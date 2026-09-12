---
name: ship-seo-and-polish
description: The modern-landing polish that separates a real Next.js site from a template — keep the scaffolded app/robots.ts, app/sitemap.ts, app/opengraph-image.tsx, JSON-LD and generateMetadata working and customized to THIS business, keep the sitemap honest to routes that exist, use semantic HTML / headings / alt text / accessible landmarks, add tasteful real imagery, and never fabricate SEO content. Use when finishing a tenant marketing build, wiring metadata / Open Graph / structured data, or reviewing whether a generated site ships like a real product.
---

# What separates a real modern landing page from a template

A bespoke design (see `design-the-front-page.md`, `build-the-ui.md`) is half of it. The other half is
the machinery a real Next.js site ships so it exists to a crawler, previews well when shared, and
reads as a real product to a browser and a screen reader. A site missing this looks generated the
moment someone pastes the link into Slack.

Another agent scaffolds the files below into the app. **Your job is to keep them working and make them
true to THIS business — not to leave stubs, and not to invent facts.**

## Keep these working, customized to this business

- **`app/generateMetadata` / metadata** — real `title`, `description`, `openGraph`, `twitter`,
  `metadataBase`, canonical, from the tenant's brand kit (`display_name`, the real offer, the real
  domain). Not "Next.js App". The description says what the business does, in the identity's voice —
  the same honesty rules as the front-page copy (a specific outcome, no adjectives-as-substance).
- **`app/opengraph-image.tsx`** — customize it to the brand: the wordmark in `--font-heading`, the
  `--business-accent`, the real name and one-line promise, the `signature_motif` if it travels. This
  is the preview a prospect sees before they click; it must look like the front page, not a default
  card. Tokens/brand only — no hardcoded hex that ignores the tenant.
- **`app/sitemap.ts`** — **keep it honest to the routes that actually exist.** List `/` and any real
  public pages; do NOT list `/portal` (it's behind a login) or routes you didn't build. `landing/app/sitemap.ts`
  is the reference pattern (enumerate from real data, never hand-maintain a stale list).
- **`app/robots.ts`** — allow the public site, point at the real `sitemap.xml`. Don't disallow the
  pages you want found; don't expose anything private.
- **JSON-LD structured data** — `Organization` + `WebSite` for the business, keyed to the real domain
  and name. Add `LocalBusiness` ONLY if the business genuinely has a physical address; otherwise omit
  it — inventing an address for schema theatre is worse than none (see `landing/components/json-ld.tsx`,
  which deliberately skips `LocalBusiness`). `JSON.stringify` into a `<script type="application/ld+json">`.

## Real-product hygiene

- **Semantic HTML and landmarks.** One `<h1>`, a sane heading order (don't skip levels for size —
  size is the type scale's job), real `<header>` / `<main>` / `<footer>` / `<nav>`, `<section>`s with
  accessible names. Screen-reader landmarks are free and they are the tell of a real site.
- **Alt text on every image**, describing the image, not stuffed with keywords. Decorative imagery
  gets `alt=""`.
- **Tasteful, real imagery where it helps** — and only where it's honest and earns its place. No
  stock clichés (handshakes, skylines, laptop-on-desk — see the front-page never-do list). Optimize
  via `next/image`. A page with no honest image is better than one padded with a fake one; the
  `StatementBlock` pause exists precisely so an image-less page still breathes.
- **Accessible interactives** — the theme toggle, links and the portal CTA reachable by keyboard,
  visible focus, sufficient contrast (the tokens handle contrast in both themes if you stay on them).

## Never fabricate SEO content

The honesty rule from `design-the-front-page.md` extends to everything here: no invented review
counts, no fake ratings/aggregateRating, no keyword-stuffed hidden text, no made-up locations,
awards, or client logos. `test/content.test.ts` guards the visible proof; you are the guard for the
metadata and structured data, which are claims too — published on the founder's own domain, under the
founder's name. If a fact isn't real, leave the field out.

## The hard rails still hold

Tokens only (no hardcoded hex), `--business-accent` for brand, both themes via tokens (no `dark:`),
no CDN fonts. `npx tsc --noEmit`, then boot `next dev` and confirm the OG image renders, the sitemap
lists only real routes, and the metadata reads as this business — per the check in `build-the-ui.md`.

## Done when

Pasting the URL into a chat shows a branded preview that looks like the front page; a crawler gets a
truthful sitemap, robots, and structured data keyed to the real business; the page is semantic and
navigable by keyboard and screen reader; and nothing in the metadata or schema is invented.
