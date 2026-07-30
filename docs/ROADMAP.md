# Roadmap — what the kernel can and can't express yet

This is written from a stress test, not a wishlist: we modeled three real agency businesses
(recruiting, bookkeeping, paid ads) the way they actually operate, then asked what the kernel
couldn't hold. Nothing here invalidates the architecture — the trust boundary, wedges, grounding,
and the contract all held up. What's missing is the **operational spine**.

Short version: **the kernel is strong at "do one gated task well" and missing "run an ongoing
operation."** Items 1–6 are now shipped; 7–9 remain.

**Verified, not asserted:** after shipping 1–5 we built the hardest of the three modelled
businesses — UK e-commerce bookkeeping — against the live kernel. All 20 capability checks pass, and
it's now a regression test (`harness/test/stress-bookkeeping.test.ts`, wedge in
`wedges/books-keeper/`). Cases, schedules, ungated reads, exact integer-pence reconciliation,
policy-bounded autonomy and runtime knowledge edits all hold up on a real service.

## Solid today

- **Task → sandboxed agent → human gate → real action**, streamed, validated, traced.
- **Wedges** as config: manifest + skills (procedure) + living knowledge (facts, edited at runtime).
- **The learning loop** — approve-with-edit and feedback become grounding examples.
- **Connections** with server-held secrets, founder- or client-owned; the sandbox only ever gets a nonce.
- **Multi-tenancy** — org → project → member, per-project isolation (tested).
- **Durability** — Postgres backs tasks, events, the service surface, and tenants (restart-tested).

## Missing, in priority order

Each item below blocked at least one of the three businesses we modeled.

### 1. Scheduler & timers  ✅ shipped
Cron-style recurring work (`daily_sync`, close on the 1st, quarterly filing), `wait_until`,
follow-up cadences (day 3 / 7 / 14), and SLA/deadline escalation.

*Why first:* all three wedges are blocked without it. A service business runs on a clock.

**Shipped:** `Schedule` + `/v1/schedules` (cadences: every N / daily / monthly, fire-now, pause).
Still missing from this item: `wait_until` mid-task (a task can't sleep and resume yet) and SLA
escalation timers.

### 2. Ungated, scoped reads through connections  ✅ shipped
The action proxy is send-only and gates **everything** — correct for "email this client," unusable
for "pull today's bank transactions." Reads need to be cheap, frequent, and ungated (but scoped to
the connection); writes stay gated.

*Why second:* small change, unblocks every read-heavy wedge (bookkeeping, ads, sourcing).

**Shipped:** `/v1/internal/reads/:capability` — GET-only, granted connections only, host from the
connection (relative path from the sandbox, so no SSRF), size-capped, per-task read budget, and
every read traced onto the timeline.

### 3. Case / engagement primitive  ✅ shipped
A long-lived work object with a stage machine — a recruiting role open for six weeks, a monthly
close, an ad account under management. Tasks become *episodes within a case*. Also gives operator
UIs their real object: clients and engagements, not a flat task list.

**Shipped:** `Case` + `/v1/cases` (stages declared by the wedge, so undeclared transitions are
refused; `data` merges; every change appends to an audit `history`). `POST /v1/cases/:id/tasks`
spawns an episode that inherits the case's wedge + client + state. The agent can read and advance
*its own* case via `/v1/internal/case` (ungated — no real-world side effect — but scoped to its run
and attributed to `agent`).

### 4. Deterministic workflows  ✅ shipped
Named, tested functions the agent calls instead of doing arithmetic in prose — reconciliation, yield,
fees, budget pacing. Cheaper, consistent, auditable. Skills stay prose (judgment); workflows are code
(mechanics).

**Shipped:** a wedge declares `workflows` and ships `workflows/<name>.mjs`; the agent calls one by
name over `/v1/internal/workflows/:name` with JSON args. Args and return value are schema-validated,
runs are timed out and size-capped, and each call is traced. The agent can pick *which* computation
and *what inputs* — never the logic. Examples: `property-sourcer/yields` (exact SDLT + net yield,
matching the wedge's own example report to the penny) and `invoice-chaser/next_step` (the dunning
ladder as policy, not vibes).

### 5. Policy-bounded autonomy  ✅ shipped
Today's rule is *every outward action passes a human*. That's right for "send this email" and wrong
for "make 40 budget tweaks today" — the founder stops clicking and turns the gate off, which kills
the trust primitive. Needs envelopes (spend / rate / scope): auto-approve inside, gate outside, batch
review after the fact.

**Shipped:** a wedge declares `policy.auto_approve` rules (exact action or `prefix:`) with
`max_amount_usd`, `max_per_task`, `max_per_day`. Inside the envelope the action executes with no
human and is recorded as `auto_approved` **with its reason**, so it lands in the batch-review queue
(`GET /v1/approvals?status=auto_approved`) — autonomy is auditable, never invisible. Outside it, the
human gate applies unchanged. **Fails closed:** no policy, no matching rule, or a cap with no amount
to check all mean "ask a human".

### 6. Wedge records  ✅ shipped
Schema'd, per-wedge structured data with idempotent upsert — candidates with stages, transactions,
campaign metrics. Markdown knowledge grounds judgment; it can't carry operational state.

**Shipped:** `/v1/records` + agent-facing `/v1/internal/records/{upsert,query}`. A record lives in a
named `collection` with a natural `key`, so **writes are idempotent** — re-ingesting a bank
transaction merges into it instead of double-posting (a unique index on
`(project, wedge, collection, key)` in Postgres, `data @> jsonb` + a GIN index for queries).
Batch upsert (≤1000/call) so a 500-transaction ingest is one round trip. This closes the gap the
bookkeeping re-run surfaced: *"which receipts are still missing?"* is now
`?collection=receipts&where={"status":"missing"}` instead of loading a blob and filtering in the model.

### 7. External-party requests
Ask the *client or candidate* for something, wait, remind, escalate. Distinct from founder approval
(which is about permission, not information).

### 8. Binary artifacts and files
PDFs/images in (parse, OCR), spreadsheets/PDFs out. Artifacts are text today.

### 9. Audit trail  ✅ shipped
An immutable record of who changed what — a legal requirement in regulated wedges like bookkeeping.

**Shipped:** a hash-chained audit log. Each entry embeds the previous entry's hash, so editing,
deleting or reordering history breaks the chain and `GET /v1/audit/verify` reports exactly where.
Records the consequential set only (approval granted/rejected/auto-approved/expired, the action that
actually executed, secret writes) — never secret material. Append-only in Postgres, with the
per-project sequence allocated under a row lock so replicas can't fork the chain. Verified against a
real database: untampered → `ok:true`; a direct `UPDATE audit_log SET actor='attacker'` →
`ok:false, broken_at:2`.

### Blueprints — provision a business, not a task  ✅ shipped
The deployable unit Cloud needs: a named bundle of wedge + schedules + required connections + seed
knowledge. `POST /v1/blueprints/:slug/provision` creates it all in one call and returns a **readiness
checklist** of what the founder still owes (credentials, mostly). Two decisions worth knowing:
schedules are provisioned **disabled** (a business with no bank token shouldn't start failing on its
6am tick), and **`activate` is refused with 409 until the checklist is satisfied**. Provisioning is
idempotent — clicking twice reuses by name instead of creating a second business. Blueprint files
carry config and intent but never credentials, so they're safe to commit and share (asserted in a
test). Provisioning lands in the audit chain.

### Multi-instance — partially shipped
**Shipped (the dangerous half):** the scheduler now *claims* due schedules through the store instead
of listing them — `FOR UPDATE SKIP LOCKED` on Postgres, with `next_run_at` advanced inside the same
transaction. Proven against a real database: the old list-then-update path fires a schedule **twice**
across two replicas (two emails to the client); the claim fires it **once**. Tested with 2 and 4
concurrent replicas (`harness/test/multi-instance.test.ts`, runs in CI).

**Still single-instance:** cancel, approval waiters, the SSE bus, proxy/action grants, policy
counters, idempotency and read budgets are in-process. Run one replica until these are Redis-backed.
Each already sits behind a small interface for exactly that swap.

### Security posture (shipped alongside)
- **Vault encrypted at rest** — AES-256-GCM per secret (`MYCEL_SECRET_KEY`), authenticated so
  tampering fails closed rather than returning junk; a key id per envelope leaves room for rotation.
  Durable in Postgres, storing only ciphertext: a stolen database dump is useless without the key
  (verified — the plaintext appears nowhere in the database). Boots with a loud warning if the key
  is unset, because then secrets don't survive a restart.

### Later
Voice channels, image generation, multi-human assignment and review queues, outcomes/reporting,
billing primitives.

## How to help

If you're running a real service and something above blocks you — or something *not* above blocks
you — open a [wedge gap issue](https://github.com/mycelhq/mycel/issues/new?labels=wedge-gap).
That's the most valuable contribution to this list. See [CONTRIBUTING.md](../CONTRIBUTING.md).
