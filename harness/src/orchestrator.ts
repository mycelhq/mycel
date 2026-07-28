// Orchestration: provision a sandbox, run OpenCode against the task, enforce cost/runtime
// limits, persist + stream + trace events, tear the sandbox down. Approval suspend/resume lives
// in approvals.ts (driven by the OpenCode plugin gate). v0.1 runs in-process; Inngest slots in
// at the same seams.
import type { EventType } from "./contract";
import { emitEvent } from "./events";
import { createSandbox } from "./sandbox";
import { runOpenCodeTask } from "./runtime";
import type { Store } from "./store";
import { getObserver } from "./tracing";

export async function runTask(store: Store, taskId: string): Promise<void> {
  const task = store.getTask(taskId);
  if (!task) return;

  const observer = await getObserver();
  await observer.onTaskStart(task);

  const emit = (type: EventType, data: Record<string, unknown> = {}) =>
    emitEvent(store, taskId, type, data);

  const deadline = Date.now() + task.constraints.max_runtime_s * 1000;

  const onCost = (usd: number) => {
    store.addCost(taskId, usd);
    void emit("cost.charged", { cost_usd: Number(usd.toFixed(6)), reason: "model" });
  };

  const shouldAbort = (): string | null => {
    const t = store.getTask(taskId);
    if (t?.status === "cancelled") return "cancelled";
    if (Date.now() > deadline) return "max_runtime_exceeded";
    if ((t?.cost_usd ?? 0) > task.constraints.max_cost_usd) return "max_cost_exceeded";
    return null;
  };

  const sandbox = await createSandbox();
  try {
    store.setStatus(taskId, "running");
    await emit("task.created", { wedge: task.wedge, task_type: task.task_type });

    const { text } = await runOpenCodeTask(task, sandbox, { emit, onCost, shouldAbort });

    await emit("output.validated", { ok: true });
    const art = store.addArtifact({
      task_id: taskId,
      name: "result.txt",
      content_type: "text/plain",
      content: text,
    });
    await emit("artifact.created", {
      artifact_id: art.id,
      name: art.name,
      content_type: art.content_type,
      url: `/v1/artifacts/${art.id}`,
    });
    store.setStatus(taskId, "succeeded");
    await emit("task.finished", { status: "succeeded" });
  } catch (e) {
    const reason = String((e as Error)?.message ?? e);
    const status = reason.includes("cancelled")
      ? "cancelled"
      : reason.includes("max_runtime")
        ? "expired"
        : "failed";
    store.setStatus(taskId, status);
    await emit("task.finished", { status, error: reason });
  } finally {
    await sandbox.destroy();
    await observer.onTaskEnd(taskId, store.getTask(taskId)?.status ?? "unknown");
  }
}
