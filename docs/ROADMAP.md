# Roadmap — what the kernel can and can't express yet

This is written from a stress test, not a wishlist: we modeled three real agency businesses
(recruiting, bookkeeping, paid ads) the way they actually operate, then asked what the kernel
couldn't hold. Nothing here invalidates the architecture — the trust boundary, wedges, grounding,
and the contract all held up. What's missing is the **operational spine**.

Short version: **the kernel is strong at "do one gated task well" and missing "run an ongoing
operation."**

## Solid today

- **Task → sandboxed agent → human gate → real action**, streamed, validated, traced.
- **Wedges** as config: manifest + skills (procedure) + living knowledge (facts, edited at runtime).
- **The learning loop** — approve-with-edit and feedback become grounding examples.
- **Connections** with server-held secrets, founder- or client-owned; the sandbox only ever gets a nonce.
- **Multi-tenancy** — org → project → member, per-project isolation (tested).
- **Durability** — Postgres backs tasks, events, the service surface, and tenants (restart-tested).

## Missing, in priority order

Each item below blocked at least one of the three businesses we modeled.

### 1. Scheduler & timers
Cron-style recurring work (`daily_sync`, close on the 1st, quarterly filing), `wait_until`,
follow-up cadences (day 3 / 7 / 14), and SLA/deadline escalation.

*Why first:* all three wedges are blocked without it. A service business runs on a clock; today the
kernel only reacts to a request or an inbound message.

### 2. Ungated, scoped reads through connections
The action proxy is send-only and gates **everything** — correct for "email this client," unusable
for "pull today's bank transactions." Reads need to be cheap, frequent, and ungated (but scoped to
the connection); writes stay gated.

*Why second:* small change, unblocks every read-heavy wedge (bookkeeping, ads, sourcing).

### 3. Case / engagement primitive
A long-lived work object with a stage machine — a recruiting role open for six weeks, a monthly
close, an ad account under management. Tasks become *episodes within a case*. Also gives operator
UIs their real object: clients and engagements, not a flat task list.

### 4. Deterministic workflows
Named, tested functions the agent calls instead of doing arithmetic in prose — reconciliation, yield,
fees, budget pacing. Cheaper, consistent, auditable. Skills stay prose (judgment); workflows are code
(mechanics).

### 5. Policy-bounded autonomy
Today's rule is *every outward action passes a human*. That's right for "send this email" and wrong
for "make 40 budget tweaks today" — the founder stops clicking and turns the gate off, which kills
the trust primitive. Needs envelopes (spend / rate / scope): auto-approve inside, gate outside, batch
review after the fact.

### 6. Wedge records
Schema'd, per-wedge structured data with idempotent upsert — candidates with stages, transactions,
campaign metrics. Markdown knowledge grounds judgment; it can't carry operational state.

### 7. External-party requests
Ask the *client or candidate* for something, wait, remind, escalate. Distinct from founder approval
(which is about permission, not information).

### 8. Binary artifacts and files
PDFs/images in (parse, OCR), spreadsheets/PDFs out. Artifacts are text today.

### 9. Audit trail
An immutable record of who changed what — a legal requirement in regulated wedges like bookkeeping.

### Later
Voice channels, image generation, multi-human assignment and review queues, outcomes/reporting,
billing primitives, and a Redis-backed bus for multi-instance (the interfaces are already ready for
it; we're not adding it until someone needs two instances).

## How to help

If you're running a real service and something above blocks you — or something *not* above blocks
you — open a [wedge gap issue](https://github.com/mycelhq/mycel/issues/new?labels=wedge-gap).
That's the most valuable contribution to this list. See [CONTRIBUTING.md](../CONTRIBUTING.md).
