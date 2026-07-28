// The Task API + SSE gateway (docs/CONTRACT.md §4). Founder products and the dashboard call
// this; browsers subscribe to the event stream through the product's server-side proxy.
//
// Auth: the public /v1 surface requires the founder API key (see auth.ts). The /v1/internal/*
// surface is sandbox-facing and authed separately (gate token / proxy nonce) — the sandbox does
// NOT hold the founder key, so the API-key middleware must not cover it.
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { requireApiKey, safeEqual } from "./auth";
import { awaitApproval, failWaitersForTask, resolveApproval } from "./approvals";
import { actionPreview, executeAction } from "./actions";
import { getActionGrant } from "./actiongrants";
import { getArtifactBackend } from "./artifacts";
import { subscribe } from "./bus";
import { markCancelled } from "./cancel";
import { loadConfig } from "./config";
import type {
  Constraints,
  ConnectionKind,
  CreateTaskInput,
  Risk,
  Task,
  TaskEvent,
  TaskStatus,
} from "./contract";
import { getDomainStore } from "./domain";
import { emitEvent } from "./events";
import { runTask } from "./orchestrator";
import { getGrant } from "./proxygrants";
import type { Store } from "./store";
import { traceLlmCall } from "./tracing";
import { loadWedge } from "./wedge";

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

// Idempotency: same Idempotency-Key returns the same task instead of spawning a duplicate (and
// duplicate real-world side effects). In-process for now (single-instance); back with the store
// for multi-instance.
const idempotency = new Map<string, string>();

export function createServer(store: Store): Hono {
  const app = new Hono();
  const domain = getDomainStore();

  app.get("/health", (c) => c.json({ ok: true, service: "mycel-harness", version: "v0.1" }));

  // Everything under /v1 EXCEPT /v1/internal/* requires the founder API key.
  app.use("/v1/*", async (c, next) => {
    if (c.req.path.startsWith("/v1/internal/")) return next();
    return requireApiKey(c, next);
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

  // GET /v1/tasks/:id
  app.get("/v1/tasks/:id", async (c) => {
    const t = await store.getTask(c.req.param("id"));
    return t ? c.json(t) : c.json({ error: "not found" }, 404);
  });

  // GET /v1/tasks/:id/events — SSE with Last-Event-ID replay
  app.get("/v1/tasks/:id/events", async (c) => {
    const taskId = c.req.param("id");
    if (!(await store.getTask(taskId))) return c.json({ error: "not found" }, 404);
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
    if (!t) return c.json({ error: "not found" }, 404);
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
      // Atomic decide: only the first transition off "pending" wins (no approve/reject TOCTOU).
      if (a.status !== "pending") return c.json({ error: `already ${a.status}` }, 409);
      const settled = resolveApproval(id, decision); // resolves the waiter, which persists status
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
    return c.json({ allow: decision === "approved", decision });
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
    let content = a.content;
    if (!content) content = (await getArtifactBackend().then((b) => b.get(a.id))) ?? "";
    return new Response(content, { headers: { "content-type": a.content_type } });
  });

  // ── The service surface: connections / channels / clients / threads ──
  // Secrets are never returned: connections expose config + a secret_ref, never the secret.

  app.post("/v1/connections", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    if (!b.kind || !b.name) return c.json({ error: "kind and name are required" }, 400);
    const conn = await domain.createConnection({
      kind: b.kind as ConnectionKind,
      name: String(b.name),
      config: (b.config as Record<string, unknown>) ?? {},
      secret_ref: typeof b.secret_ref === "string" ? b.secret_ref : undefined,
    });
    return c.json(conn, 201);
  });
  app.get("/v1/connections", async (c) => c.json(await domain.listConnections()));
  app.get("/v1/connections/:id", async (c) => {
    const conn = await domain.getConnection(c.req.param("id"));
    return conn ? c.json(conn) : c.json({ error: "not found" }, 404);
  });

  app.post("/v1/channels", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const conn = b.connection_id ? await domain.getConnection(String(b.connection_id)) : undefined;
    if (!conn) return c.json({ error: "unknown connection_id" }, 400);
    if (!b.address || !b.wedge || !b.task_type) {
      return c.json({ error: "address, wedge and task_type are required" }, 400);
    }
    if (!loadWedge(String(b.wedge))) return c.json({ error: `unknown wedge: ${b.wedge}` }, 400);
    const ch = await domain.createChannel({
      connection_id: conn.id,
      kind: conn.kind,
      address: String(b.address),
      wedge: String(b.wedge),
      task_type: String(b.task_type),
    });
    return c.json(ch, 201);
  });
  app.get("/v1/channels", async (c) => c.json(await domain.listChannels()));

  app.post("/v1/clients", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const client = await domain.createClient({
      display_name: typeof b.display_name === "string" ? b.display_name : undefined,
      handles: Array.isArray(b.handles) ? (b.handles as string[]) : [],
      metadata: (b.metadata as Record<string, unknown>) ?? {},
    });
    return c.json(client, 201);
  });
  app.get("/v1/clients", async (c) => c.json(await domain.listClients()));
  app.get("/v1/clients/:id", async (c) => {
    const client = await domain.getClient(c.req.param("id"));
    if (!client) return c.json({ error: "not found" }, 404);
    const threads = await domain.listThreadsForClient(client.id);
    return c.json({ ...client, threads });
  });

  app.get("/v1/threads/:id", async (c) => {
    const thread = await domain.getThread(c.req.param("id"));
    if (!thread) return c.json({ error: "not found" }, 404);
    return c.json({ ...thread, messages: await domain.listMessages(thread.id) });
  });

  // Inbound webhook: a message arrives on a channel. Resolve the client, append to the thread,
  // and spawn the task that handles it. The product proxies its provider's webhook (Postmark/
  // Twilio/…) here after verifying the provider signature — hence it sits behind the API key.
  app.post("/v1/channels/:id/inbound", async (c) => {
    const channel = await domain.getChannel(c.req.param("id"));
    if (!channel) return c.json({ error: "unknown channel" }, 404);
    const b = (await c.req.json().catch(() => ({}))) as {
      from?: { handle?: string; name?: string };
      body?: string;
      subject?: string;
    };
    const handle = b.from?.handle ?? "anonymous";
    let client = await domain.findClientByHandle(handle);
    if (!client) {
      client = await domain.createClient({
        display_name: b.from?.name,
        handles: [handle],
        metadata: {},
      });
    }
    const thread = await domain.findOrCreateThread(client.id, channel.id, b.subject);
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
    const { decision } = await awaitApproval(store, grant.task_id, {
      action: `${conn.kind}:${capability}`,
      risk: "high",
      preview,
    });
    if (decision !== "approved") {
      return c.json({ ok: false, decision, error: `action ${decision}` }, 200);
    }

    const result = await executeAction(conn, capability, payload);

    // Record the outbound message on the conversation + surface the outcome on the task timeline.
    if (grant.threadId) {
      await domain.addMessage({
        thread_id: grant.threadId,
        direction: "outbound",
        author: "agent",
        body: typeof payload.body === "string" ? payload.body : JSON.stringify(payload),
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
