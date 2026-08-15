# LinkedIn connect (self-hosted session) — enabling, costing & verifying

LinkedIn has **no messaging API**, so this connects a LinkedIn account the only way that works: we
hold a real member session and speak to the internal Voyager endpoints the web app calls. This
**violates the LinkedIn User Agreement and can get the account restricted.** It is opt-in, meant for
**low, human-approved volume behind a per-account residential proxy**.

Everything except the live session and the live Voyager calls is covered by `npm test`
(`harness/test/linkedin.test.ts`, 28 tests): the mappers against fixtures of both response shapes,
the proxy rule, the login flow (connected / 2FA / failure) against a mock browser, the cursor-based
sync against a mock transport, pacing, and the byte meter. The live steps need a real account and
cannot run in CI.

---

## 1. A proxy is required. Not recommended — required.

Logging in or calling Voyager from a datacenter IP is the single most reliable way to get an account
restricted, and the kernel runs on ECS. So egress is not an optional field:

- `connect`, `sync` and `send` all **refuse** without a proxy, with an error naming the field.
- A malformed or unsupported `proxy_url` is also a refusal — "we tried and it was malformed so we
  went direct" is the exact failure being designed out.
- A refused connect creates **no Connection at all** (when no pool is configured), so there is no
  half-made account to clean up.
- The only waiver is `MYCEL_LINKEDIN_ALLOW_DIRECT=1`, an environment variable a human types on a
  laptop. It is deliberately not a request-body option.

### Hosted pool (preferred for GTM)

Hand-pasting `proxy_url` does not scale. Configure an ISP pool on the host and connect without it:

| Mode | Env | Behaviour |
|---|---|---|
| **Decodo dedicated ISP** (recommended) | `MYCEL_LINKEDIN_PROXY_PROVIDER=decodo` + `MYCEL_DECODO_USERNAME` / `PASSWORD` + `MYCEL_DECODO_COUNTRIES` | One bought IP per country; `-country-{cc}` + sticky port; refuses a country we have not bought |
| **Static list** | `MYCEL_LINKEDIN_PROXY_POOL=us\|url1,gb\|url2` | Leases one dedicated ISP URL per connection; frees on disconnect; refuses wrong-country |
| **Bright Data ISP** (optional) | `MYCEL_LINKEDIN_PROXY_PROVIDER=brightdata` + `MYCEL_BRIGHTDATA_*` | Sticky `-session-{connectionId}` on the ISP superproxy |
| **BYO** | `proxy_url` in the connect body | Still wins when present |

`GET /v1/linkedin/proxy-pool` reports free slots by country (Decodo dedicated pool and static) or elastic (Bright Data). See
`harness/src/linkedin/proxy-pool.ts`.

**Provider pick:** **Decodo dedicated ISP** (~$1.20–1.60/IP/mo). Not rotating residential. After
syncToken work bandwidth is ~34 MB/account/month — Mycel pays Decodo COGS; the founder never sees a
proxy URL. Pass `country` on connect. A country not in `MYCEL_DECODO_COUNTRIES` fails clearly.
There is **no Decodo API that buys a dedicated IP** — extra countries are a dashboard purchase.
Bright Data is optional elastic; Unipile remains a future “stop maintaining Voyager” option.

```bash
# Production — Decodo dedicated pool (recommended)
MYCEL_LINKEDIN_PROXY_PROVIDER=decodo
MYCEL_DECODO_USERNAME=…          # dashboard user; `user-` prefix added if missing
MYCEL_DECODO_PASSWORD=…
MYCEL_DECODO_COUNTRIES=fr,es,gb  # bought IPs; one LinkedIn seat per country
# optional: MYCEL_DECODO_PORT_BASE=10001

# Dogfood fallback — geo-tagged dedicated list
MYCEL_LINKEDIN_PROXY_POOL='us|http://u:p@isp-us:port,fr|http://u:p@isp-fr:port'
```

Connect: `{ li_at, jsessionid, country: "fr" }` — no `proxy_url` on the self-serve path.

**A proxy that silently doesn't apply is worse than no proxy**, and that is what the obvious
implementation does. `fetch(url, { agent: new HttpsProxyAgent(...) })` is a **no-op**: Node's global
`fetch` is undici, and undici ignores `agent` — it wants a `dispatcher`. Code written that way
reports success, looks proxied, and egresses from the datacenter IP anyway. Proxying here goes
through undici's `ProxyAgent` (http/https) or an `Agent` over a SOCKS tunnel, and a missing proxy
library is a hard error rather than a fallback to a direct connection.

The proxy URL carries the proxy account's credentials, so it is **vaulted** beside the session, not
stored on the Connection. `config.proxy` keeps only `http://***@host:port` for display — the
connections API returns `config`.

---

## 2. Egress cost: where the money actually goes

The bill is dominated by the **sync** path, not the send path. Per account:

| Path | Naive | As built | How |
|---|---|---|---|
| Send 50 DMs/day | ~29 MB/mo | ~29 MB/mo | unchanged; sends are irreducible and small |
| Inbox poll every 5 min | **~422 MB/mo** | **~5 MB/mo** | cursor + gzip + page cap |
| **Total** | **~451 MB/mo** | **~34 MB/mo** | |

At 5,000 accounts that is ~2,255 GB/mo versus ~170 GB/mo of residential-proxy bandwidth —
**~$3,855/month versus ~$343/month.** Three decisions, in order of what they save:

### 2a. Deltas, not polls — and **Voyager does not support conditional requests**

The natural fix is `If-None-Match`/`ETag` or `If-Modified-Since`. It does not work here. Determined
three independent ways:

1. **Probing the live endpoints.** `/voyager/api/me`, an identity resource,
   `/voyager/api/voyagerMessagingGraphQL/graphql` and `/realtime/connect` were sent
   `if-none-match` + `if-modified-since`. All four responses (reaching LinkedIn's own tier —
   `x-li-fabric: prod-ltx1`/`prod-lor1`, past the CDN) carried
   `cache-control: no-cache, no-store, no-transform`, `pragma: no-cache`,
   `expires: Thu, 01 Jan 1970` — and **no `etag`, no `last-modified`, no `304`**. The conditional
   headers were ignored. `no-store` in particular means there is nothing to revalidate against.
   (Caveat, stated plainly: these were unauthenticated error responses. The caching headers are set
   by the frontend tier rather than the resource handler and were identical across four different
   resources, so the inference to authenticated 200s is strong — and corroborated by 2 and 3.)
2. **Reading the framework.** Voyager is Rest.li, which LinkedIn open-sources. The tree contains
   **zero** occurrences of `ETag`, `If-None-Match`, `If-Modified-Since` or `If-Match` — no Java, no
   docs, no PDL. The only `304`s are an unreferenced entry in a complete `HttpStatus` enum and a
   reason-phrase lookup table. `RestConstants.java` enumerates every header the framework knows and
   no conditional-request header is among them. The protocol spec documents 200/201/204/400/404/
   405/500 and never mentions caching. A Voyager resource would have to hand-roll conditional GETs,
   and nothing indicates any does.
3. **Checking the clients.** Four independent reverse-engineered clients — `mautrix/linkedin`,
   `mguttmann/linkedin-internal-api`, `vicnaum/linkedin-toolkit`, the `linkedin_api` lineage — were
   grepped for `etag|if-none-match|if-modified-since|304`. **Zero hits in any of them.** All poll;
   none caches conditionally. `mautrix/linkedin` is a long-running bridge that cares about
   bandwidth; if 304s were available it would use them.

**So we use LinkedIn's own mechanism instead: a `syncToken` cursor.**
`messengerConversationsBySyncToken` on the messaging GraphQL endpoint returns only the conversations
that changed since the token, plus `deletedUrns` tombstones and a `newSyncToken` to persist. An
unchanged poll comes back essentially empty (~0.4 KB) instead of re-downloading a ~49 KB inbox
listing. The token is stored on the Connection (`config.sync_token`) so it survives a restart —
losing it on every deploy would put the bill straight back where it started.

`/realtime/connect` (SSE, with a 60s heartbeat) is the further step: it removes polling entirely and
reconciles gaps with the same `syncToken`. Not built here; the cursor is what makes polling cheap
enough that it isn't urgent.

### 2b. Field projection

Voyager is Rest.li and returns large `included` entity graphs by default. Two levers:

- **`decorationId`** — LinkedIn's *named, server-registered* response shape (e.g.
  `com.linkedin.voyager.dash.deco.identity.profile.FullProfileWithEntities-101`). Typically 5-10×
  smaller. It is not arbitrary field selection: you pick from LinkedIn's menu, and the trailing
  version number **rotates with LinkedIn's deploys** — a stale one 400s, and some endpoints 400
  *without* one. So it is set via `MYCEL_LINKEDIN_DECORATION_ID` and a 400 falls back to undecorated
  **once**, remembering the result, rather than turning a rotated id into a broken inbox.
- **`fields=`** is the genuine Rest.li projection parameter (`fields=List(a,b)` in 2.0 syntax), but
  no client was found using it successfully against Voyager, and Rest.li servers may run projection
  in `MANUAL` mode where the resource simply ignores the mask. Treated as unverified; not used.

On the GraphQL path the shape is fixed by the `queryId` hash, so projection does not apply — the
delta *is* the projection. Query ids also rotate; they are env-overridable
(`MYCEL_LINKEDIN_QID_CONVERSATIONS`, `MYCEL_LINKEDIN_QID_SYNC`) so re-capturing them from a devtools
network log is a config change, not a deploy. Cold starts are page-capped
(`MYCEL_LINKEDIN_SYNC_COUNT`, default 20).

### 2c. gzip

`accept-encoding: gzip, deflate` is set explicitly on every Voyager call. Voyager honours it
(`content-encoding: gzip` and `vary: accept-encoding` observed live). Undici sends it by default,
but that is a property of the transport, not of this code — and it is worth ~3-4×.

### 2d. It is measured, not assumed

Every Voyager round-trip records what it transferred (`linkedin/meter.ts`): wire bytes
(`content-length`, i.e. what the proxy bills), decoded bytes, upload bytes, request count, empty
deltas, and a straight-line 30-day projection — per account, split by operation.

```
GET /v1/linkedin/connect/:id     → { ..., usage: { wire_bytes, compression_ratio, by_op, projected_monthly_wire_bytes } }
GET /v1/linkedin/usage           → every account in scope, plus fleet totals
POST /v1/linkedin/connect/:id/sync → { via: "sync-token", empty: true, bytes: 312, usage: {...} }
```

If `via` is `legacy` or `empty` is rarely true, the cheap path is not engaging and the bill is
heading for the left-hand column of the table above.

---

## 3. Credentials: prefer never to hold the password

The hosted-auth page a vendor like Unipile sells is not really a nicer form — the product is the
property that **the application never holds the credential**. That property is available to us
without becoming a hosted-auth vendor, so the connect endpoint takes two bodies and they are not
equal in quality:

```
POST /v1/linkedin/connect
  { "li_at": "...", "jsessionid": "\"ajax:...\"", "proxy_url": "..." }   ← PREFERRED
  { "email": "...", "password": "...",           "proxy_url": "..." }   ← fallback
```

**The session handoff (preferred).** The member is already logged into LinkedIn in their own
browser; we adopt the two cookies that session is made of, via an extension, a bookmarklet, or a
page served from our own origin that reads its own `document.cookie` after a real LinkedIn login. No
password is transmitted, held, or typed into anything we wrote. It also needs **no Playwright and no
headless login at all** — which removes the automated login that LinkedIn most reliably flags. If
the cookies don't authenticate, the connect fails immediately (checked against `/me`) rather than
days later inside an approved send.

**The password path (fallback).** Kept because the handoff needs an extension or a hosted origin and
not every deployment has one. When it is used the password is treated as radioactive:

- it exists only as a function argument, for the duration of one call;
- it is **never** persisted — not on the Connection, not in the vault, not in `config`;
- it is **never** logged, and error strings are scrubbed of it before they leave (a browser
  automation library can quote the input it was handed);
- a 2FA-challenged login holds an **open browser, not a credential** — `PendingLogin` has no
  password field — so a pending login that expires leaks nothing.

Two tests assert these properties directly rather than trusting the review.

---

## 4. Enable it (one-time)

Optional dependencies, not installed by default — the kernel builds and boots without the password-path extras. **`undici` is a real kernel dependency** (package.json) so proxied Voyager calls cannot silently fall back to datacenter egress.

```bash
# undici is installed with the kernel — do not omit it from the image
npm i socks                  # only for socks5:// proxies
npm i playwright-core        # only for the password path; not needed for the session handoff
# Chromium itself is provided by the environment (PLAYWRIGHT_BROWSERS_PATH). Do not run
# `playwright install` if the environment already ships a browser.
```

Set a stable vault key so captured sessions survive restarts:

```bash
export MYCEL_SECRET_KEY=$(openssl rand -base64 32)
```

| Env var | Default | What it does |
|---|---|---|
| `MYCEL_LINKEDIN_ALLOW_DIRECT` | unset | `1` waives the proxy requirement. **Local development only.** |
| `MYCEL_LINKEDIN_PROXY_PROVIDER` | inferred | `brightdata` \| `static` \| `none` — see proxy-pool.ts |
| `MYCEL_LINKEDIN_PROXY_POOL` | unset | Comma/JSON list of dedicated ISP proxy URLs (static mode) |
| `MYCEL_BRIGHTDATA_CUSTOMER` | unset | Bright Data customer id (ISP mode) |
| `MYCEL_BRIGHTDATA_ZONE` | unset | ISP zone name |
| `MYCEL_BRIGHTDATA_PASSWORD` | unset | Zone password |
| `MYCEL_BRIGHTDATA_COUNTRY` | unset | Default geo (overridden by connect `country`) |
| `MYCEL_BRIGHTDATA_HOST` | `brd.superproxy.io` | Superproxy host |
| `MYCEL_BRIGHTDATA_PORT` | `33335` | ISP port (residential often `22225`) |
| `MYCEL_LINKEDIN_QID_CONVERSATIONS` | a captured hash | GraphQL query id for a cold inbox page |
| `MYCEL_LINKEDIN_QID_SYNC` | a captured hash | GraphQL query id for the `syncToken` delta |
| `MYCEL_LINKEDIN_DECORATION_ID` | unset | Named response shape for the legacy Rest.li inbox |
| `MYCEL_LINKEDIN_SYNC_COUNT` | `20` | Page cap on a cold start |

---

## 5. The flow

```
POST   /v1/linkedin/connect              → { phase: "connected" | "needs_2fa", connection_id }
POST   /v1/linkedin/connect/:id/verify   { "code": "123456" }   # only after needs_2fa
GET    /v1/linkedin/connect/:id          → { connected, handle, proxy, synced, usage }
POST   /v1/linkedin/connect/:id/sync     → { via, empty, bytes, conversations, inbound, deleted }
GET    /v1/linkedin/usage                → bytes per account + fleet totals
DELETE /v1/linkedin/connect/:id          → forgets the session, the proxy and the meter
```

A refusal by the proxy rule answers **400** (`code: "linkedin_proxy_required"`); LinkedIn being
unreachable answers 502.

The account becomes a `Connection` of kind **`linkedin`**; the session is stored **encrypted in the
vault** keyed by the connection id, so the existing action proxy resolves it like any other secret.
Bind a `Channel` to it for inbound → task, exactly like email.

**Outbound goes through `executeAction` — the same approval gate as every other connection kind, and
it is not bypassable.** Two independent checks stand between an agent and a stranger's inbox:

- the **approval gate** (upstream) asks *should this message be sent at all?* — a human answers, one
  message at a time;
- **pacing** (`src/pacing.ts`, called from `sendLinkedInMessage`) asks *may this account send
  anything right now?* — weekly allowance, new-account ramp, the 08:00–19:00 weekday window, spacing
  between touches. A human approving twenty messages at 11pm does not make it safe to deliver twenty
  messages at 11pm, which is why this is not part of the approval.

A pacing refusal comes back as `paced: <reason>`, written for the founder.

---

## 6. What "verified" looks like (on a real host)

- [ ] `POST /v1/linkedin/connect` **without** `proxy_url` returns 400 `linkedin_proxy_required`, and
      `GET /v1/connections` shows no new row.
- [ ] `POST /v1/linkedin/connect` with `{ li_at, jsessionid, proxy_url }` from a live browser session
      returns `connected` — and no password was involved anywhere.
- [ ] Stale cookies return `failed`, and `GET /v1/linkedin/connect/:id` reports `connected: false`.
- [ ] The password path returns `connected` (or `needs_2fa`, then `connected` after the code).
- [ ] `GET /v1/linkedin/connect/:id` survives a harness restart (the vaulted session is reused — no
      re-login), given `MYCEL_SECRET_KEY` is set.
- [ ] The first `POST .../sync` reports `via: "graphql"`; **every subsequent one reports
      `via: "sync-token"`**, and an unchanged inbox reports `empty: true` with `bytes` in the
      hundreds. If `via` stays `graphql`, the cursor is not being persisted.
- [ ] `GET /v1/linkedin/usage` shows `compression_ratio` well under 1 (gzip is working) and a
      `projected_monthly_wire_bytes` in the tens of MB, not the hundreds.
- [ ] Confirm on the wire that the request left via the proxy — the account's session should show the
      residential IP in LinkedIn's own "where you're signed in" screen, not the ECS egress IP.
- [ ] A drafted reply, once approved, is delivered on the LinkedIn thread.
- [ ] A send outside the pacing window is refused with `paced: …` and never reaches LinkedIn.

## 7. Operational reality (do not skip)

- **Residential proxy per account, and keep it stable.** The dispatcher is cached per proxy url so
  an account's connections are reused; rotating a member's IP every request is itself a signal.
- **Low volume, human-approved.** Bulk or fast sending gets accounts restricted. Pacing enforces the
  shape; the approval gate enforces the intent.
- **Sessions expire and get challenged.** When one dies, reconnect — the handoff path makes this a
  paste rather than a re-login, and re-login re-triggers 2FA.
- **The hashes rotate.** `queryId` values and `decorationId` version suffixes change with LinkedIn's
  deploys. Both are env vars for that reason; the legacy inbox is the fallback when GraphQL fails.
- **Voyager shapes drift.** The mappers read both the legacy Rest.li and the newer GraphQL/dash
  shapes defensively, because which one an account gets is LinkedIn's decision — but a change can
  still require an update to `linkedin/voyager.ts`. The mappers are pure and fixture-tested, so that
  update is a small, verifiable one.
- **Selectors drift too.** The login selectors live in one place (`linkedin/login.ts`, `SEL`); a
  LinkedIn markup change is a one-line fix there.
- **Never log a session cookie, a password, or a message body.** Inbound message text is returned to
  the caller (that is the point of an inbox sync) and written to no log line; send failures report a
  status code, never the text.
