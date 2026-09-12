---
name: design-the-front-page
description: The opinionated playbook for the deployed business's public front page — the section order that converts, the copy rules, the taste checklist, and the never-do list — plus how to apply the founder's brand kit (preset, fold, fonts) into content/marketing.ts and the live kit. Use whenever the founder asks how the site should look, when kickoff includes brand/design references, or before you touch a word of the marketing page.
---

# Design the front page

This page is the founder's front door: the address on their invoices, in their email signature, on
the card they hand a prospect. It has ONE job — turn a stranger who half-remembers meeting the
founder into someone who clicks through to the portal — and it is the one screen in the whole app
whose effect is measured. Treat it as a conversion surface a good agency would charge for, not a
brochure.

## Start from the approved visual identity — it is the brief

Before anything, read the brand kit (`GET /v1/projects/:id/brand-kit`, also `GET /v1/host/:host` →
`brand_kit`) and look for **`identity`** — the approved `VisualIdentity` a `design_identity` run
produced and the founder accepted. **When it is present, it is your brief, and you obey it:**

- **`archetype`** sets the whole visual family (editorial / technical / warm-organic / bold-brutalist
  / minimal-luxury / playful / corporate-trust). Build to it. A technical archetype gets mono labels
  and a precise grid; an editorial one gets serif display and a magazine rag. Do not average them
  toward the house default.
- **`layout.signature_motif`** is the single most important instruction on this page. It is the one
  distinctive device — a hairline index, an oversized wordmark, a mono metadata rail, a duotone image
  treatment — that makes this site recognisably THIS business's. Execute it, everywhere it belongs,
  once as a system. It is the difference between "a nice template" and "designed for us", which is the
  exact difference the founder is paying for.
- **`sections`** is the ordered section plan and each `intent` tells you what that section must do for
  this business. Follow it, including where it deviates from the default order.
- **`palette`, `typography`, `layout.grid/rhythm`, `motion`, `voice`** direct how you use the tokens.
- **`avoid`** names the category clichés that would make this business look like everyone else. Dodge
  every one.

The identity is DIRECTION; the tokens are still the law. You express the archetype **through** the
brand kit's `accent` / `preset` / fonts and the `globals.css` tokens — never a hardcoded hex, never a
CDN font, always both themes. Read `design-craft-layout.md`, `design-craft-typography.md`,
`design-craft-color.md` and `design-craft-motion-detail.md` for how to execute each well; read
`synthesize-visual-identity.md` for what each archetype means.

**When there is no `identity`** (an older business, or a build kicked off without the design step),
fall back to the section grammar below and the house taste — a good template fill, the previous
behaviour. But the identity is the point: it is what stops every generated site looking the same.

## You are designing, not just filling

Compose the template's components as your vocabulary, but the marketing page's layout, spacing,
sections and bespoke elements are **yours to author** in service of the identity. Build the
`signature_motif`. Add sections the identity's plan calls for that the seed does not ship. What you
must not do is reinvent the token system, fight the type scale, or make it louder for the sake of it —
raise the ceiling with craft, not noise.

**And there is a mechanism for it, so this is not just encouragement.** Write the component in
`components/sections/`, register it in `components/sections/index.ts`, and place it in
`marketing.sections` as `{ kind: "custom", id: "<id>" }`. See `build-the-ui.md` for the three steps
and `components/sections/index.ts` for the contract. Until recently the page's closed `switch` made
this impossible and its header comment told you not to try — which is why every site built from this
template came out as the same six sections in a different colour. **The kernel now fails a run whose
only changes are `globals.css` and copy**, so a page that reorders the seeded sections and rewrites
their words is no longer a build that passes; it is a build that comes back to you with the file list
attached.

## THE BUILD ORDER — follow it in this sequence, do not improvise one

Every disappointing build so far started by writing `page.tsx`. Composition, component choice and
copy were decided simultaneously under time pressure, and all three came out at the level of a first
draft. These are separate decisions and they have a correct order, because each one constrains the
next.

**1. Read the brief.** Brand kit → `identity` (archetype, `signature_motif`, `sections`, `avoid`).
   This is direction, not copy. It describes how the site should LOOK. It is not the voice.

**2. Choose the composition.** `node scripts/template.mjs list`, pick by the business, then
   `show <id>`. Do not design a section order from nothing.

**3. Choose the components — BEFORE writing any markup.**
   `node scripts/component.mjs search --tag hero` / `--tag background` / `--tag card` / `tags`.
   **416 components** are vendored offline from Aceternity, Magic UI and Kokonut: parallax heroes,
   animated backgrounds, bento grids, text effects, shaders. `show <src>/<name>` then
   `add <src>/<name>`.

   **`motion` (Framer Motion) is installed.** 131 of the 416 depend on it and it used to be absent
   from package.json, which silently made the entire animated third of the library unusable — the
   most likely reason every site built from this template came out static. `@tabler/icons-react`,
   `@radix-ui/react-icons`, `next-themes` and `lucide-react` are installed too: 93% of the library
   now adds with no npm install at all.

   Note that 165 of the 416 have NO description, so a text search misses them. Browse `--tag` and
   read names; the good ones are often the ones with nothing written about them.

**4. Choose the backdrop and artwork.** `components/backdrops.tsx` and `components/artwork.tsx`.
   The template's `show` output names which ones its composition expects.

**5. NOW write the markup**, composing what you chose in 2–4.

**6. Write the copy last, against the finished layout.** Not from the mood board. See below.

**7. Verify before you finish.** `node scripts/check-styles.mjs / /services /about /contact`, then
   `mycel-build`. Both must pass, and the kernel checks both again.

Doing 5 before 3 is how a page ends up as flat `<div>`s: once markup exists, adding a rich component
means rewriting it, so the agent keeps the divs. Choose the parts first, then assemble.

## Start from a whole-page template, not a blank composition

**Run `node scripts/template.mjs list` before you design anything.**

Five complete compositions are on the shelf — section order, hero shape, services layout, which
backdrop, which artwork — each designed around a different kind of business. `show <id>` prints the
exact block to paste into `content/marketing.ts`.

Composing from nothing is what produced every disappointing build: the default section order every
time, flat sections, and copy that described the mood board because the mood board was the only
reference available. The composition is the part an agent under time pressure does worst and the
part a template solves outright. **What is left to you is the words, the colour and the wiring —
which is the part you do well.**

Pick by the BUSINESS. Each entry names who it suits and, more importantly, who it hurts: a template
chosen against its own guidance drags the copy toward a shape the business does not have, which is
worse than no template at all. `proof-first` on a business with no publishable numbers is the clearest
example — it ends in an empty proof section or an invented one.

You may still deviate. The identity's `sections` plan overrides the template where they disagree,
and a `custom` section is always available. But start from a composition, not a blank list.

## The section order, and why it is that order

The body of `/` is data: `marketing.sections` in `content/marketing.ts`, a list the page renders in
order through a closed `switch`. You reorder, drop, and choose the arrangement of each section by
editing that list. The order that converts a service business, top to bottom:

1. **Hero** (`HeroBlock`) — the promise. One outcome, one subhead, one CTA. Above the fold, nothing else.
2. **Proof** (`figures` and/or `testimonials`) — evidence the promise is real, placed *immediately*
   after it, because a claim followed by proof is trusted and a claim followed by more claims is not.
3. **Offer** (`services`) — what they actually get, concretely.
4. **How it works** (`steps`) — dissolves the "what happens after I click" objection.
5. **A held statement** (`statement`) — one line that reframes; a pause, not a section. Optional.
6. **Closing CTA** (`closing`) — the same ask as the hero, repeated once the case is made.

Repeat the ONE call to action (the hero's and the closing's are both "open the portal"). Do not
invent a second, competing CTA — a page that asks for two things gets neither.

### Pick the arrangement to fit the business, not the default

The template gives each section vetted variants precisely so a generated site does not come out
identical to every other one. Choose deliberately:

- **Hero `heroShape`** — `stack` (default), `split` (headline + a sidebar for the subhead), or `lede`
  (big editorial headline, for a business whose one line IS the pitch). Set it from `site.hero_shape`.
- **`services` layout** — `grid` only when the offerings are genuinely equal and parallel; `rows` for
  any number of services or longer descriptions; `feature` when there is a real headline offering.
  A three-across grid stacked under another three-across grid is the single most template-looking
  thing a page can do — `feature` or `rows` breaks that rhythm. Prefer them.
- **`steps` layout** — `list` when the process is corroboration; `rail` when "how this works" IS the
  sell (true for most founders here).

## Copywriting rules

- **A specific outcome beats an adjective.** "Your books closed by the 5th, every month" beats
  "professional, reliable bookkeeping". Name the result, the number, the deadline.
- **Say what they get, not what you value.** Cut "passionate", "seamless", "cutting-edge",
  "world-class", "we believe". Nobody buys a belief.
- **No jargon, no throat-clearing.** Lead with the sentence, not a run-up to it.
- **One CTA verb, repeated.** Hero and closing say the same thing.
- **The measure matters.** Bodies wrap at a readable width by design; do not fight it with walls of text.

### Honesty is enforced, not suggested

`test/content.test.ts` FAILS the build if you ship fabricated proof. Do not invent testimonials,
named people, companies, or statistics ("98% on time", "12 businesses trust us") — they publish as
the founder's own claims on the founder's own domain, and that is an FTC/CAP violation the founder
answers for. If there is no real number, ship the empty array: `visibleSections` drops a proof
section that has nothing behind it, heading and all, so an honest page still looks finished. A real
testimonial requires a `source`. When in doubt, leave it out — a tight page beats a padded lie.

## The background layer is not optional, and you do not have to draw it

`components/backdrops.tsx` ships six brand-coloured backdrops. Import one; do not hand-write an SVG
and do not settle for a flat section.

| Import | What it is | Reach for it when |
| --- | --- | --- |
| `GridBackdrop` | fine ruled grid | precise work — ops, finance, legal, engineering |
| `DotBackdrop` | dot matrix, quieter | behind a hero whose headline is doing the work |
| `ContourBackdrop` | topographic contour lines | an About or story section that wants warmth |
| `GlowBackdrop` | two blurred accent fields | the single most reliable fix for a flat page |
| `GrainOverlay` | 4% film grain | **above** another backdrop, as the finishing layer |
| `WaveDivider` | a drawn edge between sections | instead of a straight section boundary |

`<Backdrop variant="glow">…</Backdrop>` composes a pattern, the grain and the required
`relative overflow-hidden` parent in one — use it unless you need the pieces apart. Forgetting
`overflow-hidden` yourself gives a mobile horizontal scrollbar from an overhanging blur, which reads
as a layout bug and is a backdrop bug.

Icons are `lucide-react`, already a dependency, ~1500 of them. The first site this builder shipped
used ZERO — it had every one of these available and reached for none, which is why the kernel now
FAILS a build whose home page has fewer than two of {inline `<svg>`, `animate-`, `backdrop-blur`,
a gradient}. Choosing a richer component is the fix; sprinkling classes on the same flat layout is
not.

## Class names that do not exist compile to NOTHING

This project is **Tailwind v4** plus the components in `components/`. There is no hand-written
stylesheet, so an invented class name is not a small mistake — the element renders as naked HTML.

One shipped build was described by the founder as "an HTML form, extremely ugly, like it has no
CSS". It was exactly that:

    <form class="contact-form">  <div class="form-row">  <button class="button button-primary">

Five names, none of them defined anywhere. The same build shipped `about-hero` and `manifesto-mark`
(raw text under an icon nothing had sized) and `bento-feature` (a collapsed CTA). Every other gate
passed: it typechecked, it built, it served 200s.

**Two traps specifically:**

1. **Do not invent semantic class names.** `contact-form`, `card`, `button-primary`, `grid-glow-one`
   are the vocabulary of a project with its own CSS file. Use Tailwind utilities, or import the
   component that already exists — `components/contact.tsx`, `components/ui/*`.
2. **Tailwind v4 renamed things.** `bg-gradient-to-br` is v3 and produces nothing here; v4 spells it
   `bg-linear-to-br`. If you learned a utility from a v3 example, check it.

`node scripts/check-styles.mjs / /services /about /contact` fetches each page and lists every class
with no compiled CSS behind it. The kernel runs it and FAILS the build on any hit. Run it yourself
before you finish.

## Do not delete routes the template shipped

`app/portal/` is the client portal — the product, not a marketing page — and the header links to it
as "Client sign in". One build removed it and shipped a 404 behind that link. Restyle the marketing
pages freely; never drop a seeded route. The kernel checks `/portal` answers.

## Write about the work, not about the brand

The brief you are given describes a VISUAL identity. **It is not the voice.** The first site shipped
led with *"Make the next move feel inevitable."* and listed its services as *"Direction"*,
*"Identity"*, *"Experience"* — three abstractions that tell a visitor nothing about what the business
does for them, because the copy had inherited the mood board.

The register to match is the seed's own: *"The recurring work"*, *"The inbox that never empties"*,
*"The paperwork trail"*. Concrete nouns, the actual job, the outcome the client is buying. The kernel
fails the build on a list of brand-poetry words, `inevitable` among them, but passing that check is
the floor and not the goal.

## The taste checklist (the template holds these — do not break them)

- **One type scale, one rhythm.** Sizes and spacing come from the tokens and the components. Don't
  hand-pick font sizes or margins that fight the scale.
- **One accent, used twice at most.** `--business-accent` (via `variant="accent"` / `bg-accent`, and
  the 2px rule above the headline). An accent on six things is a palette, and a palette is noise.
- **Whitespace is the design.** Generous, consistent negative space reads as premium. Cramming reads
  as amateur.
- **Left-aligned, real hierarchy.** The product — portal, invoice, letterhead — is built on a left
  edge. Centred body text at these measures is where the house style breaks.
- **Elevation, not shadows.** Depth is a surface step (`--card`, `--muted`) plus a hairline
  (`--border`). No `shadow-*`.
- **At most two type families**, and they come from the preset (`--font-heading` / `--font-body`).
  Don't add a third.
- **Both themes.** The site ships a light/dark switcher (`lib/theme.tsx`, header). Check your section
  in BOTH — a surface that vanishes in dark, or an accent that goes muddy, is a bug. Use the tokens,
  never a hardcoded hex, and both modes come for free.

## Never do this

- Walls of text. Centered everything. Emoji as headings or bullets.
- Rainbow / decorative gradients. Drop shadows for "depth". Stock-photo clichés (handshakes,
  skylines, laptop-on-desk).
- A hardcoded colour (`bg-blue-600`, `#3b82f6`) — every founder's clients would see it.
- A second CTA competing with the portal link.
- Fabricated social proof of any kind. (The test will stop you; don't make it.)
- Fetching a web font at runtime (blocks the founder's headline on a CDN).

## Applying the founder's brand kit

The look lives in **one place**: `Project.branding` on the kernel (`GET /v1/projects/:id/brand-kit`,
also `GET /v1/host/:host` → `brand_kit`). Marketing and portal both render from it. Settings → Brand
is the human UI (same knobs as https://ui.shadcn.com/create); you apply it in the seed.

1. Read the brand kit (the tool this run has for kernel reads, or the intake that named it).
2. Note `site.preset` (style, baseColor, theme, font, fontHeading, radius, `code`), `site.hero_shape`,
   `type.heading` / `type.body`, `accent`.
3. Write those into the app:

| Kit field | Where it lands |
|---|---|
| `site.hero_shape` | `content/marketing.ts` → `heroShape` **and** runtime via `kit.site.hero_shape` on `/` |
| `site.preset` | CSS variables emitted by `presetThemeCss` in `app/layout.tsx` — colours (light+dark), radius, fonts |
| `site.preset.code` | Round-trip with `pnpm dlx shadcn@latest init --preset <code>` on rebuilds; do **not** invent a second theme |
| `type.*` | Invoice PDF pairing (sans/serif only); derived from preset fonts when unset |
| `accent` / `letterhead` | Hairline brand rule + PDF letterhead |

Do **not** invent a second theme file. Do **not** run `shadcn init` in a way that clobbers
`--business-accent`. Do **not** fetch web fonts on the portal.

### Preset (closed set — shadcn/create)

Founders configure **style** (nova, vega, maia, lyra, mira, luma, sera, rhea — lyra/sera force square
corners), **baseColor** (neutral, stone, zinc, gray, mauve, olive, mist, taupe), **theme** (base
neutrals plus accent themes), **font** / **fontHeading** (Inter, Geist, Lora, Playfair Display, …),
and **radius**. If the founder names a look in chat, `PUT /v1/projects/:id/branding` with
`{ site: { preset: { style, baseColor, theme, font, fontHeading, radius, code } } }` first, then
mirror `hero_shape` into `marketing.heroShape`. The kit is the source of truth; the file is the seed.
There is no mood enum (atelier / ledger / editorial) — the preset model replaced it.

## What you must not change without evidence

Hero **strings** are the A/B experiment: `middleware.ts` assigns an arm and the kernel counts which
set of words made strangers open the portal. Shape and brand tokens are design; the five hero strings
are the experiment's. **Run `mycel-insight` and read `read-the-evidence.md` before rewriting a
headline, and obey the verdict literally** — including "not enough evidence to change anything",
which is the common answer. Rewriting a headline on taste throws away the only evidence this app
produces.
