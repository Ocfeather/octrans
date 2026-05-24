// OcTrans background service worker — handles AI API calls (DeepSeek / OpenAI-compatible).

const DEFAULTS = {
  endpoint: "https://api.deepseek.com/chat/completions",
  apiKey: "",
  model: "deepseek-chat",
  visionEndpoint: "",
  visionApiKey: "",
  visionModel: "",
  targetLang: "中文",
  mode: "auto",
  imageEnabled: false,
  captureEnabled: true,
  enabled: false
};

async function getSettings() {
  const stored = await chrome.storage.local.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
}

function buildSystemPrompt(targetLang) {
  return [
    `You are a professional translation engine.`,
    `The user sends a JSON object whose keys are numeric indices and values are source strings.`,
    `Translate every value into ${targetLang}, preserving meaning, tone, and numbers.`,
    `Return a strict JSON object with the EXACT same keys, each mapped to its translated string.`,
    `Do not add, remove, merge, reorder, or rename keys. No explanations.`,
    `If a value is already in ${targetLang}, return it unchanged.`
  ].join(" ");
}

async function translateBatch(texts) {
  const { endpoint, apiKey, model, targetLang } = await getSettings();

  if (!apiKey) {
    throw new Error("未设置 API Key，请在插件弹窗中配置。");
  }

  const map = {};
  texts.forEach((t, i) => {
    map[i] = t;
  });

  const body = {
    model,
    messages: [
      { role: "system", content: buildSystemPrompt(targetLang) },
      { role: "user", content: JSON.stringify(map) }
    ],
    temperature: 0,
    response_format: { type: "json_object" }
  };

  const resp = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`API ${resp.status}: ${detail.slice(0, 300)}`);
  }

  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("API 返回内容为空。");
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    throw new Error("无法解析 API 返回的 JSON。");
  }

  // Map back by index; missing entries become null (handled per-item by the content script).
  return texts.map((_, i) => {
    const v = parsed[String(i)];
    return typeof v === "string" ? v : null;
  });
}

function deriveModelsUrl(endpoint) {
  if (endpoint.includes("/chat/completions")) {
    return endpoint.replace("/chat/completions", "/models");
  }
  try {
    const u = new URL(endpoint);
    return u.pathname.includes("/v1") ? `${u.origin}/v1/models` : `${u.origin}/models`;
  } catch (e) {
    return null;
  }
}

async function listModels(endpointArg, apiKeyArg) {
  const settings = await getSettings();
  const endpoint = (endpointArg || settings.endpoint || "").trim();
  const apiKey = (apiKeyArg || settings.apiKey || "").trim();

  if (!apiKey) throw new Error("未设置 API Key。");
  const url = deriveModelsUrl(endpoint);
  if (!url) throw new Error("无法从 API 地址推导出模型列表地址。");

  const resp = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}` }
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`API ${resp.status}: ${detail.slice(0, 200)}`);
  }
  const data = await resp.json();
  const list = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
  const ids = list
    .map((m) => (typeof m === "string" ? m : m?.id))
    .filter((id) => typeof id === "string" && id.length);
  if (!ids.length) throw new Error("未返回任何模型。");
  return ids.sort();
}

async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  const mime = blob.type || "image/png";
  return `data:${mime};base64,${btoa(binary)}`;
}

async function fetchImageAsDataUrl(src) {
  const resp = await fetch(src);
  if (!resp.ok) throw new Error(`无法获取图片 (${resp.status})`);
  const blob = await resp.blob();

  // JPEG/PNG are accepted as-is. Re-encode others (AVIF/WebP/GIF…) to JPEG,
  // downscaling large images — much faster and far smaller than PNG.
  if (blob.type === "image/jpeg" || blob.type === "image/png") {
    return blobToDataUrl(blob);
  }

  let bitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch (e) {
    throw new Error(`图片格式无法解码 (${blob.type || "未知"})`);
  }
  const MAX = 1600;
  const scale = Math.min(1, MAX / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff"; // white background for transparent images
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const out = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.9 });
  return blobToDataUrl(out);
}

async function translateImage(src) {
  const s = await getSettings();
  // Vision can use its own endpoint/key; fall back to the main ones when blank.
  const vEndpoint = (s.visionEndpoint || "").trim() || s.endpoint;
  const vKey = (s.visionApiKey || "").trim() || s.apiKey;
  const visionM = (s.visionModel || "").trim() || s.model;
  const targetLang = s.targetLang;
  if (!vKey) throw new Error("未设置 API Key，请在插件弹窗中配置。");

  const dataUrl = src.startsWith("data:") ? src : await fetchImageAsDataUrl(src);

  const prompt =
    `Extract all text in this image and translate it into ${targetLang}. ` +
    `Preserve line breaks. Output only the translated text, no explanations or notes. ` +
    `If the image contains no text, output an empty string.`;

  const body = {
    model: visionM,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: dataUrl } }
        ]
      }
    ],
    temperature: 0
  };

  const resp = await fetch(vEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${vKey}` },
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`API ${resp.status}: ${detail.slice(0, 300)}`);
  }
  const data = await resp.json();
  return data?.choices?.[0]?.message?.content || "";
}

// Tell a tab to start region selection; inject the content script first if it isn't loaded yet
// (e.g. the page was already open before the extension was installed/updated).
async function startCaptureOnTab(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "startCapture" });
  } catch (e) {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ["content.css"] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    await chrome.tabs.sendMessage(tabId, { type: "startCapture" });
  }
}

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "capture-translate") return;
  const { captureEnabled } = await chrome.storage.local.get({ captureEnabled: true });
  if (!captureEnabled) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) startCaptureOnTab(tab.id).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "translate") {
    translateBatch(msg.texts)
      .then((translations) => sendResponse({ ok: true, translations }))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true; // async response
  }
  if (msg?.type === "listModels") {
    listModels(msg.endpoint, msg.apiKey)
      .then((models) => sendResponse({ ok: true, models }))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true; // async response
  }
  if (msg?.type === "translateImage") {
    translateImage(msg.src)
      .then((text) => sendResponse({ ok: true, text }))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true; // async response
  }
  if (msg?.type === "requestCapture") {
    chrome.storage.local.get({ captureEnabled: true }, ({ captureEnabled }) => {
      if (!captureEnabled) {
        sendResponse({ ok: false, error: "截图翻译已禁用" });
        return;
      }
      startCaptureOnTab(msg.tabId)
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    });
    return true; // async response
  }
  if (msg?.type === "captureTab") {
    const windowId = _sender.tab?.windowId;
    chrome.tabs
      .captureVisibleTab(windowId, { format: "jpeg", quality: 92 })
      .then((dataUrl) => sendResponse({ ok: true, dataUrl }))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true; // async response
  }
});
