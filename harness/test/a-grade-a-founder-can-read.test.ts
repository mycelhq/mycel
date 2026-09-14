/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * ONE ROW PER KIND OF PROBLEM, NOT ONE PER JOB
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `gradeDeliverables` returns one finding per JOB, which is the diagnostic truth and what every other
 * test here enumerates. The review card is not a diagnostic. Measured on
 * `drafted:brand-and-website-projects` in production, 14 September — four of its jobs have no gate,
 * so the card rendered three sentences differing only in a job title and then "2 more".
 *
 * That is `UX.md` rule 2, "no list of near-identical rows", on the one screen where a founder decides
 * whether to trust a machine-written service. The information is one fact — four jobs are ungated —
 * and reading it four times does not make it four facts.
 *
 * ═══ WHAT THIS FILE ACTUALLY GUARDS ═══
 *
 * The fallback in `collapseForFounder` appends "(and 3 other jobs)" to a sentence that names one job
 * by its title: *"Something must be in what 'Shape brand strategy' produces ... (and 3 other jobs)"*.
 * That reads like a bug, and it is the shape the collapse exists to remove. So it is a safety net
 * rather than a plan, and this test proves nothing relies on it: every rule that CAN fire on more
 * than one job must have a plural sentence written for it.
 *
 * The rules are enumerated by grading a manifest whose every job trips everything, so adding a
 * per-job rule without a plural form fails here rather than in front of a customer.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { collapseForFounder, gradeDeliverables, type Finding } from "../src/deliverable-grade";

/** Three jobs, identically broken, so every per-job rule fires three times. */
const THREE_BROKEN_JOBS = {
  wedge: "drafted:test",
  title: "Test",
  task_types: Object.fromEntries(
    ["shape_brand_strategy", "develop_brand_identity", "build_marketing_website"].map((name) => [
      name,
      {
        deliverable_kind: "document",
        output_schema: {
          type: "object",
          required: ["summary"],
          properties: {
            summary: { type: "string" },
            total_amount: { type: "number" },
            line_count: { type: "integer" },
            items: { type: "array", items: { type: "object", properties: { item: { type: "string" } } } },
          },
        },
      },
    ]),
  ),
  fulfillment: {
    client_connections: [
      { toolkit: "nope_one", capability: "read_invoices" },
      { toolkit: "nope_two", capability: "read_invoices" },
    ],
  },
} as unknown as Parameters<typeof gradeDeliverables>[0];

const graded = () => gradeDeliverables(THREE_BROKEN_JOBS, { exemplars: 0, knownToolkits: new Set(["gmail"]) });

test("EVERY RULE THAT CAN REPEAT HAS A SENTENCE FOR THE PLURAL", () => {
  const raw = graded().findings;
  const counts = new Map<string, number>();
  for (const f of raw) counts.set(f.rule, (counts.get(f.rule) ?? 0) + 1);
  const repeating = [...counts].filter(([, n]) => n > 1).map(([r]) => r);
  assert.ok(repeating.length >= 3, `the fixture stopped repeating anything: ${JSON.stringify([...counts])}`);

  const collapsed = collapseForFounder(raw);
  for (const rule of repeating) {
    const row = collapsed.find((f) => f.rule === rule)!;
    assert.doesNotMatch(
      row.says,
      /\(and \d+ other jobs\)/,
      `"${rule}" fell through to the generic fallback — it needs a plural sentence in MANY`,
    );
    assert.match(row.says, /\d/, `"${rule}" collapsed several jobs into a sentence that does not say how many`);
  }
});

test("one row per kind of problem", () => {
  const raw = graded().findings;
  const collapsed = collapseForFounder(raw);
  assert.ok(collapsed.length < raw.length, "nothing was collapsed");
  assert.equal(new Set(collapsed.map((f) => f.rule)).size, collapsed.length, "a rule still has two rows");
  // Nothing is dropped: every kind of problem survives the collapse.
  assert.deepEqual(new Set(collapsed.map((f) => f.rule)), new Set(raw.map((f) => f.rule)));
});

test("the counts the card leads with still count jobs", () => {
  /*
    `blocking` and `weak` are NOT collapsed, and that is deliberate. Those are the numbers beside the
    verdict, and "4 things need attention" is true of four ungated jobs. Collapsing them would make a
    service look better for having the same problem repeatedly, which is the opposite of the point.
  */
  const g = graded();
  assert.ok(g.blocking + g.weak > collapseForFounder(g.findings).length);
});

test("a collapsed row keeps the worst severity in its group", () => {
  const mixed: Finding[] = [
    { rule: "unchecked-output", severity: "weak", says: "a", fix: "f", because: "b" },
    { rule: "unchecked-output", severity: "blocking", says: "b", fix: "f", because: "b" },
  ];
  assert.equal(collapseForFounder(mixed)[0]!.severity, "blocking");
});

test("a founder-facing fix survives the collapse", () => {
  // `audience` is what puts the remedy on the screen. Losing it in the collapse would silently strip
  // the remedy from exactly the findings a founder can act on.
  const two: Finding[] = [
    { rule: "no-money-plan", severity: "weak", audience: "founder", says: "a", fix: "set a price", because: "b" },
    { rule: "no-money-plan", severity: "weak", audience: "founder", says: "b", fix: "set a price", because: "b" },
  ];
  const [row] = collapseForFounder(two);
  assert.equal(row!.audience, "founder");
  assert.equal(row!.fix, "set a price");
});

test("a single finding is passed through untouched", () => {
  const one: Finding[] = [{ rule: "no-exemplar", severity: "note", says: "only one", fix: "f", because: "b" }];
  assert.deepEqual(collapseForFounder(one), one);
});
