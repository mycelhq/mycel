// A schedule that already asked must wait, not ask again.
//
// The bug these prevent does not announce itself, which is why it ran for a fortnight: every one of
// the 3,077 `monthly_close` runs SUCCEEDED. Status green, cost logged, no error anywhere, and not
// one deliverable. So the tests here are about a thing NOT happening, and the last one is a
// call-site assertion rather than a behaviour assertion, because the risk is wiring — a correct
// `scheduleWait` that nothing calls looks more finished than dead code, since it has a spec and
// passes CI while proving nothing about whether the product holds a schedule.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { ClientRequest } from "../src/contract";
import { backoffSeconds, scheduleWait } from "../src/waiting-on-client";

const DAY_S = 24 * 60 * 60;

function req(over: Partial<ClientRequest> = {}): ClientRequest {
  return {
    id: "r1",
    project_id: "p1",
    client_id: "c1",
    kind: "document",
    ask: "March bank statement",
    status: "open",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...over,
  } as ClientRequest;
}

test("no open requests means the schedule runs", () => {
  assert.equal(scheduleWait({ open: [], caseId: "k1" }).wait, false);
});

test("an open request on the schedule's own case holds it", () => {
  const v = scheduleWait({ open: [req({ case_id: "k1" })], caseId: "k1" });
  assert.equal(v.wait, true);
  assert.match(v.reason, /March bank statement/, "the hold does not name what it is waiting for");
});

test("an open request on ANOTHER case does not hold this one", () => {
  /**
   * The failure mode this rules out is the one that would be worse than the bug: one slow client
   * stopping every other client's work. The case is the boundary.
   */
  assert.equal(scheduleWait({ open: [req({ case_id: "k2" })], caseId: "k1" }).wait, false);
});

test("a resolved request never holds anything", () => {
  const v = scheduleWait({ open: [req({ case_id: "k1", status: "resolved" })], caseId: "k1" });
  assert.equal(v.wait, false, "answering the request must be enough to resume work");
});

test("with no case, the schedule's own last task is the key", () => {
  const held = scheduleWait({ open: [req({ task_id: "t9" })], lastTaskId: "t9" });
  assert.equal(held.wait, true);
  const other = scheduleWait({ open: [req({ task_id: "t8" })], lastTaskId: "t9" });
  assert.equal(other.wait, false, "another task's ask is not this schedule's ask");
});

test("a schedule with no case and no previous run is never held", () => {
  /**
   * Deliberate, not an oversight: with nothing to have asked, blocking on "some request exists in
   * this project" is the cross-client failure the case boundary exists to prevent.
   */
  assert.equal(scheduleWait({ open: [req({ case_id: "k1", task_id: "t1" })] }).wait, false);
});

test("the backoff ladder starts at a day, doubles, and caps at a week", () => {
  assert.equal(backoffSeconds(0), DAY_S, "the first hold is not one day");
  assert.equal(backoffSeconds(1), 2 * DAY_S);
  assert.equal(backoffSeconds(2), 4 * DAY_S);
  assert.equal(backoffSeconds(3), 7 * DAY_S, "the ladder does not cap at a week");
  assert.equal(backoffSeconds(50), 7 * DAY_S, "the cap is not a cap");
  /**
   * It caps rather than waiting forever because a request can be abandoned — a client leaves, a
   * founder resolves it outside the product — and a schedule waiting on a row nobody will ever
   * touch is indistinguishable from one that is broken.
   */
});

test("a nonsense streak does not produce a nonsense wait", () => {
  for (const bad of [-1, NaN, Infinity]) {
    const s = backoffSeconds(bad as number);
    assert.ok(s >= DAY_S && s <= 7 * DAY_S, `streak ${bad} produced ${s}s`);
  }
});

test("THE GATE IS ON THE WEDGE-WORK PATH AND NOT ON THE SWEEPS", () => {
  /**
   * The wiring assertion, and the one that matters most.
   *
   * Two ways to get this wrong and both are silent. Putting the gate at the TOP of `fireSchedule`
   * would hold `NUDGE_SWEEP_TASK_TYPE` — the sweep whose entire job is to chase open requests — so
   * an unanswered request would switch off the only thing that closes it, and the product would go
   * quieter the more it was owed. Leaving the gate out entirely restores the 3,077 runs.
   *
   * So this asserts POSITION: `scheduleWait` is called after every sweep branch has returned, and
   * immediately before the branch that mints a real task.
   */
  const src = readFileSync(new URL("../src/scheduler.ts", import.meta.url), "utf8");

  const gate = src.indexOf("scheduleWait({");
  const mint = src.indexOf("const task = makeTask();\n  await store.createTask(task);");
  const lastSweep = src.lastIndexOf("return recordOrSkip(");

  assert.ok(gate > 0, "fireSchedule no longer calls scheduleWait — the 3,077-run hold is gone");
  assert.ok(mint > 0, "the wedge-work branch has moved; this test can no longer see what it guards");
  assert.ok(gate < mint, "the gate is after the task is created, which is too late to hold anything");
  assert.ok(
    gate > lastSweep,
    "the gate is above a sweep branch — a sweep held by an open request cannot chase it",
  );
});

test("the hold defers and never disables", () => {
  /**
   * `pacing-is-a-wait-not-a-failure`, applied to inputs instead of quotas. A schedule that goes
   * `disabled` because a client was slow is one somebody has to remember to switch back on.
   */
  const src = readFileSync(new URL("../src/scheduler.ts", import.meta.url), "utf8");
  /*
    Sliced FORWARD from the hold. `const task = makeTask();` appears three times in this file — the
    two sweep paths use it too — so `indexOf` on it lands before the hold and produces an empty
    slice, which is a test that passes by measuring nothing.
  */
  const from = src.indexOf("if (verdict?.wait)");
  assert.ok(from > 0, "the hold branch is gone");
  const held = src.slice(from, from + 1200);
  assert.match(held, /next_run_at:/, "the hold does not move the clock");
  assert.ok(!/enabled:\s*false/.test(held), "the hold disables the schedule instead of deferring it");
});
