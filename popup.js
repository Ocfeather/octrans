const DEFAULTS = {
  endpoint: "https://api.deepseek.com/chat/completions",
  apiKey: "",
  model: "deepseek-chat",
  visionModel: "",
  targetLang: "中文",
  mode: "auto",
  imageEnabled: false,
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

let modelsCache = [];

function populateModels(models) {
  modelsCache = models; // typed/selected input values are untouched
}

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

function filtered(input) {
  const q = input.value.trim().toLowerCase();
  const matches = modelsCache.filter((m) => m.toLowerCase().includes(q));
  return matches.length ? matches : modelsCache; // free text → still show all
}

function setupCombo(inputId, listId) {
  const input = $(inputId);
  const list = $(listId);
  const toggle = document.querySelector(`.combo-toggle[data-for="${inputId}"]`);

  toggle.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const wasOpen = list.classList.contains("open");
    closeAllLists();
    if (!wasOpen) {
      buildList(inputId, listId, modelsCache); // always full list
      input.focus();
    }
  });

  input.addEventListener("input", () => {
    closeAllLists();
    buildList(inputId, listId, filtered(input));
  });
}

document.addEventListener("click", (e) => {
  if (!e.target.closest(".combo")) closeAllLists();
});

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
    populateModels(resp.models);
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
  $("imageEnabled").checked = s.imageEnabled;
  $("model").value = s.model;
  $("visionModel").value = s.visionModel;
  renderToggle(s.enabled);
  if (s.apiKey) fetchModels(true); // auto-refresh list in background
}

$("refreshModels").addEventListener("click", () => fetchModels(false));

$("save").addEventListener("click", async () => {
  await chrome.storage.local.set({
    endpoint: $("endpoint").value.trim() || DEFAULTS.endpoint,
    apiKey: $("apiKey").value.trim(),
    model: $("model").value.trim() || DEFAULTS.model,
    visionModel: $("visionModel").value.trim(),
    mode: $("mode").value,
    imageEnabled: $("imageEnabled").checked,
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

setupCombo("model", "modelList");
setupCombo("visionModel", "visionModelList");
load();
