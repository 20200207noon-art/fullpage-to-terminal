# Fullpage to Terminal

**The fastest way to send a full webpage screenshot to Claude Code (or any terminal-based AI CLI).**

Press `Option+A` → switch to Claude → `⌘V` → done. The whole page (not just the visible part) shows up as `[Image #N]`. **2 keystrokes total.**

## What you'd do without this extension

| Tool | Steps |
|---|---|
| **GoFullPage / similar** | screenshot → download PNG → open Finder → ⌘C the file → switch app → ⌘V = **5 steps** |
| **macOS ⌘⇧⌃4** | drag area → ⌘V = **2 steps** *(but visible viewport only — no scrolling pages)* |
| **Fullpage to Terminal** | `Option+A` → `⌘V` = **2 steps**, **and** it's the entire scrollable page |

The combination of *full page* + *auto-on-clipboard-as-file-reference* is what other extensions don't ship. They give you a download to find and copy by hand.

---

## Hotkey

- **macOS:** `Option + A`
- **Windows / Linux:** `Alt + A`
- Or click the camera icon in the toolbar.

(Customize at `chrome://extensions/shortcuts` if it conflicts.)

---

## Platform support

| | macOS | Windows / Linux |
|---|---|---|
| Capture full page → save to `~/Downloads/` | ✅ | ✅ |
| **Auto-paste image as `[Image #N]` in Claude Code** (zero clicks after capture) | ✅ — needs one-time `install.sh` for the native helper | ❌ — native helper is macOS-only (uses `osascript`) |
| Click button in viewer → clipboard gets `@/absolute/path.png` text → paste into Claude Code → it loads the file | ✅ | ✅ |
| Save manually with the "Save as" button | ✅ | ✅ |

**Bottom line:**
- **macOS users** get the seamless "press hotkey → switch to terminal → ⌘V → done" flow once they run `install.sh` once.
- **Windows / Linux users** can still use it — just click the big button in the viewer, then `Ctrl+V` in their terminal to paste the path text. Slightly more clicks, same end result.

A Windows-native helper (PowerShell-based) is feasible but not yet built — open an issue if you need it.

---

## Install

1. Unzip `fullpage-shot.zip`
2. Open `chrome://extensions`
3. Toggle **Developer mode** on (top-right)
4. Click **Load unpacked**, select the `fullpage-shot/` folder
5. Pin the camera icon to the toolbar from the puzzle-piece menu

### macOS only — one-time native helper setup (for the auto-paste flow)

```bash
cd fullpage-shot/native-host
./install.sh <YOUR_EXTENSION_ID>
```

Find your extension ID at `chrome://extensions` on the Fullpage Shot card. Done.

---

## Usage

1. Open any web page
2. Press the hotkey (or click the toolbar icon)
3. Wait for the shutter sound — full-page PNG is now in `~/Downloads/`
4. A new tab opens with a preview
5. **macOS with helper installed:** clipboard already holds the file reference — switch to your terminal, press `⌘V`, hit Enter
6. **Without helper / on Windows:** click the big green button → clipboard holds `@/Users/…/foo.png` (or `C:\…`) → paste in terminal → hit Enter
7. Claude Code attaches the image as `[Image #N]`

---

## Why does this exist?

Terminal apps (`Terminal.app`, `iTerm2`, Windows Terminal, …) don't accept image MIME types from the clipboard — `⌘V` / `Ctrl+V` only pastes text. So a "screenshot tool that copies the image bytes" is useless for terminal-based AI CLIs.

This extension solves it two ways:
1. Save the image to disk
2. Either (a) write a "file reference" to the clipboard via a tiny native helper — Claude Code's TUI then reads the reference and attaches the file as `[Image #N]`, or (b) write the absolute path as plain text — paste it, hit Enter, Claude Code loads the file.

---

## Troubleshooting

### Hotkey doesn't fire

Open `chrome://extensions/shortcuts`, set a different combo. Don't use `⌘⇧S` — it conflicts with macOS Save As.

### `⌘V` in terminal pastes nothing

The native helper write may have failed. Open the viewer and click the big button — that falls back to writing `@path` text, which always works.

Check the helper log: `cat /tmp/fullpage-shot-host.log`

### Capture is truncated

Pages taller than 16384 px hit the Chromium 2D-canvas hard limit. The viewer shows a red warning. Manually scroll & re-trigger if a page has weird lazy-loading.

### Sticky header appears twice in the screenshot

Should be fixed in v1.x — the extension neutralizes `position: fixed/sticky` before capturing and restores after. If it still happens, the page probably uses `transform` to fake sticky.

### SPA pages (Claude.ai / Notion / ChatGPT / Linear) only capture one screen

The extension auto-detects the inner scrolling container. If it picks the wrong element, open the service-worker console at `chrome://extensions` and look at the `[fullpage-shot] scroll info:` log.

### Chrome internal pages can't be captured

`chrome://`, `chrome-extension://`, `view-source:` etc. — Chrome forbids extension access. No workaround.

---

## File structure

```
fullpage-shot/
├── manifest.json
├── background.js          # capture + scroll-stitch + save to disk + native message
├── offscreen.html
├── offscreen.js           # plays shutter.wav
├── viewer.html            # preview + big button + hotkey banner
├── viewer.js              # clipboard fallback + i18n
├── shutter.wav            # shutter sound (>1500 Hz)
├── icons/                 # 16 / 48 / 128
├── _locales/en/           # English UI strings (more languages can be dropped in)
├── native-host/           # macOS-only native helper for clipboard file-reference write
│   ├── copy_file_to_clipboard.sh
│   └── install.sh
└── tools/
    ├── generate_shutter.py
    └── generate_icons.py
```
