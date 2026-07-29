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
GET/POST /v1/connections          external capabilities (secrets referenced, never returned)
GET/POST /v1/channels             a conversation surface bound to a connection
POST     /v1/channels/:id/inbound webhook entry: resolve client → thread → spawn task
GET/POST /v1/clients · GET :id    the customer + their task/thread history
GET      /v1/threads/:id          a conversation (messages in/out)

# Internal (sandbox-facing, nonce-gated) — the agent reaches these, never the founder key
POST /v1/internal/llm/*           proxy-mode model routing (real key stays server-side)
POST /v1/internal/actions/:cap    the action proxy — send/charge/book via a connection, gated
POST /v1/internal/gate            tool-call approval gate
```

The event stream is the heart of it. A task emits, in order:
`task.created → step.started → tool.called/tool.result → token.delta → progress →
approval.requested (pauses) → approval.resolved → output.validated → artifact.created →
cost.charged → task.finished`. Render from the stream; never poll.

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
- **Auth** on the whole public API; **input validation** and **server-side constraint ceilings**
  (a caller can't set `max_cost_usd: 1e6`); model + `max_tokens` pinned in the LLM proxy.
- **Crash-honest runtime:** a task that fails says why (persisted), OpenCode dying is a failure
  (not a fake success), approvals resolve on cancel/timeout, and terminal status is always last.

**Not yet (don't rely on these)**
- **`local` sandbox is a dev convenience, not an isolation boundary** — it shares the host
  kernel. Use `docker` or `daytona` for untrusted work. (Host secrets no longer leak into it,
  but process isolation is the sandbox's job.)
- **Per-task tool ACLs are coarse.** Tools are governed by the approval gate + bash denylist,
  not a per-task allowlist yet. `task.tools` is recorded but not hard-enforced.
- **Single-instance.** Cancel, approvals, the SSE bus, and proxy/action grants are in-process —
  run one kernel instance. Horizontal scaling needs a shared bus (Redis); the interfaces are
  ready for it.
- **Durability is opt-in via `MYCEL_DATABASE_URL`.** With it set, everything is Postgres-backed
  (tasks, events, connections, clients, threads, knowledge, and tenants) and survives restarts —
  covered by a restart test in CI. Without it, the in-memory default loses state on restart.
- **No durable mid-run resume.** On restart, interrupted tasks are marked `failed` (not resumed).

## The frontend is generated, not imported

You do not `npm install` a Mycel UI. The **frontend skill** (`skills/mycel-workspace`) teaches
your coding agent to generate the workspace UI — live stream, tool calls, approval cards,
artifact viewer — against this contract, in **your** shadcn theme and `globals.css`. See that
skill for the component contract and generation guidance.
