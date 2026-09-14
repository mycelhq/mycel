// Human-in-the-loop approval: suspend a running task until a human approves/rejects an action,
// then resume. Shared by the OpenCode plugin gate (server /v1/internal/gate) and the API
// approve/reject endpoints. This is the trust primitive — the reason an AI-native service can
// take real actions safely.
import { audit } from "./audit";
import { markAbort } from "./cancel";
import type { ApprovalDecision, Risk } from "./contract";
import { emitEvent } from "./events";
import { recordApprovalOutcome } from "./knowledge";
import { getKnowledgeStore } from "./knowledge.store";
import { getDomainStore } from "./domain";
import { evaluatePolicy } from "./policy";
import { taskClientId } from "./runtime";
import { matchStanding } from "./standing";
import { loadProjectWedge } from "./authored";
import { isAuthoredSlug, loadWedge } from "./wedge";
import type { Store } from "./store";

/** The outcome of an approval — plus, when the human edits the action before approving, the
 *  corrected payload. That edit is the highest-signal feedback in the system. */
/**
 * A task in one of these states will never act on an approval again.
 *
 * Exported because two places have to agree on it and used to not: this file, deciding whether a
 * settled approval may still move anything, and the HTTP layer, deciding whether a card is worth
 * SHOWING. When the second one is laxer than the first, the founder is offered a button that either
 * does nothing or does the wrong half of something.
 */
export const TERMINAL_STATUSES = ["succeeded", "failed", "rejected", "expired", "cancelled"];

export interface ApprovalOutcome {
  decision: ApprovalDecision;
  edited?: Record<string, unknown>;
}

interface Waiter {
  taskId: string;
  resolve: (o: ApprovalOutcome) => void;
}
const waiters = new Map<string, Waiter>();

/**
 * Twenty-four hours. See the note at the `setTimeout` for the measurement behind it.
 *
 * Env-overridable so an operator can shorten it without a deploy if the fleet ever does fill —
 * which is the failure this length trades for, and `warnIfFleetFilling` is how anyone finds out.
 */
export const APPROVAL_TTL_MS = Number(process.env.MYCEL_APPROVAL_TTL_MS ?? 24 * 60 * 60 * 1000);

/**
 * How many worker slots may sit blocked on a human before we say something.
 *
 * `MYCEL_WORKER_CONCURRENCY` is 10 in production. A run suspended on an approval still holds its
 * graphile job, so blocked runs and real work compete for the same ten. Half is the point at which
 * the fleet is degraded but still moving — early enough to act, late enough not to cry wolf.
 */
const FLEET_WARN_AT = Math.max(2, Math.floor(Number(process.env.MYCEL_WORKER_CONCURRENCY ?? 10) / 2));

/**
 * Say it once per crossing, not once per approval.
 *
 * A warning that repeats on every gate call while the fleet is full is a warning nobody reads, and
 * this one has to be readable — it is the single condition under which a 24-hour TTL stops being
 * the right trade and non-blocking release stops being optional.
 */
let warnedAtFull = false;
function warnIfFleetFilling(): void {
  const blocked = waiters.size;
  if (blocked >= FLEET_WARN_AT && !warnedAtFull) {
    warnedAtFull = true;
    console.error(
      `[mycel] APPROVAL BACKPRESSURE: ${blocked} run(s) are suspended waiting on a person, against a ` +
        `worker concurrency of ${process.env.MYCEL_WORKER_CONCURRENCY ?? 10}. A suspended run still ` +
        `holds its slot, so real work is now competing with cards nobody has clicked. This is the ` +
        `condition under which the 24-hour approval window stops being safe — see approvals.ts.`,
    );
  } else if (blocked < FLEET_WARN_AT) {
    warnedAtFull = false;
  }
}

/** Test seam: the backpressure warning is process-wide, like every other registry here. */
export function resetFleetWarning(): void {
  warnedAtFull = false;
}
// taskId -> its pending approval ids, so a cancel can settle them (no dangling waiter/timer).
const byTask = new Map<string, Set<string>>();

/** Resume a suspended task. Called by POST /v1/approvals/:id/approve|reject. `edited` carries a
 *  human correction to the action (approve-with-edit). */
export function resolveApproval(
  id: string,
  decision: "approved" | "rejected",
  edited?: Record<string, unknown>,
): boolean {
  return settle(id, { decision, edited });
}

/** Settle any pending approvals for a task (used when the task is cancelled while suspended). */
export function failWaitersForTask(taskId: string, decision: ApprovalDecision): void {
  for (const id of [...(byTask.get(taskId) ?? [])]) settle(id, { decision });
}

/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * AN APPROVAL WHOSE RUN IS GONE IS NOT PENDING. IT IS OVER.
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * MEASURED IN PRODUCTION: seventeen approvals with status `pending`, every one of them attached to a
 * task that had already FAILED, the oldest waiting 1,630 hours — sixty-eight days.
 *
 * `failWaitersForTask` exists for this and cannot reach them, because it only walks the in-memory
 * `byTask` map. The two ways an approval is orphaned both empty that map first:
 *
 *   · The task FAILS. Nothing calls `failWaitersForTask` on the failure path at all — only cancel
 *     and dunning call it — so the waiter is dropped when the run ends and the row is never touched.
 *   · The PROCESS RESTARTS. Every waiter and every `setTimeout` lives in this module's memory, so a
 *     deploy erases the lot. There is nobody left to expire the row, which is also why these
 *     seventeen never hit the TTL that was supposed to bound them.
 *
 * `GET /v1/approvals` already refuses to SHOW a pending approval on a terminal task, so no founder
 * has been looking at a dead card. The damage is to the record: the table says seventeen people are
 * being kept waiting, `pending` is what every count and every funnel reads, and the row that says
 * "a human never answered this" is indistinguishable from the row that says "nobody could".
 *
 * So the reconciliation is DURABLE — it reads the store and writes the store, and therefore works
 * for rows orphaned by a restart, which is the case the in-memory path can never cover. Run at boot
 * and on a slow timer.
 */
export async function reconcileOrphanedApprovals(store: Store): Promise<number> {
  const pending = await store.listApprovals("pending");
  if (!pending.length) return 0;
  const owners = await store.getTasksByIds(pending.map((a) => a.task_id));
  let settled = 0;
  for (const a of pending) {
    const t = owners.get(a.task_id);
    // No task at all is the same fact as a terminal one: nothing will ever come back to ask.
    if (t && !TERMINAL_STATUSES.includes(t.status)) continue;
    // `expired` rather than `rejected`. Nobody refused this — it ran out of a run to belong to, and
    // recording a refusal the founder never made would put a decision in their audit trail that
    // they did not take.
    await store.setApproval(a.approval_id, "expired", t ? `the run ${t.status} before anyone answered` : "the run no longer exists");
    settled++;
  }
  return settled;
}

/**
 * The sweep, in the shape `startEnvelopeExpirySweep` already uses.
 *
 * Ten minutes, and the interval barely matters: nothing is WAITING on this. It corrects a record
 * that nobody is currently being shown, so being ten minutes late costs nothing, and running it
 * hot would mean a full pending-approval scan against Postgres for no reader.
 *
 * Boot is the tick that matters, because a restart is the event that orphans them.
 */
export function startApprovalReconciler(store: Store, intervalMs = 10 * 60_000): { stop(): void; tick(): Promise<number> } {
  let running = false;
  async function tick(): Promise<number> {
    if (running) return 0;
    running = true;
    try {
      const n = await reconcileOrphanedApprovals(store);
      if (n) console.log(`[mycel] closed ${n} approval(s) whose run had already ended`);
      return n;
    } catch (e) {
      console.error("[mycel] approval reconciliation error:", e);
      return 0;
    } finally {
      running = false;
    }
  }
  const timer = setInterval(() => void tick(), intervalMs);
  (timer as { unref?: () => void }).unref?.();
  return { stop: () => clearInterval(timer), tick };
}

function settle(id: string, outcome: ApprovalOutcome): boolean {
  const w = waiters.get(id);
  if (!w) return false;
  waiters.delete(id);
  byTask.get(w.taskId)?.delete(id);
  w.resolve(outcome);
  return true;
}

/**
 * Record an action that ran without waiting for anyone, and return immediately.
 *
 * The audit trail without the block. `awaitApproval` is the right shape for a decision that needs a
 * person — it suspends the run until someone clicks. It is the wrong shape for work the system is
 * already allowed to do, because its five-minute TTL turns "nobody was looking right now" into
 * "this never happened": 195 of 196 production approvals expired, and LinkedIn fired zero attempts
 * in the same window.
 *
 * So low-risk actions come here instead. A real approval row is written and immediately settled as
 * `auto_approved` with its reason, which means the founder's feed shows exactly what ran and why —
 * autonomy stays auditable rather than becoming invisible. What they lose is the obligation to be
 * awake for a profile view.
 *
 * Deliberately NOT routed through `awaitApproval` with a policy that always says yes. That would
 * make every low-risk action allocate a waiter and a timer it never uses, and it would put the
 * decision in a wedge manifest where a wedge author could accidentally revoke it.
 */
export async function recordAutoApproval(
  store: Store,
  taskId: string,
  req: { action: string; risk: Risk; preview: Record<string, unknown> },
): Promise<string> {
  const approval = await store.createApproval({
    task_id: taskId,
    action: req.action,
    risk: req.risk,
    preview: req.preview,
  });
  const reason =
    typeof req.preview.why === "string" && req.preview.why
      ? String(req.preview.why)
      : "low risk — nothing sent, changed or charged";
  await store.setApproval(approval.approval_id, "auto_approved", reason);
  await emitEvent(store, taskId, "approval.resolved", {
    approval_id: approval.approval_id,
    action: req.action,
    risk: req.risk,
    decision: "auto_approved",
    reason,
  });
  return approval.approval_id;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * THE MANIFEST WHOSE ENVELOPE DECIDES — INCLUDING A SERVICE WE WROTE FOR THIS ONE BUSINESS
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * This was `loadWedge(task?.wedge ?? "")`, and `loadWedge` REFUSES an authored slug by design: a
 * written service lives in a project-scoped table, and a loader with no project in hand answering
 * for it is the tenancy leak that gate exists to prevent. Returning null is the honest answer there.
 *
 * The consequence here was not honest. `evaluatePolicy(undefined, …)` says "no auto-approve policy —
 * human gate applies", so EVERY action of EVERY written service went to a person, forever — while
 * `repairAuthoredManifest` carefully clamped allowances that nothing would ever read. The founder's
 * direction, recorded in `wedgeauthor.ts`, is the opposite and says why: *"a business that asks
 * permission for everything on day one is a gate the founder learns to stop reading, which kills the
 * gate for the sends that matter."* And this file's own header has the measurement — 195 of 196
 * production approvals expired. Unread gates do not fail loudly; they fail as work that never
 * happened.
 *
 * ═══ WHY EVALUATING AN AUTHORED ENVELOPE IS SAFE, AND WHERE THAT SAFETY COMES FROM ═══
 *
 * The author of these rules is a model, and it is the thing being granted. The protection is that
 * `toLoaded` runs `repairAuthoredManifest` — and therefore `sanitiseAuthoredPolicy` — on EVERY LOAD,
 * not once at authoring time. So the clamp does not depend on what is in the row: no wildcards, no
 * prefixes, no money rules, at most three exact actions, ten a day. A row written before the
 * sanitiser existed, or edited in the database directly, is re-clamped on the way through here.
 *
 * Everything else that stood between an action and a person still stands: `requireHuman` skips this
 * entirely, `matchStanding` refuses to cover a `high` verdict, and the approval row is still written
 * and still lands in the founder's feed with its reason.
 *
 * A `task` with no `project_id` gets the disk loader and nothing else — `loadProjectWedge` throws
 * rather than guess a tenant, and an approval path is not the place to find out.
 */
async function manifestFor(task: { wedge?: string; project_id?: string } | undefined) {
  const slug = task?.wedge ?? "";
  if (!isAuthoredSlug(slug)) return loadWedge(slug);
  if (!task?.project_id) return null;
  return loadProjectWedge(task.project_id, slug).catch(() => null);
}

/** Create an approval, emit approval.requested, and block until resolved (or TTL expiry). */
export async function awaitApproval(
  store: Store,
  taskId: string,
  req: {
    action: string;
    risk: Risk;
    preview: Record<string, unknown>;
    ttlMs?: number;
    /**
     * Skip the policy envelope entirely — a real human must decide this one.
     *
     * Set by callers that know something the wedge manifest doesn't: the outreach guard raises it
     * for a cold initiate on a ban-risk account. Without it, `cold_initiate_requires_approval`
     * would be dead the moment a wedge declares any matching `auto_approve` rule, because the
     * policy check runs first and never sees the guard's verdict.
     */
    requireHuman?: boolean;
  },
): Promise<{ approvalId: string; decision: ApprovalDecision; edited?: Record<string, unknown> }> {
  const approval = await store.createApproval({
    task_id: taskId,
    action: req.action,
    risk: req.risk,
    preview: req.preview,
    ttlMs: req.ttlMs,
  });

  // POLICY FIRST: if the wedge declares an envelope this action fits inside, resolve it without a
  // human. The approval is still recorded (with the reason) so it lands in the batch-review queue —
  // autonomy is auditable, not invisible. No policy → the human gate, exactly as before.
  const task = await store.getTask(taskId);
  const decisionByPolicy = req.requireHuman
    ? { auto: false, reason: "platform rules require a human on this send" }
    : await evaluatePolicy((await manifestFor(task))?.manifest, {
        action: req.action,
        payload: req.preview,
        taskId,
        projectId: task?.project_id,
      });
  /**
   * A STANDING GRANT the founder wrote by hand — the second, and only other, way past a person.
   *
   * Deliberately AFTER the wedge envelope, and never consulted at all when `requireHuman` is set,
   * so the order of authority reads the same as the order of trust: the platform's own hard rules
   * first, then what the wedge author shipped, then what this founder decided about their own
   * clients. It cannot cover a `high` verdict — `matchStanding` refuses that before it loads
   * anything — so a grant written for a routine weekly update can never become authority over a
   * refund by the action changing shape later.
   *
   * See standing.ts for the five properties that keep this from being a hole in the gate.
   */
  const byStanding =
    req.requireHuman || decisionByPolicy.auto
      ? { auto: false as const, reason: "" }
      : await matchStanding(getDomainStore(), {
          projectId: task?.project_id,
          action: req.action,
          clientId: task ? taskClientId(task) : undefined,
          risk: req.risk,
        });

  if (decisionByPolicy.auto || byStanding.auto) {
    const reason = byStanding.auto ? byStanding.reason : decisionByPolicy.reason;
    const grantId = byStanding.auto ? byStanding.grant.id : undefined;
    await store.setApproval(approval.approval_id, "auto_approved", reason);
    await audit({
      project_id: task?.project_id ?? "",
      // The actor is whoever actually decided. A founder's standing grant is a MEMBER decision made
      // in advance, not a policy engine's, and an audit that files both under "policy" cannot
      // answer "who let this through" — the only question anyone ever asks of it.
      actor: byStanding.auto ? "member" : "policy",
      action: "approval.auto_approved",
      entity: "task", entity_id: taskId,
      detail: {
        action: req.action,
        approval_id: approval.approval_id,
        reason,
        ...(grantId ? { standing_grant_id: grantId } : {}),
      },
    });
    await emitEvent(store, taskId, "approval.resolved", {
      approval_id: approval.approval_id,
      action: req.action,
      decision: "auto_approved",
      policy_reason: reason,
      ...(grantId ? { standing_grant_id: grantId } : {}),
    });
    // Chase closed loop: park for payment or next ladder date (same as the human-approve path).
    if (task?.task_type === "chase_invoice") {
      void import("./dunning")
        .then(({ parkAfterChaseSend }) => parkAfterChaseSend(task))
        .catch((e) => console.error("[mycel] parkAfterChaseSend failed after auto-approve:", e));
    }
    return { approvalId: approval.approval_id, decision: "auto_approved" };
  }

  await store.setStatus(taskId, "awaiting_approval");
  await emitEvent(store, taskId, "approval.requested", {
    approval_id: approval.approval_id,
    action: req.action,
    risk: req.risk,
    preview: req.preview,
  });

  const outcome = await new Promise<ApprovalOutcome>((resolve) => {
    let settled = false;
    const done = (o: ApprovalOutcome) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      resolve(o);
    };

    waiters.set(approval.approval_id, { taskId, resolve: done });
    (byTask.get(taskId) ?? byTask.set(taskId, new Set()).get(taskId)!).add(approval.approval_id);

    // The cross-instance half.
    //
    // The waiter is an in-process promise, but the DECISION is a row. With more than one replica the
    // founder's approve call can land on a different instance than the run that's blocked — so also
    // watch the row, which is the source of truth either way.
    //
    // Without this, a second replica silently breaks the gate: the approval is recorded, the UI says
    // approved, and the task hangs until its TTL expires. Silent, and worst at the exact moment the
    // product's core promise is being exercised.
    //
    // 700ms: a human just clicked a button, so sub-second is indistinguishable from instant, and
    // this is one indexed read per pending approval.
    const poll = setInterval(async () => {
      try {
        const row = await store.getApproval(approval.approval_id);
        if (row && row.status !== "pending") {
          done({ decision: row.status as ApprovalDecision });
        }
      } catch {
        /* a transient read failure must not resolve the gate — keep waiting */
      }
    }, 700);
    (poll as unknown as { unref?: () => void }).unref?.();

    /**
     * HOW LONG A DECISION STAYS OPEN — MEASURED AGAINST THE HUMAN, NOT GUESSED.
     *
     * Five minutes was the first default and it was not a timeout, it was a guarantee of expiry: 195
     * of 196 production approvals died there. Thirty was the second, chosen as a bound on COST
     * rather than on a founder — the note here said so plainly, that thirty "is not a founder's
     * response time either".
     *
     * It is not. Measured on every approval a human has actually decided in production:
     *
     *     decided within 30 minutes      2 of 26
     *     decided within 24 hours       25 of 26
     *
     * Two of twenty-six. The distribution is 44 minutes to three days, and the only reason those 24
     * were decided at all is that the timer below is in-process and `unref`ed, so a kernel restart
     * loses it and the row quietly outlives its own TTL. The product's real behaviour was "expires in
     * thirty minutes unless we happen to deploy", which is not a policy anyone chose.
     *
     * Live cost of the old number, in the fortnight before this changed: 3 of 3 `send_invoice`
     * approvals expired unsent, and 2 of 4 campaigns. Half the outbound work the machine drafted was
     * thrown away because nobody clicked inside half an hour.
     *
     * ═══ WHY THIS IS NOW SAFE, AND IT WAS NOT BEFORE ═══
     *
     * The cost argument was real when it was written. A blocked run holds a worker slot, and the
     * queue was then carrying up to 50 approvals a day — 197 of 211 all-time expiries were
     * `composio:search_people`, `get_profile`, `get_company`: READS, on an internal task type, sent
     * to a human to approve. Reading a company profile is not a decision, so nobody made it, and a
     * 24-hour window would have jammed all ten worker slots on gibberish inside a day.
     *
     * That noise is gone — `ops_distribution_tick` ran 4,010 times in the last fortnight and requested
     * zero approvals — but NOT because anyone decided reads should stop being gated. Every one of
     * those approvals was a `composio:*` action, the last one dated 25 August, and GTM stopped going
     * through Composio for LinkedIn around then. The gate never learned the difference between
     * reading a company profile and sending a stranger a message; the actions that provoked it simply
     * stopped arriving.
     *
     * WHICH MEANS IT CAN COME BACK. Broker any read through the action proxy again — a new provider,
     * an enrichment call, a search — and the same flood returns, because the classification that let
     * `search_people` through as `risk: medium` is untouched. The right fix is that a read on an
     * internal task type never reaches a human at all; until that exists, this window's safety rests
     * on an integration having been removed, which is not a guarantee.
     *
     * What is left is 12 approvals in 14 days, all of them real outbound: an invoice, an email, a
     * campaign. Ten slots against twelve fortnightly decisions is not a contention problem, and
     * `warnIfFleetFilling` below is what says so out loud if it becomes one.
     *
     * The genuinely correct shape is still non-blocking release (deliverables.routes.ts makes the
     * argument) — a queue the founder clears whenever, with nothing held open meanwhile. This
     * constant does not pretend to be it. It stops throwing away half the product's output while
     * that is built.
     */
    const ttl = setTimeout(() => settle(approval.approval_id, { decision: "expired" }), req.ttlMs ?? APPROVAL_TTL_MS);
    (ttl as { unref?: () => void }).unref?.();
    warnIfFleetFilling();
  });
  const decision = outcome.decision;

  await store.setApproval(approval.approval_id, decision);
  await audit({
    project_id: task?.project_id ?? "",
    actor: decision === "expired" ? "system" : "member",
    action: decision === "approved" ? "approval.granted" : decision === "rejected" ? "approval.rejected" : "approval.expired",
    entity: "task", entity_id: taskId,
    detail: { action: req.action, approval_id: approval.approval_id, edited: !!outcome.edited },
  });

  /**
   * THE LESSON. This is where "every correction you make sharpens it" stops being a claim.
   *
   * The moment a human settles an approval is the highest-signal event the system has: they looked
   * at exactly what the agent was about to do, on a real job, and let it through, rewrote it, or
   * refused it. Everything the distiller needs is in scope right here — the proposed payload, the
   * corrected one, the task, the client, the approval id — and until now all of it was discarded the
   * instant this function returned.
   *
   * Here rather than in the HTTP route on purpose. `resolveApproval` is one of several ways an
   * approval settles (the cross-instance poll on the row is another, and it is the one that fires
   * when the founder's click lands on a different replica), and a capture wired to the route would
   * silently learn nothing from exactly those. Every path converges on this line.
   *
   * Awaited, but it cannot throw — `recordApprovalOutcome` swallows its own failures. The action is
   * already in flight and the human has already decided; failing their approval because we could not
   * file the note would be trading the job for the lesson.
   */
  /**
   * IS THE TASK STILL ALIVE? Read this BEFORE anything acts on the decision, not after.
   *
   * `kortix-ai/suna`'s `projects/lib/pending-questions.ts` states the rule for the render side:
   * a stale ask "is worse than none: it invites an answer nothing is waiting for". The same rule
   * has a sharper edge on the WRITE side, and we were on the wrong side of it.
   *
   * This read used to sit BELOW the block that follows, so approving a card whose task had already
   * gone terminal — cancelled while suspended, expired, failed under the stall watchdog — still ran
   * `parkAfterChaseSend`. That parks the case and advances the invoice's dunning ladder as though a
   * chase had gone out. Nothing was sent. The ladder claim was burned on the way past, which is the
   * exact failure class `promises.ts` already documents, and the next legitimate chase would find
   * the rung taken.
   *
   * So the order is: establish liveness, then act.
   */
  const t = await store.getTask(taskId);
  const terminal = !!t && TERMINAL_STATUSES.includes(t.status);

  /**
   * ═══ THE LESSON IS CAPTURED WHERE THE HUMAN DECIDES, NOT WHERE THE RUN WAITS ═══
   *
   * `recordApprovalOutcome` used to be called from here, and the comment above it claimed "every
   * path converges on this line". Every path a LIVE RUN takes converges here. The path where the
   * founder decides two hours later, after a deploy or a stall killed the run that was waiting,
   * converges nowhere — there is no process left to record anything.
   *
   * Measured 2026-09-06: 21 approvals decided, every one with a project, every one on a task that
   * SUCCEEDED, over 26 days of overlap with this code. `observations` held zero rows and all 22
   * rules in production carried `"source": "onboarding"`. Not one correction has ever become a
   * rule, while the landing page says "You correct it once, and it stops needing you".
   *
   * So it moved to the two doors a human decision actually comes through — the founder's approve
   * route and the client portal's — where it fires whether or not the run outlived the wait. It is
   * also the more honest place: an auto-approval driven by a wedge policy is not a human saying the
   * draft was right, and recording it as one taught the standing suggester from evidence nobody
   * gave.
   */
  if (task) {
    /**
     * Invoice chase closed loop: once the send is approved, wait for pay OR next ladder date.
     *
     * `!terminal` because this ADVANCES STATE on the back of a send. The lesson capture above is
     * deliberately not gated the same way — a founder who read the draft and rewrote it judged the
     * CONTENT, and that judgement is true whether or not the run survived to send it. This is a
     * different thing: it claims a rung on a real invoice's ladder. On a dead task there is no send
     * to park behind, so claiming the rung would cost the client a chase they never received.
     */
    if (!terminal && decision === "approved" && task.task_type === "chase_invoice") {
      void import("./dunning")
        .then(({ parkAfterChaseSend }) => parkAfterChaseSend(task))
        .catch((e) => console.error("[mycel] parkAfterChaseSend failed after approve:", e));
    }
  }

  // Terminal was established above, before anything acted on it. Do NOT emit more events or flip a
  // finished task back to running — task.finished must stay last.
  if (!terminal) {
    await emitEvent(store, taskId, "approval.resolved", {
      approval_id: approval.approval_id,
      decision,
    });
    if (decision === "approved") {
      await store.setStatus(taskId, "running");
    } else {
      // Rejected/expired ends the whole task with the matching terminal status (contract §1/§3).
      markAbort(taskId, decision);
    }
  }
  return { approvalId: approval.approval_id, decision, edited: outcome.edited };
}
