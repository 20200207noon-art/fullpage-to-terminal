// viewer.js v13 — 极简，一句话讲清楚

const t = (key, ...subs) => chrome.i18n.getMessage(key, subs.length ? subs : undefined) || "";

const $ = (id) => document.getElementById(id);
const banner          = $("banner");
const bannerTitle     = $("bannerTitle");
const bannerSub       = $("bannerSub");
const bannerSaved     = $("bannerSaved");
const bannerSavedPath = $("bannerSavedPath");
const fallbackAction  = $("fallbackAction");
const copyBtn         = $("copyBtn");
const downloadBtn     = $("downloadBtn");
const imgWrap         = $("imgWrap");
const shotImg         = $("shotImg");
const metaEl          = $("meta");
const errBox          = $("errBox");

let lastDataUrl = null;
let lastMeta    = null;
let pathText    = null;
let copied      = false;

function applyStaticI18n() {
  document.documentElement.lang = (chrome.i18n.getUILanguage() || "en").replace("_", "-");
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    const msg = chrome.i18n.getMessage(key);
    if (msg && msg !== key) el.textContent = msg;
  });
}

function setBannerSuccess(title, sub) {
  banner.className = "banner";
  bannerTitle.textContent = title;
  bannerSub.innerHTML = sub;
}

function setBannerFallback(title, sub) {
  banner.className = "banner fallback";
  bannerTitle.textContent = title;
  bannerSub.innerHTML = sub;
}

function setBannerError(title, sub) {
  banner.className = "banner err";
  bannerTitle.textContent = title;
  bannerSub.innerHTML = sub;
}

(async function init() {
  applyStaticI18n();
  try {
    const { lastShot } = await chrome.storage.local.get("lastShot");
    if (!lastShot) {
      setBannerError("No screenshot", "Press the hotkey on a web page first.");
      return;
    }
    if (lastShot.error) {
      setBannerError("Capture failed", escapeHtml(lastShot.error));
      return;
    }
    lastDataUrl = lastShot.dataUrl;
    lastMeta = lastShot.meta || {};

    shotImg.src = lastDataUrl;
    imgWrap.style.display = "block";
    renderMeta(lastMeta);

    bindDownload();

    if (!lastMeta.savedPath) {
      setBannerError(
        "Image not saved",
        lastMeta.saveError ? escapeHtml(lastMeta.saveError) : "Use ⬇ Save as to save manually."
      );
      return;
    }

    // 显示文件落盘位置
    bannerSavedPath.textContent = lastMeta.savedPath;
    bannerSaved.style.display = "block";

    // 主路径：native host 已经把图片文件引用写到剪贴板
    if (lastMeta.clipboardMode === "file-ref") {
      copied = true;
      setBannerSuccess(
        "Image copied",
        `Press <kbd>⌘</kbd><kbd>V</kbd> anywhere to paste — shows as <span class="img-token">[Image&nbsp;#N]</span> in Claude Code`
      );
      return;
    }

    // 兜底：没装 native host，给个按钮让用户点
    pathText = `@${lastMeta.savedPath}`;
    fallbackAction.style.display = "block";
    setBannerFallback(
      "Almost ready",
      `Click the button below, then press <kbd>⌘</kbd><kbd>V</kbd> in <b>Claude Code</b>`
    );
    bindFallbackCopy();
    tryAutoCopy();
  } catch (e) {
    setBannerError("Load failed", escapeHtml(e.message));
  }
})();

function bindDownload() {
  downloadBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    if (!lastDataUrl) return;
    const a = document.createElement("a");
    a.href = lastDataUrl;
    a.download = makeFilename(lastMeta);
    document.body.appendChild(a);
    a.click();
    a.remove();
  });
}

function bindFallbackCopy() {
  copyBtn.addEventListener("click", () => triggerCopy("button"));
  document.addEventListener("click", (ev) => {
    if (copied) return;
    if (ev.target === downloadBtn || ev.target === copyBtn) return;
    triggerCopy("anywhere");
  });
  document.addEventListener("keydown", (ev) => {
    if (copied) return;
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    triggerCopy("key:" + ev.key);
  });
}

function triggerCopy(source) {
  if (!pathText || copied) return;
  console.log("[fullpage-shot] copy triggered by", source);
  navigator.clipboard.writeText(pathText)
    .then(() => {
      copied = true;
      copyBtn.disabled = true;
      copyBtn.textContent = "✓ Copied — go paste";
      setBannerSuccess(
        "Path copied",
        `Switch to <b>Claude Code</b>, press <kbd>⌘</kbd><kbd>V</kbd> then Enter`
      );
    })
    .catch((err) => console.error("clipboard.writeText failed:", err));
}

function tryAutoCopy() {
  if (!pathText || !navigator.clipboard) return;
  navigator.clipboard.writeText(pathText)
    .then(() => {
      copied = true;
      copyBtn.disabled = true;
      copyBtn.textContent = "✓ Copied — go paste";
      setBannerSuccess(
        "Path copied",
        `Switch to <b>Claude Code</b>, press <kbd>⌘</kbd><kbd>V</kbd> then Enter`
      );
    })
    .catch(() => { /* 静默 */ });
}

function renderMeta(m) {
  const sizeKb = lastDataUrl ? Math.round((lastDataUrl.length * 3) / 4 / 1024) : 0;
  const ts = m.capturedAt ? new Date(m.capturedAt).toLocaleString() : "";
  const dim = m.width && m.height ? `${m.width} × ${m.height}` : "";
  const path = m.savedPath ? ` · ${escapeHtml(m.savedPath)}` : "";
  metaEl.textContent = `${dim} · ${sizeKb} KB · ${ts}${path}`;
}

function makeFilename(m) {
  const d = new Date(m.capturedAt || Date.now());
  const pad = (n) => String(n).padStart(2, "0");
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  return `fullpage-${safeHost(m.url)}-${date}-${time}.png`;
}

function safeHost(rawUrl) {
  try { return new URL(rawUrl).hostname.replace(/[^\w.-]/g, "_") || "shot"; }
  catch (_) { return "shot"; }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}
