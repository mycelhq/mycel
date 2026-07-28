// Human-in-the-loop approval: suspend a running task until a human approves/rejects an action,
// then resume. Shared by the OpenCode plugin gate (server /v1/internal/gate) and the API
// approve/reject endpoints. This is the trust primitive — the reason an AI-native service can
// take real actions safely.
import type { ApprovalDecision, Risk } from "./contract";
import { emitEvent } from "./events";
import type { Store } from "./store";

const waiters = new Map<string, (d: ApprovalDecision) => void>();

/** Resume a suspended task. Called by POST /v1/approvals/:id/approve|reject. */
export function resolveApproval(id: string, decision: "approved" | "rejected"): boolean {
  const w = waiters.get(id);
  if (w) {
    waiters.delete(id);
    w(decision);
    return true;
  }
  return false;
}

/** Create an approval, emit approval.requested, and block until resolved (or TTL expiry). */
export async function awaitApproval(
  store: Store,
  taskId: string,
  req: { action: string; risk: Risk; preview: Record<string, unknown>; ttlMs?: number },
): Promise<{ approvalId: string; decision: ApprovalDecision }> {
  const approval = store.createApproval({
    task_id: taskId,
    action: req.action,
    risk: req.risk,
    preview: req.preview,
    ttlMs: req.ttlMs,
  });
  store.setStatus(taskId, "awaiting_approval");
  await emitEvent(store, taskId, "approval.requested", {
    approval_id: approval.approval_id,
    action: req.action,
    risk: req.risk,
    preview: req.preview,
  });

  const decision = await new Promise<ApprovalDecision>((resolve) => {
    waiters.set(approval.approval_id, resolve);
    const ttl = setTimeout(
      () => {
        if (waiters.has(approval.approval_id)) {
          waiters.delete(approval.approval_id);
          resolve("expired");
        }
      },
      req.ttlMs ?? 5 * 60 * 1000,
    );
    (ttl as { unref?: () => void }).unref?.();
  });

  store.setApproval(approval.approval_id, decision);
  store.setStatus(taskId, "running");
  await emitEvent(store, taskId, "approval.resolved", {
    approval_id: approval.approval_id,
    decision,
  });
  return { approvalId: approval.approval_id, decision };
}
