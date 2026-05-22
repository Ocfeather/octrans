// OcTrans background service worker — handles AI API calls (DeepSeek / OpenAI-compatible).

const DEFAULTS = {
  endpoint: "https://api.deepseek.com/chat/completions",
  apiKey: "",
  model: "deepseek-chat",
  targetLang: "中文",
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
});
