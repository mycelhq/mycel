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
  };
  links.set(row.hash, row);
  if (pg) void pg.putLink(row).catch((e) => console.error("[mycel] portal link persist error:", e));
  return { token, expires_at: new Date(expires_at).toISOString() };
}

/** Exchange a link for a session. Single-use and time-bound; returns undefined for anything else. */
export async function exchangePortalLink(
  token: string,
): Promise<{ token: string; scope: ClientScope; expires_at: string } | undefined> {
  const hash = digest(token);
  let link = links.get(hash);
  const fresh = link && !link.used && link.expires_at >= Date.now();

  if (pg) {
    // The claim is a single UPDATE … WHERE used = false, so two simultaneous clicks on the same
    // forwarded email can't both succeed. The cache is advisory here; the database decides.
    const claimed = await pg.claimLink(hash, Date.now());
    if (!claimed) return undefined;
    link = { ...claimed };
    links.set(hash, link);
  } else if (!fresh) {
    return undefined;
  }
  if (!link) return undefined;
  link.used = true;
  const session: StoredSession = {
    kind: "client",
    token: `mcli_${randomBytes(24).toString("base64url")}`,
    project_id: link.project_id,
    client_id: link.client_id,
    expires_at: Date.now() + SESSION_TTL_MS,
  };
  sessions.set(session.token, session);
  if (pg) {
    await pg.putSession({
      token: session.token,
      project_id: session.project_id,
      client_id: session.client_id,
      expires_at: session.expires_at,
    });
  }
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
