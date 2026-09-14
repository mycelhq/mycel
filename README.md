<img src="design/brand/banner-readme.png" alt="Mycel — draft, approve, invoice." width="100%">

<p align="center"><strong>The open kernel for AI-native service businesses.</strong></p>
<p align="center">
  OpenCode in a sandbox. A human on every send.<br>
  Clients, cases, approvals, invoices — not another chat loop.
</p>

<p align="center">
  <img src="design/brand/next-moves.gif" alt="Ranked next moves: chase overdue invoices with the score shown, a human gate above them." width="820">
</p>
<p align="center"><sub>
  Ranked next moves on <code>npm run demo:seed</code>. Filmed on Cloud against this kernel, on an earlier seed.
  The clone is headless — Cloud is a <code>/v1</code> consumer, not in the repo.
</sub></p>

<p align="center">
  <a href="https://github.com/mycelhq/mycel/actions/workflows/ci.yml"><img src="https://github.com/mycelhq/mycel/actions/workflows/ci.yml/badge.svg" alt="ci"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="Apache-2.0"></a>
  <a href="https://mycelai.dev"><img src="https://img.shields.io/badge/hosted-mycelai.dev-111.svg" alt="mycelai.dev"></a>
  <a href="https://github.com/mycelhq/mycel/stargazers"><img src="https://img.shields.io/github/stars/mycelhq/mycel?style=social" alt="GitHub stars"></a>
</p>

```bash
git clone https://github.com/mycelhq/mycel && cd mycel
npm i && npm run demo      # no keys, no Docker, no Postgres, one terminal
```

Boots a kernel, seeds a real service business into it, and prints **the work it thinks you should
do next** — ranked, with the arithmetic that put each item where it is:

```
  1   77.8  chase invoice         Invoice INV-0001                  $2,970.00
      INV-0001 is 34 days overdue with $2,970.00 outstanding; never chased
      money +27.8 · deadline +30 · staleness +20
      ⏸ Not chasing INV-0001: this business has no mailbox connected, so the
      reminder could be written but never sent and nothing would reach your client.
```

That order came from the seeded state, not from a model. You can argue with the weights — they are
in the API. The kernel stays up afterwards, so `GET /v1/moves` returns the same list as JSON.

`npm test` is the other first look: the suite drives the whole `/v1` contract against a mock agent
in-process. If it is red, the clone is broken — not your machine.

> **Pre-alpha.** The core is real and tested. APIs still move. Watch the repo; don't pin to it yet.
> [CHANGELOG](./CHANGELOG.md).

---

## What this is

Plenty of things run an LLM in a loop. Mycel is the **operating system around that loop** for a
firm that sells work: a client logs in, a job runs in a sandbox, nothing reaches the outside world
until a human approves, the artifact is a deliverable, the money is an invoice.

A **wedge** is a service as config — `wedge.json` + skills (how) + knowledge (what's true) — not a
fork of the engine. Bookkeeping, dunning, GEO, recruiting, and a contract desk all sit on the same
kernel.

The agent **never holds a credential.** It gets an opaque nonce. The harness holds the secret, shows
a preview, executes on approve, and writes an audit row. There is no code path from the sandbox to
the network that skips that gate.

```mermaid
flowchart LR
  API["Your API"] --> Box["Sandboxed OpenCode<br/>skills + knowledge · no secrets"]
  Box --> Gate["Human gate<br/>approve / edit / reject"]
  Gate --> Conn["Connection<br/>the real send"]
```

The secret never enters the box. The host of every write comes from the connection, not from the
agent.

Hosted Cloud (invite-only) is the commercial layer: [mycelai.dev](https://mycelai.dev).
This repository is the kernel. Apache-2.0, self-host it.

## Why not the thing you already have

| | You write a graph | A chat “employee” | Mycel |
|---|---|---|---|
| Loop | LangGraph, Crew, your own | An off-the-shelf agent, or your own | We don't own one. We drive [OpenCode](https://opencode.ai). |
| What you get | Nodes and state | A conversation that can use tools | **A firm:** clients, cases, waits, deliverables, invoices, a portal contract |
| Secrets | Your problem | Often in the box or the prompt | Nonce in the box. Host of every write comes from the connection. |
| Outward action | DIY | Varies | Structural gate. Policy envelopes can skip-review *inside* a declared cap; widening cannot. |
| Vertical | Prompt + tools | Prompt + tools | Wedge = manifest + skills + knowledge. One engine, many trades. |

If you want a generalist that runs your company from a chat, this is the wrong repo.
If you want the kernel under a service business you actually bill, it is the right one.

## Try it (no keys)

```bash
npm run demo         # boot + seed + the ranked moves, one terminal
```

Iterating on the seed? `npm run demo:kernel` keeps a server up across runs and `npm run demo:seed`
re-seeds it.

Five clients, invoices in every state, engagements, a wait blocked on a bank statement, ranked
**moves** derived from that state. There is **no UI in this repository** — Mycel is headless. The
console at `:3000` is a separate consumer of the same contract, not part of the kernel. The GIF at
the top, and this invoice, are that consumer — filmed on an earlier seed, so the business and client
names differ from what `demo:seed` builds today:

<p align="center">
  <img src="design/brand/money-owed.png" alt="Invoice INV-0001 Harborline Ceramics, overdue, $1,450 still to pay." width="820">
</p>

### A business to look at

The seed writes into the **owner's** project. `/v1` is project-scoped with no default, so read it
back as the owner, with that project's id. `demo:seed` prints the same command when it finishes.

```bash
LOGIN=$(curl -s localhost:4000/v1/auth/login -H 'content-type: application/json' \
  -d '{"email":"founder@sightlineresearch.example","password":"demo-sightline"}')
TOKEN=$(echo "$LOGIN" | jq -r .token)
PROJECT=$(echo "$LOGIN" | jq -r '.projects[] | select(.name=="Sightline Research") | .id')

curl -s localhost:4000/v1/moves \
  -H "authorization: Bearer $TOKEN" -H "x-mycel-project: $PROJECT" | jq
```

> **`mycel_demo_key` will not show you this.** That API key is a *different tenant* — it resolves
> to its own key-derived project, so `GET /v1/moves` with it correctly returns `{"moves":[]}` even
> after a successful seed. That is tenant isolation working, not a failed seed.

A task, from curl:

```bash
curl -X POST http://localhost:4000/v1/tasks \
  -H "authorization: Bearer $MYCEL_API_KEY" -H "content-type: application/json" \
  -d '{"wedge":"books-keeper","task_type":"chase_receipts","input":{"period":"2026-10"}}'

curl -N http://localhost:4000/v1/tasks/<id>/events \
  -H "authorization: Bearer $MYCEL_API_KEY"
```

Or: `curl -fsSL https://mycelai.dev/init | bash` — same tree, `setup.sh` writes the env.

Scaffold a product on the contract with [`npx create-mycel-app`](https://www.npmjs.com/package/create-mycel-app).

### If every field says `[mock]`

That is the fake runtime stamping a placeholder, not a broken model — `npm test` and
`npm run demo` use it on purpose. Switching to a real agent, and the other first-run trap, are
in [AGENTS.md](./AGENTS.md).

---

## What Mycel provides

**Sellable wedges** (config you can provision):

| Wedge | What it does |
|---|---|
| `invoice-chaser` | Dunning. Stands down when they reply or pay. The most complete loop. |
| `books-keeper` | Monthly close — integer-cent reconciliation, stages, intake. |
| `contract-desk` | Timesheets → billable lines, integer minor units. |
| `geo-monitor` | AI-search / GEO week: probe real surfaces, report, sized work. |
| `gtm-operator` | Outreach behind the same gate. |
| `recruiting-desk` | Sourcing / screening as cases. |
| `security-questionnaire` | Vendor security questionnaires. |
| `content-desk` | Angles, a plan, and the posts — same gate before anything publishes. |

`invoice-chaser`, `books-keeper`, and `contract-desk` ship a **blueprint** (wedge + connections +
schedules in one `POST`).

**Machinery** (`internal: true`, not products): `business-shaper` (description → service definition)
and `product-builder` (the founder's app).

A generated definition **cannot author away its own gate** — no `required: false` on approvals, no
executable workflow code, no raising harness ceilings. Promotion is a human.

**The rest of the kernel**

- Harness profiles (`decide` / `operate` / `build`) — toolset, budget, whether the box even gets an
  action token. Authored JSON cannot raise a ceiling; the plan clamps down.
- Connections: `email`, `webhook`, `custom`, `composio` (OAuth, 250+ toolkits), `linkedin`. Bind to
  *capabilities* (`send_email`, `read_payments`), not vendors.
- Hash-chained audit log. `GET /v1/audit/verify` names the first broken link.
- Stated vs observed knowledge — a founder claim that contradicts something the system watched is
  declined, not averaged.
- Autonomy that **narrows** itself on rejection rate and never widens itself.
- Postgres if `MYCEL_DATABASE_URL` is set; otherwise in-memory (fine for the first hour, gone on
  restart).

How to write a wedge: **[docs/WEDGES.md](docs/WEDGES.md)**.
What the kernel still cannot express: **[docs/ROADMAP.md](docs/ROADMAP.md)**.

## Build it, change it

```bash
npm i && npm test
```

Commands, environment, repo layout, the optional outside services and the constraints worth
knowing before you change anything: **[AGENTS.md](./AGENTS.md)** — the
[open convention](https://agents.md) for this, so your coding agent finds it on its own.

## Principles

1. **Grounded, not guessing.** Skills + knowledge, not a naked prompt.
2. **Draft-and-approve.** Outward action pauses. Autonomy is earned, never self-widened.
3. **Rented commodities.** Swap sandbox or model with one env var.
4. **Honest signals.** Validated output, real failures, no fake successes. The `[mock]` stamp exists
   so mock cannot impersonate a model.
5. **Contract over packages.** No `@mycel/react`. Generate UI against `/v1`.

## License

[Apache-2.0](./LICENSE). Open-core: this kernel is free and self-hostable, with no metering, no seat
limit and no expiry — bring your own model key.

**The engine is open. The interfaces and the hosted operation are paid.**

You get the whole thing that runs a service business, not a demo of it: the `/v1` contract, the
harness and every gate, clients, cases, engagements, deliverables, **invoices and the chase ladder**,
the **client portal contract**, the **machinery for finding clients**, approvals, earned autonomy,
knowledge and memory, the scheduler, connections, the hash-chained audit log, and every service
definition. Count the routes if you doubt it — `docs/OPEN-CORE.md` gives the command.

**Mycel is headless** — there is no UI in this repository. There is one, and it is also open:
[mycelhq/console](https://github.com/mycelhq/console), its own repo, depending on nothing but `/v1`.
That separation is the claim, not an accident of packaging: anything the console does, your own app
can do, and a console living inside the kernel would quietly suggest otherwise.

What is genuinely not open: the client-facing portal app, sign-up and billing, and our own
go-to-market.

The line, and the three rules used to decide it: **[docs/OPEN-CORE.md](./docs/OPEN-CORE.md)**.

## Who is building this

A small team that got here by running a service business on this kernel before selling it to anyone
— which is why the awkward parts are documented rather than hidden. Most of the long comments in this
repository are a bug we paid for written down so the next person does not.

If you are running a service firm and something here does not fit your trade, that is the most useful
issue you can open. The kernel is supposed to take a business nobody here has ever run — see
[docs/FITTING-A-TRADE.md](./docs/FITTING-A-TRADE.md) — and every trade that does not fit is a hole in
that claim.

## Star history

<a href="https://star-history.com/#mycelhq/mycel&Date">
  <img src="https://api.star-history.com/svg?repos=mycelhq/mycel&type=Date" alt="Star history chart" width="620">
</a>

<p align="center"><sub><a href="https://github.com/mycelhq/mycel">github.com/mycelhq/mycel</a> · <a href="https://mycelai.dev">mycelai.dev</a></sub></p>
