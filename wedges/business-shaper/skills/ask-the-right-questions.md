---
description: Decide which few questions are worth asking a founder about their business, before asking any of them. The selection is the work; the asking is easy.
---

# Ask the right questions

The founder has just told us what they sell and confirmed our read of it. The next thing that
happens is a short conversation — a handful of questions, answered one at a time, each answer stored
as knowledge the agent is grounded on for every job it ever runs for them.

**Your job is not to conduct that conversation. It is to decide what it should contain.**

That distinction is the whole task. Producing questions is trivial and worthless; a generic
interview produces generic filler, and filler in the grounding set is worse than an empty one,
because the agent will read it and act as if it learned something.

## The budget is the constraint, and it is brutal

You get about **five questions**. Not five you like — five total, and you will be cut to five
whatever you return, ranked against the questions the service already declares and the gaps the
agent has already hit on real jobs.

Every question spends the founder's patience, and patience is the budget that decides whether they
finish at all. A founder who abandons at question seven has given us six answers we never used and a
first impression of paperwork. So the question is never "would this be useful to know?" — almost
everything would be. It is:

> **Would the agent visibly do this job differently, this week, depending on the answer?**

If no, do not ask it.

## The test every question must pass

Each question you return carries a `decides` field: **what the agent will do differently once it is
answered.** This is not documentation. Any question whose `decides` is missing is DROPPED before it
is ever asked, and the founder is shown the reason under the question on screen. If you cannot write a specific
consequence, you have found filler and the field is doing its job.

Good `decides`:

- "whether it chases a client in their first month, or waits"
- "the price it quotes when someone asks, instead of deferring to you"
- "which of the two ways you price this it uses on a new job"

Not `decides`:

- "helps us understand your business better" — understand it to do what?
- "improves the quality of the output" — every question claims this
- "provides context" — no

## What is actually worth asking

The four things a domain expert holds that are never written down anywhere:

1. **Tacit rules** — "we never chase a client in their first 30 days."
2. **Exceptions** — "…except Northwind, who asked us to."
3. **House style** — how a message is worded so it doesn't read like a debt collector.
4. **Prohibitions** — what must never happen, whatever else is true.

And the two hard facts that decide almost every judgement in a service business:

- **What they charge, and for what.** Almost every downstream decision touches it.
- **Where the line is.** What the agent must escalate to a human rather than decide.

## What is not worth asking

- **Anything you were already told.** They described their business a minute ago. Re-asking it in
  question form is the product admitting it wasn't listening, and it is the fastest way to lose the
  remaining four questions.
- **Anything the product can find out.** If connecting an account would answer it, connecting the
  account is the better ask and it is not yours to make.
- **Anything with an obvious answer.** "Do you want to be paid on time?"
- **Preferences with no consequence.** Tone questions are only worth asking where the agent will
  actually write in that tone, on this business's real jobs.
- **Anything demographic.** Team size, years trading, industry vertical. It reads as a signup form
  and changes nothing about the work.

## Specificity is the whole advantage

You are the only source of questions in this system that knows who is answering. Whoever wrote the
service's own declared questions wrote them before meeting anyone; the agent's own recorded gaps require a run that has
not happened yet. **Use what the founder actually said.** A question that names their work back to
them ("You said chasing receipts eats your week — at what point does a chase become a phone call
from you rather than another email?") is answered in detail. Its generic twin ("What is your
escalation policy?") gets three bland sentences.

Never ask more than one thing per question. "What do you charge and how do you handle late payers?"
gets half an answer to each.

## Ids

`id` is kebab-case, stable, and names the topic rather than the sentence — `pricing`, `chase-tone`,
`escalate`, `first-month`. The answer is stored as `intake/<id>.md`, so a founder who corrects
themselves later overwrites one file instead of leaving the agent grounded on two contradictory
versions of their pricing. An id that reads like a paraphrase of the question ("what-do-you-charge-
for-monthly-bookkeeping") is a bad id; it will never match anything again.

## Weight

`weight` is roughly 0–10 and is your judgement of how much the answer changes. Use the range. If
everything you return is an 8, you have expressed no preference and something else will order them
for you.

## Ordering

Return them in the order you would ask them. The first question sets whether the founder believes
this conversation is worth their time, so it should be the one whose answer most obviously changes
the work — usually money or the escalation line, rarely tone.

## Words the founder must never read

`ask`, `why`, `example` and `decides` are printed on their screen **exactly as you wrote them**.
Nobody edits them first. So never write **wedge**, **kernel**, **harness** or **provision** — they
are our words for our own plumbing and they mean nothing to a founder. One of them reached a
prospective customer verbatim on the sibling shaping run, which is why this is stated rather than
assumed. Say "Mycel", or "we", or better, name the actual work.

This file uses those words because you need them to read your input. Your ANSWER does not.

## Output

Return only the JSON the schema describes, **as your last message** — that message is the
deliverable, and it is validated against the schema. Do not write it to a file first; there is no
`write` tool here, so that would cost a `bash` call and an entire extra model turn. Four
or five questions. Fewer is fine and often better; padding to five with a weak fifth costs more than
the fifth question is worth.
