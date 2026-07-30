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

/** How long a minted link stays exchangeable. Short: it's a link sitting in an email. */
const LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** How long the session lasts once exchanged. Long: nobody wants a fresh link every visit. */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

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
}

interface StoredSession extends ClientScope {
  token: string;
  expires_at: number;
}

const links = new Map<string, StoredLink>();
const sessions = new Map<string, StoredSession>();

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
  links.set(digest(token), {
    hash: digest(token),
    project_id: args.project_id,
    client_id: args.client_id,
    expires_at,
    used: false,
  });
  return { token, expires_at: new Date(expires_at).toISOString() };
}

/** Exchange a link for a session. Single-use and time-bound; returns undefined for anything else. */
export function exchangePortalLink(token: string): { token: string; scope: ClientScope; expires_at: string } | undefined {
  const link = links.get(digest(token));
  if (!link || link.used || link.expires_at < Date.now()) return undefined;
  link.used = true;
  const session: StoredSession = {
    kind: "client",
    token: `mcli_${randomBytes(24).toString("base64url")}`,
    project_id: link.project_id,
    client_id: link.client_id,
    expires_at: Date.now() + SESSION_TTL_MS,
  };
  sessions.set(session.token, session);
  return {
    token: session.token,
    scope: { kind: "client", project_id: session.project_id, client_id: session.client_id },
    expires_at: new Date(session.expires_at).toISOString(),
  };
}

/**
 * Resolve a client session.
 *
 * Deliberately NOT wired into `resolveAuth`. A client token presented to a founder route must fail
 * as an unrecognised credential — the strongest possible outcome, because it doesn't depend on every
 * founder route remembering to check what kind of caller it has.
 */
export function resolveClientSession(token: string): ClientScope | undefined {
  const s = sessions.get(token);
  if (!s) return undefined;
  if (s.expires_at < Date.now()) {
    sessions.delete(token);
    return undefined;
  }
  return { kind: "client", project_id: s.project_id, client_id: s.client_id };
}

/** Sign a client out of every device. Used when a founder revokes access. */
export function revokeClientSessions(clientId: string): number {
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
  return n;
}

/** Test seam — the registries are process-local, exactly like the action grants. */
export function _resetPortal(): void {
  links.clear();
  sessions.clear();
}
