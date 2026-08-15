// The client portal — a customer's own view of the work being done for them.
//
// Until now every route in the kernel answered to the founder: a member session or a product API
// key. A client had no identity at all, which meant the only way to show them anything was for the
// founder to forward it by hand. That's the gap this closes.
//
// The design constraint that shapes everything here: a client session must be USELESS anywhere
// except that client's own data. Not "filtered to" — useless. So client tokens live in their own
// registry that `resolveAuth` never consults, which means presenting one to a founder route fails
// as an unknown credential rather than as an authorised request that happens to return nothing. A
// filter you forget to apply leaks; a credential the route can't even parse doesn't.
//
// Access works like a magic link because the alternative is asking a bookkeeping client to invent
// and remember a password for a portal they'll open four times a year. The founder mints a link;
// exchanging it once yields a longer-lived session.
import { createHash, randomBytes } from "node:crypto";
import { databaseUrl } from "./config";

/** How long a minted link stays exchangeable. Short: it's a link sitting in an email. */
const LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** How long the session lasts once exchanged. Long: nobody wants a fresh link every visit. */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * How long after the FIRST exchange the same link still yields the SAME session.
 *
 * ─── The failure this exists for ──────────────────────────────────────────────────────────────
 *
 * Strict single-use assumes the first GET of the URL is the human. It is very often not. The link
 * travels by email, and the things that fetch a URL out of an email before its recipient does are
 * numerous and entirely routine: Microsoft Defender Safe Links, Mimecast, Barracuda and Proofpoint
 * all follow links to score them; Gmail and iMessage unfurl them for a preview; corporate proxies
 * pre-scan attachments and hrefs. Every one of those is a GET from a machine that discards the
 * response, the Set-Cookie and the session it was just handed. The human then clicks, and is told
 * their link has expired — with no way back, because the token was the only way in.
 *
 * That is the classic way magic links die in the wild, and nothing in the previous design could
 * distinguish it from an attacker replaying a forwarded email.
 *
 * ─── What is traded, precisely ────────────────────────────────────────────────────────────────
 *
 * The original comment on `used` was right: "a link that still works is a link anyone who saw the
 * email can reuse". That property is kept, with a fifteen-minute hole in it. Inside the window the
 * link returns the session it already minted — not a new one — so N exchanges produce ONE session,
 * and revoking that session kills every copy. Outside the window the link is dead exactly as
 * before. So a forwarded email is still worthless to the recipient a day later, which is the threat
 * that actually happens; the residual exposure is someone who both sees the mailbox and acts within
 * a quarter of an hour of the legitimate click, at which point they have the inbox anyway and can
 * simply request a new link.
 *
 * The alternative — an interstitial page whose POST does the exchange, as `signout/route.ts` does —
 * costs the client a click on every single visit. Email is the interface; the click budget is one.
 */
const EXCHANGE_GRACE_MS = 15 * 60 * 1000;

export interface ClientScope {
  kind: "client";
  project_id: string;
  client_id: string;
}

interface StoredLink {
  hash: string;
  project_id: string;
  client_id: string;
  expires_at: number;
  /** Single-use. A link that still works is a link anyone who saw the email can reuse. */
  used: boolean;
  /** When it was first exchanged — the start of `EXCHANGE_GRACE_MS`. Null until then. */
  used_at?: number | null;
  /**
   * The session the first exchange produced. Re-exchanging inside the grace window hands back THIS
   * one rather than minting another, so a link can never fan out into a family of sessions that
   * revoking the client has to find individually.
   */
  session_token?: string | null;
}

interface StoredSession extends ClientScope {
  token: string;
  expires_at: number;
}

// In-process cache AND, when a database is configured, the durable copy that actually matters.
//
// These used to be the only storage, which was wrong in two ways that only appear in production: a
// deploy silently signed out every customer, and on more than one replica a link minted by A could
// not be exchanged on B. The maps stay as a read cache so the common path costs nothing; the
// database is consulted on a miss, which is what makes a session portable between replicas.
const links = new Map<string, StoredLink>();
const sessions = new Map<string, StoredSession>();

let pg: import("./portal.pg").PortalPg | null = null;

/** Boot-time: attach durable portal credentials when MYCEL_DATABASE_URL is set. */
export async function initPortalStore(): Promise<{ backend: "postgres" | "memory" }> {
  const url = databaseUrl();
  if (!url) return { backend: "memory" };
  const { PortalPg } = await import("./portal.pg");
  pg = await PortalPg.connect(url);
  return { backend: "postgres" };
}

export async function closePortalStore(): Promise<void> {
  await pg?.close().catch(() => {});
  pg = null;
}

const digest = (t: string) => createHash("sha256").update(t).digest("hex");

/**
 * Mint a portal link for a client. Returns the raw token ONCE — only its hash is kept, so a stolen
 * database yields no working links.
 */
export function mintPortalLink(args: {
  project_id: string;
  client_id: string;
  ttlMs?: number;
}): { token: string; expires_at: string } {
  const token = `mpl_${randomBytes(24).toString("base64url")}`;
  const expires_at = Date.now() + (args.ttlMs ?? LINK_TTL_MS);
  const row: StoredLink = {
    hash: digest(token),
    project_id: args.project_id,
    client_id: args.client_id,
    expires_at,
    used: false,
    used_at: null,
    session_token: null,
  };
  links.set(row.hash, row);
  if (pg) void pg.putLink(row).catch((e) => console.error("[mycel] portal link persist error:", e));
  return { token, expires_at: new Date(expires_at).toISOString() };
}

/**
 * Exchange a link for a session. Time-bound, and single-use outside `EXCHANGE_GRACE_MS`; returns
 * undefined for anything else.
 *
 * Two outcomes are deliberately indistinguishable to the caller: a first exchange and a
 * within-grace re-exchange both return a session and say nothing about which happened. The portal
 * has no decision to make with that information, and the one caller who WOULD find it interesting
 * is somebody testing whether a link they found has been opened yet.
 */
export async function exchangePortalLink(
  token: string,
): Promise<{ token: string; scope: ClientScope; expires_at: string } | undefined> {
  const hash = digest(token);
  const now = Date.now();
  let link = links.get(hash);

  if (pg) {
    // The claim is a single UPDATE … WHERE used = false, so two simultaneous clicks on the same
    // forwarded email can't both succeed. The cache is advisory here; the database decides.
    const claimed = await pg.claimLink(hash, now);
    if (claimed) {
      link = { ...claimed };
      links.set(hash, link);
    } else {
      // Not claimable. Either it never existed, or it has expired, or — the case this branch is
      // entirely for — a link scanner claimed it seconds ago and threw the session away. Ask the
      // database whether the session that claim produced is still inside its grace window.
      const replay = await pg.replayLink(hash, now, now - EXCHANGE_GRACE_MS);
      if (!replay) return undefined;
      links.set(hash, { ...replay.link });
      return sessionResponse(await adoptSession(replay.session));
    }
  } else {
    // Memory-only (tests, and a kernel booted with no database). Same rules, read straight off the
    // row: unexpired, and either unused or used recently enough that the session is still the one
    // this link is entitled to hand back.
    if (!link) return undefined;
    if (link.used) {
      // The link's own TTL is deliberately not re-tested here — see the note in `replayLink`. It
      // was satisfied when the claim happened; the session is the thing that has to still be alive.
      const withinGrace = (link.used_at ?? 0) >= now - EXCHANGE_GRACE_MS;
      const prior = link.session_token ? sessions.get(link.session_token) : undefined;
      if (!withinGrace || !prior || prior.expires_at < now) return undefined;
      return sessionResponse(prior);
    }
    if (link.expires_at < now) return undefined;
  }
  if (!link) return undefined;

  const session: StoredSession = {
    kind: "client",
    token: `mcli_${randomBytes(24).toString("base64url")}`,
    project_id: link.project_id,
    client_id: link.client_id,
    expires_at: now + SESSION_TTL_MS,
  };
  sessions.set(session.token, session);
  link.used = true;
  link.used_at = now;
  link.session_token = session.token;

  if (pg) {
    // Session first, then the pointer to it. The other order can leave a link claiming a session
    // row that does not exist yet, and a re-exchange arriving in that gap gets `undefined` — the
    // exact dead end this whole mechanism is here to remove.
    await pg.putSession({
      token: session.token,
      project_id: session.project_id,
      client_id: session.client_id,
      expires_at: session.expires_at,
    });
    await pg.noteLinkExchanged(hash, now, session.token);
  }
  return sessionResponse(session);
}

/** Warm the read cache with a session the database returned, and hand it back. */
async function adoptSession(s: StoredSession): Promise<StoredSession> {
  sessions.set(s.token, s);
  return s;
}

const sessionResponse = (s: StoredSession) => ({
  token: s.token,
  scope: { kind: "client" as const, project_id: s.project_id, client_id: s.client_id },
  expires_at: new Date(s.expires_at).toISOString(),
});

/**
 * Resolve a client session.
 *
 * Deliberately NOT wired into `resolveAuth`. A client token presented to a founder route must fail
 * as an unrecognised credential — the strongest possible outcome, because it doesn't depend on every
 * founder route remembering to check what kind of caller it has.
 */
export async function resolveClientSession(token: string): Promise<ClientScope | undefined> {
  const cached = sessions.get(token);
  if (cached && cached.expires_at >= Date.now()) {
    return { kind: "client", project_id: cached.project_id, client_id: cached.client_id };
  }
  if (cached) sessions.delete(token);

  // Cache miss is the normal case after a deploy, or on a replica that didn't mint this session.
  // Before this lookup existed, both of those looked identical to "your link is no longer valid".
  if (!pg) return undefined;
  const row = await pg.getSession(token, Date.now());
  if (!row) return undefined;
  sessions.set(token, { kind: "client", ...row });
  return { kind: "client", project_id: row.project_id, client_id: row.client_id };
}

/** Sign a client out of every device. Used when a founder revokes access. */
export async function revokeClientSessions(clientId: string): Promise<number> {
  let n = 0;
  for (const [token, s] of sessions) {
    if (s.client_id === clientId) {
      sessions.delete(token);
      n++;
    }
  }
  for (const [k, l] of links) {
    // Unexchanged links are revoked too, or "revoke access" would leave a working key in an inbox.
    if (l.client_id === clientId && !l.used) links.delete(k);
  }
  // The database is authoritative: a session this replica never saw must die too, or "revoke
  // access" only revokes it on whichever box handled the click.
  if (pg) n = Math.max(n, await pg.revokeClient(clientId));
  return n;
}

/** Test seam — the registries are process-local, exactly like the action grants. */
export function _resetPortal(): void {
  links.clear();
  sessions.clear();
}
