---
name: run-a-campaign
description: Find real prospects and turn them into a sequenced LinkedIn campaign a human approves ONCE — inside a wedge where the cadence, the pacing and the stage machine are already decided in code.
---

# Run an outbound campaign

You operate the founder's real LinkedIn account. Everything you do arrives in a stranger's
notifications with the founder's name on it, and a restricted account takes about a week to lift
with no explanation and no appeal. Volume is not the goal; replies are.

## Most of this wedge is not yours to decide

Four task types exist, and all four are **harness work** — they run without invoking a model,
because in none of them is there anything for one to judge:

| Task type | What runs |
|---|---|
| `find_prospects` | Passes a query to LinkedIn's own search and files people and companies into the graph. A read: no approval, no touch budget. |
| `propose_campaign` | Writes ONE approval and an artifact. Sends nothing. (Not `draft_campaign` — that name does not exist.) |
| `advance_sequences` | The five-minute tick. Never create one by hand. |
| `outreach_touch` | One dispatched step; the anchor an auto-approval, a timeline entry and an audit row hang off. |
| `propose_reply` | AFTER they answered. One draft, one approval, one send — outside the campaign envelope. See `draft_reply.md`. |

So your contribution is **the words and the audience**, and nothing else. Write the words with
`draft_campaign_copy.md` **before** `propose_campaign` — that is the only moment copy is written, and
`draft_reply.md` takes over once the sequence has stopped. Cadence is
`workflows/next_touch.mjs`: whether to send, which touch it is, and how long to wait are fixed
given the facts on a Case. Call it before drafting any follow-up. It stops on reply, on booking and
on opt-out, and **stopping is a correct answer** — a reply hands the prospect to a human rather
than earning another touch.

Two stage vocabularies coexist. `cases.stages` is what a Case actually holds
(`queued → warmed → invited → connected → dm1 → dm2`, exiting to `replied`, `booked`, `won`, `lost`) and is
validated at the API boundary. `next_touch.mjs` speaks an internal one (`prospect → touch_1 → …`)
that is never stored; the sequencer maps into it purely to ask the cadence rules. Do not write a
`touch_2` onto a Case.

Copy is supplied at propose time (`draft_campaign_copy`). A case enrolled from the graph carries none, so a message step
**parks** — "no approved copy for this step — nothing will be improvised" — rather than inventing
one. That parking is correct behaviour. Fix it by proposing copy, never by loosening the rule.

## The approval shape

Per-CAMPAIGN, not per-send, and for a mechanical reason: an approval blocks the run in-process with
a short TTL, so a campaign asking for a human on every message would sit suspended for days and
expire.

1. `propose_campaign` produces the whole sequence — audience, steps, wait days, every template
   written out in full. **That** is what a human approves, once.
2. Individual sends then fall under `policy.auto_approve` in `wedge.json`, inside per-task and
   per-day ceilings. They still land in the approval queue with a `policy_reason`, so the founder
   reviews a batch rather than a drip.
3. Anything outside the envelope — a bigger day, an invented step, a post — reaches a human. That
   is working as intended. Never restructure a campaign to slip under a ceiling.

Two limits you cannot argue with, in this order. **Pacing** (`pacing.ts`) decides whether the
ACCOUNT may send anything at all right now, and it is not a volume rule: LinkedIn scores acceptance
and reply rate, so the real budget is derived from how the last hundred touches landed, under a
young-account ramp and an 08:00–19:00 weekday window. A human approving twenty messages at 11pm
does not make it safe to deliver twenty at 11pm. Then the campaign's own `daily_cap`, which should
be lower.

## Choosing people

1. **Search before you assume.** `search_people` runs on the messaging session we already hold and
   costs nothing, so it is always the first step. Prefer one narrow query to paging through
   hundreds — search volume is itself a scored pattern.
2. **Look at each person** with `get_profile` before they enter the list. A message that references
   something real is the whole difference in reply rate, and this is where you get the something.
3. **Enrich only what the message will use.** Email enrichment is the one hop in this system that
   costs money, and it bills per prospect. Asking for a phone number you will never dial is a real
   invoice for nothing. If no enrichment key is configured the resolver returns "not configured"
   and writes nothing — a configuration state, not a failure to work around.
4. **Say why each person fits**, specifically. "Head of finance at a UK agency" is the audience.
   "Posted last month about switching off spreadsheets for month-end" is a reason.
5. **Record who you rejected and why.** The negative result is what stops the next run redoing the
   work.

## Sequencing

Warm up, connect, converse — in that order, because it is how a person builds a relationship.

Live sequence verbs (the only `action` values `propose_campaign` will accept) live in
`skills/what-we-can-do.md` — generated from the runtime, not this file. Read it before you
propose. Cadence is `wait_days` on a step, **not** an `action: "wait"`.

Do **not** put follow, react, InMail, endorse, comment, or posts in a campaign sequence.

**Do not use `comment_on_post`.** If a post genuinely deserves a comment, say so in your reasoning
and let the founder write it.

Write every template out in full. A campaign that ships with `{{first_name}}` unfilled sends
`Hi {{first_name}}` to a stranger, and that is the founder's reputation, not a bug report.

## Taking actions

Through the action proxy; you never hold the LinkedIn session, and every call leaves through the
account's own residential proxy.

```bash
# reads — ungated and free against pacing, still metered
curl -s "$MYCEL_READS_URL/search_people" -H "authorization: Bearer $MYCEL_ACTION_TOKEN" \
  -H "content-type: application/json" \
  -d '{"connection_id":"<linkedin id>","query":"head of finance agency Austin","limit":10}'

# writes — gated, or auto-approved inside the campaign envelope
curl -s "$MYCEL_ACTIONS_URL/send_message" -H "authorization: Bearer $MYCEL_ACTION_TOKEN" \
  -H "content-type: application/json" \
  -d '{"connection_id":"<linkedin id>","thread":"<conversation urn>","body":"..."}'
```

Always pass `connection_id` explicitly. The proxy resolves a connection by matching the capability
name against the connection kind, and no LinkedIn capability name contains the word "linkedin" — so
without it the call resolves to nothing.

If a human edits your message before approving, that edit is the house voice. Use it. Never retry a
rejected action, and never re-send to someone who did not reply: the second message is where "I
don't know this person" reports come from, and that signal is what precedes a restriction.
