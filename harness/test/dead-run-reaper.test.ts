import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  NEVER_STARTED_PREFIX,
  RESTART_INTERRUPTED_PREFIX,
  WENT_SILENT_PREFIX,
  recoverTasks,
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

function fakeStore(
  tasks: { id: string; status: string }[],
  /** Pending approval rows, for the gate cases below. Omitted means the store has none. */
  pending?: { task_id: string; expires_at?: string | null }[],
  onListApprovals?: () => never,
) {
  const failed: { id: string; reason: string }[] = [];
  return {
    failed,
    listUnfinished: async () => tasks,
    listApprovals: async () => {
      if (onListApprovals) onListApprovals();
      return pending ?? [];
    },
    setStatus: async (id: string, _s: string, reason?: string) => {
      failed.push({ id, reason: reason ?? "" });
    },
    eventsAfter: async () => [],
    appendEvent: async () => {},
  } as never;
}

const reaped = (store: unknown) => (store as { failed: { id: string; reason: string }[] }).failed;
const hours = (n: number) => new Date(Date.now() + n * 3_600_000).toISOString();

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


/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * A RUN WAITING ON A PERSON IS NOT A DEAD RUN
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * MEASURED ON THE DEMO TENANT, 14 September: fifteen approvals seeded `pending`, every one now
 * `expired`, every owning task `failed` with "This run went silent while awaiting_approval —
 * nothing has driven it for over ten minutes", all fifteen closed in the same second. So the
 * showroom the landing page embeds reads "Nothing to approve" under the heading for the one promise
 * this product is sold on, and it empties itself again ten minutes after any reseed. In production
 * the same pair reached fourteen approvals that had waited between three and eleven days.
 *
 * It takes two to do it. The reaper fails the task; `reconcileOrphanedApprovals` then finds a
 * pending approval on a terminal task and expires the row. A founder back from lunch finds the card
 * gone and — per `vigil.ts` — "nothing you approve now will resume it".
 *
 * `vigil.ts` already judges this correctly: `awaiting_approval` WITH an open approval row is
 * patient, and only WITHOUT one is it the lost wakeup. The reaper simply was not asking.
 */
test("THE SWEEP LEAVES A RUN THAT IS GENUINELY WAITING ON A HUMAN", async () => {
  const store = fakeStore(
    [{ id: "gate", status: "awaiting_approval" }],
    [{ task_id: "gate", expires_at: hours(20) }],
  );
  const reaper = startDeadRunReaper(store, undefined, 60_000);
  assert.equal(await reaper.tick(), 0, "a founder at lunch had their draft killed under them");
  reaper.stop();
  assert.deepEqual(reaped(store), []);
});

test("an approval past its OWN expiry is still swept", async () => {
  /*
    The bound is the approval's TTL, not silence. A row whose `expires_at` has passed is holding
    nothing, and leaving its task non-terminal for ever would trade one stuck state for another.
  */
  const store = fakeStore(
    [{ id: "gate", status: "awaiting_approval" }],
    [{ task_id: "gate", expires_at: hours(-1) }],
  );
  const reaper = startDeadRunReaper(store, undefined, 60_000);
  assert.equal(await reaper.tick(), 1, "an expired gate keeps its run alive for ever");
  reaper.stop();
  assert.ok(reaped(store)[0]!.reason.startsWith(WENT_SILENT_PREFIX));
});

test("awaiting_approval with NO approval row is the lost wakeup, and is swept", async () => {
  // vigil.ts: "waiting for an approval that no longer exists — it was decided (or lost) and the
  // wake-up never reached the run". Nothing will ever come back to ask, so it must not sit open.
  const store = fakeStore([{ id: "gate", status: "awaiting_approval" }], []);
  const reaper = startDeadRunReaper(store, undefined, 60_000);
  assert.equal(await reaper.tick(), 1, "a run whose approval is gone was left hanging");
  reaper.stop();
});

test("a pending approval on a DIFFERENT task protects nothing", async () => {
  // The set is keyed by task id. Matching on "there exists a pending approval" would have made one
  // open gate anywhere in the installation shield every dead run in it.
  const store = fakeStore(
    [{ id: "dead", status: "awaiting_approval" }],
    [{ task_id: "someone-else", expires_at: hours(20) }],
  );
  const reaper = startDeadRunReaper(store, undefined, 60_000);
  assert.equal(await reaper.tick(), 1, "another tenant's open gate kept a dead run alive");
  reaper.stop();
});

test("a store that cannot answer sweeps exactly as it did before", async () => {
  /*
    Fail OPEN, towards the old behaviour. A blip in one read must not mean a dead run is skipped for
    ever — the sweep is the only thing that closes it, and it runs every two minutes.
  */
  const store = fakeStore([{ id: "gate", status: "awaiting_approval" }], undefined, () => {
    throw new Error("pg blip");
  });
  const reaper = startDeadRunReaper(store, undefined, 60_000);
  assert.equal(await reaper.tick(), 1, "a store blip left a dead run open");
  reaper.stop();
});

test("AT BOOT THE OPPOSITE IS TRUE, AND THE GATE IS STILL CLOSED", async () => {
  /*
    THE ASYMMETRY IS THE WHOLE DESIGN, and getting it backwards would be worse than the bug.

    The waiter, its `byTask` entry and the TTL `setTimeout` all live in the memory of the process
    that ran the task. A restart erases every one of them, so there is nobody left to resume the run
    whatever the row says — approving that card would be a click that does nothing, which is worse
    than a red row telling you to re-run it.

    On the two-minute SWEEP the run is usually alive in a worker the API cannot see, patiently
    suspended, with the orchestrator crediting the wait back against its deadline. Different
    question, different answer, same function.
  */
  const store = fakeStore(
    [{ id: "gate", status: "awaiting_approval" }],
    [{ task_id: "gate", expires_at: hours(20) }],
  );
  const got = await recoverTasks(store, undefined, undefined, "restart");
  assert.equal(got.failed, 1, "a boot left a suspended run open with nothing alive to resume it");
  assert.ok(reaped(store)[0]!.reason.startsWith(RESTART_INTERRUPTED_PREFIX), reaped(store)[0]!.reason);
});

test("the approvals table is not read when nothing is at a gate", async () => {
  // Every two minutes, for a query whose answer cannot matter. The early return is the whole reason
  // this is affordable on that interval.
  let asked = 0;
  const store = fakeStore([{ id: "t1", status: "running" }], [], (() => {
    asked++;
  }) as never);
  const reaper = startDeadRunReaper(store, undefined, 60_000);
  await reaper.tick();
  reaper.stop();
  assert.equal(asked, 0, "the sweep scans pending approvals on every tick regardless");
});
