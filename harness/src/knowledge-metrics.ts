// ═══ IS THIS THING ACTUALLY GETTING BETTER? ═══
//
// Two files in this codebase already cite `knowledge-metrics.ts` by name — knowledge.store.ts, on
// the `Observation` interface, and the `gap` kind's own doc comment. Neither citation resolved to
// anything. The table has been written on every human decision since it shipped, it is tenanted,
// append-only, indexed and keyed by subject, and until this file the only code that ever READ it
// was its own tests. That is the dominant defect shape in this repo and it is at its most expensive
// here, because the thing never read is the measurement.
//
// The per-rule half of this question is already answered well and this file does not duplicate it.
// `Rule.corrections_since` counts corrections on a subject after its rule went active, `Rule.uses`
// separates "the rule is wrong" from "the rule was never retrieved", and `rulesHealth` puts the two
// side by side and sorts the failures to the top. What that cannot see is everything that never
// became a rule: a clean approval creates no row, and `gap` creates no row, so the rules table is a
// record of corrections only. Asking it how often the agent was RIGHT is asking a list of
// complaints how the restaurant is doing.
//
// ═══ WHY THE CLEAN RATE IS THE RETENTION NUMBER ═══
//
// A founder decides whether to keep paying on one question, and it is not "how much did it do".
// It is "am I still fixing everything it hands me". A business whose clean rate is climbing is one
// where delegation is getting cheaper every month; a flat one at 40% is a founder doing the work
// twice and paying for the privilege, and they will churn whatever the volume chart says.
//
// This is the natural companion to `value-measure.ts`, and the two must not be read alone. Value
// says how many hours reached a client. This says whether they arrived finished. Hours going up
// while the clean rate goes down is a machine producing more work for its owner, which is the exact
// failure this product exists to avoid, and neither number can show it by itself.
//
// ═══ A GAP IS NOT A FAILURE, AND CONFLATING THEM WOULD TEACH THE WRONG LESSON ═══
//
// `gap` means the agent did not know something and said so instead of inventing it. That is the
// behaviour the grounding floor, the criteria and half the refusals in this codebase exist to
// produce. Folding gaps into an error rate would make the honest agent score worse than the one
// that guesses confidently and gets approved, which is precisely backwards — so gaps are excluded
// from the clean-rate denominator and reported on their own line.
//
// They are still reported, because a gap rate that climbs means the business is asking for work it
// has never told us how to do, and the answer to that is onboarding, not correction.
//
// ═══ AGGREGATE, FLOORED, AND IN POINTS ═══
//
// Same three disciplines as `value-measure.ts` and `conformance`, for the same reasons. A rate from
// six approvals swings twenty points on one bad afternoon, so under the floor this reports nothing
// rather than something shaped like an answer. And a change between two windows is stated in
// PERCENTAGE POINTS, never as a percentage of a percentage: 40% → 44% is four points, and the
// temptation to publish it as "a 10% improvement" is how a dashboard stops being evidence.

import type { Observation } from "./knowledge.store";

/**
 * The floor below which no rate is shown.
 *
 * Twenty, matching `REPORTABLE_FLOOR` in value-measure.ts. Both are the same judgement about the
 * same founder: a confident figure derived from four events teaches them to distrust the fifth, and
 * one number they cannot trust discredits the screen.
 *
 * `process-mining.ts` held the third copy and was deleted in 5ed4567c — a query over 36% of runs,
 * read once in its lifetime. The reference stayed behind, which is how a deleted feature goes on
 * looking built to the next reader.
 */
export const MIN_DECISIONS = 20;

/** The outcome kinds that are an approval verdict. `gap` is deliberately absent — see the header. */
const VERDICTS = new Set<Observation["kind"]>(["approval_clean", "approval_edited", "approval_rejected"]);

export interface QualityTrend {
  /** Approvals a human let through untouched. */
  clean: number;
  /** Approvals a human rewrote before they went out. */
  edited: number;
  /** Approvals a human refused outright. */
  rejected: number;
  /** Written corrections after the fact — the most expensive kind, because it already shipped. */
  feedbackBad: number;
  /** Times the agent proceeded on a stated assumption. NOT an error. See the header. */
  gaps: number;
  /** clean + edited + rejected. The denominator, and `gaps` is not in it. */
  decisions: number;
  /** Percent of decisions that went out untouched, 0–100, one decimal. Zero when unreportable. */
  cleanRate: number;
  /** True when there were enough decisions to say anything at all. */
  reportable: boolean;
  /** The sentence a founder reads. */
  summary: string;
}

const pct = (n: number, d: number): number => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);

/**
 * The trend over one window of observations.
 *
 * Takes rows rather than a store handle so it stays pure and testable, and so the caller decides
 * the window — a metric that picks its own date range is one nobody can reproduce.
 */
export function qualityTrend(observations: readonly Observation[], opts: { floor?: number } = {}): QualityTrend {
  const floor = opts.floor ?? MIN_DECISIONS;
  let clean = 0;
  let edited = 0;
  let rejected = 0;
  let feedbackBad = 0;
  let gaps = 0;

  for (const o of observations) {
    switch (o?.kind) {
      case "approval_clean":
        clean++;
        break;
      case "approval_edited":
        edited++;
        break;
      case "approval_rejected":
        rejected++;
        break;
      case "feedback_bad":
        feedbackBad++;
        break;
      case "gap":
        gaps++;
        break;
      default:
        // An unrecognised kind is dropped rather than bucketed. A future kind silently counted as a
        // failure would move this number for a reason nobody could find.
        break;
    }
  }

  const decisions = clean + edited + rejected;
  if (decisions < floor) {
    return {
      clean,
      edited,
      rejected,
      feedbackBad,
      gaps,
      decisions,
      cleanRate: 0,
      reportable: false,
      summary:
        `Too early to say — ${decisions} of ${floor} reviewed decisions. A rate from fewer than that ` +
        `moves twenty points on one bad afternoon.`,
    };
  }

  const cleanRate = pct(clean, decisions);
  const parts = [`${cleanRate}% of work went out exactly as drafted (${clean} of ${decisions})`];
  if (edited) parts.push(`${edited} you rewrote`);
  if (rejected) parts.push(`${rejected} you sent back`);

  const tail: string[] = [];
  if (gaps) {
    tail.push(
      `${gaps} time${gaps === 1 ? "" : "s"} it flagged something it had not been told rather than ` +
        `guessing — that is not an error, it is a question for onboarding`,
    );
  }
  if (feedbackBad) {
    tail.push(
      `${feedbackBad} correction${feedbackBad === 1 ? "" : "s"} arrived after the work had already gone out`,
    );
  }

  return {
    clean,
    edited,
    rejected,
    feedbackBad,
    gaps,
    decisions,
    cleanRate,
    reportable: true,
    summary: `${parts.join(", ")}.` + (tail.length ? ` ${tail.join("; ")}.` : ""),
  };
}

export interface TaskTypeQuality {
  taskType: string;
  decisions: number;
  clean: number;
  cleanRate: number;
  reportable: boolean;
}

/**
 * The same rate, split by job.
 *
 * The business-wide figure is the one that gets quoted and the one that hides the problem: 80%
 * clean across everything is entirely compatible with one task type running at 25% and eating every
 * hour the founder thought they had bought back. The split is where the action is, so it is ranked
 * WORST FIRST among the job types that clear the floor.
 *
 * Job types under the floor are returned too, with `reportable: false` and a zero rate, rather than
 * dropped. A caller that filters them out is making a choice; a function that hides them is making
 * that choice for every caller, and "this job has never been measured" is itself worth seeing.
 */
export function qualityByTaskType(
  observations: readonly Observation[],
  opts: { floor?: number } = {},
): TaskTypeQuality[] {
  const floor = opts.floor ?? MIN_DECISIONS;
  const byType = new Map<string, { decisions: number; clean: number }>();
  for (const o of observations) {
    if (!o?.task_type || !VERDICTS.has(o.kind)) continue;
    const row = byType.get(o.task_type) ?? { decisions: 0, clean: 0 };
    row.decisions++;
    if (o.kind === "approval_clean") row.clean++;
    byType.set(o.task_type, row);
  }

  return [...byType]
    .map(([taskType, r]) => ({
      taskType,
      decisions: r.decisions,
      clean: r.clean,
      cleanRate: r.decisions >= floor ? pct(r.clean, r.decisions) : 0,
      reportable: r.decisions >= floor,
    }))
    .sort((a, b) => {
      // Reportable first, then worst rate, then most decisions. Unreportable rows sort to the
      // bottom in volume order so the closest one to being measurable is the one nearest the top.
      if (a.reportable !== b.reportable) return a.reportable ? -1 : 1;
      if (a.reportable && a.cleanRate !== b.cleanRate) return a.cleanRate - b.cleanRate;
      return b.decisions - a.decisions;
    });
}

/**
 * Did it improve between two windows?
 *
 * In PERCENTAGE POINTS. 40% to 44% is four points, and every instinct in a founder-facing product
 * pushes toward calling that "a 10% improvement" — a percentage of a percentage, off a small base,
 * shown to the person deciding whether the thing works. `compareWindows` in value-measure.ts
 * refuses the same trick for the same reason, and the two must agree or one of them is the number
 * people learn to quote.
 *
 * Refuses when either window is under its floor. A before-and-after built on a thin window is the
 * single easiest number in this product to be wrong about, and it is also the one most likely to be
 * shown to somebody doing diligence.
 */
export function compareQuality(before: QualityTrend, after: QualityTrend): {
  comparable: boolean;
  deltaPoints: number;
  summary: string;
} {
  if (!before.reportable || !after.reportable) {
    return {
      comparable: false,
      deltaPoints: 0,
      summary:
        "Not comparable yet: one of the two windows has too few reviewed decisions. A before-and-after " +
        "from a thin window says more about the window than about the work.",
    };
  }
  const deltaPoints = Math.round((after.cleanRate - before.cleanRate) * 10) / 10;
  if (deltaPoints === 0) {
    return {
      comparable: true,
      deltaPoints: 0,
      summary:
        `Unchanged at ${after.cleanRate}% clean. It is not getting worse, and it is not learning ` +
        `either — the corrections you are making are not reaching the next draft.`,
    };
  }
  const better = deltaPoints > 0;
  return {
    comparable: true,
    deltaPoints,
    summary:
      `${Math.abs(deltaPoints)} percentage points ${better ? "better" : "worse"} ` +
      `(${before.cleanRate}% → ${after.cleanRate}% of work going out untouched, across ` +
      `${before.decisions} then ${after.decisions} decisions). ` +
      (better
        ? "Points, not percent: this is the share of work you no longer have to touch."
        : "Worth looking at the job types below — a business-wide dip is usually one job going wrong."),
  };
}
