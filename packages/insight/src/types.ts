/**
 * The wire contract between a founder's product and the kernel's ingest endpoint.
 *
 * Field names are short because this payload is sent from a customer's browser on a page they are
 * trying to leave — `sendBeacon` competes with unload, and a batch of 20 events is the difference
 * between one packet and two. That is the only reason for the terseness; nothing here is obfuscated.
 *
 * The kernel has its OWN copy of this shape (`kernel/harness/src/insight/schema.ts`) and validates
 * against it rather than importing this file. That duplication is intentional: the kernel ships as
 * a container without this package, and more importantly an ingest endpoint must treat its client
 * as hostile — a shared type would make it tempting to trust the sender's idea of the schema.
 *
 * NOTE WHAT IS ABSENT. There is no `project_id`, no IP, no user agent, no referrer, no URL, no
 * cookie. The project is derived server-side from the ingest key (see `keys.ts`); everything else
 * is either unnecessary to answer "where do customers get stuck" or actively hazardous to hold.
 */

/** Schema version. Bumped only for a breaking change; the kernel rejects versions it doesn't know. */
export const INSIGHT_VERSION = 1 as const;

/** Props are scalars only. An object would smuggle arbitrary depth (and arbitrary PII) past the caps. */
export type InsightPropValue = string | number | boolean | null;

export interface InsightEvent {
  /** Event name. `snake_case`, ≤ 64 chars, from a set the product controls. */
  n: string;
  /** Client wall-clock, ms since epoch. Advisory: the kernel buckets by ITS clock (see ingest.ts). */
  t: number;
  /** Redacted path — pathname only, query and hash already stripped, id-shaped segments masked. */
  p?: string;
  /** The declared funnel step this event completes, when it is one. */
  s?: string;
  /** Bounded, scalar-only, key-filtered. See `redact.ts` for what never survives. */
  props?: Record<string, InsightPropValue>;
}

export interface InsightBatch {
  v: typeof INSIGHT_VERSION;
  /** Anonymous id: random, first-party, cleared on consent withdrawal. Never derived from the user. */
  aid: string;
  /** Session id: random, per-tab, expires with inactivity. Makes "sessions" countable without a set. */
  sid: string;
  /** The funnel these `s` values belong to, so the kernel can attribute steps to a declaration. */
  f?: string;
  /**
   * The funnel's ORDERED steps. Sent on the first batch after init, and then not again.
   *
   * The kernel cannot compute drop-off from step counts alone: "which step loses people" is a
   * question about ORDER, and the order lives in the product's `defineFunnel` call. Something has to
   * carry it across, and the alternatives are worse. Making the summary caller pass the step list
   * means the agent restates the product's own declaration and gets it subtly wrong; a separate
   * registration endpoint is a second thing to deploy, and a first thing to forget.
   *
   * Trusting the sender with it is a real trade, and a bounded one. The ingest key's entire
   * authority is "append events to this one project", so a poisoned step list garbles exactly the
   * funnel report of the project that key already writes to — no other tenant, and nothing that
   * reads. The kernel caps the length and redacts each name like any other identifier.
   *
   * Once, rather than every batch, because this rides in a `sendBeacon` on a page someone is leaving
   * and the whole shape of this payload is "fit in one packet".
   */
  fs?: readonly string[];
  events: InsightEvent[];
}

/**
 * Limits, enforced on BOTH sides.
 *
 * The client enforces them so a founder's own buggy `track()` loop can't ship a megabyte from a
 * customer's phone. The kernel enforces them again because the client is not the only thing that
 * can post to the endpoint, and the second enforcement is the one that counts.
 */
export const LIMITS = {
  /** Flush at this many queued events, whichever comes first with the timer. */
  batch: 20,
  /** Hard cap the kernel refuses beyond. Above the flush size so a retry can carry a backlog. */
  maxEventsPerBatch: 50,
  /** Bytes. A batch at every other cap sits around 6KB, so this is ~10× headroom, not a target. */
  maxBodyBytes: 64 * 1024,
  maxEventName: 64,
  maxPathLength: 200,
  maxProps: 12,
  maxPropKey: 40,
  maxPropString: 120,
  /** Steps in a declared funnel. A funnel longer than this is a journey map, not a funnel. */
  maxFunnelSteps: 20,
  /** Queue ceiling in the client. Beyond this the OLDEST events are dropped — see client.ts. */
  maxQueue: 200,
  /** ms. Long enough to coalesce a burst of clicks, short enough that a bounce still reports. */
  flushIntervalMs: 5_000,
  /** ms of inactivity before a new session id is minted. The web analytics convention. */
  sessionIdleMs: 30 * 60_000,
} as const;

/** Config the product supplies. `enabled: false`, or an empty `endpoint`, means the whole package no-ops. */
export interface InsightConfig {
  /**
   * Master switch. Defaults to true, but the provider passes `false` whenever the product has no
   * ingest key configured — so a founder who clones the template and runs it locally gets a product
   * that sends nothing, rather than one that fails requests against an endpoint that isn't there.
   */
  enabled?: boolean;
  /**
   * Where batches go. Defaults to the product's OWN route handler on its own origin, which is what
   * keeps the ingest key on the server (see `next.tsx`). Point it at the kernel directly only if
   * you have accepted that the key is then public.
   */
  endpoint?: string;
  /**
   * The per-project ingest key, only when talking to the kernel directly. Normally undefined: the
   * route handler attaches it server-side and the browser never sees it.
   */
  key?: string;
  /** The funnel this product declares. Optional: events still land without one. */
  funnel?: { name: string; steps: readonly string[] };
  /** Escape hatch for tests and for founders who want to see what would be sent. */
  debug?: boolean;
  /**
   * Injected transport. Exists so the queue, the batching and the consent gate can be tested
   * without a browser or a network — the alternative is mocking `navigator.sendBeacon`, which
   * tests the mock. Returns false to signal "not sent", which is what triggers a requeue.
   */
  transport?: (url: string, body: string) => boolean | Promise<boolean>;
}

/** Reserved event names the kernel understands without the product declaring them. */
export const RESERVED = {
  pageview: "$pageview",
  session: "$session",
} as const;
