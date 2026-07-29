<p align="center">
  <img src="brand/logo.png" alt="Mycel" width="620">
</p>

<h3 align="center">The open kernel for AI-native service businesses.</h3>
<p align="center"><em>SaaS is dead. The harness is the product.</em></p>

---

> **Status: pre-alpha.** Mycel is being *extracted* from real AI-native service businesses we run
> ourselves, not designed in a vacuum. The core is real and tested (see below); APIs will still
> move. Watch the repo; don't pin to it yet.

## The idea

Every AI-native service is the same shape: a thin **interface** and a **harness** that does the
work. The interface is the easy ~20%. The harness is the brutal, repeated ~80% — a sandbox to run
the agent, grounding so it doesn't guess, approvals so it can touch the real world safely, secrets,
connections, tenancy, streaming, tracing, persistence, recovery.

That 80% is not your product. It's undifferentiated plumbing you'd rebuild for every wedge you test.
**Mycel is that plumbing — extracted, hardened, and open.** Your only job is the judgment: how the
work actually gets done.

> Rent the engine. Own the judgment.

## Quickstart

```bash
# 1. run the kernel
curl -fsSL https://mycel.dev/init | bash        # or: git clone https://github.com/mycelhq/mycel && cd mycel && npm i && npm run dev
# → mycel-harness on http://localhost:4000  (prints an API key + owner login on first boot)

# 2. drive it (server-to-server; the key stays server-side)
curl -X POST http://localhost:4000/v1/tasks \
  -H "authorization: Bearer $MYCEL_API_KEY" -H "content-type: application/json" \
  -d '{"wedge":"enrollment-operator","task_type":"reply_to_lead","input":{"message":"do you have space in September?"}}'

# 3. watch it work (Server-Sent Events)
curl -N http://localhost:4000/v1/tasks/<id>/events -H "authorization: Bearer $MYCEL_API_KEY"
```

Scaffold a product around it with **[`create-mycel-app`](https://github.com/mycelhq/create-mycel-app)**,
and run the **portal** (operator console) alongside.

## What Mycel provides

**The harness runtime.** Drives [OpenCode](https://opencode.ai) (a real coding agent) inside an
isolated sandbox — local, Docker, or [Daytona](https://daytona.io) — over one task/event contract.
No bespoke agent loop. Streams every step over SSE; validates output against the wedge's schema;
persists to Postgres (or in-memory); recovers on restart.

**The service surface.** Not just tasks — the whole shape of a service business:
- **Connections** — external capabilities (email, Stripe, WhatsApp, calendar, …). Secrets are
  *referenced*, never returned, never sent to the sandbox. Founder- **or client-owned** (operate on
  a client's behalf without their credentials touching the agent).
- **Channels / Clients / Threads** — inbound arrives on a channel, resolves to a client, appends to
  a thread, and spawns the task. Conversation history and continuity, built in.
- **The action proxy** — the generalization of model-proxying to *any* real-world action. The agent
  gets an opaque nonce; the harness holds the secret, runs the human approval gate, executes, and
  records the outbound message.

**Wedges (config, not code).** A service is a manifest + **skills** (how the job is done) +
**living knowledge** (what's true, edited at runtime with no redeploy). One horizontal engine, many
verticals — quality lives in the grounding, not the engine. See **[docs/WEDGES.md](docs/WEDGES.md)**.

**The learning loop.** Edit a draft before approving it, or leave feedback on a task, and the
correction becomes a grounding example. The wedge gets better from being used, not re-authored.

**Multi-tenant, from the core.** Org → project → member, with per-project data isolation and member
logins. A project key sees only its data; a member sees their org. Proven with isolation tests.

**Any model, fully traced.** Route any LLM through the proxy (OpenAI-compatible directly, others via
LiteLLM). Keys stay server-side; model + token budget pinned per task; every call logged to Langfuse.

**The frontend is generated, not imported.** No `@mycel/react` to install. A **skill** teaches your
coding agent to generate a brand-fitting workspace UI against the event contract. The hard artifact
is the contract, not the pixels.

## How it works

**One trust boundary for all privileged I/O.** The harness mediates everything the agent can't be
trusted with directly — model tokens *and* real-world actions — and the human sits at that boundary.

```
Interface ─► your API (proxy + auth) ─► Sandboxed agent (grounded by the wedge)
                                              │
                                        Human gate  ── approve / edit
                                              │
                                        Connections ── the real action (secret stays server-side)

  Grounded: skills + live knowledge, not guessing
  Confidential: secrets never enter the sandbox
  Traced: every step + model call, honest signals (validated output, real failure reasons)
```

Contract: `POST /v1/tasks` → SSE events → approvals → artifacts. **Same surface, local or cloud** —
only the backends (sandbox, Postgres, S3, Langfuse) change.

## The `/v1` contract (server-to-server)

```
Auth   Authorization: Bearer <project key | member session>     ·  POST /v1/auth/login · GET /v1/me
Work   POST /v1/tasks · GET :id · GET :id/events (SSE) · POST :id/cancel · POST :id/feedback
       POST /v1/approvals/:id/{approve,reject}   ·  GET /v1/artifacts/:id
Who    GET/POST /v1/clients · GET :id      ·      GET /v1/threads/:id
Where  GET/POST /v1/connections · /v1/channels · POST /v1/channels/:id/inbound  (webhook)
Wedge  GET /v1/wedges/:wedge · GET/POST /v1/wedges/:wedge/knowledge · GET/PUT/DELETE /v1/knowledge/:id
Tenant GET/POST /v1/projects
```

Consuming it (topology, proxy routes, SSE) and the honest security limitations are in
**[docs/INTEGRATION.md](docs/INTEGRATION.md)**. The full event/type reference is in
**[docs/CONTRACT.md](docs/CONTRACT.md)**.

## Configure (env)

| Var | Default | What |
|---|---|---|
| `MYCEL_RUNTIME` | `opencode` | `opencode` (real agent) \| `mock` (canned events, no keys — demos + tests) |
| `MYCEL_SANDBOX` | `local` | `local` \| `docker` \| `daytona` |
| `MYCEL_MODEL` | `anthropic/claude-opus-4-8` | default model; per-task override via `input.model` |
| `MYCEL_API_KEY` | generated | founder/product key (printed on boot if unset) |
| `MYCEL_OWNER_EMAIL` / `_PASSWORD` | generated | portal owner login |
| `MYCEL_DATABASE_URL` | — | Postgres for **everything** (tasks, service surface, tenants); falls back to in-memory |
| `MYCEL_PROXY_MODE` | `0` | route model calls through the harness (keys never in the sandbox) |
| `MYCEL_ARTIFACTS` | inline | `inline` \| `fs:<dir>` \| `s3://…` |
| `LANGFUSE_*` | — | opt-in tracing |

## Try it with no keys

The kernel runs end-to-end without OpenCode or a provider key — useful for a first look and for CI:

```bash
MYCEL_RUNTIME=mock npm run dev     # tasks stream canned events and finish
```

## Develop

```bash
npm i
npm run dev          # boots the harness (prints an API key + owner login)
npx tsc --noEmit     # typecheck
npm test             # test suite (in-process, mock runtime)
MYCEL_TEST_DATABASE_URL=postgres://... npm test   # + Postgres durability test
```

The suite covers auth, boundary validation + constraint clamping, a full task run, SSE ordering
and replay, connections/secret handling, living knowledge + the feedback loop, the action proxy
(gate → approve → execute → outbound, and reject), and **per-project tenant isolation**.

## Principles

1. **Grounded, not guessing.** The agent works from the wedge's skills + knowledge, not a naked prompt.
2. **Draft-and-approve.** Every outward action pauses for a human. Autonomy is earned.
3. **Rented commodities behind interfaces.** Swap sandbox or model with one env var; nothing load-bears on a vendor.
4. **Honest signals.** Validated output, real failure reasons, no fake successes. Everything traced.
5. **Contract over packages.** The frontend is generated against the event contract, not imported.

## Repo layout

```
kernel/          this — the open harness + /v1 contract + docs + example wedges
create-mycel-app/ scaffolder: a Next.js product wired to the kernel
portal/          the founder operator console (Next.js + shadcn)
```

## License

[Apache-2.0](./LICENSE). Open-core: the kernel is free and self-hostable; the hosted Cloud is the commercial layer.

---

<p align="center"><sub>github.com/mycelhq · mycel.dev</sub></p>
