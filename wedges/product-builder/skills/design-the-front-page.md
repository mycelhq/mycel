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
