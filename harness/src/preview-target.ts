// ═══ WHERE A LIVE PREVIEW IS, READABLE FROM ANY REPLICA ═══
//
// THE BUG THIS EXISTS FOR: `/v1/preview/:grant/*` resolved the sandbox's dev server through
// `getRun(taskId)` — the process-local run registry. Runs execute on the WORKER service
// (`worker_count = 2`); `/v1/preview/*` has no ALB listener rule, so it falls to the default target
// group, which is the API service (`api_count = 2`). The preview request therefore lands on a
// process that has never held the handle, `getRun` misses, and the proxy answers its "the run is
// over" page. Every time, for every founder.
//
// It works perfectly in local development, where the API and the worker are one process. That is
// why it shipped and why it read as "the preview URL doesn't work" rather than as a routing bug.
//
// THE PRECEDENT: `runregistry.ts` states the invariant ("This map is PROCESS-LOCAL... a steer/file
// request can land on a replica that is not running the task"), and `infra/main.tf` records the
// same class of bug already fixed once — sandbox callback nonces were `Map`s, "a callback had a
// 1-in-N chance of finding its grant and the rest were 401s", and the fix was to move them to the
// shared `grants` table. This is that fix, for the preview.
//
// WHAT IS SHARED AND WHAT IS NOT: only the ENDPOINT (stage, url, token, error). The run handle
// itself — the opencode client, the session, the sandbox — stays process-local, because those are
// not serialisable and genuinely die with the run. A proxy does not need them; it needs an address.
//
// LIFETIME: written as the boot ladder advances, deleted when the run ends. A stale row outliving
// its sandbox would proxy to an address that no longer answers, so the TTL is the backstop and the
// `finally` in runtime.ts is the primary.

import type { PreviewStatus } from "./runregistry";
import { getGrantStore, grantTtlMs } from "./store";

const KIND = "preview_target";

/** What a proxy on any replica needs to reach the dev server. */
export interface PreviewTarget {
  stage: PreviewStatus["stage"];
  url?: string;
  token?: string;
  error?: string;
  project_id?: string;
}

/**
 * Publish where this preview is. Called on every rung of the ladder, not only at `live` — a founder
 * watching from another replica must see "installing" too, or the page they get is indistinguishable
 * from a run that never started.
 *
 * NEVER THROWS. A preview is a convenience; failing a build because a status write failed would
 * trade the thing that matters for the thing that does not.
 */
export async function publishPreviewTarget(
  taskId: string,
  status: PreviewStatus,
  projectId?: string,
): Promise<void> {
  if (!taskId) return;
  try {
    const payload: PreviewTarget = {
      stage: status.stage,
      ...(status.url ? { url: status.url } : {}),
      ...(status.token ? { token: status.token } : {}),
      ...(status.error ? { error: status.error } : {}),
      ...(projectId ? { project_id: projectId } : {}),
    };
    const store = await getGrantStore();
    await store.put(KIND, taskId, payload as unknown as Record<string, unknown>, new Date(Date.now() + grantTtlMs()));
  } catch {
    /* a preview status is never worth failing a run over */
  }
}

/** Read it back on whichever replica the browser landed on. */
export async function readPreviewTarget(taskId: string): Promise<PreviewTarget | undefined> {
  if (!taskId) return undefined;
  try {
    const row = await (await getGrantStore()).get(KIND, taskId);
    if (!row) return undefined;
    const r = row as unknown as Record<string, unknown>;
    const payload = (r.payload ?? r) as Record<string, unknown>;
    const stage = payload.stage;
    if (typeof stage !== "string") return undefined;
    return {
      stage: stage as PreviewStatus["stage"],
      url: typeof payload.url === "string" ? payload.url : undefined,
      token: typeof payload.token === "string" ? payload.token : undefined,
      error: typeof payload.error === "string" ? payload.error : undefined,
      project_id: typeof payload.project_id === "string" ? payload.project_id : undefined,
    };
  } catch {
    return undefined;
  }
}

/**
 * Drop it when the run ends. The sandbox is torn down with the run, so a row that outlives it points
 * at an address that no longer answers — and the founder would get a proxy error instead of the
 * honest "this run is over".
 */
export async function clearPreviewTarget(taskId: string): Promise<void> {
  if (!taskId) return;
  try {
    await (await getGrantStore()).del(KIND, taskId);
  } catch {
    /* best effort; the TTL is the backstop */
  }
}
