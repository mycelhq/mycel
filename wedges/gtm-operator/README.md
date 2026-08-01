# gtm-operator (partial)

Only two things live here, and both are the deterministic half of outbound:

- `cases.stages` — the stage machine a prospect moves through
  (`prospect → touch_1 → touch_2 → touch_3`, exiting to `replied`, `booked` or `closed_lost`).
  Declaring it here is what makes an invalid transition a rejection at the API boundary instead of
  a corrupted engagement.
- `workflows/next_touch.mjs` — given the facts on a Case, the next step is fixed. Whether to send,
  which touch it is, and how long to wait are not model judgments; only *how to write it* is. The
  function is pure (no clock, no I/O — `days_since_last_touch` is passed in), so cadence is
  testable without waiting four days, and **stopping is a first-class correct answer**: a reply, a
  booking or an opt-out ends the sequence rather than falling through to "send anyway".

There are deliberately **no task types, skills or knowledge here yet**. The drafting side of this
wedge is still parked; shipping a manifest that advertises task types the kernel can't run would be
a menu listing dishes the kitchen can't cook. The cadence logic is useful on its own and was worth
landing early, because it is the part that decides whether a stranger gets a fourth message.
