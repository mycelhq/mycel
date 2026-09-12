// Voyager failure classification, the per-connection circuit breaker, and the one line a founder
// should read when LinkedIn stops answering.
//
// ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────────────────────────
// On 2026-08-18 the kernel logged 35,456 copies of
//
//     [mycel] linkedin action failed: voyager profile 410
//
// in a single day — 308 of them every five minutes, on the dot, for ten hours, from one worker. That
// is the GTM sequencer tick (`gtm/sequence.ts`, TICK_SECONDS = 300) fanning out across every project
// schedule, each dispatching `view_profile` / `send_invite`, each doing one profile read, each
// getting the same answer. Nothing in the stack treated the 35,456th identical failure differently
// from the first: `asResult` logged it, the case was parked for an hour, the next tick tried again.
//
// The bug was not the 410. LinkedIn retiring `/identity/profiles/{id}/profileView` is a thing that
// was always going to happen one day. The bug was that a PERMANENT, ACCOUNT-WIDE failure was handled
// as if it were a per-prospect blip:
//
//   · it had no `code`, so the sequencer's "named problems wait a day" branch never fired;
//   · it did not construct `LinkedInChallengeError`, so the connection was never stamped and
//     `open()`'s existing pre-flight refusal never engaged;
//   · nothing counted consecutive failures, so there was no point at which the system concluded that
//     the account — not the prospect — was the thing that was broken;
//   · and every attempt cost a real proxied request to LinkedIn from a session that was already
//     failing, which is exactly how an account gets restricted.
//
// So this module answers three questions that nothing owned before: is this failure PERMANENT or
// TRANSIENT, may this connection make a Voyager call RIGHT NOW, and has a human already been told.
//
// ── WHAT IS PERMANENT ────────────────────────────────────────────────────────────────────────────
//   · `session` — 401/403/999/checkpoint/captcha. The cookies are dead or the account is flagged.
//     Only a reconnect fixes it, and every further request makes it worse.
//   · `gone` — 410. LinkedIn retired the endpoint. No amount of waiting brings it back; it takes a
//     deploy. Retrying is pure noise and pure egress.
// Both stop the connection. They differ only in the sentence a founder reads, and that difference is
// the whole point — "reconnect LinkedIn" is useless advice when the fix is our code.
//
// ── WHAT IS TRANSIENT ────────────────────────────────────────────────────────────────────────────
// 429 (rate limit), 5xx (LinkedIn is having a bad day), timeouts and proxy blips. These get
// exponential backoff keyed on the connection, not a stop: 30s, 60s, 2m, 4m … capped at 30 minutes,
// cleared by the first success. A blip must not look like a dead account, and a dead account must
// not look like a blip.
//
// State is per-process and in-memory ON PURPOSE. It is a rate limiter, not a record: the durable
// half is the `linkedin_challenge` / `linkedin_unhealthy` stamp `connect.ts` writes on the Connection
// row, which is what makes another replica — and the pacing gate every scheduler already consults —
// skip the account too.

/** How a Voyager failure should be treated. */
export type VoyagerFailureKind = "session" | "gone" | "rate_limit" | "server" | "network" | "unknown";

export interface VoyagerFailure {
  kind: VoyagerFailureKind;
  /** Permanent = stop the connection. Transient = back off and try later. */
  permanent: boolean;
  /** The named code that travels to the sequencer (which waits a DAY on any code, not an hour). */
  code?: string;
  /** ONE sentence, written for the founder. */
  detail: string;
}

export const SESSION_DEAD_CODE = "linkedin_session_dead";
export const ENDPOINT_GONE_CODE = "linkedin_endpoint_gone";
export const PROFILE_ENDPOINT_UNKNOWN_CODE = "linkedin_profile_endpoint_unknown";
export const UNHEALTHY_CODE = "linkedin_unhealthy";
export const BACKOFF_CODE = "linkedin_backoff";

/**
 * LinkedIn answered 410 Gone — the endpoint we call no longer exists.
 *
 * Distinct from `LinkedInChallengeError` because the remedy is distinct: a challenge is fixed by the
 * founder reconnecting, a 410 is fixed by us shipping a new endpoint. Telling a founder to reconnect
 * for a 410 sends them to do something that cannot possibly work.
 */
export class LinkedInGoneError extends Error {
  readonly code = ENDPOINT_GONE_CODE;
  constructor(
    public op: string,
    public status: number,
    public connectionId: string,
  ) {
    super(
      `LinkedIn no longer serves the ${op} endpoint (410) — this needs a fix on our side, not a reconnect`,
    );
    this.name = "LinkedInGoneError";
  }
}

/**
 * The capture instructions, written once, for the one failure nobody can debug from a log line.
 *
 * When every profile-read candidate has been tried and none of them returned a shape we recognise,
 * the ONLY thing that fixes it is somebody with a real logged-in LinkedIn session copying the
 * request the web app itself makes. So the failure says exactly that, with the six things to copy —
 * an error that tells a founder what to click is worth more than one that tells them a status code.
 */
export const PROFILE_DEVTOOLS_CAPTURE = [
  "Open linkedin.com in a browser where you are logged in, open devtools → Network, filter on",
  '"voyager", and load any profile page (linkedin.com/in/<someone>). Find the request that returns',
  "that person's name/headline/photo, then copy SIX things from it:",
  "(1) the full request URL including queryId= and variables= (or decorationId=),",
  "(2) the request method,",
  "(3) the `accept` request header,",
  "(4) any `x-li-*` request headers,",
  "(5) the response status,",
  "(6) the first ~200 lines of the response JSON (redact nothing but your own name if you like —",
  "    the SHAPE is what matters).",
  "Then set MYCEL_LINKEDIN_QID_PROFILE (the queryId) or MYCEL_LINKEDIN_PROFILE_DECORATION (the",
  "decorationId) from it, or open an issue with the capture so the parser can be taught the shape.",
  "packages/linkedin/scripts/verify-profile.ts runs the same ladder against a session you paste in",
  "and prints which candidate answered.",
].join(" ");

/**
 * Every candidate profile-read endpoint was tried and none returned a profile we could parse.
 *
 * PERMANENT on purpose, and distinct from `gone`: a 410 names one dead endpoint, this names the
 * state where we have run out of guesses. Retrying it costs a founder's account real requests from
 * a session that is already being refused, and cannot succeed until somebody captures the shape.
 */
export class LinkedInProfileEndpointUnknownError extends Error {
  readonly code = PROFILE_ENDPOINT_UNKNOWN_CODE;
  constructor(
    /** One line per candidate: what was tried and what came back. The diagnosis, not a stack. */
    public attempts: string[],
    public connectionId?: string,
  ) {
    super(
      "LinkedIn did not return a profile from any endpoint we know: " +
        (attempts.length ? attempts.join("; ") : "no candidate was enabled") +
        ". This needs a fix on our side, not a reconnect. " +
        PROFILE_DEVTOOLS_CAPTURE,
    );
    this.name = "LinkedInProfileEndpointUnknownError";
  }
}

/** The breaker is open (or backing off) — refused before a single byte leaves the building. */
export class LinkedInUnavailableError extends Error {
  constructor(
    public code: string,
    message: string,
    public connectionId: string,
  ) {
    super(message);
    this.name = "LinkedInUnavailableError";
  }
}

/**
 * Classify a thrown Voyager condition.
 *
 * Deliberately tolerant of a bare `Error` with a message, because that is what the sibling modules
 * throw (`voyager profile 410`, `voyager search 429`, `LinkedIn /me returned 503`) and rewriting all
 * of them into typed errors would be a much larger change than the incident justifies. The typed
 * errors are checked first, so a real `LinkedInChallengeError` is never decided by a regex.
 */
export function classifyVoyagerFailure(e: unknown): VoyagerFailure {
  const err = e as { name?: string; code?: string; message?: string; status?: number } | undefined;
  const name = err?.name ?? "";
  const message = String(err?.message ?? e ?? "");

  if (name === "LinkedInChallengeError" || err?.code === "challenged") {
    return {
      kind: "session",
      permanent: true,
      code: SESSION_DEAD_CODE,
      detail: "LinkedIn challenged this session — reconnect the account before anything else goes out",
    };
  }
  if (name === "LinkedInGoneError" || err?.code === ENDPOINT_GONE_CODE) {
    return { kind: "gone", permanent: true, code: ENDPOINT_GONE_CODE, detail: message };
  }
  if (name === "LinkedInProfileEndpointUnknownError" || err?.code === PROFILE_ENDPOINT_UNKNOWN_CODE) {
    return { kind: "gone", permanent: true, code: PROFILE_ENDPOINT_UNKNOWN_CODE, detail: message };
  }
  if (name === "LinkedInUnavailableError") {
    return { kind: "unknown", permanent: false, code: err?.code, detail: message };
  }

  const status = err?.status ?? statusInMessage(message);
  if (status === 401 || status === 403 || status === 999) {
    return {
      kind: "session",
      permanent: true,
      code: SESSION_DEAD_CODE,
      detail: "LinkedIn rejected this session — reconnect the account before anything else goes out",
    };
  }
  if (status === 410) {
    return {
      kind: "gone",
      permanent: true,
      code: ENDPOINT_GONE_CODE,
      detail: `LinkedIn answered 410 Gone (${message}) — the endpoint was retired and this needs a fix on our side`,
    };
  }
  if (status === 429) return { kind: "rate_limit", permanent: false, detail: message };
  if (status !== undefined && status >= 500 && status <= 599) {
    return { kind: "server", permanent: false, detail: message };
  }
  if (/timed out|timeout|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed|proxy/i.test(message)) {
    return { kind: "network", permanent: false, detail: message };
  }
  return { kind: "unknown", permanent: false, detail: message };
}

/** The trailing status code the sibling modules put in their messages: `voyager profile 410`. */
function statusInMessage(message: string): number | undefined {
  const m = /\b(\d{3})\b/.exec(message);
  if (!m) return undefined;
  const n = Number(m[1]);
  return n >= 100 && n <= 999 ? n : undefined;
}

// ── The breaker ───────────────────────────────────────────────────────────────────────────────────

/** First transient backoff. Doubles per consecutive failure. */
export const BACKOFF_BASE_MS = 30_000;
/** Ceiling. Beyond this, waiting longer stops buying anything a scheduler tick would not. */
export const BACKOFF_MAX_MS = 30 * 60_000;
/**
 * Consecutive transient failures tolerated before the backoff starts.
 *
 * One is a blip and re-trying it immediately is correct. Two in a row on the same connection is a
 * pattern, and the burst this file exists to stop was a pattern from the first minute.
 */
export const TRANSIENT_GRACE = 1;

interface Health {
  /** Consecutive transient failures since the last success. */
  transient: number;
  /** Earliest next attempt, while backing off. */
  nextAttemptAt?: number;
  /** Set once a permanent failure is seen. Cleared only by a success (i.e. a reconnect). */
  stopped?: { code: string; detail: string; at: number };
  /** Whether the single actionable line has already been printed for the current stop. */
  announced?: boolean;
}

const health = new Map<string, Health>();

/** Injectable clock — the tests must not sleep for thirty seconds to prove a backoff doubles. */
let now: () => number = () => Date.now();
export function _setHealthClock(fn: (() => number) | null): void {
  now = fn ?? (() => Date.now());
}
export function _resetLinkedInHealth(): void {
  health.clear();
}

function stateOf(connectionId: string): Health {
  let s = health.get(connectionId);
  if (!s) {
    s = { transient: 0 };
    health.set(connectionId, s);
  }
  return s;
}

/**
 * May this connection call Voyager right now? Null = yes.
 *
 * This is the check that turns 3,700 failed requests an hour into zero. It costs a Map lookup and it
 * happens before the session is loaded, before the proxy is resolved and before any byte is spent.
 */
export function linkedinBlocked(connectionId: string): { code: string; detail: string } | null {
  const s = health.get(connectionId);
  if (!s) return null;
  if (s.stopped) return { code: s.stopped.code, detail: s.stopped.detail };
  if (s.nextAttemptAt && now() < s.nextAttemptAt) {
    const secs = Math.ceil((s.nextAttemptAt - now()) / 1000);
    return {
      code: BACKOFF_CODE,
      detail: `LinkedIn is failing for this account — backing off, next attempt in ${secs}s`,
    };
  }
  return null;
}

/** The backoff currently in force, in ms. 0 when there is none. Exposed for tests and for logging. */
export function linkedinBackoffMs(connectionId: string): number {
  const s = health.get(connectionId);
  if (!s?.nextAttemptAt) return 0;
  return Math.max(0, s.nextAttemptAt - now());
}

/** True while the connection is stopped on a permanent failure. */
export function linkedinStopped(connectionId: string): { code: string; detail: string } | null {
  const s = health.get(connectionId);
  return s?.stopped ? { code: s.stopped.code, detail: s.stopped.detail } : null;
}

/**
 * Record a failure and decide what happens next.
 *
 * `announce` is the answer to "should a human see this line?" — TRUE exactly once per stop, and once
 * per fresh backoff escalation. It is what replaces 35,456 identical lines with one.
 */
export function noteLinkedInFailure(
  connectionId: string,
  e: unknown,
  opts: { claim?: boolean } = {},
): VoyagerFailure & { announce: boolean; backoffMs: number } {
  // `claim` is what stops the wrong layer swallowing the one line.
  //
  // `voyager.ts` records the failure the moment it sees the status, because the breaker must close
  // before the next request is built. But at that depth there is no Connection — no name, no owner,
  // nobody to address — so it cannot say anything useful, and by CLAIMING the announcement it made
  // the layer that CAN (connect.ts's `announceOnce`, which holds the Connection) see
  // `announce: false` and stay quiet. The result was a permanent stop that logged nothing at all:
  // the one line this module exists to produce was being consumed by a caller that discards it.
  //
  // So recording and announcing are now separable. `claim: false` records the state and reports
  // what WOULD be announced without spending the once-per-stop right; the default keeps every
  // existing caller behaving exactly as before.
  const claim = opts.claim !== false;
  const f = classifyVoyagerFailure(e);
  const s = stateOf(connectionId);

  if (f.permanent) {
    const first = !s.stopped;
    if (first) s.stopped = { code: f.code ?? UNHEALTHY_CODE, detail: f.detail, at: now() };
    const announce = !s.announced;
    if (announce && claim) s.announced = true;
    return { ...f, announce, backoffMs: 0 };
  }

  s.transient++;
  if (s.transient <= TRANSIENT_GRACE) return { ...f, announce: false, backoffMs: 0 };
  const step = Math.min(BACKOFF_BASE_MS * 2 ** (s.transient - TRANSIENT_GRACE - 1), BACKOFF_MAX_MS);
  s.nextAttemptAt = now() + step;
  // Announce only when the backoff first engages; the doublings after that are the same story.
  const announce = s.transient === TRANSIENT_GRACE + 1;
  return { ...f, announce, backoffMs: step };
}

/**
 * Withdraw a permanent stop that a PROBE caused, while the prober still has candidates left.
 *
 * The one legitimate caller is the profile strategy ladder in profile.ts. A 410 there is information
 * about ONE candidate endpoint, not about the account — but `call()` cannot know that, so it stamps
 * the connection and the next candidate would be refused before it ever went out, and the ladder
 * could never get past its first dead rung.
 *
 * Narrow on purpose, and it is not a general "unstop" button:
 *   · it only clears when the stop carries `code` (so a session challenge recorded mid-ladder
 *     SURVIVES — a dead cookie is about the account and must still stop everything);
 *   · it leaves the transient backoff ladder alone, so a rate limit still slows us down;
 *   · and the ladder re-records a permanent stop itself when every candidate has been spent.
 */
export function clearLinkedInStop(connectionId: string, code: string): boolean {
  const s = health.get(connectionId);
  if (!s?.stopped || s.stopped.code !== code) return false;
  s.stopped = undefined;
  s.announced = false;
  return true;
}

// ── The invitation breaker ────────────────────────────────────────────────────────────────────────
//
// WHY THIS IS ITS OWN BREAKER AND NOT `nextAttemptAt`.
//
// An exhausted invitation allowance says nothing about whether the account can read its inbox, poll
// for acceptances, or open a profile — and those are exactly the calls that tell us when the
// allowance comes back. Putting a spent quota on the general backoff would silence the account
// wholesale for six hours to punish it for one verb.
//
// It is also kept OUT of the `health` map on purpose: `noteLinkedInSuccess` deletes that entry on
// any successful call, and a profile read succeeding two seconds later must not un-refuse the
// invitation LinkedIn just refused.
//
// WHAT IT REPLACES. A quota refusal is not transient in any useful sense. Retrying it produces no
// invitation, no information and no progress — only counter increments and log lines — and the
// counters it produces are read by the pacing multiplier, which then concludes the account is
// unhealthy on evidence the retry loop manufactured. So: refuse once, record once, wait a window
// that could plausibly change the answer, and stop.

/** How long each account-level cause is worth waiting before asking LinkedIn again. */
export const INVITE_REFUSAL_WAIT_MS: Record<string, number> = {
  // The rolling window returns allowance a few at a time as old invitations age out. Twice a day is
  // often enough to catch that and far too rare to look like a retry loop.
  weekly: 12 * 60 * 60_000,
  // Nothing changes here until somebody withdraws, and withdrawing is a deliberate act, not a tick.
  pending: 12 * 60 * 60_000,
  // A human has to clear this one. A day is the shortest wait that is not pretending otherwise.
  restricted: 24 * 60 * 60_000,
};
const DEFAULT_INVITE_WAIT_MS = 12 * 60 * 60_000;

interface InviteRefusalState {
  code: string;
  detail: string;
  until: number;
}
const inviteRefusals = new Map<string, InviteRefusalState>();

export function _resetInviteRefusals(): void {
  inviteRefusals.clear();
}

/**
 * May this connection try to INVITE right now? Null = yes.
 *
 * Checked before pacing and before the profile lookup an invitation needs, so a refused account
 * spends neither a Voyager round-trip nor a store read proving what it already knows.
 */
export function invitesBlocked(connectionId: string): { code: string; detail: string } | null {
  const s = inviteRefusals.get(connectionId);
  if (!s) return null;
  if (now() >= s.until) {
    inviteRefusals.delete(connectionId);
    return null;
  }
  const mins = Math.ceil((s.until - now()) / 60_000);
  return { code: s.code, detail: `${s.detail} (not retrying for another ${mins} min)` };
}

/**
 * Record an account-level invitation refusal, and answer the only question the caller needs:
 * IS THIS THE FIRST ONE OF THIS EPISODE?
 *
 * `first` is what the engagement counter should be keyed on. `engagement.flagged` is meant to
 * measure "how often does the platform disagree with our model of this account" — one exhausted
 * window is ONE such disagreement, however many prospects were queued behind it. Counting per
 * attempt turns a single Tuesday evening into three hundred pieces of evidence, against a
 * denominator (`sent`) that by definition cannot grow while the refusal is in force.
 */
export function noteInviteRefusal(
  connectionId: string,
  reason: string,
  code: string,
  detail: string,
): { first: boolean; untilMs: number } {
  const existing = inviteRefusals.get(connectionId);
  const active = !!existing && now() < existing.until;
  const untilMs = INVITE_REFUSAL_WAIT_MS[reason] ?? DEFAULT_INVITE_WAIT_MS;
  inviteRefusals.set(connectionId, { code, detail, until: now() + untilMs });
  // A DIFFERENT cause during an active episode is new information (weekly → restricted matters), so
  // it is announced and counted again. The same cause repeating is not.
  return { first: !active || existing.code !== code, untilMs };
}

/** An invitation went through. Whatever LinkedIn was refusing, it is not refusing it now. */
export function clearInviteRefusal(connectionId: string): void {
  inviteRefusals.delete(connectionId);
}

/**
 * A call succeeded. Clears everything — including a permanent stop, because the only way a stopped
 * connection makes a successful call again is that a founder reconnected it or we shipped the fix.
 */
export function noteLinkedInSuccess(connectionId: string): void {
  const s = health.get(connectionId);
  if (!s) return;
  health.delete(connectionId);
}

/**
 * The one line. `owner` is whatever the host can name the account by — a handle, an email, an id.
 *
 * Written as an instruction rather than a stack trace because the audience is a founder reading a
 * log tail or an alert, and the question they need answered is "what do I do".
 */
// ── What a founder is told when a connection stops ───────────────────────────────────────────────
//
// One stop, three audiences: the connection screen in cloud, the channels screen in growth, and an
// email that arrives whether or not anybody opened either. They must say the SAME thing, because a
// founder who reads "reconnect LinkedIn" in their inbox and "we are fixing it" on the screen has
// learned only that the software does not know.
//
// The split that matters is the remedy, not the status code. A dead session is fixed by the founder
// in two minutes. A retired endpoint is fixed by us shipping code, and telling them to reconnect
// would send them to do something that cannot possibly work — they would do it, it would fail, and
// they would conclude the product is broken in a way they cannot escape. That is worse than
// silence, which is the only thing worse than silence.

export type StopCause = "session" | "endpoint";

export interface StopNotice {
  code: string;
  cause: StopCause;
  /** True when reconnecting is the fix. False means it is ours and reconnecting is a wasted trip. */
  reconnect: boolean;
  /** Subject-line grade: what happened, in one clause. */
  headline: string;
  /** What has actually stopped, and what that means for their week. */
  what: string;
  /** Exactly what to do. An instruction, or an honest "nothing — it is on us". */
  fix: string;
}

/** Session-dead codes vs. our-fault codes. Anything unrecognised is treated as a session stop,
 *  because that is the branch where the founder can act and the cheaper mistake to make. */
export function stopCauseOf(code: string | undefined): StopCause {
  return code === ENDPOINT_GONE_CODE || code === PROFILE_ENDPOINT_UNKNOWN_CODE ? "endpoint" : "session";
}

/**
 * The founder-facing reading of a stop.
 *
 * `where` names the reconnect affordance for the surface doing the asking — growth's answer is a
 * command line, cloud's is a screen — because "reconnect the account" is not an instruction if the
 * reader does not know where.
 */
export function describeLinkedInStop(
  code: string | undefined,
  account: string,
  where = "Connections → LinkedIn",
): StopNotice {
  const cause = stopCauseOf(code);
  if (cause === "endpoint") {
    return {
      code: code ?? UNHEALTHY_CODE,
      cause,
      reconnect: false,
      headline: `LinkedIn outreach on ${account} is paused — this one is ours to fix`,
      what:
        `LinkedIn retired an endpoint we depend on, so invitations, messages and profile lookups on ` +
        `${account} have stopped. Nothing you did caused it and nothing is queued up waiting to burst ` +
        `out later — the account is simply idle until our code is changed.`,
      fix:
        `Nothing on your side, and reconnecting will not help — the session is fine. We ship the fix; ` +
        `sending resumes on its own once it is out.`,
    };
  }
  return {
    code: code ?? UNHEALTHY_CODE,
    cause,
    reconnect: true,
    headline: `LinkedIn outreach on ${account} has stopped — the session needs reconnecting`,
    what:
      `LinkedIn is no longer accepting the saved session for ${account}. A password change, a ` +
      `"sign out everywhere", a security check or plain expiry will all do it. Every invitation, ` +
      `message and profile lookup on this account is paused, and will stay paused — nothing is ` +
      `queued to catch up later.`,
    fix:
      `Sign in to LinkedIn in your browser, then reconnect the account in ${where}. Sending resumes ` +
      `by itself once the new session is verified. Until then nothing goes out on LinkedIn.`,
  };
}

export function actionableLine(f: VoyagerFailure, owner: string): string {
  if (f.kind === "session") return `linkedin session expired for ${owner}; reconnect required`;
  if (f.kind === "gone") return `linkedin endpoint retired for ${owner}; ${f.detail} — outreach on this account is stopped until it is fixed`;
  return `linkedin is failing for ${owner}; ${f.detail} — backing off`;
}
