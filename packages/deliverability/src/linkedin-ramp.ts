// The LinkedIn warm-up ramp. Pure functions over one account's own facts — no database, no clock of
// its own, and deliberately the same shape as `ramp.ts` next door.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// WHY THIS EXISTS: EMAIL HAD A RAMP AND LINKEDIN HAD THREE NUMBERS IN TERRAFORM
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// `LINKEDIN_CAP_PROFILE_VIEW=18`, `LINKEDIN_CAP_INVITE=8`, `LINKEDIN_CAP_MESSAGE=10`, set as the
// control for a one-day experiment. The terraform comment beside them says so outright: "a first day
// well inside the only number we have ever measured. If it survives a full day, raise these; the
// caps are the experiment's control, not a permanent opinion."
//
// It survived. Nobody raised them. So the account has been running at roughly a quarter of what is
// safe for months, and the founder's complaint — that go-to-market is throttled by gates that serve
// nothing — is arithmetically correct.
//
// The wrong fix is to set them to the safe number. `5 on Monday and 400 on Tuesday reads exactly
// like a compromised account` is the argument at the top of the email ramp, and the field research
// says the same thing about this network in stronger terms: sudden activity spikes, especially
// around invitations, profile views and messaging, are the single strongest predictor of a CAPTCHA
// check or a restriction. A flat raise is the spike.
//
// So: a ramp, earned rather than waited out, with the ceilings set where the evidence puts them.
//
// ═══ THE CEILINGS, AND WHERE EACH NUMBER COMES FROM ═══
//
//   INVITES — 22/day is the top of the safe corridor for an established account, and 18–22 is where
//   field guidance sits. But the binding constraint is not daily: LinkedIn enforces a rolling
//   ~100/week invitation cap, reputation-adjusted (a strong SSI can reach 200, a weak one is held
//   at 80). 22 × 5 working days is 110, which is over. `WEEKLY_INVITE_CAP` is therefore enforced
//   ALONGSIDE the daily number and binds first — the flat cap ignored the weekly rule entirely.
//
//   MESSAGES — 30–50/day for personalised messages to existing connections. Templated messaging
//   draws more scrutiny, which is an argument about content rather than volume and belongs to the
//   copy gate, not here.
//
//   PROFILE VIEWS — 80/day is the hard ceiling on a free account. Guidance is to stay under 60
//   until the account is well-established (6+ months with consistent activity) before approaching
//   it. This account is weeks old, so 60 is the ceiling here and 80 is recorded as the number we
//   deliberately do not go near.
//
// ═══ EARNED, NOT WAITED OUT — THE SAME RULE, FOR A SHARPER REASON ═══
//
// `ramp.ts` learned this from three mailboxes that sent four emails between them in a week and were
// about to be handed a fifteen-fold increase for surviving seven days of doing nothing. Time did not
// build the reputation; delivered mail did.
//
// LinkedIn is stricter, because the thing being measured is not deliverability but whether the
// account behaves like a person. An account that did nothing for six weeks and then sends 22
// invitations in a day has not earned week 7 — it has produced exactly the step change the network
// watches for. So the week paid is the lesser of what the calendar allows and what the account's own
// completed volume has earned, identically to email.
//
// ═══ AND A CHALLENGE COSTS MORE THAN A COMPLAINT ═══
//
// A bounced email costs a little reputation. A LinkedIn challenge costs the SESSION — every pending
// step stops, a human has to re-authenticate from the right browser behind the right proxy, and the
// account carries a mark. It is the most expensive single event in this channel.
//
// So a challenge does not decay like a complaint penalty. It drops the account to week 1 and makes
// it climb again. That is deliberately harsh: the alternative is resuming at the volume that drew
// the challenge, which is how an account goes from challenged to restricted to gone.

/** Daily allowances by week, index 0 = week 1. Steady state at index 7 (week 8+). */
export const LINKEDIN_RAMP = {
  /** Capped by WEEKLY_INVITE_CAP as well — the weekly rule binds before this does. */
  invite: [8, 10, 12, 14, 16, 18, 20, 20],
  message: [10, 15, 20, 25, 30, 35, 40, 50],
  profile_view: [18, 25, 32, 40, 48, 54, 58, 60],
} as const satisfies Record<string, readonly number[]>;

export type LinkedInAction = keyof typeof LINKEDIN_RAMP;

/**
 * The rolling seven-day invitation cap LinkedIn actually enforces.
 *
 * Conservative on purpose: the published soft cap is ~100/week and is reputation-adjusted upward for
 * strong accounts, but an account that has just been challenged is not a strong account. 100 is the
 * number that is true for everyone.
 */
export const WEEKLY_INVITE_CAP = 100;

/** The free-account hard ceiling on profile views. Recorded so the distance from it is visible. */
export const PROFILE_VIEW_HARD_CEILING = 80;

/** What one account's own history says. Everything here is a fact the caller already stores. */
export interface LinkedInAccountState {
  /** When the session was first used to act. Absent means it has never acted — week 1. */
  firstActionAt?: string | Date | null;
  /** Completed actions, all kinds, over this account's life. Drives the earned week. */
  completedActions: number;
  /** The most recent challenge, if any. Resets the ramp — see the header. */
  lastChallengeAt?: string | Date | null;
  /** Invitations sent in the last rolling seven days, for the weekly cap. */
  invitesLast7Days?: number;
}

export interface LinkedInAllowance {
  /** How many of this action may go out today. */
  limit: number;
  /** The week being paid at, 1-indexed. */
  week: number;
  /** Why the number is what it is — goes in a log, a trace, or an operator screen. */
  why: string;
}

const asTime = (v: string | Date | null | undefined): number | null => {
  if (!v) return null;
  const t = v instanceof Date ? v.getTime() : Date.parse(v);
  return Number.isNaN(t) ? null : t;
};

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The week the CALENDAR allows, 1-indexed, counted from the account's first action or its last
 * challenge — whichever is later. A challenge restarts the clock; see the header.
 */
export function calendarWeek(state: LinkedInAccountState, now: number = Date.now()): number {
  const started = asTime(state.firstActionAt);
  if (started === null) return 1;
  const challenged = asTime(state.lastChallengeAt);
  const from = challenged !== null && challenged > started ? challenged : started;
  return Math.max(1, Math.floor((now - from) / WEEK_MS) + 1);
}

/**
 * The week the account's own VOLUME has earned.
 *
 * An account only reaches week N by having actually completed roughly what weeks 1..N-1 permitted.
 * Uses the profile_view schedule as the denominator because it is the highest-volume action and the
 * one an account performs even on days it sends nothing — it is the closest thing to a pulse.
 */
export function earnedWeek(completedActions: number): number {
  let needed = 0;
  for (let i = 0; i < LINKEDIN_RAMP.profile_view.length; i++) {
    // Five working days at the previous week's allowance to earn the next one.
    needed += LINKEDIN_RAMP.profile_view[i]! * 5;
    if (completedActions < needed) return i + 1;
  }
  return LINKEDIN_RAMP.profile_view.length;
}

/**
 * What may go out today, for one action, on one account.
 *
 * Returns a limit and the reason for it. A caller that only reads `.limit` is correct; the `why` is
 * for the operator screen and the trace, because "8 invites" with no explanation is how a cap
 * becomes a mystery nobody dares raise.
 */
export function linkedInAllowance(
  action: LinkedInAction,
  state: LinkedInAccountState,
  now: number = Date.now(),
): LinkedInAllowance {
  const schedule = LINKEDIN_RAMP[action];
  const week = Math.min(calendarWeek(state, now), earnedWeek(state.completedActions));
  const idx = Math.min(week, schedule.length) - 1;
  const daily = schedule[idx]!;

  const challenged = asTime(state.lastChallengeAt);
  const recentlyChallenged = challenged !== null && now - challenged < WEEK_MS;

  if (action !== "invite") {
    return {
      limit: daily,
      week,
      why: recentlyChallenged
        ? `week ${week} after a challenge reset the ramp`
        : `week ${week} of the warm-up`,
    };
  }

  /**
   * THE WEEKLY CAP BINDS FIRST, and the flat cap this replaces did not know it existed.
   *
   * 20 a day across five working days is 100 — exactly the rolling weekly limit — so at steady state
   * the two agree and neither is redundant. What the weekly remainder catches is a burst: three
   * heavy days early in the week must not be followed by two more.
   */
  const used = Math.max(0, state.invitesLast7Days ?? 0);
  const weeklyRemaining = Math.max(0, WEEKLY_INVITE_CAP - used);
  if (weeklyRemaining < daily) {
    return {
      limit: weeklyRemaining,
      week,
      why: `${used} of ${WEEKLY_INVITE_CAP} invitations used in the last 7 days`,
    };
  }
  return {
    limit: daily,
    week,
    why: recentlyChallenged ? `week ${week} after a challenge reset the ramp` : `week ${week} of the warm-up`,
  };
}
