// The Task API + SSE gateway (docs/CONTRACT.md §4). Founder products and the dashboard call
// this; browsers subscribe to the event stream through the product's server-side proxy.
//
// Auth: the public /v1 surface requires the founder API key (see auth.ts). The /v1/internal/*
// surface is sandbox-facing and authed separately (gate token / proxy nonce) — the sandbox does
// NOT hold the founder key, so the API-key middleware must not cover it.
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { audit, auditList, auditVerify } from "./audit";
import { requireApiKey, safeEqual } from "./auth";
import { awaitApproval, failWaitersForTask, resolveApproval } from "./approvals";
import { actionPreview, executeAction, executeRead } from "./actions";
import { getActionGrant } from "./actiongrants";
import { getArtifactBackend } from "./artifacts";
import { subscribe } from "./bus";
import { markCancelled } from "./cancel";
import { loadConfig } from "./config";
import type {
  Approval,
  Constraints,
  ConnectionKind,
  ConnectionOwner,
  Cadence,
  CreateTaskInput,
  KnowledgeItem,
  Risk,
  Task,
  TaskEvent,
  TaskStatus,
} from "./contract";
import { getDomainStore } from "./domain";
import { emitEvent } from "./events";
import { getIdentityStore } from "./identity";
import { fireSchedule, firstRun } from "./scheduler";
import { runTask } from "./orchestrator";
import { getGrant } from "./proxygrants";
import { setSecret } from "./secrets";
import type { Store } from "./store";
import { traceLlmCall } from "./tracing";
import { loadWedge, wedgesDir } from "./wedge";
import { runWorkflow } from "./workflows";

const TERMINAL: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  "succeeded",
  "failed",
  "rejected",
  "expired",
  "cancelled",
]);

// Fixed-window rate limiter — a blunt guard against task-creation cost-DoS. Keyed per caller.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = Number(process.env.MYCEL_RATE_MAX ?? 120);
const rate = new Map<string, { n: number; resetAt: number }>();
function rateLimited(key: string): boolean {
  const now = Date.now();
  const b = rate.get(key);
  if (!b || now > b.resetAt) {
    rate.set(key, { n: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  b.n++;
  return b.n > RATE_MAX;
}

// Per-task read budget: reads are ungated, so this is the guardrail that keeps a runaway agent
// from hammering a third-party API. Cleared with the process (reads are per-run by nature).
const READ_MAX_PER_TASK = Number(process.env.MYCEL_READ_MAX_PER_TASK ?? 200);
const readCounts = new Map<string, number>();
function readsExceeded(taskId: string): boolean {
  const n = (readCounts.get(taskId) ?? 0) + 1;
  readCounts.set(taskId, n);
  return n > READ_MAX_PER_TASK;
}

// Idempotency: same Idempotency-Key returns the same task instead of spawning a duplicate (and
// duplicate real-world side effects). In-process for now (single-instance); back with the store
// for multi-instance.
const idempotency = new Map<string, string>();

export function createServer(store: Store): Hono {
  const app = new Hono();
  const domain = getDomainStore();
  const identity = getIdentityStore();

  // ── tenancy helpers ── every read filters by the caller's accessible projects; every write
  // stamps the resolved project; every by-id fetch checks membership. One place, used everywhere.
  const accessible = (c: import("hono").Context) => identity.accessibleProjectIds(c.get("scope"));
  const writeProjectId = (c: import("hono").Context) =>
    identity.resolveWriteProject(c.get("scope"), c.req.header("x-mycel-project"));
  const inScope = (set: Set<string>, pid?: string) => !!pid && set.has(pid);

  app.get("/health", (c) => c.json({ ok: true, service: "mycel-harness", version: "v0.1" }));

  // Member login (portal). No auth — it IS the auth. Returns a session token the portal forwards.
  app.post("/v1/auth/login", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as { email?: string; password?: string };
    if (!b.email || !b.password) return c.json({ error: "email and password required" }, 400);
    const r = getIdentityStore().login(b.email, b.password);
    if (!r) return c.json({ error: "invalid credentials" }, 401);
    return c.json({ token: r.session.token, member: r.member, projects: r.projects, expires_at: r.session.expires_at });
  });

  // Everything under /v1 EXCEPT /v1/internal/* and the login endpoint requires a credential.
  app.use("/v1/*", async (c, next) => {
    if (c.req.path.startsWith("/v1/internal/") || c.req.path === "/v1/auth/login") return next();
    return requireApiKey(c, next);
  });

  // Who am I — the portal renders itself from this (member, role, projects).
  app.get("/v1/me", async (c) => {
    const scope = c.get("scope");
    const id = getIdentityStore();
    const member = scope?.member_id ? id.getMember(scope.member_id) : undefined;
    return c.json({
      auth: scope?.kind ?? "unknown",
      role: scope?.role ?? (scope?.kind === "key" ? "service" : undefined),
      member,
      org_id: scope?.org_id,
      projects: scope ? id.listProjects(scope.org_id) : [],
    });
  });

  // Projects (tenants). A member sees their org's projects; a project key sees its own.
  app.get("/v1/projects", async (c) => {
    const scope = c.get("scope");
    if (scope.kind === "key") {
      const p = scope.project_id ? identity.getProject(scope.project_id) : undefined;
      return c.json(p ? [p] : []);
    }
    return c.json(identity.listProjects(scope.org_id));
  });
  // Create a project (+ its product API key). Owner/admin members only.
  app.post("/v1/projects", async (c) => {
    const scope = c.get("scope");
    if (scope.kind !== "member" || !["owner", "admin"].includes(scope.role ?? "")) {
      return c.json({ error: "only an owner/admin member can create projects" }, 403);
    }
    const b = (await c.req.json().catch(() => ({}))) as { name?: string; wedges?: string[] };
    if (!b.name) return c.json({ error: "name is required" }, 400);
    const { project, apiKey } = identity.createProject(scope.org_id, b.name, Array.isArray(b.wedges) ? b.wedges : []);
    return c.json({ project, api_key: apiKey }, 201);
  });

  // POST /v1/tasks — create + kick off a task
  app.post("/v1/tasks", async (c) => {
    if (rateLimited(c.req.header("authorization") ?? "anon")) {
      return c.json({ error: "rate limited" }, 429);
    }
    const body = (await c.req.json().catch(() => ({}))) as Partial<CreateTaskInput>;
    if (!body.wedge || !body.task_type) {
      return c.json({ error: "wedge and task_type are required" }, 400);
    }

    // Validate at the boundary: the wedge must exist, and if it declares task_types the requested
    // one must be among them. A typo shouldn't queue a task that dies 60s later.
    const wedge = loadWedge(body.wedge);
    if (!wedge) return c.json({ error: `unknown wedge: ${body.wedge}` }, 400);
    const types = wedge.manifest.task_types;
    if (types && Object.keys(types).length && !types[body.task_type]) {
      return c.json({ error: `unknown task_type "${body.task_type}" for wedge "${body.wedge}"` }, 400);
    }

    // Tenancy: land the task in a project the caller owns, and only if that project runs this wedge.
    const projectId = writeProjectId(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    if (!identity.projectAllowsWedge(projectId, body.wedge)) {
      return c.json({ error: `wedge "${body.wedge}" is not enabled for this project` }, 403);
    }

    const idem = c.req.header("idempotency-key");
    if (idem && idempotency.has(idem)) {
      const existing = await store.getTask(idempotency.get(idem)!);
      if (existing) return c.json(existing, 200);
    }

    const cfg = loadConfig();
    const constraints = clampConstraints(body.constraints, cfg.maxCostCeilingUsd, cfg.maxRuntimeCeilingS);
    const now = new Date().toISOString();
    const task: Task = {
      id: randomUUID(),
      project_id: projectId,
      wedge: body.wedge,
      task_type: body.task_type,
      actor: body.actor ?? { kind: "user", id: "anon" },
      input: body.input ?? {},
      constraints,
      tools: body.tools ?? [],
      // Default the task's output_schema from the wedge's task_type when the caller didn't set one.
      output_schema: body.output_schema ?? types?.[body.task_type]?.output_schema,
      status: "queued",
      cost_usd: 0,
      created_at: now,
      updated_at: now,
    };
    await store.createTask(task);
    if (idem) idempotency.set(idem, task.id);
    // fire-and-forget in-process orchestration (a durable engine slots in here later)
    void runTask(store, task.id).catch((err) => console.error("[mycel] runTask error:", err));
    return c.json(task, 201);
  });

  // GET /v1/tasks — list for the operator portal (newest first; ?status= ?wedge= ?limit=)
  app.get("/v1/tasks", async (c) => {
    const status = c.req.query("status") as TaskStatus | undefined;
    const wedge = c.req.query("wedge");
    const limit = c.req.query("limit") ? Number(c.req.query("limit")) : undefined;
    const set = accessible(c);
    const tasks = await store.listTasks({ status, wedge, limit: (limit ?? 100) * 4 });
    return c.json(tasks.filter((t) => inScope(set, t.project_id)).slice(0, limit ?? 100));
  });

  // GET /v1/approvals — the approvals queue (?status=pending), scoped to the caller's projects.
  app.get("/v1/approvals", async (c) => {
    const status = c.req.query("status") as Approval["status"] | undefined;
    const set = accessible(c);
    const aps = await store.listApprovals(status || undefined);
    const out: Approval[] = [];
    for (const a of aps) {
      const t = await store.getTask(a.task_id);
      if (t && inScope(set, t.project_id)) out.push(a);
    }
    return c.json(out);
  });

  // GET /v1/meta — what the portal needs to render itself: version, wedges, Langfuse deep-link base.
  app.get("/v1/meta", async (c) => {
    const cfg = loadConfig();
    let wedges: string[] = [];
    try {
      wedges = readdirSync(wedgesDir()).filter((d) => existsSync(join(wedgesDir(), d, "wedge.json")));
    } catch {
      /* no wedges dir */
    }
    return c.json({
      version: "v0.1",
      wedges,
      langfuse_url: cfg.langfuse?.baseUrl ?? null,
      store: process.env.MYCEL_DATABASE_URL ? "postgres" : "memory",
      sandbox: cfg.sandboxBackend,
    });
  });

  // GET /v1/tasks/:id
  app.get("/v1/tasks/:id", async (c) => {
    const t = await store.getTask(c.req.param("id"));
    if (!t || !inScope(accessible(c), t.project_id)) return c.json({ error: "not found" }, 404);
    return c.json(t);
  });

  // GET /v1/tasks/:id/events — SSE with Last-Event-ID replay
  app.get("/v1/tasks/:id/events", async (c) => {
    const taskId = c.req.param("id");
    const guard = await store.getTask(taskId);
    if (!guard || !inScope(accessible(c), guard.project_id)) return c.json({ error: "not found" }, 404);
    const raw = c.req.header("Last-Event-ID") ?? c.req.query("lastEventId") ?? "0";
    const parsed = Number(raw);
    const lastId = Number.isFinite(parsed) ? parsed : 0; // malformed header must not skip replay

    return streamSSE(c, async (stream) => {
      let lastSent = lastId;
      const queue: TaskEvent[] = [];
      const MAX_QUEUE = 5000; // bound memory for a slow client on a token-heavy task
      let overflow = false;
      let wake: (() => void) | null = null;
      const unsub = subscribe(taskId, (ev) => {
        if (queue.length >= MAX_QUEUE) overflow = true;
        else queue.push(ev);
        const w = wake;
        wake = null;
        w?.();
      });
      stream.onAbort(() => {
        const w = wake;
        wake = null;
        w?.();
      });

      try {
        // Replay persisted events first (we subscribed above, so nothing is lost in between).
        let finishedInReplay = false;
        for (const ev of await store.eventsAfter(taskId, lastId)) {
          await stream.writeSSE({ id: String(ev.id), event: ev.type, data: JSON.stringify(ev) });
          lastSent = ev.id;
          if (ev.type === "task.finished") finishedInReplay = true;
        }
        if (finishedInReplay) return;

        // Already terminal (client reconnected after the end): flush anything remaining, then close.
        const t = await store.getTask(taskId);
        if (t && TERMINAL.has(t.status)) {
          for (const ev of await store.eventsAfter(taskId, lastSent)) {
            await stream.writeSSE({ id: String(ev.id), event: ev.type, data: JSON.stringify(ev) });
            lastSent = ev.id;
          }
          return;
        }

        // Then live, deduped against replayed ids.
        let done = false;
        while (!done && !stream.aborted) {
          if (queue.length === 0 && !overflow) await new Promise<void>((r) => (wake = r));
          if (overflow) {
            await stream.writeSSE({ event: "error", data: JSON.stringify({ error: "stream overflow — reconnect with Last-Event-ID" }) });
            return;
          }
          while (queue.length) {
            const ev = queue.shift();
            if (!ev || ev.id <= lastSent) continue;
            lastSent = ev.id;
            await stream.writeSSE({ id: String(ev.id), event: ev.type, data: JSON.stringify(ev) });
            if (ev.type === "task.finished") done = true;
          }
        }
      } finally {
        unsub(); // always release the bus listener — no leak on client disconnect / error
      }
    });
  });

  app.post("/v1/tasks/:id/cancel", async (c) => {
    const t = await store.getTask(c.req.param("id"));
    if (!t || !inScope(accessible(c), t.project_id)) return c.json({ error: "not found" }, 404);
    markCancelled(t.id);
    // Wake any pending approval so a task suspended on the gate ends promptly (no dangling waiter).
    failWaitersForTask(t.id, "rejected");
    return c.json(await store.getTask(t.id));
  });

  const decide =
    (decision: "approved" | "rejected") => async (c: import("hono").Context) => {
      const id = c.req.param("id");
      if (!id) return c.json({ error: "not found" }, 404);
      const a = await store.getApproval(id);
      if (!a) return c.json({ error: "not found" }, 404);
      // Tenancy: the approval's task must belong to a project the caller owns.
      const at = await store.getTask(a.task_id);
      if (!at || !inScope(accessible(c), at.project_id)) return c.json({ error: "not found" }, 404);
      // Atomic decide: only the first transition off "pending" wins (no approve/reject TOCTOU).
      if (a.status !== "pending") return c.json({ error: `already ${a.status}` }, 409);
      // Approve-with-edit: the human may correct the action before it happens ({ edited: {...} }).
      const body = (await c.req.json().catch(() => ({}))) as { edited?: Record<string, unknown> };
      const settled = resolveApproval(id, decision, body.edited); // resolves waiter, persists status
      if (!settled) {
        // No live waiter (already expired/settled) — reflect the terminal state, don't override.
        const fresh = await store.getApproval(id);
        return c.json({ error: `already ${fresh?.status ?? "resolved"}` }, 409);
      }
      return c.json({ ok: true, decision });
    };
  app.post("/v1/approvals/:id/approve", decide("approved"));
  app.post("/v1/approvals/:id/reject", decide("rejected"));

  // Internal: the sandbox's OpenCode plugin calls this to gate a risky action. Blocks until a
  // human approves/rejects, then returns { allow }. Authed by the shared gate token (constant-time).
  app.post("/v1/internal/gate", async (c) => {
    const token = c.req.header("x-mycel-gate-token") ?? "";
    if (!safeEqual(token, loadConfig().gateToken)) return c.json({ allow: false, decision: "unauthorized" }, 401);
    const body = (await c.req.json().catch(() => ({}))) as {
      task_id?: string;
      action?: string;
      risk?: Risk;
      preview?: Record<string, unknown>;
    };
    if (!body.task_id || !(await store.getTask(body.task_id))) return c.json({ allow: false, decision: "unknown_task" }, 404);
    const { decision } = await awaitApproval(store, body.task_id, {
      action: body.action ?? "action",
      risk: body.risk ?? "medium",
      preview: body.preview ?? {},
    });
    return c.json({ allow: decision === "approved" || decision === "auto_approved", decision });
  });

  // Internal: proxy-mode model routing. The sandbox calls this with an opaque nonce; the harness
  // looks up the real key, forwards to the OpenAI-compatible upstream, streams the response back,
  // and traces the call. The provider key never enters the sandbox. The model and token budget are
  // pinned server-side so a compromised nonce can't switch models or run up an unbounded bill.
  const ALLOWED_LLM_PATHS = new Set(["chat/completions", "completions", "embeddings", "responses"]);
  app.post("/v1/internal/llm/:path{.+}", async (c) => {
    const nonce = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
    const grant = getGrant(nonce);
    if (!grant) return c.json({ error: "invalid proxy token" }, 401);
    const path = c.req.param("path");
    if (!ALLOWED_LLM_PATHS.has(path)) return c.json({ error: `path not allowed: ${path}` }, 403);

    const cfg = loadConfig();
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(await c.req.text());
    } catch {
      /* forward as-is if unparseable */
    }
    // Pin the model to the grant; cap max_tokens. (base_url is server-set, so the upstream
    // authority can't be changed by the sandbox — no SSRF here.)
    payload.model = grant.model;
    const wants = Number(payload.max_tokens ?? 0);
    payload.max_tokens = wants > 0 ? Math.min(wants, cfg.maxTokensCeiling) : cfg.maxTokensCeiling;
    const stream = payload.stream === true;

    const upstream = `${grant.base_url.replace(/\/+$/, "")}/${path}`;
    const started = Date.now();
    try {
      const res = await fetch(upstream, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${grant.api_key}` },
        body: JSON.stringify(payload),
      });
      traceLlmCall({ task_id: grant.task_id, model: grant.model, path, status: res.status, ms: Date.now() - started });
      return new Response(res.body, {
        status: res.status,
        headers: {
          "content-type": res.headers.get("content-type") ?? (stream ? "text/event-stream" : "application/json"),
        },
      });
    } catch (e) {
      traceLlmCall({ task_id: grant.task_id, model: grant.model, path, status: 502, ms: Date.now() - started });
      return c.json({ error: "upstream error", detail: String(e) }, 502);
    }
  });

  app.get("/v1/artifacts/:id", async (c) => {
    const a = await store.getArtifact(c.req.param("id"));
    if (!a) return c.json({ error: "not found" }, 404);
    const at = await store.getTask(a.task_id);
    if (!at || !inScope(accessible(c), at.project_id)) return c.json({ error: "not found" }, 404);
    let content = a.content;
    if (!content) content = (await getArtifactBackend().then((b) => b.get(a.id))) ?? "";
    return new Response(content, { headers: { "content-type": a.content_type } });
  });

  // ── The service surface: connections / channels / clients / threads ──
  // Secrets are never returned: connections expose config + a secret_ref, never the secret.

  app.post("/v1/connections", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    if (!b.kind || !b.name) return c.json({ error: "kind and name are required" }, 400);
    const projectId = writeProjectId(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    // Owner: founder-level by default; pass { owner: { kind:"client", id } } or client_id to scope
    // a connection to a specific client (their mailbox/calendar the founder operates).
    const clientId = typeof b.client_id === "string" ? b.client_id : undefined;
    const owner = (b.owner as ConnectionOwner | undefined) ??
      (clientId ? { kind: "client", id: clientId } : { kind: "founder", id: "founder" });
    const conn = await domain.createConnection({
      project_id: projectId,
      kind: b.kind as ConnectionKind,
      name: String(b.name),
      owner,
      config: (b.config as Record<string, unknown>) ?? {},
      secret_ref: typeof b.secret_ref === "string" ? b.secret_ref : undefined,
    });
    return c.json(conn, 201);
  });
  app.get("/v1/connections", async (c) => {
    const set = accessible(c);
    const clientId = c.req.query("client_id");
    const all = (await domain.listConnections()).filter((x) => inScope(set, x.project_id));
    return c.json(clientId ? all.filter((x) => x.owner.kind === "client" && x.owner.id === clientId) : all);
  });
  app.get("/v1/connections/:id", async (c) => {
    const conn = await domain.getConnection(c.req.param("id"));
    if (!conn || !inScope(accessible(c), conn.project_id)) return c.json({ error: "not found" }, 404);
    return c.json(conn);
  });
  // Store a connection's secret in the vault (a client's OAuth token, a provider key). The value
  // is never returned; the connection then resolves it server-side at action time.
  app.post("/v1/connections/:id/secret", async (c) => {
    const conn = await domain.getConnection(c.req.param("id"));
    if (!conn || !inScope(accessible(c), conn.project_id)) return c.json({ error: "not found" }, 404);
    const b = (await c.req.json().catch(() => ({}))) as { value?: string };
    if (typeof b.value !== "string" || !b.value) return c.json({ error: "value is required" }, 400);
    await setSecret(conn.id, b.value);
    await audit({
      project_id: conn.project_id ?? "", actor: (c.get("scope").member_id ?? "system") as string,
      action: "secret.written", entity: "connection", entity_id: conn.id,
      detail: { connection: conn.name, kind: conn.kind }, // never the value
    });
    return c.json({ ok: true });
  });

  app.post("/v1/channels", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const projectId = writeProjectId(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    const conn = b.connection_id ? await domain.getConnection(String(b.connection_id)) : undefined;
    if (!conn || !inScope(accessible(c), conn.project_id)) return c.json({ error: "unknown connection_id" }, 400);
    if (!b.address || !b.wedge || !b.task_type) {
      return c.json({ error: "address, wedge and task_type are required" }, 400);
    }
    if (!loadWedge(String(b.wedge))) return c.json({ error: `unknown wedge: ${b.wedge}` }, 400);
    const ch = await domain.createChannel({
      project_id: projectId,
      connection_id: conn.id,
      kind: conn.kind,
      address: String(b.address),
      wedge: String(b.wedge),
      task_type: String(b.task_type),
    });
    return c.json(ch, 201);
  });
  app.get("/v1/channels", async (c) => {
    const set = accessible(c);
    return c.json((await domain.listChannels()).filter((ch) => inScope(set, ch.project_id)));
  });

  app.post("/v1/clients", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const projectId = writeProjectId(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    const client = await domain.createClient({
      project_id: projectId,
      display_name: typeof b.display_name === "string" ? b.display_name : undefined,
      handles: Array.isArray(b.handles) ? (b.handles as string[]) : [],
      metadata: (b.metadata as Record<string, unknown>) ?? {},
    });
    return c.json(client, 201);
  });
  app.get("/v1/clients", async (c) => {
    const set = accessible(c);
    return c.json((await domain.listClients()).filter((cl) => inScope(set, cl.project_id)));
  });
  app.get("/v1/clients/:id", async (c) => {
    const client = await domain.getClient(c.req.param("id"));
    if (!client || !inScope(accessible(c), client.project_id)) return c.json({ error: "not found" }, 404);
    const threads = await domain.listThreadsForClient(client.id);
    return c.json({ ...client, threads });
  });

  app.get("/v1/threads/:id", async (c) => {
    const thread = await domain.getThread(c.req.param("id"));
    if (!thread || !inScope(accessible(c), thread.project_id)) return c.json({ error: "not found" }, 404);
    return c.json({ ...thread, messages: await domain.listMessages(thread.id) });
  });

  // ── Audit: the tamper-evident record of consequential decisions ──
  app.get("/v1/audit", async (c) => {
    const scope = c.get("scope");
    const projectId = c.req.query("project_id") ?? scope.project_id ?? [...accessible(c)][0];
    if (!projectId || !accessible(c).has(projectId)) return c.json({ error: "not found" }, 404);
    const limit = c.req.query("limit") ? Number(c.req.query("limit")) : undefined;
    return c.json(await auditList(projectId, limit));
  });
  // Prove the chain hasn't been edited. This is the endpoint an auditor/customer actually cares about.
  app.get("/v1/audit/verify", async (c) => {
    const scope = c.get("scope");
    const projectId = c.req.query("project_id") ?? scope.project_id ?? [...accessible(c)][0];
    if (!projectId || !accessible(c).has(projectId)) return c.json({ error: "not found" }, 404);
    return c.json(await auditVerify(projectId));
  });

  // ── Records: structured, queryable per-wedge state ──
  // The gap the bookkeeping stress test surfaced: case.data can hold 500 transactions but can't
  // answer "which receipts are still missing?". Records make that a query. Writes are idempotent on
  // (project, wedge, collection, key), so re-ingesting a bank transaction updates it, never
  // double-posts.
  app.get("/v1/records", async (c) => {
    const set = accessible(c);
    let where: Record<string, unknown> | undefined;
    const raw = c.req.query("where");
    if (raw) {
      try { where = JSON.parse(raw); } catch { return c.json({ error: "where must be JSON" }, 400); }
    }
    const rows = await domain.queryRecords({
      wedge: c.req.query("wedge") || undefined,
      collection: c.req.query("collection") || undefined,
      case_id: c.req.query("case_id") || undefined,
      where,
      limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
    });
    return c.json(rows.filter((r) => inScope(set, r.project_id)));
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

  // Internal: the agent reads and writes records for ITS OWN wedge/project. Data, not a real-world
  // side effect, so ungated — but scoped to the run and traced.
  app.post("/v1/internal/records/upsert", async (c) => {
    const grant = getActionGrant((c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, ""));
    if (!grant) return c.json({ ok: false, error: "invalid action token" }, 401);
    const task = await store.getTask(grant.task_id);
    if (!task) return c.json({ ok: false, error: "unknown task" }, 404);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    // A batch keeps a 500-transaction ingest to one call.
    const items = Array.isArray(b.records) ? b.records : [b];
    if (items.length > 1000) return c.json({ ok: false, error: "max 1000 records per call" }, 400);
    const out = [];
    for (const raw of items as Record<string, unknown>[]) {
      if (!raw?.collection || !raw?.key) return c.json({ ok: false, error: "each record needs collection and key" }, 400);
      out.push(
        await domain.upsertRecord({
          project_id: task.project_id,
          wedge: task.wedge, // the agent can only write its own wedge's records
          collection: String(raw.collection),
          key: String(raw.key),
          data: (raw.data as Record<string, unknown>) ?? {},
          case_id: (typeof raw.case_id === "string" ? raw.case_id : undefined) ?? task.case_id,
        }),
      );
    }
    await emitEvent(store, grant.task_id, "tool.result", { tool: "records:upsert", ok: true, count: out.length });
    return c.json({ ok: true, count: out.length, records: out.length === 1 ? out : undefined });
  });

  app.post("/v1/internal/records/query", async (c) => {
    const grant = getActionGrant((c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, ""));
    if (!grant) return c.json({ ok: false, error: "invalid action token" }, 401);
    const task = await store.getTask(grant.task_id);
    if (!task) return c.json({ ok: false, error: "unknown task" }, 404);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const q = {
      wedge: task.wedge,
      collection: typeof b.collection === "string" ? b.collection : undefined,
      case_id: typeof b.case_id === "string" ? b.case_id : undefined,
      where: (b.where as Record<string, unknown>) ?? undefined,
      limit: typeof b.limit === "number" ? Math.min(b.limit, 500) : undefined,
    };
    const [rows, count] = await Promise.all([domain.queryRecords(q), domain.countRecords(q)]);
    const scoped = rows.filter((r) => !task.project_id || r.project_id === task.project_id);
    await emitEvent(store, grant.task_id, "tool.called", {
      tool: "records:query",
      args: { collection: q.collection, where: q.where },
    });
    return c.json({ ok: true, count, records: scoped });
  });

  /** Shared validation for a record write. Returns an explicit status — never infer it from the
   *  message text (that was a bug: an "unknown wedge" error was answering 403 instead of 400). */
  function validateRecordInput(
    b: Record<string, unknown>,
    projectId: string,
  ): { error: string; status: 400 | 403 } | null {
    if (!b.wedge || !b.collection || !b.key) {
      return { error: "wedge, collection and key are required", status: 400 };
    }
    if (!loadWedge(String(b.wedge))) return { error: `unknown wedge: ${b.wedge}`, status: 400 };
    if (!identity.projectAllowsWedge(projectId, String(b.wedge))) {
      return { error: `wedge "${b.wedge}" is not enabled for this project`, status: 403 };
    }
    return null;
  }

  // ── Cases: long-lived engagements (tasks are episodes within one) ──
  // Stages come from the wedge manifest (`cases.stages`), so a transition to a stage the wedge
  // doesn't declare is rejected at the boundary rather than corrupting the engagement.
  const caseStages = (wedgeSlug: string): string[] => loadWedge(wedgeSlug)?.manifest.cases?.stages ?? [];

  app.get("/v1/cases", async (c) => {
    const set = accessible(c);
    const all = await domain.listCases({
      wedge: c.req.query("wedge") || undefined,
      status: (c.req.query("status") as "open" | "closed") || undefined,
      client_id: c.req.query("client_id") || undefined,
      stage: c.req.query("stage") || undefined,
    });
    return c.json(all.filter((k) => inScope(set, k.project_id)));
  });

  app.post("/v1/cases", async (c) => {
    const projectId = writeProjectId(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    if (!b.wedge || !b.title) return c.json({ error: "wedge and title are required" }, 400);
    const w = loadWedge(String(b.wedge));
    if (!w) return c.json({ error: `unknown wedge: ${b.wedge}` }, 400);
    if (!identity.projectAllowsWedge(projectId, String(b.wedge))) {
      return c.json({ error: `wedge "${b.wedge}" is not enabled for this project` }, 403);
    }
    const stages = caseStages(String(b.wedge));
    const stage = String(b.stage ?? w.manifest.cases?.initial ?? stages[0] ?? "open");
    if (stages.length && !stages.includes(stage)) {
      return c.json({ error: `unknown stage "${stage}" — wedge declares: ${stages.join(", ")}` }, 400);
    }
    const actor = (c.get("scope").member_id ?? "system") as string;
    const kase = await domain.createCase({
      project_id: projectId,
      wedge: String(b.wedge),
      title: String(b.title),
      client_id: typeof b.client_id === "string" ? b.client_id : undefined,
      stage,
      status: "open",
      data: (b.data as Record<string, unknown>) ?? {},
      due_at: typeof b.due_at === "string" ? b.due_at : undefined,
      history: [{ at: new Date().toISOString(), kind: "created", to: stage, actor }],
    });
    return c.json(kase, 201);
  });

  // A case with its episodes — this is the operator's real object.
  app.get("/v1/cases/:id", async (c) => {
    const kase = await domain.getCase(c.req.param("id"));
    if (!kase || !inScope(accessible(c), kase.project_id)) return c.json({ error: "not found" }, 404);
    const tasks = (await store.listTasks({ limit: 200 })).filter((t) => t.case_id === kase.id);
    const stages = caseStages(kase.wedge);
    return c.json({ ...kase, stages, tasks });
  });

  // Advance the stage, patch data, close/reopen. Every change appends to the case history.
  app.put("/v1/cases/:id", async (c) => {
    const kase = await domain.getCase(c.req.param("id"));
    if (!kase || !inScope(accessible(c), kase.project_id)) return c.json({ error: "not found" }, 404);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const actor = (c.get("scope").member_id ?? "system") as string;
    const updated = await applyCaseUpdate(kase, b, actor);
    if ("error" in updated) return c.json({ error: updated.error }, 400);
    return c.json(updated.value);
  });

  // Spawn an episode inside the case: a task that inherits the case's wedge + client context.
  app.post("/v1/cases/:id/tasks", async (c) => {
    const kase = await domain.getCase(c.req.param("id"));
    if (!kase || !inScope(accessible(c), kase.project_id)) return c.json({ error: "not found" }, 404);
    if (kase.status === "closed") return c.json({ error: "case is closed" }, 409);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    if (!b.task_type) return c.json({ error: "task_type is required" }, 400);
    const w = loadWedge(kase.wedge);
    const types = w?.manifest.task_types;
    if (types && Object.keys(types).length && !types[String(b.task_type)]) {
      return c.json({ error: `unknown task_type "${b.task_type}" for wedge "${kase.wedge}"` }, 400);
    }
    const cfg = loadConfig();
    const iso = new Date().toISOString();
    const task: Task = {
      id: randomUUID(),
      project_id: kase.project_id,
      case_id: kase.id,
      wedge: kase.wedge,
      task_type: String(b.task_type),
      actor: { kind: "system", id: `case:${kase.id}` },
      input: {
        ...((b.input as Record<string, unknown>) ?? {}),
        case: { id: kase.id, title: kase.title, stage: kase.stage, data: kase.data },
        client_id: kase.client_id,
      },
      constraints: clampConstraints(b.constraints as Partial<Constraints>, cfg.maxCostCeilingUsd, cfg.maxRuntimeCeilingS),
      tools: [],
      output_schema: types?.[String(b.task_type)]?.output_schema,
      status: "queued",
      cost_usd: 0,
      created_at: iso,
      updated_at: iso,
    };
    await store.createTask(task);
    await domain.updateCase(kase.id, {}, { at: iso, kind: "task_spawned", task_id: task.id, actor: "system" });
    void runTask(store, task.id).catch((err) => console.error("[mycel] case runTask error:", err));
    return c.json(task, 201);
  });

  // Internal: the agent reads and advances ITS OWN case. Not an outward action (no real-world side
  // effect), so it isn't gated — but it is scoped to this run's case and traced onto the timeline.
  app.get("/v1/internal/case", async (c) => {
    const grant = getActionGrant((c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, ""));
    if (!grant) return c.json({ ok: false, error: "invalid action token" }, 401);
    if (!grant.caseId) return c.json({ ok: false, error: "this task is not part of a case" }, 404);
    const kase = await domain.getCase(grant.caseId);
    if (!kase) return c.json({ ok: false, error: "not found" }, 404);
    return c.json({ ok: true, case: { ...kase, stages: caseStages(kase.wedge) } });
  });

  app.post("/v1/internal/case/update", async (c) => {
    const grant = getActionGrant((c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, ""));
    if (!grant) return c.json({ ok: false, error: "invalid action token" }, 401);
    if (!grant.caseId) return c.json({ ok: false, error: "this task is not part of a case" }, 404);
    const kase = await domain.getCase(grant.caseId);
    if (!kase) return c.json({ ok: false, error: "not found" }, 404);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const updated = await applyCaseUpdate(kase, b, "agent");
    if ("error" in updated) return c.json({ ok: false, error: updated.error }, 400);
    await emitEvent(store, grant.task_id, "progress", {
      note: `case updated${b.stage ? ` → ${b.stage}` : ""}`,
      case_id: kase.id,
    });
    return c.json({ ok: true, case: updated.value });
  });

  /** Shared by the public PUT and the agent's internal update: validate the stage, append history. */
  async function applyCaseUpdate(
    kase: import("./contract").Case,
    b: Record<string, unknown>,
    actor: string,
  ): Promise<{ value: unknown } | { error: string }> {
    const iso = new Date().toISOString();
    const patch: Record<string, unknown> = {};
    let event: import("./contract").CaseEvent | undefined;

    if (typeof b.stage === "string" && b.stage !== kase.stage) {
      const stages = caseStages(kase.wedge);
      if (stages.length && !stages.includes(b.stage)) {
        return { error: `unknown stage "${b.stage}" — wedge declares: ${stages.join(", ")}` };
      }
      patch.stage = b.stage;
      event = { at: iso, kind: "stage_changed", from: kase.stage, to: b.stage, note: typeof b.note === "string" ? b.note : undefined, actor };
    }
    // `data` merges rather than replaces, so a partial update can't wipe the engagement's state.
    if (b.data && typeof b.data === "object") patch.data = { ...kase.data, ...(b.data as Record<string, unknown>) };
    if (typeof b.title === "string") patch.title = b.title;
    if (typeof b.due_at === "string") patch.due_at = b.due_at;
    if (b.status === "closed" && kase.status !== "closed") {
      patch.status = "closed";
      patch.closed_at = iso;
      event = { at: iso, kind: "closed", note: typeof b.note === "string" ? b.note : undefined, actor };
    } else if (b.status === "open" && kase.status === "closed") {
      patch.status = "open";
      event = { at: iso, kind: "reopened", actor };
    }
    if (!event && typeof b.note === "string") event = { at: iso, kind: "note", note: b.note, actor };

    const value = await domain.updateCase(kase.id, patch as never, event);
    return { value };
  }

  // ── Schedules: recurring work (the operational spine) ──
  app.get("/v1/schedules", async (c) => {
    const set = accessible(c);
    return c.json((await domain.listSchedules()).filter((s) => inScope(set, s.project_id)));
  });
  app.post("/v1/schedules", async (c) => {
    const projectId = writeProjectId(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    if (!b.name || !b.wedge || !b.task_type || !b.cadence) {
      return c.json({ error: "name, wedge, task_type and cadence are required" }, 400);
    }
    const wedge = loadWedge(String(b.wedge));
    if (!wedge) return c.json({ error: `unknown wedge: ${b.wedge}` }, 400);
    const types = wedge.manifest.task_types;
    if (types && Object.keys(types).length && !types[String(b.task_type)]) {
      return c.json({ error: `unknown task_type "${b.task_type}" for wedge "${b.wedge}"` }, 400);
    }
    if (!identity.projectAllowsWedge(projectId, String(b.wedge))) {
      return c.json({ error: `wedge "${b.wedge}" is not enabled for this project` }, 403);
    }
    const cadence = b.cadence as Cadence;
    if (!validCadence(cadence)) return c.json({ error: "invalid cadence" }, 400);
    const s = await domain.createSchedule({
      project_id: projectId,
      name: String(b.name),
      wedge: String(b.wedge),
      task_type: String(b.task_type),
      input: (b.input as Record<string, unknown>) ?? {},
      cadence,
      enabled: b.enabled === undefined ? true : !!b.enabled,
      next_run_at: firstRun(cadence),
    });
    return c.json(s, 201);
  });
  app.get("/v1/schedules/:id", async (c) => {
    const s = await domain.getSchedule(c.req.param("id"));
    if (!s || !inScope(accessible(c), s.project_id)) return c.json({ error: "not found" }, 404);
    return c.json(s);
  });
  // Pause/resume or retarget a schedule.
  app.put("/v1/schedules/:id", async (c) => {
    const existing = await domain.getSchedule(c.req.param("id"));
    if (!existing || !inScope(accessible(c), existing.project_id)) return c.json({ error: "not found" }, 404);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    if (b.cadence && !validCadence(b.cadence as Cadence)) return c.json({ error: "invalid cadence" }, 400);
    const s = await domain.updateSchedule(existing.id, {
      enabled: typeof b.enabled === "boolean" ? b.enabled : undefined,
      name: typeof b.name === "string" ? b.name : undefined,
      input: (b.input as Record<string, unknown>) ?? undefined,
      cadence: (b.cadence as Cadence) ?? undefined,
      // changing the cadence re-bases the next run
      next_run_at: b.cadence ? firstRun(b.cadence as Cadence) : undefined,
    });
    return c.json(s);
  });
  app.delete("/v1/schedules/:id", async (c) => {
    const existing = await domain.getSchedule(c.req.param("id"));
    if (!existing || !inScope(accessible(c), existing.project_id)) return c.json({ error: "not found" }, 404);
    return c.json({ ok: await domain.deleteSchedule(existing.id) });
  });
  // Fire now (without disturbing the cadence) — the "test my schedule" button.
  app.post("/v1/schedules/:id/run", async (c) => {
    const s = await domain.getSchedule(c.req.param("id"));
    if (!s || !inScope(accessible(c), s.project_id)) return c.json({ error: "not found" }, 404);
    const task = await fireSchedule(store, domain, s);
    await domain.updateSchedule(s.id, { last_run_at: new Date().toISOString(), last_task_id: task.id });
    return c.json({ ok: true, task_id: task.id }, 201);
  });

  // ── Wedge config + living knowledge ──
  // The definition (wedge.json + skills) is authored/versioned on disk; knowledge is DATA the
  // founder edits at runtime (uploads, corrections) — no redeploy. At task time the runtime merges
  // disk knowledge + these live items so the agent is grounded in the latest.

  app.get("/v1/wedges/:wedge", async (c) => {
    const slug = c.req.param("wedge");
    const w = loadWedge(slug);
    if (!w) return c.json({ error: "unknown wedge" }, 404);
    const set = accessible(c);
    const live = (await domain.listKnowledge(slug)).filter((k) => inScope(set, k.project_id));
    return c.json({
      wedge: slug,
      manifest: w.manifest,
      skills: w.skills.map((s) => s.name),
      knowledge: {
        authored: w.knowledge.map((k) => k.name), // on disk
        live: live.map((k) => ({ id: k.id, name: k.name, kind: k.kind, source: k.source })),
      },
    });
  });

  app.get("/v1/wedges/:wedge/knowledge", async (c) => {
    const set = accessible(c);
    return c.json((await domain.listKnowledge(c.req.param("wedge"))).filter((k) => inScope(set, k.project_id)));
  });
  app.post("/v1/wedges/:wedge/knowledge", async (c) => {
    const wedge = c.req.param("wedge");
    if (!loadWedge(wedge)) return c.json({ error: "unknown wedge" }, 404);
    const projectId = writeProjectId(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    if (!b.name || typeof b.content !== "string") return c.json({ error: "name and content are required" }, 400);
    const item = await domain.createKnowledge({
      project_id: projectId,
      wedge,
      name: String(b.name),
      content: b.content,
      kind: (b.kind as KnowledgeItem["kind"]) ?? "document",
      source: (b.source as KnowledgeItem["source"]) ?? "uploaded",
      metadata: (b.metadata as Record<string, unknown>) ?? {},
    });
    return c.json(item, 201);
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

  // Feedback: rate a finished task and, when given, turn a correction into a grounding example.
  // This is the moat — the wedge gets better from being used, not from being re-authored.
  app.post("/v1/tasks/:id/feedback", async (c) => {
    const task = await store.getTask(c.req.param("id"));
    if (!task || !inScope(accessible(c), task.project_id)) return c.json({ error: "not found" }, 404);
    const b = (await c.req.json().catch(() => ({}))) as {
      rating?: "good" | "bad";
      correction?: string;
      note?: string;
    };
    let knowledgeId: string | undefined;
    if (b.correction) {
      const item = await domain.createKnowledge({
        project_id: task.project_id,
        wedge: task.wedge,
        name: `feedback-${new Date().toISOString().slice(0, 19)}.md`,
        content:
          `# Feedback on a "${task.task_type}" task\n\n` +
          (b.note ? `Note: ${b.note}\n\n` : "") +
          `## What good looks like here\n\n${b.correction}\n`,
        kind: "example",
        source: "feedback",
        metadata: { task_id: task.id, rating: b.rating },
      });
      knowledgeId = item.id;
    }
    await emitEvent(store, task.id, "feedback.recorded", {
      rating: b.rating,
      has_correction: !!b.correction,
      knowledge_id: knowledgeId,
    });
    return c.json({ ok: true, knowledge_id: knowledgeId });
  });

  // Inbound webhook: a message arrives on a channel. Resolve the client, append to the thread,
  // and spawn the task that handles it. The product proxies its provider's webhook (Postmark/
  // Twilio/…) here after verifying the provider signature — hence it sits behind the API key.
  app.post("/v1/channels/:id/inbound", async (c) => {
    const channel = await domain.getChannel(c.req.param("id"));
    if (!channel || !inScope(accessible(c), channel.project_id)) return c.json({ error: "unknown channel" }, 404);
    const pid = channel.project_id;
    const b = (await c.req.json().catch(() => ({}))) as {
      from?: { handle?: string; name?: string };
      body?: string;
      subject?: string;
    };
    const handle = b.from?.handle ?? "anonymous";
    let client = await domain.findClientByHandle(handle);
    if (!client || client.project_id !== pid) {
      client = await domain.createClient({
        project_id: pid,
        display_name: b.from?.name,
        handles: [handle],
        metadata: {},
      });
    }
    const thread = await domain.findOrCreateThread(client.id, channel.id, pid, b.subject);
    await domain.addMessage({
      thread_id: thread.id,
      direction: "inbound",
      author: client.id,
      body: b.body ?? "",
    });
    const history = await domain.listMessages(thread.id);

    const cfg = loadConfig();
    const now = new Date().toISOString();
    const task: Task = {
      id: randomUUID(),
      project_id: pid,
      wedge: channel.wedge,
      task_type: channel.task_type,
      actor: { kind: "user", id: client.id },
      input: {
        message: b.body ?? "",
        subject: b.subject,
        thread_id: thread.id, // links the run's action grant to this conversation
        client: { id: client.id, display_name: client.display_name, handles: client.handles },
        history: history.map((m) => ({ direction: m.direction, body: m.body })),
      },
      constraints: clampConstraints({}, cfg.maxCostCeilingUsd, cfg.maxRuntimeCeilingS),
      tools: [],
      output_schema: loadWedge(channel.wedge)?.manifest.task_types?.[channel.task_type]?.output_schema,
      status: "queued",
      cost_usd: 0,
      created_at: now,
      updated_at: now,
    };
    await store.createTask(task);
    void runTask(store, task.id).catch((err) => console.error("[mycel] runTask error:", err));
    return c.json({ task_id: task.id, thread_id: thread.id, client_id: client.id }, 201);
  });

  // Internal: deterministic workflows. The agent calls a NAMED function the wedge ships, with JSON
  // args — it cannot define or edit the code. Pure computation, so no approval gate; traced like a
  // tool call so the founder sees which computation ran on what inputs.
  app.post("/v1/internal/workflows/:name", async (c) => {
    const grant = getActionGrant((c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, ""));
    if (!grant) return c.json({ ok: false, error: "invalid action token" }, 401);
    const task = await store.getTask(grant.task_id);
    if (!task) return c.json({ ok: false, error: "unknown task" }, 404);
    const name = c.req.param("name");
    const args = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

    await emitEvent(store, grant.task_id, "tool.called", { tool: `workflow:${name}`, args });
    const result = await runWorkflow(task.wedge, name, args);
    await emitEvent(store, grant.task_id, "tool.result", {
      tool: `workflow:${name}`,
      ok: result.ok,
      ms: result.ms,
      error: result.error,
    });
    return c.json(result, result.ok ? 200 : 400);
  });

  // Internal: the READ proxy. The asymmetric half of the trust model — a read is ungated (an agent
  // that must wait for a human before it can look at today's transactions is useless), but still
  // scoped: only a granted connection, only GET, the host comes from the connection (no SSRF), the
  // response is size-capped, reads are rate-limited per task, and every read is traced onto the
  // task timeline so the founder can see exactly what data was pulled.
  app.post("/v1/internal/reads/:capability", async (c) => {
    const nonce = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
    const grant = getActionGrant(nonce);
    if (!grant) return c.json({ ok: false, error: "invalid action token" }, 401);
    const capability = c.req.param("capability");
    const params = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

    // Bound how much a runaway agent can hammer a third-party API on one task.
    if (readsExceeded(grant.task_id)) {
      return c.json({ ok: false, error: `read limit reached for this task (${READ_MAX_PER_TASK})` }, 429);
    }

    // Same connection resolution as the action proxy: explicit id must be granted, else match kind.
    const allowed = grant.connectionIds;
    let connId = typeof params.connection_id === "string" ? params.connection_id : undefined;
    if (connId && !allowed.includes(connId)) return c.json({ ok: false, error: "connection not granted" }, 403);
    if (!connId) {
      for (const id of allowed) {
        const conn = await domain.getConnection(id);
        if (conn && capability.toLowerCase().includes(conn.kind)) {
          connId = id;
          break;
        }
      }
    }
    const conn = connId ? await domain.getConnection(connId) : undefined;
    if (!conn) return c.json({ ok: false, error: "no granted connection for this read" }, 400);

    const tool = `read:${conn.kind}:${capability}`;
    await emitEvent(store, grant.task_id, "tool.called", {
      tool,
      args: { connection: conn.name, path: params.path, query: params.query },
    });
    const result = await executeRead(conn, capability, params);
    await emitEvent(store, grant.task_id, "tool.result", {
      tool,
      ok: result.ok,
      status: result.status,
      bytes: result.bytes,
      truncated: result.truncated,
      detail: result.detail,
    });
    return c.json(result);
  });

  // Internal: the action proxy — the generalization of the LLM proxy to real-world side effects.
  // The sandbox calls this with its action nonce; the harness resolves the connection (whose
  // secret it holds), runs the HUMAN APPROVAL GATE, executes, records the outbound message, and
  // traces it. Connection secrets never enter the sandbox; every action passes a human.
  app.post("/v1/internal/actions/:capability", async (c) => {
    const nonce = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
    const grant = getActionGrant(nonce);
    if (!grant) return c.json({ ok: false, error: "invalid action token" }, 401);
    const capability = c.req.param("capability");
    const payload = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

    // Pick the connection: an explicit id (must be in the grant), else the first granted
    // connection whose kind matches the capability name.
    const allowed = grant.connectionIds;
    let connId = typeof payload.connection_id === "string" ? payload.connection_id : undefined;
    if (connId && !allowed.includes(connId)) return c.json({ ok: false, error: "connection not granted" }, 403);
    if (!connId) {
      for (const id of allowed) {
        const conn = await domain.getConnection(id);
        if (conn && capability.toLowerCase().includes(conn.kind)) {
          connId = id;
          break;
        }
      }
    }
    const conn = connId ? await domain.getConnection(connId) : undefined;
    if (!conn) return c.json({ ok: false, error: "no granted connection for this action" }, 400);

    // HUMAN APPROVAL GATE — suspends the task, surfaces a preview, waits for approve/reject.
    const preview = actionPreview(conn, capability, payload);
    const { decision, edited } = await awaitApproval(store, grant.task_id, {
      action: `${conn.kind}:${capability}`,
      risk: "high",
      preview,
    });
    // auto_approved means a wedge policy envelope allowed it — proceed, exactly like a human yes.
    if (decision !== "approved" && decision !== "auto_approved") {
      return c.json({ ok: false, decision, error: `action ${decision}` }, 200);
    }

    // If the human corrected the action, act on the correction AND capture it as learning — this
    // is the feedback loop: the edited output becomes a grounding example for next time.
    const finalPayload = edited ? { ...payload, ...edited } : payload;
    if (edited) {
      const task = await store.getTask(grant.task_id);
      if (task) {
        await domain.createKnowledge({
          wedge: task.wedge,
          name: `correction-${new Date().toISOString().slice(0, 19)}.md`,
          content:
            `# Human correction (${conn.kind}:${capability})\n\n` +
            `The agent proposed, then a human edited before sending. Prefer the corrected form.\n\n` +
            `## Proposed\n\n${JSON.stringify(payload, null, 2)}\n\n## Corrected (do it this way)\n\n${JSON.stringify(finalPayload, null, 2)}\n`,
          kind: "correction",
          source: "feedback",
          metadata: { task_id: grant.task_id, capability },
        });
        await emitEvent(store, grant.task_id, "feedback.recorded", { kind: "correction", capability });
      }
    }

    const result = await executeAction(conn, capability, finalPayload);
    const actedTask = await store.getTask(grant.task_id);
    await audit({
      project_id: actedTask?.project_id ?? "",
      actor: decision === "auto_approved" ? "policy" : "member",
      action: "action.executed",
      entity: "connection",
      entity_id: conn.id,
      detail: { capability, connection: conn.name, ok: result.ok, decision, to: finalPayload.to, edited: !!edited },
    });

    // Record the outbound message on the conversation + surface the outcome on the task timeline.
    if (grant.threadId) {
      await domain.addMessage({
        thread_id: grant.threadId,
        direction: "outbound",
        author: "agent",
        body: typeof finalPayload.body === "string" ? finalPayload.body : JSON.stringify(finalPayload),
        status: result.ok ? "sent" : "failed",
        task_id: grant.task_id,
      });
    }
    await emitEvent(store, grant.task_id, "tool.result", {
      tool: `${conn.kind}:${capability}`,
      ok: result.ok,
      detail: result.detail,
    });
    return c.json({ ok: result.ok, detail: result.detail, data: result.data });
  });

  return app;
}

/** Reject malformed cadences at the boundary rather than letting the tick loop trip over them. */
function validCadence(c: Cadence | undefined): boolean {
  if (!c || typeof c !== "object") return false;
  if (c.kind === "every") return Number.isFinite(c.seconds) && c.seconds >= 1;
  if (c.kind === "daily") return c.hour >= 0 && c.hour <= 23 && c.minute >= 0 && c.minute <= 59;
  if (c.kind === "monthly") return c.day >= 1 && c.day <= 31 && c.hour >= 0 && c.hour <= 23 && c.minute >= 0 && c.minute <= 59;
  return false;
}

/** Clamp client-supplied constraints to server ceilings so a caller can't set max_cost_usd: 1e6. */
function clampConstraints(
  c: Partial<Constraints> | undefined,
  costCeiling: number,
  runtimeCeiling: number,
): Constraints {
  const max_cost_usd = Math.min(Math.max(0, c?.max_cost_usd ?? 1), costCeiling);
  const max_runtime_s = Math.min(Math.max(1, c?.max_runtime_s ?? 300), runtimeCeiling);
  return { max_cost_usd, max_runtime_s, approval_required: c?.approval_required ?? false };
}
