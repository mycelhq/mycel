<p align="center">
  <img src="brand/logo.png" alt="Mycel" width="620">
</p>

<h3 align="center">The open kernel for AI-native service businesses.</h3>
<p align="center"><em>SaaS is dead. The harness is the product.</em></p>

---

> **Status: pre-alpha.** Mycel is being *extracted* from real AI-native service businesses we run
> ourselves, not designed in a vacuum. The core is real and tested (see below); APIs will still
> move. Watch the repo; don't pin to it yet. What changed and what was withdrawn:
> **[CHANGELOG.md](./CHANGELOG.md)**.

## What is actually different here

Plenty of things run an agent in a loop. These are the parts that are hard to add later, and they
are the reason this repository exists:

- **An approval gate the agent cannot route around.** It is not a prompt instruction. The agent
  never holds a credential — it gets an opaque nonce, and the harness holds the secret, runs the
  gate and performs the action. There is no code path from the sandbox to the outside world that
  skips it.
- **A hash-chained audit log.** Approvals, executed actions and secret writes are appended to a
  chain; `GET /v1/audit/verify` reports the first broken link. Hashing is canonical, because jsonb
  key reordering once made every persisted chain read as tampered.
- **Stated vs observed provenance.** `knowledge.ts` ranks facts on an `EVIDENCE` axis that is
  *orthogonal* to strength. Something the founder told us during onboarding is `stated`; something
  the system watched happen is observed — and a stated claim that contradicts an observed rule on
  the same subject is declined rather than written. Most agent memory has one bucket.
- **Autonomy that narrows itself and never widens itself.** A wedge declares an envelope; when a
  granted action kind reaches a one-in-three rejection rate it is narrowed automatically. Widening
  always requires a human press. `GET` the exposure summary and it tells you, in one sentence, how
  many things this business can send your customers unattended, and which rule is binding.
- **Per-project tenancy enforced at one chokepoint**, with `project_id` a *required* positional
  argument on the scoped reads — so an unscoped caller is a compile error rather than a leak.
- **The kernel writes its own service definitions.** See below.

### The kernel writes its own services

A service ("wedge") is normally a hand-authored manifest. `authored.ts` and `wedgeauthor.ts` let the
kernel **write one** from a plain-English description of a business, and the interesting part is
what it is *not* allowed to do:

- The generated definition is validated by the same `manifestFaults`, the same closed capability and
  role vocabularies, and the same output validation as a hand-written one.
- It may not generate executable workflow code. That is refused outright, not deferred. The model
  chooses *which* computation runs and with what inputs — never the logic.
- It may not ship an approval with `required: false`, claim a role, or declare `policy` / `harness` /
  `tools`. **It cannot author away its own gate.**
- An authored slug carries a reserved prefix that the ordinary loader refuses by construction, so
  every existing call site answers "unknown service" without being individually audited.
- Promotion is behind a human, and an unusable draft is not stored at all — the run succeeds and
  reports why it refused.

Verified end to end: a design studio described in prose got a service written for it, with intake
questions about design rounds and scope creep, and approval gates it structurally cannot bypass.

## The idea

Every AI-native service is the same shape: a thin **interface** and a **harness** that does the
work. The interface is the easy ~20%. The harness is the brutal, repeated ~80% — a sandbox to run
the agent, grounding so it doesn't guess, approvals so it can touch the real world safely, secrets,
connections, tenancy, streaming, tracing, persistence, recovery.

That 80% is not your product. It's undifferentiated plumbing you'd rebuild for every wedge you test.
**Mycel is that plumbing — extracted, hardened, and open.** Your only job is the judgment: how the
work actually gets done.

> Rent the engine. Own the judgment.

## Before you start

The install path assumes these without always saying so:

| | Needed for |
|---|---|
| **Node >= 20** | everything. `setup.sh` checks this and offers to install it. |
| **git** | the `curl \| bash` one-liner clones this repo. |
| *(nothing else)* | `npm run demo` and `npm test`. Both run fully in-memory on the mock runtime. |
| **an `opencode` binary + a provider key** | **real agent runs.** Without these you get the `[mock]` trap or a 60s hang — see below. `setup.sh` offers `npm i -g opencode-ai`. |
| **Docker** | only if you choose `MYCEL_SANDBOX=docker`. Not required for local or Daytona. |
| **a Daytona API key** | only if you choose `MYCEL_SANDBOX=daytona`. |
| **Postgres** | **optional.** Without `MYCEL_DATABASE_URL` everything runs in memory and vanishes on restart. Needed for durability, for running more than one instance, and for the Postgres half of the test suite. |

## Quickstart

```bash
# 1. run the kernel
curl -fsSL https://mycelai.dev/init | bash        # or: git clone https://github.com/mycelhq/mycel && cd mycel && npm i && npm run dev
# → mycel-harness on http://localhost:4000  (prints an API key + owner login on first boot)

# 2. drive it (server-to-server; the key stays server-side)
curl -X POST http://localhost:4000/v1/tasks \
  -H "authorization: Bearer $MYCEL_API_KEY" -H "content-type: application/json" \
  -d '{"wedge":"books-keeper","task_type":"chase_receipts","input":{"period":"2026-10"}}'

# 3. watch it work (Server-Sent Events)
curl -N http://localhost:4000/v1/tasks/<id>/events -H "authorization: Bearer $MYCEL_API_KEY"
```

Scaffold a product around it with **[`create-mycel-app`](https://www.npmjs.com/package/create-mycel-app)**
(`npx create-mycel-app`).

> **There is no UI in this repository.** Mycel is a headless kernel: everything below is reachable
> over `/v1`, and the operator console is a separate consumer of that contract, not part of the
> kernel. This is deliberate — the contract is the boundary a self-hoster builds against — but it
> does mean that if you are looking for a screen to log into after `npm run dev`, there isn't one
> yet. Use `curl`, or generate a workspace UI with the frontend skill (see below).

### A business to look at

An empty kernel shows the one thing the product is not for: nothing to do. `GET /v1/moves` is a
ranked list *derived* from invoices, cases, client requests and waits, so with none of those seeded
it correctly returns `[]` — and the ranking, which is the whole idea, is invisible.

```bash
npm run demo         # kernel on :4000, in-memory, MYCEL_RUNTIME=mock, stable owner login
npm run demo:seed    # in another shell — builds "Ridgeline Books"
```

That gives you a small bookkeeping practice: five clients, five invoices (one 34 days overdue,
one 12, one due soon, one paid, one still a draft), five engagements across every stage of the
`books-keeper` ladder, two outstanding client requests, one wait blocked on a bank statement, two
schedules, and five rules the founder has taught it.

The seed script finishes by inviting you to sign in at `localhost:3000` as
`founder@ridgeline.example` / `demo-ridgeline`. **That console is not in this repository** — it is a
separate consumer of `/v1`. Read the seeded business over the API instead, which is where the
ranking actually lives:

The seed writes into the **owner's** project, and `/v1` is project-scoped with no default — so read
it back as the owner, with that project's id:

```bash
LOGIN=$(curl -s localhost:4000/v1/auth/login -H 'content-type: application/json' \
  -d '{"email":"founder@ridgeline.example","password":"demo-ridgeline"}')
TOKEN=$(echo "$LOGIN" | jq -r .token)
PROJECT=$(echo "$LOGIN" | jq -r '.projects[] | select(.name=="Ridgeline Books") | .id')

curl -s localhost:4000/v1/moves \
  -H "authorization: Bearer $TOKEN" -H "x-mycel-project: $PROJECT" | jq
```

`demo:seed` prints the project id and this same command when it finishes, so there is nothing to
retype.

> **`mycel_demo_key` will not show you this.** The kernel's API key is a *different tenant* — it
> resolves to its own key-derived project, so `GET /v1/moves` with it correctly returns
> `{"moves":[]}` even after a successful seed. That is tenant isolation working, not a failed seed.
> Project scope is required and never defaulted; there is no flag that relaxes it.

Every move comes back with the arithmetic that ranked it, which is the part worth looking at.

Every name and address in it is invented and every domain is `.example` (RFC 2606). It writes
nothing but ordinary API calls, so every row went through the same validation a real one does. It
creates no runs — see the header of `harness/scripts/seed-demo.ts` for why that omission is the
honest half of the script.

**It cannot touch a real business.** Two guards, neither of which has an override, a flag or a
`--force`: it refuses any host that is not loopback, and it refuses any kernel whose `/v1/meta`
reports a store other than `memory`. A production kernel port-forwarded to localhost passes the
first and is stopped by the second. To reset, restart the kernel — the store is in memory, so that
*is* the reset, and the seed refuses to run twice into the same project rather than duplicating it.

## What Mycel provides

**The harness runtime.** Drives [OpenCode](https://opencode.ai) (a real coding agent) inside an
isolated sandbox — local, Docker, or [Daytona](https://daytona.io) — over one task/event contract.
No bespoke agent loop. Streams every step over SSE; validates output against the wedge's schema;
persists to Postgres (or in-memory); recovers on restart.

**The service surface.** Not just tasks — the whole shape of a service business:
- **Connections** — external capabilities. The implemented kinds are `email`, `webhook`, `custom`
  (scoped read-only HTTP), `composio` (OAuth to 250+ toolkits, including Stripe, Xero and
  QuickBooks) and `linkedin`. Secrets are *referenced*, never returned, never sent to the sandbox.
  Founder- **or client-owned** (operate on a client's behalf without their credentials touching the
  agent). Wedges bind to *capabilities* — `read_payments`, `send_email` — rather than to vendors, so
  a QuickBooks user is never asked for Xero.
- **Channels / Clients / Threads** — inbound arrives on a channel, resolves to a client, appends to
  a thread, and spawns the task. Conversation history and continuity, built in.
- **The action proxy** — the generalization of model-proxying to *any* real-world action. The agent
  gets an opaque nonce; the harness holds the secret, runs the human approval gate, executes, and
  records the outbound message.

**The services in this repo.** Exactly these, and the internal ones are listed because pretending
they are products would be the easiest lie to tell here:

| Wedge | | What it does |
|---|---|---|
| `invoice-chaser` | service | Accounts-receivable dunning: chases overdue invoices, stands down when the client replies or pays. The most complete one. |
| `books-keeper` | service | Monthly close for e-commerce — integer-pence reconciliation, a stage machine, five intake questions. |
| `contract-desk` | service | Contract staffing: timesheets to billable lines, integer minor units, overtime multiplier. |
| `gtm-operator` | service | Outreach: prospecting, earned pacing, LinkedIn actions behind the approval gate. |
| `business-shaper` | `internal: true` | Machinery. Turns a description of a business into a service definition. |
| `harness-operator` | `internal: true` | Machinery. The kernel operating on itself. |
| `product-builder` | `internal: true` | Machinery. Builds the founder's own Next.js app. |

Three of them ship a **blueprint** (`invoice-chaser`, `books-keeper`, `contract-desk`) — the wedge
plus the connections and schedules it needs, provisionable in one call.

**Wedges (config, not code).** A service is a manifest + **skills** (how the job is done) +
**living knowledge** (what's true, edited at runtime with no redeploy). One horizontal engine, many
verticals — quality lives in the grounding, not the engine. See **[docs/WEDGES.md](docs/WEDGES.md)**.

**The learning loop.** Edit a draft before approving it, or leave feedback on a task, and the
correction becomes a grounding example. The wedge gets better from being used, not re-authored.

**Multi-tenant, from the core.** Org → project → member, with per-project data isolation and member
logins. A project key sees only its data; a member sees their org. Proven with isolation tests.

**Any model, fully traced.** Route any LLM through the proxy (OpenAI-compatible directly, others via
LiteLLM). Keys stay server-side; model + token budget pinned per task; every call logged to the
kernel's own durable event log, and readable back as a span tree at `GET /v1/tasks/:id/trace`.

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
only the backends (sandbox, Postgres, S3) change.

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
| `MYCEL_MODEL` | the `standard` tier | default model, provider-prefixed; per-task override via `input.model`. Tiers (`fast`/`standard`/`deep`) and their prices are in `harness/src/models.ts` |
| `MYCEL_API_KEY` | generated | founder/product key (printed on boot if unset) |
| `MYCEL_OWNER_EMAIL` / `_PASSWORD` | generated | portal owner login |
| `MYCEL_DATABASE_URL` | — | Postgres for **everything** (tasks, service surface, tenants); falls back to in-memory |
| `MYCEL_PROXY_MODE` | `0` | route model calls through the harness (keys never in the sandbox) |
| `MYCEL_ARTIFACTS` | inline | `inline` \| `fs:<dir>` \| `s3://…` |
| `PORT` | `4000` | port the kernel listens on |
| `MYCEL_URL` | `http://localhost:4000` | which kernel `npm run demo:seed` targets (loopback only — the seed refuses any other host) |
| `LANGFUSE_*` | — | optional, bring-your-own Langfuse for your own LLM debugging. Traces are always available at `GET /v1/tasks/:id/trace` without it; nothing is provisioned for you |

`npm run dev` and `npm start` load a `.env` in the kernel directory (Node's own
`--env-file-if-exists`, so no `.env` is fine and no dependency is added). Real environment variables
win over it. This is the file `setup.sh` writes — it used to be written and read by nothing, which
made every answer setup.sh collected, including the provider key, inert.

## Running with no keys, and the `[mock]` trap

> ### ⚠️ Read this before you decide the product is broken
>
> With **`MYCEL_RUNTIME=mock`** every task **succeeds** — `status: completed`, output validated
> against the wedge's real schema, the whole contract genuinely exercised — and **every string field
> contains the literal `[mock]`**.
>
> That is the fake runtime stamping a placeholder it deliberately never varies. **It is not a broken
> model, and it is not a broken install.** For real output, unset `MYCEL_RUNTIME` and give the
> kernel an agent and a provider key.

This is the trap because it is the *opposite* shape of a normal failure. The two ways a first run
goes wrong:

| | What you see | What it is |
|---|---|---|
| **The silent hang** | The first task sits in `running` at `start_opencode` for 60s, then fails `opencode failed to start (no log)` | The defaults are `MYCEL_RUNTIME=opencode` + `MYCEL_SANDBOX=local`, and a fresh clone has no `opencode` binary. There is no log because the process never existed. |
| **The `[mock]` trap** | Everything works, and writes gibberish | You set `MYCEL_RUNTIME=mock` to get past the hang. Now it looks like a product with a broken model. |

The kernel says both of these at boot rather than letting you discover them a minute later:
`runtimeAdvisories` in `harness/src/preflight.ts` prints what the first run will actually do and
names every way forward. It **warns rather than exits**, because a kernel with no agent runtime is
still a legitimate thing to run — it takes the demo seed, answers `/v1/moves`, and drives the whole
contract under `npm test`.

```bash
MYCEL_RUNTIME=mock npm run dev     # canned runs; read the box above before judging the output
npm run demo                       # better first look: a seeded business, no keys, nothing to install
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

**About the skipped tests.** A handful report `# SKIP` with a reason naming a sibling directory.
Those are drift checks against a consumer of the contract that lives in the upstream monorepo and is
deliberately not published here. They *skip rather than fail*, and the two are not interchangeable:
a hard read threw `ENOENT` before a single test registered and took the whole file down, so the
suite a stranger ran immediately after `git clone` was red. Skipping keeps upstream coverage
identical while letting this tree go green **honestly** — saying what it did not check, instead of
pretending there was nothing to check. Everything security-bearing runs in both trees.

## Roadmap

What the kernel can and can't express yet — written from a stress test against three real
agency businesses (recruiting, bookkeeping, paid ads), not a wishlist:
**[docs/ROADMAP.md](docs/ROADMAP.md)**.

## Principles

1. **Grounded, not guessing.** The agent works from the wedge's skills + knowledge, not a naked prompt.
2. **Draft-and-approve.** Every outward action pauses for a human. Autonomy is earned.
3. **Rented commodities behind interfaces.** Swap sandbox or model with one env var; nothing load-bears on a vendor.
4. **Honest signals.** Validated output, real failure reasons, no fake successes. Everything traced.
5. **Contract over packages.** The frontend is generated against the event contract, not imported.

## Repo layout

```
harness/         the kernel: /v1 contract, orchestrator, sandbox, approval gate, stores
wedges/          the seven services listed above (four real, three internal machinery)
blueprints/      a wedge plus the connections and schedules it needs, ready to provision
skills/          procedures the agent reads mid-run, including the frontend skill
docker/          the sandbox image the agent executes inside
docs/            the contract, configuration, and how a wedge is authored
```

Everything above is in this repository. `create-mycel-app` (the scaffolder) and the
operator console are published separately — they are consumers of the `/v1` contract,
not part of the kernel, and the contract is deliberately the only thing between them.
That is the same boundary a self-hoster builds against, which is why it stays a
boundary rather than a convenience.

## License

[Apache-2.0](./LICENSE). Open-core: the kernel is free and self-hostable; the hosted Cloud is the commercial layer.

---

<p align="center"><sub>github.com/mycelhq · mycelai.dev</sub></p>
