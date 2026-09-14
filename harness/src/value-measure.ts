// ═══ WHAT DID THIS ACTUALLY SAVE THEM? ═══
//
// The question this product has never been able to answer. It can show a founder what it did — a
// deliverable, a chased invoice, a sequence advanced — and it has no way to say what any of that
// was worth. That gap is the reason "does it work" has stayed an opinion, and it is the reason a
// before-and-after on an acquired business would be unarguable in both directions.
//
// Cognition published a working system for the same problem in June 2026 ("Estimating the
// Productivity of an Autonomous AI Software Engineer"), validated against 258 sessions from 126
// users across eight enterprise deployments. The method transfers almost unchanged, and their
// reasoning about WHY each choice was made is the part worth copying.
//
// ═══ THE METRIC: HOURS, AND WHY NOT THE TWO OBVIOUS ALTERNATIVES ═══
//
// Not dollars of business value: "this is still an unsolved problem in our field. It's incredibly
// hard for an engineer to know how many dollars of business value they created."
//
// Not activity — tokens, runs, artefacts produced: "these are easy to collect but don't correspond
// to effort. A mechanical refactor can touch thousands of lines in an afternoon; a two-line bug fix
// can represent hours of investigation."
//
// The middle ground is human hours: "how long would a human have taken to produce the same output?"
// Hours are "already how organizations value engineering work", standardised, and convertible.
//
// It fits a SERVICE BUSINESS better than it fits engineering, for a reason Cognition did not have:
// these firms already bill by the hour. A bookkeeper has a rate. An agency has a rate. The
// conversion from hours to money is a number the founder already knows and already defends to
// clients, rather than an imputed salary figure.
//
// ═══ PRODUCTIVE FIRST, AND OUR FILTER IS BETTER THAN THEIRS ═══
//
// "not all hours are equal. For example, if all PRs created by a session were closed, it likely
// wasn't valuable." They classify productivity before estimating hours, using merged-PR as the
// proxy.
//
// Ours is stronger evidence than a merged PR, because it involves the customer. A deliverable
// carries `released_at` — the founder chose to send it — and `accepted_at`, the client said it was
// right. A merged PR means one engineer approved it; an accepted deliverable means somebody paid
// for it and took it. Work that was never released saved nobody anything, however good it looked.
//
// ═══ AGGREGATE ONLY, AND CALIBRATED TO UNDERSTATE ═══
//
// "Individual estimates are noisy but approximately unbiased; aggregated across a deployment,
// errors cancel and the total converges toward what engineers report." So a per-item hour figure is
// not shown as a fact — `estimateOne` is internal and the report refuses to run below a floor.
//
// And: "The system is calibrated to underestimate rather than overestimate delivered output." That
// is the correct bias for us twice over. A founder who finds one inflated number stops believing
// the whole dashboard, and a diligence figure that cannot survive an auditor is worse than no
// figure. Every rounding here goes down.
//
// ═══ WHAT IT DOES NOT MEASURE, STATED BECAUSE THEY STATED IT ═══
//
// "Hours are not business value. We measure engineering capacity, not whether that capacity was
// deployed on high-value work." And "hours don't account for quality" — a defect found later makes
// the true uplift negative, and the release filter catches the obvious failures, not the subtle
// ones. Both carry over exactly. This measures capacity returned to the founder, not profit.

/** One completed piece of work, as the measurer needs it. */
export interface WorkItem {
  id: string;
  /** The task type or wedge job — the same string across comparable work. */
  kind: string;
  /** The founder released it to the client. Nothing unreleased counts. */
  releasedAt?: string | Date | null;
  /** The client accepted it. Stronger evidence than release, and rarer. */
  acceptedAt?: string | Date | null;
  /** Withdrawn, rejected, or superseded — negative evidence, counted as unproductive. */
  rejectedAt?: string | Date | null;
  /**
   * What a person in this trade would have taken, in hours, for this piece of work.
   *
   * Supplied per work item rather than derived here, because the only credible source is the trade
   * itself: the founder's own estimate, or the `research_service` finding about how long this
   * deliverable takes. A number this module invented would be the fabrication the whole design is
   * built to avoid.
   */
  humanHours?: number | null;
}

export interface ValueReport {
  /** Items that reached a client. The denominator for everything below. */
  productive: number;
  /** Items that were produced and never released, or were rejected. */
  unproductive: number;
  /** Total hours returned, summed over productive items with a supplied estimate. */
  hours: number;
  /** Productive items with no hours estimate — counted, never guessed at. */
  unestimated: number;
  /** Money, only when a rate was supplied. */
  money?: { amount: number; currency: string; hourlyRate: number };
  /** True when there was enough work to say anything. Below the floor, everything above is zero. */
  reportable: boolean;
  /** The sentence a founder reads. Plain, hedged where it must be. */
  summary: string;
}

const at = (v: WorkItem["releasedAt"]): number | null => {
  if (!v) return null;
  const n = v instanceof Date ? v.getTime() : Date.parse(String(v));
  return Number.isFinite(n) ? n : null;
};

/**
 * Did this piece of work reach a client?
 *
 * Rejection beats release: a deliverable that went out and came back is not a saved hour, it is a
 * spent one. Checked first for that reason.
 */
export function isProductive(item: WorkItem): boolean {
  if (at(item.rejectedAt) !== null) return false;
  return at(item.acceptedAt) !== null || at(item.releasedAt) !== null;
}

/**
 * The floor below which no total is shown.
 *
 * Cognition's estimator is "noisy but approximately unbiased" per item and converges in aggregate.
 * Twenty is where the noise stops dominating, and it is the same floor `conformance` uses for the
 * same reason: a confident number from four data points teaches a founder to distrust the fifth.
 */
export const REPORTABLE_FLOOR = 20;

export function measureValue(
  items: readonly WorkItem[],
  opts: { hourlyRate?: number; currency?: string; floor?: number } = {},
): ValueReport {
  const floor = opts.floor ?? REPORTABLE_FLOOR;
  let productive = 0;
  let unproductive = 0;
  let hours = 0;
  let unestimated = 0;

  for (const item of items) {
    if (!isProductive(item)) {
      unproductive++;
      continue;
    }
    productive++;
    const h = typeof item.humanHours === "number" && Number.isFinite(item.humanHours) && item.humanHours > 0
      ? item.humanHours
      : null;
    if (h === null) {
      unestimated++;
      continue;
    }
    hours += h;
  }

  // Down, always. See the header: every rounding goes the direction that survives an auditor.
  hours = Math.floor(hours * 10) / 10;

  if (productive < floor) {
    return {
      productive,
      unproductive,
      hours: 0,
      unestimated,
      reportable: false,
      summary:
        `Not enough finished work to say yet — ${productive} of ${floor} pieces delivered to a client. ` +
        `A total from fewer than that is noise wearing a number.`,
    };
  }

  const rate = opts.hourlyRate;
  const money =
    typeof rate === "number" && Number.isFinite(rate) && rate > 0
      ? {
          /**
           * INTEGER ARITHMETIC, because `Math.floor(39.8 * 100)` is 3979.
           *
           * 39.8 × 100 evaluates to 3979.9999999999995 in binary floating point, so flooring it
           * loses a whole unit of currency — an underestimate, which is the right DIRECTION, but
           * produced by numeric error rather than by the deliberate bias this file argues for. A
           * figure that is a dollar out for a reason nobody can explain is exactly the kind an
           * auditor stops trusting. `hours` is already floored to one decimal, so tenths and cents
           * are both exact integers and the product is too.
           */
          amount: Math.floor((Math.round(hours * 10) * Math.round(rate * 100)) / 1000),
          currency: opts.currency ?? "USD",
          hourlyRate: rate,
        }
      : undefined;

  const parts = [`${hours} hours of work reached a client across ${productive} pieces`];
  if (money) parts.push(`about ${money.currency} ${String(money.amount).replace(/\B(?=(\d{3})+(?!\d))/g, ",")} at your own rate`);
  const caveats: string[] = [];
  if (unestimated) caveats.push(`${unestimated} had no time estimate on file and are NOT counted`);
  if (unproductive) caveats.push(`${unproductive} never reached a client and are excluded`);

  return {
    productive,
    unproductive,
    hours,
    unestimated,
    money,
    reportable: true,
    summary:
      `${parts.join(", ")}.` +
      (caveats.length ? ` ${caveats.join("; ")}.` : "") +
      ` This is capacity returned, not profit — it does not say whether the hours were spent on the` +
      ` right work, and it counts nothing that came back.`,
  };
}

/**
 * The before-and-after, which is the only form of this number that survives a buyer.
 *
 * A single total is a claim about the present. What a diligence process asks is whether anything
 * CHANGED, and the honest answer needs both windows measured the same way — so this takes two
 * already-measured reports rather than recomputing, and refuses when either is below the floor.
 *
 * Improvement is expressed in hours rather than as a percentage. A percentage off a small base is
 * the standard way to make a modest change look transformational, and this number exists precisely
 * to be shown to somebody who will check it.
 */
export function compareWindows(before: ValueReport, after: ValueReport): {
  comparable: boolean;
  deltaHours: number;
  summary: string;
} {
  if (!before.reportable || !after.reportable) {
    return {
      comparable: false,
      deltaHours: 0,
      summary:
        "Not comparable yet: one of the two windows has too little finished work. A before-and-after " +
        "built on a thin window is the easiest number in this product to be wrong about.",
    };
  }
  const delta = Math.floor((after.hours - before.hours) * 10) / 10;
  const direction = delta > 0 ? "more" : delta < 0 ? "less" : "the same";
  return {
    comparable: true,
    deltaHours: delta,
    summary:
      `${Math.abs(delta)} hours ${direction} reached a client than in the earlier window ` +
      `(${before.hours} → ${after.hours} across ${before.productive} then ${after.productive} pieces). ` +
      `Measured the same way in both windows; hours only, because a percentage off a small base is ` +
      `how a modest change is made to look like a transformation.`,
  };
}
