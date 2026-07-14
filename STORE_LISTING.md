# Chrome Web Store Listing — 提交时直接填这里的内容

---

## 📌 v1.24.1 SHIP STATUS（2026-07-14 更新）

| 项 | 状态 |
|---|---|
| Web Store account 注册 | ✅ |
| Listing draft（ID `nibipkcfhagabnfhdmlpcnmmnebagolp`）| ✅ |
| GitHub repo `20200207noon-art/fullpage-to-terminal` | ✅ |
| Privacy policy 托管：`https://20200207noon-art.github.io/fullpage-to-terminal/PRIVACY.html` | ✅ |
| Promo images（promo/ 4 张）| ✅ |
| Native host `.pkg` 构建脚本 | ✅ |
| **v1.24.1 zip 待上传** | ⏳ `/Users/bo-bot/fullpage-shot.zip` |

### 上传步骤（10 分钟）

1. 打开 [Web Store dashboard](https://chrome.google.com/webstore/devconsole/4cbaee16-6011-44e0-a257-7fe9b6cab7d8/nibipkcfhagabnfhdmlpcnmmnebagolp/edit)
2. 左侧 → **Package** → **Upload new package** → 选 `/Users/bo-bot/fullpage-shot.zip`
3. **Store listing** tab → 滚到底部找 "What's new in this version" → 粘贴下面的 release notes
4. 右上角 **Submit for review**

### v1.24.1 What's new（复制粘贴用）

```
v1.24.1
- New: redesigned result page — a slim toolbar on top (status, saved path, copy / save actions) with the full screenshot filling the rest of the window.
- Fixed: on sites using CSS smooth scrolling (e.g. MDN), captures could come out garbled at the top with large blank areas below. All programmatic scrolling now forces instant mode, so slice positions are always read accurately.
- New (from 1.24.0): when a site ships a dedicated print stylesheet (<link media="print">), the capture now uses it. This produces dramatically cleaner screenshots on sites that designed a print layout — sponsor banners, sitemap link grids, and verbose footers are hidden, layout is tightened.
- Conservative: sites without a dedicated print stylesheet (most sites) capture the same as before — no change to existing behavior.
```

---

## 1. Item name (扩展名称)

```
Fullpage to Terminal
```

---

## 2. Short description (短描述, ≤132 字符)

```
Capture a full webpage screenshot and paste it straight into Claude Code (or any terminal-based AI CLI) as [Image #N].
```

(112 字符 ✓)

---

## 3. Detailed description (详细描述)

```
The fastest way to send a full webpage screenshot to Claude Code (or any terminal-based AI CLI). Press the hotkey, switch to your terminal, paste — done. The whole scrollable page shows up as [Image #N]. Just 2 keystrokes total.

Compared to alternatives:

• GoFullPage and similar full-page screenshot extensions: capture, then download a PNG — you still have to open Finder, find the file, ⌘C it, switch app, ⌘V. That's 5 steps.
• macOS Cmd+Shift+Ctrl+4: 2 steps, but it only captures the visible viewport — anything below the fold is missed.
• Fullpage to Terminal: 2 steps, AND captures the entire scrollable page.

The differentiator is the combination of "full page" + "auto-on-clipboard as a file reference" — no manual file juggling.

Fullpage to Terminal lets you capture a complete screenshot of any webpage — not just the visible part — and paste it directly into Claude Code (or any terminal-based AI CLI) as an [Image #N] attachment, with zero manual file handling.

━━━━━━━━━━━━━━━━━━━━━━━━━━━
HOW IT WORKS
━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. Press the hotkey (Option+A on macOS, Alt+A on Windows/Linux), or click the camera icon
2. The extension auto-scrolls the page, captures every section, and stitches them into a single high-resolution PNG
3. The PNG is saved to ~/Downloads/ and a viewer tab opens
4. Switch to your terminal where Claude Code is running, press ⌘V (or Ctrl+V), and the image attaches as [Image #N]

That's it. No manual file picking, no copying paths by hand.

━━━━━━━━━━━━━━━━━━━━━━━━━━━
WHY THIS EXISTS
━━━━━━━━━━━━━━━━━━━━━━━━━━━

Other "full page screenshot" extensions copy the image bytes to the clipboard. That's useless for terminals — Terminal.app, iTerm2, Windows Terminal etc. don't accept image MIME from the clipboard. Pasting gives you nothing.

This extension solves it correctly:
• Saves the PNG to disk first
• Writes a clipboard "file reference" (the same kind Finder/Explorer creates when you copy a file)
• Claude Code's terminal recognizes the file reference and attaches the image as [Image #N]

If you've ever wanted to send Claude Code a screenshot without juggling files, this is for you.

━━━━━━━━━━━━━━━━━━━━━━━━━━━
FEATURES
━━━━━━━━━━━━━━━━━━━━━━━━━━━

✓ Captures the entire page, including content below the fold
✓ Handles lazy-loaded content (auto-scroll triggers IntersectionObserver)
✓ Handles SPA inner-scroll containers (Claude.ai, Notion, ChatGPT, Linear)
✓ Neutralizes sticky/fixed headers to prevent duplicates
✓ Saves at native physical resolution (Retina-quality)
✓ Plays a satisfying shutter sound
✓ Free, open-source, no ads, no tracking, no telemetry

━━━━━━━━━━━━━━━━━━━━━━━━━━━
PLATFORM SUPPORT
━━━━━━━━━━━━━━━━━━━━━━━━━━━

• macOS: Full auto-paste support (requires a one-time native helper install — see GitHub)
• Windows / Linux: Click-to-copy fallback mode (paste the @path text, Claude Code loads the file)

━━━━━━━━━━━━━━━━━━━━━━━━━━━
PRIVACY
━━━━━━━━━━━━━━━━━━━━━━━━━━━

This extension does NOT collect, store, transmit, or share any of your data. Everything happens 100% locally. No analytics, no telemetry, no servers, no third-party APIs.

Full privacy policy: https://github.com/20200207noon-art/fullpage-to-terminal/blob/main/PRIVACY.md

Source code: https://github.com/20200207noon-art/fullpage-to-terminal
```

---

## 4. Category

**Productivity** （主类别）

(备选：Developer Tools — 但 Productivity 用户基数更大)

---

## 5. Language

**English** （主语言）

---

## 6. Privacy practices (隐私表单 — 必填)

Chrome 商店上架时会让你填一个 "Privacy practices" 表单，逐项回答：

| 问题 | 回答 |
|---|---|
| Single purpose | "Capture a full-page screenshot and put it on the clipboard in a format that terminal-based AI CLIs (like Claude Code) can paste as a file attachment." |
| 是否收集 PII（个人信息）？ | **No** |
| 是否收集 health info？ | **No** |
| 是否收集 financial info？ | **No** |
| 是否收集 authentication info？ | **No** |
| 是否收集 personal communications？ | **No** |
| 是否收集 location？ | **No** |
| 是否收集 web history？ | **No**（注意：捕获的图片只在用户本地，不上传，所以选 No）|
| 是否收集 user activity？ | **No** |
| 是否收集 website content？ | **No**（同上）|
| Data usage certifications（必勾）| ✅ "I do not sell or transfer user data to third parties..." 三条全勾 |

**关键**：必须勾全部三个 "data usage certifications"，否则不能提交。

**权限解释**（也会问每个权限为什么需要，照这个填）：

| Permission | 解释 |
|---|---|
| `activeTab` | "To know which tab the user wants to capture" |
| `tabs` | "To open a new tab showing the captured screenshot preview" |
| `scripting` | "To inject pre-scroll and sticky-header neutralization scripts so full-page captures are clean" |
| `offscreen` | "To play the camera shutter sound effect" |
| `clipboardWrite` | "To write the screenshot file path to the clipboard so the user can paste it" |
| `storage`, `unlimitedStorage` | "To pass captured image data from the background script to the viewer tab via local Chrome storage" |
| `downloads` | "To save the screenshot PNG to the user's Downloads folder" |
| `nativeMessaging` | "To call an optional locally-installed helper script that writes a file reference to the clipboard for one-step pasting" |
| `host_permissions: <all_urls>` | "Required by chrome.tabs.captureVisibleTab to capture pages on any site" |

---

## 7. 资产清单（已生成，提交时上传）

| 资产 | 路径 | 用途 |
|---|---|---|
| **商店扩展 zip** | `/Users/bo-bot/fullpage-shot.zip` | 上传到 "Package" |
| Icon 128 | 已嵌在 zip 内 | manifest 自动用 |
| Promo 1280×800 | `/Users/bo-bot/fullpage-shot/promo/promo-1280x800.png` | "Marquee promo tile" / "Marketing image" |
| Promo 440×280 | `/Users/bo-bot/fullpage-shot/promo/promo-440x280.png` | "Small promo tile" |
| 截图（≥1 张，1280×800） | **你需要自己截一张** —— 装上扩展 → 截图 → viewer 弹出 → 用 macOS Cmd+Shift+4+空格选 viewer 那个标签页窗口 | "Screenshots" |

---

## 8. 你需要自己做的（4 步）

### 第 1 步 — 创建 GitHub 仓库（10 分钟）
1. https://github.com/new → 仓库名 `fullpage-to-terminal` → Public
2. 上传整个 `/Users/bo-bot/fullpage-shot/` 内容（包含 native-host/、PRIVACY.md、tools/）
3. README.md 已经写好了
4. Settings → Pages → Source: `Deploy from a branch` → main / root → **Save**
5. 等几分钟，PRIVACY.md 就能通过 `https://20200207noon-art.github.io/fullpage-to-terminal/PRIVACY` 访问

### 第 2 步 — 注册 Chrome 开发者账号（5 分钟，$5 USD）
1. https://chrome.google.com/webstore/devconsole/
2. 用你的 Google 账号登录（20200207noon@gmail.com）
3. 同意 Developer Agreement
4. 付 $5 USD 注册费（一次性）

### 第 3 步 — 提交扩展（15 分钟）
1. Dashboard → "+ New item"
2. 上传 `/Users/bo-bot/fullpage-to-terminal-store.zip`
3. 按本文档 §1-§6 填表
4. 上传宣传图（§7）
5. 至少要传 1 张截图（你装上扩展自己截一下 viewer 页面就行）
6. Privacy policy URL 填：`https://20200207noon-art.github.io/fullpage-to-terminal/PRIVACY`
7. 点 "Submit for review"

### 第 4 步 — 等审核（1-7 天）
- Google 邮件通知通过 / 驳回
- 通过后扩展会出现在 https://chromewebstore.google.com/

---

## 9. 提示

- **如果第一次被驳回**（最可能的原因：用了 Apple 系统 icon），不要慌——重做一版原创 icon 重新提交，账号信誉不会损失多少
- **不要在描述里用 "Claude" 当主标题词**（避免被误认为冒充 Claude/Anthropic）。在副文案 / 描述中提到 "Claude Code" 是 OK 的，因为是描述兼容工具，不是冒充
- **被驳回邮件会写明原因**，按原因改即可
