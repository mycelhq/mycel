import { test } from "node:test";
import assert from "node:assert/strict";
import { learningVerdict, MIN_CORRECTIONS, type CurvePoint } from "../src/learning";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * "NOT YET" AND "NOT YET, AND HERE IS HOW CLOSE" ARE DIFFERENT SENTENCES
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Home had two states: a verdict, or "Nothing measured yet". A business with three corrections
 * banked and one that had never approved anything saw the SAME SCREEN — so the one actually making
 * progress was told it had made none, in week one, about the claim it had just paid for.
 *
 * The verdict now carries its own distance. Computed here rather than in the console because the
 * bar is TWO conditions, and a second copy of them next to the company's central number is a second
 * place for it to drift.
 */
const week = (at: string, mean: number, corrections: number): CurvePoint => ({
  at,
  mean,
  corrections,
  untouched: 0,
});

test("a thin record says how many more corrections it needs", () => {
  const v = learningVerdict([week("2026-08-24", 0.4, 2), week("2026-08-31", 0.3, 1)]);
  assert.equal(v.improving, undefined, "a direction was reported on three data points");
  assert.equal(v.corrections, 3);
  assert.equal(v.needed, MIN_CORRECTIONS - 3, "the console would have to re-derive the bar");
  assert.equal(v.weeks, 2);
});

test("enough corrections but only one week says WEEK, not corrections", () => {
  /**
   * The guard that matters. Telling somebody with nine corrections in a single week that they need
   * "five more corrections" would be both wrong and unfixable — what they need is for another week
   * to pass, and no amount of work today produces it.
   */
  const v = learningVerdict([week("2026-08-31", 0.35, MIN_CORRECTIONS + 1)]);
  assert.equal(v.improving, undefined);
  assert.equal(v.needed, 0, "it is asking for corrections it does not need");
  assert.equal(v.weeks, 1, "the console cannot tell it is the week that is missing");
});

test("a real verdict carries no distance, because there is none left", () => {
  const v = learningVerdict([week("2026-08-24", 0.6, 5), week("2026-08-31", 0.2, 5)]);
  assert.equal(v.improving, true);
  assert.equal(v.needed, undefined, "a settled verdict still advertises a bar");
  assert.equal(v.weeks, undefined);
  assert.match(v.note, /less editing/);
});

test("untouched drafts count toward the bar — a quiet month is the strongest evidence", () => {
  // `learningVerdict` sums corrections AND untouched, on the reasoning that a month of drafts
  // shipped unedited would otherwise read as "not enough data" when it is the best possible data.
  const clean: CurvePoint[] = [
    { at: "2026-08-24", mean: 0.3, corrections: 2, untouched: 3 },
    { at: "2026-08-31", mean: 0, corrections: 0, untouched: 4 },
  ];
  const v = learningVerdict(clean);
  assert.equal(v.corrections, 9, "untouched drafts stopped counting toward the evidence bar");
  assert.equal(v.improving, true);
});
