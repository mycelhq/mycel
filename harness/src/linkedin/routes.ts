// The LinkedIn HTTP surface, kept in its own module and mounted with one line in server.ts.
//
// Not because server.ts couldn't hold it, but because this is an opt-in, ToS-grey integration with
// its own dependencies and its own failure modes; a reader of server.ts should be able to see that
// it exists and go elsewhere for the detail.
import type { Hono } from "hono";
import type { Connection, ConnectionOwner } from "../contract";
import {
  connectWithSession,
  disconnectLinkedIn,
  getLinkedInSession,
  linkedInUsage,
  startConnect,
  syncLinkedInInbox,
  verifyConnect,
  type ConnectResult,
} from "./connect";
import { allUsage } from "./meter";
import { getIdentityStore, hasPaidPlan, linkedinSessionRefusal } from "../identity";
import { directEgressAllowed } from "./proxy";
import { proxyPoolEnabled, proxyPoolStatus } from "./proxy-pool";
import { wakeForConnection } from "../wake-schedules";
import { getDomainStore } from "../domain";

/** The tenancy helpers server.ts already owns. Passed in rather than re-derived, so scoping rules
 *  live in exactly one place. */
export interface LinkedInRouteDeps {
  getConnection(id: string): Promise<Connection | undefined>;
  updateConnectionName?(id: string, name: string): Promise<unknown>;
  listConnections(): Promise<Connection[]>;
  accessible(c: any): Set<string>;
  writeProjectId(c: any): string | undefined;
  inScope(set: Set<string>, pid?: string): boolean;
}


/**
 * THE WORK THAT WAS WAITING FOR THIS ACCOUNT, TOLD TO LOOK AGAIN NOW.
 *
 * Onboarding asks a founder to connect LinkedIn before anything can go out. Connecting used to write
 * a row and return — correct, because a route that started outreach would be doing the scheduler's
 * job without its pacing — and then the GTM loop, having already ticked and found no account, sat on
 * a `next_run_at` a full cadence away. `DEFAULT_AUDIENCE_CADENCE` is seven days.
 *
 * Nothing was broken, nothing logged an error, and the founder did exactly what they were asked and
 * watched the product do nothing for a week.
 *
 * `wakeForConnection` moves the clock; it does not run anything. See wake-schedules.ts for why that
 * distinction is the whole design.
 *
 * ONLY ON A PHASE THAT MEANS THE ACCOUNT IS USABLE. `needs_2fa` and `needs_approval` are successful
 * STARTS, not finished connections — waking on those would bring the loop forward to find the same
 * absent account and push the schedule out again, which is worse than leaving it alone.
 */
async function wakeGtmFor(projectId: string, r: { phase?: string }): Promise<void> {
  if (r?.phase !== "connected") return;
  const woken = await wakeForConnection(getDomainStore(), { project_id: projectId, kind: "linkedin" }).catch(
    () => [],
  );
  for (const w of woken) {
    console.log(`[mycel] linkedin connected — ${w.task_type} was due ${w.was_due_at}, running now`);
  }
}

/** A refusal by the proxy rule is the caller's mistake (400), not LinkedIn being down (502). */
const statusFor = (r: ConnectResult) =>
  r.phase !== "failed"
    ? undefined
    : r.code === "linkedin_proxy_required" || r.code === "linkedin_proxy_no_capacity"
      ? 400
      : 502;

export function mountLinkedIn(app: Hono, deps: LinkedInRouteDeps): void {
  const owned = async (c: any) => {
    const conn = await deps.getConnection(c.req.param("id"));
    if (!conn || !deps.inScope(deps.accessible(c), conn.project_id)) return null;
    return conn.kind === "linkedin" ? conn : null;
  };

  /**
   * Connect an account.
   *
   * Two bodies are accepted and they are not equal in quality:
   *   { li_at, jsessionid, proxy_url? }       ← preferred: no password ever reaches this process
   *   { email, password, proxy_url? }         ← fallback: headless login, password held for one call
   *
   * `proxy_url` is BYO (advanced). Self-serve omits it and sends `country` (fr, es, gb, …);
   * the host leases a bought Decodo dedicated IP for that LinkedIn member. A country with no
   * spare line fails with `linkedin_proxy_no_capacity` — never a foreign IP.
   */
  app.post("/v1/linkedin/connect", async (c) => {
    const projectId = deps.writeProjectId(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    const b = (await c.req.json().catch(() => ({}))) as {
      li_at?: string;
      jsessionid?: string;
      email?: string;
      password?: string;
      proxy_url?: string;
      country?: string;
      name?: string;
      owner?: ConnectionOwner;
    };

    /**
     * A dedicated ISP lease is OUR money, so it waits until theirs has moved.
     *
     * This refused `none` and `cancelled` and let everything else through, which sounds right and
     * is not: an org created outside the cloud signup path carries `plan_status: "active"` with
     * nothing billed, and `trialing` passed too. On 7 September production held nine orgs, ONE with
     * a billing_ref, and that one cancelled — so every account that could have reached this line
     * would have leased an IP without anyone having paid for it.
     *
     * `hasPaidPlan` asks whether a subscription exists rather than what the status column says. See
     * its note in identity.ts.
     *
     * BYO `proxy_url` still works: their IP, their bill, no gate. Signup itself never leases.
     */
    const byo = (b.proxy_url ?? "").trim();
    if (!byo && proxyPoolEnabled()) {
      const identity = getIdentityStore();
      const project = identity.getProject(projectId);
      const org = project ? identity.getOrg(project.org_id) : undefined;
      if (!org || !hasPaidPlan(org)) {
        return c.json(
          {
            error: "Start a plan, then connect LinkedIn.",
            code: "linkedin_proxy_plan_required",
          },
          402,
        );
      }
    }

    {
      const identity = getIdentityStore();
      const project = identity.getProject(projectId);
      const orgId = project?.org_id;
      if (orgId) {
        const limits = identity.limitsFor(orgId);
        const cap = limits.linkedin_sessions;
        if (cap !== null) {
          const projectIds = new Set(identity.listProjects(orgId).map((p) => p.id));
          const used = (await deps.listConnections()).filter(
            (cn) => cn.kind === "linkedin" && !!cn.project_id && projectIds.has(cn.project_id),
          ).length;
          if (used >= cap) {
            return c.json(linkedinSessionRefusal(cap, used), 402);
          }
        }
      }
    }

    if (b.li_at && b.jsessionid) {
      const r = await connectWithSession({
        li_at: b.li_at,
        jsessionid: b.jsessionid,
        proxyUrl: b.proxy_url,
        country: b.country,
        project_id: projectId,
        name: b.name,
        owner: b.owner,
      });
      await wakeGtmFor(projectId, r);
      return c.json(r, statusFor(r) ?? 201);
    }

    if (!b.email || !b.password) {
      return c.json(
        {
          error:
            "send { li_at, jsessionid } from a logged-in browser session (preferred — no password " +
            "leaves the browser), or { email, password } to drive a headless login",
        },
        400,
      );
    }
    const r = await startConnect({
      email: b.email,
      password: b.password,
      proxyUrl: b.proxy_url,
      country: b.country,
      project_id: projectId,
      name: b.name,
      owner: b.owner,
    });
    // needs_2fa, needs_approval and connected are all successful STARTS — the phase tells the client
    // what to do next (type a code, wait for the in-app tap, or nothing). Only a hard failure is an
    // error status. `needs_approval` also carries `message`, the copy the waiting screen shows.
    await wakeGtmFor(projectId, r);
    return c.json(r, statusFor(r) ?? 201);
  });

  /** ISP pool health — free slots (static) or elastic (Decodo / Bright Data). */
  app.get("/v1/linkedin/proxy-pool", (c) => {
    const status = proxyPoolStatus();
    return c.json({
      ...status,
      direct_egress_allowed: directEgressAllowed(),
      hint: status.enabled
        ? "connect with country (no proxy_url) to lease a sticky dedicated IP near the member"
        : "set MYCEL_LINKEDIN_PROXY_PROVIDER=decodo (+ MYCEL_DECODO_*) or MYCEL_LINKEDIN_PROXY_POOL",
    });
  });
  app.post("/v1/linkedin/connect/:id/verify", async (c) => {
    const conn = await owned(c);
    if (!conn) return c.json({ error: "unknown connection" }, 404);
    const b = (await c.req.json().catch(() => ({}))) as { code?: string };
    if (!b.code) return c.json({ error: "code is required" }, 400);
    const r = await verifyConnect(conn.id, b.code);
    return c.json(r, statusFor(r) ?? 200);
  });

  /** Status — including what this account has cost in bytes, which is the number that scales. */
  app.get("/v1/linkedin/connect/:id", async (c) => {
    const conn = await owned(c);
    if (!conn) return c.json({ error: "unknown connection" }, 404);
    return c.json({
      connection_id: conn.id,
      kind: conn.kind,
      connected: !!(await getLinkedInSession(conn.id)),
      handle: conn.name,
      // The proxy is shown host-only; its credentials are vaulted and never returned.
      proxy: conn.config.proxy ?? (directEgressAllowed() ? "(direct — MYCEL_LINKEDIN_ALLOW_DIRECT)" : undefined),
      synced: !!conn.config.sync_token,
      usage: linkedInUsage(conn.id),
    });
  });

  /**
   * Pull new messages. Cursor-based (`syncToken`) — Voyager has no ETag/304 to lean on, so this is
   * the mechanism that keeps a five-minute poll from costing 422MB/account/month. See voyager.ts.
   */
  app.post("/v1/linkedin/connect/:id/sync", async (c) => {
    const conn = await owned(c);
    if (!conn) return c.json({ error: "unknown connection" }, 404);
    try {
      const r = await syncLinkedInInbox(conn);
      return c.json({
        via: r.via,
        empty: r.empty,
        bytes: r.bytes,
        deleted: r.deleted,
        conversations: r.conversations,
        // Message bodies are the point of an inbox sync, so they are returned to the caller — and
        // for exactly that reason they are never written to a log line anywhere in this feature.
        inbound: r.inbound,
        usage: linkedInUsage(conn.id),
      });
    } catch (e) {
      return c.json({ error: (e as Error)?.message ?? "sync failed" }, 502);
    }
  });

  /** Fleet-wide bytes. The one place to look when asking "is the sync path still cheap?". */
  app.get("/v1/linkedin/usage", async (c) => {
    const set = deps.accessible(c);
    const rows = await Promise.all(
      allUsage().map(async (u) => {
        const conn = await deps.getConnection(u.connection_id);
        return conn && deps.inScope(set, conn.project_id) ? u : null;
      }),
    );
    const visible = rows.filter((r): r is NonNullable<typeof r> => !!r);
    return c.json({
      accounts: visible,
      total_wire_bytes: visible.reduce((n, u) => n + u.wire_bytes, 0),
      projected_monthly_wire_bytes: visible.reduce((n, u) => n + u.projected_monthly_wire_bytes, 0),
    });
  });

  app.delete("/v1/linkedin/connect/:id", async (c) => {
    const conn = await owned(c);
    if (!conn) return c.json({ error: "unknown connection" }, 404);
    await disconnectLinkedIn(conn.id);
    return c.json({ ok: true });
  });
}
