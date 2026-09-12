// The claim the company rests on, as arithmetic.
import { test } from "node:test";
import assert from "node:assert/strict";
import { clientSendBacks, correctionPairs, editDistance, learningCurve, learningVerdict, untouchedDrafts } from "../src/learning";
import type { DeliverableVersion } from "../src/contract";

const v = (o: Partial<DeliverableVersion> & { version: number }): DeliverableVersion =>
  ({
    id: `v${o.version}`,
    project_id: "p1",
    deliverable_id: "d1",
    summary: "",
    artifact_ids: [],
    created_at: `2026-01-0${o.version}T00:00:00.000Z`,
    ...o,
  }) as DeliverableVersion;

const text = (x: DeliverableVersion) => x.summary;

test("an untouched draft scores zero, a full rewrite scores one", () => {
  assert.equal(editDistance("the books are closed", "the books are closed"), 0);
  assert.equal(editDistance("alpha beta", "gamma delta"), 1);
});

test("distance is by WORD, so a one-word fix in a long draft is small", () => {
  const before = Array.from({ length: 100 }, (_, i) => `word${i}`).join(" ");
  const after = before.replace("word50", "corrected");
  assert.ok(editDistance(before, after) < 0.02, "one word in a hundred should barely register");
});

test("two empty versions are identical, not a rewrite", () => {
  // 0/0. The guard exists because "nothing changed" and "everything changed" are opposite answers.
  assert.equal(editDistance("", ""), 0);
  assert.equal(editDistance("something", ""), 1);
});

test("a pair is an agent draft immediately followed by a founder edit", () => {
  const pairs = correctionPairs(
    [v({ version: 1, author: "agent", summary: "a b c" }), v({ version: 2, author: "founder", summary: "a b d" })],
    text,
  );
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0]!.from_version, 1);
  assert.ok(pairs[0]!.distance > 0);
});

test("agent → agent → founder pairs the founder with the SECOND draft", () => {
  // Pairing with the first would score the machine's own revision as human effort.
  const pairs = correctionPairs(
    [
      v({ version: 1, author: "agent", summary: "first" }),
      v({ version: 2, author: "agent", summary: "second" }),
      v({ version: 3, author: "founder", summary: "second!" }),
    ],
    text,
  );
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0]!.from_version, 2);
});

test("a founder version with no agent draft before it is not a correction", () => {
  const pairs = correctionPairs([v({ version: 1, author: "founder", summary: "written by hand" })], text);
  assert.deepEqual(pairs, []);
});

test("a missing author means the agent, per the field's own contract", () => {
  const pairs = correctionPairs(
    [v({ version: 1, summary: "a b" }), v({ version: 2, author: "founder", summary: "a c" })],
    text,
  );
  assert.equal(pairs.length, 1, "absent author must not be read as founder — it would invent corrections");
});

test("the curve falls when the drafts get better", () => {
  const week = (n: number, d: number): DeliverableVersion[] => [
    v({ version: n * 2 - 1, author: "agent", summary: "a b c d", created_at: new Date(Date.UTC(2026, 0, 1 + n * 7)).toISOString() }),
    v({
      version: n * 2,
      author: "founder",
      summary: d > 0.5 ? "w x y z" : "a b c z",
      created_at: new Date(Date.UTC(2026, 0, 1 + n * 7)).toISOString(),
    }),
  ];
  const pairs = correctionPairs([...week(1, 0.9), ...week(2, 0.9), ...week(3, 0.1), ...week(4, 0.1)], text);
  const curve = learningCurve(pairs);
  assert.ok(curve.length >= 2);
  assert.ok(curve[curve.length - 1]!.mean < curve[0]!.mean, "later weeks should need less editing");
});

test("thin evidence says WE CANNOT SAY YET, never 'improving: false'", () => {
  // The one unacceptable screen is progress reported on four data points.
  const verdict = learningVerdict([
    { at: "2026-01-01", corrections: 1, untouched: 0, mean: 0.4 },
    { at: "2026-01-08", corrections: 1, untouched: 0, mean: 0.3 },
  ]);
  assert.equal(verdict.improving, undefined, "must not claim a direction on two corrections");
  assert.match(verdict.note, /Not enough approved work/);
});

test("with enough evidence it says which way it is going, in a sentence a founder can read", () => {
  const up = learningVerdict([
    { at: "2026-01-01", corrections: 5, untouched: 0, mean: 0.60 },
    { at: "2026-01-08", corrections: 5, untouched: 0, mean: 0.20 },
  ]);
  assert.equal(up.improving, true);
  assert.match(up.note, /40% less editing/);
  for (const word of ["wedge", "kernel", "harness", "distance"]) {
    assert.ok(!up.note.toLowerCase().includes(word), `founder-facing note leaks "${word}"`);
  }

  const down = learningVerdict([
    { at: "2026-01-01", corrections: 5, untouched: 0, mean: 0.2 },
    { at: "2026-01-08", corrections: 5, untouched: 0, mean: 0.5 },
  ]);
  assert.equal(down.improving, false);
  assert.match(down.note, /not needing less editing yet/);
});

// ── the zeroes ─────────────────────────────────────────────────────────────────────────────────

test("an untouched draft is a ZERO in the curve, not an absence", () => {
  // The bug this closes: a founder version only exists if they EDITED, so a curve built from
  // corrections alone measures "how hard were the drafts I had to fix" and is blind to the ones
  // that needed nothing. As the product works, edits get RARER — so the old shape showed a flat
  // line on the best month a customer ever had.
  const pairs = [
    { deliverable_id: "d1", at: "2026-01-01T00:00:00.000Z", from_version: 1, to_version: 2, before: "a", after: "b", distance: 1 },
  ];
  const curve = learningCurve(pairs, [{ at: "2026-01-02T00:00:00.000Z" }, { at: "2026-01-03T00:00:00.000Z" }]);
  assert.equal(curve.length, 1);
  assert.equal(curve[0]!.corrections, 1);
  assert.equal(curve[0]!.untouched, 2);
  // One rewrite and two perfect drafts is a third of a draft rewritten on average, not a whole one.
  assert.ok(Math.abs(curve[0]!.mean - 1 / 3) < 0.001, `mean was ${curve[0]!.mean}`);
});

test("a month of untouched drafts is evidence, not 'not enough data'", () => {
  const curve = learningCurve([], Array.from({ length: 10 }, (_, i) => ({ at: `2026-0${i < 5 ? 1 : 2}-0${(i % 5) + 1}T00:00:00.000Z` })));
  const v = learningVerdict(curve);
  assert.equal(v.corrections, 10, "untouched drafts must count toward the evidence bar");
  assert.notEqual(v.improving, undefined, "ten clean drafts across two months is a direction, not a shrug");
});

test("untouchedDrafts only counts drafts that were actually settled", () => {
  // A draft sitting unread in the queue has not been approved of — scoring it as "perfect first
  // time" would make an abandoned queue read as a triumph.
  const rows = [
    v({ version: 1, author: "agent", summary: "shipped" }),
    v({ version: 2, author: "agent", summary: "still waiting" }),
  ] as (DeliverableVersion & { accepted_at?: string })[];
  rows[0]!.accepted_at = "2026-01-05T00:00:00.000Z";
  assert.deepEqual(untouchedDrafts(rows), [{ at: "2026-01-05T00:00:00.000Z" }]);
});

test("a draft the founder edited is not also counted as untouched", () => {
  const rows = [
    v({ version: 1, author: "agent", summary: "draft" }),
    v({ version: 2, author: "founder", summary: "fixed" }),
  ] as (DeliverableVersion & { accepted_at?: string })[];
  rows[0]!.accepted_at = "2026-01-05T00:00:00.000Z";
  assert.deepEqual(untouchedDrafts(rows), [], "that is a correction, and counting it twice inflates both halves");
});

// ── zero is the best outcome, and the verdict called it a failure ────────────────────────────────

test("learning: a business whose drafts never needed editing is not told it has made no progress", () => {
  // THE BUG, LIVE ON THE DEMO EMBEDDED IN THE LANDING PAGE. `improving = last < first` is right for
  // every case except the one the product is aiming at: with nothing ever rewritten both ends are 0,
  // `last < first` is false, and a Product Hunt visitor read two adjacent contradicting sentences —
  // "3 weeks where nothing needed changing" over "Drafts are not needing less editing yet — 0% more
  // than when you started."
  const flat = Array.from({ length: 4 }, (_, i) => ({ at: `w${i}`, mean: 0, corrections: 0, untouched: 3 }));
  const v = learningVerdict(flat as never);
  assert.equal(v.improving, true, "a perfect record was reported as not improving");
  assert.match(v.note, /Nothing has needed editing yet/);
  // "0% more" is a subtraction that came out zero being read aloud.
  assert.ok(!/0% more/.test(v.note));
});

test("learning: improving all the way to zero says so, and keeps the starting figure", () => {
  const curve = [
    { at: "w0", mean: 0.4, corrections: 6, untouched: 0 },
    { at: "w1", mean: 0.2, corrections: 4, untouched: 1 },
    { at: "w2", mean: 0, corrections: 0, untouched: 5 },
  ];
  const v = learningVerdict(curve as never);
  assert.equal(v.improving, true);
  assert.match(v.note, /no editing at all now/);
  assert.match(v.note, /40%/, "the starting point is the evidence that it moved");
});

test("learning: flat and non-zero reads as flat, not as '0% more'", () => {
  const curve = [
    { at: "w0", mean: 0.3, corrections: 5, untouched: 0 },
    { at: "w1", mean: 0.3, corrections: 5, untouched: 0 },
    { at: "w2", mean: 0.3, corrections: 5, untouched: 0 },
  ];
  const v = learningVerdict(curve as never);
  assert.equal(v.improving, false);
  assert.match(v.note, /about as much editing as when you started/);
  assert.match(v.note, /30% of each one/);
  assert.ok(!/0%/.test(v.note.replace("30%", "")), "it still reports a zero delta as a quantity");
});

test("learning: a genuine regression is still called one", () => {
  // The fix must not swallow the case the sentence was written for.
  const curve = [
    { at: "w0", mean: 0.1, corrections: 4, untouched: 0 },
    { at: "w1", mean: 0.35, corrections: 6, untouched: 0 },
  ];
  const v = learningVerdict(curve as never);
  assert.equal(v.improving, false);
  assert.match(v.note, /not needing less editing yet/);
  assert.match(v.note, /25% more/);
});

// ── A DELIVERABLE THE CLIENT REJECTED USED TO IMPROVE THE CURVE ─────────────────────────────────
//
// `untouchedDrafts` treated "the next version is another agent draft" as "the founder did not have
// to rewrite it". The commonest reason a second agent draft exists is that the CLIENT asked for
// changes — so the sequence
//
//     v1 agent → released → client asks for changes → v2 agent → founder approves untouched
//
// scored TWO clean drafts and pulled the mean toward zero, which reads as improving. The one number
// the product rests on got better when a client was unhappy. `change_requested_at` was on the row
// the whole time and nothing read it.

const agent = (
  deliverable_id: string,
  version: number,
  summary: string,
  extra: Record<string, unknown> = {},
) =>
  ({ id: `${deliverable_id}-${version}`, project_id: "p", deliverable_id, version, summary,
     artifact_ids: [], author: "agent", ...extra }) as never;

test("a draft the client sent back is not counted as untouched", () => {
  const versions = [
    agent("d1", 1, "the first draft", {
      released_at: "2026-01-01T00:00:00.000Z",
      change_requested_at: "2026-01-02T00:00:00.000Z",
      change_request: "the totals are wrong",
    }),
    agent("d1", 2, "the corrected draft", { accepted_at: "2026-01-03T00:00:00.000Z" }),
  ];
  const untouched = untouchedDrafts(versions);
  assert.equal(untouched.length, 1, "only the accepted redraft is clean — the rejected one is not");
});

test("the client's send-back is counted as a correction, with the redraft as its distance", () => {
  const versions = [
    agent("d1", 1, "alpha beta gamma delta", {
      released_at: "2026-01-01T00:00:00.000Z",
      change_requested_at: "2026-01-02T00:00:00.000Z",
    }),
    agent("d1", 2, "alpha beta gamma epsilon", { accepted_at: "2026-01-03T00:00:00.000Z" }),
  ];
  const backs = clientSendBacks(versions, (v) => v.summary ?? "");
  assert.equal(backs.length, 1);
  assert.equal(backs[0]!.from_version, 1);
  assert.equal(backs[0]!.to_version, 2);
  assert.ok(backs[0]!.distance > 0, "one word in four changed; that is not zero");
  assert.equal(backs[0]!.at, "2026-01-02T00:00:00.000Z", "dated when the client asked");
});

test("a rejection makes the curve worse, not better", () => {
  const rejected = [
    agent("d1", 1, "alpha beta gamma delta", {
      released_at: "2026-01-01T00:00:00.000Z",
      change_requested_at: "2026-01-01T00:00:00.000Z",
    }),
    agent("d1", 2, "wholly different words entirely", { accepted_at: "2026-01-01T00:00:00.000Z" }),
  ];
  const text = (v: { summary?: string }) => v.summary ?? "";
  const withFix = learningCurve(
    [...correctionPairs(rejected, text), ...clientSendBacks(rejected, text)],
    untouchedDrafts(rejected),
  );
  // Before the fix both versions were untouched zeroes, so the mean was 0 — a perfect week.
  assert.ok(withFix[0]!.mean > 0, "a rejected deliverable must not read as a perfect week");
  assert.equal(withFix[0]!.corrections, 1);
});

test("an open send-back with no redraft yet is not scored at all", () => {
  // The redraft has not happened. Guessing a number for work not done is the failure this avoids.
  const versions = [
    agent("d1", 1, "the draft", {
      released_at: "2026-01-01T00:00:00.000Z",
      change_requested_at: "2026-01-02T00:00:00.000Z",
    }),
  ];
  assert.equal(clientSendBacks(versions, (v) => v.summary ?? "").length, 0);
  assert.equal(untouchedDrafts(versions).length, 0, "and it is certainly not clean");
});

test("a founder edit after a client send-back is charged once, not twice", () => {
  const versions = [
    agent("d1", 1, "alpha beta", {
      released_at: "2026-01-01T00:00:00.000Z",
      change_requested_at: "2026-01-02T00:00:00.000Z",
    }),
    { ...agent("d1", 2, "gamma delta"), author: "founder", created_at: "2026-01-03T00:00:00.000Z" } as never,
  ];
  const text = (v: { summary?: string }) => v.summary ?? "";
  assert.equal(correctionPairs(versions, text).length, 1, "the founder edit is a correction");
  assert.equal(clientSendBacks(versions, text).length, 0, "and must not be counted a second time");
});
