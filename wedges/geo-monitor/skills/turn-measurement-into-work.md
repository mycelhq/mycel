---
name: turn-measurement-into-work
description: How to turn a visibility measurement into recommendations an agency can actually execute and bill for. Read this before writing any weekly report or verdict — the number is the hook, the work is the product.
---

# Turn the measurement into work

A share-of-voice number is a diagnosis. Nobody pays a retainer for a diagnosis they can get free in
thirty seconds, and the agency reading this report has to justify it to *their* client on Friday.

So every report answers three questions in this order, and the third is the one that renews:

1. **Where do they stand?** The number, and what it means.
2. **Why?** The mechanism, not the metric.
3. **What do we do this week?** Named, ordered, sized work.

A report that stops at 1 is a screenshot. A report that stops at 2 is an opinion. Only 3 is a
deliverable.

## The mechanism: selection is not absorption

The single most useful distinction, and almost nobody makes it.

- **ABSORBED** — the model knows the brand from training. It says the name without being shown a
  source. Slow to earn, slow to lose, and largely out of anyone's control this quarter.
- **SELECTED** — the assistant ran a retrieval and chose their page as a source *for this answer*.
  Fast to earn, fast to lose, and **entirely** what an agency can be paid to influence.

Read the probe results for which one happened. A brand that is never absorbed but often selected is
healthy and improvable. A brand that is occasionally absorbed and never selected is coasting on
history and will decay. **Say which it is** — an agency that understands this can sell twelve months
of work; one that only sees a percentage cannot.

## The week's work is source repair, not a screenshot

Agencies that get paid for GEO do not stop at a dashboard. HyperMind, iPullRank, and the better
mid-market shops run the same sequence. Copy it. Do not invent a fourth:

1. **Measure** — citation ledger, not a one-shot prompt. For each query × surface: was the brand
   *present* in the answer, and *cited* when present? Track those as two numbers over a trailing
   window. A single check is noise.
2. **Diagnose** — selected vs absorbed (below). Writing problem vs retrieval/entity problem.
3. **Repair the owned source this week** — one page, answer-first, complete enough to live on their
   domain. That is `ship_page`. A two-paragraph stub is not repair.
4. **Entity consistency** — same product, place, and price names on the site, GBP, LinkedIn, and
   Organization schema. Recommend the mismatch. Do not invent a Wikipedia page they are not
   eligible for.
5. **Off-page** — mentions on domains the engines already trust. **Large.** Digital PR is next
   month, not this week's HTML.

`llms.txt` is not a workstream. Practitioners who calendar'd it have dropped it.

When recommending work, the Small is almost always source repair on one owned URL. The Medium is a
new page in the genres below. Entity cleanup and off-page are named, sized, and not drafted as this
week's hosted page.

Recommendations must name the shape of the page, not the keyword. Retrieval picks passages, and the
passages that get picked share properties:

- **Answers a question in its first two sentences.** Not a preamble, not a brand story. Assistants
  extract the span that answers; a page that buries the answer at paragraph six loses to one that
  does not.
- **Self-contained.** A passage that needs the rest of the page to make sense cannot be lifted. Each
  section should survive being quoted alone.
- **Specific and checkable.** Numbers, dates, named constraints, prices, hours, service areas.
  "Fast turnaround" is unquotable; "most jobs completed within three working days" is a citation.
- **Structurally obvious.** A real question as a heading, the answer immediately under it. Comparison
  tables. Definition lists. These are not SEO tricks; they are the shapes an extractor can parse.
- **Attributable.** A named author, a date, a business that clearly exists. Models weight sources
  they can attribute.

## The genres that earn citations

When recommending work, recommend one of these. They are ordered by how reliably they get picked:

1. **The direct-answer page.** One question, answered in the first two sentences, then the rest of
   a commercial page (table, process, FAQ). "How much does X cost in Y?" These win because they
   match the query shape exactly — and they only get accepted if they look like a site, not a stub.
2. **The comparison.** "X vs Y for Z." Assistants are asked to compare constantly and have thin
   material to work with. An honest comparison that admits where the competitor wins is cited more
   than a puff piece — models are unimpressed by pages that never concede anything.
3. **The original number.** Anything they measured that nobody else has: a survey, their own job
   data, regional pricing. Original data is the only genre a competitor cannot trivially copy, and
   it earns citations for years.
4. **The definitive explainer.** The page you would send someone who asked the question in person.
5. **The local answer.** "Best X in Y" — thin nationally, winnable locally, and it is where a
   service business actually competes.

## Sizing, because an agency has to schedule this

Every recommendation carries an effort so the agency can put it on a calendar and price it:

- **Small** — an edit to an existing page. Rewrite the opening two sentences, add a heading with the
  real question, insert a number they already know. Hours.
- **Medium** — a new page in one of the genres above. A day or two.
- **Large** — original data, a research piece, a structural rebuild. Weeks.

**Give at most three recommendations, and lead with a Small.** A list of twelve is a list nobody
starts. One small win this week beats a strategy deck, and the small win is what proves the retainer
was worth paying before the invoice arrives.

The kernel drafts that Small (or the first Medium) as a live page after this report lands —
`ship_page`. You do not POST that task. You write the recommendation specifically enough that a
page can be authored from it: name the URL or the new slug, name the question, name the checkable
fact they already have. A theme ("improve the pricing page") is not enough; "rewrite the opening
of /pricing so the first two sentences state the three-working-day turnaround" is.

A Large recommendation is advice for a later month. It will not be drafted this week.

## What never to recommend

- **Keyword density, meta keywords, or word count.** Not the mechanism. Recommending them tells a
  competent agency you do not understand this, and it is the fastest way to lose the account.
- **"Publish more."** Volume without shape is noise, and it is the advice they have already tried.
- **Anything unfalsifiable.** "Improve brand authority" cannot be done, checked, or billed.
- **Fabricated causation.** If they rose four points and nothing was shipped, SAY the movement is
  unexplained. Assistants re-rank on their own and claiming credit for noise is the claim that
  destroys trust the first time it is checked.

## When the number is bad

The instinct is to soften it. Do not. An agency forwards this to their client, and a report that
buries a zero is one they cannot forward.

State it plainly, then immediately name the smallest thing that would change it. **"Invisible across
all twelve queries. The fastest change is the pricing page: it answers the question in paragraph
four, and moving that answer to the top is a one-hour edit."** That is a sentence an agency can send
to their client without embarrassment, and it is why they keep paying.

## When the number is good

Say what is holding it up, so they know what to protect. A brand selected because of one
well-structured page is one redesign away from losing it — and telling them that before it happens
is the difference between a vendor and an advisor.

## Worked example — the bar, not a template

Everything above is rules. This is what a finished mid-report block looks like when the rules are
followed. **Match the depth and the specificity, never the facts** — the client, the numbers and
the pages below are illustrative, and reproducing any of them in a real report is fabrication.

> **Where you stand.** Present in 4 of 12 tracked answers this week (last week: 3), cited in 2.
> Both citations came from the same page — /guides/boiler-service-cost — which means your entire
> visibility currently hangs on one URL.
>
> **Why.** This is selection, not absorption: the assistants are retrieving that guide per-answer,
> not recalling your brand from training. Selection is the good kind — it responds to work within
> weeks — but it is also fragile: the two queries where you lost presence this week
> ("emergency plumber costs", "boiler service near me") both retrieve competitors whose pages
> answer in the first two sentences. Yours answer in paragraph four.
>
> **This week:**
> 1. **Small — rewrite the opening of /services/emergency.** The page states your call-out fee
>    (£95) in paragraph four, under the brand story. Move it to the first sentence, phrased as the
>    answer: "An emergency call-out costs £95 day or night, including the first hour." One hour of
>    work; it targets the exact query you lost this week.
> 2. **Medium — a comparison page: "Fixed-price vs hourly emergency plumbing".** Assistants are
>    asked this constantly and currently cite a trade forum. Concede honestly where hourly wins
>    (small jobs under 30 minutes); the concession is what makes the page citable.
> 3. **Large — for next month, not this week: your own call-out data.** You have 1,400 completed
>    jobs with time-to-arrival. Nobody else has this number. Published as a regional table, it is
>    the one asset a competitor cannot copy.
>
> Movement note: the rise from 3 to 4 is within normal reshuffle and nothing shipped last week —
> we are not claiming it.

Why this passes the bar: the number leads and is not softened; the mechanism is named (selected,
not absorbed) with the consequence spelled out; every recommendation names a URL, a fact they
already hold, and an effort size; the Small targets a query lost *this week*; the unexplained
movement is disclaimed instead of claimed. A report of half this depth is not finished.
