#!/usr/bin/env python3
"""Render the square Mycel avatar — the ASCII 'M' monogram, teal on loam, padded square."""
import os
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ascii_art = open(os.path.join(HERE, "logo-square.txt")).read().rstrip("\n").split("\n")

FONT_CANDIDATES = [
    ("/System/Library/Fonts/Menlo.ttc", 0),
    ("/System/Library/Fonts/SFNSMono.ttf", 0),
    ("/Library/Fonts/DejaVuSansMono.ttf", 0),
]
SIZE = 150
font = None
for path, idx in FONT_CANDIDATES:
    if os.path.exists(path):
        try:
            font = ImageFont.truetype(path, SIZE, index=idx)
            break
        except Exception:
            continue
if font is None:
    font = ImageFont.load_default()

BG = (11, 15, 14)      # loam
FG = (0, 214, 158)     # mycelium teal

# measure the block
tmp = ImageDraw.Draw(Image.new("RGB", (10, 10)))
ascent, descent = font.getmetrics()
line_h = int((ascent + descent) * 1.0)
max_w = 0
for line in ascii_art:
    bbox = tmp.textbbox((0, 0), line, font=font)
    max_w = max(max_w, bbox[2] - bbox[0])
block_w = max_w
block_h = line_h * len(ascii_art)

# square canvas with generous padding
side = max(block_w, block_h) + int(SIZE * 1.4)
img = Image.new("RGB", (side, side), BG)
draw = ImageDraw.Draw(img)
x0 = (side - block_w) // 2
y0 = (side - block_h) // 2
y = y0
for line in ascii_art:
    draw.text((x0, y), line, font=font, fill=FG)
    y += line_h

img = img.resize((1024, 1024), Image.LANCZOS)
out = os.path.join(HERE, "logo-square.png")
img.save(out)
print(f"wrote {out} (1024x1024)")
