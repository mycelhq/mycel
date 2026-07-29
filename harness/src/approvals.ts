// Human-in-the-loop approval: suspend a running task until a human approves/rejects an action,
// then resume. Shared by the OpenCode plugin gate (server /v1/internal/gate) and the API
// approve/reject endpoints. This is the trust primitive — the reason an AI-native service can
// take real actions safely.
import { markAbort } from "./cancel";
import type { ApprovalDecision, Risk } from "./contract";
import { emitEvent } from "./events";
import { evaluatePolicy } from "./policy";
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
  req: { action: string; risk: Risk; preview: Record<string, unknown>; ttlMs?: number },
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
  const decisionByPolicy = evaluatePolicy(loadWedge(task?.wedge ?? "")?.manifest, {
    action: req.action,
    payload: req.preview,
    taskId,
    projectId: task?.project_id,
  });
  if (decisionByPolicy.auto) {
    await store.setApproval(approval.approval_id, "auto_approved", decisionByPolicy.reason);
    await emitEvent(store, taskId, "approval.resolved", {
      approval_id: approval.approval_id,
      action: req.action,
      decision: "auto_approved",
      policy_reason: decisionByPolicy.reason,
    });
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
    waiters.set(approval.approval_id, { taskId, resolve });
    (byTask.get(taskId) ?? byTask.set(taskId, new Set()).get(taskId)!).add(approval.approval_id);
    const ttl = setTimeout(
      () => settle(approval.approval_id, { decision: "expired" }),
      req.ttlMs ?? 5 * 60 * 1000,
    );
    (ttl as { unref?: () => void }).unref?.();
  });
  const decision = outcome.decision;

  await store.setApproval(approval.approval_id, decision);

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
