// background.js — service worker（type: module）
//
// v2 修复要点：
//   1. 截图前先用 chrome.scripting 注入"全页面预滚动"，强制触发懒加载内容渲染
//   2. 用 Page.captureScreenshot + captureBeyondViewport: true 截整页
//   3. >16000 px 的页面分段截，再用 OffscreenCanvas 拼接
//      Chromium 2D canvas 上限 16384，超过部分目前会截断并在 viewer 标记
//   4. PNG 存 chrome.storage.local（unlimitedStorage）
//   5. offscreen 播放 shutter.wav
//   6. 打开 viewer.html 让用户在那点按钮把 PNG 写进剪贴板

const MAX_SLICE_HEIGHT = 16000;
const MAX_FINAL_HEIGHT = 16384; // OffscreenCanvas 单画布高度上限

// 全局日志缓冲区，每次 capture 开始时清空。同时输出 console + 存进 buffer 给 viewer 显示
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
  // 每次 capture 重置日志缓冲
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

  // 0.5 装进度 UI（让用户看到"扩展正在工作"，页面滚动是预期的）
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

  // 1. 注入预滚动脚本，触发懒加载（很多瀑布流/Reddit/Twitter 不滚到底就不渲染）
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: false },
      func: preloadAllContent
    });
  } catch (e) {
    console.warn("[fullpage-shot] 预滚动失败（可能页面有 CSP 或不允许注入）:", e.message);
  }

  // 2. 等一拍让懒加载图片解码、布局稳定
  await sleep(300);

  // 2.5 拍 first frame（hide 之前的原始视口）+ 检测 sidebar/sticky 元素位置
  //     拼接结束时把这些元素从 first frame 抠出来贴回拼接图，模拟"始终静止在那"的视觉
  let firstFrameDataUrl = null;
  let stickyOverlays = [];
  try {
    // 截 first frame 前先隐藏进度 UI
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: false },
        func: setProgressUIVisible,
        args: [false]
      });
    } catch (_) {}
    await sleep(30);
    firstFrameDataUrl = await new Promise((resolve, reject) => {
      chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" }, (du) => {
        const e = chrome.runtime.lastError;
        if (e) return reject(new Error(e.message));
        if (!du) return reject(new Error("first frame empty"));
        resolve(du);
      });
    });
    // 截完恢复
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
  } catch (e) {
    console.warn("[fullpage-shot] first frame / overlay detection failed:", e.message);
  }

  // 3. 注入"消固定"：彻底 display:none 所有 fixed/sticky，避免拼接重复
  let neutralized = false;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: false },
      func: neutralizeStickyAndFixed
    });
    neutralized = true;
  } catch (e) {
    console.warn("[fullpage-shot] 注入消固定样式失败:", e.message);
  }
  await sleep(120);

  let dataUrl;
  let widthPx;
  let heightPx;
  let truncated = false;

  try {
    const result = await scrollStitch(tab, { firstFrameDataUrl, stickyOverlays });
    dataUrl = result.dataUrl;
    widthPx = result.width;
    heightPx = result.height;
    truncated = result.truncated;
  } finally {
    // 5. 截图完成或失败都要还原页面样式 + 移除进度 UI
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

  // 落盘 → 把绝对路径塞进 meta，让 viewer 把 @path 写进剪贴板
  // 这是"粘进 Mac 终端"唯一能 work 的路径：图片字节 ⌘V 进 Terminal.app 永远是空
  let savedPath = null;
  let saveError = null;
  try {
    savedPath = await saveToDownloads(dataUrl, tab.url);
  } catch (e) {
    console.warn("[fullpage-shot] 落盘失败:", e);
    saveError = (e && e.message) || String(e);
  }
  meta.savedPath = savedPath;
  meta.saveError = saveError;

  // 收集 inject 函数里的日志（跑在目标 tab 的）合并到 background 自己的日志
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

  // 进度推到 100% — viewer 即将打开
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: false },
      func: updateProgressUI,
      args: [{ text: "Done!", percent: 100 }]
    });
  } catch (_) {}

  playShutter().catch((e) => console.warn("[fullpage-shot] 播放音效失败:", e));

  // 关键：把图片作为「文件引用」写到剪贴板（等价于 Finder ⌘C 那个文件）
  // Web Clipboard API 写不了文件引用类型，必须通过 Native Messaging 调本地 osascript
  // 装好 native host 后，Claude Code TUI ⌘V 直接 attach 图片
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
      console.warn("[fullpage-shot] native host 不可用（没装？）:", e.message);
    }
    // 写完最新的 meta（带 clipboardMode）
    await chrome.storage.local.set({ lastShot: { dataUrl, meta } });
  }

  await chrome.tabs.create({ url: chrome.runtime.getURL("viewer.html"), active: true });
}

// 把 URL 提取成文件名安全的 host 串：超过 40 字符就保留尾部（域名常在右侧最能认人），
// 并跳到下一个 `.` 后面避免开头是半截 subdomain
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
  // 命名格式：fullpage-{host}-{YYYY-MM-DD}T{HH-MM-SS}.png（用户指定）
  // 本地时区，时间用 T 分隔，HMS 用 dash。
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  const host = safeHost(sourceUrl);
  // 直接落到 Downloads 根目录，不进子文件夹（用户反馈"路径太深"）
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

  // 等下载完成，拿绝对路径
  const filePath = await new Promise((resolve, reject) => {
    const onChange = (delta) => {
      if (delta.id !== downloadId) return;
      if (delta.state && delta.state.current === "complete") {
        chrome.downloads.onChanged.removeListener(onChange);
        chrome.downloads.search({ id: downloadId }, (items) => {
          if (items && items[0] && items[0].filename) {
            resolve(items[0].filename);
          } else {
            reject(new Error("找不到下载记录"));
          }
        });
      } else if (delta.error && delta.error.current) {
        chrome.downloads.onChanged.removeListener(onChange);
        reject(new Error("下载错误：" + delta.error.current));
      }
    };
    chrome.downloads.onChanged.addListener(onChange);
    setTimeout(() => {
      chrome.downloads.onChanged.removeListener(onChange);
      reject(new Error("下载超时（30s）"));
    }, 30000);
  });

  return filePath;
}

// 注入到目标 tab：装一个浮动进度 UI（顶部细线 + 中央卡片）。
// 让用户看到"扩展正在截图，页面滚动是预期的"，不是页面 bug。
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

  // 顶部彩色细线进度条（4px，更明显）
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

  // 右下角大卡片（不挡顶部主内容，醒目）
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

  // pulse 动画
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

// 注入到目标 tab：检测所有 CSS position: fixed/sticky 元素，返回它们的视口 rect。
// 简化版：纯 CSS 检测，不做 scroll-then-measure（那会触发 React re-render 破坏页面）。
// 漏掉的"视觉固定但 CSS 不是 fixed"的元素（如 Share 按钮）暂时接受重复出现，
// 优先级 < 截整页的能力。
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
  // 去重：包含关系 → 只留外层
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

// 注入到目标 tab：把所有 position:fixed / position:sticky 元素彻底**隐藏**（display:none）。
// 之前用 absolute 不够 —— SPA 里 sidebar 仍然在视口内出现。
// 直接 display:none 让它们彻底消失，截图就只有页面主内容，不会重复。
// 截图完成后通过 restoreStickyAndFixed 还原。
function neutralizeStickyAndFixed() {
  const KEY = "__fullpageShotNeutralized__";
  if (window[KEY]) return;
  const restored = [];
  // 1. 全局禁用动画/过渡
  const styleEl = document.createElement("style");
  styleEl.id = "__fullpage_shot_anim_off__";
  styleEl.textContent =
    "*,*::before,*::after{animation-duration:0s !important;animation-delay:0s !important;" +
    "transition-duration:0s !important;transition-delay:0s !important;}";
  (document.head || document.documentElement).appendChild(styleEl);

  // 2. 遍历所有元素，找 CSS fixed/sticky → display:none
  // （detect 阶段已经直接 hide 了 visually-stuck 元素，这里只处理 detect 漏掉的 CSS 级 fixed/sticky）
  // ⚠️ 跳过 data-fullpage-shot=ui 标记的元素（我们自己的进度 UI 等）
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
      el.style.setProperty("display", "none", "important");
      hiddenCount++;
    }
  }
  const _hideLog = "hidden " + hiddenCount + " fixed/sticky elements (CSS-based)";
  console.log("[fullpage-shot]", _hideLog);
  if (!window.__fpsInjectLogs) window.__fpsInjectLogs = [];
  window.__fpsInjectLogs.push(_hideLog);

  // 3. body/html overflow:hidden 解掉
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

// 注入到目标 tab：滚到底再回顶，强制懒加载渲染。返回观察到的最大 scrollHeight。
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
      // 给浏览器一个 frame 让 sticky-header 之类回到正常状态
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

// 自己驱动滚动 → 截每段可见视口 → 拼接到 OffscreenCanvas
// 用 chrome.tabs.captureVisibleTab（不需要 debugger，没有"正在调试"横幅）
// 关键升级：先识别"真正在滚的那个容器"（window 或某个内部 div）。
async function scrollStitch(tab, opts) {
  const tabId = tab.id;
  const firstFrameDataUrl = opts && opts.firstFrameDataUrl;
  const stickyOverlays = (opts && opts.stickyOverlays) || [];
  // 步骤 1：在页面上下文里找出"最大可滚动元素"和它的尺寸/DPR，
  // 同时把它存到 window.__fpsHost，后续每一帧 scroll 都用同一个引用。
  const info = await execInPage(tabId, () => {
    const VW = window.innerWidth;
    const VH = window.innerHeight;
    // 候选必须是"主内容区"——宽度 >= viewport 一半，否则就是 sidebar / aside / 抽屉
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
        // 关键过滤：太窄的容器肯定不是主内容（typically sidebar 250-300px）
        if (cw < MIN_HOST_WIDTH) continue;
        // 排除被隐藏的元素
        if (cs.display === "none" || cs.visibility === "hidden") continue;
        // 排除明显的 aside/nav 角色
        const tag = el.tagName.toLowerCase();
        const role = el.getAttribute("role");
        if (tag === "aside" || tag === "nav") continue;
        if (role === "navigation" || role === "complementary") continue;

        const area = (sh - ch) * ch;
        candidates.push({ el, area, sh, ch, cw, tag });
      } catch (_) {}
    }
    // 按 area 排序选最大（1.13.3 试过宽度优先反而误选 html/body 之类宽但实际滚不动的元素，回退）
    candidates.sort((a, b) => b.area - a.area);
    const bestEl = candidates[0] ? candidates[0].el : null;

    // 调试日志
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
  // canvas 是物理分辨率（×dpr），保留原始截图清晰度。
  // 16384 是 OffscreenCanvas 单边硬上限（物理像素），所以 CSS 高度上限是 16384/dpr。
  let truncated = false;
  const maxCssHeight = Math.floor(MAX_FINAL_HEIGHT / dpr);
  if (h > maxCssHeight) {
    h = maxCssHeight;
    truncated = true;
  }

  // 保存原 scroll 位置（按 mode 选）
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
    // 每段都重新滚 + 重新读 host 当前 rect（虚拟列表 re-render 后 rect 可能变）
    const scrollResult = await execInPage(
      tabId,
      (yy) => {
        let actualY = 0;
        let rectLeft = 0, rectTop = 0, hostW = 0, hostH = 0;
        if (window.__fpsMode === "inner" && window.__fpsHost) {
          window.__fpsHost.scrollTop = yy;
          actualY = window.__fpsHost.scrollTop || 0;
          // 滚动后等一帧再读 rect（让浏览器布局更新）
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

    // 更新进度 UI（基于 scroll progress / 估算总段数）
    const estimatedTotal = Math.max(1, Math.ceil(h / vh));
    const currentSegment = safety;
    const percent = Math.min(95, 10 + Math.round((actualYNum / h) * 85));
    try {
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: false },
        func: updateProgressUI,
        args: [{ text: `Capturing... ${currentSegment} / ~${estimatedTotal}`, percent }]
      });
    } catch (_) {}

    // 600ms：给虚拟列表渲染时间 + captureVisibleTab 配额限制（Chrome 每秒最多 2 次）
    await sleep(600);

    // 截图前临时隐藏进度 UI，避免它出现在截图里
    try {
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: false },
        func: setProgressUIVisible,
        args: [false]
      });
    } catch (_) {}
    // 短等让浏览器实际重绘
    await sleep(30);

    const visDataUrl = await new Promise((resolve, reject) => {
      chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" }, (du) => {
        const err = chrome.runtime.lastError;
        if (err) return reject(new Error("captureVisibleTab: " + err.message));
        if (!du) return reject(new Error("captureVisibleTab returned empty"));
        resolve(du);
      });
    });

    // 截完恢复 UI
    try {
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: false },
        func: setProgressUIVisible,
        args: [true]
      });
    } catch (_) {}
    // 每段记下当时的 rect（inner mode 用），不再依赖初始 info.rectLeft/rectTop
    slices.push({
      y: actualYNum,
      dataUrl: visDataUrl,
      rectLeft: scrollResult ? scrollResult.rectLeft : 0,
      rectTop: scrollResult ? scrollResult.rectTop : 0
    });

    if (actualYNum === lastActualY) break; // 已到底
    lastActualY = actualYNum;
    // 下一段往前留 40px 重叠
    const OVERLAP = 40;
    scrollY = actualYNum + Math.max(80, vh - OVERLAP);
  }

  // 恢复原 scroll
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

  // ── 关键修复：从实际 bmp 像素反推真实 dpr，不信 window.devicePixelRatio ──
  // 不少配置下（外接 5K 显示器走低分辨率、用户自定义 zoom 等）devicePixelRatio
  // 报告的值不是 captureVisibleTab 实际输出的物理像素倍率。
  // 我们先解码第一段截图，从 bmp.width / viewportCSS 算真实倍率，再据此建 canvas。
  const isInner = info.mode === "inner";
  const baseCanvasW_css = isInner ? (info.viewportW || w) : w;

  // 预解码所有段（顺便从第一段算 realDpr）
  const decodedSlices = [];
  let realDpr = dpr;
  for (let i = 0; i < slices.length; i++) {
    const s = slices[i];
    const blob = await (await fetch(s.dataUrl)).blob();
    const bmp = await createImageBitmap(blob);
    if (i === 0) {
      const cssVW = info.viewportW || (info.windowVH ? Math.round(bmp.width / dpr) : bmp.width);
      const measured = bmp.width / cssVW;
      // 不要用奇怪的小数；只接受 1, 1.25, 1.5, 2, 2.5, 3
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
  if (!ctx) throw new Error("无法创建 OffscreenCanvas 2D context");
  // 关键：禁用插值 —— src 和 dst 同尺寸时不应有任何重采样
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvasW, canvasH);

  const mainWidthPx = Math.round(w * realDpr);

  // 主拼接 —— **不要在循环里 close bmp**，row-hash diff 之后统一 close
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

  // ── 贴 sticky overlays（用 realDpr，不是 dpr）─────────
  if (firstFrameDataUrl && stickyOverlays.length > 0) {
    try {
      const ffBlob = await (await fetch(firstFrameDataUrl)).blob();
      const ffBmp = await createImageBitmap(ffBlob);
      for (const ov of stickyOverlays) {
        const sx = Math.round(ov.left * realDpr);
        const sy = Math.round(ov.top * realDpr);
        const sw = Math.round(ov.width * realDpr);
        const sh = Math.round(ov.height * realDpr);
        const dx = Math.round(ov.left * realDpr);
        const dy = Math.round(ov.top * realDpr);
        ctx.drawImage(ffBmp, sx, sy, sw, sh, dx, dy, sw, sh);
      }
      ffBmp.close();
      fpsLog("pasted", stickyOverlays.length, "sticky overlays in", info.mode, "mode at realDpr=" + realDpr);
    } catch (e) {
      console.warn("[fullpage-shot] sticky overlay paste failed:", e.message);
    }
  }

  // ── Cell-based diff: 找出"在所有段都一样的 16x16 像素块" = 视觉固定区域 ──
  // 比 row-hash 精细：一行里 share 按钮 + main 内容混在一起，整行 hash 会被 main 污染。
  // 按 cell 比较，固定元素覆盖的 cells（如 share 按钮、sidebar）会被精确捕获。
  if (decodedSlices.length >= 2) {
    try {
      const CELL = 16;  // cell 大小（物理像素）
      // 1. 对每段截图取 ImageData
      const sliceDataList = [];
      for (const s of decodedSlices) {
        const tmp = new OffscreenCanvas(s.bmp.width, s.bmp.height);
        const tctx = tmp.getContext("2d");
        tctx.imageSmoothingEnabled = false;
        tctx.drawImage(s.bmp, 0, 0);
        sliceDataList.push({
          slice: s,
          imageData: tctx.getImageData(0, 0, s.bmp.width, s.bmp.height)
        });
      }
      const W = sliceDataList[0].imageData.width;
      const H = sliceDataList[0].imageData.height;
      const cellsX = Math.floor(W / CELL);
      const cellsY = Math.floor(H / CELL);

      // 2. 对每段每个 cell 算简单 hash（取 cell 中央像素 RGB）
      function cellHash(imageData, cx, cy) {
        const px = cx * CELL + CELL / 2 | 0;
        const py = cy * CELL + CELL / 2 | 0;
        const i = (py * W + px) * 4;
        return (imageData.data[i] << 16) | (imageData.data[i + 1] << 8) | imageData.data[i + 2];
      }

      // 3. 找"在所有段哈希都相同"的 cell = 视觉固定 cell
      const stickyCell = new Uint8Array(cellsX * cellsY);
      let stickyCellCount = 0;
      for (let cy = 0; cy < cellsY; cy++) {
        for (let cx = 0; cx < cellsX; cx++) {
          const h0 = cellHash(sliceDataList[0].imageData, cx, cy);
          let allSame = true;
          for (let i = 1; i < sliceDataList.length; i++) {
            if (cellHash(sliceDataList[i].imageData, cx, cy) !== h0) {
              allSame = false; break;
            }
          }
          if (allSame) {
            stickyCell[cy * cellsX + cx] = 1;
            stickyCellCount++;
          }
        }
      }
      const totalCells = cellsX * cellsY;
      fpsLog(`cell-diff: ${stickyCellCount} of ${totalCells} cells (${cellsX}x${cellsY}) are visually fixed`);

      // 4. 用 slice[0] 覆盖到 canvas 各段对应位置
      if (stickyCellCount > 0 && stickyCellCount < totalCells * 0.95) {
        const slice0 = sliceDataList[0];
        const fixCanvas = new OffscreenCanvas(W, H);
        const fctx = fixCanvas.getContext("2d");
        fctx.putImageData(slice0.imageData, 0, 0);

        // 对每段 slice[1..N]，把它对应位置的"固定 cells"用 slice[0] 覆盖
        for (let i = 1; i < sliceDataList.length; i++) {
          const s = sliceDataList[i].slice;
          const drawH = Math.min(vh, h - s.y);
          if (drawH <= 0) continue;
          const dstYBase = Math.round(s.y * realDpr);
          // 把每行的连续固定 cell 段合并成 horizontal runs，drawImage 一次画一段
          for (let cy = 0; cy < cellsY; cy++) {
            let runStart = -1;
            for (let cx = 0; cx <= cellsX; cx++) {
              const isFixed = cx < cellsX && stickyCell[cy * cellsX + cx];
              if (isFixed && runStart < 0) runStart = cx;
              if ((!isFixed || cx === cellsX) && runStart >= 0) {
                const runCells = cx - runStart;
                const sx = runStart * CELL;
                const sy = cy * CELL;
                const sw = runCells * CELL;
                const sh = CELL;
                // fixCanvas 就是整张 viewport（slice[0]），cell 在其中 = sx, sy
                // canvas 拼接时每段 dst x 也 = sx（canvas 宽 = viewport 宽）
                ctx.drawImage(fixCanvas, sx, sy, sw, sh, sx, dstYBase + sy, sw, sh);
                runStart = -1;
              }
            }
          }
        }
        fpsLog(`cell-diff applied: covered ${stickyCellCount} fixed cells across ${decodedSlices.length - 1} extra slices`);
      } else {
        fpsLog(`cell-diff: skipped (count=${stickyCellCount} of ${totalCells}, threshold check failed)`);
      }
    } catch (e) {
      console.warn("[fullpage-shot] cell-diff failed:", e.message);
      fpsLog("cell-diff failed: " + e.message);
    }
  }

  // 统一 close 所有 bmp（row-hash diff 之后）
  for (const s of decodedSlices) {
    try { s.bmp.close(); } catch (_) {}
  }

  const outBlob = await canvas.convertToBlob({ type: "image/png" });
  const dataUrl = await blobToDataUrl(outBlob);
  return { dataUrl, width: w, height: info.height, truncated };
}

// chrome.scripting.executeScript 包装：在页面上下文里跑函数，返回结果
async function execInPage(tabId, func, args) {
  try {
    const r = await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      func,
      args: args || []
    });
    return r && r[0] ? r[0].result : null;
  } catch (e) {
    console.warn("[fullpage-shot] execInPage 失败:", e.message);
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
    justification: "播放相机咔嚓声"
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
  // 出错也带上日志，方便诊断
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
