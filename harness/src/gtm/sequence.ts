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
import { executeAction, hasLinkedInExecutor, type ActionResult } from "../actions";
import { linkAgentMailThread } from "../agentmail";
import { emitEvent } from "../events";
import { PEOPLE_COLLECTION } from "../linkedin/graph";
import { riskFor, touchFor } from "../linkedin/capabilities";
import { syncLinkedInInbox, syncLinkedInNetwork } from "../linkedin/connect";
import { assertPollAllowed, assertSendAllowed, nextIntervalMs, pollIntervalMs, type PacingVerdict } from "../pacing";
import type { SendContext } from "../outreach/guard";
import { runWorkflow } from "../workflows";
import { INVITE_ACCEPTED } from "./acceptance";
import { MESSAGE_RECEIVED } from "./replies";
import { campaignEnvelope, loadCampaign, CROSS_CHANNEL_ACTIONS, type Campaign, type SequenceStep } from "./campaign";
import { evaluateCondition } from "./conditions";
import { gtmWedge, isActive } from "./stages";
import { preferredSendAt, timezoneForLocation } from "./lead-timezone";

/** The task type a sequencer Schedule spawns. Matched by the scheduler — see scheduler.ts. */
export const ADVANCE_TASK_TYPE = "advance_sequences";

/**
 * The task type of ONE dispatched step. The anchor an approval, a timeline entry and an audit row
 * hang off — declared by gtm-operator on disk.
 *
 * A NAMED CONSTANT because it stopped being local. It was the string literal `"outreach_touch"` on
 * one line of `dispatchStep`, while the next-move engine independently proposed a carrier called
 * `"gtm_next_touch"` — a task type that has never existed in any manifest. The two never had to
 * agree because nothing compared them, so the founder's home screen greyed out a button explaining
 * that no wedge could carry an outreach touch while this file dispatched one every five minutes.
 * One exported constant, read by the proposer and the dispatcher, and that divergence is a compile
 * error rather than a lie on a screen.
 */
export const TOUCH_TASK_TYPE = "outreach_touch";

/** Five minutes: frequent enough to honour jittered spacing, cheap enough to be uninteresting. */
export const TICK_SECONDS = 300;

/**
 * How many cases one tick will touch.
 *
 * Bounded twice over, and the bound is the point. Pacing refuses most of them anyway, but an
 * unbounded loop over every due case is how a backlog becomes a burst the moment a window opens.
 */
export const BATCH = 25;

/**
 * How often each inbound read runs, per account, BEFORE jitter.
 *
 * These are not the tick. The tick is every five minutes because sends need spacing that fine; the
 * inbound reads are automation against a member's session and get their own, much slower clocks:
 *
 *   · NETWORK (who accepted) — hourly. An acceptance is worth acting on within the day, not within
 *     the minute, and a connections page fetched twelve times an hour from a residential proxy is a
 *     request pattern no human produces.
 *   · INBOX (who replied) — a quarter of an hour. Faster because response time is the single biggest
 *     factor in whether a live conversation converts, and affordable because the sync is a DELTA:
 *     with a cursor, "nothing changed" costs almost nothing (see voyager.ts). Polling this endpoint
 *     WITHOUT the cursor every five minutes is the ~$3,855/month mistake that file describes.
 *
 * Both are jittered ±40% by `pollIntervalMs` and both are claimed atomically, so the fleet does not
 * arrive at LinkedIn on the hour.
 */
export const NETWORK_POLL_MS = 60 * 60 * 1000;
export const INBOX_POLL_MS = 15 * 60 * 1000;

/** The `config.polling` keys these two claims are held under. One namespace, two independent clocks. */
export const POLL_NETWORK = "linkedin_network";
export const POLL_INBOX = "linkedin_inbox";

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
  ctx?: SendContext,
) => Promise<DispatchResult>;

/**
 * The real dispatcher.
 *
 * Everything goes through `executeAction`, the same door every other connection kind uses, so a
 * sequenced action inherits the executor's secret handling and the LinkedIn path's pacing check,
 * proxy requirement, graph write and — the one that matters most — its `noteLinkedInTouch` call
 * with the CAPABILITY ID, which is what makes the weekly allowance actually decrement.
 *
 * The set of wired capabilities is asked of actions.ts rather than restated here. This used to be a
 * literal `action === "send_message"`, which meant `send_invite` and `view_profile` were reported
 * unsupported long after their executors existed — so every campaign on the default sequence parked
 * at step one, for ever, with a message that read like a design decision.
 *
 * A step whose capability genuinely has no executor is still reported as unsupported rather than
 * quietly skipped: skipping an invitation and then messaging a stranger who never accepted is worse
 * than doing nothing and saying so.
 */
const realDispatcher: Dispatcher = async (conn, action, payload, ctx) => {
  // LinkedIn capabilities, or a mail connection for the cross-channel `send_email` step.
  if (hasLinkedInExecutor(action) || conn.kind === "agentmail" || conn.kind === "email") {
    return executeAction(conn, action, payload, ctx);
  }
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
  const reached = (s: string) =>
    ["queued", "warmed", "invited", "connected", "dm1", "dm2", "em1"].indexOf(stage) >=
    ["queued", "warmed", "invited", "connected", "dm1", "dm2", "em1"].indexOf(s);
  return {
    warmed: reached("warmed"),
    invited: reached("invited"),
    connected: d.connected === true || reached("connected"),
    /**
     * The `invite_accepted` trigger, as a fact a step can be gated on.
     *
     * NOT a synonym for `connected`, which is why it is a separate fact and reads a separate field.
     * `connected` is true for anyone at or past that stage — including a prospect the founder was
     * already connected to before the campaign existed, who was enrolled straight at `connected`.
     * `invite_accepted` is true only where THIS campaign's invitation was observed being accepted,
     * which is what a step like "send the acceptance message" actually means. It was declared in
     * linkedin/capabilities.ts as a trigger with nothing behind it; acceptance.ts writes the
     * timestamp this reads.
     */
    invite_accepted: typeof d.invite_accepted_at === "string" && d.invite_accepted_at.length > 0,
    // `booked` counts as replied: it is a strictly stronger version of the same fact, and every
    // `only_if: "... AND !replied"` guard in every sequence must refuse a follow-up to someone who
    // has a meeting with us on the calendar.
    replied: d.has_reply === true || stage === "replied" || stage === "booked",
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
  /** Accounts whose inbound reads ran this tick. Zero is the normal answer — see `pollAccounts`. */
  polled: number;
  /** Invitations observed accepted this tick: cases moved `invited` → `connected`. */
  accepted: number;
  /** Replies observed this tick. Each one is a sequence that stopped. */
  replies: number;
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
 *
 * THE INBOUND READS RUN FIRST, and the order is deliberate. An acceptance discovered at the top of
 * the tick lands on a case with `due_at = now`, so the very same tick can send the first message —
 * and a first message within a day of acceptance is the one touch in this whole sequence whose
 * timing is measurably worth anything. Reconciling afterwards would cost that prospect five minutes
 * at best and, if the account runs out of window in between, a day.
 */
export async function advanceSequences(
  store: Store,
  domain: DomainStore,
  opts: { project_id?: string; now?: Date; limit?: number; task_id?: string } = {},
): Promise<TickSummary> {
  const summary: TickSummary = { processed: 0, sent: 0, paced: 0, parked: 0, closed: 0, polled: 0, accepted: 0, replies: 0 };
  if (!opts.project_id) {
    summary.note =
      "this sequencer schedule has no project — refusing to process anything. " +
      "Recreate it with a project so it can only ever touch that tenant's cases.";
    return summary;
  }
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();

  await pollAccounts(store, domain, opts.project_id, now, summary, opts.task_id);

  const all = await domain.listCases({ project_id: opts.project_id, wedge: gtmWedge(), status: "open" });
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
      const { outcome } = await advanceCase(store, domain, kase, now, campaigns);
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

// ── taking ONE touch, by hand ─────────────────────────────────────────────────────────────────────
//
// ═══ WHAT THIS FIXES ═══
//
// `gtm_next_touch` sat on the founder's next-move list with a grey button and a sentence saying no
// wedge declared a carrier. That sentence was FALSE in the only way that matters: gtm-operator
// declares `outreach_touch`, this file dispatches it every five minutes, and the move was naming a
// task type — `"gtm_next_touch"` — that had never existed anywhere. The engine was telling a founder
// the business could not do a thing the business does all day.
//
// ═══ WHY IT IS THE SAME FUNCTION AND NOT A SECOND SENDER ═══
//
// `advanceCase` is called, unchanged. Everything that protects the account protects a taken touch
// identically and in the same order: the cadence workflow's stopping rules, the step's own
// `only_if`, `assertSendAllowed` (store-backed, fails closed, the account's working hours), and the
// campaign envelope — which is the founder's own standing consent, granted when they approved the
// campaign, and which still writes an `auto_approved` approval row with its reason, so every message
// it produced stays inspectable afterwards, one by one.
//
// So taking a touch does not move a consequence boundary. It moves the CLOCK, and only forwards to
// now: the founder is saying "do the touch that is already due, rather than waiting for the tick".
// A touch that is NOT due is refused here by the same `due_at` gate `advanceSequences` uses, which is
// what stops this becoming a way to send an unpaced burst by clicking quickly.

/** The store `startNextTouch` needs. Registered by `mountGtm` — see `setTouchDeps`. */
let touchStore: Store | null = null;

/**
 * Null until `mountGtm` registers it, and a null here means NOTHING is taken.
 *
 * The same fail-closed wiring rule as `setChaseDeps` and `setNudgeDeps`, and it matters more here:
 * the fallback a hurried version of this would reach for is "construct a store" or "keep the
 * sequencer's", and either one is a second path to a member's LinkedIn session.
 */
export function setTouchDeps(d: { store: Store } | null): void {
  touchStore = d?.store ?? null;
}

/**
 * How long ONE hand-taken touch holds the case against a second one. Five minutes — the tick.
 *
 * NOT a cadence. The cadence is `due_at`, set by `dispatchStep` to the later of the jittered
 * within-day spacing and the campaign's own gap between touches, and that is what actually spaces
 * this prospect's messages. This window is narrower and does one job: serialising a founder's double
 * click against itself, and against a sequencer tick that woke on the same case in the same instant.
 * One tick is exactly the window in which those two can collide.
 */
const TAKE_CLAIM_MS = TICK_SECONDS * 1000;

/** Why a touch could not be taken. Machine codes, so a UI can say something true rather than "error". */
export type TouchRefusal = "not_configured" | "not_active" | "paced" | "parked" | "closed";

export type TouchStart =
  | { ok: true; task_id: string; case_id: string }
  | { ok: false; reason: TouchRefusal; message: string };

/**
 * Dispatch the ONE touch this prospect is already due, now instead of on the next tick.
 *
 * Refuses everything `advanceSequences` would refuse, plus two of its own: a case whose `due_at` is
 * in the future (the sequencer is deliberately spacing it), and a case another click already claimed.
 *
 * A parked outcome reports the sequencer's OWN sentence, re-read from the case it just wrote, rather
 * than a generic failure. "Paused — outside this account's working hours" is a fact a founder can act
 * on; "could not start" teaches them the button is broken.
 */
export async function startNextTouch(
  domain: DomainStore,
  kase: Case,
  opts: { now?: Date } = {},
): Promise<TouchStart> {
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();

  if (!touchStore) {
    return { ok: false, reason: "not_configured", message: "Outbound is not wired up in this deployment." };
  }
  if (!kase.project_id) {
    return { ok: false, reason: "not_active", message: "That prospect is not attached to a business." };
  }
  if (kase.status !== "open" || !isActive(kase.stage)) {
    return { ok: false, reason: "not_active", message: `This sequence is at "${kase.stage}" and is not running any more.` };
  }
  // The SAME gate `advanceSequences` applies. Without it, taking touches would be a way to send a
  // whole sequence in an afternoon — the bot signature pacing.ts exists to avoid.
  if (kase.due_at && kase.due_at > nowIso) {
    return {
      ok: false,
      reason: "paced",
      message: `The next touch for "${kase.title}" is deliberately spaced until ${kase.due_at.slice(0, 16).replace("T", " ")}.`,
    };
  }

  const claimed = await domain.claimCaseMarker({
    project_id: kase.project_id,
    id: kase.id,
    marker: "last_taken_touch_at",
    notSince: new Date(now.getTime() - TAKE_CLAIM_MS).toISOString(),
    at: nowIso,
  });
  if (!claimed) {
    return { ok: false, reason: "paced", message: `"${kase.title}" is already being worked on — give it a moment.` };
  }

  // `advanceCase` is handed the CLAIMED row, not the caller's copy. Passing the stale one would write
  // `data` back without the marker and silently release the claim we just won.
  const stepped = await advanceCase(touchStore, domain, claimed, now, new Map());
  if (stepped.outcome === "sent" && stepped.task_id) {
    return { ok: true, task_id: stepped.task_id, case_id: claimed.id };
  }
  // Re-read for the sentence the sequencer just wrote onto the case. Scoped by project, so a row that
  // vanished under us degrades to the generic answer rather than to another tenant's reason.
  const after = await domain.getCase(claimed.id);
  const reason =
    after && after.project_id === claimed.project_id
      ? (after.data as Record<string, unknown> | undefined)?.paused_reason
      : undefined;
  const because = typeof reason === "string" && reason ? reason : "the sequencer held this touch";
  if (stepped.outcome === "closed") return { ok: false, reason: "closed", message: `This sequence has finished: ${because}.` };
  if (stepped.outcome === "paced") return { ok: false, reason: "paced", message: because };
  return { ok: false, reason: "parked", message: because };
}

// ── the return path ──────────────────────────────────────────────────────────────────────────────
//
// WHY THIS LIVES ON THE SEQUENCER TICK AND NOT ON A SECOND SCHEDULE.
//
// The same reason the header gives for not inventing a timer next to `claimDueSchedules`: two
// systems that each believe they are the one talking to LinkedIn is the double-send bug wearing a
// different hat. `claimDueSchedules` already guarantees that exactly one replica runs a given
// project's tick, so anything that hangs off the tick inherits that guarantee for free. A separate
// poller would need its own claim, its own catch-up policy and its own answer to "what happens when
// four containers boot at once", and it would get one of them wrong.
//
// WHAT PROTECTS THE ACCOUNT, IN ORDER. Every one of these has to hold or a read does not happen:
//
//   1. A LIVE SESSION. No vaulted session, no poll — never a login attempt, never a retry loop.
//   2. `assertPollAllowed` — the account's own working-hours window, and the engagement pause. Both
//      store-backed, both fail closed. An account paused for engagement is not read either: adding
//      request volume to an account we have just decided to stop touching is not a safe read.
//   3. `claimPoll` — ONE atomic statement that both checks the interval and arms the next one. This
//      is what makes the poll safe on N replicas and safe against the manual `POST /v1/gtm/tick`
//      route, which does not go through the schedule claim at all.
//   4. `pollIntervalMs` — ±40% jitter, so the fleet does not arrive at LinkedIn on the hour.
//
// And the whole thing is wrapped: a poll that throws must cost this tick's reconciliation and
// nothing else. Twenty-five cases are about to be advanced behind it.

/** Every LinkedIn account belonging to THIS project. Strict equality — an unscoped account is not ours. */
async function linkedInAccountsFor(domain: DomainStore, projectId: string): Promise<Connection[]> {
  const all = await domain.listConnections();
  return all.filter((c) => c.kind === "linkedin" && c.project_id === projectId);
}

/**
 * Run the inbound reads for this project's accounts, if they are due and allowed.
 *
 * Mutates `summary` rather than returning, because these counts belong in the same line the founder
 * reads about the tick: "3 sent, 2 accepted, 1 replied" is the loop, and reporting the outbound half
 * on its own is how the return path went unnoticed for as long as it did.
 */
async function pollAccounts(
  store: Store,
  domain: DomainStore,
  projectId: string,
  now: Date,
  summary: TickSummary,
  taskId?: string,
): Promise<void> {
  let accounts: Connection[];
  try {
    accounts = await linkedInAccountsFor(domain, projectId);
  } catch {
    return; // the case work below does not depend on this and must not be lost with it
  }
  const nowIso = now.toISOString();

  for (const conn of accounts) {
    try {
      const verdict = await assertPollAllowed(domain, conn.id);
      if (!verdict.allowed) continue;

      // NETWORK — who accepted. Claimed first because an acceptance found now is a message that can
      // go out on this same tick.
      if (await domain.claimPoll(conn.id, POLL_NETWORK, nowIso, new Date(now.getTime() + pollIntervalMs(NETWORK_POLL_MS)).toISOString())) {
        summary.polled++;
        const r = await syncLinkedInNetwork(conn);
        summary.accepted += r.accepted;
        if (r.accepted > 0 && taskId) {
          /**
           * `invite_accepted`, fired.
           *
           * It has been in linkedin/capabilities.ts's trigger table since the beginning with nothing
           * behind it. This is the implementation, and it is deliberately an EVENT on the tick's own
           * task rather than a new run: the follow-up it exists to prompt is already an approved
           * step of the campaign, and spawning a model run per acceptance would spend a founder's
           * budget re-deciding something they decided when they approved the sequence.
           */
          await emitEvent(store, taskId, "progress", {
            trigger: INVITE_ACCEPTED,
            connection_id: conn.id,
            accepted: r.accepted,
            case_ids: r.case_ids ?? [],
            note: `${r.accepted} ${r.accepted === 1 ? "invitation was" : "invitations were"} accepted — the follow-up is due now`,
          }).catch(() => {});
        }
      }

      // INBOX — who replied. `replies.ts` has always known how to stop a sequence when told; until
      // now the only thing that ever told it was a human hitting POST /v1/linkedin/connect/:id/sync.
      if (await domain.claimPoll(conn.id, POLL_INBOX, nowIso, new Date(now.getTime() + pollIntervalMs(INBOX_POLL_MS)).toISOString())) {
        summary.polled++;
        const before = await countReplied(domain, projectId, conn.id);
        await syncLinkedInInbox(conn);
        const replies = Math.max(0, (await countReplied(domain, projectId, conn.id)) - before);
        summary.replies += replies;
        if (replies > 0 && taskId) {
          /**
           * `message_received`, fired.
           *
           * Same contract as `invite_accepted` above: an EVENT on this tick, not a new model run.
           * The sequence has already stopped (`replied` is terminal). What this exists to prompt
           * is a human — the founder, via `/gtm` reply-handoff — not another automated DM.
           */
          await emitEvent(store, taskId, "progress", {
            trigger: MESSAGE_RECEIVED,
            connection_id: conn.id,
            replies,
            note:
              replies === 1
                ? "a prospect replied — the sequence stopped; a person should answer"
                : `${replies} prospects replied — sequences stopped; a person should answer`,
          }).catch(() => {});
        }
      }
    } catch (e) {
      // Everything in here is bookkeeping about work that already happened. It must never take down
      // the tick that is about to advance twenty-five cases.
      console.error(`[mycel] inbound poll failed for ${conn.id}:`, (e as Error)?.message ?? e);
    }
  }
}

/** How many of this account's cases have stopped on a reply. The delta is what the tick reports. */
async function countReplied(domain: DomainStore, projectId: string, connectionId: string): Promise<number> {
  const cases = await domain.listCases({ project_id: projectId, wedge: gtmWedge(), stage: "replied" });
  return cases.filter((k) => (k.data as Record<string, unknown> | undefined)?.connection_id === connectionId).length;
}

type Outcome = "sent" | "paced" | "parked" | "closed";

/**
 * What advancing one case did, AND the row it left behind when it dispatched.
 *
 * The `task_id` exists because `startNextTouch` — a founder taking this touch off `/next` rather
 * than waiting for the cadence — has to hand back the run it started, the way `startChase` and
 * `startNudge` do. Before this, `advanceCase` returned a bare string and the id of the Task it had
 * just created was dropped on the floor; the take path would have had to go and find it by scanning
 * the task table for the newest `outreach_touch`, which is a guess wearing a query.
 *
 * Absent on every outcome but `sent`, because nothing else creates a task.
 */
interface Stepped {
  outcome: Outcome;
  task_id?: string;
}

/** Push a case out, and put a sentence on it the founder can read without asking anyone. */
async function park(domain: DomainStore, kase: Case, now: Date, afterMs: number, reason: string): Promise<void> {
  await domain.updateCase(kase.id, {
    due_at: new Date(now.getTime() + Math.max(60_000, afterMs)).toISOString(),
    data: { ...(kase.data ?? {}), paused_reason: reason, paused_at: now.toISOString() },
  });
}

async function closeCase(domain: DomainStore, kase: Case, now: Date, stage: string, note: string): Promise<Stepped> {
  await domain.updateCase(
    kase.id,
    { stage, status: "closed", closed_at: now.toISOString(), data: { ...(kase.data ?? {}), paused_reason: note } },
    { at: now.toISOString(), kind: "closed", from: kase.stage, to: stage, note, actor: "system" },
  );
  return { outcome: "closed" };
}

async function advanceCase(
  store: Store,
  domain: DomainStore,
  kase: Case,
  now: Date,
  campaigns: Map<string, Campaign | undefined>,
): Promise<Stepped> {
  const data = (kase.data ?? {}) as Record<string, unknown>;
  const campaignId = String(data.campaign_id ?? "");

  if (!campaigns.has(campaignId)) campaigns.set(campaignId, await loadCampaign(domain, kase.project_id, campaignId));
  const campaign = campaigns.get(campaignId);
  if (!campaign) {
    await park(domain, kase, now, 6 * 60 * 60 * 1000, "this campaign is missing or belongs to another project");
    return { outcome: "parked" };
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
    return { outcome: "parked" };
  }

  if (!evaluateCondition(step.only_if, factsFor(kase))) {
    // Not an error: the step's precondition is not met YET. The facts move (an invitation gets
    // accepted, a reply lands), so this is re-checked rather than abandoned.
    await park(domain, kase, now, 6 * 60 * 60 * 1000, `waiting: this step runs only if ${step.only_if}`);
    return { outcome: "parked" };
  }

  const conn = await domain.getConnection(campaign.connection_id);
  if (!conn) {
    await park(domain, kase, now, 6 * 60 * 60 * 1000, "the LinkedIn account for this campaign is gone — reconnect it");
    return { outcome: "parked" };
  }

  // PACING FIRST, before the envelope and before anything is drafted or dispatched. It is the only
  // ceiling in this system that is store-backed and fails closed, and its refusals are written for
  // a founder to read ("outside this account's working hours") rather than for a log.
  // Cross-channel email must NOT spend LinkedIn invite/DM budget — `touchFor` defaults unknowns to
  // "invite", which would silently throttle the LinkedIn account for every em1 send.
  const touch = CROSS_CHANNEL_ACTIONS.has(step.action) ? null : touchFor(step.action);
  const verdict: PacingVerdict = touch
    ? await assertSendAllowed(domain, conn.id, touch)
    : { allowed: true, remaining: 0, budget: 0, nextAfterMs: 60_000 };
  if (!verdict.allowed) {
    await park(domain, kase, now, verdict.nextAfterMs, `paused — ${verdict.reason ?? "pacing refused this send"}`);
    return { outcome: "paced" };
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
    return { outcome: "parked" };
  }

  return dispatchStep(store, domain, { campaign, kase, conn, step, verdict, envelopeReason: envelope.reason, now });
}

/**
 * A stage with no step is not a stuck case — it is a case waiting on somebody else.
 *
 * `invited` waits for an acceptance we do not control. `dm2` is the end of the sequence. Both need
 * an exit, or an unanswered invitation sits in the list for ever looking like a bug.
 */
async function waitingStage(domain: DomainStore, kase: Case, now: Date): Promise<Stepped> {
  const ageMs = now.getTime() - Date.parse(kase.updated_at ?? kase.created_at);
  if (kase.stage === "invited" && ageMs >= INVITE_STALE_DAYS * DAY_MS) {
    // Pending invitations count against the weekly limit until they are withdrawn, so an
    // invitation nobody answered is not merely a dead lead — it is budget the account is still
    // paying for. Closing it is what makes `withdraw_invite` worth doing next.
    return closeCase(domain, kase, now, "lost", `no answer after ${INVITE_STALE_DAYS} days — withdraw the invitation to recover the allowance`);
  }
  if (kase.stage === "em1" && ageMs >= TRAIL_DAYS * DAY_MS) {
    return closeCase(domain, kase, now, "lost", "sequence finished with no reply — a clean close, not another message");
  }
  await park(domain, kase, now, 12 * 60 * 60 * 1000, kase.stage === "invited" ? "waiting for them to accept" : "sequence complete — waiting before close");
  return { outcome: "parked" };
}

interface Cadence {
  stop: boolean;
  stage?: string;
  waitMs: number;
  reason: string;
}

/** How `stage` maps onto next_touch.mjs's own vocabulary. Only message steps have a cadence. */
const NEXT_TOUCH_STAGE: Record<string, string> = {
  connected: "prospect",
  dm1: "touch_1",
  dm2: "touch_2",
  em1: "touch_3",
};

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

  const r = await runWorkflow(gtmWedge(), "next_touch", {
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
 * What this step actually sends, or why it cannot.
 *
 * One place, per capability, because the arguments differ and getting them wrong is not a type
 * error — it is a case that parks with a confusing reason, or worse, an action that runs against
 * the wrong identifier. Everything it reads was written at enrolment or by an earlier step; NOTHING
 * is drafted here, which is what lets one approval honestly cover two hundred touches.
 *
 * A missing argument PARKS with a sentence rather than dispatching a half-formed call. The retry
 * windows differ on purpose: twelve hours for something that arrives on its own (a conversation
 * appears when an invitation is accepted), a day for something a human has to fix (missing copy,
 * a prospect with no profile id).
 */
function stepPayload(
  kase: Case,
  step: SequenceStep,
  conn: Connection,
): { payload: Record<string, unknown> } | { park: { reason: string; afterMs: number } } {
  const data = (kase.data ?? {}) as Record<string, unknown>;
  const copy = (data.copy ?? {}) as Record<string, string>;
  const profileId = typeof data.profile_id === "string" ? data.profile_id.trim() : "";
  // `case_id` rides along so the graph writes in linkedin/connect.ts file what they learn against
  // this engagement. It never widens tenancy — the project always comes off the connection.
  const base: Record<string, unknown> = { connection_id: conn.id, case_id: kase.id };
  const noProfile = {
    park: {
      reason: "this prospect has no LinkedIn profile id — nothing can be done to them until one is recorded",
      afterMs: DAY_MS,
    },
  };

  switch (step.action) {
    case "send_message": {
      const body = copy[step.action] ?? copy[kase.stage] ?? "";
      if (!body) return { park: { reason: "no approved copy for this step — nothing will be improvised", afterMs: DAY_MS } };
      // Reply into the conversation when we have its urn; otherwise open one with the profile id.
      //
      // This used to park unconditionally on a missing `thread`, and the park was permanent: the
      // step that runs at `connected` IS the first DM, so by definition there is no conversation
      // yet, and nothing downstream could create one. Every campaign stalled at exactly the moment
      // it became valuable — an accepted invitation that was never followed by a message.
      const thread = typeof data.thread === "string" ? data.thread.trim() : "";
      if (thread) return { payload: { ...base, thread, body } };
      if (profileId) return { payload: { ...base, profile_id: profileId, body } };
      return {
        park: {
          reason: "no conversation to reply into yet — a DM needs an accepted connection or a profile id to start one",
          afterMs: 12 * 60 * 60 * 1000,
        },
      };
    }
    case "send_email": {
      const body = copy[step.action] ?? copy[kase.stage] ?? copy.email ?? "";
      if (!body) {
        return {
          park: {
            reason:
              "email follow-up is due but there is no approved email copy — nothing will be improvised",
            afterMs: DAY_MS,
          },
        };
      }
      const name = typeof data.name === "string" && data.name.trim() ? data.name.trim() : "there";
      const subject =
        (typeof copy.email_subject === "string" && copy.email_subject.trim()) ||
        (typeof copy.subject === "string" && copy.subject.trim()) ||
        `Quick note, ${name.split(/\s+/)[0] ?? "there"}`;
      // Recipient may already sit on the case (enrich wrote it through); otherwise dispatchStep
      // looks it up on the people graph before sending.
      const to =
        (typeof data.email === "string" && data.email.includes("@") && data.email.trim()) ||
        (typeof data.work_email === "string" && data.work_email.includes("@") && data.work_email.trim()) ||
        "";
      return {
        payload: {
          ...base,
          body,
          text: body,
          subject,
          ...(to ? { to } : {}),
          ...(profileId ? { profile_id: profileId } : {}),
        },
      };
    }
    case "send_invite": {
      if (!profileId) return noProfile;
      // The note is optional and it is NEVER invented. If the founder approved copy for this step it
      // is sent verbatim; if they did not, the invitation goes out bare, which is a legitimate and
      // frequently better choice — a note that reads as a template lowers acceptance.
      const note = copy[step.action] ?? copy[kase.stage];
      return { payload: { ...base, profile_id: profileId, ...(note ? { note } : {}) } };
    }
    case "view_profile":
    case "get_profile": {
      if (!profileId) return noProfile;
      return { payload: { ...base, profile_id: profileId } };
    }
    case "withdraw_invite": {
      const invitationId = data.invitation_id;
      if (typeof invitationId !== "string" || !invitationId) {
        return { park: { reason: "no invitation id was recorded for this prospect, so there is nothing to withdraw", afterMs: DAY_MS } };
      }
      return { payload: { ...base, invitation_id: invitationId, shared_secret: data.shared_secret } };
    }
    default:
      // A capability wired later arrives here with the identifiers every LinkedIn action uses. It
      // still cannot run unless the envelope's AUTO_APPROVABLE list names it.
      return { payload: { ...base, ...(profileId ? { profile_id: profileId } : {}), thread: data.thread } };
  }
}

/**
 * What a successful step leaves behind on the case.
 *
 * `send_invite` is the one that matters: LinkedIn mints an invitation id (and sometimes a shared
 * secret) and hands it back exactly once. Withdrawing three-week-old invitations is the only way to
 * recover weekly allowance, and it is impossible without that id — so it is persisted at the moment
 * it exists rather than looked up later, because there is no endpoint that would find it again.
 */
function resultData(action: string, result: DispatchResult): Record<string, unknown> {
  const d = (result.data ?? {}) as Record<string, unknown>;
  if (action === "send_invite") {
    return {
      ...(typeof d.invitation_id === "string" ? { invitation_id: d.invitation_id } : {}),
      ...(typeof d.shared_secret === "string" ? { shared_secret: d.shared_secret } : {}),
    };
  }
  if (action === "withdraw_invite") return { invitation_id: undefined, shared_secret: undefined, invite_withdrawn_at: new Date().toISOString() };
  if (action === "send_message") {
    return {
      ...(typeof d.message_id === "string" ? { last_message_id: d.message_id } : {}),
      // PERSIST THE CONVERSATION URN. The first DM creates the thread, and if the case does not
      // keep it, the follow-up step has no urn, opens a SECOND conversation with the same person,
      // and the founder's inbox shows two threads where the prospect sees a stranger who cannot
      // find their own message. Every later DM in the sequence reuses this.
      ...(typeof d.thread === "string" && d.thread ? { thread: d.thread } : {}),
    };
  }
  return {};
}

/**
 * Do the thing, and record that it was done — including the auto-approval.
 *
 * The approval row is not decoration. An auto-approved send that leaves no row is a bypass: the
 * founder consented to a campaign, and the only way that stays honest is if every message it
 * produced is inspectable afterwards, individually, with the reason the envelope allowed it.
 */
/**
 * Pick the mailbox + recipient for a GTM `send_email` step.
 *
 * Prefers AgentMail (hears replies) over generic `email`. Recipient comes from the case, else the
 * people graph (FullEnrich). Parks with an actionable sentence when either half is missing.
 */
async function resolveGtmEmailSend(
  domain: DomainStore,
  projectId: string,
  kase: Case,
  payload: Record<string, unknown>,
): Promise<
  | { conn: Connection; payload: Record<string, unknown> }
  | { park: { reason: string; afterMs: number } }
> {
  const conns = (await domain.listConnections()).filter((c) => c.project_id === projectId);
  const mail =
    conns.find((c) => c.kind === "agentmail" && typeof c.config.inbox_id === "string" && c.config.inbox_id) ??
    conns.find((c) => c.kind === "email");
  // Deployment-wide shared inbox: one connection may be provisioned without a project for dogfood GTM.
  const shared =
    mail ??
    (await domain.listConnections()).find(
      (c) => c.kind === "agentmail" && typeof c.config.inbox_id === "string" && c.config.inbox_id && !c.project_id,
    );
  if (!shared) {
    return {
      park: {
        reason:
          "email nudge is next — connect AgentMail (Apps → Email) or Gmail so the approved copy can send",
        afterMs: DAY_MS,
      },
    };
  }

  let to = typeof payload.to === "string" && payload.to.includes("@") ? payload.to.trim() : "";
  if (!to) {
    const data = (kase.data ?? {}) as Record<string, unknown>;
    const profileId = typeof data.profile_id === "string" ? data.profile_id.trim() : "";
    if (profileId) {
      const rows = await domain.queryRecords({
        project_id: projectId,
        wedge: gtmWedge(),
        collection: PEOPLE_COLLECTION,
        where: {},
        limit: 500,
      });
      const person = rows.find((r) => r.key === profileId) ?? rows.find((r) => {
        const d = r.data as Record<string, unknown>;
        return d.profile_id === profileId || d.public_identifier === profileId;
      });
      const d = (person?.data ?? {}) as Record<string, unknown>;
      to =
        (typeof d.email === "string" && d.email.includes("@") && d.email.trim()) ||
        (typeof d.personal_email === "string" && d.personal_email.includes("@") && d.personal_email.trim()) ||
        "";
    }
  }
  if (!to) {
    return {
      park: {
        reason:
          "email nudge is next but this lead has no email yet — run FullEnrich on them, then the sequence will send",
        afterMs: DAY_MS,
      },
    };
  }

  return {
    conn: shared,
    payload: { ...payload, to, connection_id: shared.id },
  };
}

/**
 * The lead's UTC offset (minutes), inferred from their location on the people graph — or `undefined`
 * when we can't tell, in which case scheduling falls back to the seat window alone (unchanged).
 *
 * ONE targeted read per dispatched prospect. A location may already sit on the case (some enrolment
 * paths write it through); when it does not, we look the person up by `profile_id` on the people
 * graph, which is where `personRecord` stores their `location`. Failures are swallowed — a lead-tz
 * preference is a nicety, never a reason a touch does not go out.
 */
async function leadOffsetFor(
  domain: DomainStore,
  projectId: string,
  kase: Case,
): Promise<number | undefined> {
  const data = (kase.data ?? {}) as Record<string, unknown>;
  const onCase = typeof data.location === "string" ? data.location : undefined;
  if (onCase) return timezoneForLocation(onCase);

  const profileId = typeof data.profile_id === "string" ? data.profile_id.trim() : "";
  if (!profileId) return undefined;
  try {
    const rows = await domain.queryRecords({
      project_id: projectId,
      wedge: gtmWedge(),
      collection: PEOPLE_COLLECTION,
      where: { profile_id: profileId },
      limit: 1,
    });
    const person =
      rows[0] ??
      (await domain.getRecord(profileId).catch(() => undefined));
    const loc = (person?.data as Record<string, unknown> | undefined)?.location;
    return typeof loc === "string" ? timezoneForLocation(loc) : undefined;
  } catch {
    return undefined;
  }
}

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
): Promise<Stepped> {
  const { campaign, kase, conn, step, verdict, now } = args;
  const data = (kase.data ?? {}) as Record<string, unknown>;
  const iso = now.toISOString();

  // The copy was written and approved BEFORE the founder said yes. Nothing is drafted at dispatch
  // time, which is the whole reason one approval can cover two hundred touches honestly.
  const built = stepPayload(kase, step, conn);
  if ("park" in built) {
    await park(domain, kase, now, built.park.afterMs, built.park.reason);
    return { outcome: "parked" };
  }
  let payload = built.payload;
  let dispatchConn = conn;

  // Cross-channel: `send_email` leaves the LinkedIn connection. Resolve mailbox + recipient here.
  if (step.action === "send_email") {
    const resolved = await resolveGtmEmailSend(domain, campaign.project_id, kase, payload);
    if ("park" in resolved) {
      await park(domain, kase, now, resolved.park.afterMs, resolved.park.reason);
      return { outcome: "parked" };
    }
    dispatchConn = resolved.conn;
    payload = resolved.payload;
  }

  // One Task per send: the anchor an approval, a timeline and an audit entry all hang off. It is a
  // row, not a run — no model is invoked, because the words were approved days ago.
  const task: Task = {
    id: randomUUID(),
    project_id: campaign.project_id,
    case_id: kase.id,
    client_id: kase.client_id,
    wedge: gtmWedge(),
    task_type: TOUCH_TASK_TYPE,
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
    action: step.action === "send_email" ? `email:${step.action}` : `linkedin:${step.action}`,
    risk: riskFor(step.action),
    preview: {
      campaign: campaign.name,
      to: typeof payload.to === "string" ? payload.to : data.name ?? data.profile_id,
      capability: step.action,
      // Whatever words this step puts in front of a human being — a DM body, or an invitation note.
      // A step that sends no words (a profile view) shows none rather than an empty string.
      preview:
        typeof payload.body === "string"
          ? payload.body.slice(0, 400)
          : typeof payload.note === "string"
            ? payload.note.slice(0, 400)
            : undefined,
    },
  });
  // Auto-approved, WITH the reason — this is what keeps campaign autonomy auditable rather than a
  // hole. It lands in the same queue a human-gated approval does.
  await store.setApproval(approval.approval_id, "auto_approved", args.envelopeReason);
  await emitEvent(store, task.id, "approval.resolved", {
    approval_id: approval.approval_id,
    action: step.action === "send_email" ? `email:${step.action}` : `linkedin:${step.action}`,
    decision: "auto_approved",
    policy_reason: args.envelopeReason,
  });

  // The envelope reason travels WITH the send, into the platform guard inside `executeAction`.
  // LinkedIn forces a human onto a cold open; the founder's campaign approval is that human, and
  // the `auto_approved` row written two lines up is the record of it. Passing the same string keeps
  // the guard's answer and the audit row telling one story instead of two.
  const result = await dispatcher(dispatchConn, step.action, payload, {
    approved: args.envelopeReason ?? `campaign "${campaign.name}" was approved by the founder`,
  });
  await emitEvent(store, task.id, "tool.result", {
    tool: `${dispatchConn.kind}:${step.action}`,
    ok: result.ok,
    detail: result.detail,
    ...(result.code ? { code: result.code } : {}),
  });

  if (!result.ok) {
    await store.setStatus(task.id, "failed", result.detail);
    // Three different waits, because these are three different problems. An UNSUPPORTED step is a
    // gap in the harness, not a flaky network — retrying it hourly just fills the timeline. A NAMED
    // quota (the Commercial Search Limit, an exhausted invitation window) is a calendar, not a blip:
    // retrying before tomorrow cannot possibly help and spends bytes proving it. Everything else
    // gets the hour a transport failure deserves.
    const afterMs = result.unsupported || result.code ? DAY_MS : 60 * 60 * 1000;
    await park(domain, kase, now, afterMs, result.detail ?? "the send failed");
    return { outcome: "parked" };
  }
  await store.setStatus(task.id, "succeeded");

  // Remember the AgentMail thread so a reply stands this sequence down (shared-inbox thread-first).
  if (dispatchConn.kind === "agentmail" && step.action === "send_email") {
    const providerThreadId = (result.data as { thread_id?: unknown } | undefined)?.thread_id;
    if (typeof providerThreadId === "string" && providerThreadId && kase.client_id) {
      const channels = await domain.listChannels();
      const channel = channels.find((ch) => ch.connection_id === dispatchConn.id && ch.project_id === campaign.project_id);
      if (channel) {
        const thread = await domain.findOrCreateThread(
          kase.client_id,
          channel.id,
          campaign.project_id,
          typeof payload.subject === "string" ? payload.subject : undefined,
          kase.id,
        );
        await linkAgentMailThread(campaign.project_id, {
          provider_thread_id: providerThreadId,
          thread_id: thread.id,
          channel_id: channel.id,
          client_id: kase.client_id,
          case_id: kase.id,
        }).catch((e) => console.error(`[mycel] GTM AgentMail send OK but thread link failed:`, e));
      }
    }
  }

  // The pacing counter is NOT incremented here. The send path owns it (linkedin/connect.ts), which
  // is the only place that knows a message was actually accepted by LinkedIn — incrementing in both
  // would charge the account twice for one message and throttle it for no reason.
  const dailyBudget = touchFor(step.action) === "invite" ? verdict.budget / 5 : verdict.budget / 7;
  const spacingMs = nextIntervalMs(Math.max(1, dailyBudget));
  const cadenceMs = (step.wait_days ?? 0) * DAY_MS;
  // The LATER of the two: jittered within-day spacing, and the cadence gap between touches. This is
  // the earliest the next touch may fire — the quota/pacing floor is untouched.
  const baseTarget = new Date(now.getTime() + Math.max(spacingMs, cadenceMs));
  // SOFT lead-timezone preference: if we know roughly what timezone this lead sits in, nudge the
  // target to the next slot that is inside BOTH the seat's 08:00–19:00 working window and the lead's
  // own ~09:00–17:00 local hours. If there is no overlap in the next day or two — or we can't tell
  // where the lead is — the target is left exactly as today (the seat window governs at send time).
  const leadOffsetMinutes = await leadOffsetFor(domain, campaign.project_id, kase);
  const dueAt =
    leadOffsetMinutes === undefined
      ? baseTarget
      : preferredSendAt({ seatConfig: conn.config as Record<string, unknown>, leadOffsetMinutes, from: baseTarget });
  await domain.updateCase(
    kase.id,
    {
      stage: step.advance_to,
      due_at: dueAt.toISOString(),
      data: {
        ...data,
        last_touch_at: iso,
        touch_count: Number(data.touch_count ?? 0) + (step.action === "send_message" ? 1 : 0),
        last_task_id: task.id,
        paused_reason: undefined,
        // Anything LinkedIn handed back that only exists now — the invitation id above all.
        ...resultData(step.action, result),
      },
    },
    { at: iso, kind: "stage_changed", from: kase.stage, to: step.advance_to, note: `${step.action} sent`, task_id: task.id, actor: "system" },
  );
  return { outcome: "sent", task_id: task.id };
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
    wedge: gtmWedge(),
    task_type: ADVANCE_TASK_TYPE,
    input: {},
    cadence: { kind: "every", seconds: TICK_SECONDS },
    enabled: true,
    next_run_at: new Date(now.getTime() + TICK_SECONDS * 1000).toISOString(),
  });
}
