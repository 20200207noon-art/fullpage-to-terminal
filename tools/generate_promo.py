#!/usr/bin/env python3
"""生成 Chrome Web Store 上架所需的宣传图：
- 大宣传图    1280×800（主图）
- 小宣传图     440×280（缩略图）
- Marquee tile 1400×560（精选位用，2.5:1 横幅）
"""

import os
from PIL import Image, ImageDraw, ImageFont

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "promo")
ICON_PATH = os.path.join(os.path.dirname(__file__), "..", "icons", "icon128.png")

BG_DARK = (10, 12, 18)
BG_GRAD_TOP = (28, 32, 48)
BG_GRAD_BOT = (10, 12, 18)
ACCENT = (88, 166, 255)
ACCENT_GREEN = (45, 164, 78)
TEXT_HEAD = (255, 255, 255)
TEXT_BODY = (200, 210, 222)
TEXT_MUTED = (140, 150, 165)
TERM_BG = (13, 17, 23)
TERM_BORDER = (48, 54, 61)


def find_font(size: int, bold: bool = False, mono: bool = False):
    candidates = []
    if mono:
        candidates += [
            "/System/Library/Fonts/SFNSMono.ttf",
            "/System/Library/Fonts/Menlo.ttc",
        ]
    if bold:
        candidates += [
            "/System/Library/Fonts/SFNS.ttf",
            "/System/Library/Fonts/Helvetica.ttc",
        ]
    candidates += [
        "/System/Library/Fonts/SFNS.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "/Library/Fonts/Arial.ttf",
    ]
    for p in candidates:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                continue
    return ImageFont.load_default()


def vertical_grad(w: int, h: int, top, bot) -> Image.Image:
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


def draw_terminal_mockup(target_w: int, target_h: int) -> Image.Image:
    """画一个模拟终端窗口，里面显示 [Image #1] 的样子。"""
    im = Image.new("RGBA", (target_w, target_h), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)

    # 圆角窗口
    radius = 14
    d.rounded_rectangle([0, 0, target_w - 1, target_h - 1],
                        radius=radius, fill=TERM_BG, outline=TERM_BORDER, width=1)

    # 顶栏
    bar_h = 36
    d.rounded_rectangle([0, 0, target_w - 1, bar_h], radius=radius, fill=(33, 38, 45))
    d.rectangle([0, bar_h - radius, target_w, bar_h], fill=(33, 38, 45))

    # traffic light
    cx_y = bar_h // 2
    for i, color in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]):
        cx = 18 + i * 22
        d.ellipse([cx - 7, cx_y - 7, cx + 7, cx_y + 7], fill=color)

    # 标题
    f_title = find_font(13, mono=True)
    title = "claude — terminal"
    bbox = d.textbbox((0, 0), title, font=f_title)
    tw = bbox[2] - bbox[0]
    d.text(((target_w - tw) // 2, 11), title, font=f_title, fill=(140, 150, 165))

    # 内容
    body_y = bar_h + 22
    f_mono = find_font(18, mono=True)
    f_mono_b = find_font(18, mono=True)

    # > [Image #1]
    prompt = "> "
    img_token = "[Image #1]"
    px = 24
    d.text((px, body_y), prompt, font=f_mono, fill=ACCENT)
    pb = d.textbbox((0, 0), prompt, font=f_mono)
    pw = pb[2] - pb[0]
    # img token 加底色框
    tb = d.textbbox((0, 0), img_token, font=f_mono_b)
    tw = tb[2] - tb[0]
    th = tb[3] - tb[1]
    pad_x, pad_y = 8, 4
    box_x0 = px + pw
    box_y0 = body_y - pad_y + 1
    box_x1 = box_x0 + tw + pad_x * 2
    box_y1 = body_y + th + pad_y
    d.rounded_rectangle([box_x0, box_y0, box_x1, box_y1],
                        radius=5, fill=(88 * 1, 166, 255, 40),
                        outline=(88, 166, 255, 180), width=1)
    d.text((box_x0 + pad_x, body_y), img_token, font=f_mono_b, fill=ACCENT)

    # 光标
    cursor_x = box_x1 + 8
    d.rectangle([cursor_x, body_y + 2, cursor_x + 9, body_y + th], fill=TEXT_HEAD)

    return im


def make_promo_1280x800():
    W, H = 1280, 800
    im = vertical_grad(W, H, BG_GRAD_TOP, BG_GRAD_BOT).convert("RGBA")
    d = ImageDraw.Draw(im)

    # 左侧文案区
    pad_l = 80
    icon = Image.open(ICON_PATH).convert("RGBA").resize((140, 140), Image.LANCZOS)
    im.alpha_composite(icon, (pad_l, 100))

    f_name = find_font(64, bold=True)
    f_tag = find_font(34)
    f_sub = find_font(22)

    d.text((pad_l + 170, 130), "Fullpage to Terminal", font=f_name, fill=TEXT_HEAD)
    d.text((pad_l + 170, 210), "Screenshot → paste into Claude Code", font=f_tag, fill=TEXT_BODY)

    # 三段卖点
    bullets_y = 320
    bullet_color = ACCENT_GREEN
    bullets = [
        ("✓", "Capture the entire page (not just the visible part)"),
        ("✓", "Auto-copies as a file reference — paste with ⌘V"),
        ("✓", "Claude Code receives it as [Image #N], no manual steps"),
    ]
    f_bullet = find_font(22)
    for i, (mark, text) in enumerate(bullets):
        y = bullets_y + i * 50
        d.text((pad_l, y), mark, font=f_bullet, fill=bullet_color)
        d.text((pad_l + 36, y), text, font=f_bullet, fill=TEXT_BODY)

    # 底部 hotkey 标
    f_kbd = find_font(20, mono=True)
    hotkey = "⌥+A  ·  macOS"
    d.text((pad_l, 530), "Hotkey", font=find_font(16), fill=TEXT_MUTED)
    d.text((pad_l, 555), hotkey, font=f_kbd, fill=ACCENT)

    # 右侧：模拟终端窗口 mockup
    term_w = 540
    term_h = 200
    term_x = W - term_w - 70
    term_y = (H - term_h) // 2
    term = draw_terminal_mockup(term_w, term_h)
    im.alpha_composite(term, (term_x, term_y))

    # 终端窗口下方一行小字
    f_caption = find_font(16)
    caption = "What appears in your Claude Code terminal after pressing ⌘V"
    bbox = d.textbbox((0, 0), caption, font=f_caption)
    cw = bbox[2] - bbox[0]
    d.text((term_x + (term_w - cw) // 2, term_y + term_h + 16),
           caption, font=f_caption, fill=TEXT_MUTED)

    out_path = os.path.join(OUT_DIR, "promo-1280x800.png")
    im.convert("RGB").save(out_path, "PNG", optimize=True)
    print("wrote", out_path)


def make_promo_440x280():
    W, H = 440, 280
    im = vertical_grad(W, H, BG_GRAD_TOP, BG_GRAD_BOT).convert("RGBA")
    d = ImageDraw.Draw(im)

    icon = Image.open(ICON_PATH).convert("RGBA").resize((72, 72), Image.LANCZOS)
    im.alpha_composite(icon, (28, 28))

    f_name = find_font(28, bold=True)
    f_tag = find_font(15)
    d.text((118, 32), "Fullpage to Terminal", font=f_name, fill=TEXT_HEAD)
    d.text((118, 70), "Screenshot → paste into Claude", font=f_tag, fill=TEXT_BODY)

    # 模拟终端 mockup（小尺寸）
    term_w = 380
    term_h = 130
    term_x = (W - term_w) // 2
    term_y = 130
    term = draw_terminal_mockup(term_w, term_h)
    im.alpha_composite(term, (term_x, term_y))

    out_path = os.path.join(OUT_DIR, "promo-440x280.png")
    im.convert("RGB").save(out_path, "PNG", optimize=True)
    print("wrote", out_path)


def make_promo_1400x560():
    W, H = 1400, 560
    im = vertical_grad(W, H, BG_GRAD_TOP, BG_GRAD_BOT).convert("RGBA")
    d = ImageDraw.Draw(im)

    # Left: icon + title + subtitle + bullets
    pad_l = 70
    icon = Image.open(ICON_PATH).convert("RGBA").resize((110, 110), Image.LANCZOS)
    im.alpha_composite(icon, (pad_l, 70))

    f_name = find_font(54, bold=True)
    f_tag = find_font(26)
    d.text((pad_l + 138, 75), "Fullpage to Terminal", font=f_name, fill=TEXT_HEAD)
    d.text((pad_l + 138, 142), "Screenshot → paste into Claude Code", font=f_tag, fill=TEXT_BODY)

    bullets = [
        ("✓", "Capture the entire page (not just the visible part)"),
        ("✓", "Auto-copies as a file reference — paste with ⌘V"),
        ("✓", "Claude Code receives it as [Image #N], no manual steps"),
    ]
    f_bullet = find_font(20)
    bullets_y = 230
    for i, (mark, text) in enumerate(bullets):
        y = bullets_y + i * 42
        d.text((pad_l, y), mark, font=f_bullet, fill=ACCENT_GREEN)
        d.text((pad_l + 32, y), text, font=f_bullet, fill=TEXT_BODY)

    f_kbd = find_font(18, mono=True)
    d.text((pad_l, 430), "Hotkey", font=find_font(14), fill=TEXT_MUTED)
    d.text((pad_l, 452), "⌥+A  ·  macOS", font=f_kbd, fill=ACCENT)

    # Right: terminal mockup, sized for the wider canvas
    term_w = 580
    term_h = 200
    term_x = W - term_w - 70
    term_y = (H - term_h) // 2
    term = draw_terminal_mockup(term_w, term_h)
    im.alpha_composite(term, (term_x, term_y))

    f_caption = find_font(15)
    caption = "What appears in your Claude Code terminal after pressing ⌘V"
    bbox = d.textbbox((0, 0), caption, font=f_caption)
    cw = bbox[2] - bbox[0]
    d.text((term_x + (term_w - cw) // 2, term_y + term_h + 14),
           caption, font=f_caption, fill=TEXT_MUTED)

    out_path = os.path.join(OUT_DIR, "promo-1400x560.png")
    im.convert("RGB").save(out_path, "PNG", optimize=True)
    print("wrote", out_path)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    make_promo_1280x800()
    make_promo_440x280()
    make_promo_1400x560()


if __name__ == "__main__":
    main()
