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

const $ = (id) => document.getElementById(id);

function setStatus(msg, isError = false) {
  const el = $("status");
  el.textContent = msg;
  el.className = isError ? "status error" : "status";
}

function renderToggle(enabled) {
  const btn = $("toggle");
  btn.textContent = enabled ? "关闭翻译" : "开启翻译";
  btn.classList.toggle("on", enabled);
}

let textModels = [];
let visionModels = [];

function closeAllLists() {
  document.querySelectorAll(".combo-list.open").forEach((l) => l.classList.remove("open"));
}

function buildList(inputId, listId, items) {
  const input = $(inputId);
  const list = $(listId);
  list.innerHTML = "";
  if (!items.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "（暂无模型，可直接在框内输入）";
    list.appendChild(li);
  } else {
    items.forEach((m) => {
      const li = document.createElement("li");
      li.textContent = m;
      li.addEventListener("mousedown", (e) => {
        e.preventDefault(); // fire before input blur
        input.value = m;
        list.classList.remove("open");
      });
      list.appendChild(li);
    });
  }
  list.classList.add("open");
}

function setupCombo(inputId, listId, getModels) {
  const input = $(inputId);
  const list = $(listId);
  const toggle = document.querySelector(`.combo-toggle[data-for="${inputId}"]`);

  toggle.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const wasOpen = list.classList.contains("open");
    closeAllLists();
    if (!wasOpen) {
      buildList(inputId, listId, getModels()); // always full list
      input.focus();
    }
  });

  input.addEventListener("input", () => {
    closeAllLists();
    const all = getModels();
    const q = input.value.trim().toLowerCase();
    const matches = all.filter((m) => m.toLowerCase().includes(q));
    buildList(inputId, listId, matches.length ? matches : all);
  });
}

document.addEventListener("click", (e) => {
  if (!e.target.closest(".combo")) closeAllLists();
});

function fetchModels({ endpoint, apiKey, onModels, silent }) {
  if (!apiKey) {
    if (!silent) setStatus("请先填写 API Key", true);
    return;
  }
  if (!silent) setStatus("获取模型中…");
  chrome.runtime.sendMessage({ type: "listModels", endpoint, apiKey }, (resp) => {
    if (chrome.runtime.lastError || !resp) {
      if (!silent) setStatus("获取失败", true);
      return;
    }
    if (!resp.ok) {
      if (!silent) setStatus(`获取失败: ${resp.error}`, true);
      return;
    }
    onModels(resp.models);
    if (!silent) {
      setStatus(`已获取 ${resp.models.length} 个模型`);
      setTimeout(() => setStatus(""), 1500);
    }
  });
}

function fetchTextModels(silent) {
  fetchModels({
    endpoint: $("endpoint").value.trim() || DEFAULTS.endpoint,
    apiKey: $("apiKey").value.trim(),
    onModels: (m) => {
      textModels = m;
    },
    silent
  });
}

function fetchVisionModels(silent) {
  fetchModels({
    endpoint: $("visionEndpoint").value.trim() || $("endpoint").value.trim() || DEFAULTS.endpoint,
    apiKey: $("visionApiKey").value.trim() || $("apiKey").value.trim(),
    onModels: (m) => {
      visionModels = m;
    },
    silent
  });
}

function renderCapture(enabled) {
  $("capture").disabled = !enabled;
}

async function load() {
  const s = await chrome.storage.local.get(DEFAULTS);
  $("endpoint").value = s.endpoint;
  $("apiKey").value = s.apiKey;
  $("mode").value = s.mode;
  $("targetLang").value = s.targetLang;
  $("imageEnabled").checked = s.imageEnabled;
  $("captureEnabled").checked = s.captureEnabled;
  $("model").value = s.model;
  $("visionEndpoint").value = s.visionEndpoint;
  $("visionApiKey").value = s.visionApiKey;
  $("visionModel").value = s.visionModel;
  renderToggle(s.enabled);
  renderCapture(s.captureEnabled);
  if ($("apiKey").value.trim()) fetchTextModels(true);
  if ($("visionApiKey").value.trim() || $("apiKey").value.trim()) fetchVisionModels(true);
}

$("captureEnabled").addEventListener("change", () => {
  renderCapture($("captureEnabled").checked);
});

// 切换翻译模式立即生效：存储 + 通知当前页重渲染（已翻内容走缓存，不重复请求）
$("mode").addEventListener("change", async () => {
  const mode = $("mode").value;
  await chrome.storage.local.set({ mode });
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    chrome.tabs.sendMessage(tab.id, { type: "setMode", mode }, () => {
      if (chrome.runtime.lastError) return; // 翻译未开启或页面未注入，存储已更新，下次开启生效
      setStatus(mode === "auto" ? "已切换为全部翻译" : "已切换为逐段按钮");
      setTimeout(() => setStatus(""), 1500);
    });
  }
});

$("refreshModels").addEventListener("click", () => fetchTextModels(false));
$("refreshVisionModels").addEventListener("click", () => fetchVisionModels(false));

$("save").addEventListener("click", async () => {
  await chrome.storage.local.set({
    endpoint: $("endpoint").value.trim() || DEFAULTS.endpoint,
    apiKey: $("apiKey").value.trim(),
    model: $("model").value.trim() || DEFAULTS.model,
    visionEndpoint: $("visionEndpoint").value.trim(),
    visionApiKey: $("visionApiKey").value.trim(),
    visionModel: $("visionModel").value.trim(),
    mode: $("mode").value,
    imageEnabled: $("imageEnabled").checked,
    captureEnabled: $("captureEnabled").checked,
    targetLang: $("targetLang").value
  });
  setStatus("已保存 ✓");
  setTimeout(() => setStatus(""), 1500);
});

$("toggle").addEventListener("click", async () => {
  const { enabled } = await chrome.storage.local.get({ enabled: false });
  const next = !enabled;
  await chrome.storage.local.set({ enabled: next });
  renderToggle(next);

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    chrome.tabs.sendMessage(tab.id, { type: "toggle", enabled: next }, () => {
      if (chrome.runtime.lastError) {
        setStatus("请刷新页面后再试", true);
      } else {
        setStatus(next ? "翻译已开启" : "已显示原文");
        setTimeout(() => setStatus(""), 1500);
      }
    });
  }
});

$("capture").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  chrome.runtime.sendMessage({ type: "requestCapture", tabId: tab.id }, (r) => {
    if (chrome.runtime.lastError || !r?.ok) setStatus("无法在此页面截图", true);
    else window.close();
  });
});

setupCombo("model", "modelList", () => textModels);
setupCombo("visionModel", "visionModelList", () => visionModels);
load();
