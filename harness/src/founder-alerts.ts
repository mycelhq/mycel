/**
 * Telling a founder, ONCE, that their client accepted the work.
 *
 * ── WHY THIS IS THE MOMENT ───────────────────────────────────────────────────────────────────────
 * A client accepting a deliverable is the single instant where the product most obviously earned
 * its fee: an agent did the work, a human paid attention to it, and a third party signed it off.
 * Everything already happens on that transition — a timeline note, the case stamp, the skill
 * verdict that teaches the arsenal, the wait that drafts the invoice — and the founder finds out by
 * opening the app.
 *
 * A digest three days later reports it as a number ("2 accepted"). The Mon/Wed/Fri mail is the right
 * place for a summary and the wrong place for this, because the value of the sentence is almost
 * entirely in its timing.
 *
 * ── WHY THIS IS A PULL AND NOT A CALLBACK ────────────────────────────────────────────────────────
 * Both reasons are `linkedin-alerts.ts`'s, verbatim in force here:
 *
 *   1. THE KERNEL DELIBERATELY DOES NOT SEND MAIL. Delivery belongs to the product, which owns the
 *      domain, the DKIM key and the sending reputation.
 *   2. AN IN-PROCESS "have we told them" FLAG DIES WITH THE PROCESS, so a restart sends a second
 *      copy. The only marker that survives is the one written next to the fact, in Postgres.
 *
 * So the durable stamp IS the queue, and here it costs no new table at all: `accepted_at` already
 * exists, and a deliverable that has one and no `founder_notified_at` is a founder who has not been
 * told. Exactly one mail per acceptance, across any number of replicas and restarts.
 *
 * ── WHAT IS DELIBERATELY NOT ALERTED ─────────────────────────────────────────────────────────────
 * `changes_requested`. It is the other verdict on the same route and it is tempting to treat it as
 * the same kind of news, but it is not: a change request already spawns a revision run, the founder
 * sees it in the approvals queue when that run wants a human, and mailing every round-trip of a
 * normal revision cycle is how this address becomes one a founder filters. The mail that matters
 * then arrives in a folder nobody opens — which is the whole failure `linkedin-alerts.ts` describes
 * for transient LinkedIn errors.
 */
import { getDeliverableStore } from "./deliverables";
import { getIdentityStore } from "./identity";

export interface AcceptedAlert {
  deliverable_id: string;
  project_id: string;
  org_id: string;
  org_name: string;
  /** Owners and admins. Empty is possible and is NOT a reason to mark it told — see below. */
  to: string[];
  title: string;
  accepted_at: string;
  /** Which round it was signed off on. A v3 acceptance is a different story from a v1. */
  version: number;
}

/** How far back to look. A month-old acceptance nobody was told about is news that has gone stale. */
const LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

export async function listAcceptedAlerts(now = new Date()): Promise<AcceptedAlert[]> {
  const identity = getIdentityStore();
  const store = getDeliverableStore();
  const since = new Date(now.getTime() - LOOKBACK_MS).toISOString();
  const out: AcceptedAlert[] = [];

  for (const org of identity.listOrgs()) {
    const to = identity
      .listMembers(org.id)
      .filter((m) => m.role === "owner" || m.role === "admin")
      .map((m) => m.email)
      .filter(Boolean);
    for (const p of identity.listProjects(org.id)) {
      const ds = await store.listDeliverables({ project_id: p.id, limit: 500 }).catch(() => []);
      for (const d of ds) {
        if (d.status !== "accepted" || !d.accepted_at || d.founder_notified_at) continue;
        /**
         * Old acceptances are skipped rather than marked.
         *
         * Skipping leaves them due for ever, which sounds like a leak and is the safer of the two
         * mistakes: marking them would mean a deploy that turns this on quietly swallows every
         * historical acceptance, and if the lookback later proves wrong there is no way back. The
         * list is bounded by the window regardless, so nothing here grows without limit.
         */
        if (d.accepted_at < since) continue;
        out.push({
          deliverable_id: d.id,
          project_id: p.id,
          org_id: org.id,
          org_name: org.name,
          // Nobody to tell is not a reason to mark it told. It stays due, so an org that later
          // gains an owner still gets the message. Same rule as the LinkedIn stops.
          to,
          title: d.title,
          accepted_at: d.accepted_at,
          version: d.current_version ?? 1,
        });
      }
    }
  }
  // Oldest first: if a send budget ever truncates this, the news that has been waiting longest goes
  // out rather than the news that happens to sort first.
  return out.sort((a, b) => a.accepted_at.localeCompare(b.accepted_at));
}

/**
 * Mark one as told. Only ever called AFTER a successful send.
 *
 * A marker written on a failure is a promise quietly broken: the founder is never told, and the row
 * that was the evidence is gone.
 */
export async function markAcceptedNotified(
  projectId: string,
  deliverableId: string,
  at = new Date(),
): Promise<boolean> {
  return getDeliverableStore().markFounderNotified(projectId, deliverableId, at.toISOString());
}
