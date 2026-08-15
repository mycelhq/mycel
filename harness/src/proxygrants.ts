// Proxy-mode credential grants. In proxy mode the sandbox never sees a provider key — it gets
// an opaque nonce. The harness holds the real key here, keyed by that nonce; the LLM proxy
// (/v1/internal/llm) looks it up and forwards with the real key. Grant is revoked when the run ends.
//
// SHARED, not process-local. The deployment runs two API replicas and two workers, the queue hands
// a task to whichever worker claims it, and the worker service is not in the ALB target group at
// all — so the nonce is always minted in one process and presented to another. As a `Map` this did
// not degrade, it broke: `401 invalid proxy token` on every model call, with no log that said why.
// Backed by the grants table (store.ts / store.pg.ts), in-memory when no database is configured.
import { randomBytes } from "node:crypto";
import { open_, seal, type SealedSecret } from "./secrets";
import { getGrantStore, grantTtlMs } from "./store";

export interface ProxyGrant {
  base_url: string; // OpenAI-compatible upstream (provider or a LiteLLM proxy)
  api_key: string; // the REAL provider key — never leaves the server
  model: string; // the real model id
  task_id: string;
}

export async function registerGrant(g: ProxyGrant): Promise<string> {
  const nonce = randomBytes(24).toString("base64url");
  const store = await getGrantStore();
  // A durable backend means this row is in a database that gets dumped, replicated and backed up.
  // A live provider key in plaintext there is strictly worse than the Map this replaces, so it goes
  // in sealed with the same AES-256-GCM envelope that protects vault secrets (secrets.ts). That
  // adds no new operational requirement: connection secrets are already read cross-replica through
  // MYCEL_SECRET_KEY, so a fleet already needs one shared key. In memory the payload never leaves
  // the heap that produced it, so sealing there would only force a key on `npm run dev`.
  const payload: Record<string, unknown> = store.durable
    ? { base_url: g.base_url, model: g.model, task_id: g.task_id, sealed_key: seal(g.api_key) }
    : { base_url: g.base_url, model: g.model, task_id: g.task_id, api_key: g.api_key };
  await store.put("proxy", nonce, payload, new Date(Date.now() + grantTtlMs()));
  return nonce;
}

export async function getGrant(nonce: string): Promise<ProxyGrant | undefined> {
  if (!nonce) return undefined;
  let row: Record<string, unknown> | undefined;
  try {
    row = await (await getGrantStore()).get("proxy", nonce);
  } catch (e) {
    // Fail CLOSED. An unreachable database must not turn into "any nonce is fine" on a route whose
    // whole job is to hold a provider key away from the sandbox. The caller answers 401.
    console.error("[mycel] proxy grant lookup failed:", (e as Error)?.message);
    return undefined;
  }
  if (!row) return undefined;
  const key =
    typeof row.api_key === "string"
      ? row.api_key
      : row.sealed_key
        ? open_(row.sealed_key as SealedSecret)
        : undefined;
  // A key that will not open (rotated or ephemeral MYCEL_SECRET_KEY) is a grant we cannot honour.
  // Refusing is right: forwarding with an empty key would fail upstream anyway, opaquely.
  if (key === undefined) return undefined;
  return {
    base_url: String(row.base_url ?? ""),
    api_key: key,
    model: String(row.model ?? ""),
    task_id: String(row.task_id ?? ""),
  };
}

export async function revokeGrant(nonce: string): Promise<void> {
  // Revocation is best-effort: the grant also carries a TTL that the lookup enforces, so a failed
  // delete costs a row, not a live capability.
  try {
    await (await getGrantStore()).del("proxy", nonce);
  } catch (e) {
    console.error("[mycel] proxy grant revoke failed:", (e as Error)?.message);
  }
}
