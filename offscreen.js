// offscreen.js — plays shutter.wav only
// (Clipboard writes are not done here; transient activation signal can't reach
//  this offscreen document. Done in viewer.js by user click instead.)

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
