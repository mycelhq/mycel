/**
 * The client. Runs in a founder's customer's browser, so every line here is a line shipped to
 * someone who did not ask for it — which is why there are no dependencies and no framework.
 *
 * Four things it has to get right, in the order they bite:
 *
 * 1. **No-op when unconfigured.** A generated product that a founder clones and runs locally must
 *    send nothing, ever, without them having to remember to turn something off. `enabled: false`
 *    or an empty endpoint and `track()` becomes a function that returns.
 *
 * 2. **Consent before storage.** Nothing is written to `localStorage` and nothing is queued until
 *    `readConsent() === "granted"`. Note the ordering: the anonymous id is minted lazily INSIDE the
 *    grant check, so an unconsented visitor leaves no trace at all. `consent.ts` explains the rest.
 *
 * 3. **Survive unload.** Most of what a funnel needs to know happens on the page someone is
 *    leaving — the abandon IS the signal. A plain `fetch` on `pagehide` is cancelled with the
 *    document, so `sendBeacon` is the primary transport and `fetch(keepalive)` the fallback, and
 *    both are wired to `visibilitychange`/`pagehide` rather than `unload` (which Safari and the
 *    bfcache treat as advisory at best).
 *
 * 4. **Stay bounded.** A queue with no ceiling on a single-page app that never navigates is a
 *    memory leak with a network egress bill attached.
 */
import { anonymousId, forgetEverything, onConsentChange, readConsent, sessionId } from "./consent";
import { analyseFunnel, stepIndex, type FunnelDefinition } from "./funnel";
import { redactEventName, redactPath, redactProps } from "./redact";
import { LIMITS, RESERVED, INSIGHT_VERSION, type InsightBatch, type InsightConfig, type InsightEvent, type InsightPropValue } from "./types";

export interface Insight {
  /** Record an event. Silently does nothing when unconfigured or unconsented — never throws. */
  track(name: string, props?: Record<string, unknown>): void;
  /** Record a pageview for `path` (defaults to the current location). Redacted before it is queued. */
  pageview(path?: string): void;
  /** Send whatever is queued now. Returns a promise for tests; callers may ignore it. */
  flush(): Promise<void>;
  /** Detach listeners and timers. The provider calls this on unmount so HMR doesn't stack them. */
  shutdown(): void;
  /** False when this instance will never send anything. Lets a caller skip rendering a banner. */
  readonly configured: boolean;
}

/** The no-op. Returned rather than `null` so callers never need a null check on a hot path. */
const DEAD: Insight = {
  track: () => {},
  pageview: () => {},
  flush: async () => {},
  shutdown: () => {},
  configured: false,
};

const hasWindow = (): boolean => typeof window !== "undefined";

export function createInsight(config: InsightConfig = {}): Insight {
  const endpoint = config.endpoint ?? "/api/insight";
  const enabled = config.enabled !== false && !!endpoint;
  // Server-side render, or switched off: hand back something inert. Doing this HERE rather than at
  // each call site means there is exactly one place that decides, and it decides once.
  if (!enabled || !hasWindow()) return DEAD;

  const funnel = config.funnel ? ({ name: config.funnel.name, steps: config.funnel.steps } as FunnelDefinition) : null;

  let queue: InsightEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let live = readConsent() === "granted";
  let stopped = false;
  /**
   * Whether the funnel DECLARATION still needs to travel. Set once a batch carrying it was accepted
   * — not once one was attempted, because a send that failed is requeued and the kernel would then
   * never learn the step order. See `types.ts` for why the declaration rides on the batch at all.
   */
  let declared = false;

  const debug = (...args: unknown[]) => {
    if (config.debug) console.debug("[insight]", ...args);
  };

  /** Enqueue, capped. When full the OLDEST event goes: the newest describe where the customer is
   *  now, which is the question a funnel is asking. */
  function enqueue(event: InsightEvent): void {
    if (!live || stopped) return;
    if (queue.length >= LIMITS.maxQueue) queue.shift();
    queue.push(event);
    debug("queued", event.n, queue.length);
    if (queue.length >= LIMITS.batch) void flush();
    else schedule();
  }

  function schedule(): void {
    if (timer || stopped) return;
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, LIMITS.flushIntervalMs);
    // Node's timers keep the process alive; a browser's don't. `unref` is guarded because it only
    // exists off-browser, and this file is imported by the package's own tests.
    (timer as unknown as { unref?: () => void }).unref?.();
  }

  /**
   * Post one batch.
   *
   * `sendBeacon` first: it is the only transport the browser promises to finish after the document
   * is gone. It returns false when the payload exceeds the user agent's queue budget (~64KB), which
   * is exactly the case `fetch(keepalive)` is for. If both refuse, the events go BACK on the queue
   * — at the front, so ordering survives — because a failed send during normal browsing will be
   * retried on the next flush, and a failed send during unload was lost either way.
   */
  async function send(batch: InsightBatch): Promise<boolean> {
    const body = JSON.stringify(batch);
    if (body.length > LIMITS.maxBodyBytes) {
      // Can only happen if a single event is pathological, since batch size is already capped.
      // Dropping is correct: the kernel would refuse it, and retrying a 413 forever is a loop.
      debug("dropping oversized batch", body.length);
      return true;
    }
    if (config.transport) return await config.transport(endpoint, body);
    try {
      const beacon = navigator?.sendBeacon;
      // The blob's type matters: `application/json` makes this a CORS preflight-triggering request
      // in cross-origin mode, and `sendBeacon` cannot preflight. Same-origin (the default endpoint)
      // it is simply the correct content type, and the kernel parses the body either way.
      if (beacon && beacon.call(navigator, endpoint, new Blob([body], { type: "application/json" }))) return true;
    } catch {
      // Beacon rejected the payload or the origin. Fall through.
    }
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        keepalive: true,
        // Analytics must never carry the customer's session to a third party, and must never be
        // the reason a cross-origin cookie gets set.
        credentials: "omit",
        mode: "cors",
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async function flush(): Promise<void> {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!live || queue.length === 0) return;
    const events = queue.splice(0, LIMITS.maxEventsPerBatch);
    const session = sessionId(LIMITS.sessionIdleMs);
    const sendingDeclaration = !!funnel && !declared;
    const batch: InsightBatch = {
      v: INSIGHT_VERSION,
      aid: anonymousId(),
      sid: session.id,
      ...(funnel ? { f: funnel.name } : {}),
      ...(sendingDeclaration ? { fs: funnel!.steps.slice(0, LIMITS.maxFunnelSteps) } : {}),
      events,
    };
    if (config.key) (batch as InsightBatch & { k: string }).k = config.key;
    const ok = await send(batch);
    if (ok && sendingDeclaration) declared = true;
    if (!ok) {
      queue = [...events, ...queue].slice(0, LIMITS.maxQueue);
      debug("send failed, requeued", queue.length);
    }
  }

  function track(name: string, props?: Record<string, unknown>): void {
    if (!live || stopped) return;
    const n = redactEventName(name);
    if (!n) return;
    const event: InsightEvent = { n, t: Date.now() };
    const path = currentPath();
    if (path) event.p = path;
    // Tagging the step here — at the edge, from the product's own declaration — is what lets the
    // kernel compute drop-off without ever holding a per-visitor timeline to reconstruct it from.
    if (funnel && stepIndex(funnel, n) >= 0) event.s = n;
    const clean = redactProps(props);
    if (clean) event.props = clean;
    enqueue(event);
  }

  function pageview(path?: string): void {
    if (!live || stopped) return;
    // A new session gets one marker event, which is how the kernel counts sessions without keeping
    // a set of session ids per day (see consent.ts).
    const session = sessionId(LIMITS.sessionIdleMs);
    if (session.fresh) enqueue({ n: RESERVED.session, t: Date.now() });
    enqueue({ n: RESERVED.pageview, t: Date.now(), p: redactPath(path ?? currentPath()) });
  }

  function currentPath(): string {
    // `pathname` only. Never `href`, never `search` — see the header of redact.ts for the magic
    // sign-in link this rule exists because of.
    try {
      return redactPath(window.location?.pathname ?? "/");
    } catch {
      return "/";
    }
  }

  // ── lifecycle ────────────────────────────────────────────────────────────────────────────────
  const offConsent = onConsentChange((value) => {
    live = value === "granted";
    if (!live) {
      // Withdrawal drops what was queued as well as what was stored. Sending a batch collected
      // under a consent that has since been withdrawn would make the withdrawal a formality.
      queue = [];
      forgetEverything();
    }
  });

  const onHide = () => {
    if (document.visibilityState === "hidden") void flush();
  };
  const onPageHide = () => void flush();
  window.addEventListener("visibilitychange", onHide);
  window.addEventListener("pagehide", onPageHide);

  return {
    track,
    pageview,
    flush,
    shutdown() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      offConsent();
      window.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onPageHide);
    },
    configured: true,
  };
}

// ── singleton ──────────────────────────────────────────────────────────────────────────────────
// One instance per document. `track()` is called from components that know nothing about wiring, so
// there has to be an ambient one; it is deliberately the only global state in the package.
let current: Insight | null = null;

export function initInsight(config: InsightConfig = {}): Insight {
  current?.shutdown();
  current = createInsight(config);
  return current;
}

export function getInsight(): Insight {
  return current ?? DEAD;
}

/** The ambient `track`. A no-op until `initInsight` has run, which is the safe direction. */
export function track(name: string, props?: Record<string, InsightPropValue | unknown>): void {
  getInsight().track(name, props as Record<string, unknown> | undefined);
}

export { analyseFunnel };
