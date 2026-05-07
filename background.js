// background.js — service worker（type: module）
//
// Key fixes since v2:
//   1. Inject pre-scroll into the page to trigger lazy-loaded content before capture
//   2. Use Page.captureScreenshot with captureBeyondViewport for full-page output
//   3. Pages taller than 16000 px are split and stitched via OffscreenCanvas
//      Chromium 2D canvas hard limit is 16384; overflow is truncated and flagged in viewer
//   4. PNG stored in chrome.storage.local (unlimitedStorage)
//   5. Offscreen document plays shutter.wav
//   6. Open viewer.html — user click triggers clipboard write

const MAX_SLICE_HEIGHT = 16000;
const MAX_FINAL_HEIGHT = 16384; // OffscreenCanvas single-canvas height limit

// Global log buffer, cleared at the start of each capture. Logs go to console + this buffer for viewer to show.
let currentCaptureLogs = [];
function fpsLog(...args) {
  const line = "[fullpage-shot] " + args.map(a =>
    typeof a === "string" ? a : (() => { try { return JSON.stringify(a); } catch (_) { return String(a); } })()
  ).join(" ");
  currentCaptureLogs.push(line);
  console.log(line);
}
const BLOCKED_SCHEMES = [
  "chrome://",
  "chrome-extension://",
  "edge://",
  "about:",
  "view-source:",
  "chrome-search://",
  "chrome-devtools://",
  "devtools://"
];

chrome.runtime.onStartup.addListener(() => {
  chrome.storage.local.remove("lastShot").catch(() => {});
});
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.remove("lastShot").catch(() => {});
});

chrome.action.onClicked.addListener((tab) => {
  capture(tab).catch((err) => reportError(tab, err));
});

chrome.commands.onCommand.addListener((command) => {
  if (command !== "capture") return;
  chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
    const tab = tabs && tabs[0];
    if (!tab) return;
    capture(tab).catch((err) => reportError(tab, err));
  });
});

async function capture(tab) {
  // reset log buffer for each capture
  currentCaptureLogs = [];
  fpsLog("capture started, tab.url=", tab && tab.url);
  if (!tab || !tab.id) throw new Error("No active tab. Click a normal web page first, then press the hotkey.");
  const url = tab.url || "";
  if (BLOCKED_SCHEMES.some((s) => url.startsWith(s))) {
    throw new Error(
      `Cannot capture this page:\n${url}\n\nChrome blocks extensions from accessing internal pages (chrome://, chrome-extension://, view-source:, etc.).\n\nSwitch to a regular web page (like https://example.com) and try again.`
    );
  }
  if (!url) {
    throw new Error("Active tab has no URL — wait for the page to finish loading, then try again.");
  }

  // 0.5 install progress UI so user sees the extension is working; page scroll is expected
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: false },
      func: installProgressUI
    });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: false },
      func: updateProgressUI,
      args: [{ text: "Preparing page...", percent: 5 }]
    });
  } catch (_) {}

  // 1. inject pre-scroll script to trigger lazy load (many feeds like Reddit/Twitter need scroll to render)
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: false },
      func: preloadAllContent
    });
  } catch (e) {
    console.warn("[fullpage-shot] pre-scroll failed (page may have CSP or block injection):", e.message);
  }

  // 2. wait briefly for lazy-loaded images to decode and layout to settle
  await sleep(300);

  // 2.5 take first frame (original viewport before hide) + detect sidebar/sticky element positions
  //     after stitching, paste these from first frame back onto the canvas to mimic "stayed in place" visuals
  let firstFrameDataUrl = null;
  let stickyOverlays = [];
  let pageBgColor = null;
  try {
    // hide progress UI before capturing first frame
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: false },
        func: setProgressUIVisible,
        args: [false]
      });
    } catch (_) {}
    await sleep(30);
    firstFrameDataUrl = await captureWithDebugger(tab.id);
    // restore after capture
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: false },
        func: setProgressUIVisible,
        args: [true]
      });
    } catch (_) {}
    const detected = await execInPage(tab.id, detectStickyAndFixedRects);
    if (Array.isArray(detected)) stickyOverlays = detected;
    fpsLog("first frame captured, sticky overlays:", stickyOverlays.length);
    // get page's real background color to avoid white edge on dark pages
    pageBgColor = await execInPage(tab.id, getPageBackgroundColor);
    if (pageBgColor) fpsLog("page bg color:", pageBgColor);
  } catch (e) {
    console.warn("[fullpage-shot] first frame / overlay detection failed:", e.message);
  }

  // 3. inject "neutralize": display:none all fixed/sticky elements to avoid stitched repeats
  let neutralized = false;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: false },
      func: neutralizeStickyAndFixed
    });
    neutralized = true;
  } catch (e) {
    console.warn("[fullpage-shot] failed to inject neutralize styles:", e.message);
  }
  await sleep(120);

  let dataUrl;
  let widthPx;
  let heightPx;
  let truncated = false;

  try {
    const result = await scrollStitch(tab, { firstFrameDataUrl, stickyOverlays, pageBgColor });
    dataUrl = result.dataUrl;
    widthPx = result.width;
    heightPx = result.height;
    truncated = result.truncated;
  } finally {
    // 5. restore page styles and remove progress UI on capture success or failure
    if (neutralized) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id, allFrames: false },
          func: restoreStickyAndFixed
        });
      } catch (_) {}
    }
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: false },
        func: removeProgressUI
      });
    } catch (_) {}
  }

  const meta = {
    url: tab.url,
    title: tab.title || "",
    width: widthPx,
    height: heightPx,
    capturedAt: Date.now(),
    truncated,
    truncatedAt: truncated ? MAX_FINAL_HEIGHT : null
  };

  // save to disk → put absolute path into meta so viewer can write @path to clipboard
  // this is the only path that works for pasting into Mac Terminal: image bytes ⌘V into Terminal.app always pastes empty
  let savedPath = null;
  let saveError = null;
  try {
    savedPath = await saveToDownloads(dataUrl, tab.url);
  } catch (e) {
    console.warn("[fullpage-shot] save-to-disk failed:", e);
    saveError = (e && e.message) || String(e);
  }
  meta.savedPath = savedPath;
  meta.saveError = saveError;

  // collect inject-function logs (running in target tab) and merge with background logs
  try {
    const injectLogsResult = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: false },
      func: () => {
        const out = window.__fpsInjectLogs || [];
        window.__fpsInjectLogs = [];
        return out;
      }
    });
    const injectLogs = (injectLogsResult && injectLogsResult[0] && Array.isArray(injectLogsResult[0].result))
      ? injectLogsResult[0].result : [];
    for (const l of injectLogs) {
      currentCaptureLogs.push("[inject] " + l);
    }
  } catch (_) {}

  meta.logs = currentCaptureLogs.slice();
  await chrome.storage.local.set({ lastShot: { dataUrl, meta } });

  // push progress to 100% — viewer about to open
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: false },
      func: updateProgressUI,
      args: [{ text: "Done!", percent: 100 }]
    });
  } catch (_) {}

  playShutter().catch((e) => console.warn("[fullpage-shot] shutter audio play failed:", e));

  // key: write image to clipboard as "file reference" (equivalent to Finder ⌘C on the file)
  // Web Clipboard API can't write file-reference type; must call local osascript via Native Messaging
  // with native host installed, Claude Code TUI ⌘V auto-attaches the image
  if (savedPath) {
    try {
      const resp = await chrome.runtime.sendNativeMessage(
        "com.fullpageshot.copyfile",
        { path: savedPath }
      );
      if (resp && resp.ok) {
        meta.clipboardMode = "file-ref";
        fpsLog("file ref written to clipboard");
      } else {
        meta.clipboardMode = "file-ref-failed";
        meta.clipboardError = (resp && resp.error) || "unknown";
        console.warn("[fullpage-shot] native host returned error:", resp);
      }
    } catch (e) {
      meta.clipboardMode = "no-native-host";
      meta.clipboardError = e.message || String(e);
      console.warn("[fullpage-shot] native host unavailable (not installed?):", e.message);
    }
    // write latest meta including clipboardMode
    await chrome.storage.local.set({ lastShot: { dataUrl, meta } });
  }

  await chrome.tabs.create({ url: chrome.runtime.getURL("viewer.html"), active: true });
}

// Extract a filename-safe host string from URL: keep tail when > 40 chars (rightmost part is most recognizable)
// skip past next "." to avoid starting with a partial subdomain
function safeHost(rawUrl) {
  let host;
  try {
    host = new URL(rawUrl).hostname.replace(/[^\w.-]/g, "_");
  } catch (_) {
    return "shot";
  }
  const MAX = 40;
  if (host.length > MAX) {
    host = host.slice(-MAX);
    const dotIdx = host.indexOf(".");
    if (dotIdx > 0 && dotIdx < 12) host = host.slice(dotIdx + 1);
  }
  return host || "shot";
}

async function saveToDownloads(dataUrl, sourceUrl) {
  // filename format: fullpage-{host}-{YYYY-MM-DD}T{HH-MM-SS}.png (user-specified)
  // local timezone, T separator, HMS with dashes
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  const host = safeHost(sourceUrl);
  // save directly to Downloads root, no subfolder (user feedback: "path too deep")
  const filename = `fullpage-${host}-${date}-${time}.png`;

  const downloadId = await new Promise((resolve, reject) => {
    chrome.downloads.download(
      { url: dataUrl, filename, saveAs: false, conflictAction: "uniquify" },
      (id) => {
        const err = chrome.runtime.lastError;
        if (err) return reject(new Error(err.message));
        if (id == null) return reject(new Error("download did not start"));
        resolve(id);
      }
    );
  });

  // wait for download completion to get absolute path
  const filePath = await new Promise((resolve, reject) => {
    const onChange = (delta) => {
      if (delta.id !== downloadId) return;
      if (delta.state && delta.state.current === "complete") {
        chrome.downloads.onChanged.removeListener(onChange);
        chrome.downloads.search({ id: downloadId }, (items) => {
          if (items && items[0] && items[0].filename) {
            resolve(items[0].filename);
          } else {
            reject(new Error("download record not found"));
          }
        });
      } else if (delta.error && delta.error.current) {
        chrome.downloads.onChanged.removeListener(onChange);
        reject(new Error("download error: " + delta.error.current));
      }
    };
    chrome.downloads.onChanged.addListener(onChange);
    setTimeout(() => {
      chrome.downloads.onChanged.removeListener(onChange);
      reject(new Error("download timeout (30s)"));
    }, 30000);
  });

  return filePath;
}

// Inject into target tab: install a floating progress UI (top bar + center card).
// so user sees "extension is capturing, scrolling is expected" — not page bug
function installProgressUI() {
  const KEY = "__fullpageShotProgressUI__";
  if (window[KEY]) return;
  const root = document.createElement("div");
  root.id = "__fullpage_shot_progress_root__";
  root.setAttribute("data-fullpage-shot", "ui");
  root.style.cssText = [
    "all: initial",
    "position: fixed",
    "left: 0", "top: 0", "right: 0", "bottom: 0",
    "z-index: 2147483647",
    "pointer-events: none",
    "font-family: -apple-system, BlinkMacSystemFont, sans-serif"
  ].join(";");

  // colorful 4px progress bar at top (more visible)
  const barWrap = document.createElement("div");
  barWrap.style.cssText = [
    "position: absolute", "top: 0", "left: 0", "right: 0",
    "height: 4px", "background: rgba(0,0,0,0.15)"
  ].join(";");
  const bar = document.createElement("div");
  bar.id = "__fullpage_shot_progress_bar__";
  bar.style.cssText = [
    "height: 100%", "width: 0%",
    "background: linear-gradient(90deg, #2da44e 0%, #58a6ff 50%, #f78166 100%)",
    "box-shadow: 0 0 8px rgba(88, 166, 255, 0.6)",
    "transition: width 200ms ease"
  ].join(";");
  barWrap.appendChild(bar);

  // large card in bottom-right (does not block top content, eye-catching)
  const card = document.createElement("div");
  card.id = "__fullpage_shot_progress_card__";
  card.style.cssText = [
    "position: absolute",
    "right: 24px", "bottom: 24px",
    "background: linear-gradient(135deg, #1f6feb, #2da44e)",
    "color: #ffffff",
    "padding: 16px 22px",
    "border-radius: 14px",
    "border: 2px solid rgba(255,255,255,0.25)",
    "box-shadow: 0 12px 48px rgba(0,0,0,0.55), 0 0 0 4px rgba(88,166,255,0.15)",
    "font-size: 16px",
    "font-weight: 700",
    "letter-spacing: 0.3px",
    "white-space: nowrap",
    "min-width: 220px",
    "display: flex",
    "align-items: center",
    "gap: 12px",
    "animation: __fps_pulse 1.6s ease-in-out infinite"
  ].join(";");
  card.innerHTML = `
    <span style="font-size: 26px; line-height: 1;">📸</span>
    <span id="__fullpage_shot_progress_text__" style="flex:1">Capturing full page...</span>
  `;

  // pulse animation
  const style = document.createElement("style");
  style.id = "__fullpage_shot_anim_style__";
  style.textContent = `
    @keyframes __fps_pulse {
      0%, 100% { box-shadow: 0 12px 48px rgba(0,0,0,0.55), 0 0 0 4px rgba(88,166,255,0.15); }
      50%      { box-shadow: 0 12px 48px rgba(0,0,0,0.55), 0 0 0 12px rgba(88,166,255,0.05); }
    }
  `;
  document.head.appendChild(style);

  root.appendChild(barWrap);
  root.appendChild(card);
  document.documentElement.appendChild(root);
  window[KEY] = { root, styleEl: style };
}

function updateProgressUI(args) {
  const KEY = "__fullpageShotProgressUI__";
  if (!window[KEY]) return;
  const text = document.getElementById("__fullpage_shot_progress_text__");
  const bar = document.getElementById("__fullpage_shot_progress_bar__");
  if (text && args && args.text) text.textContent = args.text;
  if (bar && args && typeof args.percent === "number") {
    bar.style.width = Math.max(0, Math.min(100, args.percent)) + "%";
  }
}

function setProgressUIVisible(visible) {
  const KEY = "__fullpageShotProgressUI__";
  if (!window[KEY]) return;
  window[KEY].root.style.visibility = visible ? "visible" : "hidden";
}

function removeProgressUI() {
  const KEY = "__fullpageShotProgressUI__";
  if (!window[KEY]) return;
  try { window[KEY].root.remove(); } catch (_) {}
  try { if (window[KEY].styleEl) window[KEY].styleEl.remove(); } catch (_) {}
  delete window[KEY];
}

// Inject into target tab: get page's real background color (for canvas fill, avoid white edge on dark pages)
function getPageBackgroundColor() {
  const candidates = [document.body, document.documentElement];
  for (const el of document.querySelectorAll("main, [role='main'], #app, #root")) {
    candidates.push(el);
  }
  for (const el of candidates) {
    if (!el) continue;
    try {
      const cs = getComputedStyle(el);
      const bg = cs.backgroundColor;
      if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") {
        return bg;
      }
    } catch (_) {}
  }
  return "#ffffff";
}

// Inject into target tab: detect all CSS position:fixed/sticky elements, return their viewport rects.
// Simple version: pure CSS detection, no scroll-then-measure (that triggers React re-render and breaks the page).
// Visually-fixed-but-CSS-not-fixed elements (e.g. share button) are accepted as repeating in the stitched output for now —
// lower priority than the core full-page-capture ability.
function detectStickyAndFixedRects() {
  const VW = window.innerWidth;
  const VH = window.innerHeight;
  const rects = [];
  for (const el of document.querySelectorAll("*")) {
    let cs;
    try { cs = getComputedStyle(el); } catch (_) { continue; }
    if (cs.position !== "fixed" && cs.position !== "sticky") continue;
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    const r = el.getBoundingClientRect();
    if (r.width < 30 || r.height < 30) continue;
    if (r.right < 0 || r.bottom < 0 || r.left > VW || r.top > VH) continue;
    rects.push({
      left: Math.max(0, Math.round(r.left)),
      top: Math.max(0, Math.round(r.top)),
      width: Math.min(VW, Math.round(r.width)),
      height: Math.min(VH, Math.round(r.height)),
      area: Math.round(r.width * r.height)
    });
  }
  // Dedup: keep only outer when one rect contains another
  rects.sort((a, b) => b.area - a.area);
  const dedup = [];
  for (const r of rects) {
    const containedByExisting = dedup.some(d =>
      r.left >= d.left - 2 && r.top >= d.top - 2 &&
      r.left + r.width <= d.left + d.width + 2 &&
      r.top + r.height <= d.top + d.height + 2
    );
    if (!containedByExisting) dedup.push(r);
  }
  const _log = `sticky/fixed rects: ${rects.length} found, ${dedup.length} after dedup (CSS-position based)`;
  console.log("[fullpage-shot]", _log);
  if (!window.__fpsInjectLogs) window.__fpsInjectLogs = [];
  window.__fpsInjectLogs.push(_log);
  return dedup;
}

// Inject into target tab: fully hide all position:fixed/sticky elements (display:none).
// Switching them to absolute was not enough — SPA sidebars still appeared in the viewport.
// display:none makes them disappear entirely so the capture has only main content, no repeats.
// restoreStickyAndFixed reverts after capture.
function neutralizeStickyAndFixed() {
  const KEY = "__fullpageShotNeutralized__";
  if (window[KEY]) return;
  const restored = [];
  // 1. globally disable animations/transitions
  const styleEl = document.createElement("style");
  styleEl.id = "__fullpage_shot_anim_off__";
  styleEl.textContent =
    "*,*::before,*::after{animation-duration:0s !important;animation-delay:0s !important;" +
    "transition-duration:0s !important;transition-delay:0s !important;}";
  (document.head || document.documentElement).appendChild(styleEl);

  // 2. Walk all elements, find CSS fixed/sticky → display:none
  // (detect step already hid visually-stuck elements; this handles only CSS-level fixed/sticky missed by detect)
  // ⚠️ skip elements tagged data-fullpage-shot=ui (our own progress UI)
  const all = document.querySelectorAll("*");
  let hiddenCount = 0;
  for (const el of all) {
    if (el.getAttribute && el.getAttribute("data-fullpage-shot") === "ui") continue;
    if (el.closest && el.closest('[data-fullpage-shot="ui"]')) continue;
    let cs;
    try { cs = getComputedStyle(el); } catch (_) { continue; }
    const pos = cs.position;
    if (pos === "fixed" || pos === "sticky") {
      restored.push({
        el,
        prevDisplay: el.style.display,
        prevVisibility: el.style.visibility
      });
      // use visibility:hidden instead of display:none — preserves layout space,
      // so main does not expand to viewport-left when sidebar disappears (avoids subsequent slices' content-shift-left)
      el.style.setProperty("visibility", "hidden", "important");
      hiddenCount++;
    }
  }
  const _hideLog = "hidden " + hiddenCount + " fixed/sticky elements (CSS-based)";
  console.log("[fullpage-shot]", _hideLog);
  if (!window.__fpsInjectLogs) window.__fpsInjectLogs = [];
  window.__fpsInjectLogs.push(_hideLog);

  // 3. unset body/html overflow:hidden
  const htmlEl = document.documentElement;
  const bodyEl = document.body;
  const htmlPrevOverflow = htmlEl ? htmlEl.style.overflow : "";
  const bodyPrevOverflow = bodyEl ? bodyEl.style.overflow : "";
  if (htmlEl) htmlEl.style.setProperty("overflow", "visible", "important");
  if (bodyEl) bodyEl.style.setProperty("overflow", "visible", "important");

  window[KEY] = {
    restored,
    htmlPrevOverflow,
    bodyPrevOverflow,
    styleElId: styleEl.id
  };
}

function restoreStickyAndFixed() {
  const KEY = "__fullpageShotNeutralized__";
  const state = window[KEY];
  if (!state) return;
  const styleEl = document.getElementById(state.styleElId);
  if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
  for (const r of state.restored) {
    if (!r.el) continue;
    if (r.prevDisplay) r.el.style.display = r.prevDisplay;
    else r.el.style.removeProperty("display");
    if (r.prevVisibility) r.el.style.visibility = r.prevVisibility;
    else r.el.style.removeProperty("visibility");
  }
  if (document.documentElement) {
    document.documentElement.style.overflow = state.htmlPrevOverflow || "";
  }
  if (document.body) {
    document.body.style.overflow = state.bodyPrevOverflow || "";
  }
  delete window[KEY];
}

// Inject into target tab: scroll to bottom then back to top to force lazy-load rendering. Returns observed max scrollHeight.
function preloadAllContent() {
  return new Promise((resolve) => {
    const originalY = window.scrollY;
    const stepPx = Math.max(window.innerHeight * 0.85, 300);
    const stepDelayMs = 50;
    const stableTicksNeeded = 3;
    const safetyCapPx = 100000;
    const maxWaitMs = 6000;

    const measure = () =>
      Math.max(
        document.body ? document.body.scrollHeight : 0,
        document.documentElement ? document.documentElement.scrollHeight : 0,
        document.body ? document.body.offsetHeight : 0,
        document.documentElement ? document.documentElement.offsetHeight : 0
      );

    let y = 0;
    let lastH = 0;
    let stableTicks = 0;
    let observedMax = measure();
    const startTs = Date.now();

    const finish = () => {
      window.scrollTo(0, 0);
      // give browser one frame so sticky headers settle back to normal
      requestAnimationFrame(() => {
        setTimeout(
          () => resolve({ maxHeight: observedMax, originalY }),
          120
        );
      });
    };

    const tick = () => {
      const h = measure();
      observedMax = Math.max(observedMax, h);
      if (h === lastH) {
        stableTicks++;
      } else {
        stableTicks = 0;
        lastH = h;
      }

      window.scrollTo(0, y);
      y += stepPx;

      if (Date.now() - startTs > maxWaitMs) return finish();
      if (y >= safetyCapPx) return finish();
      if (y >= h && stableTicks >= stableTicksNeeded) return finish();

      setTimeout(tick, stepDelayMs);
    };

    tick();
  });
}

// Drive scrolling ourselves → capture each visible-viewport slice → stitch into OffscreenCanvas
// Uses chrome.debugger Page.captureScreenshot (yields physical-pixel sharp output, briefly shows debug banner)
// Key behavior: first identify the actual scrolling container (window vs an inner div)
async function scrollStitch(tab, opts) {
  const tabId = tab.id;
  const firstFrameDataUrl = opts && opts.firstFrameDataUrl;
  const stickyOverlays = (opts && opts.stickyOverlays) || [];
  const pageBgColor = (opts && opts.pageBgColor) || "#ffffff";
  // Step 1: in page context, find the "largest scrollable element" with its size/DPR
  // and store on window.__fpsHost so every later scroll uses the same reference
  const info = await execInPage(tabId, () => {
    const VW = window.innerWidth;
    const VH = window.innerHeight;
    // candidate must be the main content area — width >= half viewport, otherwise it's a sidebar/aside/drawer
    const MIN_HOST_WIDTH = Math.max(400, VW * 0.5);

    const candidates = [];
    const all = document.querySelectorAll("*");
    for (const el of all) {
      try {
        const cs = getComputedStyle(el);
        const oy = cs.overflowY;
        if (oy !== "auto" && oy !== "scroll") continue;
        const sh = el.scrollHeight;
        const ch = el.clientHeight;
        const cw = el.clientWidth;
        if (sh - ch < 200) continue;
        // key filter: containers too narrow are definitely not main content (typically sidebars are 250-300px)
        if (cw < MIN_HOST_WIDTH) continue;
        // exclude hidden elements
        if (cs.display === "none" || cs.visibility === "hidden") continue;
        // exclude obvious aside/nav roles
        const tag = el.tagName.toLowerCase();
        const role = el.getAttribute("role");
        if (tag === "aside" || tag === "nav") continue;
        if (role === "navigation" || role === "complementary") continue;

        const area = (sh - ch) * ch;
        candidates.push({ el, area, sh, ch, cw, tag });
      } catch (_) {}
    }
    // Sort by area descending (v1.13.3 tried width-first but mistakenly picked html/body — wide but actually unscrollable — reverted)
    candidates.sort((a, b) => b.area - a.area);
    const bestEl = candidates[0] ? candidates[0].el : null;

    // debug logs
    if (!window.__fpsInjectLogs) window.__fpsInjectLogs = [];
    const _logs = ["inner candidates: " + candidates.length];
    candidates.slice(0, 5).forEach((c, i) => {
      _logs.push(`  #${i} <${c.tag}> w=${c.cw} ch=${c.ch} sh=${c.sh} area=${c.area}`);
    });
    _logs.forEach(l => { console.log("[fullpage-shot]", l); window.__fpsInjectLogs.push(l); });

    const winScrollable = (document.documentElement.scrollHeight - VH) | 0;
    let mode = "window";
    if (bestEl) {
      const innerScrollable = bestEl.scrollHeight - bestEl.clientHeight;
      if (innerScrollable > Math.max(winScrollable * 2, 800)) {
        mode = "inner";
      }
    }
    const _modeLog = `mode=${mode}, winScrollable=${winScrollable}`;
    console.log("[fullpage-shot]", _modeLog);
    if (!window.__fpsInjectLogs) window.__fpsInjectLogs = [];
    window.__fpsInjectLogs.push(_modeLog);
    window.__fpsHost = mode === "inner" ? bestEl : null;
    window.__fpsMode = mode;

    const dpr = window.devicePixelRatio || 1;
    if (mode === "inner" && bestEl) {
      const rect = bestEl.getBoundingClientRect();
      return {
        mode,
        dpr,
        width: bestEl.clientWidth | 0,
        height: bestEl.scrollHeight | 0,
        viewportW: VW,
        viewportH: bestEl.clientHeight | 0,
        windowVH: VH,
        rectLeft: Math.max(0, Math.round(rect.left)),
        rectTop: Math.max(0, Math.round(rect.top))
      };
    }
    return {
      mode,
      dpr,
      width:
        (document.documentElement.scrollWidth | 0) ||
        (document.body && document.body.scrollWidth) ||
        VW,
      height:
        (document.documentElement.scrollHeight | 0) ||
        (document.body && document.body.scrollHeight) ||
        VH,
      viewportW: VW,
      viewportH: VH,
      windowVH: VH,
      rectLeft: 0,
      rectTop: 0
    };
  });

  if (!info) throw new Error(
    `Could not access page content for capture.\n\nLikely causes:\n• The page has a strict Content-Security-Policy that blocks script injection\n• The page didn't finish loading\n• You're on an internal page (chrome://, etc.)\n\nReload the page and try again. If it still fails, check Service Worker console at chrome://extensions for details.`
  );
  fpsLog("scroll info:", info);

  const w = Math.max(1, info.width);
  let h = Math.max(1, info.height);
  const vh = Math.max(100, info.viewportH);
  const dpr = info.dpr;
  // canvas at physical resolution (×dpr) preserves capture sharpness.
  // 16384 is the OffscreenCanvas hard limit (physical px), so CSS-height limit is 16384/dpr.
  let truncated = false;
  const maxCssHeight = Math.floor(MAX_FINAL_HEIGHT / dpr);
  if (h > maxCssHeight) {
    h = maxCssHeight;
    truncated = true;
  }

  // save original scroll position (by mode)
  const origScrollY = await execInPage(tabId, () => {
    if (window.__fpsMode === "inner" && window.__fpsHost) {
      return window.__fpsHost.scrollTop || 0;
    }
    return window.scrollY || 0;
  });

  const slices = [];
  let scrollY = 0;
  let lastActualY = -1;
  let safety = 0;
  const SAFETY_CAP = 200;

  while (scrollY < h && safety < SAFETY_CAP) {
    safety++;
    // scroll for each slice + re-read host's current rect (virtual lists may re-render and change rect)
    const scrollResult = await execInPage(
      tabId,
      (yy) => {
        let actualY = 0;
        let rectLeft = 0, rectTop = 0, hostW = 0, hostH = 0;
        if (window.__fpsMode === "inner" && window.__fpsHost) {
          window.__fpsHost.scrollTop = yy;
          actualY = window.__fpsHost.scrollTop || 0;
          // wait a frame after scroll before reading rect (let layout update)
          const rect = window.__fpsHost.getBoundingClientRect();
          rectLeft = Math.max(0, Math.round(rect.left));
          rectTop = Math.max(0, Math.round(rect.top));
          hostW = window.__fpsHost.clientWidth | 0;
          hostH = window.__fpsHost.clientHeight | 0;
        } else {
          window.scrollTo(0, yy);
          actualY = window.scrollY || 0;
        }
        return { actualY, rectLeft, rectTop, hostW, hostH };
      },
      [scrollY]
    );
    const actualYNum = (scrollResult && typeof scrollResult.actualY === "number") ? scrollResult.actualY : scrollY;

    // update progress UI (based on scroll progress / estimated slice total)
    // actual slice count accounts for OVERLAP=40 overlap: each slice advances (vh - 40), so +1 for the starting slice
    const stepPx = Math.max(80, vh - 40);
    const estimatedTotal = Math.max(1, Math.ceil((h - vh) / stepPx) + 1);
    const currentSegment = safety;
    const percent = Math.min(95, 10 + Math.round((actualYNum / h) * 85));
    try {
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: false },
        func: updateProgressUI,
        args: [{ text: `Capturing... ${currentSegment} / ~${estimatedTotal}`, percent }]
      });
    } catch (_) {}

    // 600ms: gives virtual lists time to render + captureVisibleTab quota (Chrome allows max 2/sec)
    await sleep(600);

    // temporarily hide progress UI before capture so it does not appear in the screenshot
    try {
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: false },
        func: setProgressUIVisible,
        args: [false]
      });
    } catch (_) {}
    // short wait so browser actually repaints
    await sleep(30);

    // Use chrome.debugger Page.captureScreenshot for forced sharpness (2× on Retina)
    // cost: short "is debugging this browser" banner, in exchange for true physical-pixel resolution
    const visDataUrl = await captureWithDebugger(tab.id);

    // restore after capture UI
    try {
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: false },
        func: setProgressUIVisible,
        args: [true]
      });
    } catch (_) {}
    // record each slice's rect at capture time (used by inner mode); no longer rely on initial info.rectLeft/rectTop
    slices.push({
      y: actualYNum,
      dataUrl: visDataUrl,
      rectLeft: scrollResult ? scrollResult.rectLeft : 0,
      rectTop: scrollResult ? scrollResult.rectTop : 0
    });

    if (actualYNum === lastActualY) break; // reached the bottom
    lastActualY = actualYNum;
    // leave 40px overlap with the next slice
    const OVERLAP = 40;
    scrollY = actualYNum + Math.max(80, vh - OVERLAP);
  }

  // restore original scroll
  await execInPage(
    tabId,
    (yy) => {
      if (window.__fpsMode === "inner" && window.__fpsHost) {
        window.__fpsHost.scrollTop = yy;
      } else {
        window.scrollTo(0, yy);
      }
    },
    [origScrollY || 0]
  ).catch(() => {});

  // ── Key fix: derive real dpr from actual bitmap pixel size, do not trust window.devicePixelRatio ──
  // In many setups (external 5K at low resolution, custom zoom, etc.) devicePixelRatio
  // may not match the captureVisibleTab actual output's physical-pixel ratio.
  // We decode the first slice and compute real ratio = bmp.width / viewportCSS, then size the canvas accordingly.
  const isInner = info.mode === "inner";
  const baseCanvasW_css = isInner ? (info.viewportW || w) : w;

  // predecode all slices (computing realDpr from the first one)
  const decodedSlices = [];
  let realDpr = dpr;
  for (let i = 0; i < slices.length; i++) {
    const s = slices[i];
    const blob = await (await fetch(s.dataUrl)).blob();
    const bmp = await createImageBitmap(blob);
    if (i === 0) {
      const cssVW = info.viewportW || (info.windowVH ? Math.round(bmp.width / dpr) : bmp.width);
      const measured = bmp.width / cssVW;
      // snap to standard ratios: 1, 1.25, 1.5, 2, 2.5, 3
      const allowed = [1, 1.25, 1.5, 2, 2.5, 3];
      let best = dpr;
      let bestDelta = Infinity;
      for (const candidate of allowed) {
        const d = Math.abs(candidate - measured);
        if (d < bestDelta) { bestDelta = d; best = candidate; }
      }
      realDpr = best;
      fpsLog(`dpr: window.devicePixelRatio=${dpr}, measured=${measured.toFixed(3)}, using=${realDpr}`);
    }
    decodedSlices.push({ ...s, bmp });
  }

  const canvasW = Math.round(baseCanvasW_css * realDpr);
  const canvasH = Math.round(h * realDpr);
  const canvas = new OffscreenCanvas(canvasW, canvasH);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Cannot create OffscreenCanvas 2D context");
  // Key: disable smoothing — no resampling when src and dst sizes match
  ctx.imageSmoothingEnabled = false;
  // fill canvas with the page's real background color (avoids white edges on dark pages)
  ctx.fillStyle = pageBgColor;
  ctx.fillRect(0, 0, canvasW, canvasH);

  const mainWidthPx = Math.round(w * realDpr);

  // main stitch — DO NOT close bmp inside the loop; close all after diff step
  for (const s of decodedSlices) {
    const bmp = s.bmp;
    const drawH = Math.min(vh, h - s.y);
    if (drawH <= 0) continue;
    const dstY = Math.round(s.y * realDpr);
    const dstH = Math.round(drawH * realDpr);
    if (isInner) {
      const rl = (typeof s.rectLeft === "number") ? s.rectLeft : info.rectLeft;
      const rt = (typeof s.rectTop === "number") ? s.rectTop : info.rectTop;
      const srcX = Math.round(rl * realDpr);
      const srcY = Math.round(rt * realDpr);
      const dstX = Math.round(rl * realDpr);
      ctx.drawImage(bmp, srcX, srcY, mainWidthPx, dstH, dstX, dstY, mainWidthPx, dstH);
    } else {
      ctx.drawImage(bmp, 0, 0, canvasW, dstH, 0, dstY, canvasW, dstH);
    }
  }

  // ── Paste overlay for CSS fixed/sticky elements (sidebar / top nav etc)──
  // These were hidden via visibility:hidden during detect, so the stitched canvas has empty regions in their place;
  // paste them back from the first frame so the sidebar/nav appears once in the long screenshot
  // Does not affect share button / input bar (CSS-not-fixed → not in stickyOverlays list anyway)
  if (firstFrameDataUrl && stickyOverlays.length > 0) {
    try {
      const ffBlob = await (await fetch(firstFrameDataUrl)).blob();
      const ffBmp = await createImageBitmap(ffBlob);
      const VPH = info.windowVH || info.viewportH;  // viewport physical height (CSS px)
      // Only a "truly bottom-pinned bar" counts as bottom. Rule:
      //   bottom edge within 20% of viewport height (adaptive, ~150-200px on 839px viewport)
      //   AND element height < half viewport (excludes full-height sidebars)
      const BOTTOM_GAP_THRESHOLD = Math.max(80, VPH * 0.2);
      const HEIGHT_RATIO_MAX = 0.5;
      let topCount = 0, bottomCount = 0;
      for (const ov of stickyOverlays) {
        const sx = Math.round(ov.left * realDpr);
        const sy = Math.round(ov.top * realDpr);
        const sw = Math.round(ov.width * realDpr);
        const sh = Math.round(ov.height * realDpr);
        const dx = Math.round(ov.left * realDpr);
        const distFromBottom = VPH - (ov.top + ov.height);
        const isSmallBar = ov.height < VPH * HEIGHT_RATIO_MAX;
        const isBottom = distFromBottom < BOTTOM_GAP_THRESHOLD && isSmallBar;
        let dy;
        if (isBottom) {
          // paste at canvas bottom, preserving original gap-from-bottom
          dy = canvasH - sh - Math.round(distFromBottom * realDpr);
          bottomCount++;
        } else {
          // default: paste at original position (top fixed + sidebar both fall here)
          dy = Math.round(ov.top * realDpr);
          topCount++;
        }
        ctx.drawImage(ffBmp, sx, sy, sw, sh, dx, dy, sw, sh);
      }
      ffBmp.close();
      fpsLog(`pasted ${stickyOverlays.length} sticky overlays (${topCount} top, ${bottomCount} bottom) in ${info.mode} mode at realDpr=${realDpr}`);
    } catch (e) {
      console.warn("[fullpage-shot] sticky overlay paste failed:", e.message);
    }
  }

  // ── post-capture pixel diff has been tried 4 times (row/cell/band/per-pixel); each introduced new bugs ──
  // Claude.ai semi-transparent input bar's per-pixel cross-slice diff exceeds fuzzy tolerance; forced overlay damages main content
  // Accept current behavior: CSS-fixed/sticky get overlay; CSS-not-fixed-but-visually-pinned elements will repeat
  if (false && decodedSlices.length >= 2) {
    try {
      // take ImageData of every slice
      const sliceImageData = [];
      for (const s of decodedSlices) {
        const tmp = new OffscreenCanvas(s.bmp.width, s.bmp.height);
        const tctx = tmp.getContext("2d");
        tctx.imageSmoothingEnabled = false;
        tctx.drawImage(s.bmp, 0, 0);
        sliceImageData.push(tctx.getImageData(0, 0, s.bmp.width, s.bmp.height));
      }
      const W = sliceImageData[0].width;
      const H = sliceImageData[0].height;
      const BOTTOM_BAND = Math.min(Math.round(H * 0.22), 200);
      const BOTTOM_START = H - BOTTOM_BAND;

      // In the bottom band, per-pixel find pixels nearly identical across all slices — fuzzy match (RGB ±10 tolerates anti-aliasing)
      const bottomMask = new Uint8Array(W * BOTTOM_BAND);
      let fixedPxCount = 0;
      const data0 = sliceImageData[0].data;
      const TOL = 10;
      for (let by = 0; by < BOTTOM_BAND; by++) {
        const y = BOTTOM_START + by;
        for (let x = 0; x < W; x++) {
          const i = (y * W + x) * 4;
          const r0 = data0[i], g0 = data0[i + 1], b0 = data0[i + 2];
          let allSame = true;
          for (let k = 1; k < sliceImageData.length; k++) {
            const dk = sliceImageData[k].data;
            if (Math.abs(dk[i] - r0) > TOL ||
                Math.abs(dk[i + 1] - g0) > TOL ||
                Math.abs(dk[i + 2] - b0) > TOL) {
              allSame = false; break;
            }
          }
          if (allSame) {
            bottomMask[by * W + x] = 1;
            fixedPxCount++;
          }
        }
      }
      const totalBottomPx = W * BOTTOM_BAND;
      fpsLog(`bottom-px-diff: ${fixedPxCount}/${totalBottomPx} pixels visually fixed (${(fixedPxCount/totalBottomPx*100).toFixed(1)}%, fuzzy ±${TOL})`);

      // apply:
      //   1. Mid-section fixed pixels (each slice's natural position) → CLEAR with page bg color
      //      (can't use slice[0] — slice[0] there is also the input bar, so 'overlay' would be a no-op)
      //   2. At canvas bottom → PASTE slice[0]'s fixed pixels (final input bar)
      if (fixedPxCount > 0 && fixedPxCount < totalBottomPx * 0.95) {
        // parse page bg color
        let bgR = 30, bgG = 30, bgB = 30;
        const m = pageBgColor.match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
        if (m) { bgR = +m[1]; bgG = +m[2]; bgB = +m[3]; }

        // overlay A: fixed pixels = bg color (for clearing mid-sections)
        const clearData = new Uint8ClampedArray(W * BOTTOM_BAND * 4);
        // overlay B: fixed pixels = slice[0] pixels (for canvas-bottom paste)
        const finalData = new Uint8ClampedArray(W * BOTTOM_BAND * 4);
        for (let by = 0; by < BOTTOM_BAND; by++) {
          const y = BOTTOM_START + by;
          for (let x = 0; x < W; x++) {
            const maskI = by * W + x;
            const dstI = maskI * 4;
            const srcI = (y * W + x) * 4;
            if (bottomMask[maskI]) {
              clearData[dstI]     = bgR;
              clearData[dstI + 1] = bgG;
              clearData[dstI + 2] = bgB;
              clearData[dstI + 3] = 255;
              finalData[dstI]     = data0[srcI];
              finalData[dstI + 1] = data0[srcI + 1];
              finalData[dstI + 2] = data0[srcI + 2];
              finalData[dstI + 3] = 255;
            }
          }
        }
        const clearCanvas = new OffscreenCanvas(W, BOTTOM_BAND);
        clearCanvas.getContext("2d").putImageData(new ImageData(clearData, W, BOTTOM_BAND), 0, 0);
        const finalCanvas = new OffscreenCanvas(W, BOTTOM_BAND);
        finalCanvas.getContext("2d").putImageData(new ImageData(finalData, W, BOTTOM_BAND), 0, 0);

        // Step 1: clear bottom fixed-pixel positions for every slice (including slice[0]'s natural position)
        for (let i = 0; i < decodedSlices.length; i++) {
          const s = decodedSlices[i];
          const drawH = Math.min(vh, h - s.y);
          if (drawH <= 0) continue;
          const dstY = Math.round(s.y * realDpr) + BOTTOM_START;
          if (dstY + BOTTOM_BAND <= canvasH) {
            ctx.drawImage(clearCanvas, 0, 0, W, BOTTOM_BAND, 0, dstY, W, BOTTOM_BAND);
          }
        }
        // Step 2: paste slice[0]'s input bar at canvas bottom
        const finalDstY = canvasH - BOTTOM_BAND;
        ctx.drawImage(finalCanvas, 0, 0, W, BOTTOM_BAND, 0, finalDstY, W, BOTTOM_BAND);

        fpsLog(`bottom-px-diff applied: cleared ${fixedPxCount} fixed pixels on ${decodedSlices.length} slices, pasted at canvas bottom`);
      } else {
        fpsLog(`bottom-px-diff: skipped (count=${fixedPxCount}, threshold check failed)`);
      }
    } catch (e) {
      console.warn("[fullpage-shot] band-diff failed:", e.message);
      fpsLog("band-diff failed: " + e.message);
    }
  }

  // close all bmps (after row/cell/band/pixel diff is done)
  for (const s of decodedSlices) {
    try { s.bmp.close(); } catch (_) {}
  }

  const outBlob = await canvas.convertToBlob({ type: "image/png" });
  const dataUrl = await blobToDataUrl(outBlob);
  return { dataUrl, width: w, height: info.height, truncated };
}

// chrome.scripting.executeScript wrapper: runs the function in page context and returns the result
// Capture via chrome.debugger (high-res): attach first + force deviceScaleFactor for higher resolution
// Cost: shows "is debugging this browser" banner at top for a few seconds
async function captureWithDebugger(tabId) {
  const target = { tabId };
  let attached = false;
  try {
    await new Promise((resolve, reject) => {
      chrome.debugger.attach(target, "1.3", () => {
        const e = chrome.runtime.lastError;
        if (e && !/already attached/i.test(e.message)) return reject(new Error(e.message));
        resolve();
      });
    });
    attached = true;
    // captureBeyondViewport: false → only the current viewport
    // fromSurface: true → grab directly from GPU surface, faster and sharper
    const result = await new Promise((resolve, reject) => {
      chrome.debugger.sendCommand(
        target,
        "Page.captureScreenshot",
        { format: "png", captureBeyondViewport: false, fromSurface: true },
        (r) => {
          const e = chrome.runtime.lastError;
          if (e) return reject(new Error("captureScreenshot: " + e.message));
          if (!r || !r.data) return reject(new Error("captureScreenshot returned empty"));
          resolve(r);
        }
      );
    });
    return "data:image/png;base64," + result.data;
  } finally {
    if (attached) {
      try {
        await new Promise((resolve) => chrome.debugger.detach(target, () => resolve()));
      } catch (_) {}
    }
  }
}

async function execInPage(tabId, func, args) {
  try {
    const r = await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      func,
      args: args || []
    });
    return r && r[0] ? r[0].result : null;
  } catch (e) {
    console.warn("[fullpage-shot] execInPage failed:", e.message);
    return null;
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function ensureOffscreen() {
  const has = await chrome.offscreen.hasDocument();
  if (has) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["AUDIO_PLAYBACK"],
    justification: "Play camera shutter sound"
  });
}

async function playShutter() {
  await ensureOffscreen();
  await chrome.runtime.sendMessage({ type: "PLAY_SHUTTER" });
}

async function reportError(tab, err) {
  console.error("[fullpage-shot]", err);
  const msg = (err && err.message) || String(err);
  const fullMsg = tab && tab.url ? `${msg}\n\n📍 Tried to capture: ${tab.url}` : msg;
  // Include logs on errors too for easier diagnosis
  let logs = currentCaptureLogs.slice();
  try {
    const r = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: false },
      func: () => { const out = window.__fpsInjectLogs || []; window.__fpsInjectLogs = []; return out; }
    });
    const il = (r && r[0] && Array.isArray(r[0].result)) ? r[0].result : [];
    for (const l of il) logs.push("[inject] " + l);
  } catch (_) {}
  try {
    await chrome.storage.local.set({
      lastShot: { error: fullMsg, capturedAt: Date.now(), logs }
    });
    await chrome.tabs.create({ url: chrome.runtime.getURL("viewer.html") });
  } catch (_) {}
}
