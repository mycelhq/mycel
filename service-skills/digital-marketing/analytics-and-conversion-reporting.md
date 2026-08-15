---
name: analytics-and-conversion-reporting
description: Stand up trustworthy GA4/attribution tracking and turn it into a decision-grade marketing report that ties spend and channels to revenue, not vanity metrics.
---

# Analytics and Conversion Reporting

You own measurement for a client: making the data trustworthy, then turning it into decisions. A beautiful report on broken data is worse than no report — it drives confident wrong moves.

## Step 1 — Audit the measurement foundation (trust before insight)

- **Tag governance:** confirm GA4 + Google Tag (and any pixels) load once, via a managed container (GTM) where possible. Check for duplicate tags inflating sessions/conversions.
- **Data quality red flags:** self-referrals, (not set) traffic, bot traffic, internal traffic not filtered, dev/staging hits polluting prod. Set up an internal-traffic filter and exclude known referrers.
- **UTM discipline:** every paid/email/social link must carry consistent `utm_source/medium/campaign` with an enforced naming convention (lowercase, no spaces). Inconsistent casing splits one channel into five rows. Build a UTM builder/spec and make the client use it.
- **Conversion events:** define the events that matter (purchase, qualified lead, signup, key micro-conversions) with values. Mark them as Key Events in GA4. Verify they fire once and match the source-of-truth (CRM/Stripe) within tolerance.

## Step 2 — Reconcile against source of truth

GA4 will never exactly match Stripe/Shopify/CRM (consent mode, ad blockers, attribution windows, modeled data). Establish the *acceptable variance* (often 5–15%) and a reconciliation habit: monthly, compare GA4 Key Events to actual closed revenue. If variance widens, something broke — investigate before reporting. Treat the CRM/billing system as truth for revenue; GA4 as truth for behavior and channel attribution.

## Step 3 — Understand attribution honestly

- GA4 default is data-driven attribution across the Google-observed path; it undercredits view-through and non-Google touches and misses offline. Know the model before you quote "GA4 says Facebook drove X."
- For multi-touch clients, look at Paths and Conversion Paths (assisted conversions) — last-click alone will underfund top-of-funnel channels that seed demand.
- For anything with a long or offline sales cycle, push offline conversions back (GA4 Measurement Protocol / Google Ads offline import / CAPI) so the platforms optimize on real closed revenue, not form-fills.

## Step 4 — Build the report that drives decisions

Structure every client report as:
1. **Headline outcome vs goal:** revenue, leads, CAC/CPA, ROAS, pipeline — against the target and the prior period. One glance answers "are we winning?"
2. **Channel breakdown:** each channel's spend, conversions, CPA/ROAS, and trend. Rank by efficiency and by scale.
3. **Funnel view:** sessions → engaged → key event → revenue, with conversion rates at each step, so a drop-off is diagnosable (traffic problem vs conversion problem).
4. **What changed & why:** the 2–3 things that moved the numbers.
5. **Recommendations:** the single most important action for next period, with the expected impact. A report without a "so what" is a data dump.

Use segments and comparisons, not raw totals — "leads up 12%" is meaningless without the period, the channel mix, and the goal. Prefer explorations/Looker Studio dashboards the client can self-serve, but always ship a written narrative; clients don't read dashboards, they read the story.

## Quality bar

- Every number is reconciled to a trusted source or explicitly labeled "modeled/directional."
- Metrics tie to money and the client's stated goal; no report leads with sessions or bounce rate as a headline.
- Trends and comparisons, never naked absolutes.
- Each report ends with a prioritized, quantified recommendation.
- Consistent definitions across periods (don't silently redefine "conversion" month to month).

## Failure modes

- Reporting on broken/duplicated tracking and calling movement "growth."
- Quoting GA4 revenue as gospel and alarming the client when it "doesn't match Stripe" — it never will exactly.
- Vanity metrics (impressions, likes, bounce rate) as headlines.
- Last-click attribution silently defunding brand/top-funnel.
- Inconsistent UTMs fragmenting channels.
- Dashboards with no narrative or recommendation — the client can't act on a pivot table.

**Great** looks like: filtered, deduped, UTM-disciplined data reconciled monthly to billing; attribution understood and offline conversions fed back; and a crisp report that ends with the one move that will most improve next month's revenue.
