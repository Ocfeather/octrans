// OcTrans content script — groups visible text by block, requests translation, injects it below.

(() => {
  const DONE_ATTR = "data-octrans-done";
  const TRANS_CLASS = "octrans-translation";
  const MAX_CHARS_PER_BATCH = 3000;
  const MAX_ITEMS_PER_BATCH = 18;
  const CONCURRENCY = 5;

  const EXCLUDE_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "CODE", "PRE", "KBD", "SAMP",
    "IFRAME", "SVG", "CANVAS", "MATH", "INPUT", "SELECT", "OPTION"
  ]);
  const BLOCK_DISPLAYS = new Set([
    "block", "list-item", "flow-root", "table", "table-row", "table-cell",
    "table-caption", "flex", "grid", "inline-block"
  ]);

  const BTN_CLASS = "octrans-btn";

  let running = false;
  let observer = null;
  let targetLang = "中文";
  let mode = "auto"; // "auto" | "button"

  function isBlock(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el === document.body) return true;
    return BLOCK_DISPLAYS.has(getComputedStyle(el).display);
  }

  function nearestBlock(el) {
    let cur = el;
    while (cur && cur !== document.body) {
      if (isBlock(cur)) return cur;
      cur = cur.parentElement;
    }
    return document.body;
  }

  function excluded(el) {
    let cur = el;
    while (cur && cur.nodeType === 1) {
      if (EXCLUDE_TAGS.has(cur.tagName)) return true;
      if (cur.classList.contains(TRANS_CLASS)) return true;
      if (cur.isContentEditable) return true;
      if (cur.hasAttribute(DONE_ATTR)) return true;
      cur = cur.parentElement;
    }
    return false;
  }

  // Skip text already written in the target language (only for distinctive scripts).
  function shouldSkip(text) {
    const letters = (text.match(/\p{L}/gu) || []).length;
    if (!letters) return true;
    if (targetLang === "中文") {
      // Japanese kana means it's Japanese (not Chinese) — translate it.
      if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)) return false;
      const han = (text.match(/\p{Script=Han}/gu) || []).length;
      return han / letters > 0.5;
    }
    if (targetLang === "한국어") {
      const ko = (text.match(/\p{Script=Hangul}/gu) || []).length;
      return ko / letters > 0.5;
    }
    return false;
  }

  function collectUnits() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const v = node.nodeValue;
        if (!v || !v.trim() || !/\p{L}/u.test(v)) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent || excluded(parent)) return NodeFilter.FILTER_REJECT;
        if (!parent.getClientRects().length) return NodeFilter.FILTER_REJECT; // hidden
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    const groups = new Map(); // blockEl -> text node[]
    let n;
    while ((n = walker.nextNode())) {
      const block = nearestBlock(n.parentElement);
      if (!groups.has(block)) groups.set(block, []);
      groups.get(block).push(n);
    }

    const units = [];
    for (const [block, nodes] of groups) {
      const text = nodes.map((x) => x.nodeValue).join(" ").replace(/\s+/g, " ").trim();
      if (text.length < 2 || shouldSkip(text)) continue;
      units.push({ block, text });
    }
    return units;
  }

  function makeTransNode(state, text) {
    const div = document.createElement("div");
    div.className = `${TRANS_CLASS} octrans-${state}`;
    div.textContent = text;
    return div;
  }

  function chunk(items) {
    const batches = [];
    let cur = [];
    let chars = 0;
    for (const it of items) {
      const len = it.text.length;
      if (cur.length && (cur.length >= MAX_ITEMS_PER_BATCH || chars + len > MAX_CHARS_PER_BATCH)) {
        batches.push(cur);
        cur = [];
        chars = 0;
      }
      cur.push(it);
      chars += len;
    }
    if (cur.length) batches.push(cur);
    return batches;
  }

  function requestTranslation(texts) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "translate", texts }, (resp) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          resolve(resp || { ok: false, error: "无响应" });
        }
      });
    });
  }

  async function runPool(batches) {
    let idx = 0;
    async function worker() {
      while (idx < batches.length && running) {
        const batch = batches[idx++];
        const resp = await requestTranslation(batch.map((b) => b.text));
        batch.forEach((item, i) => {
          if (resp.ok) {
            const t = resp.translations[i];
            if (t && t.trim()) {
              item.node.classList.remove("octrans-loading");
              item.node.classList.add("octrans-done");
              item.node.textContent = t;
            } else {
              item.node.remove(); // no translation for this item — drop quietly
            }
          } else {
            item.node.classList.remove("octrans-loading");
            item.node.classList.add("octrans-error");
            item.node.textContent = `翻译失败: ${resp.error}`;
          }
        });
      }
    }
    const workers = [];
    for (let i = 0; i < CONCURRENCY; i++) workers.push(worker());
    await Promise.all(workers);
  }

  async function translateOne(block, text, btn) {
    btn.disabled = true;
    btn.textContent = "…";
    const node = makeTransNode("loading", "翻译中…");
    block.appendChild(node);
    const resp = await requestTranslation([text]);
    if (resp.ok && resp.translations[0] && resp.translations[0].trim()) {
      node.classList.remove("octrans-loading");
      node.classList.add("octrans-done");
      node.textContent = resp.translations[0];
      btn.remove();
    } else {
      node.remove();
      btn.disabled = false;
      btn.textContent = "译";
      btn.title = resp.ok ? "未返回译文，点此重试" : `翻译失败: ${resp.error}`;
    }
  }

  function addButton(block, text) {
    block.setAttribute(DONE_ATTR, "1");
    const btn = document.createElement("button");
    btn.className = BTN_CLASS;
    btn.type = "button";
    btn.textContent = "译";
    btn.title = "翻译此段";
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      translateOne(block, text, btn);
    });
    block.appendChild(btn);
  }

  async function translatePage() {
    const units = collectUnits();
    if (!units.length) return;

    if (mode === "button") {
      units.forEach((u) => addButton(u.block, u.text));
      return;
    }

    const items = units.map((u) => {
      u.block.setAttribute(DONE_ATTR, "1");
      const node = makeTransNode("loading", "翻译中…");
      u.block.appendChild(node);
      return { node, text: u.text };
    });
    await runPool(chunk(items));
  }

  function removeTranslations() {
    document.querySelectorAll(`.${TRANS_CLASS}, .${BTN_CLASS}`).forEach((n) => n.remove());
    document.querySelectorAll(`[${DONE_ATTR}]`).forEach((el) => el.removeAttribute(DONE_ATTR));
  }

  function startObserver() {
    if (observer) return;
    let timer = null;
    observer = new MutationObserver(() => {
      if (!running) return;
      clearTimeout(timer);
      timer = setTimeout(() => running && translatePage(), 800);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function stopObserver() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
  }

  async function enable() {
    if (running) return;
    running = true;
    const s = await chrome.storage.local.get({ targetLang: "中文", mode: "auto" });
    targetLang = s.targetLang;
    mode = s.mode;
    await translatePage();
    startObserver();
  }

  function disable() {
    running = false;
    stopObserver();
    removeTranslations();
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "toggle") {
      if (msg.enabled) enable();
      else disable();
      sendResponse({ ok: true });
    } else if (msg?.type === "status") {
      sendResponse({ running });
    }
    return true;
  });

  chrome.storage.local.get({ enabled: false }, (s) => {
    if (s.enabled) enable();
  });

  // ---------- Image OCR translation (vision model + full-image overlay) ----------

  let imageEnabled = false;
  let floatBtn = null;
  let hoverImg = null;

  function eligibleImg(el) {
    return (
      el &&
      el.tagName === "IMG" &&
      el.naturalWidth >= 80 &&
      el.naturalHeight >= 80
    );
  }

  function ensureFloatBtn() {
    if (floatBtn) return floatBtn;
    floatBtn = document.createElement("button");
    floatBtn.className = "octrans-img-btn";
    floatBtn.type = "button";
    floatBtn.textContent = "译图";
    floatBtn.title = "识别并翻译图片中的文字";
    floatBtn.style.display = "none";
    floatBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (hoverImg) translateImage(hoverImg);
    });
    document.body.appendChild(floatBtn);
    return floatBtn;
  }

  function showOverlay(img, text, loading) {
    const r = img.getBoundingClientRect();
    const ov = document.createElement("div");
    ov.className = "octrans-img-overlay" + (loading ? " octrans-loading" : "");
    ov.style.left = `${r.left + window.scrollX}px`;
    ov.style.top = `${r.top + window.scrollY}px`;
    ov.style.width = `${r.width}px`;
    ov.style.height = `${r.height}px`;

    const close = document.createElement("button");
    close.className = "octrans-img-close";
    close.type = "button";
    close.textContent = "×";
    close.title = "关闭";
    close.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      ov.remove();
    });

    const inner = document.createElement("div");
    inner.className = "octrans-img-text";
    inner.textContent = text;

    ov.appendChild(close);
    ov.appendChild(inner);
    document.body.appendChild(ov);
    return { ov, inner };
  }

  async function translateImage(img) {
    if (floatBtn) floatBtn.style.display = "none";
    const src = img.currentSrc || img.src;
    if (!src) return;
    const { ov, inner } = showOverlay(img, "识别翻译中…", true);
    const resp = await new Promise((res) => {
      chrome.runtime.sendMessage({ type: "translateImage", src }, (r) => {
        res(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : r);
      });
    });
    ov.classList.remove("octrans-loading");
    if (resp && resp.ok) {
      inner.textContent = resp.text && resp.text.trim() ? resp.text : "(未识别到文字)";
    } else {
      ov.classList.add("octrans-error");
      inner.textContent = `翻译失败: ${resp ? resp.error : "无响应"}`;
    }
  }

  function onImgOver(e) {
    if (!imageEnabled) return;
    if (eligibleImg(e.target)) {
      hoverImg = e.target;
      const b = ensureFloatBtn();
      const r = e.target.getBoundingClientRect();
      b.style.left = `${r.left + 6}px`;
      b.style.top = `${r.top + 6}px`;
      b.style.display = "block";
    }
  }

  function onImgOut(e) {
    if (!floatBtn) return;
    if (e.relatedTarget === floatBtn) return; // moving onto the button itself
    if (eligibleImg(e.target)) floatBtn.style.display = "none";
  }

  document.addEventListener("mouseover", onImgOver, true);
  document.addEventListener("mouseout", onImgOut, true);
  window.addEventListener(
    "scroll",
    () => {
      if (floatBtn) floatBtn.style.display = "none";
    },
    true
  );

  chrome.storage.local.get({ imageEnabled: false }, (s) => {
    imageEnabled = s.imageEnabled;
  });
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === "local" && ch.imageEnabled) imageEnabled = ch.imageEnabled.newValue;
  });
})();
