# Privacy Policy — Fullpage to Terminal

**Last updated: 2026-05-09**

## TL;DR

**This extension does not collect, store, transmit, or share any of your data. Period.**

Everything happens 100% locally on your machine. No analytics, no telemetry, no servers, no third-party APIs.

---

## What the extension does

When you press the hotkey or click the toolbar icon:

1. **Captures the visible content** of your current browser tab using Chrome's built-in `chrome.tabs.captureVisibleTab` API.
2. **Saves the resulting PNG file** to your local `~/Downloads/` folder via Chrome's `chrome.downloads` API.
3. **Writes the file path / file reference** to your local clipboard, so you can paste it into a terminal or another app.
4. (macOS, optional) Communicates with a locally-installed native helper script via `chrome.runtime.sendNativeMessage` — the helper only writes to your local clipboard.

That's it. No part of this process leaves your computer.

---

## What data is involved

| Data | Where it goes | Who can see it |
|---|---|---|
| The screenshot PNG | Your local `~/Downloads/` folder | Only you |
| The file path | Your local clipboard | Only you (and whatever app you paste into) |
| The URL of the page being captured | Used only to generate the filename (e.g. `fullpage-example.com-2026-05-03.png`); never transmitted | — |

**Nothing is uploaded. Nothing is logged remotely. The extension does not contact any server, ever.**

---

## Permissions explained

| Permission | Why we need it |
|---|---|
| `activeTab`, `tabs` | To know which tab to capture |
| `scripting` | To inject the pre-scroll + sticky-header neutralization scripts so full-page screenshots are clean |
| `offscreen` | To play the camera shutter sound effect |
| `clipboardWrite` | To write the file path to your clipboard so you can paste it |
| `storage`, `unlimitedStorage` | To pass the captured image data from the background script to the viewer page (local Chrome storage only) |
| `downloads` | To save the PNG to `~/Downloads/` |
| `nativeMessaging` | (macOS only, optional) To call the local helper script that writes a "file reference" to the clipboard, enabling Claude Code's `[Image #N]` auto-attach |
| `host_permissions: <all_urls>` | Required by `chrome.tabs.captureVisibleTab` to capture pages on any site |

---

## Third parties

**None.**

This extension does not include or load any third-party code, fonts, scripts, analytics SDKs, or trackers. There are no requests to any external domain.

---

## Source code

The full source code of this extension is open and available at:
**https://github.com/20200207noon-art/fullpage-to-terminal**

You can verify everything described above by reading the code yourself.

---

## Changes to this policy

If this policy ever changes (e.g. if a future version adds an opt-in cloud feature), the change will be announced in the GitHub repo and reflected here with a new "Last updated" date. We will not silently start collecting data.

---

## Contact

For questions or concerns, open an issue at the GitHub repo above, or email **20200207noon@gmail.com**.

---

## Native helper installer (macOS, optional)

If you choose to install the optional macOS native helper (downloaded as a separate `.pkg` from the GitHub Releases page), the installer drops two files on your machine:

- `/Library/Application Support/FullpageToTerminal/copy_file_to_clipboard.sh`
- `/Library/Google/Chrome/NativeMessagingHosts/com.fullpageshot.copyfile.json`

Both are 100% local, never run unless invoked by the extension via Chrome's Native Messaging, and contain no telemetry. To uninstall, run:

```sh
sudo bash "/Library/Application Support/FullpageToTerminal/uninstall.sh"
```
