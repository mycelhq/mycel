/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * "THE DETAILS HAVEN'T LOADED YET" — ON EVERY RUN, FOREVER
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Opened a run trace on the demo, 14 September. The Cost panel:
 *
 *     $0.0095 spent, no breakdown yet
 *     This job has a cost, but the details haven't loaded yet.
 *
 * Directly beneath it, in the same page, the full log:
 *
 *     14:51:01  cost.charged  +$0.0001 · model_estimated
 *     14:51:07  cost.charged  +$0.0007 · model_estimated
 *
 * The page contained the data and told the founder it did not have it. Nothing was loading: this
 * fold summed `cost.charged` into `totals.cost_usd` and dropped the charge. The console's own type
 * recorded the consequence — "only on a locally folded trace: `/trace` sums the dollars and drops
 * the charges" — and the run page fetches exactly that endpoint.
 *
 * `reason` is why the panel is worth having. `"model"` means the provider priced the call and the
 * number passed through; `"model_estimated"` means it reported none and the kernel guessed from its
 * own table. Both land in the same dollar total and the same spend ceiling, so one figure implies a
 * precision this system does not have — and the person reading it is the one who has to defend it
 * on an invoice.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTrace } from "../src/traces";

let seq = 0;
const ev = (type: string, data: Record<string, unknown> = {}, ts = "2026-09-12T14:51:00.000Z") =>
  ({ task_id: "t1", seq: ++seq, type, ts, data }) as never;

test("EVERY CHARGE SURVIVES THE FOLD", () => {
  const trace = buildTrace([
    ev("task.started"),
    ev("cost.charged", { cost_usd: 0.0001, reason: "model_estimated", model: "claude", tier: "standard" }, "2026-09-12T14:51:01.000Z"),
    ev("cost.charged", { cost_usd: 0.0007, reason: "model", model: "claude", tokens: { input: 900, output: 120 } }, "2026-09-12T14:51:07.000Z"),
    ev("task.finished", { status: "succeeded" }),
  ]);
  assert.equal(trace.charges.length, 2, "the fold still throws the charges away");
  assert.equal(trace.charges[0]!.reason, "model_estimated");
  assert.equal(trace.charges[1]!.reason, "model");
  assert.equal(trace.charges[1]!.tokens?.input, 900, "token counts did not survive");
  assert.equal(trace.charges[0]!.tier, "standard");
  // In order, because the panel prints them as a timeline.
  assert.deepEqual(trace.charges.map((c) => c.ts.slice(11, 19)), ["14:51:01", "14:51:07"]);
});

test("the breakdown still sums to the total", () => {
  /*
    The two numbers are read side by side — the headline figure and the list under it — so a
    breakdown that does not add up to its own total is worse than no breakdown.
  */
  const trace = buildTrace([
    ev("task.started"),
    ev("cost.charged", { cost_usd: 0.0001, reason: "model" }),
    ev("cost.charged", { cost_usd: 0.0007, reason: "model" }),
    ev("cost.charged", { cost_usd: 0.0002, reason: "model_estimated" }),
    ev("task.finished", { status: "succeeded" }),
  ]);
  const summed = trace.charges.reduce((n, c) => n + c.cost_usd, 0);
  assert.equal(Number(summed.toFixed(6)), trace.totals.cost_usd);
});

test("a charge with no price is not invented", () => {
  // `Number.isFinite` gates both the total and the list, so they cannot disagree about what counted.
  const trace = buildTrace([
    ev("task.started"),
    ev("cost.charged", { reason: "model" }),
    ev("cost.charged", { cost_usd: "not a number", reason: "model" }),
    ev("task.finished", { status: "succeeded" }),
  ]);
  assert.deepEqual(trace.charges, [], "a charge with no usable figure was kept");
  assert.equal(trace.totals.cost_usd, 0);
});

test("a run that paid for nothing carries an empty list, never undefined", () => {
  // The console distinguishes "no charges" from "charges not carried" and says different things.
  // `undefined` would put a free run back into the "the detail is gone" branch.
  const trace = buildTrace([ev("task.started"), ev("task.finished", { status: "succeeded" })]);
  assert.deepEqual(trace.charges, []);
});

test("REASON DEFAULTS TO THE HONEST SIDE", () => {
  /*
    An event with no `reason` is an old one, from before the field existed. `"model"` is the default
    because that is what the kernel emitted then — calling it `model_estimated` would mark historical
    charges as guesses they were not.
  */
  const trace = buildTrace([
    ev("task.started"),
    ev("cost.charged", { cost_usd: 0.5 }),
    ev("task.finished", { status: "succeeded" }),
  ]);
  assert.equal(trace.charges[0]!.reason, "model");
});
