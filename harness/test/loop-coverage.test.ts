// Can this business actually run, end to end?
//
// A service business is a loop — find clients, convert them, do the work, get paid, keep them — and
// nothing modelled it. Every piece of machinery serves one stage, and the stages were only ever
// visible one wedge at a time, so "is this business's loop closed" had no answer.
//
// That is the question at onboarding, where a founder describes a business and the system
// instantiates what it thinks they need.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { explain, loopCoverage, LOOP_STAGES } from "../src/loop-coverage";
import { loadWedge, wedgesDir } from "../src/wedge";
import type { WedgeManifest } from "../src/wedge";

const installed = (...slugs: string[]): WedgeManifest[] =>
  slugs.map((s) => loadWedge(s)).filter((w): w is NonNullable<typeof w> => !!w).map((w) => w.manifest);

test("a composed business closes the loop; a single trade does not", () => {
  /**
   * THE THESIS, ASSERTED.
   *
   * A bookkeeping practice sells bookkeeping, chases its own unpaid invoices, and has to find the
   * next client. Only the first is what they say when asked what they do — and asking whether
   * `books-keeper` closes the loop is asking the wrong question about the wrong unit.
   */
  const solo = loopCoverage(installed("books-keeper"));
  assert.equal(solo.closed, false);
  assert.deepEqual(solo.installable_gaps.sort(), ["collect", "convert", "find"]);
  assert.equal(solo.needs_a_trade, false, "books-keeper IS the trade — it delivers");

  const composed = loopCoverage(installed("books-keeper", "gtm-operator", "invoice-chaser"));
  assert.equal(composed.closed, true);
  assert.deepEqual(composed.installable_gaps, []);
});

test("the deliverable signal is read the way the wrapper reads it, not half of it", () => {
  /**
   * This checked `deliverable_kind` on the task type only, and reported that books-keeper delivers
   * nothing — a wedge whose whole purpose is a monthly close. Eight of thirteen wedges declare it on
   * no task at all, and they are not broken: `deliverables.wrap.ts` falls back to
   * `fulfillment.deliverable_shapes` at the WEDGE level.
   *
   * A report that disagrees with the machinery about what gets delivered is worse than no report.
   */
  const books = loopCoverage(installed("books-keeper"));
  const deliver = books.stages.find((s) => s.stage === "deliver")!;
  assert.equal(deliver.covered, true);
  assert.ok(deliver.by.some((b) => b.includes("monthly_close")), deliver.by.join("; "));
});

test("an inbound client task is not evidence that the business delivers", () => {
  // `deliverable_verdict` is the CLIENT answering us about work already handed over. Listing it as
  // evidence that a bookkeeper delivers would offer, as proof of the work, the task where their
  // client replies about it.
  const books = loopCoverage(installed("books-keeper"));
  const deliver = books.stages.find((s) => s.stage === "deliver")!;
  assert.ok(!deliver.by.some((b) => b.includes("deliverable_verdict")), deliver.by.join("; "));
  // Same for the operational ones — chases and nudges are mail the founder already sent.
  assert.ok(!deliver.by.some((b) => /chase_|nudge_|check_in/.test(b)), deliver.by.join("; "));
});

test("a gap that needs a trade is told apart from one a stock service closes", () => {
  // Different amounts of work, and a founder should not have to guess which. Everything except the
  // trade is the same job for a bookkeeper and a video editor.
  const noTrade = loopCoverage(installed("gtm-operator", "invoice-chaser"));
  assert.equal(noTrade.needs_a_trade, true);
  assert.ok(!noTrade.installable_gaps.includes("deliver" as never));

  const lines = explain(noTrade);
  const deliverLine = lines.find((l) => l.startsWith("Do the work"))!;
  assert.match(deliverLine, /written for this specific business/);
  assert.ok(!deliverLine.includes("without writing anything new"), "the trade is not a click");
});

test("the explanation leads with what works", () => {
  /**
   * A founder reading a generated business for the first time is deciding whether to trust it, and a
   * list that opens with four gaps reads as a failure even when four of five stages are covered —
   * which is a better position than most businesses are in on day one.
   */
  const r = loopCoverage(installed("books-keeper"));
  assert.match(explain(r)[0]!, /^End to end, this can /);
});

test("every wedge on disk is describable — no stage crashes on a real manifest", () => {
  // The report is rendered at onboarding, on whatever the meta-agent just wrote. A field shape it
  // has not seen must produce a gap, never an exception on the founder's first screen.
  const all = readdirSync(wedgesDir())
    .filter((d) => {
      try {
        return statSync(join(wedgesDir(), d)).isDirectory();
      } catch {
        return false;
      }
    })
    .map((d) => loadWedge(d))
    .filter((w): w is NonNullable<typeof w> => !!w)
    .map((w) => w.manifest);
  assert.ok(all.length > 5, "not enough wedges on disk for this to prove anything");

  const r = loopCoverage(all);
  assert.equal(r.stages.length, LOOP_STAGES.length);
  assert.equal(r.closed, true, "everything installed together must close the loop");
  // And an empty install is a report of five gaps, not a crash.
  const none = loopCoverage([]);
  assert.equal(none.closed, false);
  assert.equal(none.stages.filter((s) => s.covered).length, 0);
  assert.equal(explain(none).length, LOOP_STAGES.length);
});
