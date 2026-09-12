---
name: research-a-service
description: Go and find out how a service is actually delivered, before we write a version of it. Everything you report names where you found it.
task_types: [research_service]
---

# Research a service

Somebody has told us what they sell in one line. Before we write the service they will run, go and
find out how this work is actually done by the people already doing it.

You have a browser and search. Use them. **Nothing you report may come from memory.**

## Why this job exists

The two jobs either side of this one — the shape, and the service itself — run with no network at
all. They work from what the founder typed and what the model already believes. That is right for
the first screen, which has to answer in twenty seconds. It is not enough to write somebody's
business.

A service written from priors reads plausibly and is wrong in the specific way that costs a client:
it names the deliverables a service like this usually has, in the order a page usually lists them,
at a price that sounds about right. The founder can't tell. Their client can, immediately, because
their client buys this service.

## Everything carries a source

Every finding has a `source` field and the gate refuses the output without one.

A URL does not prove a claim. That is not what it is for. It is there because **a model asked to
cite is a model that had to go and look**, and the difference between reading three real firms'
service pages and recalling what such a page usually says is invisible in the prose and total in the
result.

So: open the page. Read it. Quote what it says. If you cannot open anything, say so — see below.

## What to look for, in order

1. **Three or four firms that actually sell this.** Not directories, not "top 10" listicles — the
   firms themselves. Their services page, their pricing page, their case studies.
2. **What the client receives.** The nouns. "A monthly reconciliation pack" not "we handle your
   books". If three firms all list the same four things, those four things are the service.
3. **How it gets produced.** The steps, in order, and who does each one. This is the part that
   becomes the job the harness runs, so it matters more here than anywhere else.
4. **What it costs.** A RANGE, from real published prices. If nobody publishes a price — common in
   this trade — leave it out entirely. A single number invented from three data points gets quoted
   back to the founder as market rate and they price against it.
5. **What goes wrong.** Reviews, forum threads, complaints. This is the most valuable thing on the
   page and the hardest to find. A service that knows how it disappoints people is a service that
   can be written not to.

## What the buyer assumes is included

Look for what clients ask about that firms have to say no to — an FAQ, a "what's not included"
section, a Reddit thread of somebody annoyed. `client_expects` is that list, and the out-of-scope
section of every proposal we write gets built from it.

This is the cheapest thing you can find and one of the most useful, because it is the argument that
happens in month three of an engagement nobody scoped properly.

## When you are blocked

`reached: false` with a one-line reason. It is a good answer.

The service still gets written; it gets written from priors, which is what happened before this job
existed. That is a worse service and a known one. **A fabricated market is not a worse service, it
is a wrong one** — and it is the only outcome here that makes this job worse than not running it,
because it launders a guess into something that looks researched.

Do not work around a paywall. Do not solve a captcha. Do not sign in to anything.

## What you are not doing

You are not writing the service. You are not deciding whether we can run it. You are not talking to
the founder. You are reading what is already public about a trade, and writing down what you found
and where.

## The arithmetic of the trade

Two of the fields matter more than the rest, because they do not describe the service — they become
the gates the finished work has to pass before a client sees it.

### `identities` — what has to add up

Every trade has relations a practitioner expects to hold, and they are the first thing one of them
will tell you:

- a recruiter: presented plus rejected plus shortlisted equals screened
- a studio: hours times rate, less the deposit, is the balance
- a bookkeeper: the statement balance plus outstanding items equals the book balance
- a visibility report: share of voice is mentions over queries

None of these can be worked out from a schema. All of them are written down somewhere by somebody
who does the work.

Report the **shape**, never a check name: `sum_of_list`, `difference`, `ratio`, `count_of_list`,
`unknowable`. Name the fields with the plainest word for the thing — a name that does not end up in
the finished service is dropped rather than guessed at, so `total` beats `grand_total_amount_field`.

**Only report what you actually found somebody state.** An invented identity fails correct work, the
founder waits, and the second time it happens somebody deletes the gate — which costs every real one
with it. If a trade has no arithmetic, say nothing here. That is a true answer.

### `mechanics` — the structure a novice does not know

Not the steps. `steps` already has those. This is the part of a trade that reads as arbitrary until
somebody explains it, and it is the difference between work that passes and work that wins:

- in SEO, how pages link to each other and how a topic cluster is arranged
- in tax, the order reliefs are applied, because the order changes the answer
- in recruiting, how a scorecard is anchored so two interviewers agree
- in construction, how a rate build-up separates labour, plant and materials

Look for the thing practitioners argue about, or the thing a trade's own guides spend the most words
on. That is usually it.

## Where to look, in order

The people doing the work write it down, and almost never on the pages selling it. **A sales page
tells you what a service is CALLED. These tell you how it is JUDGED.**

Work down this ladder. Stop when you have what you need — but start at the top, because a fact from
rung one is worth more than five from rung four, and your findings are scored on where they came
from.

**1 — The trade defining itself.** A regulator, a trade body, a standard, a professional
qualification's syllabus. The filing window, the statutory response period, the code of practice, the
competency framework. These are not opinions; they are the rules the trade is held to.
Search shapes: `"<trade>" standard OR "code of practice" OR guidance`, `"<trade>" syllabus`,
`site:gov.* "<trade>" requirements`.

**2 — The software the trade lives in.** Vendor documentation, API references, field guides, support
articles. **The fields a system makes MANDATORY are the trade's own opinion about what a job must
contain** — often more honest than its prose, because somebody had to make it work. A claims system
that requires a denial code is telling you denial codes are the job.
Search shapes: `docs.<vendor>.com "<artefact>"`, `"<trade> software" documentation fields`.

**3 — Practitioners writing at length.** A long-form post, a forum thread, a Q&A answer, a subreddit
argument. This is where the EXCEPTION PATH lives: what actually goes wrong, how often, and what they
do about it. A standard tells you the process; a practitioner tells you which step everybody dreads.
Search shapes: `"<trade>" "how I" OR "what I learned" denial OR rejection OR chargeback`,
`reddit.com/r/<trade>`, `"<artefact>" problem thread`.

**4 — Open source and public templates.** Where a trade has tooling, somebody has published a schema,
a form, a validator, or a checklist. A repository's data model is a specification of the trade
written by someone who had to make it run.
Search shapes: `github.com "<trade>" schema OR template OR forms`, `"<artefact>" json schema`.

**5 — Sales pages.** Last, and worth little for mechanics. Real evidence of what the service is
CALLED and what buyers are promised — which is what `client_expects` is for — and near-worthless for
`mechanics` and `what_goes_wrong`.

## How long each deliverable takes — `typical_hours`

For every entry in `deliverables`, how long a COMPETENT PRACTITIONER takes to produce it once.
Not how long an agent takes: that is a fact about us, and this is a fact about the trade.

This is the only input to what any of this is worth. Hours saved is the measure a service business
already thinks in, already bills in, and can check against its own experience — and without a number
here every delivered piece of work can be counted and none of it can be valued.

Where it is stated outright: a rate card with a fixed fee beside an hourly rate (divide), a trade
body's guidance on chargeable time, a practitioner writing "this takes me a morning", a job listing
describing a monthly workload. Search shapes: `"<artefact>" "hourly rate" OR "fixed fee"`,
`"how long does" "<artefact>" take`, `"<trade>" chargeable hours guidance`.

**Omit it rather than guess.** An invented hours figure does not sit quietly in a schema — it is
multiplied by a rate and shown to a founder as what the product saved them, and it is the number
they will repeat to a buyer. A missing hours figure is counted honestly as unestimated. A wrong one
is a lie with a decimal point.

## Find the work itself, not only the rules — `artefact_examples`

Everything above teaches the PROCESS. None of it shows what the finished thing looks like, and a run
that knows every rule of a trade and has never seen its output writes a correct document nobody in
that trade would recognise.

So find two or three REAL SPECIMENS. Not a page describing a deliverable — the deliverable. A
regulator's model return. A trade body's worked example. A published sample report. An anonymised
case study with the artefact attached. A template a practitioner released because they were tired of
rebuilding it.

Search shapes: `"<artefact>" "sample" OR "example" filetype:pdf`, `site:gov.* "<artefact>" model OR
specimen`, `"<trade>" "worked example"`, `github.com "<artefact>" template`.

**What to write down is WHY it is good**, not that it is. A specimen with `why_good: "professional
and well laid out"` is worth nothing to the run that reads it. `"It reconciles the opening balance on
page one, so the reader knows the numbers tie before they read any of them"` is a property that can
be copied. One concrete property beats a paragraph of praise.

**Two or three, not ten.** These get read closely; a pile gets skimmed. Prefer specimens from rung
one or two — a regulator's model document is how the trade is judged, a random agency's sample is how
one agency sells.

**If you cannot find a real one, leave it empty and say so in `blocked_by`.** Describing an example
you did not open is a fabrication with a citation attached, and it is worse here than anywhere else
in this job: the run downstream will copy it.

## What a good research pass looks like

**Spread across publishers, not pages.** Five citations to one blog is one opinion. Three publishers
on rung one or two beats ten pages from the same site.

**Every finding carries a source that a reader can open.** A finding nobody can check scores zero and
is worse than an absent one, because it looks like knowledge. If you know a fact but cannot cite it,
put it in `blocked_by` and say where you would have looked.

**Name the artefacts in the trade's own words.** Not "the document" — the EOB, the rate confirmation,
the validation notice, the retention release. Those words are what make the service that gets written
from this recognisable to somebody who does the job.

**Go after the exception path deliberately.** The happy path is easy to find and is the part that
already works. What is scarce and valuable is the denial, the rejection, the resubmission, the
missed deadline, the non-payment — search for those by name.
