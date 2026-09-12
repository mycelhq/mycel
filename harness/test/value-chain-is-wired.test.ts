/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * "HOURS SAVED" IS A FOUR-LINK CHAIN AND ONE LINK WAS MISSING FOR MONTHS
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The founder's words: "the ROI needs to be really clear". The product computes it:
 *
 *   1. a job declares `typical_hours` — what a competent practitioner takes
 *   2. `founderSubmit` stamps it onto the version as `human_hours`
 *   3. `GET /v1/value` reads it and `measureValue` turns it into hours saved
 *   4. something renders the number
 *
 * Link 2 was broken in the most invisible way available: `human_hours` was in the TypeScript
 * contract, written on every submit, and had NO POSTGRES COLUMN. It was discarded on every write
 * and read back undefined, so `measureValue` counted every finished piece of work as UNESTIMATED
 * and the honest answer to "what has this saved me" was permanently "nothing we can price".
 *
 * Exactly the bug `review` had, in the same table. Found by asking which kernel fields the console
 * never mentions — the same question that found `edits`.
 *
 * These tests pin the DATA PATH. They cannot pin link 1 (nobody has researched the hours yet) or
 * link 4 (nothing renders it), and the file says so out loud rather than implying the chain works.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { submitVersionSql } from "../src/deliverables.pg";

const pg = readFileSync(new URL("../src/deliverables.pg.ts", import.meta.url), "utf8");

test("the column exists, so the figure has somewhere to land", () => {
  assert.match(
    pg,
    /ALTER TABLE deliverable_versions ADD COLUMN IF NOT EXISTS human_hours numeric/,
    "human_hours has no column — it is discarded on every write, exactly as `review` was",
  );
  // `numeric`, not `int`: a half-hour job would round to zero and quietly leave the smallest work
  // out of the total.
  assert.ok(!/human_hours (int|integer)/.test(pg), "an integer column deletes every half-hour job from the total");
});

test("it is written, and read back as a number", () => {
  const { sql, vals } = submitVersionSql({
    project_id: "p", deliverable_id: "d", allowedFrom: ["drafting"], new_id: "v",
    version: { summary: "s", artifact_ids: [], human_hours: 2.5 } as any,
    at: new Date().toISOString(),
  });
  assert.match(sql, /human_hours/, "the INSERT does not name the column");
  assert.ok(vals.includes(2.5), `the value never reaches the statement: ${JSON.stringify(vals)}`);

  // pg hands `numeric` back as a string; the contract promises a number.
  assert.match(pg, /human_hours: r\.human_hours === null \|\| r\.human_hours === undefined \? undefined : Number\(r\.human_hours\)/,
    "the read either drops it or leaves it as a string");
});

test("a version with no estimate stores null, never zero", () => {
  // Zero is a claim — "this work was worth nothing". Absent is the truth, and `measureValue`
  // counts it as unestimated so the founder is told the number is incomplete.
  const { vals } = submitVersionSql({
    project_id: "p", deliverable_id: "d", allowedFrom: ["drafting"], new_id: "v",
    version: { summary: "s", artifact_ids: [] } as any,
    at: new Date().toISOString(),
  });
  assert.ok(!vals.includes(0), "a missing estimate was written as zero, which is a false claim about the work");
});

/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * LINK 1 IS STILL OPEN, AND THIS RECORDS IT RATHER THAN HIDING IT
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Not one of the shipped trades declares `typical_hours`, so the ROI number has no data even with
 * the column in place. That is NOT something to fix by writing numbers in: `typical_hours` is a
 * fact about a trade, sourced from a rate card or a trade body, and the schema's own guidance says
 * "omit it rather than guess — an invented hours figure inflates a number the founder will quote to
 * a buyer, and that is the worst possible place for one."
 *
 * So this asserts the CURRENT state deliberately. When somebody researches the hours for a trade
 * the count goes up, this test goes red, and whoever changed it updates the number having read why
 * it was zero.
 */
test("how many shipped trades can price their work — currently none, and that is the open gap", () => {
  const dir = new URL("../../wedges/", import.meta.url);
  let total = 0;
  let priced = 0;
  for (const w of readdirSync(dir)) {
    let m: any;
    try {
      m = JSON.parse(readFileSync(new URL(`${w}/wedge.json`, dir), "utf8"));
    } catch {
      continue;
    }
    for (const spec of Object.values<any>(m.task_types ?? {})) {
      if (!spec || typeof spec !== "object") continue;
      total++;
      if (typeof spec.typical_hours === "number") priced++;
    }
  }
  assert.ok(total > 20, `only found ${total} task types — the scan is broken, not the data`);
  assert.equal(
    priced,
    0,
    `${priced} of ${total} task types now declare typical_hours. If that is real research, update ` +
      `this number. If somebody guessed, take it out — the schema forbids it for a reason.`,
  );
});

test("the authoring path DOES ask for it, so a written service can be priced", () => {
  // The source is already correct for services we write per business: `research_service` hunts for
  // the figure and `draft_service` has a field for it. Only the shipped catalogue lacks it.
  const shaper = JSON.parse(readFileSync(new URL("../../wedges/business-shaper/wedge.json", import.meta.url), "utf8"));
  const job = shaper.task_types.draft_service.output_schema.properties.manifest.properties.task_types;
  assert.ok(job.additionalProperties.properties.typical_hours, "draft_service stopped asking for the hours");
  // The two jobs word it differently — `research_service` says "omit it rather than guess",
  // `draft_service` says "omit it when the research did not find one". Match the SUBSTANCE, or the
  // test breaks on a rewording and passes on a deletion, which is backwards.
  const guidance = JSON.stringify(job.additionalProperties.properties.typical_hours);
  assert.match(guidance, /omit it/i, "nothing tells the model to leave the figure out when it does not know");
  const research = JSON.stringify(
    shaper.task_types.research_service.output_schema ?? {},
  );
  assert.match(
    research,
    /invented hours figure|omit it rather than guess/i,
    "the research step no longer warns against inventing the number — that warning is the only " +
      "thing standing between a guess and a figure the founder quotes to a buyer",
  );
});
