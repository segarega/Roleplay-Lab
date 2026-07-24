from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "resources"
OUT.mkdir(parents=True, exist_ok=True)

SIZE = 1024
SCALE = 4
canvas_size = SIZE * SCALE

image = Image.new("RGBA", (canvas_size, canvas_size), (8, 10, 18, 255))
pixels = image.load()

# Deep indigo-to-violet background with a subtle cyan lift.
for y in range(canvas_size):
    for x in range(canvas_size):
        tx = x / (canvas_size - 1)
        ty = y / (canvas_size - 1)
        glow = max(0.0, 1.0 - (((tx - 0.18) ** 2 + (ty - 0.05) ** 2) ** 0.5) * 1.4)
        r = int(18 + 49 * tx + 34 * ty + 14 * glow)
        g = int(22 + 25 * tx + 11 * ty + 30 * glow)
        b = int(45 + 83 * tx + 56 * ty + 45 * glow)
        pixels[x, y] = (min(r, 105), min(g, 90), min(b, 205), 255)

mask = Image.new("L", image.size, 0)
mask_draw = ImageDraw.Draw(mask)
radius = 228 * SCALE
mask_draw.rounded_rectangle(
    (24 * SCALE, 24 * SCALE, (SIZE - 24) * SCALE, (SIZE - 24) * SCALE),
    radius=radius,
    fill=255,
)
image.putalpha(mask)

glow_layer = Image.new("RGBA", image.size, (0, 0, 0, 0))
glow_draw = ImageDraw.Draw(glow_layer)
glow_draw.ellipse(
    (65 * SCALE, 16 * SCALE, 795 * SCALE, 746 * SCALE),
    fill=(74, 210, 255, 80),
)
glow_layer = glow_layer.filter(ImageFilter.GaussianBlur(128 * SCALE))
image = Image.alpha_composite(image, glow_layer)

draw = ImageDraw.Draw(image)

# Two staggered model lanes/speech cards.
shadow = Image.new("RGBA", image.size, (0, 0, 0, 0))
shadow_draw = ImageDraw.Draw(shadow)
shadow_draw.rounded_rectangle(
    (160 * SCALE, 224 * SCALE, 535 * SCALE, 748 * SCALE),
    radius=92 * SCALE,
    fill=(0, 0, 0, 110),
)
shadow_draw.rounded_rectangle(
    (489 * SCALE, 276 * SCALE, 864 * SCALE, 800 * SCALE),
    radius=92 * SCALE,
    fill=(0, 0, 0, 115),
)
shadow = shadow.filter(ImageFilter.GaussianBlur(26 * SCALE))
image = Image.alpha_composite(image, shadow)
draw = ImageDraw.Draw(image)

left_box = (136 * SCALE, 192 * SCALE, 511 * SCALE, 716 * SCALE)
right_box = (465 * SCALE, 244 * SCALE, 840 * SCALE, 768 * SCALE)
draw.rounded_rectangle(left_box, radius=92 * SCALE, fill=(237, 244, 255, 242))
draw.rounded_rectangle(right_box, radius=92 * SCALE, fill=(219, 224, 255, 246))

# Chat tails.
draw.polygon(
    [
        (238 * SCALE, 696 * SCALE),
        (214 * SCALE, 820 * SCALE),
        (354 * SCALE, 704 * SCALE),
    ],
    fill=(237, 244, 255, 242),
)
draw.polygon(
    [
        (636 * SCALE, 748 * SCALE),
        (756 * SCALE, 852 * SCALE),
        (724 * SCALE, 735 * SCALE),
    ],
    fill=(219, 224, 255, 246),
)

# Conversation lines, distinct accent per lane.
for y, width in [(310, 248), (397, 204), (484, 234)]:
    draw.rounded_rectangle(
        (201 * SCALE, y * SCALE, (201 + width) * SCALE, (y + 30) * SCALE),
        radius=15 * SCALE,
        fill=(53, 76, 167, 235),
    )

for y, width in [(362, 235), (449, 195), (536, 250)]:
    draw.rounded_rectangle(
        (528 * SCALE, y * SCALE, (528 + width) * SCALE, (y + 30) * SCALE),
        radius=15 * SCALE,
        fill=(118, 65, 199, 235),
    )

# Comparison spark at the overlap.
draw.ellipse(
    (423 * SCALE, 532 * SCALE, 571 * SCALE, 680 * SCALE),
    fill=(16, 20, 45, 248),
)
draw.line(
    (465 * SCALE, 606 * SCALE, 529 * SCALE, 606 * SCALE),
    fill=(113, 225, 255, 255),
    width=18 * SCALE,
)
draw.ellipse(
    (449 * SCALE, 590 * SCALE, 481 * SCALE, 622 * SCALE),
    fill=(113, 225, 255, 255),
)
draw.ellipse(
    (513 * SCALE, 590 * SCALE, 545 * SCALE, 622 * SCALE),
    fill=(113, 225, 255, 255),
)

image = image.resize((SIZE, SIZE), Image.Resampling.LANCZOS)
image.save(OUT / "icon.png", optimize=True)
image.save(
    OUT / "icon.ico",
    sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
)

print(f"Generated {OUT / 'icon.png'} and {OUT / 'icon.ico'}")
