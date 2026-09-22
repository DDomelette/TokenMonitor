# 从白底贴纸图中抠出角色：从边缘泛洪填充白色背景 -> 透明
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

SENTINEL = (255, 0, 255)
THRESH = 32


def is_near_white(px):
    return px[0] >= 235 and px[1] >= 235 and px[2] >= 235


def remove_bg(src: Path, dst: Path):
    img = Image.open(src).convert("RGB")
    w, h = img.size
    work = img.copy()
    draw_pts = []
    step = 6
    for x in range(0, w, step):
        draw_pts.append((x, 0))
        draw_pts.append((x, h - 1))
    for y in range(0, h, step):
        draw_pts.append((0, y))
        draw_pts.append((w - 1, y))
    for pt in draw_pts:
        px = work.getpixel(pt)
        if px == SENTINEL:
            continue
        if is_near_white(px):
            ImageDraw.floodfill(work, pt, SENTINEL, thresh=THRESH)

    mask = Image.new("L", (w, h), 255)
    mpx = mask.load()
    wpx = work.load()
    for y in range(h):
        for x in range(w):
            if wpx[x, y] == SENTINEL:
                mpx[x, y] = 0
    # 收缩 1px 去白边，再轻微羽化
    mask = mask.filter(ImageFilter.MinFilter(3))
    mask = mask.filter(ImageFilter.GaussianBlur(1.2))

    out = img.convert("RGBA")
    out.putalpha(mask)
    dst.parent.mkdir(parents=True, exist_ok=True)
    out.save(dst)
    print(f"ok {src.name} -> {dst}")


def main():
    assets = Path(sys.argv[1])
    out_dir = Path(sys.argv[2])
    for f in sorted(assets.glob("*.png")):
        remove_bg(f, out_dir / f.name)


if __name__ == "__main__":
    main()
