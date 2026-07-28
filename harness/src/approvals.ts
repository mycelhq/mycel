// Human-in-the-loop approval: suspend a running task until a human approves/rejects an action,
// then resume. Shared by the OpenCode plugin gate (server /v1/internal/gate) and the API
// approve/reject endpoints. This is the trust primitive — the reason an AI-native service can
// take real actions safely.
import { markAbort } from "./cancel";
import type { ApprovalDecision, Risk } from "./contract";
import { emitEvent } from "./events";
import type { Store } from "./store";

interface Waiter {
  taskId: string;
  resolve: (d: ApprovalDecision) => void;
}
const waiters = new Map<string, Waiter>();
// taskId -> its pending approval ids, so a cancel can settle them (no dangling waiter/timer).
const byTask = new Map<string, Set<string>>();

/** Resume a suspended task. Called by POST /v1/approvals/:id/approve|reject. */
export function resolveApproval(id: string, decision: "approved" | "rejected"): boolean {
  return settle(id, decision);
}

/** Settle any pending approvals for a task (used when the task is cancelled while suspended). */
export function failWaitersForTask(taskId: string, decision: ApprovalDecision): void {
  for (const id of [...(byTask.get(taskId) ?? [])]) settle(id, decision);
}

function settle(id: string, decision: ApprovalDecision): boolean {
  const w = waiters.get(id);
  if (!w) return false;
  waiters.delete(id);
  byTask.get(w.taskId)?.delete(id);
  w.resolve(decision);
  return true;
}

/** Create an approval, emit approval.requested, and block until resolved (or TTL expiry). */
export async function awaitApproval(
  store: Store,
  taskId: string,
  req: { action: string; risk: Risk; preview: Record<string, unknown>; ttlMs?: number },
): Promise<{ approvalId: string; decision: ApprovalDecision }> {
  const approval = await store.createApproval({
    task_id: taskId,
    action: req.action,
    risk: req.risk,
    preview: req.preview,
    ttlMs: req.ttlMs,
  });
  await store.setStatus(taskId, "awaiting_approval");
  await emitEvent(store, taskId, "approval.requested", {
    approval_id: approval.approval_id,
    action: req.action,
    risk: req.risk,
    preview: req.preview,
  });

  const decision = await new Promise<ApprovalDecision>((resolve) => {
    waiters.set(approval.approval_id, { taskId, resolve });
    (byTask.get(taskId) ?? byTask.set(taskId, new Set()).get(taskId)!).add(approval.approval_id);
    const ttl = setTimeout(
      () => settle(approval.approval_id, "expired"),
      req.ttlMs ?? 5 * 60 * 1000,
    );
    (ttl as { unref?: () => void }).unref?.();
  });

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
  return { approvalId: approval.approval_id, decision };
}
