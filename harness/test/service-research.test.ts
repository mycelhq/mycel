// The meta-agent going and looking, and what it must not do with what it finds.
//
// `draft_shape` and `draft_service` both run on the `decide` shape, which allows read/grep/glob/skill
// and nothing else — no browser, no fetch, no search. So the two jobs that decide what a new service
// business IS and write its service worked entirely from the model's priors and the one line the
// founder typed, while the product's claim is that it plugs into ANY service business.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  keepServiceResearch,
  latestServiceResearch,
  withDraftServiceArsenal,
  RESEARCH_COLLECTION,
} from "../src/skill-arsenal";

/** A record store, in a Map. The two methods this seam actually uses. */
function memory() {
  const rows = new Map<string, { project_id: string; collection: string; data: Record<string, unknown> }>();
  return {
    rows,
    async upsertRecord(r: any) {
      rows.set(`${r.project_id}::${r.collection}::${r.key}`, { project_id: r.project_id, collection: r.collection, data: r.data });
    },
    async queryRecords(q: any) {
      return [...rows.values()].filter((r) => r.project_id === q.project_id && r.collection === q.collection);
    },
  };
}

const found = {
  reached: true,
  deliverables: [{ what: "A monthly reconciliation pack", source: "https://example.com/services" }],
  steps: [{ step: "Pull the bank feed", who: "the firm", source: "https://example.com/how" }],
  client_expects: ["Payroll", "Chasing their debtors"],
};

test("a run that could not look is not stored as a finding", async () => {
  /**
   * THE ONE OUTCOME THAT WOULD MAKE THIS JOB WORSE THAN NOT RUNNING IT.
   *
   * `reached: false` means search was unavailable or every page was blocked. Storing it would tell
   * the draft that comes afterwards that there was nothing out there — a far stronger claim than
   * "we could not look", and one that would be laundered into a written service as if researched.
   *
   * Absent means the service is written the way it was written before this job existed: from priors.
   * That is a worse service and a KNOWN one, rather than a wrong one.
   */
  const store = memory();
  await keepServiceResearch(store, { project_id: "p1", output: { reached: false, blocked_by: "search unavailable" } });
  assert.equal(store.rows.size, 0);
  assert.equal(await latestServiceResearch(store, "p1"), undefined);

  await keepServiceResearch(store, { project_id: "p1", output: found });
  assert.equal(store.rows.size, 1);
  assert.ok(await latestServiceResearch(store, "p1"));
});

test("research belongs to one project, and goes stale", async () => {
  // A market read from ANOTHER founder's shaping session is not merely stale — it is a description
  // of a different business, and it would arrive in the prompt looking exactly like research about
  // this one.
  const store = memory();
  await keepServiceResearch(store, { project_id: "p1", output: found });
  assert.ok(await latestServiceResearch(store, "p1"));
  assert.equal(await latestServiceResearch(store, "p2"), undefined);
  assert.equal(await latestServiceResearch(store, undefined), undefined);

  // A week. This wedge runs once per business; anything older belongs to a session that was
  // abandoned, and the founder has since typed something else.
  const eightDays = Date.now() + 8 * 24 * 60 * 60 * 1000;
  assert.equal(await latestServiceResearch(store, "p1", eightDays), undefined);
  const sixDays = Date.now() + 6 * 24 * 60 * 60 * 1000;
  assert.ok(await latestServiceResearch(store, "p1", sixDays));
});

test("a store that fails does not fail the draft", async () => {
  // A service drafted without the research is the service this product wrote before the research
  // existed. A draft that fails because a lookup did is strictly worse.
  const broken = {
    async upsertRecord() {},
    async queryRecords(): Promise<unknown[]> {
      throw new Error("database gone");
    },
  };
  assert.equal(await latestServiceResearch(broken, "p1"), undefined);
});

test("the draft only sees research that reached something", () => {
  const withIt = withDraftServiceArsenal({ description: "bookkeeping for builders" }, found);
  assert.deepEqual(withIt.research, found);
  // Everything the arsenal already supplied is still there — this is an addition, not a rewrite.
  assert.ok(Array.isArray(withIt.capabilities) && withIt.capabilities.length > 0);
  assert.ok(Array.isArray(withIt.catalogue));

  for (const bad of [undefined, null, { reached: false }, { deliverables: [] }, "nope"]) {
    assert.equal(withDraftServiceArsenal({ description: "x" }, bad).research, undefined, JSON.stringify(bad));
  }
});

test("every finding has to name where it came from, and the gate says so", () => {
  /**
   * A URL does not prove a claim, and that is not what it is for. It is there because a model asked
   * to cite is a model that had to go and LOOK — and the difference between reading three real
   * firms' service pages and recalling what such a page usually says is invisible in the prose and
   * total in the result.
   */
  const wedge = JSON.parse(
    readFileSync(join(import.meta.dirname, "..", "..", "wedges", "business-shaper", "wedge.json"), "utf8"),
  ) as { task_types: Record<string, any> };
  const spec = wedge.task_types.research_service;
  assert.ok(spec, "the shaping wedge has to declare the job that goes and looks");

  // The `operate` shape is the only one with websearch, webfetch and a browser. On `decide` this job
  // could not reach anything at all — which is the bug it exists to fix.
  assert.equal(spec.harness.shape, "operate");
  assert.equal(spec.internal, true, "a founder never starts this; the shaping flow does");

  const sourced = spec.ship_checks.filter((c: any) => c.kind === "each_has" && c.field === "source").map((c: any) => c.items);
  assert.deepEqual(sourced.sort(), ["deliverables", "steps", "what_goes_wrong"]);

  // A price is a RANGE and it is optional. A single number invented from three data points gets
  // quoted back to a founder as market rate, and they price against it.
  const price = spec.output_schema.properties.price_range_minor;
  assert.deepEqual(Object.keys(price.properties).sort(), ["basis", "currency", "high", "low", "source"]);
  assert.equal(spec.output_schema.required.includes("price_range_minor"), false);
  // `reached` is required, because the honest failure has to be expressible.
  assert.ok(spec.output_schema.required.includes("reached"));
});

test("the collection key is one per project, so a second read replaces the first", async () => {
  // This wedge runs once per business. A pile of reads the draft has to choose between is a choice
  // nothing in the prompt is equipped to make.
  const store = memory();
  await keepServiceResearch(store, { project_id: "p1", output: found });
  await keepServiceResearch(store, { project_id: "p1", output: { ...found, deliverables: [{ what: "Something else", source: "https://x.example" }] } });
  assert.equal(store.rows.size, 1);
  assert.equal([...store.rows.keys()][0], `p1::${RESEARCH_COLLECTION}::latest`);
  const latest = (await latestServiceResearch(store, "p1")) as typeof found;
  assert.equal(latest.deliverables[0]!.what, "Something else");
});
