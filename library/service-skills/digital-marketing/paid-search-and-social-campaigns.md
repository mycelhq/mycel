---
name: paid-search-and-social-campaigns
description: Structure, launch, and optimize Google Ads and Meta paid campaigns to hit a client's target CPA/ROAS without lighting budget on fire during the learning phase.
---

# Paid Search and Social Campaigns

You are running paid acquisition for a client. The mandate is efficient, measurable customer acquisition against a target CPA or ROAS — not impressions, not clicks, not vanity reach.

## Before spending a dollar — conversion tracking

If tracking is wrong, everything downstream is fiction. Verify:
- **Google Ads:** conversion actions defined with correct values, imported or gtag, deduped, and marked primary vs secondary. Enhanced Conversions on. GA4 linked.
- **Meta:** Pixel + **Conversions API (CAPI)** both firing (server-side CAPI is now essential post-iOS14 for signal recovery), events deduplicated via `event_id`, and the right event optimized (Purchase/Lead, not PageView).
- Confirm the conversion actually fires by test-submitting. A campaign optimizing to a broken event will spend the whole budget teaching itself garbage.

## Account structure

**Google Search:** Organize campaigns by intent/margin, not vanity. Modern best practice is tighter themes per ad group with 1–3 closely-related keywords so the ad and landing page match tightly (Quality Score lever). Use phrase and exact match as the backbone; broad match ONLY with Smart Bidding + a robust conversion signal + an aggressive negative list. Build negatives from day one and mine the Search Terms report weekly. Separate brand and non-brand campaigns (never let brand's cheap conversions flatter non-brand performance).

**Meta:** Consolidate — don't fragment budget across 20 tiny ad sets; the algorithm needs ~50 conversions/ad set/week to exit learning. Use Advantage+ / broad targeting with strong creative and let the algorithm find the audience; detailed interest targeting is largely deprecated for prospecting. Separate prospecting from retargeting campaigns and budgets.

## Bidding

- Start with enough conversion volume before handing the machine the wheel. If <15–30 conversions/month, begin with Manual CPC or Maximize Clicks to gather data, then graduate to tCPA/tROAS.
- Set target CPA/ROAS realistically — setting tCPA far below current CPA starves delivery (the algorithm can't find conversions that cheap and throttles). Move targets in ≤20% steps.
- Respect the **learning phase**: don't touch budgets/targets/creative for the first ~50 conversions or ~1 week. Every significant edit resets learning. Impatience is the #1 killer of paid performance.

## Creative and landing pages

- **Google Search:** Responsive Search Ads with 12–15 headlines and 4 descriptions, pinned only where legally/brand necessary. Include the keyword, a clear benefit, and a CTA. Add all relevant assets (sitelinks, callouts, structured snippets, images) — they lift CTR for free.
- **Meta:** Creative is the primary lever — test 3–5 distinct concepts (angle/hook), not color variations. Hook in the first 3 seconds, native-feeling, captions for sound-off. Refresh before fatigue (rising frequency + falling CTR/CVR).
- **Landing page:** message-match the ad, one clear CTA, fast load, mobile-first. Sending paid traffic to a slow, generic homepage wastes the whole spend.

## Optimization cadence

- **Daily (first 2 weeks):** check spend pacing and that conversions register; catch tracking breaks.
- **Weekly:** Search Terms → add negatives + new keywords; pause creatives below breakeven with enough spend; shift budget to winners; check frequency (Meta).
- **Statistical discipline:** don't kill an ad set on 3 conversions of noise. Wait for meaningful volume (rule of thumb ~50–100 clicks or 15–30 conversions) before declaring a winner. Judge on CPA/ROAS and post-click quality, not CTR.

## Reporting quality bar

Report on business outcomes: spend, conversions, CPA, ROAS, and (where available) actual revenue/LTV — tied to the client's target. Include what you changed and why, and one clear next action. Never lead with "impressions up 300%."

## Failure modes

- Optimizing to a broken/wrong conversion event.
- Editing during the learning phase and perpetually resetting it.
- Setting tCPA/tROAS unrealistically and starving delivery.
- Over-segmenting ad sets below the volume the algorithm needs.
- Broad match without negatives + Smart Bidding — a budget incinerator.
- Judging on CTR or "engagement" instead of CPA/ROAS.
- Letting brand-search conversions mask weak prospecting.

**Great** looks like: verified server-side + client tracking, a clean intent-based structure, bids matched to real target economics, creative tested on angles, weekly search-term/negative hygiene, and a report the client reads in outcomes and dollars.
