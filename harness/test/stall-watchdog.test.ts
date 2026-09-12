// The stall watchdog, and the heartbeat that made it inert for months.
//
// ═══ THE PRODUCTION INCIDENT THIS FILE IS BUILT FROM ═══
//
// CloudWatch + the prod task store, 2026-08-20/21. Of 159 `gtm-operator/ops_distribution_tick`
// runs, 46 — a little under a THIRD — ended `aborted: max_runtime_exceeded` at the full 1800s
// ceiling. 44 of the 46 had a `tool.result` for `glob` as their last event before the abort, and
// across those runs there were 48 `glob` calls with NO matching result. In the 113 SUCCEEDED runs
// of the same type there were ZERO unmatched globs.
//
// The shape is always the same. Task 05673a60-23de-4d5e-a3e7-5710cb3d670b, verbatim:
//
//   03:17:52.675  tool.called  glob  knowledge/*    call_ZiG2iDf3b2zE1amDj1iR9DLq
//   03:17:52.777  tool.called  glob  skills/*       call_RwZtdX18UPYxcUBjmz52ey48
//   03:17:52.786  tool.called  glob  inputs/**/*    call_osDaavPS5g4AbWPpTOZ4hWD7
//   03:17:56.213  tool.result                       call_osDaavPS5g4AbWPpTOZ4hWD7
//   03:17:56.223  tool.result                       call_RwZtdX18UPYxcUBjmz52ey48
//   03:47:35.499  task.finished  {"error":"aborted: max_runtime_exceeded","status":"expired"}
//
// N parallel globs, N-1 results. The agent then waited 29 minutes and 39 seconds for a result that
// was never coming. The patterns are not the cause — `knowledge/*` completes fine in other runs.
//
// The kernel cannot make opencode return that result. What the kernel OWNS is noticing. A 15-minute
// stall watchdog was armed for the whole 29 minutes and never fired, because `lastEventAt` was
// refreshed by every frame on the stream and opencode heartbeats on that stream. A heartbeat proves
// the SERVER is alive. It says nothing about the AGENT.
//
// So these tests pin the distinction that fixes it: iterating is not progress.
import assert from "node:assert/strict";
import test from "node:test";
import { harnessProfileNote } from "../src/harness";
import { isAgentActivity, OpenCodeEventMapper, type OpenCodeEvent } from "../src/opencode";

const SID = "ses_ops_tick";

/** A heartbeat: opencode saying "still here", carrying no session and no agent news. */
const HEARTBEAT: OpenCodeEvent = { type: "server.connected", properties: {} } as OpenCodeEvent;

/** `session.status: busy` — the model is thinking. Republished, and not itself a unit of progress. */
const BUSY: OpenCodeEvent = {
  type: "session.status",
  properties: { sessionID: SID, status: { type: "busy" } },
} as OpenCodeEvent;

/** A token of the agent's answer. Unambiguously the agent doing something. */
function tokenDelta(text: string): OpenCodeEvent {
  return {
    type: "message.part.updated",
    properties: { sessionID: SID, delta: text, part: { id: "prt_1", sessionID: SID, messageID: "msg_1", type: "text" } },
  } as OpenCodeEvent;
}

/**
 * The stall watchdog from runtime.ts, reduced to the one decision it makes.
 *
 * Returns the wall-clock ms at which the run would be declared stalled, or null if it never is.
 * `resets` selects the rule under test, which is the entire point: the same event tape is replayed
 * under the old rule (any frame counts) and the new one (only agent activity counts).
 */
function stallsAt(
  tape: { ev: OpenCodeEvent; at: number }[],
  endAt: number,
  resets: (ev: OpenCodeEvent, mapper: OpenCodeEventMapper) => boolean,
  stallMs = 15 * 60 * 1000,
): number | null {
  const mapper = new OpenCodeEventMapper(SID);
  let lastEventAt = 0;
  for (const { ev, at } of tape) {
    // The watchdog is a 5s interval, so it fires at the first check after the clock ages out —
    // which, between two events, is bounded by the gap itself.
    if (at - lastEventAt > stallMs) return lastEventAt + stallMs;
    if (mapper.foreign(ev)) continue;
    if (resets(ev, mapper)) lastEventAt = at;
  }
  if (endAt - lastEventAt > stallMs) return lastEventAt + stallMs;
  return null;
}

/** The old rule: every frame off the socket counted. */
const OLD_RULE = () => true;
/** The new rule: only what the mapper could name as agent activity counts. */
const NEW_RULE = (ev: OpenCodeEvent, mapper: OpenCodeEventMapper) => isAgentActivity(mapper.map(ev));

/**
 * The real tape: three globs go out, two come back, and then opencode heartbeats every 30 seconds
 * for the rest of the 1800s ceiling while the agent waits on the third.
 */
function wedgedOnGlobTape(): { ev: OpenCodeEvent; at: number }[] {
  const tape: { ev: OpenCodeEvent; at: number }[] = [
    { ev: BUSY, at: 0 },
    { ev: tokenDelta("reading the distribution procedure"), at: 15_000 },
    // 03:17:56 — the last real thing that ever happened in that run.
    { ev: tokenDelta("globbing knowledge/, skills/ and inputs/"), at: 21_000 },
  ];
  // 03:17:56 → 03:47:35. Heartbeats, and nothing else, all the way to the ceiling.
  for (let t = 30_000; t <= 1_800_000; t += 30_000) {
    tape.push({ ev: HEARTBEAT, at: t });
    tape.push({ ev: BUSY, at: t + 1 });
  }
  return tape;
}

test("a heartbeat is not agent activity, so it cannot hold the stall clock open", () => {
  const mapper = new OpenCodeEventMapper(SID);
  assert.equal(isAgentActivity(mapper.map(HEARTBEAT)), false, "server.connected is liveness, not progress");
  assert.equal(isAgentActivity(mapper.map(BUSY)), false, "'the model is busy' is a status, not a unit of work");
});

test("tokens, tool calls, costs, completion and errors all count as agent activity", () => {
  const mapper = new OpenCodeEventMapper(SID);
  assert.equal(isAgentActivity(mapper.map(tokenDelta("hello"))), true, "a token is the agent talking");

  // An error must count, or a run that is failing looks identical to a run that is hung and the
  // watchdog would race the real error to the finish line.
  assert.equal(
    isAgentActivity({
      emissions: [],
      error: "opencode UnknownError: boom",
    }),
    true,
  );
  assert.equal(isAgentActivity({ emissions: [], done: true }), true);
  assert.equal(
    isAgentActivity({ emissions: [], usage: { input: 1, output: 1 } as never }),
    true,
    "a charge is proof a completion landed",
  );
  assert.equal(isAgentActivity({ emissions: [] }), false, "NOTHING is nothing");
});

test("REGRESSION: heartbeats defeated the old watchdog for the full 1800s ceiling", () => {
  // This is the bug, asserted. Under the old rule the run reaches the hard ceiling with the stall
  // watchdog never having fired — exactly what the 46 expired production runs show.
  const stalled = stallsAt(wedgedOnGlobTape(), 1_800_000, OLD_RULE);
  assert.equal(stalled, null, "old rule: 29 minutes of pure heartbeat never looked like a stall");
});

test("a run wedged on a tool result that never arrives is now ended at the stall deadline", () => {
  const stalled = stallsAt(wedgedOnGlobTape(), 1_800_000, NEW_RULE);
  assert.notEqual(stalled, null, "the agent went silent at 21s; that must be caught");
  // Last real activity was 21s in, STALL_MS is 15 minutes.
  assert.equal(stalled, 21_000 + 15 * 60 * 1000);
  // The founder-visible win: ended at ~15m instead of burning the full 30m sandbox.
  assert.ok(stalled! < 1_800_000, "must end strictly before the runtime ceiling, or nothing improved");
});

test("a healthy run that is quiet while a build blocks is NOT killed", () => {
  // `mycel-build` blocks up to its 600s CodeBuild timeout with no stream traffic. That is the
  // longest legitimate quiet in the system and STALL_MS was sized to clear it. Now that heartbeats
  // no longer prop the clock up, this margin is load-bearing rather than theoretical.
  const tape = [
    { ev: BUSY, at: 0 },
    { ev: tokenDelta("running mycel-build"), at: 10_000 },
    // 600 seconds of compiler, heartbeats only.
    ...Array.from({ length: 20 }, (_, i) => ({ ev: HEARTBEAT, at: 10_000 + (i + 1) * 30_000 })),
    // The build comes back at ~610s and the agent carries on.
    { ev: tokenDelta("build succeeded"), at: 620_000 },
    { ev: tokenDelta("writing output"), at: 640_000 },
  ];
  assert.equal(stallsAt(tape, 650_000, NEW_RULE), null, "a 10-minute compile is not a stall");
});

test("another session's chatter cannot hold this run's stall clock open", () => {
  // `foreign` events are skipped before the reset in runtime.ts. Belt and braces: a busy neighbour
  // on a shared opencode server must not disguise this run's silence.
  const foreign = { type: "message.part.updated", properties: { sessionID: "ses_someone_else", delta: "x" } };
  const tape = [
    { ev: BUSY, at: 0 },
    { ev: tokenDelta("start"), at: 1_000 },
    ...Array.from({ length: 120 }, (_, i) => ({ ev: foreign as OpenCodeEvent, at: 1_000 + (i + 1) * 30_000 })),
  ];
  const stalled = stallsAt(tape, 3_700_000, NEW_RULE);
  assert.equal(stalled, 1_000 + 15 * 60 * 1000, "a neighbour's tokens are not this run's progress");
});

// ═══ The other half of the same incident: the trace reported a budget nobody was enforcing ═══

test("the harness note reports the ENFORCED runtime, not the profile's request", () => {
  // The exact production disagreement: `general` shape asks 600s, scheduler.ts pins the constraint
  // at 1800s, and orchestrator.ts enforces the constraint. The trace said "600s".
  const note = harnessProfileNote({
    shape: "general",
    tier: "standard",
    enforcedRuntimeS: 1800,
    profileRuntimeS: 600,
    grantsActions: true,
  });
  assert.match(note, /1800s enforced/, "the number that kills the run must be the number on the trace");
  assert.match(note, /profile asked 600s/, "and the gap must stay visible, because the gap is a bug");
  assert.ok(
    !/^harness: general profile — standard tier, 600s,/.test(note),
    "must not lead with a budget that was never in force",
  );
});

test("when the request and the enforcement agree, the note says it once", () => {
  const note = harnessProfileNote({
    shape: "decide",
    tier: "standard",
    enforcedRuntimeS: 420,
    profileRuntimeS: 420,
    grantsActions: false,
  });
  assert.equal(note, "harness: decide profile — standard tier, 420s, no connection access");
});
