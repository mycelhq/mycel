// In-process abort registry. Anything that must stop a running task mid-flight records a reason
// here, so the orchestrator's shouldAbort() can check it synchronously without an async store
// read on a hot path. Reasons flow through to the terminal status: "cancelled" (user cancel),
// "rejected"/"expired" (approval outcome). (For multi-instance, back this with Redis pub/sub —
// same interface.)
const aborts = new Map<string, string>();

/** Record why a task must stop. First reason wins. */
export function markAbort(taskId: string, reason: string): void {
  if (!aborts.has(taskId)) aborts.set(taskId, reason);
}

/** The abort reason for a task, or null if it should keep running. */
export function abortReason(taskId: string): string | null {
  return aborts.get(taskId) ?? null;
}

export function clearAbort(taskId: string): void {
  aborts.delete(taskId);
}

// ── back-compat shims (cancel is just an abort with reason "cancelled") ──
export function markCancelled(taskId: string): void {
  markAbort(taskId, "cancelled");
}
export function isCancelled(taskId: string): boolean {
  return abortReason(taskId) === "cancelled";
}
export function clearCancelled(taskId: string): void {
  clearAbort(taskId);
}
