// Reading the client's recent history, so `mayTouch` has something to decide against.
//
// ── WHY THERE IS NO NEW TABLE ─────────────────────────────────────────────────────────────────
//
// The obvious build is a `client_touches` ledger written on every send. It would also be a second
// source of truth that can drift from the first: a touch that was spawned but whose ledger write
// failed is invisible to the budget, and the client gets the extra email the budget existed to
// prevent.
//
// `public.tasks` already records exactly this. Every client-facing action IS a task, with a
// `client_id`, a `task_type` and a `created_at`. Reading it means the budget is computed from the
// same rows that caused the touches, so the two cannot disagree — there is nothing to keep in sync.
//
// The cost is one indexed query per decision. That is the correct price for not having a
// reconciliation problem forever.
//
// ── WHY IT COUNTS SPAWNED, NOT DELIVERED ──────────────────────────────────────────────────────
//
// A task that was created counts against the budget even if its send later failed. That is
// deliberate and it is the safe direction: the alternative is a retry storm where every failure
// frees a slot, so a broken mailbox produces MORE attempts at the client rather than fewer.
//
// It means a genuinely failed send can cost the client a quiet slot for a day. That is a smaller
// harm than the storm, and it is visible in the task row rather than hidden.

import { mayTouch, TOUCH_FOR_TASK, type Touch, type Verdict, type Policy } from "./client-touch";

/** The minimum database surface this needs. */
export interface Queryable {
  query: (text: string, values?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }>;
}

/** Task types that reach a client, taken from the map rather than restated. */
export const TOUCH_TASK_TYPES = Object.keys(TOUCH_FOR_TASK);

/**
 * Every initiated touch to this client in the last day, newest first.
 *
 * ACROSS EVERY WEDGE, which is the entire point — the query filters on the client, never on the
 * wedge, so geo-monitor sees what invoice-chaser did. A per-wedge version of this would reproduce
 * the exact blindness the budget exists to fix.
 */
export async function recentTouches(db: Queryable, clientId: string): Promise<Touch[]> {
  if (!clientId) return [];
  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════════════
   * A RUN THAT NEVER TRIED TO REACH ANYONE IS NOT A TOUCH
   * ═══════════════════════════════════════════════════════════════════════════════════════════════
   *
   * MEASURED IN PRODUCTION, and it deadlocked the product:
   *
   *   3,103 `monthly_close` runs in thirty days. Exactly ONE attempted any outbound action.
   *
   * `monthly_close` is a `report` in `TOUCH_FOR_TASK`, so all 3,103 counted against a budget of two
   * per day. Fairmont Dental accumulated 58 in a single day, Willow & Pine 55, and every
   * `nudge_client_request` for those clients was refused with `day_full` — for weeks. Which is why
   * 51 asks were raised and none were ever chased.
   *
   * And it was circular. `fulfillment-ignite` re-started the close BECAUSE the case had unanswered
   * asks; each close ate the budget that would have let us chase them; so they stayed unanswered.
   * A loop that fed itself, in which the symptom was also the cause.
   *
   * ═══ THE FILTER, AND WHY IT DOES NOT WEAKEN THE STATED RULE ═══
   *
   * The note above says a touch "counts against the budget even if its send LATER FAILED", to stop
   * a retry storm where every failure frees a slot. That still holds exactly: the operative words
   * are ITS SEND. A run that never attempted one has no send to have failed.
   *
   * An approval row is the honest test, and it is not a proxy. NOTHING outbound happens in this
   * kernel without one — `awaitApproval` writes one before it suspends and `recordAutoApproval`
   * writes one for work that does not need to wait. Any status counts: approved, auto_approved,
   * pending, rejected, expired. So a send that was queued and refused still costs the slot, and
   * 3,102 runs that spoke to nobody no longer do.
   *
   * THE RACE IS DELIBERATE AND SMALL. A run in flight that is about to send has not written its
   * approval yet, so for those seconds it does not count and a second touch could slip past. The
   * four-hour `minGapMs` makes the window irrelevant in practice, and the alternative — counting
   * intent — is the bug this replaces.
   */
  const res = await db.query(
    `SELECT t.task_type, t.wedge, t.created_at
       FROM public.tasks t
      WHERE t.client_id = $1
        AND t.task_type = ANY($2)
        AND t.created_at > now() - interval '1 day'
        AND EXISTS (
          SELECT 1 FROM public.approvals a WHERE a.task_id::text = t.id::text
        )
      ORDER BY t.created_at DESC`,
    [clientId, TOUCH_TASK_TYPES],
  );
  // An explicit loop rather than map+filter with a type predicate: the predicate does not narrow
  // through `res.rows` being `any[]`, and a cast to make it compile would hide exactly the shape
  // mismatch this is meant to catch.
  const out: Touch[] = [];
  for (const r of (res.rows ?? []) as { task_type: string; wedge?: string; created_at: Date | string }[]) {
    const kind = TOUCH_FOR_TASK[r.task_type];
    if (!kind) continue;
    out.push({ kind, at: new Date(r.created_at).getTime(), wedge: r.wedge });
  }
  return out;
}

/**
 * The whole decision, for a caller that has a client and a task type.
 *
 * NO CLIENT MEANS NO BUDGET. Internal work — an ops tick, a probe, a build — has no client to
 * protect, and refusing it would stall the machine for nobody's benefit. The `mayTouch` call still
 * happens so responsive and unmapped types get their answer from one place.
 */
export async function checkClientTouch(
  db: Queryable,
  args: { taskType: string; clientId?: string | null; pending?: Parameters<typeof mayTouch>[3] },
  now = Date.now(),
): Promise<Verdict> {
  if (!args.clientId) return mayTouch(args.taskType, [], now, args.pending);
  const recent = await recentTouches(db, args.clientId);
  return mayTouch(args.taskType, recent, now, args.pending);
}

/**
 * A line for the log when a touch is held.
 *
 * Written as a sentence a founder can read, because this is a decision the PRODUCT made on their
 * behalf about their own client and they are entitled to know why. A budget that defers silently is
 * indistinguishable from a bug, and the founder's first instinct will be that the system is broken.
 */
export function heldLine(taskType: string, clientId: string, v: Verdict): string | null {
  if (v.allow) return null;
  const when = new Date(v.retryAfter).toISOString();
  return `[mycel] held ${taskType} for client ${clientId}: ${v.detail} — retries after ${when}`;
}

export type { Policy, Verdict };
