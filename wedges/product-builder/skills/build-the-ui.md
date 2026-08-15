---
description: shadcn/ui and Tailwind v4 as this app is actually set up — what each colour token means here, how to add a component without hanging or clobbering the theme, and the name collision that will bite you.
---

# Building the UI

shadcn/ui (`style: new-york`, `baseColor: neutral`), Tailwind v4, `lucide-react` for icons. Nothing
else, and no CSS file other than `app/globals.css`.

## Adding a component

```bash
cd ~/app && npx shadcn@latest add card badge table dialog input --yes
```

`--yes` matters: `add` defaults to prompting for confirmation, and an interactive prompt in this
sandbox is a hung turn. `components.json` and `lib/utils.ts` (`cn`) are already in the tree, which
is the entire prerequisite — `add` needs `components.json` to exist, and it does.

**Never run `npx shadcn init`.** It rewrites `app/globals.css` from its own template, deleting
`--business-accent` and the dark-mode block, and silently un-brands every founder's portal. Every
token `init` would write is already in `globals.css`, by hand.

**`components/shell.tsx` already exports `Card`.** `add card` writes a *different* `Card` (plus
`CardHeader`/`CardTitle`/`CardDescription`/`CardContent`/`CardFooter`/`CardAction`) into
`components/ui/card.tsx`. They are not interchangeable — the shell one is a bare bordered box the
portal pages compose with `divide-y`. Import them under distinct names or you will silently restyle
`/portal`.

`components/ui/button.tsx` is the worked example: `cva` variants, `asChild` via Radix `Slot`,
`data-slot`, `cn` last so a caller's `className` wins. Match it. Offline, extend that pattern by
hand rather than inventing a second one.

## The tokens, and what they actually mean here

`app/globals.css` declares shadcn's names via `@theme inline`, so the utilities are real. Two are
easy to get backwards:

- `--muted` is a **surface** (`bg-muted`, a pale grey panel). `--muted-foreground` is the **text**
  colour for captions, timestamps and secondary lines. This template's predecessor had `--muted`
  meaning text; that collision was fixed precisely so pasted shadcn code works. Do not re-break it.
- `--card` is a surface too, one step off `--background`; `--surface` is a legacy alias for it that
  older files still use. Write `--card` in new code.

Available: `background/foreground`, `card/card-foreground`, `popover/popover-foreground`,
`primary/primary-foreground`, `secondary/secondary-foreground`, `muted/muted-foreground`,
`destructive/destructive-foreground`, `border`, `input`, `ring`, and `rounded-sm|md|lg|xl` off
`--radius: 0.625rem`.

And the one that is not shadcn's and matters most:

- **`accent`** — `--color-accent` resolves to `--business-accent`, set per request in
  `app/layout.tsx` from the tenant's branding. `bg-accent`, `text-accent`, or
  `<Button variant="accent">`. Anything that should look like *their* product uses it. Note
  `--accent-foreground` is a fixed white and is not redeclared in dark mode, so accent surfaces
  need light text.

A hardcoded `bg-blue-600` or `#3b82f6` is a colour every founder's clients see.

## Build ON the token system — but DESIGN the marketing page

Two different jobs, and the rule is different for each:

- **`/portal` and app surfaces: match what is there, don't reinvent.** These are working screens a
  client opens to get something done. Compose the existing components, keep the house calm, add
  nothing decorative. The rules below are law here.
- **The marketing page: design it, to the approved identity.** This is the founder's front door and
  it must feel bespoke, not templated. Read the brand kit's `identity` and obey it (see
  `design-the-front-page.md`) — build its `signature_motif`, author the sections its plan calls for,
  express its archetype. You have real design latitude on layout, composition and bespoke elements.
  What you may NOT do — on either surface — is break the token system below.

The vocabulary and the discipline, on both surfaces:

- **The seeded sections are a STARTING VOCABULARY and a fallback — NOT the required structure.**
  `components/marketing.tsx` (`Section`, `Eyebrow`, `PortalCta`, `Figures`, `Services`, `Steps`,
  `StatementBlock`, `Testimonials`, `MarketingHeader/Footer`) ships so a build is never blank and so
  there is a house reference for how a section is built to token. It is a floor, not a spec. On the
  marketing page you SHOULD author new, bespoke React components and section layouts per business —
  the identity's `signature_motif` and its `sections` plan should produce structure this template does
  not ship. Reuse a seeded component when it genuinely fits the identity; build from scratch the moment
  it does not. `Section`/`Eyebrow`/`PortalCta` composition, but a `Services` grid, a `Steps` rail and
  three quote cards, is exactly the template the founder is complaining about.

- **THE FAILURE MODE, NAMED: "the same five sections with new text."** If two different businesses —
  a bookkeeper and a brand studio — come out with the same page skeleton (hero → figures → services →
  steps → statement → closing, same shapes, only CSS and copy swapped), you have failed the one job
  of this rewrite, no matter how good the copy is. The section ORDER and the section SHAPES must
  follow the identity, and two different identities must not produce the same skeleton. Author
  components the seed doesn't have: a distinctive index/contents device, an oversized wordmark band, a
  metadata rail, a specimen block, a duotone image treatment, a bespoke proof layout — whatever the
  `archetype` and `signature_motif` call for. Build the motif as a real system, everywhere it belongs.

- **Build to the quality bar in `landing/`.** Our own marketing site (`landing/app/page.tsx`,
  `landing/components/`) is what "bespoke and modern" looks like in this repo: real components with
  real composition (`hero.tsx`, `screens.tsx`, `capacity.tsx`, `desk.tsx`, `pricing.tsx`), a section
  order that is an argument, custom devices (the ASCII field, the dither panels, the framed screens) —
  not slots filled with strings. You are building a tenant's front door to THAT level: real
  components, real composition, authored for this business. Read `design-craft-layout.md`,
  `design-craft-typography.md`, `design-craft-color.md`, `design-craft-motion-detail.md` for how, and
  `synthesize-visual-identity.md` for what each archetype means.
- **Only the tokens for colour. Always. No exceptions.** Never a hex, never a raw Tailwind palette
  class. `bg-card`, `text-muted-foreground`, `border-border`, `bg-accent` — these are the whole
  palette, and they are why a page works in both themes. Design latitude is layout and composition,
  never a second colour system. See `design-craft-color.md`.
- **Craft, not noise.** The four `design-craft-*.md` skills (layout, typography, color,
  motion-detail) are how you make it premium: the spacing scale, the type scale, one-accent
  discipline, elevation as surface + hairline, restrained motion behind `prefers-reduced-motion`. A
  louder page is not a better one; a more crafted one is.

### The hard rails do NOT change when you innovate

Authoring bespoke components buys you layout and composition, nothing else. These stay law on every
surface, seeded component or from-scratch:

- **Tailwind v4 + shadcn tokens only. NO hardcoded hex, NO raw palette classes** (`bg-blue-600`,
  `#3b82f6`). `--business-accent` (via `variant="accent"` / `bg-accent` / `text-accent`) is the ONE
  brand colour, used sparingly.
- **Both light and dark via tokens. NEVER `dark:` prefixes** — the variables re-declare per theme.
  Check every new component in both modes before you call it done.
- **No CDN / runtime web fonts.** Fonts come from the preset (`--font-heading` / `--font-body`).
- **No fabricated proof.** `test/content.test.ts` fails the build on invented testimonials, names or
  numbers. Real proof needs a `source`; otherwise ship the empty array.
- **`/portal` stays calm.** All this innovation licence is for the marketing page. The portal is a
  working screen — compose, don't decorate (and see `portal-as-continuation.md` for the entry screen).
- **The five hero A/B STRINGS in `content/marketing.ts` stay the experiment's.** Redesign the page
  freely; do not rewrite the winning headline on taste — see the section below and `read-the-evidence.md`.

## Dark mode and the theme switcher

The app ships a light/dark switcher: `lib/theme.tsx` (a tiny client `ThemeToggle` + a pre-paint
`THEME_INIT` script) toggles a `light`/`dark` class on `<html>`, and `lib/theme-css.ts`
(`presetThemeCss`, emitted as a `<style>` in `app/layout.tsx`) declares BOTH token sets scoped under
`html[data-brand]`, `.light`, `.dark`, and a `prefers-color-scheme` fallback. So:

- **Never write `dark:` prefixes.** The variables re-declare per theme; a `dark:` class double-applies.
- **Never set a colour that isn't a token.** Anything token-based themes itself in both modes for free.
- **Check every new screen in both themes** before you call it done — a panel that disappears in dark
  or an accent that goes muddy is the tell of a colour that skipped the tokens.

Existing pages frequently write `style={{ color: "var(--muted-foreground)" }}` rather than
`text-muted-foreground`. Both resolve to the same value. The utility is preferred in new code;
don't churn the old files to match.

## Before you finish: the theme + nav self-check (RUN THIS, then fix what it finds)

Two failures ship over and over on generated sites, and both are visible the moment a founder looks:
the theme toggle does nothing on half the page, and the header links go nowhere. Neither is a matter
of taste — they are broken. Before you call the build done, run these and FIX every hit:

```bash
# 1. HARDCODED COLOUR — the theme-toggle killer. A literal hex or a raw palette class does not
#    re-declare per theme, so dark mode leaves it stranded. globals.css and opengraph-image are the
#    only places a literal colour is allowed.
grep -rnE '#[0-9a-fA-F]{6}|background:\s*#|(bg|text|border)-(red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone)-[0-9]' app components --include='*.tsx' | grep -viE 'opengraph-image|globals\.css|theme-css|theme\.tsx'
#    → every line printed is a bug. Replace with a token: bg-background, bg-card, bg-muted, bg-accent,
#      text-foreground, text-muted-foreground, border-border. Then re-run until it prints nothing.

# 2. DEAD NAV — a header/nav link that points nowhere ("#", "", no href) is a button that lies.
grep -rnE 'href=("#"|"")|<a[^>]*>[^<]+</a>' app components --include='*.tsx'
```

**The nav rule:** every header/nav item must GO somewhere real — an in-page anchor to a section you
actually rendered (`href="#work"` + `<section id="work">`), the portal (`/portal`), or the contact
section. If a label has no destination, it is not a nav item — cut it. A row of dead words in the
header is worse than a header with one working link. Check the toggle in BOTH modes and click every
nav item before you finish.

## Conventions

- Server Components by default; `"use client"` only for real browser state.
- Forms: `useActionState` + a Server Action — `app/portal/[thread]/reply.tsx` is the reference, and
  it also shows when to break the rule (a Server Action body is capped at 1MB, so uploads go to a
  Route Handler instead).
- Dates: `relative(iso)` from `@/lib/format`, computed server-side so there is no hydration
  mismatch.
- Restraint. This is a page a client opens four times a year: legibility beats personality. No
  gradients, no decorative motion, no marketing voice inside `/portal`. The existing pages set the
  level — a 2px accent rule the width of a word is the loudest thing in the app.

## The marketing page: design is yours, the hero STRINGS are the experiment's

`app/page.tsx` is the one screen whose effect is measured. It renders one of two heroes, the kernel
counts which one made strangers ask for the portal, and it decides which one won. Two things follow,
and they do not conflict:

- **The design is yours** — layout, composition, sections, the identity's `signature_motif`, spacing,
  the archetype. Design it well, to the approved identity. This is the whole point of the rewrite.
- **The five hero STRINGS in `content/marketing.ts` are the A/B experiment's, not taste's.** On an
  EXISTING site with traffic, **run `mycel-insight` and read `skills/read-the-evidence.md` before you
  rewrite a headline, and obey the verdict literally** — including "not enough evidence to change
  anything", the common answer. On a FIRST build there is no evidence yet, so write two genuinely
  different hero arms in the identity's voice and let the experiment decide. Redesigning the page and
  rewriting the winning headline on a whim are different acts: the first is your job, the second
  throws away the only evidence this app produces.

## Check it

`npx tsc --noEmit`, then boot `next dev` and load the page. That is what the kernel checks too —
see `skills/extend-the-business-app.md`. Run it per screen, not once at the end.
