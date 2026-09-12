---
description: The site improves itself — read `mycel-insight` BEFORE you touch the marketing page, and obey the verdict literally. What a conversion is, how the A/B loop is wired, and the one mistake that thrashes a client's homepage forever.
---

# Read the evidence before you change the page

`app/page.tsx` is the founder's front door. It is the one page a stranger sees, it is the page they
will rewrite after every third sales call, and it is the only page in this app whose effect can
actually be measured. So it is the one page you must not change on taste.

**Before any edit to `content/marketing.ts` or the hero, run:**

```bash
mycel-insight 14      # last 14 days, this project only
```

If the tool is not installed, this run has no evidence plane. Say so in your final message and make
only the change you were asked for.

## The loop you are standing in the middle of

1. `middleware.ts` assigns a visitor to an arm (`mkt_variant` cookie) and renders exactly one hero.
2. On their **second** request — the first that comes back carrying the cookie — the exposure is
   recorded. (The delay is the bot filter: crawlers do not keep cookies. See `onMarketing`.)
3. If that visitor later reaches `/portal`, and they are not already a client, and it is not a link
   prefetch, and they have not been counted before — that is a **conversion**.
4. The kernel compares the arms and decides whether the difference means anything.
5. You read the decision and rewrite the loser.

**A conversion is "reached the client portal after seeing the marketing page".** Not a sale — this
page cannot observe a sale, and a metric that pretended otherwise would be a fiction. It is the one
thing `/` actually asks a stranger to do: `PortalCta`, twice, both pointing at `/portal`. It
measures intent, and that is a real signal and a proxy. Say "intent" if you report it.

## What to do with the answer

Look at `experiment` in the JSON. Nothing else in the payload decides this.

| | |
|---|---|
| `winner` is a string | Rewrite the arm named in `loser`, in `content/marketing.ts`. |
| `winner` is `null` | **Change nothing about the hero copy.** Read `verdict`. |
| no `experiment` key | The product runs no A/B test, or nothing has been recorded. |

When there is a winner, the rewrite has exactly one shape:

- Write a **new attempt to beat the winner** in the loser's slot.
- **Do not delete the losing arm.** `VARIANTS` with one entry is not an experiment; the next change
  would have nothing to be measured against, and the loop stops here.
- **Do not copy the winner into the loser.** Two identical arms produce a 50/50 split of identical
  pages forever, and a `verdict` that will never again say anything.
- Change the **hero only** — eyebrow, headline, subhead, CTA label, CTA note. Those five strings are
  what the experiment varies. Rewriting the services, figures or testimonials at the same time makes
  the next result uninterpretable, because two things moved.
- Say in your final message which arm won, on how many exposures, and what you replaced.

## The one mistake that matters

**Do not compute your own winner from `arms`.**

The rates are in the payload so the numbers are auditable, not so they can be eyeballed. A 2:1 split
on three visitors is a coin landing heads twice. An agent that rewrites on that will watch the noise
move, rewrite it back, and thrash a paying client's front door forever — and every iteration will
look justified, because the numbers really did change.

The kernel's threshold (`insight/experiment.ts`) already accounts for the sample size, for how few
outcomes each arm has, for the fact that this summary gets read repeatedly rather than once, and for
whether the difference is big enough to be worth a deploy. **A rate that looks better is not a rate
that is better.** If `winner` is `null`, the honest answer is that you do not know yet.

`verdict` distinguishes the two kinds of `null`, and they want opposite responses:

- *Too little traffic* → **wait.** The hypothesis is fine; there is not enough evidence yet. It says
  roughly how many more visitors are needed.
- *Within noise* → the arms are too similar to tell apart. **Do not reshuffle words.** If you are
  asked to try again, test a genuinely bolder difference — a different promise, not a synonym.

## The rest of the payload

`headline` and `attention` are one-line conclusions the kernel has already drawn; quote them rather
than re-deriving them. `thin: true` means there is too little of everything to conclude anything —
read it before the numbers, not after. `funnel.biggest_drop_off`, when the product declares a funnel,
names the step losing the most people, which is a portal question rather than a marketing one.

## What is not in it, and will not be

No visitor, ever. No IP, no user agent, no referring page, no URL, no session, no anonymous id, no
per-person timeline — none of it is redacted afterwards, it is never collected. The people being
counted are a paying client's own customers, who agreed to nothing with us; the entire record is
"this many browsers saw this arm, this many of them asked for the portal".

Do not add a tracker to fix that. There is no analytics vendor in this app and adding one is the
founder's decision, not yours — `lib/insight.ts` explains what is sent instead and why it is sent
from the server. If you genuinely need a new measurement, add a server-side event next to the ones
already there and nothing else.
