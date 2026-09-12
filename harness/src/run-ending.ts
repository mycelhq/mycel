/**
 * NOTHING IS NOT AN ALLOWED ENDING.
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * THE INVARIANT, AND WHY IT HAS TO BE ONE
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * openwork's `session-admission-outcome.ts` is 102 lines and the best piece of UX engineering in
 * that repository. It states one rule:
 *
 *   Every user message the session accepts must end in one of: assistant output followed by idle, a
 *   pending question or permission wait, an explicit error the error card owns, or a bounded
 *   "accepted but execution outcome unknown" recovery state. PLAIN IDLE WITH NO ASSISTANT RESULT
 *   MUST NEVER SILENTLY CLEAR THE TASK.
 *
 * The bug it was written for: an appended user message alone satisfied a transcript-length check, so
 * the waiting state vanished after ~1.2s with no assistant message, no error and no recovery action.
 * Somebody asked for something and the interface went quiet.
 *
 * OUR VERSION OF PLAIN IDLE is a run that reaches `succeeded` and leaves nothing anybody can point
 * at. Measured over fourteen days: 6,559 runs succeeded and 2,065 of them produced no artifact and
 * no deliverable version. Most are legitimate — `begin_fulfillment` opens an engagement, a chase
 * sends an email, and neither is a file — which is exactly why the answer is to NAME the ending
 * rather than to alarm on it. An ending with a name can be read, counted and argued with. Silence
 * cannot, and silence is what 1,848 `begin_fulfillment` runs currently produce on the work page:
 * `RunOutcome` returns null for `succeeded`, so a run that did nothing visible renders nothing at
 * all, which is indistinguishable from a run that did everything right.
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS DOES NOT JUDGE
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * It would be easy to make `nothing_visible` a fault. It is not one. Whether a run SHOULD have
 * produced something is a question about the task type's contract, and answering it here would flag
 * one thousand eight hundred correct engagement-openings as defects — which is how a signal gets
 * switched off in its first week.
 *
 * The claim is narrower and holds without argument: the founder is told which of these happened,
 * always. What they do about it is theirs.
 *
 * PURE. Counts in, an ending out. No store, no network — so the rule is testable without either.
 */

export type RunEnding =
  | "delivered"
  | "filed"
  | "asked"
  | "parked"
  | "acted"
  | "recorded"
  | "nothing_visible"
  | "failed";

/** What a finished run left behind. Every field is a count the caller already has or can cheaply get. */
export interface RunTraces {
  /** Terminal status from the task row. Anything not `succeeded` ends the question immediately. */
  status: string;
  /** Versions submitted against a deliverable. The strongest ending there is. */
  versions?: number;
  /** Files written. A pack of renders with no deliverable row is still work a founder can open. */
  artifacts?: number;
  /** Client asks raised. Parked ON PURPOSE, and the opposite of nothing. */
  requests?: number;
  /** Waits armed. Same. */
  waits?: number;
  /** Outward actions taken — a message sent, an invoice raised, a sequence advanced. */
  actions?: number;
  /** Records or knowledge written. The weakest visible ending, and still an ending. */
  records?: number;
}

const n = (v: number | undefined) => (Number.isFinite(v) ? Math.max(0, Number(v)) : 0);

/**
 * The one ending this run had.
 *
 * ORDERED BY WHAT A FOUNDER WOULD SAY IT DID. A run that submitted a version and also wrote a record
 * "produced the report"; saying it "wrote a record" would be true and useless. So the first match
 * wins, strongest first, and the order is the claim this function actually makes.
 */
export function runEnding(t: RunTraces): RunEnding {
  // Not our question. A failed run already has a named outcome and a card that owns it.
  if (t.status !== "succeeded") return "failed";
  if (n(t.versions) > 0) return "delivered";
  if (n(t.artifacts) > 0) return "filed";
  if (n(t.requests) > 0) return "asked";
  if (n(t.waits) > 0) return "parked";
  if (n(t.actions) > 0) return "acted";
  if (n(t.records) > 0) return "recorded";
  return "nothing_visible";
}

/**
 * What the founder reads. Second person, no jargon, and every one of them says what to do next or
 * why there is nothing to do.
 *
 * `nothing_visible` is deliberately not an apology and not an alarm. Most of them are correct, and a
 * sentence that implied a fault would train a founder to distrust the seven that are not.
 */
export const ENDING_SAID: Record<RunEnding, string> = {
  delivered: "Produced a new version of the work.",
  filed: "Wrote files you can open.",
  asked: "Stopped and asked your client something.",
  parked: "Parked, waiting on something that has not arrived.",
  acted: "Did something outward — a message, an invoice, a step in a sequence.",
  recorded: "Wrote down what it learned. Nothing was produced for a client.",
  nothing_visible: "Finished without producing anything you can see.",
  failed: "Did not finish.",
};

/** True for the one ending that must never render as silence. Used by the surfaces, not by a gate. */
export function endedQuietly(e: RunEnding): boolean {
  return e === "nothing_visible";
}
