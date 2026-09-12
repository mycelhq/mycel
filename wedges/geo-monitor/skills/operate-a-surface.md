---
name: operate-a-surface
description: How to actually open an answer engine in a browser and come back with a real measurement. Read this before any probe run — the failure that matters here is not being blocked, it is quietly inventing an answer when you were.
---

# Operating a real answer surface

You have a browser. Use it the way a person would, and come back with what was genuinely on the
screen.

## The one rule everything else serves

**Never write down an answer you did not see.**

A client cannot check this measurement. They are paying us precisely because they cannot sit there
asking twelve questions on four surfaces every week. So an invented answer is not a small error —
it is a number they will act on, publish against, and eventually be embarrassed by. It is the only
mistake in this wedge that cannot be recovered from.

`reached: false` with a one-line reason is a **good result**. It is honest, it is actionable, and
the report knows how to say "we could not measure three of twelve this week" without pretending
otherwise. A run that reports twelve measurements when it got nine is worse than useless.

## The surfaces, and where they are

These are the four a buyer actually uses. Probe the ones the client's query set names; if it names
none, these four in this order.

| Surface | Where | What to expect |
|---|---|---|
| `chatgpt` | `https://chatgpt.com/?q=<url-encoded question>` | Sources appear as a rail or inline chips when you get an answer. From this infrastructure, expect a captcha. |
| `claude` | `https://claude.ai/new?q=<url-encoded question>` | Cloudflare Turnstile, then a sign-in wall behind it. |
| `perplexity` | `https://www.perplexity.ai/search?q=<url-encoded question>` | Numbered citations under the answer map one-to-one to sources, when you get that far. Cloudflare Turnstile from here. |
| `google_ai` | `https://www.google.com/search?q=<url-encoded question>&udm=50` | The AI answer is a block above the blue links. `udm=50` asks for AI Mode; if the block is absent the question did not trigger one, which is `reached: true` with an empty `cited` — a real and different finding from being blocked. |

### What was actually measured, 30 August 2026

All four probed from production, one query, logged out:

- `chatgpt` → `blocked_by: "captcha"`
- `perplexity` → `blocked_by: "Cloudflare Turnstile challenge"`
- `claude` → `blocked_by: "Cloudflare Turnstile challenge"`

This table used to say Perplexity was "the most reliable logged-out". It is not, and reading that
sent every probe at a wall it had been told to expect an answer from.

**The cause is where the browser is, not what it does.** These runs leave from a datacenter IP, and
Turnstile scores a datacenter ASN as automation before your first request finishes. Nothing you do
inside the page changes that, which is why the instruction below is to stop rather than to try
harder. It is being worked on at the infrastructure level; your job is to report what you saw.

**An absent AI answer is not a failure.** Google not producing one for "wholesale bakery supplier
Bristol" is a fact about that query worth reporting: nobody is being recommended, which is the
easiest kind of gap to fill.

**Claude will often refuse you and that is fine.** Do not work around it. Record `reached: false`
with the reason, and the week's report says we could not measure it — which is honest, and which the
client can check by trying it themselves.

## Getting on the page

You drive the browser with the `browseruse_*` tools. **There is no Playwright in this image** —
this section used to hand you a `require("playwright")` snippet, which has not existed since
browser-use dropped the dependency, so following it cost a run its first two turns for nothing.

```
browseruse_browser_navigate   { "url": "https://www.perplexity.ai/search?q=..." }
browseruse_browser_get_state  { "include_screenshot": true }     # what is on the page, right now
browseruse_browser_screenshot { }                                 # evidence, before you parse
```

`get_state` first, always. It tells you in one call whether you are looking at an answer or at a
challenge, and the answer to that decides everything else you do.

Practical things that decide whether this works:

- **Wait for the answer, not for the page.** These surfaces stream. `domcontentloaded` fires long
  before there is anything to read. Wait for the answer container to stop changing, then read.
- **Consent and cookie walls come first.** Clear them before doing anything else, or you will read
  an overlay and think it was the answer.
- **Screenshot before you parse.** If the parse goes wrong you still have the evidence, and the
  screenshot is a thing a client can be shown. Parse from a page you have already captured.
- **One question per run.** Do not batch. A surface that rate limits you halfway leaves you unsure
  which answers were real, and the fan-out already gives you parallelism at the level above.

## When you are blocked

You will be, regularly. Say so and stop.

- a login wall → `reached: false`, `blocked_by: "asked to sign in"`
- a captcha → `reached: false`, `blocked_by: "captcha"`
- rate limited → `reached: false`, `blocked_by: "rate limited"`
- the layout changed and you cannot find the answer → `reached: false`, and say that

- a Cloudflare interstitial or Turnstile widget → `reached: false`, `blocked_by: "Cloudflare Turnstile challenge"`

**Do not work around a login by finding credentials.** Do not solve captchas. Do not retry a
rate limit more than twice. Every one of those turns a measurement service into something a surface
is entitled to be annoyed about, and the client's brand is attached to it.

**Stop on the first challenge.** Not after three attempts — the first. A Turnstile challenge served
to a datacenter IP does not clear on a reload, so a second and third try buy nothing and spend the
client's run budget to arrive at the same sentence. One `get_state`, one verdict, done.

If a surface blocks us consistently, that is a finding for the founder, not a puzzle for you.

## Reading the answer

Two lists, answered separately, in this order, and do not let the first contaminate the second.

**`cited`** — look ONLY at the sources rail, footnotes, or link list. Transcribe. If it is in the
list it goes in `cited`, whatever the prose does with it. This is mechanical.

**`absorbed`** — look ONLY at the prose. A brand is absorbed if the answer describes it, quotes it,
recommends it, or leans on a fact from it. The test: *if I deleted this source, would the answer
change?*

The two come apart constantly and that is the whole point of keeping both:

- four sources listed, two discussed → `cited` has four, `absorbed` has two
- a brand recommended in the prose that appears in no source → `absorbed` only

If you find yourself producing one by filtering the other, you have answered the same question
twice.

## What you must not do

You have a browser and no ability to send anything. That is deliberate. You are here to look.

- Do not sign in to anything.
- Do not fill in a form that submits data about the client.
- Do not click anything that would post, subscribe, or contact.
- Do not navigate to the client's own systems.

If a run seems to need any of those, it has been given the wrong job. Stop and say so.
