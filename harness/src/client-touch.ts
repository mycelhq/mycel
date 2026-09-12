// The floor manager: how often ONE client hears from the business, across every wedge at once.
//
// ── THE GAP THIS CLOSES ───────────────────────────────────────────────────────────────────────
//
// Every concurrency guard in this kernel is VERTICAL. `FOR UPDATE SKIP LOCKED` stops two replicas
// claiming one schedule. `productionInFlight` stops two production runs on one case. The audit
// chain locks its own head. All correct, and all about the same piece of work being done twice.
//
// Nothing is HORIZONTAL. No wedge knows another wedge exists — a grep for sibling awareness returns
// nothing — and there is no per-project or per-client ceiling anywhere. Seven wedges each declare
// `nudge_client_request`, `check_in_case` and `deliverable_verdict`, and they all reach the same
// human.
//
// So for one agency running geo-monitor, invoice-chaser and books-keeper: a weekly report, an
// invoice chase and a document request can land on the same client in the same hour. Each is
// individually correct and correctly scheduled. Together they are three emails from one business
// before lunch, and the client experiences a company with no manners — which is precisely the
// impression this product exists to prevent.
//
// This is not a data race. It is a missing floor manager: every machine runs correctly and nobody
// sequences them.
//
// ── INITIATED VERSUS RESPONSIVE, WHICH IS THE WHOLE DESIGN ────────────────────────────────────
//
// The budget applies ONLY to touches the business chose to start. A reply to something the client
// just said is not spending attention, it is returning it — and deferring one would be rude in the
// opposite direction and far worse. A client who asks a question and gets silence because a nudge
// used up the quota is the single worst outcome this file could produce.
//
// So `deliverable_verdict` (they came back on our work) and anything answering a client message are
// RESPONSIVE and never budgeted. `nudge_client_request`, `check_in_case`, `chase_invoice`,
// `weekly_report` are INITIATED and always are.
//
// ── WHY PRIORITY, AND NOT JUST A COUNT ────────────────────────────────────────────────────────
//
// With a flat count the loser is whichever wedge happens to run second, which is arbitrary. A
// client who can hear one thing today should hear the most important one — money before a check-in,
// a delivery before a nudge. Ordering by consequence means the deferred touch is always the one
// that could wait.

/** Every kind of contact the business can initiate with a client, ordered by consequence. */
export type TouchKind =
  | "deliverable_ready"
  | "invoice_chase"
  | "document_request"
  | "report"
  | "check_in";

/**
 * What outranks what when only one may go today.
 *
 * Money and delivered work first, because those have deadlines outside our control. A check-in is
 * last because it is the one touch whose entire purpose is that nothing else was happening.
 */
export const TOUCH_PRIORITY: Record<TouchKind, number> = {
  deliverable_ready: 100,
  invoice_chase: 80,
  document_request: 60,
  report: 40,
  check_in: 10,
};

/**
 * Task type → what the client actually experiences.
 *
 * Undeclared task types are NOT touches. That is deliberate and it is the safe direction: a wedge
 * that adds a new client-facing task type is unbudgeted until someone maps it here, which risks one
 * extra email. The opposite default — treating unknown types as touches — would silently defer real
 * work for reasons nobody could find.
 */
export const TOUCH_FOR_TASK: Record<string, TouchKind> = {
  nudge_client_request: "document_request",
  chase_receipts: "document_request",
  chase_timesheet: "document_request",
  chase_invoice: "invoice_chase",
  prepare_invoice: "invoice_chase",
  send_receipt: "report",
  weekly_report: "report",
  weekly_run: "report",
  monthly_close: "report",
  check_in_case: "check_in",
};

/**
 * Task types that ANSWER the client rather than interrupt them. Never budgeted.
 *
 * Kept as an explicit set rather than inferred, because getting this wrong in the quiet direction —
 * silently deferring a reply — produces a client who thinks they were ignored, and nothing in any
 * log would say why.
 */
export const RESPONSIVE_TASKS = new Set([
  "deliverable_verdict",
  "confirm_extension",
  "answer_client_question",
]);

export interface Touch {
  kind: TouchKind;
  at: number;
  /** Which wedge sent it. Only for the explanation; the budget does not care. */
  wedge?: string;
}

export interface Policy {
  /** Initiated touches per client per rolling day. */
  perDay: number;
  /** Minimum gap between two initiated touches. */
  minGapMs: number;
}

/**
 * Two a day, four hours apart.
 *
 * TWO, not one: a business that genuinely has two things to say in a day is normal, and a ceiling of
 * one would make the product feel asleep. Not three: at three, the fourth is inevitable and the
 * client starts filtering.
 *
 * FOUR HOURS is what stops the specific failure this file exists for — three wedges whose schedules
 * happen to fire within the same hour. Spacing alone fixes the impression even when the count is
 * within budget.
 */
export const DEFAULT_POLICY: Policy = { perDay: 2, minGapMs: 4 * 60 * 60 * 1000 };

const DAY_MS = 24 * 60 * 60 * 1000;

export type Verdict =
  | { allow: true; reason: "responsive" | "within_budget" }
  | { allow: false; reason: "day_full" | "too_soon" | "outranked"; retryAfter: number; detail: string };

/**
 * May this touch go out now?
 *
 * `recent` is every INITIATED touch to this client in the last day, from every wedge. `pending` is
 * what else wants to go out in this same pass, so the highest-priority one wins rather than
 * whichever wedge the scheduler happened to reach first.
 *
 * Always returns a `retryAfter` on refusal. A deferral with no time attached is indistinguishable
 * from a drop, and a dropped client touch is invisible — nobody notices the email that never came.
 */
export function mayTouch(
  taskType: string,
  recent: Touch[],
  now: number,
  opts: { policy?: Policy; pending?: TouchKind[] } = {},
): Verdict {
  if (RESPONSIVE_TASKS.has(taskType)) return { allow: true, reason: "responsive" };

  const kind = TOUCH_FOR_TASK[taskType];
  // Not a client-facing task at all — an internal tick, a probe, a build. Nothing to budget.
  if (!kind) return { allow: true, reason: "within_budget" };

  const policy = opts.policy ?? DEFAULT_POLICY;
  const inWindow = recent.filter((t) => now - t.at < DAY_MS).sort((a, b) => b.at - a.at);

  if (inWindow.length >= policy.perDay) {
    const oldest = inWindow[inWindow.length - 1]!;
    const retryAfter = oldest.at + DAY_MS;
    return {
      allow: false,
      reason: "day_full",
      retryAfter,
      detail: `this client has already heard from us ${inWindow.length} times today (${inWindow
        .map((t) => t.kind)
        .join(", ")}); ${kind} waits`,
    };
  }

  const last = inWindow[0];
  if (last && now - last.at < policy.minGapMs) {
    return {
      allow: false,
      reason: "too_soon",
      retryAfter: last.at + policy.minGapMs,
      detail: `${Math.round((now - last.at) / 60000)} minutes since the last ${last.kind}; ${kind} waits for the gap`,
    };
  }

  // Somebody more important wants this slot in the same pass.
  const beaten = (opts.pending ?? []).filter((p) => TOUCH_PRIORITY[p] > TOUCH_PRIORITY[kind]);
  if (beaten.length > 0) {
    return {
      allow: false,
      reason: "outranked",
      retryAfter: now + policy.minGapMs,
      detail: `${beaten[0]} goes first — it matters more to this client than ${kind}`,
    };
  }

  return { allow: true, reason: "within_budget" };
}

/**
 * Order a pass so the most consequential touch goes first.
 *
 * Ties break on ARRIVAL, not on wedge name: two touches of equal priority should go out in the order
 * the work became ready, and sorting by name would silently and permanently favour whichever wedge
 * is alphabetically first.
 */
export function orderPass<T extends { taskType: string; readyAt: number }>(items: T[]): T[] {
  const rank = (t: string) => TOUCH_PRIORITY[TOUCH_FOR_TASK[t] ?? "check_in"] ?? 0;
  return [...items].sort((a, b) => rank(b.taskType) - rank(a.taskType) || a.readyAt - b.readyAt);
}
