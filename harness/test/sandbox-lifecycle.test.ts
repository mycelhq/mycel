// A SANDBOX NOBODY DELETES IS A SANDBOX THAT LIVES FOREVER.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// THE OUTAGE THIS EXISTS TO PREVENT
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// 2026-09-05, nine days before launch. Production was failing 361 of 470 tasks in 24 hours.
//
// `DaytonaSandbox.destroy()` deletes the sandbox and the orchestrator calls it, so on the happy path
// nothing leaks. It was the only path that ever deleted anything. A deploy replacing the container
// mid-run, the stall watchdog killing a silent agent, a 504 on the call being awaited — each one
// orphans a sandbox `destroy()` never reaches.
//
// Daytona's default `autoDeleteInterval` is DISABLED and its default `autoArchiveInterval` is seven
// days, so an orphan was archived and then kept. An archived sandbox still counts against the
// organisation's disk quota. At 10 GiB each, one sandbox every five minutes around the clock, the
// account was holding 100+ sandboxes claiming over 1,000 GiB against a 300 GiB limit.
//
// Then it feeds itself: `Total disk limit exceeded` fails the creation of new sandboxes, the control
// plane 504s under the retry pressure, snapshot builds cannot allocate — and every one of those
// failures orphans another sandbox. The three top failure reasons in the database were the same
// cascade wearing different hats.
//
// The fix is that the lifecycle no longer depends on this process surviving. What follows guards the
// one number that could quietly turn the backstop into a killer of real work.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SANDBOX_LIFECYCLE } from "../src/sandbox";
import { snapshotName, SNAPSHOT_PREFIX } from "../src/sandbox.snapshot";
import { loadConfig } from "../src/config";

/**
 * Comments are stripped before matching. Every assertion below is about what the code DOES, and the
 * prose above `reapStoppedSandboxes` describes the bug in its own words — it says "archive" and
 * "stopped" repeatedly. Matching raw source would read the explanation as the implementation.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[^\n]*?\/\/[^\n]*$/gm, "");
}

test("a stopped sandbox is deleted by the provider, not by us", () => {
  // 0 means "delete immediately upon stopping". Negative or absent means never, which is the
  // default and was the leak. This is the assertion the outage is about.
  assert.equal(
    SANDBOX_LIFECYCLE.autoDeleteInterval,
    0,
    "autoDeleteInterval must be 0 — anything else leaves cleanup depending on our process surviving the run",
  );
});

test("the wall-clock backstop cannot fire on a legal run", () => {
  // `ttlMinutes` destroys the sandbox even if it is stopped, paused or archived — the one state
  // auto-delete cannot reach. That makes it the only unconditional guarantee here, and also the one
  // setting that could end real work if it ever dropped below what the kernel permits a run to take.
  //
  // If you raise `maxRuntimeCeilingS`, raise `ttlMinutes` with it. That is what this test is for.
  const ceilingS = loadConfig().maxRuntimeCeilingS;
  const ttlS = SANDBOX_LIFECYCLE.ttlMinutes * 60;
  assert.ok(
    ttlS > ceilingS,
    `ttlMinutes (${SANDBOX_LIFECYCLE.ttlMinutes}m = ${ttlS}s) must exceed maxRuntimeCeilingS (${ceilingS}s), ` +
      "or the backstop will destroy sandboxes out from under runs the kernel considers legal",
  );
  // And by a real margin, so the two are not one config change away from touching.
  assert.ok(
    ttlS - ceilingS >= 3600,
    `ttlMinutes must clear maxRuntimeCeilingS by at least an hour; the margin is ${ttlS - ceilingS}s`,
  );
});

test("silence is judged by the stall watchdog, not by auto-stop", () => {
  // Lowering this looks like it shrinks the orphan window. It also ends a legitimately long, quiet
  // run: `mycel-build` blocks for minutes without touching the toolbox API, which from Daytona's
  // side is indistinguishable from inactivity. Auto-delete already bounds the leak; this does not
  // need to, and it is the setting that would cost real work.
  assert.ok(
    SANDBOX_LIFECYCLE.autoStopInterval >= 60,
    "autoStopInterval below 60 risks stopping a run that is working but quiet — STALL_MS judges silence",
  );
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE SWEEP, WHICH RAN PERFECTLY AND FREED NOTHING
// ─────────────────────────────────────────────────────────────────────────────────────────────────
//
// `reapStoppedSandboxes` was written to prevent `Total disk limit exceeded`, ran on a clock to catch
// leaks between deploys, and POSTed `/archive`. Archiving is a state change, not a deletion.
//
// So the account it was guarding held 508 archived sandboxes, 17 started, and ZERO stopped: the
// sweep had faithfully converted every stopped sandbox into an archived one and moved no bytes. The
// count it logged — described in its own comment as the signal that something is leaking — was
// counting its own output.

test("the sweep deletes; archiving is not freeing", () => {
  const src = readFileSync(new URL("../src/sandbox.ts", import.meta.url), "utf8");
  const body = src.slice(src.indexOf("export async function reapStoppedSandboxes"));
  const code = stripComments(body);
  assert.ok(
    /method:\s*"DELETE"/.test(code),
    "reapStoppedSandboxes must issue DELETE — a sandbox nothing will reattach to should not exist in any state",
  );
  assert.ok(
    !/\/archive/.test(code),
    "reapStoppedSandboxes must not archive: archiving is a state change and frees nothing",
  );
});

test("the sweep never touches a running sandbox", () => {
  const src = readFileSync(new URL("../src/sandbox.ts", import.meta.url), "utf8");
  const code = stripComments(src.slice(src.indexOf("export async function reapStoppedSandboxes")));
  // A live run holds a started sandbox, and a run that is merely slow is still started. The filter
  // must be an allow-list of dead states, never a deny-list.
  assert.ok(
    !/state\s*!==\s*["']started["']/.test(code),
    "filter by the dead states explicitly; excluding 'started' admits every future state by default",
  );
  for (const dead of ["stopped", "archived"]) {
    assert.ok(
      new RegExp(`state === ["']${dead}["']`).test(code),
      `the sweep should collect ${dead} sandboxes`,
    );
  }
});

test("the sweep reads every page", () => {
  const src = readFileSync(new URL("../src/sandbox.ts", import.meta.url), "utf8");
  const code = stripComments(src.slice(src.indexOf("export async function reapStoppedSandboxes")));
  // `/api/sandbox` returns 100 rows and a `nextCursor`. The account held 532. A sweep that reads
  // one page cannot see the backlog it exists to clear.
  assert.ok(/nextCursor/.test(code), "the sandbox list is paginated — the sweep must follow nextCursor");
});

test("the sweep can tell our sandboxes from another project's", () => {
  // The Daytona organisation is shared. Deleting by state alone would reach other projects' dead
  // sandboxes, which are equally dead and are not ours to remove.
  assert.ok(
    snapshotName().startsWith(SNAPSHOT_PREFIX),
    "the sweep filters on SNAPSHOT_PREFIX, so the names it builds must carry it",
  );
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// AND WHAT AN ORPHAN COSTS WHILE THE NET IS CLOSING
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// The lifecycle above stops a leak becoming permanent. It says nothing about the BILL, and the bill
// is where the flat 60-minute idle window showed up. Fourteen days of production: 396 runs orphaned
// by a kernel restart (870 sandbox-hours) and 510 killed by a 504 (511 hours) — together 94% of
// every sandbox-hour paid for, all of it dead runs waiting out a timer. Disk is 80% of the invoice.

test("the idle window follows the run's own budget, never a flat hour", async () => {
  const { idleMinutesFor, IDLE_FLOOR_MINUTES, SANDBOX_LIFECYCLE: L } = await import("../src/sandbox");

  // A deliver run capped at 15 minutes cannot legitimately be idle for 60. If its whole budget has
  // elapsed with no activity, the kernel would have killed it anyway.
  assert.equal(idleMinutesFor(900), 15, "a 15-minute run still got the flat hour");
  assert.equal(idleMinutesFor(420), IDLE_FLOOR_MINUTES, "a 7-minute run should sit on the floor, not below it");

  // The floor protects a short run that is genuinely quiet for a stretch.
  assert.ok(idleMinutesFor(60) >= IDLE_FLOOR_MINUTES, "a one-minute budget must not produce a one-minute window");

  // NOTHING GETS A LONGER WINDOW THAN IT HAS TODAY. `mycel-build` blocks for minutes without
  // touching the toolbox API, so a build on the full ceiling keeps its whole hour.
  assert.equal(idleMinutesFor(3600), L.autoStopInterval, "a full-ceiling run lost window it used to have");
  assert.equal(idleMinutesFor(99_999), L.autoStopInterval, "the cap is not holding");

  // Unknown budget falls back to the old constant rather than to the floor: a run whose cap we
  // cannot read is exactly the one that must not be cut short.
  assert.equal(idleMinutesFor(undefined), L.autoStopInterval, "an unknown budget must be treated as the long case");
  assert.equal(idleMinutesFor(0), L.autoStopInterval, "a zero budget is unknown, not instant");
  assert.equal(idleMinutesFor(Number.NaN), L.autoStopInterval, "NaN must not become a window");
});

test("the idle window is never the safety net", async () => {
  const { idleMinutesFor, SANDBOX_LIFECYCLE: L } = await import("../src/sandbox");
  // Whatever the window is, the two guarantees above still hold: the provider deletes on stop, and
  // the wall-clock TTL reaches states auto-delete cannot. Shortening the window must never be
  // mistaken for, or allowed to weaken, either one.
  assert.equal(L.autoDeleteInterval, 0);
  assert.ok(L.ttlMinutes * 60 > loadConfig().maxRuntimeCeilingS);
  assert.ok(
    idleMinutesFor(900) * 60 < L.ttlMinutes * 60,
    "the idle window must fire long before the wall-clock backstop, or the backstop is doing the work",
  );
});
