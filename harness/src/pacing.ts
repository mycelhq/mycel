// Outreach pacing — what keeps a founder's account alive.
//
// The brief was "on the edge, but a bit below it". That is the right instinct and it is not a
// volume number, because LinkedIn does not police volume alone. Their scoring is against
// *acceptance and reply rate*: 80 invitations a week with a 40% acceptance rate is a healthy
// account, and 40 a week at 3% is a restricted one. Sending less does not save an account whose
// messages nobody wants; sending more is fine if people are answering.
//
// So there are two mechanisms here, and the second is the one that matters:
//
//   1. HARD CAPS. Published-ish limits by account tier, as a rolling window rather than a
//      calendar reset, because LinkedIn's own windows roll. These are the ceiling.
//   2. A FEEDBACK LOOP. The real budget is derived from how the last hundred touches landed. Good
//      engagement earns more; poor engagement throttles automatically, before LinkedIn does it for
//      you. This is what "below the edge" actually means — the edge moves per account, so the
//      limit has to move with it.
//
// The failure mode we are avoiding is not a bad month. It is a founder's professional identity
// being restricted because our software was impatient, and a restriction takes about a week to
// lift with no explanation and no appeal.
//
// Deliberately NOT maximally conservative: a GTM add-on that sends five messages a day produces no
// results, and a customer paying for outcomes will simply do it by hand instead. The defaults sit
// at roughly 70–80% of the published ceiling and rise only on evidence.
import type { DomainStore } from "./domain";

/** What a channel costs against the budget. Invitations are scarcer than replies, by a lot. */
export type TouchKind = "invite" | "message" | "inmail" | "profile_view" | "follow";

/**
 * Account tiers. The published ceilings differ enough that treating a free account like a Sales
 * Navigator one is how you get someone restricted in their first fortnight.
 */
export type AccountTier = "free" | "premium" | "sales_navigator" | "recruiter";

interface Ceiling {
  /** Rolling 7-day invitation cap. The number LinkedIn actually enforces. */
  invitesPerWeek: number;
  /** Messages to existing connections. No published daily figure; patterns are scored weekly. */
  messagesPerDay: number;
  /** Requests to people you are NOT connected to — much scarcer, and the one people burn blindly. */
  requestsPerWeek: number;
  inmailPerMonth: number;
}

/**
 * Published ceilings, as of 2026. These are the ABSOLUTE limit, never the target — `budgetFor`
 * spends a fraction of them and earns the rest.
 */
const CEILING: Record<AccountTier, Ceiling> = {
  free: { invitesPerWeek: 100, messagesPerDay: 40, requestsPerWeek: 10, inmailPerMonth: 0 },
  premium: { invitesPerWeek: 100, messagesPerDay: 80, requestsPerWeek: 15, inmailPerMonth: 15 },
  sales_navigator: { invitesPerWeek: 200, messagesPerDay: 120, requestsPerWeek: 25, inmailPerMonth: 50 },
  recruiter: { invitesPerWeek: 200, messagesPerDay: 150, requestsPerWeek: 30, inmailPerMonth: 150 },
};

/**
 * A new account is the most fragile thing in this system.
 *
 * Under 30 days LinkedIn applies a stricter informal cap — roughly 50–80 invitations a week — until
 * trust signals accumulate. An account that opens at full volume on day two is the classic way to
 * lose one, so the ramp starts at a quarter and reaches full allowance at eight weeks.
 */
export function ageRamp(accountAgeDays: number): number {
  if (accountAgeDays < 7) return 0.25;
  if (accountAgeDays < 14) return 0.4;
  if (accountAgeDays < 30) return 0.6;
  if (accountAgeDays < 56) return 0.8;
  return 1;
}

export interface Engagement {
  /** Invitations sent in the scoring window, and how many were accepted. */
  sent: number;
  accepted: number;
  replied: number;
  /** Explicit negative signals: "I don't know this person", reports, withdrawals. */
  flagged: number;
}

/**
 * How much of the ceiling this account has earned.
 *
 * LinkedIn scores acceptance and reply rate, so this does too — it is the same signal, read early.
 * The multiplier is deliberately asymmetric: it falls faster than it rises, because the cost of
 * being wrong in one direction is a slow month and in the other is a restricted account.
 *
 * Below a very small sample nobody has evidence of anything, so a new account gets the cautious
 * default rather than a flattering one computed from three data points.
 */
export function engagementMultiplier(e: Engagement): number {
  if (e.sent < 20) return 0.6;

  const accept = e.accepted / e.sent;
  const reply = e.replied / Math.max(1, e.sent);
  const flagRate = e.flagged / e.sent;

  // Any meaningful rate of "I don't know this person" is the signal that precedes a restriction.
  // This is the one case worth being blunt about rather than gradual.
  if (flagRate > 0.02) return 0.2;

  // Acceptance is the dominant term; replies are a bonus because they are the strongest positive
  // signal LinkedIn has and the hardest to fake.
  let m = 0.5;
  if (accept >= 0.35) m = 1;
  else if (accept >= 0.25) m = 0.85;
  else if (accept >= 0.15) m = 0.7;
  else if (accept >= 0.08) m = 0.5;
  else m = 0.3; // nobody wants these messages; sending more is how an account dies

  if (reply >= 0.1) m = Math.min(1.15, m + 0.15);
  return m;
}

/**
 * How long a counter counts for, per kind.
 *
 * These mirror `budgetFor`: the invitation budget is a weekly figure, the message budget is
 * `messagesPerDay × 7` (also weekly), and InMail credits are monthly. A counter with no window is a
 * counter that only ever goes up, which is the same as a permanent ban after the first good week.
 */
export const WINDOW_MS: Record<TouchKind, number> = {
  invite: 7 * 86_400_000,
  message: 7 * 86_400_000,
  inmail: 30 * 86_400_000,
  profile_view: 7 * 86_400_000,
  follow: 7 * 86_400_000,
};

/**
 * The pacing bookkeeping as it is persisted on `connection.config.pacing`.
 *
 * `windows[kind]` is the instant the current counter started counting. That single field is what
 * makes rollover possible without a cron: a counter is live if its window began less than
 * `WINDOW_MS[kind]` ago, and is otherwise read as zero and reset on the next write. A rolling
 * window rather than a calendar reset, because LinkedIn's own windows roll.
 */
export interface PacingState {
  used?: Partial<Record<TouchKind, number>>;
  windows?: Partial<Record<TouchKind, string>>;
  /** When the last touch of each kind actually went out. What the UI shows, and the spacing proof. */
  last_at?: Partial<Record<TouchKind, string>>;
  engagement?: Engagement;
}

/**
 * The counters that are still inside their window, as `evaluate` wants them.
 *
 * Pure, and applied on READ as well as on write: a connection whose last send was three weeks ago
 * must not still be carrying that week's total, or the account is throttled forever by arithmetic
 * nobody can see.
 */
export function rollUsed(state: PacingState | undefined, now: Date = new Date()): Partial<Record<TouchKind, number>> {
  const used = state?.used ?? {};
  const windows = state?.windows ?? {};
  const out: Partial<Record<TouchKind, number>> = {};
  for (const [k, n] of Object.entries(used) as Array<[TouchKind, number | undefined]>) {
    if (!n) continue;
    const startedAt = Date.parse(windows[k] ?? "");
    // No window start at all means state written by something that did not record one. Count it —
    // dropping an unexplained counter is the permissive direction, and this is the safety check.
    if (Number.isFinite(startedAt) && now.getTime() - startedAt >= (WINDOW_MS[k] ?? WINDOW_MS.invite)) continue;
    out[k] = n;
  }
  return out;
}

export interface PacingInput {
  tier: AccountTier;
  accountAgeDays: number;
  engagement: Engagement;
  /** Touches already made in the rolling window, by kind. */
  used: Partial<Record<TouchKind, number>>;
  /** The account's own local hour, 0–23. Outreach at 3am is a bot signature. */
  localHour: number;
  localDay: number; // 0 = Sunday
}

export interface PacingVerdict {
  allowed: boolean;
  reason?: string;
  /** What remains in the window after this decision, for the UI to show. */
  remaining: number;
  /** The effective cap, after ramp and engagement — what "the edge" is for THIS account today. */
  budget: number;
  /** Milliseconds to wait before the next touch of this kind. Never zero. */
  nextAfterMs: number;
}

/** The effective allowance for one kind of touch: ceiling × age ramp × earned engagement. */
export function budgetFor(kind: TouchKind, input: PacingInput): number {
  const c = CEILING[input.tier];
  const base =
    kind === "invite" ? c.invitesPerWeek
    : kind === "message" ? c.messagesPerDay * 7
    : kind === "inmail" ? c.inmailPerMonth
    : kind === "profile_view" ? 400
    : 100;

  // 0.8 is the "a bit below the edge" the whole design is aimed at: enough volume to produce
  // results, with headroom so a miscount or a burst does not touch the real ceiling.
  const target = base * 0.8;
  return Math.max(1, Math.floor(target * ageRamp(input.accountAgeDays) * engagementMultiplier(input.engagement)));
}

/**
 * Time-of-day shaping.
 *
 * Real people send messages during their working day. A steady stream at 04:00 local, or the same
 * volume on a Sunday as a Tuesday, is a pattern nobody has to look hard to spot. This is a
 * detection measure that happens to cost nothing.
 */
export function withinSendingWindow(localHour: number, localDay: number): boolean {
  if (localDay === 0 || localDay === 6) return false; // weekends off entirely
  return localHour >= 8 && localHour < 19;
}

/**
 * The interval between touches, jittered.
 *
 * Spreading a day's allowance across the working window rather than firing it in one burst is what
 * "spread evenly" means in every piece of LinkedIn guidance. The jitter matters as much as the
 * spacing: a message exactly every 7 minutes is more obviously automated than a burst is.
 */
export function nextIntervalMs(dailyBudget: number, rand: () => number = Math.random): number {
  const workingMs = 11 * 60 * 60 * 1000; // the 08:00–19:00 window
  const perDay = Math.max(1, dailyBudget);
  const mean = workingMs / perDay;
  // ±40%, so the gaps look like a person getting distracted rather than a cron.
  const jitter = 0.6 + rand() * 0.8;
  // Never faster than 45 seconds, however generous the budget.
  return Math.max(45_000, Math.floor(mean * jitter));
}

/**
 * The decision. Called before every outbound touch.
 *
 * Deliberately returns a verdict rather than throwing: the caller wants to tell a founder WHY their
 * campaign is paused, and "you have used 78 of your 80 invitations this week, and the window resets
 * on Thursday" is a product, whereas an exception is a bug report.
 */
export function evaluate(kind: TouchKind, input: PacingInput): PacingVerdict {
  const budget = budgetFor(kind, input);
  const used = input.used[kind] ?? 0;
  const remaining = Math.max(0, budget - used);
  const dailyBudget = kind === "invite" ? budget / 5 : budget / 7; // invites over working days

  if (!withinSendingWindow(input.localHour, input.localDay)) {
    return {
      allowed: false,
      reason: "outside this account's working hours — outreach at 3am is a bot signature",
      remaining,
      budget,
      nextAfterMs: 60 * 60 * 1000,
    };
  }
  if (remaining <= 0) {
    return {
      allowed: false,
      reason: `this account's ${kind} allowance for the window is used (${used}/${budget})`,
      remaining: 0,
      budget,
      nextAfterMs: 6 * 60 * 60 * 1000,
    };
  }
  if (input.engagement.sent >= 20 && engagementMultiplier(input.engagement) <= 0.2) {
    return {
      allowed: false,
      reason:
        "too many recipients marked these as unwanted — paused so the account is not restricted. " +
        "Change who is being contacted, or what is being said, before resuming.",
      remaining,
      budget,
      nextAfterMs: 24 * 60 * 60 * 1000,
    };
  }
  return { allowed: true, remaining, budget, nextAfterMs: nextIntervalMs(dailyBudget) };
}

/**
 * The store-backed entry point the action proxy calls.
 *
 * Fails CLOSED: if the pacing state cannot be read, no outbound touch happens. An outreach system
 * whose safety check degrades to "send anyway" has no safety check.
 */
export async function assertSendAllowed(
  domain: DomainStore,
  connectionId: string,
  kind: TouchKind,
): Promise<PacingVerdict> {
  try {
    const conn = await domain.getConnection(connectionId);
    if (!conn) {
      return { allowed: false, reason: "unknown connection", remaining: 0, budget: 0, nextAfterMs: 0 };
    }
    const cfg = (conn.config ?? {}) as Record<string, unknown>;
    const state = (cfg.pacing ?? {}) as PacingState;
    const now = new Date();
    const offset = typeof cfg.utc_offset === "number" ? cfg.utc_offset : 0;
    const local = new Date(now.getTime() + offset * 3600_000);

    return evaluate(kind, {
      tier: (cfg.tier as AccountTier) ?? "free",
      accountAgeDays: typeof cfg.account_age_days === "number" ? cfg.account_age_days : 0,
      engagement: state.engagement ?? { sent: 0, accepted: 0, replied: 0, flagged: 0 },
      // Rolled here rather than trusted raw: the write side resets a stale counter on its next
      // touch, but nothing guarantees a touch ever comes, and a campaign that has been paused for a
      // fortnight must resume rather than stay blocked by a fortnight-old total.
      used: rollUsed(state, now),
      localHour: local.getUTCHours(),
      localDay: local.getUTCDay(),
    });
  } catch (e) {
    return {
      allowed: false,
      reason: `pacing state unavailable: ${(e as Error).message}`,
      remaining: 0,
      budget: 0,
      nextAfterMs: 60_000,
    };
  }
}

// ── The write side: closing the loop ──────────────────────────────────────────────────────────────
//
// Everything above is a READ of state that, until now, nothing wrote. `assertSendAllowed` consulted
// `connection.config.pacing` and no code path ever incremented it, so `used` stayed `{}` forever
// (the budget never decremented) and `engagement.sent` stayed 0 forever (so `engagementMultiplier`
// returned its cautious 0.6 default for the life of the account, whatever the account actually
// earned). A budget that never decrements is not a budget, and a feedback loop with no feedback is
// a constant — the two mechanisms this file's header describes were both inert.
//
// ATOMICITY. Two workers sending for the same connection must not lose an increment, and
// `updateConnection` is a read-modify-write: both read `used.message = 7`, both write 8, and one
// send is now invisible to the safety check. So these go through `DomainStore.bumpPacing`, which is
// a single arithmetic-in-the-database statement on Postgres (see domain.pg.ts) and a
// no-await-in-the-middle mutation in memory. See the guarantee stated on the interface.

/**
 * Record a touch that actually went out, against the window it belongs to.
 *
 * Call this AFTER the send succeeded, never before. A pre-increment would be safer against
 * double-sending and worse at everything else: a failed send would permanently consume a scarce
 * invitation the recipient never received, and this budget is the account's whole allowance.
 */
export async function recordTouch(
  domain: DomainStore,
  connectionId: string,
  kind: TouchKind,
  now: Date = new Date(),
): Promise<void> {
  const window = WINDOW_MS[kind] ?? WINDOW_MS.invite;
  await domain.bumpPacing(connectionId, {
    kind,
    at: now.toISOString(),
    windowResetBefore: new Date(now.getTime() - window).toISOString(),
    windowStart: now.toISOString(),
    // `engagement.sent` is the DENOMINATOR of the acceptance rate, so it counts invitations and
    // nothing else. Counting messages here would divide a fixed number of acceptances by a much
    // larger number, and every healthy account would read as one nobody wants to connect with.
    engagement: kind === "invite" ? { sent: 1 } : undefined,
  });
}

/**
 * Record how a touch landed. This is the half `engagementMultiplier` actually scores on.
 *
 * `accepted` and `replied` are the signals LinkedIn reads too, which is the point: read them first
 * and throttle ourselves before they throttle us.
 */
export async function recordEngagement(
  domain: DomainStore,
  connectionId: string,
  delta: { accepted?: number; replied?: number; flagged?: number },
  now: Date = new Date(),
): Promise<void> {
  if (!delta.accepted && !delta.replied && !delta.flagged) return;
  await domain.bumpPacing(connectionId, { at: now.toISOString(), engagement: delta });
}
