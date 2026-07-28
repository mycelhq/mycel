// The Task API + SSE gateway (docs/CONTRACT.md §4). Founder products and the dashboard
// call this; browsers subscribe to the event stream.
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { awaitApproval, resolveApproval } from "./approvals";
import { subscribe } from "./bus";
import { markCancelled } from "./cancel";
import { loadConfig } from "./config";
import type { CreateTaskInput, Risk, Task, TaskEvent } from "./contract";
import { runTask } from "./orchestrator";
import type { Store } from "./store";

export function createServer(store: Store): Hono {
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true, service: "mycel-harness", version: "v0.1" }));

  // POST /v1/tasks — create + kick off a task
  app.post("/v1/tasks", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Partial<CreateTaskInput>;
    if (!body.wedge || !body.task_type) {
      return c.json({ error: "wedge and task_type are required" }, 400);
    }
    const now = new Date().toISOString();
    const task: Task = {
      id: randomUUID(),
      wedge: body.wedge,
      task_type: body.task_type,
      actor: body.actor ?? { kind: "user", id: "anon" },
      input: body.input ?? {},
      constraints: {
        max_runtime_s: 300,
        max_cost_usd: 1,
        approval_required: false,
        ...(body.constraints ?? {}),
      },
      tools: body.tools ?? [],
      output_schema: body.output_schema,
      status: "queued",
      cost_usd: 0,
      created_at: now,
      updated_at: now,
    };
    await store.createTask(task);
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
    const lastId = Number(c.req.header("Last-Event-ID") ?? c.req.query("lastEventId") ?? 0);

    return streamSSE(c, async (stream) => {
      let lastSent = lastId;
      const queue: TaskEvent[] = [];
      let wake: (() => void) | null = null;
      const unsub = subscribe(taskId, (ev) => {
        queue.push(ev);
        const w = wake;
        wake = null;
        w?.();
      });
      stream.onAbort(() => {
        const w = wake;
        wake = null;
        w?.();
      });

      // replay persisted events first
      for (const ev of await store.eventsAfter(taskId, lastId)) {
        await stream.writeSSE({ id: String(ev.id), event: ev.type, data: JSON.stringify(ev) });
        lastSent = ev.id;
      }
      const all = await store.eventsAfter(taskId, 0);
      if (all.at(-1)?.type === "task.finished") {
        unsub();
        return;
      }

      // then live, deduped against replayed ids
      let done = false;
      while (!done && !stream.aborted) {
        if (queue.length === 0) await new Promise<void>((r) => (wake = r));
        while (queue.length) {
          const ev = queue.shift();
          if (!ev || ev.id <= lastSent) continue;
          lastSent = ev.id;
          await stream.writeSSE({ id: String(ev.id), event: ev.type, data: JSON.stringify(ev) });
          if (ev.type === "task.finished") done = true;
        }
      }
      unsub();
    });
  });

  app.post("/v1/tasks/:id/cancel", async (c) => {
    const t = await store.getTask(c.req.param("id"));
    if (!t) return c.json({ error: "not found" }, 404);
    markCancelled(t.id);
    await store.setStatus(t.id, "cancelled");
    return c.json(await store.getTask(t.id));
  });

  const decide =
    (decision: "approved" | "rejected") => async (c: import("hono").Context) => {
      const id = c.req.param("id");
      if (!id) return c.json({ error: "not found" }, 404);
      const a = await store.getApproval(id);
      if (!a) return c.json({ error: "not found" }, 404);
      if (a.status !== "pending") return c.json({ error: `already ${a.status}` }, 409);
      await store.setApproval(id, decision);
      resolveApproval(id, decision);
      return c.json({ ok: true, decision });
    };
  app.post("/v1/approvals/:id/approve", decide("approved"));
  app.post("/v1/approvals/:id/reject", decide("rejected"));

  // Internal: the sandbox's OpenCode plugin calls this to gate a risky action. Blocks until a
  // human approves/rejects, then returns { allow }. Authed by the shared gate token.
  app.post("/v1/internal/gate", async (c) => {
    const token = c.req.header("x-mycel-gate-token");
    if (!token || token !== loadConfig().gateToken) return c.json({ allow: false, decision: "unauthorized" }, 401);
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

  app.get("/v1/artifacts/:id", async (c) => {
    const a = await store.getArtifact(c.req.param("id"));
    if (!a) return c.json({ error: "not found" }, 404);
    return new Response(a.content, { headers: { "content-type": a.content_type } });
  });

  return app;
}
