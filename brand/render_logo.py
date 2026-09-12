#!/usr/bin/env python3
"""Render the Mycel ASCII logo to a PNG using a monospace font."""
from PIL import Image, ImageDraw, ImageFont
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ascii_art = open(os.path.join(HERE, "logo.txt")).read().rstrip("\n").split("\n")

# Font: prefer Menlo (has box-drawing + block glyphs), fall back to DejaVu.
FONT_CANDIDATES = [
    ("/System/Library/Fonts/Menlo.ttc", 0),
    ("/System/Library/Fonts/SFNSMono.ttf", 0),
    ("/Library/Fonts/DejaVuSansMono.ttf", 0),
]
SIZE = 44
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

# Measure
tmp = Image.new("RGB", (10, 10))
d = ImageDraw.Draw(tmp)
ascent, descent = font.getmetrics()
line_h = int((ascent + descent) * 1.05)
max_w = 0
for line in ascii_art:
    bbox = d.textbbox((0, 0), line, font=font)
    max_w = max(max_w, bbox[2] - bbox[0])

pad = 60
W = max_w + pad * 2
H = line_h * len(ascii_art) + pad * 2

# Dark background, mycelium-teal glyphs, muted tagline.
BG = (11, 15, 14)          # near-black with a green tint (loam)
FG = (0, 214, 158)         # mycelium teal-green
MUTED = (120, 138, 132)    # tagline grey-green

img = Image.new("RGB", (W, H), BG)
draw = ImageDraw.Draw(img)
y = pad
for line in ascii_art:
    # tagline lines (lowercase prose) get the muted colour
    color = MUTED if (line.strip() and line.strip()[0].islower()) or ("·" in line) else FG
    draw.text((pad, y), line, font=font, fill=color)
    y += line_h

out = os.path.join(HERE, "logo.png")
img.save(out)
print(f"wrote {out}  ({W}x{H})")
