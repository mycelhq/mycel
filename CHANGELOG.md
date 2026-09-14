# Changelog

Mycel is published as a **distribution**: each release of `mycelhq/mycel` is a snapshot built from
the monorepo the kernel is extracted from, not a replay of day-to-day commits. So this file is the
only place the intervening work is visible, and it is written from the actual commit history rather
than from a release plan. Short hashes refer to upstream commits and are here so a claim can be
traced to the change that made it true.

The project is **pre-alpha**. Entries below describe what landed, including the things that were
removed again — a capability that was withdrawn is more useful to know about than one that was
added, and this file records both.

## Unreleased — since 0.2.0

Roughly 590 upstream commits touching the kernel. This entry is written before the snapshot is cut,
because a changelog that stops a month before anyone looks is worse than no changelog: the README
tells people to watch the repo, and the last thing it showed them was August.

The theme: `0.2.0` was a harness that could be trusted to run unattended. This is a harness that
learns the trade from the customer instead of being told it, and that admits when it has not
finished.

**The trade comes from the customer's work, not from our catalogue** (`cd5dd6de`). Thirteen wedges
used to decide what a business was allowed to be; a firm that fit none of them got the nearest
neighbour, which is a different business. `draft_practice` now reads one deliverable the firm has
already sent and derives the method — the object, the question the client is paying to have
answered, what it needs each cycle, and what makes one correct. That practice is mounted into every
later delivery run, below the exemplar it was read from and above the wedge. The catalogue is
demoted to reference, not deleted. `9c6d9125` filed the output, which the first version did not:
the run validated, charged, and wrote to an artifact nothing reads.

**A run that fans out finishes its work** (`d6012fc9`). A parent that opened a batch was marked
`succeeded` the moment its children joined, with its own plan half executed. For `weekly_report` —
plan five steps, spawn six probes at step two, park — that meant the report was never written and no
deliverable was ever created, while the task reported success. Parents are re-run with the
children's output mounted, capped at two rounds, and the abort that parked them is cleared first, or
they park again instantly for the reason they were parked with.

**The run is told the rule it is judged by** (`090ba6d7`, `7a8f1632`). `client-ready` refuses to
release a covering note containing an internal word, and that list lived only in the gate. A
finished report was held for the word "probes" — a test nothing could pass except by luck, at full
cost. The list is now in the instruction, with substitutions, because a prohibition with no
alternative makes a model choose between being accurate and being compliant.

**Export** (`61dbd33a`). `GET /v1/export` returns everything one project holds, including every
deliverable version rather than only the released ones, because the difference between what an agent
wrote and what a human sent is the customer's record of their own judgement. The privacy policy and
the DPA had promised this for some time.

**The learning signal is read** (`c2ab4f16`, `0449beb0`, `dc97ce5e`, `5085f263`, `7ec032fd`).
Correction distance has accumulated since founders could edit and nothing consumed it. Untouched
drafts count as zeroes — leaving them out showed a flat line on the best month a business ever had.

**Quality, on the path that actually delivers** (`575f35ad`, `19bfdf20`, `3495f0ea`, `0df75701`).
The second reader did not run on the delivering path, the fulfilment gate covered 37% of the
product, and the only thing ever asked how good a deliverable was, was the thing that wrote it. A
disqualifying verdict now returns to the agent once before a human sees it.

**The first run, measured instead of assumed** (`ffef8b04`, `7d9c7718`, `df03d855`, `49c7cb8f`).
Every defect below was invisible from inside the monorepo and obvious within ninety seconds of
staging the published tree and running it the way a stranger would. That is the method, and it is
worth more than the fixes.

`npm run demo` is one command now. It boots, seeds a service business, and prints the ranked work
with the arithmetic that put each item where it is. It used to be a blocking server; seeing anything
meant a second terminal, `npm run demo:seed`, a wall of text telling you to curl, a login-token
dance with `jq`, and raw JSON. The split was a trap as well as a chore — the two halves had to agree
on an owner email and password declared separately, so booting the kernel by hand gave you a seed
that could not log in. `demo:kernel` keeps the old server for contributors iterating on the seed.

The README's first interactive command had returned `{"error":"invalid credentials"}` for eight
months. The demo business was renamed from a British bookkeeper to Sightline Research and the README
was never updated. The guard on that block asserted the old email as a literal, so it could only
fail when the README changed, never when the seed did.

And `demo:seed` closed by printing seven links into a UI **this repository does not contain** —
the console is a separate consumer of `/v1`, which the README states plainly and the seed did not.
On a fresh clone every link refused the connection, and the available conclusion was that the seed
had failed.

**Documentation that fails in CI instead of silently** (`96a8b73d`, `fd230f02`, `2d18c165`,
`6d561201`, `058090d0`). Docs rot without a stack trace: there is just a person who runs the first
command, gets an error, and closes the tab. Ten checks now resolve what the docs CLAIM against the
repo — every `npm run`, every wedge and task type in an example request, every link, image and
source path, every `/v1` endpoint against the 383 the harness registers, and every environment
variable the kernel names in an instruction. They cover `setup.sh` too, which is documentation that
executes: the README advertises `curl … | bash`.

What that found: the contract reference documented `uk-property-sourcing`, a wedge that has never
existed here, with `agent`, `memory` and `channels` blocks real manifests dropped long ago — so a
first wedge written from that spec produces a file the kernel does not read. `harness-operator` was
deleted deliberately and two docs went on listing it. `content-desk` shipped and the README's table
never learned about it. Preflight told operators to set `MYCEL_LITELLM_URL` and
`MYCEL_LITELLM_MASTER_KEY`, and neither appeared in any doc or in `.env.example`.

**Whichever key you set is the provider you get** (`d6e67fcf`, `f026ae83`, `b5e34871`, `69b3a6e7`).
Four capabilities reached one hardcoded vendor each — our cost-optimised picks, which are a reason
that belongs to us and to nobody cloning this. All nine options are implemented now: Google Places
beside Azure Maps, Jina Reader beside Firecrawl, Tavily beside Serper and Brave, Hunter beside
FullEnrich. Two questions collapse into one, because the second — *which provider?* — is the one
people answer wrong in a way that fails at runtime rather than at boot.

Tavily needed care rather than a third branch: it reads a Google dork as MEANING, so `-jobs
-careers` is absorbed rather than refused and the query inverts at 200 with a full result set and
nothing to warn on. And the suggestion a newcomer is given is no longer the first in list order —
that ranks by quality and was sending people to a sales form. Boot prints which capabilities are on
and the one variable that turns each of the rest on, because `GET /v1/gtm/availability` answered all
of this perfectly from behind a bearer token at a path nobody guesses.

**A fact belongs to the business, not to the wedge that learned it** (`49181dc9`, `2b6a984d`).
Retrieval ended at `r.wedge !== ctx.wedge`, which made three silos of one company: the VAT scheme a
human typed during a monthly close was unreachable when the invoice chaser wrote to that same
customer, so the business asked Dana in finance the same question three times. Facts cross; craft
does not. A crossing fact is ranked to yield, and one client's fact still never reaches another.

**Interrupted runs, told apart** (`efb0aa3b`). "recovered 12 interrupted task(s)" covered three
different pieces of news — a queued run put back with nothing sent and nothing charged, a batch
parent rejoined, and a run that actually died. Twelve failed after a restart is a signal; twelve
requeued is nothing. The honest-limitations doc said all three were marked `failed`, which was true
when it was written.

**Contributor hygiene** (`ac6d60df`, `c49f17da`, `0b84cd0d`, `676571d4`). The public repo's CI ran
every contributor's PR twice and cancelled nothing. `engines` was advisory, so on an old Node the
README's promise failed as a stack trace rather than a version message. CONTRIBUTING valued things
that all begin "understand the architecture first" and offered nothing a person could do on the
evening they cloned it — adding a provider is that, and it is real rather than invented for the
occasion. Plus the files GitHub's community profile looks for and this repo did not have.

**Tests against a real Postgres** (`91cb8aae`, `ed5ad3c3`, `72dc747a`, `1351f012`). The live tier
could not be trusted, so nobody ran it; every version submitted on Postgres had been failing to
prepare. Every SQL builder is now handed to Postgres and asked whether it is legal.

**Removed: an auto-release that bypassed consent** (`9a488292`). Built and withdrawn inside a day.
It read the correction history, decided a gate and released deliverables without checking whether
the founder had turned auto-release on — which `release-policy.ts` has always required, defaulting
to off. It contradicted the product's central promise and duplicated a mechanism that was already
correct.

**Security** (`484b691a`, `7078848e`, `316b47e2`, `c9505f30`). A live OpenAI key was reachable
inside every build sandbox for an afternoon; image generation moved to AWS with nothing secret in
the sandbox. Two auth endpoints had no rate limit and the limiter reset on every deploy.

**Also**: connectivity ratchet made additive-proof (`ac44d6ae`, `c180f40c`), a watchdog for a
silently stalled queue that had never been started (`2465e436`), contract expiry that nothing
announced (`6cfc82c2`), and a model ladder that escalates on proof rather than on guesswork
(`b3de527d`).

## 0.2.0 — 2026-08-09

The first snapshot since `0.1.0` (2026-08-01). Roughly 165 upstream commits touching the kernel.

The theme, if there is one: `0.1.0` was a harness that could run an agent. `0.2.0` is a harness that
can be *trusted* to run one unattended — because the autonomy is bounded and self-narrowing, the
audit log is tamper-evident, the tenancy is enforced at a chokepoint the compiler checks, and the
kernel can now write a service definition for a business nobody hand-authored a service for.

### Added — the kernel writes its own services

Previously a business outside the four hand-authored services was told "we can't run this yet".
The shaper now **writes** a service definition instead of picking one from a catalogue (`2d6bf54`).

- An authored service is JSON plus markdown, validated by the *same* `manifestFaults`, the same
  closed `CAPABILITIES` / `WEDGE_ROLES` vocabularies and the same `validateOutput` that a
  hand-written manifest faces. It is a new author, not a new trust level.
- Generating executable `workflows/*.mjs` is **refused outright**, not deferred. The model may
  choose which computation runs; it may never write the computation.
- Authored services are stored as project-scoped tenant data, never on disk — `wedges/` is baked
  into the image and shared by every tenant.
- Authored slugs carry a reserved prefix that `loadWedge` refuses by construction, so all ~50
  existing callers answer "unknown service" without being individually audited. Reaching one needs
  `loadProjectWedge(projectId, slug)` with a required positional project id. This also closed a
  path-traversal in `loadWedge` reachable from `POST /v1/tasks`.
- An authored service may **not** claim a role, declare `workflows` / `connections` / `policy` /
  `harness` / `tools` / `model` / `internal`, ship an approval with `required: false`, ship a job
  with a vacuous output schema, or dangle a `waits_for.resume`. It cannot author away its own gate.
- Promotion is behind a human, with the gate in the resolver rather than at a route.
- An unusable draft is **not stored**: the run succeeds and `service.draft_refused` carries the
  reasons in sentences.
- `skills/mycel-wedge-builder` interviews a founder and writes `wedge.json`, skills and seed
  knowledge (`d2415bc`).

### Added — bounded autonomy

- Policy-bounded auto-approval: a wedge declares an envelope (`max_amount_usd`, `max_per_task`,
  `max_per_day`), it fails closed, and every auto-approval is still recorded as an approval carrying
  its `policy_reason` for batch review (`df712df`).
- Initiative and consequence are separate decisions: `autonomy.ts` decides whether work may *start*
  unattended, `policy.ts` decides whether an action may *send*. Hard ceilings of 5 starts per sweep
  and 20 per day, plus a kill switch that does not destroy grants (`b6624c0`).
- **Autonomy narrows itself and never widens itself.** A granted kind that reaches a one-in-three
  rejection rate is automatically narrowed; widening always requires a human press (`b6624c0`).
- `exposure.ts` derives, from both policies, the single sentence "how many things can this business
  send my customers unattended", and names which rule binds (`48f0857`).
- Policy counters moved into Postgres with `ON CONFLICT DO UPDATE` returning the committed count,
  after four replicas permitted ~160 sends against a `max_per_day: 40` envelope (`c8707c3`).
- Approve-with-edit files a grounding example of *both* the model's version and the human's, so a
  correction teaches the wedge instead of being applied once and thrown away (`e28e680`, `430b195`).

### Added — audit, provenance and knowledge

- **Hash-chained append-only audit log** over approvals, executed actions and secret writes, with
  `GET /v1/audit/verify` reporting the first broken link. Hashing is canonical (key-sorted) because
  jsonb key reordering made every persisted chain read as tampered (`d99815c`).
- **Stated-vs-observed provenance.** Onboarding answers get a `stated` provenance with an `EVIDENCE`
  rank orthogonal to strength, and a stated claim that contradicts an observed rule on the same
  subject is `DECLINED` rather than written (`7aa26e4`).
- Two run outcomes became **observed rather than asserted** — an invoice settling after a chase, a
  reply landing on a thread. "Ignored" stays a human judgement or a timeout (`d9c02d3`).
- The distillation engine (700 lines of dead code) was wired up: capture in `awaitApproval` so
  cross-replica settlements count, retrieval with hard exclusions then scoring, and `auto_approved`
  deliberately excluded as evidence (`430b195`).
- Intake: wedge-declared questions and agent-reported knowledge gaps, ranked by real recurrence and
  stored verbatim rather than paraphrased (`48ee784`).
- Knowledge defaults inverted from `house` to `client`, so an unattributed fact is retrievable by
  nobody; the sensitivity argument is a union with no default, so a client scope cannot compile
  without a client id (`e2ae72c`).
- `graph.ts` (traversal derived from foreign keys, bounded by depth and count) and `ask.ts`, whose
  answer carries `cited` ids, a `moves` list, an `unseen` count and a first-class `insufficient`
  state (`9b50219`).
- Wedge `records`: named collections with natural keys, idempotent merge-on-upsert and jsonb `@>`
  queries, so "which receipts are still missing" is a query rather than a blob filter (`007393d`).

### Added — tenancy and scale

- **Postgres is the queue.** graphile-worker replaced fire-and-forget in-request execution: the API
  enqueues, workers claim. `jobKey` is the task id and `maxAttempts: 1`, so a task that may already
  have sent an email is never silently retried (`00a6bee`).
- **Redis is not a prerequisite** and the claim was removed. The durable event log *is* the SSE bus,
  and approval waiters watch the row as well as the promise; pinned by a two-instance test
  (`697587a`).
- The scheduler fires exactly once across a fleet via `SELECT … FOR UPDATE SKIP LOCKED` with
  `next_run_at` advanced inside the same transaction (`96ff691`).
- **Per-project tenancy at one chokepoint** — `accessible` / `writeProjectId` / `inScope` across
  every endpoint, with a wedge allowlist per project (`a05b10c`). `project_id` then became a
  *required* parameter on `listCases` / `queryRecords` / `countRecords` so the compiler finds
  unscoped callers (`cedc89d`).
- `project_id` pushed into the SQL for `GET /v1/records` and `/v1/cases` rather than post-filtered,
  after a `?limit=1` window could be consumed entirely by a neighbour's newer row (`e2ae72c`).
- Grants and policy counters moved out of in-process maps into a `grants` table keyed
  `(kind, nonce)`, with the provider key sealed with AES-256-GCM before reaching a durable backend
  (`c8707c3`).
- Postgres backends for invoices and distilled knowledge, with a two-backend parity suite
  (`4ae6637`); magic-link portal credentials made Postgres-backed with a single
  `UPDATE … WHERE used = false` claim, so a deploy no longer signs out every customer (`d35ffcd`).
- Performance: an indexed `count(*)` replaced a 20,000-row scan on every task creation, and
  maintained indexes replaced linear hostname/slug scans (`28de0dd`). Six per-store pools plus
  graphile-worker's seventh collapsed into one shared pool on the transaction pooler, with DDL
  serialised behind `pg_advisory_xact_lock` (`e167480`, `0109fbb`).

### Added — sandboxing, model routing and cost

- **Proxy mode**: the sandbox holds only an opaque per-run nonce and the harness forwards to an
  OpenAI-compatible upstream, so provider keys never enter the sandbox (`1aed25a`). `LocalSandbox`
  stopped spawning the agent with the entire host environment (`a85b263`).
- Model **tiers** with real per-million pricing (`fast` / `standard` / `deep`), defaulting to the
  cheapest model that can do the job and clamping *down* by plan rather than refusing (`ffaf29b`).
- A per-month model spend ceiling enforced at task creation, because counting jobs cannot protect
  margin across a 35x price spread (`ffaf29b`); LiteLLM virtual keys per org then carry `max_budget`
  plus a model allowlist, so the proxy itself refuses (`55231a8`).
- **The run ends on the contract, not on the agent going idle.** Once `output/result.txt` parses and
  satisfies the wedge's output schema the run stops; anything present before the prompt is
  disqualified by identity (`53fef64`, `8313de2`).
- Per-task-type harness profiles — tier, runtime, cost budget, tool permissions, and whether the run
  gets an action grant at all — verified by running opencode 1.17.6 rather than by reading its docs,
  which found that permission *order* is significant and fails silently (`225105b`).
- Daytona: named snapshots hashed over the spec and rebuilt on `error` / `build_failed` (`7020075`);
  `sandboxPreflight` so boot refuses rather than accepting work it cannot do (`6c7372f`).
- Skills are mounted as files and indexed in the prompt, instead of every skill's full text being
  concatenated into `AGENTS.md` on every run (`5708c8d`).

### Added — integrations

- **Composio** as a connection kind: the API key stays in the harness, `user_id` derives from the
  connection's owner rather than the request, and reads are allowed only through explicitly declared
  `read_tools` (`80a09e9`). Then a browsable 250+ toolkit catalogue with one-call managed auth,
  idempotent on (project, toolkit, owner) (`fd84b4d`).
- A **local stdio MCP bridge** rather than Composio's remote MCP URL — the remote form would place a
  provider credential inside the sandbox (`00d78cf`).
- Composio triggers, so an inbound event starts a run. Tenancy is rebuilt on our side from a
  `trigger_subs` row keyed on the trigger id we minted, **never** from the payload (`9d7b26f`).
- **Integration requirements bind to capabilities, not vendors** — `read_payments`,
  `read_invoices`, `read_bank_transactions`, `send_email` — resolved per project, so a QuickBooks
  bookkeeper is no longer asked for Xero (`78bd509`).
- **AgentMail** as the inbound half of email: Svix-signed webhooks, server-side thread ids, and
  domain SPF/DKIM/DMARC/MX auth as an API. A client reply *suppresses* the dunning ladder but never
  settles the invoice (`d258f9e`).
- Stripe payment **detection by polling** the founder's own Stripe through Composio read tools
  rather than by webhook — because a webhook cannot tell you that nothing happened (`0020d46`) —
  and `recordManualPayment` through the same external-payment ledger, since most small businesses
  are paid by bank transfer (`44b4432`).
- LinkedIn beyond messaging: search, profile and company reads, invites with and without a note,
  withdrawal, profile views, landing in natural-keyed `people` / `companies` records (`49c0c53`),
  behind a fourteen-action capability table read by the prompt, the pacing engine *and* the approval
  gate (`7bcc9ad`). Outreach pacing is earned — keyed on acceptance and reply rate, asymmetric (it
  falls faster than it rises), with working-hours windows, jitter, and fail-closed behaviour if
  pacing state is unreadable (`ec9a02e`, `272c70f`).

### Added — services, wedges and workflows

- **Blueprints**: a wedge plus its schedules, required connections and seed knowledge, provisioned
  in one call. Schedules are provisioned *disabled* and activation is refused with 409 until the
  readiness checklist passes (`7ba7478`).
- **Cases**: wedge-declared stage machines, merge-patched data, an audit history, and tasks as
  episodes within a case (`0e0e6b3`).
- **Deterministic workflows**: a wedge ships `workflows/<name>.mjs`, callable by name only,
  schema-validated and timed out at 5s. The agent picks *which* computation and *what* inputs; never
  the logic (`df712df`).
- **Waits**: a wedge declares `waits_for`, armed from the `ask_client` branch, later extended with
  OR conditions, a join over conditions, and expiry becoming an `unblock_wait` move (`f7ffbcc`,
  `1085d9e`, `46def23`). `invoice-chaser` is deliberately *not* wired for waits, because a wait
  would double-chase past `claimInvoiceForChase`.
- **Moves** (`moves.ts`): reads the state of the business and ranks what could legally be done right
  now, with every scoring term carrying its own sentence so the page can render the arithmetic
  (`63bd52a`). A move then became takeable, enqueued through the approval queue (`d9c02d3`).
- A wedge declares **roles** (`provides: ["dunning"]`) from a closed set, replacing seven hardcoded
  slug literals. Two claimants on a singleton role refuse to resolve and name both; a mistyped role
  is a load-time fault (`58b33c6`).
- The ungated-but-scoped **read proxy**: GET only, host fixed by the connection, `safeReadPath`
  against traversal / CRLF / SSRF, a 256 KB cap with `truncated: true`, and a per-task read budget
  (`9e62ca8`).
- New services: **`books-keeper`** (UK e-commerce monthly close, integer-pence reconciliation) built
  as a live 20/20 stress test that became a permanent regression guard (`7cb8611`), and
  **`contract-desk`** (contract staffing, integer-minor-unit billing with an overtime multiplier) as
  the proof the primitives are not bookkeeping-shaped (`13a16a3`).

### Added — observability

- `GET /v1/tasks/:id/trace`: `buildTrace` folds the durable event log the kernel *already* wrote
  into a span tree. No capture layer, no third party. Thousands of `token.delta` rows collapse into
  one generation span, and orphan action-proxy results are rendered rather than dropped (`24a6375`).
- A run page: a to-scale waterfall server-rendered from `/trace` then taken over by the browser's
  fold of the SSE stream, with the span where a run died left open and amber (`3e405e9`), later
  replaced by a two-pane conversation view that replays from stored events, not only live
  (`50013e9`).
- Cost shows its provenance — model, tier, tokens, and a provider-vs-our-table pill — so
  `model_estimated` is never presented as precision (`3e405e9`).
- The SSE contract gained a `closed` frame carrying terminal status, so `EventSource` stops
  reconnecting forever (`22f6fc9`).
- `GET /v1/analytics`, rolled up from task rows and events with no capture layer — which surfaced
  that `Approval` had no `created_at` / `decided_at`, so approval latency could not be computed at
  all (`355969c`).
- `scripts/smoke-run.sh`: one real task against a deployed kernel, because every test runs
  `MYCEL_RUNTIME=mock` and every real failure so far had been invisible to the suite (`bf2b9e2`).

### Changed

- The default model moved from Anthropic to OpenAI-via-LiteLLM; `MYCEL_MODEL` now defaults to
  `TIER_MODELS.standard` rather than a hardcoded Anthropic id, which had survived the migration and
  would have failed every run with no provider key to reach (`1798206`).
- The free plan's model ceiling was raised from `fast` to `standard` after gpt-5-nano proved unable
  to hold a tool schema and looped 72 identical malformed `bash` calls (`326b40f`, `53fef64`).
- Docs were rewritten as guidance rather than reference — decision first, then why, then the
  smallest thing that works, then failure modes with the real error strings. Checking each claim
  found **ten that were false**, including "secrets never enter the sandbox" (true of connection
  secrets; false of the model key unless `MYCEL_PROXY_MODE=1`) (`db5739a`).
- The published README stopped describing a repo layout that only exists upstream: in this
  repository the kernel *is* the root (`045c3dc`).

### Removed

Withdrawn capabilities, recorded because a retraction is worth more than a feature note.

- **`geo-monitor` was deleted** (`13a16a3`). Its headline task declared no workflow, no skill and no
  connection — a sketch presented as a service. `contract-desk` replaced it.
- **"Five ready-made services" was retracted** (`9ff6f99`). `lead-qualifier` and `property-sourcer`
  never existed, under a comment asserting the list was real. The count and the menu are gone.
- **Per-project Langfuse provisioning was deleted** (`89190fe`). It called an Organization Management
  API that does not exist on Langfuse Cloud on any plan, so the isolated per-business tracing shipped
  in `b8a4ea8` could never have worked. What survives is `LangfuseObserver` as an operator's own
  opt-in sink; its actual replacement is the in-kernel trace reader.
- **Four stub `ConnectionKind`s removed** — `stripe`, `sms`, `whatsapp`, `calendar` all returned "not
  implemented" at run time (`48ee784`).
- **Both placeholder blueprint connection rows deleted** — `api.example-bank.com` and
  `books@yourdomain.com` had shipped to real customers. A boot gate now refuses any blueprint
  carrying one (`78bd509`).
- **Onboarding templates removed** (`b0fda36`), including a hidden `fetchPriors()` that was still
  feeding two canned businesses to the shaper as invisible priors.
- `max_sends_per_hour` removed from the interface entirely rather than left nullable, because
  velocity has exactly one owner in `pacing.ts` (`cedc89d`). `first_case` deleted from `Blueprint` —
  declared, populated in both shipped blueprints, and never read (`d35ffcd`).

### Fixed

Selected, because these are the ones that say something about the system.

- **Cross-tenant knowledge leak** (`00b90de`): `listKnowledge(wedge)` filtered on wedge alone while
  the runtime mounted the result into the sandbox, so every tenant read every other tenant's
  uploaded knowledge and intake answers. Deterministic intake filenames were also silently
  overwriting each other.
- **A way to exfiltrate a bearer token behind one approval click** (`8a066f1`): `postWebhook`
  preferred an agent-supplied `payload.url` over the connection's host. In the same change,
  per-client credential isolation — advertised in the UI and enforced by nothing — became a real
  gate that naming cannot override.
- **Customer data leaking into portal events** (`3b0c56b`): `PORTAL_EVENTS` allowlisted event
  *types* then forwarded each event's whole `data`, exposing `progress.note` internals to a
  customer. Now a per-type field allowlist that fails closed.
- **Cross-project idempotency collision** (`cedc89d`): intake dedupe keys shared a module-level map
  with no project id, letting project A pre-seed a key and receive project B's inbound task and
  client ids.
- **Cost metering was 15-60x wrong** (`00b90de`): `estimateCost` hardcoded Anthropic rates after the
  move to OpenAI while `TIER_PRICE` held the real numbers and nothing read it — and it is the number
  enforcing the plan ceiling.
- **A booting container marked every in-flight run in the fleet failed, across tenants**
  (`3e405e9`): `recoverTasks` now requires a task to be silent for ten minutes as well as
  non-terminal.
- **A deployed kernel booted healthy and answered "unknown wedge" to every task** (`525273a`): the
  image contained no `wedges/` and no `blueprints/`. Found by running the built image, not by
  building it.
- **A run that produced no application told the customer it was ready** (`73ad9ac`):
  `orchestrator.ts` wrapped export and deploy in one `try` whose `catch` still set `succeeded`.
- **`"skills": []` was a filter matching nothing** (`73ad9ac`) — `[]` is not nullish — so
  `product-builder` had been running with no skills at all.
- **Route registration order** (`6028437`, `065921d`): `app.use("/v1/*")` ran before later-declared
  routes, so every new `/v1/portal/*` route answered 401 to a valid client session. The same trap had
  made `/v1/auth/federated` permanently 403.
- **A transport failure was recorded as the founder's rejection** in the audit trail (`ef99915`).
  `ReplySendError` now leaves the approval `approved`, fails the task with the transport detail, and
  answers 502.
- **The memory and Postgres stores disagreed** (`b674d8e`): `PUT /v1/schedules/:id {enabled:false}`
  erased name, input, cadence and `next_run_at` in memory while Postgres used `COALESCE`.
- **Two tests read monorepo siblings this repository deliberately does not ship** (`0227fa2`), which
  took the whole suite red on the first command a stranger ran after `git clone`. They now *skip*
  with a reason, and the security-bearing half was split into a test that always runs. See
  "Test suite" in the README.

## 0.1.0 — 2026-08-01

First public snapshot: the harness, the `/v1` contract, wedges, blueprints, the sandbox image and
the docs. Earlier history is not public — the kernel was extracted from a private monorepo, and this
repository begins at the extraction rather than replaying it.
