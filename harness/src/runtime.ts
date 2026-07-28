// The agent runtime: run one Mycel task by driving OpenCode inside a sandbox, mapping
// OpenCode's event stream onto Mycel contract events. Stack, not custom loop — OpenCode IS
// the agent. A proven OpenCode harness flow
//
import { randomBytes } from "node:crypto";
import { loadConfig } from "./config";
import type { EventType, Task } from "./contract";
import { buildOpencodeConfig, OpenCodeClient } from "./opencode";
import { buildGatePatterns, MYCEL_PLUGIN_CODE } from "./plugin";
import type { Sandbox } from "./sandbox";
import { loadWedge, type LoadedWedge } from "./wedge";

export interface RuntimeCtx {
  emit(type: EventType, data?: Record<string, unknown>): Promise<void> | void;
  onCost(usd: number): void;
  /** Returns a reason string if the task should abort (cancel / cost / runtime), else null. */
  shouldAbort(): string | null;
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
  const { config, providerEnv } = buildOpencodeConfig(model);

  // 1. Write opencode.json + AGENTS.md, then GROUND the agent: mount the wedge's skills +
  //    knowledge and any per-task documents into the sandbox so it can fulfill the service.
  await ctx.emit("step.started", { step: "configure_sandbox" });
  await sandbox.writeFile("~/.config/opencode/opencode.json", JSON.stringify(config, null, 2));
  await sandbox.writeFile("~/.config/opencode/mycel-plugin.ts", MYCEL_PLUGIN_CODE);
  await sandbox.writeFile("AGENTS.md", buildAgentsMd(task, wedge));

  for (const k of wedge?.knowledge ?? []) {
    await sandbox.writeFile(`knowledge/${k.name}`, k.content);
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
  if ((wedge?.knowledge.length ?? 0) || (wedge?.skills.length ?? 0) || docCount) {
    await ctx.emit("progress", {
      note: `grounded: ${wedge?.knowledge.length ?? 0} knowledge, ${wedge?.skills.length ?? 0} skills, ${docCount} documents`,
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
  })
    .map(([k, v]) => `${k}=${shellQuote(v)}`)
    .join(" ");
  await sandbox.spawn(`${envInline} opencode serve --port ${cfg.opencodePort} > /tmp/opencode.log 2>&1`);

  // 3. Reach the server (preview link in Daytona; localhost locally) and wait until ready.
  const { url, token } = await sandbox.previewUrl(cfg.opencodePort);
  const oc = new OpenCodeClient(url, { username: "opencode", password }, token);
  await oc.waitReady();

  // 4. Create a session, send the task prompt (returns fast; OpenCode runs async).
  const sessionId = await oc.createSession(`mycel-${task.id}`);
  await oc.sendPrompt(sessionId, buildPrompt(task, wedge), model);

  // 5. Stream OpenCode events -> Mycel contract events, until completion / idle.
  const abort = new AbortController();
  const abortWatch = setInterval(() => {
    if (ctx.shouldAbort()) abort.abort();
  }, 1000);
  (abortWatch as { unref?: () => void }).unref?.();

  let finalText = "";
  let done = false;
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
  } finally {
    clearInterval(abortWatch);
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

function buildAgentsMd(task: Task, wedge: LoadedWedge | null): string {
  const parts: string[] = [];
  parts.push(`# ${wedge?.manifest.title ?? `Mycel agent — ${task.wedge}`}`);
  parts.push("");
  parts.push(`You are fulfilling a "${task.task_type}" task for the "${task.wedge}" wedge.`);
  parts.push(
    `Use your tools to do the real work. Ground yourself in ./knowledge/ (domain playbooks, ` +
      `policies, examples) and ./inputs/ (documents for this specific task) before acting. ` +
      `Be concise. Write deliverables to ./output/.`,
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
