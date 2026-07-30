# Integrating a frontend with the Mycel kernel

The kernel is an engine. Your product (a Next.js app, or anything) drives it over one HTTP
contract. This doc is the consumer's guide: what the kernel exposes, the recommended topology,
and how a frontend consumes it. Full event/type reference is in [`CONTRACT.md`](./CONTRACT.md).

## Auth

Every public `/v1` endpoint requires the **founder API key** as `Authorization: Bearer <key>`.
Set `MYCEL_API_KEY` on the kernel; if you don't, it prints an ephemeral key on first boot (the
API is never open). The key lives server-side in your product's proxy routes — the browser never
holds it. The `/v1/internal/*` endpoints are sandbox-facing and authed separately (gate token /
opaque nonces), so the sandbox never needs the founder key.

**`X-Mycel-Project`** selects the tenant. On a **write** it names the project the row lands in; on a
**read** it narrows the result to that one project. Omit it and reads span every project the caller can
see — right for a fleet view, wrong for a per-business screen (two customers' work in one timeline).
A project outside the caller's scope yields nothing; it never widens access.

### Auth

```
POST /v1/auth/signup          public   → { token, member, projects }
POST /v1/auth/login           public   → { token, member, projects }
POST /v1/auth/hint            public   → { provider }  which provider this email used last
POST /v1/auth/reset/request   public   → { ok, token? }  ALWAYS ok — never reveals who has an account
POST /v1/auth/reset/confirm   public   → { token, … }  single-use, 30 min, signs you in
POST /v1/auth/federated       KEY ONLY → { token, created }
```

`federated` is how OAuth works: your product runs the provider dance (that's where the redirect URIs
and secrets live) and then asserts the verified email here, server-to-server. **It requires the
product API key and refuses a member session** — if a browser could call it, anyone could claim any
email. Matching is on email, so an account reached by password and later by Google stays one account.

`reset/request` returns the token for *you* to email; the kernel stores only its hash and never sends
mail itself.

### Client portal — a second credential plane

```
POST /v1/clients/:id/portal-link     founder → { token, expires_at }   shown ONCE
POST /v1/clients/:id/portal-revoke   founder → kills sessions AND unopened links
POST /v1/portal/session              public  → exchange the link for a client session
GET  /v1/portal/me · threads · threads/:id · cases     CLIENT SESSION ONLY
POST /v1/portal/threads/:id/messages                   the client replies
```

`/v1/portal/*` accepts **only** a client session, and a client session resolves nowhere else. That's
stronger than filtering: presenting a client token to a founder route fails as an unknown credential
rather than as an authorised request that happens to return nothing — a filter you forget to apply
leaks, a credential the route can't parse can't. Both directions are tested.

Ownership is always taken from the session, never from a path or body parameter. Another client's
thread is **404, not 403**, so probing ids can't confirm what exists. A reply's author and direction
are derived from the session too, so a customer can't post a message that appears to come from you.

Links are single-use and hashed at rest; revoking kills live sessions *and* any link still sitting
unopened in an inbox, because otherwise "revoke" leaves a working key in their email.

## What the kernel exposes (`/v1`)

Server-to-server. Everything a product needs is here:

```
# Work
POST /v1/tasks                    create + start a task            → { task }
GET  /v1/tasks/:id                fetch a task (incl. error)       → { task }
GET  /v1/tasks/:id/events         SSE stream (Last-Event-ID replay)
POST /v1/tasks/:id/cancel         request cancel                   → { task }
POST /v1/approvals/:id/approve    resolve an approval              → { ok, decision }
POST /v1/approvals/:id/reject     resolve an approval              → { ok, decision }
GET  /v1/artifacts/:id            fetch/download an artifact

# Who the work is for + where it comes from/goes
GET/POST /v1/connections          external capabilities (`has_secret` says whether a credential
                                  EXISTS; the value itself is never returned)
GET/POST /v1/channels             a conversation surface bound to a connection
POST     /v1/channels/:id/inbound webhook entry: resolve client → thread → spawn task
GET/POST /v1/clients · GET :id    the customer + their task/thread history
GET      /v1/threads/:id          a conversation (messages in/out)

# Internal (sandbox-facing, nonce-gated) — the agent reaches these, never the founder key
POST /v1/internal/llm/*           proxy-mode model routing (real key stays server-side)
POST /v1/internal/reads/:cap      the read proxy — ungated but scoped (GET, host from the connection)
POST /v1/internal/actions/:cap    the action proxy — send/charge/book via a connection, gated
POST /v1/internal/gate            tool-call approval gate
```

The event stream is the heart of it. A task emits, in order:
`task.created → step.started → tool.called/tool.result → token.delta → progress →
approval.requested (pauses) → approval.resolved → output.validated → artifact.created →
cost.charged → task.finished`. Render from the stream; never poll.

## Composio: OAuth and 250+ toolkits, without a token in the sandbox

Every credential used to be paste-a-token-by-hand, which rules out most real accounting and CRM
software outright — a Xero access token lasts 30 minutes and needs a refresh round trip, and no
founder is re-pasting one every half hour. Set `COMPOSIO_API_KEY` and a connection of kind
`composio` becomes a one-click authorisation instead.

```
GET  /v1/composio/toolkits?search=xero      → the app catalogue, marked with what you already have
GET  /v1/composio/categories                → category filter
POST /v1/composio/toolkits/:toolkit/connect → auth config + connection + authorise URL, in ONE call
GET  /v1/connections/:id/composio/status    → { status, active }
GET  /v1/composio/tools?toolkit=xero        → what you can call (for authoring, not for the agent)
```

`POST /v1/composio/toolkits/:toolkit/connect` is the one that matters. It creates a
**Composio-managed** auth config, so there is no OAuth client for the founder to register with the
provider — the alternative means obtaining a client id and secret and configuring redirect URIs, and
nobody running a bookkeeping practice is doing that. It's idempotent on (project, toolkit, owner), so
clicking Connect again after closing the tab reuses the connection and the auth config instead of
accumulating duplicates. Pass `client_id` to connect on a specific customer's behalf.

Send the founder to `redirect_url`, then poll `status` until `active`. **Composio owns the OAuth
callback**, so Mycel exposes no public redirect route — one less internet-facing surface, and no
half-finished grant to store if they abandon the tab.

The agent then calls a tool by slug through the normal action proxy
(`POST /v1/internal/actions/XERO_CREATE_INVOICE`), and it passes the human gate like any other
outward action. Three things the agent does **not** get to choose:

- **The Composio API key** stays in the harness, exactly like a model provider key.
- **`user_id` is derived from the connection's owner**, never from the request. A client-owned
  connection maps to `<project>:client:<client_id>`, so each customer's Xero is a separate Composio
  account and the agent cannot act as a different customer even if it asks to.
- **Which account** — the connected-account id comes from the connection's config.

**Reads must be declared.** Composio tools are mostly writes, and `XERO_CREATE_INVOICE` is not a read
just because the agent called it through `/v1/internal/reads`. Only slugs listed in the connection's
`read_tools` go down the ungated path; everything else is refused with a pointer to the action proxy.
Default deny — a connection that declares nothing is readable through nothing.

A blueprint can declare a brokered connection, and the readiness checklist then says *"Connect Xero"*
with a `composio/connect` action instead of asking for a credential that doesn't exist.

## Recommended topology: your backend fronts the kernel

**Keep the kernel private. The browser talks to your app; your app proxies to the kernel.**

```
Browser ──► your Next.js API routes ──► Mycel kernel /v1/* (private network)
  /api/tasks              proxies POST /v1/tasks
  /api/tasks/:id/events   proxies the kernel SSE stream
  /api/approvals/:id/...  proxies approve/reject
```

Why: the kernel needs no public auth, provider/kernel secrets stay server-side, and you add
*your* auth (who can create tasks, per-tenant scoping) in your routes. Same code local and
cloud — only `MYCEL_KERNEL_URL` changes.

### Minimal Next.js proxy routes

```ts
// app/api/tasks/route.ts — create a task
const KERNEL = process.env.MYCEL_KERNEL_URL ?? "http://localhost:4000";
const kauth = { authorization: `Bearer ${process.env.MYCEL_API_KEY ?? ""}` };
export async function POST(req: Request) {
  // (add your auth + per-tenant checks here — the founder key is added below, server-side)
  const r = await fetch(`${KERNEL}/v1/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json", ...kauth },
    body: await req.text(),
  });
  return new Response(r.body, { status: r.status, headers: { "content-type": "application/json" } });
}

// app/api/tasks/[id]/events/route.ts — proxy the SSE stream
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const r = await fetch(`${KERNEL}/v1/tasks/${params.id}/events`, {
    headers: { accept: "text/event-stream" },
  });
  return new Response(r.body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}
```

### Consuming the stream in the browser

```ts
const es = new EventSource(`/api/tasks/${id}/events`);
es.addEventListener("token.delta", (e) => append(JSON.parse(e.data).data.text));
es.addEventListener("tool.called", (e) => showTool(JSON.parse(e.data).data));
es.addEventListener("approval.requested", (e) => promptApproval(JSON.parse(e.data).data));
es.addEventListener("artifact.created", (e) => showArtifact(JSON.parse(e.data).data));
es.addEventListener("task.finished", () => es.close());
```
(Reconnect with `Last-Event-ID` to replay from where you left off — the kernel persists events.)

## Local vs cloud

| | Local (dev) | Cloud |
|---|---|---|
| Kernel | `mycel dev` on `localhost:4000`, `MYCEL_SANDBOX=local\|docker` | Fly/Render container, `MYCEL_SANDBOX=daytona`, `MYCEL_DATABASE_URL` set |
| Product | `next dev`, `MYCEL_KERNEL_URL=http://localhost:4000` | Vercel, `MYCEL_KERNEL_URL=https://kernel.internal…` |
| Only difference | — | `MYCEL_KERNEL_URL` + the kernel's backends (Daytona/Postgres/S3) |

Deploy the kernel with the service `Dockerfile`; deploy the product to Vercel; point the
product at the kernel URL. Nothing else changes.

## Security model & honest limitations (v0.1)

What the kernel enforces today, and what it doesn't yet — so you deploy it knowing the edges.

**Enforced**
- **One trust boundary for all privileged I/O.** Provider keys (LLM) and connection secrets
  (Stripe/Postmark/Twilio) never enter the sandbox — the agent gets opaque nonces; the harness
  holds the real secrets and mediates every call. Every outward *action* passes the human
  approval gate.
- **Per-client credential isolation.** A connection owned by a client is grantable only to a task
  serving that client, and naming it explicitly cannot override that — so one customer's mailbox or
  bank token can't be used on another customer's job. Founder-owned connections still have to be
  named by the wedge or the task.
- **The destination host always comes from the connection, for reads AND writes.** The sandbox
  supplies a path; absolute URLs, protocol-relative URLs, traversal and CRLF are rejected. This
  matters most on writes, because the connection's credential rides along as a bearer token.
- **Read/write asymmetry.** Reads are **ungated** (an agent that must wait for a human before it
  can look at today's transactions is useless) but still scoped: granted connections only, GET
  only, the host comes from the connection config (the sandbox supplies a relative path, so no
  SSRF), responses are size-capped, reads are budgeted per task, and every read is traced onto
  the task timeline. Writes stay gated.
- **Auth** on the whole public API; **input validation** and **server-side constraint ceilings**
  (a caller can't set `max_cost_usd: 1e6`); model + `max_tokens` pinned in the LLM proxy.
- **Secrets encrypted at rest.** Vault secrets are sealed with AES-256-GCM under `MYCEL_SECRET_KEY`;
  only ciphertext is persisted, and a bad key or tampered ciphertext fails closed. Set the key, or
  the kernel warns that secrets won't survive a restart.
- **Tamper-evident audit.** Approvals, executed actions and secret writes are recorded in a
  hash-chained, append-only log per project. `GET /v1/audit/verify` recomputes the chain and reports
  the first broken link, so an edited history is detectable rather than deniable.
- **Crash-honest runtime:** a task that fails says why (persisted), OpenCode dying is a failure
  (not a fake success), approvals resolve on cancel/timeout, and terminal status is always last.

**Not yet (don't rely on these)**
- **`local` sandbox is a dev convenience, not an isolation boundary** — it shares the host
  kernel. Use `docker` or `daytona` for untrusted work. (Host secrets no longer leak into it,
  but process isolation is the sandbox's job.)
- **Per-task tool ACLs are coarse.** Tools are governed by the approval gate + bash denylist,
  not a per-task allowlist yet. `task.tools` is recorded but not hard-enforced.
- **Mostly single-instance.** The *scheduler* is multi-instance safe (it claims due schedules with
  `FOR UPDATE SKIP LOCKED`, so N replicas can't double-fire — verified against a real Postgres). But
  cancel, approval waiters, the SSE bus, proxy/action grants, policy counters, idempotency and read
  budgets are still in-process: **run one replica** until those are Redis-backed.
- **Durability is opt-in via `MYCEL_DATABASE_URL`.** With it set, everything is Postgres-backed
  (tasks, events, connections, clients, threads, knowledge, and tenants) and survives restarts —
  covered by a restart test in CI. Without it, the in-memory default loses state on restart.
- **No durable mid-run resume.** On restart, interrupted tasks are marked `failed` (not resumed).

## The frontend is generated, not imported

You do not `npm install` a Mycel UI. The **frontend skill** (`skills/mycel-workspace`) teaches
your coding agent to generate the workspace UI — live stream, tool calls, approval cards,
artifact viewer — against this contract, in **your** shadcn theme and `globals.css`. See that
skill for the component contract and generation guidance.
