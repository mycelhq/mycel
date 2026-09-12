---
name: use-the-component-library
description: The rich component library — 400+ Aceternity / Magic UI / Kokonut animations, shaders, hero sections and effects, shipped IN the workspace and callable by metadata. Use it on every marketing build; it is the difference between a reskinned template and a bespoke site.
---

# Use the component library

The workspace ships two layers of components, and knowing which is which saves you every setup turn:

1. **Primitives are already there.** Every shadcn/ui primitive (~50: button, dialog, tabs, form,
   select…) is vendored in `components/ui/`. NEVER run `npx shadcn add` — just import.
2. **The rich layer is a local library, 400+ items.** Aceternity, Magic UI and Kokonut UI —
   animated heroes, bento grids, shaders, marquees, globes, text effects, backgrounds — harvested
   with full source into `component-library/` and driven by one CLI. Nothing is fetched from the
   network; it works offline in the sandbox.

## The tool

```bash
node scripts/component.mjs tags                     # the 23 tags and their counts
node scripts/component.mjs search --tag background  # e.g. aurora, beams, meteors, dot patterns
node scripts/component.mjs search marquee           # free-text over names + descriptions
node scripts/component.mjs show magicui/globe       # inspect before you commit to it
node scripts/component.mjs add aceternity/bento-grid magicui/marquee
```

`add` writes the files into `components/`, resolves same-source registry dependencies, never
overwrites, and prints ONE `npm install …` line for anything missing — run it if printed, then
import and use.

## How to use it well (this is the taste part)

- **Reach for it at the design stage, not as decoration.** When `design-the-front-page.md` calls for
  a signature motif or a section the seed does not ship, SEARCH THE LIBRARY FIRST — a curated
  Aceternity hero or Magic UI background beats anything written from scratch in one run.
- **Two or three rich components per page, not ten.** One hero treatment, one background or motif,
  one proof section (marquee of logos, bento of services). A page wearing every effect reads as a
  demo reel, not a business.
- **Restyle to the identity.** Every library component arrives in its author's palette. Rewire its
  colors/typography to the site's brand tokens (`--business-accent`, the preset variables) — a
  component that ignores the brand is the template-look this library exists to kill.
- **Both themes, always.** The site ships the light/dark switcher; check every added component in
  `.dark` before you finish. Effects with hardcoded dark backgrounds usually need their light-mode
  colors mapped to tokens.

## Reference first, paste second

A library item is SOURCE MATERIAL, not a finished part. The loop that produces a bespoke site:

1. `search` by tag, then `show <src>/<name>` and READ the source before deciding anything.
2. Choose the cheapest adaptation that serves the identity:
   - **Use as-is** only for pure mechanics (a marquee track, a scroll hook) where the visual
     surface is entirely yours anyway.
   - **`add` then rewrite** when the structure is right: land the file, then immediately rework its
     palette to the brand tokens, its type to the site's pairing, its copy to this business. The
     upstream author's colors and demo text must never survive into the page.
   - **Read and re-author** for section-level pieces (heroes, feature grids): treat the item as a
     technique to learn from — lift the animation approach or layout trick into a component you
     write in the site's own vocabulary. This is the highest-taste path and usually the right one.
3. Whatever the path, the result must be indistinguishable in voice and palette from the rest of
   the site. If a visitor can tell which section came from a library, it is not done.

## This is REQUIRED, and the build checks it

The marketing build's verification counts how many library components you pulled (via
`component.mjs add`, which records them). A build that hand-writes plain sections and skips the
library FAILS verification and is sent back — the same as a build that does not compile. Pull at
least two on every marketing site: one atmosphere piece (an animated hero, an aurora/beams/dot
background, a shader) AND at least one content block (a bento grid, a marquee of logos, an animated
feature or testimonial section). Then restyle them to the brand tokens and the identity's motif —
`add`ing is the floor, not the finish. Reskinning a template is exactly the failure this exists to
prevent.
