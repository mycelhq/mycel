import { serve } from "@hono/node-server";
import { API_KEY_GENERATED, loadConfig } from "./config";
import { closeAuditStore, initAuditStore } from "./audit";
import { closeAllPools } from "./pool";
import { closeDomainStore, getDomainStore, initDomainStore } from "./domain";
import { getIdentityStore, initIdentityStore } from "./identity";
import { recoverTasks } from "./recovery";
import { closeSecretStore, initSecretStore } from "./secrets";
import { closePortalStore, initPortalStore } from "./portal";
import { startScheduler } from "./scheduler";
import { closeQueue, initQueue, startWorker } from "./queue";
import { createServer } from "./server";
import { createStore } from "./store";
import { flushLogs } from "./tracing";
import { sandboxPreflight, sandboxReachability } from "./sandbox";

const { store, backend } = await createStore();
await initDomainStore(); // durable service surface when MYCEL_DATABASE_URL is set
await initIdentityStore(); // durable tenants (stable default ids either way)
await initSecretStore(); // encrypted-at-rest vault (AES-256-GCM)
await initAuditStore(); // tamper-evident audit chain
// Client portal links and sessions. In-memory they died on every deploy, silently — a customer
// clicked the link in their inbox and was told it was no longer valid.
await initPortalStore();
const identity = getIdentityStore();
const recovered = await recoverTasks(store);
const app = createServer(store);
const cfg = loadConfig();
const port = Number(process.env.PORT ?? 4000);

// Refuse to open the port at all if the sandbox could never call back to it.
//
// BEFORE `serve`, unlike the async preflight below, and that ordering is the whole point: the
// moment this process binds 4000 it starts passing its ECS health check, and a green target that
// fails every task is the failure mode this check exists to remove. The test is a string
// comparison, so nothing is delayed by putting it first. (The SDK and snapshot checks stay after
// the listener because a cold snapshot build takes minutes and would otherwise be killed by the
// container health check before it finished.)
const unreachable = sandboxReachability(cfg.sandboxBackend, cfg.publicUrl);
if (unreachable) {
  console.error(`\n  ✗ ${unreachable}\n    Refusing to start: every task would fail at its first callback.\n`);
  process.exit(1);
}

const server = serve({ fetch: app.fetch, port });
const queue = await initQueue();
// Every API process is a worker too by default, so one container behaves exactly as before.
// MYCEL_WORKER=0 gives an API-only replica; a worker-only container against the same database
// scales execution independently of traffic — which is the point of having a queue at all.
const worker = process.env.MYCEL_WORKER === "0" ? null : await startWorker(store);

// Refuse to serve a backend we cannot actually use.
//
// With MYCEL_SANDBOX=daytona and the SDK missing, this process previously started, reported healthy
// to the load balancer, accepted tasks and failed every one at sandbox creation. The fleet was green
// and the product could do no work whatsoever. Exiting here turns that into a failed deployment,
// which is loud, immediate, and rolls back on its own.
const sandboxProblem = await sandboxPreflight(cfg.sandboxBackend);
if (sandboxProblem) {
  console.error(`\n  ✗ ${sandboxProblem}\n    Refusing to start: every task would fail at sandbox creation.\n`);
  process.exit(1);
}

const scheduler = startScheduler(store, getDomainStore());
console.log(
  `mycel-harness v0.1 on http://localhost:${port}  ` +
    `[sandbox=${cfg.sandboxBackend} store=${backend} model=${cfg.model} ` +
    // Surfaced rather than silent: "inline" means this process runs every task it receives, which
    // is correct on a laptop and a scaling ceiling in production.
    `queue=${queue.mode}${worker ? "" : " worker=off"}]` +
    (recovered ? `  recovered ${recovered} interrupted task(s)` : ""),
);
if (API_KEY_GENERATED) {
  console.log(
    `\n  ⚠  No MYCEL_API_KEY set — generated an ephemeral key for this run:\n` +
      `     ${cfg.apiKey}\n` +
      `     Send it as 'Authorization: Bearer <key>' on /v1 calls (products). Set MYCEL_API_KEY to keep it stable.`,
  );
}
if (identity.generatedPassword) {
  console.log(
    `\n  ⚠  No MYCEL_OWNER_PASSWORD set — generated an owner login for the portal:\n` +
      `     ${identity.ownerEmail}  /  ${identity.generatedPassword}\n` +
      `     Set MYCEL_OWNER_EMAIL / MYCEL_OWNER_PASSWORD to keep it stable.\n`,
  );
}

// Graceful shutdown: stop accepting connections, let in-flight work settle briefly, release the
// store (pg pool), then exit. Prevents dropped connections and leaked pools on deploy/restart.
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[mycel] ${signal} — shutting down…`);
  server.close();
  scheduler.stop();
  // Drain before exiting. graphile-worker stops taking jobs and waits for in-flight ones, which is
  // the difference between a deploy being invisible and a deploy losing a run mid-approval.
  if (worker) await worker.stop();
  await closeQueue();
  try {
    await store.close?.();
    await closeDomainStore();
    await closeSecretStore();
    await closeAuditStore();
    await closePortalStore();
    // Last: every store shares one pool, so this is the single place it is actually ended.
    await closeAllPools();
    // Queued JSONL lines are still in memory (appends are non-blocking by design), so drain them
    // before exiting or the tail of an in-flight run is lost.
    await flushLogs();
  } catch (e) {
    console.error("[mycel] store close error:", e);
  }
  setTimeout(() => process.exit(0), 250).unref?.();
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
