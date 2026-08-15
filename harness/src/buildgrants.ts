// Build-mode grants — the third member of the family, after proxygrants.ts (LLM calls) and
// actiongrants.ts (real-world side effects). Same shape, same store, same lifetime: the harness
// mints an opaque nonce when a `build` run starts, the sandbox presents it on ONE enumerated
// kernel path, and the grant is revoked when the run ends.
//
// A SEPARATE KIND, not a flag on the action grant, and that is the whole point of the file.
//
// A `build` profile deliberately holds no action grant (`grants_actions: false` in harness.ts) —
// no connection is resolved, no MYCEL_ACTION_TOKEN enters the sandbox, and every control-plane
// endpoint answers 401. That is the security boundary for a build run: it edits source and it can
// reach nothing. Reusing the action nonce to authenticate the build tool would have handed a build
// run a credential that also opens /v1/internal/records, /v1/internal/knowledge/gap and
// /v1/internal/case — endpoints scoped to the grant's task, so not a cross-tenant hole, but a
// widening of what a shell-enabled run can touch that nobody asked for and nothing would have
// flagged. `GrantKind` namespaces the nonce space, so a build nonce cannot resolve as an action
// grant and vice versa; the build nonce opens /v1/internal/build and nothing else in the system.
//
// SHARED, not process-local, for the reason written out in the other two: the nonce is minted in a
// worker process and presented to whichever replica the load balancer picks.
import { randomBytes } from "node:crypto";
import { getGrantStore, grantTtlMs } from "./store";

export interface BuildGrant {
  task_id: string;
  /**
   * The project the source is staged under. Read from the KERNEL's database at mint time and
   * carried here so the S3 key cannot be influenced by anything the sandbox sends — the same
   * property deploy.ts protects, stated as data rather than as a convention.
   */
  project_id: string;
}

export async function registerBuildGrant(g: BuildGrant): Promise<string> {
  const nonce = randomBytes(24).toString("base64url");
  const store = await getGrantStore();
  // No secret in the payload — only ids. Nothing here needs sealing the way a provider key does.
  await store.put(
    "build",
    nonce,
    { task_id: g.task_id, project_id: g.project_id },
    new Date(Date.now() + grantTtlMs()),
  );
  return nonce;
}

export async function getBuildGrant(nonce: string): Promise<BuildGrant | undefined> {
  if (!nonce) return undefined;
  let row: Record<string, unknown> | undefined;
  try {
    row = await (await getGrantStore()).get("build", nonce);
  } catch (e) {
    // Fail CLOSED, like the other two. An unreachable database must never mean "this nonce may
    // spend money in the build plane". The caller answers 401.
    console.error("[mycel] build grant lookup failed:", (e as Error)?.message);
    return undefined;
  }
  if (!row) return undefined;
  return { task_id: String(row.task_id ?? ""), project_id: String(row.project_id ?? "") };
}

export async function revokeBuildGrant(nonce: string): Promise<void> {
  // Best-effort; the TTL in the lookup is what actually bounds the capability.
  try {
    await (await getGrantStore()).del("build", nonce);
  } catch (e) {
    console.error("[mycel] build grant revoke failed:", (e as Error)?.message);
  }
}
