# Wedges — how a founder turns a service into a product

The kernel is a stellar generic engine: an agent in a sandbox, grounded by your material, taking
real actions only through a human approval gate, streamed and traced. A **wedge** is the thin,
vertical layer that makes it *your* service. This guide is the anatomy, three worked examples, how
a founder builds one, and — the point of the whole thing — how one horizontal engine runs many
verticals **without losing quality**.

## 1. Anatomy — a wedge is config, not code

```
wedges/<slug>/
  wedge.json      definition:  task types + output schema, tools, connections, approvals, model
  skills/*.md     procedure:   HOW the job is done well — the founder's judgment, encoded
  knowledge/*.md  grounding:   WHAT is true — policy, pricing, examples (seeds; grows at runtime)
```

Three different lifecycles, deliberately separated:

| Layer | Nature | Changes | Where it lives |
|---|---|---|---|
| **Definition** (`wedge.json` + skills) | code-like | deliberate, versioned | on disk, in git |
| **Knowledge** | data-like | daily, per case | the knowledge API — no redeploy |
| **Feedback** | a loop | every approval | captured automatically → knowledge |

You never write an agent loop, a queue, an SSE stream, or a secrets vault. Those are the engine.
You bring judgment (skills) and facts (knowledge); the kernel does the rest.

## 2. Three worked examples

Examples, not a catalogue. Nothing here is a service you can buy switched on: a wedge is written to
fit the business it serves, and these three are in the repo so you can see the three *shapes* a
service takes before you write a fourth. `kernel/wedges/` also holds `gtm-operator` and
`product-builder`, plus `business-shaper` and `harness-operator`, which are machinery rather than
services — they onboard a business and let the kernel work on itself.

Completeness varies and it is worth knowing which is which before copying one. `invoice-chaser`,
`books-keeper` and `contract-desk` are end to end — manifest, workflows, skills, knowledge and a
blueprint each. `gtm-operator` and `product-builder` have no blueprint, so nothing provisions them.

There used to be a fourth example here, `geo-monitor`, and it is worth recording why it is gone
rather than quietly dropping it. Its headline `sweep` task had no workflow, no declared skill and no
connection behind it: a manifest sketch presented in the same list as three working services.
Shipping a sketch as though it were a product is the same mistake as the "five ready-made services"
line the landing page had to retract, and a doc that labels the sketch honestly does not fix it —
readers copy the nearest example, not the caveat.

### a) `books-keeper` — client conversation → gated reply

An e-commerce bookkeeper closes a month. Half the job is asking clients for the receipts that are
missing. The agent drafts the ask; a human approves the send.

- **Trigger:** a provider webhook (Postmark/Twilio) → your app verifies it → `POST
  /v1/channels/:id/inbound`. The kernel resolves the **client**, appends to the **thread**, and
  spawns a `chase_receipts` task with the conversation history — or the month-end **case** spawns
  one itself when the close stalls on documents that never arrived.
- **How it runs:** the agent is grounded in `knowledge/close-policy.md` and the founder's own
  chase example (captured at intake, so the tone is theirs and not a model's), drafts the message,
  then calls the **action proxy** to send it. "send" is a gated approval, so the task suspends at
  `awaiting_approval` and surfaces the draft. A human approves (or edits then approves). Only then
  does the email go — through the `books-email` connection whose key never entered the sandbox.
  One chase per task is inside `policy.auto_approve`; the second is not, and stops.
- **Kernel surface used:** channels + inbound, clients/threads, action proxy, approval gate, policy
  envelopes.

### b) `contract-desk` — a recurring sweep that fans out into single-target work

A recruitment agency placing contractors. Every week: whose timesheet is missing, which client-weeks
can be invoiced, which assignments have entered their notice window.

- **Trigger:** one **schedule**, daily. It is the only scheduled job in the pack, and the reason the
  other three task types are not scheduled is the shape worth copying: `chase_timesheet`,
  `prepare_invoice` and `confirm_extension` each take one assignment or one client-week and declare
  an `input_schema` that requires it. Scheduling one of those with an empty input creates a daily run
  with nothing to act on that still has to produce something.
- **How it runs:** two deterministic **workflows** own everything a client would argue about.
  `week_status.mjs` decides who is late, by how many days, whether the contractor or the client's
  approver is holding it up, and whether a client-week is complete enough to bill — all date and
  boolean arithmetic, none of it the model's. `bill_lines.mjs` turns minutes and rates into invoice
  lines in **integer minor units** and refuses a line it cannot trace to an assignment. The model
  writes the chase and the covering note; it never produces a number. `send_invoice` is a separate
  required approval from `send`, at higher risk, so a desk head who has learned to wave chases
  through has not thereby agreed to wave invoices through.
- **The one auto-approved envelope, and why only one:** `email:chase_timesheet`, two per assignment
  and sixty a day. It goes to the agency's own contractor about their own hours — no money moves and
  no client sees it. Everything else stops at a human.
- **Kernel surface used:** schedules, deterministic workflows, output schema validation, cases
  (the *assignment* is the case, not the week), separate approvals at different risk levels, policy
  envelopes, intake, capabilities.
- **Kernel surface used:** tasks + events, deterministic workflows, output schema validation,
  artifacts, action proxy.
- **Why quality holds:** a gap the agent cannot evidence is a gap it cannot emit, because the
  schema demands the citation and the skill forbids guessing at one.

### c) `invoice-chaser` — money action, tightly gated

Accounts-receivable. Given an overdue invoice + client history, pick the right dunning step and
(on approval) send it or charge a saved card.

- **Trigger:** a scheduled sweep in the founder's app → one `chase_invoice` task per overdue
  invoice.
- **How it runs:** grounded in `knowledge/dunning-policy.md` (the escalation ladder + tone). The
  agent picks `reminder → firm_reminder → final_notice → hold`, drafts the message, and — only when
  told to act — calls the action proxy. `send`, `charge`, and `refund` are **three separate
  required approvals**; a human signs off each. The Stripe key lives in a `stripe` connection,
  server-side, never in the sandbox.
- **Kernel surface used:** tasks, action proxy with multiple gated capabilities, connections.
- **Why quality holds:** the policy forbids skipping steps or inventing late fees; the approval
  gate means no money moves without a human. The agent is fast and consistent; the human owns risk.

## 3. How a founder builds one

**Author it by conversation.** Run the `mycel-wedge-builder` skill in Claude Code. It interviews
you — the job, the trigger, your procedure, your grounding, the real-world actions, what "good"
looks like — and writes `wedge.json` + skills + seed knowledge in your words. You don't hand-edit
JSON; you describe how you work.

**Configure the outside world.** Register the connections your wedge names (email/Stripe/etc.) via
`POST /v1/connections` — the secret is referenced (`env:NAME`), never stored in the clear or sent
to the sandbox. Bind a channel if it's inbound-driven.

**Ship it.** Drop the wedge folder where the kernel reads `wedges/`, point a channel at it or call
`POST /v1/tasks`. The generated Next.js product (`create-mycel-app`) already renders the live task
workspace + approval cards.

**Grow it without redeploying — this is the moat.**
- Add a document, fix pricing, drop in a great example: `POST /v1/wedges/:wedge/knowledge`. The
  next task is grounded in it immediately.
- Every time you **edit a draft before approving it**, the kernel captures the correction as a
  grounding example (`feedback.recorded` → knowledge). Rate a finished task with `POST
  /v1/tasks/:id/feedback` and a correction becomes an example too.
- Month one it drafts from your seed knowledge. Month two it drafts the way *you* do — because it
  learned from your gate decisions, not because you re-authored it.

## 4. The product around the wedge

The founder ships a normal web product; the wedge is its brain:

```
Browser ─► your Next.js app (auth, tenancy, your brand)
           ├─ /api/tasks, /events, /approvals   → proxy to the kernel (adds the founder key)
           └─ renders the live Workspace + approval cards (the mycel-workspace skill)
                                   │
                        Mycel kernel /v1  ──► sandboxed agent, grounded by the wedge,
                                              acting only through approved connections
```

`create-mycel-app` scaffolds this; the frontend skill styles the workspace to the founder's design.
The founder owns the product, the brand, the customer relationship, and the wedge. Mycel owns the
engine and the contract.

## 5. One engine, many verticals — where quality actually comes from

The fear with a horizontal platform is that it's mediocre at everything. Mycel's answer is that
**quality is not in the engine — it's in the grounding, the gate, and the loop**, and those are all
per-wedge:

- **Grounding, not cleverness.** The agent is only as good as the knowledge + skills it's given. A
  vertical feels bespoke because its wedge encodes one founder's real judgment and real facts. Two
  wedges on the same engine read completely differently.
- **The approval gate makes "good enough" safe.** The agent doesn't have to be perfect on every
  outward action — a human signs off sends, charges, bookings. Speed and consistency from the
  machine; risk and taste from the human. That division is what lets a generic engine do
  high-stakes work.
- **The feedback loop compounds.** Every correction sharpens the wedge. Quality isn't set at
  authoring time; it climbs with use. The engine stays generic; the wedge gets sharper.
- **Honest signals keep it trustworthy.** Output is validated against the schema, failures say why,
  a crashed agent is a failure not a fake success, and everything is traced. The founder can see
  exactly what happened and correct it.

So the same kernel runs a nursery's inbox, a property sourcer's analysis, and a firm's collections
— and each is as good as the judgment its founder poured into a few Markdown files, sharpened by
every human decision since. That's the model: **rent the engine, own the judgment.**
