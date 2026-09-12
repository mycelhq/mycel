/**
 * PRODUCT EVENTS FROM THE KERNEL.
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS DID NOT EXIST, AND WHAT IT COST
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Every product event in this system was captured from `cloud` — signup, onboarding steps, checkout,
 * deliverable released, invoice chased. The kernel emitted none, and the kernel is where the work
 * actually happens: it raises the client asks, arms the waits, resumes them, and produces the
 * deliverables.
 *
 * The hole that leaves is not academic and it sits exactly where this product fails. Production has
 * raised FIFTY-ONE client asks and had THREE answered. The portal fires `portal_request_answered`,
 * so the three are visible. Nothing fires when an ask goes out, so the fifty-one are not — the
 * numerator is instrumented and the denominator is not, which makes the single worst conversion
 * rate in the product invisible in the only place anybody would look for it.
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT THIS IS NOT
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Not `posthog-node`. One dependency in a worker that already carries a sandbox SDK and a browser
 * driver is a dependency that has to be justified, and this is a POST with a JSON body — the same
 * decision `cloud/lib/analytics-server.ts` records for itself.
 *
 * Not a queue, not a retry, not a flush-on-exit. Analytics must never be able to delay a run, fail a
 * run, or hold the process open at shutdown. Every call here is fire-and-forget with a short
 * deadline, and a failure is logged at debug and dropped. The rule is that a broken PostHog changes
 * nothing about whether a founder's month-end close goes out.
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * THE IDENTITY IS THE PROJECT, NOT A PERSON
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The kernel has no session and no user. It knows which business the work belongs to, and that is
 * the right grain for every question anybody asks of these events: how many asks does a business
 * send before one comes back, how long from ask to answer, does answering actually restart the work.
 * Sending a fabricated user id to make the shape match cloud's would be inventing a person.
 */
/**
 * Read at CALL time, not at import time.
 *
 * Two reasons, and the second is the one that bites. A worker that loads its secrets after the
 * module graph is built would capture `undefined` forever and silently send nothing — the failure
 * mode is an empty dashboard with no error anywhere, which is the hardest kind to notice. And a test
 * cannot exercise a call site whose key was frozen before the test file ran. The cost is one
 * `process.env` lookup on a path that is about to open a socket.
 */
const key = () => process.env.MYCEL_POSTHOG_KEY ?? process.env.NEXT_PUBLIC_POSTHOG_KEY;
const host = () =>
  (process.env.MYCEL_POSTHOG_HOST ?? process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com")
    .trim()
    .replace(/\/$/, "");

/** Names live here so a typo is a compile error rather than a silently separate series. */
export const KERNEL_EVENT = {
  /** An ask went out to a client. The denominator the portal's answer event never had. */
  requestRaised: "request_raised",
  /** The founder answered on their own behalf, rather than the client answering in the portal. */
  requestAnsweredByFounder: "request_answered_by_founder",
  /** An engagement parked, waiting on somebody. */
  waitArmed: "wait_armed",
  /** A parked engagement picked itself back up. The proof that answering an ask does anything. */
  waitResumed: "wait_resumed",
  /** A wait that can never be satisfied — see `evaluateWait`'s dead reasons. */
  waitDead: "wait_dead",
} as const;

export type KernelEvent = (typeof KERNEL_EVENT)[keyof typeof KERNEL_EVENT];

type Props = Record<string, string | number | boolean | null | undefined>;

/**
 * Send one event. Never throws, never awaited for correctness.
 *
 * Callers use `void capture(...)` deliberately: there is nothing downstream of an analytics write,
 * and `await` here would put PostHog's latency on the critical path of a client's work.
 */
export function capture(projectId: string | undefined, event: KernelEvent, props?: Props): void {
  const k = key();
  if (!k || !projectId) return;
  void fetch(`${host()}/capture/`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // Five seconds. Long enough for a working endpoint, short enough that a hanging one cannot
    // accumulate sockets on a worker that is otherwise busy.
    signal: AbortSignal.timeout(5_000),
    body: JSON.stringify({
      api_key: k,
      event,
      distinct_id: projectId,
      properties: { ...props, project_id: projectId, $lib: "mycel-kernel" },
    }),
  }).catch((e) => {
    // Debug, not error. A PostHog outage is not an incident in this product, and logging it at
    // error level would train everybody to ignore the log that does matter.
    console.debug(`[mycel] analytics ${event} dropped:`, (e as Error)?.message);
  });
}
