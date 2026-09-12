/**
 * Telling a founder, ONCE, that their LinkedIn account stopped.
 *
 * ── THE PROBLEM ──────────────────────────────────────────────────────────────────────────────────
 * A LinkedIn session is a cookie pair with no refresh API. It dies — password change, sign out
 * everywhere, a security check, plain expiry — and when it does, outbound stops. The breaker in
 * @mycel/linkedin already notices (`classifyVoyagerFailure`), already stops the account
 * (`linkedinBlocked`), and already stamps the Connection row (`config.linkedin_unhealthy`) so every
 * replica and every scheduler skips it. All of that is CONTAINMENT. None of it is a person being
 * told. For a founder paying for a GTM machine that quietly stopped, weeks pass before they notice,
 * and the thing they notice is that the product did not work.
 *
 * ── WHY THIS IS A PULL AND NOT A CALLBACK ────────────────────────────────────────────────────────
 * The obvious design is: the breaker fires, and something sends an email. It cannot, for two
 * reasons, and both are load-bearing rather than incidental.
 *
 *   1. THE KERNEL DELIBERATELY DOES NOT SEND MAIL (see cloud/lib/mail.ts). Delivery belongs to the
 *      product, which owns the domain, the DKIM key and the sending reputation. A kernel that can
 *      email a founder's contacts is a kernel with a far larger blast radius.
 *   2. AN IN-PROCESS "have we told them" FLAG DIES WITH THE PROCESS. The breaker's `announce` flag
 *      is exactly right for the log line and exactly wrong for an email: restart the worker and it
 *      is `false` again, so the next failed call sends a second copy, and a crash-looping worker
 *      sends one per boot. The only marker that survives a restart is the one written next to the
 *      stamp, in Postgres, on the row.
 *
 * So the durable stamp IS the queue. A connection with `linkedin_unhealthy` and no
 * `notified_at` is a founder who has not been told; the product's cron asks for that list, sends,
 * and marks. Exactly once per stop, across any number of failed calls, replicas and restarts. And a
 * reconnect drops the whole `linkedin_unhealthy` key (`clearLinkedInUnhealthy`), which takes the
 * marker with it — so the NEXT stop is a new notification rather than a silenced one.
 *
 * ── WHAT IS DELIBERATELY NOT MAILED ──────────────────────────────────────────────────────────────
 * Transient failures. A 429, a 503, a proxy blip and a timeout never reach this file, because they
 * never stamp the row — they take the in-memory backoff ladder instead. That is the whole point: an
 * email that arrives every time LinkedIn has a bad minute is an email a founder filters, and the one
 * that matters then arrives in a folder nobody opens.
 */
import { describeLinkedInStop, type StopCause } from "@mycel/linkedin/health";
import { getDomainStore } from "./domain";
import { getIdentityStore } from "./identity";

/** The stamp `packages/linkedin/src/connect.ts` writes, plus the marker this module owns. */
interface UnhealthyStamp {
  at?: string;
  code?: string;
  detail?: string;
  /** ISO time the founder was emailed. Absent = nobody has been told yet. */
  notified_at?: string;
}

/** One founder-ready notification. Everything the product needs to compose mail, and no config. */
export interface LinkedInStopAlert {
  connection_id: string;
  /** What the account is called on screen — never a cookie, never a urn. */
  account: string;
  org_id?: string;
  project_id?: string;
  /** Owners and admins of the org that owns the project. Empty is not mailable. */
  to: string[];
  /** When the stop was recorded. */
  at: string;
  code: string;
  cause: StopCause;
  /** Whether reconnecting is the remedy. False = it is ours to fix and reconnecting is a wasted trip. */
  reconnect: boolean;
  headline: string;
  what: string;
  fix: string;
  /** The engine's own sentence. Shown as evidence, never as the explanation. */
  detail: string;
}

const stampOf = (config: Record<string, unknown> | undefined): UnhealthyStamp | undefined => {
  const raw = config?.linkedin_unhealthy;
  return raw && typeof raw === "object" ? (raw as UnhealthyStamp) : undefined;
};

/**
 * Every stopped LinkedIn account whose founder has not been told.
 *
 * Cross-tenant, like `listDueDigests`, and gated by the same route — the control token or a
 * super-admin session. A product API key alone must not enumerate other tenants' accounts.
 */
export async function listLinkedInStopAlerts(): Promise<LinkedInStopAlert[]> {
  const identity = getIdentityStore();
  const connections = await getDomainStore().listConnections();
  const out: LinkedInStopAlert[] = [];

  for (const conn of connections) {
    if (conn.kind !== "linkedin") continue;
    const stamp = stampOf(conn.config);
    if (!stamp?.detail || stamp.notified_at) continue;

    const project = conn.project_id ? identity.getProject(conn.project_id) : undefined;
    const orgId = project?.org_id;
    const to = orgId
      ? identity
          .listMembers(orgId)
          .filter((m) => m.role === "owner" || m.role === "admin")
          .map((m) => m.email)
          .filter(Boolean)
      : [];
    // Nobody to tell is not a reason to mark it told. It stays due, so an org that later gains an
    // owner still gets the message, and the two UIs surface it in the meantime either way.
    if (!to.length) continue;

    const account = conn.name || conn.id;
    const notice = describeLinkedInStop(stamp.code, account);
    out.push({
      connection_id: conn.id,
      account,
      org_id: orgId,
      project_id: conn.project_id,
      to,
      at: stamp.at ?? new Date().toISOString(),
      code: notice.code,
      cause: notice.cause,
      reconnect: notice.reconnect,
      headline: notice.headline,
      what: notice.what,
      fix: notice.fix,
      detail: stamp.detail,
    });
  }
  return out;
}

/**
 * Record that the founder was emailed about this connection's CURRENT stop.
 *
 * Re-reads the row first, and refuses when the stamp has gone. Between the product listing a stop
 * and reporting the send, the founder may have reconnected — writing `notified_at` then would
 * resurrect a `linkedin_unhealthy` key that `clearLinkedInUnhealthy` had just removed, which pacing
 * reads as "this account is stopped". A late mail is a nuisance; a stop nobody can clear is an
 * outage.
 */
export async function markLinkedInStopNotified(connectionId: string, at = new Date()): Promise<boolean> {
  const domain = getDomainStore();
  const conn = await domain.getConnection(connectionId);
  const stamp = stampOf(conn?.config);
  if (!conn || !stamp?.detail || stamp.notified_at) return false;
  await domain.updateConnection(connectionId, {
    config: { ...conn.config, linkedin_unhealthy: { ...stamp, notified_at: at.toISOString() } },
  });
  return true;
}
