import "./sentry";
import { serve } from "@hono/node-server";
import { captureKernelException, flushSentry } from "./sentry";
import { API_KEY_GENERATED, databaseUrl, loadConfig } from "./config";
import { closeAuditStore, initAuditStore } from "./audit";
import { closeAllPools } from "./pool";
import { closeDomainStore, getDomainStore, initDomainStore } from "./domain";
import { getIdentityStore, initIdentityStore } from "./identity";
import { recoverTasks, startDeadRunReaper } from "./recovery";
import { TERMINAL_STATUSES } from "./approvals";
import { startApprovalReconciler } from "./approvals";
import { closeKnowledgeStore, initKnowledgeStore } from "./knowledge.store";
import { closeSecretStore, initSecretStore } from "./secrets";
import { closePortalStore, initPortalStore } from "./portal";
import { closeSigningStore, initSigningStore, startEnvelopeExpirySweep } from "./signing";
import { closePartyStore, initPartyStore } from "./party";
import { closeBillingStore, initBillingStore } from "./billing";
import { closeRequestStore, initRequestStore } from "./requests";
import { closeDeliverableStore, initDeliverableStore } from "./deliverables";
import { closePagesStore, initPagesStore } from "./pages";
import { initBatchStore, getBatchStore, onChildFinished } from "./batches";
import { initReleasePolicySchema } from "./release-policy.pg";
import { getPool } from "./pool";
import { closeAuthoredStore, initAuthoredStore } from "./authored";
import { seedLibraryFromDisk } from "./skill-library";
import { startScheduler } from "./scheduler";
import { startDeploymentReconciler } from "./deploy";
import { startStarvationSweep } from "./starvation";
import { installLinkedInMock, linkedInMockEnabled } from "./linkedin/mock";
import { closeQueue, enqueueTask, initQueue, startWorker } from "./queue";
import { createServer } from "./server";
import { createStore } from "./store";
import { flushLogs } from "./tracing";
import { reapStoppedSandboxes, sandboxPreflight, sandboxReachability } from "./sandbox";
import { verifySnapshot } from "./sandbox.snapshot";
import { runtimeAdvisories } from "./preflight";
import { KERNEL_VERSION } from "./version";
// Side-effect: registers `chase_invoice` claim release BEFORE crash recovery runs. Without this,
// `recoverTasks` would mark mid-chase kills as failed but leave `last_chased_at` stamped — the
// invoice would vanish from the ranked list until the ladder interval, for work that never ran.
import "./dunning";
import { reportShowroomConfig } from "./showroom";
import { reportSchemaDrift } from "./db/verify";
import { existsSync } from "node:fs";
import { libraryGapReport, libraryGaps } from "./library";

const { store, backend } = await createStore();
await initDomainStore(); // durable service surface when MYCEL_DATABASE_URL is set
await initIdentityStore(); // durable tenants (stable default ids either way)
/**
 * Does the database actually look like the schema we declare?
 *
 * AFTER the stores have initialised, because every one of them runs its own `CREATE TABLE IF NOT
 * EXISTS` / `ADD COLUMN IF NOT EXISTS` block on connect — checking before that would report every
 * column of a fresh database as missing, which is the one reading guaranteed to be wrong.
 *
 * Awaited rather than floated. It is one query, it runs before the server listens, and a floated
 * promise here would interleave its output with request logs and be attributed to whatever happened
 * to be in flight. It logs only a discrepancy and it cannot throw — see `reportSchemaDrift`.
 */
await reportSchemaDrift();
/**
 * Immediately after the orgs load, because this can only be checked once they exist.
 *
 * `MYCEL_SHOWROOM_ORG_IDS` named an org that had never existed, so the showroom guard returned
 * false for everything while every call site and every test behaved correctly — and the demo tenant
 * ran 5,094 tasks, failed 1,169, and ate the Daytona disk that real customer runs then failed on.
 * A guard that protects nothing is indistinguishable from one that works unless something checks
 * the resource it claims to protect. This is that check.
 */
reportShowroomConfig(getIdentityStore().listOrgs().map((o) => o.id));
/**
 * Immediately after the orgs are loaded, because this can only be checked once they exist.
 *
 * `MYCEL_SHOWROOM_ORG_IDS` named an org that had never existed, so the showroom guard returned
 * false for everything while every call site and every test behaved correctly — and the demo tenant
 * ran 5,094 tasks, failed 1,169, and ate the Daytona disk that real customer runs then failed on.
 * A guard that protects nothing is indistinguishable from one that works, unless something checks
 * the resource it claims to protect. This is that check.
 */

await initSecretStore(); // encrypted-at-rest vault (AES-256-GCM)
await initAuditStore(); // tamper-evident audit chain
// Client portal links and sessions. In-memory they died on every deploy, silently — a customer
// clicked the link in their inbox and was told it was no longer valid.
await initPortalStore();
await initSigningStore();
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
// Unlisted live pages (`GET /p/:token`). Same durability argument as portal links: a URL a client
// already opened that 404s on the next deploy is fulfillment that evaporated.
await initPagesStore();
// Fan-out state. Durable for a reason the stores above do not have: losing one of these does not
// lose a record, it PARKS A RUN FOR EVER. The children keep succeeding, the parent stays
// `awaiting_batch`, and nothing anywhere says why — the only invisible failure in this list.
await initBatchStore();
// One column on `deliverables` recording whether a piece of work reached the client without a human
// looking. It is the whole safety mechanism behind selective auto-release: changes requested on
// reviewed work is ordinary service business, changes requested on work we CHOSE not to review is
// the system telling us the threshold was wrong, and nothing else in the schema can tell them apart.
/**
 * Gated on `databaseUrl()`, not on `process.env.DATABASE_URL`.
 *
 * That variable is set for the console and the landing app; `infra/services.tf` gives this process
 * `MYCEL_DATABASE_URL`. So the condition was FALSE on every production boot and the migration below
 * never ran — which the comment inside it goes on to describe as the exact failure it was written
 * to prevent ("a migration that fails into a log line is a feature that quietly does not exist").
 * It did not fail into a log line. It never attempted.
 *
 * The column exists in production regardless, from an older boot or another path, so this is a
 * latent fault rather than a live one: the first fresh database would have been the one to find out.
 */
const releasePolicyUrl = databaseUrl();
if (releasePolicyUrl) {
  await initReleasePolicySchema(getPool(releasePolicyUrl)).catch((e) => {
    /**
     * ═══ A MIGRATION THAT FAILS INTO A LOG LINE IS A FEATURE THAT QUIETLY DOES NOT EXIST ═══
     *
     * This was `.catch(console.error)`, and it cost exactly what that costs. The ALTER did not apply
     * on some boot, nothing but a log line said so, and `auto_released` was missing from the
     * deliverables table from then on. Every `readRecord` threw, `mayAutoRelease` therefore saw an
     * empty record on every decision, and auto-release — a whole shipped feature — could not be
     * earned by anybody. Sentry counted the 500s; nobody connected them to a boot weeks earlier.
     *
     * It stays NON-FATAL, which is the 2026-08-29 lesson and still right: a kernel that will not
     * boot because one optional index is missing takes the API down with it. What changes is that
     * the failure now reaches the place failures are actually read. A log line on a container that
     * restarts is not a report.
     */
    console.error("[mycel] release-policy schema failed — auto-release will not work:", e);
    captureKernelException(e, { where: "initReleasePolicySchema", impact: "auto-release disabled" });
  });
}
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
/**
 * RECOVERY RUNS AFTER `initQueue`, further down, not here.
 *
 * It used to run here, and it had to move: a task reclaimed in `queued` never started, so the right
 * answer is to put it back in the queue — and `enqueueTask` needs a queue to put it in. Called
 * before `initQueue`, every requeue would throw and fall through to the failed path, which is
 * exactly the behaviour being fixed, arriving silently.
 *
 * Nothing between here and there depends on stuck rows being terminal.
 */
let recovered = 0;
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

/*
  ═══ THE RUNTIME LIBRARY, CHECKED WHERE IT IS EXPECTED ═══

  Six directories have gone missing in production, one at a time, and every one was found by somebody
  eventually running the built image and looking. This is that look, done by the process that knows
  where it expects things to be — see `library.ts` for why it warns rather than refusing.

  Placed beside the sandbox check and before the listener, so the line is in the log above "listening"
  rather than buried under a minute of request noise.
*/
const gaps = libraryGaps((p) => existsSync(p));
if (gaps.length) console.error(libraryGapReport(gaps));

const server = serve({ fetch: app.fetch, port });
const queue = await initQueue();
// Every API process is a worker too by default, so one container behaves exactly as before.
// MYCEL_WORKER=0 gives an API-only replica; a worker-only container against the same database
// scales execution independently of traffic — which is the point of having a queue at all.
const worker = process.env.MYCEL_WORKER === "0" ? null : await startWorker(store);

/**
 * Pick up what the last deploy interrupted — and put the never-started ones back to work.
 *
 * A deploy DOES kill in-flight client work: `shutdown` drains properly, but ECS SIGKILLs at
 * `stopTimeout`, capped at 120s on Fargate, and a `decide` run is 300–600s. Recovery is therefore
 * not an edge case, it is what happens on every single deploy.
 *
 * Runs that had not started go back in the queue (idempotent — `jobKey` is the task id, so two
 * replicas booting together produce one job). Runs that were mid-flight stay failed with a reason
 * on the row, because their side effects are not knowable from here and re-sending a client's
 * invoice chase is worse than making a founder press a button.
 */
recovered = await recoverTasks(
  store,
  (taskId) => enqueueTask(store, taskId),
  /**
   * A parent that was PARKED waiting on its fan-out, re-joined instead of buried.
   *
   * Drives the join through `onChildFinished` — the same path a child finishing normally takes —
   * rather than reimplementing the parent-advancing logic here. That logic is subtle (it has
   * already produced one two-hour stall) and a second copy of it would be the place the next bug
   * lives.
   *
   * Returns whether anything will ever advance this parent. Advanced now, or a child still pending
   * that will trigger the join later, both count. Everything else is false and recovery fails the
   * row exactly as it did before — see the header on `recoverTasks`.
   */
  async (parent) => {
    if (!parent.batch_id) return false;
    const batch = await getBatchStore().getBatch(parent.batch_id);
    if (!batch) return false;

    const children = (await Promise.all(batch.child_task_ids.map((id) => store.getTask(id)))).filter(
      (c): c is NonNullable<typeof c> => !!c,
    );
    const pending = children.filter((c) => !TERMINAL_STATUSES.includes(c.status));

    // Any already-finished child is enough to re-drive the join; it re-reads every sibling itself.
    const finished = children.find((c) => TERMINAL_STATUSES.includes(c.status));
    if (finished) await onChildFinished(store, finished, (id) => enqueueTask(store, id));

    const after = await store.getTask(parent.id);
    if (after && after.status !== "awaiting_batch") return true;
    return pending.length > 0;
  },
);

// Refuse to serve a backend we cannot actually use.
//
// THE PREFLIGHT THAT USED TO BE HERE TOOK PRODUCTION DOWN, and it is worth saying why rather than
// only deleting it.
//
// There were TWO `sandboxPreflight` calls after `serve`, with OPPOSITE policies. This one exited on
// any problem. The one below (`if (!isApiOnly)`) logs the same problem, keeps serving, and exits
// only behind `MYCEL_EXIT_ON_PREFLIGHT_FAILURE=1` — with the reasoning written out: "Keeping kernel
// active so HTTP, health checks, DNS, and GTM sequencer continue running", "so an external Daytona
// blip cannot take down the entire kernel fleet and campaigns."
//
// Both were true and only the first one ran. On 2026-08-29 a Daytona snapshot entered `error` state,
// the rebuild raced its own delete and came back "already exists for this organization", this line
// exited, ECS restarted the task, and it did that every eighty seconds. The kernel serves the API as
// well as the worker, so `app.mycelai.dev` got `ECONNREFUSED 10.0.0.13:4000` on every request and
// the product was down — for a provider-side snapshot state that stops no HTTP request at all.
//
// The original argument is still right and still lives below: a green target that fails every task
// is worse than a red one. What was wrong is the DEFAULT. A missing SDK is a deployment error that
// should roll back; a provider's snapshot in a bad state is an outage in something else, and taking
// our own API down for it converts somebody else's degradation into our own total failure.
//
// One preflight, one policy. Suna's `prompt-dedupe.ts` names the general form after being bitten by
// it: "Keep this as the ONE list" — two predicates answering one question means adding to one
// silently opts out of the other.
const scheduler = startScheduler(store, getDomainStore());
// Bring in-flight tenant deploys in line with CodeBuild. Without this, a successful build leaves
// the deployment row on `building` forever and the founder is never shown a URL — see deploy.ts.
const deployReconciler = startDeploymentReconciler(getDomainStore());
/**
 * The steady-state watchdog: a worker that quietly stopped consuming while the health check stayed
 * green. `recoverTasks` above covers the deploy case and is boot-only by construction; nothing
 * covered the case where the process stays up and the queue stops draining, which is the one a
 * founder experiences as "queued" for hours with nothing anywhere saying why.
 *
 * starvation.ts has been written, documented and tested since it landed, and was never started —
 * so the mechanism for catching a silent failure was itself silently absent. Same `enqueueTask` the
 * boot recovery uses, so the re-queue is idempotent and every replica may sweep.
 */
const starvationSweep = startStarvationSweep(store, (taskId) => enqueueTask(store, taskId));

/**
 * And the hole the two sweeps left between them.
 *
 * `recoverTasks` above runs once, at boot, and is the only thing that terminates a dead `running`
 * task. `startStarvationSweep` runs every two minutes and touches only `queued` rows, deliberately.
 * A run that STARTED and then died — lost sandbox, killed worker, provider that stopped answering —
 * matched neither, and sat `running` until the next deploy.
 *
 * Measured on 30 days of production: 331 of 350 reclaimed runs had done no real work for an average
 * of 7,043 seconds before anything touched the row. Two hours of a live spinner on dead work, a
 * sandbox still billing, and a held claim keeping the job off the ranked list. See
 * `startDeadRunReaper`.
 */
const deadRunReaper = startDeadRunReaper(store, (taskId) => enqueueTask(store, taskId));

/**
 * The same omission, in the same shape, one file over: `expireEnvelopes` was written and tested
 * with signing and called by nothing, so an agreement past its date kept the status `sent` for
 * ever. Nobody could sign one — `assertOpen` checks the clock — but the dashboard went on asking
 * the founder to chase it, and the audit chain never recorded an ending.
 */
const envelopeSweep = startEnvelopeExpirySweep();

/**
 * And the same omission again, one file over from that one: seventeen approvals sat `pending` on
 * tasks that had already failed, the oldest for sixty-eight days. `failWaitersForTask` was written
 * for exactly this and can only reach waiters held in memory — which a restart has already erased,
 * and a restart is precisely how they got orphaned. See `reconcileOrphanedApprovals`.
 *
 * Ticked once at boot before the interval takes over, because boot is the event that causes it.
 */
const approvalReconciler = startApprovalReconciler(store);
void approvalReconciler.tick();
// Product-eval only: a hermetic LinkedIn so the GTM journeys can connect/invite/message offline.
// Flag is set exclusively by the eval stack (scripts/e2e-ephemeral.sh); never in prod.
if (linkedInMockEnabled()) {
  installLinkedInMock();
  console.log("[mycel] MYCEL_LINKEDIN_MOCK=1 — LinkedIn transport is mocked (eval only)");
}

// Sandbox preflight: warm and verify sandbox backend.
// In API-only mode (MYCEL_WORKER=0) sandboxes are never created, so skip preflight.
// In worker/combined mode, preflight warms the snapshot. If preflight reports an issue, log
// loudly so it is surfaced immediately, but keep the HTTP listener, DNS service discovery,
// health checks, and GTM sequencer alive so an external Daytona blip cannot take down the
// entire kernel fleet and campaigns.
const isApiOnly = process.env.MYCEL_WORKER === "0";
if (!isApiOnly) {
  const sandboxProblem = await sandboxPreflight(cfg.sandboxBackend);
  if (sandboxProblem) {
    console.error(
      `\n  ⚠  ${sandboxProblem}\n` +
        `     Sandbox preflight warning: agent tasks requiring a sandbox will fail until this is resolved.\n` +
        `     Keeping kernel active so HTTP, health checks, DNS, and GTM sequencer continue running.\n`,
    );
    if (process.env.MYCEL_EXIT_ON_PREFLIGHT_FAILURE === "1") {
      process.exit(1);
    }
  }
}

/**
 * ═══ AND KEEP ASKING ═══
 *
 * The preflight above runs ONCE, and `ensureSnapshot` memoises its success for the life of the
 * process. That is the right cost decision and it is how the 2026-08-29 outage stayed invisible: the
 * snapshot entered `error` state hours after a boot that had verified it, the memo kept answering
 * "fine", every task failed at sandbox creation, and the health check stayed green because HTTP was
 * never affected. Nothing in the system was asking.
 *
 * `kortix-ai/suna` names this class in `projects/reaping/parked-runtime-verification.ts` — nothing
 * re-verified a parked sandbox, so a dead one was advertised as resumable until "a human opened the
 * session 30 hours later", and 16,243 rows had never been re-checked. Their sweep runs both
 * directions; so does `verifySnapshot`.
 *
 * NON-FATAL, deliberately, and for the reason written at length above this block: a provider's
 * snapshot in a bad state is an outage in something else, and exiting on it is how a Daytona blip
 * became our own eighty-second crash loop. This logs, repairs what it can, and keeps serving.
 *
 * Twenty minutes. Long enough to be free against a provider API, short enough that a bad snapshot is
 * a blip in the task log rather than a morning.
 */
const SNAPSHOT_RECHECK_MS = 20 * 60 * 1000;
if (!isApiOnly && cfg.sandboxBackend === "daytona" && process.env.MYCEL_SNAPSHOT_RECHECK !== "0") {
  const recheck = setInterval(async () => {
    try {
      const health = await verifySnapshot();
      if (health.ok && health.rebuilt) {
        // Loud on purpose: the fleet just repaired itself, and the window before it did is a window
        // of failed tasks somebody will be asking about.
        console.error(
          `\n  ⚠  sandbox snapshot ${health.name} was in state "${health.state}" and has been rebuilt.\n` +
            `     Agent tasks that started in the meantime will have failed at sandbox creation.\n`,
        );
      } else if (!health.ok && !("inconclusive" in health)) {
        console.error(
          `\n  ⚠  sandbox snapshot ${health.name} is in state "${health.state}" and could not be rebuilt: ${health.detail}\n` +
            `     Agent tasks requiring a sandbox will fail until this is resolved.\n`,
        );
      }
      /**
       * The other thing nothing was sweeping between deploys.
       *
       * `reapStoppedSandboxes` ran once from the boot preflight, so a leak in the run path had until
       * the next deploy — potentially a week — to accumulate. See the header on that function for
       * what the same gap cost Suna: every create in the org failing on a disk quota until a human
       * archived 1300 boxes by hand.
       *
       * After the snapshot check on purpose. If the snapshot is being rebuilt, the provider is
       * already doing expensive work and a fleet-wide sweep can wait twenty minutes.
       *
       * It DELETES now. It archived until 2026-09-05, which is a state change and frees nothing —
       * the account it was guarding had 508 archived boxes and zero stopped ones. Every sweep
       * logged a healthy number and moved no bytes.
       */
      await reapStoppedSandboxes().catch((e) =>
        console.error(`[mycel] stopped-sandbox sweep failed: ${(e as Error)?.message}`),
      );
      // `inconclusive` is deliberately silent. It means the provider did not answer, which is not
      // news about the snapshot, and logging it every twenty minutes during a provider wobble would
      // train everyone to ignore this line.
    } catch (e) {
      console.error(`[mycel] snapshot recheck failed: ${(e as Error)?.message}`);
    }
  }, SNAPSHOT_RECHECK_MS);
  // Never hold the process open for a health check.
  recheck.unref?.();
}
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
  starvationSweep.stop();
  deadRunReaper.stop();
  envelopeSweep.stop();
  approvalReconciler.stop();
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
    await closeSigningStore();
    await closePartyStore();
    await closeBillingStore();
    await closeDeliverableStore();
    await closePagesStore();
    await closeRequestStore();
    await closeKnowledgeStore();
    await closeAuthoredStore();
    // Last: every store shares one pool, so this is the single place it is actually ended.
    await closeAllPools();
    // Queued JSONL lines are still in memory (appends are non-blocking by design), so drain them
    // before exiting or the tail of an in-flight run is lost.
    await flushLogs();
    await flushSentry();
  } catch (e) {
    console.error("[mycel] store close error:", e);
  }
  setTimeout(() => process.exit(0), 250).unref?.();
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
// These used to die in CloudWatch, or nowhere. The HTTP onError in server.ts covers route
// throws; this covers ticks, the scheduler, and anything that escaped a catch.
process.on("uncaughtException", (err) => {
  console.error("[mycel] uncaughtException", err);
  captureKernelException(err);
  void flushSentry().finally(() => process.exit(1));
});
process.on("unhandledRejection", (reason) => {
  console.error("[mycel] unhandledRejection", reason);
  captureKernelException(reason);
});
