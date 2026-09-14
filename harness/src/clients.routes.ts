// The client routes — profile, context, and the portal link that lets them in.
//
// ═══ WHY THIS IS ITS OWN FILE ═══
//
// `server.ts` was 10,460 lines and 206 routes. Not one of them is wrong for being there, and that
// is the problem: nothing about a file that size tells you where anything belongs, so the next
// route goes wherever the cursor happens to be. Seven `*.routes.ts` modules already existed with a
// working shape; this is the eighth, and the pattern is the point rather than the seventy lines.
//
// ═══ THE SHAPE, AND WHY DEPENDENCIES ARE INJECTED ═══
//
// `mountClientRoutes(app, deps)`, taking exactly what these routes touch and nothing else. Injected
// rather than imported because `accessible` and `writeProjectId` are CLOSURES over the request
// scope built in `createServer` — they cannot be imported, and a second implementation of "which
// projects may this caller see" is how a tenancy check drifts. `requests.routes.ts` makes the same
// argument at more length.
//
// ═══ WHAT IS DELIBERATELY NOT HERE ═══
//
// `/v1/channels`, which sat immediately above these in the old file and reads like a sibling. It is
// not: a channel belongs to a connection and is listed by project, and moving it here would put a
// connection concern in the client module because of where it happened to be typed.
import type { Hono } from "hono";
import type { Context } from "hono";
import type { DomainStore } from "./domain";
import type { Store } from "./store";
import { audit } from "./audit";
import { getClientContext, updateClientContext } from "./client-context";
import { mintPortalLink, revokeClientSessions } from "./portal";
import { isInternalClient } from "./internal-sender";

export interface ClientRouteDeps {
  domain: DomainStore;
  store: Store;
  /** The projects this caller may READ. A closure over the request scope — see the note above. */
  accessible: (c: Context) => Set<string>;
  /** The project a WRITE lands in, or undefined when the caller named none. */
  writeProjectId: (c: Context) => string | undefined;
  /**
   * Is this project one the caller may see?
   *
   * Injected rather than reimplemented, even though it is one line. It is a closure inside
   * `createServer`, and a SECOND copy of "which projects may this caller see" is precisely how a
   * tenancy check drifts — the two would agree today and disagree the first time one of them learns
   * about a new scope kind.
   */
  inScope: (set: Set<string>, pid?: string) => boolean;
}

import { openEngagementForNewClient } from "./engagement-open";

export function mountClientRoutes(app: Hono, deps: ClientRouteDeps): void {
  const { domain, store, accessible, writeProjectId, inScope } = deps;

app.post("/v1/clients", async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const projectId = writeProjectId(c);
  if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
  const client = await domain.createClient({
    project_id: projectId,
    display_name: typeof b.display_name === "string" ? b.display_name : undefined,
    handles: Array.isArray(b.handles) ? (b.handles as string[]) : [],
    metadata: (b.metadata as Record<string, unknown>) ?? {},
    preferences: (b.preferences as Record<string, unknown>) ?? undefined,
  });

  /**
   * ═══ AND THE DESK OPENS ═══
   *
   * Adding a client used to write one row and stop. For a business with a live service that is the
   * moment everything is supposed to start — and for a real brand studio it was the moment nothing
   * did: their own written service ran six times against nobody and produced nothing, because an
   * engagement only ever opened from a signed envelope and they had no proposal flow.
   *
   * `openEngagementForNewClient` opens the case on the one live producing service, sends the intake
   * questions that service declared, invites the connections it needs, and arms the clock. The
   * ignition sweep starts the work when the answers land. It refuses to guess when a business runs
   * two — that is a decision about whose letterhead the work goes out under.
   *
   * NOT AWAITED INTO THE RESPONSE'S CRITICAL PATH BEYOND ITS OWN COMPLETION, and never raised: a
   * client that was created is created. An engagement that failed to open is visible, recoverable,
   * and must not make adding a client look broken.
   */
  await openEngagementForNewClient(projectId, client, store).catch((e) =>
    console.error(`[mycel] client ${client.id} added but no engagement opened:`, e),
  );
  return c.json(client, 201);
});
app.get("/v1/clients", async (c) => {
  const set = accessible(c);
  /**
   * Internal rows are hidden here rather than at each caller, because "each caller" turned out to
   * be the clients room, the count beside it, three pickers, the calendar, apps and the clock. One
   * chokepoint is also what keeps the agent's view and the founder's view the same: neither of them
   * has a customer called "Mycel Go-to-Market". See internal-sender.ts.
   */
  const all = await domain.listClients();
  return c.json(all.filter((cl) => inScope(set, cl.project_id) && !isInternalClient(cl)));
});
app.get("/v1/clients/:id", async (c) => {
  const client = await domain.getClient(c.req.param("id"));
  if (!client || !inScope(accessible(c), client.project_id)) return c.json({ error: "not found" }, 404);
  const threads = await domain.listThreadsForClient(client.id);
  return c.json({ ...client, threads });
});

/**
 * Everything the business knows about this customer, in one read: profile + preferences,
 * conversations, open engagements, what has already been delivered, and any knowledge tagged to
 * them. See client-context.ts for what "preferences" and "prior deliverables" mean concretely.
 */
app.get("/v1/clients/:id/context", async (c) => {
  const client = await domain.getClient(c.req.param("id"));
  if (!client || !inScope(accessible(c), client.project_id)) return c.json({ error: "not found" }, 404);
  return c.json(await getClientContext(domain, store, client.id));
});

/** Patch the writable half (profile + preferences). metadata/preferences merge, never replace. */
app.patch("/v1/clients/:id/context", async (c) => {
  const client = await domain.getClient(c.req.param("id"));
  if (!client || !inScope(accessible(c), client.project_id)) return c.json({ error: "not found" }, 404);
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const updated = await updateClientContext(domain, client.id, {
    display_name: typeof b.display_name === "string" ? b.display_name : undefined,
    handles: Array.isArray(b.handles) ? (b.handles as string[]) : undefined,
    metadata: b.metadata && typeof b.metadata === "object" ? (b.metadata as Record<string, unknown>) : undefined,
    preferences:
      b.preferences && typeof b.preferences === "object" ? (b.preferences as Record<string, unknown>) : undefined,
  });
  if (!updated) return c.json({ error: "not found" }, 404);
  return c.json(await getClientContext(domain, store, updated.id));
});

/** Mint a portal link for a client. Returned once — only the hash is stored. */
app.post("/v1/clients/:id/portal-link", async (c) => {
  const row = await domain.getClient(c.req.param("id") ?? "");
  if (!row || !inScope(accessible(c), row.project_id)) return c.json({ error: "not found" }, 404);
  const out = mintPortalLink({ project_id: row.project_id ?? "", client_id: row.id });
  await audit({
    project_id: row.project_id ?? "",
    actor: (c.get("scope").member_id ?? "system") as string,
    action: "client.portal_link",
    entity: "client",
    entity_id: row.id,
    // The token itself is never recorded — the audit log must not become a way to get in.
    detail: { client: row.display_name ?? row.id, expires_at: out.expires_at },
  });
  return c.json(out, 201);
});

/** Revoke every session AND any unexchanged link — otherwise a live key stays in their inbox. */
app.post("/v1/clients/:id/portal-revoke", async (c) => {
  const row = await domain.getClient(c.req.param("id") ?? "");
  if (!row || !inScope(accessible(c), row.project_id)) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true, revoked: await revokeClientSessions(row.id) });
});
}
