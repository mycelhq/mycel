---
name: brand-identity-system
description: Develop a coherent brand identity — strategy, logo, color, type, and usage rules — into a guidelines document a client and any future designer can apply consistently.
---

# Brand Identity System

You are building the visual and verbal foundation a business runs on for years. Identity is not a logo; it's a system of decisions that make every future touchpoint recognizable and consistent. Do strategy before pixels — a beautiful mark on a wrong strategy is worthless.

## Strategy first — anchor every choice

Before designing anything, establish and write down: the brand's **positioning** (what category, against whom, what single differentiating truth), its **audience** (who they are, what they value, what signals credibility to them), its **personality** (3–5 traits, e.g. "precise, warm, understated" — and their opposites, so choices are falsifiable), and the **one-line essence**. Every subsequent decision is justified against these. If you can't explain why a color or typeface serves the strategy, you're decorating, not designing. Audit 3–5 competitors' identities and deliberately choose where to differentiate — if everyone in the category is blue and geometric, that's an argument to be neither.

## Logo — build a system, not one lockup

Design the primary logo, then the *system* around it: a horizontal lockup, a stacked variant, a standalone icon/monogram for tight spaces (favicon, app, avatar), and a monochrome (single-color and reversed/knockout) version. Test the mark at 16px and at billboard scale — it must survive both. It must work in pure black, pure white, and on a busy photo. Rules to enforce: define minimum size, define clear-space (usually a multiple of a glyph feature), and specify what is forbidden (no stretching, recoloring, rotating, adding effects, or placing on low-contrast backgrounds). Typography-based wordmarks usually need custom letterform tweaks — never just set a font and call it a logo. Deliver vector (SVG) as the master.

## Color — a purposeful palette with roles

Don't hand over ten swatches with equal weight. Define roles: **primary** (the ownable brand color), **secondary** (1–2 support), **neutrals** (a considered gray ramp — most of a real interface is neutral), and **functional** (success/warning/error). Specify each in HEX, RGB, and where relevant CMYK and Pantone for print consistency. Verify **accessibility**: brand color on white and white on brand color for text must meet WCAG AA (4.5:1) — a primary color that fails contrast can't be used for buttons or links, and you must know that now, not after launch. Give explicit guidance on proportion (the 60-30-10 rule: dominant neutral, secondary, accent pop) so users don't drown pages in the primary.

## Typography — a functional hierarchy

Choose a type system, not just fonts: usually a display/heading face and a body face that pair by contrast (or a single well-hinted variable family used across weights). Body face must be legible at 16px on screen and have the weights/styles the brand needs. Provide a type scale (a modular ratio), and specify usage: which face/weight/size/leading/tracking for H1–H4, body, caption, and UI. Ensure webfont licensing covers the client's usage and provide the web-optimized files. Beauty in a specimen means nothing if it's illegible in a paragraph.

## Supporting elements

Round out the toolkit so the brand is buildable: an iconography style (stroke weight, corner radius, grid), a photography/illustration art direction (mood, treatment, do/don't examples), graphic devices/patterns, and a spacing/layout logic. These are what stop the brand from collapsing to "the logo and blue" once real content arrives.

## Guidelines document

Deliver a guidelines doc that a stranger could follow. It must contain: the strategy summary, logo system with clear-space/min-size/misuse examples (show the wrong ways, crossed out — this prevents the most damage), full color spec with roles and accessibility notes, type system with the scale and usage, iconography/imagery direction, and applied mockups (business card, social avatar/banner, website header, one real-world piece) proving the system works in context. Provide organized, correctly-formatted asset files (SVG/PNG logos in all variants, color/font files) named sanely.

## Quality bar

Acceptable: a nice logo, a palette, two fonts. **Great**: every element traceable to the stated strategy, a logo system that survives 16px to billboard and mono/knockout, an accessible color palette with defined roles and proportions, a legible functional type scale, explicit misuse rules, and mockups proving it in the wild — packaged so any future designer stays on-brand without you. Failure modes to reject: designing the logo before the strategy, a single logo lockup with no variants, an inaccessible primary color used for text, a font that's gorgeous in the specimen and unreadable in body, and guidelines that show only correct usage (users learn the guardrails from the "don'ts").
