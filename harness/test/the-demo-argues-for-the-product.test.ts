/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * THE DEMO WAS TELLING PROSPECTS THE PRODUCT DOES NOT WORK
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Home's lead figure is the share of each draft still the founder's, and whether it is falling.
 * Every other number on that strip is status; this one is the company. Run the kernel's own
 * `correctionPairs` → `learningCurve` → `learningVerdict` over the history `seed-history.ts` wrote,
 * as of 12 September, and it said:
 *
 *     "Drafts are not needing less editing yet — 2% more than when you started."
 *
 * Measured, against the live demo tenant's real rows. Not a styling bug and not a copy bug: the
 * fixture's two sent-back deliverables were its NEWEST two, and three clean weeks followed by a week
 * with corrections in it is, arithmetically, a business getting worse. The demo argued against the
 * product, on the product's central claim, to everybody who opened it.
 *
 * ═══ WHY THIS IS A TEST AND NOT A COMMENT IN THE SEEDER ═══
 *
 * Because the direction was EMERGENT. It came out of `i === 0 ? 3 : i === 1 ? 2 : 1` next to
 * `at(2 + i)`, two expressions forty lines apart, neither of which mentions a curve. The only way to
 * observe it was to seed a database and read a percentage off a screen, which is why it went
 * unnoticed, and reordering `FILES` would silently invert it again.
 *
 * So this runs the REAL pipeline over the REAL fixture. `lib/revisions.ts` owns what was sent back
 * and when; this owns the assertion that the result says what the landing page says. A change to
 * either end fails here rather than on a prospect's screen.
 *
 * It deliberately does NOT assert exact percentages. "73% less editing" is an artifact of sentence
 * lengths, and pinning it would make every copy edit to a summary a test failure — a guard nobody
 * can keep. What is asserted is the SHAPE: a verdict exists, it says improving, the latest week is
 * lower than the first, and the figure the masthead shows is small and not zero.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FILES, SUMMARY, REVISIONS, seedVersions } from "../scripts/lib/revisions";
import {
  correctionPairs,
  clientSendBacks,
  untouchedDrafts,
  learningCurve,
  learningVerdict,
  MIN_CORRECTIONS,
} from "../src/learning";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 12, 9, 0, 0);
const at = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString();

/**
 * Exactly the rows `seed-history.ts` inserts, in the shape `learning.ts` reads.
 *
 * The two facts it reproduces rather than imports are the ones the seeder states inline: the
 * deliverable's own date is `at(2 + i)`, and `accepted_at` is `at(1 + i)` for the first seven (the
 * rest are delivered but not yet accepted). Both are asserted against the seeder's source below, so
 * this fixture cannot drift away from the thing it claims to describe.
 */
function seededVersions() {
  const rows: Record<string, unknown>[] = [];
  FILES.forEach((f, i) => {
    const accepted = i < 7;
    for (const v of seedVersions({ index: i, baseDaysAgo: 2 + i, finalSummary: SUMMARY[f.name] ?? f.title })) {
      rows.push({
        deliverable_id: `del_${i}`,
        version: v.version,
        summary: v.summary,
        author: v.author,
        created_at: at(v.daysAgo),
        released_at: at(v.daysAgo),
        accepted_at: v.carriesFile && accepted ? at(1 + i) : undefined,
        change_request: v.changeRequest ?? undefined,
        change_requested_at: v.changeRequestedDaysAgo === null ? undefined : at(v.changeRequestedDaysAgo),
      });
    }
  });
  return rows as Parameters<typeof correctionPairs>[0];
}

const text = (v: { summary?: string }) => v.summary ?? "";

function verdictOfTheDemo() {
  const versions = seededVersions();
  const pairs = [...correctionPairs(versions, text), ...clientSendBacks(versions, text)];
  const curve = learningCurve(pairs, untouchedDrafts(versions));
  return { curve, verdict: learningVerdict(curve), pairs };
}

test("THE DEMO'S LEARNING CURVE SAYS THE PRODUCT WORKS", () => {
  const { verdict, curve } = verdictOfTheDemo();

  assert.ok(
    verdict.corrections >= MIN_CORRECTIONS,
    `the demo banks ${verdict.corrections} drafts, under the ${MIN_CORRECTIONS} needed for any verdict at all — ` +
      `Home would show "Nothing measured yet" to every prospect`,
  );
  assert.ok(curve.length >= 2, "one week of data can never produce a direction");

  assert.equal(
    verdict.improving,
    true,
    `the demo tells a prospect the drafts are NOT improving: "${verdict.note}"`,
  );
  assert.ok(
    typeof verdict.last === "number" && typeof verdict.first === "number",
    "no figure, so the masthead falls back to 'after your first approval' on the demo",
  );
  assert.ok(
    (verdict.last as number) < (verdict.first as number),
    `the latest week (${verdict.last}) is not better than the first (${verdict.first})`,
  );
});

test("the figure the masthead shows is small, and is not zero", () => {
  /**
   * Zero is a legal and correct reading — `learningVerdict` has a branch for it and calls it
   * improving, rightly, because nothing needing changing is the best outcome there is. It is the
   * wrong DEMO. "Still yours: 0%" over a business with a four-figure book invites exactly one
   * thought from a prospect, and it is not "I should buy this".
   *
   * A few per cent is the claim the landing page actually makes and the one a buyer believes.
   */
  const { verdict } = verdictOfTheDemo();
  const shown = Math.round((verdict.last as number) * 100);
  assert.ok(shown > 0, "the demo's latest week is 0% — true, improving, and unbelievable");
  assert.ok(shown <= 15, `the demo still leaves ${shown}% of each draft to the founder`);
});

test("there is a week where nothing needed changing", () => {
  /**
   * `the-number.tsx` renders these specially — the accent colour, a marker dot, and the line "N weeks
   * where nothing needed changing" — and that branch had never been seen on the demo, because the
   * fixture's corrections were spread across the only weeks that had any drafts in them at all.
   *
   * It is also the most persuasive single object on the page, so a demo without one is a demo of the
   * product's second-best state.
   */
  const { curve } = verdictOfTheDemo();
  const clean = curve.filter((p) => p.mean === 0 && (p.untouched ?? 0) > 0);
  assert.ok(clean.length >= 1, "no clean week, so the chart never shows its best state");
});

test("THE CORRECTIONS ARE AT THE START OF THE RECORD, WHICH IS WHERE THE DATE MATH PUTS THEM", () => {
  /**
   * The bug in one assertion. `REVISIONS` is keyed by index into `FILES`, and the seeder dates
   * deliverable `i` at `at(2 + i)` — so a LOW key is RECENT. Putting the substantial corrections on
   * low keys is what produced "2% more than when you started", and nothing about the key name says
   * so. This is the sentence that would have caught it.
   *
   * One recent key is allowed and intended: the single small correction that keeps the latest week
   * from being zero. The rule is that the HEAVY history belongs to the oldest half.
   */
  const keys = Object.keys(REVISIONS).map(Number).sort((a, b) => a - b);
  assert.ok(keys.length >= 2, "the demo has fewer than two sent-back deliverables to plot");
  const oldHalf = keys.filter((k) => k >= FILES.length / 2);
  assert.ok(
    oldHalf.length > keys.length - oldHalf.length,
    `most sent-back deliverables are in the recent half of FILES (${keys.join(", ")} of ${FILES.length}) — ` +
      `that is a business getting worse`,
  );
  // And the heaviest history — the one with two asks — is the oldest of them.
  const deepest = keys.reduce((a, b) => ((REVISIONS[b]?.length ?? 0) > (REVISIONS[a]?.length ?? 0) ? b : a));
  assert.equal(deepest, Math.max(...keys), "the deliverable that took three goes is not the oldest one");
});

test("the fixture here matches the dates the seeder actually writes", () => {
  /**
   * This file reproduces two of the seeder's expressions — `at(2 + i)` for a deliverable and
   * `at(1 + i)` for its acceptance — because they are SQL parameters, not exported values. A test
   * that silently models different dates from the ones in production is worse than no test, so the
   * two literals are asserted against the seeder's source.
   */
  const src = new URL("../scripts/seed-history.ts", import.meta.url);
  const seeder = readFileSync(src, "utf8");
  assert.match(
    seeder,
    /seedVersions\(\{ index: i, baseDaysAgo: 2 \+ i, finalSummary: SUMMARY\[f\.name\] \?\? f\.title \}\)/,
    "the seeder no longer dates a deliverable at `2 + i`, so this fixture models the wrong history",
  );
  assert.match(
    seeder,
    /ver\.carriesFile && accepted \? at\(1 \+ i\) : null/,
    "the seeder no longer accepts a deliverable at `1 + i`",
  );
  assert.match(seeder, /const accepted = i < 7;/, "the seeder changed which deliverables are accepted");
});

test("every draft that was sent back is WORSE than the one after it, in a way a reader can see", () => {
  /**
   * The other half of why the curve was flat. The superseded versions used to be the final summary
   * with "(superseded — see version 2.)" appended: a label, not a draft. `editDistance` is word-level
   * Levenshtein, so that scored ~2% no matter how badly the first attempt missed — which made every
   * correction in the fixture the same size and left the curve's direction to rounding.
   *
   * A draft and its redraft sharing most of their words is not a correction anybody would recognise
   * as one, and a prospect who opens the version history and reads "(superseded)" has been shown a
   * database field rather than the loop the product sells.
   */
  const versions = seededVersions();
  const pairs = [...correctionPairs(versions, text), ...clientSendBacks(versions, text)];
  assert.ok(pairs.length >= 3, `only ${pairs.length} corrections in the whole demo`);

  for (const p of pairs) {
    assert.ok(
      !/superseded/i.test(p.before),
      "a draft is labelled rather than written — it says 'superseded' instead of being a worse draft",
    );
    assert.ok(p.distance > 0, `a correction that changed nothing measurable: "${p.before}"`);
  }
  // And at least one of them is a real rewrite rather than a tweak, or the first week has no height.
  assert.ok(
    pairs.some((p) => p.distance > 0.5),
    "no correction rewrote more than half a draft, so the curve has nowhere to fall from",
  );
});

test("every client ask names what is missing", () => {
  /**
   * Not an aesthetic rule. These are the sentences on screen in the version history, and they are the
   * only place a viewer sees WHY the work changed. "Please revise" tells them nothing and makes the
   * loop look like a formality; "name them, and say which is new" is a client teaching a service what
   * a useful answer is, which is the thing being demonstrated.
   */
  const asks = Object.values(REVISIONS).flatMap((r) => r.map((x) => x.ask));
  assert.ok(asks.length >= 3, "fewer than three client asks in the demo");
  for (const ask of asks) {
    assert.ok(ask.split(/\s+/).length >= 10, `too thin to read as a real ask: "${ask}"`);
    assert.ok(
      !/^(please )?(revise|update|fix|redo)\b/i.test(ask.trim()),
      `a formality rather than an ask: "${ask}"`,
    );
  }
});
