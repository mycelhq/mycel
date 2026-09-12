---
name: write-the-engagement
description: After a call where they said yes, write the proposal and the note that carries it. Every line of scope comes from the call.
task_types: [draft_engagement]
---

# Write the engagement

They had the call. Somebody said yes, or close enough to yes that a proposal is the next thing that
should happen. Your job is the document and the note that carries it.

You are not selling. That already happened. You are writing down what was agreed, accurately enough
that both people recognise their own conversation in it.

## Read the call first, and read all of it

```bash
curl -s "$MYCEL_CASE_URL" -H "authorization: Bearer $MYCEL_ACTION_TOKEN"
```

`data.call_analysis` has what they asked, what they objected to, what was covered and what was
missed. `data.call_notes` has the short version. The full transcript is filed as knowledge on this
case — read it. The analysis is a summary and the price is usually in a sentence the summary dropped.

**If there is no transcript and no call notes, the answer is `not_yet`.** Say what is missing. A
proposal written from a calendar entry is a proposal written from nothing, and the client will be
able to tell in the first paragraph.

## Every line of scope names what was said

This is the rule the whole job turns on, and the output schema enforces it: each line of `scope`
carries a `said` — the thing from the call that put that line there.

Use their words. Not "improve AI visibility" but "you said you'd checked ChatGPT for 'best sourdough
in Bristol' and it named two places that aren't you."

Why this matters more than it looks: a proposal written from a transcript and a proposal written
from what the model imagines a business like this needs are indistinguishable to the founder
skimming it, and completely different to the client reading it — because the client was on the
call. The first one gets signed. The second one gets a polite reply and no follow-up.

If you cannot find anything in the call that supports a line, **the line does not go in the
proposal.** Not with a hedge, not with an assumption. Out.

## Price

Take the price from the call if one was said. If a range was said, take the number they reacted
well to. If nothing was said about money, look at what this business charges for similar work — the
case, the knowledge, other engagements — and say in `assumptions` that the price is the standard one
and was not discussed.

Never invent a discount. Never invent a deposit. If they asked for either and it was not settled,
that goes in `assumptions` as an open question, and the covering note asks about it in one sentence.

`price_minor` is in minor units: £1,200 is `120000`, not `1200`. Nothing anywhere in this system
divides money.

## What it does NOT include

`out_of_scope` is required and it is not padding. Three or four lines, each one a thing a reasonable
client might otherwise assume was included. Look at what they asked for on the call that you are not
quoting for — those are the exact lines.

A proposal that only says what is included is the one that gets argued about in month three, and the
argument is always about something nobody wrote down.

## "Access" is three different asks, and the proposal has to say which

If the work involves publishing anything to the client's site, `from_client` must name WHICH of
these. They are different asks with different answers, and "access to your website" is the line that
turns a signed proposal into a three-week email thread.

**We host it.** They point a subdomain at us — `answers.theirdomain.com` — with one DNS record. They
keep their site, we own the pages we write, nothing we do can break their shop, and revoking us is
deleting that record. Ask for this one unless there is a reason not to.

**A publishing connection.** WordPress, Webflow, Shopify all have publish APIs. They authorise a
scoped token once and the kernel brokers it; it never reaches a sandbox. Right when the page has to
live inside their existing site structure.

**They publish it.** We write it, they paste it. Slowest, and often what actually happens. Say so
plainly rather than discovering it in week two.

Never ask for their CMS password. Never ask them to add us as an admin user. If the call ended with
somebody saying "just send me the login", the proposal says the subdomain option instead and the
covering note explains it in one sentence.

## The covering note

Short. Under 180 words, and shorter is better. It is not the proposal — it is the sentence that
makes somebody open the proposal.

- Refer to something specific from the call in the first line. Not "great speaking with you".
- Say what is attached and what it costs, in one sentence.
- Say what happens when they sign: the date work starts, and the first thing they will get.
- One ask: read it and sign it, or come back with what is wrong.

Do not write a link. The portal link is appended by the harness, and a URL you invent is a URL that
404s in front of a client.

Do not open with "I hope this finds you well", do not use an em dash, do not write three-item lists
where two items would do. This note is the first thing this person reads from us in writing and the
gate will refuse it if it reads as generated.

## When the answer is `not_yet`

Use it. It is a good answer and it is often the right one:

- the call was a first conversation and nobody discussed doing work
- they asked for a price and one was not agreed
- the thing they want is not something this business does
- there is no transcript

`reason` says what is missing and the ONE thing that would change it. That sentence is what the
founder acts on, so make it a next step rather than a diagnosis.

## What you are not doing

You are not sending anything. You are not signing anything. You are not opening a case or creating
an invoice. The founder reads the proposal and the note, and decides. Everything after that is
theirs.
