// SAYING SOMETHING TO A RUNNING BUILD — one message on the wire at a time, oldest first.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// WHAT THIS TAKES FROM SUNA, AND WHAT IT DELIBERATELY DOES NOT
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// `kortix-ai/suna` runs the same OpenCode daemon we do, and their
// `session-lifecycle/inbox-admission.ts` says the thing worth knowing outright:
//
//     "OpenCode's legacy `/prompt_async` route interleaves inputs posted during a live turn. The
//      inbox must therefore serialize before that boundary instead of trusting runtime placement to
//      recover ownership afterwards. What is left is ORDER, and only order: one prompt of a session
//      on the wire at a time, oldest first, so the user's own messages reach OpenCode in the order
//      they were typed."
//
// We post to that exact route, from `POST /v1/tasks/:id/steer`, with nothing in between.
//
// WHAT DOES NOT TRANSFER, and it is most of their machinery. Their sessions are long-lived chats
// across many turns and many replicas, so admission waits for the turn to END and the whole thing
// lives in a durable command table with dead-lettering and instance hand-off. A Mycel run is ONE
// turn: prompt, work, `session.idle`, run over. A steer that waited for idle would arrive after the
// sandbox was destroyed, which is not steering — it is a message to nobody. So we post into the live
// turn on purpose; that is the feature.
//
// WHAT DOES TRANSFER is the half that is about ORDER rather than about turn boundaries:
//
//   1. ONE ON THE WIRE AT A TIME. Two steers typed quickly both called `startPrompt` concurrently
//      and arrived in whichever order the network settled. A founder correcting themselves — "use
//      the blue" then "no, the dark blue" — could have the correction land first.
//   2. A TRANSIENT FAILURE IS NOT A REFUSAL. Suna's `deliverWithRetry` exists because "a just-woken
//      sandbox is flaky for a beat" and their old path "bounced on the FIRST such hiccup, which told
//      the user 'still waking… send that again' and dropped their message even though the session
//      was up". Ours answered the same way, in the same situation, with a 409 and no retry.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// THE MESSAGE IS NEVER LOST SILENTLY
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// `steer.sent` goes on the event log BEFORE delivery is attempted, so a founder sees their own words
// whatever happens next. This queue only decides WHEN it reaches the agent, never whether it was
// said. A failure after the retries is reported as a failure — the one outcome that must never
// happen is the message vanishing while the caller is told `ok`.

/** How long to keep trying one message. Suna uses 45s for a waking box; a live run needs far less. */
export const DELIVER_DEADLINE_MS = 20_000;

/**
 * How many extra turns a run may be extended by steering.
 *
 * A steer that lands mid-turn is queued behind it, so answering it costs the run one more turn. That
 * has to be bounded — a sandbox held open indefinitely by a stream of messages is a cost nobody
 * agreed to — but it has to be more than one, because the ordinary shape of steering is a correction
 * followed by a follow-up. Four, with the run's own max_runtime_s and the stall watchdog as the
 * real ceilings underneath it.
 */
export const MAX_STEER_TURNS = 4;

/**
 * How long a steered turn has to START before the run stops waiting for it.
 *
 * A 204 from `prompt_async` is not proof that anything will run. Suna verified against the daemon
 * that it "answers 204 for an agent it cannot run", and their delivery loop read that as success
 * while the user's text vanished with "no queue row, no transcript bubble, no error, and nothing to
 * retry".
 *
 * Forty-five seconds is generous for a turn that is genuinely starting — OpenCode opens an assistant
 * message almost immediately — and short enough that a discarded steer does not turn a finished run
 * into fifteen minutes of silence. Cleared by the first sign of activity, so this bounds the WAIT
 * FOR A START, never the turn itself.
 */
export const STEER_TURN_START_MS = 45_000;
/** Between attempts. Long enough that a daemon mid-tool-call gets a breath, short enough to feel live. */
export const DELIVER_INTERVAL_MS = 1_000;

/** A message a founder typed, waiting its turn. */
interface Pending {
  text: string;
  resolve: (ok: { delivered: true } | { delivered: false; why: string }) => void;
}

/**
 * WHICH FAILURES MAY BE RETRIED — and the reason this is a narrow list rather than "5xx".
 *
 * `kortix-ai/suna`'s `sandbox-proxy/prompt-dedupe.ts` states the constraint we are under:
 *
 *     "Prompt delivery is the one MUTATING call on the sandbox proxy: POSTing the same body twice to
 *      opencode enqueues the user's message twice (the 3x-queued bug). opencode has no idempotency
 *      of its own, so the proxy must never re-send a prompt body it may already have delivered."
 *
 * They paid for it: on 2026-08-11, session 9f6b0d87, one submit produced FOUR identical user
 * messages 11.0s / 11.8s / 13.7s apart, because an endpoint missing from their guard list "got
 * treated as an ordinary idempotent request: no dedupe claim, retried on 5xx, retried on an
 * ambiguous timeout/abort, four attempts, four executions."
 *
 * We have no dedupe claim. So the only failures we may retry are the ones that PROVE the request
 * never reached the daemon: the connection was refused, the host did not resolve, the socket died
 * before a response, or a proxy in front answered for it. A TIMEOUT IS NOT ON THIS LIST, and that is
 * the important omission — a request that timed out may have been delivered and be running right
 * now, and retrying it is how one steer becomes two.
 */
const NEVER_DELIVERED =
  /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|socket hang up|network|fetch failed|502|503|504/i;

/** A timeout is ambiguous by construction: the request may be running. Never retried. */
const AMBIGUOUS = /timeout|timed? ?out|abort/i;

export function mayRetry(error: unknown): boolean {
  const text = String((error as Error)?.message ?? error ?? "");
  if (!text) return false;
  if (AMBIGUOUS.test(text)) return false;
  return NEVER_DELIVERED.test(text);
}

export interface SteerDeps {
  /**
   * Post to the daemon.
   *
   * THROWS on failure — which is what `OpenCodeClient.startPrompt` actually does. An earlier version
   * of this file expected `false` for a transient refusal and treated every throw as permanent, so
   * the retry loop below was unreachable: a 502 from a still-booting daemon was reported to the
   * founder as a refusal. `mayRetry` classifies the throw instead.
   */
  send: (text: string) => Promise<boolean>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  deadlineMs?: number;
  intervalMs?: number;
  /** Test seam. Production uses `mayRetry`. */
  retryable?: (error: unknown) => boolean;
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * A run's steer queue.
 *
 * One per run, held on the `RunHandle`, so it dies with the run exactly like the sandbox does. No
 * durable table: at one replica with the worker in-process there is nothing to hand off to, and a
 * command table whose only consumer is the process that wrote it is ceremony rather than safety.
 * When steering has to survive a replica move, `instance-release.ts` in their repo is the shape to
 * copy — that is a different change and it is written down here so nobody has to rediscover it.
 */
export class SteerQueue {
  private readonly q: Pending[] = [];
  private draining = false;
  private closed = false;

  constructor(private readonly deps: SteerDeps) {}

  /** How many messages are waiting behind the one being delivered. Reported, never guessed at. */
  get waiting(): number {
    return this.q.length;
  }

  /**
   * Messages DELIVERED whose turn has not been seen to end.
   *
   * ═══ THE REASON THIS COUNTER EXISTS, WHICH IS THE STEER BUG ITSELF ═══
   *
   * OpenCode persists a prompt posted during a live turn and QUEUES ITS EXECUTION behind that turn.
   * Suna states it plainly in `session-lifecycle/store.ts`: "between the POST and the turn there is
   * a real interval in which the message exists, belongs to the transcript, and has not run."
   *
   * A Mycel run ends on `session.idle`, and `runtime.ts` answers that by calling `oc.abort()` and
   * destroying the sandbox. So the sequence for every mid-turn steer was:
   *
   *    founder steers → OpenCode persists it behind the live turn → the live turn ends →
   *    `session.idle` → WE ABORT AND TEAR DOWN → the queued prompt never runs
   *
   * The message was accepted, recorded on the feed, and then killed by us before it could be
   * answered. From the founder's side that is indistinguishable from "it didn't go through", which
   * is exactly how it was reported.
   *
   * So the run may not treat the first idle after a steer as the end. `session.idle` there is a
   * BOUNDARY — the original turn finishing — and the steered turn begins on the other side of it.
   */
  private outstandingTurns = 0;

  get outstanding(): number {
    return this.outstandingTurns;
  }

  /**
   * One turn boundary has passed. Returns true if it belonged to a steer, meaning the run must keep
   * going rather than finish.
   */
  noteTurnBoundary(): boolean {
    if (this.outstandingTurns <= 0) return false;
    this.outstandingTurns -= 1;
    return true;
  }

  /**
   * Queue a message and resolve when it has been delivered — or genuinely could not be.
   *
   * Awaits the OUTCOME rather than the enqueue, because the caller is an HTTP route answering a
   * founder who is watching for their message to appear. "Accepted for later delivery" is the answer
   * that made this feel broken in the first place.
   */
  send(text: string): Promise<{ delivered: true } | { delivered: false; why: string }> {
    if (this.closed) {
      return Promise.resolve({ delivered: false as const, why: "the run finished before this could be sent" });
    }
    return new Promise((resolve) => {
      this.q.push({ text, resolve });
      void this.drain();
    });
  }

  /**
   * The run is over. Everything still queued is answered honestly rather than left hanging.
   *
   * A pending promise that never settles is worse than a failure: the route holds its connection
   * open, the founder watches a spinner, and nothing anywhere says the run ended.
   */
  close(): void {
    this.closed = true;
    for (const p of this.q.splice(0)) {
      p.resolve({ delivered: false, why: "the run finished before this could be sent" });
    }
  }

  private async drain(): Promise<void> {
    if (this.draining) return; // one on the wire at a time — the whole point
    this.draining = true;
    try {
      while (this.q.length) {
        const next = this.q[0]!;
        const outcome = await this.deliver(next.text);
        // Only a DELIVERED message earns a turn. A refusal never reached OpenCode, so nothing is
        // queued behind the live turn and the run must not wait for one.
        if (outcome.delivered) this.outstandingTurns += 1;
        next.resolve(outcome);
        this.q.shift();
      }
    } finally {
      this.draining = false;
    }
  }

  /** Suna's `deliverWithRetry`, shorter: keep trying through the flaky beat, then say so. */
  private async deliver(text: string): Promise<{ delivered: true } | { delivered: false; why: string }> {
    const now = this.deps.now ?? Date.now;
    const sleep = this.deps.sleep ?? wait;
    const deadline = now() + (this.deps.deadlineMs ?? DELIVER_DEADLINE_MS);
    let last = "the agent did not accept it";
    for (;;) {
      if (this.closed) return { delivered: false, why: "the run finished before this could be sent" };
      try {
        if (await this.deps.send(text)) return { delivered: true };
      } catch (e) {
        const why = String((e as Error)?.message ?? e).slice(0, 300);
        /**
         * Only a failure that PROVES the prompt never landed may be retried. Everything else —
         * including a timeout, especially a timeout — is reported as it is, because the alternative
         * is sending the founder's message twice. See `mayRetry`.
         */
        const retryable = this.deps.retryable ?? mayRetry;
        if (!retryable(e)) return { delivered: false, why };
        last = why;
      }
      if (now() >= deadline) return { delivered: false, why: last };
      await sleep(this.deps.intervalMs ?? DELIVER_INTERVAL_MS);
    }
  }
}
