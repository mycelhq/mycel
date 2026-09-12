import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  NEVER_STARTED_PREFIX,
  RESTART_INTERRUPTED_PREFIX,
  WENT_SILENT_PREFIX,
  startDeadRunReaper,
  wasInterruptedByRestart,
} from "../src/recovery";

/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * A DEAD RUN WAITED AN AVERAGE OF TWO HOURS FOR SOMEBODY TO DEPLOY
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Two sweeps, and a hole between them exactly the size of the failure that matters.
 *
 *   `recoverTasks`        terminates dead runs. Runs at BOOT, once.
 *   `sweepStarvedTasks`   runs every two minutes. Touches only `queued`, deliberately — it must
 *                         never turn a founder's work red to report our own outage.
 *
 * A run that STARTED and then died — lost sandbox, killed worker, provider that stopped answering —
 * matched neither and sat `running` until the next deploy.
 *
 * Measured on 30 days of production: of 350 runs eventually reclaimed, 331 had emitted no real work
 * event (tool call, step, charge) for an average of **7,043 seconds**. Two hours of a live spinner
 * over dead work, a sandbox still billing, and a held claim keeping the job off the ranked list.
 */

function fakeStore(tasks: { id: string; status: string }[]) {
  const failed: { id: string; reason: string }[] = [];
  return {
    failed,
    listUnfinished: async () => tasks,
    setStatus: async (id: string, _s: string, reason?: string) => {
      failed.push({ id, reason: reason ?? "" });
    },
    eventsAfter: async () => [],
    appendEvent: async () => {},
  } as never;
}

test("the reaper closes a run that has gone silent, without waiting for a deploy", async () => {
  const store = fakeStore([{ id: "t1", status: "running" }]);
  const reaper = startDeadRunReaper(store, undefined, 60_000);
  const n = await reaper.tick();
  reaper.stop();

  assert.equal(n, 1);
  const [row] = (store as unknown as { failed: { id: string; reason: string }[] }).failed;
  assert.equal(row?.id, "t1");
  assert.ok(row!.reason.startsWith(WENT_SILENT_PREFIX), `wrong reason: ${row!.reason}`);
});

test("the sweep does not claim a restart interrupted anything", () => {
  /*
    THE MESSAGE WAS BLAMING THE WRONG THING, and it is not pedantry.

    331 runs ended with "Interrupted by a kernel restart" having last done real work two hours
    earlier. A restart did not interrupt them; they were dead, and a restart was the only thing that
    ever looked. That sentence tells a founder we broke their work by deploying, when what happened
    is their work died and nothing noticed — different problems, different fixes, and the message
    pointed at the wrong one.
  */
  const store = fakeStore([{ id: "t1", status: "running" }]);
  return startDeadRunReaper(store, undefined, 60_000)
    .tick()
    .then(() => {
      const [row] = (store as unknown as { failed: { id: string; reason: string }[] }).failed;
      assert.doesNotMatch(row!.reason, /restart/i, "the sweep still blames a kernel restart");
    });
});

test("a swept run is still OUR fault, so it cannot retire an engagement", () => {
  /*
    `fulfillment-ignite.ts` retires a case after six consecutive production failures, and uses
    `wasInterruptedByRestart` to exclude the ones that are infrastructure rather than the work. A run
    the sweep closed is exactly as much our fault as one a deploy killed — so if the new prefix were
    not recognised here, ADDING THE SWEEP WOULD START RETIRING WORKING ENGAGEMENTS. The sweep runs
    every two minutes; six is not far away.
  */
  assert.equal(wasInterruptedByRestart(`${WENT_SILENT_PREFIX} while running — nothing has driven it`), true);
  assert.equal(wasInterruptedByRestart(`${RESTART_INTERRUPTED_PREFIX} while running.`), true);
  assert.equal(wasInterruptedByRestart(`${NEVER_STARTED_PREFIX} This run sat in the queue`), true);
  // And a real failure is still a real failure.
  assert.equal(wasInterruptedByRestart("the client's mailbox rejected the message"), false);
  assert.equal(wasInterruptedByRestart(null), false);
});

test("the reaper is actually started, and stopped", () => {
  // An interval that is never created is the dominant bug class in this repo — `expireEnvelopes` was
  // written, tested and called by nothing. A reaper nobody starts leaves the two-hour hole exactly
  // where it was, with a test suite that says otherwise.
  const boot = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[^\n]*?\/\/[^\n]*$/gm, "");
  assert.match(boot, /startDeadRunReaper\(/, "nothing starts the dead-run reaper");
  assert.match(boot, /deadRunReaper\.stop\(\)/, "the reaper is never stopped on shutdown");
});

test("a store blip does not kill the interval that is the only thing watching", async () => {
  const store = { listUnfinished: async () => { throw new Error("pg down"); } } as never;
  const reaper = startDeadRunReaper(store, undefined, 60_000);
  assert.equal(await reaper.tick(), 0, "the sweep threw instead of reporting nothing");
  reaper.stop();
});
