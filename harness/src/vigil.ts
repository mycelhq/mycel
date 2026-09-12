// Telling a stuck run from a patient one — the failure that hides longest, finally given a face.
//
// ═══ WHY THIS IS THE MOST DANGEROUS GAP IN THE SYSTEM ═══
//
// A failed run is red on the founder's screen within a minute. A stuck one is invisible for as long
// as anyone's patience lasts, because from the outside it is indistinguishable from work that is
// legitimately waiting — and this system waits on purpose, constantly: on a client's statement, on
// a founder's approval, on twelve probe children, on a sandbox coming up.
//
// We have already lived every variant this file names. A parent sat in `awaiting_batch` for two
// hours after all sixteen children succeeded, because the join state died with the process. A third
// of a night's runs hung on a tool result that never arrived, while the stall watchdog was being
// refreshed by heartbeats. Not one of them errored. Not one of them logged. Each was found by a
// person going looking, days or hours late.
//
// ═══ THE PRINCIPLE: EVERY WAIT MUST BE ABLE TO NAME ITS WITNESS ═══
//
// Waiting is not suspicious. Waiting WITHOUT EVIDENCE is. Each non-terminal state has a specific
// witness that justifies it:
//
//   queued / provisioning  →  youth. Pickup and sandbox boot are minutes; age alone convicts.
//   running / validating   →  a recent event. A live run speaks; silence past the in-run
//                             watchdog's own window means the watchdog died with the process.
//   awaiting_approval      →  an OPEN approval row. Decided-but-never-resumed is the lost wakeup.
//   awaiting_batch         →  an open batch with non-terminal children. All children terminal
//                             with the parent still asleep is the join that never fired.
//
// A task that cannot produce its witness is STUCK, and the verdict says which witness was missing
// — because "stuck" without "why" is a red light with no next action, and the founder's next
// action is the entire point of surfacing it.
//
// ═══ WHY PURE, WITH EVIDENCE INJECTED ═══
//
// The route gathers rows; this file judges them. The judgement is where every subtle decision
// lives (which witness, which threshold, which sentence), so it is the part that must be testable
// without a database — and the part that must never be able to hide a wrong threshold behind a
// query. Same split as client-mind: gathering is plumbing, judging is the product.

import type { TaskStatus } from "./contract";

/** What the gatherer could find out about one non-terminal task. All optional except identity. */
export interface Evidence {
  task_id: string;
  status: TaskStatus;
  /** ms since the task was created. */
  ageMs: number;
  /** ms since the last event on this task, if any event exists. */
  sinceLastEventMs?: number;
  /** An approval row that is still open for this task. */
  openApproval?: boolean;
  /** The batch this parent is waiting on, when one exists at all. */
  batch?: { status: string; children: number; childrenTerminal: number };
}

export type Verdict =
  | { state: "patient"; witness: string }
  | { state: "stuck"; missing: string; forFounder: string };

/**
 * Thresholds, per state, in minutes. Named and exported because they are the opinion here.
 *
 * QUEUED at 15 rather than 5: the worker drains bursts (a dunning sweep spawns 25 chases against a
 * concurrency of 4), and calling the tail of a healthy burst "stuck" teaches the founder that the
 * vigil cries wolf — which is how it ends up ignored on the day it is right.
 *
 * RUNNING at 25: the in-run watchdog fires at 15. If a run is silent past its own watchdog's
 * window, the watchdog itself went down with the process, and that is exactly what the outer net
 * exists to catch. Not tighter, because this must never race the mechanism it is backstopping.
 */
export const QUIET_LIMIT_MIN: Partial<Record<TaskStatus, number>> = {
  queued: 15,
  provisioning: 15,
  running: 25,
  validating: 25,
};

const MIN = 60_000;

export function judge(e: Evidence): Verdict {
  switch (e.status) {
    case "queued":
    case "provisioning": {
      const limit = (QUIET_LIMIT_MIN[e.status] ?? 15) * MIN;
      if (e.ageMs <= limit) return { state: "patient", witness: "young enough that pickup is still normal" };
      return {
        state: "stuck",
        missing: "a worker ever picking it up",
        forFounder:
          `This run has been waiting to start for ${Math.round(e.ageMs / MIN)} minutes. ` +
          `Nothing is working on it and nothing will — it was likely dropped by a restart. Safe to run again: it never started, so nothing was sent or charged.`,
      };
    }

    case "running":
    case "validating": {
      const limit = (QUIET_LIMIT_MIN[e.status] ?? 25) * MIN;
      // No events at all on a "running" task is the same silence, aged from the start.
      const quiet = e.sinceLastEventMs ?? e.ageMs;
      if (quiet <= limit) return { state: "patient", witness: "spoke recently — a live run produces events" };
      return {
        state: "stuck",
        missing: "any event inside its own watchdog's window",
        forFounder:
          `This run has said nothing for ${Math.round(quiet / MIN)} minutes — past the point where its own ` +
          `stall detector should have ended it, which means that detector died with the process. It will not finish. ` +
          `It was mid-flight, so check what it may have already sent before re-running it.`,
      };
    }

    case "awaiting_approval": {
      if (e.openApproval) return { state: "patient", witness: "an approval is genuinely open and waiting on a person" };
      return {
        state: "stuck",
        missing: "an open approval row",
        forFounder:
          "This run is waiting for an approval that no longer exists — it was decided (or lost) and the wake-up " +
          "never reached the run. Nothing you approve now will resume it; it needs to be re-run.",
      };
    }

    case "awaiting_batch": {
      if (!e.batch) {
        return {
          state: "stuck",
          missing: "any batch row at all",
          forFounder:
            "This run split itself into smaller jobs and the record of that split is gone. The children may even " +
            "have finished; the parent can never find out. Re-run it — the fan-out is idempotent from the top.",
        };
      }
      const allDone = e.batch.children > 0 && e.batch.childrenTerminal >= e.batch.children;
      if (e.batch.status === "open" && !allDone) {
        return {
          state: "patient",
          witness: `waiting on ${e.batch.children - e.batch.childrenTerminal} of ${e.batch.children} children still working`,
        };
      }
      // Batch joined, or every child terminal under an open batch: the parent should be awake.
      return {
        state: "stuck",
        missing: "the join ever waking the parent",
        forFounder:
          `Every one of its ${e.batch.children} sub-jobs finished and the main run never woke up — the exact ` +
          "two-hour stall this check was built after. The children's work is saved; re-running the parent will find it.",
      };
    }

    default:
      // Terminal states are not this file's business; a gatherer that sends one gets a calm answer
      // rather than a throw, because the vigil must never be the thing that crashes the sweep.
      return { state: "patient", witness: "not a waiting state" };
  }
}

/** The report: stuck first, then a one-line count of the patient, because the founder reads down. */
export function report(verdicts: { task_id: string; status: TaskStatus; verdict: Verdict }[]): {
  stuck: { task_id: string; status: TaskStatus; missing: string; forFounder: string }[];
  patient: number;
  headline: string;
} {
  const stuck = verdicts
    .filter((v): v is typeof v & { verdict: Extract<Verdict, { state: "stuck" }> } => v.verdict.state === "stuck")
    .map((v) => ({ task_id: v.task_id, status: v.status, missing: v.verdict.missing, forFounder: v.verdict.forFounder }));
  const patient = verdicts.length - stuck.length;
  const headline = stuck.length
    ? `${stuck.length} run(s) are stuck — waiting with no witness — and ${patient} are genuinely waiting.`
    : `All ${patient} waiting run(s) can name what they are waiting for.`;
  return { stuck, patient, headline };
}
