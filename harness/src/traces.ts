// Run tracing, read out of the event log we already write.
//
// This replaces per-project Langfuse tracing. Not because Langfuse is bad — it is still available as
// an operator's own opt-in sink in tracing.ts — but because its Organization Management API (the
// thing that would have let a founder's project get its own trace project) is not available on
// Langfuse Cloud at all, self-hosted Enterprise only. Meanwhile every fact a trace view needs is
// already in the `events` table: what ran, in what order, with what arguments, what it cost. The
// gap was never the recording. It was that nothing read it back.
//
// Pure functions, no I/O: the fold is the part worth testing, and a fold with a database in it
// isn't testable. The route hands it rows; this file decides what a run looked like.
import { redactPreview } from "./actions";
import type { TaskEvent } from "./contract";

export type SpanType = "step" | "tool" | "generation" | "approval";

/**
 * `running` means the log records no end for this span — an in-flight run, or one whose process
 * died mid-tool-call. It is NOT "still executing right now"; nothing here can know that. A crashed
 * run must still render, so an unfinished span is a first-class state rather than an error.
 */
export type SpanStatus = "ok" | "error" | "running";

export interface Span {
  name: string;
  type: SpanType;
  start_ts: string;
  end_ts?: string;
  duration_ms?: number;
  status: SpanStatus;
  error?: string;
  children: Span[];
  /** Tool/approval arguments, run through the same redaction the approval card uses. */
  preview?: unknown;
  /** Generation spans only: how many `token.delta` events were folded in. See `flushGeneration`. */
  token_deltas?: number;
}

export interface TraceTotals {
  /** Wall clock from the first event to the last, or to the close of the root when it closed. */
  duration_ms: number;
  /** Time inside each tool, summed by tool name. Only closed tool spans contribute. */
  tool_ms: Record<string, number>;
  tool_calls: number;
  /**
   * Streamed chunks, not tokens.
   *
   * `token.delta` carries `{ text }` and nothing else, so this counts deltas. Real usage numbers
   * exist upstream (OpenCode reports them on `message.info`) but the harness converts them straight
   * to dollars via `estimateCost` and never records the counts. See the note on `cost_usd`.
   */
  token_deltas: number;
  /** Sum of `cost.charged.cost_usd`. The only usage signal that survives into the log. */
  cost_usd: number;
  errors: number;
}

export interface Trace {
  task_id: string;
  /** The whole run. Opened by the first event, closed by `task.finished`. */
  root: Span;
  totals: TraceTotals;
  /** Events the fold ignored (`progress`, `feedback.recorded`, …). Surfaced so a UI can say so. */
  event_count: number;
}

/** Clamped: events can be written by different replicas, and skewed clocks must not print -12ms. */
function elapsed(from: string, to: string): number {
  const ms = Date.parse(to) - Date.parse(from);
  return Number.isFinite(ms) ? Math.max(0, ms) : 0;
}

function close(span: Span, ts: string, status: SpanStatus, error?: string): void {
  span.end_ts = ts;
  span.duration_ms = elapsed(span.start_ts, ts);
  span.status = status;
  if (error) span.error = error;
}

function str(v: unknown, fallback: string): string {
  return typeof v === "string" && v ? v : fallback;
}

/**
 * Fold a task's flat event log into a span tree.
 *
 * Ordering is by `seq`, never by `ts`: seq is assigned by the store under a per-task counter and is
 * the only total order that exists. Timestamps come from whichever machine emitted the event.
 */
export function buildTrace(events: TaskEvent[]): Trace {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const taskId = ordered[0]?.task_id ?? "";
  const startTs = ordered[0]?.ts ?? new Date(0).toISOString();

  const root: Span = { name: "task", type: "step", start_ts: startTs, status: "running", children: [] };
  const totals: TraceTotals = {
    duration_ms: 0,
    tool_ms: {},
    tool_calls: 0,
    token_deltas: 0,
    cost_usd: 0,
    errors: 0,
  };

  // The current step. Steps have no close event of their own — `step.started` ends the previous one,
  // and `task.finished` ends the last. That end IS recorded (the step was demonstrably no longer
  // active), unlike a tool call with no result, which we refuse to invent an end for.
  let step: Span | undefined;
  const parent = () => step ?? root;

  // Open tool calls, keyed by tool name.
  //
  // THE CORRELATION FIELD IS `data.tool`. There is no call id anywhere in the kernel: runtime.ts
  // emits `{ tool, args }` and `{ tool, ok }`, the read/action/workflow proxies emit `{ tool, … }`.
  // So pairing is LIFO by name — correct for sequential calls, which is what OpenCode does, and
  // wrong only if the same tool is ever in flight twice at once. Documented rather than faked.
  const openTools = new Map<string, Span[]>();
  const openApprovals = new Map<string, Span>();

  /**
   * The one generation span currently accumulating deltas.
   *
   * A token-heavy run emits THOUSANDS of `token.delta` rows — one per streamed chunk. One span each
   * would make the tree unreadable and the JSON enormous for zero information: the useful facts are
   * when generation started, when it stopped, and how much came out. So they collapse into a single
   * span per step with a count.
   */
  let generation: Span | undefined;
  const flushGeneration = () => {
    if (generation) generation.status = "ok";
    generation = undefined;
  };

  const closeStep = (ts: string) => {
    flushGeneration();
    if (step) close(step, ts, step.children.some((c) => c.status === "error") ? "error" : "ok");
    step = undefined;
  };

  for (const ev of ordered) {
    const d = (ev.data ?? {}) as Record<string, unknown>;
    switch (ev.type) {
      case "task.created": {
        root.name = `${str(d.wedge, "task")}:${str(d.task_type, "run")}`;
        break;
      }

      case "step.started": {
        closeStep(ev.ts);
        step = { name: str(d.step, "step"), type: "step", start_ts: ev.ts, status: "running", children: [] };
        root.children.push(step);
        break;
      }

      case "tool.called": {
        const name = str(d.tool, "tool");
        const span: Span = {
          name,
          type: "tool",
          start_ts: ev.ts,
          status: "running",
          children: [],
          preview: d.args === undefined ? undefined : redactPreview(d.args),
        };
        flushGeneration(); // a tool call ends the burst of text that led to it
        parent().children.push(span);
        (openTools.get(name) ?? openTools.set(name, []).get(name)!).push(span);
        totals.tool_calls++;
        break;
      }

      case "tool.result": {
        const name = str(d.tool, "tool");
        const ok = d.ok !== false;
        const error = ok ? undefined : str(d.error ?? d.detail, "tool failed");
        const span = openTools.get(name)?.pop();
        if (span) {
          close(span, ev.ts, ok ? "ok" : "error", error);
          totals.tool_ms[name] = (totals.tool_ms[name] ?? 0) + (span.duration_ms ?? 0);
        } else {
          // The action proxy emits `tool.result` with no matching `tool.called` — the call was
          // announced as an approval instead. Render it as an instantaneous span rather than
          // dropping it; a sent email is the most important thing on the timeline.
          const orphan: Span = { name, type: "tool", start_ts: ev.ts, status: "running", children: [] };
          close(orphan, ev.ts, ok ? "ok" : "error", error);
          parent().children.push(orphan);
          totals.tool_calls++;
        }
        if (!ok) totals.errors++;
        break;
      }

      case "token.delta": {
        totals.token_deltas++;
        if (!generation) {
          generation = {
            name: "generation",
            type: "generation",
            start_ts: ev.ts,
            status: "running",
            children: [],
            token_deltas: 0,
          };
          parent().children.push(generation);
        }
        generation.token_deltas = (generation.token_deltas ?? 0) + 1;
        // Extended on every delta, so the span's end is the last chunk actually seen — which is what
        // makes a truncated stream show the time it really ran instead of nothing.
        close(generation, ev.ts, "running");
        break;
      }

      case "approval.requested": {
        const id = str(d.approval_id, `approval-${ev.seq}`);
        const span: Span = {
          name: str(d.action, "approval"),
          type: "approval",
          start_ts: ev.ts,
          status: "running",
          children: [],
          // Already redacted at the gate (actions.ts), but re-running it is idempotent and means a
          // trace can't leak through a preview written by some future caller that forgot.
          preview: d.preview === undefined ? undefined : redactPreview(d.preview),
        };
        flushGeneration();
        parent().children.push(span);
        openApprovals.set(id, span);
        break;
      }

      case "approval.resolved": {
        const id = str(d.approval_id, "");
        const span = openApprovals.get(id);
        openApprovals.delete(id);
        const decision = str(d.decision, "approved");
        const ok = decision === "approved" || decision === "auto_approved";
        if (span) {
          close(span, ev.ts, ok ? "ok" : "error", ok ? undefined : decision);
          span.name = `${span.name} — ${decision}`;
        }
        if (!ok) totals.errors++;
        break;
      }

      case "output.validated": {
        if (d.ok === false) totals.errors++;
        break;
      }

      case "cost.charged": {
        const usd = Number(d.cost_usd);
        if (Number.isFinite(usd)) totals.cost_usd += usd;
        break;
      }

      case "task.finished": {
        closeStep(ev.ts);
        const status = str(d.status, "succeeded");
        const ok = status === "succeeded";
        close(root, ev.ts, ok ? "ok" : "error", ok ? undefined : str(d.error, status));
        if (!ok) totals.errors++;
        break;
      }

      // artifact.created / progress / feedback.recorded carry no span of their own. They belong on
      // the flat timeline the portal already renders; duplicating them here would only add noise.
      default:
        break;
    }
  }

  // Not flushed to "ok" when the run never finished: a stream cut off mid-answer is still running
  // as far as anything recorded knows.
  if (root.status !== "running") flushGeneration();
  totals.cost_usd = Number(totals.cost_usd.toFixed(6));
  const lastTs = ordered[ordered.length - 1]?.ts;
  totals.duration_ms = root.duration_ms ?? (lastTs ? elapsed(startTs, lastTs) : 0);

  return { task_id: taskId, root, totals, event_count: ordered.length };
}
