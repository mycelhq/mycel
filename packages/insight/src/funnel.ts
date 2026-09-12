/**
 * The funnel primitive.
 *
 * A funnel is an ORDERED list of named steps, declared once by the product:
 *
 *   export const intake = defineFunnel("intake", [
 *     "viewed_service", "started_intake", "submitted", "paid",
 *   ]);
 *
 * The declaration is the whole point. Without it, "where do customers give up?" is answered by a
 * human squinting at a bar chart and deciding which bar looks short — which is a judgement, made
 * inconsistently, that an agent cannot make at all. With it, drop-off is arithmetic, the same
 * arithmetic every week, and the answer is a step name a task can be written against.
 *
 * Pure and dependency-free: no DOM, no network, no clock. The client uses it to tag events, the
 * kernel's summary computes the same shape from its rollups, and the tests can pin the maths
 * without standing anything up.
 */

export interface FunnelDefinition {
  name: string;
  steps: readonly string[];
}

export interface FunnelStepReport {
  step: string;
  /** As counted. Kept alongside `reached` so a nonsense input is visible rather than smoothed away. */
  count: number;
  /** Monotonic count actually used for the rates below. See `analyseFunnel` for why they differ. */
  reached: number;
  /** Share of everyone who entered the funnel that got this far. 0..1. */
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
  /** `completed / entered`, 0..1. 0 when nobody entered — not NaN, which poisons every consumer. */
  completion_rate: number;
  steps: FunnelStepReport[];
  /**
   * Where to look first. The transition that lost the most PEOPLE, not the highest percentage —
   * a 90% loss on a step three visitors reached is noise, and pointing an agent at noise costs a
   * task. Ties break earliest, because fixing an early step also feeds every later one.
   */
  biggest_drop_off: { from: string; to: string; lost: number; loss_rate: number } | null;
}

/** Declare a funnel. Names are normalised the same way event names are, so `s` matches `n`. */
export function defineFunnel(name: string, steps: readonly string[]): FunnelDefinition {
  const clean = steps.map((s) => s.trim().toLowerCase()).filter((s) => s.length > 0);
  const seen = new Set<string>();
  for (const s of clean) {
    // A repeated step would make `from_previous` compare a step against itself, so it is a
    // declaration bug, not a data condition — thrown at definition time where the fix is obvious.
    if (seen.has(s)) throw new Error(`funnel "${name}": duplicate step "${s}"`);
    seen.add(s);
  }
  if (clean.length < 2) throw new Error(`funnel "${name}": needs at least two steps`);
  return { name: name.trim().toLowerCase(), steps: clean };
}

/** Where a step sits in the funnel, or -1. Used by the client to tag an event with its step. */
export function stepIndex(funnel: FunnelDefinition, step: string): number {
  return funnel.steps.indexOf(step.trim().toLowerCase());
}

/**
 * Turn per-step counts into a report.
 *
 * **Why counts are clamped monotonic.** The input is how many times each step event was seen, and a
 * customer who submits the form twice makes `submitted` larger than `started_intake`. Reported
 * naively that is a 120% conversion rate, which is not a surprising insight, it is a broken one —
 * and an agent reading "conversion improved to 120%" will happily write a task celebrating it. So
 * each step is capped at the step before it: `reached[i] = min(count[i], reached[i-1])`. The raw
 * count is still reported, so the discrepancy is visible to anyone who looks.
 *
 * Counting events rather than distinct people is a deliberate trade too: distinct-person funnels
 * need a per-visitor timeline, and keeping a per-visitor timeline of a founder's customers is
 * exactly the data this package refuses to hold. Event counts answer "which step is losing people"
 * correctly and answer "how many unique humans" approximately. That is the right side of the trade.
 */
export function analyseFunnel(funnel: FunnelDefinition, counts: Record<string, number>): FunnelReport {
  const raw = funnel.steps.map((s) => Math.max(0, Math.floor(counts[s] ?? 0)));
  const reached: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    const value = raw[i] ?? 0;
    reached.push(i === 0 ? value : Math.min(value, reached[i - 1] ?? 0));
  }
  const entered = reached[0] ?? 0;
  const completed = reached[reached.length - 1] ?? 0;

  const steps: FunnelStepReport[] = funnel.steps.map((step, i) => {
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
  for (let i = 1; i < steps.length; i++) {
    const s = steps[i];
    const prev = steps[i - 1];
    if (!s || !prev || s.lost <= 0) continue;
    if (!biggest || s.lost > biggest.lost) {
      biggest = { from: prev.step, to: s.step, lost: s.lost, loss_rate: s.loss_rate };
    }
  }

  return {
    name: funnel.name,
    entered,
    completed,
    completion_rate: rate(completed, entered),
    steps,
    biggest_drop_off: biggest,
  };
}

/** Division that returns 0 rather than NaN/Infinity, rounded to 4dp so JSON diffs stay stable. */
function rate(n: number, d: number): number {
  if (!d || d <= 0) return 0;
  return Math.round((n / d) * 10_000) / 10_000;
}
