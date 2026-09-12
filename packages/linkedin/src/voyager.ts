// LinkedIn Voyager — the messaging layer, once we hold a session.
//
// LinkedIn has no official messaging API, so once a session is captured (see login.ts) we speak to
// the same internal Voyager endpoints the linkedin.com web app calls, authenticated by the `li_at`
// session cookie plus the `JSESSIONID` value echoed back as the `csrf-token` header. This
// **violates the LinkedIn User Agreement and can get an account restricted** — it is opt-in and
// meant for low, human-approved volume behind a per-account proxy (see docs/VERIFY-LINKEDIN.md).
//
// The mappers (inboundMessages, conversationSummaries, messageText, syncTokenFrom) are pure and
// unit-tested against fixtures of BOTH response shapes LinkedIn currently serves; the live
// request/response shapes are undocumented and drift — verify against the site.
//
// ── WHY THE SYNC PATH LOOKS THE WAY IT DOES ──────────────────────────────────────────────────────
// Egress is the cost of this feature, and it is not spent where you would guess. Sending 50 DMs a
// day is ~29MB/month per account. Polling an inbox every five minutes and re-downloading the same
// conversation list is ~422MB/month per account — fourteen times the send path, for information
// that mostly did not change. Across 5,000 accounts that is the difference between ~$343/month and
// ~$3,855/month of residential-proxy bandwidth. Three decisions, in order of how much they save:
//
//  1. DELTAS, NOT POLLS — `syncToken`. The obvious fix is `If-None-Match`/`If-Modified-Since`, and
//     it does not work here: **Voyager does not implement HTTP conditional requests.** Determined
//     three ways (see docs/VERIFY-LINKEDIN.md for the full write-up): (a) probing the live
//     endpoints — `/voyager/api/me`, an identity resource, the messaging GraphQL endpoint and
//     `/realtime/connect` all return `cache-control: no-cache, no-store, no-transform` with no
//     `etag` and no `last-modified`, and ignore conditional headers; (b) reading LinkedIn's own
//     Rest.li framework, which contains no ETag/If-None-Match/conditional-GET support anywhere and
//     whose `S_304_NOT_MODIFIED` constant is referenced by nothing; (c) checking four independent
//     reverse-engineered clients, none of which has ever observed a 304. `no-store` in particular
//     means there is nothing to revalidate against.
//     What Voyager DOES offer is an application-level cursor: `messengerConversationsBySyncToken`
//     returns only conversations changed since the token, plus tombstones and a fresh token. That
//     turns a full inbox listing into an empty-ish delta on the overwhelming majority of polls.
//  2. FIELD PROJECTION — a page cap plus a `decorationId`, LinkedIn's named response shape. Voyager
//     is Rest.li and answers with large `included` entity graphs by default; a decoration typically
//     cuts a response 5-10x. Decoration ids carry a version suffix that rotates with LinkedIn's
//     deploys and a stale one 400s, so it is configurable and a 400 falls back to undecorated once,
//     rather than breaking the inbox.
//  3. GZIP — explicitly requested on every call. Voyager honours it (`content-encoding: gzip`,
//     `vary: accept-encoding` observed on the live endpoints). Undici sends it by default, but
//     "by default" is a property of the transport, not of this code, and this is worth ~3-4x.
//
// Every call reports what it actually transferred to meter.ts, so the paragraph above is checkable
// rather than believed.
import {
  proxiedFetch,
  redactProxy,
  describeNetworkError,
  safeRedirectLocation,
  absoluteRedirectUrl,
  isAuthRedirect,
} from "./proxy";
import { recordTransfer } from "./meter";
import {
  LinkedInGoneError,
  LinkedInUnavailableError,
  linkedinBlocked,
  noteLinkedInFailure,
  noteLinkedInSuccess,
} from "./health";
import { accountTierFromMe } from "./tier";
import type { AccountTier } from "./host";
import { mergeSetCookie, setCookiesFrom } from "./cookies";

export { mergeSetCookie, setCookiesFrom } from "./cookies";

export const VOYAGER = "https://www.linkedin.com/voyager/api";
const GRAPHQL = `${VOYAGER}/voyagerMessagingGraphQL/graphql`;

/**
 * GraphQL query ids. These are content hashes of LinkedIn's persisted queries and they ROTATE with
 * LinkedIn's web deploys — when the inbox stops syncing, re-capture them from a browser devtools
 * network log and set the env vars; no code change, no redeploy of the image.
 */
const QID_CONVERSATIONS =
  process.env.MYCEL_LINKEDIN_QID_CONVERSATIONS ?? "messengerConversations.f0873b936b43ed663997b215b2c28359";
const QID_CONVERSATIONS_SYNC =
  process.env.MYCEL_LINKEDIN_QID_SYNC ?? "messengerConversations.74c17e85611b60b7ba2700481151a316";
/** Named response shape for the legacy Rest.li inbox. Versioned suffix; rotates. Empty = undecorated. */
const DECORATION_ID = process.env.MYCEL_LINKEDIN_DECORATION_ID ?? "";
/** Page cap on a cold start. An inbox listing is unbounded otherwise. */
const SYNC_PAGE = Number(process.env.MYCEL_LINKEDIN_SYNC_COUNT ?? 20);

export interface LinkedInSession {
  li_at: string;
  jsessionid: string;
  /**
   * THE REST OF THE BROWSER'S COOKIE JAR, and the reason the account kept getting challenged.
   *
   * For a long time every Voyager request sent exactly two cookies: `li_at` and `JSESSIONID`. A real
   * Chrome on linkedin.com sends around ten, and the ones that were missing are the ones that
   * matter:
   *
   *   bcookie / bscookie — the BROWSER IDENTITY. Long-lived (a year), issued to the device, and
   *                        sent on every request a browser makes. An `li_at` arriving WITHOUT them
   *                        is an auth token being presented by something that is not the browser it
   *                        was issued to, which is the definition of a replayed cookie and exactly
   *                        the thing LinkedIn's anti-abuse challenges.
   *   lidc              — LinkedIn's own datacenter routing hint. Its absence is why
   *                        `/voyager/api/me` was observed 302-ing TO ITSELF; that was not a bug in
   *                        the call, it was the load balancer asking for a cookie we never sent.
   *   liap, li_gc, lang — smaller, but every one of them is a field in a fingerprint that currently
   *                        reads "not a browser".
   *
   * The observed behaviour matched precisely: reconnect, get a burst of ~19 actions, get challenged,
   * reconnect, repeat, all day. That is not a proxy problem — the account already egresses through a
   * sticky French ISP line — and it is not rate limiting, because 19 profile views is nothing. It is
   * a valid token on an unrecognised client.
   *
   * Stored as the RAW HEADER STRING rather than parsed into fields. We are not interpreting these;
   * we are replaying them, and every attempt to normalise a cookie jar is a chance to drop the one
   * cookie that mattered. `li_at` and `jsessionid` stay as their own fields because the CSRF header
   * is derived from JSESSIONID and the health check reads li_at by name.
   *
   * Optional: a session captured before this existed still works exactly as it did.
   */
  cookies?: string;
  /**
   * The User-Agent the session was born with. LinkedIn binds a session to the client that created
   * it; presenting Chrome/141 for a jar minted as Chrome/152 is the same mismatch as a foreign IP.
   * Absent on jars captured before this field existed — those keep `VOYAGER_UA`.
   */
  ua?: string;
  /** urn:li:fs_miniProfile:… of the connected member — used to skip our own messages on inbound. */
  self_urn?: string;
  /** urn:li:fsd_profile:… — the mailbox the GraphQL sync queries address. Derived if absent. */
  mailbox_urn?: string;
}

/** Where a call is going out from and who it is billed to. Both are required by construction. */
export interface VoyagerCtx {
  /** The Connection id — the unit bytes are metered against. */
  connectionId: string;
  /** The account's residential proxy. Absent is refused unless MYCEL_LINKEDIN_ALLOW_DIRECT=1. */
  proxyUrl?: string;
}

/** A normalized inbound LinkedIn message. */
export interface LiInbound {
  thread_id: string; // conversation entityUrn — the handle for replying
  message_id?: string;
  from: { id: string; name?: string };
  text: string;
  sent_at: string;
}

export interface LiConversation {
  thread_id: string;
  title?: string;
  last_text?: string;
  last_message_at?: string;
}

/** JSESSIONID arrives quoted ("ajax:123"); the csrf-token header wants it unquoted. */
export function csrfFrom(jsessionid: string): string {
  return jsessionid.replace(/"/g, "");
}

/** Browser-like UA. Undici's default (empty / `undici`) is why search 302s to `/uas/login` while `/me` still 200s. */
export const VOYAGER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

/**
 * The cookie header for this session.
 *
 * The full jar when we captured one, with `li_at` and `JSESSIONID` FORCED to the session's own
 * values — those two are refreshed on reconnect and the stored jar may predate that, and a stale
 * auth cookie sitting in front of a fresh one is a 401 that looks like a challenge.
 *
 * Falls back to the two-cookie form for a session captured before jars were stored.
 */
export function cookieHeader(s: LinkedInSession): string {
  const pinned = `li_at=${s.li_at}; JSESSIONID=${s.jsessionid}`;
  const jar = (s.cookies ?? "").trim();
  if (!jar) return pinned;
  const rest = jar
    .split(/;\s*/)
    .filter(Boolean)
    .filter((c) => !/^(li_at|JSESSIONID)=/i.test(c));
  return rest.length > 0 ? `${pinned}; ${rest.join("; ")}` : pinned;
}

/**
 * ═══ THE JAR HAS TO STAY ALIVE, NOT JUST BE COMPLETE ═══
 *
 * Sending the whole jar fixed one half of this. The other half is that LINKEDIN ROTATES IT, and
 * nothing here was reading the rotations back.
 *
 * `lidc` is the one that matters. It is a DATACENTER ROUTING cookie: it says which of LinkedIn's
 * datacenters is holding your session and until when, and they reissue it on nearly every response.
 * A browser follows. We replayed a frozen one forever — and a STALE `lidc` is worse than none,
 * because it actively routes the request to a datacenter that no longer has the session. LinkedIn
 * answers 302 to re-route; `voyagerCall` reads a 302 as "not signed in", stamps the challenge, and
 * the breaker stops the whole channel.
 *
 * That is the shape of every failure on this account: works for a burst, then dies. Observed
 * directly on 31 August — the same jar returned 200 from `/voyager/api/me` and then 302 seconds
 * later from an identical request, which is not a session dying, it is a routing hint going stale.
 *
 * So every response's `Set-Cookie` is merged back into the session, in memory, and the caller
 * persists when something actually changed. Deletions are honoured (`Max-Age=0`), because a cookie
 * LinkedIn explicitly cleared is one we must stop sending.
 */

/**
 * Where a rotated jar goes to be persisted.
 *
 * A SEAM rather than a direct write, because this package must not know what a database is — the
 * kernel and growth store sessions in completely different places (sealed in `public.secrets` vs
 * plaintext in `growth.secrets`), and a hard dependency here would make the package unusable in
 * one of them. The host registers a writer at startup; without one, rotation still happens in
 * memory and simply does not survive a restart, which is strictly better than not rotating.
 */
export type SessionRotatedHandler = (connectionId: string, cookies: string) => void;

let onSessionRotated: SessionRotatedHandler | undefined;

export function setSessionRotatedHandler(fn: SessionRotatedHandler | undefined): void {
  onSessionRotated = fn;
}

/** Tell the persist seam a jar changed. Also the test hook for `bindJarPersist`. */
export function noteSessionRotated(connectionId: string, cookies: string): void {
  onSessionRotated?.(connectionId, cookies);
}

type JarSecrets = {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
};

let persistTimer: ReturnType<typeof setTimeout> | null = null;
let persistPending: { id: string; cookies: string } | null = null;
let persistWriting = false;
let persistLastWrite = 0;
const JAR_PERSIST_MS = 2_000;

/**
 * Coalesce `lidc` rotations into one vault write.
 *
 * The previous host-side handler was dead in production: growth's `loadLinkedIn()` never imported
 * `voyager`, so `setSessionRotatedHandler` was undefined and every rotation stayed in memory until
 * the next `getLinkedInSession()` threw it away. This lives on the host module's export surface so
 * that cannot happen again, and it never drops the latest jar — in-flight writes queue the newest
 * cookies rather than skipping them for 30s.
 */
export function bindJarPersist(secrets: JarSecrets): void {
  const flush = async (): Promise<void> => {
    persistTimer = null;
    const job = persistPending;
    persistPending = null;
    if (!job) return;
    persistWriting = true;
    try {
      const raw = await secrets.get(job.id);
      if (!raw) return;
      const session = JSON.parse(raw) as Record<string, unknown>;
      await secrets.set(job.id, JSON.stringify({ ...session, cookies: job.cookies }));
      persistLastWrite = Date.now();
    } catch (e) {
      console.error(`[mycel] linkedin jar persist failed for ${job.id}:`, e);
      if (!persistPending) persistPending = job;
    } finally {
      persistWriting = false;
      if (persistPending) schedule();
    }
  };
  function schedule(): void {
    if (persistWriting || persistTimer) return;
    const wait = persistLastWrite === 0 ? 0 : Math.max(0, JAR_PERSIST_MS - (Date.now() - persistLastWrite));
    persistTimer = setTimeout(() => void flush(), wait);
  }
  setSessionRotatedHandler((id, cookies) => {
    persistPending = { id, cookies };
    schedule();
  });
}

/** Test hook: drop the persist seam and any queued write. */
export function _resetJarPersist(): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = null;
  persistPending = null;
  persistWriting = false;
  persistLastWrite = 0;
  setSessionRotatedHandler(undefined);
}

export function voyagerHeaders(s: LinkedInSession): Record<string, string> {
  return {
    cookie: cookieHeader(s),
    "csrf-token": csrfFrom(s.jsessionid),
    "x-restli-protocol-version": "2.0.0",
    accept: "application/json",
    // Stated explicitly rather than left to the transport's default. Worth ~3-4x on every sync,
    // and Voyager honours it; undici decodes the body for us either way.
    "accept-encoding": "gzip, deflate",
    "user-agent": s.ua?.trim() || VOYAGER_UA,
    referer: "https://www.linkedin.com/",
    origin: "https://www.linkedin.com",
    "x-li-lang": "en_US",
  };
}

/** The mailbox urn the messaging GraphQL queries address; derived from the member urn if needed. */
export function mailboxUrn(s: LinkedInSession): string | undefined {
  if (s.mailbox_urn) return s.mailbox_urn;
  const id = s.self_urn?.split(":").pop();
  return id ? `urn:li:fsd_profile:${id}` : undefined;
}

/** Rest.li 2.0 encodes query "objects" as (k:v,k:v); the values still need percent-encoding. */
export function restliArgs(args: Record<string, string>): string {
  return `(${Object.entries(args)
    .map(([k, v]) => `${k}:${encodeURIComponent(v)}`)
    .join(",")})`;
}

// ── Pure mappers (Voyager JSON → kernel shapes). Exported for unit tests. ──
//
// Two shapes are in the wild at once: the legacy Rest.li inbox (`eventContent` unions, nested
// `MessagingMember`) and the newer messaging GraphQL/dash shape (`body.text`, `sender`). These
// mappers read both, because which one an account gets is LinkedIn's decision, not ours, and a
// mapper that only understands one of them fails silently on half the fleet.

/** Extract the message text from an event/message, tolerating every nesting we have seen. */
export function messageText(event: any): string {
  const mc =
    event?.eventContent?.["com.linkedin.voyager.messaging.event.MessageEvent"] ??
    event?.eventContent ??
    event ??
    {};
  return mc?.attributedBody?.text ?? mc?.body?.text ?? (typeof mc?.body === "string" ? mc.body : "") ?? "";
}

function member(event: any): any {
  return event?.from?.["com.linkedin.voyager.messaging.MessagingMember"] ?? event?.from ?? event?.sender ?? {};
}

function memberUrn(event: any): string | undefined {
  const m = member(event);
  return m?.miniProfile?.entityUrn ?? m?.hostIdentityUrn ?? m?.entityUrn;
}

/**
 * The vanity id growth keys people on (`dana-reyes`), not the member URN. Absent on older payloads,
 * in which case the URN is all we have and the CRM match is the caller's problem.
 */
function memberPublicId(event: any): string | undefined {
  const m = member(event);
  const p = m?.miniProfile ?? m?.participantType?.member ?? m;
  const id = p?.publicIdentifier ?? p?.publicId;
  return typeof id === "string" && id.trim() ? id.trim().toLowerCase() : undefined;
}

/** Names arrive bare (legacy) or as `{ text }` attributed strings (dash). */
function textOf(v: any): string | undefined {
  if (!v) return undefined;
  return typeof v === "string" ? v : typeof v?.text === "string" ? v.text : undefined;
}

function memberName(event: any): string | undefined {
  const m = member(event);
  const p = m?.miniProfile ?? m?.participantType?.member ?? m;
  if (!p) return undefined;
  const name = [textOf(p.firstName), textOf(p.lastName)].filter(Boolean).join(" ");
  return name || undefined;
}

/** Events of a conversation, in either shape. */
function eventsOf(c: any): any[] {
  return c?.events ?? c?.messages?.elements ?? c?.messages ?? [];
}

function threadIdOf(c: any): string | undefined {
  return c?.entityUrn ?? c?.conversationUrn ?? c?.backendUrn;
}

function sentAt(event: any): number | undefined {
  const t = event?.createdAt ?? event?.deliveredAt;
  return t ? Number(t) : undefined;
}

/** The elements of a conversations payload, whichever envelope it arrived in. */
export function conversationElements(payload: any): any[] {
  const data = payload?.data ?? payload;
  return (
    data?.elements ??
    data?.messengerConversationsBySyncToken?.elements ??
    data?.messengerConversationsByCategoryQuery?.elements ??
    data?.messengerConversationsByAnchorTimestamp?.elements ??
    data?.messengerConversations?.elements ??
    []
  );
}

/**
 * The fresh cursor to send next time, if the response carried one. Returning undefined is safe:
 * the caller keeps the old token and the next sync is merely a repeat, never a gap.
 */
export function syncTokenFrom(payload: any): string | undefined {
  const data = payload?.data ?? payload;
  const meta =
    data?.messengerConversationsBySyncToken?.metadata ??
    data?.messengerConversations?.metadata ??
    data?.metadata;
  return meta?.newSyncToken ?? meta?.syncToken ?? undefined;
}

/** Conversations LinkedIn says are gone — so a local mirror can drop them instead of drifting. */
export function deletedUrnsFrom(payload: any): string[] {
  const data = payload?.data ?? payload;
  const meta =
    data?.messengerConversationsBySyncToken?.metadata ?? data?.messengerConversations?.metadata ?? data?.metadata;
  const raw: any[] = meta?.deletedUrns ?? [];
  return raw.map((d) => (typeof d === "string" ? d : d?.urn ?? d?.entityUrn)).filter(Boolean);
}

/** Conversations payload → summaries (thread_id is the conversation urn). */
export function conversationSummaries(payload: any): LiConversation[] {
  return conversationElements(payload)
    .map((c) => {
      const last = eventsOf(c)[0];
      const at = last ? sentAt(last) : undefined;
      return {
        thread_id: threadIdOf(c) as string,
        title: last ? memberName(last) : undefined,
        last_text: last ? messageText(last) : undefined,
        last_message_at: at ? new Date(at).toISOString() : undefined,
      };
    })
    .filter((s) => !!s.thread_id);
}

/** Conversations payload → inbound messages, skipping anything sent by `selfUrn`. */
export function inboundMessages(payload: any, selfUrn: string | undefined): LiInbound[] {
  const out: LiInbound[] = [];
  // The dash shape uses fsd_profile where the legacy shape uses fs_miniProfile for the same member;
  // compare on the trailing id so "is this mine?" survives the shape difference.
  const selfId = selfUrn?.split(":").pop();
  for (const c of conversationElements(payload)) {
    const thread = threadIdOf(c);
    if (!thread) continue;
    for (const event of eventsOf(c)) {
      const fromUrn = memberUrn(event);
      if (selfId && fromUrn?.split(":").pop() === selfId) continue; // our own message
      const text = messageText(event);
      if (!text) continue;
      const at = sentAt(event);
      out.push({
        thread_id: thread,
        message_id: event.entityUrn ?? event.dashEntityUrn ?? event.backendUrn ?? undefined,
        from: { id: memberPublicId(event) ?? fromUrn ?? "unknown", name: memberName(event) },
        text,
        sent_at: new Date(at ?? Date.now()).toISOString(),
      });
    }
  }
  return out;
}

/** urn:li:fs_conversation:2-abc== → the trailing conversation id used in the send URL. */
export function conversationId(threadUrn: string): string {
  return threadUrn.split(":").pop() ?? threadUrn;
}

// ── Live calls ───────────────────────────────────────────────────────────────────────────────────

export interface LiSendResult {
  ok: boolean;
  message_id?: string;
  detail?: string;
}

/** The result of one metered Voyager round-trip. */
export interface VoyagerResponse {
  ok: boolean;
  status: number;
  json: any;
  /** Raw body. People search is SSR HTML; GraphQL/JSON still lands here too. */
  text: string;
  decoded: number;
  /** Safe host+path when LinkedIn 3xx'd. Query stripped — never cookies. */
  location?: string;
  /** Absolute Location including query. For the next document GET — never log this. */
  redirectUrl?: string;
}

/** Search through a residential proxy of a large Rest.li graph regularly exceeds `/me`'s 20s. */
// `profile`/`view` join it: the profile-page candidate is a ~900KB flagship document, the same
// weight class as the people SRP, and 20s through a residential proxy is not enough for it.
const TIMEOUT_MS: Record<string, number> = { search: 45_000, profile: 45_000, view: 45_000 };
const DEFAULT_TIMEOUT_MS = 20_000;

/** One metered round-trip. Everything that talks to LinkedIn goes through here, so that the proxy
 *  rule, the gzip header and the byte meter cannot be forgotten at a call site.
 *
 *  Exported as `voyagerCall` (below) so the search/profile/invitation surfaces in the sibling files
 *  are physically unable to construct a bare fetch: there is exactly one door, and it is this one. */
async function call(
  url: string,
  session: LinkedInSession,
  ctx: VoyagerCtx,
  op: string,
  init: Record<string, unknown> = {},
): Promise<VoyagerResponse> {
  const body = typeof init.body === "string" ? init.body : undefined;
  const ms = TIMEOUT_MS[op] ?? DEFAULT_TIMEOUT_MS;
  /**
   * "THIS 403 IS AN ANSWER, NOT A CHECKPOINT."
   *
   * 401/403/999 are a challenge for almost every op, and treating them so is what keeps a dead
   * cookie from spraying. But the invitation endpoints answer a full PENDING pile and an account
   * restriction with a 403 carrying their own reason — and telling a founder "reconnect the
   * session" when the session is fine, and the truth is "you have 1,500 unanswered invitations",
   * costs them a reconnect and the week it takes to notice it changed nothing.
   *
   * The predicate is supplied by the caller (invites.ts passes its classifier) rather than read
   * here, because voyager.ts must not import the modules that import it. It can only ever DEMOTE a
   * challenge on a status the caller was already going to interpret — never suppress a checkpoint
   * redirect or a captcha, both of which are checked below on their own.
   */
  const notChallenge = typeof init.notChallenge === "function"
    ? (init.notChallenge as (status: number, json: unknown, text: string) => boolean)
    : undefined;
  /**
   * Optional path. A failure here must not stop the connection — the caller has a fallback (the
   * GraphQL inbox has Rest.li). Stripped from `init` so it never becomes a fetch header.
   */
  const bestEffort = init.bestEffort === true;
  if (notChallenge || bestEffort) {
    const { notChallenge: _n, bestEffort: _b, ...rest } = init;
    init = rest;
  }
  // THE BREAKER, at the one door. connect.ts checks it earlier and with better copy, but this is the
  // check that cannot be bypassed by a call site that forgot — and the incident that produced this
  // file was 35,456 requests that no call site thought to stop.
  const blocked = linkedinBlocked(ctx.connectionId);
  if (blocked) throw new LinkedInUnavailableError(blocked.code, blocked.detail, ctx.connectionId);
  let res: Response;
  try {
    const headers: Record<string, string> = {
      ...voyagerHeaders(session),
      ...((init.headers as Record<string, string>) ?? {}),
    };
    // Document navigation is not Rest.li. csrf-token / origin / x-li-lang on this GET are how
    // LinkedIn 302s the same people URL while `/me` on the same cookies still 200s.
    if ((headers.accept ?? "").includes("text/html")) {
      delete headers["x-restli-protocol-version"];
      delete headers["csrf-token"];
      delete headers.origin;
      delete headers["x-li-lang"];
      headers["sec-fetch-dest"] = "document";
      headers["sec-fetch-mode"] = "navigate";
      headers["sec-fetch-site"] = "none";
      headers["upgrade-insecure-requests"] = "1";
    }
    res = await proxiedFetch(
      url,
      {
        ...init,
        headers,
        signal: AbortSignal.timeout(ms),
        // The walker applies Set-Cookie on 302 hops. Without this, a stale lidc 302's fresh
        // cookie is eaten before voyagerCall ever sees the response.
        onJar: (cookies: string) => {
          session.cookies = cookies;
          noteSessionRotated(ctx.connectionId, cookies);
        },
      },
      ctx.proxyUrl,
      `a LinkedIn ${op}`,
    );
  } catch (e) {
    const detail = describeNetworkError(e);
    if (/aborted due to timeout|TimeoutError|TIMEOUT_ERR/i.test(detail)) {
      const timeout = new Error(
        `LinkedIn ${op} timed out after ${Math.round(ms / 1000)}s via ${redactProxy(ctx.proxyUrl)}`,
        { cause: e instanceof Error ? e : undefined },
      );
      if (!bestEffort) noteLinkedInFailure(ctx.connectionId, timeout, { claim: false });
      throw timeout;
    }
    // A transport failure is transient by construction — it never reached LinkedIn's application.
    // It still counts, because a proxy that is refusing every connection produces exactly the same
    // unbounded retry loop a dead session does.
    if (!bestEffort) noteLinkedInFailure(ctx.connectionId, e, { claim: false });
    throw e;
  }
  // ROTATIONS FIRST, before anything can throw on the response. A 302 caused by a stale `lidc`
  // carries the fresh one in its own Set-Cookie, so the fix for the redirect arrives in the
  // redirect — and reading it after the challenge check would discard exactly the cookie that
  // stops the next request being challenged.
  const rotated = setCookiesFrom(res.headers);
  if (rotated.length > 0) {
    const before = session.cookies ?? `li_at=${session.li_at}; JSESSIONID=${session.jsessionid}`;
    const after = mergeSetCookie(before, rotated);
    if (after !== before) {
      session.cookies = after;
      noteSessionRotated(ctx.connectionId, after);
    }
  }

  const text = await res.text().catch(() => "");
  const decoded = Buffer.byteLength(text);
  // content-length on a gzipped response IS the compressed length — the bytes the proxy bills.
  // Absent (chunked), the decoded size is the honest upper bound.
  const wire = Number(res.headers?.get?.("content-length") ?? NaN);
  let json: any = undefined;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    /* not json — status still tells the caller what happened */
  }
  recordTransfer(ctx.connectionId, op, {
    wire: Number.isFinite(wire) ? wire : decoded,
    decoded,
    up: body ? Buffer.byteLength(body) : 0,
    emptyDelta: op === "sync" && conversationElements(json).length === 0,
  });
  const rawLocation = res.headers?.get?.("location") ?? "";
  const location = rawLocation ? safeRedirectLocation(rawLocation) : undefined;
  const redirectUrl = rawLocation ? absoluteRedirectUrl(url, rawLocation) : undefined;
  if (linkedinChallenge(res.status, json, text, rawLocation) && !notChallenge?.(res.status, json, text)) {
    const challenge = new LinkedInChallengeError(res.status, ctx.connectionId);
    noteLinkedInFailure(ctx.connectionId, challenge, { claim: false });
    throw challenge;
  }
  // 410 Gone: LinkedIn retired this endpoint. Permanent for every profile, every prospect and every
  // account — so it stops the connection here rather than being re-discovered 3,700 times an hour.
  if (res.status === 410) {
    if (bestEffort) return { ok: false, status: 410, json, text, decoded, location, redirectUrl };
    const gone = new LinkedInGoneError(op, res.status, ctx.connectionId);
    noteLinkedInFailure(ctx.connectionId, gone, { claim: false });
    throw gone;
  }
  // Everything else is the CALLER's to interpret — a 404 profile is an answer, not a failure — with
  // two exceptions that are never an answer and always mean "stop asking so fast".
  if (res.status === 429 || (res.status >= 500 && res.status <= 599)) {
    if (!bestEffort) noteLinkedInFailure(ctx.connectionId, new Error(`voyager ${op} ${res.status}`), { claim: false });
  } else if (res.ok) {
    // The clean slate. A success is the only thing that clears a stop, and that is deliberate: it
    // means the founder reconnected, or we shipped the endpoint fix.
    noteLinkedInSuccess(ctx.connectionId);
  }
  return { ok: res.ok, status: res.status, json, text, decoded, location, redirectUrl };
}

/**
 * Session-dead / checkpoint / captcha — stop the account, do not keep sending.
 *
 * 429 is rate-limit, not a challenge: pacing backs off. 5xx is LinkedIn being down.
 * 401/403/999 and checkpoint HTML are "reconnect before anything else goes out."
 */
export function linkedinChallenge(status: number, json: unknown, text = "", location = ""): boolean {
  if (status === 401 || status === 403 || status === 999) return true;
  // A 302 Location to /checkpoint/ is the challenge. /uas/login is often just missing headers —
  // proxiedFetch returns that 302 as a status rather than persisting a reconnect.
  if (location && isAuthRedirect(location) && /\/checkpoint\//i.test(location)) return true;
  const blob = `${text}\n${typeof json === "string" ? json : JSON.stringify(json ?? "")}`.toLowerCase();
  // `\bcaptcha\b` — `includes("captcha")` matches `recaptcha` in a normal people-SRP bootstrap.
  return blob.includes("/checkpoint/") || /\bcaptcha\b/.test(blob) || blob.includes("challenge_id");
}

export class LinkedInChallengeError extends Error {
  readonly code = "challenged";
  constructor(
    public status: number,
    public connectionId: string,
  ) {
    super("LinkedIn challenged this session — reconnect before anything else goes out");
    this.name = "LinkedInChallengeError";
  }
}

/**
 * The one door, for the sibling modules.
 *
 * search.ts, profile.ts and invites.ts all go through this rather than `proxiedFetch` directly. It
 * is not convenience: `call` is where the proxy rule, the gzip header and the byte meter live, and a
 * second call site that forgot any one of them would be invisible until an account got restricted.
 */
export const voyagerCall = call;

/** Verify a session is live and capture the self URN. Returns null when the session is rejected. */
export async function fetchSelf(
  session: LinkedInSession,
  ctx: VoyagerCtx,
): Promise<{ self_urn?: string; mailbox_urn?: string; name?: string; tier?: AccountTier } | null> {
  const r = await call(`${VOYAGER}/me`, session, ctx, "self");
  // 401/403 throw LinkedInChallengeError inside `call` — cookie rejection. Any other non-OK
  // (429, 5xx, proxy already thrown) must not look like stale cookies.
  if (!r.ok) throw new Error(`LinkedIn /me returned ${r.status}`);
  const me = r.json ?? {};
  const self_urn = me?.miniProfile?.entityUrn ?? me?.["*miniProfile"] ?? me?.entityUrn;
  const name = me?.miniProfile
    ? [me.miniProfile.firstName, me.miniProfile.lastName].filter(Boolean).join(" ")
    : undefined;
  return {
    self_urn,
    mailbox_urn: mailboxUrn({ ...session, self_urn }),
    name: name || undefined,
    tier: accountTierFromMe(me),
  };
}

export interface SyncState {
  /** The cursor from the previous sync. Absent = cold start (a bounded, decorated full page). */
  syncToken?: string;
}

export interface SyncResult {
  conversations: LiConversation[];
  inbound: LiInbound[];
  /** Persist this and hand it back next time — that is the entire bandwidth optimisation. */
  syncToken?: string;
  deleted: string[];
  /** True when the cursor said "nothing changed" — the common case, and the cheap one. */
  empty: boolean;
  /** Decoded response size, so a caller can assert the sync stayed small. */
  bytes: number;
  /** Which path answered: the GraphQL cursor, a cold GraphQL page, or the legacy Rest.li inbox. */
  via: "sync-token" | "graphql" | "legacy";
}

/** Set once when a decorationId is rejected, so a rotated id costs one 400 rather than one per poll. */
let decorationRejected = false;

/**
 * GraphQL messaging is rolled out unevenly, and its query ids rotate. A 401/403/999 from THAT
 * endpoint is "this path is not available to this account", not "the session is dead" — the Rest.li
 * inbox below is the one that decides that. A real checkpoint/captcha still throws, because that
 * is the session.
 *
 * The bug this exists for: `call()` treats every 403 as LinkedInChallengeError and stamps the
 * account-wide breaker. The worker started polling the inbox on 1 September, GraphQL 403'd, and
 * every subsequent Voyager call — invites, DMs, the health probe — was refused before it left the
 * process. The fallback this function claims to have never ran.
 */
function graphqlInboxNotChallenge(status: number, json: unknown, text = ""): boolean {
  if (status !== 401 && status !== 403 && status !== 999) return false;
  const blob = `${text}\n${typeof json === "string" ? json : JSON.stringify(json ?? "")}`.toLowerCase();
  if (blob.includes("/checkpoint/") || /\bcaptcha\b/.test(blob) || blob.includes("challenge_id")) return false;
  return true;
}

/**
 * Sync the inbox as cheaply as LinkedIn allows.
 *
 * With a `syncToken`: a delta — only conversations that changed, plus tombstones and a new token.
 * Without one: a bounded, decorated first page whose only job is to establish the token. If the
 * GraphQL endpoint is unavailable to this account (LinkedIn rolls these out unevenly) it falls back
 * to the legacy Rest.li inbox, which is more expensive but still page-capped and still metered.
 */
export async function syncConversations(
  session: LinkedInSession,
  ctx: VoyagerCtx,
  state: SyncState = {},
): Promise<SyncResult> {
  const mailbox = mailboxUrn(session);
  if (mailbox) {
    const variables = state.syncToken
      ? restliArgs({ mailboxUrn: mailbox, syncToken: state.syncToken })
      : restliArgs({ mailboxUrn: mailbox, count: String(SYNC_PAGE) });
    const qid = state.syncToken ? QID_CONVERSATIONS_SYNC : QID_CONVERSATIONS;
    try {
      const r = await call(`${GRAPHQL}?queryId=${qid}&variables=${variables}`, session, ctx, "sync", {
        notChallenge: graphqlInboxNotChallenge,
        bestEffort: true,
      });
      if (r.ok) {
        const elements = conversationElements(r.json);
        return {
          conversations: conversationSummaries(r.json),
          inbound: inboundMessages(r.json, session.self_urn),
          // Keep the old token if LinkedIn didn't mint a new one — a missing cursor must never
          // silently become a cold start, which is exactly the expensive thing we are avoiding.
          syncToken: syncTokenFrom(r.json) ?? state.syncToken,
          deleted: deletedUrnsFrom(r.json),
          empty: elements.length === 0,
          bytes: r.decoded,
          via: state.syncToken ? "sync-token" : "graphql",
        };
      }
    } catch (e) {
      // A connection already stopped must not spend another request on the fallback.
      if (e instanceof LinkedInUnavailableError) throw e;
      // A real checkpoint on GraphQL is a real checkpoint — don't ask Rest.li the same question.
      if (e instanceof LinkedInChallengeError) throw e;
      // 410 (retired query id), timeout, transport: the Rest.li inbox is the older, more widely
      // available path. Falling through is the whole point of having it.
    }
  }

  // Legacy Rest.li inbox. Page-capped and decorated where a decoration is configured.
  const params = new URLSearchParams({ keyVersion: "LEGACY_INBOX", count: String(SYNC_PAGE) });
  if (DECORATION_ID && !decorationRejected) params.set("decorationId", DECORATION_ID);
  let r = await call(`${VOYAGER}/messaging/conversations?${params}`, session, ctx, "sync");
  if (!r.ok && r.status === 400 && params.has("decorationId")) {
    // A rotated decoration id 400s. Retry bare once, and remember — the inbox keeps working while
    // someone re-captures MYCEL_LINKEDIN_DECORATION_ID.
    decorationRejected = true;
    params.delete("decorationId");
    r = await call(`${VOYAGER}/messaging/conversations?${params}`, session, ctx, "sync");
  }
  if (!r.ok) {
    // A 302 here is LinkedIn redirecting the inbox read to login — the same header/session rejection
    // the search path fights, NOT a checkpoint challenge (those throw LinkedInChallengeError inside
    // `call`). It is usually transient, so we do NOT stop the account; we say what happened in words
    // a founder can act on instead of leaking "voyager conversations 302" into the UI.
    if (r.status === 302) {
      throw new Error(
        "LinkedIn didn't accept the inbox read just now — it bounced the request to its login page. " +
          "This usually clears on its own; if syncing keeps failing, reconnect the account.",
      );
    }
    throw new Error(`LinkedIn inbox read failed (${r.status}) — try again shortly, or reconnect the account.`);
  }
  const elements = conversationElements(r.json);
  return {
    conversations: conversationSummaries(r.json),
    inbound: inboundMessages(r.json, session.self_urn),
    syncToken: state.syncToken,
    deleted: [],
    empty: elements.length === 0,
    bytes: r.decoded,
    via: "legacy",
  };
}

export async function sendMessage(
  session: LinkedInSession,
  ctx: VoyagerCtx,
  threadUrn: string,
  text: string,
): Promise<LiSendResult> {
  const body = {
    eventCreate: {
      value: {
        "com.linkedin.voyager.messaging.create.MessageCreate": {
          body: text,
          attachments: [],
          attributedBody: { text, attributes: [] },
        },
      },
    },
  };
  const r = await call(
    `${VOYAGER}/messaging/conversations/${conversationId(threadUrn)}/events?action=create`,
    session,
    ctx,
    "send",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
  );
  // Note what is NOT in the failure detail: the message text. A send failure is a status code.
  return r.ok
    ? { ok: true, message_id: r.json?.value?.eventUrn ?? r.json?.value?.backendEventUrn ?? undefined }
    : { ok: false, detail: `voyager send ${r.status}` };
}

/**
 * Open a NEW conversation with a first-degree connection and send the first message in one call.
 *
 * THE BUG this exists for: `sendMessage` above needs a conversation urn, and after an invitation is
 * accepted there is usually no conversation at all — the two of you have never spoken. So the first
 * DM of every sequence, the single most valuable message the product sends, had nowhere to go. It
 * parked, and it parked again on the next tick, forever, because nothing in the loop could create
 * the thing it was waiting for. `capabilities.ts` has documented `send_message` as taking "a
 * conversation urn, or profile_id to start one" the whole time; this is the missing half of it.
 *
 * Voyager creates the conversation when handed recipients plus the first event, which is why this
 * is one call and not "create, then send" — a two-call version can leave an empty thread behind if
 * the second half fails, and an empty thread is indistinguishable from one we already used.
 *
 * Recipient may be a public id (`dana-okafor`) or a full profile urn; normalised to the trailing id
 * LinkedIn accepts in the recipients list.
 */
export async function createConversation(
  session: LinkedInSession,
  ctx: VoyagerCtx,
  profileId: string,
  text: string,
): Promise<LiSendResult & { thread?: string }> {
  const recipient = profileId.includes(":") ? (profileId.split(":").pop() ?? profileId) : profileId.trim();
  if (!recipient) return { ok: false, detail: "create conversation needs a profile id" };
  if (!text.trim()) return { ok: false, detail: "create conversation needs message text" };

  const body = {
    keyVersion: "LEGACY_INBOX",
    conversationCreate: {
      eventCreate: {
        value: {
          "com.linkedin.voyager.messaging.create.MessageCreate": {
            body: text,
            attachments: [],
            attributedBody: { text, attributes: [] },
          },
        },
      },
      recipients: [recipient],
      subtype: "MEMBER_TO_MEMBER",
    },
  };
  const r = await call(`${VOYAGER}/messaging/conversations`, session, ctx, "send", {
    method: "POST",
    headers: { "content-type": "application/json", "x-restli-method": "create" },
    body: JSON.stringify(body),
  });
  // Same rule as `sendMessage`: the failure detail is a status code and never the message text.
  if (!r.ok) return { ok: false, detail: `voyager create conversation ${r.status}` };

  const value = r.json?.value ?? r.json?.data ?? r.json;
  const thread =
    (typeof value?.entityUrn === "string" && value.entityUrn) ||
    (typeof value?.conversationUrn === "string" && value.conversationUrn) ||
    (typeof value?.backendConversationUrn === "string" && value.backendConversationUrn) ||
    threadIdOf(value) ||
    undefined;
  const message_id = value?.eventUrn ?? value?.backendEventUrn ?? value?.["*event"] ?? undefined;

  // A create LinkedIn accepted but that returned no thread urn is STILL a success for the send —
  // the message went. The next inbox sync surfaces the conversation and `noteInboundReplies`
  // attaches the urn. Callers treat a missing thread as "resolve it later", never as a failed send,
  // because the alternative is retrying a message a real person has already received.
  return {
    ok: true,
    thread: typeof thread === "string" ? thread : undefined,
    message_id: typeof message_id === "string" ? message_id : undefined,
  };
}

/** Test hook: forget that a decoration id was rejected. */
export function _resetDecoration(): void {
  decorationRejected = false;
}
