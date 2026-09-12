// SIX CONSECUTIVE FAILURES, THEN THE ENGAGEMENT WAS RETIRED.
//
// From the production kernel log:
//
//     [mycel] fulfillment ignition for 293d3ddf-…: 1 engagement(s) retired —
//     ignite 60b2a9af-…: 6 consecutive monthly_close failures — not retrying
//
// Every scheduled close for that client had been refused, at schedule time, by its own schema:
//
//     this task's input does not match what `monthly_close` needs: $.period: required
//
// `books-keeper.monthly_close` declares `period` required and the reasoning on that field is right:
// "a close with no period is a close of nothing, and production runs have failed asking for exactly
// this after spending a sandbox to discover it." Failing at schedule time beats burning a sandbox.
//
// What nobody closed is the other half. `fulfillment-ignite.ts` is the ONLY caller that starts a
// recurring deliverable, and it sent `{ because, scheduled_at }` — so the contract could never be
// satisfied and the flagship service never ran on a schedule at all.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { previousMonth } from "../src/fulfillment-ignite";

test("a close fired now closes the month that just ended", () => {
  assert.equal(previousMonth(new Date("2026-10-01T00:05:00Z")), "2026-09");
  assert.equal(previousMonth(new Date("2026-10-31T23:59:00Z")), "2026-09");
  // The January case, which is the one an off-by-one gets wrong.
  assert.equal(previousMonth(new Date("2026-01-03T09:00:00Z")), "2025-12");
  // Zero-padded, because "2026-9" is not a month anybody's schema will accept.
  assert.equal(previousMonth(new Date("2026-10-15T00:00:00Z")), "2026-09");
  assert.equal(previousMonth(new Date("2026-02-01T00:00:00Z")), "2026-01");
});

test("the period is derived in UTC", () => {
  /**
   * A close fired at 00:30 on the 1st in London is 23:30 on the 31st in UTC. A local-time derivation
   * labels it with the wrong month for half the world, and the kernel timestamps everything else in
   * UTC — so the period has to agree with the `scheduled_at` sitting beside it.
   */
  assert.equal(previousMonth(new Date("2026-10-01T00:30:00Z")), "2026-09");
  // Same instant expressed with an offset: still September, because the instant is what matters.
  assert.equal(previousMonth(new Date("2026-09-30T23:30:00-01:00")), "2026-09");
});

test("the ignition path sends a period, or nothing recurring ever runs", () => {
  /**
   * The wiring, asserted at the only call site that exists. This repo's most common bug is a correct
   * rule with nothing invoking it, and this one cost a live engagement six failures and a retirement.
   */
  const src = readFileSync(new URL("../src/fulfillment-ignite.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");
  assert.match(
    src,
    /input: \{ because, scheduled_at: nowIso, period: previousMonth\(now\) \}/,
    "the scheduler no longer sends a period — every schema that requires one will refuse at schedule time",
  );
});

test("the schema this was failing still requires what it requires", () => {
  /*
    The fix is on the CALLER, deliberately. Relaxing the field would have hidden the failure rather
    than repaired it — and `geo-monitor` relaxing its own `client` was right for the opposite reason:
    that is a fact the RUN holds and the caller does not. A period is a fact about the CLOCK, which is
    exactly what a scheduler is.

    Pinned so a later "just make it optional" has to argue with the production log above.
  */
  const wedge = JSON.parse(
    readFileSync(new URL("../../wedges/books-keeper/wedge.json", import.meta.url), "utf8"),
  );
  const schema = wedge.task_types.monthly_close.input_schema;
  assert.deepEqual(schema.required, ["period"], "monthly_close stopped requiring a period");
});
