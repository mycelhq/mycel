// Per-project ingest keys.
//
// The product must NOT present the founder's product key to post analytics. That key can start
// tasks, read every client, mint sessions and change the plan; it lives in the product's server
// environment precisely because it is that powerful. An analytics endpoint is reachable, in effect,
// by anyone who can load the founder's homepage — putting the master key behind it means one
// misconfigured route handler turns "someone can inflate my pageview count" into "someone owns my
// business". So ingest gets its own credential whose entire authority is: APPEND EVENTS TO ONE
// PROJECT.
//
// The key is DERIVED rather than stored:
//
//     mik_<base64url(project_id)>_<hmac(secret, project_id) truncated>
//
// Two reasons. There is no new table, no migration and no cache to go stale — the kernel can verify
// a key on a cold replica with no database, which matters because this is a write path that must
// stay cheap. And revocation is a secret rotation, which is a thing an operator already knows how
// to do, rather than a delete against a table nobody remembers exists.
//
// The trade is that keys cannot be revoked individually, only per-deployment. That is acceptable
// for a credential that can only append events to a project the holder is already collecting for;
// it would not be acceptable for anything that can read.
import { mintProjectKey, projectForKey } from "../scopedkeys";

/** Prefix. `mik_` — "mycel ingest key" — and it is identifiable on sight in a log. */
const PREFIX = "mik_";
/**
 * Signed into the tag, so an ingest key verifies as an ingest key and as nothing else.
 *
 * UNCHANGED from when the HMAC lived in this file (`insight:v1:${projectId}`, where the trailing
 * colon was part of the template rather than of the label). It has to be: every ingest key already
 * pasted into a founder's hosting dashboard was minted with this exact material, and changing it
 * would silently stop their analytics without anything failing loudly enough to notice.
 */
const LABEL = "insight:v1";

/** Mint the ingest key for a project. Deterministic: minting twice returns the same key. */
export function ingestKeyFor(projectId: string): string {
  return mintProjectKey(PREFIX, LABEL, projectId);
}

/**
 * Which project does this key authorise — and only this project.
 *
 * The derivation moved to `scopedkeys.ts` when branding needed a credential of the same shape. Two
 * hand-written HMAC verifiers is how one of them ends up comparing with `===`, so there is one, and
 * this is a named call into it rather than a copy.
 */
export function projectForIngestKey(key: string | undefined | null): string | undefined {
  return projectForKey(PREFIX, LABEL, key);
}
