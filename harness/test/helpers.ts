// Shared test helpers. Tests run in-process against a fresh InMemoryStore with MYCEL_RUNTIME=mock,
// so tasks finish instantly with no OpenCode. Node's test runner isolates each file in its own
// process, so the identity/domain singletons are fresh per file.
// `randomUUID` was used by `freshProjectId` below without ever being imported — the helper had no
// caller, so nothing had run it. It throws on first use, which would have looked like a bug in
// whichever test reached for it first.
import { randomUUID } from "node:crypto";
import { createServer } from "../src/server";
import { InMemoryStore } from "../src/store";

export const KEY = process.env.MYCEL_API_KEY || "testkey";

export function makeApp() {
  const store = new InMemoryStore();
  return { store, app: createServer(store) };
}

type Res = { status: number; json: any; text: string };

export async function api(app: ReturnType<typeof createServer>, path: string, opts: RequestInit = {}, key: string = KEY): Promise<Res> {
  const res = await app.request(`/v1/${path}`, {
    ...opts,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...(opts.headers || {}) },
  });
  const text = await res.text();
  let json: any;
  try { json = JSON.parse(text); } catch { /* non-json */ }
  return { status: res.status, json, text };
}

const TERMINAL = new Set(["succeeded", "failed", "rejected", "expired", "cancelled"]);

export async function waitTask(app: ReturnType<typeof createServer>, id: string, timeoutMs = 4000, key: string = KEY) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { json } = await api(app, `tasks/${id}`, {}, key);
    if (json && TERMINAL.has(json.status)) return json;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(`task ${id} did not finish within ${timeoutMs}ms`);
}

/**
 * A fresh tenant id for a test that writes to an append-only or globally-listed store.
 *
 * The audit log, the approvals list and the task list are all global reads. Against the in-memory
 * store each test file gets a clean process, so absolute counts pass; against a real Postgres they
 * accumulate across runs and the same assertion fails the second time. That has now cost three
 * debugging detours, so: scope by a unique id, or filter by something the test created. Never assert
 * a count over a shared collection.
 */
export function freshProjectId(prefix = "t"): string {
  return `${prefix}-${randomUUID()}`;
}
