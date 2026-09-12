// THE WORK A CLIENT PAYS FOR HAD A DECISION'S HARNESS.
//
// Every long-form deliverable — a monthly close, a visibility report, a screened longlist, an
// answered questionnaire packet — ran on `decide`: standard tier, 7 minutes, 50 cents,
// `temperature: 0.1`, 40 steps. For `decide` those are the right numbers. Picking the next dunning
// rung wants the most probable answer every time and variance there is a bug.
//
// A deliverable is not that, and the temperature is the sharpest example: at 0.1 the model takes the
// highest-probability continuation at every token, which is how a report comes out grammatical,
// correctly structured and thin — the exact phrase `exemplar.ts` uses about production output today,
// "competent, correctly structured, and SHORT". Depth is where a writer reaches past the obvious next
// sentence, and 0.1 is an instruction not to.
import test from "node:test";
import assert from "node:assert/strict";
import { SHAPE_DEFAULTS, isShape, resolveHarnessProfile } from "../src/harness";
import { loadWedge } from "../src/wedge";
import type { Task } from "../src/contract";

const CEILINGS = { maxRuntimeS: 3600, maxCostUsd: 50 };

function taskOf(wedge: string, task_type: string): Task {
  return {
    id: "t1", project_id: "p1", wedge, task_type,
    actor: { kind: "system", id: "test" }, input: {},
    constraints: { max_runtime_s: 3600, max_cost_usd: 50, approval_required: false },
    tools: [], status: "queued", cost_usd: 0,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  } as Task;
}

test("deliver is a real shape a manifest can ask for", () => {
  assert.equal(isShape("deliver"), true);
  const d = SHAPE_DEFAULTS.deliver;
  // NOT `deep`, and that is a decision rather than an oversight. models.ts, 29 August: Luna is
  // $0.20/$1.20 against Terra's $2.00/$12.00 for 3.8 points of aggregate index, so an HOUR of Luna
  // costs less than twenty minutes of Terra. What long knowledge work is short of is turns, not a
  // better first guess.
  assert.equal(d.tier, "standard");
  assert.ok(d.strict_output, "these are the runs whose output IS the product");
});

test("deliver gives a document the room a decision does not need", () => {
  const dec = SHAPE_DEFAULTS.decide;
  const del = SHAPE_DEFAULTS.deliver;
  assert.ok(del.max_runtime_s > dec.max_runtime_s, "a thousand-word researched report is not a 7-minute job");
  // The same hour `build` gets. A coding task is write, run, read the failure, change it; a monthly
  // close is that loop pointed at a ledger.
  assert.equal(del.max_runtime_s, SHAPE_DEFAULTS.build.max_runtime_s, "knowledge work needs a build's room");
  assert.ok(del.max_cost_usd > dec.max_cost_usd);
  assert.ok((del.steps ?? 0) > (dec.steps ?? 0), "a run that spends its steps gathering has none left to write with");
});

test("deliver is warmer than decide, and nowhere near creative", () => {
  const del = SHAPE_DEFAULTS.deliver;
  assert.ok((del.temperature ?? 0) > (SHAPE_DEFAULTS.decide.temperature ?? 0));
  // These documents carry figures — a close reports a reconciliation, a report a share of voice.
  // Warmth in prose must not become invention in numbers: the arithmetic gates catch a wrong total,
  // and nothing catches a plausible one nobody checked.
  assert.ok((del.temperature ?? 0) <= 0.4, "a bookkeeping document is not creative writing");
});

test("the long-form deliverables actually ask for it", () => {
  // The point of the change. Each of these produces a document a client reads end to end.
  for (const [wedge, type] of [
    ["books-keeper", "monthly_close"],
    ["geo-monitor", "weekly_report"],
    ["recruiting-desk", "screen_longlist"],
    ["security-questionnaire", "fill_questionnaire"],
  ] as const) {
    const w = loadWedge(wedge);
    if (!w) continue; // an install without this wedge on disk
    const p = resolveHarnessProfile({ task: taskOf(wedge, type), wedge: w, ceilings: CEILINGS });
    assert.equal(p.shape, "deliver", `${wedge}/${type} should be shaped as a deliverable`);
  }
});

test("a short judgement STAYS on decide", () => {
  // Being selective is the point. `deliver` is expensive, and a four-sentence chase email is not
  // improved by thirty minutes and a warmer temperature — it is only made more expensive and
  // slightly less predictable, which on a message to somebody's client is the wrong trade.
  const w = loadWedge("invoice-chaser");
  if (!w) return;
  const p = resolveHarnessProfile({ task: taskOf("invoice-chaser", "chase_invoice"), wedge: w, ceilings: CEILINGS });
  assert.notEqual(p.shape, "deliver");
});

test("every plan now gets the same model on a deliverable, and that is a real consequence", () => {
  /**
   * `deliver` asks for `standard`, and `standard` is exactly the ceiling for `free` and `starter`.
   * So a starter customer's monthly close now runs on the same model as a scale customer's.
   *
   * Pinned because it is a COMMERCIAL change hiding in a technical one. While `deliver` asked for
   * `deep`, the plan ladder differentiated the deliverable itself: starter got clamped, growth did
   * not. It no longer does. That is defensible — the work a client receives should not be worse
   * because their agency is on a cheaper plan — but it should be a decision somebody made rather
   * than a side effect nobody noticed, so it fails here if the tier moves back.
   */
  const w = loadWedge("books-keeper");
  if (!w) return;
  const t = (plan: "free" | "starter" | "growth") =>
    resolveHarnessProfile({ task: taskOf("books-keeper", "monthly_close"), wedge: w, ceilings: CEILINGS, plan }).tier;
  assert.equal(t("free"), "standard");
  assert.equal(t("starter"), "standard");
  assert.equal(t("growth"), "standard", "growth is not given MORE than the shape asked for");
});

test("a shape that asks above a plan's ceiling is still clamped", () => {
  // The contract that makes every profile a REQUEST rather than a bill. `build` asks for `deep`;
  // a free org gets its ceiling and the run happens anyway.
  const w = loadWedge("product-builder");
  if (!w) return;
  const free = resolveHarnessProfile({
    task: taskOf("product-builder", "build_feature"), wedge: w, ceilings: CEILINGS, plan: "free",
  });
  assert.equal(free.requested_tier, "deep");
  assert.equal(free.tier, "standard", "free tops out at standard");
  assert.equal(free.tier_clamped, true);
});
