// What the finished thing looks like — the layer this harness never had.
//
// An authored service gets rules, procedures and (since `identitiesToChecks`) machine gates on its
// arithmetic. None of those describe the ARTEFACT. Measured rather than assumed: a real
// `write_post` run for a landscaping firm produced 688 words with no marketing slop, no invented
// figures, a correct derivation of distribution uniformity and an explicit refusal to state a price
// it had not been given — and handed back a text blob the founder would have to format.
//
// DocReward names this as the standing gap in agentic document generation: workflows optimise
// textual quality and overlook structural professionalism. Its remedy is to judge structure
// SEPARATELY from content, which is the split this codebase already has for artefacts
// (`design-lint` judges layout with no opinion on truth; `shipFaults` judges arithmetic with no
// opinion on layout) and lacked the instruction to make achievable.

import { test } from "node:test";
import assert from "node:assert/strict";

import { deliverableShapeAsSkill, readDeliverableShape } from "../src/deliverable-shape";
import { SERVICE_AUTHORING_RULES } from "../src/authoring-contract";

const SHAPE = {
  format: "report",
  sections: [
    { heading: "Summary for the property manager", must: "State whether the property is summer-ready.", depth: "one short paragraph" },
    { heading: "Zone-by-zone findings", must: "One row per zone with its distribution uniformity.", depth: "a table" },
  ],
};

test("it teaches the shape and imports no findings", () => {
  // THE DESIGN CONSTRAINT. "When Correct Demonstrations Hurt" shows correct demonstrations can
  // REDUCE accuracy through contextual evidence shift — a specimen full of invented findings sits
  // in context beside the real ones and changes the mixture of evidence the model reasons from.
  // A shape carries the structure and none of the evidence.
  const page = deliverableShapeAsSkill(readDeliverableShape(SHAPE))!;
  assert.match(page, /Zone-by-zone findings/);
  assert.match(page, /a table/, "depth is dropped — the part prose cannot carry");
  assert.match(page, /SHAPE, not a sample/i, "nothing tells the run this carries no findings");
  // No numbers that could be mistaken for a result.
  const figures = page.match(/\b\d+(?:\.\d+)?%|\$[\d,]+/g) ?? [];
  assert.deepEqual(figures, [], `the shape page carries importable figures: ${figures.join(", ")}`);
});

test("the format is what the client opens, and markdown is called out as not it", () => {
  const page = deliverableShapeAsSkill(readDeliverableShape(SHAPE))!;
  assert.match(page, /\*\*report\*\*/, "the artefact format is not stated");
  assert.match(page, /Markdown handed to a\nclient is a draft/, "nothing refuses markdown-as-deliverable");
});

test("an unknown shape yields nothing rather than a generic skeleton", () => {
  // "Summary / Findings / Next steps" applied to every trade is worse than silence: it reads as
  // authoritative and is nobody's actual format.
  assert.equal(deliverableShapeAsSkill(undefined), undefined);
  assert.equal(readDeliverableShape({ format: "report", sections: [] }), undefined);
  assert.equal(readDeliverableShape({ sections: "nope" }), undefined);
  assert.equal(readDeliverableShape(null), undefined);
});

test("the reconciliations ride along, because structure serves them", () => {
  const page = deliverableShapeAsSkill(readDeliverableShape(SHAPE), [
    { says: "Inspected areas must sum to the total inspected area.", shape: "sum_of_list", fields: {} } as never,
  ])!;
  assert.match(page, /sum to the total inspected area/);
  // The reason the two belong on one page: a section that shows a total without its parts leaves
  // the machine check nothing to reconcile against.
  assert.match(page, /has nothing to reconcile against/);
});

test("it names both failure modes, because they have different causes", () => {
  const page = deliverableShapeAsSkill(readDeliverableShape(SHAPE))!;
  assert.match(page, /read as sloppy work/, "the unstructured-but-correct failure is unnamed");
  assert.match(page, /read as dishonest/, "the pretty-but-wrong failure is unnamed");
});

test("malformed sections are dropped, not repaired", () => {
  const parsed = readDeliverableShape({
    format: "deck",
    sections: [{ heading: "Real" }, { must: "no heading" }, null, { heading: "   " }],
  })!;
  assert.equal(parsed.sections.length, 1);
  assert.equal(parsed.format, "deck");
});

test("the drafter is asked for it, or nothing ever produces one", () => {
  // The defect this repo produces most: a reader with no writer. The contract must instruct it.
  const rule = SERVICE_AUTHORING_RULES.find((r) => r.id === "deliverable-shape");
  assert.ok(rule, "the authoring contract no longer asks for a deliverable_shape");
  assert.match(rule.guidance, /deliverable_shape/);
  assert.match(rule.guidance, /no findings, figures or client names/i);
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// THE TEMPLATE WAS BUILT AND MOUNTED FOR THE WRONG POPULATION
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//
// `deliverableShapeAsSkill` has existed since the authoring pass and its only caller was
// `wedgeauthor.ts`. So a service Mycel INVENTED was told what the finished object looks like, and
// the thirteen wedges running real engagements were not — the same inversion `compile.ts` already
// names about human ceilings, where the jobs with actual customers were held to the lower bar.
//
// These tests hold the two halves of the fix: that a wedge naming its producing step declares that
// step's shape, and that the shape survives the parse into something a run can read.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const WEDGE_DIR = join(import.meta.dirname, "..", "..", "wedges");

function manifests(): Array<{ wedge: string; m: any }> {
  return readdirSync(WEDGE_DIR)
    .filter((d) => !d.startsWith("."))
    .map((wedge) => {
      try {
        return { wedge, m: JSON.parse(readFileSync(join(WEDGE_DIR, wedge, "wedge.json"), "utf8")) };
      } catch {
        return null;
      }
    })
    .filter((x): x is { wedge: string; m: any } => x !== null);
}

test("a wedge that names its producing step declares that step's shape", () => {
  const missing: string[] = [];
  for (const { wedge, m } of manifests()) {
    const produces = m.fulfillment?.production_task_type;
    if (!produces) continue;
    const tt = m.task_types?.[produces];
    assert.ok(tt, `${wedge}: fulfillment names "${produces}" and no such task type exists`);
    // `link` producers hand over a URL, not a document with sections — a section order is not the
    // right description of a shipped page, and inventing one for it would be this test demanding
    // a field that means nothing for that noun.
    if (tt.deliverable_kind === "link") continue;
    if (!readDeliverableShape(tt.deliverable_shape)) missing.push(`${wedge}/${produces}`);
  }
  assert.deepEqual(
    missing,
    [],
    `these wedges name the step that produces the client's work and never say what it looks like: ${missing.join(", ")}`,
  );
});

test("every declared shape parses and renders a page naming its own format", () => {
  let checked = 0;
  for (const { wedge, m } of manifests()) {
    for (const [name, tt] of Object.entries<any>(m.task_types ?? {})) {
      if (!tt?.deliverable_shape) continue;
      const parsed = readDeliverableShape(tt.deliverable_shape);
      assert.ok(parsed, `${wedge}/${name}: declares a deliverable_shape that does not parse`);
      const page = deliverableShapeAsSkill(parsed);
      assert.ok(page, `${wedge}/${name}: parses but renders nothing`);
      // The format is the one instruction the page exists to carry — a shape that renders without
      // naming the noun the client opens has lost the point of being mounted.
      assert.match(page!, new RegExp(`\\*\\*${parsed!.format}\\*\\*`), `${wedge}/${name}: page never names its format`);
      // Every section must state an obligation. A heading with no `must` is a table of contents,
      // and a run reading one learns the order and nothing about what goes in it.
      for (const s of parsed!.sections) {
        assert.ok(s.must.trim().length > 20, `${wedge}/${name}: section "${s.heading}" says nothing about what must be in it`);
      }
      checked++;
    }
  }
  // Named rather than counted: a count breaks the day someone adds a shape, having found nothing.
  assert.ok(checked > 0, "no wedge declares a deliverable_shape — the template layer is unmounted again");
});

test("STANDARD §6 on this trade is in the geo wedge's shape, not only in the prose", () => {
  const m = manifests().find((x) => x.wedge === "geo-monitor")!.m;
  const shape = readDeliverableShape(m.task_types.weekly_report.deliverable_shape);
  assert.ok(shape, "geo-monitor/weekly_report declares no shape");
  const page = deliverableShapeAsSkill(shape)!.toLowerCase();
  // "a scorecard plus three sized recommendations — one Small, one Medium, one Large. Lead with
  // the Small." The wedge's ship_checks already enforce the spread in the JSON; this is the same
  // sentence made structural, so the run lays them out in that order instead of discovering it.
  for (const word of ["scorecard", "small", "medium", "large"]) {
    assert.ok(page.includes(word), `the GEO shape never mentions "${word}" — §6 names it`);
  }
  const headings = shape!.sections.map((s) => s.heading.toLowerCase());
  assert.ok(
    headings.some((h) => h.includes("next week")),
    "the GEO shape has no section for what happens next — §6: current wedges mostly miss the third",
  );
});
