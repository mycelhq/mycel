// Outbound HTTP that cannot hang a run forever.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// THE OUTAGE THIS IS THE FIX FOR, WHICH HAPPENED IN THE OTHER CODEBASE FIRST
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// The founder's own outbound engine (`growth/`) went dark for a full day: 798 engine ticks started,
// none finished, zero emails sent, and NOTHING IN THE LOGS. The cause was a fetch whose timeout
// guarded the headers and not the body — a `setTimeout(() => ctrl.abort())` cleared in a `finally`
// that ran when the response resolved, so `res.text()` streamed afterwards with the abort disarmed.
// One stranger's web server returned headers and then trickled its body forever, the sweep's
// deterministic order re-claimed the same lead at the head of every subsequent tick, and the whole
// machine died quietly because nothing was erroring.
//
// The product's own GTM had the same shape in three places and WORSE: `gtm/discover-web.ts`,
// `gtm/firecrawl.ts` and `gtm/enrich.ts` each called `fetch` with no signal at all, followed by an
// unguarded `await res.text()`. Not a timer that stood down early — no timer.
//
// That matters more here than it did there, because these run inside a CUSTOMER's task. A hung
// provider holds the run until the sandbox's runtime limit, and `STANDARD.md` §3 already records
// that "a stuck run distinguishable from a patient one" is unbuilt — so the failure is silent by
// construction, on somebody else's business, and the first anyone knows is a campaign that stopped.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// WHY `AbortSignal.timeout` AND NOT A CONTROLLER PLUS A TIMER
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// The hand-rolled version is what broke, and it broke in the way that reads as correct: everybody
// remembers to `clearTimeout` in a `finally`, and the `finally` runs at exactly the wrong moment.
// `AbortSignal.timeout(ms)` is armed by the runtime for a fixed wall-clock duration and is not
// something a caller can accidentally stand down — the body read is inside the deadline because
// there is nothing to clear.
//
// The trade is that the deadline covers the WHOLE exchange rather than resetting per byte, which is
// the behaviour we want anyway: what these calls need is a bound on "how long can this cost me",
// not on "how long between packets". A slow-but-progressing provider that takes longer than the
// deadline is one we should give up on, because a run has a runtime limit and a cost ceiling.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// AND IT RETURNS THE TEXT
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// Deliberately not a `Response`. Handing one back would put the body read outside the deadline
// again the moment a caller forgot — which is precisely the bug — so the read happens here, under
// the same signal, and the caller gets bytes it cannot un-read.

/** Long enough for a slow provider, short enough that a run does not die of it. */
export const DEFAULT_DEADLINE_MS = 30_000;

export interface DeadlineResult {
  ok: boolean;
  /** 0 when nothing was reached at all — a network error, a DNS failure, or the deadline. */
  status: number;
  text: string;
  /** Parsed when the body is JSON. A non-JSON body is a gateway page, not a result. */
  json?: unknown;
  /** Present only on failure, in a form safe to log. Never contains the request. */
  detail?: string;
  /** True when the deadline fired, so a caller can say so rather than reporting "network error". */
  timedOut?: boolean;
}

/**
 * A request with a hard wall-clock bound covering headers AND body.
 *
 * Never throws. Every one of these calls sits inside a task that has better things to do than
 * unwind a stack because a third party is down, and the three original call sites all wanted a
 * result object anyway — two of them had already hand-rolled one, differently.
 */
export async function fetchWithDeadline(
  url: string,
  init: RequestInit = {},
  opts: { deadlineMs?: number; redact?: (s: string) => string } = {},
): Promise<DeadlineResult> {
  const deadlineMs = opts.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const clean = opts.redact ?? ((s: string) => s);
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(deadlineMs) });
    // INSIDE the deadline, and this line is the whole point of the module.
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      /* a non-JSON body is a gateway page, not a result */
    }
    return { ok: res.ok, status: res.status, text, json };
  } catch (e) {
    const err = e as { name?: string; message?: string };
    // `TimeoutError` is what `AbortSignal.timeout` raises; `AbortError` is a caller-cancelled
    // request. Named apart because "we gave up after 30s" and "something went wrong" send whoever
    // reads the trace to completely different places.
    const timedOut = err?.name === "TimeoutError";
    return {
      ok: false,
      status: 0,
      text: "",
      timedOut,
      detail: clean(
        timedOut
          ? `no answer within ${Math.round(deadlineMs / 1000)}s`
          : `unreachable: ${err?.message ?? "network error"}`,
      ),
    };
  }
}
