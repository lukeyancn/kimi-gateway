"""Generate the tray / exe icons in the same visual language as the WebUI mark.

Rounded-square gradient (violet -> cyan -> green) with the bridge glyph in
white. Writes a multi-resolution .ico plus a muted "stopped" variant.
"""

from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent
SIZES = [256, 128, 64, 48, 32, 24, 16]
SS = 8  # supersampling factor for smooth curves

ACTIVE_STOPS = [(0.0, (139, 124, 255)), (0.55, (76, 201, 240)), (1.0, (61, 220, 151))]
IDLE_STOPS = [(0.0, (150, 156, 176)), (0.55, (122, 129, 150)), (1.0, (95, 102, 122))]


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def gradient(size, stops):
    img = Image.new("RGB", (size, size))
    pixels = img.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * (size - 1))
            for i in range(len(stops) - 1):
                p0, c0 = stops[i]
                p1, c1 = stops[i + 1]
                if p0 <= t <= p1:
                    local = 0 if p1 == p0 else (t - p0) / (p1 - p0)
                    pixels[x, y] = lerp(c0, c1, local)
                    break
    return img


def rounded_mask(size, radius_ratio=0.28):
    mask = Image.new("L", (size * 4, size * 4), 0)
    draw = ImageDraw.Draw(mask)
    r = int(size * 4 * radius_ratio)
    draw.rounded_rectangle([0, 0, size * 4 - 1, size * 4 - 1], radius=r, fill=255)
    return mask.resize((size, size), Image.LANCZOS)


def build(size, stops):
    big = size * SS
    base = gradient(big, stops)
    mask = rounded_mask(size * SS)
    icon = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    icon.paste(base, (0, 0), mask)

    # Small sizes need a simpler, chunkier glyph or it turns to mush in the
    # 16px tray. Rails and thin strokes only exist from 24px up.
    detailed = size >= 24
    draw = ImageDraw.Draw(icon)

    w = big * (0.085 if detailed else 0.115)
    node_r = big * (0.100 if detailed else 0.125)
    left = (big * (0.285 if detailed else 0.265), big * 0.50)
    right = (big * (0.715 if detailed else 0.735), big * 0.50)

    draw.line([left, right], fill=(255, 255, 255, 255), width=int(w))
    for center in (left, right):
        draw.ellipse(
            [
                center[0] - node_r,
                center[1] - node_r,
                center[0] + node_r,
                center[1] + node_r,
            ],
            fill=(255, 255, 255, 255),
        )

    if detailed:
        faint = (255, 255, 255, 165)
        rail_w = int(w * 0.72)
        draw.line([(big * 0.375, big * 0.315), (big * 0.625, big * 0.315)], fill=faint, width=rail_w)
        draw.line([(big * 0.375, big * 0.685), (big * 0.625, big * 0.685)], fill=faint, width=rail_w)

    return icon.resize((size, size), Image.LANCZOS)


def write_ico(path, stops):
    frames = [build(s, stops) for s in SIZES]
    frames[0].save(path, format="ICO", sizes=[(s, s) for s in SIZES], append_images=frames[1:])
    print(f"wrote {path} ({', '.join(str(s) for s in SIZES)})")


assets = OUT / "assets"
assets.mkdir(exist_ok=True)
write_ico(assets / "icon-on.ico", ACTIVE_STOPS)
write_ico(assets / "icon-off.ico", IDLE_STOPS)

# also keep a png preview for docs
build(256, ACTIVE_STOPS).save(assets / "icon.png")
print("wrote assets/icon.png")
