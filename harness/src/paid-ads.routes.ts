// Founder-only paid ads. Draft + edit stay local. Place and pause hit Composio only after a click.
//
// Not under /v1/gtm/* — that middleware 501s when outreach is missing, and a draft ad must still
// be writable from Pipeline. The agent never sees these routes.

import type { Context, Hono } from "hono";
import type { Connection } from "./contract";
import type { DomainStore } from "./domain";
import { connConfig } from "./composio";
import {
  AD_TOOLKITS,
  adsAccounts,
  createDraft,
  getPaidAd,
  listPaidAds,
  parseBrief,
  pauseAd,
  placeAd,
  updateDraft,
  type AdToolkit,
} from "./paid-ads";

export function mountPaidAds(
  app: Hono,
  deps: {
    domain: DomainStore;
    writeProjectId(c: Context): string | undefined;
    getConnection(id: string): Promise<Connection | undefined>;
    inScope(set: Set<string>, pid?: string): boolean;
    accessible(c: Context): Set<string>;
  },
): void {
  const { domain, writeProjectId, getConnection, inScope, accessible } = deps;

  app.get("/v1/ads", async (c) => {
    const projectId = writeProjectId(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    const conns = (await domain.listConnections()).filter((x) => inScope(accessible(c), x.project_id));
    return c.json({
      ads: await listPaidAds(domain, projectId),
      accounts: adsAccounts(conns, projectId),
    });
  });

  app.post("/v1/ads", async (c) => {
    const projectId = writeProjectId(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    const b = (await c.req.json().catch(() => ({}))) as {
      brief?: unknown;
      sells?: string;
      sells_to?: string;
      name?: string;
      objective?: string;
      geo?: string;
      daily_budget_major?: number;
      currency?: string;
      connection_id?: string;
      toolkit?: string;
    };
    const brief = parseBrief(b.brief) ?? parseBrief({ sells: b.sells, sells_to: b.sells_to, name: b.name });
    if (!brief) {
      return c.json({ error: "say what you sell and who you sell it to — that is the brief the copy is written from" }, 400);
    }
    if (b.connection_id) {
      const conn = await getConnection(b.connection_id);
      if (!conn || !inScope(accessible(c), conn.project_id) || conn.project_id !== projectId) {
        return c.json({ error: "not found" }, 404);
      }
      const toolkit = connConfig(conn).toolkit.toLowerCase() as AdToolkit;
      if (!AD_TOOLKITS.includes(toolkit)) {
        return c.json({ error: "that connection is not a Meta, Google, or LinkedIn ads account" }, 400);
      }
      b.toolkit = toolkit;
    }
    const ad = await createDraft({
      domain,
      projectId,
      brief,
      objective: b.objective,
      geo: b.geo,
      daily_budget_major: b.daily_budget_major,
      currency: b.currency,
      connection_id: b.connection_id,
      toolkit: b.toolkit,
      name: b.name,
      orgId: (c.get("scope") as import("./identity").AuthScope | undefined)?.org_id,
    });
    return c.json({ ok: true, ad }, 201);
  });

  app.patch("/v1/ads/:id", async (c) => {
    const projectId = writeProjectId(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    const ad = await getPaidAd(domain, projectId, c.req.param("id"));
    if (!ad) return c.json({ error: "not found" }, 404);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const next = await updateDraft({
      domain,
      ad,
      patch: {
        connection_id: typeof b.connection_id === "string" ? b.connection_id : undefined,
        toolkit: typeof b.toolkit === "string" ? b.toolkit : undefined,
        name: typeof b.name === "string" ? b.name : undefined,
        objective: typeof b.objective === "string" ? b.objective : undefined,
        geo: typeof b.geo === "string" ? b.geo : undefined,
        daily_budget_major: typeof b.daily_budget_major === "number" ? b.daily_budget_major : undefined,
        currency: typeof b.currency === "string" ? b.currency : undefined,
        chosen_angle_id: typeof b.chosen_angle_id === "string" ? b.chosen_angle_id : undefined,
        headline: typeof b.headline === "string" ? b.headline : undefined,
        primary: typeof b.primary === "string" ? b.primary : undefined,
        cta: typeof b.cta === "string" ? b.cta : undefined,
      },
    });
    return c.json({ ok: true, ad: next });
  });

  app.post("/v1/ads/:id/place", async (c) => {
    const projectId = writeProjectId(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    const ad = await getPaidAd(domain, projectId, c.req.param("id"));
    if (!ad) return c.json({ error: "not found" }, 404);
    const b = (await c.req.json().catch(() => ({}))) as { confirm?: unknown; connection_id?: string };
    if (b.confirm !== true) {
      return c.json({ error: "Place this ad only after you have seen the daily budget." }, 400);
    }
    const connectionId = (typeof b.connection_id === "string" ? b.connection_id : ad.connection_id) ?? "";
    if (!connectionId) {
      return c.json({ error: "pick the ads account this will run on" }, 400);
    }
    const conn = await getConnection(connectionId);
    if (!conn || !inScope(accessible(c), conn.project_id) || conn.project_id !== projectId) {
      return c.json({ error: "not found" }, 404);
    }
    const result = await placeAd({ domain, ad, conn, confirm: true });
    if (!result.ok) return c.json({ error: result.error, ad: result.ad }, result.status);
    return c.json({ ok: true, ad: result.ad });
  });

  app.post("/v1/ads/:id/pause", async (c) => {
    const projectId = writeProjectId(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    const ad = await getPaidAd(domain, projectId, c.req.param("id"));
    if (!ad) return c.json({ error: "not found" }, 404);
    const connectionId = ad.connection_id ?? "";
    if (!connectionId) return c.json({ error: "this ad has no ads account to pause on" }, 400);
    const conn = await getConnection(connectionId);
    if (!conn || !inScope(accessible(c), conn.project_id) || conn.project_id !== projectId) {
      return c.json({ error: "not found" }, 404);
    }
    const result = await pauseAd({ domain, ad, conn });
    if (!result.ok) return c.json({ error: result.error, ad: result.ad }, result.status);
    return c.json({ ok: true, ad: result.ad });
  });
}
