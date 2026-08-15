// Crash recovery. On boot, any non-terminal task in a durable store was interrupted mid-run —
// its sandbox and OpenCode session are gone, so it can't be resumed in place. Mark it failed so
// nothing is stuck forever and any reconnecting SSE stream closes cleanly. In-memory persists
// nothing across restarts, so this is a no-op there.
import { markCancelled } from "./cancel";
import { emitEvent } from "./events";
import { releaseClaimFor } from "./promises";
import type { Store } from "./store";

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
function recoveryReason(status: string): string {
  return status === "queued"
    ? "Never started. This run was still waiting its turn when the kernel restarted, so it was dropped rather than left queued forever. Nothing ran, nothing was sent and nothing was charged — it is safe to run again."
    : `Interrupted by a kernel restart while ${status}. The sandbox it was working in went with it, so the run could not be picked up where it left off.`;
}

export async function recoverTasks(store: Store): Promise<number> {
  const stuck = await store.listUnfinished();
  for (const t of stuck) {
    markCancelled(t.id);
    const reason = recoveryReason(t.status);
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
  }
  return stuck.length;
}
