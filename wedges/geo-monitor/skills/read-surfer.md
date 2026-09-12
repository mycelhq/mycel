---
name: read-surfer
description: Optional Surfer SEO overlay for a weekly GEO report. Content scores and keyword gaps are measurements — never invent them. GEO share-of-voice still comes from probes, not from Surfer.
---

# Surfer, when it is actually connected

Mycel does not ship a Surfer account. If this install has no Surfer credential, skip this file
entirely and write the weekly report from probes + `share_of_voice@1` as usual. Do not estimate a
content score, a keyword gap, or a "you are at 64/100" number. Absence is the truth; a made-up
Surfer number is a lie a client can check in thirty seconds.

## When to read it

Only when a Surfer connection exists on this project, or `$SURFER_API_KEY` is in the environment.
Then it is an overlay on the GEO report, not a substitute:

- **GEO (this wedge)** — what answer engines actually said and cited. Measured by `probe_surface`.
- **Surfer (this skill)** — on-page content editor score and SERP keyword coverage for pages you
  already named in the recommendations. Measured by Surfer's API.

A client buying AI-visibility is buying the first. The second is how an SEO agency turns "write a
comparison page" into "this URL is 47 and the SERP winners are 78 because they have X".

## How to call it

Surfer's Content Editor and SERP endpoints are POST. A GET returns 405; that is not proof the
product is missing. Do not "check whether Surfer is up" with a GET.

If a connection row exists, read its secret through the kernel's connection read. If only an env
key exists:

```bash
curl -s "https://app.surferseo.com/api/v1/content_editor" \
  -H "API-Key: $SURFER_API_KEY" \
  -H "content-type: application/json" \
  -d '{"permalink":"<the page you are scoring>"}'
```

Exact paths drift. Prefer the connection's `config.api_url` when present. If the call fails, say
so in `client_summary` in one clause ("Surfer was not reachable this week") and leave Surfer
fields **absent**. Do not zero them.

## What you may copy into the report

Only values the response actually contained:

- `content_score` — their score for a named URL
- `word_count` / `required_word_count` — if both present
- `missing_terms` — terms the SERP winners use that this page does not, capped at ten, verbatim
- `serp_url` — the page you scored

Never Core Web Vitals, schema "100%", or "Grounded & Verified". Surfer does not measure those, and
this wedge does not either.

## What never to do

- Substitute a Surfer score for share of voice. They are different measurements.
- Recommend "fix Core Web Vitals" or "add FAQ schema" from a Surfer miss. That is a different
  product, and inventing it is how a GEO retainer turns into a fake technical-SEO PDF.
- Run Surfer against a URL you did not already name in a recommendation. It is a cost; spend it
  on the pages this week's GEO probes said to change.
