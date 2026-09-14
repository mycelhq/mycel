---
name: component-libraries
description: Compose the site from the best FREE, high-quality component libraries (shadcn/ui, Magic UI, Aceternity, Origin UI, Tremor) via the shadcn CLI, then adapt them to the brand — never hand-roll a section a great library already nails.
---

# Build from free component libraries, then make them yours

Do not hand-write a hero, a pricing table, a testimonial wall, or a bento grid from a blank file. Great, free, open-source libraries have already solved these, accessibly and responsively. Pull the closest match and adapt it to the brand. Hand-rolling from scratch is slower and almost always worse.

All of these are FREE and public — no API key, no account. They are shadcn-registry compatible, so the `shadcn` CLI (already installed in this workspace) installs any of them by URL straight into `components/`.

## The libraries, and what each is for

- **shadcn/ui** (ui.shadcn.com) — the foundation. Buttons, forms, dialogs, tabs, cards, navigation. This template already uses it; its primitives are your building blocks. `npx shadcn@latest add button card dialog tabs …`
- **shadcn blocks** (ui.shadcn.com/blocks) — full sections: hero, login, dashboard, sidebar. Free. Start here for whole-page structure.
- **Magic UI** (magicui.design) — animated marketing components: marquee, animated beams, bento grids, number tickers, shimmer buttons. Free registry. `npx shadcn@latest add "https://magicui.design/r/<name>.json"`
- **Aceternity UI** (ui.aceternity.com) — high-end animated hero/section components (spotlight, background gradients, 3D cards). Free; copy from the site or its registry. Use sparingly — one showpiece, not ten.
- **Origin UI** (originui.com) — a large set of polished, free shadcn components (inputs, selects, avatars, timelines). Great for filling in the details shadcn/ui doesn't ship.
- **Tremor** (tremor.so) — free React dashboard + chart components. Reach for these for any data/analytics surface (the portal's metrics, a KPI section).
- **HyperUI** (hyperui.dev) — free Tailwind marketing + application snippets, copy-paste. Good for quick, clean sections without a dependency.

## You can FETCH components, but you cannot SEE them — so work by name + index

You have network, `curl`, and the `shadcn` CLI. You do NOT have a browser: you cannot look at a rendered gallery and pick the prettiest card. You choose a component by KNOWING it exists and what it is for, then fetch its code. Two moves:

**1. Discover what a registry actually has — list its index before guessing a name.** Most shadcn-compatible registries serve a machine-readable index. `curl` it and read the names/descriptions:

```
curl -s https://magicui.design/r/registry.json | jq '.items[] | {name, description}'   # Magic UI
curl -s https://ui.shadcn.com/r/index.json | jq '.[].name'                             # shadcn/ui
```

If `registry.json`/`index.json` 404s, try the library's `/r` root or its docs; the point is: LIST first, then pick a real name, then fetch. Do not invent a component name and `add` it blind — confirm it against the index.

**2. Install it into this project by URL (or name for shadcn/ui):**

```
npx shadcn@latest add button card dialog                         # shadcn/ui, by name
npx shadcn@latest add "https://magicui.design/r/marquee.json"    # any registry, by URL
```

The CLI writes into this project's own `components/`, resolves dependencies, and matches `components.json` + the Tailwind theme. For libraries that publish copy-paste code rather than a registry (Aceternity, HyperUI), `curl`/read the component source from their docs and write it into `components/` yourself, wiring its dependencies.

## The catalogue — what to reach for, by job

Names drift, so LIST the registry to confirm, but this is what each library reliably gives you:

- **Hero / above-the-fold:** Aceternity (spotlight, aurora/background-beams, hero-highlight), Magic UI (animated-grid-pattern, dot-pattern, retro-grid as a backdrop). One showpiece only.
- **Social proof / logos:** Magic UI `marquee` (logo or testimonial marquee), `animated-list`.
- **Feature sections:** Magic UI `bento-grid`, shadcn blocks feature sections, Aceternity `card-hover-effect`.
- **Numbers / stats:** Magic UI `number-ticker`, `animated-circular-progress-bar`; Tremor for real charts/metrics.
- **CTAs / buttons:** Magic UI `shimmer-button`, `rainbow-button`, `shiny-button`; shadcn `button` as the base.
- **Pricing:** shadcn blocks pricing, or compose from shadcn `card` + `badge` + `button`.
- **Forms / inputs / selects / auth:** shadcn/ui + Origin UI (large set of polished inputs, selects, tags, timelines).
- **Nav / footer / dashboard shell:** shadcn blocks (sidebar, dashboard, login) — full sections, not just primitives.
- **Dashboards / analytics / any data surface:** Tremor (cards, charts, KPI deltas) — reach for these on the portal's metrics.

So the loop is: decide the SECTION you need → recall the library that owns it (above) → `curl` its index to get the exact current name → `add` it → adapt to the brand.

## Then ADAPT — this is the part that matters

A pulled component is a starting point, never the finished thing. Make it the founder's:
- **Theme, don't restyle.** These components read the CSS variables this template already sets from the brand kit (`--primary`, `--background`, `--radius`, the fonts). Let them inherit. Do NOT hardcode colors — if a pulled component ships hardcoded hex, replace it with the token so a brand change still flows through.
- **Match the archetype.** The brand has a visual identity (editorial / technical / warm-organic / bold-brutalist / minimal-luxury / …). A bold-brutalist brand does not get a soft, rounded, gradient hero; a minimal-luxury one does not get a marquee of animated beams. Pick components that fit, and tune radius/shadow/motion to the archetype.
- **Motion is seasoning.** One animated showpiece per page, maybe two. A page where everything shimmers, floats and beams reads as a demo, not a business. Kill motion that does not earn its place.
- **Real content, never lorem.** Populate with the founder's actual offer, audience and words (from the brief/brand). A gorgeous component full of placeholder text is a failing deliverable.
- **Accessibility survives the adaptation.** Keep the semantic HTML, focus states, alt text and contrast the library gave you. Do not strip them for looks.

## Great vs acceptable vs failing

- **Great:** every section is a strong library component, themed to the brand tokens, tuned to the archetype, with one tasteful showpiece and real content — indistinguishable from a bespoke build, done in a fraction of the time.
- **Acceptable:** solid library components pulled and themed, even if the composition is a little generic.
- **Failing:** hand-rolled sections that a library does better, hardcoded colors that ignore the brand, placeholder text, or motion on everything. If it looks like an unstyled template or a component showcase, it is not done.
