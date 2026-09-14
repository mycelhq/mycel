// Crash recovery. On boot, any non-terminal task in a durable store was interrupted — nothing is
// driving it, so it must be made terminal or made runnable again before the SSE stream can close.
//
// THREE OUTCOMES, AND THEY ARE NOT THE SAME NEWS. This comment used to say "mark it failed", which
// was true when it was written and has not been for a while:
//
//   · `queued`, never started       → REQUEUED. Nothing was sent and nothing was charged.
//   · `awaiting_batch`, rejoinable  → REJOINED. The fanned-out work is collected, not thrown away.
//   · anything mid-run              → FAILED, with the reason on the row, and its sandbox reaped.
//
// Only the third is a loss, and collapsing all three into one number told an operator that twelve
// runs died when twelve runs had simply gone back in the queue. `recoverTasks` returns the
// breakdown for that reason. In-memory persists nothing across restarts, so this is a no-op there.
import { markCancelled } from "./cancel";
import { emitEvent } from "./events";
import { releaseClaimFor } from "./promises";
import { deleteSandboxById } from "./sandbox";
import type { Store } from "./store";
import type { Task } from "./contract";

/**
 * Why this run ended, in a sentence the founder reading `/work/<id>` can act on.
 *
 * ─── THE PRODUCTION FAILURE THIS EXISTS FOR ───
 *
 * Several `invoice-chaser` chases from the dunning sweep sat in the console as `failed` at `$0.00`,
 * dating back weeks, alongside chases of the SAME task type that succeeded and produced real
 * firm_reminder decisions for $0.0003. Zero cost means the run died before a single token, and the
 * row said nothing at all about why: `setStatus(id, "failed")` was called with no `error`, and both
 * stores deliberately leave that column alone when `error === undefined` (store.pg.ts, store.ts).
 * The reason existed only inside the event log, as the generic phrase "interrupted by a restart" —
 * and the page renders the ROW: `row.error ? { error: row.error } : {}` in work/[id]/page.tsx. So
 * the founder got a red badge and a blank space. That is this repo's recurring bug wearing a
 * different hat: something failing while telling us nothing.
 *
 * HOW A CHASE GETS HERE, which is worth writing down because "a restart" undersells it. The sweep
 * spawns up to 25 chases in one tick against a worker concurrency of 4, each a multi-minute
 * `decide` run, and `listUnfinished` reclaims anything non-terminal untouched for ten minutes —
 * INCLUDING rows still sitting in `queued`. The tail of a batch is therefore reclaimed by the next
 * deploy having never run at all. That is a capacity story, not a crash, and the two must not read
 * identically on screen: one is safe to retry and the other may have already sent an email.
 */
/**
 * The two openers below, as constants, because a second reader now depends on them.
 *
 * `fulfillment-ignite.ts` counts a case's consecutive production failures and retires it after six.
 * A run killed by a deploy is not the case failing — it is us restarting the container — and
 * counting it means six deploys during one month-end silently retire a working engagement. So the
 * ignite counter has to be able to recognise these, and the only honest place to define "these" is
 * next to the function that writes them.
 */
export const NEVER_STARTED_PREFIX = "Never started.";
export const RESTART_INTERRUPTED_PREFIX = "Interrupted by a kernel restart";
/**
 * A run reclaimed by the periodic sweep rather than by a boot.
 *
 * ═══ WHY THE WORDING HAD TO SPLIT, AND IT IS NOT PEDANTRY ═══
 *
 * Measured on 30 days of production: 350 runs ended with "Interrupted by a kernel restart", and for
 * 331 of them the last real work event — a tool call, a step, a charge — was on average **7,043
 * seconds**, near two hours, before the row was touched. A restart did not interrupt those runs.
 * They had been dead for two hours and a restart is simply the only thing that ever looked.
 *
 * So the sentence was telling a founder we broke their work by deploying, when what actually
 * happened is that their work died and nothing noticed until we happened to deploy. Those are
 * different problems with different fixes, and the message pointed at the wrong one.
 */
export const WENT_SILENT_PREFIX = "This run went silent";

/**
 * Was this failure OURS rather than the work going wrong?
 *
 * `fulfillment-ignite.ts` counts a case's consecutive production failures and retires it after six.
 * A run the sweep reclaimed is no more the case's fault than one a deploy killed — in both the work
 * stopped for an infrastructure reason — so the swept prefix has to be recognised here too, or
 * adding the sweep would start silently retiring working engagements.
 */
export function wasInterruptedByRestart(error: string | null | undefined): boolean {
  const e = error ?? "";
  return (
    e.startsWith(NEVER_STARTED_PREFIX) ||
    e.startsWith(RESTART_INTERRUPTED_PREFIX) ||
    e.startsWith(WENT_SILENT_PREFIX)
  );
}

/** What ended the run: this process starting up, or the periodic sweep finding it dead. */
export type RecoveryCause = "restart" | "sweep";

function recoveryReason(status: string, cause: RecoveryCause): string {
  if (status === "queued") {
    return cause === "restart"
      ? `${NEVER_STARTED_PREFIX} This run was still waiting its turn when the kernel restarted, so it was dropped rather than left queued forever. Nothing ran, nothing was sent and nothing was charged — it is safe to run again.`
      : `${NEVER_STARTED_PREFIX} This run sat in the queue with nothing taking it. Nothing ran, nothing was sent and nothing was charged — it is safe to run again.`;
  }
  return cause === "restart"
    ? `${RESTART_INTERRUPTED_PREFIX} while ${status}. The sandbox it was working in went with it, so the run could not be picked up where it left off.`
    : `${WENT_SILENT_PREFIX} while ${status} — nothing has driven it for over ten minutes, so it was closed rather than left open forever. Anything it had already done stands; nothing further was sent or charged.`;
}

/**
 * Could this run be started again by us, without asking a person first?
 *
 * ═══ WHY ONLY `queued`, AND WHY THAT LINE IS NOT NEGOTIABLE ═══
 *
 * A deploy kills in-flight work. `shutdown` drains correctly — `worker.stop()` waits for in-flight
 * graphile jobs — but ECS sends SIGTERM and then SIGKILLs at `stopTimeout`, which Fargate caps at
 * 120 seconds. A `decide` run is 300–600. So the drain cannot finish, and every deploy lands on
 * somebody's engagement.
 *
 * `recoverTasks` already knew the difference and wrote it into the reason string — "Nothing ran,
 * nothing was sent and nothing was charged — it is safe to run again" — and then did not run it
 * again. A founder had to notice a red badge and press a button. That is the gap.
 *
 * A `queued` task was reclaimed having NEVER STARTED: no sandbox, no tokens, no email, no charge.
 * Re-running it is indistinguishable from it having waited slightly longer, which is what it was
 * doing anyway.
 *
 * A `running` task is the opposite and must stay failed. It may have sent a chase, taken a payment,
 * booked a meeting — `assertSendPromiseKept` exists precisely because a run's side effects are not
 * inferable from its status. Auto-retrying one is how a client gets the same invoice reminder twice
 * from a company that is supposed to be handling this for them, and no ceiling anywhere upstream
 * would catch it because the second send looks like a first.
 *
 * So: the safe half is automatic, the unsafe half stays a human's decision. Splitting on the status
 * the store already records costs nothing and needs no new bookkeeping.
 */
export function isSafeToRequeue(status: string): boolean {
  return status === "queued";
}


/**
 * The sandbox this task recorded at acquisition, deleted.
 *
 * Reads the event log rather than a column: `sandbox.acquired` is written before any work runs, so
 * it exists for exactly the runs that got far enough to hold a box. A task that never started has
 * no such event and nothing to clean up — which is the same population `isSafeToRequeue` lets back
 * into the queue, and it must stay cheap for them.
 */
async function reapSandboxFor(store: Store, taskId: string): Promise<void> {
  const events = await store.eventsAfter(taskId, 0).catch(() => []);
  const ids = new Set<string>();
  for (const e of events) {
    if (e.type !== "sandbox.acquired") continue;
    const id = (e.data as { sandbox_id?: unknown } | undefined)?.sandbox_id;
    if (typeof id === "string" && id.trim()) ids.add(id.trim());
  }
  // Every one, not just the last. A run that was resumed after a batch acquires a fresh box each
  // round, and the rounds before the last are exactly the ones nothing else will ever name.
  for (const id of ids) {
    const gone = await deleteSandboxById(id).catch(() => false);
    if (gone) console.log(`[mycel] released sandbox ${id} held by interrupted task ${taskId}`);
  }
}

/**
 * ═══ A PARKED PARENT IS NOT A RUNNING ONE ═══
 *
 * `isSafeToRequeue` splits the world in two — `queued` never started, everything else may have sent
 * an email or taken a payment — and that split is right for every status it was written about. It
 * was not written about `awaiting_batch`, which is neither.
 *
 * A task in `awaiting_batch` has FANNED OUT: it spawned children and parked itself, and the join
 * advances it when they finish. It is doing nothing. Its own side effects, if any, happened before
 * it parked, so re-parking it repeats none of them — the argument that keeps `running` failed does
 * not reach it.
 *
 * What happened instead: a deploy killed the parked parent, recovery marked it `failed`, and
 * `onChildFinished` only advances a parent whose status is still `awaiting_batch`. So every child's
 * completed work was orphaned — the fan-out ran, the results existed, and nothing could ever
 * collect them. Two of six `weekly_report` failures in three weeks were this, and `weekly_report`
 * is the only job in the product that produces a real client deliverable.
 *
 * ═══ AND WHY IT STILL FAILS SOMETIMES ═══
 *
 * Leaving it parked unconditionally would be worse than the bug. Nothing sweeps `awaiting_batch`:
 * `reconcileStarvedTasks` filters on `isSafeToRequeue` too, so a parent whose children all finished
 * during the outage would sit parked for ever with no trigger left. That is the trap this codebase
 * keeps naming — a halt with no way back — and it already cost two hours once (batches.ts).
 *
 * So `rejoin` re-attempts the join at boot and answers one question: will anything ever advance this
 * parent? True means it advanced now, or a child is still pending and will trigger it later. False
 * means every child is terminal and the join still did not fire, so nothing ever will — and it
 * falls through to the failed path exactly as before. Fail-closed, no new stall.
 *
 * Injected rather than imported for the reason `onChildFinished` gives about `resume`: it keeps the
 * batch store out of this module, and lets a test exercise recovery without one.
 */
/** What a recovery pass actually did. `total` is every task it touched. */
export interface Recovered {
  /** Went back in the queue: they had not started, so nothing was sent and nothing was charged. */
  requeued: number;
  /** Batch parents whose fanned-out work was collected rather than discarded. */
  rejoined: number;
  /** Died mid-run. The only one of the three that is a loss. */
  failed: number;
  total: number;
}

/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * A RUN WAITING ON A PERSON IS NOT A DEAD RUN, AND WE WERE KILLING IT AFTER TEN MINUTES
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `listUnfinished()` means "non-terminal and untouched for ten minutes", and `awaiting_approval` is
 * non-terminal. A founder who raises a draft at 12:40 and comes back from lunch at 13:20 has a run
 * that was silent for forty minutes for the best possible reason: it is doing exactly what the
 * product promises and waiting for them.
 *
 * MEASURED ON THE DEMO TENANT, 14 September. Fifteen approvals seeded as `pending`, every one of
 * them now `expired`, every owning task `failed` with "This run went silent while awaiting_approval
 * — nothing has driven it for over ten minutes", all fifteen closed in the same second. The
 * showroom — the tenant the landing page embeds — shows "Nothing to approve" under the heading for
 * the one promise this product is sold on, and it empties itself again within ten minutes of any
 * reseed. In production the same pair reached fourteen approvals that had waited between three and
 * eleven days.
 *
 * The pair is what does it: the reaper fails the task, then `reconcileOrphanedApprovals` sees a
 * pending approval on a terminal task and expires the row. `vigil.ts` already judges this case
 * correctly — `awaiting_approval` WITH an open approval row is "patient", and only without one is
 * it the lost wakeup — and the reaper was not asking.
 *
 * ═══ WHY ONLY ON THE SWEEP ═══
 *
 * At BOOT the opposite is true and the old behaviour is right: the waiter and its timer live in the
 * process's memory (`waiters`, `byTask`, the TTL `setTimeout`), so a restart leaves nobody to
 * resume the run whatever the row says. Approving it then would be a click that does nothing, which
 * is worse than a red row that says re-run it.
 *
 * On the two-minute sweep the run is usually alive in a worker the API cannot see, patiently
 * suspended, with `orchestrator.ts` crediting the suspended time back against its deadline. Its
 * bound is the approval's own TTL — which is what `expires_at` is for and what this honours.
 *
 * A store that cannot answer returns everything, so a blip can only ever make this sweep behave as
 * it did before rather than skip a genuinely dead run for ever.
 */
async function withoutPatientGates(store: Store, tasks: Task[]): Promise<Task[]> {
  const gated = tasks.filter((t) => t.status === "awaiting_approval");
  if (!gated.length) return tasks;
  let pending: { task_id: string; expires_at?: string | null }[];
  try {
    pending = await store.listApprovals("pending");
  } catch (e) {
    console.error("[mycel] could not read pending approvals; sweeping as before:", e);
    return tasks;
  }
  const now = Date.now();
  const patient = new Set(
    pending
      // An approval past its own expiry is not holding anything: the TTL is the bound, and a row
      // whose bound has passed is exactly the case the sweep should still close.
      .filter((a) => {
        const until = a.expires_at ? Date.parse(a.expires_at) : NaN;
        return Number.isNaN(until) || until > now;
      })
      .map((a) => a.task_id),
  );
  return tasks.filter((t) => !(t.status === "awaiting_approval" && patient.has(t.id)));
}

export async function recoverTasks(
  store: Store,
  requeue?: (taskId: string) => Promise<void>,
  rejoin?: (parent: Task) => Promise<boolean>,
  cause: RecoveryCause = "restart",
): Promise<Recovered> {
  const counts = { requeued: 0, rejoined: 0, failed: 0 };
  const all = await store.listUnfinished();
  const stuck = cause === "sweep" ? await withoutPatientGates(store, all) : all;
  for (const t of stuck) {
    if (rejoin && t.status === "awaiting_batch") {
      try {
        if (await rejoin(t)) {
          await emitEvent(store, t.id, "progress", {
            note:
              (cause === "restart"
                ? "A kernel restart interrupted this run while it was waiting on the work it had fanned out. "
                : "This run went quiet while waiting on the work it had fanned out. ") +
              "It had already handed that work off, so nothing was re-sent and nothing was re-charged — " +
              "the results were collected instead of being thrown away.",
          });
          counts.rejoined += 1;
          continue;
        }
      } catch (e) {
        // Fall through and fail it. A rejoin that cannot happen must not leave the row
        // non-terminal, for the same reason the requeue path says so.
        console.error(`[mycel] could not rejoin batch parent ${t.id} after restart:`, e);
      }
    }
    if (requeue && isSafeToRequeue(t.status)) {
      /**
       * Put it back rather than burying it.
       *
       * NOT marked failed first: `enqueueTask` uses the task id as `jobKey`, so the row stays
       * `queued` and the job is idempotent — two kernel replicas booting from the same deploy both
       * call this and produce one job, not two. Marking it failed and then re-queueing would also
       * leave a permanent red row for a run that went on to succeed, which teaches a founder to
       * ignore red.
       */
      try {
        await requeue(t.id);
        await emitEvent(store, t.id, "progress", {
          note:
            cause === "restart"
              ? "Requeued after a kernel restart. This run had not started — nothing was sent and nothing was charged — so it went back in the queue rather than being dropped."
              : "Requeued after sitting in the queue with nothing taking it. This run had not started — nothing was sent and nothing was charged.",
        });
        counts.requeued += 1;
        continue;
      } catch (e) {
        // Fall through to the failed path. A requeue that cannot happen must not leave the row
        // non-terminal, or it is stuck for ever and the SSE stream never closes.
        console.error(`[mycel] could not requeue ${t.id} after restart:`, e);
      }
    }
    markCancelled(t.id);
    /**
     * ═══ AND DELETE THE BOX THIS RUN WAS HOLDING ═══
     *
     * `recoveryReason` has always said the truthful thing — "The sandbox it was working in went
     * with it" — and that was only half true. The RUN went with it. The sandbox did not: it stayed
     * `started`, with nothing driving it, until its idle timer fired and Daytona's auto-delete
     * finally caught it.
     *
     * Measured over fourteen days: 396 runs interrupted by a kernel restart, 870 sandbox-hours of
     * 10 GiB boxes doing nothing. The single largest line in a Daytona bill whose disk share is
     * 80%. `reapStoppedSandboxes` cannot help — it refuses to touch a `started` box, correctly,
     * because from outside a slow run looks exactly the same. Only the kernel that created this one
     * knows it is dead, and now it wrote the id down.
     *
     * Best effort and never blocking. A delete that fails leaves exactly the leak we had before,
     * and the idle timer plus `autoDeleteInterval: 0` still catch it. What must not happen is a
     * provider call keeping a task non-terminal.
     */
    await reapSandboxFor(store, t.id).catch(() => {});
    const reason = recoveryReason(t.status, cause);
    // THE REASON GOES ON THE ROW, not only into the event log. See `recoveryReason`.
    await store.setStatus(t.id, "failed", reason);
    /**
     * GIVE BACK WHAT THE KILLED RUN WAS HOLDING.
     *
     * `runTask`'s catch path calls `releaseClaimFor` before `task.finished`. A SIGKILL never
     * reaches that catch — the process is gone — so without this, a chase that died mid-sandbox
     * would leave `last_chased_at` stamped and the unpaid invoice off the ranked list until the
     * ladder interval elapsed. graphile-worker will not auto-retry (`maxAttempts: 1`), which is
     * what prevents a duplicate email; releasing the claim is what makes a founder-initiated
     * retry possible without waiting out the pace window for work that never ran.
     */
    const returned = await releaseClaimFor(t);
    if (returned) await emitEvent(store, t.id, "progress", { note: returned });
    await emitEvent(store, t.id, "task.finished", { status: "failed", error: reason });
    counts.failed += 1;
  }
  // `total` is derived, never counted separately — a second counter is a second thing to get wrong.
  return { ...counts, total: stuck.length };
}

/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * A DEAD RUN SHOULD NOT WAIT FOR A DEPLOY TO BE NOTICED
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `recoverTasks` runs at BOOT and is the only thing in this kernel that terminates a dead `running`
 * task. `sweepStarvedTasks` runs every two minutes and deliberately touches only `queued` rows,
 * because it must never turn a founder's work red to report our own outage.
 *
 * Between them is a hole exactly the size of a run that started and then died — a lost sandbox, a
 * killed worker, a provider that stopped answering. Nothing terminates it. It sits `running` until
 * the next deploy.
 *
 * MEASURED, on 30 days of production: of 350 runs eventually reclaimed, 331 had done no real work
 * for an average of 7,043 seconds — near two hours — before anything touched the row. That is two
 * hours in which the founder sees a live spinner on work that is dead, the sandbox keeps billing,
 * and any claim the run took (`last_chased_at`, and its kind) stays held so nothing re-proposes the
 * job. The run's own retry disappears with it, which is the second half of the failure `promises.ts`
 * was written for.
 *
 * ── WHY THIS IS SAFE, AND WHY IT IS THE SAME FUNCTION ──
 *
 * `listUnfinished()` already filters to rows untouched for `STALE_TASK_MS`, so this can only ever
 * see runs that have been silent for ten minutes. Every cost/status write during a healthy run
 * touches `updated_at`, so a live run is never a candidate. Calling `recoverTasks` on a timer is
 * therefore not a new policy — it is the existing policy, asked more than once a deploy.
 *
 * Reusing the function rather than writing a second reclaim is the point: `releaseClaimFor`,
 * `reapSandboxFor`, `markCancelled` and the terminal event all have to happen, and a second
 * implementation is how one of them gets forgotten.
 */
export const DEAD_RUN_SWEEP_MS = 2 * 60 * 1000;

export function startDeadRunReaper(
  store: Store,
  requeue?: (taskId: string) => Promise<void>,
  intervalMs = DEAD_RUN_SWEEP_MS,
): { stop(): void; tick(): Promise<number> } {
  const tick = async (): Promise<number> => {
    try {
      // `rejoin` is deliberately NOT passed. Rejoining a fanned-out batch parent needs the live
      // in-process batch registry, which only the booting kernel has; from a timer there is nothing
      // to rejoin to, and offering a rejoin that always fails would just log noise every two minutes.
      const got = await recoverTasks(store, requeue, undefined, "sweep");
      if (got.total > 0) {
        // LOUD, for the same reason the starvation sweep is: this is our fault, not the founder's,
        // and a sweep that quietly repairs the symptom hides whatever is killing runs.
        //
        // Broken out, because only `failed` is a dead run. A queued row that nothing picked up in
        // ten minutes is a capacity story and goes back in the queue — reporting the two as one
        // number is what made a busy afternoon read like an outage.
        console.error(
          `[mycel] DEAD RUNS: ${got.failed} run(s) silent for over ten minutes were closed` +
            (got.requeued ? `; ${got.requeued} that had never started went back in the queue` : "") +
            ".",
        );
      }
      return got.total;
    } catch (e) {
      // Never throws. A store blip must not take down the interval that is the only thing watching.
      console.error("[mycel] dead-run sweep failed:", e);
      return 0;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  // `unref` so this never holds the process open — the same courtesy every other interval here does.
  timer.unref?.();
  return { stop: () => clearInterval(timer), tick };
}
