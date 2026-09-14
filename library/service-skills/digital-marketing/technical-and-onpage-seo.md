---
name: technical-and-onpage-seo
description: Diagnose and fix the crawl, index, structured-data, and on-page issues that gate a client site's organic visibility before any content or link work matters.
---

# Technical and On-Page SEO

You are auditing and fixing a client's site so search engines can crawl, render, index, and rank it. Technical debt caps everything else — never start content or link building until the foundation passes.

## Order of operations (fix top-down; lower items are wasted if higher ones fail)

1. **Indexability.** Pull `robots.txt` and confirm no blanket `Disallow: /` and no accidental blocking of `/wp-admin` assets, JS, or CSS. Check every important template for `<meta name="robots" content="noindex">` and `X-Robots-Tag` headers. In Google Search Console (GSC) → Pages report, read the "Why pages aren't indexed" buckets: "Crawled – currently not indexed" (thin/duplicate), "Discovered – not indexed" (crawl budget / low value), "Excluded by noindex," "Alternate page with proper canonical," "Blocked by robots.txt."
2. **Canonicalization.** Every URL must self-canonical unless intentionally consolidating. Hunt for canonical chains, canonicals pointing to redirects, cross-domain canonicals to staging, and pagination/parameter duplication (`?sort=`, `?utm=`). Consolidate www vs non-www and http vs https to one host with 301s.
3. **Sitemaps.** XML sitemap contains only 200-status, self-canonical, indexable URLs — no redirects, no noindex, no 404s. Submit in GSC and reconcile "submitted vs indexed."
4. **Site architecture / crawl depth.** Every money page reachable within 3 clicks of the home page. Flag orphan pages (in sitemap, zero internal links). Flatten deep taxonomies.
5. **Rendering.** Test with URL Inspection → "Test live URL" → view rendered HTML and screenshot. If content only appears after client JS and Google's render is blank, you have a JS-SEO problem — recommend SSR/SSG or dynamic rendering.
6. **Core Web Vitals & speed.** Pull field data (CrUX) from GSC, not just lab. Targets: LCP < 2.5s, INP < 200ms, CLS < 0.1 at p75. Common fixes: compress/serve WebP/AVIF, `width`/`height` on images (kills CLS), preload the LCP image, defer non-critical JS, eliminate render-blocking CSS, `font-display: swap`.

## On-page, per target page

- **One primary intent per URL.** Classify intent (informational / commercial / transactional / navigational) from the current SERP — mirror the format Google already rewards (listicle, comparison, tool, product).
- **Title tag:** primary keyword near the front, under ~60 chars / 580px, unique across the site, compelling not stuffed.
- **H1:** one per page, matches search intent, not identical to the title.
- **Heading hierarchy:** logical H2/H3 nesting that maps to subtopics a user (and the "People Also Ask" box) expects.
- **Content depth:** cover the entities and questions competitors cover — but earn the words; kill filler. Match or beat the median top-10 depth, don't pad to a word count.
- **Internal links:** add 2–5 contextual links from relevant existing pages using descriptive anchor text (not "click here"), pointing to the target.
- **Structured data:** add JSON-LD for the page type — `Article`, `Product` + `Offer` + `AggregateRating`, `FAQPage`, `BreadcrumbList`, `Organization`, `LocalBusiness`. Validate in the Rich Results Test. Never mark up content not visible on the page (manual-action risk).
- **Images:** descriptive alt text, lazy-load below the fold, keep the LCP image eager.

## Deliverable quality bar

Ship a prioritized audit, not a raw crawler dump. Group findings by **impact × effort**. Each item states: the problem, the affected URLs (or a count + example), the business consequence ("these 40 product pages are noindexed → zero organic revenue"), and the exact fix. A senior deliverable leads with the 3–5 issues that move revenue and relegates cosmetic nits to an appendix.

## Tools

Screaming Frog or Sitebulp for crawling, GSC (source of truth for how Google actually sees the site), Ahrefs/Semrush Site Audit for scale, PageSpeed Insights + CrUX for CWV, the Rich Results Test and Schema.org for structured data.

## Failure modes to avoid

- Chasing a lighthouse score of 100 while the site is noindexed — always check indexability first.
- Recommending "add more keywords" — modern ranking is about intent match and entity coverage, not density.
- Marking up fake reviews or FAQ content that isn't on the page — triggers manual actions.
- Blanket-canonicalizing paginated series to page 1 (orphans deep products); use self-canonicals.
- Treating lab CWV as truth; Google ranks on field (CrUX) data.
- Deploying 302s where 301s are meant (302 doesn't pass consolidation the same way / signals temporary).

**Great** looks like: a crawlable, fully-indexed site where every money page self-canonicals, renders server-side, loads under CWV thresholds, carries valid schema, and sits ≤3 clicks deep — delivered as a ranked, revenue-framed action list the client's dev can execute without a follow-up call.
