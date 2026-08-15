---
name: launch-qa-checklist
description: Run the pre-launch and go-live QA gauntlet for a client website — cross-browser, responsive, forms, analytics, SEO, security, accessibility — so the site ships without embarrassing or costly defects.
---

# Website Launch QA & Go-Live

The launch is where reputations are made or lost. A broken contact form or a `noindex` shipped to production undoes months of work silently. Run this as a gated checklist — nothing goes live with an open critical item.

## Functional QA

- **Every link**: crawl the built site (Screaming Frog / linkinator) — zero internal 404s, zero broken external links, no redirect chains. Check nav, footer, in-body, and buttons.
- **Every form**: submit each one end-to-end. Verify (1) the submission actually arrives at its destination (inbox, CRM, webhook — check the real endpoint, not just a success toast), (2) validation catches bad input with clear inline errors, (3) required fields enforced, (4) the success and error states both render, (5) spam protection (honeypot/reCAPTCHA) is active, (6) the confirmation email/autoresponder fires. A form that shows "thanks" but silently drops the lead is the worst launch bug — test the delivery.
- **Interactive components**: modals, accordions, tabs, carousels, filters, search — click through each. Test on touch, not just mouse.
- **Third-party embeds**: maps, video, booking widgets, chat — load and function on production domain (some break on domain/CSP change).

## Cross-browser & responsive

Test the latest Chrome, Safari, Firefox, and Edge, plus **real iOS Safari and Android Chrome** (emulators miss Safari quirks). Check breakpoints at 320 / 375 / 768 / 1024 / 1440. Look for: horizontal scroll, overlapping text, cut-off content, broken layouts, tap targets too small, sticky headers covering content, and hover-only interactions that are dead on touch.

## SEO & analytics go-live gates

- **Remove `noindex`**: confirm no `<meta robots noindex>` and no `Disallow: /` in `robots.txt`. This is the #1 catastrophic launch bug — a staging block shipped live de-indexes the whole site. Verify in production, not staging.
- `sitemap.xml` present, valid, submitted to Google Search Console; Search Console and Bing Webmaster verified.
- Unique title + meta description on every page; canonical tags correct for the production domain.
- OG/Twitter tags render correctly — test with a real share-preview validator.
- Analytics (GA4 / Plausible) firing on production, goals/conversions configured and test-fired. Consent banner present where required (GDPR/CCPA) and actually gating non-essential tags.
- 301 redirect map from old URLs live and verified (for redesigns).

## Performance & accessibility gates

- Lighthouse mobile ≥ targets (see performance skill): LCP < 2.5s, CLS < 0.1, INP good.
- Images optimized/compressed; no multi-MB PNGs shipped.
- Keyboard-only pass: tab through the whole site, everything reachable and operable, visible focus, modals trap and release focus.
- Automated a11y scan (axe / Lighthouse a11y) with no critical violations; contrast AA verified; all images have alt text.

## Security & infrastructure

- HTTPS enforced sitewide; HTTP → HTTPS 301; valid, non-expiring-soon TLS cert; no mixed-content warnings.
- Security headers: HSTS, `X-Content-Type-Options: nosniff`, a sane `Content-Security-Policy`, `Referrer-Policy`.
- No secrets/API keys in client-side source or committed env files. No exposed `.env`, `.git`, admin panels, or staging URLs.
- Custom 404 and 500 pages that match the brand and offer a way back.
- DNS: correct A/CNAME records, `www` and apex both resolve to one canonical (301 the other), email records (SPF/DKIM/DMARC) intact if the domain sends mail.
- Automated backups and rollback path confirmed before flipping DNS.
- Favicon and app icons (all sizes) present.

## Go-live sequence

1. Freeze content, take a full backup of the current live site.
2. Deploy to production behind the same domain in a testable way (or low DNS TTL cutover).
3. Re-run the SEO gates *on the production URL* — especially the noindex/robots check.
4. Smoke-test the top 5 journeys (home → service → contact form submit) live.
5. Submit sitemap, confirm analytics firing.
6. Monitor for 24–48h (canary): error logs, form submissions arriving, Search Console coverage, CWV field data.

## Quality bar

Acceptable: it loads and the homepage looks right. **Great**: every checklist item signed off, forms verified delivering to the real destination, production confirmed indexable, redirects live, analytics firing, a11y and perf gates green, and a monitored 48h post-launch window. Reject any launch with: an unverified form, a possible lingering `noindex`, broken mobile Safari, or missing redirects. "It worked on staging" is not a launch criterion — production is.
