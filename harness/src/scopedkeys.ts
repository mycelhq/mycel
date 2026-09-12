// Derived per-project credentials — one derivation, several purposes.
//
// ═══ WHAT THIS IS FOR ═══
//
// Some things the kernel deploys are PUBLIC-FACING and run code we generated: the tenant Lambda
// serving a founder's marketing site and client portal. Such a runtime needs to ask the kernel one
// or two narrow questions, and it must not be handed a credential that can answer any others.
//
// `MYCEL_API_KEY` is the operator's product key: it can start tasks, read every client in every
// project, mint sessions and change the plan. It exists so the CLOUD CONSOLE and the WORKER can
// talk to the kernel. Putting it in a per-tenant Lambda would mean one dependency compromise, one
// SSRF, one leaked environment listing — in a runtime whose contents were written by a model — hands
// over the whole estate.
//
// `MYCEL_HOST_TOKEN` is better and still not right for that path. It is a SHARED SECRET that
// resolves ANY host, which is fine for the one trusted multi-tenant ECS app it was written for
// (infra/apps.tf) and wrong for a runtime that exists once per tenant: leaking one tenant's Lambda
// environment would leak a token that reads every other tenant's branding.
//
// So a public-facing runtime gets a key that carries its own scope in its signature. The project id
// comes OUT of the credential; there is no request field that can name a different one.
//
// ═══ WHY ONE MODULE AND NOT TWO ═══
//
// `insight/keys.ts` invented this shape first, for analytics ingest. This file is that code, moved,
// with the label made a parameter — because the alternative is two hand-written HMAC verifiers, and
// two hand-written verifiers of anything is how one of them ends up comparing with `===`.
//
// The prefix and label are BOTH in the signed material, so a key minted for one purpose does not
// verify for another even under the same secret. That property is the reason a label exists at all:
// without it, an ingest key — which is deliberately cheap to obtain, being pasted into hosting
// dashboards — would also be a valid branding key, and the "entire authority is append events"
// promise in insight/keys.ts would quietly have become false.
//
// ═══ THE TRADE, STATED ═══
//
// Derived keys cannot be revoked individually, only by rotating the secret. Acceptable for
// credentials that append to, or read the PUBLIC face of, a project the holder already serves. It
// would not be acceptable for anything that can read a client, an invoice or a message.
import { createHmac, timingSafeEqual } from "node:crypto";
import { loadConfig } from "./config";

/** 128 bits of tag. Guessing is not a strategy; short enough to paste into an env var. */
const TAG_LENGTH = 32;

/**
 * The signing secret.
 *
 * `MYCEL_INSIGHT_SECRET` when set — the one knob that revokes every derived key at once. Otherwise
 * the product API key, which any real deployment already keeps stable across restarts (config.ts
 * generates an ephemeral one only in development, where a key that dies with the process is the
 * correct behaviour anyway).
 *
 * Kept under its original name rather than renamed to something more general, because renaming it
 * would silently invalidate every ingest key already sitting in a founder's hosting dashboard.
 */
function secret(): string {
  return process.env.MYCEL_INSIGHT_SECRET || loadConfig().apiKey;
}

function tag(label: string, projectId: string): string {
  return createHmac("sha256", secret()).update(`${label}:${projectId}`).digest("hex").slice(0, TAG_LENGTH);
}

/** Mint a key. Deterministic: minting twice returns the same key, so there is nothing to store. */
export function mintProjectKey(prefix: string, label: string, projectId: string): string {
  return `${prefix}${Buffer.from(projectId, "utf8").toString("base64url")}_${tag(label, projectId)}`;
}

/**
 * Which project does this key authorise — and only this project.
 *
 * Returns undefined for anything that does not verify. Note what is NOT here: no lookup of a project
 * id supplied by the caller, no fallback to a default project, no "if the tag is missing treat it as
 * the org's only project". Every one of those is how a scoping bug gets written, and this codebase
 * has already shipped several of them. The project id comes out of the signature or the request is
 * refused.
 */
export function projectForKey(prefix: string, label: string, key: string | undefined | null): string | undefined {
  if (!key || typeof key !== "string" || !key.startsWith(prefix)) return undefined;
  const body = key.slice(prefix.length);
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
  // caller smuggle a path or a query fragment through into a record key or a URL.
  if (!projectId || !/^[A-Za-z0-9._:-]{1,80}$/.test(projectId)) return undefined;
  const expected = Buffer.from(tag(label, projectId));
  const got = Buffer.from(presented);
  // Constant-time, like everything else in this codebase that compares a credential (auth.ts).
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return undefined;
  return projectId;
}

// ── the branding credential ──────────────────────────────────────────────────────────────────────
//
// ═══ THE BUG THIS FIXES, STATED PLAINLY ═══
//
// `hostLookup` in business-template/lib/kernel.ts read `MYCEL_API_KEY`. Nothing ever set it on the
// tenant Lambda: `deploy.ts` did not mint one and `infra/buildspec.tenant.yml` did not write one
// into the function's environment. So in production `hostLookup` returned null on every request,
// `businessBrand()` fell back to `SOLO_BRAND`, and every hosted tenant rendered `BUSINESS_NAME` /
// `BUSINESS_ACCENT` — which `deploy.ts` also never set, so in practice the literal string "Your
// business" and the default green. A founder's BrandKit, which the kernel computes and serves on
// this exact route, was reaching only development and self-hosted installs.
//
// The fix could have been one line — put `MYCEL_API_KEY` in the buildspec — and that line is exactly
// what `infra/portal.tf` refused to allow, correctly: "open this only once branding has a credential
// of its own that is scoped to one project." This is that credential.
//
// ═══ WHAT ITS AUTHORITY IS, EXACTLY ═══
//
// Turn a hostname into the PUBLIC face of ONE project: display name, accent, support email, logo
// reference. That is all of it. It cannot read a client, an invoice, a message or a task; it cannot
// write anything; and the project it resolves is fixed by its own signature, so a tenant Lambda
// holding one cannot ask about a hostname belonging to somebody else — the route compares the
// host's project against the key's and 404s on a mismatch. The blast radius of leaking one is the
// branding of the site it was already serving, which is public by construction.

/** Prefix. Distinct from `mik_` so a key is identifiable on sight in a log or a hosting console. */
export const BRAND_KEY_PREFIX = "mbk_";
/** Signed into the tag, so an ingest key can never verify as a branding key. */
const BRAND_LABEL = "brand:v1";

export function brandKeyFor(projectId: string): string {
  return mintProjectKey(BRAND_KEY_PREFIX, BRAND_LABEL, projectId);
}

export function projectForBrandKey(key: string | undefined | null): string | undefined {
  return projectForKey(BRAND_KEY_PREFIX, BRAND_LABEL, key);
}
