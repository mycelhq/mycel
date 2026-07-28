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

They span the three shapes a service takes. All three ship in `kernel/wedges/`.

### a) `enrollment-operator` — inbound conversation → gated reply

A nursery/clinic gets lead emails. The agent drafts the reply; a human approves the send.

- **Trigger:** a provider webhook (Postmark/Twilio) → your app verifies it → `POST
  /v1/channels/:id/inbound`. The kernel resolves the **client**, appends to the **thread**, and
  spawns a `reply_to_lead` task with the conversation history.
- **How it runs:** the agent is grounded in `knowledge/playbook.md` + `pricing.md`, drafts a reply,
  then calls the **action proxy** to send it. Because "send" is a gated approval, the task suspends
  at `awaiting_approval` and surfaces the draft. A human approves (or edits then approves). Only
  then does the email go — through the `email` connection whose key never entered the sandbox.
- **Kernel surface used:** channels + inbound, clients/threads, action proxy, approval gate.

### b) `property-sourcer` — research → structured deliverable

A UK buy-to-let sourcer (the founder's own wedge). Given a brief + a listing, decide if it's a deal
and produce a report with the numbers.

- **Trigger:** a button in the founder's app → `POST /v1/tasks` (`source_property`). No channel;
  it's a request/response job with a rich artifact.
- **How it runs:** grounded in `knowledge/sourcing-criteria.md` (the buyer's box + exact yield
  math) and `example-report.md` (the shape to match). The agent researches comparable rents (via
  `web_search`), runs the numbers, and emits JSON matching the `output_schema`. The kernel's
  **output validator** checks it against the schema — an honest `output.validated`, then the report
  lands as an **artifact**. Sending it to the buyer is a separate gated action.
- **Kernel surface used:** tasks + events, output schema validation, artifacts, action proxy.
- **Why quality holds:** the founder's yield formula and red-lines live in knowledge; the agent
  can't hand-wave a yield because the schema demands the numbers and the skill forbids guessing.

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
