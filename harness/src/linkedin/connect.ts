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
import type { Connection, ConnectionOwner } from "../contract";
import { getDomainStore } from "../domain";
import { getSecret, setSecret, deleteSecret } from "../secrets";
import { assertSendAllowed, recordEngagement, recordTouch } from "../pacing";
import { touchFor } from "./capabilities";
import { noteInboundReplies } from "../gtm/replies";
import { startLogin, submitChallenge, type BrowserDriver, type PendingLogin } from "./login";
import { ProxyRequiredError, redactProxy, requireProxy } from "./proxy";
import { forgetUsage, usageFor, type AccountUsage } from "./meter";
import {
  fetchSelf,
  sendMessage,
  syncConversations,
  type LinkedInSession,
  type LiSendResult,
  type SyncResult,
  type VoyagerCtx,
} from "./voyager";

export type ConnectPhase = "connected" | "needs_2fa" | "failed";

export interface ConnectResult {
  phase: ConnectPhase;
  connection_id: string;
  handle?: string;
  error?: string;
  /** "linkedin_proxy_required" when the refusal was the proxy rule — the caller answers 400. */
  code?: string;
}

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
) => Promise<{ self_urn?: string; mailbox_urn?: string; name?: string } | null> = fetchSelf;

/** The egress context for a connection: its id (what bytes are metered against) and its proxy. */
export async function voyagerCtx(conn: Connection): Promise<VoyagerCtx> {
  return { connectionId: conn.id, proxyUrl: await getSecret(proxyKey(conn.id)) };
}

async function persistSession(
  connectionId: string,
  session: LinkedInSession,
  proxyUrl?: string,
): Promise<{ verified: boolean; name?: string }> {
  // Confirm the session is live and learn the self/mailbox urns (so inbound skips our own messages
  // and the cheap GraphQL sync path has a mailbox to address).
  const me = await verifier(session, { connectionId, proxyUrl }).catch(() => null);
  const full: LinkedInSession = {
    ...session,
    self_urn: me?.self_urn ?? session.self_urn,
    mailbox_urn: me?.mailbox_urn ?? session.mailbox_urn,
  };
  // Stored under the connection id → the action proxy's resolveSecret(secret_ref, conn.id) finds it.
  await setSecret(connectionId, JSON.stringify(full));
  return { verified: me !== null, name: me?.name };
}

interface ConnectBase {
  proxyUrl?: string;
  owner?: ConnectionOwner;
  project_id?: string;
  name?: string;
}

/** Create the Connection row and vault its proxy. Throws ProxyRequiredError before creating
 *  anything, so a refused connect leaves no half-made account behind. */
async function newConnection(input: ConnectBase & { label: string }): Promise<{ conn: Connection; proxyUrl?: string }> {
  const proxyUrl = requireProxy(input.proxyUrl, "connecting a LinkedIn account");
  const conn = await getDomainStore().createConnection({
    project_id: input.project_id,
    kind: "linkedin",
    name: input.name ?? input.label,
    owner: input.owner ?? { kind: "founder", id: "founder" },
    // Non-secret settings only. The proxy url goes to the vault; its host is fine to show.
    config: { proxy: redactProxy(proxyUrl) },
  });
  if (proxyUrl) await setSecret(proxyKey(conn.id), proxyUrl);
  return { conn, proxyUrl };
}

/**
 * THE PREFERRED PATH: adopt a session the member already has.
 *
 * They are logged into LinkedIn in their own browser; we take the two cookies that session is made
 * of. No password is transmitted, held, or typed into anything we wrote — which also means there is
 * no headless login for LinkedIn to flag, and no Playwright dependency on this path at all.
 */
export async function connectWithSession(
  input: ConnectBase & { li_at: string; jsessionid: string },
): Promise<ConnectResult> {
  let created: { conn: Connection; proxyUrl?: string };
  try {
    created = await newConnection({ ...input, label: "LinkedIn" });
  } catch (e) {
    if (e instanceof ProxyRequiredError) return { phase: "failed", connection_id: "", error: e.message, code: e.code };
    throw e;
  }
  const { conn, proxyUrl } = created;
  const { verified, name } = await persistSession(
    conn.id,
    { li_at: input.li_at, jsessionid: input.jsessionid },
    proxyUrl,
  );
  // Cookies that /me rejects are not a connection. Fail here — at the moment the member is looking
  // at the screen — rather than at the first send, days later, inside an approved action.
  if (!verified) {
    await deleteSecret(conn.id).catch(() => {});
    return {
      phase: "failed",
      connection_id: conn.id,
      error: "LinkedIn rejected those cookies — copy li_at and JSESSIONID from a live, logged-in session",
    };
  }
  if (name) await getDomainStore().updateConnection(conn.id, { name: `LinkedIn (${name})` });
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
    if (e instanceof ProxyRequiredError) return { phase: "failed", connection_id: "", error: e.message, code: e.code };
    throw e;
  }
  const { conn, proxyUrl } = created;
  // The email is not a secret and identifies the account in the UI; the password is not stored.
  await getDomainStore().updateConnection(conn.id, { config: { ...conn.config, email: input.email } });

  const { outcome, pending: pend } = await startLogin(input.email, input.password, {
    proxyUrl,
    driverFactory: input.driverFactory,
  });

  if (outcome.phase === "connected" && outcome.session) {
    const { name } = await persistSession(conn.id, outcome.session, proxyUrl);
    return { phase: "connected", connection_id: conn.id, handle: name };
  }
  if (outcome.phase === "needs_2fa" && pend) {
    pending.set(conn.id, pend);
    return { phase: "needs_2fa", connection_id: conn.id };
  }
  return { phase: "failed", connection_id: conn.id, error: outcome.error, code: outcome.code };
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
    const { name } = await persistSession(connectionId, outcome.session, pend.proxyUrl);
    return { phase: "connected", connection_id: connectionId, handle: name };
  }
  return { phase: "failed", connection_id: connectionId, error: outcome.error };
}

/** Load a connected account's session from the vault. */
export async function getLinkedInSession(connectionId: string): Promise<LinkedInSession | null> {
  const raw = await getSecret(connectionId);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as LinkedInSession;
  } catch {
    return null;
  }
}

// ── Outbound ─────────────────────────────────────────────────────────────────────────────────────
//
// Two independent checks stand between an agent and a stranger's LinkedIn inbox, and they answer
// different questions:
//
//   · The APPROVAL GATE (upstream, in the action proxy) asks "should this message be sent at all?"
//     A human answers it, one message at a time.
//   · PACING (here, ../pacing) asks "may this account send anything right now?" — the weekly
//     allowance, the ramp for a young account, the 8am-7pm weekday window, the spacing between
//     touches. A human approving twenty messages at 11pm does not make it safe to deliver twenty
//     messages at 11pm, which is exactly why this check is not part of the approval.
//
// Pacing returns a verdict rather than throwing, and the reason is a sentence for the founder
// ("you have used 78 of your 80 invitations this week"), so it is passed straight through.

/** Swappable for tests. Defaults to the real, store-backed pacing engine. */
type PacingCheck = typeof assertSendAllowed;
let pacingCheck: PacingCheck | null = assertSendAllowed;

/** Test hook: install a pacing function, or null to skip the check entirely. */
export function _setPacing(fn: PacingCheck | null): void {
  pacingCheck = fn;
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
    await recordTouch(getDomainStore(), connectionId, kind);
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

  if (pacingCheck) {
    const verdict = await pacingCheck(getDomainStore(), conn.id, "message");
    if (!verdict.allowed) {
      // A pacing refusal is a normal outcome, not a crash — and its reason is written for the
      // founder, so it goes back verbatim.
      return { ok: false, detail: `paced: ${verdict.reason ?? "not allowed right now"}` };
    }
  }

  try {
    const res = await sendMessage(session, await voyagerCtx(conn), threadUrn, text);
    // Only a send LinkedIn accepted spends budget. Charging for a failure would burn allowance on
    // messages nobody received; charging before the call would do it on every transport blip.
    if (res.ok) await noteLinkedInTouch(conn.id, "send_message");
    return res;
  } catch (e) {
    if (e instanceof ProxyRequiredError) return { ok: false, detail: e.message };
    // Never echo the message body back in an error.
    return { ok: false, detail: `linkedin send failed: ${(e as Error)?.message ?? "unknown error"}` };
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
    await getDomainStore().updateConnection(conn.id, {
      config: { ...conn.config, sync_token: result.syncToken },
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
    const newReplies = await noteInboundReplies(getDomainStore(), conn, result.inbound);
    if (newReplies > 0) await recordEngagement(getDomainStore(), conn.id, { replied: newReplies });
  } catch (e) {
    console.error(`[mycel] inbound reply bookkeeping failed for ${conn.id}:`, e);
  }
  return result;
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
  await deleteSecret(connectionId).catch(() => {});
  await deleteSecret(proxyKey(connectionId)).catch(() => {});
  forgetUsage(connectionId);
}

/** Test-only: clear in-memory pending logins. */
export function _resetPending(): void {
  pending.clear();
}

/** Test-only: swap the session verifier (default is the live Voyager /me call). */
export function _setVerifier(fn: typeof verifier): void {
  verifier = fn;
}
