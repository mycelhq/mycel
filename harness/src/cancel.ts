// In-process cancellation registry. The cancel endpoint marks a task here so the running
// orchestrator's shouldAbort() can check it synchronously, without an async store read on a
// hot path. (For multi-instance, back this with Redis pub/sub — same interface.)
const cancelled = new Set<string>();

export function markCancelled(taskId: string): void {
  cancelled.add(taskId);
}

export function isCancelled(taskId: string): boolean {
  return cancelled.has(taskId);
}

export function clearCancelled(taskId: string): void {
  cancelled.delete(taskId);
}
