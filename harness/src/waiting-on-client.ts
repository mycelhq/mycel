// A SCHEDULE THAT ALREADY ASKED MUST WAIT. IT MUST NOT ASK AGAIN.
//
// ═══ THE MEASUREMENT THIS EXISTS FOR ═══
//
// Fourteen days of production, real runs only:
//
//   · 3,077 `monthly_close` runs across TWO engagements. One every 31 minutes. Every one of them
//     refused for the same missing bank statement. $22.90.
//   · 1,924 artifacts asked for an input against 138 that were work — fourteen asks per unit of
//     output.
//   · 90% of model spend went to runs that produced no deliverable, across 6,159 runs that all
//     SUCCEEDED. A run that succeeds and delivers nothing is invisible in every other metric:
//     status green, cost logged, no error anywhere.
//
// The model behaved correctly every single time. It was asked to close a month, it had no
// statement, it asked for one, and it stopped. Then the clock fired again.
//
// ═══ WHY THE CHECK IS HERE AND NOT IN THE INPUT SCHEMA ═══
//
// The obvious fix is to refuse the task at creation when its declared inputs are unsatisfied, and
// `inputFaults` already does exactly that on `POST /v1/tasks`. It does not help, and the reason is
// worth writing down because it is the difference between a plausible fix and a real one.
//
// `monthly_close` REQUIRES exactly one field: `period`. `transactions` — the ledger — and
// `closing_balance_minor` — the statement — are both OPTIONAL, deliberately and correctly, because
// the run can fetch them from a connected ledger when one exists. A schedule carrying a period
// satisfies its contract completely. The contract was never violated; the WORLD was missing
// something, and a schema cannot see the world.
//
// So the question this asks is not "is this task well formed" but "did the last attempt already
// stop on something only a human can provide, and has anybody provided it yet". That is a fact
// about open requests, not about JSON.
//
// ═══ WHY A WAIT AND NOT A FAILURE ═══
//
// The same rule the sending pacer already runs on: a self-imposed hold defers, it never halts. A
// schedule that goes `disabled` because a client was slow is a schedule somebody has to remember to
// switch back on, and nobody does. This pushes `next_run_at` and leaves the schedule enabled, so
// answering the request is the only thing that has to happen for work to resume.
//
// ═══ AND WHY IT FAILS OPEN ═══
//
// Every caller catches. An unreadable request store must never stop a paying founder's clock — the
// only direction this can be wrong is to run something it could have skipped, which is what
// happens today anyway. `fireSchedule`'s plan check is written the same way for the same reason.
import type { ClientRequest } from "./contract";

/** Twenty-four hours. The floor, not the whole answer — see `backoffSeconds`. */
const DAY_S = 24 * 60 * 60;

/**
 * The longest this will ever defer a schedule.
 *
 * Seven days rather than "until answered" because a request can be abandoned — a client leaves, a
 * case dies, a founder resolves it outside the product — and a schedule that waits forever on a row
 * nobody will ever touch is indistinguishable from a schedule that is broken. At the cap it fires
 * again, which re-raises the ask against a client who has now been quiet for a week, and that is a
 * signal the founder should see rather than one this module should swallow.
 */
const MAX_BACKOFF_S = 7 * DAY_S;

export interface WaitVerdict {
  /** True when the schedule must not fire. */
  wait: boolean;
  /** What it is waiting for, in the founder's words. Empty when `wait` is false. */
  reason: string;
  /** Seconds to push `next_run_at` out by. Zero when not waiting. */
  backoffSeconds: number;
  /** The request that is holding it, so a caller can name it without a second read. */
  request?: ClientRequest;
}

const RUNNING: WaitVerdict = { wait: false, reason: "", backoffSeconds: 0 };

/**
 * Doubling from a day, capped.
 *
 * The first wait is a day because most of these are answered inside one — a client sees the email
 * in the morning. Doubling after that is not about the client, it is about cost: the fifth
 * consecutive unanswered check has a far lower chance of finding an answer than the first, and it
 * costs exactly as much.
 *
 * Pure, and takes the streak rather than reading it, so the whole ladder is one table in a test.
 */
export function backoffSeconds(streak: number): number {
  const n = Number.isFinite(streak) && streak > 0 ? Math.floor(streak) : 0;
  return Math.min(MAX_BACKOFF_S, DAY_S * 2 ** Math.min(n, 10));
}

/**
 * Whether a schedule is waiting on somebody, given the open requests in its project.
 *
 * PURE. No store, no clock. Everything it needs is passed in, which is what makes the ladder and
 * every match rule testable without a database — and this module is only worth having if its rules
 * are checked, because its failure mode is silence.
 *
 * ── WHAT COUNTS AS "THIS SCHEDULE'S ASK" ──
 *
 * Two keys, in order of precision:
 *
 *   1. `caseId` — the schedule's engagement. Any open request on that case blocks it, INCLUDING one
 *      raised by a different task. That breadth is deliberate: a close and a receipt chase on the
 *      same engagement are the same conversation to the client, and firing the close while they
 *      already owe us a statement produces a second email about the same missing thing.
 *   2. `lastTaskId` — what this schedule created last time. Used when the schedule names no case,
 *      which is most sweeps. Narrow but exact: it means "the previous run of this very schedule
 *      ended by asking".
 *
 * A schedule with neither is never held. That is not an oversight — with no case and no previous
 * run there is nothing to have asked, and blocking on "some request exists somewhere in the
 * project" would let one client's slow reply stop every other client's work.
 */
export function scheduleWait(o: {
  /** Open requests only. Filtering here rather than trusting the caller would hide a bad query. */
  open: readonly ClientRequest[];
  caseId?: string;
  lastTaskId?: string;
  /** Consecutive times this schedule has already been held. Drives the ladder. */
  streak?: number;
}): WaitVerdict {
  const open = o.open.filter((r) => r.status === "open");
  if (open.length === 0) return RUNNING;

  const held = o.caseId
    ? open.find((r) => r.case_id === o.caseId)
    : o.lastTaskId
      ? open.find((r) => r.task_id === o.lastTaskId)
      : undefined;

  if (!held) return RUNNING;

  return {
    wait: true,
    /*
      Named in the founder's language and quoting the ask itself. "Waiting on the client" is a
      status; "waiting on Kestrel Analytics for the March statement" is a thing somebody can act
      on, and the founder can always answer on the client's behalf.
    */
    reason: `waiting on an unanswered request: ${held.ask}`,
    backoffSeconds: backoffSeconds(o.streak ?? 0),
    request: held,
  };
}
