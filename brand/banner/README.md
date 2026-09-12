# The LinkedIn banner

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
