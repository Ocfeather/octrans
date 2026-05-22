const DEFAULTS = {
  endpoint: "https://api.deepseek.com/chat/completions",
  apiKey: "",
  model: "deepseek-chat",
  targetLang: "中文",
  mode: "auto",
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

function populateModels(models, selected) {
  const sel = $("model");
  const list = models.slice();
  if (selected && !list.includes(selected)) list.unshift(selected);
  sel.innerHTML = "";
  list.forEach((id) => {
    const o = document.createElement("option");
    o.value = id;
    o.textContent = id;
    if (id === selected) o.selected = true;
    sel.appendChild(o);
  });
}

function fetchModels(silent = false) {
  const endpoint = $("endpoint").value.trim() || DEFAULTS.endpoint;
  const apiKey = $("apiKey").value.trim();
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
    populateModels(resp.models, $("model").value || DEFAULTS.model);
    if (!silent) {
      setStatus(`已获取 ${resp.models.length} 个模型`);
      setTimeout(() => setStatus(""), 1500);
    }
  });
}

async function load() {
  const s = await chrome.storage.local.get(DEFAULTS);
  $("endpoint").value = s.endpoint;
  $("apiKey").value = s.apiKey;
  $("mode").value = s.mode;
  $("targetLang").value = s.targetLang;
  populateModels([], s.model); // show saved model immediately
  renderToggle(s.enabled);
  if (s.apiKey) fetchModels(true); // auto-refresh list in background
}

$("refreshModels").addEventListener("click", () => fetchModels(false));

$("save").addEventListener("click", async () => {
  await chrome.storage.local.set({
    endpoint: $("endpoint").value.trim() || DEFAULTS.endpoint,
    apiKey: $("apiKey").value.trim(),
    model: $("model").value.trim() || DEFAULTS.model,
    mode: $("mode").value,
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

load();
