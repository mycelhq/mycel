// "You have approved this eight times without touching it" — the proposer standing.ts said should
// exist, built.
//
// ═══ THE DIVISION OF AUTHORITY ═══
//
// standing.ts, property 1: "NEVER INFERRED. There is no code path anywhere that creates one of
// these from observed behaviour. `suggestWidening` in autonomy.ts proposes; a human writes."
//
// This module is the proposing half for the APPROVAL gate, and it keeps that property intact: its
// output is a draft and a sentence of evidence. It writes nothing. The only way a suggestion
// becomes authority is the founder POSTing it to /v1/standing themselves, through the same route,
// with the same owner/admin check and the same member identity, as a grant they typed by hand.
//
// (`suggestWidening` itself, for comparison, had zero callers when this was written — machinery
// with no feed, the failure this repo keeps finding. This module ships WITH its route and tests.)
//
// ═══ WHAT COUNTS AS EVIDENCE ═══
//
// Only human decisions. `auto_approved` rows are excluded at the query (see
// `decidedApprovalsForProject`): a suggester that counted the policy engine's own approvals would
// be learning from itself — the check-confirming-its-own-answer failure, wearing a new hat.
//
// An approval the founder EDITED before approving counts against, not for. "Approved, but only
// after I fixed it" is the founder doing the work the agent should have; automating that send
// would ship the unfixed version. The streak is consecutive UNTOUCHED approvals, newest first,
// and one edit or rejection resets it to zero.
//
// ═══ WHY THE SHAPE OF A SUGGESTION IS NARROW ═══
//
//   · Per (action, client), never per action alone. standing.ts calls the all-clients grant "a much
//     larger thing to grant", so the machine never proposes it — a founder can still write one.
//   · Never for an action that carried `high` risk in the window, even once. matchStanding would
//     refuse those uses anyway (risk is recomputed per use); proposing a grant that exists to be
//     refused trains the founder to distrust suggestions.
//   · The ceiling comes from observed volume with headroom, clamped to HARD_MAX_USES_PER_DAY.
//     A grant that is narrower than the traffic it covers just re-raises approvals — annoying;
//     a grant wider than observed traffic is authority nobody demonstrated a need for — worse.

import type { DecidedApproval } from "./store";
import { HARD_MAX_USES_PER_DAY, MAX_GRANT_DAYS, type StandingGrant, isLive } from "./standing";

/** Consecutive untouched approvals before the machine speaks up. Eight — the "eighth Friday" from
 *  standing.ts's own header: the point at which consent has visibly become training. */
export const MIN_STREAK = 8;

export interface GrantSuggestion {
  action: string;
  client_id: string;
  /** Proposed ceiling, observed + headroom, clamped. The founder may lower it; the route clamps again. */
  max_uses_per_day: number;
  expires_days: number;
  /** The evidence, as one sentence the founder reads before deciding. */
  because: string;
  /** The numbers behind the sentence, for a UI that wants to show its work. */
  evidence: { streak: number; total: number; edited: number; rejected: number; window_days: number };
}

/**
 * Draft the grants this decision stream has earned. Pure — no store, no clock reads beyond `now`.
 *
 * `rows` must be newest-first (both stores return them that way).
 */
export function suggestStandingGrants(
  rows: readonly DecidedApproval[],
  existing: readonly StandingGrant[],
  now: Date = new Date(),
): GrantSuggestion[] {
  const windowDays = 60;
  const cutoff = new Date(now.getTime() - windowDays * 86_400_000).toISOString();

  // A live grant already covering (action, client) — or that action for ALL clients — silences the
  // suggestion. Suggesting what is already granted is noise, and noise is the failure mode this
  // whole feature exists to reduce.
  const covered = (action: string, client: string): boolean =>
    existing.some(
      (g) =>
        isLive(g, now) &&
        g.action.toLowerCase() === action.toLowerCase() &&
        (!g.client_id || g.client_id === client),
    );

  const groups = new Map<string, DecidedApproval[]>();
  for (const r of rows) {
    if (r.decided_at < cutoff) continue;
    // No client, no suggestion. The machine only proposes the narrow form — see the header.
    if (!r.client_id) continue;
    const key = `${r.action.toLowerCase()}\u0000${r.client_id}`;
    const list = groups.get(key);
    if (list) list.push(r);
    else groups.set(key, [r]);
  }

  const out: GrantSuggestion[] = [];
  for (const list of groups.values()) {
    const { action, client_id } = list[0]! as { action: string; client_id: string };
    if (covered(action, client_id)) continue;
    if (list.some((r) => r.risk === "high")) continue;

    let streak = 0;
    for (const r of list) {
      // Newest first: the streak is what has happened LATELY, so old rejections a founder has
      // since changed their mind about do not block forever — they just have to be outweighed by
      // a fresh unbroken run.
      if (r.status === "approved" && !r.edited) streak++;
      else break;
    }
    if (streak < MIN_STREAK) continue;

    const rejected = list.filter((r) => r.status === "rejected").length;
    const edited = list.filter((r) => r.status === "approved" && r.edited).length;

    // Observed busiest day + half again, so an ordinary Tuesday never re-raises the gate the
    // founder just closed. Clamped: no suggestion may exceed what a hand-written grant may hold.
    const byDay = new Map<string, number>();
    for (const r of list) {
      if (r.status !== "approved") continue;
      const d = r.decided_at.slice(0, 10);
      byDay.set(d, (byDay.get(d) ?? 0) + 1);
    }
    const busiest = Math.max(1, ...byDay.values());
    const ceiling = Math.min(HARD_MAX_USES_PER_DAY, Math.max(1, Math.ceil(busiest * 1.5)));

    const days = Math.max(
      1,
      Math.round(
        (new Date(list[0]!.decided_at).getTime() - new Date(list[list.length - 1]!.decided_at).getTime()) /
          86_400_000,
      ),
    );
    out.push({
      action,
      client_id,
      max_uses_per_day: ceiling,
      expires_days: MAX_GRANT_DAYS,
      because:
        `You have approved "${action}" for this client ${streak} times in a row without changing a word` +
        (rejected || edited
          ? ` (earlier in the window: ${edited} edited, ${rejected} rejected)`
          : "") +
        `. Want these to stop waiting on you? Each one still lands in the queue, named and revocable.`,
      evidence: { streak, total: list.length, edited, rejected, window_days: windowDays },
    });
  }

  // The longest-earned first: the suggestion the founder is most likely to want is the one they
  // have been paying the most attention-tax on.
  return out.sort((a, b) => b.evidence.streak - a.evidence.streak);
}
