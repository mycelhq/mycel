// Small reads that hang off a project: knowledge, records, artifacts, approvals, threads.
//
// ═══ WHY FIVE PREFIXES IN ONE MODULE ═══
//
// Each is one to three routes and each is a scoped READ over a store that already exists. Five
// files of forty lines would be five more places to look, and the thing they share is the only
// thing that matters about them: every one filters by what the caller may see and returns 404 —
// never 403 — for anything else, because a 403 confirms the row exists.
//
// They are grouped because they are small and alike, not because they are one domain. If any of
// them grows a write path or a policy of its own it should leave.
import type { Hono } from "hono";
import type { Context } from "hono";
import type { DomainStore } from "./domain";
import type { Store } from "./store";
import { exportProject } from "./export";
import { getDeliverableStore } from "./deliverables";
import { getKnowledgeStore } from "./knowledge.store";
import { getBillingStore } from "./billing";
import { listWedges } from "./wedge";

export interface ProjectReadRoutesDeps {
  domain: DomainStore;
  store: Store;
  accessible: (c: Context) => Set<string>;
  writeProjectId: (c: Context) => string | undefined;
  inScope: (set: Set<string>, pid?: string) => boolean;
  /**
   * The three server.ts locals these routes reach for.
   *
   * INJECTED, not moved, and the distinction was learned the hard way one slice ago: `/v1/cases`
   * was abandoned because two of its helpers had readers outside the slice, and hoisting them out
   * of a function body mangled the file. `serveArtifact` and `withContent` have four and five
   * readers respectively. A helper with readers on both sides of a cut belongs to neither, so it
   * stays where it is and travels as a dependency.
   */
  serveArtifact: (...args: any[]) => any;
  withContent: (...args: any[]) => any;
  validateRecordInput: (...args: any[]) => any;
}

export function mountProjectReadRoutes(app: Hono, deps: ProjectReadRoutesDeps): void {
  const { domain, store, accessible, writeProjectId, inScope, serveArtifact, withContent, validateRecordInput } = deps;

app.get("/v1/artifacts/:id", async (c) => {
  const a = await store.getArtifact(c.req.param("id"));
  if (!a) return c.json({ error: "not found" }, 404);
  const at = await store.getTask(a.task_id);
  if (!at || !inScope(accessible(c), at.project_id)) return c.json({ error: "not found" }, 404);
  return serveArtifact(await withContent(a));
});

/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * EVERY CONVERSATION IN THE BUSINESS, OPTIONALLY THE ONES ONE SERVICE IS HAVING
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The founder: *"we have inbox in agentmail per service right? can or should we show it per service?
 * build mail inbox, filter ones for that service? inbound and outbound?"*
 *
 * The premise is worth correcting because it decides the shape of this route. There is ONE address
 * per business, not one per service — `mailbox-ensure.ts` mints it from the project name when the
 * first engagement opens. That is the right design and should not change: a client emails the
 * business, and per-service addresses would make a four-person studio look like a company with
 * departments, then break threading the moment somebody replies to the wrong one.
 *
 * So a service does not own an inbox. It owns a set of ENGAGEMENTS, and those own conversations.
 * `?wedge=` is therefore a FILTER over one inbox, which is also the only version of this that stays
 * true when a client's one thread covers two services.
 *
 * ═══ WHY THE LAST MESSAGE RIDES ALONG ═══
 *
 * A list of conversations without the last thing said is a list of counts. The console would then
 * fetch `/v1/threads/:id` per row — the exact N+1 the client page's own note says it was rebuilt to
 * remove — so the batch happens here, in one query (`lastMessages`).
 *
 * Bodies are NOT truncated here. The console decides how much of a message to show, and a store that
 * pre-clips loses the ability to change that decision without a deploy of the kernel.
 */
app.get("/v1/threads", async (c) => {
  const projectId = writeProjectId(c);
  if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
  if (!inScope(accessible(c), projectId)) return c.json({ error: "not found" }, 404);

  const wedge = (c.req.query("wedge") ?? "").trim();
  const limit = Math.min(Math.max(1, Number(c.req.query("limit") ?? 100) || 100), 300);

  /**
   * The wedge → case → thread hop, resolved HERE rather than in the store.
   *
   * A thread knows its case and a case knows its wedge. Teaching the conversation store that second
   * hop would put service semantics inside it, and the next filter after this one would go there
   * too. `listCases` is already the tenant-scoped, fail-closed reader for the first half.
   */
  let caseIds: string[] | undefined;
  if (wedge) {
    const cases = await domain.listCases({ project_id: projectId, wedge });
    caseIds = cases.map((k) => k.id);
    // An explicit filter matching nothing answers NOTHING, never everything. The unfiltered list is
    // a different question and a caller that asked this one must not be given it by accident.
    if (caseIds.length === 0) return c.json({ threads: [] });
  }

  const threads = await domain.listThreadsForProject(projectId, { caseIds, limit });
  const last = await domain.lastMessages(threads.map((t) => t.id));
  return c.json({
    threads: threads.map((t) => ({ ...t, last: last.get(t.id) ?? null })),
  });
});

app.get("/v1/threads/:id", async (c) => {
  const thread = await domain.getThread(c.req.param("id"));
  if (!thread || !inScope(accessible(c), thread.project_id)) return c.json({ error: "not found" }, 404);
  return c.json({ ...thread, messages: await domain.listMessages(thread.id) });
});

/**
 * Attach a conversation to an engagement (or retitle/close it).
 *
 * The operator's escape hatch for the case `findOrCreateThread` cannot decide on its own: a new
 * lead's general thread that has since become a real job. Without this the only way to get a
 * `case_id` onto a thread was to guess it at intake time, which is exactly when nobody knows it.
 *
 * The case must be in the SAME project and belong to the SAME client as the thread. Both halves
 * matter: the project check is the tenancy boundary, and the client check stops an operator
 * (or a mis-wired product) from filing one customer's conversation under another customer's job,
 * which the portal would then show to the wrong person.
 */
app.put("/v1/threads/:id", async (c) => {
  const thread = await domain.getThread(c.req.param("id"));
  if (!thread || !inScope(accessible(c), thread.project_id)) return c.json({ error: "not found" }, 404);
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  let caseId: string | undefined;
  if (typeof b.case_id === "string" && b.case_id) {
    if (thread.case_id) {
      return c.json({ error: "this conversation is already attached to a case", code: "thread.case_locked" }, 409);
    }
    const kase = await domain.getCase(b.case_id);
    if (!kase || kase.project_id !== thread.project_id) return c.json({ error: "unknown case" }, 404);
    if (kase.client_id && kase.client_id !== thread.client_id) {
      return c.json({ error: "that case belongs to a different client" }, 400);
    }
    caseId = kase.id;
  }
  const updated = await domain.updateThread(thread.id, {
    case_id: caseId,
    subject: typeof b.subject === "string" ? b.subject : undefined,
    status: b.status === "open" || b.status === "closed" ? b.status : undefined,
  });
  return c.json(updated);
});

/**
 * EVERYTHING THIS BUSINESS HOLDS, IN ONE FILE.
 *
 * The privacy policy says export is self-service through the API and the DPA says it is an API
 * call. Until this route existed, neither was true - 353 routes and not one of them exported
 * anything. Both sentences described what we meant to build.
 *
 * Scoped by `writeProjectId` exactly like every write, not by the read set, and deliberately: this
 * hands back a whole business in one response, and "which projects can this token see" is a wider
 * question than "which project is this request FOR". A token with access to two businesses must
 * still have to say which one it is exporting.
 */
app.get("/v1/export", async (c) => {
  const projectId = writeProjectId(c);
  if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
  if (!inScope(accessible(c), projectId)) return c.json({ error: "not found" }, 404);

  const out = await exportProject(
    { domain, deliverables: getDeliverableStore(), knowledge: getKnowledgeStore(), billing: getBillingStore(), tasks: store },
    projectId,
    { tasks: c.req.query("tasks") === "1", wedges: listWedges() },
  );

  // Named so a browser saves it rather than rendering it, and dated so two exports do not overwrite
  // each other in a downloads folder.
  return new Response(JSON.stringify(out, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="mycel-export-${out.exported_at.slice(0, 10)}.json"`,
    },
  });
});

app.get("/v1/records", async (c) => {
  const set = accessible(c);
  let where: Record<string, unknown> | undefined;
  const raw = c.req.query("where");
  if (raw) {
    try { where = JSON.parse(raw); } catch { return c.json({ error: "where must be JSON" }, 400); }
  }
  /**
   * The tenant filter goes INTO the query, once per accessible project.
   *
   * This route used to query unscoped and filter the result. `domain.ts` spells out why that is
   * wrong and this route was the proof: `?limit=50` asked the store for fifty rows across EVERY
   * tenant, and the post-filter then removed the ones that weren't yours — so a busy neighbour
   * simply consumed the window and you got an empty page, and a caller with a wide accessible set
   * got rows it could never have named. A post-filter protects only the rows the query happened
   * to return. `RecordQuery.project_id` is now required, so this shape is the only one that
   * compiles.
   */
  const limit = Math.min(Number(c.req.query("limit") ?? 200) || 200, 500);
  const rows = [];
  for (const pid of set) {
    rows.push(
      ...(await domain.queryRecords({
        project_id: pid,
        wedge: c.req.query("wedge") || undefined,
        collection: c.req.query("collection") || undefined,
        case_id: c.req.query("case_id") || undefined,
        where,
        limit,
      })),
    );
  }
  rows.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  return c.json(rows.slice(0, limit));
});

app.post("/v1/records", async (c) => {
  const projectId = writeProjectId(c);
  if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const err = validateRecordInput(b, projectId);
  if (err) return c.json({ error: err.error }, err.status);
  const rec = await domain.upsertRecord({
    project_id: projectId,
    wedge: String(b.wedge),
    collection: String(b.collection),
    key: String(b.key),
    data: (b.data as Record<string, unknown>) ?? {},
    case_id: typeof b.case_id === "string" ? b.case_id : undefined,
  });
  return c.json(rec, 201);
});

app.get("/v1/records/:id", async (c) => {
  const r = await domain.getRecord(c.req.param("id"));
  if (!r || !inScope(accessible(c), r.project_id)) return c.json({ error: "not found" }, 404);
  return c.json(r);
});

app.delete("/v1/records/:id", async (c) => {
  const r = await domain.getRecord(c.req.param("id"));
  if (!r || !inScope(accessible(c), r.project_id)) return c.json({ error: "not found" }, 404);
  return c.json({ ok: await domain.deleteRecord(r.id) });
});

app.get("/v1/knowledge/:id", async (c) => {
  const k = await domain.getKnowledge(c.req.param("id"));
  if (!k || !inScope(accessible(c), k.project_id)) return c.json({ error: "not found" }, 404);
  return c.json(k);
});
app.put("/v1/knowledge/:id", async (c) => {
  const existing = await domain.getKnowledge(c.req.param("id"));
  if (!existing || !inScope(accessible(c), existing.project_id)) return c.json({ error: "not found" }, 404);
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const k = await domain.updateKnowledge(c.req.param("id"), {
    name: typeof b.name === "string" ? b.name : undefined,
    content: typeof b.content === "string" ? b.content : undefined,
    metadata: (b.metadata as Record<string, unknown>) ?? undefined,
  });
  return k ? c.json(k) : c.json({ error: "not found" }, 404);
});
app.delete("/v1/knowledge/:id", async (c) => {
  const existing = await domain.getKnowledge(c.req.param("id"));
  if (!existing || !inScope(accessible(c), existing.project_id)) return c.json({ error: "not found" }, 404);
  return c.json({ ok: await domain.deleteKnowledge(c.req.param("id")) });
});
}
