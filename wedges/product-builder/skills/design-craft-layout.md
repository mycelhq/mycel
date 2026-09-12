---
name: design-craft-layout
description: Layout and composition rules for bespoke marketing sites and client portals. Section anatomy and order, the 4px spacing scale, padding rhythm, content and text measure, bento grids, and deliberate grid-breaking. Obey these when the build_feature task lays out any page.
---

# Design Craft: Layout & Composition

These are the layout laws. The approved Visual Identity (from the `design_identity` task) tells you WHICH archetype, section plan, and signature motif to use; this file tells you HOW to compose it. Obey both.

## Stack constraints (non-negotiable)
- Next.js 16 / React 19 / Tailwind v4 / shadcn (new-york, neutral) / lucide-react. No other CSS system.
- Layout uses Tailwind utilities and CSS grid/flex only. No CSS modules, no styled-components.
- The `/portal` is calm and legible: NO marketing theatrics, NO decorative section rhythm tricks, NO bento drama. Portal uses plain, generous, predictable layout. The rules below about hero drama, motif, and grid-breaking apply to the MARKETING site only.

## Section anatomy & order (marketing page)
Follow this canonical order unless the approved identity's section plan overrides it (Framiq):
1. **Sticky nav** — thin, logo left, 3-5 links, one accent CTA right.
2. **Hero** — in this exact internal order: kicker → headline → subhead → two CTAs (one accent primary, one quiet secondary) → product visual OR the ONE signature motif.
   - Lead the hero with a REAL product/portal screenshot, not an abstract illustration (Framiq).
3. **Social proof band** — logos or a one-line proof strip directly under the hero.
4. **Alternating feature sections / bento** — alternate image-left / image-right; or a bento block.
5. **How-it-works** — numbered steps (3-4).
6. **Testimonials.**
7. **Pricing.**
8. **FAQ.**
9. **Final CTA band** — polarity-flipped (dark if the page is light) for punch.
10. **Fat footer.**

Every section must work in BOTH light and dark themes via tokens. Never write `dark:` prefixes — tokens re-declare per theme.

## Spacing: the 4px scale
Use ONLY these step values for margin, padding, and gap (Refactoring UI — constrain the scale):
`4, 8, 12, 16, 24, 32, 48, 64, 96, 128`.
- Never invent an in-between value (no 20, no 40, no 72) for spacing.
- Related things closer, unrelated things farther — express hierarchy through spacing, not borders.

## Section padding rhythm
- Desktop vertical section padding: **96-128px** (`py-24` to `py-32`).
- Tablet: ~64px. Mobile: ~48px.
- Keep the vertical rhythm consistent down the page; do not let one section breathe at 128 and the next at 40.

## Width & measure
- Content max-width: **1100-1280px**, centered (`max-w-6xl`/`max-w-7xl` band). Never let content run full-bleed edge-to-edge except intentional full-bleed bands (CTA, image).
- Body text measure: **60-75 characters** per line. Constrain prose columns (`max-w-prose` or an explicit `ch` cap). Never a headline or paragraph spanning the full 1280px.

## Bento grids
Use a bento block when showcasing 3-6 related features/screenshots at once (SaaSFrame). Rules:
- **Asymmetric**, mixed aspect ratios — NOT a uniform card grid.
- Exactly **ONE dominant tile** anchoring the block; the rest orbit it.
- Real screenshots inside tiles, not lorem or stock (Raycast).
- Bento earns ~23% greater scroll depth vs uniform grids (SaaSFrame) — reserve it for the moment you want dwell.
- Do not stack two bento blocks back to back; one per page is usually enough.

## Deliberate grid-breaking
- **Break the grid exactly once per page, deliberately** (Framiq) — one element that bleeds past the column, overlaps, or offsets. One. A second break reads as an accident.
- The break should land on the hero motif or the single most important feature, never on body copy.

## Whitespace method
- Start with TOO MUCH whitespace, then remove until it feels right (Refactoring UI). Never start cramped and add.
- Whitespace is the primary tool for perceived quality and calm. When in doubt, add a step on the 4px scale, don't remove one.

## Sources
- Refactoring UI (Wathan & Schoger) — constrained spacing scale, hierarchy via spacing, whitespace-first. https://www.sglavoie.com/posts/2023/09/09/book-summary-refactoring-ui/
- SaaSFrame — designing bento grids that actually work (2026). https://www.saasframe.io/blog/designing-bento-grids-that-actually-work-a-2026-practical-guide
- Framiq — best SaaS landing pages 2026 (section order, real screenshot hero, deliberate grid break). https://framiq.app/blog/best-saas-landing-pages-2026
- Raycast DESIGN.md — real-screenshot bento tiles. https://github.com/VoltAgent/awesome-design-md/blob/main/design-md/raycast/DESIGN.md
