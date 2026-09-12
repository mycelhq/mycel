// "Approve this kind, for this client, from now on" — as a thing the founder WROTE, not a thing
// the machine inferred.
//
// ═══ WHY THIS EXISTS ═══
//
// The product's claim is "nothing reaches a client without you." The claim dies two ways, and only
// one of them is obvious.
//
// The obvious death is a hole in the gate. The other one is a queue so full of things nobody needed
// to look at that the founder stops looking, and then the gate is a formality with a spinner on it.
// A founder who approves the same weekly status update to the same retainer client for the eighth
// Friday in a row has not consented eight times; they have been trained.
//
// So: a STANDING GRANT. One sentence, written by a human, naming one action and (usually) one
// client, with a daily ceiling and an expiry date. Inside it, that exact action for that exact
// client resolves without stopping the run — and still lands in the queue, resolved, saying which
// grant let it through and offering to revoke it.
//
// ═══ WHAT KEEPS THIS FROM BEING A HOLE ═══
//
// Five properties, each with a test named after the bug it prevents:
//
//  1. NEVER INFERRED. There is no code path anywhere that creates one of these from observed
//     behaviour. `suggestWidening` in autonomy.ts proposes; a human writes. This module has no
//     equivalent of a proposal because the only actor allowed to widen is a person.
//  2. NEVER SELF-GRANTED. `by` must be a real member identity. The agent, the sweep, the policy
//     engine and the system have no way to author one — see `HUMAN_REQUIRED`.
//  3. NEVER COVERS A HIGH-RISK ACTION. Not at creation, and not at match time. A grant written when
//     an action scored `low` does not cover the day that action carries a refund: the verdict is
//     recomputed per action and a `high` one always goes to a person. This is the property that
//     makes the whole thing safe to have, because it means a grant cannot be laundered into
//     authority over money by changing what the action does.
//  4. ALWAYS VISIBLE AND ALWAYS REVOCABLE. Every grant is a row the founder can list and delete,
//     every use is counted, and every auto-resolution names the grant on the approval it resolved.
//  5. ALWAYS EXPIRES. No grant is forever. `MAX_GRANT_DAYS` is the outer bound, so the worst case
//     for a founder who granted something and forgot is bounded by a calendar rather than by their
//     memory.
//
// It narrows the same way `autonomy.ts` does and for the same reason: everything unreadable,
// unparseable, expired, revoked or ambiguous refuses, and refusing means "a human looks at it",
// which is the product working normally.
import { randomUUID } from "node:crypto";
import type { Risk } from "./contract";
import type { DomainStore } from "./domain";
import { getPolicyCounters } from "./store";

/** Reserved wedge slug for these rows, exactly as `AUTONOMY_WEDGE` is. Not a wedge on disk. */
export const STANDING_WEDGE = "standing";
export const STANDING_COLLECTION = "standing_grant";

/**
 * The longest a standing grant can live: ninety days.
 *
 * Not a technical limit — an honesty one. "From now on" is what the founder means and it is not
 * what they should get, because the business they granted it for is not the business they will
 * have in a year. A quarter is long enough that renewing is not nagging and short enough that a
 * grant written for a client who churned in March is not still live in December.
 */
export const MAX_GRANT_DAYS = 90;

/**
 * The most auto-resolutions one grant can spend in a day, whatever the founder asks for.
 *
 * Twenty, matching `HARD_MAX_PER_DAY` in autonomy.ts deliberately: the two ceilings bound the same
 * quantity from opposite ends (that one bounds runs started unasked, this one bounds sends passed
 * unread) and a founder should not have to hold two different numbers in their head. A founder may
 * set it LOWER. There is deliberately no way to set it higher.
 */
export const HARD_MAX_USES_PER_DAY = 20;

/**
 * Actor names that are not people.
 *
 * The single most important list in this file. A grant is the only mechanism in the product that
 * lets an action reach a client without a human looking at it in the moment, so the question "who
 * wrote this grant" has exactly one acceptable class of answer. These are the strings the kernel's
 * own non-human actors use in `audit()` (`actor: "policy"`, `actor: "system"`), and any of them
 * arriving as an author means a code path is trying to widen its own authority.
 */
const HUMAN_REQUIRED = new Set(["", "-", "agent", "policy", "system", "kernel", "sweep", "auto", "autonomy", "worker"]);

export interface StandingGrant {
  v: 1;
  id: string;
  /**
   * The action, matched EXACTLY and case-insensitively — never as a prefix, never as a substring.
   *
   * `autonomy.ts` makes the same choice for `kind` and states the reason: a prefix in a permission
   * is a permission whose extent nobody can predict, and an unpredictable permission is not a
   * permission. Here it is sharper still, because `email:` as a prefix would cover every email this
   * business will ever send, including ones written by a capability that does not exist yet.
   */
  action: string;
  /**
   * The client this covers. Absent means EVERY client of the project, which is a much larger thing
   * to grant and is presented as such — see `describeGrant`.
   */
  client_id?: string;
  /** Ceiling on auto-resolutions in a rolling UTC day. Clamped to `HARD_MAX_USES_PER_DAY`. */
  max_per_day: number;
  /** ISO instant. Past it, the grant is inert; it is not deleted, so the founder can see it lapsed. */
  expires_at: string;
  granted_at: string;
  /** A member identity. Never a machine — see `HUMAN_REQUIRED`. */
  granted_by: string;
  revoked_at?: string;
  revoked_by?: string;
}

/** Why an action did or did not clear a standing grant. Recorded on the approval either way. */
export type StandingDecision =
  | { auto: true; grant: StandingGrant; reason: string }
  | { auto: false; reason: string };

const iso = (d: Date) => d.toISOString();
const dayKey = (now: Date) => now.toISOString().slice(0, 10);

function dayExpiry(now: Date): Date {
  const end = new Date(now);
  end.setUTCHours(24, 0, 0, 0);
  return end;
}

/** A grant is live if it was never revoked and has not lapsed. Anything else is inert. */
export function isLive(g: StandingGrant, now: Date): boolean {
  if (g.revoked_at) return false;
  const until = Date.parse(g.expires_at);
  return Number.isFinite(until) && until > now.getTime();
}

/** The sentence the founder reads in the list, and the one quoted back when a grant is used. */
export function describeGrant(g: StandingGrant): string {
  const who = g.client_id ? `for ${g.client_id}` : "for every client";
  return `${g.action} ${who}, up to ${g.max_per_day} a day, until ${g.expires_at.slice(0, 10)}`;
}

export interface NewGrant {
  action: string;
  client_id?: string;
  max_per_day?: number;
  /** Days from now. Clamped into `1..MAX_GRANT_DAYS`; absent means the full window. */
  days?: number;
}

/**
 * Write a grant.
 *
 * Throws rather than returning an error shape, because every caller is an HTTP route with a human
 * on the other end and there is no "partially granted". A refusal here is a 400 the founder reads.
 */
export async function grantStanding(
  domain: DomainStore,
  projectId: string,
  input: NewGrant,
  by: string,
  now: Date = new Date(),
): Promise<StandingGrant> {
  // Not defaulted. Two cross-tenant leaks have shipped in this repo and both came in through a
  // scope that was optional somewhere. A grant written into the wrong project is standing
  // permission to email somebody else's clients.
  if (!projectId) throw new Error("a standing approval must be scoped to a project");

  // PROPERTY 2. The agent cannot author its own permission.
  const author = String(by ?? "").trim();
  if (!author || HUMAN_REQUIRED.has(author.toLowerCase())) {
    throw new Error("a standing approval can only be granted by a person, and this one names no member");
  }

  const action = String(input.action ?? "").trim().toLowerCase();
  if (!action) throw new Error("a standing approval must name exactly one action");
  // A wildcard is not a narrower permission expressed conveniently — it is every action there is,
  // including the ones this build does not have yet. There is no spelling of "everything" here.
  if (action.includes("*") || action.endsWith(":")) {
    throw new Error(`"${input.action}" is a pattern, not an action — name the one action you mean`);
  }

  const days = Math.min(MAX_GRANT_DAYS, Math.max(1, Math.floor(Number(input.days ?? MAX_GRANT_DAYS)) || MAX_GRANT_DAYS));
  const perDay = Math.min(
    HARD_MAX_USES_PER_DAY,
    Math.max(1, Math.floor(Number(input.max_per_day ?? HARD_MAX_USES_PER_DAY)) || HARD_MAX_USES_PER_DAY),
  );

  const grant: StandingGrant = {
    v: 1,
    id: randomUUID(),
    action,
    ...(input.client_id ? { client_id: String(input.client_id) } : {}),
    max_per_day: perDay,
    expires_at: iso(new Date(now.getTime() + days * 86_400_000)),
    granted_at: iso(now),
    granted_by: author,
  };

  await domain.upsertRecord({
    // From the ARGUMENT the route derived from the session, never from the body.
    project_id: projectId,
    wedge: STANDING_WEDGE,
    collection: STANDING_COLLECTION,
    // One row per grant, keyed by its own id, so revoking one cannot disturb another — the failure
    // that shape prevents is "I revoked the invoice one and the status update stopped too".
    key: grant.id,
    data: grant as unknown as Record<string, unknown>,
  });
  return grant;
}

/**
 * Every grant this project has, live or not, newest first.
 *
 * Lapsed and revoked rows are RETURNED, not filtered. "Visible" has to include the ones that
 * stopped working, because the founder's question is usually "did I grant that?" and an empty list
 * answers it wrongly.
 */
export async function listStanding(
  domain: DomainStore,
  projectId: string,
): Promise<StandingGrant[]> {
  if (!projectId) return [];
  let rows: Awaited<ReturnType<DomainStore["queryRecords"]>>;
  try {
    rows = await domain.queryRecords({
      project_id: projectId,
      wedge: STANDING_WEDGE,
      collection: STANDING_COLLECTION,
      limit: 200,
    });
  } catch (e) {
    // Loud, and then empty. An unreadable list is the same answer as no grants for every consumer
    // of this function: the gate applies. It must never look like "you granted nothing".
    console.error(`[mycel] could not read standing approvals for ${projectId}:`, (e as Error)?.message ?? e);
    throw e;
  }
  return rows
    .map((r) => r.data as unknown as StandingGrant)
    .filter((g): g is StandingGrant => !!g && typeof g === "object" && g.v === 1 && typeof g.action === "string")
    .sort((a, b) => (a.granted_at < b.granted_at ? 1 : -1));
}

/**
 * Revoke one. Idempotent; returns false when there was nothing of that id in THIS project.
 *
 * A tombstone rather than a delete: the founder should be able to see that they revoked it and
 * when, and an audit of "was this ever permitted" cannot be answered by a missing row.
 */
export async function revokeStanding(
  domain: DomainStore,
  projectId: string,
  id: string,
  by: string,
  now: Date = new Date(),
): Promise<boolean> {
  if (!projectId || !id) return false;
  const all = await listStanding(domain, projectId);
  const g = all.find((x) => x.id === id);
  if (!g) return false;
  if (g.revoked_at) return true;
  await domain.upsertRecord({
    project_id: projectId,
    wedge: STANDING_WEDGE,
    collection: STANDING_COLLECTION,
    key: g.id,
    data: { ...g, revoked_at: iso(now), revoked_by: by || "member" } as unknown as Record<string, unknown>,
  });
  return true;
}

export interface StandingMatchArgs {
  projectId?: string;
  action: string;
  clientId?: string;
  /** The verdict risk.ts computed for THIS action, this time. `high` can never clear a grant. */
  risk: Risk;
  now?: Date;
  /** `false` evaluates without spending the daily budget. Used by previews and tests. */
  commit?: boolean;
}

/**
 * Does a founder-written grant cover this action, right now?
 *
 * Every early return is a refusal, and a refusal means the human gate applies — which is the
 * product's documented default and what happens with no grants at all. There is no path through
 * this function where a failure to read, parse, count or scope something results in an action
 * going out unseen.
 */
export async function matchStanding(
  domain: DomainStore,
  args: StandingMatchArgs,
): Promise<StandingDecision> {
  // PROPERTY 3, checked FIRST and before anything is even loaded, so no amount of grant-writing
  // can reach it. A grant is a statement about routine work; `high` is the definition of not that.
  if (args.risk === "high") {
    return { auto: false, reason: "this one is high risk, and a standing approval never covers those" };
  }
  if (!args.projectId) return { auto: false, reason: "no project scope — the human gate applies" };

  const now = args.now ?? new Date();
  let grants: StandingGrant[];
  try {
    grants = await listStanding(domain, args.projectId);
  } catch (e) {
    // FAIL CLOSED, exactly as `evaluatePolicy` does and for the same reason: an unreachable store
    // must not be a way to dissolve every ceiling in the system at once.
    return { auto: false, reason: `standing approvals unavailable — human gate applies: ${(e as Error)?.message ?? e}` };
  }

  const action = args.action.toLowerCase();
  const match = grants.find(
    (g) =>
      isLive(g, now) &&
      g.action === action &&
      // A grant naming a client covers that client and nobody else. A grant naming none covers all
      // of them — which is why `describeGrant` says "for every client" out loud rather than
      // rendering an empty field.
      (g.client_id === undefined || g.client_id === args.clientId),
  );
  if (!match) return { auto: false, reason: "no standing approval covers this" };

  // The daily ceiling goes through the SHARED counters, not a local map. Four processes each
  // counting to the same ceiling is how `max_per_day` in policy.ts silently became four times
  // itself in production; there is no reason to relearn that here.
  const key = `standing|${dayKey(now)}|${match.id}`;
  let counters: Awaited<ReturnType<typeof getPolicyCounters>>;
  try {
    counters = await getPolicyCounters();
    if ((await counters.peek(args.projectId, "day", key)) >= match.max_per_day) {
      return { auto: false, reason: `that standing approval has spent its ${match.max_per_day} for today` };
    }
    if (args.commit !== false) {
      // Atomic, and the returned position is the only thing that decides. See policy.ts for the
      // race this shape closes.
      const used = await counters.bump(args.projectId, "day", key, dayExpiry(now));
      if (used > match.max_per_day) {
        return { auto: false, reason: `that standing approval has spent its ${match.max_per_day} for today` };
      }
    }
  } catch (e) {
    return { auto: false, reason: `standing approvals unavailable — human gate applies: ${(e as Error)?.message ?? e}` };
  }

  return {
    auto: true,
    grant: match,
    // Written in the founder's own voice and in the past tense, because it is quoted back to them
    // on the resolved card next to a Revoke button. "You allowed this" is a fact they can act on;
    // "policy matched rule 3" is not.
    reason: `you allowed this on ${match.granted_at.slice(0, 10)} — ${describeGrant(match)}`,
  };
}
