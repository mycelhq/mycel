/**
 * THE SENTENCE A CLIENT READS MUST BE A SENTENCE.
 *
 * Two versions in production have a JSON blob where their summary should be:
 *
 *   {"query":"AI that runs the back office for a small agency","surface":"unavailable","cited":[],…}
 *   {"role":"Northwing","candidates":[],"summary":"No candidates were sourced. The case does not …"}
 *
 * The second is the instructive one. It contains a perfectly good written sentence, under a
 * `summary` key, and the whole envelope was stored instead of it. A run that produces structured
 * output and hands the envelope over verbatim gets its envelope shown to the customer.
 *
 * `String(b.summary ?? "")` accepted it without comment, because by then it IS a string — the agent
 * had already stringified it. So the check cannot be a type check. It has to look at the shape.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { humanSummary } from "../src/deliverables.routes.ts";

test("prose passes through untouched", () => {
  assert.equal(humanSummary("Eleven enquiries against two. One form field is costing submissions."),
    "Eleven enquiries against two. One form field is costing submissions.");
  assert.equal(humanSummary("  trimmed  "), "trimmed");
});

test("the written sentence is pulled out of the envelope", () => {
  // The real production row. There WAS a summary; it was buried one level down.
  const real = '{"role":"Northwing","candidates":[],"summary":"No candidates were sourced. The case does not contain a role brief."}';
  assert.equal(humanSummary(real), "No candidates were sourced. The case does not contain a role brief.");
});

test("an envelope with no sentence in it yields nothing, not the envelope", () => {
  // The other real row. Returning it would be the bug.
  const real = '{"query":"AI that runs the back office","surface":"unavailable","cited":[],"passages":[],"position":0}';
  assert.equal(humanSummary(real), "");
});

test("an object is unwrapped as readily as a stringified one", () => {
  assert.equal(humanSummary({ note: "Books are closed." }), "Books are closed.");
  assert.equal(humanSummary({ candidates: [], position: 0 }), "");
});

test("a sentence that merely mentions braces is not mistaken for JSON", () => {
  const s = "The template still contains {client_name} in two places.";
  assert.equal(humanSummary(s), s);
});

test("nesting is bounded, so a hostile payload cannot spin", () => {
  let deep: unknown = "found it";
  for (let i = 0; i < 40; i++) deep = { summary: deep };
  assert.doesNotThrow(() => humanSummary(deep));
});

test("both agent submit paths refuse a blob rather than storing it", () => {
  // `humanSummary` turning a blob into "" is only half the fix: storing "" is worse than storing
  // the blob, because the client opens a deliverable with no sentence and nothing says why.
  const src = readFileSync(new URL("../src/deliverables.routes.ts", import.meta.url), "utf8");
  assert.equal(
    (src.match(/const summaryBad = summaryFault\(b\.summary, body\.summary\);/g) ?? []).length,
    2,
    "one of the two version-submit routes no longer checks the summary it was handed",
  );
});

test("readVersionBody actually calls it", () => {
  // Sabotaging the wiring left every other test in this file green, because they all exercise
  // `humanSummary` directly. A helper that is correct and unreferenced is the defect this codebase
  // hits most often, and it just happened inside the test for it.
  const src = readFileSync(new URL("../src/deliverables.routes.ts", import.meta.url), "utf8");
  const fn = src.slice(src.indexOf("function readVersionBody"), src.indexOf("function readVersionBody") + 700);
  assert.match(fn, /summary: humanSummary\(b\.summary\),/,
    "readVersionBody stores the raw summary again — everything else here passes regardless");
});

test("a version with NO summary is still allowed", () => {
  // An artifact with no covering note is a shape this route has always accepted. Making summaries
  // mandatory would be a second, unrelated behaviour change riding along on a bug fix.
  assert.equal(humanSummary(undefined), "");
  assert.equal(humanSummary(""), "");
});
