/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * A REPAIR THAT ONLY RUNS AT AUTHORING TIME IS A REPAIR FOR A POPULATION OF ZERO
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Measured against production on 14 September. Three services have ever been written by the
 * meta-agent — 9 August, 14 August, 6 September — and graded with the code shipped that morning they
 * came back with **35 weak findings and not one clean**, every one of them carrying the same verdict:
 *
 *     "It will produce work, and almost nothing checks whether the work is right. Fine to try on
 *      your own business, not on a client who is paying."
 *
 * The refusal-path derivation had shipped hours earlier and accounted for eleven of those findings.
 * It did nothing, because it lived in `authorWedgeFromOutput` — a function that runs ONCE, when the
 * model's output is first parsed. All three services predated it. Nothing re-runs authoring, so no
 * already-written service would ever receive the fix, and the population it could help was zero.
 *
 * `repairAuthoredManifest` is the function that runs on EVERY LOAD, through `toLoaded`. That is what a
 * deterministic idempotent repair is for, and it is where structural derivations belong.
 *
 * ═══ THE LINE THIS FILE DEFENDS ═══
 *
 * A repair may derive STRUCTURE and must never invent TRADE KNOWLEDGE. Three things landed on the
 * right side of that line and one deliberately did not:
 *
 *   · every client-facing job gets a way to say it could not do the work — true of a dental recall,
 *     a visa application and a cleaning rota alike
 *   · a list of objects whose author ALREADY declared an evidence field gets the gate that enforces
 *     it — noticing a declaration, not making one
 *   · a job with no output schema is left alone, because adding a field to a schema that has none is
 *     not repair, it is deciding what the business produces
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { repairAuthoredManifest } from "../src/wedgeauthor";
import { gradeDeliverables } from "../src/deliverable-grade";

type Manifest = Record<string, unknown>;
const load = (m: Manifest): Manifest => {
  // Exactly what `toLoaded` does to a stored row. Called twice everywhere below, because idempotence
  // is the property that makes running this on every load safe.
  repairAuthoredManifest(m, []);
  repairAuthoredManifest(m, []);
  return m;
};

/** A service as the model actually writes them: prose, string lists, one list of objects with evidence. */
const stored = (): Manifest => ({
  wedge: "drafted:design-feedback-and-scope-changes",
  title: "Design feedback and scope changes",
  task_types: {
    draft_scope_change: {
      deliverable_kind: "document",
      output_schema: {
        type: "object",
        required: ["change_summary"],
        properties: {
          change_summary: { type: "string" },
          fee_minor_units: { type: "integer" },
          assumptions: { type: "array", items: { type: "string" } },
          impacts: {
            type: "array",
            items: {
              type: "object",
              properties: { impact: { type: "string" }, evidence: { type: "string" } },
            },
          },
        },
      },
    },
    reconcile_internal: {
      internal: true,
      output_schema: { type: "object", properties: { note: { type: "string" } } },
    },
  },
});

test("A SERVICE WRITTEN BEFORE THE FIX STILL GETS THE FIX", () => {
  const m = load(stored());
  const job = (m.task_types as Record<string, { output_schema: { properties: Record<string, unknown> } }>)
    .draft_scope_change!;
  assert.ok(job.output_schema.properties.could_not_complete, "no way to say the work could not be done");
  assert.equal(
    gradeDeliverables(m as never, { exemplars: 0 }).findings.filter((f) => f.rule === "no-refusal-path").length,
    0,
    "the grade still says this job cannot refuse — the derivation and the grader disagree",
  );
});

test("the refusal is offered, never required", () => {
  /*
    This runs on services that are already promoted and already running. A new field in `required`
    would fail every run in flight for not setting a flag it had never been told about — a repair that
    breaks the thing it repairs.
  */
  const m = load(stored());
  const job = (m.task_types as Record<string, { output_schema: { required?: string[] } }>).draft_scope_change!;
  assert.ok(!(job.output_schema.required ?? []).includes("could_not_complete"));
});

test("machinery is left alone", () => {
  // An internal job hands a client nothing, so it has nothing to refuse TO anybody.
  const m = load(stored());
  const job = (m.task_types as Record<string, { output_schema: { properties: Record<string, unknown> } }>)
    .reconcile_internal!;
  assert.equal(job.output_schema.properties.could_not_complete, undefined);
});

test("AN EVIDENCE FIELD THE AUTHOR DECLARED BECOMES A GATE", () => {
  const m = load(stored());
  const job = (m.task_types as Record<string, { ship_checks?: Array<Record<string, unknown>> }>).draft_scope_change!;
  const gate = (job.ship_checks ?? []).find((c) => c.kind === "each_has" && c.items === "impacts");
  assert.ok(gate, "the author asked every impact to carry its evidence and nothing enforces it");
  assert.equal(gate.field, "evidence");
  // Idempotent: `load` ran the repair twice and there must be exactly one.
  assert.equal((job.ship_checks ?? []).filter((c) => c.kind === "each_has").length, 1);
});

test("a list of strings gets no gate, because the gate would never fire", () => {
  /*
    `ship-checks.ts` records this in its own header: an `each_has` pointed at a string array did
    nothing, and "a typo here silently disables the gate". A string has no field to name. Deriving one
    anyway would install a check that passes forever on a service that believes it is held to
    something — worse than the finding it silences.
  */
  const m = load(stored());
  const job = (m.task_types as Record<string, { ship_checks?: Array<Record<string, unknown>> }>).draft_scope_change!;
  assert.ok(!(job.ship_checks ?? []).some((c) => c.items === "assumptions"));
});

test("NOTHING IS INVENTED — a list with no evidence field keeps its finding", () => {
  /**
   * The other half, and the more important one. Deciding that a list of proposed actions OUGHT to
   * cite something is a judgement about the trade. Noticing that the author already said each entry
   * carries `evidence`, and making that binding, is structure.
   *
   * So a job whose list declares no provenance keeps `claims-without-evidence`, and the founder
   * reading "nothing makes each entry name where it came from" is being told something true.
   */
  const m: Manifest = {
    wedge: "drafted:test",
    task_types: {
      write_plan: {
        deliverable_kind: "document",
        output_schema: {
          type: "object",
          required: ["steps"],
          properties: {
            steps: { type: "array", items: { type: "object", properties: { step: { type: "string" } } } },
          },
        },
      },
    },
  };
  load(m);
  const job = (m.task_types as Record<string, { output_schema: { properties: Record<string, { items?: { properties?: Record<string, unknown> } }> }; ship_checks?: unknown[] }>).write_plan!;
  assert.equal(job.output_schema.properties.steps!.items?.properties?.source, undefined, "a source field was invented");
  assert.ok(!(job.ship_checks ?? []).some((c) => (c as { kind?: string }).kind === "each_has"));
  assert.ok(
    gradeDeliverables(m as never, { exemplars: 0 }).findings.some((f) => f.rule === "claims-without-evidence"),
    "the finding was silenced without the provenance being enforced",
  );
});

test("A SCHEMA WITH NO PROPERTIES IS NOT REPAIRED INTO ONE", () => {
  /*
    `authoredFaults` refuses `{ type: "object", properties: {} }` with "does not say what it produces"
    — a schema that validates everything is the thin failure that looks configured. The first version
    of the refusal derivation wrote one property into that empty object, `isObjectSchema` then passed
    it, and a job with no declared output became a stored draft whose only field is its own refusal
    flag. `eval-generation-quality.test.ts` caught it on the first run.
  */
  const m: Manifest = {
    wedge: "drafted:test",
    task_types: { write_thing: { deliverable_kind: "document", output_schema: { type: "object", properties: {} } } },
  };
  load(m);
  const job = (m.task_types as Record<string, { output_schema: { properties: Record<string, unknown> } }>).write_thing!;
  assert.deepEqual(Object.keys(job.output_schema.properties), [], "an empty schema was repaired into a real-looking one");
});

test("THE VERDICT COUNTS JOBS WITH NO GATE, NOT FINDINGS", () => {
  /**
   * The verdict was `weak >= 3 → "almost nothing checks whether the work is right"`. An absolute count
   * knows nothing about how big the service is, so a service earns the worst sentence available by
   * being LARGER — and on 14 September `drafted:geo-audit-and-action-plan` carried SEVEN `ship_checks`
   * and was told almost nothing checked it.
   *
   * A harsh verdict on this screen is fine. A FALSE one is not: a founder who reads it, looks at the
   * gates, and sees they disagree has learned the grade is decoration.
   */
  const gated = {
    wedge: "drafted:test",
    task_types: Object.fromEntries(
      ["a", "b", "c", "d"].map((k) => [
        `write_${k}`,
        {
          deliverable_kind: "document",
          output_schema: { type: "object", required: ["body"], properties: { body: { type: "string" } } },
          // `n`, not `min`: `readShipChecks` drops a check whose shape it cannot parse, so the first
          // version of this fixture had ZERO effective checks and the test failed on its own gated case.
          ship_checks: [{ kind: "min_words", field: "body", n: 50 }],
        },
      ]),
    ),
  };
  const none = {
    wedge: "drafted:test",
    task_types: Object.fromEntries(
      ["a", "b", "c", "d"].map((k) => [
        `write_${k}`,
        {
          deliverable_kind: "document",
          output_schema: { type: "object", required: ["body"], properties: { body: { type: "string" } } },
        },
      ]),
    ),
  };
  const v = (m: unknown) => gradeDeliverables(m as never, { exemplars: 0 }).verdict;
  assert.doesNotMatch(v(gated), /nothing checks/, "a service where every job is gated is told nothing checks it");
  assert.match(v(none), /nothing checks whether the work is right/, "a service with no gates at all is not told so");
  // And the two must not read the same, which is the whole point of the tiers.
  assert.notEqual(v(gated), v(none));
});
