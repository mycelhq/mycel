// A RECURRING DELIVERABLE THAT CANNOT COMPARE ITSELF TO LAST TIME IS A SCREENSHOT.
//
// ═══ MEASURED, WITH TWO REAL RUNS ON A REAL MODEL ═══
//
// Same client, a week apart. Week one reported 0% share of voice. Week two reported 50% — a
// doubling, and the single most important fact a weekly report can carry. Week two's output said:
//
//     "No previous-period number or change note was supplied, so movement cannot be assessed."
//
// The number was there. Week one had stored it correctly:
//
//     { collection: "geo_share_of_voice", key: "halstead-robotics",
//       data: { share_of_voice_pct: 0, queries: 2, mentions: 0 } }
//
// ═══ THE CAUSE: AN ENDPOINT WITH NO CONTRACT ═══
//
// Every other address in the sandbox appears TWICE in runtime.ts — once setting the variable, once
// as a worked example in the prompt. `MYCEL_RECORDS_URL` appeared once. The run was handed a URL and
// had to guess the shape, and both runs guessed visibly in their bash history: week one tried a bare
// POST, `/series`, an OPTIONS probe and a PUT before finding `/upsert` on the fifth attempt; week two
// tried a bare GET, `{"type":"series"}` and `/series`, gave up, and never wrote its number at all.
//
// Neither ever called `/query`. Nothing told them the previous period was retrievable.
//
// ═══ AFTER ═══
//
// Three calls, each correct first time, and the report leads with the change:
//
//     "Last recorded period: 0% from 2 answers. … the rise to 50% is recorded as unexplained
//      rather than attributed to a change."

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

const runtime = readFileSync(new URL("../src/runtime.ts", import.meta.url), "utf8");
/** Comments argue for rules and are not evidence of them — this file's own prose quotes the curl. */
const code = runtime.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

test("every address the sandbox is given also has its shape shown", () => {
  /**
   * The property, stated as the general rule rather than as "records has an example". An address
   * with no contract is one the run has to guess, and guessing costs a handful of calls when it
   * works and the whole feature when it does not.
   *
   * Counted as: each `MYCEL_*_URL` assigned into the sandbox env must appear again somewhere in the
   * prompt text. Two mentions means "set, and demonstrated"; one means "set, and left to luck".
   */
  const assigned = [...code.matchAll(/env\.(MYCEL_\w+_URL)\s*=/g)].map((m) => m[1]);
  assert.ok(assigned.length >= 5, `only ${assigned.length} sandbox addresses found — this guard is measuring nothing`);

  /**
   * ═══ UNLESS A SCRIPT CALLS IT FOR THE AGENT ═══
   *
   * `MYCEL_IMAGE_URL` and `MYCEL_BUILD_URL` are handed to the sandbox and never appear in the prompt,
   * and that is CORRECT: `imagetool.ts` and `remotebuild.ts` generate the shell that uses them, so
   * the agent runs a command rather than composing a request. It has no contract to guess.
   *
   * The guard's first version flagged both, which would have meant either two pointless prompt
   * sections or an exemption list. Keying on "does some other module write a script that uses this"
   * is the real distinction and needs no maintenance: wrap an address in a script and it drops out,
   * hand it to the agent raw and it must be documented.
   */
  const wrappers = readdirSync(new URL("../src/", import.meta.url))
    .filter((f) => f.endsWith(".ts") && f !== "runtime.ts")
    .map((f) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8"))
    .join("\n");

  const undocumented = assigned.filter((name) => {
    const shownToAgent = code.includes(`$${name}`); // `$MYCEL_X_URL` only appears in prompt text
    const wrappedInAScript = wrappers.includes(`$${name}`) || wrappers.includes(`\${${name}`);
    return !shownToAgent && !wrappedInAScript;
  });
  assert.deepEqual(
    undocumented,
    [],
    `these addresses are handed to the run with no worked example, so it must guess the contract:\n  ${undocumented.join("\n  ")}`,
  );
});

test("the run is told to read the last period before it writes this one", () => {
  /*
    Order matters and is the difference between a series that is written and one that is used. A run
    that writes without reading produces exactly the failure this was found by: the numbers
    accumulate and nothing ever looks at them.
  */
  const q = code.indexOf("$MYCEL_RECORDS_URL/query");
  const u = code.indexOf("$MYCEL_RECORDS_URL/upsert");
  assert.ok(q > 0, "the run is no longer shown how to look up the previous period");
  assert.ok(u > 0, "the run is no longer shown how to record this period");
  assert.ok(q < u, "write is shown before read — a run that writes without reading never closes the loop");
});

test("the record key carries the period, or there is no series", () => {
  /**
   * `queryRecords` is `SELECT DISTINCT ON (key) … ORDER BY observed_at DESC` — ONE row per key. So a
   * key of just the subject is one row forever: each period overwrites the last and there is a
   * latest value but no history.
   *
   * The first version of this prompt said exactly that, and a live run obeyed it and overwrote week
   * one with week two. `<subject>:<period>` gives both properties: re-running a period replaces that
   * period rather than duplicating it, and periods accumulate.
   */
  const example = code.slice(code.indexOf("$MYCEL_RECORDS_URL/upsert"));
  assert.match(
    example,
    /"key":"[^"]*:[^"]*"/,
    "the upsert example keys on the subject alone — every period will overwrite the last",
  );
  assert.match(example, /observed_at/, "observed_at is not set, so the lookup cannot order the series");
});

test("an empty lookup is said plainly rather than implied away", () => {
  /*
    The first period is a real state and a common one. A run that quietly omits the comparison reads
    as a run that found nothing worth reporting; one that says "this is the first period" is honest
    and sets the expectation for next time.
  */
  assert.match(
    code,
    /first period — say so plainly rather than/,
    "the first-period case is no longer handled, so an empty lookup will read as a missing comparison",
  );
});
