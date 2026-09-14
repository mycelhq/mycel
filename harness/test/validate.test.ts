import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateValue } from "../src/validate";

// ── if / then ─────────────────────────────────────────────────────────────────────────────────────
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// "WE CANNOT RUN YOUR BUSINESS, AND HERE IS NOTHING TO DO ABOUT IT" WAS A SCHEMA-CLEAN ANSWER
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// `draft_shape` answers `runs_as.fit: "none"` — nothing we ship is this business's work — and
// `runs_as.to_author` lists the services to write for them. The subset here was type/required/
// properties/enum/items, none of which can require the second when the first is true. Twelve
// production shapes answered `none`; NINE proposed nothing, and every one was schema-valid.
//
// It is a RETRY rather than a failure, which is why the schema is the right layer: `runtime.ts`
// polls `output/result.txt` and ends the run the moment it validates, so an answer that does not
// validate simply does not finish the run and the agent keeps working within its eight steps.
//
// (The first attempt was a `ship_checks` entry. It was dead twice: the manifest key is `ship_checks`
// and I wrote `checks`, and `client-ready.ts` only evaluates checks for task types declaring
// `ship_requires` — which is for CLIENT-FACING jobs, and shaping a business is not one.)

const SHAPE_RULE = {
  type: "object",
  properties: { fit: { enum: ["direct", "adjacent", "none"] }, to_author: { type: "array" } },
  required: ["fit"],
  if: { properties: { fit: { enum: ["none"] } }, required: ["fit"] },
  then: { required: ["to_author"], properties: { to_author: { type: "array", minItems: 1 } } },
};

test("IF/THEN: fit=none with nothing to author is rejected", () => {
  const empty = validateValue({ fit: "none", to_author: [] }, SHAPE_RULE);
  assert.ok(empty.length > 0, "a business we cannot serve, proposing nothing, validated");
  assert.match(empty.join(" "), /at least 1 item/);

  // Absent entirely is how nine of the twelve actually answered.
  const missing = validateValue({ fit: "none" }, SHAPE_RULE);
  assert.ok(missing.some((e) => /to_author: required/.test(e)), `expected a required error, got ${missing}`);
});

test("it is silent when the catalogue covers the work", () => {
  /*
    `direct` and `adjacent` mean we already run this, and an empty list is the CORRECT answer there.
    A rule that demanded an entry would invent work and put a draft in front of a founder who needs
    none — which is why this is conditional rather than a plain `minItems` on the field.
  */
  assert.deepEqual(validateValue({ fit: "direct" }, SHAPE_RULE), []);
  assert.deepEqual(validateValue({ fit: "adjacent", to_author: [] }, SHAPE_RULE), []);
  assert.deepEqual(validateValue({ fit: "none", to_author: [{ title: "Payroll compliance" }] }, SHAPE_RULE), []);
});

test("a non-matching `if` leaves `then` unapplied, and its own errors are not reported", () => {
  /**
   * `if` is a PROBE. Its failures decide whether `then` applies and must never reach the caller —
   * otherwise every `direct` answer would carry "fit: not one of [none]", which is not a defect and
   * would be read as one.
   */
  const errs = validateValue({ fit: "direct" }, SHAPE_RULE);
  assert.deepEqual(errs, [], `the probe leaked its own errors: ${errs}`);
  assert.ok(!errs.some((e) => /not one of/.test(e)));
});

test("minItems only bites on arrays, and the real errors still come through", () => {
  // A model that answers the array as prose has produced zero entries, not one.
  const prose = validateValue({ fit: "none", to_author: "payroll compliance" }, SHAPE_RULE);
  assert.ok(prose.some((e) => /expected array/.test(e)), `expected a type error, got ${prose}`);
  // And the unconditional half of the schema is untouched by any of this.
  assert.ok(validateValue({}, SHAPE_RULE).some((e) => /fit: required/.test(e)));
  assert.ok(validateValue({ fit: "sideways" }, SHAPE_RULE).some((e) => /not one of/.test(e)));
});

test("THE SHAPER'S OWN SCHEMA CARRIES IT", () => {
  // A rule nobody mounts is the dominant bug class here, and this one has already been dead once.
  const manifest = JSON.parse(
    readFileSync(new URL("../../wedges/business-shaper/wedge.json", import.meta.url).pathname, "utf8"),
  ) as { task_types: Record<string, { output_schema: { properties: { runs_as: Record<string, unknown> } } }> };
  const runsAs = manifest.task_types.draft_shape.output_schema.properties.runs_as;
  assert.deepEqual(runsAs.if, { properties: { fit: { enum: ["none"] } }, required: ["fit"] });
  assert.deepEqual(runsAs.then, {
    required: ["to_author"],
    properties: { to_author: { type: "array", minItems: 1 } },
  });
});
