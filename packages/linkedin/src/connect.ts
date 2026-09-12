// "Connect LinkedIn" orchestration: get a session → store it in the vault → a Connection.
//
// TWO WAYS IN, AND THE FIRST ONE IS BETTER:
//   1. `connectWithSession` — the member hands over the `li_at` + `JSESSIONID` cookies from a
//      browser they are already logged into (an extension, a bookmarklet, or a hosted page we
//      serve that reads its own document.cookie after a real LinkedIn login). **No password ever
//      enters this system.** That property, not the prettier form, is what a hosted-auth vendor
//      like Unipile is actually selling, and it is available to us without becoming one.
//   2. `startConnect` — we drive a headless browser with the member's password (login.ts). Kept
//      because the handoff needs a browser extension or a hosted origin and not every deployment
//      has one. The password lives for the duration of one function call and is never persisted,
//      never logged and never put on the Connection.
//
// The session is stored as a vault secret keyed by the connection id, so the existing action proxy
// resolves it exactly like any other connection secret (resolveSecret falls back to the connection
// id) — no new secret plumbing. The LinkedIn account becomes a first-class `Connection` of kind
// "linkedin", so Channels bind to it and outbound sends flow through the same approval gate.
//
// The proxy url is a SECRET too — it carries the proxy account's credentials — so it lives in the
// vault beside the session, and the Connection config keeps only a redacted form for display.
// `config` is returned by the connections API; a proxy password must not be.
import {
  getLinkedInHost,
  type AccountTier,
  type LinkedInConnection as Connection,
  type LinkedInConnectionOwner as ConnectionOwner,
  type PacingVerdict,
  type TouchKind,
} from "./host";
import { touchFor } from "./capabilities";
import { startLogin, submitChallenge, pollForApproval, type BrowserDriver, type PendingLogin } from "./login";
import { ProxyRequiredError, redactProxy, requireProxy, describeNetworkError } from "./proxy";
import {
  adoptStickyKey,
  proxyPoolEnabled,
  releaseProxy,
  resolveConnectProxy,
  stickyKeyForLiAt,
  type ProxyProviderId,
} from "./proxy-pool";
// The action modules. Each is a thin fetch plus a pure parser, so the parsers stay unit-testable
// without a live LinkedIn session — which is the only part that survives LinkedIn changing a
// response shape.
import { CommercialSearchLimitError, searchPeople, type PeopleQuery } from "./search";
import { companyPeople } from "./discover";
import { InviteQuotaError, sendInvite, withdrawInvite, resolveProfileUrn, checkNote } from "./invites";
import { warmupEnabled, WARMUP_DISABLED, endorseSkill, withdrawEndorsement, reactToPost, followPerson } from "./engage";
import { writePeople, writeCompanies, companyStubs, type GraphScope } from "./graph";
import { recentConnections } from "./network";
import { getProfile, getCompany, viewProfile, profileStrategyState, type LiProfile } from "./profile";
import { forgetUsage, usageFor, type AccountUsage } from "./meter";
import {
  createConversation,
  fetchSelf,
  sendMessage,
  syncConversations,
  LinkedInChallengeError,
  type LinkedInSession,
  type LiSendResult,
  type SyncResult,
  type VoyagerCtx,
} from "./voyager";
import {
  LinkedInProfileEndpointUnknownError,
  LinkedInUnavailableError,
  UNHEALTHY_CODE,
  actionableLine,
  linkedinBlocked,
  invitesBlocked,
  noteInviteRefusal,
  clearInviteRefusal,
  noteLinkedInFailure,
  noteLinkedInSuccess,
} from "./health";

export type ConnectPhase = "connected" | "needs_2fa" | "needs_approval" | "failed";

export interface ConnectResult {
  phase: ConnectPhase;
  connection_id: string;
  handle?: string;
  error?: string;
  /** "linkedin_proxy_required" when the refusal was the proxy rule — the caller answers 400. */
  code?: string;
  /**
   * Founder-facing copy for `needs_approval`: there is no code to relay, so the client shows this and
   * then polls the connection's status until the in-app tap lands. See `startConnect`.
   */
  message?: string;
}

// The host seams, aliased to the names this file has always used. Everything below reads them
// lazily so a host wired after import (or re-wired by a test) is picked up on the next call.
const getSecret = (key: string) => getLinkedInHost().secrets.get(key);
const setSecret = (key: string, value: string) => getLinkedInHost().secrets.set(key, value);
const deleteSecret = (key: string) => getLinkedInHost().secrets.delete(key);
const connectionStore = () => getLinkedInHost().connections;

/** Where the account's proxy url is vaulted. Separate key so it can be rotated without re-login. */
const proxyKey = (connectionId: string) => `${connectionId}:proxy`;

// Pending 2FA logins, holding a live browser between the credential step and the code submission.
// It holds a browser, not a credential — see PendingLogin.
const pending = new Map<string, PendingLogin>();
const PENDING_TTL_MS = 10 * 60 * 1000;

function sweepPending(): void {
  const cutoff = Date.now() - PENDING_TTL_MS;
  for (const [id, p] of pending) {
    if (p.createdAt < cutoff) {
      void p.ctx.close().catch(() => {});
      void p.driver.close().catch(() => {});
      pending.delete(id);
    }
  }
}

// The session verifier is injectable (default: the real Voyager /me call) so tests exercise the
// connect flow without a live LinkedIn account, exactly like `driverFactory` for the browser.
let verifier: (
  session: LinkedInSession,
  ctx: VoyagerCtx,
) => Promise<{ self_urn?: string; mailbox_urn?: string; name?: string; tier?: AccountTier } | null> = fetchSelf;

/** The egress context for a connection: its id (what bytes are metered against) and its proxy. */
export async function voyagerCtx(conn: Connection): Promise<VoyagerCtx> {
  return { connectionId: conn.id, proxyUrl: await getSecret(proxyKey(conn.id)) };
}

const COOKIE_REJECTED =
  "LinkedIn rejected those cookies — copy li_at and JSESSIONID from a live, logged-in session";

async function abortConnect(connectionId: string): Promise<void> {
  forgetLiveSession(connectionId);
  await deleteSecret(connectionId).catch(() => {});
  await deleteSecret(proxyKey(connectionId)).catch(() => {});
  releaseProxy(connectionId);
  await connectionStore().deleteConnection(connectionId);
}

function founderProxyRefusal(e: ProxyRequiredError): { error: string; code: string } {
  const vendor = /\b(decodo|smartproxy|brightdata|bright data|residential line|lease failed)\b/i.test(e.message);
  if (e.code === "linkedin_proxy_no_capacity" || vendor) {
    return { error: "couldn't open a line in this country", code: e.code };
  }
  return { error: e.message, code: e.code };
}

function failConnect(connectionId: string, e: unknown): ConnectResult {
  if (e instanceof ProxyRequiredError) {
    return { phase: "failed", connection_id: connectionId, ...founderProxyRefusal(e) };
  }
  return {
    phase: "failed",
    connection_id: connectionId,
    error: describeNetworkError(e) || "LinkedIn connect failed",
  };
}

async function persistSession(
  connectionId: string,
  session: LinkedInSession,
  proxyUrl?: string,
): Promise<{ verified: boolean; name?: string }> {
  // Confirm the session is live and learn the self/mailbox urns (so inbound skips our own messages
  // and the cheap GraphQL sync path has a mailbox to address).
  //
  // LinkedIn 401/403 on /me is cookie rejection (verifier returns null, or throws
  // LinkedInChallengeError). Proxy / undici / dispatcher failures MUST throw — catching them as
  // null is how a missing package became "LinkedIn rejected those cookies".
  let me: Awaited<ReturnType<typeof verifier>>;
  try {
    me = await verifier(session, { connectionId, proxyUrl });
  } catch (e) {
    if (e instanceof LinkedInChallengeError) {
      me = null;
    } else {
      console.error(`[mycel] linkedin session verify failed for ${connectionId}:`, e);
      throw e;
    }
  }
  const full: LinkedInSession = {
    ...session,
    self_urn: me?.self_urn ?? session.self_urn,
    mailbox_urn: me?.mailbox_urn ?? session.mailbox_urn,
  };
  // Stored under the connection id → the action proxy's resolveSecret(secret_ref, conn.id) finds it.
  await setSecret(connectionId, JSON.stringify(full));
  rememberLiveSession(connectionId, full);
  if (me?.tier) {
    try {
      const conn = await connectionStore().getConnection(connectionId);
      if (conn) {
        await connectionStore().updateConnection(connectionId, {
          config: { ...conn.config, tier: me.tier },
        });
      }
    } catch (e) {
      console.error(`[mycel] linkedin tier NOT recorded for ${connectionId}:`, e);
    }
  }
  // A verified session is the evidence — and the only evidence — that the reason we stopped this
  // account has been dealt with. Clearing here is what lets a reconnect actually resume outreach
  // instead of leaving the founder staring at a flag they have no way to remove.
  if (me !== null) await clearLinkedInUnhealthy(connectionId);
  return { verified: me !== null, name: me?.name };
}

interface ConnectBase {
  proxyUrl?: string;
  /** ISO country for pool geo (e.g. `us`). Ignored when BYO `proxyUrl` is set. */
  country?: string;
  /**
   * LinkedIn-member sticky key for the ISP pool. Prefer `stickyKeyForLiAt` when cookies are known
   * so two orgs sharing one LinkedIn account share one egress IP. Password login omits this until
   * cookies exist, then `bindMemberProxy` adopts the member key.
   */
  stickyKey?: string;
  owner?: ConnectionOwner;
  project_id?: string;
  name?: string;
}

/** Create the Connection row and vault its proxy.
 *
 * Proxy resolution order: request `proxy_url` (BYO) → configured ISP pool (Decodo / Bright Data /
 * static) → refuse (unless MYCEL_LINKEDIN_ALLOW_DIRECT).
 *
 * When nothing can supply a proxy we refuse BEFORE creating a Connection (same invariant as before).
 * When the pool will allocate, we create first so Bright Data can bind `-session-{connectionId}`,
 * then lease; lease failure clears secrets and marks the row refused.
 */
async function newConnection(input: ConnectBase & { label: string }): Promise<{ conn: Connection; proxyUrl?: string }> {
  const byo = (input.proxyUrl ?? "").trim();
  const usePool = !byo && proxyPoolEnabled();

  // No BYO and no pool → enforce the rule up front so a refused connect leaves no row behind.
  if (!byo && !usePool) {
    const proxyUrl = requireProxy(undefined, "connecting a LinkedIn account");
    const conn = await connectionStore().createConnection({
      project_id: input.project_id,
      kind: "linkedin",
      name: input.name ?? input.label,
      owner: input.owner ?? { kind: "founder", id: "founder" },
      config: { proxy: redactProxy(proxyUrl), proxy_provider: "byo" },
    });
    if (proxyUrl) await setSecret(proxyKey(conn.id), proxyUrl);
    return { conn, proxyUrl };
  }

  if (byo) {
    const proxyUrl = requireProxy(byo, "connecting a LinkedIn account");
    const conn = await connectionStore().createConnection({
      project_id: input.project_id,
      kind: "linkedin",
      name: input.name ?? input.label,
      owner: input.owner ?? { kind: "founder", id: "founder" },
      config: { proxy: redactProxy(proxyUrl), proxy_provider: "byo" },
    });
    if (proxyUrl) await setSecret(proxyKey(conn.id), proxyUrl);
    return { conn, proxyUrl };
  }

  // Pool path.
  const conn = await connectionStore().createConnection({
    project_id: input.project_id,
    kind: "linkedin",
    name: input.name ?? input.label,
    owner: input.owner ?? { kind: "founder", id: "founder" },
    config: {},
  });

  let proxyUrl: string | undefined;
  let provider: ProxyProviderId = "byo";
  let leaseCountry: string | undefined;
  try {
    const resolved = resolveConnectProxy({
      connectionId: conn.id,
      stickyKey: input.stickyKey,
      country: input.country,
    });
    proxyUrl = resolved.proxyUrl;
    provider = resolved.provider;
    leaseCountry = resolved.lease?.country;
  } catch (e) {
    await deleteSecret(conn.id).catch(() => {});
    await deleteSecret(proxyKey(conn.id)).catch(() => {});
    releaseProxy(conn.id);
    await connectionStore().updateConnection(conn.id, {
      name: `${input.name ?? input.label} (proxy refused)`,
      config: { proxy: "(refused)" },
    });
    throw e;
  }

  if (proxyUrl) await setSecret(proxyKey(conn.id), proxyUrl);
  const proxyCountry = leaseCountry ?? (input.country ? input.country.toLowerCase() : undefined);
  await connectionStore().updateConnection(conn.id, {
    config: {
      proxy: redactProxy(proxyUrl),
      proxy_provider: provider,
      ...(proxyCountry ? { proxy_country: proxyCountry } : {}),
    },
  });
  const fresh = (await connectionStore().getConnection(conn.id)) ?? conn;
  return { conn: fresh, proxyUrl };
}

/**
 * After a session is known, bind this connection to the LinkedIn member's sticky ISP key and
 * vault the (possibly shared) proxy URL. Org B connecting the same `li_at` joins org A's IP.
 */
async function bindMemberProxy(
  connectionId: string,
  session: LinkedInSession,
  currentProxyUrl?: string,
): Promise<string | undefined> {
  if (!proxyPoolEnabled()) return currentProxyUrl;
  const memberKey = stickyKeyForLiAt(session.li_at);
  const { proxyUrl, changed } = adoptStickyKey(connectionId, memberKey);
  const next = proxyUrl ?? currentProxyUrl;
  if (next && (changed || next !== currentProxyUrl)) {
    await setSecret(proxyKey(connectionId), next);
  }
  const conn = await connectionStore().getConnection(connectionId);
  if (conn) {
    await connectionStore().updateConnection(connectionId, {
      config: {
        ...conn.config,
        ...(next ? { proxy: redactProxy(next) } : {}),
        linkedin_sticky: memberKey,
        ...(session.self_urn ? { linkedin_urn: session.self_urn } : {}),
      },
    });
  }
  return next;
}

/**
 * THE PREFERRED PATH: adopt a session the member already has.
 *
 * They are logged into LinkedIn in their own browser; we take the two cookies that session is made
 * of. No password is transmitted, held, or typed into anything we wrote — which also means there is
 * no headless login for LinkedIn to flag, and no Playwright dependency on this path at all.
 */
export async function connectWithSession(
  input: ConnectBase & { li_at: string; jsessionid: string; cookies?: string },
): Promise<ConnectResult> {
  // Sticky key BEFORE allocate: same cookies across orgs share one Decodo port / Bright Data session.
  const stickyKey = stickyKeyForLiAt(input.li_at);
  let created: { conn: Connection; proxyUrl?: string };
  try {
    created = await newConnection({ ...input, stickyKey, label: "LinkedIn" });
  } catch (e) {
    if (e instanceof ProxyRequiredError) return { phase: "failed", connection_id: "", ...founderProxyRefusal(e) };
    throw e;
  }
  const { conn, proxyUrl } = created;
  let verified: boolean;
  let name: string | undefined;
  try {
    ({ verified, name } = await persistSession(
      conn.id,
      // The whole jar, not the two named cookies. `bcookie`/`bscookie` are what tell LinkedIn WHICH
      // BROWSER this token belongs to, and sending an `li_at` without them is what was getting the
      // account challenged every hour. See LinkedInSession.cookies.
      { li_at: input.li_at, jsessionid: input.jsessionid, cookies: input.cookies },
      proxyUrl,
    ));
  } catch (e) {
    await abortConnect(conn.id);
    return failConnect(conn.id, e);
  }
  // Cookies that /me rejects are not a connection. Fail here — at the moment the member is looking
  // at the screen — rather than at the first send, days later, inside an approved action.
  if (!verified) {
    await abortConnect(conn.id);
    return {
      phase: "failed",
      connection_id: conn.id,
      error: COOKIE_REJECTED,
    };
  }
  const session = (await getLinkedInSession(conn.id)) ?? {
    li_at: input.li_at,
    jsessionid: input.jsessionid,
    cookies: input.cookies,
  };
  await bindMemberProxy(conn.id, session, proxyUrl);
  if (name) await connectionStore().updateConnection(conn.id, { name: `LinkedIn (${name})` });
  return { phase: "connected", connection_id: conn.id, handle: name };
}

/**
 * The password path. Creates the Connection, drives the login, and either completes (session
 * stored) or returns `needs_2fa` for the founder to finish via `verifyConnect`.
 *
 * `password` is a parameter and nothing else: it is not written to the Connection, not vaulted, not
 * logged, and not carried on the pending-login record.
 */
export async function startConnect(
  input: ConnectBase & {
    email: string;
    password: string;
    driverFactory?: (proxyUrl?: string) => Promise<BrowserDriver>;
  },
): Promise<ConnectResult> {
  sweepPending();
  let created: { conn: Connection; proxyUrl?: string };
  try {
    created = await newConnection({ ...input, label: `LinkedIn (${input.email})` });
  } catch (e) {
    if (e instanceof ProxyRequiredError) return { phase: "failed", connection_id: "", ...founderProxyRefusal(e) };
    throw e;
  }
  const { conn, proxyUrl } = created;
  // The email is not a secret and identifies the account in the UI; the password is not stored.
  await connectionStore().updateConnection(conn.id, { config: { ...conn.config, email: input.email } });

  const { outcome, pending: pend } = await startLogin(input.email, input.password, {
    proxyUrl,
    driverFactory: input.driverFactory,
  });

  if (outcome.phase === "connected" && outcome.session) {
    return finishConnected(conn.id, outcome.session, proxyUrl);
  }
  if (outcome.phase === "needs_2fa" && pend) {
    pending.set(conn.id, pend);
    return { phase: "needs_2fa", connection_id: conn.id };
  }
  if (outcome.phase === "needs_approval" && pend) {
    // No code comes back for this kind: the browser is held, and the member tapping "Yes, it's me"
    // in their app is what advances it. So we store the pending (so a disconnect can tear it down)
    // and start the poll in the BACKGROUND — when it resolves connected it completes the connection
    // down the exact same path a synchronous connect would (`finishConnected`). The founder does
    // nothing here except approve on their phone; the client polls the connection's status.
    pending.set(conn.id, pend);
    void completeApprovalInBackground(conn.id, pend, proxyUrl).catch((e) =>
      console.error(`[mycel] linkedin app-approval background completion crashed for ${conn.id}:`, e),
    );
    return { phase: "needs_approval", connection_id: conn.id, message: outcome.message };
  }
  await abortConnect(conn.id);
  return { phase: "failed", connection_id: conn.id, error: outcome.error, code: outcome.code };
}

/**
 * Verify → vault → bind, the tail every successful login shares. Extracted so the synchronous
 * connect and the background app-approval completion cannot drift: a session that /me rejects is
 * torn down, a live one is vaulted and bound to the member's sticky IP.
 */
async function finishConnected(
  connectionId: string,
  session: LinkedInSession,
  proxyUrl?: string,
): Promise<ConnectResult> {
  let verified: boolean;
  let name: string | undefined;
  try {
    ({ verified, name } = await persistSession(connectionId, session, proxyUrl));
  } catch (e) {
    await abortConnect(connectionId);
    return failConnect(connectionId, e);
  }
  if (!verified) {
    await abortConnect(connectionId);
    return { phase: "failed", connection_id: connectionId, error: COOKIE_REJECTED };
  }
  await bindMemberProxy(connectionId, session, proxyUrl);
  return { phase: "connected", connection_id: connectionId, handle: name };
}

/**
 * Wait for the in-app approval, then complete (or clean up). Fire-and-forget from `startConnect`.
 *
 * `pollForApproval` tears the browser down on both the connected and the timeout path, so the only
 * bookkeeping left here is the pending map and, on a login that never got approved, the half-made
 * Connection row (so a stale, session-less account is not left lying around).
 */
async function completeApprovalInBackground(
  connectionId: string,
  pend: PendingLogin,
  proxyUrl?: string,
): Promise<void> {
  // Poll for the whole hold window, not the 180s default: the founder has to pick up their phone,
  // open LinkedIn, find the notification and tap it — routinely more than three minutes. The
  // browser is held PENDING_TTL_MS (10m); the poll must live nearly that long or it closes the
  // browser out from under a founder who is still walking to their phone, and the "I've approved
  // it" button then finds nothing. Margin so the poll, not the sweeper, owns teardown.
  const outcome = await pollForApproval(pend, { timeoutMs: PENDING_TTL_MS - 20_000 });
  // Whether it succeeded or timed out, this pending is done — the browser is already closed.
  if (pending.get(connectionId) === pend) pending.delete(connectionId);
  if (outcome.phase === "connected" && outcome.session) {
    const r = await finishConnected(connectionId, outcome.session, proxyUrl);
    if (r.phase !== "connected") {
      console.error(`[mycel] linkedin app-approval landed but the session was not usable for ${connectionId}: ${r.error}`);
    }
    return;
  }
  // Timed out (or a stray error): the member never approved. Don't leave a session-less row behind.
  await abortConnect(connectionId).catch((e) =>
    console.error(`[mycel] linkedin app-approval cleanup failed for ${connectionId}:`, e),
  );
}

/** Finish a challenged login with the verification code the founder received. */
export async function verifyConnect(connectionId: string, code: string): Promise<ConnectResult> {
  const pend = pending.get(connectionId);
  if (!pend) {
    return {
      phase: "failed",
      connection_id: connectionId,
      error: "no pending verification for this connection (it may have expired)",
    };
  }
  pending.delete(connectionId);
  const outcome = await submitChallenge(pend, code);
  if (outcome.phase === "connected" && outcome.session) {
    let verified: boolean;
    let name: string | undefined;
    try {
      ({ verified, name } = await persistSession(connectionId, outcome.session, pend.proxyUrl));
    } catch (e) {
      return failConnect(connectionId, e);
    }
    if (!verified) {
      return { phase: "failed", connection_id: connectionId, error: COOKIE_REJECTED };
    }
    await bindMemberProxy(connectionId, outcome.session, pend.proxyUrl);
    return { phase: "connected", connection_id: connectionId, handle: name };
  }
  return { phase: "failed", connection_id: connectionId, error: outcome.error };
}

/** Load a connected account's session from the vault. */
const liveSessions = new Map<string, LinkedInSession>();

function rememberLiveSession(connectionId: string, session: LinkedInSession): void {
  liveSessions.set(connectionId, session);
}

function forgetLiveSession(connectionId: string): void {
  liveSessions.delete(connectionId);
}

/**
 * One object per connection for the life of the process.
 *
 * `voyagerCall` merges `lidc` onto the session it was handed. Every action used to `JSON.parse` a
 * fresh copy from the vault, so those merges died at the next prospect — and the persist handler
 * that should have written them was never registered. Returning the same object is what makes a
 * rotation survive until the vault write lands.
 */
export async function getLinkedInSession(connectionId: string): Promise<LinkedInSession | null> {
  const raw = await getSecret(connectionId);
  if (!raw) {
    forgetLiveSession(connectionId);
    return null;
  }
  let parsed: LinkedInSession;
  try {
    parsed = JSON.parse(raw) as LinkedInSession;
  } catch {
    return liveSessions.get(connectionId) ?? null;
  }
  const cached = liveSessions.get(connectionId);
  if (cached && cached.li_at === parsed.li_at && cached.jsessionid === parsed.jsessionid) {
    if (parsed.ua && !cached.ua) cached.ua = parsed.ua;
    if (parsed.self_urn) cached.self_urn = parsed.self_urn;
    if (parsed.mailbox_urn) cached.mailbox_urn = parsed.mailbox_urn;
    return cached;
  }
  liveSessions.set(connectionId, parsed);
  return parsed;
}

// ── Outbound ─────────────────────────────────────────────────────────────────────────────────────
//
// Two independent checks stand between an agent and a stranger's LinkedIn inbox, and they answer
// different questions:
//
//   · The APPROVAL GATE (upstream, in the action proxy) asks "should this message be sent at all?"
//     A human answers it, one message at a time.
//   · PACING (here, via the host's pacing engine) asks "may this account send anything right now?" — the weekly
//     allowance, the ramp for a young account, the 8am-7pm weekday window, the spacing between
//     touches. A human approving twenty messages at 11pm does not make it safe to deliver twenty
//     messages at 11pm, which is exactly why this check is not part of the approval.
//
// Pacing returns a verdict rather than throwing, and the reason is a sentence for the founder
// ("you have used 78 of your 80 invitations this week"), so it is passed straight through.

/**
 * Swappable for tests. The first argument is the host's opaque `pacingContext` (the kernel passes
 * its DomainStore there), kept so existing test doubles keep their three-argument shape.
 */
export type PacingCheck = (store: unknown, connectionId: string, kind: TouchKind) => Promise<PacingVerdict>;

/** undefined → the host's pacing engine. null → skip the check. A function → an injected double. */
let pacingCheck: PacingCheck | null | undefined = undefined;

/** Test hook: install a pacing function, or null to skip the check entirely. */
export function _setPacing(fn: PacingCheck | null): void {
  pacingCheck = fn;
}

/** Consult pacing for one touch. Returns the verdict, or null when the check is switched off. */
async function checkPacing(connectionId: string, kind: TouchKind): Promise<PacingVerdict | null> {
  if (pacingCheck === null) return null;
  if (pacingCheck === undefined) return getLinkedInHost().pacing.assertSendAllowed(connectionId, kind);
  return pacingCheck(getLinkedInHost().pacingContext?.(), connectionId, kind);
}

/**
 * Spend the touch this action costs — the other half of `assertSendAllowed`.
 *
 * THE BUG THIS EXISTS TO CLOSE: pacing read `connection.config.pacing` and nothing on any path ever
 * wrote it. So `used` was permanently `{}` (the weekly allowance never decremented, and an account
 * could be driven straight through its real limit while every check said "allowed"), and
 * `engagement.sent` was permanently 0, which pins `engagementMultiplier` to its cautious 0.6
 * default whatever the account earns. A sequencer on top of that open loop is a machine for getting
 * a founder's account restricted.
 *
 * It takes the CAPABILITY ID, not a touch kind, so the mapping stays `touchFor`'s single decision:
 * a step composed later out of any capability spends the right budget without anyone remembering to
 * update a second table. `touchFor` returns "invite" for an unknown id, so a miss over-charges the
 * scarcest budget, which is the safe direction.
 *
 * Never throws. A failed increment is logged loudly (it is a safety-relevant loss) but it must not
 * turn a message the recipient already received into a reported failure — the caller would retry,
 * and a duplicate DM is a worse outcome than one uncounted touch.
 */
export async function noteLinkedInTouch(connectionId: string, action: string): Promise<void> {
  const kind = touchFor(action);
  if (!kind) return; // reads and free actions cost nothing
  try {
    await getLinkedInHost().pacing.recordTouch(connectionId, kind);
  } catch (e) {
    console.error(`[mycel] pacing counter NOT incremented for ${action} on ${connectionId}:`, e);
  }
}

/**
 * Send a message on a connected LinkedIn account. Called by the action executor AFTER approval.
 *
 * This is the single outbound door: the approval gate is upstream, pacing is here, the proxy rule is
 * downstream in voyager/proxy. Anything that wants to send LinkedIn should call this, not Voyager.
 */
export async function sendLinkedInMessage(
  conn: Connection,
  threadUrn: string,
  text: string,
): Promise<LiSendResult> {
  const session = await getLinkedInSession(conn.id);
  if (!session) return { ok: false, detail: "linkedin session not found or expired — reconnect the account" };

  const verdict = await checkPacing(conn.id, "message");
  if (verdict && !verdict.allowed) {
    // A pacing refusal is a normal outcome, not a crash — and its reason is written for the
    // founder, so it goes back verbatim.
    return { ok: false, detail: `paced: ${verdict.reason ?? "not allowed right now"}` };
  }

  try {
    const ctx = await voyagerCtx(conn);
    const attempt = () => sendMessage(session, ctx, threadUrn, text);
    const res = await onceMoreOnTransientLiSend(await attempt(), attempt);
    // Only a send LinkedIn accepted spends budget. Charging for a failure would burn allowance on
    // messages nobody received; charging before the call would do it on every transport blip.
    if (res.ok) await noteLinkedInTouch(conn.id, "send_message");
    return res;
  } catch (e) {
    if (e instanceof LinkedInChallengeError) {
      void persistLinkedInChallenge(e.connectionId, e.status);
      return { ok: false, detail: e.message };
    }
    if (e instanceof ProxyRequiredError) return { ok: false, detail: e.message };
    // Never echo the message body back in an error.
    return { ok: false, detail: `linkedin send failed: ${(e as Error)?.message ?? "unknown error"}` };
  }
}

/**
 * The FIRST DM after an accept: open the conversation with the profile and send, in one call.
 *
 * Separate from `sendLinkedInMessage` because the two are not interchangeable — that one needs a
 * conversation urn and this one is what produces the first urn there has ever been. Everything else
 * about the door is identical, deliberately: vaulted session, pacing on the same `message` touch,
 * one metered call through the account's proxy, budget spent only on a send LinkedIn accepted.
 *
 * Returns `thread` so the sequencer can persist it on the Case. Without that, every later DM in the
 * sequence has no urn and parks — which is the failure this whole path exists to end.
 */
export async function sendLinkedInFirstMessage(
  conn: Connection,
  profileId: string,
  text: string,
): Promise<LiSendResult & { thread?: string }> {
  const session = await getLinkedInSession(conn.id);
  if (!session) return { ok: false, detail: "linkedin session not found or expired — reconnect the account" };

  const verdict = await checkPacing(conn.id, "message");
  if (verdict && !verdict.allowed) {
    // A pacing refusal is a normal outcome, not a crash — its reason is written for the founder.
    return { ok: false, detail: `paced: ${verdict.reason ?? "not allowed right now"}` };
  }

  try {
    const ctx = await voyagerCtx(conn);
    const attempt = () => createConversation(session, ctx, profileId, text);
    const res = await onceMoreOnTransientLiSend(await attempt(), attempt);
    if (res.ok) await noteLinkedInTouch(conn.id, "send_message");
    return res;
  } catch (e) {
    if (e instanceof LinkedInChallengeError) {
      void persistLinkedInChallenge(e.connectionId, e.status);
      return { ok: false, detail: e.message };
    }
    if (e instanceof ProxyRequiredError) return { ok: false, detail: e.message };
    // Never echo the message body back in an error.
    return { ok: false, detail: `linkedin first message failed: ${(e as Error)?.message ?? "unknown error"}` };
  }
}

/** 429 / 5xx blips — one short retry. Challenges, pacing, and 4xx are not retried. */
function isTransientLiSend(detail?: string): boolean {
  return !!detail && /voyager (send|create conversation) (429|5\d\d)\b/i.test(detail);
}

async function onceMoreOnTransientLiSend<T extends { ok: boolean; detail?: string }>(
  first: T,
  retry: () => Promise<T>,
): Promise<T> {
  if (first.ok || !isTransientLiSend(first.detail)) return first;
  await new Promise((r) => setTimeout(r, 800));
  return retry();
}

// ── Search, profiles, invitations ────────────────────────────────────────────────────────────────
//
// Everything below is the same shape as `sendLinkedInMessage` above, and that sameness is the point:
// load the vaulted session, ask pacing whether this account may spend the touch this capability
// costs, make ONE metered call through the account's proxy, and increment the counter only if
// LinkedIn accepted it. A capability that skipped any of those four would be the hole the other
// thirteen are protected from.
//
// The reads additionally WRITE WHAT THEY LEARNED into the graph (see graph.ts), because a read whose
// result only ever reaches a chat window is a demo. That write is best-effort by construction: it
// can never turn a successful LinkedIn call into a reported failure.

/** The uniform result these return. Maps straight onto the action proxy's `ActionResult`. */
export interface LiActionResult {
  ok: boolean;
  detail?: string;
  /** A named, actionable failure — `linkedin_commercial_search_limit`, `linkedin_invite_quota`, … */
  code?: string;
  data?: Record<string, unknown>;
}

/** Load the session and the egress context, or explain why we cannot act. */
async function open(conn: Connection): Promise<{ session: LinkedInSession; ctx: VoyagerCtx } | LiActionResult> {
  const session = await getLinkedInSession(conn.id);
  if (!session) return { ok: false, detail: "linkedin session not found or expired — reconnect the account" };
  // Challenge is on the Connection, not only on paced writes. Search/profile reads are free in the
  // budget but they still hit Voyager — spraying Find after 401/403/999/captcha is how a flagged
  // account gets worse. Stop here, before the first request.
  if (conn.config?.linkedin_challenge) {
    return {
      ok: false,
      code: "challenged",
      detail: "LinkedIn challenged this session — reconnect before anything else goes out",
    };
  }
  // The DURABLE half of the breaker: a permanent failure recorded on the Connection row, so a
  // restarted process and every other replica skip this account too rather than each rediscovering
  // the same dead session 300 times a tick.
  const unhealthy = conn.config?.linkedin_unhealthy as { code?: string; detail?: string } | undefined;
  if (unhealthy?.detail) {
    return { ok: false, code: unhealthy.code ?? UNHEALTHY_CODE, detail: unhealthy.detail };
  }
  // The in-process half: permanent stops not yet persisted, and transient backoff, which is
  // deliberately NOT written to the store — a 429 is a rate limiter, not a fact about the account.
  const blocked = linkedinBlocked(conn.id);
  if (blocked) return { ok: false, code: blocked.code, detail: blocked.detail };
  return { session, ctx: await voyagerCtx(conn) };
}

const isRefusal = (v: unknown): v is LiActionResult => typeof (v as LiActionResult)?.ok === "boolean";

/**
 * The pacing gate, keyed on the CAPABILITY ID rather than a touch kind.
 *
 * Same decision as `noteLinkedInTouch`: `touchFor` is the single mapping, so a capability added later
 * is paced correctly without anyone remembering a second table. A capability that costs nothing
 * (search, withdraw) skips the check entirely rather than consulting a budget it does not spend.
 */
async function paced(conn: Connection, action: string): Promise<LiActionResult | null> {
  const kind = touchFor(action);
  if (!kind) return null;
  const verdict = await checkPacing(conn.id, kind);
  if (!verdict || verdict.allowed) return null;
  return { ok: false, detail: `paced: ${verdict.reason ?? "not allowed right now"}` };
}

/**
 * Turn a thrown LinkedIn condition into a result the founder can act on.
 *
 * The two named errors carry a `code` on purpose: the UI can special-case them, and more importantly
 * a human reading "you are out of invitations this week" does something different from a human
 * reading "invite failed". Anything else becomes a plain message — never the payload, never the note.
 */
function asResult(e: unknown, conn?: Connection): LiActionResult {
  if (e instanceof LinkedInChallengeError) {
    void persistLinkedInChallenge(e.connectionId, e.status);
    if (conn) announceOnce(conn, e);
    return { ok: false, code: e.code, detail: e.message };
  }
  if (e instanceof CommercialSearchLimitError || e instanceof InviteQuotaError) {
    return { ok: false, code: e.code, detail: e.message };
  }
  if (e instanceof ProxyRequiredError) return { ok: false, code: e.code, detail: e.message };
  // The breaker refused before any byte went out. It is not a new failure and it must not be logged
  // as one — it is the SILENCE this whole mechanism exists to produce.
  if (e instanceof LinkedInUnavailableError) return { ok: false, code: e.code, detail: e.message };

  const detail = describeNetworkError(e) || "linkedin call failed";
  if (!conn) {
    console.error(`[mycel] linkedin action failed:`, detail);
    return { ok: false, detail };
  }
  const noted = announceOnce(conn, e);
  // A CODE on a permanent failure is not decoration: `gtm/sequence.ts` waits a DAY on any named
  // code and only an hour on a nameless one, so this is what stops the case coming back in 60
  // minutes to ask LinkedIn the same dead question again.
  return noted.code ? { ok: false, code: noted.code, detail: noted.detail || detail } : { ok: false, detail };
}

/**
 * Record the failure against the connection's health and print AT MOST ONE line about it.
 *
 * The line is written for a human — "linkedin session expired for <owner>; reconnect required" —
 * because the alternative, which is what happened, is 35,456 copies of a status code that told
 * nobody which account to fix.
 */
function announceOnce(conn: Connection, e: unknown): { code?: string; detail: string; permanent: boolean } {
  const noted = noteLinkedInFailure(conn.id, e);
  if (noted.announce) {
    console.error(`[mycel] ${actionableLine(noted, conn.name || conn.id)}`);
  }
  if (noted.permanent) void persistLinkedInUnhealthy(conn.id, noted.code ?? UNHEALTHY_CODE, noted.detail);
  return { code: noted.code, detail: noted.detail, permanent: noted.permanent };
}

/**
 * Stamp the connection so every OTHER replica and every scheduler skips it too.
 *
 * `pacing.ts` reads this flag next to `linkedin_challenge`, which is what makes the skip reach the
 * sequencer, the pollers and the next-move engine without any of them learning a new concept. It is
 * cleared by a reconnect (see `clearLinkedInUnhealthy`) and by nothing else.
 */
async function persistLinkedInUnhealthy(connectionId: string, code: string, detail: string): Promise<void> {
  try {
    const conn = await connectionStore().getConnection(connectionId);
    if (!conn) return;
    const existing = conn.config?.linkedin_unhealthy as { code?: string } | undefined;
    if (existing?.code === code) return; // already stamped — do not rewrite the row every tick
    await connectionStore().updateConnection(connectionId, {
      config: { ...conn.config, linkedin_unhealthy: { at: new Date().toISOString(), code, detail } },
    });
  } catch (err) {
    console.error(`[mycel] linkedin unhealthy flag NOT recorded for ${connectionId}:`, err);
  }
}

/**
 * Clear the stop. Called when a session is (re)connected and verified — the only evidence that
 * exists for "whatever was broken is not broken any more".
 */
export async function clearLinkedInUnhealthy(connectionId: string): Promise<void> {
  noteLinkedInSuccess(connectionId);
  try {
    const conn = await connectionStore().getConnection(connectionId);
    // BOTH stamps, because both refuse. `linkedin_challenge` is the older one and it is written by
    // the SAME failure — a 401/403/999/captcha constructs `LinkedInChallengeError`, which stamps the
    // challenge in `asResult` and the unhealthy flag in `announceOnce`. Clearing only one left a
    // reconnected account permanently refused by `open()`'s challenge pre-flight and by pacing, with
    // no affordance anywhere that could remove it: a founder who did exactly what they were told,
    // and watched it not work.
    //
    // Only ever reached with a VERIFIED session behind it (see `persistSession`), which is the whole
    // licence for clearing a flag this load-bearing.
    if (!conn?.config?.linkedin_unhealthy && !conn?.config?.linkedin_challenge) return;
    const { linkedin_unhealthy: _drop, linkedin_challenge: _drop2, ...rest } = conn.config;
    await connectionStore().updateConnection(connectionId, { config: rest });
  } catch {
    /* a stale flag is refused-but-recoverable; a throw here would fail the reconnect itself */
  }
}

/** Stamp the connection so pacing refuses every further touch until they reconnect. */
async function persistLinkedInChallenge(connectionId: string, status: number): Promise<void> {
  try {
    const conn = await connectionStore().getConnection(connectionId);
    if (!conn) return;
    await connectionStore().updateConnection(connectionId, {
      config: {
        ...conn.config,
        linkedin_challenge: { at: new Date().toISOString(), status },
      },
    });
  } catch (err) {
    console.error(`[mycel] linkedin challenge flag NOT recorded for ${connectionId}:`, err);
  }
}

/** The tenant + engagement these rows belong to. Taken from the CONNECTION, never from a payload. */
const scopeOf = (conn: Connection, caseId?: string): GraphScope => ({ project_id: conn.project_id, case_id: caseId });

/**
 * Search people, and leave the results in the graph.
 *
 * A Commercial Search Limit comes back as a named code rather than a generic failure — see
 * `CommercialSearchLimitError`. It is the one search outcome a founder must not misread as "our
 * targeting is wrong".
 */
export async function searchLinkedInPeople(
  conn: Connection,
  q: PeopleQuery,
  caseId?: string,
): Promise<LiActionResult> {
  const opened = await open(conn);
  if (isRefusal(opened)) return opened;
  const refused = await paced(conn, "search_people");
  if (refused) return refused;
  try {
    const page = await searchPeople(opened.session, opened.ctx, q);
    // Only a search LinkedIn actually answered spends anything, and only then is it recorded.
    await noteLinkedInTouch(conn.id, "search_people");
    const scope = scopeOf(conn, caseId);
    const written = await writePeople(getLinkedInHost().records, scope, page.people, { field: "search" });
    // The employers named on the cards become stub company rows, which a later get_company fills in
    // through the same JSONB merge. Searching therefore populates the company list for free.
    const companies = await writeCompanies(getLinkedInHost().records, scope, companyStubs(page.people));
    return {
      ok: true,
      detail: `found ${page.people.length} ${page.people.length === 1 ? "person" : "people"} (via ${page.via})`,
      data: {
        people: page.people,
        total: page.total,
        next_start: page.next_start,
        records_written: written,
        companies_written: companies,
      },
    };
  } catch (e) {
    return asResult(e, conn);
  }
}

/**
 * People who work at a company, written to the graph exactly as a search would write them — but
 * WITHOUT spending the people-search quota. This is the unmetered discovery surface (see
 * `discover.ts`): when `search_people` is capped, the finder keeps producing prospects from here.
 *
 * Takes a vanity slug (`stripe`) or a numeric org id. A slug is resolved through `getCompany` once,
 * and that company is written to the graph on the way past — so asking for a company's people also
 * fills in the company row, the same free enrichment `search_people` gets from the cards.
 */
export async function discoverCompanyPeople(
  conn: Connection,
  input: { company?: string; company_id?: string; limit?: number; start?: number },
  caseId?: string,
): Promise<LiActionResult> {
  const opened = await open(conn);
  if (isRefusal(opened)) return opened;
  const refused = await paced(conn, "company_people");
  if (refused) return refused;
  try {
    const scope = scopeOf(conn, caseId);
    let companyId = (input.company_id ?? "").replace(/[^0-9]/g, "");
    if (!companyId && input.company) {
      const company = await getCompany(opened.session, opened.ctx, input.company);
      if (company) await writeCompanies(getLinkedInHost().records, scope, [company]);
      // A company entityUrn is `urn:li:fs_company:2135371` — the trailing segment is the org id the
      // People tab facets on.
      companyId = (company?.urn?.split(":").pop() ?? "").replace(/[^0-9]/g, "");
    }
    if (!companyId) {
      return { ok: false, detail: `couldn't resolve a LinkedIn company id for "${input.company ?? input.company_id ?? ""}"` };
    }
    const page = await companyPeople(opened.session, opened.ctx, {
      companyId,
      limit: input.limit,
      start: input.start,
    });
    await noteLinkedInTouch(conn.id, "company_people");
    const written = await writePeople(getLinkedInHost().records, scope, page.people, { field: "search" });
    const companies = await writeCompanies(getLinkedInHost().records, scope, companyStubs(page.people));
    return {
      ok: true,
      detail: `found ${page.people.length} ${page.people.length === 1 ? "person" : "people"} at the company (via ${page.via})`,
      data: {
        people: page.people,
        next_start: page.next_start,
        records_written: written,
        companies_written: companies,
      },
    };
  } catch (e) {
    return asResult(e, conn);
  }
}

/** One profile, in detail, written to the graph under its public identifier. */
export async function getLinkedInProfile(
  conn: Connection,
  profileId: string,
  caseId?: string,
): Promise<LiActionResult> {
  const opened = await open(conn);
  if (isRefusal(opened)) return opened;
  const refused = await paced(conn, "get_profile");
  if (refused) return refused;
  try {
    const profile = await getProfile(opened.session, opened.ctx, profileId);
    await noteLinkedInTouch(conn.id, "get_profile");
    if (!profile) return { ok: false, detail: `no profile visible to this account for "${profileId}"` };
    const scope = scopeOf(conn, caseId);
    await writePeople(getLinkedInHost().records, scope, [profile], { field: "profile" });
    await writeCompanies(getLinkedInHost().records, scope, companyStubs([profile]));
    return { ok: true, detail: profile.name ?? profile.public_id, data: { profile } };
  } catch (e) {
    return asResult(e, conn);
  }
}

/** One company page, written to the graph under its registrable domain. */
export async function getLinkedInCompany(conn: Connection, slug: string): Promise<LiActionResult> {
  const opened = await open(conn);
  if (isRefusal(opened)) return opened;
  const refused = await paced(conn, "get_company");
  if (refused) return refused;
  try {
    const company = await getCompany(opened.session, opened.ctx, slug);
    await noteLinkedInTouch(conn.id, "get_company");
    if (!company) return { ok: false, detail: `no company page for "${slug}"` };
    const written = await writeCompanies(getLinkedInHost().records, scopeOf(conn), [company]);
    return {
      ok: true,
      detail: company.name ?? slug,
      // A company with no resolvable website cannot be keyed on a domain, so it is READ but not
      // STORED — and the caller is told, rather than left to wonder why the CRM did not update.
      data: { company, stored: written > 0 },
    };
  } catch (e) {
    return asResult(e, conn);
  }
}

/**
 * A profile view: the cheapest warm-up touch there is, and a real one.
 *
 * It spends `profile_view` from the weekly budget, so it is paced like any other write even though
 * nothing is delivered. The view only reaches the target's notifications if the ACCOUNT's own
 * profile-viewing setting is public — which nothing here can verify, so nothing here claims it.
 */
export async function viewLinkedInProfile(
  conn: Connection,
  profileId: string,
  caseId?: string,
): Promise<LiActionResult> {
  const opened = await open(conn);
  if (isRefusal(opened)) return opened;
  const refused = await paced(conn, "view_profile");
  if (refused) return refused;
  try {
    const res = await viewProfile(opened.session, opened.ctx, profileId);
    if (!res.ok) return { ok: false, detail: res.detail };
    await noteLinkedInTouch(conn.id, "view_profile");
    const scope = scopeOf(conn, caseId);
    if (res.profile) await writePeople(getLinkedInHost().records, scope, [res.profile], { field: "profile" });
    return { ok: true, detail: res.detail, data: { profile: res.profile } };
  } catch (e) {
    return asResult(e, conn);
  }
}

/**
 * React to a post — a warm-up touch, and OFF by default (see engage.ts).
 *
 * Same door as every other write: vaulted session, store-backed pacing on the `follow` touch (the
 * per-seat budget its capability declares — no separate lane), one metered call, counter incremented
 * only on success. The kill-switch is checked FIRST, before any session or store read, so a disabled
 * warm-up is inert: it touches nothing, spends nothing, and reaches no network.
 */
export async function reactToLinkedInPost(
  conn: Connection,
  postUrn: string,
  reaction: string,
): Promise<LiActionResult> {
  if (!warmupEnabled()) return WARMUP_DISABLED;
  const opened = await open(conn);
  if (isRefusal(opened)) return opened;
  const refused = await paced(conn, "react_to_post");
  if (refused) return refused;
  try {
    const res = await reactToPost(opened.session, opened.ctx, postUrn, reaction);
    if (res.ok) await noteLinkedInTouch(conn.id, "react_to_post");
    return res;
  } catch (e) {
    return asResult(e, conn);
  }
}

/**
 * Follow a person without connecting — a warm-up touch, and OFF by default (see engage.ts).
 *
 * Identical shape to `reactToLinkedInPost`: kill-switch first, then session, pacing on the `follow`
 * touch, one metered call, counter only on success.
 */
export async function followLinkedInPerson(conn: Connection, memberUrn: string): Promise<LiActionResult> {
  if (!warmupEnabled()) return WARMUP_DISABLED;
  const opened = await open(conn);
  if (isRefusal(opened)) return opened;
  const refused = await paced(conn, "follow_person");
  if (refused) return refused;
  try {
    const res = await followPerson(opened.session, opened.ctx, memberUrn);
    if (res.ok) await noteLinkedInTouch(conn.id, "follow_person");
    return res;
  } catch (e) {
    return asResult(e, conn);
  }
}

/**
 * Endorse one listed skill — a warm-up touch, and OFF by default (see engage.ts).
 *
 * Identical shape to its two siblings: kill-switch first, then session, pacing, one metered call,
 * counter only on success. This wrapper existed in intent from the day `endorseSkill` was written
 * (d0d6bd6 built the executor and its tests), but the kernel-side wiring was dropped in the
 * package extraction — so the verb sat in WARMUP_GATED, declared dispatchable, with no dispatcher
 * behind it. The playbooks suite caught exactly that gap.
 */
export async function endorseLinkedInSkill(
  conn: Connection,
  memberUrn: string,
  skillUrn: string,
): Promise<LiActionResult> {
  if (!warmupEnabled()) return WARMUP_DISABLED;
  const opened = await open(conn);
  if (isRefusal(opened)) return opened;
  const refused = await paced(conn, "endorse_skill");
  if (refused) return refused;
  try {
    const res = await endorseSkill(opened.session, opened.ctx, memberUrn, skillUrn);
    if (res.ok) await noteLinkedInTouch(conn.id, "endorse_skill");
    return res;
  } catch (e) {
    return asResult(e, conn);
  }
}

/**
 * Send a connection request. The single most restriction-prone action in the system.
 *
 * It reaches the same door `send_message` does and takes the same two independent checks: the human
 * approval gate upstream (the action proxy, or a campaign envelope that a human approved once and
 * that is re-read from the store on every send), and store-backed pacing here. There is no bypass and
 * this comment exists so that adding one requires deleting it.
 *
 * A public identifier costs one extra profile read, because a slug and a member urn are unrelated
 * identifiers. That read is not waste — it is the "look at them first" step, and its result is
 * written to the graph on the way past.
 */
export async function sendLinkedInInvite(
  conn: Connection,
  profileId: string,
  note?: string,
  caseId?: string,
): Promise<LiActionResult> {
  const opened = await open(conn);
  if (isRefusal(opened)) return opened;

  // LINKEDIN ALREADY SAID NO, AND IT SAID IT ABOUT THE ACCOUNT.
  //
  // Before the note check, before pacing, before the profile read an invitation needs: if LinkedIn
  // refused this account's invitations recently for a reason that cannot have changed yet, this
  // returns the SAME named refusal without a single round-trip. The code travels, so the sequencer
  // parks the case for a day and — because these codes are account-level stops — abandons the rest
  // of the tick instead of asking the same dead question once per prospect.
  const inviteBlocked = invitesBlocked(conn.id);
  if (inviteBlocked) return { ok: false, code: inviteBlocked.code, detail: inviteBlocked.detail };

  // The note is checked BEFORE pacing, so an over-long note fails without spending anything.
  const checked = checkNote(note);
  if (checked.error) return { ok: false, detail: checked.error };

  const refused = await paced(conn, "send_invite");
  if (refused) return refused;

  try {
    const { session, ctx } = opened;
    const resolved = await resolveProfileUrn(session, ctx, profileId, (id) => getProfile(session, ctx, id));
    if (resolved.profile) {
      await writePeople(getLinkedInHost().records, scopeOf(conn, caseId), [resolved.profile as LiProfile], {
        field: "profile",
      });
    }
    if (!resolved.urn) {
      // WHY THIS BRANCH IS TWO BRANCHES. An invitation is addressed by member urn, and a slug cannot
      // be computed into one — so "no urn" has two completely different causes with two completely
      // different remedies, and the version that said one sentence for both is what let a fleet-wide
      // endpoint failure read as 5,000 individually unlucky prospects.
      //   · no read path works at all → PERMANENT and ours to fix. It carries the code so the
      //     sequencer waits a day instead of an hour, and the connection is stopped.
      //   · a read path works and this person just did not come back with a urn → per-prospect, no
      //     code, the loop moves on to the next one.
      const { latched, retired } = profileStrategyState();
      if (!latched && retired.length) {
        const dead = new LinkedInProfileEndpointUnknownError(
          retired.map((r) => `${r}: retired`),
          conn.id,
        );
        return asResult(dead, conn);
      }
      return {
        ok: false,
        detail:
          `could not resolve "${profileId}" to a LinkedIn member — no invitation sent` +
          (latched ? ` (the profile read via ${latched} returned no member urn for them)` : ""),
      };
    }
    const res = await sendInvite(session, ctx, resolved.urn, checked.note);
    // Only an invitation LinkedIn accepted spends allowance. Charging for a refusal would burn the
    // scarcest budget in the system on requests nobody received.
    if (res.ok) {
      // An invitation went through, so whatever LinkedIn was refusing, it is not refusing now.
      clearInviteRefusal(conn.id);
      await noteLinkedInTouch(conn.id, "send_invite");
    }
    return res.ok
      ? { ok: true, detail: "invitation sent", data: { invitation_id: res.invitation_id, shared_secret: res.shared_secret } }
      // A per-prospect refusal (`linkedin_invite_duplicate`) carries its code so the case parks for a
      // day rather than an hour — and carries NO account-level flag, because it is not one.
      : { ok: false, ...(res.code ? { code: res.code } : {}), detail: res.detail ?? "invitation failed" };
  } catch (e) {
    /**
     * THE NEGATIVE HALF OF THE FEEDBACK LOOP.
     *
     * `engagement.flagged` is read by `engagementMultiplier` — above 2% it collapses the account's
     * whole budget to 0.2 and pauses outreach — and nothing has ever written it. This is the write.
     *
     * The event it counts is LinkedIn REFUSING an invitation for quota or restriction reasons at a
     * moment when our own store-backed pacing had just said yes. `InviteQuotaError`'s own message
     * says it: "pacing should have stopped this first, so the configured budget is too high for this
     * account". That disagreement is the platform telling us it disagrees with our model of the
     * account, and throttling ourselves on it is the entire purpose of the multiplier.
     *
     * ONE EPISODE IS ONE FLAG, and this is the correction to the version that shipped.
     *
     * The counter used to be incremented on every refusal. It is read as a RATE — `flagged / sent` —
     * and `sent` cannot grow while invitations are being refused, so a caller that walked a prospect
     * list against a refusal that was never going to clear booked one flag per prospect per tick
     * against a frozen denominator. The founder's own account reached `{sent: 6, flagged: 305}` in a
     * single evening that way: 305 is not 305 refusals worth of evidence, it is one refusal counted
     * 305 times, and the multiplier would have read it as a 5,000% flag rate.
     *
     * So the breaker decides. `noteInviteRefusal` opens an episode and answers `first`; the counter
     * moves once per episode, and every attempt behind it is turned away by `invitesBlocked` above
     * without reaching LinkedIn at all. A NEW cause during an open episode (weekly → restricted) is
     * genuinely new evidence and counts again.
     *
     * WHAT IS DELIBERATELY NOT COUNTED HERE, and it is tempting: an invitation that quietly
     * disappears from the sent list without the person becoming a connection. That reads like "I
     * don't know this person", and it is not — it is dominated by people who simply ignored it, and
     * ignore rates run an order of magnitude above the 2% cliff. Wiring that in would pause every
     * healthy account in the fleet within a fortnight, and it would look exactly like the safety
     * system working.
     *
     * Best-effort: a failed counter write must not change what the caller is told about the send.
     */
    if (e instanceof InviteQuotaError) {
      const { first, untilMs } = noteInviteRefusal(conn.id, e.reason, e.code, e.message);
      if (first) {
        console.error(
          `[mycel] linkedin invitations refused for ${conn.id} (${e.reason}) — not retrying for ` +
            `${Math.round(untilMs / 3_600_000)}h: ${e.message}`,
        );
        await getLinkedInHost().pacing.recordEngagement(conn.id, { flagged: 1 }).catch((err) =>
          console.error(`[mycel] pacing flag NOT recorded for ${conn.id}:`, err),
        );
      }
    }
    return asResult(e, conn);
  }
}

/**
 * Withdraw a pending invitation — the only action here that GIVES budget back.
 *
 * Free (`touch: null`) because it costs nothing to spend; worth running on everything older than
 * three weeks, because until it is withdrawn a pending invitation is still counted against the
 * weekly limit.
 */
export async function withdrawLinkedInInvite(
  conn: Connection,
  invitationId: string,
  sharedSecret?: string,
): Promise<LiActionResult> {
  const opened = await open(conn);
  if (isRefusal(opened)) return opened;
  try {
    const res = await withdrawInvite(opened.session, opened.ctx, invitationId, sharedSecret);
    return res.ok
      ? { ok: true, detail: "invitation withdrawn — that allowance is back", data: { invitation_id: res.invitation_id } }
      : { ok: false, detail: res.detail ?? "withdraw failed" };
  } catch (e) {
    return asResult(e, conn);
  }
}

// ── Inbound ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Sync an account's inbox using the cheapest path LinkedIn offers, and persist the cursor.
 *
 * The cursor is the whole optimisation (see voyager.ts): it is kept on the Connection so it survives
 * a restart — a lost token means one expensive full page, and losing it on every deploy would put
 * the bandwidth bill straight back where it started.
 */
export async function syncLinkedInInbox(conn: Connection): Promise<SyncResult> {
  const session = await getLinkedInSession(conn.id);
  if (!session) throw new Error("linkedin session not found or expired — reconnect the account");
  const state = { syncToken: typeof conn.config.sync_token === "string" ? conn.config.sync_token : undefined };
  const result = await syncConversations(session, await voyagerCtx(conn), state);
  if (result.syncToken && result.syncToken !== state.syncToken) {
    /**
     * ═══ RE-READ BEFORE WRITING, BECAUSE `conn` IS AS OLD AS THE HOST ═══
     *
     * `updateConnection` REPLACES `config` wholesale — it is `config = COALESCE($3::jsonb, config)`,
     * not a merge. And `conn` here is whatever the caller is holding, which in the worker is the
     * connection `wireLinkedInHost` memoised once at boot. So spreading `...conn.config` writes back
     * a snapshot of the config as it was at wire time, silently undoing every key changed since.
     *
     * That resurrected the breaker on a loop and cost two days of LinkedIn. The health probe cleared
     * `linkedin_unhealthy` and logged `healed`; forty seconds later the inbox sync wrote a new
     * `sync_token` carrying the boot-time config, and the stamp was back. The tell was that its `at`
     * never moved off `2026-09-03T14:21:04.103Z` while the clears kept succeeding — a fresh failure
     * writes a fresh timestamp (see `persistLinkedInUnhealthy`), so an OLD timestamp reappearing is
     * a replay, not a re-stamp. Cleared by hand at 06:09 and by the probe at 06:24; back both times.
     *
     * `persistLinkedInUnhealthy` and `persistLinkedInChallenge` immediately above both re-read the
     * connection before writing, for exactly this reason. This one did not, and it is the only one
     * of the three that runs on every tick.
     */
    const fresh = (await connectionStore().getConnection(conn.id)) ?? conn;
    await connectionStore().updateConnection(conn.id, {
      config: { ...fresh.config, sync_token: result.syncToken },
    });
  }

  // THE FEEDBACK HALF OF PACING. A reply is the strongest positive signal LinkedIn scores, and this
  // is the only place in the system that learns one — so the engagement counter is written here or
  // it is never written at all, and `engagementMultiplier` scores every account as if nobody had
  // ever answered it.
  //
  // Counted through the sequencer's cases rather than off the raw inbound list, for two reasons:
  // it dedupes (a prospect who sends four messages is one reply, not four, and inflating the
  // numerator would silently EARN budget), and it excludes inbound from people this account never
  // contacted — recruiters, spam — who are not in the denominator `sent` measures either.
  //
  // Wrapped: an inbox sync that fails because of bookkeeping would cost the founder their messages.
  try {
    // Narrowed rather than passed through: `noteInboundReplies` now REQUIRES a project because the
    // case read behind it applies no tenant filter without one. An account with no project gets its
    // messages and no bookkeeping, which is the only honest answer.
    const project_id = conn.project_id;
    const host = getLinkedInHost();
    const newReplies = project_id ? await host.inbound.noteInboundReplies({ id: conn.id, project_id }, result.inbound) : 0;
    if (newReplies > 0) await host.pacing.recordEngagement(conn.id, { replied: newReplies });
    // Unmatched inbound is NOT a reply-rate event. Capture them as `replied` cases so Pipeline
    // and the reply-handoff see the people who wrote first, without earning pacing budget.
    if (project_id) {
      await host.inbound.captureUnsolicitedInbound({ id: conn.id, project_id }, result.inbound).catch((e) =>
        console.error(`[mycel] unsolicited inbound capture failed for ${conn.id}:`, e),
      );
    }
  } catch (e) {
    console.error(`[mycel] inbound reply bookkeeping failed for ${conn.id}:`, e);
  }
  return result;
}

/**
 * Learn which invitations were accepted, and tell the sequencer and pacing.
 *
 * The mirror image of `syncLinkedInInbox`: one cheap read, then the bookkeeping the read makes
 * possible. See network.ts for why this is the connections list and not a per-prospect degree check
 * or the sent-invitations list.
 *
 * TENANCY IS A PRECONDITION, NOT A FILTER. A connection with no project cannot be reconciled at all,
 * because the case read it drives applies NO tenant filter when handed `undefined` — it would walk
 * every customer's pipeline looking for a profile id. There is no sensible fallback, so there is
 * none: it refuses.
 *
 * Never throws for a LinkedIn-side refusal. This runs on the sequencer tick beside twenty-five
 * unrelated cases, and a 403 from Voyager must not become "sequencer error" on all of them.
 */
export async function syncLinkedInNetwork(conn: Connection): Promise<NetworkSyncResult> {
  if (!conn.project_id) {
    return { ok: false, accepted: 0, seen: 0, bytes: 0, detail: "this LinkedIn account has no project — nothing can be reconciled against it" };
  }
  const session = await getLinkedInSession(conn.id);
  if (!session) return { ok: false, accepted: 0, seen: 0, bytes: 0, detail: "linkedin session not found or expired — reconnect the account" };

  let page: Awaited<ReturnType<typeof recentConnections>>;
  try {
    page = await recentConnections(session, await voyagerCtx(conn));
  } catch (e) {
    if (e instanceof ProxyRequiredError) return { ok: false, accepted: 0, seen: 0, bytes: 0, detail: e.message };
    return { ok: false, accepted: 0, seen: 0, bytes: 0, detail: (e as Error)?.message ?? "linkedin connections read failed" };
  }
  if (!page.ok) return { ok: false, accepted: 0, seen: 0, bytes: page.bytes, detail: page.detail };

  const project_id = conn.project_id;
  const r = await getLinkedInHost().inbound.noteAcceptedInvitations({ id: conn.id, project_id }, { connected: page.public_ids });

  // THE POSITIVE HALF OF THE FEEDBACK LOOP, and it is counted off the CASE TRANSITIONS rather than
  // off the observed list. `engagement.sent` counts invitations, so its numerator must count
  // invitations that were answered — not first-degree connections, most of whom this system never
  // invited. Since acceptance only ever RAISES the multiplier, an inflated numerator is an account
  // earning budget it did not earn.
  if (r.accepted > 0) {
    await getLinkedInHost().pacing.recordEngagement(conn.id, { accepted: r.accepted }).catch((e) =>
      console.error(`[mycel] acceptance bookkeeping failed for ${conn.id}:`, e),
    );
  }
  return { ok: true, accepted: r.accepted, case_ids: r.case_ids, seen: page.public_ids.length, pending: r.pending, bytes: page.bytes };
}

export interface NetworkSyncResult {
  ok: boolean;
  /** Cases that moved `invited` → `connected` in this poll. The engagement delta. */
  accepted: number;
  /** Which ones, so the caller can fire `invite_accepted` naming them. */
  case_ids?: string[];
  /** How many connections the page returned, and how many cases were still waiting. Both for "why nothing happened". */
  seen: number;
  pending?: number;
  bytes: number;
  detail?: string;
}

/** Bytes transferred by this account. The measurable half of the cost story (see meter.ts). */
export function linkedInUsage(connectionId: string): AccountUsage | undefined {
  return usageFor(connectionId);
}

export async function disconnectLinkedIn(connectionId: string): Promise<void> {
  const pend = pending.get(connectionId);
  if (pend) {
    await pend.ctx.close().catch(() => {});
    await pend.driver.close().catch(() => {});
    pending.delete(connectionId);
  }
  forgetLiveSession(connectionId);
  await deleteSecret(connectionId).catch(() => {});
  await deleteSecret(proxyKey(connectionId)).catch(() => {});
  releaseProxy(connectionId);
  forgetUsage(connectionId);
  await connectionStore().deleteConnection(connectionId);
}

/** Test-only: clear in-memory pending logins. */
export function _resetPending(): void {
  pending.clear();
  liveSessions.clear();
}

export { bindJarPersist, setSessionRotatedHandler, noteSessionRotated } from "./voyager";

/** Test-only: swap the session verifier (default is the live Voyager /me call). */
export function _setVerifier(fn: typeof verifier): void {
  verifier = fn;
}


/**
 * Withdraw an endorsement we made.
 *
 * Same door as every other write — vaulted session, metered, one call — with one deliberate
 * difference: NO `warmupEnabled()` check. Every other engage verb is behind that switch because it
 * decides whether we may touch a stranger's profile. This one decides whether we may STOP touching
 * it, and gating the undo behind the same flag as the do is how you end up with endorsements you
 * are no longer allowed to remove.
 *
 * Not paced either. Cleanup must not queue behind the day's outreach budget: the whole point is
 * that it happens promptly once somebody opts out.
 */
export async function withdrawLinkedInEndorsement(
  conn: Connection,
  memberUrn: string,
  skillUrn: string,
): Promise<LiActionResult> {
  const opened = await open(conn);
  if (isRefusal(opened)) return opened;
  try {
    const res = await withdrawEndorsement(opened.session, opened.ctx, memberUrn, skillUrn);
    return res.ok ? { ok: true, detail: res.detail } : { ok: false, detail: res.detail, code: res.code };
  } catch (e) {
    return asResult(e, conn);
  }
}
