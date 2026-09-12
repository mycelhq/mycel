// WHAT A HUMAN LOOKS LIKE TO LINKEDIN, AND WHY THE FIRST RUN DID NOT.
//
// ═══ THE EVIDENCE THIS FILE IS BUILT ON ═══
//
// The production worker's first ever connection requests went out on 7 September at:
//
//     13:00:33  13:00:41  13:01:04  13:01:10  13:01:16     — five invites in 43 seconds
//
// and the sixth came back HTTP 429. That was read as "the account has no invitations left in its
// rolling weekly window (~100)", and the number was used to plan a whole launch. It was wrong:
// `invites.ts` classifies a bare 429 as `weekly` when the body says nothing readable, and its
// WEEKLY_SIGNAL regex also matches `RATE_LIMIT` — which means the opposite thing. The account had
// sent FIVE invitations in its entire life. A ~100/week allowance cannot be exhausted by five.
//
// So the 429 was throttling, not a quota: one action every ~11 seconds is not a person, and
// LinkedIn said so. The ceiling is much higher than five — but only for a client that behaves.
//
// ═══ WHAT THIS MODULE ENFORCES ═══
//
// Four independent brakes, because the failure they prevent is different in each case:
//
//   1. GAP        no two actions closer than ~45s, jittered — kills the machine-gun signature.
//   2. BURST      a hard ceiling per rolling ten minutes — kills "six quick ones then a pause",
//                 which averages out fine over an hour and still looks nothing like a person.
//   3. DAY        a per-seat daily budget on a warm-up ramp — a dormant account that starts
//                 sending twenty invitations a day is the classic restriction trigger.
//   4. WEEK       LinkedIn's own ~100/week invitation allowance, as a hard stop.
//
// Every one of them returns a WAIT, never a failure. A brake is something we do to ourselves;
// booking it as an error is how a healthy account gets marked dead.

/** An action a seat can take. Only `invite` is charged against LinkedIn's weekly allowance. */
export type Action = "invite" | "message" | "view" | "check";

export interface PaceConfig {
  /** Floor between any two actions, before jitter. */
  minGapMs: number;
  /** Jitter added on top of the floor, uniform in [0, gapJitterMs). */
  gapJitterMs: number;
  /** Ceiling on actions in any rolling ten minutes. */
  burstPer10Min: number;
  /** Daily invite budget by day-of-life, last entry repeats forever. */
  ramp: readonly number[];
  /**
   * The most invitations we will attempt in seven days BEFORE LinkedIn has told us its real
   * number. Not a belief about the limit — a bound on how far we are willing to probe for it.
   */
  weeklyProbeCeiling: number;
  /** Local hours [start, end) in which this seat is awake. */
  hours: readonly [number, number];
}

export const DEFAULT_PACE: PaceConfig = {
  minGapMs: 45_000,
  gapJitterMs: 135_000,
  burstPer10Min: 6,
  // Day 1 is deliberately tiny. Three of these accounts belong to somebody's family and have
  // never sent a cold invitation in their life; the ramp is what makes that survivable.
  ramp: [8, 12, 16, 20, 25, 25, 30],
  weeklyProbeCeiling: 220,
  hours: [9, 18],
};

/**
 * For an ESTABLISHED account that already does outreach — the founder's own.
 *
 * The gentle ramp exists because a dormant account that suddenly sends twenty invitations a day
 * is the classic restriction trigger. That argument does not apply to an account with history, so
 * this one starts where the other finishes. It is still paced: the gap and burst brakes are about
 * looking human, and those apply to everybody.
 */
export const ESTABLISHED_PACE: PaceConfig = {
  ...DEFAULT_PACE,
  ramp: [20, 25, 30, 35, 35, 40, 40],
  burstPer10Min: 7,
};

/**
 * A REAL PERSON'S ACCOUNT THAT HAS NEVER DONE OUTREACH — which is what three of these four are.
 *
 * `DEFAULT_PACE` opens at 8/day, and 8 was the wrong number for this case. The ramp exists because
 * a DORMANT account that suddenly sends twenty invitations a day is a classic restriction trigger.
 * A sibling's ordinary LinkedIn is not dormant: it has a real profile, real connections, years of
 * history, and a login from this city. What it lacks is a habit of sending invitations, and that is
 * a smaller gap than the cautious ramp assumes.
 *
 * So this starts at 12 and reaches 30 by day five. The truly cautious ramp stays available for what
 * it was written for: an account created recently, with few connections and nothing on it.
 *
 * The gap and burst brakes are identical for every profile. Those are about looking like a person,
 * which is not negotiable for anybody.
 */
export const PERSONAL_PACE: PaceConfig = {
  ...DEFAULT_PACE,
  ramp: [12, 16, 20, 25, 30, 30, 30],
};

/** A brand-new account with no history. The original cautious ramp, named for what it is. */
export const NEW_ACCOUNT_PACE: PaceConfig = DEFAULT_PACE;

export type PaceProfile = "new" | "personal" | "established";

export function paceFor(profile: PaceProfile | string | null | undefined): PaceConfig {
  return profile === "established" ? ESTABLISHED_PACE : profile === "new" ? NEW_ACCOUNT_PACE : PERSONAL_PACE;
}

/** What the seat has already done, newest first is NOT required — these are just timestamps. */
export interface SeatHistory {
  /** Epoch ms of every action taken by this seat, any kind. */
  actions: readonly number[];
  /** Epoch ms of every INVITE by this seat. */
  invites: readonly number[];
  /** When this seat first sent anything, for the ramp. Null = it has never run. */
  firstRunAt: number | null;
  /**
   * LinkedIn's ACTUAL weekly allowance for this seat, learned from LinkedIn's own refusal, or
   * null while we still do not know.
   *
   * ═══ A CEILING MUST BE A READING, NOT A SETTING ═══
   *
   * `weeklyInviteCap: 100` was a guess dressed as a fact. The published figure is the common
   * case, not the rule — the real allowance varies with account age, connection count and past
   * acceptance rate, and nothing about OUR configuration changes it. Setting ours to 300 would
   * not buy 300 invitations; it would buy this seat's real number plus two hundred refusals, and
   * repeated refused writes are exactly what earns an account a challenge.
   *
   * So the number is discovered instead. A seat probes up to `weeklyProbeCeiling`, and the FIRST
   * time LinkedIn says the limit is reached, the count at that moment is recorded here and
   * respected from then on. One refusal per seat per week is the entire price of knowing the
   * truth, and it is cheaper than either guessing low forever or hammering.
   */
  observedWeeklyCap: number | null;
}

export type Verdict =
  | { go: true }
  | { go: false; waitMs: number; because: string };

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Day-of-life, 1-indexed: the ramp's first entry applies on the first day a seat runs. */
export function dayOfLife(h: SeatHistory, now: number): number {
  if (h.firstRunAt === null) return 1;
  return Math.max(1, Math.floor((now - h.firstRunAt) / DAY) + 1);
}

/** Today's invite budget for this seat. */
export function budgetToday(cfg: PaceConfig, h: SeatHistory, now: number): number {
  const day = dayOfLife(h, now);
  return cfg.ramp[Math.min(day, cfg.ramp.length) - 1] ?? cfg.ramp[cfg.ramp.length - 1] ?? 0;
}

const since = (xs: readonly number[], from: number) => xs.filter((t) => t >= from).length;

/**
 * May this seat act right now?
 *
 * Order matters only for the message the caller shows a human; every brake is checked and the
 * LONGEST wait wins, so a seat that is both out of hours and mid-burst is told the real answer
 * rather than being woken up to be refused again.
 */
export function mayAct(
  action: Action,
  cfg: PaceConfig,
  h: SeatHistory,
  now: number,
  localHour: number,
): Verdict {
  const waits: { waitMs: number; because: string }[] = [];

  // `check` is reading our own inbox — a person does that whenever they like, and it sends
  // nothing to anybody. It is exempt from every outbound brake except working hours.
  const outbound = action !== "check";

  const [from, to] = cfg.hours;
  if (localHour < from) {
    waits.push({ waitMs: (from - localHour) * HOUR, because: `asleep — this seat starts at ${from}:00 local` });
  } else if (localHour >= to) {
    waits.push({ waitMs: (24 - localHour + from) * HOUR, because: `done for the day — this seat stops at ${to}:00 local` });
  }

  if (outbound) {
    const last = h.actions.length ? Math.max(...h.actions) : null;
    if (last !== null) {
      const gap = cfg.minGapMs + Math.floor(Math.random() * cfg.gapJitterMs);
      const elapsed = now - last;
      if (elapsed < gap) {
        waits.push({ waitMs: gap - elapsed, because: "too soon after the last action" });
      }
    }

    const inBurst = since(h.actions, now - 10 * 60_000);
    if (inBurst >= cfg.burstPer10Min) {
      waits.push({
        waitMs: 10 * 60_000,
        because: `${inBurst} actions in ten minutes is the burst ceiling — five in 43 seconds is what earned the 429`,
      });
    }
  }

  if (action === "invite") {
    const budget = budgetToday(cfg, h, now);
    const sentToday = since(h.invites, now - DAY);
    if (sentToday >= budget) {
      waits.push({ waitMs: DAY - (now - (h.invites[h.invites.length - budget] ?? now)), because: `today's budget of ${budget} invites is spent` });
    }
    const sentThisWeek = since(h.invites, now - 7 * DAY);
    const ceiling = h.observedWeeklyCap ?? cfg.weeklyProbeCeiling;
    if (sentThisWeek >= ceiling) {
      waits.push({
        waitMs: HOUR,
        because:
          h.observedWeeklyCap === null
            ? `${sentThisWeek} invites in seven days without LinkedIn objecting — holding at the probe ceiling rather than pushing further blind`
            : `${sentThisWeek} of this seat's measured ${h.observedWeeklyCap}/week allowance is spent — only time restores it`,
      });
    }
  }

  if (waits.length === 0) return { go: true };
  const worst = waits.reduce((a, b) => (b.waitMs > a.waitMs ? b : a));
  return { go: false, waitMs: Math.max(1000, Math.round(worst.waitMs)), because: worst.because };
}

/**
 * How long to dwell on a profile before acting on it.
 *
 * A person opens a profile, reads it, and only then decides. An invitation sent 200ms after the
 * page load has no reading in it, and the gap between load and click is the cheapest behavioural
 * signal there is.
 */
export const dwellMs = (): number => 4_000 + Math.floor(Math.random() * 11_000);
