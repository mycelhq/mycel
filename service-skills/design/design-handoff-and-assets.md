---
name: design-handoff-and-assets
description: Prepare and deliver design work to developers — organized files, specs, tokens, exported assets, and annotations — so the build matches the design without a hundred clarifying questions.
---

# Design Handoff & Asset Delivery

The design isn't done when it looks right in Figma; it's done when a developer can build it accurately without guessing. Sloppy handoff is where great designs become mediocre builds. Your job is to remove every ambiguity and every manual export the developer would otherwise fumble.

## Organize the source file first

A handoff file is a shared document, not your scratchpad. Before delivering: name every layer and frame meaningfully (no "Rectangle 47", "Frame 12 copy 3"). Structure pages logically (Cover, Design System, Components, Screens/Flows, Archive). Delete or clearly quarantine dead exploration. Use auto-layout on everything that will be responsive — it communicates the resize/reflow behavior developers need and prevents "how does this stretch?" questions. Group screens by flow so a dev can follow the journey.

## Componentize and tokenize

Build the design on **components** and **styles/variables**, not detached one-offs. Define color styles, text styles, effect styles, and spacing/size variables — these map directly to the code design tokens (see the web-dev design-system skill). When a developer sees `color/brand/primary` instead of a raw hex, they know it's a token, not an arbitrary value. Provide variants for component states (hover/active/disabled/error/loading) so the dev builds *all* states, not just default. Name components to match likely code component names (Button, Card, FormField) to reduce translation friction.

## Specify the invisible

Devs can inspect what's on the canvas; they can't inspect what isn't. Explicitly annotate:

- **Interaction & behavior**: what happens on hover/tap/focus, transitions and their duration/easing, what's clickable and where it goes, scroll behavior, sticky elements.
- **Responsive behavior**: provide desktop AND mobile (and tablet where it differs); annotate how elements reflow, wrap, hide, or reorder between breakpoints. Don't make devs invent the mobile layout.
- **States**: empty, loading, error, success, and edge cases (very long text, missing image, zero items, huge numbers). Show the overflow/truncation rule.
- **Content rules**: max/min lengths, truncation vs wrap, pluralization, date/number formats.
- **Conditional logic**: when elements appear/disappear, validation rules, and their error messages (write the actual error copy).

## Assets — export everything, correctly

Never make the developer export from your file. Deliver production-ready assets:

- **Icons and logos as SVG** (optimized/cleaned — run through SVGO; remove editor cruft, flatten where sensible). SVG scales and recolors; don't ship icons as PNG.
- **Photos/raster as optimized WebP/AVIF** at the correct dimensions, plus @2x for retina where relevant. Compress — never hand over a 5MB PNG.
- Correct naming convention (kebab-case, semantic: `icon-arrow-right.svg`, not `Vector-3.png`).
- Favicon/app-icon set in required sizes if in scope.
- Fonts: provide the web-licensed WOFF2 files (or the font source/link) and confirm licensing covers web embedding — don't leave the dev to source fonts and risk a licensing gap.

## Redlines and measurements

Use the tool's inspect/dev-mode (Figma Dev Mode, Zeplin) so devs can pull exact measurements, colors, and CSS — but don't rely on it alone for intent. Confirm the spacing scale, type scale, grid, and breakpoints are documented in one place. Where inspection could mislead (e.g. optical adjustments, intended fluid behavior), annotate the *intent*, not just the measured pixel value.

## Walkthrough and open loop

Do a live or async handoff walkthrough of the flows, key interactions, and gotchas. Then stay available: designs meet reality during build (a real string is longer, an API returns an unexpected state) and the designer must resolve those quickly rather than the dev guessing. Review the built result against the design and log the diffs — handoff includes the QA loop, not just the toss-over-the-wall.

## Quality bar

Acceptable: a Figma link and some exported PNGs. **Great**: a cleanly organized, componentized, tokenized file; every state and breakpoint designed and annotated; interaction/responsive/content rules specified in writing; SVG icons and optimized responsive images delivered pre-exported and sanely named; fonts with confirmed licensing; a walkthrough done; and the designer available to resolve build-time reality. Failure modes to reject: "Rectangle 47" layers, only the desktop happy-path designed, raw hex instead of tokens, icons as PNG, uncompressed images, no error-state copy, no responsive annotation, and disappearing after handoff. If a developer has to ask what happens on hover or how it looks on mobile, the handoff was incomplete.
