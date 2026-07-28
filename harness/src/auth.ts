// Auth for the public /v1 surface. One founder API key (Bearer), required on every public
// endpoint. Constant-time comparison so a timing side-channel can't recover the key.
//
// Topology note: in the recommended setup the browser never holds this key — the product's
// server-side proxy routes present it, and add their own per-end-user auth/tenancy on top. The
// kernel is single-tenant-per-key; per-tenant scoping is the product's job. (Task-scoped tokens
// for direct-to-browser setups are a future addition.)
import { timingSafeEqual } from "node:crypto";
import type { Context, Next } from "hono";
import { loadConfig } from "./config";

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

/** Hono middleware: require the founder API key on the public API. */
export async function requireApiKey(c: Context, next: Next): Promise<Response | void> {
  const presented = bearer(c);
  if (!presented || !safeEqual(presented, loadConfig().apiKey)) {
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
}
