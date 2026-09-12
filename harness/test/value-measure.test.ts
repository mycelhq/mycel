// What did this actually save them?
//
// The question this product has never answered, and the reason "does it work" has stayed an
// opinion. Cognition published a working system for the same problem (June 2026), validated
// against 258 sessions from 126 users across eight enterprise deployments. These tests pin the
// choices that make the number survive contact with somebody who checks it.

import { test } from "node:test";
import assert from "node:assert/strict";

import { compareWindows, isProductive, measureValue, REPORTABLE_FLOOR, type WorkItem } from "../src/value-measure";

const delivered = (n: number, hours = 2): WorkItem[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `d${i}`,
    kind: "monthly_close",
    releasedAt: "2026-09-01T10:00:00Z",
    humanHours: hours,
  }));

test("work that never reached a client saved nobody anything", () => {
  // Cognition: "if all PRs created by a session were closed, it likely wasn't valuable." Our filter
  // is stronger because it involves the customer — a merged PR is one engineer approving; a
  // released deliverable is a founder choosing to send it.
  assert.equal(isProductive({ id: "a", kind: "k", releasedAt: "2026-09-01T00:00:00Z" }), true);
  assert.equal(isProductive({ id: "b", kind: "k", acceptedAt: "2026-09-01T00:00:00Z" }), true);
  assert.equal(isProductive({ id: "c", kind: "k" }), false, "produced and never sent");
});

test("rejection beats release — a deliverable that came back is a spent hour, not a saved one", () => {
  assert.equal(
    isProductive({
      id: "d",
      kind: "k",
      releasedAt: "2026-09-01T00:00:00Z",
      rejectedAt: "2026-09-02T00:00:00Z",
    }),
    false,
  );
});

test("below the floor it reports nothing rather than a confident wrong number", () => {
  // "Individual estimates are noisy but approximately unbiased; aggregated, errors cancel." A total
  // from four data points teaches a founder to distrust the fifth.
  const r = measureValue(delivered(REPORTABLE_FLOOR - 1));
  assert.equal(r.reportable, false);
  assert.equal(r.hours, 0, "a total leaked out below the floor");
  assert.match(r.summary, /noise wearing a number/);
});

test("hours with no estimate are counted as missing, never guessed", () => {
  // A number this module invented would be the fabrication the whole design exists to avoid.
  const items = [...delivered(20), ...delivered(5).map((d) => ({ ...d, id: `x${d.id}`, humanHours: null }))];
  const r = measureValue(items);
  assert.equal(r.productive, 25);
  assert.equal(r.unestimated, 5);
  assert.equal(r.hours, 40, "unestimated work inflated the total");
  assert.match(r.summary, /NOT counted/);
});

test("every rounding goes down", () => {
  // "The system is calibrated to underestimate rather than overestimate." A founder who finds one
  // inflated number stops believing the dashboard; a diligence figure that fails an auditor is
  // worse than no figure.
  const r = measureValue(delivered(20, 1.99), { hourlyRate: 100 });
  assert.equal(r.hours, 39.8, "hours rounded up");
  assert.equal(r.money!.amount, 3980);
  const odd = measureValue(delivered(20, 1.999), { hourlyRate: 33.33 });
  assert.ok(odd.money!.amount <= odd.hours * 33.33, "money rounded up");
});

test("money only appears when the founder supplied their own rate", () => {
  // A service business already bills by the hour and defends that rate to clients. An imputed one
  // would be our number in their mouth.
  assert.equal(measureValue(delivered(20)).money, undefined);
  assert.equal(measureValue(delivered(20), { hourlyRate: 0 }).money, undefined);
  assert.equal(measureValue(delivered(20), { hourlyRate: 150, currency: "GBP" })!.money!.currency, "GBP");
});

test("it says what it does not measure", () => {
  // Cognition state both plainly and both carry over: "Hours are not business value" and "hours
  // don't account for quality".
  const r = measureValue(delivered(20));
  assert.match(r.summary, /capacity returned, not profit/);
  assert.match(r.summary, /does not say whether the hours were spent on the right work/);
});

test("a before-and-after refuses a thin window", () => {
  const thin = measureValue(delivered(3));
  const fat = measureValue(delivered(40));
  const c = compareWindows(thin, fat);
  assert.equal(c.comparable, false);
  assert.match(c.summary, /easiest number in this product to be wrong about/);
});

test("improvement is stated in hours, never as a percentage off a small base", () => {
  // The standard way to make a modest change look transformational — and this number exists to be
  // shown to somebody who will check it.
  const before = measureValue(delivered(20, 2));
  const after = measureValue(delivered(40, 2));
  const c = compareWindows(before, after);
  assert.equal(c.comparable, true);
  assert.equal(c.deltaHours, 40);
  assert.ok(!/%/.test(c.summary), "a percentage crept into the comparison");
  assert.match(c.summary, /Measured the same way in both windows/);
});
