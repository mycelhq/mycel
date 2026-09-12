---
name: synthesize-visual-identity
description: How to derive a BESPOKE visual identity for one business from its brand configuration and what it actually does — the method, the archetypes, and the one rule that keeps every generated site from looking the same. Use for the design_identity task, before any site is built.
---

# Synthesize a visual identity

This runs BEFORE a line of the site is built. Its whole purpose is the thing the founder complained
about: every generated site used to look the same, because the build filled one fixed template. You
break that here — by committing to a visual direction derived from THIS business, so the build's
brief is an identity, not a scaffold. The founder approves what you produce before anything is built.

You output the identity **only** (the `design_identity` schema). You do not touch code.

## What you read first

1. **The brand kit** — `GET /v1/projects/:id/brand-kit` (also on `GET /v1/host/:host` → `brand_kit`).
   This is what the founder already chose: `site.preset` (style, baseColor, theme, font, fontHeading,
   radius, `code`), `type.heading` / `type.body`, `accent`, logo. **This is a constraint, not a
   suggestion.** You design WITHIN it: choose the discipline of the accent, the temperature of the
   neutrals, the character of the type — you do not override the accent or swap to a CDN font.
2. **The business** — what it sells, who it sells to, how it positions, its knowledge. The identity
   must be legible as *this* business's. A bookkeeper and a brand studio that sell to the same
   startups should not get the same site.

## The method (repeatable, and it must be)

1. **Name the one truth.** In a sentence: what does this business want a stranger to feel in the
   first three seconds? (Trust. Taste. Rigor. Warmth. Momentum.) Everything below serves that.
2. **Pick the archetype that serves it** — from the enum, deliberately. The rationale must be one a
   competitor could NOT copy word for word. If your rationale fits any business in the category, you
   picked by default, not by design. Redo it.
3. **Find the signature motif.** This is the single most important decision. One distinctive element,
   executed everywhere, that makes the site recognisably theirs: a hairline index-number system, an
   oversized wordmark that bleeds off the fold, a mono metadata rail down the left, a duotone image
   treatment in their accent, a numbered process rail, a single rule the width of a word. **One.** Not
   five decorations — five decorations is noise and it is what amateur sites do. The motif is the
   difference between "a nice template" and "designed for us".
4. **Derive type, palette, layout from the archetype** — coherently. The archetype decides the
   defaults; the business decides the nuance. Fill every field of the schema with a choice AND its
   reason.
5. **Write the avoid list from the category.** Name the clichés that would make this business look
   like everyone else in its field (SaaS: the three-across feature grid and the gradient blob;
   agencies: the full-bleed hero video and the "We craft experiences" line; accountants: the stock
   handshake and the navy-and-grey corporate template). These are the traps the build must dodge.

## The archetypes, concretely

Each names a coherent set of defaults. Choose one; do not blend three.

- **editorial** — serif display, generous measure, magazine hierarchy, rag-right asymmetry, images
  treated as plates. For studios, writers, brand/creative businesses selling taste.
- **technical** — mono for metadata and labels, grid-precise, product-doc calm, tight even scale,
  cool neutrals. For developer-adjacent, data, infra, precise-process businesses.
- **warm-organic** — soft warm neutrals, rounded radii, human photography, relaxed rhythm. For care,
  wellness, hospitality, people-first services.
- **bold-brutalist** — heavy grotesque type, hard edges, high contrast, oversized wordmark, near-mono
  palette with one loud accent. For businesses whose whole pitch is confidence and difference.
- **minimal-luxury** — extreme restraint, vast whitespace, one accent used once, small precise type.
  For premium, high-ticket, "if you have to ask" positioning.
- **playful** — colour, personality, a little motion, unexpected layout. For consumer-facing,
  creative, younger-audience businesses.
- **corporate-trust** — structured, credible, understated, real numbers foregrounded, no theatrics.
  For finance, legal, B2B services where the buyer is de-risking a decision.

## The rules that do not bend (they come from the design-craft skills — read those too)

- **Design within the founder's brand kit.** Never override the configured accent or fonts; never a
  CDN web font; never a hardcoded hex. The kit is the source of truth; you decide how it is *used*.
- **Both themes ship.** `default_mode` is only which one a first visitor sees. The switcher stays.
- **No fabricated proof, ever.** If the business has no real numbers or testimonials, the identity
  must not lean on a proof section that will be empty — plan a page that looks finished without it.
- **The portal is not a billboard.** Whatever the marketing archetype, `/portal` stays calm and
  legible — a client opens it to work, not to be sold to. The identity applies its palette and type
  there; it does not apply its theatrics.

## Hand-off

Your output is the approved brief for `build_feature`. Write it so a build agent who has never seen
this business could execute it and produce a site the founder recognises. Every field is an
instruction; `signature_motif`, `sections`, and `avoid` are the ones that carry the design.
