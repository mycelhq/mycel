---
name: design-craft-typography
description: Typography rules for bespoke marketing sites and client portals. Family count, premium pairings, variable-font-only sourcing, the type scale, leading and tracking rules, and kicker treatment. Obey these when the build_feature task sets any type.
---

# Design Craft: Typography

The approved Visual Identity names the type system for THIS business (which display family, which body). This file governs HOW type is set regardless of the pairing chosen.

## Stack constraints (non-negotiable)
- **No runtime CDN web fonts.** A CDN font request blocks the founder's headline. Self-host every font (place under the app, load via `@font-face` / `next/font` local). **Variable fonts only** — one file, many weights, ~400KB saved vs static cuts (launchnow).
- Font families are exposed as tokens/utilities; do not hardcode `font-family` strings in components — use the display and body utilities wired in `globals.css`.
- Works in both themes automatically (type is theme-agnostic; color comes from tokens, never `dark:`).

## Two families max
- Exactly **two** families: ONE display with personality + ONE neutral sans for body (Refactoring UI — limit families). Never three.
- Premium pairings to reach for:
  - **Expressive serif** (Playfair Display / Instrument Serif) + **Inter** — editorial, warm, human.
  - **Geist Mono / JetBrains Mono** + **Inter** — technical, product, precise (Geist).
  - When the identity is minimal/technical, the display family may simply be the body family at a heavier weight — restraint is a valid choice (Geist ships mono + sans and nothing else).

## Type scale (each step ≥ 1.25×)
Use ONLY these sizes; every step is at least 1.25× the last (Refactoring UI):
`14, 16, 18, 20, 24, 32, 40, 56, 72, 96` (px).
- Do not invent intermediate sizes.
- Establish hierarchy through size + weight + color, not through many custom sizes.

## Body text
- Body: **16-18px**, line-height **1.5-1.6**.
- Measure 60-75ch (see layout skill).
- Body weight 400 (or 450 if the variable font offers it). Never bold whole paragraphs for emphasis.

## Headings
- Large display/headings: tight leading **1.0-1.15**.
- Negative tracking **-0.01 to -0.03em** on LARGE display type only (Geist, Refactoring UI). NEVER apply negative tracking to body or small text — it hurts legibility.
- **2-3 weights max** across the whole site. In technical/minimal identities, cap heading weight at **600** — no 700/800/900 (Geist).

## Kickers / eyebrows
- Kicker above a headline: **uppercase**, letter-spacing **+0.06 to +0.1em**, small (14px), muted token color.
- One kicker per section maximum.

## Portal note
The `/portal` uses the SAME two families but stays understated: body sizes, restrained heading weights, no oversized display type, no kinetic treatment. Calm and legible over expressive.

## Sources
- launchnow — best fonts for web design 2026; variable fonts save ~400KB. https://launchnow.design/blog/best-fonts-for-web-design-in-2026
- Refactoring UI (Wathan & Schoger) — limit families, type steps ≥1.25×, hierarchy via size/weight/color. https://www.sglavoie.com/posts/2023/09/09/book-summary-refactoring-ui/
- Vercel Geist — Geist + Geist Mono, restrained weights, negative tracking on display. https://vercel.com/geist/introduction , https://www.designsystems.one/design-systems/vercel-geist
