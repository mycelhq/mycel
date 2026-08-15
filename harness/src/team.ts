// WHO on the team handles WHAT — inferred from what they have actually done, not from a role.
//
// A role is a PERMISSION ("may this person approve"). It says nothing about responsibility — who,
// among the people who *may* do a thing, is the one who actually does it. That is a different fact,
// and the only honest source for it is the audit trail: the tamper-evident record of consequential
// decisions already carries an actor on every entry. This module reads that record and tallies, per
// person, which human-readable areas of the business their decisions fall in.
//
// Deliberately READ-ONLY and pure. It infers and reports; it does not route approvals or change who
// gets asked. We validate the model against reality before wiring anything to it — a
// responsibility map that disagrees with what a founder knows about their own team is worse than
// none, and the only way to find out is to show it first.
import type { AuditEntry } from "./audit";

/**
 * The CLOSED set of responsibility areas.
 *
 * Human-readable domains of a service business, not a mirror of the audit action vocabulary — a
 * founder thinks in "collections" and "client communication", not in `approval.granted on a dunning
 * entity". Closed on purpose: an open set would let every new audit action invent a new area, and
 * the whole value here is a small, stable map a person can hold in their head.
 */
export const RESPONSIBILITY_AREAS = [
  "collections",
  "bookkeeping",
  "outreach",
  "client_comms",
  "setup",
  "billing_admin",
  "team_admin",
] as const;
export type ResponsibilityArea = (typeof RESPONSIBILITY_AREAS)[number];

/** Founder-facing labels. Plain language — this is rendered next to a person's name. */
export const RESPONSIBILITY_LABEL: Record<ResponsibilityArea, string> = {
  collections: "Collections & invoicing",
  bookkeeping: "Bookkeeping",
  outreach: "Outreach & pipeline",
  client_comms: "Client communication",
  setup: "Connections & setup",
  billing_admin: "Billing & plan",
  team_admin: "Team & access",
};

/** One person's areas, sorted by weight (how often their decisions fell there) descending. */
export type MemberResponsibilities = { area: ResponsibilityArea; weight: number }[];

/**
 * Does this text mention a money/collections entity? Used to disambiguate an approval — the same
 * `approval.granted` action means collections on an invoice and client comms on a case note.
 */
function looksLikeCollections(s: string): boolean {
  return /invoice|dunning|chase|collection|payment|overdue/i.test(s);
}
function looksLikeOutreach(s: string): boolean {
  return /outreach|message|prospect|sequence|connect|linkedin|touch/i.test(s);
}

/**
 * Map a single audit entry to at most one responsibility area.
 *
 * `undefined` means "this entry says nothing about responsibility" — a project creation, a trigger
 * subscription, a super-admin sign-in. Skipping is the right answer for those: counting them would
 * dilute the signal with noise nobody assigns a person to.
 */
function areaFor(entry: AuditEntry): ResponsibilityArea | undefined {
  const { action } = entry;
  // Where the entity/detail disambiguates, look at it. Cheap and deterministic.
  const context = `${entry.entity} ${entry.entity_id} ${JSON.stringify(entry.detail ?? {})}`;

  switch (action) {
    case "approval.granted":
    case "approval.rejected":
    case "approval.auto_approved":
      if (looksLikeCollections(context)) return "collections";
      if (looksLikeOutreach(context)) return "outreach";
      return "client_comms";
    case "connection.linked":
    case "secret.written":
      return "setup";
    case "org.plan_changed":
      return "billing_admin";
    case "standing.granted":
    case "standing.revoked":
      return "team_admin";
    case "case.closed":
    case "case.stage_changed":
    case "client.portal_link":
      return "client_comms";
    default:
      // Anything touching members/invites is team administration, whatever the action name.
      if (/member|invite/i.test(context)) return "team_admin";
      return undefined;
  }
}

/**
 * Tally, per member, which areas their audited decisions fall in.
 *
 * PURE: no store, no IO — hand it entries, get a map back. Deterministic ordering: areas are sorted
 * by weight descending, ties broken by the area's fixed position in `RESPONSIBILITY_AREAS`, so the
 * same input always yields the same output (which the endpoint and its test both rely on).
 */
export function inferResponsibilities(
  entries: AuditEntry[],
): Map<string, MemberResponsibilities> {
  // member -> area -> weight
  const tally = new Map<string, Map<ResponsibilityArea, number>>();

  for (const entry of entries) {
    const actor = entry.actor;
    // Ignore a falsy/empty actor, and the non-human actors — "responsibility" is about people.
    if (!actor || actor === "agent" || actor === "system" || actor === "policy") continue;
    const area = areaFor(entry);
    if (!area) continue;
    let areas = tally.get(actor);
    if (!areas) {
      areas = new Map();
      tally.set(actor, areas);
    }
    areas.set(area, (areas.get(area) ?? 0) + 1);
  }

  const out = new Map<string, MemberResponsibilities>();
  for (const [member, areas] of tally) {
    const sorted = [...areas.entries()]
      .map(([area, weight]) => ({ area, weight }))
      .sort(
        (a, b) =>
          b.weight - a.weight ||
          RESPONSIBILITY_AREAS.indexOf(a.area) - RESPONSIBILITY_AREAS.indexOf(b.area),
      );
    out.set(member, sorted);
  }
  return out;
}

/**
 * Who most handles a given area — the member with the highest weight there, or undefined if nobody
 * has touched it. Deterministic on ties: the first member encountered while scanning wins, and the
 * scan order is the map's insertion order (the order actors first appear in the audit stream).
 */
export function whoHandles(
  inferred: Map<string, MemberResponsibilities>,
  area: ResponsibilityArea,
): string | undefined {
  let best: string | undefined;
  let bestWeight = 0;
  for (const [member, areas] of inferred) {
    const hit = areas.find((a) => a.area === area);
    if (hit && hit.weight > bestWeight) {
      best = member;
      bestWeight = hit.weight;
    }
  }
  return best;
}
