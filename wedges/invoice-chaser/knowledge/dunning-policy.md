# Dunning policy (the escalation ladder)

Seed policy — the founder tunes the intervals live (`PUT /v1/chase-policy`) and can rewrite this
document through the knowledge API. Tone beats aggression: most late payment is friction, not
refusal.

## The ladder

Read the row, take the step. Age is measured from the **due date**, not the issue date.

| Days overdue | Step | What it sounds like |
| --- | --- | --- |
| Not yet due | `hold` | Nothing. An invoice that is not late is not a chase. |
| 1–7 | `reminder` | Friendly nudge. "Just checking this didn't slip through." |
| 8–21 | `firm_reminder` | Clear and direct, still warm. Restate amount and original due date, ask for a payment date. |
| 22–35 | `final_notice` | Formal. Reference the terms and what the contract says happens next. |
| 36+ | `hold` | **Stop and hand to a person.** See below — this is not a fourth email. |

Two things override the row outright, whatever the age:

| Condition | Step | Why |
| --- | --- | --- |
| They promised a date that has not passed | `hold` | Chasing inside a promise you accepted is how a good client becomes a former one. |
| The work is disputed | `hold` | Argue and you have a dispute about two things. Escalate to a human. |

## Why 36+ is a hold and not a fourth email

This rung used to be missing: the ladder stopped at 35 days and said nothing about what came after,
so the honest reading was "keep sending final notices for ever". An invoice that has survived a
reminder, a firm reminder and a formal notice is not unpaid because nobody asked. It is unpaid
because the client cannot pay, will not pay, or has a problem nobody has surfaced — and all three
are decisions a person makes, not messages an agent sends.

The same logic bounds the count. A run stops chasing an invoice once it has been chased
`maxChases` times (default 6, hard ceiling 10) even if the age says it may escalate again. Age tells
you how hard to press; count tells you when pressing has stopped working.

## Pacing

Never chase the same invoice twice inside **48 hours**. This is a floor and it is not configurable —
the founder can make chasing gentler than the default ladder, never harder.

The sweep that finds overdue invoices may run hourly. That makes it **responsive** (a newly overdue
invoice is picked up sooner), never **aggressive** — the client's experience is paced by the table
above and by the 48-hour floor, not by how often we look.

## Tone rules

- One clear ask per message. Always include the invoice number, the amount, and a way to pay.
- No late fees and no legal language unless the contract explicitly allows them. If you are unsure
  whether it does, it does not.
- Never invent a consequence. "We will have to escalate" when nothing is set up to escalate is a
  bluff a client can call, and they only have to call it once.
- If the amount is wrong, or they say they already paid, stop chasing and check. Being wrong about
  money in writing costs more than the invoice.
- Charging a saved card or issuing a refund is always a separate, human-approved action.

## When in doubt, go softer

Every judgement call in this document resolves downward: an unclear standing takes the gentler step,
an ambiguous promise counts as a promise, an unreadable dispute flag counts as a dispute. The cost of
one chase sent too gently is a few more days of float. The cost of one sent too hard is a client.
