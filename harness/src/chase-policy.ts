// HOW OFTEN THIS BUSINESS CHASES ITS OWN CLIENTS.
//
// ═══ WHY THIS IS A SETTING AND NOT A CONSTANT ═══
//
// `chaseIntervalDays` was three `if` statements: 3 days under a week overdue, 5 under three weeks, 7
// after. Good defaults, chosen carefully, and wrong to impose. "How many times do you want us to
// chase a client, and how hard" is the single question a founder has an opinion about before they
// have an opinion about anything else in this product — a bookkeeper with a decade of goodwill and a
// contractor owed for materials do not want the same ladder, and both are right about their own
// business.
//
// It also became a support burden nobody could answer: a founder asking us to ease off had nothing
// to change, because the number was in a compiled function.
//
// ═══ WHAT A FOUNDER MAY NOT CONFIGURE ═══
//
// The floor. `MIN_CHASE_INTERVAL_DAYS` stays non-negotiable and every value is clamped to it, because
// the failure this bounds is not a preference — it is our sending address chasing somebody's customer
// daily. `wedges/invoice-chaser/knowledge/dunning-policy.md` says "never chase the same invoice twice
// in 48h", and a settings screen that lets a bad day override that would make the product an
// instrument of something we would not defend.
//
// The ceiling too. A ladder with no end is not a ladder, so `maxChases` is capped — an invoice that
// has been chased ten times is not going to be paid by an eleventh email, and the honest next move is
// a person deciding whether to write it off, not more automation.
//
// ═══ THE SHAPE IS `release-policy.ts`'S, DELIBERATELY ═══
//
// A knowledge record per project, an env floor under it, and a read that fails soft to the default.
// Two policies with two storage mechanisms is one more thing to keep in step, and this one carries
// the same property that matters: a project that cannot be read is chased on the DEFAULT ladder
// rather than not chased at all, because a store blip must never silently stop the collections a
// business depends on.
/**
 * Never chase the same invoice twice inside 48 hours.
 *
 * Defined HERE rather than in dunning.ts, where it used to live: the floor is this module's
 * invariant — every configured value is clamped to it — and importing it from the module that now
 * imports the clamping would be a cycle. `dunning.ts` re-exports it, so existing readers are
 * unaffected.
 *
 * The rule itself is `wedges/invoice-chaser/knowledge/dunning-policy.md`'s, and it is not a
 * preference: it is what stops our sending address chasing somebody's customer daily.
 */
export const MIN_CHASE_INTERVAL_DAYS = 2;

export interface ChasePolicy {
  /** Days between chases while 0–7 days overdue. */
  firstDays: number;
  /** Days between chases while 8–21 days overdue. */
  secondDays: number;
  /** Days between chases beyond 21 days overdue. */
  laterDays: number;
  /**
   * How many times one invoice may be chased before it stops and waits for a person.
   *
   * The literal answer to "how many times should we send it to the client". Zero would mean never
   * chase, which is what disabling the wedge is for, so the minimum is one.
   */
  maxChases: number;
}

/** The ladder that was hardcoded, now the default rather than the law. */
export const DEFAULT_CHASE_POLICY: ChasePolicy = {
  firstDays: 3,
  secondDays: 5,
  laterDays: 7,
  maxChases: 6,
};

/** Beyond this an email is not the tool. See the header. */
export const MAX_CHASES_CEILING = 10;

/** A gentle end of the range a founder might sensibly ask for; beyond it the ladder is not chasing. */
export const MAX_INTERVAL_DAYS = 30;

const clampDays = (v: unknown, fallback: number): number => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_INTERVAL_DAYS, Math.max(MIN_CHASE_INTERVAL_DAYS, Math.round(n)));
};

/**
 * Read a stored policy, keeping every value inside what we will defend.
 *
 * Clamps rather than rejects. A row carrying `firstDays: 0` — hand-edited, or written by an older
 * shape — must not throw and must not chase daily; it becomes the floor. Refusing the whole policy
 * over one bad field would drop the founder's other three settings on the ground.
 */
export function toChasePolicy(data: unknown, base: ChasePolicy = DEFAULT_CHASE_POLICY): ChasePolicy {
  const d = (data ?? {}) as Record<string, unknown>;
  const maxRaw = Number(d.maxChases);
  return {
    firstDays: clampDays(d.firstDays, base.firstDays),
    secondDays: clampDays(d.secondDays, base.secondDays),
    laterDays: clampDays(d.laterDays, base.laterDays),
    maxChases: Number.isFinite(maxRaw)
      ? Math.min(MAX_CHASES_CEILING, Math.max(1, Math.round(maxRaw)))
      : base.maxChases,
  };
}

/**
 * Days to wait before chasing this invoice again.
 *
 * The policy's own values are already clamped, so this cannot return anything below the floor no
 * matter what was stored.
 */
export function chaseIntervalFor(daysOverdue: number, policy: ChasePolicy = DEFAULT_CHASE_POLICY): number {
  if (!Number.isFinite(daysOverdue)) return MIN_CHASE_INTERVAL_DAYS;
  if (daysOverdue <= 7) return policy.firstDays;
  if (daysOverdue <= 21) return policy.secondDays;
  return policy.laterDays;
}

/**
 * Has this invoice had all the chasing it is going to get?
 *
 * The stop is on COUNT, not on age. An invoice 200 days overdue that has been chased twice is still
 * worth a third; one chased six times last month is not worth a seventh whatever its age. Age is
 * already what the ladder's intervals respond to.
 */
export function chasesExhausted(chaseCount: number, policy: ChasePolicy = DEFAULT_CHASE_POLICY): boolean {
  return Number.isFinite(chaseCount) && chaseCount >= policy.maxChases;
}

export const CHASE_POLICY_COLLECTION = "chase_policy";

/** The read this module needs from the domain store, and nothing else. Mirrors release-policy.ts. */
export type QueryRecords = (q: {
  project_id: string;
  wedge: string;
  collection: string;
  limit?: number;
}) => Promise<{ data?: unknown }[]>;

export async function chasePolicyFor(
  projectId: string,
  wedge: string,
  deps: { queryRecords: QueryRecords },
): Promise<ChasePolicy> {
  if (!projectId || !wedge) return DEFAULT_CHASE_POLICY;
  try {
    const rows = await deps.queryRecords({
      project_id: projectId,
      wedge,
      collection: CHASE_POLICY_COLLECTION,
      limit: 1,
    });
    return toChasePolicy(rows[0]?.data);
  } catch {
    // A store blip must never silently stop the collections a business depends on.
    return DEFAULT_CHASE_POLICY;
  }
}
