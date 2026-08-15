---
name: core-web-vitals-performance
description: Diagnose and fix web performance against Core Web Vitals (LCP, INP, CLS) and loading speed so a client site is fast on real mid-range mobile devices, not just on the developer's laptop.
---

# Performance & Core Web Vitals

Speed is a feature and a ranking factor. You are optimizing for a mid-range Android on a 4G connection, not a MacBook on fiber. Always measure on throttled conditions; the laptop lies.

## The three metrics you are accountable for

- **LCP (Largest Contentful Paint)** — time to render the biggest above-the-fold element (usually the hero image or headline). Target < 2.5s. This is your headline number.
- **INP (Interaction to Next Paint)** — responsiveness to taps/clicks across the whole visit. Target < 200ms. Replaced FID in 2024; it's about main-thread blocking.
- **CLS (Cumulative Layout Shift)** — visual stability. Target < 0.1. Content jumping as it loads.

Measure both **lab** (Lighthouse, WebPageTest — reproducible) and **field** (CrUX / real-user data — what actually ships). Lab tells you why; field tells you whether it matters. Optimize the field 75th percentile.

## Fix LCP

The LCP element must load first and fast. (1) Identify it — Lighthouse names it. (2) If it's an image: serve modern format (AVIF/WebP), correctly sized (never a 3000px image in a 600px slot), with `fetchpriority="high"` and a `preload`; never lazy-load the LCP image (a top failure mode). (3) Eliminate render-blocking resources: inline critical CSS, defer the rest, `defer`/`async` scripts. (4) Kill slow server response (TTFB) — cache HTML at the edge/CDN, target TTFB < 600ms. (5) Preconnect to critical third-party origins. Self-host fonts or `preload` them with `font-display: swap` so text isn't invisible during load.

## Fix INP

INP is a main-thread problem. (1) Ship less JavaScript — it's the biggest lever. Audit the bundle (`webpack-bundle-analyzer` / source-map-explorer); remove dead deps, replace heavy libs (moment → date-fns/Temporal, lodash → native). (2) Code-split: route-level splitting, dynamic `import()` for below-fold or interaction-triggered components. (3) Break up long tasks (> 50ms) — yield to the main thread, defer non-urgent work, use `requestIdleCallback`. (4) Hydration cost on SSR frameworks is a common INP killer — prefer server components / islands / partial hydration; don't hydrate static content. (5) Debounce expensive handlers; move heavy compute to a Web Worker.

## Fix CLS

Layout shift comes from unreserved space. (1) Every `<img>`/`<video>` has explicit `width`/`height` (or aspect-ratio) so the browser reserves the box. (2) Reserve space for ads, embeds, and dynamically injected banners. (3) Fonts: use `size-adjust`/`font-display: optional` or metric-matched fallbacks to avoid the FOUT reflow. (4) Never insert content above existing content after load (e.g. a cookie bar pushing the page down) — overlay it instead. (5) Animate only `transform` and `opacity` — never `top`/`left`/`width`/`height`, which trigger layout.

## Asset discipline

Images are usually 60%+ of page weight. Enforce: responsive `srcset`/`sizes`, AVIF with WebP fallback, lazy-load *below-fold* images (`loading="lazy"`), and a CDN with automatic format negotiation. Fonts: subset to used glyphs, WOFF2 only, ≤ 2 families / ≤ 4 weights. Enable Brotli compression, HTTP/2+, and long-cache immutable hashed assets.

## Workflow

1. Baseline: Lighthouse mobile (throttled) + a WebPageTest run. Record all three metrics and the waterfall.
2. Rank fixes by impact × effort — LCP and JS reduction usually win first.
3. Change one thing, re-measure — attribute the delta. Don't shotgun.
4. Set a **performance budget** in CI (Lighthouse CI / bundlesize): fail the build if JS exceeds N KB or LCP regresses. Perf that isn't gated silently rots.

## Quality bar

Acceptable: green Lighthouse on desktop. **Great**: field CWV "good" at p75 on mobile — LCP < 2.5s, INP < 200ms, CLS < 0.1 — with a CI perf budget preventing regressions and the LCP image preloaded/prioritized. Failure modes to reject: measuring only on the dev laptop, lazy-loading the hero image, shipping a 200KB+ JS bundle for a marketing page, unsized images, animating layout properties, and "it feels fast to me." The user on a three-year-old phone is the client.
