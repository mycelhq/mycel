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
import { getIdentityStore } from "./identity";
import { modelForTier, TIER_MODELS, TIER_PRICE, type ModelTier } from "./models";
import { keyForOrg } from "./litellm";
import { resolveHarnessProfile, SHAPE_DEFAULTS, type HarnessProfile } from "./harness";

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
  /**
   * The harness, engineered for THIS task type.
   *
   * One config for every task was the original sin here: "build a Next.js product for this
   * business" and "decide the next dunning step on this invoice" were handed identical tools,
   * identical permissions, an identical model tier and — the part that actually mattered —
   * identical credentials. The profile decides all of it, and everything below reads from it
   * rather than re-deriving anything.
   *
   * Profiles REQUEST; the plan and the server ceilings DECIDE. `resolveHarnessProfile` has already
   * run the tier through `resolveTier` (which clamps down, never refuses) and both budgets through
   * the ceilings, so nothing here needs to clamp again.
   */
  const plan = task.project_id
    ? getIdentityStore().getOrg(getIdentityStore().getProject(task.project_id)?.org_id ?? "")?.plan
    : undefined;
  const profile = resolveHarnessProfile({
    task,
    wedge,
    plan,
    ceilings: { maxRuntimeS: cfg.maxRuntimeCeilingS, maxCostUsd: cfg.maxCostCeilingUsd },
  });
  const tier: ModelTier = profile.tier;

  /**
   * Which model. An explicit model on the task wins (an operator debugging a specific run), then a
   * model named in the wedge manifest (which skips tiering entirely), then the profile's tier.
   */
  const model =
    typeof task.input?.model === "string"
      ? task.input.model
      : (wedge?.manifest.model ?? modelForTier(tier) ?? cfg.model);

  if (profile.tier_clamped) {
    // Said out loud rather than silently downgraded — a founder wondering why an answer is thinner
    // than last month deserves to see the reason on the run.
    void ctx.emit("progress", {
      note: `Ran on the ${tier} model: your plan does not include the ${profile.requested_tier} tier.`,
    });
  }

  /**
   * The budgets, made honest on the Task itself.
   *
   * `max_cost_usd` takes effect immediately: `shouldAbort` in orchestrator.ts reads
   * `task.constraints.max_cost_usd` on every tick, off this same object.
   *
   * `max_runtime_s` deliberately is NOT written back. `runTask` captures `deadline` from the
   * constraint BEFORE it enters the runtime, so by the time a profile exists the clock is already
   * running; storing a longer number here would record a budget the run never actually had. The
   * seam is the task-creation path, which should default the constraint from
   * `profileConstraintDefaults()` instead of from a flat 300 seconds. Until it does, a `build`
   * profile still gets killed at whatever the creator asked for — which is the bug that burned
   * 165k tokens and delivered nothing.
   */
  task.constraints.max_cost_usd = Math.min(task.constraints.max_cost_usd || profile.max_cost_usd, profile.max_cost_usd);

  await ctx.emit("progress", {
    note: `harness: ${profile.shape} profile — ${tier} tier, ${profile.max_runtime_s}s, ${profile.grants_actions ? "may act through connections" : "no connection access"}`,
  });

  let config: Record<string, unknown>;
  let providerEnv: Record<string, string>;
  let promptModel: string;
  let nonce: string | undefined;

  if (cfg.proxyMode) {
    // Route model calls through the harness proxy — the real key never enters the sandbox.
    const { providerId, modelId } = splitModel(model);

    /**
     * Where model calls actually go.
     *
     * With LiteLLM configured, the upstream is the proxy and the credential is this ORG'S virtual
     * key — which carries a hard budget and a model allowlist the proxy enforces per request. That
     * matters because the kernel's own spend ceiling is checked once, at task creation, and so
     * cannot stop the run that is currently spending. This can.
     *
     * Without it, we fall back to talking to the provider directly with the shared key, exactly as
     * before. Degrading rather than failing is deliberate: a budget broker being down should slow
     * nobody's business down with it.
     */
    const orgId = task.project_id
      ? getIdentityStore().getProject(task.project_id)?.org_id
      : undefined;
    const tenantKey = orgId ? await keyForOrg(orgId) : undefined;

    const base = tenantKey
      ? `${process.env.MYCEL_LITELLM_URL!.replace(/\/+$/, "")}/v1`
      : (process.env.MYCEL_LLM_UPSTREAM ?? openaiCompatibleBase(providerId));
    if (!base) {
      throw new Error(
        `proxy mode: no OpenAI-compatible upstream for "${providerId}" — set MYCEL_LITELLM_URL, or MYCEL_LLM_UPSTREAM`,
      );
    }
    const realKey = tenantKey ?? process.env[providerEnvVar(providerId)] ?? "";
    // The grant's `model` is what the proxy pins on the way UPSTREAM, so it must be the name the
    // upstream knows — LiteLLM registers `openai/gpt-5.6-luna`, provider prefix and all.
    //
    // `modelId` is the bare id, and it is right in exactly one other place: the sandbox's own config,
    // where the provider is `mycel` and the model is addressed as `mycel/<modelId>`. Using the bare
    // id here too sent `model=gpt-5.6-luna` to LiteLLM, which answered "Invalid model name" — a
    // 400 that surfaced as a run silently burning its whole runtime budget and aborting on the
    // timeout, because nothing on the way back turns an upstream 400 into a fast failure.
    //
    // Two names for one model is not an accident to be tidied away: `mycel/...` inside the sandbox
    // is what keeps the real provider key out of it, and `openai/...` upstream is what LiteLLM
    // meters and budgets per org.
    nonce = await registerGrant({ base_url: base, api_key: realKey, model, task_id: task.id });
    const built = buildOpencodeConfig(
      model,
      { proxyBaseUrl: `${cfg.publicUrl}/v1/internal/llm`, nonce, modelId },
      profile,
    );
    config = built.config;
    providerEnv = built.providerEnv;
    promptModel = `mycel/${modelId}`;
  } else {
    const built = buildOpencodeConfig(model, undefined, profile);
    config = built.config;
    providerEnv = built.providerEnv;
    promptModel = model;
  }

  /**
   * Which connections this run may act through, and whether it gets a token at all.
   *
   * `grants_actions: false` (every `build` profile) short-circuits the whole block: no connection
   * is even resolved, no grant is minted, and MYCEL_ACTION_TOKEN never enters the sandbox's
   * environment. That is the least-privilege split the profiles exist for, and it is worth being
   * precise about why it is done HERE rather than in the sandbox's permission block: the plugin's
   * `isGated()` matches on tool NAME against a substring list ("send", "email", "pay", ...), and
   * the tool a build uses is `bash`, which matches none of them. A shell-enabled run is therefore
   * ungated at the plugin layer by construction. The only thing that stops a build agent emailing
   * a customer is that it holds no credential to do it with.
   *
   * Not resolving the connections is also the cheapest of the two wins: the run is never even told
   * which mailbox exists.
   */
  const domain = getDomainStore();
  let connectionIds: string[] = [];
  let threadId: string | undefined;
  let grantedConns: Connection[] = [];
  let actionNonce: string | undefined;

  if (profile.grants_actions) {
    // Only this task's project's connections are grantable — never another tenant's.
    const allConns = (await domain.listConnections()).filter(
      (c) => !task.project_id || c.project_id === task.project_id,
    );
    const wantedConns = new Set<string>([
      ...(wedge?.manifest.connections ?? []),
      ...(Array.isArray(task.input?.connections) ? (task.input.connections as string[]) : []),
    ]);
    const clientId = taskClientId(task);
    connectionIds = selectGrantableConnections(allConns, wantedConns, clientId).map((c) => c.id);
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
    actionNonce = await registerActionGrant({ task_id: task.id, connectionIds, threadId, caseId: task.case_id });
    grantedConns = allConns.filter((c) => connectionIds.includes(c.id));
  }

  // 1. Write opencode.json + AGENTS.md, then GROUND the agent: mount the wedge's skills +
  //    knowledge and any per-task documents into the sandbox so it can fulfill the service.
  await ctx.emit("step.started", { step: "configure_sandbox" });
  await sandbox.writeFile("~/.config/opencode/opencode.json", JSON.stringify(config, null, 2));
  await sandbox.writeFile("~/.config/opencode/mycel-plugin.ts", MYCEL_PLUGIN_CODE);
  await sandbox.writeFile("AGENTS.md", buildAgentsMd(task, wedge, grantedConns, profile));

  // Ground the agent in the LATEST knowledge: on-disk (authored) + live (uploaded/feedback),
  // with live items overriding same-named disk files. This is how runtime edits + corrections
  // take effect without a redeploy.
  // Scoped to THIS task's project. Every API route already scoped correctly; this one — the only
  // place that puts the bytes in front of a model — did not, so every tenant on a wedge was reading
  // every other tenant's knowledge.
  const liveKnowledge = await domain.listKnowledge(task.wedge, task.project_id ?? "");
  const knowledgeByName = new Map<string, string>();
  for (const k of wedge?.knowledge ?? []) knowledgeByName.set(k.name, k.content);
  for (const k of liveKnowledge) knowledgeByName.set(k.name, k.content);
  for (const [name, content] of knowledgeByName) {
    await sandbox.writeFile(`knowledge/${name}`, content);
  }

  // Skills as files, indexed in AGENTS.md rather than inlined into it. Mounting them is what makes
  // that index real — an index pointing at files nobody wrote is worse than no index, because the
  // agent will try to read them and get nothing.
  //
  // Filtered by the profile: a wedge's procedures are not all relevant to every task type, and an
  // index line for a skill this run must not use is an invitation to use it.
  const mountedSkills = profileSkills(wedge, profile);
  for (const s of mountedSkills) {
    await sandbox.writeFile(`skills/${s.name}`, s.content);
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
  if (knowledgeByName.size || mountedSkills.length || docCount) {
    await ctx.emit("progress", {
      note: `grounded: ${knowledgeByName.size} knowledge (${liveKnowledge.length} live), ${mountedSkills.length} skills, ${docCount} documents`,
    });
  }

  // 2. Start `opencode serve` with provider creds + HTTP Basic auth.
  await ctx.emit("step.started", { step: "start_opencode" });
  const password = randomBytes(18).toString("hex");
  /**
   * The control-plane environment.
   *
   * Everything from MYCEL_ACTIONS_URL down is behind `grants_actions`, and it is one block rather
   * than seven `if`s because every one of those endpoints authenticates with the SAME action token.
   * Handing a build run the URLs without the token would only teach it to make requests that 401;
   * handing it neither is the honest statement that this run has no control plane beyond its own
   * filesystem.
   */
  const env: Record<string, string> = {
    ...providerEnv,
    OPENCODE_SERVER_USERNAME: "opencode",
    OPENCODE_SERVER_PASSWORD: password,
    // approval-gate wiring — the plugin calls back here to suspend on risky actions
    MYCEL_GATE_URL: `${cfg.publicUrl}/v1/internal/gate`,
    MYCEL_GATE_TOKEN: cfg.gateToken,
    MYCEL_TASK_ID: task.id,
    MYCEL_GATE_PATTERNS: buildGatePatterns(task, wedge),
  };
  if (profile.grants_actions && actionNonce) {
    // Action proxy: wedge tools POST here with this token to send/charge/book through a connection.
    env.MYCEL_ACTIONS_URL = `${cfg.publicUrl}/v1/internal/actions`;
    // Reads: ungated (but scoped to the same granted connections) — see AGENTS.md.
    env.MYCEL_READS_URL = `${cfg.publicUrl}/v1/internal/reads`;
    env.MYCEL_CASE_URL = `${cfg.publicUrl}/v1/internal/case`;
    env.MYCEL_WORKFLOWS_URL = `${cfg.publicUrl}/v1/internal/workflows`;
    env.MYCEL_GAPS_URL = `${cfg.publicUrl}/v1/internal/knowledge/gap`;
    env.MYCEL_RECORDS_URL = `${cfg.publicUrl}/v1/internal/records`;
    env.MYCEL_ACTION_TOKEN = actionNonce;
  }
  const envInline = Object.entries(env)
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
    if (nonce) await revokeGrant(nonce);
    if (actionNonce) await revokeActionGrant(actionNonce);
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
    try {
      /**
       * Strict-output profiles use OpenCode's NATIVE structured output rather than a sentence in
       * the prompt. Verified on 1.17.6's own OpenAPI document: POST /session/:id/message accepts
       * `format: {type:"json_schema", schema, retryCount}`, and opencode re-prompts the model
       * itself when the answer does not validate.
       *
       * That is worth doing because a schema violation is currently terminal: `runTask` validates
       * the final text and throws, so the whole run is billed and delivers nothing. Two free
       * retries inside the session are far cheaper than one failed task.
       */
      const schema = outputSchemaFor(task, wedge);
      await oc.sendPrompt(
        sessionId,
        buildPrompt(task, wedge, profile),
        promptModel,
        profile.strict_output && schema
          ? { format: { type: "json_schema", schema, retryCount: 2 } }
          : undefined,
      );
    } catch (e) {
      // Attach the agent's own log before rethrowing.
      //
      // OpenCode answers a failed prompt with `500 UnknownError ... check server logs for details`
      // and a reference id — and those logs are inside the sandbox, which the orchestrator destroys
      // in its `finally`. So the one artefact that explains the failure is deleted microseconds
      // after it is written, and every such failure looks identical from out here.
      //
      // Reading it costs one exec on a sandbox that is about to die anyway. Tail only: a long run's
      // log is mostly token streaming, and the interesting part is always the end.
      throw new Error(`${(e as Error).message}\n--- opencode.log (tail) ---\n${await tailAgentLog(sandbox)}`);
    }

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
    if (nonce) await revokeGrant(nonce);
    if (actionNonce) await revokeActionGrant(actionNonce);
  }

  // 6. Prefer the streamed final text; fall back to an artifact the agent wrote.
  if (!finalText) finalText = (await sandbox.readFile("output/result.txt")) ?? "";
  return { text: finalText };
}

/** The schema this run must answer in, if any. Wedge task_type first, then the task's own. */
function outputSchemaFor(task: Task, wedge: LoadedWedge | null): unknown {
  return wedge?.manifest.task_types?.[task.task_type]?.output_schema ?? task.output_schema;
}

/** Which of the wedge's skills this task type gets. Undefined `profile.skills` means all of them. */
function profileSkills(wedge: LoadedWedge | null, profile: HarnessProfile) {
  const all = wedge?.skills ?? [];
  if (!profile.skills) return all;
  const wanted = new Set(profile.skills.map((s) => (s.endsWith(".md") ? s : `${s}.md`)));
  return all.filter((s) => wanted.has(s.name));
}

/**
 * The prompt, shaped by the profile.
 *
 * The closing instruction is the part that genuinely differs. A `decide` run's deliverable IS the
 * final message, and it must validate — `runTask` throws on a schema failure, so the whole run is
 * wasted by a stray sentence of preamble. A `build` run's deliverable is a working repository, and
 * demanding a JSON object from it produces a model that stops building in order to describe what it
 * built.
 */
function buildPrompt(task: Task, wedge: LoadedWedge | null, profile?: HarnessProfile): string {
  const tt = wedge?.manifest.task_types?.[task.task_type];
  const outputSchema = outputSchemaFor(task, wedge);
  const shape = profile?.shape ?? "general";
  const strict = profile?.strict_output ?? false;

  const closing =
    shape === "build"
      ? `Do the real work: change the code, run it, and check it works before you say it does. ` +
        `When finished, summarise what you changed and why as your last message, and write the same ` +
        `summary to ./output/result.txt.`
      : `Do the real work. When finished, state the final result plainly as your last message and ` +
        `also write it to ./output/result.txt.`;

  return [
    tt?.description ? `Goal: ${tt.description}` : `Task type: ${task.task_type}`,
    `Input: ${JSON.stringify(task.input)}`,
    (wedge?.knowledge.length ?? 0) > 0
      ? `Your knowledge base is in ./knowledge/ — read the relevant files before acting.`
      : "",
    `Any documents uploaded for this specific task are in ./inputs/.`,
    // Under strict output the schema is enforced by opencode's own `format: json_schema` (which
    // retries), so restating it in prose only spends tokens telling the model something it is
    // already constrained by.
    outputSchema && !strict
      ? `Return a result conforming to this schema: ${JSON.stringify(outputSchema)}`
      : "",
    strict ? `Your final message must be ONLY the JSON result — no preamble, no code fences.` : "",
    closing,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * One line describing what a skill is for, for the index in AGENTS.md.
 *
 * Prefers a `description:` in frontmatter — the convention every skill in this repo follows — and
 * falls back to the first real sentence, because a skill written without frontmatter should still
 * be findable rather than silently unlabelled.
 */
function skillSummary(content: string): string {
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const described = fm?.[1].match(/^description:\s*(.+)$/m)?.[1]?.trim();
  if (described) return described.replace(/^["']|["']$/g, "").slice(0, 200);
  const body = content.replace(/^---[\s\S]*?---/, "");
  const line = body
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("#") && !l.startsWith("<!--"));
  return (line ?? "no description").slice(0, 200);
}

/**
 * The system instructions, shaped by the profile.
 *
 * The profile decides whether whole SECTIONS exist, not just their wording. A `build` run holds no
 * action token, so the action-proxy section and the knowledge-gap section are not merely
 * discouraged — they are omitted, because instructions the agent cannot follow are worse than
 * absent: it spends turns on them and gets 401s back.
 */
function buildAgentsMd(
  task: Task,
  wedge: LoadedWedge | null,
  connections: Connection[] = [],
  // Optional so the existing call sites (and the prompt-size tests) still work. Defaults to the
  // permissive shape, which is exactly what they were asserting before profiles existed.
  profile: HarnessProfile = defaultProfileFor(task),
): string {
  const parts: string[] = [];
  parts.push(`# ${wedge?.manifest.title ?? `Mycel agent — ${task.wedge}`}`);
  parts.push("");
  parts.push(`You are fulfilling a "${task.task_type}" task for the "${task.wedge}" wedge.`);
  if (profile.shape === "build") {
    parts.push(
      `This is a BUILD task: you are constructing or altering software in this workspace. Read the ` +
        `code before you change it, make the change, and verify it actually runs. Write deliverables ` +
        `to ./output/.`,
    );
    /**
     * Said out loud rather than left for the agent to discover through failures.
     *
     * This run holds no action token, so every Mycel control-plane endpoint is unreachable. An agent
     * that does not know that will burn turns curling them and reading 401s — and, worse, may decide
     * the right way to "finish" is to email someone. Telling it plainly is cheaper than either.
     */
    parts.push(
      `You have NO access to this business's email, payments, calendar or customer records, and no ` +
        `credentials to reach them. Do not attempt to contact anyone or take any real-world action. ` +
        `If the job seems to need one, say so in your final message and stop.`,
    );
  } else {
    parts.push(
      `Use your tools to do the real work. Ground yourself in ./knowledge/ (domain playbooks, ` +
        `policies, examples) and ./inputs/ (documents for this specific task) before acting. ` +
        `Be concise. Write deliverables to ./output/.`,
    );
  }
  if (profile.shape === "decide") {
    parts.push(
      `This is a DECISION task: read, reason, and answer. You cannot create or edit files — your ` +
        `deliverable is the final message, which must match the required schema exactly.`,
    );
  }
  if (task.case_id && profile.grants_actions) {
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
  // Taught whenever the run holds a token, not only when connections exist: the most valuable gaps
  // are about judgment (pricing, tone, when to escalate), which has nothing to do with having a
  // connection. A run with no token cannot reach the endpoint at all, so it is omitted there.
  if (profile.grants_actions) {
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
  }
  /**
   * Skills are INDEXED here and mounted as files, not inlined.
   *
   * Every skill's full text used to be concatenated into this prompt on every run, so a wedge with
   * twenty procedures paid for twenty procedures on a task that needed one. The agent has a
   * filesystem — `./knowledge/` already works this way — so the prompt carries a menu and the agent
   * pays tokens only for what it actually opens.
   *
   * The summary line matters: it is the entire basis on which the agent decides whether to read the
   * file, so a skill whose description is vague gets skipped when it was needed, or read when it
   * was not.
   */
  const skills = profileSkills(wedge, profile);
  if (skills.length) {
    parts.push("");
    parts.push(`## Procedures`);
    parts.push(
      `Written up in ./skills/. Read the one that fits the job before you start — they are how this ` +
        `business does the work, not general advice. Don't read them all.`,
    );
    parts.push("");
    for (const s of skills) {
      parts.push(`- \`skills/${s.name}\` — ${skillSummary(s.content)}`);
    }
  }
  return parts.join("\n");
}

/**
 * The permissive profile, for call sites that have no wedge or plan in hand (tests, and the
 * `buildAgentsMd` default parameter). Deliberately the `general` shape: the pre-profile behaviour.
 */
function defaultProfileFor(task: Task): HarnessProfile {
  const base = SHAPE_DEFAULTS.general;
  return {
    shape: "general",
    task_type: task.task_type,
    tier: base.tier,
    requested_tier: base.tier,
    tier_clamped: false,
    max_runtime_s: base.max_runtime_s,
    max_cost_usd: base.max_cost_usd,
    permission: base.permission,
    tools: base.tools,
    instructions: ["AGENTS.md"],
    grants_actions: base.grants_actions,
    strict_output: base.strict_output,
    long_lived: base.long_lived,
  };
}

/**
 * What this run cost, from the price table the rest of the system already uses.
 *
 * This used to hardcode $3/$15 per million (or $5/$25 if the model name contained "opus"), which
 * was wrong twice over: those are Anthropic's rates and we moved to OpenAI via LiteLLM, and no
 * model id we serve contains "opus" — `openai/gpt-5-nano`, `gpt-5.6-luna`, `gpt-5.6-terra`. So the
 * fast tier was metered at 60x its real cost.
 *
 * That number is not cosmetic: `spendThisMonth` enforces the plan ceiling on it, so the free tier's
 * $2/month allowance was really about three cents and ran out after a handful of jobs. Every margin
 * figure reasoned about in models.ts was computed from a table this function never read.
 *
 * Falls back to the standard tier for an unrecognised model. Over-estimating an unknown model
 * throttles a customer early, which is recoverable; under-estimating means serving work at a loss
 * and finding out on the invoice.
 */
function estimateCost(model: string, usage: Record<string, unknown>): number {
  const input = Number(usage.input_tokens ?? usage.inputTokens ?? usage.prompt_tokens ?? 0);
  const output = Number(usage.output_tokens ?? usage.outputTokens ?? usage.completion_tokens ?? 0);

  const tier = (Object.keys(TIER_MODELS) as ModelTier[]).find(
    (t) => TIER_MODELS[t] === model || model.endsWith(TIER_MODELS[t].split("/").pop() ?? "\u0000"),
  );
  const price = TIER_PRICE[tier ?? "standard"];
  return (input * price.in + output * price.out) / 1e6;
}

function shellQuote(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

/** Test seam: the prompt is a cost decision, so its shape is worth asserting directly. */
export const buildAgentsMdForTest = buildAgentsMd;
/** Test seam: the closing instruction and the schema handling differ by profile. */
export const buildPromptForTest = buildPrompt;

/**
 * The last few KB of OpenCode's own log, or a note saying why we could not get it.
 *
 * Never throws: this runs on the failure path, and a diagnostic that can fail the run it is trying
 * to explain is worse than no diagnostic.
 */
async function tailAgentLog(sandbox: Sandbox): Promise<string> {
  // /tmp/opencode.log is only what we redirected from `opencode serve` — which turns out to be the
  // startup banner and nothing else. OpenCode writes its real diagnostics to its own log directory,
  // so a 500 from the server left us with "opencode server listening" and no cause. Gather both, plus
  // the newest file under each candidate directory, and say which file each chunk came from: a tail
  // with no filename is unattributable the moment there is more than one source.
  const CANDIDATES = [
    "/tmp/opencode.log",
    "$HOME/.local/share/opencode/log",
    "$HOME/.cache/opencode/log",
    "/root/.local/share/opencode/log",
  ];
  const script = CANDIDATES.map(
    (c) =>
      `if [ -f ${c} ]; then echo "--- ${c} ---"; tail -c 3000 ${c}; ` +
      `elif [ -d ${c} ]; then f=$(ls -t ${c} 2>/dev/null | head -1); ` +
      `[ -n "$f" ] && { echo "--- ${c}/$f ---"; tail -c 3000 ${c}/$f; }; fi`,
  ).join("; ");

  try {
    const r = await sandbox.exec(`{ ${script}; } 2>/dev/null || true`);
    const out = (r.stdout || r.stderr || "").trim();
    return out || "(no agent log found)";
  } catch (e) {
    return `(could not read: ${(e as Error).message})`;
  }
}
