# Probe one query

You are measuring whether a named client appears in an answer for one query on one surface.

- Record every brand/domain, not just the client.
- Prefer short exact names over marketing copy.
- If the surface refuses or errors, return `cited: []`, `absorbed: []` and put the error in
  `raw_excerpt` — do not invent citations.
- Do not compute share of voice. That is the pack's job after the batch joins.

## `cited` and `absorbed` are two different questions

Answer them separately, in this order, and do not let the first answer contaminate the second.

**`cited` — was it OFFERED as a source?** Look only at the citation list, footnotes, or "Sources"
rail. This is a mechanical transcription. If it is in the list, it goes in `cited`, no matter what
the prose does.

**`absorbed` — did the answer USE it?** Look only at the prose. A brand is absorbed when the answer
describes it, quotes it, recommends it, or leans on a fact from it. Ask: *if I deleted this source,
would the answer change?* If nothing in the prose would change, it was not absorbed.

### The two cases this exists to catch

These are the ones that get scored wrong, and getting them right is the whole reason we record two
lists. A model asked to do this in one pass typically produces both errors at once — copying the
Sources rail into `absorbed`, and forgetting the brand that was never linked.

**Listed but unused → `cited` only.** A source sits in the rail and the prose never touches it. This
is the most common error: do NOT copy the citation list into `absorbed`. Four sources listed and two
discussed means `cited` has four and `absorbed` has two.

> Sources: [1] bench.co [2] xero.com [3] quickbooks.com [4] getharvest.com
> …prose discusses Bench's statistic and Xero's comparison table, and says nothing about
> QuickBooks or Harvest.
>
> `cited: [bench.co, xero.com, quickbooks.com, getharvest.com]`
> `absorbed: [bench.co, xero.com]`

**Discussed but unlinked → `absorbed` only.** The answer talks about a brand that appears nowhere in
the sources. It still belongs in `absorbed`. This is not an edge case — it is the signal that the
entity is known to the model while the pages are not being retrieved, which is a completely
different problem from being unread, and the report says so.

> …"Some people swear by Pilot, though it's aimed more at funded startups."
> Pilot is in no source. → `absorbed` includes Pilot. `cited` does not.

`absorbed` is therefore NOT a subset of `cited`. If you find yourself producing one as a filter of
the other, you have answered the same question twice.

## Passages

When the answer reveals what it drew on, record it in `passages` with the brand, the text, and the
`genre` — definition, statistic, comparison, procedure, quote. Quote verbatim where you can; a close
paraphrase is acceptable, an invention is not. An empty `passages` is a true and useful answer.

The genre is what makes the advice measurable later: "publish more comparisons" is a hunch, and
"eleven of your fourteen absorptions were comparison tables" is a brief.
