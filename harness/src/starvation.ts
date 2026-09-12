// A QUEUE THAT STOPPED DRAINING WHILE THE PROCESS STAYED UP.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// THE GAP THIS FILLS, AND THE THREE THINGS THAT ALREADY COVER MOST OF IT
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// Three mechanisms already stand between a founder and a job that never runs, and none of them is
// this one:
//
//   · `enqueueTask` falls back to running INLINE when the queue is unavailable, so a kernel with no
//     database queue does the work rather than losing it;
//   · `recoverTasks` re-queues never-started runs at BOOT, which is what makes a deploy survivable —
//     and it is boot-only by construction, because it FAILS every unfinished run it cannot safely
//     re-queue. Running that on a timer would kill every live run in the fleet;
//   · `sandboxPreflight` refuses to start at all on a backend that cannot work, after a deployment
//     "started, reported healthy to the load balancer, accepted tasks and failed every one at
//     sandbox creation. The fleet was green and the product could do no work whatsoever."
//
// What none of them covers is STEADY STATE: the process is up, the health check is green, and the
// worker has quietly stopped taking jobs. `recoverTasks` will not run again until the next deploy,
// so the founder watches "queued" for hours and nothing anywhere says why.
//
// Suna hit exactly this and wrote the backstop for it in
// `session-lifecycle/undelivered-prompts.ts`:
//
//     "A command still `queued` TEN MINUTES past its available_at means that drain is starved —
//      leader dead, scheduler disabled, or the tick wedged — and every prompt behind it (trigger
//      fires, approval resumes) is sitting undelivered while its session shows 'queued — agent
//      picking up' forever. This pass executes those stale rows through the SAME claim/retry/
//      dead-letter machinery the drain uses ... and ships a real error so a dead scheduler pages
//      instead of silently eating prompts."
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// WHAT THIS SWEEP MAY AND MAY NOT TOUCH
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// ONLY `queued`. That is the one status where nothing has happened — `isSafeToRequeue` is the same
// predicate `recoverTasks` uses and for the same reason: a run in any later status may have already
// sent an email or moved money, and re-queueing it would do that twice.
//
// It NEVER FAILS A ROW. Every other sweep in this codebase can mark something failed; this one
// cannot, because a starved queue is an operational fault and the founder's job is fine. Turning
// their work red to report our own outage is the wrong direction, and it is what the boot recovery
// deliberately avoids too ("leave a permanent red row for a run that went on to succeed ... teaches
// a founder to ignore red").
//
// A task WAITING FOR A PROVISIONING RETRY is untouched, and that is structural rather than lucky:
// `provisioning.ts` re-enqueues while the row sits at status `provisioning`, which this sweep does
// not look at. The relation is asserted in the test rather than left to two files agreeing by hand —
// the pattern their `undelivered-prompts.ts` uses when it derives its own window from the dedupe
// TTL instead of hardcoding a second copy of it.
import { emitEvent } from "./events";
import { isSafeToRequeue } from "./recovery";
import type { Store } from "./store";

/**
 * How long a `queued` row waits before it is evidence of a starved queue rather than of a busy one.
 *
 * `enqueueTask` normally hands a job straight to a worker that polls every two seconds, so a row
 * still queued after ten minutes is not slow — nothing is taking it. Ten also matches the default
 * `STALE_TASK_MS` the boot recovery already uses, so the two agree about what "stale" means.
 */
export const STARVED_AFTER_MS = Number(process.env.MYCEL_STARVED_AFTER_MS ?? 10 * 60 * 1000);

/** How often to look. Cheap: one indexed query that returns nothing in steady state. */
export const STARVATION_SWEEP_MS = 2 * 60 * 1000;

/** Bounded, so a genuinely wedged fleet cannot turn one sweep into a thundering herd. */
export const STARVATION_BATCH = 25;

export interface StarvationOutcome {
  /** Rows found starved. Zero in steady state, which is the normal answer. */
  found: number;
  /** Rows put back. Less than `found` only when a re-queue itself failed. */
  requeued: number;
}

/**
 * One pass.
 *
 * Pure of scheduling so a test can drive it directly, and so the caller owns the cadence — the same
 * split `reconcileUndeliveredPrompts` uses.
 */
export async function reconcileStarvedTasks(
  store: Store,
  requeue: (taskId: string) => Promise<void>,
  now = Date.now(),
): Promise<StarvationOutcome> {
  const stale = await store.listUnfinished(STARVED_AFTER_MS).catch((e) => {
    // A sweep that cannot read is not evidence of anything. "We could not check" is not "nothing is
    // wrong", and it is certainly not "everything is starved" — see the note on positive evidence.
    console.error("[mycel] starvation sweep could not read tasks:", e);
    return [] as Awaited<ReturnType<Store["listUnfinished"]>>;
  });

  const starved = stale.filter((t) => isSafeToRequeue(t.status)).slice(0, STARVATION_BATCH);
  if (!starved.length) return { found: 0, requeued: 0 };

  /**
   * LOUD, because this is our fault and not the founder's.
   *
   * Suna's phrasing is the standard to hold to: ship a real error "so a dead scheduler pages instead
   * of silently eating prompts". A sweep that quietly repairs the symptom every two minutes would
   * hide a worker that has been dead for a week.
   */
  console.error(
    `[mycel] STARVED QUEUE: ${starved.length} task(s) queued for more than ${Math.round(STARVED_AFTER_MS / 60_000)} ` +
      `minutes with nothing taking them. The worker may have stopped consuming. Re-queueing; ` +
      `ids: ${starved.map((t) => t.id).slice(0, 5).join(", ")}${starved.length > 5 ? " …" : ""}`,
  );

  let requeued = 0;
  for (const t of starved) {
    try {
      await requeue(t.id);
      requeued += 1;
      await emitEvent(store, t.id, "progress", {
        note:
          "This job sat in the queue with nothing picking it up, so it was put back. Nothing had " +
          "started — nothing was sent and nothing was charged.",
      });
    } catch (e) {
      // Never fail the row. A re-queue that cannot happen is still our problem, not a reason to turn
      // a founder's work red.
      console.error(`[mycel] could not re-queue starved task ${t.id}:`, e);
    }
  }
  void now;
  return { found: starved.length, requeued };
}

/**
 * The cadence. `reconcileStarvedTasks` stayed pure of scheduling so a test could drive it — and
 * then nothing owned the cadence, so the sweep never ran once outside its own tests.
 *
 * That is the failure this file exists to catch, wearing this file's own clothes. A backstop for a
 * silently-stalled queue that is itself silently never started is worse than not having written it:
 * the header argues at length that steady-state starvation is uncovered, and a reader would take
 * the file's presence as evidence it is covered.
 *
 * SAFE ON EVERY REPLICA, deliberately un-elected. `enqueueTask` keys the job by task id, so N
 * replicas sweeping the same starved row produce one queue entry — the same idempotence that lets
 * boot recovery re-queue without coordination. Electing a leader here would add a failure mode
 * (the elected sweeper dies and nothing sweeps) to guard against a duplicate that cannot happen.
 *
 * A tick that throws is swallowed. This is the mechanism that runs WHEN other things are broken;
 * an unhandled rejection out of the watchdog would take down the process it is watching, which is
 * the one outcome worse than a starved queue.
 */
export function startStarvationSweep(
  store: Store,
  requeue: (taskId: string) => Promise<void>,
  intervalMs = STARVATION_SWEEP_MS,
): { stop(): void; tick(): Promise<StarvationOutcome> } {
  let running = false;
  async function tick(): Promise<StarvationOutcome> {
    // Overlap guard, matching the scheduler and the deploy reconciler. A sweep slower than its own
    // interval must not stack, or a wedged database turns a watchdog into the load that keeps it wedged.
    if (running) return { found: 0, requeued: 0 };
    running = true;
    try {
      return await reconcileStarvedTasks(store, requeue);
    } catch (e) {
      console.error("[mycel] starvation sweep tick error:", e);
      return { found: 0, requeued: 0 };
    } finally {
      running = false;
    }
  }

  const timer = setInterval(() => void tick(), intervalMs);
  (timer as { unref?: () => void }).unref?.();
  /**
   * No boot tick, unlike the scheduler and the deploy reconciler.
   *
   * `recoverTasks` runs at boot and already re-queues everything safe, so a sweep seconds later
   * would find the same rows mid-flight and log STARVED QUEUE about a queue that is draining
   * normally. The first honest measurement is one interval in.
   */
  return {
    stop() {
      clearInterval(timer);
    },
    tick,
  };
}
