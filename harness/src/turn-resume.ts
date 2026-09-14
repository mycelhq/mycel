// Resuming a TURN after a transient provider failure — which is not retrying the task.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// WHERE THIS CAME FROM, AND WHY IT IS THE ONE RECOVERY MOVE THAT IS SAFE
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// Taken from a comparable runtime's `turn-auto-resume.ts` — the single best idea we found reading their
// repo. Every engineering decision below is theirs; each one is a mistake we would otherwise have
// made once first, in production, on somebody's client.
//
// The problem it solves: a root turn dies mid-stream from something that has nothing to do with the
// work — an upstream idle timeout, a connection reset, a 5xx after the model client's own retries.
// `runtime.ts` correctly refuses to report success on a partial stream, so today that is a failed
// task, and a wedged provider host means a founder's client sees nothing.
//
// The obvious fix is forbidden. `queue.ts` is `maxAttempts: 1` for a documented reason: a run past
// the approval gate may already have sent an email or moved money, so re-running the TASK could send
// it twice. That constraint is right and this does not touch it.
//
// **Resuming the turn is not retrying the task.** It continues the same session, with the same
// context, the same already-executed tool calls and the same approval history. Nothing is replayed;
// the model is asked to carry on from where it stopped. That is the only recovery compatible with
// `maxAttempts: 1`, which is exactly why it is worth the care below.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// THE FOUR DECISIONS THAT MAKE IT SAFE
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
//  1. A ROLLING BUDGET, NOT A COUNTER. Their header names the bug: a failed turn can end in `idle`
//     as well as `error`, so a counter that resets on idle re-arms on every failure and retries for
//     ever. A window of timestamps cannot be re-armed by anything the session does.
//
//  2. A CLASSIFIER THAT FAILS TOWARD SURFACING. Anything not recognised as transient is permanent.
//     A retry of a permanent error fails identically and burns the budget twice, and the founder
//     waits three backoffs to see an error that was true immediately.
//
//  3. ALL 4xx EXCEPT 408 AND 429 ARE PERMANENT. A 400 is the caller's to fix. This is the rule most
//     likely to be got wrong by treating "it failed, try again" as a general truth.
//
//  4. A KILL SWITCH. `MYCEL_TURN_RESUME=0`.
//
// What is NOT taken: their re-check of the session's last message after the backoff, which exists
// because their daemon serves an interactive product where a human may prompt again during the 45
// seconds. A Mycel run has exactly one prompter and it is the kernel, so there is no second writer
// to lose a race with. Said out loud rather than silently dropped — if steering ever becomes
// concurrent with a resume, this is the line that has to come back.

/** Off with `MYCEL_TURN_RESUME=0`. Anything else, including unset, is on. */
export const resumeEnabled = (): boolean => process.env.MYCEL_TURN_RESUME !== "0";

/** Three inside fifteen minutes. Their numbers, and the backoff is theirs too. */
export const MAX_RESUMES = 3;
export const RESUME_WINDOW_MS = 15 * 60_000;
export const BACKOFF_MS = [5_000, 15_000, 45_000] as const;

/**
 * Errors that are worth continuing through.
 *
 * By NAME first, because two of them are decisions rather than failures and no message regex should
 * ever be allowed to override that:
 *
 *   · an abort is somebody cancelling — resuming it would restart work a human stopped, which is the
 *     worst possible outcome of a recovery mechanism;
 *   · an auth failure is a credential that will fail identically in five seconds, and again in
 *     fifteen, while the founder waits.
 */
const NEVER_RESUME = /abort|auth|forbidden|unauthorized|permission|credential|api key|quota exceeded|insufficient|billing/i;

/**
 * The message shapes that mean "the pipe broke", after the status code has had its say.
 *
 * A fallback rather than the primary test. Message text is the least stable thing a provider emits,
 * and a classifier that leads with it is one that silently stops working when somebody rewords an
 * error page.
 */
const TRANSIENT_TEXT =
  /idle timeout|timed? ?out|econnreset|connection reset|socket hang up|epipe|network|stream (ended|closed)|premature close|502|503|504|bad gateway|service unavailable|gateway timeout|overloaded|rate.?limit|try again/i;

/** Pull an HTTP status out of an error message when the provider put one there. */
function statusIn(text: string): number | undefined {
  const m = text.match(/\b([45]\d\d)\b/);
  return m ? Number(m[1]) : undefined;
}

/**
 * Is this worth resuming?
 *
 * Fails CLOSED — an error it does not recognise is permanent, and the run surfaces it exactly as it
 * does today. This function can only ever turn a failure into a retry of something already known to
 * be retryable; it can never suppress an error.
 */
export function isTransientTurnError(raw: string): boolean {
  const text = (raw ?? "").trim();
  if (!text) return false;
  if (NEVER_RESUME.test(text)) return false;

  const status = statusIn(text);
  if (status !== undefined) {
    // 408 Request Timeout and 429 Too Many Requests are the two 4xx that a wait genuinely fixes.
    if (status === 408 || status === 429) return true;
    if (status >= 400 && status < 500) return false;
    if (status >= 500) return true;
  }
  return TRANSIENT_TEXT.test(text);
}

/**
 * The rolling budget.
 *
 * Deliberately a plain object the caller owns for the life of one run, rather than a module-level
 * map keyed by session. A map would outlive the runs in it and would be one more piece of
 * coordination state in process memory — which `STANDARD.md` §3 has a rule against for exactly the
 * reason it gives: state that only exists in a process is state that vanishes on a deploy and takes
 * the answer with it.
 */
export interface ResumeBudget {
  /** When each resume was delivered. Timestamps, not a count — see decision 1. */
  at: number[];
}

export const newResumeBudget = (): ResumeBudget => ({ at: [] });

/**
 * How long to wait before the next resume, or `undefined` when the budget is spent.
 *
 * `now` is a parameter so this is testable without a clock, which matters: the window logic is the
 * part most likely to be subtly wrong and it is invisible at run time.
 */
export function nextResumeDelay(budget: ResumeBudget, now = Date.now()): number | undefined {
  // Drop everything outside the window FIRST — that is what makes it rolling rather than a counter.
  budget.at = budget.at.filter((t) => now - t < RESUME_WINDOW_MS);
  if (budget.at.length >= MAX_RESUMES) return undefined;
  return BACKOFF_MS[budget.at.length] ?? BACKOFF_MS[BACKOFF_MS.length - 1];
}

/** Record that one was delivered. Called only after the prompt actually goes out. */
export const noteResume = (budget: ResumeBudget, now = Date.now()): void => {
  budget.at.push(now);
};

/**
 * What the model is told.
 *
 * The two instructions that matter are the last two, and they are the difference between a resume
 * and a redo: check what was cut off, and do not repeat work that already succeeded. A model told
 * only "continue" will cheerfully re-run the tool call it just completed — which, for a run that
 * holds an action grant, is how one email becomes two.
 */
export function resumePrompt(reason: string): string {
  return (
    `Your previous response was interrupted by a transient provider error (${reason.slice(0, 200)}). ` +
    `Resume from where it stopped: work out which step or tool call was cut off, re-run that one ` +
    `only if it did not complete, and carry on to the original goal. ` +
    `Do NOT redo work that already succeeded, and do not start the task again.`
  );
}
