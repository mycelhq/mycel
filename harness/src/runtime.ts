// The agent runtime: run one Mycel task by driving OpenCode inside a sandbox, mapping
// OpenCode's event stream onto Mycel contract events. Stack, not custom loop — OpenCode IS
// the agent. A proven OpenCode harness flow
//
import { memorySection, recallForRun, type MemoryDoc } from "./memory";
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
import { gatherMaterials, materialsNote, type MaterialsResult } from "./materials";
import { getRequestStore } from "./requests";
import { recordSkillUses } from "./skill-scales";
import { SkillAttention } from "./skill-attention";
import { MAX_STEER_TURNS, STEER_TURN_START_MS, SteerQueue } from "./steer-queue";
import { registerRun, deregisterRun, getRun, type PreviewStatus } from "./runregistry";
// PREVIEW_PORT (4321, deliberately not 3000 — the verify step boots its own throwaway `next dev` on
// 3000) lives in sandbox.ts so DockerSandbox can publish it at acquire time. The port split does not
// by itself keep the two apart: Next 16 locks per DIRECTORY. See startPreview.
import { PREVIEW_PORT , SANDBOX_HOME } from "./sandbox";
import { groundRun, type Grounding, type GroundingFile } from "./knowledge";
import { deriveAuthority as deriveBrainAuthority, digestFor as brainDigestFor } from "./brain";
import { getBillingStore } from "./billing";
import { getKnowledgeStore } from "./knowledge.store";
import {
  buildComponentMcpConfig,
  buildOpencodeConfig,
  isAgentActivity,
  OpenCodeClient,
  OpenCodeEventMapper,
  openaiCompatibleBase,
  providerEnvVar,
  splitModel,
  type UsageDelta,
} from "./opencode";
import { buildGatePatterns, MYCEL_PLUGIN_CODE } from "./plugin";
import {
  brokeredCaveat,
  capabilityAdapter,
  isCapability,
  isDeclarableCapability,
  resolveCapability,
  whyNoProvider,
} from "./capabilities";
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
import { sharedCraft } from "./craft";
import type { MountedSkill } from "./compile";
import { criteriaAsPromptLines } from "./deliverable-criteria";
import { deliverableShapeAsSkill, readDeliverableShape, SHAPE_SKILL_FILE } from "./deliverable-shape";
import { IMAGE_TOOL_PATH, imageProviderFromEnv, imageToolDoc, imageToolScript } from "./imagetool";
import { CHECK_TOOL_PATH, checkToolDoc, checkToolScript } from "./checktool";
import { exemplarSkills, shippedExemplarSkills } from "./exemplar";
import { continuitySkills } from "./continuity";
import { practiceSkills } from "./practice";
import { priorBatchResults } from "./batches";
import { INTERNAL_VOCABULARY } from "./client-ready";
import { wedgeForRole } from "./roles";
import { getDeliverableStore } from "./deliverables";
import { describeInputContract } from "./input-contract";
import {
  arsenalSkillsFor,
  arsenalSkillsForBrief,
  latestServiceResearch,
  stagedArsenalForBrief,
  withDraftServiceArsenal,
} from "./skill-arsenal";
import { dealLessons, lessonsForPrompt } from "./deal-lessons";
import { listEnvelopes } from "./signing";
import { loadProjectWedge } from "./authored";
import { isPlaybookKnowledge, overlayPlaybooks } from "./playbooks";
import { armFor } from "./skill-trial";
import { describeForAgent } from "./linkedin/capabilities";
import { getIdentityStore, type Plan } from "./identity";
import { designSystemFilesFor, designSystemFor } from "./design-systems";
import { clearPreviewTarget, publishPreviewTarget } from "./preview-target";
import { challengerFor, escalatedTier, modelForTier, TIER_MODELS, TIER_PRICE, type ModelTier } from "./models";
import { PRESUB_PLAN } from "./presubscription";
import { keyForOrg, litellmEnabled } from "./litellm";
import { harnessProfileNote, resolveHarnessProfile, SHAPE_DEFAULTS, type HarnessProfile } from "./harness";
import { compile, describe, type Refusal } from "./compile";
import { lockedScript, resolveWorkspace, seedWorkspace, type ResolvedWorkspace, type SeedOutcome } from "./workspace";
import { buildBrowserUseMcp, qualified, BROWSERUSE_BRIEF, BROWSERUSE_DENIED, BROWSERUSE_TOOLS } from "./browseruse";
import { operateEgress, redactProxy, type EgressEnv } from "./operate-egress";
import { resolveSecret } from "./secrets";
import {
  browserTarget,
  browserUseConfig,
  domainLock,
  mayWrite,
  parseSession,
  refuseWrite,
  BROWSER_CONFIG_PATH,
  SESSION_PATH,
  type StorageState,
} from "./browser-work";
import { proxyPoolStatus } from "./linkedin/proxy-pool";
import { describeShipContract, readShipChecks, antiSlopRules } from "./ship-checks";
import { effectiveShipContract } from "./infer-checks";
import { describePackages, hasPackages, installScript, readPackages } from "./packages";
import { machineHeaders } from "./render/taste";
import { draftServiceInput } from "./offering";
import { type PinnedStyle, resolveStyle, styleForVersion } from "./house-style";
import {
  isTransientTurnError,
  newResumeBudget,
  nextResumeDelay,
  noteResume,
  resumeEnabled,
  resumePrompt,
} from "./turn-resume";

/** Same reasoning as `VERIFY_SCRIPT_PATH`: a script on disk has nothing for a foreign shell to eat. */
const PREVIEW_INSTALL_SCRIPT = ".mycel-preview-install.sh";
/** Same reasoning: a script on disk has nothing for a foreign shell to eat. */
const PACKAGE_INSTALL_SCRIPT = ".mycel-packages.sh";

/**
 * Which port should THIS opencode start bind?
 *
 * See the long "A PER-INVOCATION PORT" comment at the spawn site (and evals/product/ERROR-HUNT-LOG.md,
 * 2026-08-17): a single run calls `runOpenCodeTask` more than once (schema-retry, verify-repair),
 * each mints a FRESH HTTP Basic password, and the earlier `opencode serve` process outlives its
 * aborted session. On a FIXED port the lingering server (password A) intercepts the new client
 * (password B) → a persistent 401 until the 60s timeout. The pkill meant to prevent it is ineffective
 * in the Daytona microVM.
 *
 * So every non-docker start gets its OWN port: a lingering server on the old port can no longer be on
 * the socket the new client dials, which makes the password mismatch impossible by construction.
 * Docker is the exception — `DockerSandbox` publishes ONE inner port at acquire time and its
 * `previewUrl` ignores the argument, so a random inner port would be unreachable; it stays fixed and
 * relies on the (there-effective) pkill instead.
 *
 * Exported so the invariant is unit-testable without booting a real run: two calls for a non-docker
 * backend must not collide, and docker must stay pinned.
 */
export function pickOpencodePort(backend: string, basePort: number): number {
  if (backend === "docker") return basePort;
  return basePort + 1 + Math.floor(Math.random() * 4000);
}

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
  /**
   * A page describing how this business has actually handled work like this, mined from its own
   * case history. Empty when the run works no case, or when there is too little history to say.
   *
   * INJECTED, for the same reason `materials` is: building it needs the task store, which the
   * runtime does not hold. See `processSkillFor`.
   */
  /**
   * What the client has already handed over for this case, ready to mount into `./inputs/`.
   *
   * INJECTED, for the same reason `renderDocument` is: reading it needs the task store, the request
   * store and the artifact backend, and reaching for all three from here would make this module
   * untestable — every existing runtime test would need a database to construct a context.
   *
   * Optional, so a caller with nothing to offer (the chat surface, a mock run, every current test)
   * still type-checks. Absent means the run gets no client material, which is exactly what happens
   * today, so nothing regresses by omission.
   */
  materials?(): Promise<MaterialsResult | undefined>;
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
  /**
   * ═══ A CAPABILITY WHOSE DATA IS ALREADY IN THE TASK IS NOT MISSING ═══
   *
   * `satisfiedByInput` names the capabilities whose whole purpose — fetching something — has already
   * been done by the caller. A wedge declares which input field settles which capability
   * (`capability_inputs` in the manifest), and this is the resolved set for THIS task.
   *
   * The loop ran into this head-on. A monthly close was posted with sixteen transactions in
   * `input.transactions`, whose own contract says "THE LEDGER, ALREADY EXPORTED... no further
   * fetching is needed" — and the run still reported "no bank feed is connected to this business, so
   * the month cannot be reconciled automatically", asked the client for a bank statement it was
   * already holding, and delivered nothing.
   *
   * That is the platform demanding a connection to reach data it has in its hand. It is also the
   * shape of every migration and every backfill: a founder who exports a year of ledgers should not
   * be told to connect a bank feed before we will read them.
   */
  satisfiedByInput: readonly string[] = [],
): { ids: string[]; missing: string[] } {
  const ids: string[] = [];
  const missing: string[] = [];
  const supplied = new Set(satisfiedByInput);
  if (!projectId) {
    // No project means no tenant to resolve against, and resolving against "all of them" is the
    // cross-tenant leak this repo has shipped twice. A task with no project gets no capability
    // grants at all; a wedge that names connections directly is unaffected.
    // Every capability, not only the eleven: a declared one with no project is just as unresolvable
    // and the founder is owed the same sentence about it.
    return { ids, missing: capabilities.map((c) => whyNoProvider(c)) };
  }
  for (const name of capabilities) {
    /**
     * ═══ AN UNKNOWN NAME USED TO VANISH HERE, WITH NO GRANT AND NO SENTENCE ═══
     *
     * `continue` was correct while `CAPABILITIES` was the whole vocabulary — an unknown name could
     * only be a typo, already refused at manifest load. It stopped being correct when a service
     * became able to declare a need this kernel has never heard of and a connection became able to
     * answer it: a physiotherapy practice asking to read appointments got no connection, no
     * `missing` entry, and therefore no explanation anywhere.
     *
     * `resolveCapability` now answers both kinds, and a name that is neither known nor declarable is
     * still refused — loudly, in `missing`, rather than by silence.
     */
    if (!isCapability(name) && !isDeclarableCapability(name)) {
      missing.push(`"${name}" is not a capability this kernel can resolve — check the spelling.`);
      continue;
    }
    // Supplied in the task. No connection is needed and none is granted — the run reads the input,
    // which is what the input contract told it to do.
    if (supplied.has(name)) continue;
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

/**
 * The stored session for a browser connection, or `undefined` if this run may not have it.
 *
 * Three refusals, and every one of them returns `undefined` rather than throwing, because the run
 * should still happen — it just happens logged out, hits the portal's sign-in page, and says so.
 * That is a diagnosable outcome. A run killed at boot over a connection question is not.
 *
 *   1. WRONG TENANT. A browser session belonging to another project is the single worst thing on
 *      this path to hand out by accident, and the check is on the connection's own `project_id`
 *      rather than on anything the task input claims.
 *   2. WRITE INTENT AGAINST A READ CONNECTION. A task type that declares `browser_writes` refuses a
 *      connection the founder marked read-only. The alternative is discovering the mismatch by
 *      changing something in a client's live system, which is not a thing to discover.
 *   3. NO USABLE SESSION. A vault value that is not a storage state is a misconfiguration, not an
 *      empty session — see `parseSession`.
 */
async function sessionForRun(
  task: Task,
  target: ReturnType<typeof browserTarget> & object,
  wedge: LoadedWedge | null,
): Promise<StorageState | undefined> {
  const conn = await getDomainStore().getConnection(target.connection_id).catch(() => undefined);
  if (!conn || !task.project_id || conn.project_id !== task.project_id) return undefined;

  const writes = !!(wedge?.manifest.task_types?.[task.task_type] as { browser_writes?: boolean } | undefined)
    ?.browser_writes;
  if (writes && !mayWrite(target)) {
    console.warn(`[mycel] ${refuseWrite(target)}`);
    return undefined;
  }
  return parseSession(await resolveSecret(conn.secret_ref, conn.id));
}

/** The task type that writes a proposal. Named here because the prompt path reads it back. */
const DRAFT_ENGAGEMENT_TASK_TYPE = "draft_engagement";

/**
 * Read at prompt time, like the rest of the evidence on this path.
 *
 * These runs sit in a queue, and a deal that closed while this one was waiting is exactly the one
 * worth learning from. Fails soft: a proposal written without the lessons is the proposal this
 * product wrote before they existed, and a draft that fails because a lookup did is strictly worse.
 */
async function dealLessonsFor(projectId: string): Promise<Record<string, unknown> | undefined> {
  const envelopes = await listEnvelopes(projectId).catch(() => []);
  if (!envelopes.length) return undefined;
  return lessonsForPrompt(dealLessons(envelopes));
}

export async function runOpenCodeTask(
  task: Task,
  sandbox: Sandbox,
  ctx: RuntimeCtx,
): Promise<{
  text: string;
  capabilityGaps?: string[];
  missingArtifacts?: string[];
  /** Declared files that exist and do not parse — see `malformedArtifacts`. */
  brokenArtifacts?: string[];
}> {
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
  // Read once and shared with the escalation below: two calls could disagree if the flag flipped
  // mid-run, and a ceiling that moves between the profile and the model choice is unexplainable.
  const unlimited = getIdentityStore().orgIsUnlimited(orgId);
  const profile = resolveHarnessProfile({
    task,
    wedge,
    plan,
    unlimited,
    ceilings: { maxRuntimeS: cfg.maxRuntimeCeilingS, maxCostUsd: cfg.maxCostCeilingUsd },
  });
  /**
   * THE TIER, RAISED WHEN THE RUN HAS ALREADY PROVED IT NEEDS MORE.
   *
   * `repair_round` is set by the orchestrator's repair loop, which only runs after a workspace
   * failed verification — so this is not a guess that the task is hard, it is a workspace that did
   * not verify. See `escalatedTier`: one step per round, never past the plan's ceiling, never
   * downward. Round zero is untouched, which is every normal run.
   */
  const repairRound = Number((task.input as Record<string, unknown> | undefined)?.repair_round ?? 0);
  const tier: ModelTier = escalatedTier(profile.tier, repairRound, plan, unlimited);

  /**
   * Which model. An explicit model on the task wins (an operator debugging a specific run), then a
   * model named in the wedge manifest (which skips tiering entirely), then a model trial if one is
   * running and this run drew the challenger arm, then the profile's tier.
   *
   * ORDER MATTERS AND THE TRIAL IS THIRD ON PURPOSE. An operator pinning a model to reproduce a
   * failure, and a wedge that names a model because its trade needs that one, are both statements
   * about a specific run; a trial is a statement about the average. Letting the trial win over
   * either would mean an operator's pin silently not applying to a fifth of runs, which is the
   * worst kind of bug — it only appears sometimes.
   *
   * `armFor` is a pure hash of the task id, so calling it here and again below costs nothing and
   * cannot disagree with itself. That determinism is the whole reason the arm is derived rather
   * than drawn: a retried run must land in the same arm, or one deliverable ends up counted on
   * both sides of its own trial.
   */
  const model =
    typeof task.input?.model === "string"
      ? task.input.model
      : (wedge?.manifest.model ?? challengerFor(tier, armFor(task.id)) ?? modelForTier(tier) ?? cfg.model);

  if (tier !== profile.tier) {
    // Said out loud for the same reason the clamp is: a founder comparing two rounds of the same
    // build should not have to guess why the second one reads better, or cost more.
    void ctx.emit("progress", {
      note: `The last attempt did not verify, so this round runs on the ${tier} model instead of ${profile.tier}.`,
    });
  }
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

  /**
   * REPORT THE BUDGET THAT IS ENFORCED, NOT THE ONE THAT WAS ASKED FOR.
   *
   * This line said `${profile.max_runtime_s}s`, and the comment above explains why that number is
   * NOT the clock: `orchestrator.ts` captured `deadline` from `task.constraints.max_runtime_s`
   * before the profile existed. In production the two disagreed by 3x — every scheduler-created
   * `ops_distribution_tick` announced "600s" (the `general` shape default) and was then killed at
   * 1800s (`scheduler.ts`'s blanket constraint). Anyone reading the trace to work out why a run was
   * cut off was reading a number that had never been in force.
   *
   * So the enforced deadline leads, and the profile's request is shown only when it differs — which
   * is the signal that the task-creation seam named above still needs closing.
   */
  await ctx.emit("progress", {
    note: harnessProfileNote({
      shape: profile.shape,
      tier,
      enforcedRuntimeS: task.constraints.max_runtime_s,
      profileRuntimeS: profile.max_runtime_s,
      grantsActions: profile.grants_actions,
    }),
  });

  let config: Record<string, unknown>;
  let providerEnv: Record<string, string>;
  let promptModel: string;
  let nonce: string | undefined;
  /**
   * The run's own model endpoint, kept so more than one thing in the sandbox can use it.
   *
   * It was consumed inline by `buildOpencodeConfig` and thrown away. browser-use needs the same
   * three values — and it must get them from HERE rather than reconstructing the URL, because a
   * second place that spells `/v1/internal/llm` is a second place that can be wrong about it.
   */
  let modelProxy: { baseUrl: string; apiKey: string; model: string } | undefined;

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
    /**
     * ═══ WHICH OF THE TWO NAMES, DECIDED BY WHO IS ACTUALLY LISTENING ═══
     *
     * The paragraph above is right that the grant must pin "the name the upstream knows", and then
     * hardcodes the LiteLLM answer. `tenantKey` is what says whether LiteLLM is even in the path:
     * present means a brokered virtual key, absent means `MYCEL_LLM_UPSTREAM` — usually
     * api.openai.com — is the upstream.
     *
     * OpenAI has never heard of `openai/gpt-5.6-luna`. It answers:
     *
     *     Model not found: openai/gpt-5.6-luna. Did you mean: gpt-5.6-luna, …
     *
     * so EVERY task on a deployment without LiteLLM failed at the first model call. Not degraded —
     * no run could start at all, which is every self-hosted install and every local eval. It went
     * unseen because the hosted product always brokers, and because `MYCEL_MODEL` sets the banner
     * (`model=gpt-5.6-luna`) while the run resolves its own tier model, so the boot line said the
     * right thing and the run sent the wrong one.
     *
     * `litellm.ts` already makes exactly this distinction for the answer-box path, and says why:
     * "the direct path sends the model id and the proxy path sends the qualified name. Which
     * provider it is was already decided by `MYCEL_LLM_UPSTREAM`; repeating it in the model name
     * only gives the endpoint a string it cannot parse." The run path never got the same treatment.
     */
    nonce = await registerGrant({
      base_url: base,
      api_key: realKey,
      model: tenantKey ? model : modelId,
      task_id: task.id,
    });
    modelProxy = { baseUrl: `${cfg.publicUrl}/v1/internal/llm`, apiKey: nonce, model: modelId };
    const built = buildOpencodeConfig(
      model,
      { proxyBaseUrl: modelProxy.baseUrl, nonce, modelId },
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
    /**
     * Which capabilities this task's OWN INPUT already settles.
     *
     * `capability_inputs` maps a capability to the input field that supplies it — for books-keeper,
     * `read_bank_transactions` is settled by `transactions`. Declared per wedge rather than inferred,
     * because "this field looks like a ledger" is a guess and the consequence of getting it wrong is
     * a run that thinks it has the month's data and does not.
     *
     * A present-but-empty array does NOT settle anything: `transactions: []` is a caller saying
     * there were none, which is a claim a bank feed would have to confirm.
     */
    const capInputs = (wedge?.manifest as { capability_inputs?: Record<string, string> } | undefined)
      ?.capability_inputs ?? {};
    const suppliedCaps = Object.entries(capInputs)
      .filter(([, field]) => {
        const v = (task.input as Record<string, unknown> | undefined)?.[field];
        return Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null && v !== "";
      })
      .map(([cap]) => cap);
    /**
     * The capabilities THIS job needs — its own if it names them, the wedge's whole set if not.
     *
     * A `monthly_close` was gated on `send_email` because books-keeper declares it for its chases,
     * and a founder with no mailbox got a close that reported itself blocked over access it was
     * never going to use. Narrowed here rather than in the manifest reader so the wedge-level list
     * stays the default for every job that does not care.
     */
    const wedgeCaps = wedge?.manifest.capabilities ?? [];
    const taskCaps = (wedge?.manifest.task_types?.[task.task_type] as { capabilities?: string[] } | undefined)
      ?.capabilities;
    const byCapability = capabilityConnections(
      taskCaps ?? wedgeCaps,
      allConns,
      task.project_id,
      suppliedCaps,
    );
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

  /**
   * THE BROWSER, for the `operate` shape and no other. See browseruse.ts for the whole argument.
   *
   * Short version: raw Playwright is a driver and the agent has to invent selectors from screenshots;
   * browser-use hands it an indexed list of the page's interactive elements. It is mounted with NO
   * model key, deliberately — our harness is the agent and browser-use is the hands — so the
   * deterministic tools work and the two LLM-backed ones do not, which is the boundary we want.
   *
   * `operate` denies everything by default (`"*": "deny"`), exactly like `decide`, so each tool has
   * to be named or the server mounts and the model never sees it — the same "built a bridge and then
   * hid it" failure the block above exists to avoid. The nested agent is the one exception and is
   * left denied; `SHAPE_DEFAULTS.operate` spells that out by name so it survives this loop.
   */
  /**
   * WHERE THIS RUN'S BROWSER APPEARS TO BE.
   *
   * `undefined` unless residential egress is configured, which is the state everything has shipped
   * in — the proxy is metered per gigabyte and a deploy must not start spending. See
   * operate-egress.ts for why this cannot reuse the LinkedIn ISP lines that already exist.
   *
   * The country comes from the task input, because it is the CLIENT'S market rather than ours: an
   * answer engine returns a different answer in London than in Austin, and the client selling to
   * London agencies is buying the London answer.
   */
  const egress = operateEgress(process.env as EgressEnv, {
    country: typeof (task.input as { country?: unknown } | undefined)?.country === "string"
      ? ((task.input as { country: string }).country)
      : undefined,
    // Read per run, never cached. A customer connecting a LinkedIn account in this country turns a
    // borrowable line into one that must not be touched, and nothing else would say so.
    pool: proxyPoolStatus(),
  });
  if (egress) {
    // Redacted. This string carries a proxy password, and a trace is a log file.
    await ctx.emit("progress", { note: `egress: residential, ${egress.country} (${redactProxy(egress)})` });
  }
  /**
   * ═══ THE SYSTEM THIS RUN IS ALLOWED TO WORK IN, IF ANY ═══
   *
   * `operate` could drive a browser and could not hold a credential, so it could see the whole
   * internet and none of the systems a service business actually works in — a supplier portal, a
   * council portal, an insurer's extranet, a client's CMS. All of them need a login.
   *
   * Resolved HERE and not in the `grants_actions` block above, deliberately. That block mints an
   * action token, and `SHAPE_DEFAULTS.operate.grants_actions` is `false` precisely because a browser
   * holding a live session is a larger surface than a token scoped to three endpoints. This gives
   * the browser a session and still no action token, which is the line that comment draws.
   */
  const browserConn = browserTarget(
    profile.shape === "operate" && typeof (task.input as { connection_id?: unknown } | undefined)?.connection_id === "string"
      ? await domain.getConnection((task.input as { connection_id: string }).connection_id).catch(() => undefined)
      : undefined,
  );
  // Only this task's project's connections, the same rule the action grants follow. A browser
  // session belonging to another tenant is the worst thing in this file to hand out by accident.
  const browserSession =
    browserConn && (await sessionForRun(task, browserConn, wedge));
  if (browserConn && browserSession) {
    await sandbox.writeFile(SESSION_PATH, JSON.stringify(browserSession));
    await sandbox.writeFile(BROWSER_CONFIG_PATH, JSON.stringify(browserUseConfig(), null, 2));
    // The origin and the access, never the session. A founder reading a trace should be able to see
    // which system was opened and on whose authority.
    await ctx.emit("progress", {
      note: `browser: ${browserConn.name} (${browserConn.origin}, ${browserConn.access})`,
    });
  }

  const browserMcp = buildBrowserUseMcp(profile.shape, {
    llm: modelProxy,
    ...(egress ? { proxy: { server: egress.server, username: egress.username, password: egress.password } } : {}),
    ...(browserConn && browserSession
      ? { allowedDomains: domainLock(browserConn), configPath: BROWSER_CONFIG_PATH.replace(/^~/, "/root") }
      : {}),
  });
  if (browserMcp) {
    config.mcp = { ...((config.mcp as Record<string, unknown> | undefined) ?? {}), ...browserMcp };
    const perm = { ...((config.permission as Record<string, unknown> | undefined) ?? {}) };
    for (const tool of BROWSERUSE_TOOLS) {
      const name = qualified(tool);
      // Never promote a tool the shape has already refused. `BROWSERUSE_DENIED` is the nested agent,
      // and a loop that blindly allowed everything it enumerated would quietly undo the one denial
      // that matters — which is precisely how an allowlist built from a tool list goes wrong.
      if (BROWSERUSE_DENIED.includes(name)) continue;
      perm[name] = "allow";
    }
    config.permission = perm;
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
      /*
        THREE OUTCOMES, THREE SENTENCES. This line already existed because "a seed that silently
        no-ops and a seed that never ran leave identical feeds" — and then a third case appeared
        that it could not say: a repair round re-entering against a workspace the agent had already
        built in. That one printed the same "seeded from business-template — 634 files" as a first
        seed, which is how a loop that wiped the agent's work three times read as normal.
      */
      note: !seeded.root
        ? `workspace ~/${ws.dir}: created empty — this wedge declares no scaffold to seed from.`
        : seeded.reused
          ? `workspace ~/${ws.dir}: already built in — left exactly as the previous session left it, ` +
            `nothing re-seeded from ${ws.seed}.`
          : `workspace ~/${ws.dir}: seeded from ${ws.seed} — ${seeded.written} files` +
            (seeded.skipped ? ` (${seeded.skipped} binary/oversized files skipped)` : ""),
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
   * ═══ AND SOMETHING TO PUT IN THE FRAME ═══
   *
   * `design-lint.ts` refuses external placeholder CDNs — correctly, they look fake when they 404 —
   * and offers `.ph-img` as the alternative, so every site and deck this product has ever built
   * shipped grey rectangles. The linter was right and the cupboard was bare.
   *
   * Deliverable and build shapes only: those are the two that produce something a person looks at.
   * A `decide` run renders nothing, and an `operate` run is driving a browser.
   *
   * No grant, no gate, no credential. On the anonymous tier this spends nothing, touches no
   * customer and writes to no system of record — putting it behind the approval queue would ask a
   * founder to authorise "draw a picture", which is how a queue becomes noise nobody reads. See
   * imagetool.ts for why it is a CLI tool rather than an MCP server.
   *
   * Fail-soft: a sandbox that will not accept the script costs the run its pictures, never the run.
   */
  const imageProvider =
    profile.shape === "deliver" || profile.shape === "build" ? imageProviderFromEnv() : undefined;
  if (imageProvider) {
    try {
      await sandbox.writeFile(IMAGE_TOOL_PATH, imageToolScript(imageProvider));
      await sandbox.exec(`chmod +x ${IMAGE_TOOL_PATH}`, 30_000);
    } catch {
      /* no pictures this run */
    }
  }

  /**
   * ═══ AND THE REVIEWER'S INSTRUMENT, IN THE RUN'S OWN HANDS ═══
   *
   * `mycel-check` posts a file back to `/v1/internal/check`, which runs the SAME `lintArtifact` the
   * submit gate runs and the SAME declared shape this run was mounted. See checktool.ts for why it
   * is a round trip rather than a copy of the rules in the box: a second definition drifts, and it
   * drifts silently in the direction that teaches the agent its own instrument lies.
   *
   * `deliver` only. A build run has `mycel-build` and a compiler telling it whether the thing works;
   * these are the runs whose output is a document a person reads and judges, and the only ones
   * `slopFault` refuses.
   *
   * Needs the proxy nonce, so it is absent on a run with no model grant — and absent is the right
   * answer there, because `checkToolDoc` is only added when the script was actually installed.
   */
  let checkTool = false;
  if (profile.shape === "deliver" && nonce) {
    try {
      await sandbox.writeFile(CHECK_TOOL_PATH, checkToolScript(`${loadConfig().publicUrl}/v1/internal`, nonce));
      await sandbox.exec(`chmod +x ${CHECK_TOOL_PATH}`, 30_000);
      /**
       * ═══ ASK THE BOX, DO NOT ASSUME THE WRITE ═══
       *
       * `writeFile` + `chmod` returning without throwing is not evidence the agent can run this.
       *
       * I nearly convinced myself it was worse than that. The first live call came back in 5ms
       * against 615ms for the same script from a laptop, and I read that as "it never ran". It is
       * not: `mycel-build` averages 7ms across 78 calls and `mycel-insight` 9ms across 53, and both
       * demonstrably work — `duration_ms` on a bash tool call is dispatch, not wall clock. The
       * check almost certainly ran and passed, on a report that has no P0 findings and carries all
       * six declared sections.
       *
       * The probe stays anyway, because the reasoning that led me there was the right reasoning
       * about the wrong number: the run's only evidence was that a write did not throw, which is
       * checking the verb rather than measuring the resource. Now `checkTool` — which gates the
       * AGENTS.md section — is set from what the box answers, and the feed says which. An agent
       * pointed at a tool that is not on its PATH learns that the instructions lie.
       */
      // The BARE NAME, because that is what the agent types and what AGENTS.md tells it to type.
      // Probing the absolute path would answer a question nobody asked: the file can exist and be
      // executable and still not be on the PATH the agent's shell has.
      const found = await sandbox.exec(`command -v mycel-check >/dev/null 2>&1 && echo yes || echo no`, 30_000);
      checkTool = found.stdout.includes("yes");
      await ctx.emit("progress", {
        note: checkTool
          ? "quality check available: `mycel-check <file.html>` applies the same rules that refuse a deliverable at submit"
          : "mycel-check could not be installed — this run submits without reading its own work first",
      });
    } catch {
      /* the run submits unchecked, as it did before this existed */
    }
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

  // The client's own row, for the facts block in AGENTS.md. Never fatal: a task with no client, or a
  // store that cannot answer, gets the prompt it got before this existed.
  const runClientId = taskClientId(task);
  const runClient = runClientId
    ? await getDomainStore()
        .getClient(runClientId)
        .catch(() => undefined)
    : undefined;

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
  /**
   * The founder's own work, mounted as the bar this run is held to.
   *
   * Onboarding's exemplar step collects one real deliverable they have already sent a client. This
   * is where it is spent: alongside the wedge's craft, so the model is shown a finished piece by a
   * professional in this trade rather than only told the rules.
   *
   * Concatenated LAST so it reads after the procedures — the skills say how to do the work, the
   * exemplar says how good it has to be. Fails soft to none, exactly like the library read above.
   */
  const ownExemplars = await exemplarSkills(domain, task.project_id).catch(() => []);
  /**
   * The founder's own work wins outright, and the wedge's reference is the floor under it.
   *
   * Not both: two exemplars written to different standards is a style guide the model has to
   * arbitrate between, and the one it should follow is never in doubt. Theirs carries their voice,
   * their client's expectations and their firm's habits — none of which is ours to overrule.
   *
   * The fallback matters more than it looks, because it is the COMMON case: most accounts never
   * reach the onboarding screen that asks for an upload, so this path was mounting nothing at all
   * and the run was back to prose rules with no demonstration.
   */
  const founderExemplars = ownExemplars.length ? ownExemplars : shippedExemplarSkills(wedge);

  /**
   * ═══ AND WHAT THIS PARTICULAR CLIENT WAS SENT LAST TIME ═══
   *
   * Everything mounted above is about STANDARD — the founder's own past work as the bar, the craft,
   * the procedures. None of it answers "what did we already tell these people", which is the
   * question a retainer is actually judged on: a client reading their sixth report compares it to
   * their fifth, not to an ideal one.
   *
   * Deliverable shapes only, and fail-soft to nothing, like every other mount on this path. See
   * continuity.ts for why it reads the RELEASED version rather than the newest.
   */
  const lastTime =
    profile.shape === "deliver" && task.project_id && task.client_id
      ? await continuitySkills(getDeliverableStore(), {
          projectId: task.project_id,
          clientId: task.client_id,
        }).catch(() => [])
      : [];

  /**
   * ═══ AND HOW THIS FIRM ACTUALLY DOES THE WORK ═══
   *
   * Everything above is standard and history. Method came from the WEDGE, and the wedge is ours:
   * thirteen trades and their task types, written before we had met a customer. Their exemplar
   * could override our voice and never our method. This mounts the practice derived from the work
   * they actually shipped, so the method comes from them too.
   *
   * Deliverable shapes only, fail-soft to nothing, mounted BELOW the exemplar it was read from -
   * see practice.ts for why an inference must not outrank its own evidence.
   */
  /**
   * ═══ AND WHAT ITS OWN CHILDREN CAME BACK WITH ═══
   *
   * Only ever present on a re-run after a batch joined. A parked parent is torn down completely, so
   * without this it reaches the same step, decides it needs measurements, and fans out again. Every
   * other mount here is about standard or method; this is the run's own working memory, handed back.
   */
  const fromChildren = task.project_id
    ? await priorBatchResults(task.id, task.project_id).catch(() => undefined)
    : undefined;

  const method =
    profile.shape === "deliver" && task.project_id
      ? await practiceSkills(domain, wedgeForRole("business_shaping"), task.project_id).catch(() => [])
      : [];

  /**
   * WHICH SIDE OF A TRIAL THIS RUN IS ON.
   *
   * Derived from the task id, never drawn: a run gets re-read, retried and reported on after the
   * fact, and a random draw would answer differently each time — putting the same deliverable in
   * both arms and corrupting the only evidence a trial has. See `armFor`.
   *
   * Computed for EVERY run, whether or not any skill is under trial, because it costs a hash and the
   * alternative is asking "is anything on trial" before we have loaded the overlays that would say.
   * A run with no challenger mounted reads the incumbent either way; the arm is then just a label on
   * the evidence, and `skillScales` treats a row with no arm as not-in-a-trial rather than as a
   * third arm — so the label only starts meaning something when a trial actually exists.
   */
  const arm = armFor(task.id);
  /**
   * ═══ THE CRAFT THAT IS NOT A TRADE'S ═══
   *
   * Six rules, mounted on every run that produces something a client receives, whatever the trade.
   *
   * They were learned this way round: a model playing a paying client rejected the same deliverable
   * six times, and none of its complaints were about bookkeeping. "You sent me an account of the work
   * rather than the work." "You say reconciled and show no reconciliation." "A retainer should buy a
   * recommendation, not a list of ambiguities pushed back to me." Those are true of a GEO report, a
   * screened longlist and a finished site, and every one of them was written down in `books-keeper`
   * as if it were an accounting rule.
   *
   * Trade craft belongs in the wedge — VAT schemes, aging buckets, selection versus absorption. This
   * is the part that does not change, and it lives in `kernel/craft/` (loaded by `sharedCraft`) so a new trade inherits it on
   * the day it is written rather than rediscovering it through a rejected deliverable.
   *
   * Deliverable shapes only. A `decide` run answering "which dunning rung" produces nothing a client
   * opens, and spending its budget on how to write a covering note is spending it on the wrong thing.
   */
  const described =
    task.task_type === "draft_service" && task.input && typeof (task.input as { description?: unknown }).description === "string"
      ? (task.input as { description: string }).description
      : "";
  /**
   * ═══ THE HOUSE STYLE, MOUNTED AS BYTES ═══
   *
   * Nothing in this file read the brand kit. The kit was resolved for invoices, proposals and the
   * portal — every surface the KERNEL renders — and was invisible to the runs that produce the work
   * a client actually opens. So a report and a deck and a landing page for the same business each
   * invented their own palette, which is why a set of deliverables never looked like one firm made
   * them.
   *
   * Two files, on deliverable shapes only: the token values and the prose about when this look is
   * right. A `decide` run answering "which dunning rung" renders nothing and does not need them.
   *
   * Fail-soft throughout. An unknown project, a missing directory, an archetype we have no mapping
   * for — each degrades to no house style, which is exactly where this started, and never to a
   * failed run.
   */
  /**
   * The system's shape, wearing this business's identity.
   *
   * `designSystemFor` picks WHICH system from the archetype; the kit carries the accent the founder
   * actually chose. Passing only the first left the run holding two palettes — the system's own
   * reference colours and the brand's — with nothing saying which was authoritative. See
   * `withBrandIdentity`.
   */
  const kit = task.project_id ? getIdentityStore().brandKit(task.project_id) : undefined;
  /**
   * ═══ A REVISION WEARS WHAT THE CLIENT ALREADY SAW ═══
   *
   * This used to call `designSystemFor(kit.identity)` unconditionally, so the look was re-derived on
   * every run from whatever the identity said at that instant. A founder who restyled between a
   * client accepting v1 and asking for one change got v2 back in a different house style — a
   * different firm appearing to answer, on the single interaction where the client was already
   * unhappy enough to ask.
   *
   * A regenerating run is handed `deliverable_id` in its input (see the `regenerate` branch in
   * deliverables.routes.ts), so the pin is reachable. Absent — a genuinely new piece of work, or a
   * row created before pins existed — this resolves exactly as it did before.
   *
   * Fail-soft: a lookup that throws degrades to today's resolution rather than failing the run. The
   * cost of the degrade is a restyled revision, which is what happened every time before this.
   */
  const pinned = await pinnedStyleFor(task).catch(() => undefined);
  const style = styleForVersion(pinned, resolveStyle(kit));
  const brandFiles =
    profile.shape === "deliver" || profile.shape === "build"
      ? designSystemFilesFor(style.system, { accent: style.accent, neutral: style.neutral })
      : [];

  /**
   * The declared shape for THIS task type, as a mounted page. Read off the manifest rather than
   * inferred: a shape nobody wrote is a shape we do not know, and guessing one is worse than none.
   */
  const withShapeFrontMatter = (page: string) =>
    ["---", "description: What the client actually opens: the sections of this artefact, in order, and how deep each one goes.", "---", "", page].join("\n");
  const shapePage = ((): MountedSkill[] => {
    if (profile.shape !== "deliver" && profile.shape !== "build") return [];
    const declared = wedge?.manifest.task_types?.[task.task_type]?.deliverable_shape;
    const page = deliverableShapeAsSkill(readDeliverableShape(declared));
    // Same frontmatter `wedgeauthor` gives its copy. Without it the index line is the page's first
    // body sentence cut at 200 chars, and the index line is the whole basis for opening the file.
    return page
      ? [{ name: SHAPE_SKILL_FILE, content: withShapeFrontMatter(page) }]
      : [];
  })();

  const mountedSkills = [
    ...profileSkills(wedge, profile, liveKnowledge, task.task_type, librarySkills, arm),
    ...(profile.shape === "deliver" || profile.shape === "build" ? sharedCraft() : []),
    /**
     * ═══ AND WHAT THE FINISHED THING LOOKS LIKE ═══
     *
     * The template. `craft:presenting-work` above says how a deliverable is presented in general;
     * this says what sections THIS job's artefact has, in what order, and how deep each goes.
     * General rule, then the specific instance of it — which is why it sits immediately after.
     *
     * ─── IT WAS BUILT, AND MOUNTED FOR THE WRONG POPULATION ───
     *
     * `deliverableShapeAsSkill` has existed since the authoring pass. Its only caller was
     * `wedgeauthor.ts`, so a service Mycel INVENTED was told what the finished object looks like
     * and the thirteen wedges running real engagements were not. Same inversion `compile.ts`
     * already names about human ceilings: the jobs with customers held to the lower bar.
     *
     * Declared per task type, absent for most, and `deliverableShapeAsSkill` returns undefined for
     * a missing one — so a job whose shape nobody has written keeps the run's own judgement rather
     * than a generic Summary/Findings/Next-steps skeleton that is nobody's actual format.
     */
    ...shapePage,
    ...founderExemplars,
    ...method,
    ...(fromChildren ? [fromChildren] : []),
    // Last month's released deliverable for this client. AFTER the exemplars on purpose: the
    // exemplar says how good it has to be, and this says what it has to follow on from — a
    // standard the run should imitate, then a history it must not contradict.
    ...lastTime,
    // Library runbooks the brief actually matches. Mounted, not pasted into the task JSON — see
    // `arsenalSkillsFor`. Compile sees the craft; the shaper copies it instead of inventing a taxonomy.
    ...(task.task_type === "draft_service"
      ? arsenalSkillsFor(described)
      : // The same shelf, for the runs that actually make the thing. See `arsenalSkillsForBrief`:
        // mounted on deliverable shapes only, on a smaller budget, matched against the brief rather
        // than a founder's sentence — because a deliver run has no founder sentence.
        profile.shape === "deliver" || profile.shape === "build"
        ? arsenalSkillsForBrief(task)
        : []),
    ...brandFiles,
  ];

  /**
   * ═══ THE COMPILE. The last point before a token is spent. ═══
   *
   * Everything the compiler reads only becomes true here: the profile is resolved, connections are
   * granted, capability gaps are known, and craft is mounted. So this is where the question "is
   * this job EQUIPPED to produce expert work?" is finally answerable — and it is answerable from
   * data, without asking the model anything.
   *
   * The sandbox is already up, which is not ideal and is not the point. A sandbox boot is cheap;
   * a run that produces work which LOOKS finished and is not costs the client relationship. The
   * guarantee worth having is that no TOKEN is spent on a job missing a definition of done, a
   * human ceiling, or the access to finish — and that guarantee holds right here.
   *
   * FAILS CLOSED. A refusal ends the run. It never falls back to a wider toolset, a longer budget,
   * or an unmounted skill set — that inversion is the specific way harness compilers become unsafe.
   */
  const compiled = compile({
    task,
    profile: {
      shape: profile.shape,
      strict_output: profile.strict_output,
      max_runtime_s: profile.max_runtime_s,
      max_cost_usd: profile.max_cost_usd,
      grants_actions: profile.grants_actions,
    },
    outputSchema: (outputSchemaFor(task, wedge) ?? null) as Record<string, unknown> | null,
    shipRequires: shipRequiresFor(task, wedge),
    deliverableShapes: wedge?.manifest.fulfillment?.deliverable_shapes,
    // Read off the mount rather than the manifest, so this reports what the run was ACTUALLY
    // given. A shape declared but not mounted is the failure mode this whole pass is about.
    hasDeclaredShape: shapePage.length > 0,
    internalTaskType: !!(wedge?.manifest.task_types?.[task.task_type] as { internal?: boolean } | undefined)
      ?.internal,
    skills: mountedSkills.map((sk) => ({ name: sk.name, content: sk.content })),
    capabilityGaps,
    connections: grantedConns.map((c) => c.id),
  });
  /**
   * ═══ THE STAGED SHELF, RESOLVED BEFORE THE PROMPT IS WRITTEN ═══
   *
   * Computed here rather than at the write site below because AGENTS.md has to NAME it, and
   * AGENTS.md is written first. That ordering is the whole bug this moves: `craft/INDEX.md` was
   * written into every deliver sandbox and mentioned nowhere, so reaching it meant the agent had to
   * speculatively `ls craft/`. Fourth instance of the same defect found in one day.
   *
   * Pure enough to hoist — it reads the seed shelf off disk and scores it against the brief. The
   * files are still written below, from this same object, so the shelf is walked once.
   */
  const stagedShelf =
    profile.shape === "deliver"
      ? ((): ReturnType<typeof stagedArsenalForBrief> | undefined => {
          try {
            return stagedArsenalForBrief(task);
          } catch {
            return undefined;
          }
        })()
      : undefined;

  await ctx.emit("progress", { note: describe(compiled) });
  if (!compiled.ok) {
    /**
     * MISSING ACCESS IS REPORTED, NOT REFUSED — and this is the one place the call site overrides
     * the compiler on purpose.
     *
     * `compile()` rates a capability gap fatal, on the reasoning that a job which cannot finish
     * should not spend the budget discovering that. That reasoning is sound for a mature project
     * and wrong for the case that actually dominates: a client mid-onboarding who has connected
     * two things out of five. Refusing them outright would mean the platform does nothing at all
     * until every integration is live, which is the worst possible first hour of using it.
     *
     * The runtime already handles gaps better than a refusal could — buildAgentsMd writes a "what
     * this run cannot do" section, so the model knows the boundary and does the part it can. That
     * is a deliberate, documented decision (see the `capabilityGaps` block below) and it predates
     * this compile step; quietly inverting it here would be this file overruling a design choice
     * nobody revisited.
     *
     * The other four refusals stay fatal. Those are things a wedge AUTHOR controls — a definition
     * of done, written craft, a human ceiling — and none of them is fixed by waiting.
     */
    const fatal = compiled.refusals.filter((r) => r.code !== "missing_access");
    for (const r of compiled.refusals) {
      if (r.code === "missing_access") await ctx.emit("progress", { note: `compile: ${r.message}` });
    }
    if (fatal.length) {
      // By name, with a sentence a founder can act on. Refusing costs one run; shipping work that
      // looks finished and is not costs the client. See compile.ts.
      throw new CompileRefused(fatal);
    }
  } else {
    for (const w of compiled.warnings) await ctx.emit("progress", { note: `compile warning: ${w}` });
  }
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
      runClient,
      checkTool,
      stagedShelf?.index ? { staged: stagedShelf.staged, shelf: stagedShelf.shelf } : undefined,
      /*
        Recall, last in the list and last to be read. Best-effort: a vault that cannot be reached is
        a run with no recall, never a run that does not happen. The query is the task's own
        description plus its type, which is what the run is actually about — the alternative,
        embedding the whole input, retrieves on the client's name and returns everything.
      */
      await recallForRun(
        task.project_id ?? "",
        `${task.task_type} ${wedge?.manifest.task_types?.[task.task_type]?.description ?? ""}`,
      ).catch(() => []),
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

  /**
   * ═══ THE REST OF THE SHELF, STAGED RATHER THAN MOUNTED ═══
   *
   * `arsenalSkillsForBrief` gives this run four whole skills, and `DELIVER_ARSENAL_LIMIT` explains
   * why four and why whole. The fifth-best match, on a shelf of 221, simply did not exist as far as
   * the run was concerned.
   *
   * These are written to disk and named in an index the agent reads, so it can open one when the
   * brief turns out to need it — open-design's own pattern, applied to the shelf instead of to a
   * single skill's references. Nothing extra enters the prompt but the index.
   *
   * Deliverable shapes only. A `decide` run renders nothing and would be reading design craft to no
   * end; a build already carries the component library and the seed's own conventions.
   *
   * Fail-soft: a staging write that fails costs a file the agent might have opened, and must never
   * cost the run. That is the same rule the knowledge and skill writes above follow.
   */
  if (stagedShelf) {
    try {
      for (const f of stagedShelf.files) await sandbox.writeFile(f.path, f.content);
      if (stagedShelf.index) await sandbox.writeFile("craft/INDEX.md", stagedShelf.index);
    } catch (e) {
      await Promise.resolve(
        ctx.emit("progress", { note: `craft shelf not staged: ${(e as Error)?.message ?? "unknown"}` }),
      ).catch(() => {});
    }
  }
  /**
   * Attribution, in two passes.
   *
   * WRITTEN NOW, before the agent starts, so a run that crashes, stalls or is killed still leaves a
   * record that these skills were mounted. That matters more than it looks: a skill that is only
   * ever mounted into runs that die would otherwise have no rows at all, and would read as untested
   * rather than as implicated.
   *
   * REWRITTEN AT THE END with what the agent actually opened. `recordSkillUses` upserts on
   * `(task, skill)`, so the second pass replaces the first rather than doubling it — see the note
   * there. Fail-soft throughout: a run must never fail because the scale could not be written.
   */
  const attention = new SkillAttention(mountedSkills);
  /**
   * Declared out here so the `finally` can close it on every exit path. A queued message whose
   * promise never settles holds the founder's request open on a run that has already ended.
   */
  let steerQueue: SteerQueue | undefined;
  /**
   * How many extra turns the founder's steering has bought this run.
   *
   * Bounded rather than open-ended: a run whose sandbox is held open indefinitely by a stream of
   * messages is a cost nobody agreed to, and the founder can always start a fresh job. Four is
   * enough for a real correction and a follow-up on either side of it.
   */
  let steerTurns = 0;
  /**
   * When an extension granted for a steer expires unless the turn starts.
   *
   * `undefined` whenever no steer is being waited on, which is almost always. See the block that
   * sets it for why a 204 is not proof that anything will run.
   */
  let steerDeadline: number | undefined;
  /** Set when a steered turn was granted an extension and never started. See the stall watchdog. */
  let steerStarved = false;
  if (task.project_id) {
    void recordSkillUses(getDomainStore(), {
      project_id: task.project_id,
      task_id: task.id,
      wedge: task.wedge,
      skills: mountedSkills,
      arm,
    }).catch((e) => console.error("[mycel] recordSkillUses failed:", e));
  }
  // What the CLIENT handed over for this case, mounted alongside anything the caller passed in.
  //
  // MOUNTED HERE, not at the spawn sites, and that placement is the point. Fulfilment runs are
  // started from at least four places — kickoff, the ignition sweep, a founder pressing run, a
  // client's reply clearing a wait — and a gather in each is four chances for one to be forgotten.
  // The failure that produced this code was already of exactly that shape: a door that existed and
  // was never called. Every run reaches this line, so no spawn path can miss it.
  //
  // Fail-soft and ADDITIVE: an unreachable request store costs the run its client material, which
  // it will notice and report, and that is strictly better than an episode that never starts. The
  // caller's own documents are never displaced, because a founder who attached a file to this task
  // meant it more specifically than anything gathered from history.
  const gathered = await ctx.materials?.().catch((e) => {
    console.error("[mycel] client materials gather failed:", e);
    return undefined;
  });
  const documents = [
    ...(Array.isArray(task.input?.documents) ? (task.input.documents as unknown[]) : []),
    ...(gathered?.documents ?? []),
  ];
  if (gathered) {
    const note = materialsNote(gathered);
    if (note) await ctx.emit("progress", { note: `client materials — ${note}` });
  }
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
    // THE CLIENT-DELIVERABLE LOOP, WHICH HAD NO ADDRESS.
    //
    // `/v1/internal/deliverables` has existed on the agent plane throughout — a run may create a
    // deliverable and submit versions, and deliberately cannot release one. Delivery wedges document
    // the loop in their skills (`multi-shot-fulfillment.md`: "founder review → submit a deliverable
    // version and end the run"), and several declare `deliverable_verdict` as a task type so a
    // client's answer can resume the work.
    //
    // Every one of those instructions was unreachable. This env block is how a sandbox learns where
    // anything is, `MYCEL_PUBLIC_URL` is read by the kernel and never passed in, and there was no
    // deliverables entry — so an agent told to "submit a deliverable version" had no URL to submit
    // it to, and no base to build one from. The route was live, the skills were right, and nothing
    // could call it: no agent-produced deliverable has ever reached a client portal.
    //
    // Same species as the audit key and the reasoning_effort 400 — built correctly, never wired,
    // silent because the surface that would have complained was never reached.
    env.MYCEL_DELIVERABLES_URL = `${cfg.publicUrl}/v1/internal/deliverables`;
    // The run's own files, by id. Needed to submit a `file_set` or a `document` — those take
    // `artifact_ids`, and an agent with no way to look one up cannot build the call. The route was
    // live and referenced in a comment three files away, with no address in the sandbox: the same
    // "built correctly, never wired" this whole block exists because of.
    env.MYCEL_ARTIFACTS_URL = `${cfg.publicUrl}/v1/internal/artifacts`;
    // The company brain. Two verbs, the SAME action token — no new credential enters the sandbox.
    env.MYCEL_BRAIN_URL = `${cfg.publicUrl}/v1/internal/brain`;
    /*
      Where the run writes down what it learned. Same action token again — a memory write is not a
      new kind of authority and must not arrive with a new kind of credential. The address is what
      makes the route reachable at all: `/v1/internal/artifacts` was live, referenced in a comment
      three files away, and had no address in the sandbox for weeks, which is the exact failure this
      whole block exists because of.
    */
    env.MYCEL_MEMORY_URL = `${cfg.publicUrl}/v1/internal/memory/write`;
    env.MYCEL_ACTION_TOKEN = actionNonce;
  }
  /**
   * The image key travels in the ENVIRONMENT, never in the script.
   *
   * `mycel-image` is written into the sandbox as a file, and a file in the workspace is a file the
   * run can export — baking a live provider credential into it would ship the key inside whatever
   * artefact the task hands back. Same rule the opencode launch follows: secrets go in env, not in
   * argv and not on disk.
   */
  if (imageProvider) {
    /**
     * A NONCE, NEVER A KEY — for every provider, not just Bedrock.
     *
     * This used to branch: Bedrock got the kernel's URL and a nonce, everything else got its own
     * provider credential, because "a scoped provider key is the only thing at risk". That stopped
     * being true when the deployment pointed the image key at the OpenAI secret it already held —
     * a run could then read a live org credential out of its own environment and spend outside both
     * LiteLLM's per-org budget and the `images_per_month` ceiling.
     *
     * Now every provider is reached through `/v1/internal/image`, so what enters a sandbox is a
     * short-lived, task-scoped grant that opens one endpoint of ours and dies with the run.
     */
    env.MYCEL_IMAGE_URL = `${cfg.publicUrl}/v1/internal/image`;
    env.MYCEL_IMAGE_KEY = nonce ?? "";
    if (imageProvider.model) env.MYCEL_IMAGE_MODEL = imageProvider.model;
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
  /**
   * ═══ THE PROVIDER KEY MUST NOT TRAVEL IN A COMMAND LINE ═══
   *
   * These were interpolated straight into the `spawn` string, which put every one of them in the
   * process table. Observed on this machine during a real run, in plain `ps aux` output:
   *
   *     bash -lc OPENAI_API_KEY='sk-proj-…' OPENCODE_SERVER_PASSWORD='966c…'
   *       MYCEL_GATE_TOKEN='d61e…' opencode serve --hostname 0.0.0.0 --port 4791
   *
   * `ps` is world-readable. On LocalSandbox that is the HOST process table, so any process run by
   * any user on the box could read the provider key, the gate token that authorises spend, and the
   * HTTP Basic password for the agent server — no exploit required, just `ps`. Docker and Daytona
   * narrow the audience to whoever is inside the container; they do not make it private.
   *
   * So the values go to a file instead, 0600, sourced and DELETED before `opencode` is exec'd. The
   * secret is then in neither the process table nor the filesystem for the life of the run, and the
   * environment the server sees is identical to what it was.
   *
   * `set -a` exports everything the file assigns, which is what the inline form did implicitly.
   * Written through `sandbox.writeFile` rather than a heredoc for the reason `verifyWorkspace`
   * documents at length: `DaytonaSandbox.exec` hands its string to a shell we do not control, and a
   * quote in a value would close their wrapper and exit before running anything.
   */
  /**
   * `~/`-PREFIXED ON BOTH SIDES, because that is the only spelling all three backends agree on:
   *
   *   · LocalSandbox.abs      strips `~/` (and a leading `/`) and joins the sandbox home
   *   · DaytonaSandbox.abs    passes an absolute path through, else joins `$HOME`
   *   · DockerSandbox         rewrites a leading `~/` to `root/`, then re-roots it
   *
   * A leading `/` is right for two of them and silently relocates the file under the sandbox home on
   * the third; a bare relative path is right for two and lands at filesystem root on Docker. Only
   * `~/` resolves to the same file everywhere, which is why `SESSION_PATH` and `BRIDGE_SCRIPT_PATH`
   * are written that way.
   *
   * The first attempt here used "/tmp/…". On LocalSandbox the file was written under the sandbox
   * home while the shell read the absolute path, the source found nothing, and because the command
   * was `;`-separated it carried on and started opencode with NO environment — no API key, no port:
   *
   *     Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.
   *
   * `&&`, not `;`, for that second reason. Failing to load the credentials must ABORT rather than
   * fall through to a server running without them — an unauthenticated agent server is a worse
   * outcome than a run that fails loudly, and the `;` made the two look identical from outside.
   */
  const envFile = `~/.mycel-oc-env-${task.id}`;
  await sandbox.writeFile(
    envFile,
    Object.entries(env)
      .map(([k, v]) => `${k}=${shellQuote(v)}`)
      .join("\n") + "\n",
  );
  // `umask` before the write would be racy across backends, so the mode is set immediately after.
  // Failure is swallowed: a sandbox whose `chmod` is unavailable is still better off sourcing a
  // file than publishing the key to `ps`.
  await sandbox.exec(`chmod 600 ${envFile} 2>/dev/null || true`, 10_000).catch(() => {});
  const envInline = `set -a && . ${envFile} && set +a && rm -f ${envFile} &&`;
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
  /**
   * ═══ A PER-INVOCATION PORT — a run may start opencode MORE THAN ONCE ═══
   *
   * THE INCIDENT (2026-08-17, evals/product/ERROR-HUNT-LOG.md). `runOpenCodeTask` mints a fresh
   * HTTP Basic password every call (line ~781), and a single run now calls it AGAIN for the
   * schema-retry and the build verify-repair rounds (orchestrator.ts:238, 395). Every call had
   * spawned `opencode serve` on the SAME fixed port (`cfg.opencodePort`, 4444). The previous
   * phase's server was still bound to it — the OpenCode SESSION was aborted, but the serve PROCESS
   * was not — so the second spawn could not take the port, the old server (password A) kept
   * answering, and the new client (password B) AUTH-REJECTED against it. A real GTM France build
   * wrote all 16 files, then died at `probes saw: 55 × http 401` (waitReady's tally — the only
   * reason this was diagnosable at all). A build that failed verify ONCE thus died on the retry
   * instead of either repairing or failing with the real verify error.
   *
   * TWO WRONG FIXES came first: readiness instrumentation (named the tally, didn't stop it) and a
   * `pkill -f 'opencode serve'` before every spawn. The pkill is INEFFECTIVE in the Daytona
   * microVM (pkill absent / no match there), so the lingering server survived and kept
   * intercepting the new client.
   *
   * THE ROBUST FIX: give each spawn its OWN port, so a lingering server can never intercept the new
   * client — the two never share a socket, so a password mismatch is impossible by construction.
   * `LocalSandbox.previewUrl(port)` and `DaytonaSandbox.previewUrl(port)` both honour an arbitrary
   * port (localhost / getPreviewLink), so this costs nothing there.
   *
   * DOCKER IS THE EXCEPTION: `DockerSandbox` publishes ONE fixed inner port at `acquire` time and
   * `previewUrl` IGNORES its argument, so a random inner port would be unreachable from the host.
   * Docker keeps the fixed port — and there the `pkill` below DOES work (real Linux, real process
   * table), which is exactly the backend a fixed port needs. So: randomise for daytona/local
   * (where the kill is unreliable but a fresh port is free), stay fixed + kill for docker.
   */
  const ocPort = pickOpencodePort(cfg.sandboxBackend, cfg.opencodePort);
  /**
   * ═══ DOCKER ONLY, BECAUSE ON A LOCAL SANDBOX THIS IS A HOST-WIDE KILL ═══
   *
   * `pickOpencodePort` gives docker the FIXED port and everything else a random one, so freeing the
   * port before rebinding is load-bearing on docker and pointless elsewhere. The previous comment
   * said as much and then ran it unconditionally, calling it "a harmless no-op on daytona/local".
   *
   * It is not a no-op on local. `LocalSandbox.exec` is `bash -lc <command>` on the HOST with no
   * containment, so this killed every `opencode serve` on the machine — including the one belonging
   * to a run that was still going, and including a developer's own session.
   *
   * That is the "opencode ended before completing" that made the breadth eval unusable: runs that
   * overlapped even briefly had the later one shoot the earlier one's server, and the failure
   * surfaced as a protocol fault with no error, minutes after the kill. A single run in isolation
   * always succeeded, which is what kept it looking like flakiness.
   *
   * Left in place for docker rather than deleted: there the port really is fixed and a stale bind
   * really does have to be cleared.
   */
  if (cfg.sandboxBackend === "docker") {
    await sandbox
      .exec(`pkill -f 'opencode serve' 2>/dev/null; sleep 1; true`)
      .catch(() => {});
  }
  await sandbox.spawn(
    `${envInline} opencode serve --hostname 0.0.0.0 --port ${ocPort} > /tmp/opencode.log 2>&1`,
  );

  // 3. Reach the server (preview link in Daytona; localhost locally) and wait until ready.
  //    Setup is abortable (cancel works during boot) and surfaces the real startup failure —
  //    the opencode log — instead of a bare "did not become ready".
  const { url, token } = await sandbox.previewUrl(ocPort);
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
    // The probe tally (waitReady's own message) comes FIRST: it says what the gate observed, and
    // the log tail is corroboration. The first instrumented prod failure proved the order matters —
    // the tally was thrown away here and the tail alone pointed at permissions on a healthy server.
    throw new Error(`opencode failed to start — ${reason}${log ? `\n--- agent log tail ---\n${log.slice(-1000)}` : ""}`);
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
          /**
           * A STATUS LADDER DRIVEN BY REAL OBSERVATIONS, not by optimistic timers.
           *
           * The first version spawned `npm install && npm run dev` fire-and-forget and emitted
           * `preview.ready` immediately — which told the founder "live" while `npm install` had
           * minutes left, and told them nothing at all when the dev server crashed on boot. Each
           * rung below is proven before it is claimed: `installing` ends when npm exits 0,
           * `booting` ends when the port ANSWERS from inside the sandbox, and `failed` carries the
           * dev-server log tail so the UI can quote the actual error.
           *
           * The status lives on the run's registry handle (`handle.preview`), which is what
           * `GET /v1/tasks/:id/preview` reads and what the `/v1/preview/:grant/*` proxy routes to.
           * `startPreview` returns immediately; the boot continues in the background so the HTTP
           * route that triggered it never blocks on an npm install.
           */
          const status: PreviewStatus = { stage: "starting", port: PREVIEW_PORT, startedAt: Date.now() };
          const handle = getRun(task.id);
          if (handle) handle.preview = status;
          const say = (note: string) => {
            void Promise.resolve(ctx.emit("progress", { note })).catch(() => {});
          };
          /**
           * ═══ AND PUBLISH IT WHERE ANOTHER REPLICA CAN READ IT ═══
           *
           * `handle.preview` above is process-local, and this run is on a WORKER while the browser's
           * request for `/v1/preview/*` lands on the API service. Without this the proxy could never
           * find the dev server and answered its "run is over" page every time. See
           * preview-target.ts for the whole argument.
           *
           * Every rung, not just `live`: a founder watching from another replica has to see
           * "installing" too, or the wait is indistinguishable from a run that never started.
           */
          const publish = () => void publishPreviewTarget(task.id, status, task.project_id);
          publish();
          void (async () => {
            try {
              status.stage = "installing";
              publish();
              say("preview: installing dependencies");
              /**
               * ═══ UNDER THE WORKSPACE LOCK, AND WRITTEN TO A FILE ═══
               *
               * node_modules is never seeded (workspace.ts DEFAULT_EXCLUDES), so the first boot pays
               * a real install — into the SAME directory `workspace.verify` installs into. Before
               * the lock those two could run at once, because this one is triggered by a founder
               * opening a tab and the other by the run reaching its end. Two npm processes writing
               * one `node_modules` corrupts it, and the run then fails with a verdict about the
               * agent's work that is really about the founder having looked at it.
               *
               * Written to a file and run by path rather than interpolated, for the reason
               * `verifyWorkspace` documents at length: `DaytonaSandbox.exec` hands its string to a
               * shell we do not control, and every quote in the lock preamble would close Daytona's
               * own wrapper and exit 2 without running a thing.
               *
               * Exit 75 is the lock timing out — reported as itself, because "we waited fifteen
               * minutes for the build's own install" is a different sentence from "npm failed".
               */
              const installScript = lockedScript(
                [
                  `cd ~/${ws.dir} || exit 2`,
                  "npm install --no-audit --no-fund > /tmp/preview-install.log 2>&1",
                  "echo MYCEL_NPM_EXIT=$?",
                ].join("\n"),
              );
              await sandbox.writeFile(PREVIEW_INSTALL_SCRIPT, installScript);
              const install = await sandbox.exec(`bash ~/${PREVIEW_INSTALL_SCRIPT}`, 900_000);
              if (install.code === 75) {
                throw new Error("timed out waiting for the build's own npm install to finish");
              }
              if (!install.stdout.includes("MYCEL_NPM_EXIT=0")) {
                throw new Error("npm install failed");
              }
              status.stage = "booting";
              publish();
              say("preview: dev server booting");
              /**
               * ═══ THE DEV LOCK IS PER-DIRECTORY, AND THE PORT SEPARATION NEVER PROTECTED US ═══
               *
               * `sandbox.ts` picks 4321 "deliberately not 3000 — the verify step boots its own
               * throwaway `next dev` on 3000". That was a defence against a PORT collision, and the
               * collision is not on the port. Next 16 takes a lock on the DIRECTORY, and both
               * servers run in ~/app. Read from a failed boot in production:
               *
               *     ✓ Ready in 472ms
               *     ⨯ Another next dev server is already running.
               *     - PID: 10398   - Dir: /root/app
               *
               * Which is verify's throwaway, still alive: `verify-build.sh` ends with
               * `kill $(cat /tmp/dev.pid)`, and that pid is the `npm run dev` WRAPPER. npm takes
               * the signal, the `next-server` grandchild is orphaned and keeps the lock. The port
               * split made this invisible rather than impossible — nothing ever collided on 4321,
               * so the guard looked like it was working for as long as Next 15 had no such lock.
               *
               * So clear the squatter before spawning. Scoped to port 3000 BY NUMBER, which is
               * verify's and cannot be the preview's: a blanket `pkill next` here would kill a live
               * preview the founder is watching every time the agent verified its own work.
               */
              await sandbox
                .exec(
                  [
                    `pids=$(command -v fuser >/dev/null 2>&1 && fuser 3000/tcp 2>/dev/null)`,
                    `[ -z "$pids" ] && pids=$(command -v lsof >/dev/null 2>&1 && lsof -ti tcp:3000 2>/dev/null)`,
                    // Last resort: no fuser, no lsof. /proc is always there, and a next-server whose
                    // cwd is the workspace and which is not ours is by definition the leak.
                    `[ -z "$pids" ] && pids=$(for d in /proc/[0-9]*; do grep -qs 'next' "$d/cmdline" 2>/dev/null && [ "$(readlink -f "$d/cwd" 2>/dev/null)" = "$HOME/${ws.dir}" ] && echo "\${d#/proc/}"; done)`,
                    `[ -n "$pids" ] && kill -9 $pids 2>/dev/null`,
                    // The lock file outlives the process it named, and Next trusts the file.
                    `rm -rf ~/${ws.dir}/.next/dev 2>/dev/null`,
                    `echo CLEARED="$pids"`,
                  ].join("\n"),
                  20_000,
                )
                .then((r) => {
                  const who = r.stdout.match(/CLEARED=(.+)/)?.[1]?.trim();
                  if (who) say(`preview: cleared a stale dev server (${who}) holding the workspace`);
                })
                .catch(() => {});
              /**
               * ═══ AND LEAVE A DEATH CERTIFICATE, SO A DEAD BOOT IS NOT WAITED OUT ═══
               *
               * The founder, watching the three-minute version: *"this is taking too long."* They
               * were right in a way the old loop could not see — Next had already printed its
               * refusal and EXITED, at second one. The loop polled a port that nothing would ever
               * answer for the remaining 179.
               *
               * `spawn` returns void and gives us no handle, so the shell records the exit itself.
               * Checked in the SAME exec as the probe, so watching for the corpse costs no extra
               * round trip. This is the general fix: any boot that dies — a missing dependency, a
               * syntax error in next.config, an OOM — now reports in seconds with its own log,
               * instead of three minutes and a sentence about time.
               */
              await sandbox.exec(`rm -f /tmp/preview.exit`, 10_000).catch(() => {});
              await sandbox.spawn(
                `cd ~/${ws.dir} && PORT=${PREVIEW_PORT} npm run dev > /tmp/preview.log 2>&1; echo $? > /tmp/preview.exit`,
              );
              // Probe FROM INSIDE the sandbox: the kernel may have no route to the port until the
              // Daytona preview link is minted, but 127.0.0.1 is always the truth about "is it up".
              const deadline = Date.now() + 180_000;
              let up = false;
              let died = false;
              while (Date.now() < deadline && !ctx.shouldAbort()) {
                const probe = await sandbox
                  .exec(
                    `curl -s -o /dev/null -m 3 -w '%{http_code}' http://127.0.0.1:${PREVIEW_PORT}/ || true; echo " gone=$(cat /tmp/preview.exit 2>/dev/null)"`,
                    10_000,
                  )
                  .catch(() => ({ stdout: "", stderr: "", code: 1 }));
                const out = probe.stdout.trim();
                // Any HTTP answer counts — a dev server serving a 404 or a compile-error overlay is
                // still a dev server the founder should be looking at.
                if (/^[1-5]\d\d\b/.test(out)) {
                  up = true;
                  break;
                }
                /*
                  ORDER MATTERS: the port is read first. A dev server that answered and then exited
                  between the two halves of this line is still a server worth showing, and calling it
                  dead because of a race would be the same false negative in a new costume.
                */
                if (/gone=\d/.test(out)) {
                  died = true;
                  break;
                }
                await new Promise((r) => setTimeout(r, 2_500));
              }
              if (died) throw new Error("the dev server exited instead of starting");
              if (!up) throw new Error("dev server did not answer within 3 minutes");
              // previewUrl mints the externally-reachable address (Daytona preview link / mapped
              // localhost); the port is already answering, so "live" is now a fact, not a hope.
              const preview = await sandbox.previewUrl(PREVIEW_PORT);
              status.url = preview.url;
              status.token = preview.token;
              status.stage = "live";
              publish();
              say("preview: live");
              await ctx.emit("preview.ready", { url: preview.url, token: preview.token, port: PREVIEW_PORT });
            } catch (e) {
              const tail = await sandbox
                .exec(`tail -c 1200 /tmp/preview.log /tmp/preview-install.log 2>/dev/null || true`, 10_000)
                .then((r) => r.stdout.trim())
                .catch(() => "");
              status.stage = "failed";
              status.error = `${(e as Error).message}${tail ? `\n${tail}` : ""}`.slice(0, 2000);
              publish();
              say(`preview: could not boot — ${(e as Error).message}`);
            }
          })();
        }
      : undefined;

  /**
   * ═══ WHAT THIS JOB NEEDS THAT THE IMAGE DOES NOT CARRY ═══
   *
   * Before the agent's first turn, deliberately: a library installed halfway through a run is a
   * library the agent already worked around, and the working-around is the expensive part.
   *
   * Under the workspace lock — `startPreview` and `workspace.verify` both run `npm install` in this
   * sandbox, and a third concurrent npm writing `node_modules` corrupts it, which is exactly the
   * failure WORKSPACE_LOCK_DIR was created for.
   *
   * FAIL SOFT, LOUDLY. An install that cannot complete must not fail the run: the agent may not need
   * the library for the path it takes, and killing a job that would have succeeded is worse than one
   * that reaches for something missing and says so. The progress note is what makes that
   * diagnosable rather than mysterious.
   */
  const declaredPackages = readPackages(
    (wedge?.manifest.task_types?.[task.task_type] as { packages?: unknown } | undefined)?.packages ??
      (wedge?.manifest as { packages?: unknown } | undefined)?.packages,
  );
  for (const f of declaredPackages.faults) {
    // Reported, never silently dropped: a dependency that vanishes is a run that fails later doing
    // something unrelated, with the agent spending its budget working out why.
    await ctx.emit("progress", { note: `not installing ${f.ecosystem} "${f.name}" — it ${f.why}` });
  }
  if (hasPackages(declaredPackages.packages)) {
    const names = [
      ...(declaredPackages.packages.npm ?? []),
      ...(declaredPackages.packages.pip ?? []),
    ];
    await ctx.emit("step.started", { step: "install_packages" });
    await ctx.emit("progress", { note: `installing for this job: ${names.join(", ")}` });
    try {
      await sandbox.writeFile(PACKAGE_INSTALL_SCRIPT, lockedScript(installScript(declaredPackages.packages)));
      const r = await sandbox.exec(`bash ~/${PACKAGE_INSTALL_SCRIPT}`, 600_000);
      if (r.code !== 0) {
        await ctx.emit("progress", {
          note: `could not install everything this job asked for — it will run without: ${(r.stdout || r.stderr || "").trim().slice(-400)}`,
        });
      }
    } catch (e) {
      await ctx.emit("progress", { note: `package install did not run: ${(e as Error)?.message ?? "unknown"}` });
    }
  }

  /**
   * ═══ WATCHING THE AGENT'S BROWSER — `operate` ONLY ═══
   *
   * The founder sees a list of tool calls today. `browseruse_browser_click {index: 14}` is an audit
   * trail, not something anybody watches, and it is close to useless for working out why a run went
   * wrong — because the interesting information is what the PAGE did, and 14 turns out to have been
   * a cookie banner.
   *
   * ═══ THE PORT IS READ, NOT ASSUMED ═══
   *
   * browser-use's `CHROME_DEBUG_PORT = 9242` is a red herring: `local_browser_watchdog.py` calls
   * `_find_free_port()` and passes that to `--remote-debugging-port`, so the real port is random per
   * launch and 9242 is never bound. Chromium writes what it actually bound to as the first line of
   * `DevToolsActivePort` in its user-data-dir — the documented mechanism every DevTools client uses
   * — so the port is read out of the sandbox rather than guessed, and this keeps working if
   * browser-use changes how it chooses one.
   *
   * The directory is browser-use's MCP default (`mcp/server.py` sets `user_data_dir` to
   * `~/.config/browseruse/profiles/default` unless config overrides it). If that ever moves, this
   * returns "the agent has not opened a browser yet", which is the honest failure: a wrong picture
   * would be far worse than none.
   *
   * ═══ ON DEMAND, AND CACHED ═══
   *
   * Same argument as `startPreview`, arrived at the hard way: an `operate` run nobody is watching
   * must not pay for a second CDP connection and a stream of JPEGs. The attach is cached, so a
   * poller calling this every second costs one socket, not one per tick.
   */
  let cast: import("./screencast").Screencast | undefined;
  let castAt = 0;
  const screen =
    profile.shape === "operate"
      ? async () => {
          const { findPageTarget, readDevToolsPort, Screencast } = await import("./screencast");
          if (cast?.alive) {
            const frame = cast.latest();
            return frame ? { frame } : { why: cast.why() };
          }
          // Re-attach at most every few seconds. The agent may not have opened a browser yet, and
          // spawning an exec per poll against a sandbox that has no browser is the sort of quiet
          // cost that only shows up on somebody's bill.
          if (Date.now() - castAt < 4_000) return { why: "waiting for the browser" };
          castAt = Date.now();
          try {
            const read = await sandbox.exec(
              "cat ~/.config/browseruse/profiles/default/DevToolsActivePort 2>/dev/null || true",
              10_000,
            );
            const port = readDevToolsPort(read.stdout ?? "");
            if (!port) return { why: "the agent has not opened a browser yet" };
            // The kernel may have no route to a sandbox-internal port until one is minted. Same
            // mechanism the dev-server preview uses, and it takes any port.
            const link = await sandbox.previewUrl(port);
            const target = await findPageTarget(link.url.replace(/\/$/, ""));
            if (!target) return { why: "the browser is open but has no page to watch yet" };
            cast = await Screencast.attach(target.webSocketDebuggerUrl);
            return { why: "connecting to the browser" };
          } catch (e) {
            return { why: `could not watch the browser: ${(e as Error)?.message ?? "unknown"}` };
          }
        }
      : undefined;

  // 4 + 5. Session + stream, under one finally that always revokes the proxy grant and clears
  // the abort watcher — even if session setup throws.
  const abort = new AbortController();
  let abortWatch: ReturnType<typeof setInterval> | undefined;
  let stallWatch: ReturnType<typeof setInterval> | undefined;
  let lastEventAt = Date.now();
  /** Consecutive provider retries with no real agent activity between them. See the loop below. */
  let providerRetryStreak = 0;
  /** The last thing the agent was seen doing, named in the stall message. See the watchdog below. */
  let lastActivity = "nothing yet — the agent never did anything we could name";
  /**
   * Tool calls issued and not yet answered, by call id.
   *
   * `lastActivity` alone named the wrong thing, and the note where it is set says the investigation
   * it misdirected concluded "a hung generation, not a dead process". The event log says otherwise.
   * Production task 55461956 issued three globs in one turn; two returned in about four seconds and
   * the third never did. The last EVENT was therefore a `tool.result` — from one of the calls that
   * WORKED — so the stall message read "after tool.result (glob)" and pointed at a finished call
   * while the run sat on an unfinished one.
   *
   * An outstanding call is the difference between "the model stopped thinking" and "we are waiting
   * on a tool", and those have completely different fixes. So they are tracked.
   */
  const outstandingCalls = new Map<string, string>();
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
    // One budget per run, owned here rather than in a module-level map keyed by session: a map would
    // outlive the runs in it and would be coordination state in process memory, which STANDARD.md §3
    // has a rule against for the reason it gives — state that only exists in a process vanishes on a
    // deploy and takes the answer with it.
    const resumeBudget = newResumeBudget();
    mapper = new OpenCodeEventMapper(sessionId);

    // Publish a live handle so a founder can steer this build and read its file tree while it runs.
    // Deregistered in the finally below on every exit path; the sandbox dies with the run, so the
    // handle must never outlive it.
    /**
     * The founder's channel into this run, serialised.
     *
     * `send` returns FALSE for a transient refusal and THROWS for a permanent one, which is the
     * distinction `SteerQueue` retries on — a daemon mid-tool-call is worth waiting a beat for; a
     * session that is gone is not.
     */
    steerQueue = new SteerQueue({
      send: async (text) => {
        await oc.startPrompt(sessionId, text, promptModel);
        return true;
      },
    });
    registerRun({
      taskId: task.id,
      projectId: task.project_id,
      sessionId,
      steer: steerQueue,
      oc,
      sandbox,
      model: promptModel,
      workspaceDir: ws?.dir,
      startPreview,
      screen,
    });

    /**
     * ═══ THE PREVIEW STARTS NOW, NOT WHEN SOMEBODY OPENS THE TAB ═══
     *
     * It was on demand, and the founder's verdict after months was "I have never seen the browser
     * preview in my life". The reason is a race it could not win:
     *
     *   · the ladder is `npm install` (a minute or two into a cold workspace) and then a dev server
     *     boot (up to three more) — call it two to five minutes from the tab opening;
     *   · the sandbox is destroyed in the orchestrator's `finally`, unconditionally, the instant the
     *     run ends;
     *   · so anyone who opened the pane late — or on a short run — watched "Installing dependencies"
     *     until the sandbox vanished underneath it and the pane said `gone`.
     *
     * Starting here means the install runs CONCURRENTLY with the agent's first turns, which are the
     * slowest part of a build anyway, and the dev server is usually up before the founder has
     * finished reading the first few lines of the ticker.
     *
     * The original argument for on-demand was cost: booting `next dev` in every build spends sandbox
     * CPU on a preview nobody looks at. That argument was correct and it was answered by the wrong
     * mechanism. It is a `build`-shape run in a workspace — the founder is watching their own site
     * being constructed, which is the single most-watched surface in the product — and a feature
     * that has never once worked costs strictly more than the CPU it was saving.
     *
     * `startPreview` is idempotent (`previewStarted`), so the HTTP POST the pane still sends on mount
     * remains correct and free. And it is `void`-ed: the boot must never delay the agent's first
     * prompt, which is what the founder is actually waiting for.
     */
    if (startPreview) void Promise.resolve(startPreview()).catch(() => {});

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
     * ═══ THE STALL WATCHDOG — a silent run must fail fast, not hang showing nothing ═══
     *
     * OBSERVED IN PRODUCTION: a GTM France build ran mycel-build (CodeBuild succeeded), started the
     * dev server, verified the routes, created output/ — and then the opencode stream went dead
     * silent at 17:52. The run stayed "running" with zero further events for 20+ minutes, all the
     * way toward its 60-minute deadline, while the founder watched a live preview that never moved
     * and had no idea it was over. `for await (const ev of stream)` blocks on the next event, so the
     * only thing that can rescue a silent stream is a timer. The abort registry (`shouldAbort`) only
     * knows about cancels, cost and the hard deadline; it cannot see "the model stopped talking".
     *
     * STALL_MS is deliberately longer than the longest legitimate quiet: `mycel-build` blocks up to
     * its 600s (10m) CodeBuild timeout with no stream traffic, so anything under that would kill a
     * healthy build waiting on the compiler. 15 minutes clears that with margin and still ends a
     * true hang in a quarter of the old 60-minute wait — with a message that says what happened.
     *
     * ═══ WHY THIS WATCHDOG WAS INERT, AND WHAT `lastEventAt` NOW MEASURES ═══
     *
     * OBSERVED IN PRODUCTION (2026-08-20/21, `gtm-operator/ops_distribution_tick`): 46 runs — about
     * a THIRD of every tick of that type — died on `aborted: max_runtime_exceeded` at the full 1800s
     * ceiling. In all of them the agent fired N parallel `glob` calls and got back N-1 results: one
     * `tool.result` never arrived, and the agent then sat waiting on it for ~29 minutes. The stall
     * watchdog above was armed the whole time and never fired ONCE.
     *
     * The reason is that `lastEventAt` was refreshed at the top of the loop on EVERY frame the
     * stream produced, and opencode heart-beats on that stream. A heartbeat is proof the SERVER is
     * alive; it is not proof the AGENT is doing anything. So the clock could never age past
     * STALL_MS while opencode was up, and the watchdog only ever caught the one failure mode where
     * the opencode process itself died and the socket went fully silent — never the far more common
     * one where opencode is healthy and the agent is blocked on a tool result that will never come.
     *
     * So the clock is now reset by AGENT ACTIVITY rather than by stream traffic: an event only
     * counts if the mapper turned it into something — an emission, a usage charge, a completion or
     * an error. Heartbeats, `session.status: busy`, ignored types and events belonging to another
     * session all leave the clock running, which is exactly what "nothing is happening" means.
     *
     * The loop still ITERATES on heartbeats, and that is deliberate and separate: iterating is what
     * lets the abort and contract checks below run promptly. Iterating is not progress.
     */
    const STALL_MS = 15 * 60 * 1000;

/**
 * How many provider retries in a row may pass with no work between them.
 *
 * Each one resets STALL_MS, so this is what stops a hard-down provider from holding a sandbox for
 * the whole of `max_runtime_s`. Twenty is generous against a real rate-limit — opencode backs off
 * between attempts, so twenty of them is many minutes of genuine trying — and it is well short of
 * "forever", which is what an uncounted reprieve amounts to.
 */
const MAX_PROVIDER_RETRY_STREAK = 20;
    let stalled = false;
    stallWatch = setInterval(() => {
      /**
       * A steered turn that never starts ends the run NORMALLY, not on the stall path.
       *
       * `steerDeadline` is set when an idle is spent extending the run for a steer, and cleared by
       * the first agent activity. If it expires, OpenCode took the prompt (204) and never ran it —
       * which is a real outcome the run should report as "finished, and your message was not picked
       * up", not fifteen minutes of silence followed by a stall error. `steerStarved` routes it to
       * the ordinary completion path below.
       */
      if (steerDeadline !== undefined && Date.now() > steerDeadline) {
        steerStarved = true;
        abort.abort();
        return;
      }
      if (Date.now() - lastEventAt > STALL_MS) {
        stalled = true;
        abort.abort();
      }
    }, 5000);
    (stallWatch as { unref?: () => void }).unref?.();

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
      /**
       * A REWRITE RUN NEEDS THE MATERIAL, NOT JUST THE BRIEF.
       *
       * `rewrite_skill` is told which procedure is failing by `input.candidate`, and a targeted brief
       * with nothing to study is still guesswork — it just guesses about the right file. The two
       * things it needs are the body it is replacing and the founder's own corrections, and both are
       * gathered HERE rather than when the task was queued: these runs sit in a queue for a while, and
       * the evidence that matters is the evidence at run time.
       *
       * Fails soft to whatever the caller sent. A rewrite with no edits attached is a weaker run, and
       * a rewrite that never happens because the rule store was briefly unreachable is a worse one.
       */
      let promptTask = task;
      /**
       * ═══ WHAT THIS BUSINESS'S OWN CLOSED DEALS SAY, BEFORE IT WRITES ANOTHER ONE ═══
       *
       * `draft_engagement` prices a proposal. Every previous negotiation this business ran is
       * already recorded — what was proposed, what the client asked to change, and what actually
       * moved — and nothing read it, so the twelfth proposal was written with exactly as much
       * knowledge as the first.
       *
       * The lessons report `asked` and `conceded` separately, always with the sample. That
       * distinction is the whole reason this is safe to put in a prompt: "clients asked about the
       * term in 4 of 5 and you held every time" tells the model to hold, where a version that merged
       * the two would tell it to pre-emptively discount against an objection this business wins.
       */
      if (task.task_type === DRAFT_ENGAGEMENT_TASK_TYPE && task.project_id) {
        const lessons = await dealLessonsFor(task.project_id).catch(() => undefined);
        if (lessons) {
          promptTask = { ...task, input: { ...(task.input as object), your_own_closed_deals: lessons } };
        }
      }
      if (task.task_type === "draft_service") {
        /**
         * THE RESEARCH, READ AT RUN TIME rather than threaded through the task input.
         *
         * Same reason the note above gives for the rewrite candidate: these runs sit in a queue, and
         * the evidence that matters is the evidence when the run starts. A `research_service` that
         * finished while this was queued is exactly the case worth catching.
         *
         * The most recent successful one for this project, and nothing older than a week — a market
         * read from a different business's shaping session is worse than none, and this wedge is used
         * once per business.
         */
        /**
         * AND WHAT THE FOUNDER SAID THEY ACTUALLY DO.
         *
         * The research says what the trade delivers; this says which of it is theirs. A drafter
         * given only the research writes the average firm's service — the one the web describes —
         * and a founder who does two of the eight things it found gets six jobs they never sell.
         *
         * Absent when they have not answered, which is the behaviour that existed before this and
         * is a known outcome rather than a wrong one.
         */
        promptTask = { ...task, input: await draftServiceInput(getDomainStore(), task) };
      }

      await oc.startPrompt(
        sessionId,
        buildPrompt(
          promptTask,
          wedge,
          profile,
          grounding.files.length,
          docCount,
          ws?.dir,
        ),
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
        // NOT `lastEventAt = Date.now()` — see the stall watchdog comment above. Arriving on the
        // socket is not activity; opencode heartbeats arrive forever while the agent is wedged.
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
        /**
         * Which skills the agent is opening, read off the stream we are already consuming.
         *
         * Every emission's data, not just `tool.called`, and not filtered by tool name — the agent
         * may open a skill with `read`, with `bash cat`, with `grep`, or from a script it wrote a
         * moment ago, and a matcher over tool names would miss most of that SILENTLY. The same
         * argument the contract watcher makes a few hundred lines down. `skill-attention.ts` bounds
         * the work and stops early once every mounted skill has been seen.
         */
        for (const e of mapped.emissions) attention.observe(e.data);
        /**
         * ═══ A RETRY KEEPS THE RUN ALIVE, BUT IT MAY NOT DO SO FOREVER ═══
         *
         * A retryable provider error is not a failed turn (see `mapError` in opencode.ts), so it
         * must not be allowed to kill the run — but it is also not WORK, and it arrives on a cadence.
         * Counting it as ordinary activity resets STALL_MS every time, so a provider that is hard
         * down and retried every few seconds would hold a sandbox open until `max_runtime_s` with
         * nothing to show for it. That is the shape of the bug `kortix-ai/suna` fixed one hop
         * downstream in their stream reader: a frame proving the daemon is alive was counted as
         * proof the RUNTIME was doing something, and at a 20s cadence it "suppressed a genuinely
         * dead opencode's probe failures roughly three quarters of the time."
         *
         * So a retry buys the run a reprieve from the stall clock, and the reprieves are counted.
         * Real activity — a token, a tool call, usage — resets the count, because a provider that
         * recovered and then throttles again later is a different event, not a continuation.
         */
        if (mapped.retryable) {
          providerRetryStreak += 1;
          if (providerRetryStreak > MAX_PROVIDER_RETRY_STREAK) {
            throw new Error(
              `the model provider failed ${providerRetryStreak} times in a row with no work in between — ` +
                `opencode kept retrying and never got through`,
            );
          }
        } else if (isAgentActivity(mapped)) {
          providerRetryStreak = 0;
        }
        // The agent did something we can name. THIS is what keeps the stall clock alive.
        if (isAgentActivity(mapped)) {
          lastEventAt = Date.now();
          // The steered turn started. Whatever it does next is bounded by the ordinary watchdog.
          steerDeadline = undefined;
          // WHAT it was doing, not just THAT it was doing something. A stall message that cannot
          // name the last activity sent this investigation to the wrong place for two days: the
          // text below used to assert the cause was "the agent process dying after a build step",
          // and the 90 production stalls it was describing were `ops_distribution_tick` runs that
          // never build anything. Sixteen of the twenty most recent died immediately after a `glob`
          // RESULT — the tool returned and the next model turn never produced a token. That is a
          // hung generation, not a dead process, and no amount of reading this code would have
          // shown it. Only the event log did. So the run now carries its own last breadcrumb.
          const act = mapped.emissions[mapped.emissions.length - 1];
          if (act) {
            const d = (act.data ?? {}) as Record<string, unknown>;
            const name = d.tool ?? d.name ?? d.step;
            lastActivity = typeof name === "string" && name ? `${act.type} (${name})` : act.type;
          }
          // Every emission, not only the last — a turn can issue three calls in one frame, which is
          // exactly the shape that produced the bug this tracks.
          for (const e of mapped.emissions) {
            const d = (e.data ?? {}) as Record<string, unknown>;
            const id = typeof d.call_id === "string" ? d.call_id : "";
            if (!id) continue;
            if (e.type === "tool.called") {
              const tool = typeof d.tool === "string" ? d.tool : "tool";
              const args = d.args ? JSON.stringify(d.args).slice(0, 120) : "";
              outstandingCalls.set(id, args ? `${tool} ${args}` : tool);
            } else if (e.type === "tool.result") {
              outstandingCalls.delete(id);
            }
          }
        }
        for (const e of mapped.emissions) await ctx.emit(e.type, e.data);
        if (mapped.usage) chargeUsage(ctx, model, tier, mapped.usage);
        if (mapped.error) {
          /**
           * ═══ A BROKEN PIPE IS NOT A FAILED JOB ═══
           *
           * See turn-resume.ts for the whole argument and where it came from. Short version: a turn
           * that dies from an upstream idle timeout or a 502 has nothing wrong with it, and this
           * throw makes it a failed task — which `queue.ts` will not retry, correctly, because a run
           * past the approval gate may already have sent an email.
           *
           * Resuming the TURN is not retrying the task. It carries on in the same session with the
           * same context, the same executed tool calls and the same approval history, so it is the
           * one recovery move `maxAttempts: 1` permits.
           *
           * It can only ever turn a failure into a continuation: an error it does not recognise as
           * transient falls straight through to the throw below, exactly as before, and a spent
           * budget does the same.
           */
          const delay = resumeEnabled() && isTransientTurnError(mapped.error)
            ? nextResumeDelay(resumeBudget)
            : undefined;
          if (delay === undefined) throw new Error(mapped.error);

          await ctx.emit("progress", {
            note: `the model provider dropped the connection — waiting ${Math.round(delay / 1000)}s and carrying on from where it stopped`,
          });
          await new Promise((r) => setTimeout(r, delay));
          // Cancellation beats recovery. A founder who stopped the run during the backoff must not
          // have it quietly restarted by this block.
          if (ctx.shouldAbort()) throw new Error(mapped.error);
          noteResume(resumeBudget);
          await oc.startPrompt(sessionId, resumePrompt(mapped.error), promptModel);
          // The stall watchdog measures time since the last AGENT activity, and a resume is activity
          // — without this the backoff counts against a clock that is about to kill the run it is
          // recovering.
          lastEventAt = Date.now();
          continue;
        }
        if (mapped.done) {
          /**
           * ═══ AN IDLE AFTER A STEER IS A BOUNDARY, NOT THE END ═══
           *
           * OpenCode persists a prompt posted during a live turn and queues its execution BEHIND
           * that turn — Suna's `session-lifecycle/store.ts`: "between the POST and the turn there is
           * a real interval in which the message exists, belongs to the transcript, and has not run."
           *
           * This branch used to abort and break unconditionally. So every mid-turn steer went:
           * founder steers, OpenCode queues it, the original turn ends, `session.idle` arrives, and
           * WE ABORT AND DESTROY THE SANDBOX before the queued prompt is ever picked up. The message
           * was accepted, written to the feed, and then killed by us. From the founder's side that
           * is indistinguishable from "it didn't send", which is how it was reported.
           *
           * So a steer buys one more turn. Bounded by `MAX_STEER_TURNS` — a founder who keeps
           * talking should keep being answered, but not without limit — and still inside the run's
           * own `max_runtime_s` and the stall watchdog, which are the real ceilings. A steer that
           * OpenCode never runs therefore ends the run on the stall path with a reason, rather than
           * hanging.
           */
          if (steerTurns < MAX_STEER_TURNS && steerQueue?.noteTurnBoundary()) {
            steerTurns += 1;
            await ctx.emit("progress", { note: "picking up what you said" });
            // The steered turn is real activity, so the stall watchdog measures from here — a slow
            // first token must not count against a clock that started before the founder typed.
            lastEventAt = Date.now();
            /**
             * AND A BOUND ON WAITING FOR IT, because a 204 proves nothing.
             *
             * Suna verified directly against the daemon that `POST /session/:id/prompt_async`
             * "answers 204 for an agent it cannot run", and their delivery loop read that as success
             * while "the user's text is gone with no queue row, no transcript bubble, no error, and
             * nothing to retry" (measured, session 65216cc6, 2026-08-26).
             *
             * We accept a 204 as delivered too. So a steer OpenCode silently discards would leave
             * this branch waiting for a turn that never starts — and without this bound that turns
             * "the run finished and ignored your message" into "the run hung for fifteen minutes and
             * then failed on the stall path", which is strictly worse for everybody.
             *
             * So the extension is granted, and then withdrawn if nothing happens. Measured against
             * PROGRESS: any agent activity clears it, so a turn that really is starting is never
             * cut off.
             */
            steerDeadline = Date.now() + STEER_TURN_START_MS;
            continue;
          }
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
      /**
       * The run DID finish — the original turn completed and everything it produced is real. What
       * did not happen is the steered turn. Reported as a fact about the founder's message rather
       * than as a failure of the work, because the work is fine.
       */
      if (steerStarved) {
        await ctx.emit("progress", {
          note:
            "the run finished before your message was picked up — the agent accepted it and never " +
            "started a turn for it. Nothing was lost from the work itself; send it again on the next run.",
        });
        done = true;
      } else if (stalled)
        throw new Error(
          // Name the call we are actually WAITING ON, when there is one. "after tool.result (glob)"
          // described a call that had finished; "waiting on glob {path:'/'}" is the fault itself.
          `the run stopped responding — no activity for 15 minutes ${
            outstandingCalls.size
              ? `while waiting on ${outstandingCalls.size} unanswered tool call(s): ${[...outstandingCalls.values()].slice(0, 3).join("; ")}`
              : `after ${lastActivity}`
          }, so it was ` +
            "ended rather than left hanging. The work up to the stall is in the run's events. If the " +
            "last activity was a tool RESULT, the tool returned and the model turn after it never " +
            "produced a token — a hung generation upstream, not a dead sandbox, and retrying is the " +
            "right response. If it was a tool CALL, the tool itself never came back.",
        );
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
    // And the shared copy, for the same reason and on the same exit path. The sandbox dies with the
    // run, so a row that outlives it points the proxy at an address that no longer answers — the
    // founder would get a connection error where the honest answer is "this run is over". The TTL is
    // only the backstop.
    void clearPreviewTarget(task.id);
    // Answer anything still queued. A pending promise that never settles is worse than a failure:
    // the route holds its connection open and nothing anywhere says the run ended.
    steerQueue?.close();
    // The screencast socket points INTO the sandbox, which is destroyed a few lines further out.
    // Closed here rather than left to garbage collection, because a websocket nobody closes is a
    // reconnect loop against a host that no longer exists. Best effort: `stop()` swallows a browser
    // that has already gone, which is the ordinary case.
    cast?.stop();
    if (abortWatch) clearInterval(abortWatch);
    if (stallWatch) clearInterval(stallWatch);
    if (contractWatch) clearInterval(contractWatch);
    if (nonce) await revokeGrant(nonce);
    if (actionNonce) await revokeActionGrant(actionNonce);
    if (buildNonce) await revokeBuildGrant(buildNonce);
    // Reported from the `finally` so it survives the failure path too. A run that failed BECAUSE
    // the protocol moved is precisely the run whose drift counter is worth reading.
    const drift = mapper?.unmapped;
    if (drift && Object.keys(drift).length) ctx.onDrift?.(drift);

    /**
     * The second attribution pass: what the agent actually opened.
     *
     * In the `finally` for the same reason the drift counter is — a run that STALLED is exactly the
     * run whose attention data is worth having, because "the agent never opened the procedure it
     * needed" is one of the more likely explanations and the only way to see it is to record it on
     * the failure path too.
     *
     * Upserts over the rows written before the first turn, so this replaces rather than doubles.
     * `void` and caught: attribution is bookkeeping, and bookkeeping must never be the reason a
     * finished run reports a failure.
     */
    if (task.project_id) {
      void recordSkillUses(getDomainStore(), {
        project_id: task.project_id,
        task_id: task.id,
        wedge: task.wedge,
        skills: attention.uses(),
        arm,
      }).catch((e) => console.error("[mycel] recordSkillUses (attention) failed:", e));
    }
  }

  // 6. The artifact that MET THE CONTRACT wins outright — it is the thing we verified, and the
  //    agent's closing prose ("I've written the final notice to output/result.txt") would otherwise
  //    replace a schema-valid document with a sentence about it. Otherwise prefer the streamed final
  //    text, and fall back to whatever the agent left on disk.
  /**
   * The gaps travel WITH the answer.
   *
   * `decideFate` holds a gapped run back from a client (see client-ready.ts), and it can only do
   * that if it knows. Computed hundreds of lines above, at the point the connections were resolved,
   * and returned here rather than recomputed — a second derivation of "what could this run not do"
   * is a second thing that can disagree with the first, and the one that disagrees silently is the
   * one the client sees.
   */
  /**
   * ═══ DID THE FILES IT NAMED ACTUALLY GET WRITTEN? ═══
   *
   * The `artifacts` contract asks a deliverable to carry the work, and the prompt says a path with
   * no file behind it is worse than an empty array. The first run under that contract named a
   * ledger CSV and a sales-tax return, wrote neither, and passed every gate — because naming a file
   * satisfies a schema exactly as well as writing one does.
   *
   * That is the failure a schema cannot close and a model cannot be trusted to close, so it is
   * checked against the filesystem. Cheap: one `ls` of the output directory, once, at the end of a
   * run that has already spent minutes.
   *
   * Reported, not thrown. The work up to here may be genuinely good and the founder should see it —
   * `decideFate` holds it rather than the run failing, which is the same call `ship_checks` makes
   * about a wrong total.
   */
  const declared = satisfied || finalText;
  const missingArtifacts = await missingArtifactPaths(sandbox, declared);
  // A file that exists but does not parse is a different fault from one that was never written, and
  // both are repairable by the agent that has the data. See `malformedArtifacts`.
  const brokenArtifacts = await malformedArtifacts(sandbox, declared);
  if (satisfied) return { text: satisfied, capabilityGaps, missingArtifacts, brokenArtifacts };
  return { text: finalText, capabilityGaps, missingArtifacts, brokenArtifacts };
}

/**
 * Paths a run CLAIMED in `artifacts` that no file exists at.
 *
 * Fails soft to `[]` everywhere: unparseable output is `validateOutput`'s problem, and a sandbox
 * that cannot be read is an infrastructure fault that must not be reported to a founder as "your
 * bookkeeper did not write the ledger".
 */
/**
 * The files a run SAYS it wrote, so the orchestrator can fetch them before the sandbox dies.
 *
 * Exported because two callers need the same list and must not disagree about it: this module
 * checks the paths exist, the orchestrator collects them. Two readings of "what did it claim" is
 * how one of them ships a file the other reported as missing.
 *
 * `file` only. A `url` or `repo` is not ours to fetch.
 */
/**
 * The path a client should see, from the path the run wrote.
 *
 * `./output/` is OUR instruction to the agent — the `deliver` shape tells it where to put files —
 * and it has no business appearing in a manifest a client reads. Worse, it made the declared name
 * and the delivered name differ: the run declared `output/july-2026-reconciled-ledger.json` and the
 * artifact was stored as `july-2026-reconciled-ledger.json`, so a reader matching one to the other
 * found nothing. A client did exactly that and said "they say they produced a reconciled ledger and
 * VAT working paper, but neither file was actually supplied" — about two files that were.
 *
 * One helper, because the phantom-artifact check already stripped this prefix and the client-facing
 * manifest did not. Two places normalising the same thing differently is how that gap opened.
 */
export const artifactPathForClient = (p: string): string =>
  p.replace(/^\.?\//, "").replace(/^output\//, "");

/**
 * Rewrite `artifacts[].path` in a parsed output to the names the client actually receives.
 *
 * In place and on the parsed object, so the manifest, the deliverable and anything matching paths to
 * artifacts all read the same string.
 */
export function normaliseArtifactPaths(parsed: Record<string, unknown> | null): void {
  const arts = parsed?.artifacts;
  if (!Array.isArray(arts)) return;
  for (const a of arts) {
    // `file` only, exactly like `declaredArtifactPaths`. A `url` or `repo` points somewhere we do not
    // own, and stripping a prefix out of somebody else's address is how you break a link.
    const item = a as { kind?: unknown; path?: unknown };
    if (item?.kind !== "file") continue;
    if (typeof item.path === "string" && item.path) item.path = artifactPathForClient(item.path);
  }
}

export function declaredArtifactPaths(text: string): { path: string }[] {
  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const arts = (parsed as { artifacts?: unknown })?.artifacts;
  if (!Array.isArray(arts)) return [];
  const out: { path: string }[] = [];
  for (const a of arts) {
    const item = a as { kind?: unknown; path?: unknown };
    if (item?.kind !== "file" || typeof item.path !== "string" || !item.path) continue;
    out.push({ path: artifactPathForClient(item.path) });
  }
  return out;
}

/**
 * ═══ A DATA FILE THAT DOES NOT PARSE IS BROKEN WORK, NOT A DELIVERABLE ═══
 *
 * The ledger went out with `Studio rent, July` unquoted. CSV's one rule, and breaking it shifts every
 * column right from that row on, so a spreadsheet shows the counterparty under `description` and the
 * category under `counterparty` for the rest of the file. The client opened it and said what it was:
 * "the CSV is not delivered to a professional standard: multiple descriptions contain commas but are
 * not quoted, so it is not reliably machine-readable."
 *
 * Everything else the gate owns reads the model's JSON. The FILES are the work — that is the whole
 * point of the `deliver` shape — and nothing had ever looked at one. This is the narrow version of
 * that: not "is the ledger correct", which needs a trade, but "does this file parse as the format it
 * claims", which is decidable here with no model and the same answer every time.
 *
 * Deliberately only CSV, and only field-count consistency. It is the format we tell runs to use for
 * anything a client opens in a spreadsheet, it is the one they get wrong, and a row whose field count
 * differs from the header is unambiguous — no quoting subtlety, no dialect argument, no judgement.
 * A check that needed judgement would eventually hold good work and be deleted.
 */
export function malformedCsv(name: string, content: string): string | undefined {
  const lines = content.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return undefined;
  const fields = (line: string): number => {
    let n = 1;
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        // "" inside a quoted field is an escaped quote, not a close.
        if (quoted && line[i + 1] === '"') i++;
        else quoted = !quoted;
      } else if (ch === "," && !quoted) n++;
    }
    return n;
  };
  const want = fields(lines[0]!);
  for (let i = 1; i < lines.length; i++) {
    const got = fields(lines[i]!);
    if (got === want) continue;
    return (
      `"${name}" is not valid CSV: line ${i + 1} has ${got} field${got === 1 ? "" : "s"} where the ` +
      `header has ${want}. A value containing a comma must be in double quotes — unquoted, every ` +
      `column after it shifts right and the file reads as nonsense in a spreadsheet.`
    );
  }

  /**
   * ═══ AND THE HEADER ROW IS NOT OURS TO WRITE IN OUR OWN WORDS ═══
   *
   * Structure was the only thing checked here, and a perfectly-formed CSV whose first line reads
   * `date,amount_minor,description` has still failed. `amount_minor` is this platform's internal
   * representation of money; a client's accountant opening the ledger we sent should never learn
   * that we hold pence as integers, any more than they should see the word "wedge".
   *
   * The shortest path from a result object to a file is `Object.keys(row)`, which is exactly how
   * this happens, and it happened in two of this repo's own workflows. The same rule runs on
   * workbook columns in `render/taste.ts` — one definition, wherever a header row appears.
   */
  const machine = machineHeaders(splitCsvLine(lines[0]!));
  if (machine.length) {
    return (
      `"${name}" has ${machine.map((h) => `"${h}"`).join(", ")} in its header row. ` +
      `Those are field names, not column headings — write what the column means to the person ` +
      `opening the file: "Amount", not "amount_minor". A client should never see how we store things.`
    );
  }
  return undefined;
}

/** One CSV line to its fields, respecting quotes. Only ever used on a header row. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else quoted = !quoted;
    } else if (ch === "," && !quoted) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((f) => f.trim());
}

/** Declared files that exist but do not parse as what their extension claims. */
async function malformedArtifacts(sandbox: Sandbox | undefined, text: string): Promise<string[]> {
  if (!sandbox || !text) return [];
  const faults: string[] = [];
  for (const { path } of declaredArtifactPaths(text)) {
    if (!/\.csv$/i.test(path)) continue;
    const body = await sandbox.readFile(`output/${path}`).catch(() => null);
    if (typeof body !== "string" || !body.trim()) continue; // Absent is the phantom check's job.
    const fault = malformedCsv(path, body);
    if (fault) faults.push(fault);
  }
  return faults;
}

async function missingArtifactPaths(sandbox: Sandbox | undefined, text: string): Promise<string[]> {
  if (!sandbox || !text) return [];
  const missing: string[] = [];
  // The SAME list the orchestrator collects from — see `declaredArtifactPaths`. Only `file` makes a
  // claim about our filesystem; a `url` or `repo` points somewhere we cannot reach, and "we could
  // not check" must never be reported as "it is missing".
  for (const { path } of declaredArtifactPaths(text)) {
    const found = await sandbox.readFile(`output/${path}`).catch(() => null);
    if (found === null || found === undefined) missing.push(path);
  }
  return missing;
}

/**
 * A run refused by the compiler, carrying every reason rather than the first.
 *
 * A distinct class because this is NOT a crash and must never be logged as one: nothing went wrong,
 * the job was asked to do work it was not equipped to do, and the fix is a wedge edit rather than a
 * retry. Retrying an unequipped job just spends the budget again.
 */
export class CompileRefused extends Error {
  constructor(readonly refusals: readonly Refusal[]) {
    super(`not equipped to run — ${refusals.map((r) => r.message).join(" ")}`);
    this.name = "CompileRefused";
  }
}

/** The ship bar for this run, if the wedge declares one. Mirrors the orchestrator's read. */
function shipRequiresFor(task: Task, wedge: LoadedWedge | null): string[] {
  const raw = (wedge?.manifest.task_types?.[task.task_type] as { ship_requires?: unknown } | undefined)?.ship_requires;
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
}

/** The schema this run must answer in, if any. Wedge task_type first, then the task's own. */
function outputSchemaFor(task: Task, wedge: LoadedWedge | null): unknown {
  return wedge?.manifest.task_types?.[task.task_type]?.output_schema ?? task.output_schema;
}

/** Which of the wedge's skills this task type gets. Undefined `profile.skills` means all of them. */
/**
 * ═══ IS THIS JOB EQUIPPED TO PRODUCE EXPERT WORK — ASKED BEFORE ANYTHING RUNS ═══
 *
 * `compile()` answers exactly this, and it only ever gets asked mid-run, one task at a time, where
 * the answer arrives as a thrown refusal after a founder pressed go. Its own header says the
 * question is answerable "from data, before a sandbox boots and before a token is spent" — and
 * until now nothing asked it that way.
 *
 * IT LIVES HERE, NOT IN A ROUTE, because `profileSkills` is private to this file and reproducing it
 * elsewhere would be a second implementation of "what craft does this job actually have". Two
 * answers to that question is precisely how a readiness screen ends up disagreeing with what
 * happens when you press the button, which is worse than having no screen.
 *
 * ONLY THE AUTHOR-CONTROLLED REFUSALS. `missing_access` is dropped, for the same reason the run
 * path drops it: a client mid-onboarding with two connections out of five is not a broken service,
 * and a readiness panel that said so would be telling founders their business is unequipped when
 * what they need is to finish connecting things. The other four — a definition of done, written
 * craft, a human ceiling, a bar for what ships — are things a wedge author controls and none of
 * them is fixed by waiting.
 */
export function jobReadiness(args: {
  wedge: LoadedWedge | null;
  taskType: string;
  projectId?: string;
  plan?: Plan;
  ceilings: { maxRuntimeS: number; maxCostUsd: number };
  /** Library craft for this wedge's domains, resolved by the caller (it reads the disk). */
  library?: WedgeFile[];
}): { ok: boolean; refusals: Refusal[] } {
  const { wedge, taskType } = args;
  const tt = wedge?.manifest.task_types?.[taskType] as Record<string, unknown> | undefined;
  if (!wedge || !tt) return { ok: true, refusals: [] };

  /**
   * A synthetic task, carrying only what the compiler reads off one: its type and its wedge. The
   * four refusals below are properties of the JOB, not of any particular run — that is the whole
   * reason this can be answered in advance — so no real ids are needed and inventing some would
   * imply a scope this check does not have.
   */
  const task = { task_type: taskType, wedge: wedge.manifest.wedge, project_id: args.projectId } as Task;
  const profile = resolveHarnessProfile({ task, wedge, ...(args.plan ? { plan: args.plan } : {}), ceilings: args.ceilings });

  const result = compile({
    task,
    profile: {
      shape: profile.shape,
      strict_output: profile.strict_output,
      max_runtime_s: profile.max_runtime_s,
      max_cost_usd: profile.max_cost_usd,
      grants_actions: profile.grants_actions,
    },
    outputSchema: (tt.output_schema ?? null) as Record<string, unknown> | null,
    shipRequires: Array.isArray(tt.ship_requires) ? (tt.ship_requires as string[]) : undefined,
    deliverableShapes: wedge.manifest.fulfillment?.deliverable_shapes,
    internalTaskType: tt.internal === true,
    hasDeclaredShape: readDeliverableShape(tt.deliverable_shape) !== undefined,
    // The SAME resolver the run uses. Live overlays are not applied: this asks whether the service
    // as authored is equipped, which is the question a founder can act on.
    skills: profileSkills(wedge, profile, [], taskType, args.library ?? []).map((sk) => ({
      name: sk.name,
      content: sk.content,
    })),
  });

  if (result.ok) return { ok: true, refusals: [] };
  const refusals = result.refusals.filter((r) => r.code !== "missing_access");
  return { ok: refusals.length === 0, refusals };
}

function profileSkills(
  wedge: LoadedWedge | null,
  profile: HarnessProfile,
  live: Array<{ name: string; content: string; updated_at?: string; metadata?: Record<string, unknown> }> = [],
  taskType?: string,
  library: WedgeFile[] = [],
  /**
   * Which side of a running trial this task is on. Defaults to the arm with evidence behind it, so
   * every caller that does not pass one — and every run before trials existed — reads the incumbent.
   */
  arm: "incumbent" | "challenger" = "incumbent",
) {
  // The wedge's own skills, plus shared-library skills for its domains that it does not already
  // define. Merged BEFORE overlay so a library skill gets task-type filtering and can be disabled by
  // a tenant overlay, and so a wedge's own skill of the same name wins outright.
  const own = new Set((wedge?.skills ?? []).map((s) => (s.name.endsWith(".md") ? s.name : `${s.name}.md`)));
  const disk = [...(wedge?.skills ?? []), ...library.filter((s) => !own.has(s.name.endsWith(".md") ? s.name : `${s.name}.md`))];
  const all = overlayPlaybooks(disk, live, taskType, arm);
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
    /**
     * The contract BEFORE the payload, so the JSON below is read as answers rather than as noise.
     *
     * See input-contract.ts for the run that made this necessary: a weekly_report was handed eight
     * already-measured queries, could not tell they were measurements, went and re-probed, and
     * joined on "batch joined with no successful children" having written nothing.
     */
    ...describeInputContract(tt?.input_schema),
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
     * ═══ AND WHAT THE SCHEMA CANNOT SAY ═══
     *
     * The schema above is a SHAPE. It cannot say that a summary of fourteen words is not a summary,
     * that a total has to equal its own lines, that every recommendation needs a mechanism and not
     * just the first one, or that "seamless" is not a description of work. Those are `ship_requires`
     * and `ship_checks`, and until this line the agent was never shown a single one of them.
     *
     * So the kernel graded every run against a contract the run had not seen. A near-miss that a
     * sentence would have fixed became a hold, which costs the founder an afternoon and teaches the
     * agent nothing — it would produce exactly the same output next time. A contract you are graded
     * against and not shown is not a contract; it is a trap.
     *
     * Placed directly after the schema on purpose. The two are one statement of what a good answer
     * is, and separating them would let a reader satisfy the first and skim the second.
     */
    ...(() => {
      // The SAME contract the orchestrator grades against — declared plus whatever the output
      // schema's shape implies. Reading `tt.ship_checks` directly here meant that for the 31 task
      // types declaring none, this block produced nothing and the agent was told no rules, then
      // held against inferred ones it had never seen. That is the trap described above, so the two
      // call sites share one function.
      const contract = effectiveShipContract(tt as Record<string, unknown> | undefined);
      const lines = describeShipContract(
        contract.ship_requires.length ? contract.ship_requires : undefined,
        contract.ship_checks,
      );
      return lines.length
        ? [
            `Before you answer, check it against every one of these. The kernel checks the same list ` +
              `and will hold the work from the client if any of them fails:\n${lines.map((l) => `  - ${l}`).join("\n")}`,
          ]
        : [];
    })(),
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
  /**
   * ═══ WHAT THE FIRM ALREADY KNOWS ABOUT THIS CLIENT ═══
   *
   * `Client.preferences` has said, in the contract, since it was written: "operational settings
   * (tone, timezone, billing day) — the agent should be able to read one without a search." The
   * agent could not read one at all. Nothing on this path had ever fetched the client.
   *
   * A close ran nine times and told the same client nine times that their VAT scheme was unknown,
   * their return period was not supplied and their deadlines could not be stated — while the
   * platform held a `Client` row with a `preferences` object built for exactly this. The client's
   * verdict was the obvious one: "for $400 a month, they should obtain or verify these basic facts."
   *
   * A firm that asks the same question every month is not a firm anyone keeps. This is the general
   * fix, not a VAT one: a durable fact about a client — their scheme, their tone, their billing day,
   * their timezone — is asked once and known afterwards.
   */
  client?: { display_name?: string; metadata?: Record<string, unknown>; preferences?: Record<string, unknown> },
  /**
   * Whether `mycel-check` was actually written into this box.
   *
   * Threaded rather than recomputed, unlike `imageProviderFromEnv()` a few lines below. That one
   * can be re-derived from the environment and is right by construction; this one depends on a
   * `writeFile` that is allowed to fail soft, and documenting a tool that is not installed is the
   * same defect as pointing at an unmounted template — the next real pointer gets skimmed with it.
   */
  checkTool = false,
  /**
   * The staged craft shelf, when this run has one: how many procedures are on disk and how big the
   * whole shelf is.
   *
   * Present so the prompt can NAME `craft/INDEX.md` and say how partial the view is. openwork's
   * tool catalog does exactly this — "PARTIAL — 12 of 40 shown" — and changes its own workflow
   * instructions to match, because a menu that does not say what is missing is read as the whole
   * world.
   */
  craftShelf?: { staged: number; shelf: number },
  /**
   * What this business's own agent wrote down about this before.
   *
   * LAST in the list and passed IN rather than fetched here, because this function is synchronous
   * and must stay that way: every prompt-size test drives it directly, and an async prompt builder
   * would make all of them need a store. The caller does the recall; this only renders it.
   */
  memories?: MemoryDoc[],
): string {
  const parts: string[] = [];
  parts.push(`# ${wedge?.manifest.title ?? `Mycel agent — ${task.wedge}`}`);
  parts.push("");
  parts.push(`You are fulfilling a "${task.task_type}" task for the "${task.wedge}" wedge.`);
  parts.push("");
  /**
   * Near the top, because it changes how the rest is read. A close that learns on line 200 that the
   * client is on the flat rate scheme has already computed the wrong VAT.
   *
   * Facts only — no invitation to infer. An empty `preferences` prints nothing rather than "no
   * preferences recorded", which reads as a finding and is not one.
   */
  const clientFacts: string[] = [];
  for (const [k, v] of Object.entries({ ...(client?.metadata ?? {}), ...(client?.preferences ?? {}) })) {
    if (v === null || v === undefined || v === "") continue;
    if (typeof v === "object" && !Array.isArray(v)) continue; // Nested settings are not facts for a prompt.
    clientFacts.push(`- ${k}: ${Array.isArray(v) ? v.join(", ") : String(v)}`);
  }
  if (client?.display_name || clientFacts.length) {
    parts.push("## What we already know about this client");
    parts.push("");
    if (client?.display_name) parts.push(`- name: ${client.display_name}`);
    parts.push(...clientFacts.slice(0, 40));
    parts.push("");
    parts.push(
      "These are recorded facts, not guesses — use them. Asking a client again for something the " +
        "firm already has on file is the fastest way to look like nobody is paying attention.",
    );
    parts.push("");
    parts.push(
      "If one of them is a CURRENCY, it is this client's — the money their documents are priced and " +
        "paid in, which is not always the money this firm keeps its own books in. Never assume one.",
    );
    parts.push("");
  }
  /**
   * ═══ WHERE YOUR FILES ARE — and the run this sentence exists because of ═══
   *
   * Until now only BUILD tasks were told where anything lived (`workspaceSection`). Every other run
   * was handed `knowledge/` and `skills/` by name with no root, and a model that does not know where
   * it is searches from the root of the filesystem.
   *
   * Production, task 55461956, 04:00:18 — three globs issued in parallel:
   *
   *     glob { path: "/", pattern: "skills/**\/*"    } → returned in 3.7s
   *     glob { path: "/", pattern: "inputs/**\/*"    } → returned in 4.0s
   *     glob { path: "/", pattern: "knowledge/**\/*" } → NEVER RETURNED
   *
   * The turn hung on the third for fifteen minutes until the stall watchdog killed the run. Globbing
   * from `/` walks `/proc`, `/sys` and every mount in the image to prove that `/knowledge` does not
   * exist — and `/knowledge` never exists, because the files are under HOME. Roughly a third of all
   * non-infrastructure failures in production are this one shape.
   *
   * So every run is told its root, in the second paragraph, before it is told about anything it might
   * want to look for. The cheapest fix available for the largest single failure mode we have.
   */
  parts.push(
    `Everything of yours is under \`${SANDBOX_HOME}\`, which is also your home directory and where you ` +
      `start. \`knowledge/\`, \`skills/\`, \`inputs/\` and \`output/\` are relative to it.`,
  );
  parts.push(
    `NEVER search from \`/\`. A glob or grep rooted at the filesystem root walks the whole image — ` +
      `\`/proc\`, \`/sys\`, every mount — and on this image it does not come back. Search from \`.\` ` +
      `or from \`${SANDBOX_HOME}\`, or name the directory you actually want.`,
  );
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
  /**
   * ═══ THE OPERATE SHAPE IS TOLD WHAT THE BROWSER IS ═══
   *
   * Mounting tools is not the same as making them usable. An agent that has the browser-use tools
   * and has not been told their SHAPE will try to pass CSS selectors to `browser_click`, get
   * errors, and fall back to guessing from screenshots — which is precisely the failure mode
   * browser-use was mounted to remove. The one idea it has to arrive knowing is that
   * `browser_get_state` returns an INDEXED list and everything else refers to those indexes.
   *
   * Written here rather than in a skill file because it describes the RUNTIME, not the trade. A
   * wedge's skills say how to do bookkeeping; this says what the hands are. Same rule as
   * `remoteBuildToolDoc` two branches down, including its rule: documented only for the shape that
   * actually has it, because a tool an agent is told about and cannot call costs it turns and costs
   * us the credibility of everything else in the file.
   */
  if (profile.shape === "operate") {
    parts.push("");
    parts.push(BROWSERUSE_BRIEF);
    parts.push("");
  }
  /**
   * WHAT WAS INSTALLED FOR THIS JOB.
   *
   * Same argument as the browser brief above it and the output contract below: a capability the
   * agent does not know it has is a capability it does not use. A wedge that declares a charting
   * library and never mentions it gets runs that describe a chart in prose — and the install is
   * pure cost.
   *
   * Rendered from the SAME parse the installer used, so the prompt can never claim something the
   * kernel refused: a name that failed validation is absent from both.
   */
  {
    const declared = readPackages(
      (wedge?.manifest.task_types?.[task.task_type] as { packages?: unknown } | undefined)?.packages ??
        (wedge?.manifest as { packages?: unknown } | undefined)?.packages,
    ).packages;
    const said = describePackages(declared);
    if (said.length) {
      parts.push("");
      parts.push(...said);
      parts.push("");
    }
  }
  /**
   * The image tool, documented on exactly the shapes it was INSTALLED on.
   *
   * Placed here rather than inside the build block because `deliver` gets the tool too — a deck or
   * a landing page is where a picture earns its place, and those are deliver runs. The rule the
   * build tools follow applies unchanged: documented only where the script really is, because a
   * tool an agent is told about and cannot run costs it turns and costs this whole file its
   * credibility.
   */
  /**
   * What the work is judged on, given to the generator.
   *
   * Anthropic's harness post found the criteria pay before any evaluator exists: "Even on the first
   * iteration, outputs were noticeably better than a baseline with no prompting at all, suggesting
   * the criteria and associated language themselves steered the model." This is the cheap half of
   * a generator/evaluator loop and it carries no orchestration cost.
   *
   * Deliver shapes only. A build has `mycel-build` and a compiler telling it whether it worked; a
   * decide run produces no artefact for a client to be disappointed by.
   */
  if (profile.shape === "deliver") parts.push(...criteriaAsPromptLines());

  {
    // Documented ONLY when a provider key is really present, which is the same rule the build
    // tools follow. With no key the tool is absent and unmentioned, and the run composes without
    // photography — which the craft shelf teaches and which is better than a placeholder.
    const img = profile.shape === "deliver" || profile.shape === "build" ? imageProviderFromEnv() : undefined;
    /**
     * ART-DIRECTED WITH THE VALUES THIS RUN IS ALREADY HOLDING.
     *
     * `brandFiles` above resolves the same design system and the same kit to write `brand/tokens.css`
     * into the workspace. Passing them here too costs nothing and closes the gap between "the palette
     * is on disk somewhere" and "the image prompt names the accent".
     */
    if (img) {
      /**
       * ART-DIRECTED WITH THE VALUES THE BRAND FILES ARE ALREADY WRITTEN FROM.
       *
       * Read here rather than threaded in: `buildAgentsMd` already takes eleven positional
       * arguments, and `brandKit` is the same synchronous identity-store lookup the caller makes to
       * produce `brand/tokens.css`. One more parameter to carry two strings across that signature
       * would cost more than the lookup does.
       */
      const brand = task.project_id ? getIdentityStore().brandKit(task.project_id) : undefined;
      parts.push(
        ...imageToolDoc(img, {
          system: designSystemFor(brand?.identity),
          accent: typeof brand?.accent === "string" ? brand.accent : undefined,
          neutral: typeof brand?.neutral === "string" ? brand.neutral : undefined,
        }),
      );
    }
  }

  if (profile.shape === "build") {
    parts.push(
      `This is a BUILD task: you are constructing or altering software in this workspace. Read the ` +
        `code before you change it, make the change, and verify it actually runs. Write deliverables ` +
        `to ./output/.`,
    );
    if (workspace) parts.push(...workspaceSection(workspace.ws, workspace.seeded, workspace.buildTool));
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
  } else if (profile.shape === "deliver") {
    /**
     * ═══════════════════════════════════════════════════════════════════════════════════════════
     * THE INSTRUCTION USED TO SAY "BE CONCISE" TO THE SHAPE WHOSE OUTPUT IS THE PRODUCT
     * ═══════════════════════════════════════════════════════════════════════════════════════════
     *
     * Every run took the same line: "Use your tools to do the real work … Be concise. Write
     * deliverables to ./output/." Correct for an operate tick. Wrong here, and wrong in the two
     * ways that decide whether a client thinks the month was worth paying for.
     *
     * BREVITY. `deliver` is the shape whose own comment says "these are the runs whose output IS the
     * product". Telling it to be concise is telling it to write less of the thing being sold, and
     * `exemplar.ts` had already diagnosed the result — "competent, correctly structured, and SHORT".
     * The exemplar exists to convey depth, and one word in the prompt was arguing with it.
     *
     * FORMAT. It named no format at all. `craft:presenting-work` is mounted on every one of these
     * runs and opens with "self-contained HTML is the default for anything a person reads" and
     * "markdown is a working note. It is not a deliverable" — and in production, runs have authored
     * 4,923 `.txt`, 2,045 `.md`, 23 `.csv` and ZERO `.html`. A craft document nothing in the prompt
     * points at is a craft document the model skims.
     *
     * So this branch says what the craft says, at the moment the model is deciding what to write.
     * It does not restate the craft — that would be two sources of truth for a rule that changes —
     * it names the file it is in and the two decisions that get made before anybody opens it.
     */
    parts.push(
      `Use your tools to do the real work. Ground yourself in ./knowledge/ (domain playbooks, ` +
        `policies, examples) and ./inputs/ (documents for this specific task) before acting.`,
    );
    parts.push(
      `WHAT YOU WRITE TO ./output/ IS THE PRODUCT. A client opens it and this business is paid for ` +
        `it. Read \`craft:presenting-work\` before you write anything and follow it: a self-contained ` +
        `.html file for anything a person reads, inline SVG for any chart, and the data file itself ` +
        `alongside it when there is data. Markdown is a working note, not a deliverable. ` +
        `Depth is the job — an exemplar is mounted and it is the standard to match, not a ceiling.`,
    );
    /**
     * ═══ AND THE TEMPLATE, WHEN THIS JOB HAS ONE ═══
     *
     * Conditional because most task types declare no shape, and a pointer to a file that is not
     * mounted teaches the model that the index lies — the same failure as the craft doc nothing
     * pointed at, inverted.
     *
     * Stated as the section order the run does not get to redesign. That is the whole reason the
     * template exists: the trade has produced this document the same way for decades, and a run
     * that reinvents its section order spends budget on a decision that was already made and
     * hands the client two months that do not look like each other.
     */
    if (mountedSkills?.some((sk) => sk.name === SHAPE_SKILL_FILE)) {
      parts.push(
        `\`${SHAPE_SKILL_FILE}\` is the SHAPE this artefact takes: the sections, in that order, ` +
          `and how deep each one goes. It is a template, not a sample — it holds no findings to ` +
          `reuse. Follow the order. It is this trade's format, not a suggestion, and redesigning ` +
          `it spends the run on a decision the trade already made.`,
      );
    }
    /**
     * ═══ AND THE INSTRUMENT THE REVIEWER WILL USE ═══
     *
     * Immediately after the two things it checks — the slop rules and the shape — because that is
     * the order the run needs them in: here is the standard, here is the format, and here is how to
     * find out whether you met them BEFORE saying you are finished.
     */
    if (checkTool) {
      parts.push(...checkToolDoc(mountedSkills?.some((sk) => sk.name === SHAPE_SKILL_FILE) === true));
    }
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
  /**
   * ═══ RECALL SITS AFTER THE RULES, AND THAT ORDER IS THE SAFETY PROPERTY ═══
   *
   * Rules are what a human corrected on real work and they bind. Memory is what the agent wrote
   * down for itself and it binds nothing — `knowledge.ts` refuses a `self_reported` rule source for
   * exactly this reason, and nothing here changes that. Putting recall above the rules would
   * quietly invert it: whatever is read last, closest to the task, is what a model weighs most.
   *
   * `memorySection` also says so in words, because the ordering is invisible to the reader. Where a
   * memory contradicts the task input or a taught rule, those win and the memory is the thing that
   * is wrong.
   */
  const recalled = memories?.length ? memorySection(memories) : "";

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
  if (recalled) {
    parts.push("");
    parts.push(recalled);
  }

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
    // AND HOW TO PUT WORK IN FRONT OF THE CLIENT. Taught next to the case because it is the same
    // engagement: a case is where the work IS, a deliverable is what it produced. Without this the
    // agent knows the loop from its skills and has nowhere to send it.
    /**
     * ═══ THE PROMPT DOCUMENTED A FLOW THE ROUTE REFUSES ═══
     *
     * This said: create with `{title, kind:"document"}`, then POST a version. The route validates
     * the version payload on that first call, so a `document` with no artifact is refused —
     * "a document deliverable is exactly one file, and this version has 0". Step one could never
     * succeed, and the two halves had disagreed since validation was hoisted above the create (which
     * was itself a real fix: it stopped seven orphaned `drafting` rows per close).
     *
     * What the agent did with that is the whole cost. Its FIRST call was exactly what this text told
     * it to send. When that failed it tried twenty-five more: `files`, `version`, `artifacts`,
     * `initial_version`, `file_name`/`file_path`, `kind:"file"`, an OPTIONS probe, an invented
     * `/help` endpoint, a recursive glob for anything named "deliverable" under `/root`. The one that finally passed was
     * `{"kind":"link"}` with a loopback URL — because `link` is the only kind whose payload check a
     * bare create can satisfy. The client received an empty link deliverable with no covering note
     * and no files, and scored it 1 out of 10: "they have sent me a title rather than a monthly
     * bookkeeping close."
     *
     * So: the real contract, which is ONE call that either fully succeeds or writes nothing.
     *
     * And the sentence that should have been here first. Most runs do not need this at all — the
     * kernel wraps the run's own files into a deliverable, with the covering note and the branded
     * document, the moment the run ends. An agent doing it by hand produces a worse version of what
     * it was already getting for free.
     */
    parts.push(
      `**You almost certainly do not need to do this.** Write your files to \`./output/\`, list them ` +
        `in \`artifacts\`, and the delivery is assembled for you when this run ends — covering note, ` +
        `branded document, your files attached. Submitting by hand is for work that is NOT files ` +
        `(a live URL), or a second version mid-run.`,
    );
    parts.push(
      `If you do need it, it is ONE call — title, kind and the payload together. A create with no ` +
        `payload is refused, so there is no two-step version of this:\n` +
        "```bash\n" +
        `# The ids of files you wrote are here:\n` +
        `curl -s "$MYCEL_ARTIFACTS_URL" -H "authorization: Bearer $MYCEL_ACTION_TOKEN"\n` +
        `\n` +
        `curl -s "$MYCEL_DELIVERABLES_URL" -H "authorization: Bearer $MYCEL_ACTION_TOKEN" \\\n` +
        `  -H "content-type: application/json" -d '{"title":"<their words>","kind":"file_set",\n` +
        `    "summary":"<the covering note>","artifact_ids":["<id>","<id>"]}'\n` +
        `\n` +
        `# "document" is exactly one artifact_id. "link" takes {"url":"https://..."} and no files.\n` +
        `# A SECOND version: send the same call plus "deliverable_id", never a new title — v2 of a\n` +
        `# report is a new VERSION, or the client loses the history and cannot see what changed.\n` +
        "```\n" +
        `The response carries \`deliverable_id\`. Keep it.\n\n` +
        `You submit; you cannot release. The founder releases it to the client and the client accepts ` +
        `it — that is the whole point of the gate, so do not ask the founder to "accept" anything.`,
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
   * much does Brightline owe us" is asking a human to read a database.
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
  /**
   * ═══ AND WRITE DOWN WHAT YOU LEARNED, WHILE YOU ARE STILL HOLDING IT ═══
   *
   * The instruction is placed HERE, beside "when you don't know something", because the two are the
   * same moment seen from either end: this run asked, and the next one should not have to.
   *
   * The previous attempt at this was three nightly jobs that reflected on finished work — 216 runs,
   * 261 sandbox-hours, four proposals, none adopted. It failed because reflection after the fact is
   * a separate job with none of the context, and because a proposal is something a human has to
   * accept. This costs one tool call inside a run that is already open, and there is nothing to
   * accept: memory binds nothing, so it needs no approval.
   */
  /**
   * ═════════════════════════════════════════════════════════════════════════════════════════════
   * THE MEASUREMENT THIS WEEK, AND THE ONE FROM LAST WEEK
   * ═════════════════════════════════════════════════════════════════════════════════════════════
   *
   * ═══ WHY THIS SECTION EXISTS: THE LOOP DID NOT CLOSE, AND THIS IS WHY ═══
   *
   * Measured, with two real runs on a real model against the same client a week apart.
   *
   * Week one reported 0% share of voice. Week two reported 50% — a doubling, and the single most
   * important fact a weekly report can carry. Week two's output said:
   *
   *     "No previous-period number or change note was supplied, so movement cannot be assessed."
   *
   * The number WAS there. Week one had stored it correctly:
   *
   *     { collection: "geo_share_of_voice", key: "halstead-robotics",
   *       data: { share_of_voice_pct: 0, queries: 2, mentions: 0, observed_at: "2026-09-08" } }
   *
   * ═══ THE CAUSE WAS AN UNDOCUMENTED CONTRACT ═══
   *
   * Every other endpoint in this sandbox appears TWICE in this file — once setting the variable,
   * once as a worked example in the prompt. `MYCEL_RECORDS_URL` appeared once. The run was handed a
   * URL with no shape, and had to guess.
   *
   * Both runs guessed, visibly, in their own bash history. Week one tried a bare POST, then
   * `/series`, then an `OPTIONS` probe, then `PUT`, before finding `/upsert` on the fifth attempt.
   * Week two tried a bare GET, then `{"type":"series"}`, then `/series`, gave up, and never wrote
   * its number at all — so the series has one point in it and always will.
   *
   * Neither run ever called `/query`. Nothing told them the previous period was retrievable, so the
   * honest sentence they wrote — "was not supplied" — was true of what they had been given and
   * false of what existed.
   *
   * ═══ WHY BOTH VERBS, AND WHY READ FIRST ═══
   *
   * A recurring deliverable that cannot compare itself to last time is a screenshot. The compare is
   * the product: "you were at 0%, you are at 50%" is what renews a retainer, and a fresh number with
   * no history is a fact the client already suspected.
   *
   * Read is listed before write because that is the order the work happens in — and because a run
   * that writes without reading produces the exact failure above, where the series accumulates and
   * nothing ever looks at it.
   *
   * ═══ THE KEY CARRIES THE PERIOD, AND THE FIRST VERSION OF THIS GOT IT WRONG ═══
   *
   * `queryRecords` is `SELECT DISTINCT ON (key) … ORDER BY observed_at DESC` — one row per key,
   * newest first. So a key of just the client name is ONE row forever: each week replaces the last
   * and there is no series, only a latest value. The first draft of this section said exactly that
   * and a live run obeyed it, overwriting week one with week two.
   *
   * `<subject>:<period>` is the shape that gives both properties at once: re-running a week replaces
   * that week rather than duplicating it, and the weeks accumulate. `observed_at` must be set on
   * every row because it is what the ordering reads — without it the lookup falls back to
   * `created_at`, which is when the run happened rather than what it measured.
   */
  if (profile.grants_actions) {
    parts.push("");
    parts.push("## Compare this period with the last one");
    parts.push(
      "Recurring work is judged on MOVEMENT, not on this week's number alone. Before you write " +
        "anything, look up what you recorded last time — and when you are done, record this time's " +
        "figures so the next run can do the same.",
    );
    parts.push("");
    parts.push("```bash");
    parts.push("# What did we record before? Newest first. `where` matches fields inside `data`.");
    parts.push(`curl -sS -X POST "$MYCEL_RECORDS_URL/query" -H "authorization: Bearer $MYCEL_ACTION_TOKEN" \\`);
    parts.push(`  -H 'content-type: application/json' \\`);
    parts.push(`  -d '{"collection":"<your collection>","limit":5}'`);
    parts.push("");
    parts.push("# This period's figures. The key must include the PERIOD, not just the subject:");
    parts.push("# the same key replaces its row, so `<subject>:<period>` makes a re-run idempotent");
    parts.push("# for that period while still accumulating a series across periods. `observed_at`");
    parts.push("# is what the lookup sorts on, so always set it.");
    parts.push(`curl -sS -X POST "$MYCEL_RECORDS_URL/upsert" -H "authorization: Bearer $MYCEL_ACTION_TOKEN" \\`);
    parts.push(`  -H 'content-type: application/json' \\`);
    parts.push(
      `  -d '{"records":[{"collection":"<your collection>","key":"<client-slug>:2026-09-15","data":{"observed_at":"2026-09-15","<metric>":50}}]}'`,
    );
    parts.push("```");
    parts.push("");
    parts.push(
      "If the lookup comes back empty this is the first period — say so plainly rather than " +
        "implying a comparison you cannot make. If it comes back with a number, lead with the " +
        "change.",
    );
    parts.push("");
    parts.push("## Write down what you learned");
    parts.push(
      "When you find out something durable about this client or this engagement — who signs off, " +
        "which format they want, a fact you had to go and ask for — write it down so the next run " +
        "starts where you finished:",
    );
    parts.push("");
    parts.push("```bash");
    parts.push(`curl -sS -X POST "$MYCEL_MEMORY_URL" -H "authorization: Bearer $MYCEL_ACTION_TOKEN" \\`);
    parts.push(`  -H 'content-type: application/json' \\`);
    parts.push(`  -d '{"path":"clients/acme.md","body":"# Acme\\n\\nFinance contact is Dana. Wants the P&L split by region."}'`);
    parts.push("```");
    parts.push("");
    parts.push(
      "Drawers are `clients/`, `engagements/`, `timeline/` and `knowledge/`. Writing the same path " +
        "again REPLACES it, so correcting a note is the same call. Keep each one to a paragraph or " +
        "two — anything longer is a transcript, and the next run pays for it in tokens forever.",
    );
    parts.push("");
    parts.push(
      "**Do not write what is already in the task input, and do not write your conclusions about " +
        "how the work should be done.** The first is noise and the second is a rule — rules come " +
        "from a human correcting real work, never from you deciding you were right.",
    );
  }

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
  /**
   * ═══ YOU ALREADY DID THIS, AND HERE IS WHAT CAME BACK ═══
   *
   * BEFORE the fan-out instructions, deliberately. A resumed parent has no memory of its first run —
   * parking is implemented by throwing, the sandbox is destroyed, the agent process is gone — so it
   * arrives, reads how to fan out, and fans out again. `priorBatchResults` was written to stop
   * exactly that and mounts the children's outputs as `batch:results`, whose first paragraph reads
   * "DO NOT SPAWN THEM AGAIN".
   *
   * The agent never opened it. Observed end to end on task b8ef3b01 (6 September, geo weekly
   * report): three rounds, each one reading run-geo-week.md, turn-measurement-into-work.md,
   * craft:presenting-work, the shape, the tokens and the exemplar — and never `batch:results`,
   * which was mounted every time. Six probe children ran, all six succeeded, and the third fan-out
   * tripped the loop cap and failed the task. Three sandbox boots for a report that was never
   * written.
   *
   * A mounted file the prompt does not name is a file the model skims. That is the third time this
   * week — the craft doc that gave production 4,923 .txt and zero .html, the template mounted for
   * authored services only, and now this. The difference between a fix and a comment about a fix is
   * a line in the prompt.
   */
  const priorResults = mountedSkills?.find((sk) => sk.name === "batch:results");
  if (priorResults) {
    parts.push("");
    parts.push(`## You have already fanned out on this task`);
    parts.push(
      `An earlier round of THIS task spawned child jobs and they have all finished. Their output ` +
        `is mounted at \`skills/batch:results\` — **read it now, before you plan anything.**\n\n` +
        `Do NOT open another batch for the same measurement. It costs the same money, takes the ` +
        `same time, returns the same answer, and a third round is killed as a loop. Carry on from ` +
        `where the plan left off and write the deliverable with what is already there.`,
    );
  }
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
  /**
   * HOW TO WRITE, before the procedures that say what to do.
   *
   * The forbidden vocabularies have only ever been a GATE — the run finishes, the words are found,
   * the work is held, and the founder waits while it is written again. That pays the full cost of a
   * bad draft before rejecting it, and teaches the model nothing, because the model never saw the
   * rule. A separate "check your writing" pass would be worse: another turn, another minute, and
   * another chance to rewrite something that was fine.
   *
   * So it is an instruction, rendered from the gate's own constants so the two cannot drift. See
   * `antiSlopRules` in ship-checks.ts for why the positive rules are the larger half.
   *
   * Every run, not only the deliverable ones: a chase email and a client check-in are read by the
   * same person as the report, and slop in a two-line message is more obvious, not less.
   */
  /**
   * ═══ THE DELIVERABLE IS THE WORK, NOT AN ACCOUNT OF IT ═══
   *
   * Only for the `deliver` shape, because it is the only one whose output a client receives.
   *
   * Every deliverable task in this system used to emit a summary and nothing else. A client sent
   * one scored it 3/10 and would not pay again, and one of their complaints was exactly this: they
   * had been sent an account of work rather than the work. A service business does not sell reports
   * about bookkeeping, it sells reconciled books; it does not sell a note about a questionnaire, it
   * sells the questionnaire answered.
   *
   * The schema now has an `artifacts` array and `ship_requires` includes it, so a run that names no
   * artifact is held. This is the instruction that goes with the contract — naming a file in the
   * output while never writing one would satisfy the gate and deliver nothing, which is the failure
   * mode a schema alone cannot close.
   */
  if (profile.shape === "deliver") {
    parts.push("");
    parts.push("## What you are actually delivering");
    parts.push("");
    parts.push(
      "Write the work to `./output/` as real files before you answer, then list them in " +
        "`artifacts`. A path in `artifacts` that no file exists at is worse than an empty array — " +
        "it tells the founder something shipped when nothing did.",
    );
    parts.push("");
    parts.push(
      "The summary is the covering note that goes with the work. If you find yourself writing a " +
        "summary and nothing else, you have described the job rather than done it.",
    );
    parts.push("");
    /**
     * ═══════════════════════════════════════════════════════════════════════════════════════════
     * DO NOT DESIGN THE DOCUMENT. THE HARNESS ALREADY DOES.
     * ═══════════════════════════════════════════════════════════════════════════════════════════
     *
     * Measured on a real run: the agent wrote an 8,391-character HTML report of which 3,079
     * characters — 37% — were hand-rolled CSS. A `:root` block of custom properties, `clamp()`
     * typography, a box-sizing reset, forty-one lines of a design system invented from nothing.
     * Against 592 words of actual analysis.
     *
     * And the harness had ALREADY rendered the same content properly. `deliverables.wrap.ts` does
     * `if (kind === "document" && content && renderDocument)` — the run's markdown goes through
     * `blocksFromMarkdown` → `insertChart` → `render("report", …, brandKit)`, which applies the
     * founder's own brand, inserts the wedge's declared chart, and is checked by `tasteBlockers`.
     *
     * So every deliverable shipped TWO documents: a branded, taste-checked PDF, and a bespoke HTML
     * file with a different look. Same content, two designs, and a third of the run's output budget
     * spent competing with a renderer that was always going to run.
     *
     * ── WHY THIS IS THE FIX FOR THE WORK BEING THIN, NOT JUST FOR THE DUPLICATE ──
     *
     * The reviewer on that run failed it on "It is the thing they asked for" and "Every number and
     * claim is traceable". Both are analysis faults, and the attention that would have fixed them
     * went into a stylesheet. Taking the document away gives the whole budget back to the work.
     *
     * ── AND IT IS WHY THE PRODUCT LOOKS LIKE ONE PRODUCT ──
     *
     * A founder forwarding two deliverables from the same business should not be forwarding two
     * designs. One renderer means one look, everywhere, without anybody maintaining it.
     */
    parts.push(
      "**Write the analysis, not the document.** Put the work in `./output/` as markdown or data — " +
        "a `.md` with your findings, a `.csv` of the rows, a `.json` of the figures. The house " +
        "renderer turns that into the finished document with this business's own brand on it.",
    );
    parts.push("");
    parts.push(
      "Do not write HTML and do not write CSS. A stylesheet you invent is thrown away or, worse, " +
        "attached beside the rendered one so the client gets the same report twice in two designs. " +
        "Every minute spent on a `:root` block is a minute not spent on the numbers, and the numbers " +
        "are the only part a client can tell apart from anybody else's.",
    );
    parts.push("");
    /**
     * ═══ WHO READS THE COVERING NOTE ═══
     *
     * `client-ready.ts` refuses to release a summary containing any of these words, and until now
     * the run had never been shown the list. A deliverable was asked for a note, told nothing about
     * the rule, and then held for breaking it — a test nothing could pass except by luck, charged
     * at full price every time. The first real `weekly_report` this product ever completed was held
     * on exactly this, for the word "probes".
     *
     * A guard the worker cannot see is not a standard, it is a trap. The list is imported rather
     * than restated so the gate and the instruction cannot drift into disagreeing about it.
     */
    parts.push(
      "The summary is read by your client. They do not know this system exists, they did not " +
        "commission a run, and they are not interested in how the work was produced. Write it the " +
        "way the person whose name is on it would write it.",
    );
    parts.push("");
    parts.push(
      `These words are ours, not theirs. A note containing one is held back instead of sent: ` +
        `${INTERNAL_VOCABULARY.join(", ")}.`,
    );
    parts.push("");
    /**
     * ═══ AND WHAT TO SAY INSTEAD ═══
     *
     * The blocklist alone was not enough, and the way it failed is worth recording. A real run
     * needed to tell a client that a measurement had not completed and should be taken again. The
     * honest English for that is "rerun the checks" — a banned word — and with no permitted phrasing
     * offered, the model chose the accurate sentence over the rule. It was right to.
     *
     * A prohibition with no alternative is a trap for anyone with something true to say. These are
     * the substitutions for the terms that name a thing a client legitimately needs told about; the
     * rest of the list is machinery they should never hear of at all.
     */
    parts.push(
      "Where you need the idea and not the word: a probe or a rerun is \"a check\" and \"checking " +
        "again\"; an artifact is \"the file\" or name it (\"the spreadsheet\", \"the report\"); a run " +
        "is \"the work\". Never describe the machinery that produced something — the client cares " +
        "what it says, not how it was made.",
    );
  }

  /**
   * ═══ WHAT YOU COULD NOT DO IS NOT THE SAME AS WHAT YOU WANT TO ASK ═══
   *
   * Mounted whenever the output schema offers both words, because the model reliably writes the
   * same item under each and one of them used to bin the whole delivery.
   *
   * The August close that surfaced this reconciled sixteen transactions to the penny, wrote a
   * ledger, a VAT worksheet and a P&L, and put four items in `needs` — including the two payments
   * it could not classify, which it ALSO put in `questions`, worded almost identically. Read
   * literally it was not wrong: it could not finish the VAT return. But the close was finished, and
   * the client received four questions and no books.
   *
   * `decideFate` no longer lets that lose the work — a `needs` beside output that clears the ship
   * bar now travels with the delivery instead of replacing it. This is the other half: the run
   * should not have to be rescued from its own wording. Told the distinction plainly, it writes the
   * ask in the right place, and the client gets a cleaner document rather than the same item twice.
   */
  const outProps = (outputSchemaFor(task, wedge) as { properties?: Record<string, unknown> } | null)?.properties;
  if (outProps && "needs" in outProps && "questions" in outProps) {
    parts.push("");
    parts.push("## `needs` or `questions` — they are not the same");
    parts.push("");
    parts.push(
      "`needs` is for when you could not do THIS JOB at all without something only the client has. " +
        "Not the fuller version of the job, not the next step after it — this one. If you finished " +
        "what you were asked to do, `needs` is empty even if something further is now waiting on them.",
    );
    parts.push("");
    parts.push(
      "`questions` is for open items on work you DID finish: the judgement calls you would not make " +
        "alone, each with your best guess so they can answer in a word. A month that reconciles with " +
        "two payments you cannot place is a finished close with two questions, not a blocked one.",
    );
    parts.push("");
    parts.push("Never write the same item under both. Pick the one that is true and put it there once.");
  }

  parts.push("");
  parts.push(...antiSlopRules());

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
    /**
     * ═══ AND SAY THAT THIS IS NOT THE WHOLE SHELF ═══
     *
     * The list above is complete for what is MOUNTED and silent about what is not. For a deliver
     * run that is misleading: `stagedArsenalForBrief` writes the next twenty procedures into
     * `craft/` and an index at `craft/INDEX.md`, and until now nothing in this prompt said either
     * existed. Reaching them required the agent to guess that a directory it was never told about
     * was worth listing.
     *
     * Named, and quantified. openwork's catalog renders "PARTIAL — 12 of 40 shown" rather than just
     * showing twelve, for the reason this repo has now hit four times in a day: a menu that does not
     * state its own completeness is read as the whole world.
     */
    if (craftShelf?.staged) {
      parts.push("");
      parts.push(
        `Those are the closest matches, not the shelf. \`craft/INDEX.md\` lists ` +
          `${craftShelf.staged} more procedures already written into this sandbox, out of ` +
          `${craftShelf.shelf} in the library. Read the index if the job asks for something the ` +
          `procedures above do not cover — the files are already here and cost nothing to open.`,
      );
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
function workspaceSection(ws: ResolvedWorkspace, seeded?: SeedOutcome, buildTool?: boolean): string[] {
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
    /**
     * AND IF THE MARKING SCHEME IS A FILE, SAY SO — because otherwise this instruction got weaker
     * the day the checks moved out of the manifest.
     *
     * `verify` used to be seven thousand characters of shell rendered right here, so the agent read
     * every gate and every message before writing a line. Moving it into the seed so two wedges
     * could share it reduced that to a filename, which tells an agent nothing about what it is
     * marked on — and the gates are worth reading precisely because each one names a production
     * failure and how to avoid repeating it.
     *
     * The file is IN the workspace, so the fix is to say where. A script the agent reads is strictly
     * better than one pasted into a prompt: it cannot drift from the thing that actually runs.
     */
    const scriptRef = ws.verify.match(/(?:^|\s)((?:scripts|bin)\/[\w.-]+)/)?.[1];
    if (scriptRef) {
      parts.push(
        `That is a script in your own workspace — \`~/${ws.dir}/${scriptRef}\`. **Read it before you ` +
          `start.** Every check in it names a real failure and says how to avoid it, and it is the ` +
          `exact thing you are graded by, so reading it is the cheapest work available to you.`,
      );
    }
  }

  // ── AND THE OTHER EXAM, WHICH WAS NEVER MENTIONED ───────────────────────────────────────────
  //
  // `require_remote_build` means the kernel checks, at hand-off, that the app COMPILED on the build
  // plane — by reading the run's own event log, which the sandbox cannot write to. A run that never
  // called `mycel-build` is failed with "the run never proved the app builds ... 3 builds were
  // available and none were used".
  //
  // Nothing told the agent that. This function disclosed `verify` in the strongest terms in the
  // whole prompt and said nothing about the build, and the `buildTool` fact was threaded through
  // `buildAgentsMd`'s signature only to be dropped on the floor. So the agent finished, wrote a
  // confident final message, and the kernel failed it for skipping a tool it had never been asked
  // to use. Its own docstring already made the argument — "an agent that does not know the exam
  // exists cannot sit it" — about the other exam.
  //
  // Written in the same register as the verify paragraph on purpose. A soft "a build plane is
  // available" reads as an offer; this is a requirement, and the difference decides the run.
  if (ws.requireRemoteBuild && buildTool) {
    parts.push("");
    parts.push(
      `**The app must actually compile, and the kernel checks that separately.** Run ` +
        `\`mycel-build\` from inside \`~/${ws.dir}\`. It blocks for a few minutes, compiles with the ` +
        `exact toolchain that deploys, and prints SUCCEEDED or the tail of the real build log. ` +
        `A run that never calls it is FAILED at hand-off however good the code looks, because ` +
        `nothing proved it builds. On failure, fix what the log says and run it again — you get a ` +
        `small number of attempts, and the tool tells you how many remain.`,
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

/** Test seam: the index line is load-bearing and is asserted directly. */
export const fileSummaryForTest = fileSummary;

/**
 * The house style already fixed on the deliverable this task is revising, if it is revising one.
 *
 * Keyed on `input.deliverable_id` — the field the regenerate path already passes — rather than on
 * anything inferred from the case or the wedge. An inference here would guess wrong exactly when a
 * client has more than one deliverable open on one engagement, which is the normal state of a
 * retainer.
 */
async function pinnedStyleFor(task: { project_id?: string; input?: unknown }): Promise<PinnedStyle | undefined> {
  const id = (task.input as { deliverable_id?: unknown } | undefined)?.deliverable_id;
  if (typeof id !== "string" || !id || !task.project_id) return undefined;
  const d = await getDeliverableStore().getDeliverable(task.project_id, id);
  return d?.style;
}
