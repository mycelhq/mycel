---
name: multi-shot-fulfillment
description: How to deliver complex knowledge work across episodes — draft, pause for founder/client review, revise, accept — without one-shotting or orphaning waits.
---

# Multi-shot fulfillment

Service work is almost never one shot. The harness is built for **episodes inside a Case**: do some work, stop at a real gate, wait without dropping the ball, then continue with the client's (or founder's) words in hand.

## The art

1. **Produce something inspectable.** Prefer a `Deliverable` (document / file_set / link) over a chat dump. Versions are append-only; their change requests survive.
2. **Stop on purpose.** When you need judgment, access, or a verdict:
   - founder review → submit a deliverable version (`in_review`) and end the run
   - client input → open a `ClientRequest` (`document` | `answer` | `decision`) and/or arm a wait
   - never invent the missing logo / bank statement / decision
3. **Resume from facts, not memory.** On `deliverable_verdict` or request resolution, read live state (`GET /v1/internal/deliverables/:id`, the request row, attached artifact ids). Resume input can be stale by minutes.
4. **Revise against their words.** `change_request` on the version they saw is the brief for v+1. Quote it; do not reinterpret into a different ask.
5. **Close the money loop.** Acceptance is billable. Do not soft-close in chat; leave `accepted_at` queryable so invoicing can follow.

## Skills + workflows

- **Skills** (this file and trade procedures) hold judgment: tone, what "done" means, when to ask vs decide.
- **Workflows** hold mechanics: reconcile cents, render a PDF, pace a chase. Call them by name; never re-derive arithmetic in prose.
- Declare `deliverable_verdict`, `nudge_client_request`, and `check_in_case` on every delivery wedge so `/next` and waits can actually take the work.

## What not to do

- One enormous run that "finishes the project" while the client is silent
- Overwriting a previous deliverable version instead of submitting v+1
- Asking the founder to Accept (clients own acceptance)
- Dumping binary into chat — put bytes on artifacts and let the inspector preview them
