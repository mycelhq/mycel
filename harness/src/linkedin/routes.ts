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
import { getIdentityStore, linkedinSessionRefusal } from "../identity";
import { directEgressAllowed } from "./proxy";
import { proxyPoolEnabled, proxyPoolStatus } from "./proxy-pool";

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
     * Sticky ISP from our pool is a paid/trial seat cost — never lease during pre-pay onboarding
     * just to sniff geo. BYO `proxy_url` still works (their IP, their bill). Signup itself never
     * hits Decodo; this is the second latch so a `plan_status: none` org cannot burn a dedicated IP.
     */
    const byo = (b.proxy_url ?? "").trim();
    if (!byo && proxyPoolEnabled()) {
      const identity = getIdentityStore();
      const project = identity.getProject(projectId);
      const org = project ? identity.getOrg(project.org_id) : undefined;
      const status = org?.plan_status ?? "none";
      if (status === "none" || status === "cancelled") {
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
    // needs_2fa and connected are both successful starts; only a hard failure is an error status.
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
