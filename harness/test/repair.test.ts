import { test } from "node:test";
import assert from "node:assert/strict";
import { repairOutput } from "../src/repair";
import { validateOutput } from "../src/validate";
import { buildPromptForTest } from "../src/runtime";

/**
 * ═══ THE PRODUCTION FAILURE THESE TESTS ARE FOR ═══
 *
 * Live dogfooding on openai/gpt-5.6-luna: the `business-shaper` / `draft_shape` run — the flagship
 * "describe your business" first impression — failed validation with
 * `$.sells / $.sells_to / $.runs_as / $.first_job / $.confidence: required`. There was no retry at
 * any layer, so a recoverable near-miss hard-failed the single most important moment.
 *
 * `repairOutput` is the deterministic safety net: it unwraps a nested answer and fills schema-declared
 * defaults, but never fabricates a substantive business fact. These tests pin exactly that — recovery
 * where it is honest, and a fail-closed refusal where it is not.
 */

// A faithful subset of business-shaper / draft_shape's real output_schema (kernel/wedges/business-shaper).
const SHAPE_SCHEMA = {
  type: "object",
  required: ["sells", "sells_to", "runs_as", "first_job", "confidence"],
  properties: {
    name: { type: "string" },
    sells: { type: "string" },
    sells_to: { type: "string" },
    runs_as: {
      type: "object",
      required: ["fit"],
      properties: { fit: { type: "string", enum: ["direct", "adjacent", "none"] } },
    },
    first_job: {
      type: "object",
      required: ["title", "why"],
      properties: { title: { type: "string" }, why: { type: "string" } },
    },
    confidence: { type: "string", enum: ["high", "medium", "low"], default: "low" },
  },
};

const fullShapeMinus = (drop: string[]): Record<string, unknown> => {
  const base: Record<string, unknown> = {
    name: "Harborline Books",
    sells: "monthly bookkeeping",
    sells_to: "UK creative agencies",
    runs_as: { fit: "direct" },
    first_job: { title: "Reconcile last month", why: "the books are behind" },
    confidence: "high",
  };
  for (const k of drop) delete base[k];
  return base;
};

test("a run that validates is never touched — repair only runs on the failure path", () => {
  // repairOutput is only called after validateOutput fails; assert the valid answer passes so it is.
  assert.equal(validateOutput(JSON.stringify(fullShapeMinus([])), SHAPE_SCHEMA).ok, true);
});

test("a missing confidence is defaulted to low, not hard-failed", () => {
  const raw = JSON.stringify(fullShapeMinus(["confidence"]));
  assert.equal(validateOutput(raw, SHAPE_SCHEMA).ok, false, "precondition: this near-miss fails as-is");

  const r = repairOutput(raw, SHAPE_SCHEMA);
  assert.ok(r, "should recover a draft missing only confidence");
  assert.equal((r!.value as { confidence: string }).confidence, "low");
  assert.equal(validateOutput(r!.text, SHAPE_SCHEMA).ok, true);
  assert.match(r!.changes.join(" "), /confidence/);
});

test("an answer nested one key deep is unwrapped — the exact gpt-5.6-luna failure", () => {
  // Every required field present, but the whole object wrapped under "shape" — so the top-level
  // object is missing sells / sells_to / runs_as / first_job / confidence, the reported error.
  const raw = JSON.stringify({ shape: fullShapeMinus([]) });
  assert.deepEqual(validateOutput(raw, SHAPE_SCHEMA).errors.sort(), [
    "$.confidence: required",
    "$.first_job: required",
    "$.runs_as: required",
    "$.sells: required",
    "$.sells_to: required",
  ]);

  const r = repairOutput(raw, SHAPE_SCHEMA);
  assert.ok(r, "should unwrap the nested answer");
  assert.equal((r!.value as { sells: string }).sells, "monthly bookkeeping");
  assert.equal(validateOutput(r!.text, SHAPE_SCHEMA).ok, true);
  assert.match(r!.changes.join(" "), /unwrapped/);
});

test("unwrapping AND defaulting compose in one pass (nested, and missing confidence inside)", () => {
  const raw = JSON.stringify({ result: fullShapeMinus(["confidence"]) });
  const r = repairOutput(raw, SHAPE_SCHEMA);
  assert.ok(r);
  assert.equal((r!.value as { confidence: string }).confidence, "low");
  assert.equal(validateOutput(r!.text, SHAPE_SCHEMA).ok, true);
});

test("repair works through prose and fences, reusing the same extraction as validateOutput", () => {
  const raw = "Here's the shape:\n```json\n" + JSON.stringify(fullShapeMinus(["confidence"])) + "\n```\nHope that helps!";
  const r = repairOutput(raw, SHAPE_SCHEMA);
  assert.ok(r);
  assert.equal(validateOutput(r!.text, SHAPE_SCHEMA).ok, true);
});

test("a missing SUBSTANTIVE field is NOT fabricated — repair fails closed", () => {
  // `sells` carries no default; refuse rather than invent what the business sells.
  for (const field of ["sells", "sells_to", "runs_as", "first_job"]) {
    const raw = JSON.stringify(fullShapeMinus([field]));
    assert.equal(repairOutput(raw, SHAPE_SCHEMA), null, `must not repair a missing ${field}`);
  }
});

test("a genuinely empty answer is not massaged into a fake business", () => {
  assert.equal(repairOutput("{}", SHAPE_SCHEMA), null);
  assert.equal(repairOutput("I could not read this business.", SHAPE_SCHEMA), null);
});

test("a wrong enum value is the model's answer and is left to fail honestly", () => {
  // confidence present but invalid — not a missing field, so the default does not overwrite it.
  const bad = fullShapeMinus([]);
  bad.confidence = "very high";
  assert.equal(repairOutput(JSON.stringify(bad), SHAPE_SCHEMA), null);
});

test("the strict prompt names the required fields and forbids nesting", () => {
  const prompt = buildPromptForTest(
    { wedge: "business-shaper", task_type: "draft_shape", input: {}, output_schema: SHAPE_SCHEMA } as never,
    null,
    { shape: "decide", strict_output: true } as never,
  );
  assert.match(prompt, /sells, sells_to, runs_as, first_job, confidence/);
  assert.match(prompt, /do not nest the answer under another key/);
});
