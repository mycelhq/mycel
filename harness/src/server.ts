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
import { buildChecklist, listBlueprints, loadBlueprint, provision } from "./blueprints";
import { bearer, requireApiKey, safeEqual } from "./auth";
import { awaitApproval, failWaitersForTask, resolveApproval } from "./approvals";
import { actionPreview, executeAction, executeRead } from "./actions";
import { capabilitiesForConnection, guardSend, isMessagingSend } from "./outreach/guard";
import { getClientContext, updateClientContext } from "./client-context";
import {
  intakeDedupeKey,
  intakeSourceForChannelKind,
  lookupIntakeReplay,
  normalizeIntake,
  rememberIntake,
  type NormalizedIntake,
} from "./intake-normalize";
import { mountLinkedIn } from "./linkedin/routes";
import { mountGtm } from "./gtm/routes";
import { mountInsight } from "./insight/routes";
import { getActionGrant } from "./actiongrants";
import { getArtifactBackend } from "./artifacts";
import { subscribe } from "./bus";
import { markCancelled } from "./cancel";
import { databaseUrl, loadConfig } from "./config";
import type {
  Approval,
  Artifact,
  Constraints,
  Connection,
  ConnectionKind,
  ConnectionOwner,
  Cadence,
  CreateTaskInput,
  KnowledgeItem,
  Risk,
  Task,
  EventType,
  TaskEvent,
  TaskStatus,
} from "./contract";
import { getDomainStore } from "./domain";
import { profileConstraintDefaults } from "./harness";
import { emitEvent } from "./events";
import { canManageMembers, getIdentityStore, PLAN_LIMITS } from "./identity";
import type { Plan, PlanStatus, Role } from "./identity";
import { fireSchedule, firstRun } from "./scheduler";
import { enqueueTask } from "./queue";
import { getGrant } from "./proxygrants";
import { hasSecret, setSecret } from "./secrets";
import { stripContent as stripArtifactContent } from "./store";
import { taskClientId } from "./runtime";
import { buildTrace } from "./traces";
import type { Store } from "./store";
import {
  connConfig as composioConnConfig,
  composioConfig,
  composioUserId,
  connectionStatus as composioStatus,
  initiateConnection as composioInitiate,
  isReadTool as isComposioReadTool,
  listTools as composioListTools,
  listToolkits as composioListToolkits,
  listAllToolkits as composioListAllToolkits,
  listCategories as composioCategories,
  createManagedAuthConfig,
  slugToolkit,
  composioWebhookSecret,
  deleteTrigger as composioDeleteTrigger,
  parseTriggerEvent,
  setTriggerEnabled as composioSetTriggerEnabled,
  setWebhookSubscription as composioSetWebhookSubscription,
  upsertTrigger as composioUpsertTrigger,
  verifyWebhook as verifyComposioWebhook,
  WEBHOOK_HEADERS,
} from "./composio";
import type { Toolkit as ComposioToolkit } from "./composio";
import { startRunFromTrigger } from "./triggers";
import { buildCoverage, gapId, isGapId, recordAnswer } from "./intake";
import {
  exchangePortalLink,
  mintPortalLink,
  resolveClientSession,
  revokeClientSessions,
  type ClientScope,
} from "./portal";
import { traceLlmCall } from "./tracing";
import { loadWedge, wedgesDir, type LoadedWedge } from "./wedge";
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
  // Reads see every project in scope, unless the caller names one with X-Mycel-Project — the same
  // header that selects the target of a write. One header, one meaning, both directions.
  const accessible = (c: import("hono").Context) =>
    identity.accessibleProjectIds(c.get("scope"), c.req.header("x-mycel-project"));
  const writeProjectId = (c: import("hono").Context) =>
    identity.resolveWriteProject(c.get("scope"), c.req.header("x-mycel-project"));
  const inScope = (set: Set<string>, pid?: string) => !!pid && set.has(pid);

  /**
   * Does this client id name a client in this project?
   *
   * Every route that lets a caller attach a task to a client must ask. `task.client_id` is what the
   * client-context façade joins on, so writing an unchecked string there lets someone point their
   * own task at a victim's client and have their artifacts surface inside that client's context —
   * and, in the other direction, plant content in a context a rival's operator reads as their own.
   * The check is deliberately strict on both sides: no client, or a client in another project, is a
   * refusal, never a silently-dropped field.
   */
  const clientInProject = async (clientId: string, projectId: string): Promise<boolean> => {
    if (!clientId || !projectId) return false;
    const row = await domain.getClient(clientId);
    return !!row && row.project_id === projectId;
  };

  /**
   * Which granted connection a capability refers to.
   *
   * An explicit `connection_id` must be in the grant. Otherwise: a Composio capability is a tool slug
   * like `XERO_GET_INVOICES`, so match its prefix against the connection's toolkit; everything else
   * falls back to matching the connection kind inside the capability name ("send_email" → `email`).
   */
  const resolveGrantedConnection = async (
    allowed: string[],
    capability: string,
    explicit?: unknown,
  ): Promise<{ id?: string; refused?: true }> => {
    if (typeof explicit === "string") {
      return allowed.includes(explicit) ? { id: explicit } : { refused: true };
    }
    const toolkit = slugToolkit(capability);
    const conns = (await Promise.all(allowed.map((id) => domain.getConnection(id)))).filter(
      (x): x is NonNullable<typeof x> => !!x,
    );
    const byToolkit = toolkit
      ? conns.find((cn) => cn.kind === "composio" && composioConnConfig(cn).toolkit.toLowerCase() === toolkit)
      : undefined;
    const byKind = conns.find((cn) => capability.toLowerCase().includes(cn.kind));
    return { id: (byToolkit ?? byKind)?.id };
  };

  // ── file uploads ──
  //
  // Two rules govern everything below.
  //
  // 1. Never serve an upload as something a browser will execute. An HTML file uploaded by a
  //    customer and served back with `text/html` from the app's own origin is stored XSS against
  //    the founder — the classic way a file feature becomes an account takeover. So: forced
  //    download, `nosniff`, and executable-ish types rewritten to octet-stream.
  // 2. The size ceiling is enforced before anything is stored, not after. A 2GB body that gets
  //    rejected at the end has already been in memory.

  const MAX_UPLOAD_BYTES = Number(process.env.MYCEL_MAX_UPLOAD_MB ?? 25) * 1024 * 1024;

  /** Types a browser will run. Rewritten on the way out; still stored exactly as received. */
  const EXECUTABLE_TYPES = /^(text\/html|image\/svg\+xml|application\/xhtml|text\/xml|application\/xml)/i;

  /** Text stays text so an artifact can still be read as prose; everything else is base64. */
  const isTextual = (type: string) =>
    /^text\/plain|^text\/csv|^text\/markdown|^application\/json|^application\/x-ndjson/i.test(type);

  /**
   * Read a multipart upload and store it.
   *
   * Returns a discriminated result rather than throwing, because every caller wants to turn the
   * failure into a specific status code and message.
   */
  const ingestUpload = async (
    c: import("hono").Context,
    taskId: string,
    opts: { uploadedBy: string; clientId?: string },
  ): Promise<{ artifact: Artifact } | { error: string; status: number }> => {
    let form: Record<string, unknown>;
    try {
      form = await c.req.parseBody();
    } catch {
      return { error: "expected a multipart/form-data upload", status: 400 };
    }
    const file = form.file;
    if (!(file instanceof File)) return { error: "a 'file' part is required", status: 400 };
    if (file.size > MAX_UPLOAD_BYTES) {
      return { error: `file is larger than ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB`, status: 413 };
    }
    const bytes = Buffer.from(await file.arrayBuffer());
    // Trust the length we actually read, not the one the client declared.
    if (bytes.byteLength > MAX_UPLOAD_BYTES) {
      return { error: `file is larger than ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB`, status: 413 };
    }
    if (bytes.byteLength === 0) return { error: "the file is empty", status: 400 };

    const type = file.type || "application/octet-stream";
    const textual = isTextual(type);
    const artifact = await store.addArtifact({
      task_id: taskId,
      // Basename only. A name like "../../etc/passwd" is harmless to the database and lethal to
      // any consumer that writes it to disk, and the fs artifact backend is one.
      name: (file.name || "upload").split(/[\\/]/).pop()!.slice(0, 200),
      content_type: type,
      content: textual ? bytes.toString("utf8") : bytes.toString("base64"),
      encoding: textual ? "utf8" : "base64",
      size_bytes: bytes.byteLength,
      source: "upload",
      client_id: opts.clientId,
      uploaded_by: opts.uploadedBy,
    });
    const backend = await getArtifactBackend();
    if (!backend.inline) await backend.put(artifact.id, artifact.content);
    await emitEvent(store, taskId, "artifact.created", {
      artifact_id: artifact.id,
      name: artifact.name,
      content_type: artifact.content_type,
      size_bytes: artifact.size_bytes,
      source: "upload",
    });
    return { artifact };
  };

  /** Fill in content from the artifact backend when it isn't stored inline. */
  const withContent = async (a: Artifact): Promise<Artifact> => {
    if (a.content) return a;
    const backend = await getArtifactBackend();
    return { ...a, content: (await backend.get(a.id)) ?? "" };
  };

  /** Serve the bytes, defensively. See the two rules above. */
  const serveArtifact = (a: Artifact): Response => {
    const body: Buffer | string =
      a.encoding === "base64" ? Buffer.from(a.content, "base64") : a.content;
    const type = EXECUTABLE_TYPES.test(a.content_type) ? "application/octet-stream" : a.content_type;
    return new Response(body as unknown as ReadableStream | string, {
      headers: {
        "content-type": type,
        // Quoted and stripped of quotes/newlines: an unescaped filename here is header injection.
        "content-disposition": `attachment; filename="${a.name.replace(/["\r\n]/g, "")}"`,
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
      },
    });
  };

  app.get("/health", (c) => c.json({ ok: true, service: "mycel-harness", version: "v0.1" }));

  // Member login (portal). No auth — it IS the auth. Returns a session token the portal forwards.
  // ── Client portal ──
  // A separate credential plane. `/v1/portal/*` accepts ONLY a client session, and a client session
  // is not resolvable anywhere else — so this is the one place in the kernel that answers to someone
  // other than the founder, and it can only ever answer about them.
  app.post("/v1/portal/session", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as { token?: string };
    const out = await exchangePortalLink(b.token ?? "");
    // One message for expired, used and forged alike: distinguishing them tells someone holding a
    // stale link whether it was ever real.
    if (!out) return c.json({ error: "that link is invalid or has expired" }, 401);
    const client = await domain.getClient(out.scope.client_id);
    return c.json({
      token: out.token,
      expires_at: out.expires_at,
      client: client ? { id: client.id, display_name: client.display_name } : undefined,
    });
  });

  app.use("/v1/portal/*", async (c, next) => {
    if (c.req.path === "/v1/portal/session") return next();
    const scope = await resolveClientSession(bearer(c));
    if (!scope) return c.json({ error: "unauthorized" }, 401);
    c.set("client", scope);
    await next();
  });

  /** The scope is the only source of client identity here — never a path or body parameter. */
  const client = (c: import("hono").Context) => c.get("client") as ClientScope;

  app.get("/v1/portal/me", async (c) => {
    const sc = client(c);
    const row = await domain.getClient(sc.client_id);
    if (!row || row.project_id !== sc.project_id) return c.json({ error: "not found" }, 404);
    return c.json({ id: row.id, display_name: row.display_name, since: row.created_at });
  });

  app.get("/v1/portal/threads", async (c) => {
    const sc = client(c);
    const threads = (await domain.listThreadsForClient(sc.client_id)).filter(
      // The client_id lookup should be sufficient; the project check is belt and braces against a
      // future store that indexes differently.
      (t) => !t.project_id || t.project_id === sc.project_id,
    );
    return c.json(threads);
  });

  app.get("/v1/portal/threads/:id", async (c) => {
    const sc = client(c);
    const thread = await domain.getThread(c.req.param("id") ?? "");
    // Ownership is checked against the SESSION, not against anything the caller sent. A 404 rather
    // than a 403, so probing ids can't confirm that someone else's thread exists.
    if (!thread || thread.client_id !== sc.client_id) return c.json({ error: "not found" }, 404);
    const messages = await domain.listMessages(thread.id);
    return c.json({ thread, messages });
  });

  app.post("/v1/portal/threads/:id/messages", async (c) => {
    const sc = client(c);
    const thread = await domain.getThread(c.req.param("id") ?? "");
    if (!thread || thread.client_id !== sc.client_id) return c.json({ error: "not found" }, 404);
    const b = (await c.req.json().catch(() => ({}))) as { body?: string };
    const body = (b.body ?? "").trim();
    if (!body) return c.json({ error: "body is required" }, 400);
    if (body.length > 10_000) return c.json({ error: "message is too long" }, 413);
    const msg = await domain.addMessage({
      thread_id: thread.id,
      direction: "inbound",
      // Attributed to the client from the session — a client cannot post as the agent or as another
      // customer by setting a field.
      author: sc.client_id,
      body,
      status: "sent",
    });

    // …and the business actually does something about it. See `spawnFromThread`.
    const taskId = await spawnFromThread(thread, sc, body);
    return c.json({ ...msg, task_id: taskId }, 201);
  });

  /**
   * A customer sending in a document.
   *
   * The whole reason binary artifacts exist: "here is my bank statement" is the opening move of
   * most service businesses, and until now the portal could only carry prose. The upload spawns a
   * run exactly as a message does — same wedge, same approval gate — with the file attached to it,
   * because an attachment with no work attached to it is a filing cabinet, not a service.
   */
  app.post("/v1/portal/threads/:id/attachments", async (c) => {
    const sc = client(c);
    const thread = await domain.getThread(c.req.param("id") ?? "");
    if (!thread || thread.client_id !== sc.client_id) return c.json({ error: "not found" }, 404);

    const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
    const note = typeof form.body === "string" ? form.body.trim().slice(0, 10_000) : "";
    const filename = form.file instanceof File ? form.file.name : "a file";
    const msg = await domain.addMessage({
      thread_id: thread.id,
      direction: "inbound",
      author: sc.client_id,
      body: note || `Sent a file: ${filename}`,
      status: "sent",
    });
    const taskId = await spawnFromThread(thread, sc, note || `Attached ${filename}`);
    if (!taskId) {
      // No channel or no wedge — the message is recorded, but there is nowhere to put the file,
      // and inventing a task to hang it on would be worse than saying so.
      return c.json({ ...msg, error: "this thread has no live channel, so the file was not stored" }, 409);
    }
    const up = await ingestUpload(c, taskId, { uploadedBy: sc.client_id, clientId: sc.client_id });
    if ("error" in up) return c.json({ error: up.error }, up.status as 400);
    return c.json({ message: msg, task_id: taskId, artifact: stripArtifactContent(up.artifact) }, 201);
  });

  /**
   * The files on a customer's thread.
   *
   * Without this the portal could accept an upload and then had no way to list it: artifacts hang
   * off tasks, and a task id only reaches a customer when the agent posts an outbound message. So
   * the UI had to reconstruct the list from the run event stream, which meant a file the customer
   * sent five minutes ago was invisible until the agent replied.
   *
   * Scoped twice, like the download below: the task must be in this project AND attributed to this
   * client.
   */
  app.get("/v1/portal/threads/:id/artifacts", async (c) => {
    const sc = client(c);
    const thread = await domain.getThread(c.req.param("id") ?? "");
    if (!thread || thread.client_id !== sc.client_id) return c.json({ error: "not found" }, 404);

    // Every run this thread has spawned, via the messages that carry a task id, plus any task whose
    // input names the thread — an upload's run is reachable either way.
    const messages = await domain.listMessages(thread.id);
    const ids = new Set(messages.map((m) => m.task_id).filter((x): x is string => !!x));
    for (const t of await store.listTasks({ limit: 500 })) {
      if (t.project_id === sc.project_id && (t.input as { thread_id?: string })?.thread_id === thread.id) {
        ids.add(t.id);
      }
    }

    const out: Omit<Artifact, "content">[] = [];
    for (const id of ids) {
      const t = await store.getTask(id);
      if (!t || t.project_id !== sc.project_id || taskClientId(t) !== sc.client_id) continue;
      out.push(...(await store.listArtifacts(id)));
    }
    out.sort((a, b) => a.created_at.localeCompare(b.created_at));
    return c.json(out);
  });

  /**
   * A customer downloading a file from their own thread.
   *
   * Two conditions, both required: the artifact's task belongs to this client, in this project.
   * Checking the task alone would let a client read a file the founder attached to someone else's
   * run that happened to reference them.
   */
  app.get("/v1/portal/artifacts/:id", async (c) => {
    const sc = client(c);
    const a = await store.getArtifact(c.req.param("id"));
    if (!a) return c.json({ error: "not found" }, 404);
    const t = await store.getTask(a.task_id);
    if (!t || t.project_id !== sc.project_id || taskClientId(t) !== sc.client_id) {
      return c.json({ error: "not found" }, 404);
    }
    return serveArtifact(await withContent(a));
  });

  /**
   * Spawn the run a client's inbound message deserves.
   *
   * Extracted so an attachment and a reply take the same path. Returns the task id, or undefined
   * when the thread's channel is gone or its wedge no longer loads — in which case the message is
   * still recorded and a human can pick it up.
   */
  async function spawnFromThread(
    thread: { id: string; channel_id: string; subject?: string },
    sc: { client_id: string; project_id: string },
    body: string,
  ): Promise<string | undefined> {
    let taskId: string | undefined;
    const channel = (await domain.listChannels()).find((ch) => ch.id === thread.channel_id);
    if (channel && loadWedge(channel.wedge)) {
      const history = await domain.listMessages(thread.id);
      const clientRow = await domain.getClient(sc.client_id);
      const cfg = loadConfig();
      const now = new Date().toISOString();
      const task: Task = {
        id: randomUUID(),
        project_id: sc.project_id,
        wedge: channel.wedge,
        task_type: channel.task_type,
        // `kind: "user"` with the client's id, so `selectGrantableConnections` scopes the run to
        // this client's connections and no one else's.
        actor: { kind: "user", id: sc.client_id },
        input: {
          message: body,
          subject: thread.subject,
          thread_id: thread.id,
          client_id: sc.client_id,
          client: { id: sc.client_id, display_name: clientRow?.display_name },
          history: history.map((m) => ({ direction: m.direction, body: m.body })),
        },
        constraints: clampConstraints({}, cfg.maxCostCeilingUsd, cfg.maxRuntimeCeilingS),
        tools: [],
        output_schema: loadWedge(channel.wedge)?.manifest.task_types?.[channel.task_type]?.output_schema,
        source: "portal",
        client_id: sc.client_id,
        assigned_to: "agent",
        status: "queued",
        cost_usd: 0,
        created_at: now,
        updated_at: now,
      };
      await store.createTask(task);
      taskId = task.id;
      await enqueueTask(store, task.id);
    }
    return taskId;
  }

  /**
   * A client watching their own run.
   *
   * The founder-plane stream at `/v1/tasks/:id/events` is unreachable with a client session, which
   * is correct — but it left a customer-facing product with no way to show work happening. This is
   * the same stream, scoped: the task must belong to this client, in this project.
   *
   * Note what it does NOT forward. `tool.called` args can carry a customer's own data back to them
   * harmlessly, but a run's internals — costs, model names, raw errors — are the operator's
   * business, not the customer's. See `PORTAL_EVENTS`.
   */
  app.get("/v1/portal/tasks/:id/events", async (c) => {
    const sc = client(c);
    const task = await store.getTask(c.req.param("id") ?? "");
    const belongs =
      task && task.project_id === sc.project_id && task.actor.kind === "user" && task.actor.id === sc.client_id;
    if (!belongs) return c.json({ error: "not found" }, 404);
    return streamTaskEvents(c, task.id, PORTAL_EVENTS);
  });



  app.get("/v1/portal/cases", async (c) => {
    const sc = client(c);
    // Scope in the QUERY, not after it. A portal session holds exactly one project, and the old
    // post-filter (`!x.project_id || …`) admitted any Case that happened to carry no project_id.
    const cases = await domain.listCases({ project_id: sc.project_id, client_id: sc.client_id });
    // Only what a customer should see: where their engagement is up to, not the agent's internals.
    return c.json(
      cases
        .map((x) => ({
          id: x.id,
          title: x.title,
          stage: x.stage,
          status: x.status,
          due_at: x.due_at,
          updated_at: x.updated_at,
        })),
    );
  });

  app.post("/v1/auth/signup", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as { email?: string; password?: string; org_name?: string };
    const email = (b.email ?? "").trim().toLowerCase();
    const password = b.password ?? "";
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return c.json({ error: "a valid email is required" }, 400);
    if (password.length < 10) return c.json({ error: "password must be at least 10 characters" }, 400);
    const out = getIdentityStore().signup({ email, password, orgName: b.org_name });
    // Deliberately explicit: someone signing up with an email that exists needs to be told, unlike
    // the reset flow where the same honesty would be an enumeration oracle for a stranger.
    if (!out) return c.json({ error: "that email already has an account — sign in instead" }, 409);
    return c.json({ token: out.session.token, member: out.member, projects: out.projects }, 201);
  });

  /**
   * Which provider this email used last, so the sign-in screen can point at the right button.
   *
   * Answers identically for unknown emails — `{ provider: null }` — because a true/false answer here
   * would let anyone check whether a given person has an account.
   */
  app.post("/v1/auth/hint", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as { email?: string };
    const provider = getIdentityStore().lastProviderFor((b.email ?? "").trim().toLowerCase());
    return c.json({ provider: provider ?? null });
  });

  app.post("/v1/auth/reset/request", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as { email?: string };
    const out = getIdentityStore().requestReset((b.email ?? "").trim().toLowerCase());
    // ALWAYS ok:true. Saying "no such account" would turn this into a way to enumerate customers,
    // and the product sends the mail only when a token comes back.
    return c.json({ ok: true, ...(out ? { token: out.token, email: out.email } : {}) });
  });

  app.post("/v1/auth/reset/confirm", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as { token?: string; password?: string };
    if ((b.password ?? "").length < 10) return c.json({ error: "password must be at least 10 characters" }, 400);
    const out = getIdentityStore().confirmReset(b.token ?? "", b.password ?? "");
    if (!out) return c.json({ error: "that reset link is invalid or has expired" }, 400);
    return c.json({ token: out.session.token, member: out.member, projects: out.projects });
  });

  app.post("/v1/auth/login", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as { email?: string; password?: string };
    if (!b.email || !b.password) return c.json({ error: "email and password required" }, 400);
    const r = getIdentityStore().login(b.email, b.password);
    if (!r) return c.json({ error: "invalid credentials" }, 401);
    return c.json({ token: r.session.token, member: r.member, projects: r.projects, expires_at: r.session.expires_at });
  });

  // Everything under /v1 EXCEPT /v1/internal/* and the login endpoint requires a credential.
  app.use("/v1/*", async (c, next) => {
    // Public by necessity — these are how someone without a session gets one. `/v1/auth/federated`
    // is deliberately absent: it asserts a verified identity, so it must stay behind the product key.
    const PUBLIC_AUTH = new Set([
      "/v1/auth/login",
      "/v1/auth/signup",
      "/v1/auth/hint",
      "/v1/auth/reset/request",
      "/v1/auth/reset/confirm",
    ]);
    // `/v1/invites/<token>` is public for the same reason: the person holding the link has no
    // account yet, and the token IS the credential. Prefix rather than exact match because the
    // token is in the path.
    // `/v1/host/*` carries its own credential (`MYCEL_HOST_TOKEN`) and checks it in the handler,
    // because the customer-facing app that calls it must not hold an operator key. It still
    // accepts a product key, so this middleware runs and sets a scope when one is presented.
    //
    // `/v1/composio/webhook` is public because Composio has no Mycel session and never will. Its
    // credential is the HMAC signature over the raw body, checked in the handler against the
    // project's webhook secret — and the handler refuses everything when that secret is unset,
    // rather than degrading into an unauthenticated "start a run" endpoint. Exact match, not a
    // prefix: nothing else under /v1/composio/ may inherit this.
    //
    // `/v1/insight/events` is public here for the same reason and with the same shape: it carries
    // its own credential, a per-project INGEST key, checked in the handler — deliberately not the
    // founder's product key, which a near-public write path must never see. The project it writes
    // to comes out of that key's signature. Exact match, never a prefix: `/v1/insight/summary` and
    // `/v1/insight/key` are reads and stay behind the founder credential like everything else.
    if (
      c.req.path.startsWith("/v1/internal/") ||
      c.req.path.startsWith("/v1/invites/") ||
      c.req.path === "/v1/composio/webhook" ||
      c.req.path === "/v1/insight/events" ||
      (c.req.path.startsWith("/v1/host/") && !!process.env.MYCEL_HOST_TOKEN) ||
      PUBLIC_AUTH.has(c.req.path)
    )
      return next();
    return requireApiKey(c, next);
  });

  /**
   * Federated sign-in. The PRODUCT asserts an email a provider already verified.
   *
   * Note where this sits: below the auth middleware, so it needs the product API key. That is the
   * entire security boundary — if a browser could call it, anyone could claim any email. The kernel
   * doesn't run OAuth itself because redirect URIs and provider secrets belong to the product, and
   * Auth.js already handles the provider zoo far better than we would.
   *
   * Registered AFTER the auth middleware, deliberately. Hono applies middleware in registration
   * order, so a route declared above `app.use("/v1/*")` never gets a scope — which is exactly what
   * happened first time, and made this look permanently broken rather than permanently open. The
   * public auth routes sit above it precisely because they need no scope.
   */
  app.post("/v1/auth/federated", async (c) => {
    if (c.get("scope")?.kind !== "key") {
      return c.json({ error: "federated sign-in requires the product API key" }, 403);
    }
    const b = (await c.req.json().catch(() => ({}))) as { email?: string; provider?: string; org_name?: string };
    const email = (b.email ?? "").trim().toLowerCase();
    const provider = b.provider === "google" || b.provider === "github" ? b.provider : undefined;
    if (!email || !provider) return c.json({ error: "email and a supported provider are required" }, 400);
    const out = getIdentityStore().federated({ email, provider, orgName: b.org_name });
    return c.json(
      { token: out.session.token, member: out.member, projects: out.projects, created: out.created },
      out.created ? 201 : 200,
    );
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
    const maxProjects = identity.limitsFor(scope.org_id).projects;
    if (maxProjects !== null && identity.listProjects(scope.org_id).length >= maxProjects) {
      return c.json(
        { error: `your plan includes ${maxProjects} project${maxProjects === 1 ? "" : "s"}`, code: "project_limit" },
        402,
      );
    }
    const { project, apiKey } = identity.createProject(scope.org_id, b.name, Array.isArray(b.wedges) ? b.wedges : []);
    return c.json({ project, api_key: apiKey }, 201);
  });

  // -----------------------------------------------------------------------------------------------
  // Team
  //
  // A second pair of hands is the point at which a founder stops being the only approver, so these
  // routes are about one thing: who may approve, and who may let someone else approve.
  //
  // Every write here is member-only and role-gated. A product API key must NOT be able to add a
  // member — a key is a machine credential that lives in an environment variable, and one leaking
  // should not be a route to a human login.
  // -----------------------------------------------------------------------------------------------

  // -----------------------------------------------------------------------------------------------
  // Where a business answers
  //
  // The business app is ONE deployment serving every founder's clients, resolved by hostname. See
  // the comment on `projectForHost` for why that is safe: the app holds no data, and the kernel
  // decides what a client sees from their session rather than from the host.
  // -----------------------------------------------------------------------------------------------

  const ROOT_DOMAIN = process.env.MYCEL_ROOT_DOMAIN ?? "mycelai.dev";

  /**
   * Which business serves this hostname. Called by the business app on every request, so it takes a
   * product key rather than a member session and returns only what a portal needs to render.
   *
   * Notably absent: the project id. The app never needs it — a client session already carries the
   * project, and handing the id to an unauthenticated-ish surface invites someone to try using it.
   */
  app.get("/v1/host/:host", async (c) => {
    /**
     * A credential of its own, not the product key.
     *
     * The business app is customer-facing, and giving it an operator credential would mean a
     * compromise there — a dependency, an SSRF — hands over a key that can read and create tasks.
     * `MYCEL_HOST_TOKEN` can do exactly one thing: turn a hostname into a display name and a
     * colour. A product key is also accepted so a self-hosted single-tenant setup needs no extra
     * configuration.
     */
    const hostToken = process.env.MYCEL_HOST_TOKEN;
    const presented = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
    const viaHostToken = !!hostToken && safeEqual(presented, hostToken);
    // `scope` is undefined when the middleware waved this through on the host-token path, so
    // the optional chain is load-bearing rather than defensive.
    if (!viaHostToken && c.get("scope")?.kind !== "key") {
      return c.json({ error: "host lookup requires the host token or a product key" }, 403);
    }
    const p = identity.projectForHost(c.req.param("host") ?? "", ROOT_DOMAIN);
    if (!p) return c.json({ error: "no business answers on that host" }, 404);
    return c.json({
      slug: p.slug,
      branding: {
        display_name: p.branding?.display_name ?? p.name,
        accent: p.branding?.accent ?? "#16a34a",
        support_email: p.branding?.support_email,
      },
    });
  });

  // `GET /v1/projects/:id/tracing` used to report which Langfuse project a business's traces went
  // to. There is no external trace store any more: a run's trace is read back from our own event log
  // at `GET /v1/tasks/:id/trace`, per task, under the same scope check as the task itself.

  /** Where this business's portal lives, and the state of any custom domain. Members only. */
  app.get("/v1/projects/:id/domain", async (c) => {
    const scope = c.get("scope");
    const p = identity.getProject(c.req.param("id") ?? "");
    if (!p || !inScope(accessible(c), p.id)) return c.json({ error: "not found" }, 404);
    void scope;
    return c.json({
      slug: p.slug,
      portal_url: p.slug ? `https://${p.slug}.${ROOT_DOMAIN}` : null,
      custom_domain: p.custom_domain,
      verified: !!p.custom_domain_verified_at,
      // The record they must publish. Returned while unverified so the UI can show it again after
      // a reload — a founder who closes the tab shouldn't have to start the claim over.
      verify_record: p.domain_verify_token
        ? { type: "TXT", name: `_mycel.${p.custom_domain}`, value: p.domain_verify_token }
        : null,
    });
  });

  app.post("/v1/projects/:id/domain", async (c) => {
    const scope = c.get("scope");
    if (!canManageMembers(scope.role)) return c.json({ error: "only an owner or admin can set a domain" }, 403);
    const p = identity.getProject(c.req.param("id") ?? "");
    if (!p || !inScope(accessible(c), p.id)) return c.json({ error: "not found" }, 404);
    const b = (await c.req.json().catch(() => ({}))) as { domain?: string };
    const out = identity.claimDomain(p.id, b.domain ?? "");
    if ("error" in out) return c.json(out, 400);
    await audit({
      project_id: p.id,
      actor: scope.member_id ?? "member",
      action: "domain.claimed",
      entity: "project",
      entity_id: p.id,
      detail: { domain: b.domain },
    });
    return c.json({ verify_record: { type: "TXT", ...out.record } }, 201);
  });

  /**
   * Check the claim against DNS.
   *
   * Deliberately a real lookup rather than the founder ticking a box: serving a portal on a domain
   * someone else owns is how a phishing page ends up with our certificate on it. Until this passes,
   * `projectForHost` refuses the domain even if DNS already points at us.
   */
  app.post("/v1/projects/:id/domain/verify", async (c) => {
    const scope = c.get("scope");
    if (!canManageMembers(scope.role)) return c.json({ error: "only an owner or admin can verify a domain" }, 403);
    const p = identity.getProject(c.req.param("id") ?? "");
    if (!p || !inScope(accessible(c), p.id)) return c.json({ error: "not found" }, 404);
    if (!p.custom_domain || !p.domain_verify_token) return c.json({ error: "no domain is awaiting verification" }, 400);

    let records: string[][] = [];
    try {
      const dns = await import("node:dns/promises");
      records = await dns.resolveTxt(`_mycel.${p.custom_domain}`);
    } catch {
      // NXDOMAIN and "not propagated yet" are the same thing to a founder who just added a record,
      // and telling them apart isn't worth the confusion.
      return c.json({ verified: false, reason: "no TXT record found at that name yet" }, 409);
    }
    const flat = records.map((r) => r.join(""));
    if (!flat.includes(p.domain_verify_token)) {
      return c.json({ verified: false, reason: "the TXT record is there but doesn't match", found: flat }, 409);
    }
    identity.markDomainVerified(p.id);
    await audit({
      project_id: p.id,
      actor: scope.member_id ?? "member",
      action: "domain.verified",
      entity: "project",
      entity_id: p.id,
      detail: { domain: p.custom_domain },
    });
    return c.json({ verified: true, portal_url: `https://${p.custom_domain}` });
  });

  app.put("/v1/projects/:id/branding", async (c) => {
    const scope = c.get("scope");
    if (!canManageMembers(scope.role)) return c.json({ error: "only an owner or admin can change branding" }, 403);
    const p = identity.getProject(c.req.param("id") ?? "");
    if (!p || !inScope(accessible(c), p.id)) return c.json({ error: "not found" }, 404);
    const b = (await c.req.json().catch(() => ({}))) as {
      display_name?: string;
      accent?: string;
      support_email?: string;
    };
    // A colour goes into a style attribute on a page served to a founder's customers. Anything that
    // isn't a hex triple is a CSS injection waiting to happen.
    if (b.accent && !/^#[0-9a-fA-F]{6}$/.test(b.accent)) {
      return c.json({ error: "accent must be a hex colour like #16a34a" }, 400);
    }
    const updated = identity.setBranding(p.id, {
      display_name: b.display_name?.slice(0, 80),
      accent: b.accent,
      support_email: b.support_email?.slice(0, 200),
    });
    return c.json({ branding: updated?.branding ?? {} });
  });

  // -----------------------------------------------------------------------------------------------
  // Plan & usage
  //
  // The kernel knows what a plan allows. It does not know what it costs or who took the money —
  // that is the commercial control plane's business, and it talks to `PUT /v1/org/plan` with a
  // product key. Anyone running this themselves stays on `self_hosted`, whose limits are all null.
  // -----------------------------------------------------------------------------------------------

  const monthStart = () => {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  };

  /** Model spend this calendar month. The limit that actually protects margin — see Limits. */
  const spendThisMonth = (set: Set<string>) => store.sumCostSince([...set], monthStart());

  /** Tasks created this calendar month, for the metered limit. */
  const tasksThisMonth = async (set: Set<string>) => {
    const from = new Date();
    const since = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1);
    return store.countTasksSince([...set], new Date(since).toISOString());
  };

  app.get("/v1/org", async (c) => {
    const scope = c.get("scope");
    const org = identity.getOrg(scope.org_id);
    if (!org) return c.json({ error: "not found" }, 404);
    const limits = identity.limitsFor(scope.org_id);
    const projects = identity.listProjects(scope.org_id);
    return c.json({
      org: {
        id: org.id,
        name: org.name,
        created_at: org.created_at,
        plan: org.plan ?? "self_hosted",
        plan_status: org.plan_status ?? "active",
        plan_renews_at: org.plan_renews_at,
        // The provider's customer id is echoed only to a member — a product key that leaked should
        // not also hand over the billing account it can be used against.
        billing_ref: scope.kind === "member" ? org.billing_ref : undefined,
      },
      limits,
      usage: {
        seats: identity.seatsUsed(scope.org_id),
        projects: projects.length,
        tasks_this_month: await tasksThisMonth(identity.accessibleProjectIds(scope)),
        model_spend_usd: await spendThisMonth(identity.accessibleProjectIds(scope)),
      },
    });
  });

  /**
   * Set the plan.
   *
   * This is the one write in the kernel that a member cannot make, and the asymmetry is the point:
   * a session belongs to someone who benefits from a bigger number here.
   *
   * Setting SOMEONE ELSE'S plan is a second, larger privilege, and it needs its own credential.
   * A hosted control plane holds one product key and serves every tenant, so without this a
   * key that leaked from any product could rewrite every customer's entitlements. `MYCEL_CONTROL_TOKEN`
   * is unset by default, which means cross-org writes are simply unavailable to a self-hosted
   * install — the failure is closed, and nobody has to notice a setting to be safe.
   */
  app.put("/v1/org/plan", async (c) => {
    const scope = c.get("scope");
    if (scope.kind !== "key") return c.json({ error: "the plan is set by the control plane" }, 403);
    const targetOrg = ((await c.req.raw.clone().json().catch(() => ({}))) as { org_id?: string }).org_id;
    if (targetOrg && targetOrg !== scope.org_id) {
      const control = process.env.MYCEL_CONTROL_TOKEN ?? "";
      const presented = c.req.header("x-mycel-control") ?? "";
      if (!control || !safeEqual(presented, control)) {
        return c.json({ error: "setting another org's plan requires the control token" }, 403);
      }
      if (!identity.getOrg(targetOrg)) return c.json({ error: "not found" }, 404);
    }
    const b = (await c.req.json().catch(() => ({}))) as {
      plan?: string;
      status?: string;
      billing_ref?: string;
      renews_at?: string;
    };
    const plan = b.plan as Plan | undefined;
    if (plan && !(plan in PLAN_LIMITS)) return c.json({ error: `unknown plan: ${b.plan}` }, 400);
    const status = b.status as PlanStatus | undefined;
    if (status && !["active", "trialing", "past_due", "cancelled"].includes(status)) {
      return c.json({ error: `unknown status: ${b.status}` }, 400);
    }
    const orgId = targetOrg ?? scope.org_id;
    const org = identity.setPlan(orgId, {
      plan,
      status,
      billing_ref: b.billing_ref,
      renews_at: b.renews_at,
    });
    return org ? c.json({ org, limits: identity.limitsFor(orgId) }) : c.json({ error: "not found" }, 404);
  });

  /** Guard for the team-management routes. Returns an error response, or null when allowed. */
  const requireManager = (c: Parameters<typeof accessible>[0]) => {
    const scope = c.get("scope");
    if (scope.kind !== "member") return c.json({ error: "team management requires a member session" }, 403);
    if (!canManageMembers(scope.role)) return c.json({ error: "only an owner or admin can change the team" }, 403);
    return null;
  };

  app.get("/v1/team", async (c) => {
    const scope = c.get("scope");
    return c.json({
      members: identity.listMembers(scope.org_id),
      // Pending invitations are only the manager's business — an operator seeing them can't act on
      // them, and each row names an email address that hasn't agreed to anything yet.
      invites: canManageMembers(scope.role) ? identity.listInvites(scope.org_id) : [],
      can_manage: scope.kind === "member" && canManageMembers(scope.role),
    });
  });

  /**
   * Invite someone.
   *
   * Returns the raw token ONCE. The kernel does not send email — the product does, because that's
   * where the mail provider and the branded template live. Anything the product doesn't send is
   * unrecoverable, which is the correct failure mode for a credential.
   */
  app.post("/v1/team/invites", async (c) => {
    const denied = requireManager(c);
    if (denied) return denied;
    const scope = c.get("scope");
    const b = (await c.req.json().catch(() => ({}))) as { email?: string; role?: string };
    const email = (b.email ?? "").trim().toLowerCase();
    if (!email.includes("@")) return c.json({ error: "a valid email is required" }, 400);
    // Explicit rather than coerced. Silently downgrading an unrecognised role would hand someone an
    // operator when they asked for an admin, and report success.
    const role = (b.role ?? "operator") as Role;
    if (!["admin", "operator", "viewer"].includes(role)) {
      return c.json({ error: "role must be admin, operator or viewer — an org has one owner" }, 400);
    }
    // Counted before sending, including outstanding invitations — otherwise the limit lands on
    // twenty confused recipients at accept time instead of once, here, on the person who set it up.
    const seats = identity.limitsFor(scope.org_id).seats;
    if (seats !== null && identity.seatsUsed(scope.org_id) >= seats) {
      return c.json(
        { error: `your plan includes ${seats} seat${seats === 1 ? "" : "s"}`, code: "seat_limit" },
        402,
      );
    }
    const out = identity.invite({ orgId: scope.org_id, email, role, invitedBy: scope.member_id! });
    if ("error" in out) {
      return c.json(
        {
          error:
            out.error === "taken"
              ? "that email already has a Mycel account"
              : "that email has a pending invitation to another team",
        },
        409,
      );
    }
    return c.json({ invite: out.invite, token: out.token }, 201);
  });

  app.delete("/v1/team/invites/:id", async (c) => {
    const denied = requireManager(c);
    if (denied) return denied;
    const ok = identity.revokeInvite(c.get("scope").org_id, c.req.param("id"));
    return ok ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
  });

  app.patch("/v1/team/members/:id", async (c) => {
    const denied = requireManager(c);
    if (denied) return denied;
    const b = (await c.req.json().catch(() => ({}))) as { role?: string };
    if (!["admin", "operator", "viewer"].includes(b.role ?? "")) {
      return c.json({ error: "role must be admin, operator or viewer" }, 400);
    }
    const out = identity.setMemberRole(c.get("scope").org_id, c.req.param("id"), b.role as Role);
    return "error" in out ? c.json(out, 400) : c.json(out);
  });

  app.delete("/v1/team/members/:id", async (c) => {
    const denied = requireManager(c);
    if (denied) return denied;
    const scope = c.get("scope");
    // Removing yourself would log you out mid-request and, if you were the last admin, strand the
    // org. Leaving is a different feature and it doesn't exist yet.
    if (c.req.param("id") === scope.member_id) return c.json({ error: "you cannot remove yourself" }, 400);
    const out = identity.removeMember(scope.org_id, c.req.param("id"));
    return "error" in out ? c.json(out, 400) : c.json(out);
  });

  // What the invite link shows before anyone commits. Public — the token is the credential.
  app.get("/v1/invites/:token", async (c) => {
    const peek = identity.peekInvite(c.req.param("token"));
    // One message for expired, revoked and never-existed. Distinguishing them tells someone holding
    // a guessed token that they guessed close.
    return peek ? c.json(peek) : c.json({ error: "this invitation is no longer valid" }, 404);
  });

  app.post("/v1/invites/:token/accept", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as { password?: string };
    const pw = b.password ?? "";
    if (pw.length < 8) return c.json({ error: "a password of at least 8 characters is required" }, 400);
    const out = identity.acceptInvite(c.req.param("token"), pw);
    if (!out) return c.json({ error: "this invitation is no longer valid" }, 404);
    return c.json(
      { token: out.session.token, member: out.member, projects: out.projects, expires_at: out.session.expires_at },
      201,
    );
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

    /**
     * The metered limit.
     *
     * Checked here rather than at execution because a queued task that dies on a quota is worse
     * than one that was never accepted: the customer's email has already arrived, and the founder
     * finds out from a status page.
     *
     * `past_due` is deliberately NOT blocked — see PlanStatus. A bookkeeping service that stops
     * answering its customers because a card expired does more damage to the founder than the
     * unpaid invoice does to us.
     */
    const scope = c.get("scope");
    const limits = identity.limitsFor(scope.org_id);
    const monthly = limits.tasks_per_month;
    if (monthly !== null) {
      const used = await tasksThisMonth(identity.accessibleProjectIds(scope));
      if (used >= monthly) {
        return c.json(
          { error: `your plan includes ${monthly} jobs a month, and ${used} have run`, code: "task_limit" },
          402,
        );
      }
    }

    /**
     * The spend ceiling.
     *
     * Job count alone does not protect margin: the model tiers differ by 35× in price, so a plan
     * can be well inside its job allowance and deeply unprofitable. This is the limit that
     * corresponds to money rather than to volume.
     *
     * Deliberately checked BEFORE the run, like the job limit, and deliberately generous — it is a
     * runaway guard, not a throttle anyone should meet in normal use.
     */
    if (limits.model_spend_usd_per_month !== null) {
      const spent = await spendThisMonth(identity.accessibleProjectIds(scope));
      if (spent >= limits.model_spend_usd_per_month) {
        return c.json(
          {
            error: `this month's model spend has reached your plan's $${limits.model_spend_usd_per_month} ceiling`,
            code: "spend_limit",
            spent_usd: Number(spent.toFixed(2)),
          },
          402,
        );
      }
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

    // A client_id on a task decides whose context that task's artifacts show up in, so it is
    // checked against the caller's own project before it is stored. See `clientInProject`.
    if (body.client_id !== undefined && !(await clientInProject(body.client_id, projectId))) {
      return c.json({ error: "unknown client_id for this project" }, 400);
    }

    const cfg = loadConfig();
    const constraints = clampConstraints(body.constraints, cfg.maxCostCeilingUsd, cfg.maxRuntimeCeilingS, loadWedge(body.wedge), body.task_type);
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
      // Posted directly, so the surface is the API unless the caller names a truer one.
      source: body.source ?? "api",
      client_id: body.client_id,
      case_id: body.case_id,
      assigned_to: body.assigned_to ?? "agent",
      confidence_score: body.confidence_score,
      status: "queued",
      cost_usd: 0,
      created_at: now,
      updated_at: now,
    };
    await store.createTask(task);
    if (idem) idempotency.set(idem, task.id);
    // Enqueued, not executed here. With Postgres configured a worker claims it, so replicas share
    // load instead of following the load balancer; without one it runs inline exactly as before.
    await enqueueTask(store, task.id);
    return c.json(task, 201);
  });

  // GET /v1/tasks — list for the operator portal (newest first; ?status= ?wedge= ?client_id= ?limit=)
  app.get("/v1/tasks", async (c) => {
    const status = c.req.query("status") as TaskStatus | undefined;
    const wedge = c.req.query("wedge");
    const clientId = c.req.query("client_id") || undefined;
    const limit = c.req.query("limit") ? Number(c.req.query("limit")) : undefined;
    const set = accessible(c);
    const tasks = await store.listTasks({ status, wedge, client_id: clientId, limit: (limit ?? 100) * 4 });
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

  /**
   * Analytics — what the business actually did, aggregated.
   *
   * No new capture layer and no third-party pixel: every number here already exists as task rows
   * and events, because the kernel has been recording them since the first run. Bolting on an
   * analytics SDK would mean a second source of truth that disagrees with the audit log by Tuesday.
   *
   * All of it is derived per request. That's fine at this size and honest about it — when it stops
   * being fine, the fix is a rollup table, not a tracking script.
   */
  app.get("/v1/analytics", async (c) => {
    const set = accessible(c);
    const days = Math.min(Math.max(Number(c.req.query("days") ?? 30), 1), 365);
    const since = Date.now() - days * 86400_000;

    const tasks = (await store.listTasks({ limit: 5000 })).filter(
      (t) => inScope(set, t.project_id) && Date.parse(t.created_at) >= since,
    );
    const terminal = tasks.filter((t) => TERMINAL.has(t.status));
    const succeeded = tasks.filter((t) => t.status === "succeeded");
    // Blocked on a human and busy on a machine are opposite problems, and lumping them into
    // "in flight" hid the one this product is supposed to be measuring.
    const blocked = tasks.filter((t) => t.status === "awaiting_approval");

    // Bucket by day so a caller can draw a line without re-deriving it. Keyed by ISO date, which
    // sorts lexicographically — no date parsing on the other end.
    // Every day in the window, including the empty ones. Emitting only the days that had work makes
    // a quiet fortnight render as a dense chart, which reads as "we were busy" — the opposite of
    // the truth. The kernel knows the window; the caller shouldn't have to reconstruct it.
    type DayRow = { tasks: number; cost_usd: number; failed: number };
    const byDay = new Map<string, DayRow>();
    for (let i = days - 1; i >= 0; i--) {
      byDay.set(new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10), { tasks: 0, cost_usd: 0, failed: 0 });
    }
    for (const t of tasks) {
      const day = t.created_at.slice(0, 10);
      const row = byDay.get(day) ?? { tasks: 0, cost_usd: 0, failed: 0 };
      row.tasks += 1;
      row.cost_usd += t.cost_usd || 0;
      if (["failed", "rejected", "expired", "cancelled"].includes(t.status)) row.failed += 1;
      byDay.set(day, row);
    }

    const byWedge = new Map<string, { tasks: number; cost_usd: number }>();
    for (const t of tasks) {
      const row = byWedge.get(t.wedge) ?? { tasks: 0, cost_usd: 0 };
      row.tasks += 1;
      row.cost_usd += t.cost_usd || 0;
      byWedge.set(t.wedge, row);
    }

    // How long a human takes to approve. The number that decides whether "human in the loop" is a
    // feature or the bottleneck, and nothing else in the product surfaces it.
    // `Array.filter` ignores a promise and keeps every element, so an async predicate here would
    // have silently counted other tenants' approvals. Resolve first, then filter.
    const all = await store.listApprovals();
    const owned = await Promise.all(
      all.map(async (a) => {
        const t = await store.getTask(a.task_id);
        return t && inScope(set, t.project_id) ? a : null;
      }),
    );
    // Windowed like everything else. It wasn't, so the approvals block silently described all time
    // while sitting under a header that said "last 30 days".
    const approvals = owned
      .filter((a): a is NonNullable<typeof a> => a !== null)
      .filter((a) => Date.parse(a.created_at) >= since);
    const decided = approvals.filter((a) => a.decided_at && a.created_at);
    const waits = decided
      .map((a) => Date.parse(a.decided_at!) - Date.parse(a.created_at))
      .filter((n) => Number.isFinite(n) && n >= 0)
      .sort((x, y) => x - y);
    const median = waits.length ? waits[Math.floor(waits.length / 2)] : null;

    const clients = (await domain.listClients()).filter((x) => inScope(set, x.project_id));

    /**
     * The same window, one window earlier.
     *
     * A success rate with no direction is a number, not a signal — 82% is good news or a crisis
     * depending on last month. Computed from the rows already in hand rather than a second query.
     */
    const prevSince = since - days * 86400_000;
    const prior = (await store.listTasks({ limit: 5000 })).filter(
      (t) => inScope(set, t.project_id) && Date.parse(t.created_at) >= prevSince && Date.parse(t.created_at) < since,
    );
    const priorTerminal = prior.filter((t) => TERMINAL.has(t.status));
    const priorSucceeded = prior.filter((t) => t.status === "succeeded");

    return c.json({
      window_days: days,
      previous: {
        tasks: prior.length,
        success_rate: priorTerminal.length
          ? Math.round((priorSucceeded.length / priorTerminal.length) * 100)
          : null,
        cost_usd: Number(prior.reduce((n, t) => n + (t.cost_usd || 0), 0).toFixed(4)),
      },
      tasks: {
        total: tasks.length,
        succeeded: succeeded.length,
        // Of FINISHED work only. Counting in-flight tasks as failures would make the number sag
        // every time the business is busy, which is exactly backwards.
        success_rate: terminal.length ? Math.round((succeeded.length / terminal.length) * 100) : null,
        in_flight: tasks.length - terminal.length - blocked.length,
        awaiting_approval: blocked.length,
        // "The agent broke", "you said no" and "you never answered" are three different businesses.
        // Expiry in particular is the strongest signal that the human is the bottleneck.
        failed: tasks.filter((t) => t.status === "failed").length,
        rejected: tasks.filter((t) => t.status === "rejected").length,
        expired: tasks.filter((t) => t.status === "expired").length,
        cancelled: tasks.filter((t) => t.status === "cancelled").length,
      },
      cost_usd: Number(tasks.reduce((n, t) => n + (t.cost_usd || 0), 0).toFixed(4)),
      approvals: {
        total: approvals.length,
        auto_approved: approvals.filter((a) => a.status === "auto_approved").length,
        pending: approvals.filter((a) => a.status === "pending").length,
        expired: approvals.filter((a) => a.status === "expired").length,
        median_wait_seconds: median === null ? null : Math.round(median / 1000),
      },
      clients: { total: clients.length },
      by_day: [...byDay.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([day, v]) => ({ day, ...v, cost_usd: Number(v.cost_usd.toFixed(4)) })),
      by_wedge: [...byWedge.entries()]
        .sort((a, b) => b[1].tasks - a[1].tasks)
        .map(([wedge, v]) => ({ wedge, ...v, cost_usd: Number(v.cost_usd.toFixed(4)) })),
    });
  });

  // GET /v1/meta — what a product needs to render itself: version, wedges, observability state.
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
      // No `langfuse_url` / `tracing` state any more. Tracing was an optional external sink that
      // could be configured-but-broken, so a UI had to ask whether it was working before linking to
      // it. It isn't optional now: every run's trace is folded from the event log the kernel always
      // writes, at `GET /v1/tasks/:id/trace`, so a client can just ask for it.
      store: databaseUrl() ? "postgres" : "memory",
      sandbox: cfg.sandboxBackend,
    });
  });

  // GET /v1/tasks/:id
  app.get("/v1/tasks/:id", async (c) => {
    const t = await store.getTask(c.req.param("id"));
    if (!t || !inScope(accessible(c), t.project_id)) return c.json({ error: "not found" }, 404);
    return c.json(t);
  });

  /**
   * Patch assignment / confidence / client linkage mid-run — an agent step reporting how sure it
   * was, or an operator routing a task to a human.
   *
   * Narrow on purpose. `status` has its own transitions, cost is accrued not set, and `input` is
   * immutable once a run is reading it. Only fields whose value can legitimately change while the
   * work is in flight are here, and `client_id` is validated against the caller's own project
   * before it is written.
   */
  app.patch("/v1/tasks/:id", async (c) => {
    const t = await store.getTask(c.req.param("id"));
    if (!t || !inScope(accessible(c), t.project_id)) return c.json({ error: "not found" }, 404);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const patch: Parameters<Store["updateTask"]>[1] = {};

    if (b.assigned_to !== undefined) {
      if (b.assigned_to !== "agent" && b.assigned_to !== "human") {
        return c.json({ error: 'assigned_to must be "agent" or "human"' }, 400);
      }
      patch.assigned_to = b.assigned_to;
    }
    if ("confidence_score" in b) {
      if (b.confidence_score === null) patch.confidence_score = null;
      else if (typeof b.confidence_score === "number" && b.confidence_score >= 0 && b.confidence_score <= 1) {
        patch.confidence_score = b.confidence_score;
      } else {
        return c.json({ error: "confidence_score must be null or a number in [0,1]" }, 400);
      }
    }
    if ("client_id" in b) {
      if (b.client_id === null) {
        patch.client_id = undefined;
      } else if (typeof b.client_id === "string" && (await clientInProject(b.client_id, t.project_id!))) {
        patch.client_id = b.client_id;
      } else {
        return c.json({ error: "unknown client_id for this project" }, 400);
      }
    }

    const updated = await store.updateTask(t.id, patch);
    return c.json(updated);
  });

  // GET /v1/tasks/:id/trace — the run as a span tree, folded from the durable event log.
  //
  // Same tenancy check as every other task read: the trace is strictly a projection of events the
  // operator can already stream, so it must be exactly as reachable and no more. Operator plane
  // only — it carries costs and tool arguments, which is the half of a run the portal deliberately
  // hides from clients (see PORTAL_EVENTS below).
  app.get("/v1/tasks/:id/trace", async (c) => {
    const taskId = c.req.param("id") ?? "";
    const t = await store.getTask(taskId);
    if (!t || !inScope(accessible(c), t.project_id)) return c.json({ error: "not found" }, 404);
    // `0` is "from the beginning" — a trace is the whole run by definition; there is no replay
    // cursor to honour here.
    const trace = buildTrace(await store.eventsAfter(taskId, 0));
    return c.json({ ...trace, task_id: taskId, status: t.status, wedge: t.wedge, task_type: t.task_type });
  });

  /**
   * What a CUSTOMER may see of a run.
   *
   * An allowlist, not a denylist: a new event type is invisible to clients until someone decides it
   * should be, which is the right default when the alternative is leaking whatever gets added next.
   * Excluded on purpose — `cost.charged` (your margins are not their business), `token.delta` (raw
   * model output before validation), and the approval events (an internal control, and seeing
   * "waiting for a human" invites "why is a human involved?").
   */
  const PORTAL_EVENTS: ReadonlySet<EventType> = new Set<EventType>([
    "task.created",
    "step.started",
    "tool.called",
    "tool.result",
    "progress",
    "output.validated",
    "artifact.created",
    "task.finished",
  ]);

  /**
   * The task event stream, shared by both credential planes.
   *
   * Extracted so the client-facing stream can't drift from the operator one — replay semantics,
   * queue bounds and terminal handling are subtle enough that a second copy would eventually be a
   * second set of bugs. The caller has already decided the request is allowed; `allow` decides what
   * this particular audience gets to see.
   */
  const streamTaskEvents = (c: import("hono").Context, taskId: string, allow?: ReadonlySet<EventType>) => {
    const raw = c.req.header("Last-Event-ID") ?? c.req.query("lastEventId") ?? "0";
    const parsed = Number(raw);
    const lastId = Number.isFinite(parsed) ? parsed : 0; // malformed header must not skip replay
    const visible = (ev: TaskEvent) => !allow || allow.has(ev.type);

    /**
     * What a customer may see INSIDE an allowed event.
     *
     * The type allowlist was only half the boundary. Every allowed event's whole `data` object was
     * forwarded verbatim, and `progress.note` is free text authored by the runtime and the agent —
     * a customer watching a run saw "mock runtime — no sandbox, canned result". Anything the agent
     * decides to narrate about its own internals reaches the client the same way.
     *
     * So the portal plane gets a field allowlist per type, not just a type allowlist. Fails closed:
     * an event type whose fields nobody has thought about yet is forwarded with no data at all,
     * which shows the customer "Working…" rather than whatever gets added next.
     *
     * The operator plane passes through untouched — the founder is entitled to everything.
     */
    const PORTAL_FIELDS: Partial<Record<EventType, readonly string[]>> = {
      "task.created": [],
      "step.started": [],
      // Deliberately no `note`: it is operator-flavoured prose with no contract.
      progress: [],
      // The name and type of a file produced FOR this customer — they are about to download it.
      "artifact.created": ["artifact_id", "name", "content_type", "size_bytes"],
      // Which capability ran, never its arguments or what came back.
      "tool.called": ["tool"],
      "tool.result": ["tool", "ok"],
      "output.validated": ["ok"],
      "task.finished": ["status"],
    };

    const redact = (ev: TaskEvent): TaskEvent => {
      if (!allow) return ev;
      const keep = PORTAL_FIELDS[ev.type] ?? [];
      const src = (ev.data ?? {}) as Record<string, unknown>;
      const data: Record<string, unknown> = {};
      for (const k of keep) if (k in src) data[k] = src[k];
      return { ...ev, data };
    };

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

      // The cross-instance half.
      //
      // The in-process bus only carries events emitted by THIS process. With more than one replica,
      // a browser attached here can be watching a run executing over there — so also poll the
      // durable log, which is the actual source of truth. Events carry monotonic ids and the drain
      // below already skips anything at or below `lastSent`, so a duplicate from both paths costs a
      // comparison and nothing else.
      //
      // This is what makes horizontal scaling a `desired_count` change rather than a Redis
      // dependency. The interval is the worst-case added latency, and 400ms is imperceptible next to
      // a model call.
      const poll = setInterval(async () => {
        try {
          for (const ev of await store.eventsAfter(taskId, lastSent)) {
            if (queue.length >= MAX_QUEUE) {
              overflow = true;
              break;
            }
            queue.push(ev);
          }
        } catch {
          /* a transient read failure must not kill a live stream */
        }
        const w = wake;
        wake = null;
        w?.();
      }, 400);
      (poll as unknown as { unref?: () => void }).unref?.();
      stream.onAbort(() => {
        const w = wake;
        wake = null;
        w?.();
      });

      try {
        // Replay persisted events first (we subscribed above, so nothing is lost in between).
        let finishedInReplay = false;
        for (const ev of (await store.eventsAfter(taskId, lastId)).filter(visible)) {
          await stream.writeSSE({ id: String(ev.id), event: ev.type, data: JSON.stringify(redact(ev)) });
          lastSent = ev.id;
          if (ev.type === "task.finished") finishedInReplay = true;
        }
        if (finishedInReplay) return;

        // Already terminal (client reconnected after the end): flush anything remaining, then close.
        const t = await store.getTask(taskId);
        if (t && TERMINAL.has(t.status)) {
          for (const ev of (await store.eventsAfter(taskId, lastSent)).filter(visible)) {
            await stream.writeSSE({ id: String(ev.id), event: ev.type, data: JSON.stringify(redact(ev)) });
            lastSent = ev.id;
          }
          // Say the run is over before hanging up.
          //
          // Not every terminal task has a `task.finished` in its log — one cancelled before its
          // execution loop started never emits one. Closing silently is indistinguishable from a
          // dropped connection, so `EventSource` reconnects, gets the same silent close, and
          // retries forever against a run that will never say anything again. This frame is the
          // difference between a client that settles and one that spins.
          await stream.writeSSE({ event: "closed", data: JSON.stringify({ status: t.status }) });
          return;
        }

        // Then live, deduped against replayed ids.
        let done = false;
        while (!done && !stream.aborted) {
          if (queue.length === 0 && !overflow) await new Promise<void>((r) => (wake = r));
          if (overflow) {
            // Deliberately carries NO `id:`. The browser keeps the last id it actually received
            // data for, so its automatic reconnect resumes from the last real event rather than
            // skipping the burst that caused the overflow. That is load-bearing — stamping an id
            // here would silently drop everything the client missed.
            //
            // Sent as `overflow` rather than `error`: EventSource delivers transport failures on
            // the "error" handler too, so a shared name forces every client to tell them apart by
            // whether the frame happens to have `.data`. Everyone gets that wrong once.
            const frame = JSON.stringify({ error: "stream overflow — reconnect with Last-Event-ID" });
            await stream.writeSSE({ event: "overflow", data: frame });
            // Also under the old name, for one release, so a client written against it keeps
            // working while it moves over.
            await stream.writeSSE({ event: "error", data: frame });
            return;
          }
          while (queue.length) {
            const ev = queue.shift();
            if (!ev || ev.id <= lastSent) continue;
            lastSent = ev.id;
            // Filtered here as well as in replay, or a customer would see a filtered history and
            // then an unfiltered live tail — the leak arriving only for whoever kept the tab open.
            if (!visible(ev)) continue;
            await stream.writeSSE({ id: String(ev.id), event: ev.type, data: JSON.stringify(redact(ev)) });
            if (ev.type === "task.finished") done = true;
          }
        }
      } finally {
        clearInterval(poll);
        unsub(); // always release the bus listener — no leak on client disconnect / error
      }
    });
  };

  // GET /v1/tasks/:id/events — SSE with Last-Event-ID replay
  app.get("/v1/tasks/:id/events", async (c) => {
    const taskId = c.req.param("id") ?? "";
    const guard = await store.getTask(taskId);
    if (!guard || !inScope(accessible(c), guard.project_id)) return c.json({ error: "not found" }, 404);
    return streamTaskEvents(c, taskId);
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

      /**
       * The correction is the point.
       *
       * "Every human correction sharpens the wedge" is the thesis this product is sold on, and it
       * was not true: an edit was applied to the one action in flight, recorded in the audit chain
       * as `edited: true`, and then discarded. The same mistake would arrive again next week and be
       * corrected again by hand — which is a treadmill, not a moat.
       *
       * Written as grounding knowledge, in the same shape `POST /v1/tasks/:id/feedback` uses, so
       * the runtime picks it up on the next run with no redeploy. Deliberately records BOTH the
       * agent's version and the human's: "here is what good looks like" teaches far less than
       * "here is what it wrote and here is what I sent instead".
       */
      let correctionId: string | undefined;
      if (decision === "approved" && body.edited && Object.keys(body.edited).length) {
        try {
          const item = await domain.createKnowledge({
            project_id: at.project_id,
            wedge: at.wedge,
            name: `correction-${new Date().toISOString().slice(0, 19)}.md`,
            content: [
              `# A "${a.action}" the founder rewrote before it went out`,
              "## What the agent proposed",
              "```json",
              JSON.stringify(a.preview, null, 2),
              "```",
              "## What was actually sent",
              "```json",
              JSON.stringify(body.edited, null, 2),
              "```",
              "Match the second, not the first.",
            ].join("\n\n"),
            kind: "correction",
            source: "feedback",
            metadata: { task_id: a.task_id, approval_id: id, action: a.action },
          });
          correctionId = item.id;
          await emitEvent(store, a.task_id, "feedback.recorded", {
            rating: "bad",
            has_correction: true,
            knowledge_id: correctionId,
            from: "approval_edit",
          });
        } catch (e) {
          // Never fail the approval because we couldn't file the lesson. The action is already
          // in flight and the human has decided; losing the note is the lesser outcome.
          console.error("[mycel] could not record approval correction:", e);
        }
      }
      return c.json({ ok: true, decision, correction_id: correctionId });
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
    const grant = await getGrant(nonce);
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
    return serveArtifact(await withContent(a));
  });

  /** What a run produced or was given, metadata only. The list is cheap; the bytes are not. */
  app.get("/v1/tasks/:id/artifacts", async (c) => {
    const t = await store.getTask(c.req.param("id"));
    if (!t || !inScope(accessible(c), t.project_id)) return c.json({ error: "not found" }, 404);
    return c.json(await store.listArtifacts(t.id));
  });

  /**
   * Hand a file to a run.
   *
   * The founder forwarding a bank statement, a signed contract, the spreadsheet a client emailed
   * them. Multipart, because that is what a browser file input produces and asking a product to
   * base64 a 20MB PDF into JSON doubles the memory for no reason.
   */
  app.post("/v1/tasks/:id/artifacts", async (c) => {
    const t = await store.getTask(c.req.param("id"));
    if (!t || !inScope(accessible(c), t.project_id)) return c.json({ error: "not found" }, 404);
    const scope = c.get("scope");
    const art = await ingestUpload(c, t.id, { uploadedBy: scope.member_id ?? "product-key" });
    if ("error" in art) return c.json({ error: art.error }, art.status as 400);
    // Metadata only. Echoing the content back means a 25MB upload is answered with 33MB of base64
    // the caller already has.
    return c.json(stripArtifactContent(art.artifact), 201);
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
  // `has_secret` reports whether a credential EXISTS — never its value, never its length, never a
  // prefix. Without it a UI cannot tell "connected" from "still owes a credential", so it either
  // guesses (and lies) or stays silent about the one thing the founder needs to act on.
  const withSecretFlag = async (conn: Connection) => ({
    ...conn,
    // For a Composio connection there is no secret to store here at all — Composio holds the OAuth
    // grant and refreshes it. "Connected" means the account exists, so that's what the flag reports;
    // otherwise every Composio connection would read as "needs credential" forever.
    has_secret:
      conn.kind === "composio"
        ? !!composioConnConfig(conn).connected_account_id
        : !!conn.secret_ref || (await hasSecret(conn.id)),
  });
  app.get("/v1/connections", async (c) => {
    const set = accessible(c);
    const clientId = c.req.query("client_id");
    const all = (await domain.listConnections()).filter((x) => inScope(set, x.project_id));
    const rows = clientId ? all.filter((x) => x.owner.kind === "client" && x.owner.id === clientId) : all;
    return c.json(await Promise.all(rows.map(withSecretFlag)));
  });
  app.get("/v1/connections/:id", async (c) => {
    const conn = await domain.getConnection(c.req.param("id"));
    if (!conn || !inScope(accessible(c), conn.project_id)) return c.json({ error: "not found" }, 404);
    return c.json(await withSecretFlag(conn));
  });

  // ── LinkedIn: self-hosted session, opt-in ── /v1/linkedin/* lives in linkedin/routes.ts. It gets
  // the tenancy helpers rather than re-deriving them, so scoping has one definition.
  mountLinkedIn(app, {
    getConnection: (id) => domain.getConnection(id),
    accessible,
    writeProjectId,
    inScope,
  });

  // ── Outreach sequencer ── /v1/gtm/* lives in gtm/routes.ts. Propose a campaign, approve it once,
  // and a five-minute Schedule walks each prospect's Case through the sequence under pacing.
  mountGtm(app, {
    store,
    domain,
    getConnection: (id) => domain.getConnection(id),
    accessible,
    writeProjectId,
    inScope,
  });

  // ── Product analytics ── /v1/insight/* lives in insight/routes.ts. The generated product reports
  // what its customers actually did; the agent that wrote it reads the summary and improves it.
  // Ingest authenticates with a per-project key and takes the project from that key's signature, so
  // it gets no tenancy helper — there is nothing here for it to trust.
  mountInsight(app, { domain, accessible });

  // ── Composio: OAuth, brokered ──
  // The founder clicks once per toolkit; Composio owns the callback and the refresh cycle. Mycel
  // exposes no public redirect route, so there's no internet-facing OAuth surface here and no
  // half-finished grant to persist — we ask Composio for the status when we want to know.
  const composioConn = async (c: import("hono").Context) => {
    const conn = await domain.getConnection(c.req.param("id") ?? "");
    if (!conn || !inScope(accessible(c), conn.project_id)) return { error: "not found" as const, status: 404 as const };
    if (conn.kind !== "composio") return { error: "not a composio connection" as const, status: 400 as const };
    const cfg = composioConfig();
    if (!cfg) return { error: "COMPOSIO_API_KEY is not set on the harness" as const, status: 501 as const };
    return { conn, cfg };
  };

  app.post("/v1/connections/:id/composio/connect", async (c) => {
    const r = await composioConn(c);
    if ("error" in r) return c.json({ error: r.error }, r.status);
    const { conn, cfg } = r;
    const cc = composioConnConfig(conn);
    const body = (await c.req.json().catch(() => ({}))) as { auth_config_id?: string; callback_url?: string };
    // Fall back to creating a Composio-managed auth config, the same way the catalogue does.
    //
    // Without this, a connection that came from a BLUEPRINT was a dead end: blueprints declare
    // `{toolkit: "xero"}` with no auth config id (they can't — it's per-project), so the Connect
    // button on the setup flow returned 400 and the founder had no way forward. Two routes to the
    // same outcome, one of which worked.
    if (!cc.toolkit && !body.auth_config_id) {
      return c.json({ error: "connection has no config.toolkit" }, 400);
    }
    const authConfigId =
      body.auth_config_id ??
      cc.auth_config_id ??
      (await createManagedAuthConfig(cfg, { toolkit: cc.toolkit })).id;
    try {
      const out = await composioInitiate(cfg, {
        authConfigId,
        // Derived from the connection's owner, never from the request body — the whole point of the
        // per-client mapping is that nobody can ask to be someone else's Composio user.
        userId: composioUserId(conn),
        callbackUrl: body.callback_url,
      });
      await domain.updateConnection(conn.id, {
        config: { ...conn.config, auth_config_id: authConfigId, connected_account_id: out.connected_account_id },
      });
      await audit({
        project_id: conn.project_id ?? "",
        actor: (c.get("scope").member_id ?? "system") as string,
        action: "connection.linked",
        entity: "connection",
        entity_id: conn.id,
        // The connected-account id is a reference, not a credential. The token stays at Composio.
        detail: { connection: conn.name, toolkit: cc.toolkit, connected_account_id: out.connected_account_id },
      });
      return c.json(out, 201);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 502);
    }
  });

  app.get("/v1/connections/:id/composio/status", async (c) => {
    const r = await composioConn(c);
    if ("error" in r) return c.json({ error: r.error }, r.status);
    const cc = composioConnConfig(r.conn);
    if (!cc.connected_account_id) return c.json({ status: "NOT_STARTED", active: false });
    try {
      const st = await composioStatus(r.cfg, cc.connected_account_id);
      return c.json({ ...st, active: st.status === "ACTIVE" });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 502);
    }
  });


  // The app catalogue — 1000+ toolkits, browsable. This is the surface that makes Composio visible
  // as a capability rather than a config field only blueprints can reach.
  //
  // `?all=1` returns the whole catalogue in one response, which is what a store front-end needs:
  // you cannot group by category, or say how many accounting apps there are, from a 60-item page.
  // That costs three upstream requests, so it is cached — the catalogue changes on Composio's
  // release schedule, not ours, and a founder scrolling the grid must not re-fetch 1000 toolkits
  // per navigation.
  const CATALOGUE_TTL_MS = 10 * 60_000;
  let catalogue: { at: number; value: { items: ComposioToolkit[]; total?: number } } | undefined;
  const fullCatalogue = async (cfg: ReturnType<typeof composioConfig> & {}) => {
    if (catalogue && Date.now() - catalogue.at < CATALOGUE_TTL_MS) return catalogue.value;
    const value = await composioListAllToolkits(cfg, {});
    catalogue = { at: Date.now(), value };
    return value;
  };

  app.get("/v1/composio/toolkits", async (c) => {
    const cfg = composioConfig();
    if (!cfg) return c.json({ error: "COMPOSIO_API_KEY is not set on the harness" }, 501);
    const all = ["1", "true", "yes"].includes((c.req.query("all") ?? "").toLowerCase());
    try {
      const [list, conns] = await Promise.all([
        all
          ? fullCatalogue(cfg)
          : composioListToolkits(cfg, {
              search: c.req.query("search") || undefined,
              category: c.req.query("category") || undefined,
              cursor: c.req.query("cursor") || undefined,
              limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
            }),
        domain.listConnections(),
      ]);
      // Which of these the founder already has, so the catalogue can say "connected" instead of
      // inviting them to connect Xero for the third time.
      const set = accessible(c);
      const mine = new Map(
        conns
          .filter((x) => x.kind === "composio" && inScope(set, x.project_id))
          .map((x) => [composioConnConfig(x).toolkit, x]),
      );
      return c.json({
        ...list,
        items: list.items.map((t) => {
          const conn = mine.get(t.slug);
          return {
            ...t,
            connection_id: conn?.id,
            connected: conn ? !!composioConnConfig(conn).connected_account_id : false,
          };
        }),
      });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 502);
    }
  });

  app.get("/v1/composio/categories", async (c) => {
    const cfg = composioConfig();
    if (!cfg) return c.json({ error: "COMPOSIO_API_KEY is not set on the harness" }, 501);
    try {
      return c.json(await composioCategories(cfg));
    } catch (e) {
      return c.json({ error: (e as Error).message }, 502);
    }
  });

  /**
   * Connect an app in one call: auth config → connection → authorise URL.
   *
   * The founder picks an app and clicks. Everything that would otherwise be setup — registering an
   * OAuth client with the provider, creating an auth config, creating a connection — happens here,
   * using Composio-MANAGED auth so there is no client id or secret for them to obtain.
   *
   * Idempotent on (project, toolkit, owner): calling twice reuses the connection and re-initiates
   * authorisation rather than accumulating duplicates, because "click Connect again" is what people
   * do when a tab gets closed mid-flow.
   */
  app.post("/v1/composio/toolkits/:toolkit/connect", async (c) => {
    const cfg = composioConfig();
    if (!cfg) return c.json({ error: "COMPOSIO_API_KEY is not set on the harness" }, 501);
    const projectId = writeProjectId(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    const toolkit = (c.req.param("toolkit") ?? "").toLowerCase();
    if (!/^[a-z0-9_-]{1,64}$/.test(toolkit)) return c.json({ error: "invalid toolkit" }, 400);

    const b = (await c.req.json().catch(() => ({}))) as {
      client_id?: string;
      name?: string;
      read_tools?: string[];
    };
    const owner: ConnectionOwner = b.client_id
      ? { kind: "client", id: b.client_id }
      : { kind: "founder", id: "founder" };

    try {
      const existing = (await domain.listConnections()).find(
        (x) =>
          x.project_id === projectId &&
          x.kind === "composio" &&
          composioConnConfig(x).toolkit === toolkit &&
          x.owner.kind === owner.kind &&
          x.owner.id === owner.id,
      );
      const cc = existing ? composioConnConfig(existing) : undefined;
      // Reuse the auth config — one per toolkit per project is the point; creating a fresh one per
      // click would litter their Composio account.
      const authConfigId =
        cc?.auth_config_id ?? (await createManagedAuthConfig(cfg, { toolkit })).id;

      const conn =
        existing ??
        (await domain.createConnection({
          project_id: projectId,
          kind: "composio",
          name: b.name ?? toolkit,
          owner,
          config: { toolkit, auth_config_id: authConfigId, read_tools: b.read_tools ?? [] },
        }));

      const out = await composioInitiate(cfg, {
        authConfigId,
        userId: composioUserId(conn),
      });
      await domain.updateConnection(conn.id, {
        config: {
          ...conn.config,
          toolkit,
          auth_config_id: authConfigId,
          connected_account_id: out.connected_account_id,
          ...(b.read_tools ? { read_tools: b.read_tools } : {}),
        },
      });
      await audit({
        project_id: projectId,
        actor: (c.get("scope").member_id ?? "system") as string,
        action: "connection.linked",
        entity: "connection",
        entity_id: conn.id,
        detail: { connection: conn.name, toolkit, connected_account_id: out.connected_account_id },
      });
      return c.json({ ...out, connection_id: conn.id, toolkit }, 201);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 502);
    }
  });

  // What can this toolkit do? For a founder authoring a wedge — the agent never calls this.
  app.get("/v1/composio/tools", async (c) => {
    const cfg = composioConfig();
    if (!cfg) return c.json({ error: "COMPOSIO_API_KEY is not set on the harness" }, 501);
    try {
      const tools = await composioListTools(cfg, {
        toolkit: c.req.query("toolkit") || undefined,
        search: c.req.query("search") || undefined,
        limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
      });
      return c.json(tools);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 502);
    }
  });

  // ── Triggers: the doorbell ──
  // See triggers.ts for why routing is read from the stored subscription and never from a payload.

  /**
   * Subscribe this connection to an event. Idempotent on (connection, trigger_slug) at both ends:
   * the store upserts, and Composio's own endpoint is an upsert — so a founder clicking twice ends
   * with one subscription and one run per event, not two.
   */
  app.post("/v1/connections/:id/triggers", async (c) => {
    const r = await composioConn(c);
    if ("error" in r) return c.json({ error: r.error }, r.status);
    const { conn, cfg } = r;
    const cc = composioConnConfig(conn);
    const b = (await c.req.json().catch(() => ({}))) as {
      trigger_slug?: string;
      wedge?: string;
      task_type?: string;
      config?: Record<string, unknown>;
    };
    const slug = (b.trigger_slug ?? "").trim().toUpperCase();
    if (!slug || !b.wedge || !b.task_type) {
      return c.json({ error: "trigger_slug, wedge and task_type are required" }, 400);
    }
    if (!/^[A-Z0-9_]{1,128}$/.test(slug)) return c.json({ error: "invalid trigger_slug" }, 400);

    // Validate the destination up front, exactly like POST /v1/tasks. A subscription that can only
    // ever produce a 404 at 3am is worse than a 400 now.
    const wedge = loadWedge(b.wedge);
    if (!wedge) return c.json({ error: `unknown wedge: ${b.wedge}` }, 400);
    const types = wedge.manifest.task_types;
    if (types && Object.keys(types).length && !types[b.task_type]) {
      return c.json({ error: `unknown task_type "${b.task_type}" for wedge "${b.wedge}"` }, 400);
    }
    if (!identity.projectAllowsWedge(conn.project_id ?? "", b.wedge)) {
      return c.json({ error: `wedge "${b.wedge}" is not enabled for this project` }, 403);
    }
    if (!cc.connected_account_id) {
      return c.json({ error: "connect this account before subscribing to its events" }, 400);
    }
    if (!composioWebhookSecret()) {
      // Refuse to register a trigger we would then be unable to accept. Otherwise the founder gets
      // a working subscription on Composio's side and a webhook route that rejects every delivery.
      return c.json({ error: "COMPOSIO_WEBHOOK_SECRET is not set on the harness" }, 501);
    }

    try {
      const out = await composioUpsertTrigger(cfg, {
        slug,
        // Derived from the connection's owner, never the body — same rule as every other call.
        userId: composioUserId(conn),
        connectedAccountId: cc.connected_account_id,
        triggerConfig: b.config ?? {},
      });
      const sub = await domain.createTriggerSub({
        project_id: conn.project_id,
        connection_id: conn.id,
        trigger_slug: slug,
        trigger_id: out.trigger_id,
        owner: conn.owner,
        wedge: b.wedge,
        task_type: b.task_type,
        config: b.config ?? {},
        enabled: true,
      });
      await audit({
        project_id: conn.project_id ?? "",
        actor: (c.get("scope").member_id ?? "system") as string,
        action: "trigger.subscribed",
        entity: "trigger",
        entity_id: sub.id,
        detail: { connection: conn.name, toolkit: cc.toolkit, trigger_slug: slug, wedge: b.wedge, task_type: b.task_type },
      });
      return c.json(sub, 201);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 502);
    }
  });

  app.get("/v1/triggers", async (c) => {
    const set = accessible(c);
    const connId = c.req.query("connection_id");
    const rows = (await domain.listTriggerSubs()).filter((s) => inScope(set, s.project_id));
    return c.json(connId ? rows.filter((s) => s.connection_id === connId) : rows);
  });

  const ownedSub = async (c: import("hono").Context) => {
    const sub = await domain.getTriggerSub(c.req.param("id") ?? "");
    if (!sub || !inScope(accessible(c), sub.project_id)) return undefined;
    return sub;
  };

  /** Pause or resume without losing the subscription — the trigger equivalent of disabling a schedule. */
  app.patch("/v1/triggers/:id", async (c) => {
    const sub = await ownedSub(c);
    if (!sub) return c.json({ error: "not found" }, 404);
    const b = (await c.req.json().catch(() => ({}))) as { enabled?: boolean };
    if (typeof b.enabled !== "boolean") return c.json({ error: "enabled is required" }, 400);
    const cfg = composioConfig();
    // Stop delivery at the source when we can, but the stored `enabled` flag is the one that
    // actually decides: the webhook route checks it, so a trigger paused here is paused even if
    // Composio keeps sending.
    if (cfg && sub.trigger_id) {
      try {
        await composioSetTriggerEnabled(cfg, sub.trigger_id, b.enabled);
      } catch {
        /* the local flag still holds; a stale instance at Composio delivers into a closed door */
      }
    }
    return c.json(await domain.updateTriggerSub(sub.id, { enabled: b.enabled }));
  });

  app.delete("/v1/triggers/:id", async (c) => {
    const sub = await ownedSub(c);
    if (!sub) return c.json({ error: "not found" }, 404);
    const cfg = composioConfig();
    if (cfg && sub.trigger_id) {
      try {
        await composioDeleteTrigger(cfg, sub.trigger_id);
      } catch {
        /* deleted locally regardless — an orphan at Composio delivers to a subscription that's gone */
      }
    }
    await domain.deleteTriggerSub(sub.id);
    await audit({
      project_id: sub.project_id ?? "",
      actor: (c.get("scope").member_id ?? "system") as string,
      action: "trigger.unsubscribed",
      entity: "trigger",
      entity_id: sub.id,
      detail: { trigger_slug: sub.trigger_slug, wedge: sub.wedge },
    });
    return c.json({ ok: true });
  });

  /** Tell Composio where to deliver. One URL per project, on their side — see composio.ts. */
  app.post("/v1/composio/webhook/subscribe", async (c) => {
    const cfg = composioConfig();
    if (!cfg) return c.json({ error: "COMPOSIO_API_KEY is not set on the harness" }, 501);
    const b = (await c.req.json().catch(() => ({}))) as { webhook_url?: string };
    const url = b.webhook_url ?? process.env.MYCEL_PUBLIC_URL;
    if (!url) return c.json({ error: "webhook_url is required (or set MYCEL_PUBLIC_URL)" }, 400);
    try {
      const target = url.endsWith("/v1/composio/webhook") ? url : `${url.replace(/\/$/, "")}/v1/composio/webhook`;
      return c.json(await composioSetWebhookSubscription(cfg, target));
    } catch (e) {
      return c.json({ error: (e as Error).message }, 502);
    }
  });

  /**
   * The inbound webhook. PUBLIC — allowlisted in the auth middleware above.
   *
   * There is no session here and there cannot be one, so the signature IS the authentication.
   * Everything before the verification must therefore be free of side effects, and everything that
   * fails verification must leave nothing behind: no task, no subscription touched, no log line
   * carrying the body.
   *
   * On the logging point specifically: these payloads are the contents of customers' inboxes and
   * invoices. Nothing here prints the body, the headers, or the parsed event data — a failure is
   * reported by its reason code alone, which is enough to debug a misconfigured secret and not
   * enough to leak an email.
   *
   * A refusal answers 401 and a routing miss answers 200. That asymmetry is deliberate: a 4xx/5xx
   * makes Composio retry, so anything we will never accept (an event for a subscription that was
   * deleted, a disabled trigger) must be acknowledged or it is redelivered forever.
   */
  app.post("/v1/composio/webhook", async (c) => {
    const secret = composioWebhookSecret();
    // Fail closed. Without a secret this route would be an unauthenticated way to make the kernel
    // spend money, so an unconfigured harness accepts nothing at all.
    if (!secret) return c.json({ error: "webhooks are not configured" }, 501);

    // Raw text, not c.req.json(): the signature covers the exact bytes, and re-serialising a parsed
    // object cannot be trusted to reproduce them (key order, unicode escapes, whitespace).
    const raw = await c.req.text();
    const verdict = verifyComposioWebhook({
      secret,
      webhookId: c.req.header(WEBHOOK_HEADERS.id) ?? "",
      timestamp: c.req.header(WEBHOOK_HEADERS.timestamp) ?? "",
      signature: c.req.header(WEBHOOK_HEADERS.signature) ?? "",
      rawBody: raw,
      toleranceS: Number(process.env.COMPOSIO_WEBHOOK_TOLERANCE_S ?? 300),
    });
    if (!verdict.ok) return c.json({ error: "invalid signature", reason: verdict.reason }, 401);

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    const event = parseTriggerEvent(parsed);
    // Lifecycle events (a connection expired, say) come down the same pipe and must not start runs.
    if (!event) return c.json({ ok: true, ignored: "not a trigger event" });

    /**
     * Find whose subscription this is. `trigger_id` is what Composio returned when WE registered
     * the trigger, so it is the only identifier in the delivery that we minted and therefore the
     * only one that may decide routing on its own.
     *
     * The fallback exists because a legacy V2 envelope can arrive without it. It resolves the
     * connected account to a connection first, so the pair (connection, slug) still comes out of
     * our own records — a payload naming a slug alone can never select a subscription.
     */
    let sub = event.trigger_id
      ? await domain.findTriggerSub({ trigger_id: event.trigger_id })
      : undefined;
    if (!sub && event.connected_account_id) {
      const conn = (await domain.listConnections()).find(
        (x) => x.kind === "composio" && composioConnConfig(x).connected_account_id === event.connected_account_id,
      );
      if (conn) {
        sub = await domain.findTriggerSub({
          connection_id: conn.id,
          trigger_slug: event.trigger_slug,
        });
      }
    }
    if (!sub) return c.json({ ok: true, ignored: "no subscription" });

    const connection = await domain.getConnection(sub.connection_id);
    const out = await startRunFromTrigger({ store, domain, event, sub, connection });
    if (!out.ok) {
      // 402 is the one refusal worth surfacing as a failure: the founder is over their plan, and a
      // Composio retry a few minutes later may well succeed.
      if (out.status === 402) return c.json({ error: out.reason }, 402);
      return c.json({ ok: true, ignored: out.reason });
    }
    return c.json({ ok: true, task_id: out.task_id, duplicate: out.duplicate ?? false }, out.duplicate ? 200 : 202);
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
      preferences: (b.preferences as Record<string, unknown>) ?? undefined,
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

  app.get("/v1/threads/:id", async (c) => {
    const thread = await domain.getThread(c.req.param("id"));
    if (!thread || !inScope(accessible(c), thread.project_id)) return c.json({ error: "not found" }, 404);
    return c.json({ ...thread, messages: await domain.listMessages(thread.id) });
  });

  // ── Blueprints: provision a whole business, not a task ──
  // This is what Cloud's "describe it and it goes live" resolves to. Provisioning is idempotent and
  // creates schedules DISABLED, so a business with no credentials yet can't start failing on a timer.
  app.get("/v1/blueprints", async (c) =>
    c.json(
      listBlueprints().map((b) => ({
        blueprint: b.blueprint,
        title: b.title,
        summary: b.summary,
        wedge: b.wedge,
        sells_as: b.sells_as,
        requires_connections: (b.requires_connections ?? []).map((r) => ({ name: r.name, kind: r.kind, why: r.why })),
        schedules: (b.schedules ?? []).map((s) => ({ name: s.name, task_type: s.task_type, cadence: s.cadence })),
        installed: !!loadWedge(b.wedge),
      })),
    ),
  );

  app.get("/v1/blueprints/:slug", async (c) => {
    const b = loadBlueprint(c.req.param("slug"));
    if (!b) return c.json({ error: "unknown blueprint" }, 404);
    return c.json(b);
  });

  // Apply a blueprint to a project → connections, disabled schedules, seed knowledge + a checklist
  // of what the founder must still supply.
  app.post("/v1/blueprints/:slug/provision", async (c) => {
    const projectId = writeProjectId(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    const b = loadBlueprint(c.req.param("slug"));
    if (!b) return c.json({ error: "unknown blueprint" }, 404);
    if (!loadWedge(b.wedge)) return c.json({ error: `blueprint needs wedge "${b.wedge}", which isn't installed` }, 400);
    if (!identity.projectAllowsWedge(projectId, b.wedge)) {
      return c.json({ error: `wedge "${b.wedge}" is not enabled for this project` }, 403);
    }
    const result = await provision(domain, b, projectId);
    await audit({
      project_id: projectId,
      actor: (c.get("scope").member_id ?? "system") as string,
      action: "project.created",
      entity: "blueprint",
      entity_id: b.blueprint,
      detail: { created: result.created, reused: result.reused, ready: result.ready },
    });
    return c.json(result, 201);
  });

  /** Readiness — what's still missing before this business can run. */
  app.get("/v1/blueprints/:slug/readiness", async (c) => {
    const scope = c.get("scope");
    const projectId = c.req.query("project_id") ?? scope.project_id ?? [...accessible(c)][0];
    if (!projectId || !accessible(c).has(projectId)) return c.json({ error: "not found" }, 404);
    const b = loadBlueprint(c.req.param("slug"));
    if (!b) return c.json({ error: "unknown blueprint" }, 404);
    const checklist = await buildChecklist(domain, b, projectId);
    return c.json({ blueprint: b.blueprint, project_id: projectId, checklist, ready: checklist.every((i) => i.done) });
  });

  // Go live: enable the blueprint's schedules — but only once the checklist is actually satisfied.
  app.post("/v1/blueprints/:slug/activate", async (c) => {
    const projectId = writeProjectId(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    const b = loadBlueprint(c.req.param("slug"));
    if (!b) return c.json({ error: "unknown blueprint" }, 404);
    const checklist = await buildChecklist(domain, b, projectId);
    const missing = checklist.filter((i) => !i.done);
    if (missing.length) {
      // Refuse rather than "activate" a business that would fail on its first tick.
      return c.json({ error: "not ready", missing }, 409);
    }
    const names = new Set((b.schedules ?? []).map((s) => s.name));
    const mine = (await domain.listSchedules()).filter((s) => s.project_id === projectId && names.has(s.name));
    for (const s of mine) await domain.updateSchedule(s.id, { enabled: true });

    /**
     * Run one now.
     *
     * `next_run_at` was computed at provision time as the next strictly-future occurrence, so a
     * founder who finished setting up at 10:00 on a wedge that runs daily at 06:00 saw "your
     * business is running" and then nothing at all for twenty hours. They had just been asked for
     * credentials and taught the thing their trade; the product's answer was a promise about
     * tomorrow.
     *
     * One immediate run, so the next screen has something real on it. The rest of the schedule is
     * untouched — this doesn't shift the cadence, it just doesn't make them wait to see it work.
     */
    let firstTask: string | undefined;
    const lead = mine[0];
    if (lead) {
      firstTask = (await fireSchedule(store, domain, lead)).id;
    }
    return c.json({ ok: true, activated: mine.map((s) => s.name), first_task_id: firstTask });
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
  /**
   * What files this run has, and their bytes.
   *
   * Without this the upload feature is decorative: a client sends a bank statement, a run starts,
   * and the agent has no way to open it. Scoped to the grant's own task, so one run cannot read
   * another's documents even inside the same project.
   *
   * Base64 in JSON rather than raw bytes, because the sandbox talks to this over the same JSON
   * client it uses for everything else, and a second transport is a second thing to get wrong.
   * `?meta=1` returns the list without content, which is what a first look wants.
   */
  app.get("/v1/internal/artifacts", async (c) => {
    const grant = await getActionGrant((c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, ""));
    if (!grant) return c.json({ ok: false, error: "invalid action token" }, 401);
    return c.json({ ok: true, artifacts: await store.listArtifacts(grant.task_id) });
  });

  app.get("/v1/internal/artifacts/:id", async (c) => {
    const grant = await getActionGrant((c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, ""));
    if (!grant) return c.json({ ok: false, error: "invalid action token" }, 401);
    const a = await store.getArtifact(c.req.param("id"));
    if (!a || a.task_id !== grant.task_id) return c.json({ ok: false, error: "not found" }, 404);
    const full = await withContent(a);
    return c.json({
      ok: true,
      id: full.id,
      name: full.name,
      content_type: full.content_type,
      encoding: full.encoding ?? "utf8",
      size_bytes: full.size_bytes,
      content: full.content,
    });
  });

  app.post("/v1/internal/records/upsert", async (c) => {
    const grant = await getActionGrant((c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, ""));
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
    const grant = await getActionGrant((c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, ""));
    if (!grant) return c.json({ ok: false, error: "invalid action token" }, 401);
    const task = await store.getTask(grant.task_id);
    if (!task) return c.json({ ok: false, error: "unknown task" }, 404);
    // An agent run belongs to exactly one project, so the tenant filter goes INTO the query. The
    // previous post-filter left `count` computed across every tenant (a cross-project row count is
    // still a disclosure), and its `!task.project_id ||` escape hatch meant an unattributed task
    // could read the whole table. A task with no project reads nothing.
    if (!task.project_id) return c.json({ ok: false, error: "task has no project scope" }, 403);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const q = {
      project_id: task.project_id,
      wedge: task.wedge,
      collection: typeof b.collection === "string" ? b.collection : undefined,
      case_id: typeof b.case_id === "string" ? b.case_id : undefined,
      where: (b.where as Record<string, unknown>) ?? undefined,
      limit: typeof b.limit === "number" ? Math.min(b.limit, 500) : undefined,
    };
    const [rows, count] = await Promise.all([domain.queryRecords(q), domain.countRecords(q)]);
    await emitEvent(store, grant.task_id, "tool.called", {
      tool: "records:query",
      args: { collection: q.collection, where: q.where },
    });
    return c.json({ ok: true, count, records: rows });
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
      // Inherited, not re-supplied: an episode of a case is for the case's client by definition,
      // which is also what makes it show up in that client's context without a join through Case.
      client_id: kase.client_id,
      source: "case",
      assigned_to: "agent",
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
    await enqueueTask(store, task.id);
    return c.json(task, 201);
  });

  // Internal: the agent reads and advances ITS OWN case. Not an outward action (no real-world side
  // effect), so it isn't gated — but it is scoped to this run's case and traced onto the timeline.
  app.get("/v1/internal/case", async (c) => {
    const grant = await getActionGrant((c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, ""));
    if (!grant) return c.json({ ok: false, error: "invalid action token" }, 401);
    if (!grant.caseId) return c.json({ ok: false, error: "this task is not part of a case" }, 404);
    const kase = await domain.getCase(grant.caseId);
    if (!kase) return c.json({ ok: false, error: "not found" }, 404);
    return c.json({ ok: true, case: { ...kase, stages: caseStages(kase.wedge) } });
  });

  app.post("/v1/internal/case/update", async (c) => {
    const grant = await getActionGrant((c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, ""));
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
    // Query per accessible project rather than reading every tenant's rows and filtering after.
    // The post-filter was correct, but reading globally to discard most of it is the pattern that
    // let the same mistake go unnoticed in the runtime, where there was no filter at all.
    const live = (await Promise.all([...set].map((pid) => domain.listKnowledge(slug, pid)))).flat();
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


  // ── Intake: what the business knows, and what it still needs to be told ──
  // The queue merges the wedge's declared questions with gaps the agent hit on real jobs. An answer
  // becomes a knowledge item the agent is grounded on — same store as everything else.
  app.get("/v1/wedges/:wedge/intake", async (c) => {
    const wedgeSlug = c.req.param("wedge") ?? "";
    const projectId = writeProjectId(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    const wedge = loadWedge(wedgeSlug);
    if (!wedge) return c.json({ error: `unknown wedge: ${wedgeSlug}` }, 404);
    const [gaps, knowledge] = await Promise.all([
      domain.listGaps(projectId, wedgeSlug),
      domain.listKnowledge(wedgeSlug, projectId),
    ]);
    return c.json(
      buildCoverage(
        wedgeSlug,
        wedge.manifest.intake ?? [],
        gaps,
        knowledge.filter((k) => k.project_id === projectId),
      ),
    );
  });

  app.post("/v1/wedges/:wedge/intake/:question", async (c) => {
    const wedgeSlug = c.req.param("wedge") ?? "";
    const questionId = c.req.param("question") ?? "";
    const projectId = writeProjectId(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    const wedge = loadWedge(wedgeSlug);
    if (!wedge) return c.json({ error: `unknown wedge: ${wedgeSlug}` }, 404);

    const b = (await c.req.json().catch(() => ({}))) as { answer?: string; ask?: string };
    const answer = typeof b.answer === "string" ? b.answer.trim() : "";
    if (!answer) return c.json({ error: "answer is required" }, 400);

    const declared = (wedge.manifest.intake ?? []).find((q) => q.id === questionId);
    const gap = isGapId(questionId)
      ? (await domain.listGaps(projectId, wedgeSlug)).find((g) => g.id === questionId)
      : undefined;
    const ask = declared?.ask ?? gap?.question ?? b.ask;
    if (!ask) return c.json({ error: "unknown question" }, 404);

    const item = await recordAnswer(domain, {
      projectId,
      wedge: wedgeSlug,
      questionId,
      ask,
      answer,
      kind: declared?.kind,
    });
    // Answering closes the gap, but recordGap reopens it if the agent hits it again — which is the
    // signal that the answer didn't actually cover the case.
    if (gap) await domain.setGapStatus(gap.id, projectId, "answered");
    return c.json({ ok: true, knowledge_id: item.id, name: item.name }, 201);
  });

  app.post("/v1/wedges/:wedge/intake/:question/dismiss", async (c) => {
    const projectId = writeProjectId(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    const g = await domain.setGapStatus(c.req.param("question") ?? "", projectId, "dismissed");
    return g ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
  });

  // Internal: the agent reporting what it did NOT know.
  //
  // This is the half of intake that's worth the most, because it's evidence-backed — the question
  // came up on a real job, not from someone imagining what might matter. Ungated and cheap on
  // purpose: an agent that has to ask permission to admit ignorance will simply guess instead, and a
  // silent guess is the failure mode this whole system exists to remove.
  app.post("/v1/internal/knowledge/gap", async (c) => {
    const nonce = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
    const grant = await getActionGrant(nonce);
    if (!grant) return c.json({ ok: false, error: "invalid action token" }, 401);
    const b = (await c.req.json().catch(() => ({}))) as { question?: string; fallback?: string };
    const question = typeof b.question === "string" ? b.question.trim() : "";
    if (!question) return c.json({ ok: false, error: "question is required" }, 400);

    const task = await store.getTask(grant.task_id);
    if (!task?.project_id) return c.json({ ok: false, error: "task has no project" }, 400);

    const gap = await domain.recordGap({
      id: gapId(question),
      project_id: task.project_id,
      wedge: task.wedge,
      question,
      fallback: typeof b.fallback === "string" ? b.fallback : undefined,
      task_id: task.id,
    });
    // On the timeline too, so the founder sees it in context rather than only in a queue.
    await emitEvent(store, grant.task_id, "progress", {
      note: `Missing knowledge: ${question}`,
      gap_id: gap.id,
      hits: gap.hits,
    });
    return c.json({ ok: true, recorded: gap.id, hits: gap.hits });
  });

  app.get("/v1/wedges/:wedge/knowledge", async (c) => {
    const set = accessible(c);
    const wedgeSlug = c.req.param("wedge");
    return c.json((await Promise.all([...set].map((pid) => domain.listKnowledge(wedgeSlug, pid)))).flat());
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

  // ── Intake: normalize → resolve client/thread → create task ──
  // Channel inbound and the form POST are the same pipeline with different adapters. The other ways
  // a task is born (schedule, case episode, POST /v1/tasks) are spawn paths, not intake, and stay
  // as they are.

  async function acceptIntake(args: {
    projectId: string;
    wedge: string;
    taskType: string;
    channelId?: string;
    normalized: NormalizedIntake;
  }): Promise<{ task_id: string; thread_id?: string; client_id: string; replayed?: boolean }> {
    // Providers retry. Without this, a Postmark redelivery of the same email is a second run, a
    // second reply to the customer, and a second charge. Keyed per project — see intakeDedupeKey.
    const dedupe = intakeDedupeKey(args.projectId, args.normalized);
    const replayOf = lookupIntakeReplay(dedupe);
    if (replayOf) {
      const existing = await store.getTask(replayOf);
      // Only replay a task that is still in THIS project: the key is project-scoped, so this can
      // only fail if the row vanished, but the check costs nothing and closes the branch properly.
      if (existing && existing.project_id === args.projectId) {
        return {
          task_id: existing.id,
          client_id: existing.client_id ?? args.normalized.client.handle,
          thread_id: typeof existing.input.thread_id === "string" ? existing.input.thread_id : undefined,
          replayed: true,
        };
      }
    }

    let client = await domain.findClientByHandle(args.normalized.client.handle);
    if (!client || client.project_id !== args.projectId) {
      client = await domain.createClient({
        project_id: args.projectId,
        display_name: args.normalized.client.name,
        handles: [args.normalized.client.handle],
        metadata: {},
      });
    }

    // A thread needs a channel to hang off. Form intake without one still creates a task — it is
    // just not a conversation, and pretending otherwise would mean inventing a channel row.
    let threadId: string | undefined;
    let history: { direction: string; body: string }[] = [];
    if (args.channelId) {
      const thread = await domain.findOrCreateThread(
        client.id,
        args.channelId,
        args.projectId,
        args.normalized.subject,
      );
      await domain.addMessage({
        thread_id: thread.id,
        direction: "inbound",
        author: client.id,
        body: args.normalized.body,
      });
      threadId = thread.id;
      history = (await domain.listMessages(thread.id)).map((m) => ({ direction: m.direction, body: m.body }));
    }

    const cfg = loadConfig();
    const now = new Date().toISOString();
    const task: Task = {
      id: randomUUID(),
      project_id: args.projectId,
      wedge: args.wedge,
      task_type: args.taskType,
      actor: { kind: "user", id: client.id },
      input: {
        message: args.normalized.body,
        subject: args.normalized.subject,
        ...(threadId ? { thread_id: threadId } : {}), // links the run's action grant to this conversation
        client: { id: client.id, display_name: client.display_name, handles: client.handles },
        ...(history.length ? { history } : {}),
        ...(args.normalized.metadata ? { intake_metadata: args.normalized.metadata } : {}),
      },
      constraints: clampConstraints({}, cfg.maxCostCeilingUsd, cfg.maxRuntimeCeilingS),
      tools: [],
      output_schema: loadWedge(args.wedge)?.manifest.task_types?.[args.taskType]?.output_schema,
      source: args.normalized.source,
      client_id: client.id,
      assigned_to: "agent",
      status: "queued",
      cost_usd: 0,
      created_at: now,
      updated_at: now,
    };
    await store.createTask(task);
    rememberIntake(dedupe, task.id);
    await enqueueTask(store, task.id);
    return { task_id: task.id, thread_id: threadId, client_id: client.id };
  }

  // Inbound webhook: a message arrives on a channel. The product proxies its provider's webhook
  // (Postmark/Twilio/…) here after verifying the provider signature — hence it sits behind the API
  // key. Missing sender or body fails closed: the old `handle ?? "anonymous"` fallback quietly
  // merged every unidentifiable inbound into one shared client and threaded strangers together.
  app.post("/v1/channels/:id/inbound", async (c) => {
    const channel = await domain.getChannel(c.req.param("id"));
    if (!channel || !inScope(accessible(c), channel.project_id)) return c.json({ error: "unknown channel" }, 404);
    if (!channel.project_id) return c.json({ error: "channel has no project scope" }, 400);

    const source = intakeSourceForChannelKind(channel.kind);
    if (!source) {
      return c.json(
        { error: `channel kind "${channel.kind}" has no intake adapter yet`, code: "intake.unknown_source" },
        400,
      );
    }

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "intake payload must be valid JSON", code: "intake.malformed" }, 400);
    }

    const normalized = normalizeIntake(source, raw);
    if (!normalized.ok) return c.json(normalized.error, 400);

    const out = await acceptIntake({
      projectId: channel.project_id,
      wedge: channel.wedge,
      taskType: channel.task_type,
      channelId: channel.id,
      normalized: normalized.value,
    });
    return c.json(out, out.replayed ? 200 : 201);
  });

  /**
   * Form intake — the same normalizer path as channel inbound, for a website contact form.
   * Body: the canonical form envelope plus either `channel_id` (inherits wedge/task_type/project
   * and opens a thread) or `wedge` + `task_type` (X-Mycel-Project required).
   */
  app.post("/v1/intake/form", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "intake payload must be valid JSON", code: "intake.malformed" }, 400);
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return c.json({ error: "intake payload must be a JSON object", code: "intake.malformed" }, 400);
    }
    const body = raw as Record<string, unknown>;

    let projectId: string | undefined;
    let wedge: string | undefined;
    let taskType: string | undefined;
    let channelId: string | undefined;

    if (typeof body.channel_id === "string") {
      const channel = await domain.getChannel(body.channel_id);
      if (!channel || !inScope(accessible(c), channel.project_id)) {
        return c.json({ error: "unknown channel" }, 404);
      }
      projectId = channel.project_id;
      wedge = channel.wedge;
      taskType = channel.task_type;
      channelId = channel.id;
    } else {
      projectId = writeProjectId(c) ?? undefined;
      if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
      if (typeof body.wedge !== "string" || typeof body.task_type !== "string") {
        return c.json({ error: "channel_id or wedge+task_type are required" }, 400);
      }
      wedge = body.wedge;
      taskType = body.task_type;
      if (!loadWedge(wedge)) return c.json({ error: `unknown wedge: ${wedge}` }, 400);
      if (!identity.projectAllowsWedge(projectId, wedge)) {
        return c.json({ error: `wedge "${wedge}" is not enabled for this project` }, 403);
      }
    }
    if (!projectId) return c.json({ error: "channel has no project scope" }, 400);

    // Strip the routing keys before normalizing so they don't land in metadata as unknown form
    // fields — they are ours, not the form's. Any other extra still passes through the adapter.
    const { channel_id: _c, wedge: _w, task_type: _t, ...formPayload } = body;
    const normalized = normalizeIntake("form", formPayload);
    if (!normalized.ok) return c.json(normalized.error, 400);

    const out = await acceptIntake({
      projectId,
      wedge: wedge!,
      taskType: taskType!,
      channelId,
      normalized: normalized.value,
    });
    return c.json(out, out.replayed ? 200 : 201);
  });

  // Internal: deterministic workflows. The agent calls a NAMED function the wedge ships, with JSON
  // args — it cannot define or edit the code. Pure computation, so no approval gate; traced like a
  // tool call so the founder sees which computation ran on what inputs.
  app.post("/v1/internal/workflows/:name", async (c) => {
    const grant = await getActionGrant((c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, ""));
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
    const grant = await getActionGrant(nonce);
    if (!grant) return c.json({ ok: false, error: "invalid action token" }, 401);
    const capability = c.req.param("capability");
    const params = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

    // Bound how much a runaway agent can hammer a third-party API on one task.
    if (readsExceeded(grant.task_id)) {
      return c.json({ ok: false, error: `read limit reached for this task (${READ_MAX_PER_TASK})` }, 429);
    }

    const allowed = grant.connectionIds;
    const picked = await resolveGrantedConnection(allowed, capability, params.connection_id);
    if (picked.refused) return c.json({ ok: false, error: "connection not granted" }, 403);
    const conn = picked.id ? await domain.getConnection(picked.id) : undefined;
    if (!conn) return c.json({ ok: false, error: "no granted connection for this read" }, 400);

    // Composio tools are mostly WRITES. Letting any of them through the ungated read path would
    // quietly dissolve the read/write asymmetry — XERO_CREATE_INVOICE is not a read just because the
    // agent called it through /reads. Only slugs the connection explicitly lists are readable.
    if (conn.kind === "composio" && !isComposioReadTool(conn, capability)) {
      return c.json(
        {
          ok: false,
          error: `"${capability}" is not a declared read for "${conn.name}" — use the action proxy so a human approves it`,
        },
        403,
      );
    }

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
    const grant = await getActionGrant(nonce);
    if (!grant) return c.json({ ok: false, error: "invalid action token" }, 401);
    const capability = c.req.param("capability");
    const payload = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

    const allowed = grant.connectionIds;
    const picked = await resolveGrantedConnection(allowed, capability, payload.connection_id);
    if (picked.refused) return c.json({ ok: false, error: "connection not granted" }, 403);
    const conn = picked.id ? await domain.getConnection(picked.id) : undefined;
    if (!conn) return c.json({ ok: false, error: "no granted connection for this action" }, 400);

    // PLATFORM GUARD — runs BEFORE the approval gate on purpose. A send Instagram will never
    // deliver, or one past WhatsApp's 24h window, is refused here rather than parked in a founder's
    // approval queue for five minutes so they can authorise something the platform then rejects.
    // Refusing costs nothing; a wasted approval costs the one resource we can't buy more of.
    const cap = capabilitiesForConnection(conn);
    let requireHuman = false;
    if (isMessagingSend(cap, capability)) {
      const outbound = {
        thread:
          typeof payload.thread === "string" ? payload.thread
          : typeof payload.thread_id === "string" ? payload.thread_id
          : grant.threadId,
        to: typeof payload.to === "string" ? payload.to : undefined,
        text: String(payload.body ?? payload.text ?? payload.message ?? ""),
        template: payload.template as { name: string; language: string } | undefined,
      };
      // The reply window is measured from the customer's last inbound, which the thread already
      // records — without it every windowed platform would look permanently closed.
      let lastInboundAt: string | undefined;
      if (cap.reply_window_h !== null && grant.threadId) {
        const msgs = await domain.listMessages(grant.threadId);
        for (const m of msgs) if (m.direction === "inbound") lastInboundAt = m.created_at;
      }
      const verdict = guardSend(cap, outbound, { last_inbound_at: lastInboundAt });
      if (!verdict.allow) {
        await emitEvent(store, grant.task_id, "tool.result", {
          tool: `${conn.kind}:${capability}`,
          ok: false,
          detail: verdict.reason,
        });
        return c.json({ ok: false, code: verdict.code, error: verdict.reason }, 200);
      }
      requireHuman = verdict.force_approval === true;
    }

    // HUMAN APPROVAL GATE — suspends the task, surfaces a preview, waits for approve/reject.
    const preview = actionPreview(conn, capability, payload);
    const { decision, edited } = await awaitApproval(store, grant.task_id, {
      action: `${conn.kind}:${capability}`,
      risk: "high",
      preview,
      // A cold initiate on a ban-risk account cannot be auto-approved by a wedge policy.
      requireHuman,
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
          // project_id, which this call omitted. Without it the row belongs to no tenant: it is
          // mounted into EVERY tenant running this wedge (listKnowledge filtered on wedge alone),
          // and it is invisible in the founder's own UI because `inScope` requires a project — so
          // it could be neither seen nor deleted, and an erasure request could not be satisfied.
          // The content is the full proposed and corrected payload: recipient, amount, message body.
          project_id: task.project_id,
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

/**
 * Clamp client-supplied constraints to server ceilings so a caller can't set max_cost_usd: 1e6.
 *
 * The DEFAULTS come from the task type's harness profile, not from a constant. A flat 300s was
 * killing real work: a production run spent 165,000 tokens and was aborted mid-think, and a
 * `build` profile — which exists to construct a whole Next.js product — could never have finished
 * inside five minutes. "Decide the next dunning step" and "build an application" do not share a
 * budget, and pretending they do means the expensive one silently never completes.
 *
 * Ceilings still win: a profile REQUESTS, the server DECIDES, exactly as `resolveTier` clamps a
 * requested model tier down by plan. A founder-authored manifest cannot buy itself more runtime
 * than the deployment allows.
 */
function clampConstraints(
  c: Partial<Constraints> | undefined,
  costCeiling: number,
  runtimeCeiling: number,
  wedge?: LoadedWedge | null,
  taskType?: string,
): Constraints {
  const d = profileConstraintDefaults(wedge ?? null, taskType ?? "", {
    maxRuntimeS: runtimeCeiling,
    maxCostUsd: costCeiling,
  });
  const max_cost_usd = Math.min(Math.max(0, c?.max_cost_usd ?? d.max_cost_usd), costCeiling);
  const max_runtime_s = Math.min(Math.max(1, c?.max_runtime_s ?? d.max_runtime_s), runtimeCeiling);
  return { max_cost_usd, max_runtime_s, approval_required: c?.approval_required ?? false };
}
