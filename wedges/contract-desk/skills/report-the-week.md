---
name: report-the-week
description: Turn the Monday sweep into a client-facing weekly status the client reads without a follow-up call — work done, hours against budget, blockers, next week's plan.
---

# Report the week

The Monday sweep (`weekly_run`) collects the desk's internal truth: whose timesheet is missing, which
weeks are ready to bill, which assignments are ending. That is the *raw material*. When the ask is a
**client-ready status**, the thing you hand over is not that sweep — it is a short, professional
update the client reads over coffee and closes without needing to email you back. It goes in the
REQUIRED `client_summary` field: the structured sweep fields (`missing_timesheets`, `ready_to_bill`,
`ending_soon`, …) stay as the internal working record, and `client_summary` is what the portal and
the client actually see. It is never optional and never the raw sweep. Produce it as an inspectable
`Deliverable` document, not a chat dump, and never paste the internal sweep verbatim.

The client is not on your desk. They do not want `assignment_id`s, `ready_to_bill` states, or "notice
window" mechanics. They want to know: is my work getting done, am I on budget, is anything stuck, and
what happens next.

## First, read the week's real facts — never narrate a status from memory

`GET $MYCEL_CASE_URL` for the engagement: it carries the budget, the week being reported, and the id
of the connected time-tracking / delivery source (`data.timesheet_connection_id`). Then pull this
week's actuals from that source — hours logged against budget, what shipped, and anything blocked:

```bash
curl -s "$MYCEL_READS_URL/harvest_timesheets" -H "authorization: Bearer $MYCEL_ACTION_TOKEN" \
  -H "content-type: application/json" \
  -d '{"connection_id":"<data.timesheet_connection_id>","query":{"week_ending":"<week>"}}'
```

Every number in the status — hours this week, hours used to date, hours remaining against budget —
comes from that read, unchanged. The work completed, the milestone, and the blocker come from it too.
Do not invent an hours figure and do not report a budget you did not read. If the read is empty or the
source is not connected, say so plainly and name what you need, rather than filling the numbers in.

## Write it in this order, every time

1. **The headline first — one or two plain sentences.** Where the engagement stands this week.
   "This week we shipped the two integrations on plan and you're tracking just under budget. One item
   is waiting on your team's sign-off before we can bill it." Lead with the answer, never with
   process or a list.
2. **Work completed** — in the client's language (outcomes, not `assignment` ids). What actually got
   done and what it means for them. Concrete, specific, no filler.
3. **Hours against budget — always, and stated plainly.** How many hours were used this week, against
   what was budgeted, and where that leaves the running total. "18 of the 20 hours budgeted this
   week; 62 of 80 hours used on the engagement, so ~18 hours of runway left." If you genuinely do not
   have the budget figure, say so in one honest sentence and name what you'd need to report it — never
   silently drop it. Budget status is the single line a client scans for; a status without it reads
   as an evasion.
4. **Blockers, honestly.** Anything stuck, in one plain sentence each: what it is, why it matters, and
   who owns the next move. A contractor who submitted and is waiting on the client's own manager is
   the *client's* action, not a failing on our side — say so plainly. If nothing is blocked, say that
   in a sentence rather than omitting it.
5. **Always end with concrete next steps.** Specific, dated where you can: what we'll do next week,
   what (if anything) we need from the client and by when. "Next week: finish the reporting dashboard
   and prep the November invoice. We need your manager to approve Dana's timesheet by Wednesday so we
   can bill it." A status with no clear next step reads unfinished even when the work is on track.

## Tone

Professional and warm, plain language, no project-management jargon a client wouldn't use themselves —
no "velocity", "WIP", "burn-down", "in flight". Scannable: short sections or short bullets, the
budget line impossible to miss. The test: would the client forward this to their own boss without
editing it? If not, it is your working notes, not a status — rewrite it before you send.

**Never leak internal plumbing into a client status.** The client does not care — and should never
read — that a payment provider isn't connected, that a read came back empty, that something is "on
staging", or any other detail of how we or the tools are wired. Translate everything into the
client's outcomes ("the new checkout is live and approved", not "moved to staging"). In particular,
do NOT append a caveat like "payment status could not be verified because no provider is connected":
that is our plumbing, not their status. If a fact isn't about their work, their hours, their blocker,
or what happens next, it does not belong in the status.

## Worked example — the bar, not a template

Illustrative throughout; **match the depth and the order, never the facts.**

> **Week ending 22 March — on track, one thing needs your eye.**
>
> Maya shipped the checkout redesign to staging on Thursday; your team's review is the last step
> before it goes live. That was the milestone for this fortnight, and it landed on schedule.
>
> **Hours.** 34 this week (Maya 26, Tomás 8), 212 of your 300-hour budget used with five weeks to
> run. At the current pace you finish around 290 — inside budget, with no room for scope
> additions, so anything new should go on the April statement instead.
>
> **One blocker.** Tomás has been waiting since Tuesday on API credentials for the inventory
> system — it's the only thing between him and starting the sync work. Whoever owns that system
> on your side can unblock him in five minutes.
>
> **Next week.** Maya takes your staging feedback to production; Tomás starts the inventory sync
> the day credentials arrive. Nothing is billed until you've seen the invoice, as usual.

Why this passes the bar: the headline answers "is my work getting done" before anything else;
every number came from the timesheet read and is phrased against THEIR budget, not our ledger; the
blocker names who can fix it and how cheaply, which is what turns a status into an action; and the
one budget risk (no room for scope additions) is said now, five weeks early, instead of appearing
as a surprise on an invoice. No assignment ids, no "ready_to_bill", no desk vocabulary anywhere.
