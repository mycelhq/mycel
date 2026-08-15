// The agent runtime: run one Mycel task by driving OpenCode inside a sandbox, mapping
// OpenCode's event stream onto Mycel contract events. Stack, not custom loop — OpenCode IS
// the agent. A proven OpenCode harness flow
//
import { randomBytes } from "node:crypto";
import { registerActionGrant, revokeActionGrant } from "./actiongrants";
import { registerBuildGrant, revokeBuildGrant } from "./buildgrants";
import {
  BUILD_TOOL_PATH,
  INSIGHT_TOOL_PATH,
  buildToolScript,
  insightToolDoc,
  insightToolScript,
  remoteBuildConfig,
  remoteBuildToolDoc,
} from "./remotebuild";
import { loadConfig } from "./config";
import type { Connection, EventType, Task } from "./contract";
import { getDomainStore } from "./domain";
import { recordSkillUses } from "./skill-scales";
import { registerRun, deregisterRun } from "./runregistry";

/**
 * The port the long-lived interactive-preview dev server binds. DELIBERATELY NOT 3000 — the verify
 * step boots its own throwaway `next dev` on 3000, curls it once and kills it, and a preview server
 * squatting on 3000 would make verify pass against the wrong process (a false green). Physical port
 * separation keeps the two independent with zero changes to the verify command.
 */
const PREVIEW_PORT = 4321;
import { groundRun, type Grounding, type GroundingFile } from "./knowledge";
import { deriveAuthority as deriveBrainAuthority, digestFor as brainDigestFor } from "./brain";
import { getBillingStore } from "./billing";
import { getKnowledgeStore } from "./knowledge.store";
import {
  buildComponentMcpConfig,
  buildOpencodeConfig,
  OpenCodeClient,
  OpenCodeEventMapper,
  openaiCompatibleBase,
  providerEnvVar,
  splitModel,
  type UsageDelta,
} from "./opencode";
import { buildGatePatterns, MYCEL_PLUGIN_CODE } from "./plugin";
import { brokeredCaveat, capabilityAdapter, isCapability, resolveCapability, whyNoProvider } from "./capabilities";
import { composioConfig, connConfig as composioConnConfig, isComposio } from "./composio";
import {
  renderToolContext,
  selectToolContext,
  taskQuery,
  type ConnectionTools,
  type ConnectionToolRequest,
} from "./composio.tools";
import {
  BRIDGE_MANIFEST_PATH,
  BRIDGE_SCRIPT_PATH,
  buildBridgeManifest,
  buildMcpConfig,
  GATE_EXEMPT_PREFIX,
  MCP_SERVER_NAME,
  MYCEL_MCP_BRIDGE_CODE,
} from "./mcpbridge";
import { registerGrant, revokeGrant } from "./proxygrants";
import type { Sandbox } from "./sandbox";
import { validateOutput } from "./validate";
import { type LoadedWedge, type WedgeFile } from "./wedge";
import { librarySkillsForWedge } from "./skill-library";
import { loadProjectWedge } from "./authored";
import { isPlaybookKnowledge, overlayPlaybooks } from "./playbooks";
import { describeForAgent } from "./linkedin/capabilities";
import { getIdentityStore } from "./identity";
import { modelForTier, TIER_MODELS, TIER_PRICE, type ModelTier } from "./models";
import { PRESUB_PLAN } from "./presubscription";
import { keyForOrg, litellmEnabled } from "./litellm";
import { resolveHarnessProfile, SHAPE_DEFAULTS, type HarnessProfile } from "./harness";
import { resolveWorkspace, seedWorkspace, type ResolvedWorkspace, type SeedOutcome } from "./workspace";

/** What a charge was for, beyond the dollars. Everything here ends up on `cost.charged`. */
export interface CostMeta {
  /**
   * The model that produced the tokens.
   *
   * "Which model ran this?" is the first question anyone asks a trace, and until now the event log
   * could not answer it for any run in the system's history.
   */
  model?: string;
  tier?: string;
  /** Prompt/completion/reasoning/cache counts, kept rather than collapsed into dollars. */
  tokens?: Record<string, number>;
  reason?: string;
}

export interface RuntimeCtx {
  emit(type: EventType, data?: Record<string, unknown>): Promise<void> | void;
  onCost(usd: number, meta?: CostMeta): void;
  /** Returns a reason string if the task should abort (cancel / cost / runtime), else null. */
  shouldAbort(): string | null;
  /**
   * Unrecognised OpenCode event types and their counts, handed over so `task.finished` can carry
   * them. Optional: not every RuntimeCtx has a place to put them, and a missing drift counter must
   * not be a type error at every call site.
   */
  onDrift?(counts: Record<string, number>): void;
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
/**
 * The connection ids that answer a wedge's declared capabilities, in this project.
 *
 * The bridge between "this agent needs to be able to send email" and "this founder's Gmail". It
 * returns IDS rather than names because `selectGrantableConnections` accepts either and an id cannot
 * collide with a name a founder chose — `wanted.has(c.name)` on a founder who named a connection
 * `read_payments` would otherwise be a small, funny, real hole.
 *
 * A capability nothing provides contributes NOTHING and does not throw. That is the roles.ts rule:
 * an install with no mailbox connected is a legitimate install, and the run degrades to drafting.
 * What makes it honest rather than silent is that `runOpenCodeTask` puts the missing-capability
 * sentence into the run's context (see below), so the agent is told what it cannot do instead of
 * discovering it by trying.
 */
export function capabilityConnections(
  capabilities: readonly string[],
  conns: Connection[],
  projectId: string | undefined,
): { ids: string[]; missing: string[] } {
  const ids: string[] = [];
  const missing: string[] = [];
  if (!projectId) {
    // No project means no tenant to resolve against, and resolving against "all of them" is the
    // cross-tenant leak this repo has shipped twice. A task with no project gets no capability
    // grants at all; a wedge that names connections directly is unaffected.
    return { ids, missing: capabilities.filter(isCapability).map((c) => whyNoProvider(c)) };
  }
  for (const name of capabilities) {
    if (!isCapability(name)) continue; // Already refused at manifest load; belt and braces here.
    const binding = resolveCapability(name, conns, projectId);
    if (!binding.ok) {
      missing.push(binding.detail);
      // An ambiguous single-provider capability grants NOTHING rather than granting both. Handing an
      // agent two mailboxes and no rule for which to use is how a client gets the same chase twice.
      if (binding.ambiguous) continue;
    } else if (capabilityAdapter(name) === "brokered") {
      // TOLD EVEN WHEN IT WORKS, because "works" means something different here.
      //
      // A brokered capability hands the agent the vendor's own tools and nothing else: no adapter
      // composes the call, nothing normalises the answer. An agent that believes `write_crm` is a
      // kernel verb plans a run around a single clean step and then spends the run discovering the
      // toolkit's argument names by trial — which is exactly what `send_email` did before it had an
      // adapter, and the reason a chase could silently never leave. Saying so up front costs one
      // line of the prompt and is the difference between a plan and a guess.
      missing.push(brokeredCaveat(name));
    }
    for (const b of binding.bound) ids.push(b.connection.id);
  }
  return { ids: [...new Set(ids)], missing };
}

/**
 * Which connections a run may act through — the tenant boundary, enforced HERE rather than trusted
 * to the caller.
 *
 * ═══ THE THIRD CROSS-TENANT LEAK, AND WHY THE PROJECT IS NOW AN ARGUMENT ═══
 *
 * This function used to take only `clientId` and its own docstring said "this function does not
 * check tenancy" — the project filter was the CALLER's job, eight lines up in `runOpenCodeTask`,
 * where it read `!task.project_id || c.project_id === task.project_id`. That disjunct is a
 * fail-OPEN: a task with no project matched EVERY connection in the deployment. `capabilityConnections`
 * had already been taught to refuse a falsy project (see above), but the NAME-based path had not —
 * and `wedge.manifest.connections` contains plain names like "linkedin", so a project-less task
 * could be granted another tenant's LinkedIn member session. Two cross-tenant leaks had already
 * shipped from this exact shape: a guard that lives in the callee's caller is a convention, and
 * conventions are what the third leak is made of.
 *
 * So `projectId` is a required positional argument, and a falsy one grants NOTHING. The check
 * cannot be forgotten by a new caller, because there is no way to call this without answering the
 * question. A project-less task is a legitimate thing to have (a bare `spawnTask` in a test, a
 * migration) — it simply gets no hands, which is the safe direction to be wrong in.
 *
 * Client entitlement is the SECOND, narrower gate and still applies: within one project, a client's
 * own connections come automatically, and founder-owned ones must be named.
 */
export function selectGrantableConnections(
  conns: Connection[],
  wanted: Set<string>,
  projectId: string | undefined,
  clientId?: string,
): Connection[] {
  // A run with no tenant resolves against no tenant. NEVER "all of them" — see above.
  if (!projectId) return [];
  return conns.filter((c) => {
    if (c.project_id !== projectId) return false;
    if (!entitledTo(c, clientId)) return false;
    // This client's own connections come automatically — the founder acts on their behalf, through
    // their mailbox and their calendar. Founder-owned ones must be named by the wedge or the task.
    return c.owner.kind === "client" || wanted.has(c.name) || wanted.has(c.id);
  });
}

/**
 * Where model calls go, and with which credential — or a refusal, in a sentence, before anything
 * has been provisioned.
 *
 * ═══ THE PRODUCTION FAILURE THIS EXISTS FOR ═══
 *
 * This used to be four inline lines ending in `?? ""`. With no tenant key it fell back to talking to
 * OpenAI directly with an EMPTY key, span up a sandbox, and let the provider answer. What a founder
 * signing up on app.mycelai.dev actually read, on the second screen of onboarding, was OpenAI's own
 * 401: "You didn't provide an API key … You can obtain an API key from
 * https://platform.openai.com/account/api-keys" — telling the customer of a hosted product to go and
 * buy a key he was never meant to supply. The run was recorded failed at $0.00 having done nothing,
 * and the real fault (no virtual key was ever minted) was nowhere in the message.
 *
 * THE GENUINE DEGRADE IS KEPT. A self-hosted operator with `OPENAI_API_KEY` set, or a hosted
 * deployment whose budget broker is momentarily down, still runs — a broker outage must not stop a
 * customer's business. What is removed is the third case, where there is nothing to run WITH: that
 * now fails at the start, spends nothing, and names which of the two credentials is missing.
 */
export function resolveUpstream(
  providerId: string,
  tenantKey: string | undefined,
  orgId?: string,
): { base: string; key: string } {
  const base = tenantKey
    ? `${process.env.MYCEL_LITELLM_URL!.replace(/\/+$/, "")}/v1`
    : (process.env.MYCEL_LLM_UPSTREAM ?? openaiCompatibleBase(providerId));
  if (!base) {
    throw new Error(
      `proxy mode: no OpenAI-compatible upstream for "${providerId}" — set MYCEL_LITELLM_URL, or MYCEL_LLM_UPSTREAM`,
    );
  }
  const directKey = process.env[providerEnvVar(providerId)];
  if (!tenantKey && !directKey) {
    // Two sentences, because the two deployments have different people reading them. A hosted
    // deployment MEANT to broker keys (MYCEL_LITELLM_URL is set), so the fault is ours and the
    // message points at the broker; a self-hosted one is missing a key its operator supplies.
    throw new Error(
      litellmEnabled()
        ? `No model credential for this business. This deployment brokers model access through LiteLLM and no virtual key could be issued` +
          `${orgId ? ` for org ${orgId}` : " because this task is not attached to a project"}. ` +
          `Nothing was started and nothing was charged. This is ours to fix, not yours: the kernel must be able to reach MYCEL_LITELLM_URL with a valid MYCEL_LITELLM_MASTER_KEY.`
        : `No model credential is configured. Set MYCEL_LITELLM_URL and MYCEL_LITELLM_MASTER_KEY to broker keys per business, ` +
          `or ${providerEnvVar(providerId)} to call ${providerId} directly. Nothing was started and nothing was charged.`,
    );
  }
  return { base, key: tenantKey ?? directKey! };
}

export async function runOpenCodeTask(
  task: Task,
  sandbox: Sandbox,
  ctx: RuntimeCtx,
): Promise<{ text: string }> {
  const cfg = loadConfig();
  // Resolved from the TASK's project, for the same reason `orgId` below is: the definition that
  // shapes this run must belong to the tenant whose work it is. An authored service is unreachable
  // through `loadWedge`, so this is not an optimisation — it is the only way to run one.
  const wedge = await loadProjectWedge(task.project_id ?? "", task.wedge);
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
  // Resolved from the TASK's project, so the ceiling belongs to the tenant whose work this is and
  // never to whoever happened to enqueue it. `orgId` is "" for a task outside any project, and
  // `orgIsUnlimited("")` is false, so an unowned task can never come out uncapped.
  const orgId = task.project_id ? (getIdentityStore().getProject(task.project_id)?.org_id ?? "") : "";
  const org = orgId ? getIdentityStore().getOrg(orgId) : undefined;
  /**
   * The plan whose CEILINGS apply — which is not the plan's NAME before anybody has paid.
   *
   * A cloud org is stamped with the plan it is about to buy while `plan_status` stays `none`, so the
   * name is aspirational. Onboarding's own drafting runs are allowed to happen in that state (see
   * presubscription.ts — production refused a real signup at step two of onboarding until they
   * were), and reading the name alone would hand a stranger who picked Growth on the pricing page
   * the `deep` tier, at 10× the token price, before we had charged them anything. `PRESUB_PLAN`
   * pins them to `standard`.
   *
   * Status, not name, and only `none`: `trialing` and `past_due` keep the full ceiling of the plan
   * they are on, because a trial that silently ran on a cheaper model would be a demo of a product
   * we do not sell.
   */
  const plan = org?.plan_status === "none" ? PRESUB_PLAN : org?.plan;
  const profile = resolveHarnessProfile({
    task,
    wedge,
    plan,
    unlimited: getIdentityStore().orgIsUnlimited(orgId),
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
    // `orgIdForProject`, not `getProject`: this is the WORKER process, whose identity cache was
    // filled at boot, and the org was created by the API container minutes ago. See the note on that
    // method for the production run this cost.
    const orgId = task.project_id
      ? await getIdentityStore().orgIdForProject(task.project_id)
      : undefined;
    const tenantKey = orgId ? await keyForOrg(orgId) : undefined;

    const { base, key: realKey } = resolveUpstream(providerId, tenantKey, orgId);
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
  /** Declared capabilities nothing in this project provides. Told to the agent; see `buildAgentsMd`. */
  let capabilityGaps: string[] = [];
  let actionNonce: string | undefined;
  /**
   * The build tool's credential — minted separately from the action grant, and only for a run that
   * can actually use it. See buildgrants.ts for why it is not a flag on the action nonce.
   */
  let buildNonce: string | undefined;

  if (profile.grants_actions) {
    // Only this task's project's connections are grantable — never another tenant's, and a task
    // with NO project gets none rather than all of them. Both halves of that are now enforced
    // inside `selectGrantableConnections`; this filter is the cheap pre-narrowing that keeps the
    // rest of this block (thread channel, tool catalogue) reading a list it is allowed to see.
    const allConns = (await domain.listConnections()).filter(
      (c) => !!task.project_id && c.project_id === task.project_id,
    );
    // Capabilities first, then the two name-based sources. `capabilityConnections` resolves "needs to
    // read payments" against whatever this founder actually connected, so a QuickBooks business and a
    // Stripe business both get hands from the same one-line declaration in the manifest.
    const byCapability = capabilityConnections(wedge?.manifest.capabilities ?? [], allConns, task.project_id);
    capabilityGaps = byCapability.missing;
    const wantedConns = new Set<string>([
      ...byCapability.ids,
      ...(wedge?.manifest.connections ?? []),
      ...(Array.isArray(task.input?.connections) ? (task.input.connections as string[]) : []),
    ]);
    const clientId = taskClientId(task);
    connectionIds = selectGrantableConnections(allConns, wantedConns, task.project_id, clientId).map(
      (c) => c.id,
    );
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

  /**
   * WHAT THE CONNECTIONS CAN ACTUALLY DO — fetched, selected, and mounted.
   *
   * Deliberately AFTER the grant block and reading `grantedConns`, never `allConns`. The tool
   * context is a description of capability, and describing a connection to a run that may not use
   * it is both a leak of another client's vendor stack and an invitation for the agent to try. The
   * tenant boundary for this feature is `selectGrantableConnections`, unchanged and not re-derived
   * here; see the header of composio.tools.ts, rule (a).
   *
   * `Promise.all` is not used: `toolCatalogue` is per-toolkit cached and a business has a handful of
   * connections, so the serial cost is one cold fetch each on the first run of a fleet and zero
   * thereafter. Failure is swallowed inside `toolCatalogue` — a Composio outage degrades the prompt
   * to the old name-and-id form rather than failing sandbox setup, which is the wrong thing to die
   * of when the task might not need a connection at all.
   */
  let toolContext: ConnectionTools[] = [];
  if (grantedConns.length) {
    const requests: ConnectionToolRequest[] = [];
    for (const c of grantedConns) {
      if (!isComposio(c)) continue;
      const cc = composioConnConfig(c);
      if (!cc.toolkit) continue;
      requests.push({
        connection_id: c.id,
        connection_name: c.name,
        toolkit: cc.toolkit,
        read_tools: cc.read_tools ?? [],
        // A wedge names the tools its procedure depends on; the task may name more. Both are
        // "someone deliberately said this run uses this", which is rule (b).
        named_tools: [
          ...(wedge?.manifest.tools ?? []),
          // `task.tools` is the contract's own per-task tool list — the closest thing to "someone
          // said this run uses this" that exists on a Task.
          ...(task.tools ?? []),
        ],
      });
    }
    toolContext = await selectToolContext(
      composioConfig(),
      requests,
      taskQuery({
        type: task.task_type,
        wedge: task.wedge,
        input: task.input as Record<string, unknown> | undefined,
        extra: [wedge?.manifest.title ?? ""],
      }),
    );
  }

  /**
   * MOUNT THEM AS REAL TOOLS. See mcpbridge.ts for the evidence that 1.17.6 supports this at all.
   *
   * Only when the run has an action nonce: the bridge's every call is an authenticated POST to the
   * action proxy, so mounting it without a token would give the agent a toolbox of tools that all
   * 401 — which reads to a model as "the tool is broken" and burns a turn each discovering it.
   */
  let mcpConfig: Record<string, unknown> | undefined;
  if (actionNonce && toolContext.length) {
    const manifest = buildBridgeManifest(toolContext);
    mcpConfig = buildMcpConfig(manifest, {
      actionsUrl: `${cfg.publicUrl}/v1/internal/actions`,
      readsUrl: `${cfg.publicUrl}/v1/internal/reads`,
      token: actionNonce,
    });
    if (mcpConfig) {
      config.mcp = mcpConfig;
      // DECIDE SHAPE DENIES EVERYTHING BY DEFAULT (`"*": "deny"`). MCP tools arrive as
      // `mycel_<name>` and are not on that allowlist, so without this the bridge mounts, the model
      // never sees the tools, and the only path that works is curl-via-bash — which is exactly the
      // "we built a bridge and then hid it" failure. Allow each mounted tool by its full OpenCode
      // name; the authoritative gate for writes remains the action proxy, not this permission bit.
      const perm = { ...((config.permission as Record<string, unknown> | undefined) ?? {}) };
      for (const t of manifest.tools) {
        perm[`${MCP_SERVER_NAME}_${t.name}`] = "allow";
      }
      config.permission = perm;
      await sandbox.writeFile(BRIDGE_SCRIPT_PATH, MYCEL_MCP_BRIDGE_CODE);
      await sandbox.writeFile(BRIDGE_MANIFEST_PATH, JSON.stringify(manifest, null, 2));
    }
  }

  // Component-library MCPs for a BUILD run — the agent composes from best-in-class UI components
  // (21st.dev Magic) rather than hand-rolling them. Separate from the action bridge above and NOT
  // gated on an action nonce: these are tool-only servers. Dormant unless a provider key is set on
  // the kernel (see buildComponentMcpConfig), so the default build touches no credential. Build shape
  // is allow-by-default, so merging the server into `mcp` is enough — no permission entries needed.
  const componentMcp = buildComponentMcpConfig(profile.shape);
  if (componentMcp) {
    config.mcp = { ...((config.mcp as Record<string, unknown> | undefined) ?? {}), ...componentMcp.servers };
  }

  // 1. Write opencode.json + AGENTS.md, then GROUND the agent: mount the wedge's skills +
  //    knowledge and any per-task documents into the sandbox so it can fulfill the service.
  await ctx.emit("step.started", { step: "configure_sandbox" });
  await sandbox.writeFile("~/.config/opencode/opencode.json", JSON.stringify(config, null, 2));
  await sandbox.writeFile("~/.config/opencode/mycel-plugin.ts", MYCEL_PLUGIN_CODE);

  /**
   * THE WORKSPACE EXISTS BEFORE THE AGENT DOES.
   *
   * `readSeed` sat in workspace.ts with no caller anywhere in the repo, so `product-builder` —
   * which has declared `seed: "business-template"` since the block was written — started every run
   * against an empty home directory. Handed "build a feature in your Next.js product" and given no
   * product, the agent built one from scratch wherever it happened to be standing (`/root`), `~/app`
   * never came into existence, and the export at the end failed with "the run produced no ~/app
   * directory". That is the whole of bug #2 and most of bug #3.
   *
   * Seeding here rather than in the orchestrator keeps it next to the other things the sandbox is
   * given — config, AGENTS.md, skills, knowledge — and, more usefully, means the seed counts are
   * known when AGENTS.md is written a few lines below, so the prompt can say what is actually there.
   */
  const ws = resolveWorkspace(wedge?.manifest, task.task_type);
  let seeded: SeedOutcome | undefined;
  if (ws) {
    seeded = await seedWorkspace(sandbox, ws);
    await ctx.emit("progress", {
      // ALWAYS EMITTED, both ways round. The absence of this line is what made run 49fa00bb take a
      // day to read: a seed that silently no-ops and a seed that never ran leave identical feeds.
      // A declared-but-missing scaffold no longer reaches here at all — `seedWorkspace` throws, and
      // the run fails in its first seconds naming the scaffold instead of expiring thirty minutes
      // later having searched the sandbox for a project nobody put there.
      note: seeded.root
        ? `workspace ~/${ws.dir}: seeded from ${ws.seed} — ${seeded.written} files` +
          (seeded.skipped ? ` (${seeded.skipped} binary/oversized files skipped)` : "")
        : `workspace ~/${ws.dir}: created empty — this wedge declares no scaffold to seed from.`,
    });
  }

  /**
   * THE BUILD TOOL — installed only when it can actually work.
   *
   * Three conditions, and each one prevents a specific lie:
   *
   *   · the workspace asks for it   — otherwise a `books-keeper` run would be handed a compiler
   *   · this kernel has a build plane — otherwise the script exists, 503s, and the agent burns turns
   *     discovering that a documented tool is fictional
   *   · the task has a project      — the S3 key is keyed by project, and a task with none has
   *     nowhere to stage source that is safely nobody else's
   *
   * When any of them is false the tool is not installed, not documented, and not enforced. That is
   * the state of every developer machine, and a build run there behaves exactly as it did before
   * this existed.
   */
  const buildPlane = ws?.requireRemoteBuild && remoteBuildConfig() && task.project_id ? true : false;
  if (buildPlane && ws) {
    buildNonce = await registerBuildGrant({ task_id: task.id, project_id: task.project_id! });
    // On PATH, so the agent runs `mycel-build` rather than remembering a path. `writeFile` resolves
    // relative names against HOME, so this one is absolute on purpose.
    await sandbox.writeFile(BUILD_TOOL_PATH, buildToolScript());
    await sandbox.exec(`chmod +x ${BUILD_TOOL_PATH}`, 30_000);
    // Installed alongside, on the same nonce and the same switch. `mycel-build` proves the app
    // compiles; `mycel-insight` says what the LAST version of it did to real visitors — which is the
    // difference between an agent that rewrites a page and one that improves it. See the note above
    // `INSIGHT_TOOL_PATH` for why it shares the build grant rather than minting a second credential.
    await sandbox.writeFile(INSIGHT_TOOL_PATH, insightToolScript());
    await sandbox.exec(`chmod +x ${INSIGHT_TOOL_PATH}`, 30_000);
    await ctx.emit("progress", {
      note:
        `build plane available: \`mycel-build\` compiles ~/${ws.dir} with the deploy toolchain. ` +
        `This task cannot succeed until one of those builds passes.`,
    });
  }

  /**
   * Ground the agent by RETRIEVAL, not by accumulation.
   *
   * What used to happen here: every knowledge file this wedge had ever accumulated for this tenant
   * was written into the sandbox, every run, forever. That is O(business history) per job — it gets
   * slower and more expensive exactly as a customer becomes more valuable — and, worse, it has no
   * notion of relevance, so the one note that governs this job arrives buried in ninety that don't.
   * The comment on `buildAgentsMd` about skills made precisely this argument and it applies here.
   *
   * Now: rank by wedge, task type, client, recency and how often a rule has actually been used, and
   * take what fits a hard budget. The distilled rules go INLINE (there are few, they are one line
   * each, and a prohibition read too late is a prohibition that did not work); the files stay files,
   * indexed in AGENTS.md so the agent pays for what it opens.
   *
   * Scoped to THIS task's project throughout. Every API route already scoped correctly; this one —
   * the only place that puts the bytes in front of a model — did not, so every tenant on a wedge was
   * reading every other tenant's knowledge. A run with no project grounds on the wedge's own disk
   * knowledge and nothing else.
   */
  const liveKnowledge = task.project_id ? await domain.listKnowledge(task.wedge, task.project_id) : [];
  const candidates = new Map<string, GroundingFile>();
  // Live items override same-named disk files — that is how a runtime correction takes effect
  // without a redeploy, and it is why the disk files are inserted first.
  for (const k of wedge?.knowledge ?? []) candidates.set(k.name, { name: k.name, content: k.content });
  for (const k of liveKnowledge) {
    // Playbook overlays mount as skills, not as knowledge files. Writing them into ./knowledge/
    // would double-mount the same bytes and bury the index in procedure drafts.
    if (isPlaybookKnowledge(k.name)) continue;
    candidates.set(k.name, {
      name: k.name,
      content: k.content,
      kind: k.kind,
      source: k.source,
      created_at: k.created_at,
      metadata: k.metadata,
    });
  }
  // The brain's index for this run. Best-effort and never fatal: a brain that cannot be counted
  // must degrade to "the agent was not told it exists", never to "the run failed".
  const brainAuth = deriveBrainAuthority(task);
  let brainDigest: string | undefined;

  const grounding = await groundRun(getKnowledgeStore(), {
    ctx: {
      project_id: task.project_id ?? "",
      wedge: task.wedge,
      task_type: task.task_type,
      client_id: taskClientId(task),
    },
    files: [...candidates.values()],
  });

  if (brainAuth && profile.grants_actions) {
    try {
      brainDigest = await brainDigestFor(
        { domain: getDomainStore(), billing: getBillingStore(), knowledge: getKnowledgeStore() },
        brainAuth,
      );
    } catch (e) {
      console.error("[mycel] could not summarise the company brain:", (e as Error)?.message);
    }
  }

  // Skills as files, indexed in AGENTS.md rather than inlined into it. Computed once so the index
  // and the files cannot disagree — an overlay the prompt names and the sandbox lacks is worse than
  // no overlay.
  // Shared-library skills for this wedge's domains — mounted alongside its own. A store read, failing
  // soft to none: a library outage must not strip a run of the procedures it does carry.
  const librarySkills = await librarySkillsForWedge(domain, wedge?.manifest).catch(() => []);
  const mountedSkills = profileSkills(wedge, profile, liveKnowledge, task.task_type, librarySkills);
  await sandbox.writeFile(
    "AGENTS.md",
    buildAgentsMd(
      task,
      wedge,
      grantedConns,
      profile,
      grounding,
      ws ? { ws, seeded, buildTool: buildPlane } : undefined,
      toolContext,
      brainDigest,
      capabilityGaps,
      mountedSkills,
    ),
  );
  for (const f of grounding.files) {
    await sandbox.writeFile(`knowledge/${f.name}`, f.content);
  }

  // Filtered by the profile: a wedge's procedures are not all relevant to every task type, and an
  // index line for a skill this run must not use is an invitation to use it.
  for (const s of mountedSkills) {
    await sandbox.writeFile(`skills/${s.name}`, s.content);
  }
  // Attribution: remember which skills this run mounted, keyed by the task, so a later client verdict
  // on its deliverable can weigh them. Fail-soft — a run must never fail because the scale could not
  // be written. See skill-scales.ts.
  if (task.project_id) {
    void recordSkillUses(getDomainStore(), {
      project_id: task.project_id,
      task_id: task.id,
      wedge: task.wedge,
      skills: mountedSkills,
    }).catch((e) => console.error("[mycel] recordSkillUses failed:", e));
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
  if (grounding.files.length || grounding.rules.selected.length || mountedSkills.length || docCount) {
    // What was LEFT OUT is reported, not just what was included. A founder whose correction did not
    // reach the prompt is entitled to see that it was a budget decision rather than assume the
    // system ignored them — and "dropped" climbing run after run is the signal that the budget is
    // now too small for this business.
    const left = grounding.rules.dropped + grounding.omitted_files;
    await ctx.emit("progress", {
      note:
        `grounded: ${grounding.rules.selected.length} learned rules, ${grounding.files.length} knowledge ` +
        `(${liveKnowledge.length} live), ${mountedSkills.length} skills, ${docCount} documents` +
        (left ? ` — ${left} lower-ranked item(s) left out for budget` : ""),
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
    /**
     * The kernel's own MCP tools skip the plugin gate because they are gated SERVER-SIDE, at the
     * action proxy, with a real preview. Set unconditionally — including on runs that mount no
     * bridge — so that the value is a property of the plugin's contract rather than of whether this
     * particular run happened to have connections. A conditional here would mean the exemption is
     * present on exactly the runs where it is hardest to reason about it.
     */
    MYCEL_GATE_EXEMPT: GATE_EXEMPT_PREFIX,
  };
  if (profile.grants_actions && actionNonce) {
    // Action proxy: wedge tools POST here with this token to send/charge/book through a connection.
    env.MYCEL_ACTIONS_URL = `${cfg.publicUrl}/v1/internal/actions`;
    // Reads: ungated (but scoped to the same granted connections) — see AGENTS.md.
    env.MYCEL_READS_URL = `${cfg.publicUrl}/v1/internal/reads`;
    env.MYCEL_CASE_URL = `${cfg.publicUrl}/v1/internal/case`;
    env.MYCEL_WORKFLOWS_URL = `${cfg.publicUrl}/v1/internal/workflows`;
    env.MYCEL_PACKS_URL = `${cfg.publicUrl}/v1/internal/packs/run`;
    env.MYCEL_BATCHES_URL = `${cfg.publicUrl}/v1/internal/batches`;
    env.MYCEL_GAPS_URL = `${cfg.publicUrl}/v1/internal/knowledge/gap`;
    env.MYCEL_RECORDS_URL = `${cfg.publicUrl}/v1/internal/records`;
    // The company brain. Two verbs, the SAME action token — no new credential enters the sandbox.
    env.MYCEL_BRAIN_URL = `${cfg.publicUrl}/v1/internal/brain`;
    env.MYCEL_ACTION_TOKEN = actionNonce;
  }
  /**
   * The build tool's two variables, on their own switch.
   *
   * Deliberately NOT inside the `grants_actions` block above: a build run has `grants_actions:
   * false` by construction (harness.ts overrules the manifest to guarantee it), so anything gated on
   * that flag is unreachable from exactly the shape that needs a compiler. This is the one
   * capability a build run has beyond its own filesystem, and it reaches one endpoint that starts
   * one build of one archive and returns a log.
   */
  if (buildNonce && ws) {
    env.MYCEL_BUILD_URL = `${cfg.publicUrl}/v1/internal/build`;
    env.MYCEL_BUILD_TOKEN = buildNonce;
    // So `mycel-build` with no argument packages the right directory. The agent may still pass one.
    env.MYCEL_WORKSPACE_DIR = ws.dir;
  }
  const envInline = Object.entries(env)
    .map(([k, v]) => `${k}=${shellQuote(v)}`)
    .join(" ");
  /**
   * `--hostname 0.0.0.0`, AND IT IS NOT OPTIONAL.
   *
   * OBSERVED IN PRODUCTION: every shaping run on app.mycelai.dev failed, twice in a row, after
   * sitting in "running" for five minutes, with:
   *
   *     opencode failed to start: opencode server listening on http://127.0.0.1:4444
   *
   * That message is the bug wearing its own evidence. opencode HAD started — the line quoted back at
   * the founder is opencode's success banner — and it had bound LOOPBACK ONLY, because
   * `opencode serve --hostname` defaults to "127.0.0.1" (verified on the pinned 1.17.6: `serve
   * --help` prints `[string] [default: "127.0.0.1"]`). Nothing outside the process's own network
   * namespace can reach a loopback socket, so:
   *
   *   · DaytonaSandbox — `getPreviewLink` proxies in from outside the sandbox. Never connects.
   *   · DockerSandbox  — `docker run -p 127.0.0.1::4444` publishes the CONTAINER's interface, not
   *                      the container's loopback. Never connects.
   *
   * So `waitReady` polled a socket that could not be reached, for its full 60s, on every run, on
   * every backend. The only sandbox this ever worked on is the in-process local one, which is why
   * the test suite was green through all of it.
   *
   * This is safe to bind wide: the sandbox is a single-tenant, per-task, network-isolated box, and
   * the server still demands the HTTP Basic password generated one line above and never reused.
   */
  await sandbox.spawn(
    `${envInline} opencode serve --hostname 0.0.0.0 --port ${cfg.opencodePort} > /tmp/opencode.log 2>&1`,
  );

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
    if (buildNonce) await revokeBuildGrant(buildNonce);
    const reason = String((e as Error)?.message ?? e);
    if (reason.startsWith("aborted:")) throw e;
    /**
     * `tailAgentLog`, NOT `/tmp/opencode.log`.
     *
     * OBSERVED IN PRODUCTION: the founder's first-ever run failed with
     * `opencode failed to start: opencode server listening on http://127.0.0.1:4444` — a sentence
     * that reports a failure and then quotes a SUCCESS banner, because `/tmp/opencode.log` is only
     * the stdout we redirected, and opencode's stdout is the banner and nothing else. Its real
     * diagnostics go to its own log directory.
     *
     * `tailAgentLog` was written for exactly this and gathers both, with the filename each chunk
     * came from. It was wired into the session-creation failure below and never into this one — the
     * earlier and far more common failure. A diagnostic that exists and is not called on the path
     * that needs it is the same as no diagnostic, and it cost a whole walkthrough to root-cause a
     * bind address the log had been printing all along.
     */
    const log = (await tailAgentLog(sandbox)).trim();
    throw new Error(`opencode failed to start${log ? `: ${log.slice(-1200)}` : " (no log)"}`);
  }

  // ── Live preview: started ON DEMAND, BUILD shape only ───────────────────────────────────────────
  //
  // The founder watches their app build in real time — but only if they OPEN the workspace. Booting a
  // long-lived `next dev` (which first has to `npm install`, node_modules is never seeded) in every
  // build, watched or not, spends real sandbox time and CPU on a preview nobody looks at. So the run
  // exposes a `startPreview` on its registry handle and the cloud calls it (POST /tasks/:id/preview)
  // when the Preview tab opens. Idempotent, fire-and-forget, and on a DEDICATED port (not 3000 — that
  // would false-green the verify step's throwaway dev server). LIFETIME: dies with the sandbox.
  let previewStarted = false;
  const startPreview =
    profile.shape === "build" && ws
      ? async () => {
          if (previewStarted) return;
          previewStarted = true;
          void sandbox
            .spawn(
              `cd ~/${ws.dir} && npm install --no-audit --no-fund && ` +
                `PORT=${PREVIEW_PORT} npm run dev > /tmp/preview.log 2>&1`,
            )
            .then(async () => {
              try {
                // previewUrl just mints the URL; it is reachable once dev binds, and the founder's
                // iframe retries until then — so emitting immediately is correct.
                const preview = await sandbox.previewUrl(PREVIEW_PORT);
                await ctx.emit("preview.ready", { url: preview.url, token: preview.token, port: PREVIEW_PORT });
              } catch {
                /* best-effort: a preview that cannot be reached is not a build failure */
              }
            })
            .catch(() => {});
        }
      : undefined;

  // 4 + 5. Session + stream, under one finally that always revokes the proxy grant and clears
  // the abort watcher — even if session setup throws.
  const abort = new AbortController();
  let abortWatch: ReturnType<typeof setInterval> | undefined;
  /** Polls for a schema-valid `output/result.txt`; see the comment where it is armed. */
  let contractWatch: ReturnType<typeof setInterval> | undefined;
  /** The contract-satisfying artifact, once one exists. Non-empty means the run is over. */
  let satisfied = "";
  let finalText = "";
  let done = false;
  let mapper: OpenCodeEventMapper | undefined;
  try {
    if (ctx.shouldAbort()) throw new Error(`aborted: ${ctx.shouldAbort()}`);
    const sessionId = await oc.createSession(`mycel-${task.id}`);
    mapper = new OpenCodeEventMapper(sessionId);

    // Publish a live handle so a founder can steer this build and read its file tree while it runs.
    // Deregistered in the finally below on every exit path; the sandbox dies with the run, so the
    // handle must never outlive it.
    registerRun({
      taskId: task.id,
      projectId: task.project_id,
      sessionId,
      oc,
      sandbox,
      model: promptModel,
      workspaceDir: ws?.dir,
      startPreview,
    });

    /**
     * SUBSCRIBE BEFORE PROMPTING. This ordering is the whole bug.
     *
     * `POST /session/:id/message` is synchronous — its body is the finished assistant message — so
     * the old sequence (await the prompt, then open /event) spent the entire run with nobody
     * listening and then attached to a session that had already gone quiet. A production task burnt
     * 165,000 tokens and left four events in the log, none of them from the agent.
     *
     * `openEvents` does the HTTP handshake before it returns, so by the time the prompt is accepted
     * the stream is live. `startPrompt` then uses `prompt_async`, which answers 204 immediately, so
     * the loop below is free to consume the stream while the turn runs.
     */
    const stream = await oc.openEvents(abort.signal);

    abortWatch = setInterval(() => {
      if (ctx.shouldAbort()) abort.abort();
    }, 1000);
    (abortWatch as { unref?: () => void }).unref?.();

    /**
     * THE CONTRACT ENDS THE RUN.
     *
     * OpenCode's `session.idle` is the agent deciding it is finished. That is not the same question
     * as "is the work done", and the gap between them is expensive. A production `chase_invoice`
     * run wrote a schema-valid `output/result.txt` at 22:17:29 — five minutes in, correct answer,
     * everything the task asked for — and then spent the next twenty minutes re-reading
     * `dunning-policy.md` in a loop until the runtime ceiling killed it. The task was recorded as
     * `expired` with `max_runtime_exceeded`. The customer would have been told their invoice chase
     * failed, while the finished result sat on disk inside a sandbox we then deleted.
     *
     * So the harness stops watching the agent and starts watching the artifact. The moment the file
     * parses and satisfies the wedge's own output schema, the contract is met and there is nothing
     * left to buy by continuing. This is the thesis in one interval: the contract is the hard
     * artifact, the agent is replaceable, and neither one gets to decide when it is done.
     *
     * ONLY WITH A SCHEMA. Without one `validateOutput` returns ok for any bytes at all, so the first
     * partial write of a half-built file would end the run. No schema means no defensible finish
     * line, and we fall back to waiting for idle.
     *
     * Polling rather than watching a `tool.result`: the agent may write that file with `bash`,
     * `write`, `patch`, or a script that shells out, and a matcher over tool names would miss the
     * spellings we did not think of. One exec every six seconds against a sandbox is free next to
     * one wasted model turn.
     */
    const contractSchema = outputSchemaFor(task, wedge);
    if (contractSchema && typeof contractSchema === "object") {
      /**
       * What was already at that path before this agent wrote anything.
       *
       * Normally nothing. But the sandbox snapshot, a wedge's mounted inputs, or a blueprint's
       * scaffolding could all put a file there, and a PLACEHOLDER that happens to satisfy the schema
       * would end the run on its first tick — shipping template text to a customer as their
       * deliverable and reporting success. Anything already present is disqualified by identity, so
       * the run can only finish on something this agent actually produced.
       */
      const baseline = await sandbox.readFile("output/result.txt").catch(() => null);
      let reading = false;
      contractWatch = setInterval(() => {
        // Never overlap execs — `readFile` is a command round-trip into the sandbox, and a slow one
        // under load would otherwise stack up a queue of identical reads.
        if (reading || satisfied) return;
        reading = true;
        void sandbox
          .readFile("output/result.txt")
          .then((raw) => {
            if (!raw || satisfied || raw === baseline) return;
            if (!validateOutput(raw, contractSchema).ok) return;
            satisfied = raw;
            // Stop the agent spending immediately, rather than at the next stream event. The loop
            // below still owns the exit; this only stops the meter.
            void oc.abort(sessionId).catch(() => {});
          })
          .catch(() => {
            // The file not existing yet is the overwhelmingly common case and is not news.
          })
          .finally(() => {
            reading = false;
          });
      }, 6000);
      (contractWatch as { unref?: () => void }).unref?.();
    }

    try {
      /**
       * THE SCHEMA IS ENFORCED HERE, NOT BY OPENCODE. THE TWO HALVES NOW AGREE.
       *
       * This used to pass `format: {type:"json_schema", schema, retryCount: 2}` for strict-output
       * profiles, and there were two contradictory comments about what that did. Both were wrong;
       * the pinned binary settles it, and the evidence is written out in `startPrompt` in
       * opencode.ts. In one line: 1.17.6 DOES honour `format`, by injecting a `StructuredOutput`
       * tool and forcing `toolChoice: "required"`, putting the answer somewhere our event mapper
       * cannot see and killing any run that answers in prose instead.
       *
       * OBSERVED IN PRODUCTION: five consecutive fresh signups, 0% success. A shaping run read its
       * skill, read its knowledge, planned three todos, worked for two minutes and died on
       * `opencode StructuredOutputError: Model did not produce structured output` — having already
       * produced the correct answer, in the place the prompt told it to put it.
       *
       * So there is now ONE rule about where the answer belongs, and all three mechanisms state it:
       *
       *   · `buildPrompt` inlines the schema and tells a strict run its final message IS the
       *     deliverable (one model sampling, not two — see the note on `closing`).
       *   · `runTask` validates that answer against the same schema and throws if it does not
       *     conform, so nothing unverified reaches a customer.
       *   · `contractWatch` above still accepts a schema-valid `output/result.txt` if the agent
       *     writes one anyway, and ends the run early when it does.
       *
       * None of those can silently succeed on an empty answer, which `format` could.
       */
      await oc.startPrompt(
        sessionId,
        buildPrompt(task, wedge, profile, grounding.files.length, docCount, ws?.dir),
        promptModel,
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

    // The agent's own phase. Without it every tool call and every token in the run hangs off
    // `start_opencode` in the trace, which reads as if booting the server took four minutes.
    await ctx.emit("step.started", { step: "agent" });

    try {
      for await (const ev of stream) {
        const reason = ctx.shouldAbort();
        if (reason) {
          await oc.abort(sessionId);
          throw new Error(`aborted: ${reason}`);
        }
        // Checked before `foreign`, so a heartbeat is enough to carry us out. That matters: during
        // a long model turn heartbeats may be the only traffic on the stream.
        if (satisfied) {
          await ctx.emit("progress", {
            note: "contract satisfied — output/result.txt validates against the task schema; ending the run",
          });
          done = true;
          await oc.abort(sessionId);
          break;
        }
        if (mapper.foreign(ev)) continue;

        const mapped = mapper.map(ev);
        for (const e of mapped.emissions) await ctx.emit(e.type, e.data);
        if (mapped.usage) chargeUsage(ctx, model, tier, mapped.usage);
        if (mapped.error) throw new Error(mapped.error);
        if (mapped.done) {
          done = true;
          await oc.abort(sessionId);
          break;
        }
      }
      finalText = mapper.finalText;
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
      /**
       * THE THIRD PLACE THIS EXACT MISTAKE WAS MADE. `/tmp/opencode.log` is only the stdout the
       * harness redirects, and opencode's stdout is its startup banner and nothing else.
       *
       * OBSERVED IN PRODUCTION, minutes after the bind-address fix went out: a shaping run died
       * eight seconds into the agent step and told the founder
       * `opencode ended before completing: opencode server listening on http://0.0.0.0:4444` —
       * a failure reported by quoting a success, for the second time in one walkthrough, from a
       * different line. The stream ending with no completion signal is the case where the cause is
       * hardest to guess and the real log matters most (OOM is the known one; see remotebuild.ts).
       *
       * `tailAgentLog` reads opencode's own log directory as well as the banner, and names the file
       * each chunk came from. Every failure path in this file now goes through it.
       */
      const log = (await tailAgentLog(sandbox)).trim();
      throw new Error(`opencode ended before completing${log ? `: ${log.slice(-1200)}` : ""}`);
    }
  } finally {
    deregisterRun(task.id);
    if (abortWatch) clearInterval(abortWatch);
    if (contractWatch) clearInterval(contractWatch);
    if (nonce) await revokeGrant(nonce);
    if (actionNonce) await revokeActionGrant(actionNonce);
    if (buildNonce) await revokeBuildGrant(buildNonce);
    // Reported from the `finally` so it survives the failure path too. A run that failed BECAUSE
    // the protocol moved is precisely the run whose drift counter is worth reading.
    const drift = mapper?.unmapped;
    if (drift && Object.keys(drift).length) ctx.onDrift?.(drift);
  }

  // 6. The artifact that MET THE CONTRACT wins outright — it is the thing we verified, and the
  //    agent's closing prose ("I've written the final notice to output/result.txt") would otherwise
  //    replace a schema-valid document with a sentence about it. Otherwise prefer the streamed final
  //    text, and fall back to whatever the agent left on disk.
  if (satisfied) return { text: satisfied };
  if (!finalText) finalText = (await sandbox.readFile("output/result.txt")) ?? "";
  return { text: finalText };
}

/** The schema this run must answer in, if any. Wedge task_type first, then the task's own. */
function outputSchemaFor(task: Task, wedge: LoadedWedge | null): unknown {
  return wedge?.manifest.task_types?.[task.task_type]?.output_schema ?? task.output_schema;
}

/** Which of the wedge's skills this task type gets. Undefined `profile.skills` means all of them. */
function profileSkills(
  wedge: LoadedWedge | null,
  profile: HarnessProfile,
  live: Array<{ name: string; content: string; updated_at?: string; metadata?: Record<string, unknown> }> = [],
  taskType?: string,
  library: WedgeFile[] = [],
) {
  // The wedge's own skills, plus shared-library skills for its domains that it does not already
  // define. Merged BEFORE overlay so a library skill gets task-type filtering and can be disabled by
  // a tenant overlay, and so a wedge's own skill of the same name wins outright.
  const own = new Set((wedge?.skills ?? []).map((s) => (s.name.endsWith(".md") ? s.name : `${s.name}.md`)));
  const disk = [...(wedge?.skills ?? []), ...library.filter((s) => !own.has(s.name.endsWith(".md") ? s.name : `${s.name}.md`))];
  const all = overlayPlaybooks(disk, live, taskType);
  const filtered = !profile.skills
    ? all
    : all.filter((s) => {
        const wanted = new Set(profile.skills!.map((name) => (name.endsWith(".md") ? name : `${name}.md`)));
        return wanted.has(s.name);
      });
  // Generated from the executor table, never from a markdown file they could drift. An overlay of
  // the same name is dropped so a prompt cannot widen the composer.
  if (wedge?.manifest.provides?.includes("outreach")) {
    const conscience = { name: "what-we-can-do.md", content: describeForAgent() };
    return [conscience, ...filtered.filter((s) => s.name !== conscience.name)];
  }
  return filtered;
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
function buildPrompt(
  task: Task,
  wedge: LoadedWedge | null,
  profile?: HarnessProfile,
  // How many knowledge files were actually mounted. Defaults to the wedge's own count so the
  // existing call sites (and the prompt tests) behave exactly as before; the runtime passes the
  // retrieved count, because pointing the agent at ./knowledge/ when retrieval mounted nothing
  // sends it to read an empty directory.
  mountedKnowledge?: number,
  /** How many task documents were written into ./inputs/. Zero means the directory does not exist. */
  mountedDocuments = 0,
  /** The deliverable directory, when this task type declares one. Named in the closing instruction. */
  workspaceDir?: string,
): string {
  const tt = wedge?.manifest.task_types?.[task.task_type];
  const outputSchema = outputSchemaFor(task, wedge);
  const shape = profile?.shape ?? "general";
  const strict = profile?.strict_output ?? false;

  /**
   * A STRICT RUN HANDS ITS ANSWER OVER IN ONE TURN. THE FILE IS NOT ASKED FOR.
   *
   * History, because this line has now been wrong in two different directions.
   *
   * First it said both "your final message must be ONLY the JSON result" and "state it as your last
   * message AND ALSO write it to ./output/result.txt". Those cannot both be obeyed — writing a file
   * is an action, and an action means the last message is not only JSON. A production onboarding run
   * produced a 446-token answer in fourteen seconds, then filled the remaining two minutes with
   * `true` and `pwd` because it could not work out how it was allowed to hand the answer over.
   *
   * The fix for that ORDERED the pair: write FIRST, reply second. That is obeyable, and it is what
   * has been killing onboarding ever since, because of what a tool call costs at production latency.
   * The `decide` profile denies `write` and `edit`, so "write the JSON to a file" can only be a
   * `bash` heredoc — and a tool call ends the assistant turn. The model must therefore be sampled
   * TWICE: once to emit the heredoc, once to repeat the same JSON as prose. In production a single
   * completion measures 85–95 seconds (LiteLLM; the ALB idle timeout was raised 60 → 300 for exactly
   * this), so the mandatory second sampling is not overhead, it is a doubling. Fourteen `mycel:run`
   * tasks over one week: p50 175s, and four of them finished at 180.1s, 180.2s, 180.6s and 180.8s —
   * the `draft_shape` ceiling, to the tenth of a second. Half of every founder's first screen was a
   * coin flip against a budget written when a completion took ten seconds.
   *
   * So the instruction is singular now and the deliverable is the final message — which is what
   * `runOpenCodeTask` already falls back to and what `runTask` already validates. One sampling, no
   * tool call, roughly 90s instead of roughly 180s.
   *
   * The contract watcher stays armed. It is no longer the intended path, but an agent that writes the
   * file anyway still gets the deterministic early finish it was built for, at the price of one
   * sandbox exec every six seconds. Giving that protection up to save nothing would be the wrong
   * trade.
   */
  const closing =
    shape === "build"
      ? // The directory is repeated here, in the prompt, and not left to AGENTS.md alone. The run
        // that built in `/root` had a system prompt telling it to build "in this workspace" and a
        // user prompt that never mentioned a path; whichever of the two it was reading, the answer
        // has to be the same.
        (workspaceDir
          ? `Work in \`~/${workspaceDir}\` — that directory is the deliverable and everything outside ` +
            `it is discarded. `
          : "") +
        `Do the real work: change the code, run it, and check it works before you say it does. ` +
        `When finished, write a summary of what you changed and why to ./output/result.txt, then ` +
        `give that same summary as your last message.`
      : strict
        ? `Do the real work, then reply with exactly the JSON result and nothing else. Your final ` +
          `message IS the deliverable and it is validated against the schema above, so hand it over ` +
          `directly — do not write it to a file first, and do not announce it before you send it.`
        : `Do the real work. When finished, write the final result to ./output/result.txt, then ` +
          `state that same result plainly as your last message.`;

  return [
    tt?.description ? `Goal: ${tt.description}` : `Task type: ${task.task_type}`,
    `Input: ${JSON.stringify(task.input)}`,
    (mountedKnowledge ?? wedge?.knowledge.length ?? 0) > 0
      ? `Your knowledge base is in ./knowledge/ — read the relevant files before acting.`
      : "",
    /**
     * ONLY MENTIONED WHEN DOCUMENTS WERE ACTUALLY MOUNTED, exactly like the knowledge line above.
     *
     * This used to be unconditional, and `./inputs/` does not exist when a task carries no
     * documents — which is most tasks. So the agent was told about a directory, went to look, and
     * got `ripgrep execution failed` from `glob` and `File not found` from `read`. A production
     * onboarding run spent SEVENTY of its one hundred and eighty seconds on that hunt — `glob
     * inputs/**`, `read /root/inputs`, `ls -la /root && ls -la /`, `pwd` — and then expired without
     * ever answering the question it was asked. The same detour is visible in the invoice runs.
     *
     * Pointing an agent at something that is not there is worse than saying nothing: it cannot tell
     * "this is empty" from "I am looking in the wrong place", so it keeps looking. The budget it
     * burns doing that is the budget the actual work needed.
     */
    mountedDocuments > 0
      ? `Documents uploaded for this specific task are in ./inputs/ — read them before acting.`
      : "",
    /**
     * THE SCHEMA IS ALWAYS IN THE PROMPT, INCLUDING UNDER STRICT OUTPUT.
     *
     * It used to be omitted when `strict` was set, on the reasoning that opencode's own
     * `format: json_schema` already constrains the model, so restating it in prose was wasted
     * tokens. That left a strict-output run ordered to emit nothing but JSON and never shown the
     * shape. `runTask` then throws on the validation failure and the whole run is wasted; worse,
     * once a run could also END on schema satisfaction, the same gap made a run that can never
     * finish — burning to the runtime ceiling looking for a target it was never given.
     *
     * The reasoning was also factually wrong about the mechanism, in a way that took a 0%-success
     * production week to find. `format` IS honoured by the pinned 1.17.6 binary, and honouring it
     * is what was killing these runs; the harness no longer sends it at all. See `startPrompt` in
     * opencode.ts for what the binary does and the evidence for it.
     *
     * So the prose schema is not a belt-and-braces restatement of something else. It is the ONLY
     * statement of the contract the model ever sees, and it goes in unconditionally.
     */
    outputSchema ? `Return a result conforming to this schema: ${JSON.stringify(outputSchema)}` : "",
    /**
     * THE REQUIRED FIELDS, NAMED, AS A FLAT TOP-LEVEL OBJECT.
     *
     * The schema is in the prompt above, but a required list buried in a nested JSON Schema is easy for
     * a model to under-read — a live shaping run on gpt-5.6-luna came back with every required field
     * "missing", the answer nested one key deep. Repeating the top-level required names in plain prose,
     * and telling the model NOT to wrap the object, is the cheap half of stopping that (repair.ts is the
     * safety net for when it happens anyway). Named only under `strict`, where the final message IS the
     * validated deliverable.
     */
    strict && requiredNames(outputSchema).length
      ? `Your JSON must be a single flat object with every one of these top-level fields present — ` +
        `do not omit any and do not nest the answer under another key: ${requiredNames(outputSchema).join(", ")}.`
      : "",
    strict ? `Your final message must be ONLY the JSON result — no preamble, no code fences.` : "",
    closing,
  ]
    .filter(Boolean)
    .join("\n");
}

/** The top-level `required` field names of an output schema, or `[]` when there are none. */
function requiredNames(schema: unknown): string[] {
  const req = (schema as { required?: unknown } | null)?.required;
  return Array.isArray(req) ? req.filter((r): r is string => typeof r === "string") : [];
}

/**
 * One line describing what a file is for, for the indexes in AGENTS.md.
 *
 * Prefers a `description:` in frontmatter — the convention every skill in this repo follows — and
 * falls back to the first real sentence, because a file written without frontmatter should still be
 * findable rather than silently unlabelled. Knowledge files use it too: they are markdown written by
 * a founder or distilled from a correction, and their first line of prose is what they are about.
 */
function fileSummary(content: string): string {
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
  // What retrieval chose for this run. Optional for the same reason: a caller with no store in hand
  // (tests, tooling) gets the pre-retrieval prompt rather than a type error.
  grounding?: Grounding,
  /**
   * The directory that IS the deliverable, what was seeded into it, and whether `mycel-build` was
   * actually installed. See `workspaceSection` and `remoteBuildToolDoc`.
   */
  workspace?: { ws: ResolvedWorkspace; seeded?: SeedOutcome; buildTool?: boolean },
  /**
   * What each granted Composio connection can actually do — slugs, arguments, return values.
   *
   * Optional, and absent means the old prose. That fallback is load-bearing rather than tidy: a run
   * whose Composio catalogue fetch failed still gets a usable prompt describing the action proxy,
   * and the alternative (no connection section at all) would tell an agent its mailbox does not
   * exist because a metadata request timed out.
   */
  tools?: ConnectionTools[],
  /**
   * ~400 characters saying what the company brain HOLDS, without holding it. See `digestFor`.
   * Optional and absent by default, so a caller with no stores gets the pre-brain prompt.
   */
  brainDigest?: string,
  /**
   * Capabilities this wedge declares that NOTHING in this project provides, as sentences.
   *
   * Told to the agent up front rather than discovered by trying, because the alternative is what
   * this repo keeps paying for: a run that reaches for a mailbox that is not there, gets a rejection
   * it reads as a transient error, retries, and finally reports a chase as sent. An agent that is
   * told "there is no mailbox connected" writes the draft and says it could not send it, which is
   * the honest outcome and the one a founder can act on.
   */
  capabilityGaps: string[] = [],
  /**
   * Skills already overlaid and filtered for this run. When omitted, rebuilt from the wedge —
   * tests and tooling that do not have live knowledge still get the shipped files.
   */
  mountedSkills?: { name: string; content: string }[],
): string {
  const parts: string[] = [];
  parts.push(`# ${wedge?.manifest.title ?? `Mycel agent — ${task.wedge}`}`);
  parts.push("");
  parts.push(`You are fulfilling a "${task.task_type}" task for the "${task.wedge}" wedge.`);
  parts.push("");
  parts.push(
    `If a person describes wanting to harm themselves or end their life: refuse to help with methods, ` +
      `say you are not a crisis service, and tell them to contact local emergency services or the 988 ` +
      `Suicide & Crisis Lifeline (call or text 988 in the US). Do not discuss means. Then continue ` +
      `the work they actually hired you for, or stop if the message is only that.`,
  );

  /**
   * Said once, at the top, because a schema error is not self-correcting.
   *
   * A production run called `bash` seventy-two times, almost every one rejected with
   * `SchemaError: Missing key ["description"]`, never adapting, until the task expired having
   * produced nothing. Every rejection cost a model call. The tool's own error text names the
   * missing field and the model still did not supply it — so the fix is to say it before the first
   * attempt rather than hope the loop teaches it.
   *
   * Cheap insurance: one line of prompt against an entire wasted run.
   */
  if (profile.tools.bash !== false) {
    parts.push(
      `The \`bash\` tool requires BOTH \`command\` and \`description\` — a one-line description of ` +
        `what the command does. Omitting \`description\` is rejected, and retrying without it fails ` +
        `again.`,
    );
  }
  if (profile.shape === "build") {
    parts.push(
      `This is a BUILD task: you are constructing or altering software in this workspace. Read the ` +
        `code before you change it, make the change, and verify it actually runs. Write deliverables ` +
        `to ./output/.`,
    );
    if (workspace) parts.push(...workspaceSection(workspace.ws, workspace.seeded));
    // Documented ONLY when the script is really in the sandbox. A tool an agent is told about and
    // cannot run costs it turns and costs us the credibility of everything else in this file.
    if (workspace?.buildTool) parts.push(...remoteBuildToolDoc(workspace.ws.dir));
    // Same switch, same grant, same rule: documented only when the script is really in the sandbox.
    if (workspace?.buildTool) parts.push(...insightToolDoc());
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
  /**
   * WHAT THIS BUSINESS HAS TAUGHT THE AGENT — inline, near the top, and deliberately unlike skills.
   *
   * Skills are indexed rather than inlined because they are long, procedural, and only one of them
   * is relevant. Rules are the opposite: a handful of lines, each one already selected as relevant
   * to THIS task type and THIS client by retrieval, and — the part that decides it — a prohibition
   * the agent never bothered to open is a prohibition that did not work. "Never mention the discount
   * to this client" has to be read before the draft, not after a decision to go looking.
   *
   * They come before the procedures for the same reason: house rules override the general method.
   */
  if (grounding?.rules.selected.length) {
    parts.push("");
    parts.push(`## What this business has taught you`);
    parts.push(
      `These were learned from corrections a human actually made on real jobs here — not general ` +
        `advice, and not your own conclusions. They override the procedures below. Where a correction ` +
        `shows what was drafted and what was sent, match the second.`,
    );
    parts.push("");
    parts.push(grounding.rules.markdown);
    if (grounding.rules.dropped) {
      // Said out loud. An agent that believes it has been given everything will act on a partial
      // picture with full confidence, which is the more expensive of the two failures.
      parts.push("");
      parts.push(
        `(${grounding.rules.dropped} further rule(s) exist for this wedge but did not fit this run's ` +
          `budget. If something here seems to contradict what you were told elsewhere, ask rather than pick.)`,
      );
    }
  }

  /**
   * The knowledge files, INDEXED — the same argument as skills, and the reason this section exists.
   *
   * The files are on disk either way. What changed is that the agent is now told what is there and
   * what each one is for, so it opens the pricing note because it needs pricing rather than reading
   * nine files hoping. The index is one line per file and the list is already capped by retrieval,
   * so this section does not grow with the business the way the mount did.
   */
  if (grounding?.files.length) {
    parts.push("");
    parts.push(`## What this business knows`);
    parts.push(
      `In ./knowledge/. Open the ones that bear on this job — they are this business's own facts, ` +
        `policies and examples, and they beat your general knowledge whenever they disagree.`,
    );
    parts.push("");
    for (const f of grounding.files) {
      parts.push(`- \`knowledge/${f.name}\` — ${fileSummary(f.content)}`);
    }
    if (grounding.omitted_files) {
      parts.push("");
      parts.push(
        `(${grounding.omitted_files} older or less relevant knowledge file(s) were not attached to ` +
          `this run. If you need something that isn't here, say so rather than assuming it doesn't exist.)`,
      );
    }
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
        `Every result you get back is BOUNDED — long lists are headed and counted, big values are\n` +
        `clipped. If a result carries \`"truncated": true\`, read the \`note\`: you did NOT see\n` +
        `everything, and reporting the part you saw as the whole is the mistake to avoid. Narrow the\n` +
        `request and call again.\n\n` +
        `Available connections:`,
    );
    for (const c of connections) parts.push(`- **${c.name}** (${c.kind}) — id \`${c.id}\``);

    /**
     * WHAT EACH CONNECTION CAN DO, by name, with arguments.
     *
     * Before this, the section above was the whole story: a name, a kind, an id, and an instruction
     * to POST to `$MYCEL_ACTIONS_URL/<capability>`. The capability IS the Composio tool slug, and
     * nothing in the prompt ever said what the slugs were — so the agent guessed, the proxy
     * rejected the guess, and the run reported that it could not create the invoice while a fully
     * authorised Xero sat one correct string away. See composio.tools.ts for the selection rule
     * that keeps this section from becoming a thousand schemas.
     */
    if (tools?.length) {
      parts.push("");
      parts.push(`### What these connections can do`);
      parts.push(
        `These are the tools available on this run, with their real slugs. Use a slug EXACTLY as\n` +
          `written — a guessed slug is rejected, not corrected. Anything marked "needs approval"\n` +
          `pauses for a human; anything marked "read" runs immediately.`,
      );
      parts.push(...renderToolContext(tools));
      parts.push("");
      parts.push(
        `Most of these are also mounted as native tools you can call directly (they appear with a\n` +
          `\`mycel_\` prefix). Calling one is equivalent to the \`curl\` above and passes the same\n` +
          `human approval gate — prefer it, because you cannot mistype the endpoint.`,
      );
    }
  }

  /**
   * WHAT THIS RUN CANNOT DO. Outside the `connections.length` block on purpose — a project with
   * nothing connected at all is exactly the case that needs to be told, and it is the case where
   * there is no "Taking real-world actions" section to hang it off.
   */
  if (capabilityGaps.length) {
    parts.push("");
    parts.push(`## What you cannot do on this run`);
    parts.push(
      `This wedge normally uses these and they are not connected for this business. Do the part of ` +
        `the job you can, and SAY plainly in your result which step you could not complete and why. ` +
        `Do not describe a step you could not take as done, and do not look for another way round.`,
    );
    parts.push("");
    for (const g of capabilityGaps) parts.push(`- ${g}`);
  }
  /**
   * THE COMPANY BRAIN.
   *
   * Before the gap section on purpose: "ask the founder" is the fallback for what the business has
   * never written down, and this is the thing that already knows. A run that raises a gap for "how
   * much does Northwind owe us" is asking a human to read a database.
   *
   * The digest states what the brain HOLDS — counts only, no client, no amount, no sentence. That is
   * deliberately not an answer: it is the index, and it exists so the agent knows asking is cheap
   * and that silence would be a guess.
   */
  if (profile.grants_actions && brainDigest) {
    parts.push("");
    parts.push(`## What this business already knows`);
    parts.push(brainDigest);
    parts.push(
      "```bash\n" +
        `curl -s "$MYCEL_BRAIN_URL/ask" \\\n` +
        `  -H "authorization: Bearer $MYCEL_ACTION_TOKEN" -H "content-type: application/json" \\\n` +
        `  -d '{"q":"march invoice","sources":["invoices","threads"]}'\n` +
        `# then fetch one in full, using the source_ref a hit gave you:\n` +
        `curl -s "$MYCEL_BRAIN_URL/get" \\\n` +
        `  -H "authorization: Bearer $MYCEL_ACTION_TOKEN" -H "content-type: application/json" \\\n` +
        `  -d '{"source_ref":"invoices:…"}'\n` +
        "```\n" +
        `It only ever returns what THIS run is allowed to see; you cannot widen that from here, and\n` +
        `filters only narrow it. Every reply carries \`authority_excluded\` — if it is not zero, rows\n` +
        `exist that you may not read, so do not extrapolate from what you got. Raise a gap instead.`,
    );
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
  parts.push("");
  parts.push(`## Exact numbers and fan-out`);
  parts.push(
    `For billing-grade math, call an installed pack by name — never invent the arithmetic:\n` +
      "```bash\n" +
      `curl -s "$MYCEL_PACKS_URL" -H "authorization: Bearer $MYCEL_ACTION_TOKEN" \\\n` +
      `  -H "content-type: application/json" \\\n` +
      `  -d '{"pack":"share_of_voice@1","args":{...}}'\n` +
      "```\n" +
      `Wedge workflows (when declared) still live at \`$MYCEL_WORKFLOWS_URL/<name>\`.\n\n` +
      `To fan out many sibling jobs and wait for them to finish (query×model, N locales), open a batch:\n` +
      "```bash\n" +
      `curl -s "$MYCEL_BATCHES_URL" -H "authorization: Bearer $MYCEL_ACTION_TOKEN" \\\n` +
      `  -H "content-type: application/json" \\\n` +
      `  -d '{"join":"all","children":[{"task_type":"…","input":{…}}]}'\n` +
      "```\n" +
      `That parks THIS run until the children join. Do not keep working after you open a batch.`,
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
  const skills = mountedSkills ?? profileSkills(wedge, profile);
  if (skills.length) {
    parts.push("");
    parts.push(`## Procedures`);
    parts.push(
      `Written up in ./skills/. Read the one that fits the job before you start — they are how this ` +
        `business does the work, not general advice. Don't read them all.`,
    );
    parts.push("");
    for (const s of skills) {
      parts.push(`- \`skills/${s.name}\` — ${fileSummary(s.content)}`);
    }
  }
  return parts.join("\n");
}

/**
 * WHERE THE WORK GOES, stated once and unambiguously.
 *
 * The failure this exists to prevent is bug #3 of three, and it is the cheapest of them to fix and
 * the most expensive to leave. Task e4dbc13f was told "construct or alter software in this
 * workspace" — a sentence containing no directory. It built in `/root`, `~/app` was never created,
 * the export found nothing, and half an hour of `deep`-tier tokens were spent on files that were
 * deleted when the microVM was.
 *
 * So: name the directory, say what is already in it, and say plainly what happens to everything
 * outside it. The last part is the one an agent cannot infer — from inside the sandbox, `/root/foo`
 * and `/root/app/foo` look equally permanent.
 *
 * The verify command is disclosed for the same reason. The kernel runs it after the agent stops
 * (see `verifyWorkspace`), and an agent that does not know the exam exists cannot sit it; one that
 * does will run it itself, find the error while it still has turns left, and fix it.
 */
function workspaceSection(ws: ResolvedWorkspace, seeded?: SeedOutcome): string[] {
  const parts: string[] = [];
  parts.push("");
  parts.push(`## Your workspace is \`~/${ws.dir}\``);
  parts.push(
    `**Everything you build must live under \`~/${ws.dir}\`.** That directory is the deliverable: it ` +
      `is archived when you stop and handed to the customer. Anything you write anywhere else in ` +
      `this sandbox — your home directory, /tmp, a folder you invent — is DELETED and nobody ever ` +
      `sees it. \`cd ~/${ws.dir}\` before you start.`,
  );
  if (seeded?.root && seeded.written > 0) {
    parts.push("");
    parts.push(
      `It is not empty. A working application (${seeded.written} files) is already there — ` +
        `\`package.json\`, \`app/\`, \`components/\`, \`lib/\`. **Read it before you write anything.** ` +
        `Your job is to EXTEND this app, not to replace it or start a new one beside it. Match the ` +
        `conventions you find; do not introduce a second styling system or a second way of talking ` +
        `to the kernel.`,
    );
    parts.push(
      `Dependencies are NOT installed (\`node_modules\` is never shipped into or out of here). Run ` +
        `\`npm install\` in \`~/${ws.dir}\` first — nothing will run until you do.`,
    );
  } else {
    // Honest about the degraded case rather than describing files that are not there. An agent sent
    // to read a scaffold that does not exist burns turns proving it.
    parts.push("");
    parts.push(`It is currently EMPTY — there is no scaffold on this run. You are starting from nothing.`);
  }
  if (ws.verify) {
    parts.push("");
    parts.push(
      `**You will be marked on this, by a machine, not on your description of it.** When you stop, ` +
        `the kernel runs \`${ws.verify}\` in \`~/${ws.dir}\`. If it exits non-zero the task FAILS and ` +
        `nothing is delivered, whatever your final message says. Run it yourself and fix what it ` +
        `reports, before you finish.`,
    );
  }
  return parts;
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
 * Turn one usage increment into a charge, with the counts and the model kept ON the event.
 *
 * Both halves of this used to be thrown away. `runtime.ts` called `estimateCost` and passed only
 * the dollars to `onCost`, so `cost.charged` carried `{cost_usd, reason}` and a trace could report
 * how many CHUNKS were streamed but not how many tokens were spent, nor on what. `traces.ts` says
 * so in a comment on `token_deltas`; it was right, and this is the other end of that complaint.
 *
 * OpenCode's own `cost` is preferred when it is non-zero — it prices against the provider's real
 * table, which is better than ours can be. In proxy mode the provider is `mycel`, a custom
 * openai-compatible entry with no pricing, so `cost` is 0 and the tier table below is the only
 * number available. Preferring theirs and falling back to ours is what keeps both modes honest.
 */
function chargeUsage(ctx: RuntimeCtx, model: string, tier: ModelTier, usage: UsageDelta): void {
  const usd = usage.cost_usd > 0 ? usage.cost_usd : estimateCost(model, usage.input, usage.output);
  ctx.onCost(usd, {
    model,
    tier,
    tokens: {
      input: usage.input,
      output: usage.output,
      reasoning: usage.reasoning,
      cache_read: usage.cache_read,
      cache_write: usage.cache_write,
    },
    // Where the dollars came from. A run priced by our table and one priced by the provider are
    // different kinds of claim, and an invoice dispute turns on which one this was.
    reason: usage.cost_usd > 0 ? "model" : "model_estimated",
  });
}

/**
 * What a token count costs, from the price table the rest of the system already uses.
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
 * It also used to take a `usage` bag and dig for `input_tokens | inputTokens | prompt_tokens` —
 * none of which OpenCode has ever sent. Its real shape is `tokens: {input, output, reasoning,
 * cache:{read,write}}`, so every one of those lookups returned undefined and every run in the
 * system's history was priced at exactly $0.00. Taking two numbers means a caller cannot get the
 * key names wrong again.
 *
 * Falls back to the standard tier for an unrecognised model. Over-estimating an unknown model
 * throttles a customer early, which is recoverable; under-estimating means serving work at a loss
 * and finding out on the invoice.
 */
function estimateCost(model: string, input: number, output: number): number {
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

/**
 * Test seam: pricing and the metadata that rides with it are the difference between a trace that
 * can answer "which model, how many tokens" and the one we shipped, which could answer neither.
 */
export const chargeUsageForTest = chargeUsage;
