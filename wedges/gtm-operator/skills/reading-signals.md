---
name: reading-signals
description: Call the workflow, quote what it returns, and never rank accounts by eye. The signal does the targeting; the message does the conversation.
---

# Reading signals

You have three deterministic workflows. Use them. Everything below is about what is left for you
once they have run, which is the part that actually needs judgement.

```bash
curl -s "$MYCEL_WORKFLOWS_URL/signal_score" -H "authorization: Bearer $MYCEL_ACTION_TOKEN" \
  -H "content-type: application/json" -d '{"now":"<today>","icp":{...},"signals":[...]}'
```

## Never rank accounts yourself

You will be able to look at twelve signals and form a confident opinion about which account is
hottest. So will the next run, and it will be a different opinion.

A founder needs to know **why this account is at the top today and not last week**, and the answer
has to be the same answer every time. That is arithmetic, and the workflow does it: each signal type
decays on its own clock, a pricing-page visit is worth a fifth of itself in a week while a funding
round is still worth most of itself, and signals stack per company.

Quote `act`, in order. Do not re-sort it, do not re-score it, and do not rewrite `lead_with`.

## A closed window is not a weak signal

The workflow returns `stale` separately and that is not a formality. **Do not write to those
accounts.**

"We noticed you raised a round" eight months later is not a softer version of a good message. It is
evidence nobody was paying attention, and the prospect reads it that way. Silence is better.

Do report them to the founder, though, and report them as what they are:

> Four signals fired this month and the window closed on all four before anything went out. That is
> a routing problem, not a sourcing one — the feed is working.

That sentence is worth more than the four messages would have been.

## Name the signal in the opener, or the targeting was wasted

This is the whole game and it is where most signal work dies.

> **Earns a reply:** "Saw you're hiring a head of retail and the post mentions opening two more
> sites — is the second one signed yet?"
>
> **Reads as spam anyway:** "We help growing bakeries with their brand and website."

The second one was sent to a perfectly chosen account at a perfectly chosen moment and it is
indistinguishable from a blast, because nothing in it could only have been written to them. The
signal did the targeting. The message still has to do the conversation.

`lead_with` gives you the fact. `say` on each signal tells you how to use it — read it, especially on
funding (match the stage to the offer) and on a champion who moved (congratulate the person, not the
account).

## What the signal already told you about qualification

When they reply, you know more than you would from a cold list, and `qualify_on` says what:

- **After funding** — they have budget. Qualify on fit and timeline, not money.
- **After a pricing visit** — they are comparing. Qualify on what they are comparing you to, and on
  switching cost.
- **After a senior hire** — there is a new mandate. Qualify on whether it maps to what you sell.

Asking a funded company about budget wastes the one thing the signal bought you.

## What you never automate

Two decisions stay with a person, and they are the two the machine is worst at:

**Who is worth outreach this week.** The workflow scores; the founder chooses. A high score on an
account they have a reason to avoid is still a no.

**How to answer a live reply.** Once a human writes back, you stop. Draft, propose, and let the
founder send. A real objection answered by a machine is how a relationship ends before it starts.

## Never

- Never write to an account in `stale`.
- Never re-rank, re-score, or re-word what the workflow returned.
- Never open with a third-party intent score. It is a tiebreaker for who to work next, never a reason
  to start, and saying it out loud is worse than not having it.
- Never invent a signal. If the feed did not report it, it did not happen.
- Never send. You propose; the founder approves.
