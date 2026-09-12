// One sending mailbox's own facts, and whether it may send a cold email right now.
//
// ═══ THE HOLE THIS FILLS, AND WHY IT WAS INVISIBLE ═══
//
// `sequence.ts` reads:
//
//     const touch = CROSS_CHANNEL_ACTIONS.has(step.action) ? null : touchFor(step.action);
//     const verdict = touch ? await assertSendAllowed(...) : { allowed: true, ... };
//
// The comment above it is right and the fix was half-done. Cross-channel email must NOT spend the
// LinkedIn invite budget — `touchFor` defaults unknowns to "invite", so every `em1` send was
// silently throttling the founder's LinkedIn account. Exempting email from LinkedIn's budget was
// correct. Replacing it with `{ allowed: true }` was not: cold outreach email from this kernel had
// no ceiling of any kind. No warm-up, no daily cap, no spacing, no working hours. A brand-new
// mailbox could open a hundred conversations on its first afternoon, which reads to every receiver
// exactly like a compromised account.
//
// ═══ WHY THIS IS SCOPED TO THE SEQUENCER AND NOT TO THE TRANSPORT ═══
//
// The same email connection carries cold outreach AND a dunning chase to an existing client, a
// receipt, a check-in. Those are not the same thing and must not obey the same rule: a receipt to a
// client who has just paid goes at 3am on a Sunday if that is when they paid, and an overdue invoice
// that stopped being chased because a cold mailbox hit its daily cap would be a far worse bug than
// the one this file fixes.
//
// So the ramp is applied where the CAMPAIGN is, not where the transport is — the same place
// `pacing.ts` applies LinkedIn's. Transactional mail never passes through here.
//
// ═══ WHAT IS SHARED AND WHAT IS LOCAL ═══
//
// Every rule — the schedule, the earned-week test, the penalties, the spacing, the window — is in
// `@mycel/deliverability`, so this kernel and `growth/` cannot enforce different ones. This file is
// storage and a clock. It holds no numbers.
import {
  DEFAULT_POLICY,
  applyPenalty,
  chooseInbox,
  rampFor,
  shouldBurn,
  type InboxSnapshot,
  type InboxState,
  type RampVerdict,
  type SendingPolicy,
} from "@mycel/deliverability";
import { getDomainStore } from "./../domain";
import type { Record_ } from "../contract";

export const INBOX_HEALTH_COLLECTION = "inbox_health";
/** Sending health belongs to the BUSINESS, like the suppression list. See suppression.ts. */
export const INBOX_HEALTH_WEDGE = "_business";

/** What is persisted. `key` is duplicated into `data` because `where` filters on `data` only. */
interface StoredHealth {
  key: string;
  address: string;
  domain: string;
  started_at: string;
  state: InboxState;
  penalty: number;
  penalty_at?: string;
  sent_total: number;
  bounces: number;
  complaints: number;
  /** The day `sent_today` counts, as YYYY-MM-DD in UTC. A different day resets the count. */
  day?: string;
  sent_today: number;
  last_send_at?: string;
}

const keyFor = (address: string): string => String(address ?? "").trim().toLowerCase();
const domainOf = (address: string): string => keyFor(address).split("@")[1] ?? "unknown";
const dayOf = (now: Date): string => now.toISOString().slice(0, 10);

function readHealth(r: Record_ | undefined): StoredHealth | undefined {
  const d = r?.data as StoredHealth | undefined;
  return d?.address ? d : undefined;
}

/**
 * A mailbox this kernel has never sent from starts its warm-up NOW.
 *
 * Not backdated to when the connection was made. A mailbox that was configured in March and first
 * used in September has no delivery history in September, and pretending otherwise is exactly the
 * "week 2 on four lifetime sends" failure the earned-week rule exists to stop — this simply refuses
 * to create the same hole from the other end.
 */
const fresh = (address: string, now: Date): StoredHealth => ({
  key: keyFor(address),
  address: keyFor(address),
  domain: domainOf(address),
  started_at: now.toISOString(),
  state: "warming",
  penalty: 0,
  sent_total: 0,
  bounces: 0,
  complaints: 0,
  day: dayOf(now),
  sent_today: 0,
});

async function load(projectId: string, address: string): Promise<StoredHealth | undefined> {
  const key = keyFor(address);
  const rows = await getDomainStore().queryRecords({
    project_id: projectId,
    wedge: INBOX_HEALTH_WEDGE,
    collection: INBOX_HEALTH_COLLECTION,
    where: { key },
    limit: 1,
  });
  return readHealth(rows.find((r) => r.key === key));
}

async function save(projectId: string, h: StoredHealth): Promise<void> {
  await getDomainStore().upsertRecord({
    project_id: projectId,
    wedge: INBOX_HEALTH_WEDGE,
    collection: INBOX_HEALTH_COLLECTION,
    key: h.key,
    data: h as unknown as Record<string, unknown>,
  });
}

/** The package's shape, from ours. The day counter resets here rather than on a scheduled job. */
function snapshot(h: StoredHealth, now: Date): InboxSnapshot {
  const sameDay = h.day === dayOf(now);
  return {
    address: h.address,
    domain: h.domain,
    displayName: null,
    startedAt: new Date(h.started_at),
    state: h.state,
    penalty: h.penalty,
    penaltyAt: h.penalty_at ? new Date(h.penalty_at) : null,
    sentTotal: h.sent_total,
    bounces: h.bounces,
    complaints: h.complaints,
    sentToday: sameDay ? h.sent_today : 0,
    lastSendAt: h.last_send_at ? new Date(h.last_send_at) : null,
  };
}

export interface SendWindow {
  allowed: boolean;
  /** Written for a founder to read, never for a log. */
  reason: string;
  /** Milliseconds to wait before trying again. Never zero — a parked case needs a time. */
  nextAfterMs: number;
  ramp: RampVerdict;
  remaining: number;
}

const MINUTE = 60_000;

/**
 * May this mailbox send a COLD email right now?
 *
 * Every rule comes from `chooseInbox`, given a fleet of one. Using the fleet function for a single
 * mailbox rather than reimplementing its four checks is deliberate: the day this kernel grows a
 * second sending mailbox, rotation and the per-domain ceiling are already correct, and the refusal
 * codes a founder sees do not change underneath them.
 */
export async function mayEmail(args: {
  project_id: string;
  address: string;
  now?: Date;
  policy?: SendingPolicy;
}): Promise<SendWindow> {
  const now = args.now ?? new Date();
  const policy = args.policy ?? DEFAULT_POLICY;
  const stored = (await load(args.project_id, args.address)) ?? fresh(args.address, now);
  const snap = snapshot(stored, now);
  const result = chooseInbox([snap], policy, now);
  const plan = result.plans[0]!;
  const remaining = plan.remaining;

  if (result.choice) {
    return { allowed: true, reason: plan.ramp.reason, nextAfterMs: Math.max(MINUTE, result.choice.delaySeconds * 1000), ramp: plan.ramp, remaining };
  }

  /**
   * The refusal a founder reads, and the wait that goes with it.
   *
   * Each one names a different situation and a different length of wait, because "come back in four
   * minutes" and "come back tomorrow" being the same sentence is how a founder learns to ignore the
   * sentence. `outside_window` waits until the window could plausibly have opened rather than
   * computing the exact hour: the wait is a floor, and the next attempt re-checks.
   */
  const said: Record<string, { reason: string; wait: number }> = {
    outside_window: { reason: "outside the hours this mailbox sends in — cold email lands on a weekday, in working hours", wait: 60 * MINUTE },
    all_at_cap: { reason: `this mailbox has sent its ${plan.ramp.cap} for today (${plan.ramp.reason})`, wait: 6 * 60 * MINUTE },
    all_spacing: { reason: plan.blocked ?? "sending again this soon would look like a machine", wait: 15 * MINUTE },
    all_paused: { reason: plan.ramp.reason, wait: 24 * 60 * MINUTE },
    domain_ceiling: { reason: "this domain has carried enough of today's sending", wait: 6 * 60 * MINUTE },
    no_inboxes: { reason: "no sending mailbox is configured", wait: 24 * 60 * MINUTE },
  };
  const chosen = said[result.refusal ?? "no_inboxes"] ?? said.no_inboxes!;
  return { allowed: false, reason: chosen.reason, nextAfterMs: chosen.wait, ramp: plan.ramp, remaining };
}

/**
 * One cold email went out. Called AFTER a successful dispatch, never before.
 *
 * Counting on intent rather than on success would let a run of transport failures eat a mailbox's
 * whole allowance without a single message reaching anybody — and the warm-up would then advance on
 * volume that was never delivered, which is the exact fiction the earned-week rule exists to refuse.
 */
export async function recordEmailSend(args: { project_id: string; address: string; now?: Date }): Promise<void> {
  const now = args.now ?? new Date();
  const h = (await load(args.project_id, args.address)) ?? fresh(args.address, now);
  const sameDay = h.day === dayOf(now);
  await save(args.project_id, {
    ...h,
    state: h.state === "warming" || h.state === "active" ? h.state : h.state,
    sent_total: h.sent_total + 1,
    day: dayOf(now),
    sent_today: (sameDay ? h.sent_today : 0) + 1,
    last_send_at: now.toISOString(),
  });
}

/**
 * A bounce or a complaint, applied to the mailbox that sent it.
 *
 * The penalty numbers and the burn threshold are the package's. What is here is that a burned
 * mailbox is stored as `burned` and stays that way: it sends zero and a human has to clear it.
 * Deliberately not self-healing — "it fixed itself overnight" is how a burned mailbox quietly
 * resumes and finishes the job of burning the domain.
 */
export async function penaliseInbox(args: {
  project_id: string;
  address: string;
  kind: "complaint" | "hard_bounce" | "transient_bounce";
  now?: Date;
}): Promise<{ penalty: number; state: InboxState }> {
  const now = args.now ?? new Date();
  const h = (await load(args.project_id, args.address)) ?? fresh(args.address, now);
  const applied = applyPenalty({ penalty: h.penalty, penaltyAt: h.penalty_at ? new Date(h.penalty_at) : null }, args.kind, now);
  const next: StoredHealth = {
    ...h,
    penalty: applied.penalty,
    ...(applied.penaltyAt ? { penalty_at: applied.penaltyAt.toISOString() } : {}),
    bounces: h.bounces + (args.kind === "complaint" ? 0 : 1),
    complaints: h.complaints + (args.kind === "complaint" ? 1 : 0),
  };
  if (shouldBurn({ penalty: next.penalty })) next.state = "burned";
  await save(args.project_id, next);
  return { penalty: next.penalty, state: next.state };
}

/** Every sending mailbox this business has, decided. For a health board and for a founder's answer. */
export async function inboxHealth(projectId: string, now: Date = new Date()): Promise<(InboxSnapshot & { ramp: RampVerdict })[]> {
  const rows = await getDomainStore().queryRecords({
    project_id: projectId,
    wedge: INBOX_HEALTH_WEDGE,
    collection: INBOX_HEALTH_COLLECTION,
    limit: 100,
  });
  return rows
    .map(readHealth)
    .filter((h): h is StoredHealth => !!h)
    .map((h) => {
      const snap = snapshot(h, now);
      return { ...snap, ramp: rampFor(snap, now, DEFAULT_POLICY.maxPerInboxPerDay) };
    });
}
