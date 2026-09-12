// The nudge sweep is where the touch budget is ENFORCED. Gated before the claim, because
// `claimRequestForNudge` is a compare-and-set that stamps `last_nudged_at` — claiming and then
// declining would burn the interval on a nudge nobody received.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mayTouch } from "../src/client-touch";
import { TOUCH_TASK_TYPES } from "../src/client-touch.pg";

test("a nudge is a budgeted touch, and a verdict is not", () => {
  assert.ok(TOUCH_TASK_TYPES.includes("nudge_client_request"));
  assert.ok(!TOUCH_TASK_TYPES.includes("deliverable_verdict"));
});

test("THE SCENARIO: geo-monitor reported this morning, so the nudge waits", () => {
  const now = 1_800_000_000_000;
  const recent = [{ kind: "report" as const, at: now - 30 * 60_000, wedge: "geo-monitor" }];
  const v = mayTouch("nudge_client_request", recent, now);
  assert.equal(v.allow, false);
  assert.equal(v.allow === false && v.reason, "too_soon");
  assert.ok(v.allow === false && v.detail.includes("report"), "and names what it is waiting behind");
});

test("past the gap, the same nudge goes", () => {
  const now = 1_800_000_000_000;
  const recent = [{ kind: "report" as const, at: now - 5 * 60 * 60_000, wedge: "geo-monitor" }];
  assert.equal(mayTouch("nudge_client_request", recent, now).allow, true);
});

test("a request with no client is never held — nothing to protect", () => {
  assert.equal(mayTouch("nudge_client_request", [], 1_800_000_000_000).allow, true);
});
