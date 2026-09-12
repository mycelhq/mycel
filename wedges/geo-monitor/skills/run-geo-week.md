# Run a GEO week

1. Read the case for the client's query list and surfaces.

## If a mentions / share-of-voice source is connected, read it and report — do not refuse

`GET $MYCEL_CASE_URL`. When the case carries the id of a connected monitoring source
(`data.mentions_connection_id`), you do NOT run probes yourself — the measurements already exist at
the source. Read them:

```bash
curl -s "$MYCEL_READS_URL/brandwatch_mentions" -H "authorization: Bearer $MYCEL_ACTION_TOKEN" \
  -H "content-type: application/json" \
  -d '{"connection_id":"<data.mentions_connection_id>","query":{"client":"<brand>"}}'
```

The read returns the week's `mentions` (each with the surface it appeared on and its sentiment), the
query list that was probed, and a `share_of_voice` sample (the client's percentage and the competing
brands' shares). Set `status` to `reported` and carry those numbers into the result UNCHANGED —
`share_of_voice_pct`, `queries`, `mentions`, `top_competitors` all come from the read, never
estimated. Lead `client_summary` with where the client stands (their share of voice, who is winning
the citations), then the notable mentions and their sentiment, and end with the one thing worth
responding to this week. This is a real report from measured data: refusing it, or zeroing it, is the
error. Only refuse (below) when NO source and NO query list exist.

## Otherwise, when you must run probes yourself

**Do not "check whether the service is up" first.** These endpoints are POST-only, and a GET to one
answers 405 with its usage — never 200. A real run once sent three GETs, read the answers as proof
that batches, packs and workflows did not exist, and refused a report it could have produced. The
only way to find out whether a fan-out works is to POST the fan-out.

2. Open a batch (do not keep working after this call):

```bash
curl -s "$MYCEL_BATCHES_URL" -H "authorization: Bearer $MYCEL_ACTION_TOKEN" \
  -H "content-type: application/json" \
  -d '{"join":"all","children":[{"task_type":"probe_surface","input":{"query":"…","surface":"…","client":"…"}}]}'
```

3. When you are resumed after join (or when producing the weekly report from aggregate outputs), call
   `share_of_voice@1` with the client name and every child's

   ```
   { query, surface, cited, reached, blocked_by }
   ```

   **Pass `reached` and `blocked_by` through. Every time, including on the runs that worked.** This
   step used to say `{query, cited}`, and dropping the other three is how a blocked probe became a
   measurement: a probe that hit a captcha returns `cited: []` — correctly, because it refuses to
   invent an answer it could not see — and an empty citation list is indistinguishable from "the
   assistant answered and did not mention you" by the time it reaches the pack. It divided by all of
   them. Ten queries, six blocked, brand named in three of the four that answered: the truth is 75%
   and it said 30%.

   The pack now excludes the unreached ones and returns `unreached` and `blocked_by` alongside the
   percentage, but only if you hand them over. A missing `reached` counts as reached, because every
   historical row omits it.

4. After join, put the pack's numbers into the final result unchanged. Your `summary` may explain; it
   may not contradict the pack. That now includes `unreached` and `blocked_by`, which go in the
   report whenever `unreached` is above zero — a client is owed the size of the hole in their own
   number, and the sentence is "we could not reach ChatGPT this week", not a smaller percentage with
   no explanation attached.

5. **If every probe was blocked, there is no share of voice.** Set `no_surface_reached` to true and
   leave `share_of_voice_pct` absent — a ship check refuses the report if you state both. Zero per
   cent says the assistants answered and named somebody else, which is a finding a client would act
   on. "Nobody could look" is a different fact and it is not their fault. Say which surfaces refused
   and why, in `client_summary`, and treat the week as an honest report about a bad week for
   MEASUREMENT rather than a bad week for the client.

## When there is nothing to probe — refuse through the schema, never furnish

A weekly report is an aggregate of real probes. If the case carries NO query list — or there is no
case at all — there is nothing to aggregate, and the honest output is a refusal, not a report. The
schema makes the refusal a first-class answer, so you do not have to smuggle it into prose:

- Set `status` to `not_set_up`. Leave the measurement fields (`share_of_voice_pct`, `queries`,
  `mentions`) ABSENT — do not set them to zero. Zero is a measurement; absence is the truth.
- Write `client_summary` as the plain-language answer the client reads: monitoring is not live yet
  because no brand/query list is connected, and the one action that turns it on (add the brand /
  product names and surfaces to probe). This is the whole deliverable in this state.
- Do NOT invent queries, do NOT emit a report with empty sections, zeroes, or "no mentions found"
  claims you never measured. A client reading "no brand mentions this week" believes you looked.
  An empty-section report scored 0/1.0 with a judge for exactly this reason: it looks like work
  and carries no truth.

When probes DID run, set `status` to `reported` and lead `client_summary` with where the client
stands in plain language (share of voice, who is winning the citations); the numeric fields carry
the pack's measurements unchanged.

Also populate `recommendations` (at most three, lead with a Small — see turn-measurement-into-work)
and `happens_next` (one sentence the agency can say to their client about this week). A week that
measured and named no work is held from the portal. It is not a report.

The rule generalises: this wedge's reports carry MEASUREMENTS. A measurement you did not make must
never appear as a number in a deliverable, whatever the schema seems to want.

And the subtler half, which is where this actually goes wrong in practice: a measurement you did not
make must not be silently folded into one you did. A blocked probe is not a zero. It does not lower
a percentage, it shrinks the sample — and the difference between those two is a client being told
their visibility is collapsing when the truth is that nobody could look.

## Put the report where the client can see it

A weekly report that ends in the task result reaches the operator and stops there. The client
is paying for a report they can open, and the retainer is renewed or cancelled on whether it shows
up. So when `status` is `reported`, submit it as a deliverable version.

```bash
# ONCE per client, ever. Keep the id on the case (`data.report_deliverable_id`).
curl -s "$MYCEL_DELIVERABLES_URL" -H "authorization: Bearer $MYCEL_ACTION_TOKEN" \
  -H "content-type: application/json" \
  -d '{"title":"AI visibility — <client>","kind":"document"}'

# EVERY week after that: a new VERSION of that same deliverable.
curl -s "$MYCEL_DELIVERABLES_URL/<id>/versions" -H "authorization: Bearer $MYCEL_ACTION_TOKEN" \
  -H "content-type: application/json" \
  -d '{"summary":"Week of <date>","body":"<client_summary, then the numbers>"}'
```

**One deliverable, fifty-two versions — not fifty-two deliverables.** This is the difference between
a client who can see their line moving and a client with a year of identical unread cards. The
version history *is* the trend; it is the reason the retainer is worth renewing, and it is
unrecoverable if you get this wrong for a few months.

**Never publish a `not_set_up` report to the client.** A refusal is a message to the FOUNDER — it
says the brand and query list were never connected. A client opening "monitoring is not live yet" is
reading a bill for nothing. Leave that one in the task result and let the founder fix it.

**Lead the version body with `client_summary`**, then the numbers. The client reads one paragraph
and decides whether to read further; do not open with a table.

You submit; the founder releases. Do not ask the founder to accept — acceptance belongs to the
client, and it is what makes the work billable.

## After the report, a page is drafted for you

When `status` is `reported` and you named a Small or Medium recommendation, the kernel starts
`ship_page` on this engagement and hosts the page at a URL the client can open. You do not call
that yourself. A second POST of the same page in the same week is how a client gets two drafts of
the same URL.

Your job in the report is to make that page authorable: a named page, a named question, a fact they
already know. The page run will refuse (and ask the client) rather than invent a price.
