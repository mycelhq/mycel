---
name: keyword-research-and-content-strategy
description: Turn a client's market into a prioritized keyword map and topic-cluster content plan that targets winnable, intent-matched demand instead of vanity volume.
---

# Keyword Research and Content Strategy

You are building the demand map that tells a client what to publish, in what order, to capture organic traffic that converts. The output is a keyword-to-URL plan and an editorial roadmap — not a spreadsheet of high-volume words nobody can rank for.

## Step 1 — Seed the universe

Start from the client's actual offers and customer language, not your assumptions. Sources: the client's product pages, sales-call transcripts, support tickets, existing GSC "Queries" (real impressions they already get), competitor top-pages (Ahrefs/Semrush → "Top Pages" and "Content Gap"), Reddit/forums/review sites for the phrasing customers use, and autocomplete + "People Also Ask" + "Related searches."

## Step 2 — Expand and pull metrics

Push seeds through a keyword tool (Ahrefs Keywords Explorer, Semrush Keyword Magic, or GSC + Search Console API for owned data). For each keyword capture: search volume, keyword difficulty (KD), CPC (a proxy for commercial value), current client rank, and SERP features present (featured snippet, PAA, shopping, local pack, video).

## Step 3 — Classify by intent (the decision that matters most)

Read the live SERP for each head term and tag intent:
- **Informational** ("how to", "what is") → blog/guide, top-of-funnel, low direct conversion.
- **Commercial investigation** ("best", "vs", "review", "alternatives") → comparison/listicle, high-value mid-funnel.
- **Transactional** ("buy", "pricing", "near me", "[service] in [city]") → product/service/landing page, bottom-funnel.
- **Navigational** → brand pages.

Match the content format to what already ranks. If the top 10 for a term are all listicles, a single product page will not rank there — respect the SERP's revealed preference.

## Step 4 — Score winnability and prioritize

Don't chase volume. Prioritize by expected value = `volume × conversion-likelihood (intent) × win-probability`. Win-probability is a function of KD **relative to the client's Domain Rating / topical authority** — a DR-20 site should target KD < 20 and long-tail first, not KD-70 head terms. Prioritize:
1. **Quick wins:** keywords ranking positions 5–20 in GSC (already have authority, small push to page 1). This is the fastest ROI and should lead the roadmap.
2. **Bottom-funnel commercial/transactional** terms even at low volume — they pay the bills.
3. **Cluster-building informational** terms that establish topical authority.

## Step 5 — Cluster into a pillar/topic architecture

Group keywords into topic clusters. Each cluster = one **pillar page** (broad, targets the head term, e.g. "email marketing") + multiple **cluster pages** (long-tail subtopics, e.g. "email subject line best practices," "email automation for ecommerce") that link up to the pillar and to each other. This internal-linking topology signals topical authority and distributes link equity. Map every keyword to exactly one canonical target URL — **one intent per URL** — to avoid keyword cannibalization (two of the client's pages competing for the same term).

## Step 6 — Build the roadmap

Sequence by dependency and ROI: quick wins → high-value clusters → supporting content. For each planned piece specify: target URL (new or existing), primary + secondary keywords, intent, format, target word depth (benchmarked against the median top-10, not arbitrary), the internal links it must give and get, and the CTA/conversion goal.

## Quality bar

- Every keyword is mapped to exactly one URL (no cannibalization).
- Every target is *winnable* given the client's authority — a plan full of KD-80 terms for a new site is a failure regardless of how it looks.
- The roadmap opens with quick wins (results in weeks) to build client trust, then compounds via clusters.
- Commercial/transactional intent is represented, not just traffic-for-traffic's-sake blog posts.

## Failure modes

- Sorting by volume and picking the top rows — the classic amateur move; you get unrankable head terms.
- Ignoring existing GSC data and rankings — the client already tells you what's close.
- Creating multiple pages for near-identical intent — cannibalization dilutes both.
- Recommending content the site has no authority to rank for, then blaming Google in 6 months.
- Treating KD as absolute rather than relative to the client's DR.

**Great** looks like a living keyword map where each row has intent, a mapped URL, a winnability rationale, and a place in a cluster — sequenced so the client sees ranking movement within the first month while authority compounds toward the head terms over quarters.
