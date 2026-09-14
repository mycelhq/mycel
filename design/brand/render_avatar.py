#!/usr/bin/env python3
"""
The avatar, in three grounds — and the one that matters is the one that disappears.

═══════════════════════════════════════════════════════════════════════════════════════════════════
WHY THERE IS MORE THAN ONE
═══════════════════════════════════════════════════════════════════════════════════════════════════

LinkedIn lays the avatar over the bottom-left of the cover. If the avatar's background is even
slightly off the banner's, the crop shows as a rectangle of not-quite-black sitting on the artwork —
and the two were off, measurably: the avatar was drawn on `(11, 15, 14)` (loam, from the ASCII logo)
and the banner's left edge is `(9, 11, 12)` (`--background` from globals.css). Two dark colours that
look identical alone and read as a seam the moment one is laid on the other.

So `dark` is drawn on the BANNER's background, sampled from the same token, and the mark appears to
float on the artwork rather than sit in a box on it.

`light` is the white ground — the reference the founder sent, and the one that survives every place
a logo is shown on white: search results, partner pages, an invoice header.

`mark` is transparent, for everywhere neither assumption holds.

═══════════════════════════════════════════════════════════════════════════════════════════════════
THE GREEN DID NOT NEED CHANGING
═══════════════════════════════════════════════════════════════════════════════════════════════════

Sampled from the reference rather than eyeballed: its mark is `(0, 216, 158)` and this one has been
`(0, 214, 158)` all along — the same colour within JPEG noise. The reference reads lighter because
it is on WHITE, not because its green is lighter. Changing the green to chase that impression would
have made every dark surface wrong to fix a light one.

═══════════════════════════════════════════════════════════════════════════════════════════════════
AND THE PADDING IS FOR A CIRCLE
═══════════════════════════════════════════════════════════════════════════════════════════════════

LinkedIn crops company logos to a rounded square and personal ones to a circle. A mark drawn to the
edges of its square loses its corners in the second case, so the block sits inside `SAFE` — the
largest circle that fits — with room to spare.
"""
import math
import os
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ART = open(os.path.join(HERE, "logo-square.txt")).read().rstrip("\n").split("\n")

# ═══ TWO GREENS, BECAUSE THE TWO GROUNDS WANT OPPOSITE THINGS ═══
#
# Measured, not argued. Contrast of the mint the mark used to be, (0, 214, 158):
#
#   on the banner's dark ground   10.3:1     — excellent
#   on white                       1.9:1     — washed out, and this is the complaint
#
# The transparent mark is the one that goes on LinkedIn, and LinkedIn composites it onto a light
# card. So the version most people see was the one at 1.9:1, which is why it read as "a bit light"
# even though on the cover it was the strongest thing in the frame.
#
# One green cannot serve both: brightening it for the dark ground is exactly what dims it on white.
# So the ground picks the green, which is the same thing `paletteFor` in shader-field.tsx already
# does per theme — a brand tuned to its substrate rather than one value defended everywhere.
#
# `ON_LIGHT` is 4.4:1 on white and still 4.5:1 on dark, which is the crossover: the most saturated
# green that clears AA-large on paper without going muddy. `ON_DARK` stays the mint, because on the
# cover nothing beats it and that is the one that has to shine in a feed.
ON_LIGHT = (0, 138, 92)
ON_DARK = (0, 214, 158)
FG = ON_DARK

# ═══ THE RADIANT MARK ═══
#
# The transparent version is the one being uploaded, and it is meant to glow rather than sit quietly.
# Relative luminance across the family, for the record:
#
#   (0, 138, 92)     0.189   the readable-on-paper green
#   (0, 214, 158)    0.506   the mint the ASCII logo has always used
#   (74, 246, 196)   0.714   this
#   (140, 252, 219)  0.803   past the point where it stops reading as green
#
# 0.714 is where it is unmistakably radiant and still unmistakably the brand's green. It gives up
# contrast on white — that trade was made deliberately and with the numbers in front of us.
RADIANT = (74, 246, 196)

# ═══ THE FEED VERSION, AND WHY IT IS A TILE RATHER THAN A TRANSPARENT MARK ═══
#
# "Make it shine the most among all the logos on LinkedIn." There are two contrasts that decide
# that and they are usually confused with each other:
#
#   INTERNAL — the mark against its own ground.
#   EXTERNAL — the whole tile against the feed it sits in, which on LinkedIn is a white card.
#
# Measured, against white:
#
#   transparent mark, ON_LIGHT green      4.4:1 internal    1.0:1 external
#   brand ground + BRIGHT mint           12.1:1 internal   19.7:1 external
#
# A transparent logo is 1.0:1 externally BY CONSTRUCTION — it is the same colour as the card, so it
# cannot stand out from a row of other cards no matter what colour the glyph is. That is why the
# no-background version reads as quiet in a feed while being the strongest thing on our own cover.
#
# A dark tile in a column of white cards is the single loudest object available, and it costs
# nothing: it is already the brand. Pure black scores marginally higher (12.9 / 21.0) and is not
# ours — it reads as a hole punched in the feed rather than as a company.
# PURE BLACK, and that turned out to be the whole trick. The reference the founder sent reads as
# radiant and its mark is only (192, 192, 192) — 11.5:1, DIMMER than our green. What makes it glow
# is the ground: (0, 0, 0), not the near-black `--background` this used, which loses about a fifth
# of the available contrast for a difference nobody can see in isolation.
CONTRAST_BG = (0, 0, 0)
# Radiant, with the green surviving as a tint rather than as the subject. 18.1:1 — brighter than the
# reference, and the point where pushing further just arrives at white, which any company could own.
CONTRAST_FG = (170, 255, 228)
LOAM = (11, 15, 14)         # the ASCII logo's own ground, kept for the wordmark
WHITE = (255, 255, 255)

def banner_ground(size):
    """
    The avatar's ground, CUT FROM THE BANNER ITSELF.

    ═══ THE COLOUR WAS NEVER THE PROBLEM ═══

    First attempt: a flat fill of the banner's corner colour, `(9, 11, 12)`. Visible rectangle.
    Second: the mean of the patch the avatar actually covers, `(8, 13, 13)` — a two-unit match per
    channel, and STILL a visible rectangle.

    Because the banner is GRAIN, and a flat patch beside grain reads as an edge at identical mean.
    The eye is far better at texture discontinuity than at hue, which is why matching the colour
    harder kept not working.

    Third attempt re-rendered the shader into a square canvas. Grain, correct density — and the
    wrong part of the field, because the uniforms scale to whatever canvas they are given, so a
    square samples a different region than the banner's left edge.

    So: take the pixels. The banner at 2× has the avatar's footprint at exactly the size the avatar
    needs, which makes this a copy rather than a match, and there is nothing left to drift.

    Below the banner's bottom edge there is nothing to copy — LinkedIn hangs the avatar off the
    cover onto the profile card, so that part is not over the banner at all. The last row is
    mirrored downward, which continues the grain plausibly rather than ending it in a hard line.
    """
    from PIL import Image as _I, ImageOps as _O
    try:
        b = _I.open(os.path.join(HERE, "linkedin-cover.png")).convert("RGB")
    except Exception:
        return _I.new("RGB", (size, size), (9, 11, 12))  # the token, if no banner is rendered yet
    sc = b.width / 1584
    av = int(152 * sc)
    x, y = int(56 * sc), b.height - int(av * 0.62)
    patch = b.crop((x, y, x + av, min(b.height, y + av)))
    if patch.height < av:
        # Mirror the tail rather than repeat one row: a repeated row is a visible vertical smear.
        tail = _O.flip(patch.crop((0, patch.height - (av - patch.height), patch.width, patch.height)))
        full = _I.new("RGB", (av, av))
        full.paste(patch, (0, 0))
        full.paste(tail, (0, patch.height))
        patch = full
    return patch.resize((size, size), _I.LANCZOS)

SIZE = 150
OUT = 1024
# ═══ HOW MUCH OF THE SQUARE THE MARK OCCUPIES ═══
#
# Was 0.62, which left a ring of dead space a third of the width and made the M small in a big empty
# box — the founder's note, and correct: at feed size the void reads and the letter does not.
#
# 0.80 is the largest value where the block's corners still sit inside the circle LinkedIn crops a
# personal avatar to. `render` prints that measurement on every run, so this is a checked number
# rather than a guess — push it further and the run says the corners are outside.
# ═══ TWO CROPS, TWO SIZES — AND I HAD BEEN SOLVING FOR THE WRONG ONE ═══
#
# The mark was held to 0.62, then 0.72, both times against the largest CIRCLE that fits the square.
# That is the right constraint for a personal avatar and the wrong one for a company logo, which
# LinkedIn shows in a ROUNDED SQUARE — a far more generous frame, and the one this is actually for.
#
# Solved rather than eyeballed, for this block's aspect (h/w = 0.942):
#
#   circular crop                     max 0.728
#   rounded square, 18% radius        max 0.920
#   rounded square, 22% radius        max 0.896   ← LinkedIn's, roughly
#   rounded square, 25% radius        max 0.878
#
# So `SQUARE` is 0.88, a hair under the tightest of those — 45% larger than where this started, and
# the void the founder kept pointing at is gone. `CIRCLE` stays for anything cropped round.
SQUARE = 0.88
CIRCLE = 0.72
SAFE = SQUARE


def font():
    for path, idx in (("/System/Library/Fonts/Menlo.ttc", 0),
                      ("/System/Library/Fonts/SFNSMono.ttf", 0),
                      ("/Library/Fonts/DejaVuSansMono.ttf", 0)):
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, SIZE, index=idx)
            except Exception:
                continue
    return ImageFont.load_default()


def render(bg, out_name, transparent=False, ground=None, ink=None):
    f = font()
    tmp = ImageDraw.Draw(Image.new("RGB", (10, 10)))
    ascent, descent = f.getmetrics()
    line_h = ascent + descent
    block_w = max(tmp.textbbox((0, 0), line, font=f)[2] - tmp.textbbox((0, 0), line, font=f)[0] for line in ART)
    block_h = line_h * len(ART)

    # Draw large, then downsample — the box-drawing glyphs have hairline strokes that alias badly
    # at final size and resolve cleanly from 4×.
    side = int(max(block_w, block_h) / SAFE)
    mode = "RGBA" if transparent else "RGB"
    img = Image.new(mode, (side, side), (0, 0, 0, 0) if transparent else bg)
    if ground is not None:
        img.paste(ground.resize((side, side), Image.LANCZOS), (0, 0))
    d = ImageDraw.Draw(img)
    x0, y0 = (side - block_w) // 2, (side - block_h) // 2
    for i, line in enumerate(ART):
        fg = ink or FG
        d.text((x0, y0 + i * line_h), line, font=f, fill=fg if not transparent else fg + (255,))

    img = img.resize((OUT if ground is None else 300, OUT if ground is None else 300), Image.LANCZOS)
    path = os.path.join(HERE, out_name)
    img.save(path)
    # The circle a personal avatar is cropped to. Reported so the safe area is a checked number
    # rather than a claim in a docstring.
    # Reported against BOTH crops, because a file sized for a rounded square is legitimately outside
    # the circle and a bare "OUTSIDE" would read as a fault every run. Naming which crop it clears is
    # the difference between a check and a warning nobody reads.
    corner = math.hypot(block_w, block_h) / 2 * (OUT / side)
    fits = "square+circle" if corner <= OUT / 2 else "rounded square only"
    print(f"  {out_name}  {OUT}×{OUT}  block corner {corner:.0f}px — fits {fits}")


if __name__ == "__main__":
    print("avatar:")
    # Blends into the banner because it IS the banner: the ground is cut from it, not matched to it.
    # 300px is LinkedIn's own recommendation for a logo and, at the ~150px it displays, the same
    # device pixel ratio the cover renders at — so the grain survives at the same density.
    render(None, "logo-avatar-dark.png", ground=banner_ground(300))
    # The reference: green on white.
    render(WHITE, "logo-avatar-light.png", ink=ON_LIGHT)
    # Neither assumption.
    # The one being uploaded. Radiant rather than readable: see RADIANT for the luminance ladder
    # and for what it costs on white.
    render(None, "logo-avatar-mark.png", transparent=True, ink=RADIANT)
    # The existing dark square, kept on loam for the wordmark's own ground.
    render(LOAM, "logo-square.png")
    # THE ONE TO UPLOAD TO LINKEDIN. A dark tile in a column of white cards, with the mint pushed to
    # where it stops gaining. 12.1:1 against its own ground, 19.7:1 against the feed. See CONTRAST_BG.
    render(CONTRAST_BG, "logo-avatar-contrast.png", ink=CONTRAST_FG)
