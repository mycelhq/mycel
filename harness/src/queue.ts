// The task queue.
//
// What this replaces: `POST /v1/tasks` used to call `runTask()` fire-and-forget in the process that
// served the request. Fine on a laptop, wrong everywhere else —
//
//   · No backpressure. A hundred simultaneous requests started a hundred concurrent runs, each
//     holding a sandbox, on whichever box the load balancer picked.
//   · A deploy killed in-flight work. The only record a task was running was a promise nobody held.
//   · Replicas did not share load. The instance that received the POST did the job, so work followed
//     the load balancer rather than capacity — which is why "add a replica" didn't help.
//
// Now the API enqueues and returns; a worker claims and runs. Postgres is the queue, via
// graphile-worker: `LISTEN/NOTIFY` so a job starts in milliseconds rather than on a poll interval,
// and `FOR UPDATE SKIP LOCKED` so N workers pull from one queue with no double-execution. The same
// primitive the scheduler already proved, and no Redis — one datastore, one connection pool.
//
// Deliberately degrades: with no `MYCEL_DATABASE_URL` there is no queue to put anything in, so we
// run inline exactly as before. That keeps `npm run dev` and the whole test suite working with zero
// setup, and means the queue is something you get by configuring Postgres rather than something you
// must configure to get started.
import { runTask } from "./orchestrator";
import type { Store } from "./store";

const TASK = "mycel:run";

type WorkerUtils = { addJob: (name: string, payload: unknown, opts?: unknown) => Promise<unknown>; release: () => Promise<void> };
type Runner = { stop: () => Promise<void> };

let utils: WorkerUtils | null = null;
let runner: Runner | null = null;
let queueReady = false;

const connectionString = () => process.env.MYCEL_DATABASE_URL;

/**
 * How many runs one worker executes at once — the real backpressure knob.
 *
 * Each run holds a sandbox and mostly waits on a model, so this is bounded by sandbox memory rather
 * than CPU. 10 is a starting point for a 1GB task; raise it with the container.
 */
const CONCURRENCY = Number(process.env.MYCEL_WORKER_CONCURRENCY ?? 10);

/** True when work is being distributed rather than run wherever it arrived. */
export function queueEnabled(): boolean {
  return queueReady;
}

/**
 * Prepare the queue. Safe to call when no database is configured — it simply reports that inline
 * execution is in force, which the boot banner surfaces so nobody is surprised in production.
 */
export async function initQueue(): Promise<{ mode: "queue" | "inline" }> {
  const cs = connectionString();
  if (!cs) return { mode: "inline" };
  const { makeWorkerUtils } = await import("graphile-worker");
  // Creates its own `graphile_worker` schema in the same database — one datastore, not two.
  utils = (await makeWorkerUtils({ connectionString: cs })) as unknown as WorkerUtils;
  queueReady = true;
  return { mode: "queue" };
}

/**
 * Hand a task to a worker.
 *
 * `jobKey` is the task id, so a retried HTTP request or a duplicated webhook can't enqueue the same
 * run twice — the queue dedupes before a sandbox is ever provisioned, which is the expensive part.
 */
export async function enqueueTask(store: Store, taskId: string): Promise<void> {
  if (utils && queueReady) {
    await utils.addJob(TASK, { taskId }, { jobKey: taskId, maxAttempts: 1 });
    return;
  }
  // Inline fallback. Fire-and-forget on purpose: the caller is an HTTP handler that must return
  // immediately, exactly as it did before there was a queue.
  void runTask(store, taskId).catch((err) => console.error("[mycel] runTask error:", err));
}

/**
 * Start consuming.
 *
 * `maxAttempts: 1` on enqueue, so a failed run is not retried automatically. That's deliberate: a
 * task that reached the human approval gate and failed afterwards may have already sent an email or
 * moved money, and silently re-running it would do that twice. Retries belong to the founder, who
 * can see what happened.
 */
export async function startWorker(store: Store): Promise<{ stop: () => Promise<void> } | null> {
  const cs = connectionString();
  if (!cs || !queueReady) return null;

  const { run } = await import("graphile-worker");
  runner = (await run({
    connectionString: cs,
    concurrency: CONCURRENCY,
    // Belt and braces: NOTIFY drives normal latency, and this catches anything a dropped
    // notification would otherwise strand until the next restart.
    pollInterval: 2000,
    taskList: {
      [TASK]: async (payload: unknown) => {
        const { taskId } = payload as { taskId: string };
        await runTask(store, taskId);
      },
    },
  })) as unknown as Runner;
  return {
    async stop() {
      // Graceful: graphile-worker stops accepting jobs and waits for in-flight ones. That's what
      // makes a deploy invisible instead of losing a customer's run mid-approval.
      await runner?.stop();
      runner = null;
    },
  };
}

export async function closeQueue(): Promise<void> {
  await runner?.stop().catch(() => {});
  await utils?.release().catch(() => {});
  runner = null;
  utils = null;
  queueReady = false;
}
