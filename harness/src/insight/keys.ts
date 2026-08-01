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
import { createHmac, timingSafeEqual } from "node:crypto";
import { loadConfig } from "../config";

const PREFIX = "mik_";
/** 128 bits of tag. Enough that guessing is not a strategy; short enough to paste into an env var. */
const TAG_LENGTH = 32;

/**
 * The signing secret.
 *
 * `MYCEL_INSIGHT_SECRET` when set — that is the knob to turn to revoke every ingest key at once.
 * Otherwise the product API key, which is already required to be stable across restarts in any real
 * deployment (config.ts generates an ephemeral one only in development, where an ingest key that
 * dies with the process is the correct behaviour anyway).
 */
function secret(): string {
  return process.env.MYCEL_INSIGHT_SECRET || loadConfig().apiKey;
}

function tag(projectId: string): string {
  return createHmac("sha256", secret()).update(`insight:v1:${projectId}`).digest("hex").slice(0, TAG_LENGTH);
}

/** Mint the ingest key for a project. Deterministic: minting twice returns the same key. */
export function ingestKeyFor(projectId: string): string {
  return `${PREFIX}${Buffer.from(projectId, "utf8").toString("base64url")}_${tag(projectId)}`;
}

/**
 * Which project does this key authorise — and only this project.
 *
 * Returns undefined for anything that does not verify. Note what is NOT here: no lookup of a
 * project id supplied by the caller, no fallback to a default project, no "if the tag is missing
 * treat it as the org's only project". Every one of those is how a scoping bug gets written, and
 * today's session found three of them in this codebase already. The project id comes out of the
 * signature or the request is refused.
 */
export function projectForIngestKey(key: string | undefined | null): string | undefined {
  if (!key || typeof key !== "string" || !key.startsWith(PREFIX)) return undefined;
  const body = key.slice(PREFIX.length);
  const sep = body.lastIndexOf("_");
  if (sep <= 0) return undefined;
  const encoded = body.slice(0, sep);
  const presented = body.slice(sep + 1);
  if (presented.length !== TAG_LENGTH) return undefined;
  let projectId: string;
  try {
    projectId = Buffer.from(encoded, "base64url").toString("utf8");
  } catch {
    return undefined;
  }
  // A project id is a UUID (or a test-supplied string); anything with structure in it would let a
  // caller smuggle a path or a query fragment through into the record key.
  if (!projectId || !/^[A-Za-z0-9._:-]{1,80}$/.test(projectId)) return undefined;
  const expected = Buffer.from(tag(projectId));
  const got = Buffer.from(presented);
  // Constant-time, like everything else that compares a credential in this codebase (auth.ts).
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return undefined;
  return projectId;
}
