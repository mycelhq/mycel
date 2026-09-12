import type { WedgeManifest, WedgeTaskType } from "./wedge";

/**
 * Which resume the author declared for an ask raised by this job.
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS IS NOT JUST `task_types[t].waits_for`
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * In production, three task types raise every client ask there has ever been:
 *
 *     books-keeper:monthly_close        26 asks, 19 still open
 *     geo-monitor:weekly_report          4 asks,  4 still open
 *     books-keeper:deliverable_verdict   2 asks,  2 still open
 *
 * None of them declares a `waits_for`. `chase_receipts` — the ONE job in the whole repo that does —
 * has raised zero. So the wait machinery is complete, correct, and wired to a job nobody runs, while
 * the jobs that do run raise asks that nothing can ever resume. Fifty-one asks, three answered, and
 * answering them did nothing either.
 *
 * The authoring contract's `no-self-resume` rule is right and stays: asking is a stage, and a job
 * that resumes itself re-asks the question the client just answered. The intended shape is
 * `chase_receipts` (asks) → `monthly_close` (works), and books-keeper declares exactly that.
 *
 * What the manifest did not anticipate is that `monthly_close` is the SCHEDULED job. It runs first,
 * discovers halfway through that the bank statement is missing, and raises the ask itself — which is
 * the reasonable thing for it to do and leaves it with no declared resume.
 *
 * So: fall back to the resume the author declared INTO this job. `chase_receipts` says "when a
 * client answers a chase, resume `monthly_close`". A `monthly_close` run raising that same ask wants
 * that same resume. This reads the author's stated intent rather than inventing a rule — and it can
 * only ever resume a job the author already named as a resume target.
 */
export interface WaitDeclaration {
  spec: { on: string; resume: string; reason: string };
  /** Which task type's manifest entry this came from. `undefined` when it is the job's own. */
  inheritedFrom?: string;
}

export function declaredWaitFor(
  manifest: WedgeManifest | undefined,
  taskType: string,
): WaitDeclaration | undefined {
  const own = manifest?.task_types?.[taskType]?.waits_for;
  if (own && own.on === "client_request") return { spec: own };

  /**
   * The sibling that names this job as its resume. Deterministic when there are several: sorted, so
   * two kernels reading the same manifest arm the same wait. Several would itself be an authoring
   * smell, and picking the first alphabetically is a stable answer rather than a correct one.
   */
  const siblings = (Object.entries(manifest?.task_types ?? {}) as [string, WedgeTaskType][])
    .filter(([name, s]) => name !== taskType && s?.waits_for?.on === "client_request" && s.waits_for.resume === taskType)
    .sort(([a], [b]) => a.localeCompare(b));
  const hit = siblings[0];
  return hit ? { spec: hit[1].waits_for!, inheritedFrom: hit[0] } : undefined;
}

/**
 * An ask nobody can act on.
 *
 * Raised when a run asks the client for something and neither its own manifest entry nor any sibling
 * says what to do with the answer. The ask still goes out — a run that needs a bank statement needs
 * it, and refusing here would trade a stuck engagement for a broken one — but it is a dead ask, and
 * it was silent. Nineteen of them are sitting in production right now.
 */
export function deadAskWarning(wedge: string, taskType: string, ask: string): string {
  return (
    `[mycel] ${wedge}:${taskType} asked the client for "${ask.slice(0, 60)}" but declares no ` +
    `waits_for, and no sibling job names it as a resume — so answering it will start nothing. ` +
    `Give the asking job \`waits_for: { on: "client_request", resume: "<the job that does the ` +
    `work>" }\`.`
  );
}
