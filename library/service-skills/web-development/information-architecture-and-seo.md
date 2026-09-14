---
name: information-architecture-and-seo
description: Plan a multi-page website's page structure, URL hierarchy, internal linking, and on-page/technical SEO so pages get found, ranked, and navigated without dead ends.
---

# Information Architecture & Technical SEO

You are structuring a client's website before a line of layout is built. Get this wrong and every downstream page inherits the mistake. Do the IA first, the SEO second, and never invert that order.

## Start from intent, not the org chart

Do not mirror the client's internal departments. Map the *jobs* a visitor arrives to do. For a typical service business there are four intent clusters: (1) evaluate ("can they do my thing?") → services/solutions pages; (2) trust ("are they real/good?") → case studies, about, testimonials; (3) convert ("how do I start?") → contact, pricing, booking; (4) learn ("answer my question") → blog/resources. Build a spreadsheet: one row per intended page, columns for primary intent, target query, the single conversion action, and the parent page. If a page has no distinct intent or no query, it should not be a page — fold it into a section.

## URL and hierarchy rules

Keep depth ≤ 3 clicks from home to any commercial page. URLs are lowercase, hyphenated, no stop words, no dates on evergreen pages, no `.html`, no query-string routing for real content. Directory structure should read as a breadcrumb: `/services/brand-identity/`, not `/service?id=7`. One canonical URL per page — pick trailing-slash convention and enforce it with 301s. Never let both `/about` and `/about/` resolve 200. Reserve `/blog/{slug}` flat (no date, no category in path) so posts can be re-categorized without breaking links.

## Internal linking is the actual ranking lever

Search engines distribute authority through links. Money pages (the service/pricing pages that convert) must receive the most internal links. Practical rules: every blog post links to at least one relevant service page with descriptive anchor text (not "click here"); the primary nav exposes the money pages within one click; add a contextual "related services" block, not just a footer dump. Build a hub-and-spoke: a pillar page (e.g. "Brand Identity Design") links down to specific sub-topic posts, and each post links back up to the pillar. Orphan pages (zero internal inbound links) are invisible — audit for them before launch.

## On-page SEO per page — the checklist

For each page produce: one `<title>` (50–60 chars, primary keyword front-loaded, brand suffix); one `<meta description>` (140–160 chars, benefit + implicit CTA — it's ad copy, not a summary); exactly one `<h1>` matching search intent; a logical `h2/h3` outline that a person could skim. Target one primary query per page and 2–4 semantic variants — never two pages targeting the same query (that's keyword cannibalization; merge them). Write for the person; the keyword is a constraint, not the goal. Add `alt` text that describes the image for a blind user, not a keyword-stuffed string.

## Technical SEO the agent must ship

- `robots.txt` allowing crawl, pointing to the sitemap. Never ship the staging `Disallow: /` to production — this is the single most common launch-killing bug.
- `sitemap.xml` auto-generated, only canonical 200 URLs, submitted in Search Console.
- `rel="canonical"` self-referencing on every page; cross-referencing where duplication is unavoidable.
- Structured data (JSON-LD schema.org): `Organization` + `LocalBusiness` sitewide, `Service`/`BreadcrumbList` on service pages, `Article` on posts, `FAQPage` where you have real FAQs. Validate in Google's Rich Results Test.
- Open Graph + Twitter Card tags with a real 1200×630 image, or shared links look broken.
- HTTPS everywhere, HSTS, no mixed content. Redirect chains collapsed to a single 301.

## Migration safety (redesigns)

If replacing an existing site, you must preserve equity. Crawl the old site (Screaming Frog), export every indexed URL, and map each to its new destination with a 301 — never let old URLs 404. Diff old vs new URL sets; every removed URL needs a redirect target or an explicit decision to let it die. Keep the redirect map in the repo.

## Quality bar

Acceptable: sane hierarchy, unique titles, sitemap present. **Great**: every page traces to a named intent and query, money pages are the most-linked internal nodes, zero orphans, breadcrumb-legible URLs, validated structured data, and a documented redirect map. Common failure modes to reject: nav mirroring the org chart, two pages fighting for one keyword, meta descriptions that restate the title, staging robots.txt shipped live, and blog posts that never link to anything commercial. Deliver the IA as a sitemap diagram plus the intent/query spreadsheet before building — it's the contract the rest of the site is measured against.
