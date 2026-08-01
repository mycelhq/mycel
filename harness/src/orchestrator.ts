// Orchestration: provision a sandbox, run OpenCode against the task, enforce cost/runtime
// limits, persist + stream + trace events, tear the sandbox down. Approval suspend/resume lives
// in approvals.ts (driven by the OpenCode plugin gate). v0.1 runs in-process; a durable engine
// slots in at the same seams.
import { getArtifactBackend } from "./artifacts";
import { abortReason, clearAbort } from "./cancel";
import { loadConfig } from "./config";
import type { EventType, TaskStatus } from "./contract";
import { emitEvent } from "./events";
import { createSandbox, type Sandbox } from "./sandbox";
import { runOpenCodeTask, type CostMeta } from "./runtime";
import { runMockTask } from "./runtime.mock";
import type { Store } from "./store";
import { getObserver } from "./tracing";
import { validateOutput } from "./validate";

export async function runTask(store: Store, taskId: string): Promise<void> {
  const task = await store.getTask(taskId);
  if (!task) return;

  // One process-wide observer (the JSONL sink). The per-tenant variant existed for the Langfuse
  // sink, which is gone; see tracing.ts.
  const observer = await getObserver();
  await observer.onTaskStart(task);

  const emit = (type: EventType, data: Record<string, unknown> = {}) =>
    emitEvent(store, taskId, type, data);

  const deadline = Date.now() + task.constraints.max_runtime_s * 1000;
  let accruedCost = 0;

  /**
   * Unrecognised OpenCode event types seen during the run, reported on `task.finished`.
   *
   * The alternative is what happened before: a protocol change silently produced runs with no tool
   * calls, no tokens and no cost, and looked exactly like a quiet run. A counter here means the
   * next drift is visible on the very first task that hits it.
   */
  let drift: Record<string, number> | undefined;
  const onDrift = (counts: Record<string, number>) => {
    drift = counts;
  };

  const onCost = (usd: number, meta?: CostMeta) => {
    accruedCost += usd;
    // Fire-and-forget, but never leave an unhandled rejection (a pg blip must not crash the process).
    void store.addCost(taskId, usd).catch((e) => console.error("[mycel] addCost error:", e));
    void Promise.resolve(
      emit("cost.charged", {
        cost_usd: Number(usd.toFixed(6)),
        reason: meta?.reason ?? "model",
        // The model and the token counts ride ALONG with the dollars rather than being collapsed
        // into them. "Which model ran this?" is the first question anyone asks a trace, and until
        // now `cost.charged` carried `{cost_usd, reason}` and could not answer it.
        ...(meta?.model ? { model: meta.model } : {}),
        ...(meta?.tier ? { tier: meta.tier } : {}),
        ...(meta?.tokens ? { tokens: meta.tokens } : {}),
      }),
    ).catch((e) => console.error("[mycel] cost event error:", e));
  };

  // Synchronous, store-independent — safe to call on hot paths inside the run loop. The abort
  // registry carries user cancels AND approval outcomes (rejected/expired), so they end the run.
  const shouldAbort = (): string | null => {
    const r = abortReason(taskId);
    if (r) return r;
    if (Date.now() > deadline) return "max_runtime_exceeded";
    if (accruedCost > task.constraints.max_cost_usd) return "max_cost_exceeded";
    return null;
  };

  /** `unmapped` only appears when something WAS unmapped — an absent key means a clean run. */
  const driftData = () => (drift ? { unmapped: drift } : {});

  const ctx = { emit, onCost, shouldAbort, onDrift };
  const useMock = loadConfig().runtime === "mock";
  let sandbox: Sandbox | undefined;
  try {
    // Provisioning is inside the try: a sandbox that fails to start must fail the task, not
    // strand it in `queued` with an SSE stream hanging forever.
    await store.setStatus(taskId, "provisioning");
    if (!useMock) sandbox = await createSandbox();
    await store.setStatus(taskId, "running");
    await emit("task.created", { wedge: task.wedge, task_type: task.task_type });

    const { text } = useMock
      ? await runMockTask(task, ctx)
      : await runOpenCodeTask(task, sandbox!, ctx);

    // Honest validation against the wedge/task output_schema — not a hardcoded ok:true.
    const schema = task.output_schema;
    const v = validateOutput(text, schema);
    await emit("output.validated", { ok: v.ok, errors: v.errors });
    if (!v.ok) throw new Error(`output failed validation: ${v.errors.join("; ")}`);

    const backend = await getArtifactBackend();
    const art = await store.addArtifact({
      task_id: taskId,
      name: "result.txt",
      content_type: "text/plain",
      content: backend.inline ? text : "",
    });
    if (!backend.inline) await backend.put(art.id, text);
    await emit("artifact.created", {
      artifact_id: art.id,
      name: art.name,
      content_type: art.content_type,
      url: `/v1/artifacts/${art.id}`,
    });
    await store.setStatus(taskId, "succeeded");
    await emit("task.finished", { status: "succeeded", ...driftData() });
  } catch (e) {
    const reason = String((e as Error)?.message ?? e);
    const status = terminalStatusFor(reason);
    await store.setStatus(taskId, status, reason);
    await emit("task.finished", { status, error: reason, ...driftData() });
  } finally {
    clearAbort(taskId);
    if (sandbox) await sandbox.destroy();
    const final = await store.getTask(taskId);
    await observer.onTaskEnd(taskId, final?.status ?? "unknown");
  }
}

/** Map an abort/error reason to the terminal status the contract defines. */
function terminalStatusFor(reason: string): TaskStatus {
  if (reason.includes("cancelled")) return "cancelled";
  if (reason.includes("rejected")) return "rejected";
  if (reason.includes("expired")) return "expired";
  if (reason.includes("max_runtime")) return "expired";
  return "failed";
}
