// NOTHING IS NOT AN ALLOWED ENDING.
//
// openwork's admission rule: every accepted request must end in a NAMED terminal state, and plain
// idle with no result must never silently clear the task. Our plain idle is a run that reaches
// `succeeded` and leaves nothing anybody can point at — 2,065 of 6,559 over fourteen days — and
// `RunOutcome` returns null for `succeeded`, so those render as nothing. A run that did everything
// right and a run that did nothing look identical.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ENDING_SAID, endedQuietly, runEnding, type RunEnding } from "../src/run-ending";

test("run ending: a succeeded run that left nothing is NAMED, not silent", () => {
  assert.equal(runEnding({ status: "succeeded" }), "nothing_visible");
  assert.equal(endedQuietly("nothing_visible"), true);
  // The whole point: it has a sentence. Silence is what this replaces.
  assert.ok(ENDING_SAID.nothing_visible.trim().length > 10);
});

test("run ending: the sentence is not an alarm, because most of them are correct", () => {
  // 1,848 of the 2,065 are `begin_fulfillment` opening an engagement, which is a real outcome that
  // is not a file. A sentence implying a fault would train a founder to distrust the ones that are.
  const said = ENDING_SAID.nothing_visible.toLowerCase();
  for (const alarm of ["error", "fail", "wrong", "problem", "broken", "sorry"]) {
    assert.ok(!said.includes(alarm), `"${alarm}" makes a correct ending read as a defect`);
  }
});

test("run ending: strongest wins, because that is what a founder would say it did", () => {
  // A run that submitted a version and also wrote a record "produced the report". Saying it "wrote a
  // record" would be true and useless.
  assert.equal(runEnding({ status: "succeeded", versions: 1, records: 3, artifacts: 2 }), "delivered");
  assert.equal(runEnding({ status: "succeeded", artifacts: 2, records: 3 }), "filed");
  assert.equal(runEnding({ status: "succeeded", requests: 1, records: 9 }), "asked");
  assert.equal(runEnding({ status: "succeeded", waits: 1, records: 9 }), "parked");
  assert.equal(runEnding({ status: "succeeded", actions: 1, records: 9 }), "acted");
  assert.equal(runEnding({ status: "succeeded", records: 1 }), "recorded");
});

test("run ending: a run that did not succeed is not this function's question", () => {
  // A failed run already has a named outcome and a card that owns it. Re-deriving one here would be
  // a second opinion on a settled question.
  for (const status of ["failed", "cancelled", "expired", "running", "queued"]) {
    assert.equal(runEnding({ status, artifacts: 5, versions: 2 }), "failed", `${status} was reclassified`);
  }
});

test("run ending: a store that cannot answer can only move the ending toward silence", () => {
  // Every count in `runTracesFor` is independently fail-soft, and a failed read contributes zero.
  // Zero can only walk DOWN the order — never invent a stronger ending than the run earned.
  const blind = runEnding({ status: "succeeded", artifacts: undefined, versions: undefined });
  assert.equal(blind, "nothing_visible");
  // And nonsense counts do not promote it either.
  assert.equal(runEnding({ status: "succeeded", artifacts: Number.NaN, records: -3 }), "nothing_visible");
});

test("run ending: every ending has a sentence, and the compiler asks when one is added", () => {
  const all: RunEnding[] = ["delivered", "filed", "asked", "parked", "acted", "recorded", "nothing_visible", "failed"];
  for (const e of all) assert.ok(ENDING_SAID[e], `${e} has no sentence`);
  assert.equal(Object.keys(ENDING_SAID).length, all.length, "the map and the union have drifted apart");
});

test("run ending: the route returns it, so no surface has to re-derive silence", () => {
  // A CALL-SITE TEST. The classifier is the easy half; the half this repo keeps losing is something
  // actually calling it. And `quiet` is derived once here rather than by each surface comparing
  // against a string — two places that decide what counts as silence is two places to disagree.
  const src = readFileSync(fileURLToPath(new URL("../src/server.ts", import.meta.url)), "utf8");
  assert.match(src, /const ending = runEnding\(traces\)/);
  assert.match(src, /ending_said: ENDING_SAID\[ending\], quiet: endedQuietly\(ending\)/);
  assert.match(src, /const traces = await runTracesFor\(store, t\)/);
});

test("run ending: `delivered` is honestly unreachable, and the code says so", () => {
  // There is no `deliverable.submitted` event, so this route cannot tell a delivering run from any
  // other file-writing one. Widening `filed` to cover both would be the tempting fix and would lose
  // the distinction that matters — one of them means the client has something to open. The gap is
  // named in the source instead, so somebody adds the event rather than blurring the ending.
  const src = readFileSync(fileURLToPath(new URL("../src/server.ts", import.meta.url)), "utf8");
  assert.match(src, /THERE IS NO `deliverable\.submitted` EVENT/);
  assert.ok(
    !/versions: kinds\.has\(/.test(src),
    "the route is inferring a submitted version from an event that does not mean that",
  );
});

test("run ending: the run's own stdout dump is not a file anybody opens", () => {
  // `result.txt` is 5,455 of the 7,565 artifacts in production — the harness's raw transcript,
  // written on almost every run that has ever executed. Counting it makes "wrote files you can open"
  // true of everything, which turns the one ending that matters into one that never fires.
  const src = readFileSync(fileURLToPath(new URL("../src/server.ts", import.meta.url)), "utf8");
  assert.match(src, /x\.name !== "result\.txt"/);
  // And the classifier still calls a run with nothing else silent.
  assert.equal(runEnding({ status: "succeeded", artifacts: 0 }), "nothing_visible");
});

test("run ending: an artifact with no bytes is not a file, and one stored in S3 is", () => {
  // `size_bytes > 0` with an empty `content` column is the DESIGN, not a defect — the bytes are in
  // S3 and the size is recorded precisely so a reader can tell "empty" from "stored elsewhere". A
  // rule that keyed on the column would call every externally-stored deliverable nothing.
  const src = readFileSync(fileURLToPath(new URL("../src/server.ts", import.meta.url)), "utf8");
  assert.match(src, /x\.name !== "result\.txt" && \(x\.size_bytes \?\? 0\) > 0/);
  assert.ok(!/octet_length|length\(content\)/.test(src), "the count is reading the content column");
});
