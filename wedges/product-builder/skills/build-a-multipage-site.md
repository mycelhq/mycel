---
name: build-a-multipage-site
description: A generated agency/business site is a MULTI-PAGE site, not a one-pager — the pages a real commercial site has, each indexable, in the nav, in the sitemap. Use for every marketing build; it is what makes the site rank and read as a real company.
---

# Build a multi-page site, not a one-pager

A one-page site is a brochure. A real commercial agency site — the bar is our own `landing/`, which
has `/`, `/vs/[slug]`, `/wedges/[slug]`, `/blog/*`, `/changelog/*` — is a set of pages, each one a
door search can index and a buyer can land on. A single `/` is the single biggest reason a generated
site does not rank. Build the pages this business actually warrants, and wire them up for real.

## The pages (build the ones that have real substance — never filler)

Home is always there. Add the others when the business gives you honest content for them:

- **`/` Home** — the pitch, the signature motif, the strongest proof, the primary CTA.
- **`/services` (or `/approach`, `/what-we-do`)** — the offer in depth. What each engagement is, how
  it works, what the client gets. Almost always warranted for a service business.
- **`/work` (or `/case-studies`)** — proof. Build this ONLY if there is real, sourced proof (a named
  client, a real outcome). No fabricated case studies, ever — a made-up client on the founder's own
  domain is a lie they answer for. If there is no real proof yet, DO NOT build a fake `/work`; fold a
  short "how we work" into `/services` instead.
- **`/about`** — the people/positioning/point of view. Who they are and why they can be trusted.
- **`/contact`** — the contact form (`components/contact.tsx`) + support email/phone, on its own
  indexable page as well as the `#contact` section on Home.

Two to four pages beyond Home is the right range for most. More thin pages hurt more than they help —
each page must earn its place with real content, not padding.

## Wire every page up — or it is worse than not having it

1. **Nav goes to real pages.** Every header/nav item links to a page you actually built (`/services`,
   `/work`, `/about`, `/contact`) or an in-page anchor to a section that exists. NO dead links — see
   the nav rule in `build-the-ui.md`. The nav is the same on every page (shared `MarketingHeader`).
2. **Each page has its own `generateMetadata`** — a unique `title` and `description`, `openGraph`,
   and a canonical. Two pages with the same title is a wasted page to a search engine. Reuse the
   `generateMetadata` pattern already in `app/layout.tsx`.
3. **Add every page to `app/sitemap.ts`.** The seed sitemap lists `/` and `/portal`; extend it with
   each real route you build, honest to what exists — never a route you did not create.
4. **One design system across all pages.** Same brand, same tokens, same signature motif, same
   `MarketingHeader`/`MarketingFooter`. A visitor moving between pages must never feel they left the
   site. Each page is DESIGNED (per `build-the-ui.md` and the identity), not a text dump.
5. **Internal links.** Pages link to each other where it helps a reader (Home → Services, Services →
   Contact). Internal linking is both UX and SEO.

## The `/portal` is NOT a marketing page — leave its behaviour alone

`/portal` is the real client portal (it reads the kernel and authenticates by magic link). You style
its ENTRY screen as a brand continuation (`portal-as-continuation.md`), but you do not turn it into a
marketing page, do not add it to the marketing nav as a peer of `/services`, and do not put it in the
sitemap as indexable content — it is already handled. It is the "Client sign in" affordance in the
header, and nothing else changes about how it works.

## Check it

`npx tsc --noEmit`, boot `next dev`, and load EVERY page you built — each must answer 200 and render
designed, in both themes, with working nav. A page that 404s or throws is worse than one you never
built. Then confirm `sitemap.xml` lists exactly the routes that exist.
