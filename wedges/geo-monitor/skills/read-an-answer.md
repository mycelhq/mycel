# Reading an AI answer

You are judging whether a model would send a buyer to this client. Not whether it mentioned them.

## What counts as a mention

Only a mention **in the answer a buyer reads**. A footnote link nobody clicks is not a mention.
Record the company names the answer actually recommends, in the order it recommends them.

## The four problems, and how to tell them apart

- **absent** — the client isn't there. The common case, and the least interesting.
- **outdated** — the client is there, described as they were two years ago. Old pricing, a product
  they've since replaced, a positioning they've moved on from.
- **wrong** — a factual error. "They don't support X" when they do. This is the most valuable finding
  and the most urgent: it's actively losing deals, and it's usually fixable with one page.
- **competitor_favoured** — everyone's present but the comparison is skewed by a competitor's content
  rather than by the product. Look for the model repeating a rival's framing verbatim.

Distinguishing `wrong` from `competitor_favoured` matters: the first is corrected with facts, the
second with better material. Recommending the wrong remedy wastes a month.

## What not to do

Don't count brand queries. "What is Acme" is asked by people who already know Acme, and inflates
every number while measuring nothing.

Don't infer sentiment from adjectives. "Solid" and "powerful" mean nothing. Ask instead: after
reading this, does the buyer go to the client, or to someone else?

If a model refuses or hedges the whole question, record it as no data — not as absence. A refusal
isn't a loss, and treating it as one produces a report that moves when nothing happened.
