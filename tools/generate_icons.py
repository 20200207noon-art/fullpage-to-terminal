#!/usr/bin/env python3
"""扩展图标 = Apple Terminal.app 真 icon 做整体背景 + 从 Apple Image Capture.app 抠出的银色相机叠右下。

⚠️ 注意：此版本使用了 macOS 系统应用图标资源。Chrome Web Store 审核可能因商标
原因驳回。仅用于本地开发 / 个人分发；上架前应换成 tools/generate_icons.py 之外
的原创设计版本。
"""

import os
import shutil
import subprocess
import tempfile
from PIL import Image, ImageDraw, ImageChops

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "icons")
TERMINAL_ICNS = "/System/Applications/Utilities/Terminal.app/Contents/Resources/Terminal.icns"
IMAGE_CAPTURE_ICNS = "/System/Applications/Image Capture.app/Contents/Resources/AppIcon.icns"


def icns_to_png(src_icns: str, px: int, tmp_dir: str) -> Image.Image:
    out_png = os.path.join(tmp_dir, f"_{os.path.basename(src_icns)}_{px}.png")
    subprocess.run(
        ["sips", "-s", "format", "png", src_icns, "--out", out_png, "-z", str(px), str(px)],
        check=True, capture_output=True
    )
    return Image.open(out_png).convert("RGBA")


def get_terminal_bg(size: int, tmp_dir: str) -> Image.Image:
    """Apple Terminal icon 裁透明边后铺满 size×size。"""
    im = icns_to_png(TERMINAL_ICNS, 1024, tmp_dir)
    bbox = im.getbbox()
    if bbox:
        im = im.crop(bbox)
    margin = max(0, size // 64)
    inner = size - margin * 2
    im.thumbnail((inner, inner), Image.LANCZOS)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ox = (size - im.width) // 2
    oy = (size - im.height) // 2
    canvas.paste(im, (ox, oy), im)
    return canvas


def extract_camera(target_px: int, tmp_dir: str) -> Image.Image:
    """从 Image Capture icon 抠出银色相机；右上角 LED 区域 mask 成透明，避免红点。"""
    im = icns_to_png(IMAGE_CAPTURE_ICNS, 1024, tmp_dir).convert("RGBA")
    W, H = im.size

    cam_x0 = int(W * 0.30)
    cam_y0 = int(H * 0.43)
    cam_x1 = int(W * 0.96)
    cam_y1 = int(H * 0.96)
    cam_r  = int(W * 0.10)

    vf_x0 = cam_x0 + int((cam_x1 - cam_x0) * 0.10)
    vf_x1 = vf_x0 + int((cam_x1 - cam_x0) * 0.30)
    vf_y0 = cam_y0 - int(H * 0.04)
    vf_y1 = cam_y0 + int(H * 0.02)
    vf_r  = int((vf_y1 - vf_y0) // 2)

    mask = Image.new("L", (W, H), 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle([vf_x0, vf_y0, vf_x1, vf_y1], radius=vf_r, fill=255)
    md.rounded_rectangle([cam_x0, cam_y0, cam_x1, cam_y1], radius=cam_r, fill=255)

    # 把右上角红色 LED 剪成透明
    led_cx = int(W * 0.91)
    led_cy = int(H * 0.51)
    led_r  = int(W * 0.04)
    md.ellipse([led_cx - led_r, led_cy - led_r, led_cx + led_r, led_cy + led_r], fill=0)

    r, g, b, a = im.split()
    new_a = ImageChops.multiply(a, mask)
    im.putalpha(new_a)
    bbox = im.getbbox()
    if bbox:
        im = im.crop(bbox)
    im.thumbnail((target_px, target_px), Image.LANCZOS)
    return im


def make_icon(size: int) -> Image.Image:
    tmp = tempfile.mkdtemp()
    try:
        bg = get_terminal_bg(size, tmp)
        # 16px 也叠相机
        if size >= 64:
            cam_ratio = 0.58
        elif size >= 32:
            cam_ratio = 0.65
        else:
            cam_ratio = 0.78
        cam_target = int(size * cam_ratio)
        cam = extract_camera(cam_target, tmp)
        margin = max(0, size // 40)
        x = size - cam.width - margin
        y = size - cam.height - margin
        bg.alpha_composite(cam, (x, y))
        return bg
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main():
    if not os.path.exists(TERMINAL_ICNS):
        raise SystemExit(f"找不到 {TERMINAL_ICNS}")
    if not os.path.exists(IMAGE_CAPTURE_ICNS):
        raise SystemExit(f"找不到 {IMAGE_CAPTURE_ICNS}")
    os.makedirs(OUT_DIR, exist_ok=True)
    for s in (16, 48, 128):
        img = make_icon(s)
        path = os.path.abspath(os.path.join(OUT_DIR, f"icon{s}.png"))
        img.save(path, "PNG")
        print("wrote", path)


if __name__ == "__main__":
    main()
