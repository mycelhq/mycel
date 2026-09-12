# How this service measures

Share of voice is **computed**, never estimated.

1. Open a batch of `probe_surface` children — one per (query × surface).
2. When the batch joins, call the pack:

```bash
curl -s "$MYCEL_PACKS_URL" -H "authorization: Bearer $MYCEL_ACTION_TOKEN" \
  -H "content-type: application/json" \
  -d '{"pack":"share_of_voice@1","args":{"client":"<name>","results":[...]}}'
```

3. Upsert a series sample on Records with `observed_at` set to the probe instant so week-over-week charts are honest.

If the pack is unavailable, say so and stop. Do not invent a percentage in prose.

If a Surfer credential is on this project, read `read-surfer` AFTER the pack has a real number, and
only for pages named in this week's recommendations. Surfer is an overlay. It is not share of voice.

## Selected is not absorbed

Every probe records two lists and they are not the same list.

**`cited` — selection.** The surface offered this source. It appeared in the citation list, the
footnotes, the "Sources" rail. It was retrieved.

**`absorbed` — absorption.** The answer actually *used* it: described it, quoted it, recommended it.

They come apart in both directions, and the direction matters:

- **Cited, not absorbed.** We were retrieved and ignored. The page is findable and not usable —
  usually a page with no extractable claim in it. This is a WRITING problem.
- **Absorbed, not cited.** The answer talked about the client without linking them. The entity is
  known; the page is not being retrieved. This is a RETRIEVAL problem — crawlability, entity
  consistency, third-party corroboration.

A report that collapses these into one number can tell a client they were "visible 4 times" in a week
where nobody read a word they wrote. Worse, it cannot say what to do next, which is the only thing
the retainer is for. Selection and absorption have different fixes; keep them apart all the way
through to the client's page.

The week's Small recommendation is drafted as a live **commercial page** at a public URL
(`ship_page`) after the report. That page is the work — nav, table, FAQ, JSON-LD, the first two
sentences answering the question. A cream stub is not the work. The number is the reason the page
exists.

## Passages, because citation is chunk-level

Answer engines quote passages, not pages. When a surface shows what it drew on, record it in
`passages` with its `genre` — definition, statistic, comparison, procedure, quote.

The genre counts are what make a recommendation measurable. "Publish more comparisons" is a hunch;
"eleven of your fourteen absorptions this quarter were comparison tables, and you have published two"
is a brief. Do not fabricate a passage when the surface does not reveal one — an empty `passages` is
a true answer and an invented one poisons the series.

## What NOT to spend the week on

`llms.txt` gets no special treatment from crawlers and practitioners who built recurring calendar
blocks for maintaining it have dropped the task. Do not put it in a plan or bill for it. Entity
consistency — the same product, feature and category names everywhere, corroborated by credible
third-party sources — is where that hour belongs.
