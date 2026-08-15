---
name: design-craft-motion-detail
description: Elevation, borders, radii, motion, and premium finishing details for bespoke marketing sites and client portals. Shadow-vs-surface elevation, hairline borders, radii by archetype, scroll and hover motion values, kinetic type discipline, and the small details that read premium. Obey these when adding depth, motion, or polish.
---

# Design Craft: Motion & Detail

The approved Visual Identity picks the ONE signature motif and the archetype. This file governs HOW elevation, borders, radii, motion, and finishing are executed.

## Stack constraints (non-negotiable)
- **ALL motion gated behind `prefers-reduced-motion`.** Provide a static, non-animated state; motion is progressive enhancement.
- Elevation, borders, and radii come through tokens/utilities — no hardcoded hex shadows or colors. No `dark:` prefixes (tokens re-declare per theme).
- **`/portal` stays calm:** NO decorative motion, NO kinetic type, NO gradients. Portal may use quiet functional transitions (focus, hover on interactive controls) only.

## Elevation
- A shadow scale exists (Refactoring UI), but **this repo prefers elevation = surface-step + hairline border over heavy shadows.** Lift a card by stepping its surface token and adding a 1px border, not by dropping a big shadow.
- **In dark mode, elevate by LIGHTENING the surface**, not by adding shadow (shadow is nearly invisible on near-black).
- If you do use shadow, keep it soft, low, and single-layered — never a hard dark drop shadow.

## Borders
- **1px hairline, low-contrast borders read premium** (studiomeyer). Use a subtle neutral-token border to separate surfaces rather than heavy dividers or boxes.
- One consistent border treatment across the page.

## Radii by archetype
Pick from the identity's archetype and apply consistently everywhere:
- **Technical / product:** 6px (Geist).
- **Warm / playful:** 12-16px.
- **Brutalist:** 0-2px.
Never mix radii scales within one surface.

## Scroll-in motion
- Fade in + **12-24px upward translate** as elements enter the viewport.
- Stagger children **40-80ms** apart.
- Duration **200-500ms**, **ease-out**.
- Govern all of this with SHARED timing and easing tokens — do not hand-tune per component (studiomeyer, Emil Kowalski). One system, applied everywhere.

## Hover
- Card hover: scale **exactly 1.02** + a slightly softer/lower shadow, **~150-200ms** (studiomeyer). Not 1.05, not a bounce.
- Interactive elements get a considered hover state, always with a matching non-motion fallback.

## Kinetic type
- Apply kinetic/animated type to the **ONE headline that matters most** (usually the hero) and nowhere else (Magic UI, Emil Kowalski). Kinetic everything = kinetic nothing.

## The one signature motif
- Carry ONE recurring signature motif through the page (Raycast's diagonal stripes are the model) — the motif named in the approved identity. Repeat it deliberately in 2-3 places; it becomes the brand's fingerprint.

## Small premium details (do these)
- **Real screenshots**, never lorem or stock imagery, in heroes, bento tiles, and features.
- **Branded focus rings** using the accent token — visible, never `outline: none` with nothing to replace it.
- **Precise numerals** — tabular figures for prices, stats, data.
- Considered **empty, hover, and loading states** for every interactive surface (Emil Kowalski) — especially in the portal.
- Consistent iconography from **lucide-react** only.

## Sources
- studiomeyer — web design trends 2026 (1.02 hover, hairline borders, shared motion timing). https://studiomeyer.io/en/blog/webdesign-trends-2026
- Emil Kowalski — motion & UI polish (shared easing, empty/loading states, kinetic restraint).
- Refactoring UI (Wathan & Schoger) — shadow-scale elevation, hierarchy. https://www.sglavoie.com/posts/2023/09/09/book-summary-refactoring-ui/
- Magic UI — kinetic text, bordered/animated components. (VoltAgent/awesome-design-md)
- superfiles / Raycast DESIGN.md — bento hover interactions, signature diagonal-stripe motif. https://github.com/VoltAgent/awesome-design-md/blob/main/design-md/raycast/DESIGN.md
- Vercel Geist — 6px radii. https://vercel.com/geist/introduction
