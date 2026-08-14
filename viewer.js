// viewer.js — GoFullPage-style slim toolbar + full image below

const t = (key, ...subs) => chrome.i18n.getMessage(key, subs.length ? subs : undefined) || "";

const $ = (id) => document.getElementById(id);
const bannerTitle     = $("bannerTitle");
const bannerSub       = $("bannerSub");
const bannerSaved     = $("bannerSaved");
const bannerSavedPath = $("bannerSavedPath");
const copyBtn         = $("copyBtn");
const downloadBtn     = $("downloadBtn");
const logsBtn         = $("logsBtn");
const imgWrap         = $("imgWrap");
const shotImg         = $("shotImg");
const errBox          = $("errBox");
const diagBox         = $("diagBox");
const diagText        = $("diagText");

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

function setStatus(state, title, subHtml) {
  document.body.className = state; // ok | fallback | err
  bannerTitle.textContent = title;
  bannerSub.innerHTML = subHtml || "";
}
const setBannerSuccess  = (title, sub) => setStatus("ok", title, sub);
const setBannerFallback = (title, sub) => setStatus("fallback", title, sub);
const setBannerError    = (title, sub) => setStatus("err", title, sub);

(async function init() {
  applyStaticI18n();
  logsBtn.addEventListener("click", () => {
    diagBox.style.display = diagBox.style.display === "none" ? "block" : "none";
  });
  try {
    const { lastShot } = await chrome.storage.local.get("lastShot");
    if (!lastShot) {
      setBannerError("No screenshot", "Press the hotkey on a web page first.");
      return;
    }
    if (lastShot.error) {
      setBannerError("Capture failed", "");
      errBox.textContent = lastShot.error;
      errBox.style.display = "block";
      if (lastShot.logs && lastShot.logs.length) diagText.textContent = lastShot.logs.join("\n");
      return;
    }
    lastDataUrl = lastShot.dataUrl;
    lastMeta = lastShot.meta || {};

    shotImg.src = lastDataUrl;
    imgWrap.style.display = "block";
    bindImageZoom();

    // diagnostics: meta summary + capture logs, behind the ⓘ button
    diagText.textContent =
      metaSummary(lastMeta) +
      (lastMeta.logs && lastMeta.logs.length ? "\n\n" + lastMeta.logs.join("\n") : "");

    bindDownload();

    if (!lastMeta.savedPath) {
      setBannerError(
        "Image not saved",
        lastMeta.saveError ? escapeHtml(lastMeta.saveError) : "Use ⬇ Save as to save manually."
      );
      return;
    }

    // show on-disk path (click = copy path)
    bannerSavedPath.textContent = lastMeta.savedPath;
    bannerSaved.title = lastMeta.savedPath;
    bannerSaved.style.display = "block";
    bannerSaved.addEventListener("click", () => {
      navigator.clipboard.writeText(lastMeta.savedPath).catch(() => {});
    });

    // main path: native host already wrote a file reference to the clipboard
    if (lastMeta.clipboardMode === "file-ref") {
      copied = true;
      setBannerSuccess(
        "Image copied",
        `<kbd>⌘</kbd><kbd>V</kbd> to paste — shows as <span class="img-token">[Image&nbsp;#N]</span> in Claude Code`
      );
      return;
    }

    // fallback: native host not installed → show a button user can click
    pathText = `@${lastMeta.savedPath}`;
    copyBtn.style.display = "";
    setBannerFallback(
      "Almost ready",
      `Copy the path, then <kbd>⌘</kbd><kbd>V</kbd> in <b>Claude Code</b>`
    );
    bindFallbackCopy();
    tryAutoCopy();
  } catch (e) {
    setBannerError("Load failed", escapeHtml(e.message));
  }
})();

// The PNG is captured at PHYSICAL resolution (naturalWidth = cssWidth × dpr).
// Rendering it unscaled makes it look 2× too big on any Retina/HiDPI screen —
// that was the "the screenshot is huge on this Mac but fine on the other one"
// bug: the difference was the display's devicePixelRatio, not Chrome's version.
//
// Two views, click to toggle:
//   default      — fits the window width: you land on the whole page at a glance
//   .actual-size — the page's own size, what it looked like in the browser
// Neither view ever exceeds the page's real CSS width, so the image is never
// blown up past life size.
function bindImageZoom() {
  // The page's own CSS width. Prefer meta: for a very tall page the capture is
  // scaled down to fit the canvas limit, so naturalWidth / dpr would undershoot.
  const pageCssWidth = () =>
    Math.round((lastMeta && lastMeta.width) ||
               shotImg.naturalWidth / (window.devicePixelRatio || 1));

  const applySizing = () => {
    if (!shotImg.naturalWidth) return;
    const cssW = pageCssWidth() + "px";
    if (imgWrap.classList.contains("actual-size")) {
      shotImg.style.width = cssW;        // life size; scrolls if the window is narrower
      shotImg.style.maxWidth = "none";   // inline max-width from the other view would cap it
    } else {
      shotImg.style.width = "100%";      // shrink to fit…
      shotImg.style.maxWidth = cssW;     // …but never stretch past life size
    }
  };
  shotImg.addEventListener("load", applySizing);
  if (shotImg.complete) applySizing();
  // dragging the window between a Retina and a non-Retina display changes dpr
  window.addEventListener("resize", applySizing);
  shotImg.addEventListener("click", () => {
    imgWrap.classList.toggle("actual-size");
    applySizing();
  });
}

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
    if (ev.target === downloadBtn || ev.target === copyBtn || ev.target === logsBtn) return;
    triggerCopy("anywhere");
  });
  document.addEventListener("keydown", (ev) => {
    if (copied) return;
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    triggerCopy("key:" + ev.key);
  });
}

function markCopied() {
  copied = true;
  copyBtn.disabled = true;
  copyBtn.textContent = "✓ Copied";
  setBannerSuccess(
    "Path copied",
    `Switch to <b>Claude Code</b>, <kbd>⌘</kbd><kbd>V</kbd> then Enter`
  );
}

function triggerCopy(source) {
  if (!pathText || copied) return;
  console.log("[fullpage-shot] copy triggered by", source);
  navigator.clipboard.writeText(pathText)
    .then(markCopied)
    .catch((err) => console.error("clipboard.writeText failed:", err));
}

function tryAutoCopy() {
  if (!pathText || !navigator.clipboard) return;
  navigator.clipboard.writeText(pathText)
    .then(markCopied)
    .catch(() => { /* silent */ });
}

function metaSummary(m) {
  const sizeKb = lastDataUrl ? Math.round((lastDataUrl.length * 3) / 4 / 1024) : 0;
  const ts = m.capturedAt ? new Date(m.capturedAt).toLocaleString() : "";
  const dim = m.width && m.height ? `${m.width} × ${m.height} CSS px` : "";
  const px  = m.pixelWidth && m.pixelHeight ? ` · ${m.pixelWidth} × ${m.pixelHeight} image px` : "";
  const scale = m.outScale ? ` · ${(+m.outScale).toFixed(2)}× output` : "";
  const cut = m.truncated ? ` · TRUNCATED at ${m.truncatedAt} CSS px` : "";
  const path = m.savedPath ? ` · ${m.savedPath}` : "";
  return `${dim}${px}${scale}${cut} · ${sizeKb} KB · ${ts}${path}`;
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
