// Shared test helpers. Tests run in-process against a fresh InMemoryStore with MYCEL_RUNTIME=mock,
// so tasks finish instantly with no OpenCode. Node's test runner isolates each file in its own
// process, so the identity/domain singletons are fresh per file.
// `randomUUID` was used by `freshProjectId` below without ever being imported — the helper had no
// caller, so nothing had run it. It throws on first use, which would have looked like a bug in
// whichever test reached for it first.
import { randomUUID } from "node:crypto";
import { createServer } from "../src/server";
import { getDomainStore, initDomainStore } from "../src/domain";
import { initSecretStore } from "../src/secrets";
import { InMemoryStore } from "../src/store";

export const KEY = process.env.MYCEL_API_KEY || "testkey";

export function makeApp() {
  const store = new InMemoryStore();
  return { store, app: createServer(store) };
}

/**
 * A server with its own DOMAIN and its own VAULT, not merely its own event store.
 *
 * `makeApp` gives each call a fresh `InMemoryStore`, but the domain store and the secret vault are
 * process-wide singletons (see the comment on `getDomainStore`) — deliberately, because the server,
 * the orchestrator and the action proxy all have to be looking at the same one. The consequence is
 * that isolation is per FILE, not per test: two tests in the same file share every connection row
 * and every sealed secret ever written.
 *
 * That is usually harmless and occasionally a lie. A connect flow, for instance, reuses an existing
 * connection for the same (project, toolkit, owner) and recalls the credentials the founder pasted
 * last time — correct product behaviour, and exactly the thing that makes a later test in the same
 * file "pass" on state its own setup never created. Reach for this whenever a test asserts on what
 * is or isn't already stored.
 *
 * Async because swapping the backend is: both initialisers pick Postgres when MYCEL_DATABASE_URL is
 * set, which is what keeps the same tests honest against a real database.
 */
export async function makeFreshApp(): Promise<ReturnType<typeof makeApp>> {
  await initDomainStore();
  await initSecretStore();
  return makeApp();
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

/**
 * Give a project a mailbox it can actually send from.
 *
 * ─── WHY EVERY CHASE TEST NEEDS THIS NOW ───
 *
 * `startChase` refuses with `cannot_send` before it claims the invoice when nothing in the project
 * can send email. That gate exists because of the production run this repo's promises.ts documents:
 * a business with ZERO connection rows had chases spawned against it, and each one drafted a
 * message the agent was never even told it could send, reported success, and burned the invoice's
 * ladder claim on the way past.
 *
 * A test that chases without a mailbox is therefore testing a configuration that no longer chases.
 * `kind: "email"` is the generic provider-over-HTTP connection (contract.ts), founder-owned, which
 * is what `selectGrantableConnections` grants a chase run — the same resolution the run itself does.
 */
export async function connectMailbox(projectId: string, name = "billing-mailbox") {
  // IDEMPOTENT, AND THAT IS LOAD-BEARING. `send_email` is a cardinality-one capability, so a second
  // mailbox in the same project makes `resolveCapability` AMBIGUOUS — it grants nothing rather than
  // guessing, because handing an agent two mailboxes and no rule for which to use is how a client
  // gets the same chase twice. A helper that created one per call would therefore turn every chase
  // test into a `cannot_send` refusal, and look exactly like the bug it was written for.
  const existing = (await getDomainStore().listConnections()).find(
    (c) => c.project_id === projectId && c.kind === "agentmail" && c.owner?.kind === "founder",
  );
  if (existing) return existing;
  return getDomainStore().createConnection({
    project_id: projectId,
    // `agentmail`, not the generic `email` kind, and that is not arbitrary. `send_email` in
    // capabilities.ts lists gmail, outlook and agentmail as its providers; a `kind: "email"` row —
    // a directly configured transactional sender — satisfies NONE of them, so `capabilityConnections`
    // resolves it to nothing and a chase run is handed no mailbox at all. A helper built on that kind
    // would seed a business that still cannot send, and every test using it would fail for the very
    // reason the tests are about. (That gap is real, not a test artifact: a business whose only
    // mailbox is a `kind: "email"` row cannot chase today. Worth closing in capabilities.ts, which
    // is not this change's file.)
    kind: "agentmail",
    name,
    owner: { kind: "founder", id: "founder" },
    config: { address: "billing@test.co" },
  });
}
