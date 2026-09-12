# Fitting a trade

`WEDGES.md` is the anatomy — what the files are and where they go. This is the **method**: how to
take a service business nobody here has ever run and turn it into a wedge that produces work an
expert in that trade would sign their name to.

It is written from two instances rather than from theory. `geo-monitor` was fitted against
`STANDARD.md` §6's spec for AI-visibility work; `site-studio` was fitted against its spec for web
development. Both times the same four questions produced the manifest, and the third one is the one
everybody skips.

---

## The claim this method has to support

> The constraint on this company should be selling, not whether we can do the trade.

That is only true if fitting a new trade is a day of work by somebody who can interview a
practitioner — not a month of engineering. It is a day of work when the trade's craft can be written
down as **requirements a machine can check**. This document is how you get there.

---

## 1. What does this trade actually deliver?

Not "what does the client buy" — what lands in their inbox.

The trap is to model the *sale* rather than the *work*. A web studio sells "a website"; a
bookkeeper sells "the books". Model that and you get one enormous task type that either succeeds
completely or not at all, and every real engagement immediately becomes a special case.

Ask instead: **what are the moments this engagement is gated on?** Each gate is a task type.

`STANDARD.md` §6 does this for web development in one sentence and it is the model for the question:

> Almost never one deliverable. Four gated ones: a copy deck and sitemap approved before anything is
> built, a staging URL with a named review deadline, a change list per round, then launch and
> handover.

Four gates, four task types, four deliverables a client says yes or no to. The test for whether you
have the granularity right:

- **A deliverable is reviewable in under ten minutes**, has an obvious accept-or-reject decision, and
  names what happens next. (`STANDARD.md` §6 again.)
- **The client can say no to one without the engagement collapsing.** If rejecting the deliverable
  means starting over, it was too big.

---

## 2. Where does this trade lose money?

The most valuable question and the least obvious, because practitioners rarely volunteer the answer
— it sounds like admitting a weakness.

Every service trade has two or three failure modes that are famous inside it and invisible outside.
They are where the craft lives, and they are what a wedge is *for*. Some examples, all of them
encoded in this repo:

| Trade | Where it bleeds | What the wedge does about it |
|---|---|---|
| Web development | Revisions arriving one email at a time for five weeks | `review_round` makes a round a **batch**, sizes each change, and names what is out of scope with a reason |
| Web development | A launch that forgets the redirects, killing four years of search traffic | `launch_checklist` requires a redirect map and what was actually **seen** on the live domain |
| Bookkeeping | A close that balances because something was forced | `agrees` — `reconciled: true` beside a non-zero difference cannot ship |
| Contracting | An invoice whose total disagrees with its own lines | `sums_to`, in integer minor units, exact |
| AI visibility | A share-of-voice number with no work attached | `spread` on effort — recommendations that are all Large is a quarter nobody starts on Friday |

Notice what these have in common. **None of them is about the model being clever.** They are all
things a competent practitioner does automatically and an eager one forgets under time pressure.
That is exactly the population a checkable rule can cover.

**How to find them.** Ask a practitioner: *what goes wrong on these jobs that costs you money, and
what do you do to stop it?* Then ask *what does a bad one look like — one that a client accepted and
you were embarrassed by?* The second question is the one that produces the gates.

---

## 3. Which of that craft is checkable?

This is the step that decides whether the trade is fitted or merely described, and there is a ladder.
Use the **lowest rung that catches the failure**, because every rung up is more machinery and more
ways to be wrong.

**Rung 1 — `output_schema`.** Is it the right shape. Enums are free correctness: `size` as
`"tweak" | "rework" | "new"` makes a whole class of vagueness impossible to express.

**Rung 2 — `ship_requires`.** Which fields must carry *something*. This is a non-emptiness test and
that is all it is. It stops an empty answer wearing the schema's clothes.

**Rung 3 — `ship_checks`, arithmetic.** Do the fields **agree with each other**. `agrees`, `sums_to`.
Use these wherever being right is arithmetic rather than judgement — those places are rarer than you
expect and more valuable than anything else on this list, because they are the only gates that are
*certainly* correct.

**Rung 4 — `ship_checks`, craft.** `each_has`, `spread`, `min_words` / `max_words`, `forbids`.
Proxies for quality, deliberately crude. A word count is not a measure of whether writing is good; it
is a measure of whether there is any. `spread` does not know what "small" means; it only knows that
one size repeated three times is not a plan.

**What does NOT go on the ladder.** Anything needing a model to evaluate. A gate that is itself a
judgement is a gate that is sometimes wrong in ways nobody can predict, and the value of everything
above is that it produces the same answer every time and can be argued with.

### The rule that matters more than any of the rungs

> **A gate that holds good work is a gate somebody deletes — and then the bad work ships too.**

Every check you add, test against three or four sentences a real practitioner in that trade would
actually write, and assert they pass in **silence**. `ship-checks.test.ts` does this with a
bookkeeper's close, a GEO summary and a contractor's timesheet note. If your check fires on any of
them, it is wrong, however good the intention.

This is why `forbids` is opt-in per field rather than global: "leverage" is marketing slop on a
homepage and an ordinary word in a note about a leverage ratio.

---

## 4. What has to be in the room that isn't ours?

The last question, and the one that decides how much of the trade you can actually run.

- **What software does the work live in?** If it is a browser and there is no API, the task type
  declares `harness.shape: "operate"` — which gives it a real Chromium and, deliberately, takes away
  its ability to send, charge or publish. A written service may declare that shape for exactly this
  reason.
- **What does the client have to hand over, and when?** Declare it as an intake ask. A run that
  discovers halfway through that it needs a bank statement has already spent the money.
- **What does the studio do outside this system?** Say so and design around it rather than pretending.
  `site-studio` does not build the site — studios build in Webflow, Framer, WordPress and by hand, and
  a wedge that only works when we build serves almost none of them. Scoping, revision discipline,
  launch and handover are the same work whatever the stack, and they are where the money leaks.

---

## The shape of a finished fit

```
wedges/<slug>/
  wedge.json
    task_types.<job>.description       what it is, and which skill to read first
    task_types.<job>.output_schema     the shape, with enums doing free work
    task_types.<job>.ship_requires     which fields must carry something
    task_types.<job>._comment_ship_checks   WHY each gate exists, in the trade's terms
    task_types.<job>.ship_checks       the gates
  skills/*.md
    one file per expensive failure mode, named after the failure
```

Skills are named after the failure, not the topic: `nobody-remembers-the-redirects`, not
`launch-process`. A file named after a topic gets written as a summary of the topic. A file named
after a failure gets written as an argument, and an argument is what changes what an agent does.

Every `ship_checks` entry gets a `_comment` saying which craft rule it encodes. A gate whose reason
is not written down is a gate the next person deletes when it fires inconveniently — and they will
be right to, because they cannot tell a considered constraint from a guess.

---

## What this method is not

It is not a way to make a model an expert. Nothing here teaches a trade; it **constrains** one, and
the constraint is only as good as the practitioner it came from. The interview is the work. This
document is how you turn the interview into something that holds.

And it does not remove the human. Every gate here decides whether work reaches a client
*unreviewed* — a failed check holds the work for the founder, it never fails the run. The ambition is
not that nobody looks. It is that when somebody does look, they are looking at work that has already
passed everything a machine could have caught, so their attention is spent on the thing only they
can judge.
