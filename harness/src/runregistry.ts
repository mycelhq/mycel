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
import type { SteerQueue } from "./steer-queue";
import type { Sandbox } from "./sandbox";

/**
 * Where the live preview is on its way from "sandbox exists" to "a browser can watch the app".
 *
 * A real ladder, driven by real observations inside the sandbox (`node_modules` appearing, the dev
 * port answering), never by optimistic timers. `failed` carries the tail of /tmp/preview.log so the
 * founder UI can say what actually went wrong instead of spinning forever.
 */
import type { Buffer } from "node:buffer";

export interface PreviewStatus {
  stage: "starting" | "installing" | "booting" | "live" | "failed";
  /** Base URL the KERNEL uses to reach the dev server (Daytona preview link / mapped localhost). */
  url?: string;
  /** Daytona preview token — travels as the `x-daytona-preview-token` header, never in a URL. */
  token?: string;
  port: number;
  startedAt: number;
  /** Tail of the dev-server log when `stage === "failed"`. */
  error?: string;
}

export interface RunHandle {
  taskId: string;
  projectId?: string;
  sessionId: string;
  /**
   * The founder's messages to this run, serialised.
   *
   * NOT `oc.startPrompt` directly, which is what `/v1/tasks/:id/steer` used to call. a comparable runtime runs the
   * same OpenCode daemon and documents why in `session-lifecycle/inbox-admission.ts`: the
   * `/prompt_async` route interleaves inputs posted during a live turn, so two messages typed
   * quickly arrive in whichever order the network settled. See `steer-queue.ts` for what transfers
   * from their design and what deliberately does not.
   */
  steer: SteerQueue;
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
  /**
   * Live preview ladder, written by the boot sequence `startPreview` kicks off and read by
   * `GET /v1/tasks/:id/preview` (status) and `GET /v1/preview/:grant/*` (the proxy). Absent until
   * `startPreview` has been called at least once.
   */
  preview?: PreviewStatus;
  /**
   * Attach a read-only screencast to the browser this run is driving, and return the newest frame.
   *
   * Present only for `operate` runs, and called ON DEMAND — the same argument `startPreview` makes:
   * a second CDP connection and a stream of JPEGs is real work, and an `operate` run nobody is
   * watching should not pay for it. Idempotent, so a poller may call it on every tick.
   *
   * Returns the reason there is no picture rather than throwing, because "waiting for the browser to
   * paint", "the agent has not opened one yet" and "it crashed" are three different sentences and a
   * viewer needs to be told which.
   */
  screen?: () => Promise<{ frame?: { bytes: Buffer; at: number; width: number; height: number }; why?: string }>;
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
