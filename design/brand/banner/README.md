# The banners

Two surfaces, two compositions, one generator. `?mode=github` is left-aligned and fills the frame;
the default is right-aligned around LinkedIn's avatar. Both draw the same shader the sign-in screen
draws, so they are the brand rather than a copy of it.

## The README banner

```bash
cd kernel/brand/banner && python3 -m http.server 8765 &
MYCEL_DPR=1 node shot.mjs "http://localhost:8765/banner.html?w=1920&h=453&mode=github" /tmp/b.png 1920 453
python3 -c "from PIL import Image; Image.open('/tmp/b.png').convert('RGB').quantize(colors=64, dither=Image.NONE).save('../banner-readme.png', optimize=True)"
```

`?mark=` overrides the wordmark, `?does=` the line under it.

### The spec, if you are drawing this by hand instead

The generated one is a placeholder good enough to ship. A drawn one should keep these, because they
are what makes it read as the same object as everything else we make:

| | |
|---|---|
| Ratio | **4.24 : 1** (1920 × 453 ships; 2432 × 574 is the same frame at 2× and four times the bytes) |
| Background | `oklch(0.148 0.004 228.8)` — near-black, very slightly cool |
| Wordmark | `oklch(0.78 0.21 146)`. Brighter than the product's `--glow`, which is a light source and reads dim as an ink |
| Second line | `oklch(0.987 0.002 197.1)` off-white. The contrast is what makes it a caption rather than a second headline |
| Faces | Geist 800 at −0.055em for the mark; a condensed grotesque, all caps, for the line |
| Left inset | ~17% of the HEIGHT, not a round pixel number — type set flush to a computed edge looks further in than it is |
| Weight | **under 600 KB.** The grain is noise and PNG cannot compress it; quantise to 64 colours with no dither. 2× and full colour came out at 6.7 MB, above the fold, on the first page a stranger sees |

**The line is three words and they are the loop.** `DRAFT.` is what the machine does, `APPROVE.` is
the human gate that is the entire differentiator, `INVOICE.` is the only evidence any of it worked.
Not adjectives — every competitor's banner is adjectives.

## The LinkedIn banner

```bash
cd kernel/brand/banner && python3 -m http.server 8765 &
node shot.mjs "http://localhost:8765/banner.html?w=1584&h=396&avatar=152" ../linkedin-cover.png 1584 396
node shot.mjs "http://localhost:8765/banner.html?w=1128&h=191&avatar=120" ../linkedin-company-banner.png 1128 191
```

`?text=` overrides the line (HTML, so `<em>` works). `?avatar=` is the diameter LinkedIn overlays.

## It is the product's own shader

`GrainGradient` from `@paper-design/shaders`, the same thing `cloud/components/brand/shader-field.tsx`
puts behind the sign-in screen, in the dark theme's own tokens. Geist and Instrument Serif, which is
what both apps load.

The first attempt reproduced the *landing page's* Bayer dither in Python instead. Different texture,
different surface — close enough to be recognised, wrong enough to look like a copy of the brand
rather than the brand.

## Three things that cost a render each

**The vanilla package has no `GrainGradient`.** That name is in `@paper-design/shaders-react`; the
plain package exports `ShaderMount` and the raw fragment shader. The import failed, nothing reached
the console, and the page rendered a flat background that looked like a design decision. Found by
asking the DOM whether a canvas existed.

**A module whose import fails never executes**, so a `try/catch` inside it cannot report the one
error most likely to happen. The `window.addEventListener("error")` in the classic script above the
module is the only thing that sees it. (And `import` is illegal inside a block, which is its own
wasted render.)

**Headless Chromium has no WebGL** — `shader-field.tsx` says so — so the shader threw and the banner
came out flat. `shot.mjs` launches with SwiftShader, Chromium's software rasteriser: slower, and
pixel-identical for a still frame.

## Layout

The left third is not ours. LinkedIn lays the avatar over the bottom-left of every cover, and type
placed there gets covered by the platform — the most common way a banner ends up looking careless.
So the frame reads dark on the left for the mark, and the line sits right-aligned in the bloom.

One sentence, nothing under it. A banner that says two things says neither.
