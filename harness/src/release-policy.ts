// Earning the right to skip the founder's review — the difference between a product that makes one
// person faster and a product that means they never hire again.
//
// ═══ THE PROBLEM THIS IS THE ANSWER TO ═══
//
// Nothing reaches a client without a human releasing it. That gate is correct: it is the reason no
// customer has ever received a half-finished piece of work, and on the day it was written it caught
// exactly that.
//
// It is also the next hire. At one client, clicking release is a moment. At ten, with a weekly
// report each, it is forty decisions a month, every one of which is a person reading something they
// have read forty times before and pressing the same button. That is a job, and hiring for it is the
// precise failure this product exists to prevent.
//
// So the goal is not to remove the gate. It is to make it SELECTIVE — to apply where the record is
// thin and lift where it is strong.
//
// ═══ WHY THE RECORD IS PER WEDGE PER CLIENT ═══
//
// Not global, and not per wedge alone. Both of the tempting simplifications are wrong in ways that
// show up as a bad customer experience rather than as an error:
//
//   GLOBAL is wrong because a business doing brilliant bookkeeping for six months tells you nothing
//   about the first website it builds. Different work, different failure modes, different reviewer.
//
//   PER WEDGE ALONE is wrong because the relationship matters as much as the craft. A brand new
//   client has no shared vocabulary with us yet, no history of what they consider finished, and the
//   first deliverable is where all of that gets negotiated. Auto-releasing it because the wedge has
//   done well elsewhere is the automation equivalent of sending a new client a form letter.
//
// The pair is the unit, because the pair is what a track record is actually about: this kind of work,
// for this person, has repeatedly been right.
//
// ═══ WHY "ACCEPTED WITH NO CHANGES" AND NOT "ACCEPTED" ═══
//
// An acceptance that followed a revision is a good outcome and a WEAK signal. It says the loop
// works. It does not say the first attempt was right, and the first attempt is exactly what
// auto-release ships.
//
// So only a clean first-pass acceptance counts toward the record. Anything that needed a revision
// resets it — not as punishment, but because it is direct evidence that unreviewed work from this
// pairing would have gone out wrong.

/** What happened to one delivered piece of work, from the client's side. */
export type Outcome =
  /** Accepted on the first version, with no changes requested at any point. */
  | "clean_accept"
  /** Accepted, but only after the client asked for changes. */
  | "accept_after_changes"
  /** The client asked for changes and it is not yet resolved. */
  | "changes_requested"
  /** Released automatically and then the client asked for changes. The expensive one. */
  | "auto_released_then_changes";

export interface Record {
  wedge: string;
  client_id: string;
  /** Newest first. Only outcomes for THIS wedge and THIS client. */
  outcomes: Outcome[];
}

export type Decision =
  | { release: "auto"; reason: string }
  | { release: "review"; reason: string };

/**
 * Clean first-pass acceptances needed, in a row, before the gate lifts.
 *
 * THREE, and the number is a judgement rather than a calculation. Two is a coincidence — any pairing
 * can get two right. Four or five is a threshold a weekly service reaches in over a month, which is
 * long enough that the feature never fires for the customers who would benefit most.
 *
 * Three consecutive first-pass acceptances is roughly "this has been right every time for a month",
 * which is the point at which a competent human reviewer starts skimming anyway. The honest argument
 * for automating a review is that it has already stopped being a real review.
 */
export const CLEAN_RUN_REQUIRED = 3;

/**
 * After an auto-released deliverable comes back with changes, the bar goes up rather than back to
 * where it was.
 *
 * The asymmetry is the whole safety story. A mistake made while a human was reviewing is a mistake
 * the system was allowed to make. A mistake made because we skipped the human is a mistake we CHOSE
 * to risk, and the client experienced it as the business getting sloppier over time — which is the
 * worst possible trajectory for a service relationship.
 *
 * So the record does not merely reset; the pairing has to earn a longer clean run than it did the
 * first time. Twice-burned means twice as long, and a pairing that keeps failing this way ends up
 * effectively permanently gated, which is the correct outcome.
 */
export const PENALTY_PER_LAPSE = CLEAN_RUN_REQUIRED;

export interface Policy {
  /** Off by default. Auto-release is something a founder turns on, never something they discover. */
  enabled: boolean;
  /** Override the clean run, per project. */
  cleanRunRequired?: number;
}

export const DEFAULT_POLICY: Policy = { enabled: false };

/** How many auto-released deliverables have come back with changes, ever, for this pairing. */
export function lapses(r: Record): number {
  return r.outcomes.filter((o) => o === "auto_released_then_changes").length;
}

/** The clean run this pairing currently has to produce, given its history of lapses. */
export function barFor(r: Record, policy: Policy = DEFAULT_POLICY): number {
  const base = policy.cleanRunRequired ?? CLEAN_RUN_REQUIRED;
  return base + lapses(r) * PENALTY_PER_LAPSE;
}

/** Consecutive clean first-pass acceptances at the head of the record. */
export function cleanRun(r: Record): number {
  let n = 0;
  for (const o of r.outcomes) {
    if (o === "clean_accept") n++;
    else break;
  }
  return n;
}

/**
 * May this deliverable go straight to the client?
 *
 * `clientReady` is the caller's own verdict from `client-ready.ts` — whether the work is even fit to
 * hand over. It is a HARD precondition rather than a factor, and the ordering matters: a track
 * record is a statement about work that was fit to send, and it can never be evidence that unfit
 * work is fine. A pairing with fifty clean acceptances still does not get to release a refusal.
 */
export function mayAutoRelease(args: {
  record: Record;
  policy?: Policy;
  /** Did `decideFate` say this is deliverable work? Anything else is not a candidate at all. */
  clientReady: boolean;
  /** Founder marked this engagement as needing eyes on everything. Always wins. */
  alwaysReview?: boolean;
}): Decision {
  const policy = args.policy ?? DEFAULT_POLICY;

  if (!policy.enabled) {
    return { release: "review", reason: "automatic release is off for this business" };
  }
  if (args.alwaysReview) {
    return { release: "review", reason: "this engagement is marked for review on every deliverable" };
  }
  if (!args.clientReady) {
    // Never reachable in normal flow — `decideFate` holds these long before release — but stated
    // explicitly because a future caller that forgets it would auto-release machine text.
    return { release: "review", reason: "this run did not produce work a client can read" };
  }

  const bar = barFor(args.record, policy);
  const run = cleanRun(args.record);

  if (run < bar) {
    const seen = args.record.outcomes.length;
    if (seen === 0) {
      return {
        release: "review",
        reason: "first piece of this work for this client — nothing to go on yet",
      };
    }
    const why = lapses(args.record)
      ? `${run} of ${bar} clean deliveries in a row (the bar is higher here after an automatic release came back)`
      : `${run} of ${bar} clean deliveries in a row`;
    return { release: "review", reason: why };
  }

  return {
    release: "auto",
    reason: `${run} deliveries in a row accepted first time — released without review, and it is on your desk now`,
  };
}

/**
 * Fold what just happened into the record.
 *
 * `wasAutoReleased` is carried because the SAME client action means different things depending on
 * whether a human had looked first. Changes requested on reviewed work is ordinary service
 * business. Changes requested on work we chose not to review is the system telling us the threshold
 * was wrong, and it has to be recorded differently or the penalty above can never fire.
 */
export function record(
  r: Record,
  event: { verdict: "accepted" | "changes_requested"; hadRevision: boolean; wasAutoReleased: boolean },
): Record {
  let outcome: Outcome;
  if (event.verdict === "changes_requested") {
    outcome = event.wasAutoReleased ? "auto_released_then_changes" : "changes_requested";
  } else {
    outcome = event.hadRevision ? "accept_after_changes" : "clean_accept";
  }
  // Newest first, and bounded: a pairing's distant past does not bear on whether today's work needs
  // reading, and an unbounded array is a row that grows forever.
  return { ...r, outcomes: [outcome, ...r.outcomes].slice(0, 50) };
}

/** The line a founder reads on the engagement when the gate lifts or holds. */
export function explain(d: Decision): string {
  return d.release === "auto" ? `sent automatically — ${d.reason}` : `waiting for you — ${d.reason}`;
}

/**
 * Whether this business has turned automatic release on.
 *
 * Read from the environment for now, as an explicit allowlist of project ids rather than a global
 * boolean. A global switch would turn it on for every tenant at once, and the first customer to
 * discover that their work had been going out unreviewed would be the last conversation we had with
 * them.
 *
 * ═══ AND THAT ALLOWLIST MADE THE WHOLE FEATURE UNREACHABLE ═══
 *
 * `STANDARD.md` §4 calls this "the thing that decides whether the vision is real" and says of it:
 * "Nothing else on the roadmap changes the shape of the business; this does." It was gated on
 * `MYCEL_AUTO_RELEASE_PROJECTS`, an environment variable. So no founder could turn it on, no founder
 * could see a track record accumulating, enabling it for one customer needed a DEPLOY, and the
 * mechanism had never run for anybody.
 *
 * The old note here said "when this moves to a project setting, this function is the only thing that
 * changes". That turned out to be true, which is the nicest thing that can be said about a seam.
 *
 * ═══ WHERE THE SETTING LIVES ═══
 *
 * A record under a reserved wedge, exactly like payment rails — one row per project, read through
 * `queryRecords`, which carries the fail-closed tenant filter rather than a fifth hand-written one.
 * No new table, no migration, and a project that has never touched it reads back as off.
 *
 * ═══ THE ENVIRONMENT VARIABLE STILL WORKS, AND IS NOW A FLOOR RATHER THAN THE GATE ═══
 *
 * A self-host that set it keeps working. It cannot turn the feature OFF for a project that has
 * turned it on, and the setting cannot turn it off for a project the operator has allowlisted —
 * those are two different people's decisions and the honest resolution is that either can enable.
 * Disabling is per-project and belongs to the founder, which is the direction that matters: the
 * person whose reputation is spent is the one who gets to stop it.
 */

/** Reserved wedge and collection for the setting. Same shape as `payments/payment_instructions`. */
export const RELEASE_WEDGE = "release-policy";
export const POLICY_COLLECTION = "policy";
export const POLICY_KEY = "default";

/** The operator-level allowlist. Kept for self-hosts that already set it — see the note above. */
export function policyFromEnv(projectId: string): Policy {
  const raw = process.env.MYCEL_AUTO_RELEASE_PROJECTS ?? "";
  const allowed = raw.split(/[\s,]+/).filter(Boolean);
  if (!projectId || !allowed.includes(projectId)) return DEFAULT_POLICY;
  const n = Number(process.env.MYCEL_AUTO_RELEASE_CLEAN_RUN);
  return { enabled: true, ...(Number.isFinite(n) && n > 0 ? { cleanRunRequired: Math.floor(n) } : {}) };
}

/** Normalise whatever is in the record. A stored `cleanRunRequired` is clamped, never trusted. */
export function toPolicy(data: unknown, fallback: Policy = DEFAULT_POLICY): Policy {
  const d = (data ?? {}) as { enabled?: unknown; clean_run_required?: unknown };
  if (typeof d.enabled !== "boolean") return fallback;
  const n = Number(d.clean_run_required);
  return {
    enabled: d.enabled,
    // Between 1 and 20. One is "the next clean one goes out", which is a founder's decision to make;
    // above twenty the feature can never fire and the number is a mistake rather than a preference.
    ...(Number.isFinite(n) && n >= 1 && n <= 20 ? { cleanRunRequired: Math.floor(n) } : {}),
  };
}

/**
 * This project's policy — the setting first, the operator allowlist as a floor.
 *
 * Async now, which the one caller (`orchestrator.ts`) already was. Failing CLOSED on a store error:
 * an unreachable database must never be the reason work goes to a client unreviewed.
 */
export async function releasePolicyFor(
  projectId: string,
  deps: { queryRecords: QueryRecords },
): Promise<Policy> {
  const floor = policyFromEnv(projectId);
  if (!projectId) return floor;
  try {
    const rows = await deps.queryRecords({
      project_id: projectId,
      wedge: RELEASE_WEDGE,
      collection: POLICY_COLLECTION,
      limit: 1,
    });
    return toPolicy(rows[0]?.data, floor);
  } catch {
    return floor;
  }
}

/** The read this module needs from the domain store, and nothing else. */
export type QueryRecords = (q: {
  project_id: string;
  wedge: string;
  collection: string;
  limit?: number;
}) => Promise<{ data?: unknown }[]>;
