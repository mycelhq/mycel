// Funnel arithmetic, kernel-side.
//
// The same maths as `packages/insight/src/funnel.ts`, and duplicated for the same reason as
// `schema.ts`: the kernel ships as a container that does not contain that package. Both sides are
// pinned by tests that assert the same numbers, so a divergence is a red test rather than a support
// ticket about a dashboard and an SDK disagreeing.
//
// Why this exists at all: without a declared, ordered step list, "where do customers give up?" is
// answered by a human squinting at a bar chart and deciding which bar looks short. That is a
// judgement, made differently every week, and an agent cannot make it. With the declaration it is
// arithmetic, and the answer is a step NAME that a self-improvement task can be written against.

export interface FunnelStepReport {
  step: string;
  /** As counted. Kept next to `reached` so a nonsense input stays visible rather than smoothed away. */
  count: number;
  /** The monotonic count the rates below actually use. See `analyseFunnel` for why they differ. */
  reached: number;
  /** Share of everyone who entered that got this far. 0..1. */
  from_start: number;
  /** Share of the PREVIOUS step that got here. 0..1. The number that localises a problem. */
  from_previous: number;
  /** How many were lost between the previous step and this one. */
  lost: number;
  /** That loss as a share of the previous step. 0..1. */
  loss_rate: number;
}

export interface FunnelReport {
  name: string;
  entered: number;
  completed: number;
  /** `completed / entered`. 0 when nobody entered — not NaN, which poisons every consumer downstream. */
  completion_rate: number;
  steps: FunnelStepReport[];
  /**
   * Where to look first. The transition that lost the most PEOPLE, not the highest percentage: a
   * 90% loss on a step three visitors reached is noise, and pointing an agent at noise costs a task
   * and buys nothing. Ties break earliest, because fixing an early step also feeds every later one.
   */
  biggest_drop_off: { from: string; to: string; lost: number; loss_rate: number } | null;
}

/** Division that yields 0 rather than NaN/Infinity, rounded to 4dp so JSON diffs stay stable. */
export function rate(n: number, d: number): number {
  if (!d || d <= 0) return 0;
  return Math.round((n / d) * 10_000) / 10_000;
}

/**
 * Turn per-step counts into a report.
 *
 * **Why counts are clamped monotonic.** The input is how many times each step event was seen, and a
 * customer who submits the form twice makes `submitted` larger than `started`. Reported naively
 * that is a 120% conversion rate, which is not a surprising insight, it is a broken one — and an
 * agent reading "conversion improved to 120%" will cheerfully write a task celebrating it. So each
 * step is capped at the one before: `reached[i] = min(count[i], reached[i-1])`. The raw count is
 * still reported, so the discrepancy is visible to anyone who looks for it.
 *
 * Counting EVENTS rather than distinct people is a deliberate trade. A distinct-person funnel needs
 * a per-visitor timeline, and holding a per-visitor timeline of a founder's customers is precisely
 * the data this feature refuses to keep (see `schema.ts`: the anonymous id is discarded on arrival).
 * Event counts answer "which step is losing people" correctly and "how many unique humans"
 * approximately, and only the first question drives a change to the product.
 */
export function analyseFunnel(name: string, steps: readonly string[], counts: Record<string, number>): FunnelReport {
  const raw = steps.map((s) => Math.max(0, Math.floor(counts[s] ?? 0)));
  const reached: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    const value = raw[i] ?? 0;
    reached.push(i === 0 ? value : Math.min(value, reached[i - 1] ?? 0));
  }
  const entered = reached[0] ?? 0;
  const completed = reached[reached.length - 1] ?? 0;

  const rows: FunnelStepReport[] = steps.map((step, i) => {
    const here = reached[i] ?? 0;
    const before = i === 0 ? entered : (reached[i - 1] ?? 0);
    const lost = i === 0 ? 0 : Math.max(0, before - here);
    return {
      step,
      count: raw[i] ?? 0,
      reached: here,
      from_start: rate(here, entered),
      from_previous: i === 0 ? (entered > 0 ? 1 : 0) : rate(here, before),
      lost,
      loss_rate: i === 0 ? 0 : rate(lost, before),
    };
  });

  let biggest: FunnelReport["biggest_drop_off"] = null;
  for (let i = 1; i < rows.length; i++) {
    const here = rows[i];
    const prev = rows[i - 1];
    if (!here || !prev || here.lost <= 0) continue;
    if (!biggest || here.lost > biggest.lost) {
      biggest = { from: prev.step, to: here.step, lost: here.lost, loss_rate: here.loss_rate };
    }
  }

  return { name, entered, completed, completion_rate: rate(completed, entered), steps: rows, biggest_drop_off: biggest };
}
