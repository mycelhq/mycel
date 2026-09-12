# rally

A local, multi-seat LinkedIn runner for launch day. Runs on the founder's laptop, on the founder's
own home connection, driving one real Chrome profile per account at human pace.

Deliberately **separate from the outbound product**: different risk model, different machine,
different lifetime. It borrows the people list from Postgres and owns everything after that.

## Why local, and why a visible browser

A LinkedIn session is bound to the browser and IP that created it. Running here means the session
lives on the residential IP it was born on — strictly better than any ISP proxy we could rent, and
it removes the whole proxy problem.

Headless is not an option. Headless Chromium sets `navigator.webdriver`, ships empty plugin and
mimeType arrays, and leaks `HeadlessChrome` in the UA. Any one of those sorts this traffic into a
different bucket, and three of these accounts belong to somebody's family. So: real Chrome,
visible, one persistent profile per seat.

## The pacing, and why it exists

The production worker's first ever invitations went out at 13:00:33, 13:00:41, 13:01:04, 13:01:10,
13:01:16 — **five in 43 seconds** — and the sixth came back 429. That was misread as "the weekly
allowance is exhausted"; the account had sent five invitations in its entire life, so it plainly
was not. It was throttling.

`pace.ts` enforces four independent brakes, and `test/pace.test.ts` replays those five exact
timestamps as a regression:

| brake | what it prevents |
|---|---|
| gap ≥ 45s, jittered to 180s | the machine-gun signature that earned the 429 |
| ≤ 6 actions per rolling 10 min | six quick ones then a pause, which averages out fine and still isn't a person |
| daily ramp (see below) | a dormant account suddenly sending 20/day |
| weekly ceiling | LinkedIn's own allowance — **measured, not assumed** |

Every brake is a **wait**, never a failure. Booking a self-imposed brake as an error is how a
healthy account gets marked dead.

## The weekly ceiling is a reading, not a setting

The first version hardcoded `weeklyInviteCap: 100`. That was a guess dressed as a fact: the
published figure is the common case, not the rule, and the real allowance varies with account age,
connection count and past acceptance rate. Nothing about our configuration changes it — setting
ours to 300 would not buy 300 invitations, it would buy the account's real number plus two hundred
refusals, and repeated refused writes are what earns a challenge.

So each seat discovers its own. It probes up to `weeklyProbeCeiling` (220), and the **first** time
LinkedIn says the limit is reached, the count at that moment is recorded and respected from then
on. One refusal per seat per month is the entire price of knowing the truth. The board shows it as
`week/cap`, with `?` while the seat is still probing.

A reading older than four weeks is discarded and the seat probes again — LinkedIn raises an
account's allowance as it earns trust, and a bad week should not hold a seat down forever.

## Two pace profiles

An account with outreach history and a dormant one belonging to somebody's sibling are not the
same risk. Mark the former with a trailing `!` at connect time:

```bash
npm run rally -- connect 'me!' sibling1 sibling2 friend1
```

| profile | daily ramp |
|---|---|
| `default` (family accounts) | 8 → 12 → 16 → 20 → 25 → 25 → 30 |
| `established` (`me!`) | 20 → 25 → 30 → 35 → 35 → 40 → 40 |

The gap and burst brakes apply to both: those are about looking human, which is not negotiable
for anybody.

## The split: the machine decides, you click

The first version drove the browser — find Connect, click it, handle the modal. That breaks the
moment LinkedIn moves a selector, and it spends account trust on every attempt, on accounts
belonging to your family.

It was also solving the wrong half. Clicking Connect takes two seconds. The hard part is knowing
**who** to click, from **which** of four accounts, in what order, and when to stop for the day —
bookkeeping across four accounts and a thousand people that nobody can hold in their head.

So: the machine owns the queue, the priority, the per-seat budget and the record. You own the
click. Nothing here automates LinkedIn, so there is no selector to break and no automated
behaviour to detect — the traffic is a person, because it is one.

## Always on

```bash
RALLY_LAUNCH_AT=2026-09-15 npm run rally -- up
```

Installs a launchd agent that starts the CRM at login and restarts it if it dies —
`http://localhost:5174`, always there. `rally down` removes it. Log: `~/.mycel/rally/crm.log`.

`KeepAlive` is the point: "always open" cannot mean "until something goes wrong at 3am on launch
day". The plist carries `AWS_PROFILE` and `HOME` explicitly, because launchd starts with almost no
environment and without them the Sync button silently stops reaching Postgres.

## Use

```bash
cd packages/rally && npm install

# 1. register the accounts. `me!` gets the faster ramp (it has outreach history).
npm run rally -- seats 'me!' sibling1 sibling2 friend1

# 2. pull the list, ranked
export DATABASE_URL=...            # the product's Postgres, read-only
npm run rally -- import producthunt

# 3. work a seat. Opens each profile in your browser; you click Connect.
npm run rally -- work me
```

```
  me — 20 invitations to send today  (established pace)
  enter = sent it   ·   s = skip   ·   q = stop for now

  [1/20]  Dario Pironi
     maker · launched 2d ago · Wispr Flow
     https://www.linkedin.com/in/dariopironi/
```

Then, as people accept:

```bash
npm run rally -- accepted me "Dario" "Dalena"
npm run rally -- status          # who replied · who went quiet · who is unasked
```

## What it says, and when

The message changes with the date, because the same sentence is wrong on two different days:

| phase | message |
|---|---|
| 2+ days out | "We're launching on Product Hunt on 15 September. I'll send you the link on the day." |
| the eve | "We're launching tomorrow — would you take a look when it's live?" |
| launch day | "We're live on Product Hunt today. `<link>`" |
| after | stops asking entirely |

Before the launch you are asking somebody to *remember* something, which is a favour they will
probably forget. On the day you are asking them to *click* something, which takes eight seconds.
The first message exists to earn the right to send the second.

After launch day `rally work` refuses to send. A message about a day that has passed tells the
reader you are not paying attention — and the product's own Product Hunt campaign sat paused a
week past its date because nothing checked.

```bash
export RALLY_LAUNCH_AT=2026-09-15
export RALLY_LAUNCH_URL=https://www.producthunt.com/posts/mycel   # on the day
```

## Does it need the laptop open?

Yes — and less than you would think. Closing an Apple Silicon MacBook sleeps it; `caffeinate`
prevents *idle* sleep, not lid-close sleep, so nothing runs either way. Automating it fully does
not change that: a loop on a sleeping laptop is just as asleep.

But the whole fleet's day is **44 invitations ≈ 37 minutes** of open time, because the pacing is
the point. Any 40 minutes will do, and the pacing treats the gaps as normal. Launch day is the one
that wants real coverage — keep it open and plugged in, or move the whole thing to an always-on
machine on the same home connection.

## Priority

A Product Hunt rally is not ordinary outbound. The audience is people **active on Product Hunt
right now**, because those are the ones still there on launch day — so recency of their own launch
is the strongest signal, and it decays fast. Makers outrank everyone else: they have launched, they
know what the day costs, and they turn up for other people's.

Every row carries the sentence explaining its rank (`maker · launched 2d ago · Wispr Flow`). A
ranked list nobody can audit is a ranked list nobody trusts.

## Topping the list up every morning

```bash
RALLY_LAUNCH_AT=2026-09-15 npm run rally -- daily install
```

A launchd agent at 08:10 daily, walking the last two days of Product Hunt and folding new makers
into the queue. launchd rather than cron because the scrape needs your GUI session — it drives a
real visible Chrome, which is the whole reason it gets past Cloudflare. It stops itself once the
launch date passes. `rally daily uninstall` removes it.

## What the board answers

Who replied · who read it and said nothing (the cohort worth one more touch) · who is still
waiting to be asked. Per seat and in total, with accept and reply rates.

## Keep the Mac awake

A closed laptop sends nothing:

```bash
caffeinate -dimsu npm run rally -- run
```

## State

Everything is in `~/.mycel/rally`: one SQLite file and one Chrome profile per seat. **No password
is ever stored** — `connect` uses it once and drops it; from then on the session is the browser
profile, exactly as it would be if a person had typed it.
