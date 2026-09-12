// The warm-up ramp. Pure functions over one inbox's own facts — no database, no clock of its own,
// no shared constant that would make the whole fleet move together.
//
// ═══ MOVED HERE FROM growth/lib/email/ramp.ts, UNCHANGED ═══
//
// Every number below carries an argument somebody has already had, and several of them carry an
// observation from a real fleet — the 2026-08-27 note about three mailboxes being handed a
// fifteen-fold increase for having survived seven days of doing nothing is not a hypothetical, it is
// a bug that was found and fixed. Re-deriving this on the kernel side would have produced different
// numbers with none of the evidence, which is the mistake this repo made once with the Xero tool
// slugs and does not intend to make again.
//
// So: `growth/` (selling Mycel) and `kernel/` (the agency's own outreach) now share ONE ramp. Two
// sending systems enforcing different warm-up schedules is two answers to "may this mailbox send
// today", and the one that is wrong is the one that burns a domain.
//
// WHAT A WARM-UP ACTUALLY IS, because the word gets used for two different things. It is not "send a
// few and hope". A brand-new sending identity has no reputation at any receiver, and receivers treat
// "no history" and "bad history" nearly identically for the first weeks: low inbox placement, high
// greylisting, aggressive rate limiting. The only way to build history is to send small volumes that
// get delivered and engaged with, and to grow the volume slowly enough that the growth curve itself
// does not look like a compromised account. A mailbox that sends 5 messages on Monday and 400 on
// Tuesday is indistinguishable, from the receiver's side, from a mailbox whose password just leaked.
//
// THE SCHEDULE:
//
//   week 1     5 / day     establishing that the domain exists and mail from it is wanted
//   week 2    15 / day     tripling is aggressive but survivable off a delivered week 1
//   week 3    25 / day
//   week 4    30 / day     the old permanent ceiling; now a plateau rather than a stop
//   week 5    35 / day
//   week 6    40 / day
//   week 7    45 / day
//   week 8+   50 / day     steady state.
//
// THE CEILING MOVED FROM 30 TO 50, AND THE ARGUMENT AGAINST 30 IS WEAKER THAN IT LOOKS. The case for
// stopping at 30 was that it is the top of what one human plausibly sends by hand in a working day,
// and that more volume should be bought by adding MAILBOXES instead. The first half is a real
// signal and the second half is still true — rotation.ts is how the fleet scales, not this constant.
// But 50 individual sends spread across an eight-hour day is one every ten minutes, which is a
// person working a list, not a machine; the number that gives a receiver pause is not 50, it is 50
// sent in four minutes, and that is `throttle.ts`'s problem rather than this file's. Zoho Mail Lite
// permits well above this per mailbox, so the binding constraint here is reputation, never the
// provider's quota.
//
// WHAT MATTERS MORE THAN THE CEILING IS THAT NOTHING JUMPS. The failure this file exists to prevent
// is a step change — 5 on Monday and 400 on Tuesday reads exactly like a compromised account. So the
// extra volume is four more 5-a-day steps rather than one leap from 30 to 50, and reaching steady
// state now takes eight weeks instead of four. That is the honest cost of the higher number, and it
// is why raising the ceiling is not the same as getting the volume sooner: an inbox registered today
// is at 30/day in four weeks either way.
//
// If complaints appear, the penalty machinery below drags this back down on its own — and it drags
// down from wherever the inbox actually is, so a week-8 mailbox that draws two complaints sends 30
// tomorrow, not 50.
//
// THE RAMP GOES DOWN AS WELL AS UP, which is the part most warm-up implementations miss. `penalty`
// is measured in WEEKS of the ramp: a complaint costs one week, so a week-4 inbox that draws a
// complaint sends 25 tomorrow instead of 30, and a second complaint puts it back to 15. That is a
// meaningful, immediate cost, and it is automatic — nobody has to notice.
//
// Penalty DECAYS, one week per clean fortnight (see PENALTY_DECAY_DAYS). Without decay a single bad
// address would cripple a mailbox forever, which pushes an operator toward the one thing that must
// never be easy: editing the penalty by hand. With decay, recovery is a function of behaving well
// for a while, which is exactly what it should be.

export type InboxState = "warming" | "active" | "paused" | "burned";

/** Everything the ramp is allowed to look at. Deliberately one inbox's facts and nothing global. */
export interface InboxHealth {
  /** The warm-up clock. Week 1 starts here. */
  startedAt: Date;
  state: InboxState;
  /** Weeks of step-back accumulated from complaints and hard bounces. */
  penalty: number;
  /** When the penalty was last incremented. Decay is measured from here. */
  penaltyAt: Date | null;
  sentTotal: number;
  bounces: number;
  complaints: number;
}

/** Sends per day at effective week 1, 2, … 8+. Index is (week - 1), clamped to the last entry. */
export const RAMP: readonly number[] = [5, 15, 25, 30, 35, 40, 45, 50] as const;

/**
 * ═══ THE RAMP IS EARNED, NOT WAITED OUT ═══
 *
 * Everything above describes a schedule measured in CALENDAR weeks, and that is a hole big enough to
 * drive the exact failure this file exists to prevent through.
 *
 * Observed 2026-08-27. All three mailboxes: started 21 August, calendar week 2, therefore permitted
 * 15/day each — 45/day across the fleet. Actual sends in their entire existence: 2, 1 and 1. Four
 * emails, total. They have precisely no delivery history, no receiver has formed any opinion of
 * them, and the ramp was about to hand them a fifteen-fold increase for having survived seven days
 * of doing nothing.
 *
 * "5 on Monday and 400 on Tuesday reads exactly like a compromised account" is the argument at the
 * top of this file. 1/day for a week and then 15/day is the same shape. Time did not build the
 * reputation; DELIVERED MAIL builds the reputation, and there was none.
 *
 * So the week an inbox is paid at is now the lesser of what the calendar allows and what its own
 * volume has earned. An inbox that actually works its allowance advances on schedule and notices
 * nothing. An inbox that sits idle stays at week 1 until it sends something, which is both safer and
 * the honest description of where it stands.
 *
 * WORKING_DAYS is 5 because the send window is weekdays (`window="9-17 days 12345"`), so a week of
 * ramp is five sending days, not seven.
 *
 * EARNED_FRACTION is 0.6, not 1.0, and the slack is deliberate. Requiring a mailbox to max its cap
 * every single day would mean one quiet Tuesday — a holiday, a thin lead list, a deploy — permanently
 * stalls the ramp, and an operator facing that reaches for the one lever nobody should want them
 * touching: editing the schedule by hand. Sixty percent is "this mailbox is genuinely in use"
 * without demanding perfection.
 */
const WORKING_DAYS = 5;
const EARNED_FRACTION = 0.6;

/**
 * The highest week this inbox's own delivered volume justifies, 1-based.
 *
 * Walks the ramp accumulating what a mailbox that actually worked each week would have behind it.
 * The first week whose requirement is not met is the week it is still in.
 */
export function earnedWeek(sentTotal: number): number {
  const sent = Math.max(0, sentTotal ?? 0);
  let cumulative = 0;
  for (let w = 1; w <= RAMP.length; w++) {
    cumulative += RAMP[w - 1]! * WORKING_DAYS * EARNED_FRACTION;
    if (sent < cumulative) return w;
  }
  return RAMP.length;
}

/** The permanent ceiling. Exported so the UI can render "24/30" without re-deriving it. */
export const RAMP_CEILING: number = RAMP[RAMP.length - 1]!;

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

/** One week of penalty falls off after this many clean days. */
export const PENALTY_DECAY_DAYS = 14;

/**
 * Health clamps. These are ABSOLUTE, not relative to the current week: an inbox whose bounce rate is
 * over 5% goes to week-1 volume no matter how old it is, because age is evidence of nothing once the
 * list feeding the mailbox is bad.
 *
 * `MIN_SAMPLE` stops the first bounce from a three-send-old inbox reading as a 33% bounce rate.
 * Before the sample is meaningful the ramp runs on age alone — which is safe, because at that point
 * age alone means 5 a day.
 */
export const HEALTH_MIN_SAMPLE = 20;
export const BOUNCE_CLAMP_RATE = 0.05;
export const COMPLAINT_CLAMP_RATE = 0.003; // 0.3%, ten times AWS's action line. Well past "concerning".

/** Age of the inbox in whole weeks, 1-based. Day 0 is week 1. */
export function warmupWeek(startedAt: Date, now: Date): number {
  const age = now.getTime() - startedAt.getTime();
  if (!Number.isFinite(age) || age < 0) return 1;
  return Math.floor(age / WEEK_MS) + 1;
}

/**
 * The penalty that actually applies now, after decay. Stored penalty is a high-water mark; this is
 * what it has faded to.
 */
export function effectivePenalty(h: Pick<InboxHealth, "penalty" | "penaltyAt">, now: Date): number {
  const stored = Math.max(0, Math.floor(h.penalty ?? 0));
  if (stored === 0) return 0;
  if (!h.penaltyAt) return stored;
  const cleanDays = (now.getTime() - h.penaltyAt.getTime()) / DAY_MS;
  if (cleanDays <= 0) return stored;
  const decayed = Math.floor(cleanDays / PENALTY_DECAY_DAYS);
  return Math.max(0, stored - decayed);
}

export interface RampVerdict {
  /** The week of the ramp this inbox is being paid at. 1-based, after penalty. */
  week: number;
  /** Calendar week, before penalty. Shown next to `week` so a step-down is legible in the UI. */
  calendarWeek: number;
  penalty: number;
  /** Sends allowed today. */
  cap: number;
  /** Why the cap is what it is. One line, rendered in the health board. */
  reason: string;
  bounceRate: number;
  complaintRate: number;
}

/**
 * The daily ceiling for ONE inbox, from ITS OWN age and ITS OWN health.
 *
 * Order matters: the state check comes first (a paused mailbox is paused, full stop), then age, then
 * penalty, then the health clamps, then the operator's global ceiling. Every step can only ever
 * LOWER the number. There is no input to this function that raises a cap.
 */
export function rampFor(h: InboxHealth, now: Date, maxPerInboxPerDay = RAMP_CEILING): RampVerdict {
  const sent = Math.max(0, h.sentTotal ?? 0);
  const bounceRate = sent > 0 ? (h.bounces ?? 0) / sent : 0;
  const complaintRate = sent > 0 ? (h.complaints ?? 0) / sent : 0;

  const calendarWeek = warmupWeek(h.startedAt, now);
  const penalty = effectivePenalty(h, now);

  /** `!` is safe by construction: the index is clamped into the array on the line itself. */
  const base = (week: number): number => RAMP[Math.min(Math.max(1, week), RAMP.length) - 1]!;

  if (h.state === "paused" || h.state === "burned") {
    return {
      week: 0,
      calendarWeek,
      penalty,
      cap: 0,
      reason: h.state === "paused" ? "paused by hand" : "burned: health past recovery, a human must clear this",
      bounceRate,
      complaintRate,
    };
  }

  /**
   * The lesser of what the calendar allows and what this mailbox's own sending has earned.
   *
   * Both directions are guarded by this one line. Idle-but-old cannot claim volume it never built
   * (the bug: week 2 and 15/day on four lifetime sends). Busy-but-new cannot outrun the calendar
   * either, because reputation takes wall-clock time to register at a receiver no matter how eagerly
   * you send — which is the original argument and still true.
   */
  const allowed = Math.max(1, calendarWeek - penalty);
  const earned = earnedWeek(sent);
  const week = Math.min(allowed, earned);

  let cap = base(week);
  let reason =
    penalty > 0
      ? `week ${calendarWeek} stepped back ${penalty} to week ${week} by complaints/bounces`
      : earned < allowed
        ? `week ${calendarWeek} by the calendar, but ${sent} sent so far only earns week ${earned}`
        : `week ${calendarWeek} of warm-up`;

  // Health clamps. Applied after the ramp so the reason string tells the truth about which rule bit.
  if (sent >= HEALTH_MIN_SAMPLE) {
    if (bounceRate > BOUNCE_CLAMP_RATE && base(1) < cap) {
      cap = base(1);
      reason = `bounce rate ${(bounceRate * 100).toFixed(1)}% over ${(BOUNCE_CLAMP_RATE * 100).toFixed(0)}%: held at week-1 volume`;
    }
    if (complaintRate > COMPLAINT_CLAMP_RATE && base(1) < cap) {
      cap = base(1);
      reason = `complaint rate ${(complaintRate * 100).toFixed(2)}% over ${(COMPLAINT_CLAMP_RATE * 100).toFixed(1)}%: held at week-1 volume`;
    }
  }

  if (maxPerInboxPerDay < cap) {
    cap = Math.max(0, maxPerInboxPerDay);
    reason = `operator ceiling COLD_INBOX_MAX_PER_DAY=${maxPerInboxPerDay}`;
  }

  return { week, calendarWeek, penalty, cap, reason, bounceRate, complaintRate };
}

/**
 * What a complaint or hard bounce costs, in weeks of ramp.
 *
 * A COMPLAINT IS WORTH MORE THAN A BOUNCE and the asymmetry is the whole judgement here. A bounce
 * means the address was wrong — bad data, and the fix is upstream in sourcing. A complaint means the
 * address was RIGHT and a real person read what we sent and said "this is spam". That is a verdict on
 * the message, and it is the signal AWS suspends accounts over. So a complaint costs two weeks and a
 * hard bounce costs one.
 *
 * The step-back is relative to where the inbox actually is, not to a fixed floor, so the bite scales
 * with the ramp: two complaints take a week-4 mailbox from 30/day to 5/day, and a week-8 mailbox at
 * steady state from 50/day to 30/day. The mature inbox is punished less in proportion, which is
 * correct — it has the delivery history to have earned the benefit of the doubt once — and four
 * complaints put it at week 1 regardless.
 *
 * Transient bounces cost nothing. A full mailbox is not a list-quality problem.
 */
export const PENALTY_COMPLAINT = 2;
export const PENALTY_HARD_BOUNCE = 1;

export function penaltyFor(kind: "complaint" | "hard_bounce" | "transient_bounce"): number {
  if (kind === "complaint") return PENALTY_COMPLAINT;
  if (kind === "hard_bounce") return PENALTY_HARD_BOUNCE;
  return 0;
}

/**
 * Apply a penalty to stored state. Returns the new stored values; the caller persists them.
 *
 * Note it stacks onto the STORED penalty, not the decayed one, and resets the decay clock. Two
 * complaints thirteen days apart therefore cost the full four weeks rather than three — being bad
 * twice in a fortnight is worse than being bad twice in a year, and the arithmetic should say so.
 */
export function applyPenalty(
  h: Pick<InboxHealth, "penalty" | "penaltyAt">,
  kind: "complaint" | "hard_bounce" | "transient_bounce",
  now: Date,
): { penalty: number; penaltyAt: Date | null } {
  const add = penaltyFor(kind);
  if (add === 0) return { penalty: h.penalty ?? 0, penaltyAt: h.penaltyAt ?? null };
  return { penalty: Math.max(0, Math.floor(h.penalty ?? 0)) + add, penaltyAt: now };
}

/**
 * When an inbox has sunk far enough that continuing to use it is the problem.
 *
 * Ten weeks of accumulated penalty is five complaints, or a long unbroken run of both. At that point
 * the mailbox is not warming up badly, it is burned, and every further send from it is spending
 * account-level reputation for a mailbox that will not deliver anyway. `burned` sends zero and needs
 * a human to clear — deliberately not self-healing, because "it fixed itself overnight" is how a
 * burned mailbox quietly resumes.
 */
export const BURN_PENALTY_WEEKS = 10;

export function shouldBurn(h: Pick<InboxHealth, "penalty">): boolean {
  return (h.penalty ?? 0) >= BURN_PENALTY_WEEKS;
}
