// STEERING — one message on the wire at a time, oldest first.
//
// Ported from a comparable runtime's `session-lifecycle/inbox-admission.ts` and `deliver.ts`. They run the
// same OpenCode daemon and say the thing outright: "`/prompt_async` interleaves inputs posted during
// a live turn... one prompt of a session on the wire at a time, oldest first, so the user's own
// messages reach OpenCode in the order they were typed."
//
// We posted to that exact route with nothing in between.

import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_STEER_TURNS, STEER_TURN_START_MS, SteerQueue, mayRetry } from "../src/steer-queue";

/** A daemon under our control: records order, and can be told to refuse for a while. */
function daemon(opts: { refuseFirst?: number; throwOn?: string } = {}) {
  const seen: string[] = [];
  let refusals = opts.refuseFirst ?? 0;
  return {
    seen,
    send: async (text: string) => {
      if (opts.throwOn && text === opts.throwOn) throw new Error("session is gone");
      if (refusals > 0) {
        refusals -= 1;
        return false;
      }
      seen.push(text);
      return true;
    },
  };
}

const fast = { sleep: async () => {}, intervalMs: 0 };

test("two messages typed quickly arrive in the order they were typed", async () => {
  // THE BUG. Both called `startPrompt` concurrently and landed in whichever order the network
  // settled — so a founder correcting themselves ("use the blue" / "no, the dark blue") could have
  // the correction arrive first and be overwritten by the thing they were correcting.
  const d = daemon();
  const q = new SteerQueue({ send: d.send, ...fast });
  const both = Promise.all([q.send("use the blue"), q.send("no, the dark blue")]);
  await both;
  assert.deepEqual(d.seen, ["use the blue", "no, the dark blue"]);
});

test("only one is on the wire at a time", async () => {
  let concurrent = 0;
  let peak = 0;
  const q = new SteerQueue({
    ...fast,
    send: async () => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      await new Promise((r) => setTimeout(r, 5));
      concurrent -= 1;
      return true;
    },
  });
  await Promise.all(["a", "b", "c", "d"].map((t) => q.send(t)));
  assert.equal(peak, 1, "serialised, which is the whole point");
});

test("a busy daemon is retried, not refused", async () => {
  // a comparable runtime's reason, verbatim: "a just-woken sandbox is flaky for a beat" and the old path "bounced on
  // the FIRST such hiccup, which told the user 'still waking… send that again' and dropped their
  // message even though the session was up". Ours answered 409 in exactly that situation.
  const d = daemon({ refuseFirst: 3 });
  const q = new SteerQueue({ send: d.send, ...fast });
  const r = await q.send("keep the redirects");
  assert.deepEqual(r, { delivered: true });
  assert.deepEqual(d.seen, ["keep the redirects"]);
});

test("but not forever — a deadline ends with a sentence, never a hang", async () => {
  let clock = 0;
  const q = new SteerQueue({
    send: async () => false,
    now: () => clock,
    sleep: async () => {
      clock += 1_000;
    },
    intervalMs: 1_000,
    deadlineMs: 5_000,
  });
  const r = await q.send("hello");
  assert.equal(r.delivered, false);
  assert.match((r as { why: string }).why, /did not accept it/);
});

// ── which failures may be retried, and why the list is narrow ──────────────────────────────────
//
// `startPrompt` THROWS on failure and never returns false, so the first version of this file — which
// expected `false` for a transient refusal and treated every throw as permanent — had an unreachable
// retry loop. A 502 from a still-booting daemon was reported to the founder as a refusal, which is
// the exact behaviour the retry was added to prevent.
//
// The fix is not "retry throws". a comparable runtime's `prompt-dedupe.ts`: "opencode has no idempotency of its own,
// so the proxy must never re-send a prompt body it may already have delivered." One submit of theirs
// became four identical user messages because an endpoint was retried on an ambiguous timeout.

test("a failure that proves nothing was delivered is retried", async () => {
  for (const message of [
    "connect ECONNREFUSED 127.0.0.1:4096",
    "getaddrinfo ENOTFOUND sandbox.internal",
    "socket hang up",
    "send prompt failed: 502 Bad Gateway",
    "send prompt failed: 503 Service Unavailable",
    "fetch failed",
  ]) {
    assert.equal(mayRetry(new Error(message)), true, message);
  }
});

test("a TIMEOUT is never retried, because the prompt may be running right now", async () => {
  // The important omission. A request that timed out may have been delivered — retrying it is how
  // one steer becomes two, and the founder's correction arrives twice.
  for (const message of [
    "The operation timed out",
    "request timeout",
    "This operation was aborted",
  ]) {
    assert.equal(mayRetry(new Error(message)), false, message);
  }
});

test("an error we do not recognise is not retried", async () => {
  // Fails toward not-duplicating. An unknown failure may well have landed.
  for (const message of ["", "send prompt failed: 400 bad request", "something odd"]) {
    assert.equal(mayRetry(new Error(message)), false, JSON.stringify(message));
  }
});

test("a throw the classifier allows is actually retried, and then succeeds", async () => {
  // The end-to-end version: the loop that was unreachable now runs.
  let attempts = 0;
  const q = new SteerQueue({
    ...fast,
    send: async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("connect ECONNREFUSED 127.0.0.1:4096");
      return true;
    },
  });
  const r = await q.send("use the dark blue");
  assert.deepEqual(r, { delivered: true });
  assert.equal(attempts, 3);
});

test("a throw the classifier refuses is reported at once, not after the deadline", async () => {
  let attempts = 0;
  const q = new SteerQueue({
    ...fast,
    send: async () => {
      attempts += 1;
      throw new Error("The operation timed out");
    },
  });
  const r = await q.send("hello");
  assert.equal(r.delivered, false);
  assert.equal(attempts, 1, "asked once — a timeout may already be running");
});

test("a permanent refusal is not retried", async () => {
  // Retrying something the daemon is certain about spends the founder's patience to reach the same
  // answer twenty seconds later.
  let calls = 0;
  const q = new SteerQueue({
    ...fast,
    send: async () => {
      calls += 1;
      throw new Error("session is gone");
    },
  });
  const r = await q.send("anything");
  assert.equal(r.delivered, false);
  assert.equal(calls, 1, "asked once");
  assert.match((r as { why: string }).why, /session is gone/);
});

test("one message failing does not block the next", async () => {
  // A head-of-line failure that stalled the queue would turn one bad message into a mute session.
  const d = daemon({ throwOn: "bad" });
  const q = new SteerQueue({ send: d.send, ...fast });
  const [first, second] = await Promise.all([q.send("bad"), q.send("good")]);
  assert.equal(first.delivered, false);
  assert.equal(second.delivered, true);
  assert.deepEqual(d.seen, ["good"]);
});

test("when the run ends, everything waiting is answered", async () => {
  // A pending promise that never settles is worse than a failure: the route holds its connection
  // open, the founder watches a spinner, and nothing says the run ended.
  const q = new SteerQueue({
    ...fast,
    send: async () => new Promise<boolean>(() => {}), // never resolves
  });
  const pending = q.send("first");
  const queued = q.send("second");
  q.close();
  const r = await queued;
  assert.equal(r.delivered, false);
  assert.match((r as { why: string }).why, /run finished/);
  void pending;
});

test("a message sent after the run ended is refused immediately", async () => {
  const q = new SteerQueue({ ...fast, send: async () => true });
  q.close();
  const r = await q.send("too late");
  assert.equal(r.delivered, false);
  assert.match((r as { why: string }).why, /run finished/);
});

test("the queue reports how many are waiting rather than guessing", async () => {
  // Typed as a plain function rather than a nullable, because TypeScript cannot see through the
  // async closure that assigns it and narrows the call site to `null`.
  let release: () => void = () => {};
  const q = new SteerQueue({
    ...fast,
    send: async () => {
      await new Promise<void>((r) => {
        release = r;
      });
      return true;
    },
  });
  void q.send("a");
  void q.send("b");
  void q.send("c");
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(q.waiting, 3, "one in flight, two behind it, all still queued until delivered");
  release();
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// A STEER BUYS A TURN — the actual reason steering "did not go through"
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// OpenCode persists a prompt posted during a live turn and QUEUES its execution behind that turn.
// a comparable runtime's `session-lifecycle/store.ts`: "between the POST and the turn there is a real interval in
// which the message exists, belongs to the transcript, and has not run."
//
// A Mycel run ends on `session.idle`, and the runtime answered that by aborting the session and
// destroying the sandbox. So every mid-turn steer was: founder steers, OpenCode queues it, the
// original turn ends, idle arrives, we abort and tear down, the queued prompt never runs. The
// message was accepted, written to the feed, and then killed by us.

test("a delivered steer leaves a turn outstanding", async () => {
  const q = new SteerQueue({ ...fast, send: async () => true });
  assert.equal(q.outstanding, 0);
  await q.send("use the dark blue");
  assert.equal(q.outstanding, 1, "the run must wait for the turn this bought");
});

test("a REFUSED steer buys nothing", async () => {
  // Nothing reached OpenCode, so nothing is queued behind the live turn, so the run must not sit
  // waiting for a turn that will never come.
  const q = new SteerQueue({
    ...fast,
    send: async () => {
      throw new Error("The operation timed out");
    },
  });
  const r = await q.send("hello");
  assert.equal(r.delivered, false);
  assert.equal(q.outstanding, 0);
});

test("each turn boundary consumes exactly one steer", async () => {
  const q = new SteerQueue({ ...fast, send: async () => true });
  await q.send("one");
  await q.send("two");
  assert.equal(q.outstanding, 2);
  assert.equal(q.noteTurnBoundary(), true);
  assert.equal(q.outstanding, 1);
  assert.equal(q.noteTurnBoundary(), true);
  assert.equal(q.outstanding, 0);
  // And an idle with nothing outstanding is the genuine end of the run.
  assert.equal(q.noteTurnBoundary(), false, "the run finishes when no steer is waiting");
});

test("the extension is bounded", () => {
  // A sandbox held open indefinitely by a stream of messages is a cost nobody agreed to, and the
  // founder can always start a fresh job.
  assert.ok(MAX_STEER_TURNS >= 2, "one is too few — a correction and a follow-up is the normal shape");
  assert.ok(MAX_STEER_TURNS <= 8, "and this must not become an unbounded session");
});

test("the wait for a steered turn is bounded, and bounded on a START not a duration", () => {
  // A 204 from `prompt_async` is not proof anything will run — a comparable runtime verified the daemon "answers 204
  // for an agent it cannot run", and their loop read it as success while the user's text vanished
  // with "no queue row, no transcript bubble, no error, and nothing to retry".
  //
  // Without a bound, our own extension would turn "the run finished and ignored your message" into
  // fifteen minutes of silence ending in a stall error — strictly worse. The bound is on the turn
  // STARTING, cleared by the first activity, so a turn that really is running is never cut off.
  assert.ok(STEER_TURN_START_MS >= 20_000, "a turn that is genuinely starting must not be cut off");
  assert.ok(STEER_TURN_START_MS <= 90_000, "and a discarded steer must not cost the founder minutes");
});
