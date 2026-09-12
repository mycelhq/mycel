---
name: design-craft-color
description: Color rules for bespoke marketing sites and client portals. Grayscale-first, OKLCH construction, one-accent discipline, WCAG contrast, first-class dark mode, and rationed gradients. Obey these when constructing tokens and applying color in the build.
---

# Design Craft: Color

The approved Visual Identity gives the palette rationale and the single accent hue for THIS business. This file governs HOW color is constructed and applied.

## Repo law (read first — overrides any hex you were tempted to write)
- Colors come **ONLY** from CSS variable tokens in `app/globals.css`, declared via `@theme inline`.
- **NEVER** a hardcoded hex in a component. **NEVER** a raw Tailwind palette class (`bg-blue-600`, `text-red-500`, etc.).
- The single accent is `--business-accent`, used through `bg-accent` / `text-accent` / `<Button variant="accent">`.
- Tokens **re-declare per theme**, so **NEVER** write `dark:` prefixes. Light and dark are handled by the token layer.
- The OKLCH / color-mix guidance below is for HOW to author the TOKEN VALUES inside `globals.css` — it is never license to hardcode color in a component.

## Grayscale first
- Design the whole layout in grayscale, add color LAST (Refactoring UI). If it works in gray, color only sharpens it.
- Most of the interface is the neutral ramp. Color is the exception, not the field.

## Construct token values in OKLCH
When authoring token values in `globals.css` (Evil Martians, LogRocket):
- Use **OKLCH** for perceptual uniformity — equal lightness steps look equal.
- Build ramps with `color-mix()` / consistent L steps off a base hue rather than hand-picking each stop.
- **Clamp chroma** so no step gets garish; keep chroma modest and consistent across the ramp.
- This yields predictable, accessible ramps that stay legible in both themes.

## One accent only
- Palette = **one neutral ramp + exactly ONE accent** (`--business-accent`) + optionally ONE tint.
- No second accent. Vercel ships zero second accent — the ink IS the brand (Geist). Restraint reads premium.
- The optional tint is for subtle fills/backgrounds only, never a competing call-to-action color.

## Contrast (WCAG 2.2)
- Body text ≥ **4.5:1** against its surface. Large text ≥ 3:1.
- Verify the accent has sufficient contrast for text/buttons in BOTH themes; if not, the token layer must carry a per-theme accent-foreground.
- Never rely on color alone to convey state.

## Dark mode is first-class
- Dark is not an inverted afterthought (LogRocket, Geist). Design it as its own surface.
- Near-black surfaces: **#0a0a0a - #171717** range (authored as tokens), not pure `#000`.
- **Elevate by lightening the surface a step, not by piling on shadow.** Higher = lighter.
- Desaturate/soften the accent slightly in dark if it vibrates against near-black — handled in the dark token block.

## Gradients — rationed
- At most **ONE** gradient on the whole marketing page, at the single hero focal moment (Geist ships one hero gradient and no more).
- **NO gradients in `/portal`.** None. The portal stays flat, calm, token-driven.
- No gradient text on body, no gradient borders sprinkled around.

## Respect the platform
- Honor `prefers-color-scheme`, `prefers-contrast`, and `forced-colors` (Windows high-contrast) — don't override user contrast choices.

## Sources
- Evil Martians — OKLCH in CSS, why quit RGB/HSL. https://evilmartians.com/chronicles/oklch-in-css-why-quit-rgb-hsl
- LogRocket — OKLCH for consistent, accessible palettes; first-class dark mode. https://blog.logrocket.com/oklch-css-consistent-accessible-color-palettes
- Refactoring UI (Wathan & Schoger) — grayscale-first, color last. https://www.sglavoie.com/posts/2023/09/09/book-summary-refactoring-ui/
- Vercel Geist — monochrome ink brand, zero second accent, single hero gradient. https://vercel.com/geist/introduction , https://www.designsystems.one/design-systems/vercel-geist
