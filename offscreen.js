// offscreen.js — 只负责播放 shutter.wav
// （剪贴板写入不在这里做，因为 transient activation 信号传不过来；改在 viewer.js 里由用户点击触发）

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "PLAY_SHUTTER") {
    const audio = new Audio(chrome.runtime.getURL("shutter.wav"));
    audio.volume = 0.9;
    audio.play().then(
      () => sendResponse({ ok: true }),
      (err) => sendResponse({ ok: false, error: String(err) })
    );
    return true; // async sendResponse
  }
});
