// A live handle to an in-flight OpenCode run — the seam that lets an outside request reach a running
// build's session and sandbox.
//
// ═══ WHY THIS EXISTS AND WHY IT IS DELIBERATELY THIN ═══
//
// Steering a build mid-flight and reading its live file tree both need the same thing the run holds
// only inside `runOpenCodeTask`'s closure: the opencode client, the session id, the sandbox. Rather
// than thread those out through the store (they are not serialisable and die with the run), the run
// registers a handle here for exactly as long as it executes and deregisters in its `finally`.
//
// ═══ THE ONE INVARIANT EVERY CONSUMER MUST RESPECT ═══
//
// A handle is present ONLY while the run is executing, and the sandbox is torn down the moment the
// run ends. So a MISSING entry is not an error — it is "the run is over" (or, on a multi-replica
// deployment, "the run is executing on another replica"). Every route that reads this must answer a
// miss with 409/410, never 500, and fall back to the durable artifacts (the exported workspace, the
// event log) for anything a finished run should still be able to show.
//
// This map is PROCESS-LOCAL. With N kernel replicas a steer/file request can land on a replica that
// is not running the task; the lookup misses and the route says so. That is correct for the current
// single-active-build model; task→replica routing is the future change if a build ever needs to be
// steerable from any replica.
import type { OpenCodeClient } from "./opencode";
import type { Sandbox } from "./sandbox";

export interface RunHandle {
  taskId: string;
  projectId?: string;
  sessionId: string;
  oc: OpenCodeClient;
  sandbox: Sandbox;
  /** The model ref `startPrompt` needs — the same `promptModel` the initial prompt used. */
  model: string;
  /** The run's workspace directory (`ws.dir`), so file reads stay inside the founder's app. */
  workspaceDir?: string;
  /**
   * Boot the long-lived preview dev server and emit `preview.ready`. Present only for BUILD runs, and
   * called ON DEMAND (when a founder opens the Preview tab) so an unwatched build spends nothing on a
   * preview. Idempotent — safe to call on every tab open.
   */
  startPreview?: () => Promise<void>;
}

const runs = new Map<string, RunHandle>();

export function registerRun(handle: RunHandle): void {
  runs.set(handle.taskId, handle);
}

export function deregisterRun(taskId: string): void {
  runs.delete(taskId);
}

export function getRun(taskId: string): RunHandle | undefined {
  return runs.get(taskId);
}
