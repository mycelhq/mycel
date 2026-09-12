# gtm-operator

The deterministic half of outbound. Nothing here is a model judgment.

- `task_types` — the four jobs the kernel actually runs for this wedge, and all four are **harness
  work rather than agent work**. `find_prospects` passes a query to LinkedIn's own search and files
  what comes back; `propose_campaign` writes an approval and an artifact; `advance_sequences` is the
  five-minute tick; `outreach_touch` is one dispatched step. None of them invokes a model, because
  in none of them is there anything for one to decide — the query is the founder's and the copy was
  approved days ago. Paying per prospect for an LLM call to pass six strings to a search endpoint is
  pure cost.
- `cases.stages` — the stage machine a prospect moves through
  (`queued → warmed → invited → connected → dm1 → dm2`, exiting to `replied`, `booked`, `won` or
  `lost`). Declaring it here is what makes an invalid transition a rejection at the API boundary
  instead of a corrupted engagement — which is why adding `booked` meant editing this manifest and
  not only the TypeScript: without the line, `PUT /v1/cases/:id` rejects the stage it now sets.
- `workflows/next_touch.mjs` — given the facts on a Case, the next step is fixed. Whether to send,
  which touch it is, and how long to wait are not model judgments; only *how to write it* is. The
  function is pure (no clock, no I/O — `days_since_last_touch` is passed in), so cadence is
  testable without waiting four days, and **stopping is a first-class correct answer**: a reply, a
  booking or an opt-out ends the sequence rather than falling through to "send anyway".

There are **three skills and one knowledge file**, and where the line falls between them and the
task types is the whole design.

`skills/run-a-campaign.md` covers the only two things this wedge leaves to judgement — **the words
and the audience**. `skills/draft_campaign_copy.md` is the first half of that, and it runs **at
propose time only**: it fills the artifact a human is about to read. `skills/draft_reply.md` is what
happens after the machine has stopped — a prospect answered, the stage went terminal, and anything
further is a new decision, one approval per message (`gtm/reply.ts`). They are mounted
automatically: `loadWedge` reads every file under `skills/` unless the manifest names a subset, and
this manifest names none, so dropping a file in that directory is the whole act of shipping it.

None of that loosens the rule the four task types are built on. **No model is invoked at send
time.** `advance_sequences` still parks a step rather than improvise one ("no approved copy for this
step — nothing will be improvised"), and that park is correct. Agent judgement fills the artifact a
human approves; the tick only delivers words somebody has already read. A skill that drafted during
the tick would move the moment of consent to after the send, which is the same as not having one.

`knowledge/what-good-outreach-looks-like.md` is the floor, not the ceiling: it is what a project has
before it has any wins of its own. The real content arrives per-project — `convertProspect` files a
won prospect as an example, and a reply the founder rewrote before sending is filed as a correction
— so the house facts on disk stay deliberately thin and generic rather than pretending to know a
trade they have never seen.

Two stage vocabularies coexist and it is worth knowing which is which. `cases.stages` above is the
OUTREACH vocabulary in `harness/src/gtm/stages.ts` — the one every real Case actually holds, because
`enrolProspects` creates cases at `queued` and `sequence.ts` advances them along that list. Those
stages track a LinkedIn relationship rather than a touch count. `next_touch.mjs` speaks a second,
INTERNAL vocabulary (`prospect → touch_1 → …`) which is never stored on a Case; `sequence.ts` maps
into it (`NEXT_TOUCH_STAGE`) purely to ask the cadence rules rather than reimplement them.

`cases.stages` used to declare `next_touch.mjs`'s vocabulary instead, and the consequence was not
cosmetic: `caseStages()` in server.ts validates `POST /v1/cases` and `PUT /v1/cases/:id` against
this list, so the API boundary rejected every stage a GTM case can actually be in. Marking a
prospect `won` — the one transition that turns outbound into revenue — answered 400 `unknown stage
"won"` while the sequencer wrote `warmed` and `invited` straight through `domain.updateCase` and
never noticed. A declared vocabulary that no record ever holds validates nothing and blocks
everything.
