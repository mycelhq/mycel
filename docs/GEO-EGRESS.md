# Residential egress for GEO probes

`probe_surface` opens a real answer engine in a real browser. From AWS it is blocked.

## What was measured

30 August 2026, production, one query, logged out, all four surfaces:

| surface | result |
|---|---|
| chatgpt | `blocked_by: "captcha"` |
| perplexity | `blocked_by: "Cloudflare Turnstile challenge"` |
| claude | `blocked_by: "Cloudflare Turnstile challenge"` |
| google_ai | `blocked_by: "captcha"` |

The agent behaved correctly every time — `reached: false`, a reason, no invented answer. The
product is honest and measures nothing.

## Why no amount of code fixes it

Turnstile in its usual mode is **not a puzzle**. There is nothing to solve. It scores the browser
and the network and then silently passes or blocks, and the network reputation is the heaviest term.

That rules out the three things people try first:

- **Captcha solvers** (2captcha, CapSolver) solve puzzles. There is no puzzle.
- **Stealth patches** (`navigator.webdriver`, fingerprint spoofing) improve one term in a score
  dominated by a different term. browser-use already carries most of this work.
- **Retrying.** A challenge served to a datacenter ASN does not clear on a reload. The skill now
  says stop on the FIRST one, because attempts two and three spend the client's budget to reach the
  same sentence.

## Not any proxy

| kind | verdict |
|---|---|
| datacenter | same problem, different datacenter |
| static residential / ISP | known ranges, increasingly flagged — and it is what LinkedIn uses here |
| **rotating residential** | **what this is written for** |
| mobile (4G/5G) | best and most expensive; carrier NAT puts thousands of real people on one address |

## Why it is a better measurement, not a workaround

Answer engines personalise by geography. "Best bookkeeping service for creative agencies" returns a
different answer in London than in Austin, and a client selling to London agencies is buying the
London answer.

Probing from `eu-west-2` was never neutral. It was one arbitrary location that happened to be ours,
reported as though it were everyone's. `country` is now an input to the probe and `measured_from` is
an output, so a number carries the place it was taken.

## Cost, and the thing that is easy to get wrong about it

**You do not buy an IP per client.** That is the LinkedIn product, and it is why it is expensive:
LinkedIn needs a member's session to keep one stable identity forever, so each seat is a dedicated
purchased address. Three seats, three countries, and it does not scale.

Probing needs the opposite. There is no account, no session, no identity to keep — every probe wants
to look like a different person asking a question. That is **rotating residential**: one credential,
a shared pool of millions of consumer addresses, billed per gigabyte, with the country chosen per
request. A hundred clients across ten countries costs the same per gigabyte as one client.

Rough magnitude, worth measuring rather than trusting: a real browser page load on these surfaces is
a few MB, and rotating residential runs $3–8/GB, so **2–4 cents per probe**. Ten queries across four
surfaces weekly for a hundred clients is ~4,000 probes/week — call it $170–700/month of COGS against
a monitoring retainer. Around 1–2% of revenue at typical retainer pricing.

There is a large unpulled lever if that matters: most of those megabytes are JavaScript bundles and
images, and neither is the measurement. `BROWSER_USE_CONFIG_PATH` points browser-use at a config
whose `browser_profile.args` accepts Chromium flags (`--blink-settings=imagesEnabled=false`,
`--disable-remote-fonts`), and `BrowserProfileEntry` is `extra='allow'` so they pass through. Worth
2–5x. Not built, because nothing is spending yet — and it should only apply when a proxy is actually
in use, since a direct probe is free and a screenshot with images is better client evidence.

## Why it does not reuse the LinkedIn lines

There is already a Decodo account here with dedicated ISP IPs in `fr`, `es`, `gb`. Each is leased
permanently to a LinkedIn member so their session keeps one address. `assertNotLinkedInLine` refuses
to send probe traffic through them:

1. It couples unrelated failure domains. An answer engine flagging that address takes a customer's
   LinkedIn account with it — an account they cannot get back — over a page load worth $0.0014.
2. There are three seats. Probing at scale needs many addresses.
3. Wrong product. Sticky ISP exists so a session keeps one identity. A probe wants the opposite: a
   fresh consumer address each time, in a named city, like a different person asking.

Same vendor, same bill, different line.

**Except when the seat is idle.** `assertNotLinkedInLine` originally refused by hostname, which was
the wrong invariant — the risk is not the host, it is whether an account is sitting on that address.
`proxyPoolStatus().free_by_country` already knows: a country with `0` free is leased. So
`MYCEL_OPERATE_EGRESS=isp` borrows a bought-but-idle line, and refuses one with a member on it,
re-checked on every run because a customer connecting tomorrow silently changes the answer.

That is a **test path, not the destination**. These are single static addresses. One of them making
hundreds of probes a week across four engines is a conspicuous pattern where a rotating pool spreads
the same traffic over thousands of consumer connections. Expect the ISP lines to work now, prove the
approach for free, and degrade.

## Turning it on

Create a **rotating residential** sub-user in the Decodo dashboard (Residential → pay per GB). Not a
dedicated ISP IP; that is the LinkedIn product.

```bash
aws secretsmanager put-secret-value --secret-id mycel/decodo-geo \
  --secret-string '{"username":"…","password":"…"}'
```

Kernel env:

```bash
MYCEL_OPERATE_EGRESS=residential            # or `isp` to borrow an idle line; anything else is direct
MYCEL_OPERATE_PROXY_USERNAME=…              # `user-` prefix added if missing
MYCEL_OPERATE_PROXY_PASSWORD=…
MYCEL_OPERATE_PROXY_COUNTRIES=gb,fr,es,us   # a country not on this list is refused, never substituted
# optional
MYCEL_OPERATE_PROXY_HOST=residential.decodo.io
MYCEL_OPERATE_PROXY_PORT=10000
```

Unset, half-set, or set to anything but `residential` / `isp`, every probe goes out exactly as it
does today. Residential is metered per gigabyte and a deploy must not start spending.

### Proving it for free first

Two of the three dedicated ISP lines are bought and idle. Point at one and re-run the probes:

```bash
MYCEL_OPERATE_EGRESS=isp
MYCEL_OPERATE_PROXY_USERNAME=<the LinkedIn dashboard user>
MYCEL_OPERATE_PROXY_PASSWORD=…
MYCEL_OPERATE_PROXY_COUNTRIES=fr,es,gb       # order sets the sticky port: FR 10001, ES 10002, GB 10003
```

Probe with `"country":"gb"`. France is leased and will be refused; that refusal is the guard working.
If the UK line clears Turnstile, rotating residential will too, and the question becomes only what it
costs.

## Verify

Re-run the four probes and read `blocked_by`:

```bash
for s in chatgpt perplexity google_ai claude; do
  SMOKE_TAG="$s" SMOKE_INPUT="{\"query\":\"best bookkeeping service for UK creative agencies\",\"surface\":\"$s\",\"country\":\"gb\"}" \
    AWS_PROFILE=mycel scripts/smoke-run.sh geo-monitor probe_surface &
done; wait
```

Expect **partial** success. Rotating residential moves this from "always blocked" to "usually fine",
not to "always fine": logged-out ChatGPT is more aggressive than Perplexity, and some queries hit a
login wall wherever they come from. The `reached: false` path stays live because it still fires.

## A country is never substituted

With a Spanish line idle and a UK line busy, the tempting shortcut is to probe the UK query through
Spain. It would clear the captcha — Cloudflare does not care which country — and produce a **wrong
number**.

Answer engines personalise by geography. "Best bookkeeping service for UK creative agencies" asked
from Madrid returns Spanish providers, euros and Spanish-language signals: an answer no UK customer
will ever see, recorded as a UK measurement and invoiced as one. That is strictly worse than the
block it works around, because a blocked probe says `reached: false` and everybody knows, and a
substituted one is indistinguishable from a real measurement.

So there is no fallback anywhere in `operate-egress.ts`. Asked for a country it cannot serve, it
returns `undefined`, the probe goes out directly, and it comes back honestly blocked.

## The one thing that is easy to get wrong

`BROWSER_USE_PROXY_URL` must carry **no credentials**.

Verified against the pinned wheel: `browser_use/config.py` maps it to `ProxySettings.server`,
`browser/profile.py` passes that as `--proxy-server=`, and Chromium drops any userinfo in that flag.
Auth happens over CDP — `browser/session.py` registers `Fetch.authRequired` and answers with the
separate `username`/`password`, from their own two env vars.

A `http://user:pass@host` URL therefore 407s every request. And a 407 reaching the agent looks
exactly like the captcha wall the proxy was bought to get past: we would have paid for residential
egress and measured nothing, with the symptom unchanged. `browseruse.test.ts` pins all three names
so a version bump that renames them fails the build instead of the bill.
