#!/usr/bin/env python3
"""生成商店所需的 1280×800 截图 mockup —— 模拟 viewer 成功状态。
不需要装扩展真截，直接 PIL 画一张精致的"成功提示"截图。
"""

import os
from PIL import Image, ImageDraw, ImageFont

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "promo")
ICON_PATH = os.path.join(os.path.dirname(__file__), "..", "icons", "icon128.png")

# 调色（和 viewer.html 一致）
BG = (14, 17, 22)
PANEL = (22, 27, 34)
BORDER = (42, 49, 60)
TEXT = (230, 237, 243)
MUTED = (139, 148, 158)
ACCENT = (45, 164, 78)
BANNER_TOP = (31, 58, 37)
BANNER_BOT = (21, 41, 26)
KBD_BG = (13, 17, 23)
KBD_BORDER = (48, 54, 61)
PROMPT_GREEN = (95, 230, 130)
TERM_BG = (13, 17, 23)
TERM_BAR = (33, 38, 45)
ERR_PINK = (255, 180, 186)


def find_font(size: int, bold: bool = False, mono: bool = False):
    if mono:
        for p in ["/System/Library/Fonts/SFNSMono.ttf",
                  "/System/Library/Fonts/Menlo.ttc"]:
            if os.path.exists(p):
                try: return ImageFont.truetype(p, size)
                except: pass
    for p in ["/System/Library/Fonts/SFNS.ttf",
              "/System/Library/Fonts/Helvetica.ttc",
              "/Library/Fonts/Arial.ttf"]:
        if os.path.exists(p):
            try: return ImageFont.truetype(p, size)
            except: pass
    return ImageFont.load_default()


def vertical_grad(w, h, top, bot):
    im = Image.new("RGB", (w, h), top)
    pix = im.load()
    for y in range(h):
        t = y / max(1, h - 1)
        r = int(top[0] * (1 - t) + bot[0] * t)
        g = int(top[1] * (1 - t) + bot[1] * t)
        b = int(top[2] * (1 - t) + bot[2] * t)
        for x in range(w):
            pix[x, y] = (r, g, b)
    return im


def make_screenshot_1280x800():
    W, H = 1280, 800
    im = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(im)

    # ── 模拟 Chrome 浏览器顶部 chrome（窗口 chrome）───────
    chrome_h = 70
    d.rectangle([0, 0, W, chrome_h], fill=(40, 43, 48))
    # 三个 traffic light
    for i, color in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]):
        cx = 24 + i * 22
        cy = chrome_h // 2 - 8
        d.ellipse([cx - 7, cy - 7, cx + 7, cy + 7], fill=color)
    # tab + URL bar 简化
    d.rounded_rectangle([100, 18, 280, 50], radius=8, fill=(60, 64, 70))
    d.text((116, 26), "Fullpage to Terminal", font=find_font(13), fill=TEXT)
    # URL
    d.rounded_rectangle([300, 18, 1240, 50], radius=8, fill=(50, 54, 60))
    d.text((316, 26), "chrome-extension://...akodjdhihjilm.../viewer.html",
           font=find_font(13, mono=True), fill=MUTED)

    # ── 主体：viewer 页 ─────────────────────────────
    body_top = chrome_h
    # 大成功 banner（绿色渐变）
    banner_h = 220
    banner = vertical_grad(W, banner_h, BANNER_TOP, BANNER_BOT)
    im.paste(banner, (0, body_top))
    # banner 底部绿色细线
    d.rectangle([0, body_top + banner_h - 3, W, body_top + banner_h], fill=ACCENT)

    # 左上角小角标 ⌥+A
    f_kbd_small = find_font(13, mono=True)
    d.text((40, body_top + 22), "⌨", font=find_font(16), fill=(220, 220, 220, 200))
    # 画 kbd 块
    for i, ch in enumerate(["⌥", "+", "A"]):
        if ch == "+":
            d.text((68 + i * 22, body_top + 22), ch, font=f_kbd_small, fill=MUTED)
        else:
            x = 64 + i * 22
            d.rounded_rectangle([x, body_top + 22, x + 18, body_top + 42],
                                radius=4, fill=KBD_BG, outline=KBD_BORDER, width=1)
            bb = d.textbbox((0, 0), ch, font=f_kbd_small)
            tw = bb[2] - bb[0]; th = bb[3] - bb[1]
            d.text((x + (18 - tw) // 2, body_top + 22 + (20 - th) // 2 - 2),
                   ch, font=f_kbd_small, fill=(180, 180, 180))

    # 右上角 ⬇ Save as 按钮
    d.rounded_rectangle([W - 130, body_top + 18, W - 30, body_top + 48],
                        radius=8, fill=(0, 0, 0, 50), outline=BORDER, width=1)
    d.text((W - 116, body_top + 23), "⬇ Save as", font=find_font(14), fill=TEXT)

    # ── banner 主标题 ✓ Image copied ────────────
    f_head = find_font(56, bold=True)
    head = "✓ Image copied"
    bb = d.textbbox((0, 0), head, font=f_head)
    hw = bb[2] - bb[0]
    head_y = body_top + 60
    d.text(((W - hw) // 2, head_y), head, font=f_head, fill=(182, 240, 197))

    # ── 副文案 with kbd + img-token ────────────
    # 由于 PIL 文字混排排序复杂，分段画
    f_sub = find_font(22)
    f_kbd = find_font(20, mono=True)
    f_token = find_font(20, mono=True)

    sub_y = head_y + 80
    parts_left = "Switch to "
    bold_seg = "Claude Code"
    parts_mid = " and press "
    parts_after = " — it'll attach as "

    # 计算总宽度
    pl_w = d.textbbox((0, 0), parts_left, font=f_sub)[2]
    bs_w = d.textbbox((0, 0), bold_seg, font=find_font(22, bold=True))[2]
    pm_w = d.textbbox((0, 0), parts_mid, font=f_sub)[2]
    kbd_w = 48 + 6 + 28  # ⌘V approx
    pa_w = d.textbbox((0, 0), parts_after, font=f_sub)[2]
    token_w = d.textbbox((0, 0), "[Image #N]", font=f_token)[2] + 18  # padding

    total_w = pl_w + bs_w + pm_w + kbd_w + pa_w + token_w
    cur_x = (W - total_w) // 2

    d.text((cur_x, sub_y), parts_left, font=f_sub, fill=(216, 232, 223))
    cur_x += pl_w
    d.text((cur_x, sub_y), bold_seg, font=find_font(22, bold=True), fill=(216, 232, 223))
    cur_x += bs_w
    d.text((cur_x, sub_y), parts_mid, font=f_sub, fill=(216, 232, 223))
    cur_x += pm_w
    # ⌘V
    for ch in ["⌘", "V"]:
        d.rounded_rectangle([cur_x, sub_y, cur_x + 28, sub_y + 28],
                            radius=5, fill=KBD_BG, outline=KBD_BORDER, width=1)
        bb = d.textbbox((0, 0), ch, font=find_font(16, mono=True))
        tw = bb[2] - bb[0]
        d.text((cur_x + (28 - tw) // 2 - 1, sub_y + 4), ch,
               font=find_font(16, mono=True), fill=TEXT)
        cur_x += 30
    cur_x -= 2
    d.text((cur_x, sub_y), parts_after, font=f_sub, fill=(216, 232, 223))
    cur_x += pa_w
    # [Image #N] token：深底+亮文字，确保看得见
    d.rounded_rectangle([cur_x, sub_y - 2, cur_x + token_w - 8, sub_y + 30],
                        radius=5, fill=(20, 50, 30),
                        outline=(120, 220, 160), width=2)
    d.text((cur_x + 8, sub_y), "[Image #N]", font=f_token, fill=(180, 240, 200))

    # ── 文件路径行 📁 Saved to ... ─────────────
    saved_y = sub_y + 60
    saved_text = "📁 Saved to /Users/you/Downloads/fullpage-en.wikipedia.org-2026-05-03-23-05-12.png"
    f_saved = find_font(15, mono=True)
    bb = d.textbbox((0, 0), saved_text, font=f_saved)
    sw = bb[2] - bb[0]
    d.text(((W - sw) // 2, saved_y), saved_text, font=f_saved, fill=(168, 200, 182))

    # ── 截图预览（mock 一个长截图缩略图）───────
    # 在 banner 下方画一个圆角矩形当截图 placeholder
    img_y = body_top + banner_h + 30
    img_w = 700
    img_h = 410
    img_x = (W - img_w) // 2

    # 用 viewer-mode banner 占位
    d.rounded_rectangle([img_x, img_y, img_x + img_w, img_y + img_h],
                        radius=8, fill=(28, 32, 38), outline=BORDER, width=1)

    # 在中间画一个简化的 wiki 风格页面
    # 顶栏
    d.rectangle([img_x, img_y, img_x + img_w, img_y + 40], fill=(245, 245, 245))
    d.text((img_x + 14, img_y + 12), "🌐  en.wikipedia.org/wiki/Cat",
           font=find_font(12, mono=True), fill=(60, 60, 60))
    # 页面背景白
    d.rectangle([img_x, img_y + 40, img_x + img_w, img_y + img_h], fill=(255, 255, 255))
    # 标题
    d.text((img_x + 30, img_y + 60), "Cat",
           font=find_font(36, bold=True), fill=(20, 20, 20))
    # 几行 mock 文本
    f_body = find_font(13)
    lines = [
        "From Wikipedia, the free encyclopedia",
        "",
        "The cat (Felis catus), also referred to as the domestic cat or house cat, is a",
        "small domesticated carnivorous mammal. It is the only domesticated species of",
        "the family Felidae. Recent advances in archaeology and genetics have shown that",
        "the domestication of the cat occurred in the Near East around 7500 BC.",
        "",
        "Cats are commonly kept as house pets but can also be farm cats or feral cats; the",
        "feral cat ranges freely and avoids human contact. Domestic cats are valued by",
        "humans for companionship and their ability to kill vermin.",
        "",
        "                              [photo of a cat]",
    ]
    for i, line in enumerate(lines):
        d.text((img_x + 30, img_y + 110 + i * 18), line, font=f_body, fill=(50, 50, 50))

    # 截图边角写 "✓ Full page captured" 标签
    label_x = img_x + img_w - 200
    label_y = img_y + img_h - 40
    d.rounded_rectangle([label_x, label_y, label_x + 180, label_y + 26],
                        radius=13, fill=(45, 164, 78))
    d.text((label_x + 14, label_y + 5), "✓ Full page captured",
           font=find_font(12, bold=True), fill=(255, 255, 255))

    # ── 底部状态行 ──────────────────────
    foot_y = H - 40
    d.text((W // 2 - 200, foot_y), "1280 × 8400  ·  892 KB  ·  Sun May 3, 23:05",
           font=find_font(11), fill=MUTED)

    out_path = os.path.join(OUT_DIR, "screenshot-1280x800.png")
    im.save(out_path, "PNG", optimize=True)
    print("wrote", out_path)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    make_screenshot_1280x800()


if __name__ == "__main__":
    main()
