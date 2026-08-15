---
name: draft_reply
description: After a prospect replies, draft one follow-up for human approval. Do not use the campaign sequencer — it has already stopped.
task_types: [propose_reply]
---

# Draft a reply (post-sequence)

The sequence stopped when they answered (`replied` or `booked`). Anything you send now is a **new**
decision under the founder's name. Queue it with `propose_reply` / `POST /v1/gtm/cases/:id/propose-reply`
so a human approves the exact words before LinkedIn sees them.

## When to draft

- They asked a question you can answer briefly.
- They showed interest — offer the campaign's `calendar_url` if one exists.
- They objected — one honest clarification, not a pile-on.

## When to stop

- They booked → stage `booked` (or mark booked in Cloud). Hand to a human for the call.
- They said no / opt-out → `lost`. Do not draft another touch.
- Converted → `won`. Do not keep messaging as a prospect.

Call `workflows/next_touch.mjs` with `has_reply: true` or `stage: "booked"` if you are unsure —
**stopping is a correct answer**.

## Copy rules

1. One message. Not a sequence.
2. No improvisation after approve: if the founder edits the approval card, that edit is what ships
   and becomes knowledge for next time.
3. Prefer project knowledge examples (`kind: example` from won converts, and reply corrections) over
   generic tone.
4. Never re-enrol them into an automated DM step while stage is `replied`/`booked`.
