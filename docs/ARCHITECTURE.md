# Mycel — System Architecture (v2, full platform)

> **This is the north-star design, not a description of what ships today.** It names the full
> target system (Inngest durable resume, task-scoped JWTs, RBAC, per-wedge tenant isolation,
> vault-backed secrets, self-improvement loop). For what v0.1 actually enforces vs. defers, see
> the "Security model & honest limitations" section in [INTEGRATION.md](./INTEGRATION.md). Where
> this doc and the code disagree, the code (and that section) is the truth.

> The kernel for AI-native services businesses. Mycel is two planes: a **local Studio**
> where a founder chats-and-builds skills and agents, and a **cloud Runtime** where those
> agents execute real work at scale across channels, under supervision, and improve
> through a closed feedback loop. This doc is the complete subsystem taxonomy, the
> local/cloud split, the self-improvement loop, the security model, and the build phases.

---

## 1. Mental model — two planes and a bridge

The single most important structural decision: **what lives on the founder's machine vs.
what runs in the cloud.** The founder's creative work (skills, agents, chatting and
building) is local. The execution that serves end clients is cloud. Config flows up;
telemetry and feedback flow down. That round-trip is the founder's own improvement loop.

```
        ┌──────────────────────── LOCAL STUDIO (founder's machine) ─────────────────────┐
        │  `mycel dev`  ·  chat-and-build  ·  source of truth for skills/agents          │
        │                                                                                │
        │   Skill Studio     Agent Builder     Tool/MCP Builder     Local Sandbox        │
        │   (author/eval)    (compose/config)  (build integrations) (test before deploy) │
        │        │                │                  │                    │              │
        │        └──── mycel.config.ts + skills/ + agents/ + tools/  (versioned in git)  │
        └───────────────────────────────────┬────────────────────────────────────────────┘
                        `mycel deploy` (config up)  ▲  telemetry + feedback (down)
                                             ▼      │
        ┌──────────────────────── CLOUD RUNTIME (Mycel Cloud or self-hosted) ────────────┐
        │  durable harness · sandbox pool · channels · memory · approvals · self-improve  │
        │                                                                                │
        │   Identity   Channels   Harness Runtime   Memory   Self-Improvement   GTM       │
        │   & Access   (adapters) (durable+sandbox) (persist)  (closed loop)   (gated)    │
        │                                                                                │
        │              Tools & Protocols (MCP · A2A · registry)   Observability/Security  │
        └────────────────────────────────────────────────────────────────────────────────┘
                     end clients reach agents through Channels; founder supervises
```

**Why this split.** Skills are the founder's unfair advantage and their creative surface,
so they stay local, in the founder's repo, editable by chatting with the agent. The
runtime is heavy, always-on, and multi-tenant, so it's cloud. `mycel deploy` is the seam.
Both planes are open-source and self-hostable; the hosted Cloud is the paid convenience.

---

## 2. Subsystem taxonomy (the map)

Eleven subsystems across the two planes plus two cross-cutting concerns.

```
IDENTITY & ACCESS ──────── founder auth (Google/GitHub OAuth), API keys, task-scoped
                           JWTs, RBAC, per-wedge tenant isolation
SKILL SYSTEM ───────────── versioned composable capabilities; Studio to author + eval;
                           registry; self-improving example sets   [LOCAL-first]
AGENT SYSTEM ───────────── declarative agent configs, templates, autonomy levels,
                           guardrails, benchmarks                  [LOCAL-first]
HARNESS RUNTIME ────────── durable task orchestration + sandboxed execution + approvals
                           + streaming + artifacts + cost limits   [CLOUD]
TOOLS & PROTOCOLS ──────── tool registry + permissions; MCP (host+consume); A2A;
                           interop; Tool/MCP builder                [BOTH]
MEMORY SYSTEM ──────────── short-term run scratch + long-term persistent (vector +
                           structured), per wedge/entity, policy-driven   [CLOUD]
CHANNEL SYSTEM ─────────── adapters: WhatsApp, IG, email, web widget, Slack, SMS, voice,
                           API; inbound→task, output→channel w/ approval  [CLOUD]
SELF-IMPROVEMENT LOOP ──── outcomes measured → configs/skills updated → benchmarked →
                           promoted if better; auditable            [CLOUD→LOCAL]
GO-TO-MARKET PLANE ─────── founder-gated: sourcing, outreach, scheduling; itself built
                           from agents+skills+channels              [CLOUD, gated]
OBSERVABILITY ──────────── tracing, cost, benchmark dashboards, audit logs   [BOTH]
─────────────────────────  cross-cutting  ─────────────────────────
SECURITY MODEL ─────────── sandbox isolation, least-privilege grants, approval gates,
                           secret vault, PII, signed skill provenance
PROTOCOL / TYPES ───────── @mycel/protocol: the task/event/skill/agent contracts shared
                           everywhere (one TypeScript source of truth)
```

---

## 2b. Repository structure & extensibility model

Four roots, with a **capability-agnostic core** — the single most important structural rule.
Core never hardcodes a provider, channel, or wedge; everything optional is a plugin behind a
versioned SDK.

```
mycel/
  core/         runtime, agent loop, sessions, gateway, config, routing — PLUGIN-AGNOSTIC
  packages/     versioned SDK + contract libs (shared by core AND third-party plugins):
                @mycel/protocol · @mycel/plugin-sdk · @mycel/agent-core · @mycel/gateway-protocol
  plugins/      everything optional: model providers, channel adapters, harness bridges
                (claude-code/opencode/copilot), tools, memory backends, skill bundles
  clients/      the dashboard (Next.js) + frontend skills (generate the UI) + the mycel CLI
```

**Plugin model (manifest-first).** Each plugin ships a declarative `mycel.plugin.json` read
*before any code loads*: `id, version, activation{onStartup, onHarness[], onDemand},
configSchema (JSON Schema, additionalProperties:false), channels/providers/skills declared,
authChoices, uiHints`. Code entry is one typed hook: `register(api: MycelPluginApi)` where
the api exposes `registerTool, registerChannel, registerHarness, registerHook,
registerService, emitAgentEvent, ...`. Two tiers: **bundle plugins** (skills/MCP/config —
safe, preferred for founders) and **code plugins** (deep runtime hooks). Boundaries enforced
by tsconfig project refs + an SDK-surface check in CI.

**Storage & config discipline (stolen):** one canonical store (Postgres for the multi-tenant
cloud), no sidecar files; a `mycel doctor` tool owns all config/schema
migrations (runtime only ever reads the current shape); `SecretRef` indirection for secrets
(fail-closed, per-owner isolation, never logged); an explicit config-surface budget to fight
sprawl.

---

## 3. Subsystems in detail

### 3.1 Identity & Access
- **Founder auth:** OAuth (Google, GitHub) via Auth.js/WorkOS; email fallback. Founders
  own an org (workspace).
- **Machine access:** scoped **API keys** for server-to-server; short-lived **task-scoped
  JWTs** minted by the founder's backend for browser embeds (kernel key never leaves the
  server).
- **Tenancy:** every object is scoped to `org → wedge`. Hard isolation between wedges so
  one client's data never bleeds into another. End-client identities (the businesses/
  people a founder serves) live *under* a wedge, separate from founder identity.
- **RBAC:** owner / operator / viewer at minimum; approval rights are a distinct grant.

### 3.2 Skill System  (local-first — the heart)
- A **skill** = a versioned, composable unit of capability: instructions + allowed tools +
  few-shot examples + **eval cases**. (Same shape as Claude Code / gstack skills.) Files in
  the founder's repo under `skills/`; the repo is the source of truth.
- **Skill Studio** (local): the founder chats with an agent to author, edit, and test a
  skill, run its evals, and see diffs. This is the "chat and build" surface, always local.
- **Registry + sharing:** skills publish to the runtime on deploy; open-source skills are
  shareable (a community marketplace is the OSS flywheel).
- **Self-improving:** a skill's example set is promoted/demoted from real outcomes (see 3.8).
  Every change is gated on the skill's eval suite — no silent regressions.

### 3.3 Agent System  (local-first)
- An **agent** = a declarative composition: `{ model, skills[], tools[], memory_policy,
  autonomy_level, guardrails, output_schema, channel_bindings }`. Config as code
  (`agents/*.ts` or YAML), so it's diffable, reviewable, benchmarkable.
- **Templates:** starting points (`inbound-lead-operator`, `document-corrector`,
  `followup-closer`) so a founder stands up a wedge in minutes.
- **Autonomy levels:** `draft-only → approve-to-send → auto-with-guardrails → autonomous`.
  Trust is earned by moving an agent up the ladder as its benchmarks hold.
- **Benchmarks:** each agent has an eval suite; config changes run against it before deploy.

### 3.4 Harness Runtime  (cloud — the execution core)
Durable orchestration (Inngest) + sandboxed execution (Daytona/OpenCode) + approval gating
+ event streaming + artifacts + hard cost/runtime limits. This is the runtime designed in
v1; it is now *one* subsystem, driven by Agent+Skill config rather than hard-coded. Detail
in §5 (runtime flow) and §7 (failure modes) below.

### 3.5 Tools & Protocols  (both planes) — three-layer strategy
Three cleanly separated protocol surfaces:

1. **Mycel gateway protocol** — typed wire format between the runtime and its clients (CLI,
   dashboard, embeds, the founder's harness). Additive-first versioning.
2. **MCP, both directions** — Mycel is an **MCP server** (exposes its tools/skills/wedge
   capabilities so the founder's Claude Code/OpenCode/Copilot can call them) AND an **MCP
   client** (agents consume any external MCP server). This is the backbone of the Local
   Studio (§4).
3. **ACP-style harness bridge** — a deployed Mycel agent can delegate execution to an
   external coding harness (Claude Code, Codex, OpenCode) while Mycel keeps session,
   permission, channel, memory, and billing ownership. Mycel is a hub over harnesses.

Plus:
- **Tool registry:** tools granted **per task, least-privilege**; high-risk tools (send,
  pay, delete) require approval.
- **A2A (agent-to-agent):** agents delegate sub-tasks to other agents; delegation is itself
  a task on the runtime.
- **"OFP":** you named this as a third protocol — confirm which one (open agent/finance
  protocol?). A generic interop adapter slot is reserved so it drops in without a rewrite.

### 3.6 Memory System  (cloud)
- **Short-term:** per-run scratch (the sandbox filesystem + run context).
- **Long-term persistent:** per `wedge` and per `entity` (a client, a lead, a student):
  vector store (semantic recall) + structured store (facts, history). Grounds the agent
  in "what we know about this client."
- **Policy-driven:** each agent declares what it may read/write and retention/PII rules.
- Feeds grounding *and* the self-improvement loop.

### 3.7 Channel System  (cloud)
- **Adapters** normalize the outside world: WhatsApp, Instagram, Gmail/email, web widget,
  Slack, SMS, voice, raw API. Inbound message → a **task**; agent output → the channel,
  **gated by approval** for risky sends.
- **Adapter interface:** `receive() → NormalizedInbound`, `send(approvedOutput)`,
  `capabilities()`. Compliance (e.g. WhatsApp Business API rules) enforced in the adapter.
- Channels are how the harness "interacts with the world" and how end clients reach agents.

### 3.8 Self-Improvement Loop  (cloud → local, the moat)
The closed, auditable loop you asked for. Not vibes — measured.

```
   agent run ─► outcome captured ─► measured vs. wedge KPI ─► candidate config/skill edit
       ▲                                                              │
       │                                                     run eval / benchmark
       │                                                              │
   promote if better  ◄──── A/B or shadow test ◄──── gate: no regression on eval suite
       │
       └─► telemetry + the diff surface back to the LOCAL Studio (founder reviews/approves)
```

- **Unit of learning:** a skill's example set and a wedge's `knowledge_config` (winning
  scripts, objection handlers), not model weights (v1).
- **Gate:** every candidate improvement must pass the skill/agent eval suite and beat the
  incumbent on the wedge KPI (e.g. reply→booking conversion) in a shadow/A-B test.
- **Auditable:** every promotion is a versioned, reviewable change. The founder sees it in
  the local Studio and can approve/reject. Autonomy of the *loop itself* is configurable.

### 3.9 Go-To-Market Plane  (cloud, founder-gated)
Sourcing (Apollo/Maps/IG), enrichment, qualification, outreach drafting, scheduling,
follow-up. Built *from the same substrate* — GTM is just a wedge Mycel ships for the
founder, running agents+skills+channels. Never exposed to end clients.

### 3.10 Observability
Tracing (every step/tool/cost as an event), cost dashboards, benchmark/eval dashboards,
audit logs. Present in both planes: local for dev, cloud for production.

### 3.11 Security Model  (cross-cutting)
- **Isolation:** each run in its own sandbox (Daytona microVM/container); no shared state.
- **Least privilege:** per-task tool grants; secrets from a vault, never in prompts/logs.
- **Approval gates:** high-risk actions (send, pay, delete, share) require human approval.
- **Data isolation:** hard per-wedge/per-tenant boundaries; PII tagging + retention policy.
- **Egress control:** sandboxes get scoped network access, not open internet by default.
- **Supply chain:** skills/tools are signed; provenance tracked (you're shipping other
  people's skills into execution — this matters).

---

## 4. The Local Studio — plug into the founder's harness, don't build a chat

**Decision: Mycel does NOT ship a chat UI.** The founder already lives in a coding agent
(Claude Code, OpenCode, Copilot). That IS the chat-and-build surface. Mycel plugs into it.
This is the proven model for a hub over harnesses (details in
`internal` notes). Building our own chat would be redundant and worse.

The local plane is three thin things:

1. **Mycel MCP server** (`mycel mcp`) — exposes Mycel's capabilities as MCP tools to whatever
   harness the founder chats with: `create_skill`, `edit_agent`, `run_task`, `inspect_run`,
   `list_wedges`, `deploy`, `tail_logs`. The founder says "build me an inbound-lead agent for
   this wedge" *in Claude Code*, and Claude Code calls Mycel's MCP tools to do it.
2. **A skill/config bundle** — dropped into the founder's harness (e.g. `.claude/skills/mycel/`)
   so their agent knows Mycel's conventions, schemas, and how to scaffold skills/agents.
3. **The `mycel` CLI** — the thin control surface: `init`, `dev` (local runtime + sandbox for
   testing), `deploy`, `logs`. No GUI. Everything visual is either the founder's harness or
   the cloud dashboard.

```
   Founder chats in  ── Claude Code / OpenCode / Copilot ──┐
   (their harness)                                          │ MCP tools (mycel mcp)
                                                            ▼
   skills/ agents/ tools/ mycel.config.ts  ◄──build/edit──  Mycel (local)
        │  (in the founder's git repo = source of truth)     │  mycel dev (test locally)
        │                                                      │
        └──────────────── mycel deploy (config UP) ───────────┘
                                    │
                                    ▼
        Cloud Runtime ── agents live on channels ── telemetry + improvement diffs (DOWN)
```

**The other direction (ACP bridge):** a *deployed* Mycel agent can itself delegate execution
to Claude Code / Codex / OpenCode as its runtime harness, while Mycel owns the durable
session, approvals, channels, memory, and billing. Mycel is a hub over harnesses, not a
replacement for them.

- **Always local:** skills, agent configs (the founder's IP, in their git repo), and the
  chat-and-build loop (via their harness + Mycel MCP).
- **Deployed:** runtime, channels, memory, approvals, GTM — the always-on execution.
- **Install guides:** `mycel init` (local), add the Mycel MCP server to your harness,
  `mycel deploy --cloud` (hosted, one command), or self-host (compose for one box, helm for
  scale). Ship one-click Fly + Render configs with an auto-generated gateway token.

---

## 5. Runtime flow (durable, config-driven, with approval suspend)

```
inbound (channel) ─► task/created ─► [Inngest runTask]
   ├─ load agent + skills + wedge knowledge_config + memory
   ├─ provision Daytona sandbox (idempotent)         [isolation]
   ├─ grant least-privilege tools (+ MCP servers)    [security]
   ├─ run OpenCode agent ─► events ─► Redis ─► SSE ─► founder/embed
   ├─ IF high-risk action: approval.requested → step.waitForEvent(timeout) → resume|expire
   ├─ validate output vs schema · enforce max_cost/max_runtime
   ├─ persist artifacts · write memory · record feedback
   └─ always: destroy sandbox (no leak)
```

Stack unchanged from v1: **TypeScript** everywhere, **Inngest** (durable + `waitForEvent`
approvals), **Postgres** (system of record), **Redis** (SSE fan-out), **S3** (artifacts),
**LiteLLM** (model gateway), **Daytona/OpenCode** (sandboxed agent), **Next.js** dashboard +
**frontend skills** that generate the founder's UI against the event contract.

---

## 6. Data model (expanded)

```
identity:  orgs · founders · oauth_accounts · api_keys · memberships(rbac)
catalog:   wedges · skills · skill_versions · agents · agent_versions · templates
kernel:    tasks · task_steps · agent_runs · tool_calls · approvals · artifacts ·
           cost_events · events · feedback_events
memory:    memory_entities · memory_facts · memory_vectors
channels:  channel_connections · inbound_messages · outbound_messages
improve:   knowledge_configs · eval_suites · eval_runs · benchmark_results · promotions
gtm:       leads · reply_drafts · bookings · followups · customers
```

Kernel + memory + improve are wedge-agnostic (the reusable core). Wedge/product tables
stay separate so a wedge can be dropped without touching the kernel.

---

## 7. Failure modes (designed in)

| Failure | Handling |
|---|---|
| Worker dies mid-task | Inngest durable step resume |
| Approval never resolves | `waitForEvent` timeout → `expired` |
| Cost / runtime runaway | worker enforces hard kill |
| Orphaned sandbox | cleanup in always/onFailure step |
| Late SSE subscriber | persisted events + `Last-Event-ID` replay |
| Duplicate external action on retry | idempotency keys on send/book/charge |
| Kernel key in browser | task-scoped JWT only |
| Skill regression from self-improve | eval-suite gate blocks promotion |
| Malicious/broken shared skill | signed provenance + sandbox isolation + tool grants |

---

## 8. Build phases (complete scope, sequenced)

Nothing cut. Order chosen so a real task runs early and each plane comes online in a
testable way.

1. **Protocol + Runtime core** — `@mycel/protocol`, api (POST /tasks + SSE), worker
   (Inngest runTask), Postgres, S3 artifact, mock agent runtime. One task end-to-end.
2. **Approvals + safety** — suspend/resume, TTL, cost/runtime kill, schema validation.
3. **Real agent** — swap mock for OpenCode-in-Daytona + LiteLLM behind the runtime interfaces.
4. **Skill + Agent System** — skill/agent config schema, templates, eval suites.
5. **Local Studio** — `mycel` CLI: `init`, `dev` (chat-and-build), `deploy`.
6. **Channels** — adapter interface + first adapters (web widget, email, WhatsApp).
7. **Memory** — persistent per-wedge/entity store + policies.
8. **Self-improvement loop** — outcome capture, eval gate, promotion, Studio review.
9. **Tools & Protocols** — registry, MCP host/consume, A2A, Tool/MCP builder.
10. **Identity + multi-tenant + GTM + packaging** — OAuth, RBAC, hosted + self-host images.

Dashboard + frontend skills (generate the UI) grow alongside from phase 5.

---

## 9. Open questions (do not block phase 1)

1. **"OFP" protocol** — confirm which interop protocol you meant (MCP + A2A are in; is
   OFP a third, e.g. an open agent/finance protocol?).
2. Auth provider: Auth.js (own it) vs WorkOS/Clerk (buy it) for Google/GitHub OAuth.
3. Local Studio runtime: does `mycel dev` run a trimmed local copy of the cloud runtime,
   or a distinct lighter path? (Leaning: same runtime, local backing services.)
4. Memory store: pgvector (one datastore) vs a dedicated vector DB.
5. License: open-core (Apache core + proprietary hosted/GTM) vs BSL — decide before public.
