// The agent-facing read: `GET /v1/insight/summary`.
//
// This is the output the whole feature exists for, so it is worth being explicit about who it is
// for. It is NOT a dashboard payload. Nobody is going to draw a line chart from it. Its consumer is
// a model deciding what to change about a product it wrote, and that changes every design choice:
//
//   - **Terse.** Everything here competes for context with the product's own source code. Ten top
//     events, not five hundred. Rounded rates, not float noise. No per-day series — a model cannot
//     do anything with 30 numbers that it cannot do with the two windows they collapse into.
//   - **Pre-decided.** `biggest_drop_off` and `attention` exist because "look at the chart and pick
//     the worst step" is exactly the judgement that gets made differently every time it is made.
//     The arithmetic is here, once, so the model receives a conclusion it can act on rather than
//     evidence it has to interpret.
//   - **Comparative.** A completion rate of 12% means nothing alone. "12%, was 21% last week" is a
//     task. So every summary carries the previous window of equal length and the notable deltas.
//   - **Honest about thin data.** A 90% drop on a step three people reached is noise, and a model
//     handed noise will confidently write a task about it. Changes below a volume floor are not
//     reported at all, and `thin` says so out loud.
import type { DomainStore } from "../domain";
import {
  CONVERSION_METRIC,
  CONVERT_PREFIX,
  EXPOSURE_PREFIX,
  analyseExperiment,
  type ExperimentReport,
} from "./experiment";
import { analyseFunnel, type FunnelReport } from "./funnel";
import { aggregateWindow, loadFunnel, topCounts, type Aggregate } from "./store";

/** How many rows of each ranking survive into the payload. See "terse", above. */
const TOP_N = 10;
/** Below this many observations in both windows, a delta is noise and is not reported. */
const VOLUME_FLOOR = 10;
/** Relative movement that counts as "notable". Below it, week-to-week wobble. */
const NOTABLE = 0.25;

export interface Delta {
  metric: string;
  previous: number;
  current: number;
  /** Relative change, `(current - previous) / previous`. `null` when there was no previous value. */
  change: number | null;
  direction: "up" | "down";
}

export interface InsightSummary {
  project_id: string;
  window: { days: number; from: string; to: string };
  previous: { from: string; to: string };
  totals: { events: number; sessions: number; pageviews: number; batches: number };
  previous_totals: { events: number; sessions: number; pageviews: number; batches: number };
  funnel: (FunnelReport & { previous_completion_rate: number; declared_steps: number }) | null;
  /**
   * The A/B verdict, or null when this product runs no experiment.
   *
   * Read `experiment.winner` BEFORE `experiment.arms`. A null winner alongside arms that look
   * different is not an invitation to eyeball the rates and decide for yourself — it means the
   * difference did not survive the test in `experiment.ts`, and `verdict` says which condition it
   * failed.
   */
  experiment: ExperimentReport | null;
  top_events: Array<{ name: string; count: number; previous: number }>;
  top_paths: Array<{ path: string; count: number }>;
  changes: Delta[];
  /** One line stating what the numbers say. Written for a model to quote back in a task title. */
  headline: string;
  /** The single most actionable thing, or null when the data does not support naming one. */
  attention: string | null;
  /** True when there is too little data to draw a conclusion from. Read this BEFORE the numbers. */
  thin: boolean;
  /** True when the row cap was hit and the oldest part of the window is missing. */
  truncated: boolean;
}

const totalsOf = (a: Aggregate) => ({
  events: a.events,
  sessions: a.sessions,
  pageviews: a.pageviews,
  batches: a.batches,
});

/**
 * Build the summary for one project.
 *
 * `projectId` is resolved by the caller from the founder's credential, and every read below pushes
 * it down into the query. Nothing in this file accepts a project id from a request body or reads a
 * row it did not ask for by project.
 */
export async function buildSummary(
  domain: DomainStore,
  projectId: string,
  opts: { days?: number; funnel?: string; now?: Date } = {},
): Promise<InsightSummary> {
  const days = Math.min(Math.max(Math.floor(opts.days ?? 7), 1), 90);
  const now = opts.now ?? new Date();
  const to = now.toISOString();
  const from = new Date(now.getTime() - days * 86_400_000).toISOString();
  const prevFrom = new Date(now.getTime() - 2 * days * 86_400_000).toISOString();
  // The windows are half-open, `[from, to)`, so the two never double-count the instant between
  // them. The current window's end is pushed one millisecond PAST now, though, because a batch
  // ingested in the same millisecond as this read would otherwise fall outside both windows and
  // simply vanish. That is not a theoretical boundary: a product posting continuously will hit it,
  // and "events silently missing near the edge of every window" is a bug nobody would ever
  // reproduce. Nothing can be ingested in the future, so the extra millisecond can only ever
  // include an event that already happened.
  const end = new Date(now.getTime() + 1).toISOString();

  const [cur, prev] = await Promise.all([
    aggregateWindow(domain, projectId, from, end),
    aggregateWindow(domain, projectId, prevFrom, from),
  ]);

  const declaration = await loadFunnel(domain, projectId, opts.funnel);
  const funnel = declaration
    ? {
        ...analyseFunnel(declaration.name, declaration.steps, cur.aggregate.steps),
        previous_completion_rate: analyseFunnel(declaration.name, declaration.steps, prev.aggregate.steps)
          .completion_rate,
        declared_steps: declaration.steps.length,
      }
    : null;

  const events = topCounts(cur.aggregate.names)
    .slice(0, TOP_N)
    .map(({ key, count }) => ({ name: key, count, previous: prev.aggregate.names[key] ?? 0 }));
  const paths = topCounts(cur.aggregate.paths)
    .slice(0, TOP_N)
    .map(({ key, count }) => ({ path: key, count }));

  // The experiment is read from the CURRENT window only, and deliberately not compared to the
  // previous one. An A/B test is already a comparison — between arms, over the same period, on the
  // same traffic. Comparing this week's control to last week's control adds a second, worse
  // comparison (different weather, different ad spend, different day of the week) and invites a
  // conclusion drawn from the wrong one.
  const experiment = analyseExperiment(cur.aggregate.names, CONVERSION_METRIC);

  const changes = notableChanges(cur.aggregate, prev.aggregate, funnel);
  // "Thin" is about whether a CONCLUSION is supportable, so it keys off sessions rather than events:
  // a single visitor clicking around produces plenty of events and no evidence.
  const thin = cur.aggregate.sessions < VOLUME_FLOOR && cur.aggregate.events < VOLUME_FLOOR * 5;

  return {
    project_id: projectId,
    window: { days, from, to },
    previous: { from: prevFrom, to: from },
    totals: totalsOf(cur.aggregate),
    previous_totals: totalsOf(prev.aggregate),
    funnel,
    experiment,
    top_events: events,
    top_paths: paths,
    changes,
    headline: headlineFor(cur.aggregate, funnel, experiment, thin, days),
    attention: attentionFor(funnel, changes, experiment, thin),
    thin,
    truncated: cur.truncated || prev.truncated,
  };
}

/** A delta, or nothing when it is below either floor. Both floors matter — see the header. */
function delta(metric: string, previous: number, current: number): Delta | null {
  if (Math.max(previous, current) < VOLUME_FLOOR) return null;
  if (previous <= 0) return { metric, previous, current, change: null, direction: "up" };
  const rounded = Math.round(((current - previous) / previous) * 1000) / 1000;
  if (Math.abs(rounded) < NOTABLE) return null;
  return { metric, previous, current, change: rounded, direction: rounded >= 0 ? "up" : "down" };
}

/**
 * What moved.
 *
 * Volume first (sessions, pageviews), then the funnel's completion rate, then the events that
 * changed most. Capped, because a list of forty deltas is a list nobody reads — including a model,
 * which will simply attend to whichever one it saw first.
 */
function notableChanges(cur: Aggregate, prev: Aggregate, funnel: InsightSummary["funnel"]): Delta[] {
  const out: Delta[] = [];
  const push = (d: Delta | null) => {
    if (d) out.push(d);
  };
  push(delta("sessions", prev.sessions, cur.sessions));
  push(delta("pageviews", prev.pageviews, cur.pageviews));
  if (funnel) {
    // Rates are compared on their own terms rather than through `delta`, whose volume floor counts
    // observations and would read 0.21 vs 0.12 as "both under 10, ignore".
    const before = funnel.previous_completion_rate;
    const after = funnel.completion_rate;
    const moved = before > 0 ? Math.round(((after - before) / before) * 1000) / 1000 : null;
    if (funnel.entered >= VOLUME_FLOOR && (moved === null || Math.abs(moved) >= NOTABLE)) {
      out.push({
        metric: `funnel.${funnel.name}.completion_rate`,
        previous: before,
        current: after,
        change: moved,
        direction: after >= before ? "up" : "down",
      });
    }
  }
  const names = new Set([...Object.keys(cur.names), ...Object.keys(prev.names)]);
  const eventDeltas: Delta[] = [];
  for (const n of names) {
    // `$pageview` and `$session` are already reported as `pageviews`/`sessions`; repeating them as
    // event deltas would spend two of a short list saying the same thing twice.
    if (n === "$pageview" || n === "$session") continue;
    // Likewise the experiment's arm counters, and for a sharper reason. A week-over-week delta on
    // `$exposure:control` is a statement about how much traffic the site got, dressed up as a
    // statement about the experiment — and it is computed with the wrong test. `experiment` above
    // is the only place an arm is allowed to be compared to anything.
    if (n.startsWith(EXPOSURE_PREFIX) || n.startsWith(CONVERT_PREFIX)) continue;
    const d = delta(`event.${n}`, prev.names[n] ?? 0, cur.names[n] ?? 0);
    if (d) eventDeltas.push(d);
  }
  eventDeltas.sort((a, b) => Math.abs(b.change ?? 1) - Math.abs(a.change ?? 1));
  return [...out, ...eventDeltas].slice(0, 8);
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function headlineFor(
  cur: Aggregate,
  funnel: InsightSummary["funnel"],
  experiment: ExperimentReport | null,
  thin: boolean,
  days: number,
): string {
  if (cur.batches === 0) return `No events received in the last ${days}d.`;
  if (thin) return `Only ${cur.sessions} session(s) and ${cur.events} events in ${days}d — too thin to conclude from.`;
  const base = `${cur.sessions} sessions, ${cur.events} events in ${days}d.`;
  // A decided experiment leads, because it is the one line in this payload that names a file to
  // edit. An undecided one does not lead: putting "no winner yet" first every week trains the
  // reader to skip the first sentence.
  if (experiment?.winner) return `${base} ${experiment.verdict}`;
  if (!funnel) return `${base} No funnel declared, so drop-off is not computed.`;
  return `${base} Funnel "${funnel.name}": ${funnel.completed}/${funnel.entered} completed (${pct(funnel.completion_rate)}).`;
}

/**
 * The one thing to do something about.
 *
 * Deliberately singular. Handing a model a ranked list of six problems produces a task that tries to
 * fix six things; handing it the worst one produces a change that can be measured next week against
 * this same number. Returns null rather than inventing a finding when the data does not carry one —
 * a summary that always has an opinion is a summary whose opinion means nothing.
 */
function attentionFor(
  funnel: InsightSummary["funnel"],
  changes: Delta[],
  experiment: ExperimentReport | null,
  thin: boolean,
): string | null {
  // A won experiment outranks every other finding here, and not because it is more important. It is
  // the only finding that comes with an executable instruction: a named losing arm, in a named file,
  // whose replacement will be measured against this same number next week. A drop-off report says
  // where to look; this says what to do.
  //
  // Deliberately NOT gated on `thin`. `thin` is a statement about total sessions, and the
  // experiment carries its own, far stricter floor (200 exposures per arm) — a product that
  // instruments only the marketing page can clear the experiment's bar while `sessions` stays low,
  // and suppressing a properly-powered result because a different counter is small would be
  // discarding the good evidence on the strength of the weak.
  if (experiment?.winner && experiment.loser) return experiment.verdict;
  if (thin) return null;
  const drop = funnel?.biggest_drop_off;
  if (drop && funnel && funnel.entered >= VOLUME_FLOOR) {
    return `Biggest drop-off: "${drop.from}" → "${drop.to}" loses ${drop.lost} (${pct(drop.loss_rate)} of those who reached "${drop.from}").`;
  }
  const worst = changes.find((d) => d.direction === "down");
  if (worst) {
    return `${worst.metric} fell from ${worst.previous} to ${worst.current}${worst.change === null ? "" : ` (${pct(worst.change)})`}.`;
  }
  return null;
}
