import { serve } from "@hono/node-server";
import { API_KEY_GENERATED, loadConfig } from "./config";
import { closeAuditStore, initAuditStore } from "./audit";
import { closeAllPools } from "./pool";
import { closeDomainStore, getDomainStore, initDomainStore } from "./domain";
import { getIdentityStore, initIdentityStore } from "./identity";
import { recoverTasks } from "./recovery";
import { closeKnowledgeStore, initKnowledgeStore } from "./knowledge.store";
import { closeSecretStore, initSecretStore } from "./secrets";
import { closePortalStore, initPortalStore } from "./portal";
import { closePartyStore, initPartyStore } from "./party";
import { closeBillingStore, initBillingStore } from "./billing";
import { closeRequestStore, initRequestStore } from "./requests";
import { closeDeliverableStore, initDeliverableStore } from "./deliverables";
import { closeAuthoredStore, initAuthoredStore } from "./authored";
import { seedLibraryFromDisk } from "./skill-library";
import { startScheduler } from "./scheduler";
import { startDeploymentReconciler } from "./deploy";
import { closeQueue, initQueue, startWorker } from "./queue";
import { createServer } from "./server";
import { createStore } from "./store";
import { flushLogs } from "./tracing";
import { sandboxPreflight, sandboxReachability } from "./sandbox";
import { runtimeAdvisories } from "./preflight";
import { KERNEL_VERSION } from "./version";
// Side-effect: registers `chase_invoice` claim release BEFORE crash recovery runs. Without this,
// `recoverTasks` would mark mid-chase kills as failed but leave `last_chased_at` stamped — the
// invoice would vanish from the ranked list until the ladder interval, for work that never ran.
import "./dunning";

const { store, backend } = await createStore();
await initDomainStore(); // durable service surface when MYCEL_DATABASE_URL is set
await initIdentityStore(); // durable tenants (stable default ids either way)
await initSecretStore(); // encrypted-at-rest vault (AES-256-GCM)
await initAuditStore(); // tamper-evident audit chain
// Client portal links and sessions. In-memory they died on every deploy, silently — a customer
// clicked the link in their inbox and was told it was no longer valid.
await initPortalStore();
// Third-party counterparties (candidate / contractor / assessor). Same durability argument as
// portal links: a recruiting CV ask that dies on deploy is a silent week-one failure.
await initPartyStore();
// Accounts receivable. This call did not exist. `initBillingStore()` was reachable from the test
// suite and from nowhere else, so a deployment with MYCEL_DATABASE_URL set still kept every invoice
// in a Map and lost the lot on the next deploy — money, discovered weeks later, with nothing left to
// reconstruct it from. No `catch`, deliberately; see the comment on the function itself.
await initBillingStore();
// What each client is blocked on. Same reasoning, different loss: a client's answer that vanishes
// on deploy leaves the run blocked for ever and leaves the client with no way to know they need to
// send it again.
await initRequestStore();
// The fulfilment loop. Same argument as `initBillingStore` above and the same failure if it is
// skipped: a deliverable a client accepted is the evidence an invoice rests on, and losing it on a
// deploy is losing the proof that the work was signed off.
await initDeliverableStore();
// Distilled rules and the observations that measure them. Durable when a database is configured,
// and it FAILS the boot if that database is unreachable rather than falling back to memory: the
// rows here are the founder's own corrections, and a process that quietly forgets them on every
// deploy makes the same person fix the same mistake twice, which is how they stop bothering.
await initKnowledgeStore();
// Services Mycel wrote for one business, and whether a founder agreed to run them. Durable for the
// same reason as the stores above and with a sharper loss if it is not: an in-memory draft dies on
// the next deploy, so a founder who read the review card and went to fetch a colleague comes back to
// an empty list — and, worse, a PROMOTED service would silently stop being loadable mid-engagement,
// which reads to their clients as the business going quiet.
await initAuthoredStore();
// The curated shared skill library — kernel/service-skills/<domain>/*.md upserted into the library so
// a wedge's domain skills are there to mount from the first run. Idempotent and fail-soft: a bad seed
// file is skipped, and a library that cannot be written must not stop the kernel from serving.
await seedLibraryFromDisk(getDomainStore()).catch((e) => console.error("[mycel] skill library seed failed:", e));
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
// Bring in-flight tenant deploys in line with CodeBuild. Without this, a successful build leaves
// the deployment row on `building` forever and the founder is never shown a URL — see deploy.ts.
const deployReconciler = startDeploymentReconciler(getDomainStore());
console.log(
  `mycel-harness v${KERNEL_VERSION} on http://localhost:${port}  ` +
    `[sandbox=${cfg.sandboxBackend} store=${backend} model=${cfg.model} ` +
    // Surfaced rather than silent: "inline" means this process runs every task it receives, which
    // is correct on a laptop and a scaling ceiling in production.
    `queue=${queue.mode}${worker ? "" : " worker=off"}]` +
    (recovered ? `  recovered ${recovered} interrupted task(s)` : ""),
);
// Say what the first run will actually do, now, instead of sixty seconds into a task that hangs.
//
// THIS CALL DID NOT EXIST. `runtimeAdvisories` was written for exactly this line, documented in the
// README as something "the kernel says at boot", covered by its own comment block — and exported to
// nobody. A stranger-install walkthrough proved the cost: a dev boot printed no advisory at all,
// then the first task sat in `running` for 60s and died with `opencode failed to start (no log)`.
// The information that would have prevented it was computed nowhere and printed nowhere. That is a
// silent failure, which this project does not get to have.
//
// Wired like `sandboxPreflight` above but deliberately NON-fatal — see the header of preflight.ts
// for why a kernel with no agent runtime is still a legitimate thing to run.
const advisories = runtimeAdvisories(cfg);
if (advisories.length) {
  console.log(`\n  ⚠  ${advisories[0]}\n${advisories.slice(1).map((l) => (l ? `     ${l}` : "")).join("\n")}\n`);
}
if (API_KEY_GENERATED) {
  console.log(
    `\n  ⚠  No MYCEL_API_KEY set — generated an ephemeral key for this run:\n` +
      `     ${cfg.apiKey}\n` +
      `     Send it as 'Authorization: Bearer <key>' on /v1 calls (products). Set MYCEL_API_KEY to keep it stable.`,
  );
}
if (identity.generatedPassword) {
  // Memory-only boots. Postgres attach clears this — a generated password is never the login
  // once members loaded from the database, and printing it on ECS was a lie that looked like
  // we rotated founder@mycel.local on every deploy.
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
  deployReconciler.stop();
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
    await closePartyStore();
    await closeBillingStore();
    await closeDeliverableStore();
    await closeRequestStore();
    await closeKnowledgeStore();
    await closeAuthoredStore();
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
