// Which mailbox sends the next message, and whether one should be sent at all.
//
// ═══ MOVED HERE FROM growth/lib/email/rotation.ts ═══
//
// One change from the original: it took `ColdEmailConfig`, which is growth's whole email config
// object — provider, region, AWS configuration set, unsubscribe secret, postal address. None of that
// is a rotation decision, and depending on it would have dragged an app's environment loading into a
// pure package. So the four rules below now take `SendingPolicy`, which is exactly the fields they
// read and nothing else. `ColdEmailConfig` satisfies it structurally, so growth passes its config
// unchanged.
//
//
// FOUR RULES, each closing a different way this looks like a machine:
//
//   1. PER-INBOX DAILY CAP — the ramp from ramp.ts. Never exceeded, never averaged across mailboxes.
//   2. SPACING — a mailbox that sent 90 seconds ago does not send again. Real people do not emit
//      messages on a fixed interval, so the floor is a floor and jitter is added on top.
//   3. PER-DOMAIN CEILING — no domain may account for more than `domainMaxShare` of the day. With two
//      domains at 0.5 this is barely binding; it becomes the whole point the moment one domain's
//      inboxes are healthier than the other's, because without it the healthy domain would silently
//      absorb all the volume and then be the only domain that gets burned.
//
//      AND WITH ONE DOMAIN IT IS MAXIMALLY BINDING, WHICH IS THE OPPOSITE OF WHAT IT IS FOR. The
//      sentence above assumed two. On 31 August the fleet was three mailboxes on one domain: 3 x 5 =
//      15 a day of capacity, ceiling floor(15 x 0.5) = 7, and exactly 7 emails went out before every
//      further attempt refused with `domain_ceiling`. Half the fleet's capacity was not reserved for
//      anyone — there was nobody to reserve it for — it was simply deleted. See `domainCeiling`.
//   4. WORKING HOURS — sends land inside a working window, on working days. Cold mail timestamped
//      03:14 on a Sunday is not from a founder.
//
// LEAST-USED-FIRST, not round-robin. Round-robin looks fair and is not: inboxes have different caps
// (different ages, different penalties), so a fixed rotation over-serves the newest mailbox and
// under-serves the mature one. Sorting by fraction-of-cap-consumed spreads load in PROPORTION to what
// each mailbox can safely carry, which is what "spread the sends" actually means.

import type { InboxHealth, RampVerdict } from "./ramp";
import { RAMP_CEILING, rampFor } from "./ramp";

/**
 * Everything rotation is allowed to look at. Deliberately NOT an app's config object.
 *
 * A pure function that takes a config with an AWS region and an HMAC secret in it is a pure function
 * that will eventually read one. This is the narrow slice — four rules' worth of numbers — and both
 * apps' own config objects satisfy it structurally.
 */
export interface SendingPolicy {
  /** Hard ceiling per inbox per day, applied ON TOP of the warm-up ramp. Never raises it. */
  maxPerInboxPerDay: number;
  /** Fraction of the day's total capacity any ONE domain may account for. */
  domainMaxShare: number;
  /** Minimum gap between two sends from the SAME mailbox, before jitter. */
  minSpacingSeconds: number;
  /** Random extra gap added to every send, so the cadence is not a metronome. */
  jitterMinSeconds: number;
  jitterMaxSeconds: number;
  /** Working-hours window for sends, in the SENDING account's timezone. [start, end). */
  windowStartHour: number;
  windowEndHour: number;
  /** ISO weekdays sends are allowed on: 1 = Monday … 7 = Sunday. */
  windowDays: number[];
}

/**
 * A policy that refuses nothing it does not have to, for a caller that has not configured one.
 *
 * Not a lax default: the ramp still binds, the window is still weekday business hours, and spacing
 * still applies. It is the set of numbers a sending system should start at, so that "we have not
 * configured deliverability yet" produces careful sending rather than no sending and never
 * unrestricted sending.
 */
export const DEFAULT_POLICY: SendingPolicy = {
  maxPerInboxPerDay: RAMP_CEILING,
  domainMaxShare: 0.5,
  minSpacingSeconds: 90,
  jitterMinSeconds: 15,
  jitterMaxSeconds: 180,
  windowStartHour: 9,
  windowEndHour: 17,
  windowDays: [1, 2, 3, 4, 5],
};

export interface InboxSnapshot extends InboxHealth {
  address: string;
  domain: string;
  displayName: string | null;
  /** Sends already made today, in the window's timezone. */
  sentToday: number;
  lastSendAt: Date | null;
}

/**
 * What this fleet can physically send in a whole day, right now.
 *
 * The sum of each mailbox's OWN ramp cap — not what is left today, and not what is unblocked this
 * minute. Spending decisions are about the size of the pipe, and a mailbox that is merely spacing
 * for another eleven minutes still carries its full daily allowance.
 *
 * Exists because the audit pass was buying 40c artifacts with no reference to this number at all:
 * three sends a day against 438 enrolled people is a 146-day queue, and an audit cached for 14 days
 * is bought to expire. See `assets/lookahead.ts`.
 */
export function dailySendCapacity(
  inboxes: readonly InboxSnapshot[],
  cfg: SendingPolicy,
  now: Date = new Date(),
): number {
  return inboxes.reduce((n, i) => n + Math.max(0, rampFor(i, now, cfg.maxPerInboxPerDay).cap), 0);
}

export interface InboxPlan extends InboxSnapshot {
  ramp: RampVerdict;
  /** Sends still available from this mailbox today. */
  remaining: number;
  /** Null when this mailbox could send right now. Otherwise the reason it cannot. */
  blocked: string | null;
  /** The earliest this mailbox may send again, when spacing is what is holding it. */
  nextEligibleAt: Date | null;
}

export type RotationRefusal =
  | "outside_window"
  | "no_inboxes"
  | "all_at_cap"
  | "all_spacing"
  | "domain_ceiling"
  | "all_paused";

export interface RotationChoice {
  inbox: InboxPlan;
  /** Seconds to wait before actually sending, so the cadence is never a metronome. */
  delaySeconds: number;
}

export interface RotationResult {
  choice: RotationChoice | null;
  refusal: RotationRefusal | null;
  /** Every inbox, decided. The health board renders this whether or not a send happens. */
  plans: InboxPlan[];
  /** Capacity across the whole fleet today, and how much of it is spent. */
  capacity: { cap: number; used: number; remaining: number };
  /** Per-domain, with the ceiling applied. */
  domains: { domain: string; cap: number; used: number; ceiling: number; remaining: number }[];
}

/** ISO weekday, 1 = Monday … 7 = Sunday. `Date#getUTCDay` is 0 = Sunday. */
const isoWeekday = (d: Date): number => ((d.getUTCDay() + 6) % 7) + 1;

/**
 * Working hours, evaluated in UTC.
 *
 * NOTE THE DIFFERENCE FROM lib/engine/hours.ts, which evaluates the PROSPECT's timezone. That is
 * right for LinkedIn, where the touch is visible to the recipient the moment it happens. It is wrong
 * here: the visible timestamp on an email is the SENDER's, and a mailbox that emits mail at all hours
 * of its own local day is the anomaly. So this window is the sending account's, and per-recipient
 * timing is a scheduling concern for the sequencer, not a deliverability one.
 */
export function inWindow(now: Date, cfg: SendingPolicy): boolean {
  if (!cfg.windowDays.includes(isoWeekday(now))) return false;
  const h = now.getUTCHours();
  return h >= cfg.windowStartHour && h < cfg.windowEndHour;
}

/** Deterministic in tests: pass a `rand` that returns a fixed number. */
export type Rand = () => number;

function jitter(cfg: SendingPolicy, rand: Rand): number {
  const span = Math.max(0, cfg.jitterMaxSeconds - cfg.jitterMinSeconds);
  return Math.round(cfg.jitterMinSeconds + rand() * span);
}

/** Seconds left in today's sending window, or 0 once it has closed. */
export function windowSecondsLeft(now: Date, cfg: SendingPolicy): number {
  if (!cfg.windowDays.includes(isoWeekday(now))) return 0;
  const h = now.getUTCHours() + now.getUTCMinutes() / 60 + now.getUTCSeconds() / 3600;
  if (h >= cfg.windowEndHour) return 0;
  const from = Math.max(h, cfg.windowStartHour);
  return Math.max(0, Math.round((cfg.windowEndHour - from) * 3600));
}

/**
 * Spacing floor for one mailbox. Derived from its OWN cap rather than being a constant: a week-1
 * mailbox with 5 sends spreads them across the window (about 100 minutes apart), while a
 * steady-state mailbox at 30 sends every ~18 minutes. Both look like someone working through a list;
 * a constant would make the week-1 mailbox fire all five in the first hour and then go silent, which
 * is the more suspicious shape.
 *
 * ═══ AGAINST THE REMAINING WINDOW, NOT THE WHOLE ONE ═══
 *
 * This divided the FULL window by the FULL cap, always — so the pace was set as if every day began
 * with the window and none of the quota spent. It never did.
 *
 * 31 August, exactly: window 08:00–17:00, cap 5 a mailbox, so spacing = 32400/5 = 108 minutes.
 * The first email went at 11:30, because the copy gate had been rejecting everything before that.
 * From 11:30 to 17:00 is 330 minutes, which at 108 apart is three sends a mailbox. Three across
 * three mailboxes is nine or ten. TEN WENT, out of fifteen, and the five that did not were not
 * refused by anything — the pacer had already decided the day was 108 minutes wide per send and
 * would not narrow it as the day ran out.
 *
 * Any day that starts late could therefore never recover its quota, and days DO start late: a
 * deploy, a challenged session, a copy gate that needed fixing. The fix is one line of arithmetic —
 * spread what is LEFT of the cap across what is LEFT of the window — and it makes the quota
 * reachable from any starting point instead of only from 08:00.
 *
 * NOTHING ABOUT DELIVERABILITY IS RELAXED. `minSpacingSeconds` is the floor and is untouched: a
 * mailbox can still never send twice inside it, however late the day is. This narrows the gap
 * toward that floor; it cannot cross it. The cap itself — the warm-up ramp — is also untouched.
 *
 * `now` and `sentToday` are optional so every existing caller keeps the old whole-window answer,
 * which is the right one when there is no clock to reason about.
 */
export function spacingSeconds(cap: number, cfg: SendingPolicy, now?: Date, sentToday = 0): number {
  if (cap <= 0) return Number.POSITIVE_INFINITY;
  const whole = Math.max(1, (cfg.windowEndHour - cfg.windowStartHour) * 3600);
  if (!now) return Math.max(cfg.minSpacingSeconds, Math.floor(whole / cap));

  const left = Math.max(0, cap - sentToday);
  if (left <= 0) return Number.POSITIVE_INFINITY;
  const secondsLeft = windowSecondsLeft(now, cfg);
  // Outside the window there is nothing to pace against; `inWindow` refuses the send anyway, and
  // returning the whole-window figure keeps the number on the board meaningful rather than 0.
  if (secondsLeft <= 0) return Math.max(cfg.minSpacingSeconds, Math.floor(whole / cap));
  return Math.max(cfg.minSpacingSeconds, Math.floor(secondsLeft / left));
}

/**
 * Decide. `now` and `rand` are injected so this is a pure function of its inputs.
 *
 * The refusal codes matter as much as the choice: "all_at_cap" at 2pm is the system working
 * correctly, and "all_spacing" means come back in a few minutes. Collapsing both into `null` would
 * make a healthy engine indistinguishable from a stalled one on the board.
 */
export function chooseInbox(
  inboxes: readonly InboxSnapshot[],
  cfg: SendingPolicy,
  now: Date = new Date(),
  rand: Rand = Math.random,
): RotationResult {
  const plans: InboxPlan[] = inboxes.map((i) => {
    const ramp = rampFor(i, now, cfg.maxPerInboxPerDay);
    const remaining = Math.max(0, ramp.cap - i.sentToday);
    // Paced against what is LEFT of the day and what is LEFT of this mailbox's cap. See the note
    // on `spacingSeconds`: dividing the whole window by the whole cap meant a day that started at
    // 11:30 could only ever reach ten of fifteen.
    const space = spacingSeconds(ramp.cap, cfg, now, i.sentToday);
    const nextEligibleAt =
      i.lastSendAt && Number.isFinite(space) ? new Date(i.lastSendAt.getTime() + space * 1000) : null;

    let blocked: string | null = null;
    if (ramp.cap === 0) blocked = ramp.reason;
    else if (remaining === 0) blocked = `at cap (${i.sentToday}/${ramp.cap})`;
    else if (nextEligibleAt && nextEligibleAt > now) {
      const mins = Math.ceil((nextEligibleAt.getTime() - now.getTime()) / 60000);
      blocked = `spacing: ${mins}m to go`;
    }

    return { ...i, ramp, remaining, blocked, nextEligibleAt };
  });

  const totalCap = plans.reduce((n, p) => n + p.ramp.cap, 0);
  const totalUsed = plans.reduce((n, p) => n + p.sentToday, 0);

  // Per-domain accounting. The ceiling is a share of the FLEET's capacity, not of the domain's own —
  // otherwise "no domain may exceed 50% of itself" is a tautology that constrains nothing.
  const byDomain = new Map<string, { cap: number; used: number }>();
  for (const p of plans) {
    const d = byDomain.get(p.domain) ?? { cap: 0, used: 0 };
    d.cap += p.ramp.cap;
    d.used += p.sentToday;
    byDomain.set(p.domain, d);
  }
  const domainCeiling = (d: string): number => {
    const own = byDomain.get(d)?.cap ?? 0;
    // A SHARE RULE NEEDS SOMETHING TO SHARE WITH. This rule protects a fleet from letting its
    // healthiest domain absorb all the volume and take all the damage. With one domain there is no
    // other domain to absorb from and none to protect: the domain IS the fleet, and the rule stops
    // distributing volume and starts deleting it.
    //
    // Deliberately `< 2` rather than a config flag. The condition under which the rule means
    // something is a fact about the fleet, and reading it off the fleet is what stops it from being
    // a setting somebody has to know to change.
    //
    // NOTHING ABOUT DELIVERABILITY IS RELAXED HERE. Rule 1 — the per-inbox warm-up ramp — is the
    // protection, it is per mailbox, and it is untouched. This only stops a distribution rule from
    // binding where there is no distribution to do.
    if (byDomain.size < 2) return own;
    // The ceiling can only ever LOWER a domain's own capacity. A share that exceeds what the domain's
    // mailboxes can carry is not extra permission.
    return Math.min(own, Math.floor(totalCap * cfg.domainMaxShare));
  };
  const domains = [...byDomain.entries()].map(([domain, d]) => {
    const ceiling = domainCeiling(domain);
    return { domain, cap: d.cap, used: d.used, ceiling, remaining: Math.max(0, ceiling - d.used) };
  });

  const capacity = {
    cap: domains.reduce((n, d) => n + d.ceiling, 0),
    used: totalUsed,
    remaining: domains.reduce((n, d) => n + d.remaining, 0),
  };

  const refuse = (refusal: RotationRefusal): RotationResult => ({ choice: null, refusal, plans, capacity, domains });

  if (plans.length === 0) return refuse("no_inboxes");
  if (!inWindow(now, cfg)) return refuse("outside_window");
  if (plans.every((p) => p.ramp.cap === 0)) return refuse("all_paused");

  const domainHasRoom = (d: string) => (domains.find((x) => x.domain === d)?.remaining ?? 0) > 0;

  const eligible = plans.filter((p) => p.blocked === null && domainHasRoom(p.domain));

  if (eligible.length === 0) {
    // Order the diagnosis from most to least structural, so the board says the useful thing.
    if (plans.some((p) => p.blocked === null)) return refuse("domain_ceiling");
    if (plans.every((p) => p.remaining === 0)) return refuse("all_at_cap");
    return refuse("all_spacing");
  }

  // Least-used-first by FRACTION of its own cap, then by longest-idle, then by address so the order
  // is stable and a test can assert it.
  const sorted = [...eligible].sort((a, b) => {
    const fa = a.sentToday / Math.max(1, a.ramp.cap);
    const fb = b.sentToday / Math.max(1, b.ramp.cap);
    if (fa !== fb) return fa - fb;
    const la = a.lastSendAt?.getTime() ?? 0;
    const lb = b.lastSendAt?.getTime() ?? 0;
    if (la !== lb) return la - lb;
    return a.address.localeCompare(b.address);
  });

  return {
    choice: { inbox: sorted[0]!, delaySeconds: jitter(cfg, rand) },
    refusal: null,
    plans,
    capacity,
    domains,
  };
}
