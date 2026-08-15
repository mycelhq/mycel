// Scoped magic links for third-party counterparties on a ClientRequest.
//
// Recruiting asks a candidate for a CV; contract-desk asks a contractor for a timesheet; security
// asks an assessor for evidence. Same ask/wait/nudge grammar as the client — different identity.
// A party session can ONLY see and answer the one request the link was minted for. It is useless
// on founder routes and on the client portal (separate credential plane, same pattern as portal.ts).
//
// Storage mirrors portal.ts: in-process Maps as a read cache, Postgres when MYCEL_DATABASE_URL is
// set. In-memory-only party links die on every deploy — the exact bug portal already paid for.
import { createHash, randomBytes } from "node:crypto";
import type { ClientRequest } from "./contract";
import { databaseUrl } from "./config";
import { getRequestStore } from "./requests";

const LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_TTL_MS = 2 * 24 * 60 * 60 * 1000;
/** Same grace as portal — email scanners claim the first GET; the human clicks seconds later. */
const EXCHANGE_GRACE_MS = 15 * 60 * 1000;

export interface PartyScope {
  project_id: string;
  client_id: string;
  request_id: string;
  party_role: string;
  party_label?: string;
}

interface StoredPartyLink {
  hash: string;
  project_id: string;
  client_id: string;
  request_id: string;
  party_role: string;
  party_label?: string;
  expires_at: number;
  used: boolean;
  used_at?: number | null;
  session_token?: string | null;
}

interface StoredPartySession {
  token: string;
  project_id: string;
  client_id: string;
  request_id: string;
  party_role: string;
  party_label?: string;
  expires_at: number;
}

const digest = (t: string) => createHash("sha256").update(t).digest("hex");

const links = new Map<string, StoredPartyLink>();
const sessions = new Map<string, StoredPartySession>();

let pg: import("./party.pg").PartyPg | null = null;

/** Boot-time: attach durable party credentials when MYCEL_DATABASE_URL is set. */
export async function initPartyStore(): Promise<{ backend: "postgres" | "memory" }> {
  const url = databaseUrl();
  if (!url) return { backend: "memory" };
  const { PartyPg } = await import("./party.pg");
  pg = await PartyPg.connect(url);
  return { backend: "postgres" };
}

export async function closePartyStore(): Promise<void> {
  await pg?.close().catch(() => {});
  pg = null;
}

/** Test seam. */
export function _resetParty(): void {
  links.clear();
  sessions.clear();
}

/**
 * Mint a one-time link for a non-client party on an existing request.
 * Returns the raw token once — only the hash is retained.
 */
export function mintPartyLink(args: {
  project_id: string;
  client_id: string;
  request_id: string;
  party_role: string;
  party_label?: string;
  ttlMs?: number;
}): { token: string; expires_at: string } {
  const token = `mpty_${randomBytes(24).toString("base64url")}`;
  const expires_at = Date.now() + (args.ttlMs ?? LINK_TTL_MS);
  const row: StoredPartyLink = {
    hash: digest(token),
    project_id: args.project_id,
    client_id: args.client_id,
    request_id: args.request_id,
    party_role: args.party_role,
    party_label: args.party_label,
    expires_at,
    used: false,
    used_at: null,
    session_token: null,
  };
  links.set(row.hash, row);
  if (pg) void pg.putLink(row).catch((e) => console.error("[mycel] party link persist error:", e));
  return { token, expires_at: new Date(expires_at).toISOString() };
}

export async function exchangePartyLink(
  token: string,
): Promise<{ token: string; scope: PartyScope; expires_at: string } | undefined> {
  const hash = digest(token);
  const now = Date.now();
  let link = links.get(hash);

  if (pg) {
    const claimed = await pg.claimLink(hash, now);
    if (claimed) {
      link = { ...claimed, party_label: claimed.party_label ?? undefined };
      links.set(hash, link);
    } else {
      const replay = await pg.replayLink(hash, now, now - EXCHANGE_GRACE_MS);
      if (!replay) return undefined;
      links.set(hash, { ...replay.link, party_label: replay.link.party_label ?? undefined });
      const session = await adoptSession({
        ...replay.session,
        party_label: replay.session.party_label ?? undefined,
      });
      return sessionResponse(session);
    }
  } else {
    if (!link) return undefined;
    if (link.used) {
      const withinGrace = (link.used_at ?? 0) >= now - EXCHANGE_GRACE_MS;
      const prior = link.session_token ? sessions.get(link.session_token) : undefined;
      if (!withinGrace || !prior || prior.expires_at < now) return undefined;
      return sessionResponse(prior);
    }
    if (link.expires_at < now) return undefined;
  }

  if (!link) return undefined;

  const session: StoredPartySession = {
    token: `mpty_s_${randomBytes(24).toString("base64url")}`,
    project_id: link.project_id,
    client_id: link.client_id,
    request_id: link.request_id,
    party_role: link.party_role,
    party_label: link.party_label,
    expires_at: now + SESSION_TTL_MS,
  };
  sessions.set(session.token, session);
  link.used = true;
  link.used_at = now;
  link.session_token = session.token;
  links.set(hash, link);

  if (pg) {
    await pg.putSession(session).catch((e) => console.error("[mycel] party session persist error:", e));
    await pg
      .noteLinkExchanged(hash, now, session.token)
      .catch((e) => console.error("[mycel] party link note error:", e));
  }

  return sessionResponse(session);
}

async function adoptSession(s: StoredPartySession): Promise<StoredPartySession> {
  sessions.set(s.token, s);
  return s;
}

const sessionResponse = (s: StoredPartySession) => ({
  token: s.token,
  scope: {
    project_id: s.project_id,
    client_id: s.client_id,
    request_id: s.request_id,
    party_role: s.party_role,
    party_label: s.party_label,
  },
  expires_at: new Date(s.expires_at).toISOString(),
});

export async function resolvePartySession(token: string): Promise<PartyScope | undefined> {
  if (!token) return undefined;
  const cached = sessions.get(token);
  if (cached && cached.expires_at >= Date.now()) {
    return {
      project_id: cached.project_id,
      client_id: cached.client_id,
      request_id: cached.request_id,
      party_role: cached.party_role,
      party_label: cached.party_label,
    };
  }
  if (cached) sessions.delete(token);

  if (!pg) return undefined;
  const row = await pg.getSession(token, Date.now());
  if (!row) return undefined;
  const session: StoredPartySession = {
    ...row,
    party_label: row.party_label ?? undefined,
  };
  sessions.set(session.token, session);
  return {
    project_id: session.project_id,
    client_id: session.client_id,
    request_id: session.request_id,
    party_role: session.party_role,
    party_label: session.party_label,
  };
}

/** The one request this party may see — or undefined (always answer 404 upstream). */
export async function partyOwnedRequest(scope: PartyScope): Promise<ClientRequest | undefined> {
  const r = await getRequestStore().getRequest(scope.project_id, scope.request_id);
  if (!r || r.client_id !== scope.client_id) return undefined;
  if (!r.party_role || r.party_role === "client") return undefined;
  if (r.party_role !== scope.party_role) return undefined;
  return r;
}

export function toPartyRequest(r: ClientRequest) {
  return {
    id: r.id,
    kind: r.kind,
    ask: r.ask,
    detail: r.detail,
    status: r.status,
    due_at: r.due_at,
    party_role: r.party_role,
    party_label: r.party_label,
    response: r.response,
    resolved_at: r.resolved_at,
  };
}
