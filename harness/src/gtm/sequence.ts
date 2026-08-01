// The outreach sequencer: what turns an approved campaign into messages that arrive like a person
// sent them.
//
// THE SHAPE, AND WHY IT IS THIS SHAPE:
//
//   · ONE CASE PER PROSPECT PER CAMPAIGN. `Case` already has `stage`, an INDEXED `due_at`, and a
//     `history` — it was built for exactly this. So there is no queue table, no per-prospect timer,
//     and no in-memory state that a restart loses. The sequence is the stage list in stages.ts.
//
//   · A FREQUENT, SMALL TICK. Every ~5 minutes, a bounded batch. A rejected design ran once daily
//     at 09:00 and spawned every due draft at once — which is the bot signature pacing.ts exists to
//     avoid. `nextIntervalMs` spreads an account's whole daily allowance across its working hours
//     with ±40% jitter precisely so the traffic does not look like a cron, and that only works if
//     something wakes up often enough to honour it. Frequent and small, always.
//
//   · THE CLAIM IS THE SCHEDULER'S. `claimDueSchedules` already guarantees one fire across N
//     replicas (FOR UPDATE SKIP LOCKED). Inventing a second timer here would mean two systems that
//     each believe they are the one sending, which is the double-send bug with extra steps.
//
//   · PACING IS THE CEILING, NOT THE POLICY ENGINE. `policy.ts` counters are in-process `Map`s:
//     with N replicas they permit N× what they claim, and they reset to zero (fail OPEN) on every
//     deploy. They must never be the only thing between an agent and a restricted account.
//     `assertSendAllowed` is store-backed and fails closed, and it is consulted here before every
//     single send — after which the send path increments the counter it just spent (see
//     linkedin/connect.ts), because until today nothing did.
import { randomUUID } from "node:crypto";
import type { Case, Connection, Schedule, Task } from "../contract";
import type { DomainStore } from "../domain";
import type { Store } from "../store";
import { executeAction, type ActionResult } from "../actions";
import { emitEvent } from "../events";
import { riskFor, touchFor } from "../linkedin/capabilities";
import { assertSendAllowed, nextIntervalMs, type PacingVerdict } from "../pacing";
import { runWorkflow } from "../workflows";
import { campaignEnvelope, loadCampaign, type Campaign, type SequenceStep } from "./campaign";
import { evaluateCondition } from "./conditions";
import { GTM_WEDGE, isActive } from "./stages";

/** The task type a sequencer Schedule spawns. Matched by the scheduler — see scheduler.ts. */
export const ADVANCE_TASK_TYPE = "advance_sequences";

/** Five minutes: frequent enough to honour jittered spacing, cheap enough to be uninteresting. */
export const TICK_SECONDS = 300;

/**
 * How many cases one tick will touch.
 *
 * Bounded twice over, and the bound is the point. Pacing refuses most of them anyway, but an
 * unbounded loop over every due case is how a backlog becomes a burst the moment a window opens.
 */
export const BATCH = 25;

/** A pending invitation stops counting against the weekly limit only when it is withdrawn. */
const INVITE_STALE_DAYS = 21;
/** How long a finished sequence waits before it is closed out. */
const TRAIL_DAYS = 7;

const DAY_MS = 86_400_000;

// ── dispatch ─────────────────────────────────────────────────────────────────────────────────────

export interface DispatchResult extends ActionResult {
  /** The step names a capability nothing can execute yet. Not a failure — a gap, said out loud. */
  unsupported?: boolean;
}

export type Dispatcher = (
  conn: Connection,
  action: string,
  payload: Record<string, unknown>,
) => Promise<DispatchResult>;

/**
 * The real dispatcher.
 *
 * Everything goes through `executeAction`, the same door every other connection kind uses, so a
 * sequenced send inherits the executor's secret handling and the LinkedIn send path's pacing check
 * and counter increment. A step whose capability has no executor yet is reported as unsupported
 * rather than quietly skipped: skipping an invitation and then messaging a stranger who never
 * accepted is worse than doing nothing and saying so.
 */
const realDispatcher: Dispatcher = async (conn, action, payload) => {
  if (action === "send_message") return executeAction(conn, action, payload);
  return {
    ok: false,
    unsupported: true,
    detail: `"${action}" has no executor yet — the sequence is paused at this step rather than skipping it`,
  };
};

let dispatcher: Dispatcher = realDispatcher;
/** Test hook: swap the dispatcher (default is the real, gated executor). */
export function _setDispatcher(fn: Dispatcher | null): void {
  dispatcher = fn ?? realDispatcher;
}

// ── facts ────────────────────────────────────────────────────────────────────────────────────────

/**
 * The facts an `only_if` may read, computed by the harness from the case — never supplied by a
 * model. That is what makes the condition language safe to expose.
 */
export function factsFor(kase: Case): Record<string, boolean> {
  const d = (kase.data ?? {}) as Record<string, unknown>;
  const stage = kase.stage;
  const reached = (s: string) => ["queued", "warmed", "invited", "connected", "dm1", "dm2"].indexOf(stage) >= ["queued", "warmed", "invited", "connected", "dm1", "dm2"].indexOf(s);
  return {
    warmed: reached("warmed"),
    invited: reached("invited"),
    connected: d.connected === true || reached("connected"),
    replied: d.has_reply === true || stage === "replied",
    opted_out: d.opt_out === true,
    has_thread: typeof d.thread === "string" && d.thread.length > 0,
  };
}

// ── the tick ─────────────────────────────────────────────────────────────────────────────────────

export interface TickSummary {
  processed: number;
  sent: number;
  paced: number;
  parked: number;
  closed: number;
  /** Set when the tick did nothing on purpose — surfaced so "nothing happened" is never a mystery. */
  note?: string;
}

/**
 * Advance every case that is due, for ONE project.
 *
 * `project_id` is required and fails closed. A Schedule with no project must process NOTHING rather
 * than everything: `listCases` treats an absent project as "no tenant filter", so an unscoped
 * schedule would happily sequence every customer's prospect list through one founder's LinkedIn
 * account. That is the worst bug this file could have, so it is the first line of it.
 */
export async function advanceSequences(
  store: Store,
  domain: DomainStore,
  opts: { project_id?: string; now?: Date; limit?: number } = {},
): Promise<TickSummary> {
  const summary: TickSummary = { processed: 0, sent: 0, paced: 0, parked: 0, closed: 0 };
  if (!opts.project_id) {
    summary.note =
      "this sequencer schedule has no project — refusing to process anything. " +
      "Recreate it with a project so it can only ever touch that tenant's cases.";
    return summary;
  }
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();

  const all = await domain.listCases({ project_id: opts.project_id, wedge: GTM_WEDGE, status: "open" });
  const due = all
    .filter((k) => isActive(k.stage) && !!(k.data as Record<string, unknown>)?.campaign_id)
    .filter((k) => !k.due_at || k.due_at <= nowIso)
    // Oldest due first: a case that has been waiting longest goes first, so a backlog drains in
    // order instead of starving whoever was enrolled early.
    .sort((a, b) => (a.due_at ?? "") < (b.due_at ?? "") ? -1 : 1)
    .slice(0, opts.limit ?? BATCH);

  // Campaigns are shared by every case in them; one read each rather than one per case.
  const campaigns = new Map<string, Campaign | undefined>();

  for (const kase of due) {
    summary.processed++;
    try {
      const outcome = await advanceCase(store, domain, kase, now, campaigns);
      if (outcome === "sent") summary.sent++;
      else if (outcome === "paced") summary.paced++;
      else if (outcome === "closed") summary.closed++;
      else summary.parked++;
    } catch (e) {
      // One broken case must not stop the other twenty-four. Park it with the reason visible.
      summary.parked++;
      await park(domain, kase, now, 60 * 60 * 1000, `sequencer error: ${(e as Error).message}`).catch(() => {});
    }
  }
  return summary;
}

type Outcome = "sent" | "paced" | "parked" | "closed";

/** Push a case out, and put a sentence on it the founder can read without asking anyone. */
async function park(domain: DomainStore, kase: Case, now: Date, afterMs: number, reason: string): Promise<void> {
  await domain.updateCase(kase.id, {
    due_at: new Date(now.getTime() + Math.max(60_000, afterMs)).toISOString(),
    data: { ...(kase.data ?? {}), paused_reason: reason, paused_at: now.toISOString() },
  });
}

async function closeCase(domain: DomainStore, kase: Case, now: Date, stage: string, note: string): Promise<Outcome> {
  await domain.updateCase(
    kase.id,
    { stage, status: "closed", closed_at: now.toISOString(), data: { ...(kase.data ?? {}), paused_reason: note } },
    { at: now.toISOString(), kind: "closed", from: kase.stage, to: stage, note, actor: "system" },
  );
  return "closed";
}

async function advanceCase(
  store: Store,
  domain: DomainStore,
  kase: Case,
  now: Date,
  campaigns: Map<string, Campaign | undefined>,
): Promise<Outcome> {
  const data = (kase.data ?? {}) as Record<string, unknown>;
  const campaignId = String(data.campaign_id ?? "");

  if (!campaigns.has(campaignId)) campaigns.set(campaignId, await loadCampaign(domain, kase.project_id, campaignId));
  const campaign = campaigns.get(campaignId);
  if (!campaign) {
    await park(domain, kase, now, 6 * 60 * 60 * 1000, "this campaign is missing or belongs to another project");
    return "parked";
  }

  const step = campaign.steps.find((s) => s.from === kase.stage);
  if (!step) return waitingStage(domain, kase, now);

  // Stopping is a first-class outcome, and it is not this file's opinion: next_touch.mjs in the
  // gtm-operator wedge already decides whether a sequence continues at all, from the facts. It is
  // pure and clock-free, so it is asked rather than reimplemented here.
  const cadence = await cadenceFor(kase, step, now);
  if (cadence.stop) return closeCase(domain, kase, now, cadence.stage ?? "lost", cadence.reason);
  if (cadence.waitMs > 0) {
    await park(domain, kase, now, cadence.waitMs, cadence.reason);
    return "parked";
  }

  if (!evaluateCondition(step.only_if, factsFor(kase))) {
    // Not an error: the step's precondition is not met YET. The facts move (an invitation gets
    // accepted, a reply lands), so this is re-checked rather than abandoned.
    await park(domain, kase, now, 6 * 60 * 60 * 1000, `waiting: this step runs only if ${step.only_if}`);
    return "parked";
  }

  const conn = await domain.getConnection(campaign.connection_id);
  if (!conn) {
    await park(domain, kase, now, 6 * 60 * 60 * 1000, "the LinkedIn account for this campaign is gone — reconnect it");
    return "parked";
  }

  // PACING FIRST, before the envelope and before anything is drafted or dispatched. It is the only
  // ceiling in this system that is store-backed and fails closed, and its refusals are written for
  // a founder to read ("outside this account's working hours") rather than for a log.
  const touch = touchFor(step.action);
  const verdict: PacingVerdict = touch
    ? await assertSendAllowed(domain, conn.id, touch)
    : { allowed: true, remaining: 0, budget: 0, nextAfterMs: 60_000 };
  if (!verdict.allowed) {
    await park(domain, kase, now, verdict.nextAfterMs, `paused — ${verdict.reason ?? "pacing refused this send"}`);
    return "paced";
  }

  const envelope = await campaignEnvelope(store, domain, {
    campaign,
    kase,
    connection: conn,
    action: step.action,
    now,
  });
  if (!envelope.auto) {
    // Fifteen minutes for "waiting for you to approve", six hours for anything structural — a
    // founder who approves at lunchtime should see the campaign start that afternoon.
    const retryMs = envelope.reason.startsWith("waiting") ? 15 * 60 * 1000 : 6 * 60 * 60 * 1000;
    await park(domain, kase, now, retryMs, envelope.reason);
    return "parked";
  }

  return dispatchStep(store, domain, { campaign, kase, conn, step, verdict, envelopeReason: envelope.reason, now });
}

/**
 * A stage with no step is not a stuck case — it is a case waiting on somebody else.
 *
 * `invited` waits for an acceptance we do not control. `dm2` is the end of the sequence. Both need
 * an exit, or an unanswered invitation sits in the list for ever looking like a bug.
 */
async function waitingStage(domain: DomainStore, kase: Case, now: Date): Promise<Outcome> {
  const ageMs = now.getTime() - Date.parse(kase.updated_at ?? kase.created_at);
  if (kase.stage === "invited" && ageMs >= INVITE_STALE_DAYS * DAY_MS) {
    // Pending invitations count against the weekly limit until they are withdrawn, so an
    // invitation nobody answered is not merely a dead lead — it is budget the account is still
    // paying for. Closing it is what makes `withdraw_invite` worth doing next.
    return closeCase(domain, kase, now, "lost", `no answer after ${INVITE_STALE_DAYS} days — withdraw the invitation to recover the allowance`);
  }
  if (kase.stage === "dm2" && ageMs >= TRAIL_DAYS * DAY_MS) {
    return closeCase(domain, kase, now, "lost", "sequence finished with no reply — a clean close, not another message");
  }
  await park(domain, kase, now, 12 * 60 * 60 * 1000, kase.stage === "invited" ? "waiting for them to accept" : "sequence complete — waiting before close");
  return "parked";
}

interface Cadence {
  stop: boolean;
  stage?: string;
  waitMs: number;
  reason: string;
}

/** How `stage` maps onto next_touch.mjs's own vocabulary. Only message steps have a cadence. */
const NEXT_TOUCH_STAGE: Record<string, string> = { connected: "prospect", dm1: "touch_1", dm2: "touch_2" };

/**
 * Ask the wedge's cadence workflow whether to send, and how long to wait if not.
 *
 * The workflow owns the spacing between TOUCHES (4 days, 3 days, then a clean close) and the
 * stopping rules (reply, booking, opt-out). Pacing owns the spacing WITHIN a day. They are
 * different questions and neither is a substitute for the other, so both are consulted and the
 * later of the two wins.
 */
async function cadenceFor(kase: Case, step: SequenceStep, now: Date): Promise<Cadence> {
  const d = (kase.data ?? {}) as Record<string, unknown>;
  if (d.opt_out === true) return { stop: true, stage: "lost", waitMs: 0, reason: "opted out — stop permanently" };
  if (d.has_reply === true) return { stop: true, stage: "replied", waitMs: 0, reason: "they replied — this one is yours" };

  const lastTouch = typeof d.last_touch_at === "string" ? Date.parse(d.last_touch_at) : NaN;
  const daysSince = Number.isFinite(lastTouch) ? (now.getTime() - lastTouch) / DAY_MS : null;
  const floorMs = (step.wait_days ?? 0) * DAY_MS;
  const ownFloor =
    daysSince !== null && floorMs > 0 && now.getTime() - lastTouch < floorMs
      ? { stop: false, waitMs: floorMs - (now.getTime() - lastTouch), reason: `waiting ${step.wait_days}d between touches` }
      : { stop: false, waitMs: 0, reason: "" };

  const ntStage = NEXT_TOUCH_STAGE[step.from];
  if (!ntStage || step.action !== "send_message") return ownFloor;

  const r = await runWorkflow(GTM_WEDGE, "next_touch", {
    stage: ntStage,
    has_reply: d.has_reply === true,
    opt_out: d.opt_out === true,
    days_since_last_touch: daysSince === null ? null : Math.floor(daysSince),
    touch_count: Number(d.touch_count ?? 0),
  });
  // If the wedge is not deployed beside this harness, fall back to the step's own floor rather than
  // sending unconditionally — an absent cadence must not read as "send now".
  if (!r.ok || !r.data) return ownFloor;

  const v = r.data as { should_send?: boolean; mark_closed?: boolean; next_stage?: string; next_touch_after_days?: number | null; reason?: string };
  if (v.mark_closed) return { stop: true, stage: v.next_stage === "replied" ? "replied" : "lost", waitMs: 0, reason: v.reason ?? "cadence closed this sequence" };
  if (v.should_send === false) {
    const days = v.next_touch_after_days ?? 1;
    return { stop: false, waitMs: Math.max(ownFloor.waitMs, days * DAY_MS), reason: v.reason ?? "not due yet" };
  }
  return ownFloor;
}

/**
 * Do the thing, and record that it was done — including the auto-approval.
 *
 * The approval row is not decoration. An auto-approved send that leaves no row is a bypass: the
 * founder consented to a campaign, and the only way that stays honest is if every message it
 * produced is inspectable afterwards, individually, with the reason the envelope allowed it.
 */
async function dispatchStep(
  store: Store,
  domain: DomainStore,
  args: {
    campaign: Campaign;
    kase: Case;
    conn: Connection;
    step: SequenceStep;
    verdict: PacingVerdict;
    envelopeReason: string;
    now: Date;
  },
): Promise<Outcome> {
  const { campaign, kase, conn, step, verdict, now } = args;
  const data = (kase.data ?? {}) as Record<string, unknown>;
  const copy = (data.copy ?? {}) as Record<string, string>;
  const iso = now.toISOString();

  const payload: Record<string, unknown> = {
    connection_id: conn.id,
    profile_id: data.profile_id,
    thread: data.thread,
    // The copy was written and approved BEFORE the founder said yes. Nothing is drafted at send
    // time, which is the whole reason one approval can cover two hundred messages honestly.
    body: copy[step.action] ?? copy[kase.stage] ?? "",
  };
  if (step.action === "send_message" && !payload.thread) {
    await park(domain, kase, now, 12 * 60 * 60 * 1000, "no conversation to reply into yet — a DM needs an accepted connection");
    return "parked";
  }
  if (step.action === "send_message" && !payload.body) {
    await park(domain, kase, now, 24 * 60 * 60 * 1000, "no approved copy for this step — nothing will be improvised");
    return "parked";
  }

  // One Task per send: the anchor an approval, a timeline and an audit entry all hang off. It is a
  // row, not a run — no model is invoked, because the words were approved days ago.
  const task: Task = {
    id: randomUUID(),
    project_id: campaign.project_id,
    case_id: kase.id,
    client_id: kase.client_id,
    wedge: GTM_WEDGE,
    task_type: "outreach_touch",
    actor: { kind: "system", id: `campaign:${campaign.id}` },
    input: { campaign_id: campaign.id, case_id: kase.id, step: step.action, stage: kase.stage },
    constraints: { max_runtime_s: 60, max_cost_usd: 0, approval_required: false },
    tools: [],
    status: "running",
    cost_usd: 0,
    created_at: iso,
    updated_at: iso,
  };
  await store.createTask(task);

  const approval = await store.createApproval({
    task_id: task.id,
    action: `linkedin:${step.action}`,
    risk: riskFor(step.action),
    preview: {
      campaign: campaign.name,
      to: data.name ?? data.profile_id,
      capability: step.action,
      preview: typeof payload.body === "string" ? payload.body.slice(0, 400) : undefined,
    },
  });
  // Auto-approved, WITH the reason — this is what keeps campaign autonomy auditable rather than a
  // hole. It lands in the same queue a human-gated approval does.
  await store.setApproval(approval.approval_id, "auto_approved", args.envelopeReason);
  await emitEvent(store, task.id, "approval.resolved", {
    approval_id: approval.approval_id,
    action: `linkedin:${step.action}`,
    decision: "auto_approved",
    policy_reason: args.envelopeReason,
  });

  const result = await dispatcher(conn, step.action, payload);
  await emitEvent(store, task.id, "tool.result", { tool: `linkedin:${step.action}`, ok: result.ok, detail: result.detail });

  if (!result.ok) {
    await store.setStatus(task.id, "failed", result.detail);
    // An unsupported step is a gap in the harness, not a flaky network: retrying it in an hour
    // would just fill the timeline. A day, with the reason on the case.
    await park(domain, kase, now, result.unsupported ? DAY_MS : 60 * 60 * 1000, result.detail ?? "the send failed");
    return "parked";
  }
  await store.setStatus(task.id, "succeeded");

  // The pacing counter is NOT incremented here. The send path owns it (linkedin/connect.ts), which
  // is the only place that knows a message was actually accepted by LinkedIn — incrementing in both
  // would charge the account twice for one message and throttle it for no reason.
  const dailyBudget = touchFor(step.action) === "invite" ? verdict.budget / 5 : verdict.budget / 7;
  const spacingMs = nextIntervalMs(Math.max(1, dailyBudget));
  const cadenceMs = (step.wait_days ?? 0) * DAY_MS;
  await domain.updateCase(
    kase.id,
    {
      stage: step.advance_to,
      // The LATER of the two: jittered within-day spacing, and the cadence gap between touches.
      due_at: new Date(now.getTime() + Math.max(spacingMs, cadenceMs)).toISOString(),
      data: {
        ...data,
        last_touch_at: iso,
        touch_count: Number(data.touch_count ?? 0) + (step.action === "send_message" ? 1 : 0),
        last_task_id: task.id,
        paused_reason: undefined,
      },
    },
    { at: iso, kind: "stage_changed", from: kase.stage, to: step.advance_to, note: `${step.action} sent`, task_id: task.id, actor: "system" },
  );
  return "sent";
}

// ── the schedule ─────────────────────────────────────────────────────────────────────────────────

/**
 * Create (or find) the ticking Schedule for a project.
 *
 * One per project, every five minutes, always scoped. The scheduler's `claimDueSchedules` does the
 * rest — including the guarantee that with four replicas exactly one of them fires each tick.
 */
export async function ensureSequenceSchedule(domain: DomainStore, projectId: string, now: Date = new Date()): Promise<Schedule> {
  if (!projectId) throw new Error("a sequencer schedule must be scoped to a project");
  const existing = (await domain.listSchedules()).find(
    (s) => s.project_id === projectId && s.task_type === ADVANCE_TASK_TYPE,
  );
  if (existing) return existing;
  return domain.createSchedule({
    project_id: projectId,
    name: "outreach sequencer",
    wedge: GTM_WEDGE,
    task_type: ADVANCE_TASK_TYPE,
    input: {},
    cadence: { kind: "every", seconds: TICK_SECONDS },
    enabled: true,
    next_run_at: new Date(now.getTime() + TICK_SECONDS * 1000).toISOString(),
  });
}
