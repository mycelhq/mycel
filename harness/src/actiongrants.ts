// Action-mode grants — the generalization of proxy-mode (proxygrants.ts) from "LLM calls" to
// "real-world side effects". When a task runs, the harness mints an opaque nonce and records
// which connections that task may act through (plus the thread its replies belong to). The
// sandbox's tools call /v1/internal/actions/* with the nonce; the harness looks up the real
// connection secret, runs the human approval gate, executes, and traces it. The connection
// secrets — Stripe/Postmark/Twilio keys — never enter the sandbox. Grant is revoked when the run
// ends.
//
// SHARED, not process-local, for the same reason as proxygrants: the nonce is minted in a worker
// process and presented to an API replica that never saw it. As a `Map` that was a hard 401 on the
// action proxy, the read proxy, the case/gap/records APIs and workflows — the entire tool surface.
//
// The payload here holds no secrets, only ids: which connections this run may reach. The secrets
// stay where they were, resolved server-side per action.
import { randomBytes } from "node:crypto";
import { getGrantStore, grantTtlMs } from "./store";

export interface ActionGrant {
  task_id: string;
  /** Connection ids this task may act through (least privilege — only what the run needs). */
  connectionIds: string[];
  /** The thread outbound messages are recorded on (a reply's conversation), if any. */
  threadId?: string;
  /** The case this run is an episode of, if any — lets the agent read/advance its engagement. */
  caseId?: string;
}

export async function registerActionGrant(g: ActionGrant): Promise<string> {
  const nonce = randomBytes(24).toString("base64url");
  const store = await getGrantStore();
  await store.put(
    "action",
    nonce,
    {
      task_id: g.task_id,
      connectionIds: g.connectionIds,
      threadId: g.threadId ?? null,
      caseId: g.caseId ?? null,
    },
    new Date(Date.now() + grantTtlMs()),
  );
  return nonce;
}

export async function getActionGrant(nonce: string): Promise<ActionGrant | undefined> {
  if (!nonce) return undefined;
  let row: Record<string, unknown> | undefined;
  try {
    row = await (await getGrantStore()).get("action", nonce);
  } catch (e) {
    // Fail CLOSED — an unreachable database must never mean "this nonce may act". Callers 401.
    console.error("[mycel] action grant lookup failed:", (e as Error)?.message);
    return undefined;
  }
  if (!row) return undefined;
  return {
    task_id: String(row.task_id ?? ""),
    // jsonb round-trips arrays faithfully, but a hand-edited or truncated row must not become
    // `undefined` on a field every authorisation check reads with `.includes`.
    connectionIds: Array.isArray(row.connectionIds) ? (row.connectionIds as string[]) : [],
    threadId: row.threadId ? String(row.threadId) : undefined,
    caseId: row.caseId ? String(row.caseId) : undefined,
  };
}

export async function revokeActionGrant(nonce: string): Promise<void> {
  // Best-effort, like the proxy grant: the TTL in the lookup is what actually bounds the capability.
  try {
    await (await getGrantStore()).del("action", nonce);
  } catch (e) {
    console.error("[mycel] action grant revoke failed:", (e as Error)?.message);
  }
}
