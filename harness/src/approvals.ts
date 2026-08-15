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
import { loadWedge } from "./wedge";
import type { Store } from "./store";

/** The outcome of an approval — plus, when the human edits the action before approving, the
 *  corrected payload. That edit is the highest-signal feedback in the system. */
export interface ApprovalOutcome {
  decision: ApprovalDecision;
  edited?: Record<string, unknown>;
}

interface Waiter {
  taskId: string;
  resolve: (o: ApprovalOutcome) => void;
}
const waiters = new Map<string, Waiter>();
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

function settle(id: string, outcome: ApprovalOutcome): boolean {
  const w = waiters.get(id);
  if (!w) return false;
  waiters.delete(id);
  byTask.get(w.taskId)?.delete(id);
  w.resolve(outcome);
  return true;
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
    : await evaluatePolicy(loadWedge(task?.wedge ?? "")?.manifest, {
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

    const ttl = setTimeout(() => settle(approval.approval_id, { decision: "expired" }), req.ttlMs ?? 5 * 60 * 1000);
    (ttl as { unref?: () => void }).unref?.();
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
  if (task) {
    await recordApprovalOutcome(getKnowledgeStore(), {
      project_id: task.project_id,
      wedge: task.wedge,
      task_type: task.task_type,
      client_id: taskClientId(task),
      action: req.action,
      decision,
      proposed: req.preview ?? {},
      edited: outcome.edited,
      task_id: taskId,
      approval_id: approval.approval_id,
    });
    // Invoice chase closed loop: once the send is approved, wait for pay OR next ladder date.
    if (decision === "approved" && task.task_type === "chase_invoice") {
      void import("./dunning")
        .then(({ parkAfterChaseSend }) => parkAfterChaseSend(task))
        .catch((e) => console.error("[mycel] parkAfterChaseSend failed after approve:", e));
    }
  }

  // If the task already reached a terminal state (e.g. cancelled while suspended), do NOT emit
  // more events or flip it back to running — task.finished must stay last.
  const t = await store.getTask(taskId);
  const terminal = t && ["succeeded", "failed", "rejected", "expired", "cancelled"].includes(t.status);
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
