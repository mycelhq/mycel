// The agent runtime: run one Mycel task by driving OpenCode inside a sandbox, mapping
// OpenCode's event stream onto Mycel contract events. Stack, not custom loop — OpenCode IS
// the agent. A proven OpenCode harness flow
//
import { randomBytes } from "node:crypto";
import { registerActionGrant, revokeActionGrant } from "./actiongrants";
import { loadConfig } from "./config";
import type { Connection, EventType, Task } from "./contract";
import { getDomainStore } from "./domain";
import {
  buildOpencodeConfig,
  OpenCodeClient,
  openaiCompatibleBase,
  providerEnvVar,
  splitModel,
} from "./opencode";
import { buildGatePatterns, MYCEL_PLUGIN_CODE } from "./plugin";
import { registerGrant, revokeGrant } from "./proxygrants";
import type { Sandbox } from "./sandbox";
import { loadWedge, type LoadedWedge } from "./wedge";

export interface RuntimeCtx {
  emit(type: EventType, data?: Record<string, unknown>): Promise<void> | void;
  onCost(usd: number): void;
  /** Returns a reason string if the task should abort (cancel / cost / runtime), else null. */
  shouldAbort(): string | null;
}

/** Who this run is acting for, if anyone. All three sources are caller-supplied. */
export function taskClientId(task: Task): string | undefined {
  const inputClient = task.input?.client as { id?: string } | undefined;
  return (
    (typeof task.input?.client_id === "string" ? task.input.client_id : undefined) ??
    inputClient?.id ??
    (task.actor.kind === "user" ? task.actor.id : undefined)
  );
}

/** A client-owned connection belongs to exactly one client. Founder-owned ones are unrestricted. */
export function entitledTo(conn: Pick<Connection, "owner">, clientId?: string): boolean {
  return conn.owner.kind !== "client" || conn.owner.id === clientId;
}

/**
 * Which connections a run may act through. Extracted and exported because it is the per-client half
 * of the trust boundary, and inline it could not be tested at all.
 *
 * Ownership is a GATE, not a preference: naming a connection cannot override it. This used to be one
 * arm of an `||` next to "the wedge or task named it" — and since `task.input.connections` is
 * caller-supplied and unvalidated, a task for client A could name client B's connection id and be
 * handed it. One customer's mailbox or bank token, used on another customer's job. The project
 * boundary held; the per-client boundary was a default any caller could opt out of.
 *
 * Callers must pre-filter to the task's project. This function does not check tenancy.
 */
export function selectGrantableConnections(
  conns: Connection[],
  wanted: Set<string>,
  clientId?: string,
): Connection[] {
  return conns.filter((c) => {
    if (!entitledTo(c, clientId)) return false;
    // This client's own connections come automatically — the founder acts on their behalf, through
    // their mailbox and their calendar. Founder-owned ones must be named by the wedge or the task.
    return c.owner.kind === "client" || wanted.has(c.name) || wanted.has(c.id);
  });
}

export async function runOpenCodeTask(
  task: Task,
  sandbox: Sandbox,
  ctx: RuntimeCtx,
): Promise<{ text: string }> {
  const cfg = loadConfig();
  const wedge = loadWedge(task.wedge);
  const model =
    typeof task.input?.model === "string"
      ? task.input.model
      : (wedge?.manifest.model ?? cfg.model);

  let config: Record<string, unknown>;
  let providerEnv: Record<string, string>;
  let promptModel: string;
  let nonce: string | undefined;

  if (cfg.proxyMode) {
    // Route model calls through the harness proxy — the real key never enters the sandbox.
    const { providerId, modelId } = splitModel(model);
    const base = process.env.MYCEL_LLM_UPSTREAM ?? openaiCompatibleBase(providerId);
    if (!base) {
      throw new Error(
        `proxy mode: no OpenAI-compatible upstream for "${providerId}" — set MYCEL_LLM_UPSTREAM (e.g. a LiteLLM proxy)`,
      );
    }
    const realKey = process.env[providerEnvVar(providerId)] ?? "";
    nonce = registerGrant({ base_url: base, api_key: realKey, model: modelId, task_id: task.id });
    const built = buildOpencodeConfig(model, {
      proxyBaseUrl: `${cfg.publicUrl}/v1/internal/llm`,
      nonce,
      modelId,
    });
    config = built.config;
    providerEnv = built.providerEnv;
    promptModel = `mycel/${modelId}`;
  } else {
    const built = buildOpencodeConfig(model);
    config = built.config;
    providerEnv = built.providerEnv;
    promptModel = model;
  }

  // Resolve which connections this run may act through, and mint an action token. The sandbox
  // gets the token, never a connection secret; every action still passes the human approval gate.
  const domain = getDomainStore();
  // Only this task's project's connections are grantable — never another tenant's.
  const allConns = (await domain.listConnections()).filter(
    (c) => !task.project_id || c.project_id === task.project_id,
  );
  const wantedConns = new Set<string>([
    ...(wedge?.manifest.connections ?? []),
    ...(Array.isArray(task.input?.connections) ? (task.input.connections as string[]) : []),
  ]);
  const clientId = taskClientId(task);
  const connectionIds = selectGrantableConnections(allConns, wantedConns, clientId).map((c) => c.id);
  let threadId: string | undefined;
  if (typeof task.input?.thread_id === "string") {
    threadId = task.input.thread_id;
    const thread = await domain.getThread(threadId);
    if (thread) {
      const channel = (await domain.listChannels()).find((ch) => ch.id === thread.channel_id);
      const conn = channel ? allConns.find((c) => c.id === channel.connection_id) : undefined;
      // The reply channel goes through the same ownership gate. A thread id is caller-supplied too,
      // so without this check it was a second route to another client's connection.
      if (conn && entitledTo(conn, clientId) && !connectionIds.includes(conn.id)) {
        connectionIds.push(conn.id);
      }
    }
  }
  const actionNonce = registerActionGrant({ task_id: task.id, connectionIds, threadId, caseId: task.case_id });
  const grantedConns = allConns.filter((c) => connectionIds.includes(c.id));

  // 1. Write opencode.json + AGENTS.md, then GROUND the agent: mount the wedge's skills +
  //    knowledge and any per-task documents into the sandbox so it can fulfill the service.
  await ctx.emit("step.started", { step: "configure_sandbox" });
  await sandbox.writeFile("~/.config/opencode/opencode.json", JSON.stringify(config, null, 2));
  await sandbox.writeFile("~/.config/opencode/mycel-plugin.ts", MYCEL_PLUGIN_CODE);
  await sandbox.writeFile("AGENTS.md", buildAgentsMd(task, wedge, grantedConns));

  // Ground the agent in the LATEST knowledge: on-disk (authored) + live (uploaded/feedback),
  // with live items overriding same-named disk files. This is how runtime edits + corrections
  // take effect without a redeploy.
  const liveKnowledge = await domain.listKnowledge(task.wedge);
  const knowledgeByName = new Map<string, string>();
  for (const k of wedge?.knowledge ?? []) knowledgeByName.set(k.name, k.content);
  for (const k of liveKnowledge) knowledgeByName.set(k.name, k.content);
  for (const [name, content] of knowledgeByName) {
    await sandbox.writeFile(`knowledge/${name}`, content);
  }
  const documents = Array.isArray(task.input?.documents) ? (task.input.documents as unknown[]) : [];
  let docCount = 0;
  for (const d of documents) {
    const doc = d as { name?: unknown; content?: unknown };
    if (typeof doc.name === "string" && typeof doc.content === "string") {
      await sandbox.writeFile(`inputs/${doc.name}`, doc.content);
      docCount++;
    }
  }
  if (knowledgeByName.size || (wedge?.skills.length ?? 0) || docCount) {
    await ctx.emit("progress", {
      note: `grounded: ${knowledgeByName.size} knowledge (${liveKnowledge.length} live), ${wedge?.skills.length ?? 0} skills, ${docCount} documents`,
    });
  }

  // 2. Start `opencode serve` with provider creds + HTTP Basic auth.
  await ctx.emit("step.started", { step: "start_opencode" });
  const password = randomBytes(18).toString("hex");
  const envInline = Object.entries({
    ...providerEnv,
    OPENCODE_SERVER_USERNAME: "opencode",
    OPENCODE_SERVER_PASSWORD: password,
    // approval-gate wiring — the plugin calls back here to suspend on risky actions
    MYCEL_GATE_URL: `${cfg.publicUrl}/v1/internal/gate`,
    MYCEL_GATE_TOKEN: cfg.gateToken,
    MYCEL_TASK_ID: task.id,
    MYCEL_GATE_PATTERNS: buildGatePatterns(task, wedge),
    // Action proxy: wedge tools POST here with this token to send/charge/book through a connection.
    MYCEL_ACTIONS_URL: `${cfg.publicUrl}/v1/internal/actions`,
    // Reads: ungated (but scoped to the same granted connections) — see AGENTS.md.
    MYCEL_READS_URL: `${cfg.publicUrl}/v1/internal/reads`,
    MYCEL_CASE_URL: `${cfg.publicUrl}/v1/internal/case`,
    MYCEL_WORKFLOWS_URL: `${cfg.publicUrl}/v1/internal/workflows`,
    MYCEL_GAPS_URL: `${cfg.publicUrl}/v1/internal/knowledge/gap`,
    MYCEL_RECORDS_URL: `${cfg.publicUrl}/v1/internal/records`,
    MYCEL_ACTION_TOKEN: actionNonce,
  })
    .map(([k, v]) => `${k}=${shellQuote(v)}`)
    .join(" ");
  await sandbox.spawn(`${envInline} opencode serve --port ${cfg.opencodePort} > /tmp/opencode.log 2>&1`);

  // 3. Reach the server (preview link in Daytona; localhost locally) and wait until ready.
  //    Setup is abortable (cancel works during boot) and surfaces the real startup failure —
  //    the opencode log — instead of a bare "did not become ready".
  const { url, token } = await sandbox.previewUrl(cfg.opencodePort);
  const oc = new OpenCodeClient(url, { username: "opencode", password }, token);
  try {
    await oc.waitReady(60000, ctx.shouldAbort);
  } catch (e) {
    if (nonce) revokeGrant(nonce);
    revokeActionGrant(actionNonce);
    const reason = String((e as Error)?.message ?? e);
    if (reason.startsWith("aborted:")) throw e;
    const log = (await sandbox.readFile("/tmp/opencode.log").catch(() => null)) ?? "";
    throw new Error(`opencode failed to start${log ? `: ${log.trim().slice(-800)}` : " (no log)"}`);
  }

  // 4 + 5. Session + stream, under one finally that always revokes the proxy grant and clears
  // the abort watcher — even if session setup throws.
  const abort = new AbortController();
  let abortWatch: ReturnType<typeof setInterval> | undefined;
  let finalText = "";
  let done = false;
  try {
    if (ctx.shouldAbort()) throw new Error(`aborted: ${ctx.shouldAbort()}`);
    const sessionId = await oc.createSession(`mycel-${task.id}`);
    await oc.sendPrompt(sessionId, buildPrompt(task, wedge), promptModel);

    abortWatch = setInterval(() => {
      if (ctx.shouldAbort()) abort.abort();
    }, 1000);
    (abortWatch as { unref?: () => void }).unref?.();

    try {
      for await (const ev of oc.events(abort.signal)) {
        const reason = ctx.shouldAbort();
        if (reason) {
          await oc.abort(sessionId);
          throw new Error(`aborted: ${reason}`);
        }
        const sid: unknown = ev.properties?.sessionID ?? ev.properties?.part?.sessionID;
        if (typeof sid === "string" && sid !== sessionId) continue;

        switch (ev.type) {
          case "message.part.delta": {
            const d: unknown = ev.properties?.delta;
            if (typeof d === "string" && d) await ctx.emit("token.delta", { text: d });
            break;
          }
          case "message.part.updated": {
            const part = ev.properties?.part;
            const kind: unknown = part?.type;
            if (kind === "tool" || kind === "tool-invocation") {
              const name = part.toolName ?? part.tool ?? "tool";
              if (part.result !== undefined) await ctx.emit("tool.result", { tool: name, ok: !part.error });
              else await ctx.emit("tool.called", { tool: name, args: part.invocation?.input ?? part.args });
            } else if (kind === "text" && typeof part.text === "string") {
              finalText = part.text;
            } else if (kind === "reasoning") {
              await ctx.emit("progress", { note: "reasoning" });
            }
            break;
          }
          case "message.info": {
            const usage = ev.properties?.info?.usage ?? ev.properties?.usage;
            if (usage) ctx.onCost(estimateCost(model, usage));
            break;
          }
          case "message.completed":
          case "session.completed":
          case "session.idle": {
            done = true;
            break;
          }
          case "session.error": {
            throw new Error(`opencode session error: ${JSON.stringify(ev.properties)}`);
          }
        }
        if (done) {
          await oc.abort(sessionId);
          break;
        }
      }
    } catch (e) {
      // An aborted fetch surfaces as a generic AbortError — translate to the real reason so the
      // task lands on the correct terminal status.
      const reason = ctx.shouldAbort();
      if (reason) throw new Error(`aborted: ${reason}`);
      throw e;
    }

    // The stream ended without a completion signal → OpenCode died (crash, OOM, network). Do NOT
    // report success on partial/empty output.
    if (!done) {
      const reason = ctx.shouldAbort();
      if (reason) throw new Error(`aborted: ${reason}`);
      const log = (await sandbox.readFile("/tmp/opencode.log").catch(() => null)) ?? "";
      throw new Error(`opencode ended before completing${log ? `: ${log.trim().slice(-500)}` : ""}`);
    }
  } finally {
    if (abortWatch) clearInterval(abortWatch);
    if (nonce) revokeGrant(nonce);
    revokeActionGrant(actionNonce);
  }

  // 6. Prefer the streamed final text; fall back to an artifact the agent wrote.
  if (!finalText) finalText = (await sandbox.readFile("output/result.txt")) ?? "";
  return { text: finalText };
}

function buildPrompt(task: Task, wedge: LoadedWedge | null): string {
  const tt = wedge?.manifest.task_types?.[task.task_type];
  const outputSchema = tt?.output_schema ?? task.output_schema;
  return [
    tt?.description ? `Goal: ${tt.description}` : `Task type: ${task.task_type}`,
    `Input: ${JSON.stringify(task.input)}`,
    (wedge?.knowledge.length ?? 0) > 0
      ? `Your knowledge base is in ./knowledge/ — read the relevant files before acting.`
      : "",
    `Any documents uploaded for this specific task are in ./inputs/.`,
    outputSchema ? `Return a result conforming to this schema: ${JSON.stringify(outputSchema)}` : "",
    `Do the real work. When finished, state the final result plainly as your last message and also write it to ./output/result.txt.`,
  ]
    .filter(Boolean)
    .join("\n");
}

function buildAgentsMd(task: Task, wedge: LoadedWedge | null, connections: Connection[] = []): string {
  const parts: string[] = [];
  parts.push(`# ${wedge?.manifest.title ?? `Mycel agent — ${task.wedge}`}`);
  parts.push("");
  parts.push(`You are fulfilling a "${task.task_type}" task for the "${task.wedge}" wedge.`);
  parts.push(
    `Use your tools to do the real work. Ground yourself in ./knowledge/ (domain playbooks, ` +
      `policies, examples) and ./inputs/ (documents for this specific task) before acting. ` +
      `Be concise. Write deliverables to ./output/.`,
  );
  if (task.case_id) {
    parts.push("");
    parts.push(`## This is part of an ongoing engagement`);
    parts.push(
      `Read the case (stage, accumulated state) and record what you learn — state must outlive this run:\n` +
        "```bash\n" +
        `curl -s "$MYCEL_CASE_URL" -H "authorization: Bearer $MYCEL_ACTION_TOKEN"\n` +
        `curl -s "$MYCEL_CASE_URL/update" -H "authorization: Bearer $MYCEL_ACTION_TOKEN" \\\n` +
        `  -H "content-type: application/json" -d '{"stage":"<next stage>","data":{...},"note":"why"}'\n` +
        "```\n" +
        `Only stages the wedge declares are accepted. \`data\` merges, so send just what changed.`,
    );
  }
  if (connections.length) {
    parts.push("");
    parts.push(`## Taking real-world actions`);
    parts.push(
      `To send/charge/book, POST to the action proxy — never handle credentials yourself:\n` +
        "```bash\n" +
        `curl -s "$MYCEL_ACTIONS_URL/<capability>" \\\n` +
        `  -H "authorization: Bearer $MYCEL_ACTION_TOKEN" -H "content-type: application/json" \\\n` +
        `  -d '{"connection_id":"<id>","to":"...","subject":"...","body":"..."}'\n` +
        "```\n" +
        `Every action pauses for human approval before it happens.\n\n` +
        `To READ from a connection (no approval needed, but same connections only):\n` +
        "```bash\n" +
        `curl -s "$MYCEL_READS_URL/<capability>" \\\n` +
        `  -H "authorization: Bearer $MYCEL_ACTION_TOKEN" -H "content-type: application/json" \\\n` +
        `  -d '{"connection_id":"<id>","path":"v1/charges","query":{"limit":"10"}}'\n` +
        "```\n" +
        `Reads are GET-only, size-capped, and traced. Pass a relative path, never a full URL.\n\n` +
        `Available connections:`,
    );
    for (const c of connections) parts.push(`- **${c.name}** (${c.kind}) — id \`${c.id}\``);
  }
  // Taught unconditionally, not only when connections exist: the most valuable gaps are about
  // judgment (pricing, tone, when to escalate), which has nothing to do with having a connection.
  parts.push("");
  parts.push(`## When you don't know something`);
  parts.push(
    `If you need a fact about THIS business that you weren't given — a price, a policy, a\n` +
      `preference, how they'd word something — say so instead of inventing it:\n` +
      "```bash\n" +
      `curl -s "$MYCEL_GAPS_URL" \\\n` +
      `  -H "authorization: Bearer $MYCEL_ACTION_TOKEN" -H "content-type: application/json" \\\n` +
      `  -d '{"question":"What is the late-payment fee?","fallback":"assumed none"}'\n` +
      "```\n" +
      `Then carry on with your best assumption and state it in the output. The founder is shown\n` +
      `these questions and answers them once; the answer becomes knowledge you're given next time.\n` +
      `Ask about things specific to this business, not general knowledge. One call per distinct gap.`,
  );
  if (wedge?.skills.length) {
    parts.push("");
    parts.push(`## Procedures`);
    for (const s of wedge.skills) {
      parts.push("");
      parts.push(`### ${s.name}`);
      parts.push(s.content);
    }
  }
  return parts.join("\n");
}

// Rough cost estimate. Refine per model/provider; meter via the model-gateway usage.
function estimateCost(model: string, usage: Record<string, unknown>): number {
  const input = Number(usage.input_tokens ?? usage.inputTokens ?? usage.prompt_tokens ?? 0);
  const output = Number(usage.output_tokens ?? usage.outputTokens ?? usage.completion_tokens ?? 0);
  // Opus-tier default rates ($/token). Wire a real price table when it matters.
  const isOpus = model.includes("opus");
  const inRate = isOpus ? 5 / 1e6 : 3 / 1e6;
  const outRate = isOpus ? 25 / 1e6 : 15 / 1e6;
  return input * inRate + output * outRate;
}

function shellQuote(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}
