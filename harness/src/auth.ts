// Auth for the public /v1 surface. Two accepted credentials, both as `Authorization: Bearer`:
//   - a product API key (machine, server-to-server) → resolves to a Project
//   - a member session token (human, from the portal login) → resolves to an Org member
// Constant-time comparison so a timing side-channel can't recover a secret.
//
// Topology note: in the recommended setup the browser never holds a product key — the product's
// proxy presents it; the portal presents the member's session token. The kernel is the trust root.
import { timingSafeEqual } from "node:crypto";
import type { Context, Next } from "hono";
import { type AuthScope, getIdentityStore } from "./identity";

declare module "hono" {
  interface ContextVariableMap {
    scope: AuthScope;
  }
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function bearer(c: Context): string {
  const h = c.req.header("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m?.[1]?.trim() ?? c.req.header("x-mycel-api-key") ?? "";
}

/** Resolve a presented credential to an auth scope (project key or member session), or null. */
export function resolveAuth(token: string): AuthScope | null {
  if (!token) return null;
  const id = getIdentityStore();
  // Member tokens are prefixed, so we don't waste a lookup — but either resolver is safe.
  if (token.startsWith("msess_")) return id.resolveSession(token) ?? null;
  return id.resolveApiKey(token) ?? id.resolveSession(token) ?? null;
}

/** Hono middleware: require a valid product key or member session on the public API. */
export async function requireApiKey(c: Context, next: Next): Promise<Response | void> {
  const scope = resolveAuth(bearer(c));
  if (!scope) return c.json({ error: "unauthorized" }, 401);
  c.set("scope", scope);
  await next();
}
