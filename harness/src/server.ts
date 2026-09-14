// The Task API + SSE gateway (docs/CONTRACT.md §4). Founder products and the dashboard call
// this; browsers subscribe to the event stream through the product's server-side proxy.
//
// Auth: the public /v1 surface requires the founder API key (see auth.ts). The /v1/internal/*
// surface is sandbox-facing and authed separately (gate token / proxy nonce) — the sandbox does
// NOT hold the founder key, so the API-key middleware must not cover it.
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { libraryGaps } from "./library";
import { join } from "node:path";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { captureKernelException } from "./sentry";
import { streamSSE } from "hono/streaming";
import { audit, auditList, auditVerify } from "./audit";
import { assertBlueprintsValid, buildChecklist, isProvisioned, listBlueprints, loadBlueprint, provision } from "./blueprints";
import {
  ALL_CAPABILITIES,
  CAPABILITIES,
  assertCapabilityTableValid,
  capabilityProviders,
  isCapability,
  isDeclarableCapability,
  projectWedgeSlugs,
  resolveCapability,
} from "./capabilities";
import { hasShape } from "./capabilities.normalise";
import {
  capabilityImplementation,
  hasActionShape,
  planBookCalendar,
  planSendEmail,
  type BookingRequest,
  type CapabilityPlan,
  type EmailSend,
} from "./capabilities.act";
import { bearer, requireApiKey, safeEqual } from "./auth";
import { TERMINAL_STATUSES, awaitApproval, failWaitersForTask, recordAutoApproval, resolveApproval } from "./approvals";
import { actionPreview, executeAction, executeRead } from "./actions";
import { boundData, boundResult } from "./toolresult";
import { capabilitiesForConnection, guardSend, isMessagingSend, outboundFromPayload } from "./outreach/guard";
import { getClientContext, updateClientContext } from "./client-context";
import { isShowroomOrg, SHOWROOM_REFUSAL } from "./showroom";
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
import { loadAudience } from "./gtm/autonomous";
import { mountInsight } from "./insight/routes";
import { mountMeetings } from "./meetings.routes";
import { mountPaidAds } from "./paid-ads.routes";
import { clientKey, rateLimited as limited } from "./rate-limit";
import { buildSummary } from "./insight/summary";
import { mountClientRoutes } from "./clients.routes";
import { mountSigningRoutes } from "./signing.routes";
import { openEngagementFromSignature } from "./engagement-open";
import { mountMilestoneRoutes } from "./milestones.routes";
import { bookFindings, clientEconomics } from "./client-economics";
import { dealLessons } from "./deal-lessons";
import { explain as explainLoop, loopCoverage } from "./loop-coverage";
import {
  browserTarget,
  parseSession,
  sessionCovers,
  wrongSessionFor,
  BROWSER_CONNECTION_KIND,
} from "./browser-work";
import { surfaceWarnings, SURFACE_HEALTH_COLLECTION } from "./surface-health";
import { listEnvelopes } from "./signing";
import type { Client } from "./contract";
import { mountSkillRoutes } from "./skills.routes";
import { mountBlueprintRoutes } from "./blueprints.routes";
import { mountProjectReadRoutes } from "./project-reads.routes";
import { buildCalendar, calendarSummary, matchBookingCase } from "./calendar";
import { mountAuthRoutes } from "./auth.routes";
import { mountTeamRoutes } from "./team.routes";
import { mountRequestRoutes } from "./requests.routes";
import { mountPortalApprovals } from "./portal-approvals";
import { mountPortalThreads } from "./portal-threads";
import { announceRelease } from "./release-announce";
import { mountDeliverableRoutes } from "./deliverables.routes";
import { mountProductOpsRoutes } from "./ops.routes";
import { getDeliverableStore, setDeliverableDeps } from "./deliverables";
import { mountInvoiceRoutes } from "./invoices.routes";
import { reconcileProject } from "./payments";
import { importCrmClients, syncCalendar } from "./capability-import";
import { CHASE_TASK_TYPE, dunningWedge } from "./dunning";
import { getActionGrant } from "./actiongrants";
import {
  ask as brainAsk,
  deriveAuthority,
  founderAuthority,
  digestFor as brainDigestFor,
  get as brainGet,
  type BrainRequest,
  type BrainSource,
} from "./brain";
import { ask as groundedAsk, MAX_QUESTION } from "./ask";
import { chat as chatTurn, MAX_MESSAGE } from "./chat";
import { extractText as extractAttachmentText, MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES } from "./attachments";
import {
  autonomyView,
  ensureAutonomySchedule,
  loadAutonomyPolicy,
  saveAutonomyPolicy,
  EMPTY_POLICY,
  type AutonomyPolicy,
  type AutonomyRule,
} from "./autonomy";
import {
  deriveMoveAuthority,
  moveAuthorityForProject,
  proposeMoves,
  recordOutcome,
  takeMove,
  outcomeStats,
  MOVE_KINDS,
  MOVE_RESULTS,
  noteRequestAnswered,
  systemMoveAuthority,
  type MoveKind,
  type MoveRequest,
  type MoveResult,
  type MoveStores,
} from "./moves";
import { armDeclaredWait, armWait, ensureWaitSchedule, rearmWait, setWaitDeps, MAX_REARMS } from "./waits";
import { setIgniteDeps } from "./fulfillment-ignite";
import { setShipDeps } from "./ship-follow-on";
import { setArsenalDeps } from "./skill-arsenal";
import { getRun } from "./runregistry";
import { readPreviewTarget } from "./preview-target";
import {
  DEFAULT_DESIGN_SYSTEM,
  designSystem,
  designSystemSummaries,
  designSystemsByArchetype,
  shadcnFromDesignSystem,
} from "./design-systems";
import { skillScales, trialArms, type SkillScale } from "./skill-scales";
import { isTier, modelForTier } from "./models";
import { candidates } from "./skill-candidates";
import { armOf, judgeTrial, type TrialArm } from "./skill-trial";
import { addLibrarySkill, listLibrarySkills, removeLibrarySkill, parseSkillDoc, librarySkillsForWedge } from "./skill-library";
import { isFetchableSkillUrl, licenseUrlsFor, readLicense, siblingLicenseUrls } from "./skill-sourcing";
import { getRequestStore } from "./requests";
import { mayAskClient } from "./client-ready";
import { getBuildGrant } from "./buildgrants";
import {
  MAX_BUILDS_PER_RUN,
  MAX_SOURCE_BYTES,
  pollBuild,
  remoteBuildConfig,
  startRemoteBuild,
} from "./remotebuild";
import { getArtifactBackend } from "./artifacts";
import { normalizeBrandKitConfig, publicBrandKit } from "./brandkit";
import { render } from "./render";
import { readDeliveryEvent, readDsn } from "./outreach/bounces";
import { readAutoReply } from "./outreach/auto-reply";
import { suppressAddress } from "./outreach/suppression";
import { penaliseInbox } from "./outreach/inbox-health";
import { sendingReport } from "./outreach/sending-report";
import type { SuppressReason } from "@mycel/deliverability";
import { renderWorkbook } from "./render/xlsx";
import { renderDocument } from "./render/docx";
import { getPublishedPage, isPageToken, PUBLISHED_PAGE_CSP } from "./pages";
import { REFERRAL_REWARD_MONTHS } from "./referrals";
import { releaseOrgProxies } from "./proxy-decommission";
import { subscribe, subscribeAll } from "./bus";
import { markCancelled, markAbort } from "./cancel";
import { getBatchStore } from "./batches";
import { databaseUrl, loadConfig } from "./config";
import type { Case,
  Approval,
  Artifact,
  Constraints,
  Connection,
  ConnectionKind,
  ConnectionOwner,
  Cadence,
  CreateTaskInput,
  Invoice,
  KnowledgeItem,
  Risk,
  Task,
  EventType,
  TaskEvent,
  TaskSource,
  TaskStatus,
  WaitStatus,
} from "./contract";
import { getDomainStore } from "./domain";
import { profileConstraintDefaults } from "./harness";
import { emitEvent } from "./events";
import { canApprove, canManageMembers, fulfillmentRefusal, getIdentityStore, PLAN_LIMITS, PLAN_STATUSES, signupInviteOnly } from "./identity";
import type { Plan, PlanStatus, Role } from "./identity";
import { inferResponsibilities, RESPONSIBILITY_LABEL } from "./team";
import { fireSchedule, firstRun, scheduleKey } from "./scheduler";
import { enqueueTask } from "./queue";
import { serviceNotEnabled, unknownService } from "./service-words";
import { getGrant } from "./proxygrants";
import { lintArtifact } from "./design-lint";
import { readDeliverableShape } from "./deliverable-shape";
import { projectForBrandKey } from "./scopedkeys";
import { getSecret, hasSecret, setSecret } from "./secrets";
import { getGrantStore, grantTtlMs, sizeOf, stripContent as stripArtifactContent } from "./store";
import { clientSendBacks, correctionPairs, learningCurve, learningVerdict, untouchedDrafts } from "./learning";
import { taskClientId, jobReadiness } from "./runtime";
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
  createAuthConfig as composioCreateAuthConfig,
  toolkitAuth as composioToolkitAuth,
  isMissingManagedAuth,
  isRedirectScheme,
  parseAuthScheme,
  requirementMessage,
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
import type {
  AuthField as ComposioAuthField,
  AuthScheme as ComposioAuthScheme,
  Toolkit as ComposioToolkit,
  ToolkitAuth as ComposioToolkitAuth,
} from "./composio";
// Read only for the capability bit on `GET /v1/meta` — this route starts nothing. A deployment is
// created by a run finishing (orchestrator.ts) and never by a founder.
import { deployConfig, discardDeploy, publishDeploy } from "./deploy";
import { PREVIEW_STATE_HEADER, previewPage, previewStatus, type PreviewPageState } from "./preview-page";
import { advanceCustomDomain, type DomainProvisioning } from "./domains.aws";
import { startRunFromTrigger } from "./triggers";
import {
  buildCoverage,
  buildInterview,
  gapId,
  isGapId,
  recordAnswer,
  routeGap,
  type DraftedQuestion,
} from "./intake";
import { detectRecurrence, recordApprovalOutcome, recordGapAnswer, scopeMeta } from "./knowledge";
import { compareQuality, qualityByTaskType, qualityTrend } from "./knowledge-metrics";
import { measureValue } from "./value-measure";
import { generateImage, imageProviderFromEnv } from "./imagetool";
import { getPolicyCounters } from "./store";
import { getKnowledgeStore } from "./knowledge.store";
import { getBillingStore, invoiceTotals } from "./billing";
import { getPaymentInstructions, noteClientReplyOnInvoice } from "./payments.manual";
import { getPaymentRails, howToPay, sellerMissingSentence } from "./payments.rails";
import { settleStripePayment, settlementFromStripeEvent } from "./payments.stripe";
import {
  AGENTMAIL_WEBHOOK_HEADERS,
  agentMailConfig,
  claimDomainForProject,
  connectionForInbox,
  createInbox,
  findAgentMailThread,
  findAgentMailThreadGlobal,
  getDomain as getAgentMailDomain,
  inboxIdFor,
  linkAgentMailThread,
  listProjectDomains,
  listUnattributedInbound,
  parseAgentMailInbound,
  projectOwnsDomain,
  recordUnattributedInbound,
  registerDomain as registerAgentMailDomain,
  verifyAgentMailWebhook,
  ensureInboxDelivery,
  inboxNameTaken,
} from "./agentmail";
import {
  exchangePortalLink,
  mintPortalLink,
  resolveClientSession,
  revokeClientSessions,
  type ClientScope,
} from "./portal";
import {
  exchangePartyLink,
  partyOwnedRequest,
  resolvePartySession,
  toPartyRequest,
} from "./party";
import { traceLlmCall } from "./tracing";
import { assessRisk } from "./risk";
import {
  describeGrant,
  grantStanding,
  HARD_MAX_USES_PER_DAY,
  isLive,
  listStanding,
  MAX_GRANT_DAYS,
  revokeStanding,
} from "./standing";
import { suggestStandingGrants } from "./standing-suggest";
import { isAuthoredSlug, loadWedge, wedgesDir, type LoadedWedge } from "./wedge";
import {
  barFor,
  cleanRun,
  explain,
  lapses,
  mayAutoRelease,
  releasePolicyFor,
  CLEAN_RUN_REQUIRED,
  PENALTY_PER_LAPSE,
  POLICY_COLLECTION,
  POLICY_KEY,
  RELEASE_WEDGE,
} from "./release-policy";
import { inputFaults } from "./input-contract";
import { MEMORY_DRAWERS, getMemoryStore, rememberFromRun } from "./memory";
import { readRecord } from "./release-policy.pg";
import {
  CHASE_POLICY_COLLECTION,
  DEFAULT_CHASE_POLICY,
  MAX_CHASES_CEILING,
  MAX_INTERVAL_DAYS,
  MIN_CHASE_INTERVAL_DAYS,
  chasePolicyFor,
  toChasePolicy,
} from "./chase-policy";
import { getPool } from "./pool";
import { loadProjectWedge, promotedSlugs } from "./authored";
import {
  listPlaybooks,
  playbookEnabled,
  playbookKnowledgeName,
  playbookNameFromTitle,
  playbookSaveMeta,
  playbookChallenger,
  playbookVersions,
  safePlaybookName,
  type PlaybookVersion,
} from "./playbooks";
import { mountAuthoredRoutes } from "./authored.routes";
import { assertWedgeRolesValid, wedgeForRole, wedgeRoleMap, whyNoWedge } from "./roles";
import {
  isPresubscriptionWork,
  PRESUB_MAX_COST_USD,
  PRESUB_MAX_RUNS,
  PRESUB_MAX_SPEND_USD,
  PRESUB_SINCE,
  PRESUB_SPENT_MESSAGE,
} from "./presubscription";
import { ensureUpkeep } from "./upkeep";
import { runWorkflow } from "./workflows";
import goingQuiet from "../../library/workflows/going-quiet.mjs";
import { runPack, resolvePack, parsePackRef } from "./packs";
import { isOurOwnAddress, INTERNAL_CLIENT_METADATA } from "./internal-sender";
import { deadAskWarning, declaredWaitFor } from "./wait-declaration";
import { capture, KERNEL_EVENT } from "./analytics";
import { ENDING_SAID, type RunTraces, endedQuietly, runEnding } from "./run-ending";
import { fetchWithDeadline } from "./http";
import { measureSite } from "./house-style.fetch";
import { describeMeasured } from "./house-style.measure";
import { clientReachable, redirectedNote } from "./ask-reachable";


/**
 * How far back "still happening" reaches, for the approvals block in `/v1/analytics`.
 *
 * Fourteen days, from the live distribution: 7 approvals in the last week, 16 in the last fortnight.
 * A seven-day window on this volume is two or three decisions — too few to claim anything from, and
 * a claim built on three rows is noise wearing evidence's clothes. Thirty days is what this exists
 * to correct. A fortnight is the shortest window that still carries enough rows to mean something.
 */
const APPROVAL_RECENT_DAYS = 14;

const TERMINAL: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  "succeeded",
  "failed",
  "rejected",
  "expired",
  "cancelled",
]);


/**
 * The only hosts a shared-library skill may be imported FROM. An allowlist rather than a blocklist:
 * the kernel making an outbound request to a URL a caller chose is a request-forgery primitive, and
 * "raw markdown from a known code host" is a small enough door to name explicitly. https-only is
 * enforced at the call site.
 */


// Fixed-window rate limiter — a blunt guard against task-creation cost-DoS. Keyed per caller.
const RATE_MAX = Number(process.env.MYCEL_RATE_MAX ?? 120);
// MYCEL_AUTH_RATE_MAX moved to auth.routes.ts with the six routes that were its only readers.
function rateLimited(key: string): boolean {
  return limited(key, RATE_MAX);
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

// Idempotency: the same Idempotency-Key returns the same task instead of spawning a duplicate (and
// duplicate real-world side effects). Backed by the grant store — see the claim in POST /v1/tasks
// for why a process-local Map was already wrong on a fleet that runs several replicas.
/**
 * How long an Idempotency-Key is honoured.
 *
 * Twenty-four hours: long enough to cover any retry a human or a client library will make of a
 * request they are unsure about, short enough that a key is not a permanent reservation on a word.
 * The window is a property of the CALLER's uncertainty, not of the run, which is why it is not
 * derived from the runtime ceiling the way `grantTtlMs` is.
 */
const IDEM_TTL_MS = 24 * 60 * 60 * 1000;

export function createServer(store: Store): Hono {
  /**
   * BOOT GATES. Both throw, and both are here rather than swallowed for the same reason.
   *
   * A capability provider table pointing at a normaliser that does not exist, or a blueprint shipping
   * `books@yourdomain.com`, is a configuration error that runs perfectly well for weeks and then does
   * something to a real client. A kernel that refuses to start gets looked at in the first minute.
   */
  // Both halves. Passing only the read predicate would boot a deployment whose `send_email` adapter
  // key points at nothing, which is the write-side spelling of the exact failure this gate exists for.
  assertCapabilityTableValid(hasShape, hasActionShape);
  /**
   * The third boot gate, which had been written and never called.
   *
   * `roles.ts` says of it, in its own doc: "Boot gate. Called once from `createServer` so a bad
   * manifest stops the kernel starting." It was not. `capabilities.ts` calls itself "the counterpart
   * of `assertWedgeRolesValid`" and `blueprints.ts` cites it as the precedent for not swallowing —
   * two gates modelled on a third that never ran.
   *
   * The failure it exists for is the one its doc names: two wedges both claiming `dunning`, which
   * the index resolves silently to whichever loaded first, and a client gets chased in another
   * trade's voice for weeks. Without this the index is built lazily on first use, so a malformed
   * manifest surfaces somewhere downstream at request time instead of here.
   */
  assertWedgeRolesValid();
  assertBlueprintsValid();
  const app = new Hono();
  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      if (err.status >= 500) captureKernelException(err);
      return err.getResponse();
    }
    captureKernelException(err);
    console.error("[mycel] unhandled route error:", err);
    return c.json({ error: err instanceof Error ? err.message : "internal error" }, 500);
  });
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

  /**
   * Fill in content from the artifact backend when it isn't stored inline.
   *
   * ═══ WHY THIS THROWS INSTEAD OF SERVING "" ═══
   *
   * Observed in production. The WORKER runs with `MYCEL_ARTIFACTS=s3`, so it stores the row with an
   * empty `content` column and puts the bytes in the bucket. The KERNEL, which is the process that
   * SERVES artifacts, had no `MYCEL_ARTIFACTS` at all — so it was `inline`, whose `get` always
   * answers null, and this line turned that into `content: ""`. A founder's shaping run therefore
   * succeeded, wrote a perfectly good business shape to S3, and onboarding told him "The draft came
   * back empty, so there's nothing worth showing you." The draft was not empty; the reader was
   * looking in the wrong place, and the `?? ""` made a configuration split-brain look like a model
   * that produced nothing.
   *
   * `size_bytes` is what makes the two cases distinguishable: a genuinely empty artifact records 0,
   * and an artifact whose bytes live elsewhere records how many there are. Bytes we are told exist
   * and cannot produce is a fault, and it is now said out loud.
   */
  const withContent = async (a: Artifact): Promise<Artifact> => {
    if (a.content) return a;
    const backend = await getArtifactBackend();
    const fetched = await backend.get(a.id);
    if (fetched === null && (a.size_bytes ?? 0) > 0) {
      // Logged AS WELL AS thrown. There is no `onError` on this app, so an uncaught throw becomes a
      // bare 500 with nothing in CloudWatch — and a misconfiguration nobody can see is how this one
      // survived. The caller gets the sentence too; both audiences need it.
      console.error(
        `[mycel] artifact ${a.id} claims ${a.size_bytes} bytes the "${process.env.MYCEL_ARTIFACTS ?? "inline"}" backend does not have. ` +
          `Every process that reads or writes artifacts must share one MYCEL_ARTIFACTS setting.`,
      );
      throw new Error(
        `artifact ${a.id} holds ${a.size_bytes} bytes that this process cannot read: the content is not in the store and the ` +
          `"${process.env.MYCEL_ARTIFACTS ?? "inline"}" artifact backend does not have it. Every process that reads or writes ` +
          `artifacts must share one MYCEL_ARTIFACTS setting — a worker writing to S3 and an API serving inline loses the file.`,
      );
    }
    return { ...a, content: fetched ?? "" };
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

  /**
   * `library` is here so a missing runtime directory is READABLE FROM OUTSIDE.
   *
   * Six of them have gone missing in production and every one was found by somebody with shell
   * access eventually running the built image. A deployment nobody can exec into had no way to ask.
   * Empty is the healthy answer, and `ok` stays true: the API genuinely works — that is the whole
   * problem this reports.
   */
  app.get("/health", (c) =>
    c.json({
      ok: true,
      service: "mycel-harness",
      version: "v0.1",
      library: libraryGaps((p) => existsSync(p)).map((g) => ({ missing: g.entry, cost: g.cost })),
    }),
  );

  /**
   * A live page the client opens. PUBLIC, not under `/v1`, unguessable token.
   *
   * This is the product for GEO `ship_page` (and any other authored HTML we host): an https URL
   * that works on a phone. It is deliberately not artifact preview — that route will never serve
   * `text/html` from the authenticated origin. CSP forbids script; sanitizer already stripped it.
   * Unknown tokens 404 with the same body as a malformed token so this is not an oracle.
   */
  app.get("/p/:token", async (c) => {
    const token = c.req.param("token") ?? "";
    const missing = new Response("not found", {
      status: 404,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "x-robots-tag": "noindex",
        "cache-control": "no-store",
      },
    });
    if (!isPageToken(token)) return missing;
    const page = await getPublishedPage(token);
    if (!page) return missing;
    return new Response(page.html, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": PUBLISHED_PAGE_CSP,
        "x-content-type-options": "nosniff",
        "x-robots-tag": "noindex, nofollow",
        "referrer-policy": "no-referrer",
        "cache-control": "public, max-age=60",
      },
    });
  });

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

  // ── Party plane (third-party counterparties on a single ClientRequest) ──
  app.post("/v1/party/session", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as { token?: string };
    const out = await exchangePartyLink(b.token ?? "");
    if (!out) return c.json({ error: "that link is invalid or has expired" }, 401);
    return c.json({
      token: out.token,
      expires_at: out.expires_at,
      party: {
        role: out.scope.party_role,
        label: out.scope.party_label,
        request_id: out.scope.request_id,
      },
    });
  });

  app.use("/v1/party/*", async (c, next) => {
    if (c.req.path === "/v1/party/session") return next();
    const scope = await resolvePartySession(bearer(c));
    if (!scope) return c.json({ error: "unauthorized" }, 401);
    c.set("party", scope);
    await next();
  });

  app.get("/v1/party/request", async (c) => {
    const scope = c.get("party") as import("./party").PartyScope;
    const row = await partyOwnedRequest(scope);
    if (!row) return c.json({ error: "not found" }, 404);
    return c.json(toPartyRequest(row));
  });

  app.post("/v1/party/request/respond", async (c) => {
    const scope = c.get("party") as import("./party").PartyScope;
    const row = await partyOwnedRequest(scope);
    if (!row) return c.json({ error: "not found" }, 404);
    if (row.status !== "open") return c.json({ error: "that request is already closed" }, 409);
    if (row.kind === "connection") {
      return c.json({ error: "connection asks are for the client — not a third party" }, 400);
    }
    const b = (await c.req.json().catch(() => ({}))) as { response?: string };
    const response = (b.response ?? "").trim();
    if (!response) return c.json({ error: "an answer is required" }, 400);
    if (response.length > 10_000) return c.json({ error: "that answer is too long" }, 413);
    const resolved = await getRequestStore().resolveRequest(scope.project_id, row.id, response);
    if (!resolved) return c.json({ error: "that request is already closed" }, 409);
    await noteRequestAnswered(
      domain,
      systemMoveAuthority(resolved.project_id),
      resolved,
      resolved.resolved_at ?? new Date().toISOString(),
    ).catch(() => undefined);
    return c.json({ ok: true, request: toPartyRequest(resolved) });
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
   * A CUSTOMER SENDING IN THE FILE THE ASK IS WAITING FOR.
   *
   * ═══ THE ASK WAS ANSWERABLE ONLY IF WE HAPPENED TO HAVE A MAILBOX ═══
   *
   * The door next to this one is keyed on a THREAD, and a thread only exists when the project has
   * a channel. One project of twenty-one has one, so `thread_id` is null on every ask the product
   * has ever written — and `blocked.tsx` renders its file input only when `thread_id` is set.
   *
   * The arithmetic of that: twenty-eight of the forty-one open asks are `document` kind. A client
   * who reached the portal saw the question, a textarea, and a Send button, and no way to attach
   * the one thing being asked for. The ask was structurally unanswerable, and nothing said so.
   *
   * So this is keyed on the REQUEST, which always exists, instead of on a thread, which usually
   * does not. The founder-side twin (`/v1/requests/:id/attachments`) has existed for a while; this
   * is the same idea on the side of the person actually holding the file.
   *
   * ═══ WHERE THE BYTES LAND ═══
   *
   * On the run that raised the ask. Artifacts hang off tasks, and that run is where the resuming
   * episode will look — so `row.task_id` is the only honest anchor. Twenty-two of the twenty-eight
   * carry one. The six that do not are kickoff asks, raised when the engagement opened and before
   * any run existed; they are refused here in words rather than by silently accepting a file with
   * nowhere to belong. Their answer can still be typed.
   *
   * Scoped twice, like every route on this plane: the request is read with the SESSION's project,
   * and then its `client_id` must match the session's too. An id belonging to another tenant or
   * another customer of the same tenant reads as "not found" rather than as a row to check later.
   */
  app.post("/v1/portal/requests/:id/attachments", async (c) => {
    const sc = client(c);
    const row = await getRequestStore().getRequest(sc.project_id, c.req.param("id") ?? "");
    if (!row || row.client_id !== sc.client_id) return c.json({ error: "not found" }, 404);
    if (row.status !== "open") return c.json({ error: "that ask is already answered" }, 409);
    if (!row.task_id) {
      return c.json(
        { error: "this ask was raised when the engagement opened, before any run — type your answer instead of attaching a file" },
        409,
      );
    }
    const up = await ingestUpload(c, row.task_id, { uploadedBy: sc.client_id, clientId: sc.client_id });
    if ("error" in up) return c.json({ error: up.error }, up.status as 400);
    // The artifact id is what `respond` takes back as `artifact_ids`, so the client answers in two
    // steps from one form: upload, then send the answer carrying what was uploaded.
    return c.json(stripArtifactContent(up.artifact), 201);
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
    thread: { id: string; channel_id: string; subject?: string; case_id?: string },
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
        // Taken from the THREAD, never from the request. A client replying in the portal cannot
        // name a case, so the only way a run gets one is the conversation it came out of — which is
        // the whole point of `Thread.case_id`: it makes the engagement travel with the message
        // instead of having to be re-derived (or guessed) by every spawn path.
        case_id: thread.case_id,
        wedge: channel.wedge,
        task_type: channel.task_type,
        // `kind: "user"` with the client's id, so `selectGrantableConnections` scopes the run to
        // this client's connections and no one else's.
        actor: { kind: "user", id: sc.client_id },
        input: {
          message: body,
          subject: thread.subject,
          thread_id: thread.id,
          ...(thread.case_id ? { case_id: thread.case_id } : {}),
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

  /**
   * ── Sign-in ── six of the /v1/auth* routes live in auth.routes.ts.
   *
   * `federated` and `verify/request` stay below, after the `app.use("/v1/*")` they sit behind — in
   * Hono the order of a `use` relative to its neighbours is behaviour, not layout.
   */
  mountAuthRoutes(app, { identity });


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
      // Public because the link is opened from a mail client that may hold no session. See the
      // handler. Note what is NOT here: `/v1/auth/verify/request`, which mints the token and stays
      // behind a session precisely so it can be keyed on a member id and can therefore never be
      // asked whether a given email address has an account.
      "/v1/auth/verify/confirm",
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
    //
    // `/v1/portal/*` carries its own credential too, and it is the one plane that must NOT accept
    // the founder's product key. It is exempt here because the client-session middleware registered
    // above already refuses everything on this prefix that does not present a valid session (with
    // `/v1/portal/session`, the way you get one, as its only exception) — so nothing is opened by
    // this line. What it fixes is an ordering trap: Hono runs middleware in registration order, so
    // a portal route declared BELOW this one was being answered by the product-key check with a
    // bare 401, and a client's perfectly good session looked expired. The portal routes that
    // already worked worked only because they happened to be declared above it.
    if (
      c.req.path.startsWith("/v1/internal/") ||
      c.req.path.startsWith("/v1/invites/") ||
      // `/v1/signup-invites/<token>` is the same shape: the person holding a signup link has no
      // account yet, and the token IS the credential. The peek answers only {valid, email?}.
      c.req.path.startsWith("/v1/signup-invites/") ||
      c.req.path.startsWith("/v1/portal/") ||
      c.req.path.startsWith("/v1/party/") ||
      c.req.path === "/v1/composio/webhook" ||
      // `/v1/agentmail/webhook` is public for exactly the reason /v1/composio/webhook is: AgentMail
      // holds no Mycel credential, and its Svix signature over the raw body IS the authentication.
      // Exact match, never a prefix — everything else under /v1/agentmail/ (provisioning an inbox,
      // registering a sending domain, reading unattributed inbound) is an operator action and stays
      // behind the founder's key. A prefix here would have handed domain registration to the world.
      c.req.path === "/v1/agentmail/webhook" ||
      // The join bot holds no founder session. The per-join token IS the credential, checked in
      // the handler. Exact match: `/v1/meetings/join` stays behind the founder key — that path
      // starts a Fargate task, which costs money.
      c.req.path === "/v1/meetings/complete" ||
      c.req.path === "/v1/insight/events" ||
      // The live-preview proxy. An `<iframe src>` can send no header, so the per-task grant IN THE
      // PATH is the credential — minted behind the founder's key by POST /v1/tasks/:id/preview,
      // TTL-bound, and resolved against the grant store in the handler. Same shape as /v1/invites/.
      c.req.path.startsWith("/v1/preview/") ||
      // Host lookup has three accepted credentials and only one of them is a product key, so the
      // product-key middleware must not answer first with a bare 401. The bypass is CONDITIONAL on a
      // non-product credential actually being presented — waving the whole prefix through
      // unconditionally would leave `scope` unset, and the handler's product-key branch reads
      // `scope`, so the self-hosted path would break in a way nothing here would notice.
      (c.req.path.startsWith("/v1/host/") &&
        (!!process.env.MYCEL_HOST_TOKEN || !!projectForBrandKey(bearer(c)))) ||
      PUBLIC_AUTH.has(c.req.path)
    )
      return next();
    return requireApiKey(c, next);
  });

  /**
   * ═══ A SHOWROOM IS READ-ONLY. NOTHING IT DOES PERSISTS. ═══
   *
   * Refusing task creation was not enough, and the gap was worse than a stray row: a visitor opened
   * Apps and STARTED A COMPOSIO CONNECTION — a real OAuth flow, against our account, from a tenant
   * anyone on the internet can walk into. Every write endpoint was a hole of that shape. One of them
   * left a project called "hh" behind, which made the demo open on an empty business.
   *
   * Blocking each of them one at a time is a losing game: the set grows every time somebody adds a
   * route, and the failure is silent until a stranger finds it. So the rule is the method, not the
   * endpoint. GET and HEAD read; everything else changes something; a showroom does not change.
   *
   * Registered directly AFTER the auth middleware so `scope` exists, and BEFORE every route, so a
   * handler added tomorrow is covered without anyone remembering this file.
   *
   * The cost is that the demo cannot demonstrate writing, and that is the right trade — a visitor
   * comes to see whether the product is real, and the product is just as real read-only. What they
   * lose is the ability to leave litter in somebody else's shop window.
   */
  app.use("/v1/*", async (c, next) => {
    const m = c.req.method.toUpperCase();
    if (m === "GET" || m === "HEAD" || m === "OPTIONS") return next();

    const scope = c.get("scope");
    if (!isShowroomOrg(scope?.org_id)) return next();

    /**
     * THE PRODUCT KEY IS NOT A VISITOR.
     *
     * This guard exists to stop STRANGERS writing, and a stranger holds a session cookie. The
     * product API key is held by the deployment: it lives in Secrets Manager, never reaches a
     * browser, and is what the seeder authenticates with to build the showroom in the first place.
     *
     * Without this exemption the rule eats its own tail — the tenant becomes unseedable, and the
     * only way to change it is the database, which is exactly the reaching-behind-the-routes that
     * seed-demo.ts warns against.
     */
    if (scope?.kind === "key") return next();

    return c.json({ error: SHOWROOM_REFUSAL, code: "showroom" }, 403);
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
    // The invite-only gate applies here too — this route CREATES an account for a new email, and an
    // OAuth button must not be a way around the front door. An existing member is a sign-in, not a
    // sign-up, and passes untouched. No token: the OAuth dance has nowhere to carry one, so a linked
    // stranger signs up with a password and connects Google afterwards.
    if (
      signupInviteOnly() &&
      !getIdentityStore().findMemberByEmail(email) &&
      !getIdentityStore().signupPermitted(email).ok
    ) {
      return c.json({ error: "sign-ups are invite-only right now", code: "invite_only" }, 403);
    }
    const out = getIdentityStore().federated({ email, provider, orgName: b.org_name });
    return c.json(
      { token: out.session.token, member: out.member, projects: out.projects, created: out.created },
      out.created ? 201 : 200,
    );
  });

  /**
   * Ask for a verification email — for the signed-in member, and no one else.
   *
   * Below the auth middleware, so a session is mandatory. That placement is the entire
   * anti-enumeration argument and it is worth stating plainly: the endpoint takes NO email address.
   * It cannot be asked "does bob@acme.com have an account" because there is nowhere to put the
   * question. `/v1/auth/reset/request` has to answer `ok: true` to strangers and carry a comment
   * explaining why; this one is not reachable by a stranger at all.
   *
   * A product API key has no person behind it and therefore no address to verify — refused with a
   * sentence saying so rather than a 500 from an undefined member id.
   *
   * The four outcomes are reported as four different things. `202` for sent, `200` for
   * already-verified, `429` with `retry_after_ms` for throttled — a client that collapsed these
   * into "ok" would tell someone to check an inbox for a message that was never sent.
   */
  app.post("/v1/auth/verify/request", async (c) => {
    const scope = c.get("scope");
    if (!scope?.member_id) {
      return c.json({ error: "verification is for a signed-in person; an API key has no inbox" }, 400);
    }
    const out = getIdentityStore().requestVerification(scope.member_id);
    switch (out.status) {
      case "sent":
        return c.json({ status: "sent", token: out.token, email: out.email }, 202);
      case "already-verified":
        return c.json({ status: "already-verified", email: out.email });
      case "throttled":
        return c.json({ status: "throttled", retry_after_ms: out.retry_after_ms }, 429);
      case "unknown-member":
        // A live session pointing at a member that no longer exists. Real — an owner can remove a
        // teammate while they have a tab open — and it is a 401, not a 404: the right cure is to
        // sign in again, which is what `kernel()` in the product does with this status.
        return c.json({ error: "that session no longer belongs to anyone" }, 401);
    }
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

  /**
   * Remember something about the person, not the business.
   *
   * The product had been calling this route for the tour's "don't show me again" since before it
   * existed, and swallowing the 404 — so the tour re-ran forever and nobody could see why. Now
   * onboarding depends on the same promise for something far more visible ("we already asked you
   * your name"), which made a real route the only honest option.
   *
   * PATCH rather than PUT, and merged rather than replaced: two tabs holding two different reads of
   * `prefs` must not be able to erase each other's field. `null` deletes a key; an absent key is
   * left alone, which is what a partial form submit actually means.
   *
   * Member-only. A product API key has no person behind it, so there is nobody whose preferences
   * these would be — and silently writing them onto some member would attribute a machine's state
   * to a human.
   */
  app.patch("/v1/me/prefs", async (c) => {
    const scope = c.get("scope");
    if (!scope?.member_id) return c.json({ error: "member session required" }, 403);
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return c.json({ error: "body must be an object of preference keys" }, 400);
    }
    /**
     * TWO REFUSALS, AND THEY ARE NOT THE SAME PROBLEM.
     *
     * This said "preferences are too large" for both, because the store returned a bare
     * `undefined` and the comment here asserted it could only mean a ceiling. It cannot: a member
     * this process has never loaded refuses identically.
     *
     * Walking a fresh signup through onboarding hit exactly that. A kernel restart landed
     * mid-flow, the member was in Postgres but not yet in the in-memory Map, and onboarding
     * reported that an account with `prefs = null` had preferences that were too large. An hour
     * went into the wrong limit.
     *
     * 413 still for a genuine ceiling: nothing was malformed, there was just too much of it. 404
     * for a member we do not have, which is the truth and points at the session rather than the
     * payload.
     */
    const written = getIdentityStore().setMemberPrefsResult(scope.member_id, body as Record<string, unknown>);
    if (!written.member) {
      return written.reason === "no_such_member"
        ? c.json({ error: "no such member — this session's account is not loaded" }, 404)
        : c.json({ error: "preferences are too large" }, 413);
    }
    return c.json({ prefs: written.member.prefs ?? {} });
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
  // Tenant sites are served at `<slug>.apps.mycelai.dev`, a DIFFERENT root than the console's
  // `mycelai.dev`. Both must resolve a host to its project, or a generated site never gets its
  // brand. Empty on a single-domain / self-hosted install, which is fine — `projectForHost` just
  // gets the one root then.
  const APPS_DOMAIN = process.env.MYCEL_APPS_DOMAIN?.trim() || "";
  // Where a tenant site actually lives — the apps domain when there is one, else the root. Used for
  // the `portal_url` this route reports, which was pointing at `<slug>.mycelai.dev` (nothing) rather
  // than the `<slug>.apps.mycelai.dev` the deploy publishes to.
  const SITE_DOMAIN = APPS_DOMAIN || ROOT_DOMAIN;
  const HOST_ROOTS = [APPS_DOMAIN, ROOT_DOMAIN].filter(Boolean);

  // ── Public marketing-site inquiry (`POST /v1/host/:host/inquiry`) ──
  // Reserved bucket id a website lead is filed under. NOT a real client: no portal session ever
  // carries it, so the lead is founder-only by construction, and `nudgeWedgeFor` refuses to chase a
  // request with no case, so it is never emailed.
  const WEBSITE_INQUIRY_CLIENT_ID = "website-inquiry";
  // Sliding windows. Deliberately tight — a human fills a contact form a handful of times, never
  // fifty. Per-IP stops one stranger; per-project stops a botnet from flooding one founder's leads.
  const INQUIRY_IP_MAX = 5;
  const INQUIRY_IP_WINDOW_MS = 10 * 60_000; // 5 per 10 minutes per IP
  const INQUIRY_PROJECT_MAX = 50;
  const INQUIRY_PROJECT_WINDOW_MS = 60 * 60_000; // 50 per hour per project

  /**
   * ═══ CAN THIS DEPLOYMENT ACTUALLY SERVE A FOUNDER'S OWN DOMAIN? ═══
   *
   * By default, no — and until now the product said yes anyway. That is the bug this constant is.
   *
   * The flow was complete and convincing: claim a domain, publish a TXT record, `POST .../verify`
   * does a real DNS lookup, and on success the route returns `https://books.hartley.com` as the
   * founder's portal URL. Every line of it worked. Nothing behind it existed.
   *
   *   - `infra/dns.tf` promised `aws_acm_certificate.custom` in a comment. No such resource is
   *     defined anywhere, so no certificate is ever requested for the name.
   *   - `aws_lb_listener.https` carries exactly ONE certificate — the `*.mycelai.dev` wildcard.
   *     There is no `aws_lb_listener_certificate` resource in the repo, so a founder's own name is
   *     not on the listener and TLS fails before HTTP happens.
   *   - Every host-header rule in `apps.tf` matches `*.mycelai.dev`. A founder's domain matches
   *     none of them, so even with TLS solved it would fall through to the LANDING page.
   *
   * So the founder's reward for doing everything right was a padlock error, and the product had
   * told them it verified. That is the worst of the three possible states — worse than not offering
   * it, because it costs them a DNS change, a support ticket and their confidence in everything
   * else the product claims to have checked.
   *
   * ═══ WHY NOT JUST BUILD IT ═══
   *
   * Because it is not a terraform change, and writing terraform for it would be the same lie with
   * more files in it. A tenant domain is created when a founder types it at 2am; Terraform describes
   * a fixed set of resources applied by an operator. Doing this properly means the KERNEL calling
   * ACM `RequestCertificate`, publishing the validation CNAME the founder must add (a second DNS
   * round trip they have to be walked through), polling issuance, calling
   * `AddListenerCertificates`, and editing a host-header rule's value list — against a listener
   * whose certificate count and rule-condition count are both hard AWS quotas that this product
   * would hit at a few dozen tenants. That is a subsystem with its own failure modes, its own
   * retry semantics and its own quota story. It is worth building. It is not worth pretending.
   *
   * So: one switch. Off, and the product does not offer what it cannot serve — it says so, in a
   * sentence, and points at the address that genuinely works. On, and the routes behave exactly as
   * they always did, for a deployment that has done the ACM and listener work out of band.
   *
   * Note what is NOT gated: `projectForHost` still resolves an already-verified custom domain. A
   * deployment that turns this off after a founder verified must not stop answering for them.
   */
  const CUSTOM_DOMAINS =
    (process.env.MYCEL_CUSTOM_DOMAINS ?? "").toLowerCase() === "1" ||
    (process.env.MYCEL_CUSTOM_DOMAINS ?? "").toLowerCase() === "true";

  /** The one sentence a founder reads instead of a broken padlock. Kept greppable and kept honest. */
  const NO_CUSTOM_DOMAINS =
    // No "above" or "below" in here. This sentence is rendered by the console, by the CLI and by a
    // raw 501 body, and a copy that names a position on one particular screen is wrong on the other
    // two — the console puts the portal address above it, and the first draft said "below".
    "This deployment can't serve a portal on your own domain yet — it has no certificate for it, " +
    "so pointing DNS here would fail. Your portal address still works.";

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
    /**
     * ═══ THE PER-TENANT CREDENTIAL, AND WHY IT IS THE ONE THIS ROUTE WAS WAITING FOR ═══
     *
     * `MYCEL_HOST_TOKEN` is a shared secret that resolves ANY host. That is right for the one
     * trusted multi-tenant ECS app it was written for and wrong for the per-tenant Lambda, which
     * exists once per founder and runs code a model wrote: leaking one tenant's environment would
     * leak a token that reads every other tenant's branding. `MYCEL_API_KEY` — which
     * `business-template` used to ask for, and which nothing ever set, so this whole path was dead
     * in production — is very much worse: it starts tasks and reads every client in the estate.
     *
     * A brand key carries its own scope in its signature (`scopedkeys.ts`). Its entire authority is
     * "the public face of ONE project", and the enforcement of the "one" is three lines down.
     */
    const brandProject = projectForBrandKey(presented);
    // `scope` is undefined when the middleware waved this through on the host-token or brand-key
    // path, so the optional chain is load-bearing rather than defensive.
    if (!viaHostToken && !brandProject && c.get("scope")?.kind !== "key") {
      return c.json({ error: "host lookup requires a brand key, the host token, or a product key" }, 403);
    }
    const p = identity.projectForHost(c.req.param("host") ?? "", HOST_ROOTS);
    if (!p) return c.json({ error: "no business answers on that host" }, 404);
    /**
     * THE LEAST-AUTHORITY LINE. A brand key answers for its OWN project and no other.
     *
     * Without it the key would be a host-token with extra steps: a compromised tenant Lambda could
     * walk `acme.apps.mycelai.dev`, `globex.apps…` and read every founder's brand. The host is
     * still what selects the project — a tenant may serve several hostnames — but the answer is
     * refused unless the two agree. 404 and not 403, so a probe cannot distinguish "that host
     * belongs to someone else" from "that host does not exist".
     */
    if (brandProject && brandProject !== p.id) {
      return c.json({ error: "no business answers on that host" }, 404);
    }
    // `branding` stays exactly as it was — `businessProfile()` in business-template/lib/kernel.ts
    // reads those three fields and a deployed tenant must not need a redeploy to keep rendering.
    // `brand_kit` is the same object resolved in full, so the marketing site, the portal and a
    // rendered invoice are one brand rather than three. Logo BYTES are not here: this call is on the
    // critical path of every page load, and the logo is fetched as an image when it is shown.
    const kit = identity.brandKit(p.id)!;
    return c.json({
      slug: p.slug,
      branding: {
        display_name: kit.display_name,
        accent: kit.accent,
        support_email: kit.support_email,
      },
      brand_kit: publicBrandKit(kit),
    });
  });

  /**
   * A STRANGER writing to the agency from its generated marketing site.
   *
   * This is the one PUBLIC WRITE the tenant face has, so it is the one that has to assume the caller
   * is hostile. It carries the SAME credential as `GET /v1/host/:host` above — the shared
   * `MYCEL_HOST_TOKEN` or a per-project brand key — and re-checks it here, because the middleware
   * bypass for `/v1/host/*` only proves *a* host credential was presented, not that it answers for
   * the host in the path. The least-authority line is identical to the GET's: a brand key answers
   * for its OWN project and nothing else, and a mismatch is a 404 (never a 403) so a probe cannot
   * enumerate which hosts exist.
   *
   * What it deliberately does NOT do: create a client, open a thread, or start a run. A website
   * inquiry is a LEAD, not an engagement — it is captured as an open `ClientRequest` the founder
   * reads and actions, under a reserved non-client bucket id so no customer session can ever see it
   * and the nudge sweep (which fails closed on a request with no case behind it) never chases it.
   */
  app.post("/v1/host/:host/inquiry", async (c) => {
    // ── credential, mirrored verbatim from GET /v1/host/:host ──
    const hostToken = process.env.MYCEL_HOST_TOKEN;
    const presented = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
    const viaHostToken = !!hostToken && safeEqual(presented, hostToken);
    const brandProject = projectForBrandKey(presented);
    if (!viaHostToken && !brandProject && c.get("scope")?.kind !== "key") {
      return c.json({ error: "an inquiry needs a brand key, the host token, or a product key" }, 403);
    }

    // ── per-IP throttle, BEFORE we resolve anything: a stranger must not be able to make us do work
    //    (a host lookup, a store write) faster than a human could plausibly fill a form. First hop of
    //    x-forwarded-for, exactly like the auth limiter. ──
    if (limited(clientKey(c, "inquiry-ip"), INQUIRY_IP_MAX, INQUIRY_IP_WINDOW_MS)) {
      return c.json({ ok: false, error: "Too many messages from here. Please try again later." }, 429);
    }

    // Resolve the project the SAME way the GET does, and enforce the same least-authority line.
    const p = identity.projectForHost(c.req.param("host") ?? "", HOST_ROOTS);
    // 404 (not 403) on both "no such host" and "brand key for another project", so the two are
    // indistinguishable to a prober — the GET's rule, kept identical.
    if (!p || (brandProject && brandProject !== p.id)) {
      return c.json({ error: "no business answers on that host" }, 404);
    }

    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

    // Honeypot: a field no human sees and no real form fills. A bot that trips it is answered with
    // the SAME 200 a success gets and nothing is written — telling it apart from a real submission is
    // exactly what we deny it. Checked after the project resolves so a scripted probe cannot use the
    // honeypot's shape to distinguish a live host from a dead one.
    const hp = typeof body._hp === "string" ? body._hp.trim() : "";
    if (hp) return c.json({ ok: true });

    // ── per-project throttle: one founder's inbox cannot be flooded even from many IPs. ──
    if (limited(`inquiry-proj:${p.id}`, INQUIRY_PROJECT_MAX, INQUIRY_PROJECT_WINDOW_MS)) {
      return c.json({ ok: false, error: "This business is receiving a lot of messages right now. Please try again later." }, 429);
    }

    // Strip C0/C1 control chars — keep newlines/tabs only where a human legitimately types them (the
    // message body). A control char in a name or email is either a mistake or an injection attempt.
    const oneLine = (v: unknown): string =>
      String(v ?? "").replace(/[\u0000-\u001F\u007F-\u009F]/g, "").trim();
    const multiLine = (v: unknown): string =>
      String(v ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "").trim();

    const name = oneLine(body.name);
    const email = oneLine(body.email);
    const company = oneLine(body.company);
    const message = multiLine(body.message);
    /**
     * WHERE THE LEAD CAME FROM — campaign, referrer, which headline they were shown.
     *
     * Assembled by the tenant site from the request that rendered the page and round-tripped
     * through a hidden form field, so it is BROWSER-SUPPLIED and treated as such. It is sanitised
     * there and sanitised again here, and it decides nothing: the project this lead is filed
     * against comes from the host and the credential, as it did before this field existed. The
     * worst a forged value can do is misdescribe the sender's own lead.
     *
     * Capped hard. It is provenance the founder skims, not a payload — the tenant sends at most
     * seven short labelled lines, so anything past 600 characters is not something this app wrote.
     */
    const provenance = multiLine(body.provenance).slice(0, 600);

    if (!name || !email || !message) {
      return c.json({ ok: false, error: "Your name, email, and a message are all required." }, 400);
    }
    if (name.length > 120 || email.length > 200 || message.length > 4000 || company.length > 160) {
      return c.json({ ok: false, error: "One of those fields is too long." }, 400);
    }
    // Shape only — we do not send to it here, so a deliverability check would be theatre. This rejects
    // the obvious garbage ("", "hi", "a@b") that makes a lead worthless to follow up.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return c.json({ ok: false, error: "That email address doesn't look right." }, 400);
    }

    const detail =
      `From: ${name} <${email}>` +
      (company ? `\nCompany: ${company}` : "") +
      `\n\n${message}` +
      // Last and separated, so it reads as provenance under the message rather than as part of what
      // the sender wrote. A founder scanning a morning's leads is looking for one word here.
      (provenance ? `\n\nWhere this came from:\n${provenance}` : "");

    await getRequestStore().createRequest({
      project_id: p.id,
      // Reserved bucket, not a real client: no customer session carries this id, so the lead is
      // founder-only by construction, and it is never confused with an actual client on the account.
      client_id: WEBSITE_INQUIRY_CLIENT_ID,
      kind: "answer",
      ask: `Website inquiry from ${name}`,
      detail,
      // Sender identity travels in the party fields so the console can render "who" without a client
      // join. `party_role` stays "client" (the default) purely so this never lands on a candidate /
      // contractor packet path — no third-party link is minted for it.
      party_label: name,
      party_email: email,
    });

    return c.json({ ok: true });
  });

  // `GET /v1/projects/:id/tracing` used to report which Langfuse project a business's traces went
  // to. There is no external trace store any more: a run's trace is read back from our own event log
  // at `GET /v1/tasks/:id/trace`, per task, under the same scope check as the task itself.

  /**
   * The DNS checklist a founder must publish, assembled from what the state machine has learned so
   * far. Three records at most, each with a `purpose` key the console turns into a sentence:
   *
   *   ownership   — the TXT that proves the name is theirs. Gone once verified.
   *   certificate — ACM's validation CNAME. Appears after the first advance; stays until issued
   *                 (and afterwards, harmlessly — ACM uses the same record to renew).
   *   traffic     — the final CNAME from their name to `dxxxx.cloudfront.net`. Appears as soon as
   *                 the tenant's distribution is discovered, so all three can be published in ONE
   *                 sitting at the registrar instead of three round trips.
   */
  const domainRecords = (p: { custom_domain?: string; domain_verify_token?: string; domain_provisioning?: DomainProvisioning }) => {
    if (!CUSTOM_DOMAINS || !p.custom_domain) return [];
    const prov = p.domain_provisioning;
    const records: { purpose: string; type: string; name: string; value: string }[] = [];
    if (p.domain_verify_token) {
      records.push({ purpose: "ownership", type: "TXT", name: `_mycel.${p.custom_domain}`, value: p.domain_verify_token });
    }
    if (prov?.acm_record_name && prov.acm_record_value) {
      records.push({ purpose: "certificate", type: "CNAME", name: prov.acm_record_name, value: prov.acm_record_value });
    }
    if (prov?.distribution_domain) {
      records.push({ purpose: "traffic", type: "CNAME", name: p.custom_domain, value: prov.distribution_domain });
    }
    return records;
  };

  /** Where the machine stands, for a reader that was not watching it move. */
  const domainState = (p: { custom_domain?: string; custom_domain_verified_at?: string; domain_provisioning?: DomainProvisioning }) => {
    if (!p.custom_domain) return undefined;
    // The provisioning record wins when present; the two ownership facts answer for rows written
    // before the record existed, so an already-verified pre-migration domain reads as verified
    // rather than mysteriously "claimed".
    return p.domain_provisioning?.state ?? (p.custom_domain_verified_at ? "ownership_verified" : "claimed");
  };

  /** Where this business's portal lives, and the state of any custom domain. Members only. */
  app.get("/v1/projects/:id/domain", async (c) => {
    const scope = c.get("scope");
    const p = identity.getProject(c.req.param("id") ?? "");
    if (!p || !inScope(accessible(c), p.id)) return c.json({ error: "not found" }, 404);
    void scope;
    return c.json({
      // ── The serving state machine (domains.aws.ts), rendered for the console ──
      // No AWS call happens on this GET: everything below was recorded the last time the machine
      // advanced, so the page loads at page-load speed and the "Check status" POST is the only
      // thing that talks to ACM/CloudFront.
      domain_state: domainState(p),
      domain_error: CUSTOM_DOMAINS ? p.domain_provisioning?.error : undefined,
      records: domainRecords(p),
      live_url: p.domain_provisioning?.state === "live" && p.custom_domain ? `https://${p.custom_domain}` : null,
      slug: p.slug,
      portal_url: p.slug ? `https://${p.slug}.${SITE_DOMAIN}` : null,
      root_domain: ROOT_DOMAIN,
      // The whole point of this field: the UI asks the deployment what it can do rather than
      // rendering a form and hoping. A surface that offers a domain this kernel cannot serve is the
      // exact failure `CUSTOM_DOMAINS` exists to end, and it must not be possible to reintroduce it
      // by writing a nice-looking form in the console.
      custom_domain_supported: CUSTOM_DOMAINS,
      ...(CUSTOM_DOMAINS ? {} : { custom_domain_unsupported_reason: NO_CUSTOM_DOMAINS }),
      custom_domain: p.custom_domain,
      verified: !!p.custom_domain_verified_at,
      // The record they must publish. Returned while unverified so the UI can show it again after
      // a reload — a founder who closes the tab shouldn't have to start the claim over. Withheld
      // entirely when the deployment cannot serve the domain: a TXT record is an INSTRUCTION, and
      // handing someone an instruction whose success means nothing is how this feature wasted
      // people's afternoons.
      verify_record:
        CUSTOM_DOMAINS && p.domain_verify_token
          ? { type: "TXT", name: `_mycel.${p.custom_domain}`, value: p.domain_verify_token }
          : null,
    });
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════════════
   * ARCHIVE A BUSINESS — THE THING THERE WAS NO WAY TO DO
   * ═══════════════════════════════════════════════════════════════════════════════════════════════
   *
   * Until this route a project could be created and never removed. Every trial, every walkthrough,
   * every "let me see what this does" left a permanent business in the switcher — thirteen of them
   * on the founder's own account, and it would have happened to every single person who signed up.
   *
   * ARCHIVE, NOT DELETE, and the reason is the client rather than caution. A business carries
   * invoices, released deliverables and a portal on its own subdomain, and its CUSTOMERS hold links
   * into all three. Destroying that to tidy a sidebar trades somebody else's records for somebody's
   * clutter. So it disappears from every list, its clocks stop, and it stays reachable by id.
   *
   * The clocks are the half that would be forgotten. An archived business whose schedules kept
   * firing is worse than no archive at all: invisible, and still spending money.
   */
  app.post("/v1/projects/:id/archive", async (c) => {
    const scope = c.get("scope");
    const id = c.req.param("id");
    const project = identity.getProject(id);
    if (!project || !accessible(c).has(id)) return c.json({ error: "not found" }, 404);

    const body = (await c.req.json().catch(() => ({}))) as { archived?: unknown };
    // Default true, so `POST` with no body archives. `{ archived: false }` brings it back.
    const archiving = body.archived !== false;

    const next = identity.setProjectArchived(id, archiving ? new Date().toISOString() : null);
    if (!next) return c.json({ error: "not found" }, 404);

    /**
     * Silence its clocks, or give them back.
     *
     * Only the ones ARCHIVING turned off are re-enabled, tracked on the schedule itself — otherwise
     * un-archiving would switch on schedules the founder had deliberately turned off before they
     * ever archived it, which is a different business decision being made on their behalf.
     */
    let touched = 0;
    const owned = (await domain.listSchedules()).filter((x) => x.project_id === id);
    for (const sch of owned) {
      const paused = (sch.input as { archived_pause?: unknown } | undefined)?.archived_pause === true;
      if (archiving && sch.enabled) {
        await domain
          .updateSchedule(sch.id, { enabled: false, input: { ...sch.input, archived_pause: true } })
          .catch(() => null);
        touched++;
      } else if (!archiving && paused) {
        const { archived_pause: _drop, ...rest } = (sch.input ?? {}) as Record<string, unknown>;
        await domain.updateSchedule(sch.id, { enabled: true, input: rest }).catch(() => null);
        touched++;
      }
    }

    await audit({
      project_id: id,
      actor: scope?.member_id ?? "system",
      action: archiving ? "project.archived" : "project.unarchived",
      entity: "project",
      entity_id: id,
      detail: { name: project.name, schedules_touched: touched },
    });

    return c.json({ ok: true, project: next, schedules_touched: touched });
  });

  app.post("/v1/projects/:id/domain", async (c) => {
    const scope = c.get("scope");
    // 501 and not 400: the request is fine, this deployment cannot honour it. Refused BEFORE the
    // role check so an owner and an operator get the same true answer rather than two different
    // wrong ones, and refused before `claimDomain` so no verify token is ever minted for a name
    // nothing will serve.
    if (!CUSTOM_DOMAINS) return c.json({ error: NO_CUSTOM_DOMAINS, supported: false }, 501);
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
    if (!CUSTOM_DOMAINS) return c.json({ error: NO_CUSTOM_DOMAINS, supported: false }, 501);
    if (!canManageMembers(scope.role)) return c.json({ error: "only an owner or admin can verify a domain" }, 403);
    const p = identity.getProject(c.req.param("id") ?? "");
    if (!p || !inScope(accessible(c), p.id)) return c.json({ error: "not found" }, 404);
    if (!p.custom_domain) return c.json({ error: "no domain is awaiting verification" }, 400);

    // Ownership check runs only while the TXT token is outstanding. Once verified, re-entering this
    // route is the founder's "check again" — it ADVANCES the serving state machine (certificate,
    // edge alias) instead of refusing with "nothing awaiting verification", which used to be the
    // answer and left the whole second half of the flow with no button to press.
    if (p.domain_verify_token) {
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
    }

    /**
     * One bounded pass of the serving machine — request the certificate, read its status, attach
     * the alias if it can. Never blocks on issuance: the gap between "certificate requested" and
     * "issued" is the founder publishing a CNAME at their registrar, which is measured in hours,
     * and a request handler that waits for a registrar is an outage with a progress bar. The
     * founder presses this again; the machine resumes from where the row says it stopped.
     */
    // Captured BEFORE the advance: `getProject` hands back the live object, so after the machine
    // runs, `p.domain_provisioning` is already the new state and could not tell us it changed.
    const stateBefore = p.domain_provisioning?.state;
    const prov = await advanceCustomDomain(identity, p.id);
    if (prov.state === "live" && stateBefore !== "live") {
      await audit({
        project_id: p.id,
        actor: scope.member_id ?? "member",
        action: "domain.live",
        entity: "project",
        entity_id: p.id,
        detail: { domain: p.custom_domain, distribution: prov.distribution_id },
      });
    }
    const fresh = identity.getProject(p.id) ?? p;
    return c.json({
      verified: !!fresh.custom_domain_verified_at,
      domain_state: domainState(fresh),
      domain_error: prov.state === "failed" ? prov.error : undefined,
      records: domainRecords(fresh),
      live_url: prov.state === "live" ? `https://${p.custom_domain}` : null,
      // Kept for older callers that read only this: the domain is only genuinely reachable once
      // live, so until then the answer stays the address that works today.
      portal_url: prov.state === "live" ? `https://${p.custom_domain}` : (fresh.slug ? `https://${fresh.slug}.${SITE_DOMAIN}` : null),
    });
  });

  app.put("/v1/projects/:id/branding", async (c) => {
    const scope = c.get("scope");
    if (!canManageMembers(scope.role)) return c.json({ error: "only an owner or admin can change branding" }, 403);
    const p = identity.getProject(c.req.param("id") ?? "");
    if (!p || !inScope(accessible(c), p.id)) return c.json({ error: "not found" }, 404);
    // The body is a `BrandKitConfig` — a strict SUPERSET of the old `{display_name, accent,
    // support_email}`, so every existing caller keeps working unchanged and there is still exactly
    // one place a business's brand is stored. Validation (hex colours, logo mime and size,
    // letterhead enum) lives in brandkit.ts, because the renderer has to re-check the same things
    // when it reads a row an older build wrote.
    const { config, problems } = normalizeBrandKitConfig(await c.req.json().catch(() => ({})));
    // Refusals are returned rather than silently dropped: a logo that vanishes with a 200, or an
    // accent that is quietly ignored, is a founder who believes they changed something they didn't.
    if (problems.length) return c.json({ error: problems[0].message, problems }, 400);
    const updated = identity.setBranding(p.id, config);
    const kit = identity.brandKit(p.id);
    return c.json({ branding: updated?.branding ?? {}, brand_kit: kit ? publicBrandKit(kit) : null });
  });

  /**
   * ═══ GO AND READ THEIR OWN SITE ═══
   *
   * The only place in this product where a brand is MEASURED rather than picked off a shelf.
   * opendesign's first principle is that an AI naming a colour from memory hallucinates
   * plausible-but-wrong values; the only fix is to read a real one. Every house style before this
   * was `chosen`, `derived` or `default` — good taste, correctly argued, and not theirs.
   *
   * ONE REQUEST, NOT A JOB. This is a handful of GETs against a public website and a regex over the
   * CSS: no model, no sandbox, no browser. Making it a task would put a founder behind a queue for
   * something that finishes in under a second, and would make a page they are looking at wait on a
   * worker.
   *
   * STORING IS NOT ADOPTING. The reading lands as evidence with no `accepted_at`, so nothing that
   * renders changes until the founder looks at it and says yes — see `StyleEvidence` in
   * house-style.ts for why this one value alone needs a confirmation.
   */
  app.post("/v1/projects/:id/branding/measure", async (c) => {
    const scope = c.get("scope");
    if (!canManageMembers(scope.role)) return c.json({ error: "only an owner or admin can change branding" }, 403);
    const p = identity.getProject(c.req.param("id") ?? "");
    if (!p || !inScope(accessible(c), p.id)) return c.json({ error: "not found" }, 404);
    const b = (await c.req.json().catch(() => ({}))) as { website?: unknown };
    const website = String(b.website ?? "").trim().slice(0, 300);

    const reading = await measureSite(website, async (url) => {
      // Six seconds and 2 MB. A stylesheet is small; anything that is not is not a stylesheet, and a
      // founder waiting on a page must never be held by somebody else's slow CDN.
      const r = await fetchWithDeadline(url, { redirect: "follow" }, { deadlineMs: 6_000 });
      /**
       * `url` is the REQUESTED address, not the final one after redirects — `fetchWithDeadline`
       * does not surface that and this route does not need it enough to change a shared helper.
       * The consequence is small and worth naming: a site that redirects to `www.` resolves its
       * relative stylesheet hrefs against the pre-redirect origin, which the redirect then follows
       * anyway. It matters only for a redirect that changes PATH depth, which a homepage does not.
       */
      return { ok: r.ok, body: (r.text ?? "").slice(0, 2_000_000), url };
    });

    const branding = { ...(p.branding ?? {}) } as Record<string, unknown>;
    branding.website = website || undefined;
    branding.measured = {
      at: new Date().toISOString(),
      url: reading.url,
      colors: reading.colors,
      fonts: reading.fonts,
      problem: reading.problem,
      // Deliberately NOT carried over from any previous reading. A new measurement is a new claim,
      // and inheriting the old confirmation would let a re-read silently repaint accepted work.
    };
    identity.setBranding(p.id, branding as never);
    return c.json({ measured: branding.measured, said: describeMeasured(reading) });
  });

  /**
   * The founder agreeing that what we read off their site IS their brand.
   *
   * Separate from the measuring route because they are different acts by different parties: one is
   * us reading, the other is them deciding. Collapsing them would make looking at a website enough
   * to change what a client receives.
   */
  app.post("/v1/projects/:id/branding/measure/accept", async (c) => {
    const scope = c.get("scope");
    if (!canManageMembers(scope.role)) return c.json({ error: "only an owner or admin can change branding" }, 403);
    const p = identity.getProject(c.req.param("id") ?? "");
    if (!p || !inScope(accessible(c), p.id)) return c.json({ error: "not found" }, 404);
    const branding = { ...(p.branding ?? {}) } as { measured?: { colors?: string[]; accepted_at?: string } };
    const m = branding.measured;
    if (!m?.colors?.length) {
      return c.json({ error: "there is nothing measured to accept — read the site first" }, 400);
    }
    branding.measured = { ...m, accepted_at: new Date().toISOString() };
    identity.setBranding(p.id, branding as never);
    return c.json({ measured: branding.measured });
  });

  /**
   * The kit itself, logo bytes and all — for the renderer's sake and for a configuration UI that
   * needs to show the founder what is currently set.
   *
   * Separate from the branding PUT's response, which strips the bytes, because 200KB of base64 has
   * no business travelling on a write nobody asked to read back.
   */
  app.get("/v1/projects/:id/brand-kit", async (c) => {
    const p = identity.getProject(c.req.param("id") ?? "");
    if (!p || !inScope(accessible(c), p.id)) return c.json({ error: "not found" }, 404);
    return c.json(identity.brandKit(p.id));
  });

  /**
   * GET /v1/design-systems — the shelf of looks a founder can choose from.
   *
   * The console cannot read `kernel/design-systems/` (different image, different container), and
   * duplicating 29 palettes into the app would guarantee the two drift — the founder would pick a
   * look from one list and the delivering run would wear a different one. One source of truth, read
   * over the wire.
   *
   * Not project-scoped and holding nothing tenant-specific: it is the same 29 vendored systems for
   * everybody. Behind the founder's key like the rest of /v1, because there is no reason for it to
   * be public and a list of what we ship is not something to hand out for free.
   *
   * SUMMARIES, not bodies. The full tokens.css and DESIGN.md are what a RUN mounts; a chooser needs
   * four colours and a sentence, and sending ~250KB so a browser can paint 29 swatches would be
   * paying for the wrong thing.
   */
  app.get("/v1/design-systems", (c) =>
    c.json({
      systems: designSystemSummaries(),
      default: DEFAULT_DESIGN_SYSTEM,
      // So the console can show "suggested from your look" without holding its own copy of the
      // archetype table. Two copies is how a look comes to mean one thing in the chooser and
      // another in the run that makes the document.
      by_archetype: designSystemsByArchetype(),
    }),
  );

  /**
   * GET /v1/design-systems/:id — one system in full.
   *
   * For a specimen the console renders in an iframe: it needs the real `:root` block to paint a
   * real example, which is the only way a founder can tell `editorial` from `publication`.
   */
  app.get("/v1/design-systems/:id", (c) => {
    const s = designSystem(c.req.param("id") ?? "");
    if (!s) return c.json({ error: "not found" }, 404);
    /**
     * `shadcn` rides along, and it is the reason any of this can dress a real surface.
     *
     * The system's own `tokens.css` speaks open-design's vocabulary — `--bg`, `--fg`, `--surface`.
     * Every app we ship (landing, cloud, business-template) speaks shadcn's — `--background`,
     * `--foreground`, `--card`. Seven names overlap out of fifty, so handing a consumer the raw
     * tokens and expecting a themed page is handing them a file their components cannot read.
     *
     * Sent as a sibling rather than replacing `tokens`, because both have callers: a DELIVERABLE
     * gets the raw system (it writes its own CSS from scratch and wants the full vocabulary), and a
     * SITE gets this block (its components are already written against shadcn names).
     */
    return c.json({ ...s, shadcn: shadcnFromDesignSystem(s.id) });
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
        linkedin_sessions: (await domain.listConnections()).filter(
          (cn) => cn.kind === "linkedin" && projects.some((p) => p.id === cn.project_id),
        ).length,
      },
    });
  });

  mountProductOpsRoutes(app, store);

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
    // Validated against the exported union rather than a list retyped here. The list version was a
    // copy that had to be remembered: adding `none` to `PlanStatus` and not to the array would have
    // made the one status meaning "not entitled to anything" the one status this route rejects.
    if (status && !PLAN_STATUSES.includes(status)) {
      return c.json({ error: `unknown status: ${b.status}` }, 400);
    }
    const orgId = targetOrg ?? scope.org_id;
    /**
     * Captured BEFORE the write, because the entry below is only worth anything if it says what
     * changed, and after `setPlan` the previous values are gone from every store we have.
     *
     * COPIED, not referenced. `getOrg` hands back the live object out of the store's map and
     * `setPlan` mutates it in place, so holding the reference recorded the new values as the old
     * ones — every entry would have claimed the org moved from `past_due` to `past_due`. Caught by
     * the test in trial.test.ts that asserts a transition rather than just the presence of an entry,
     * which is the only reason to assert on `from` at all.
     */
    const was = identity.getOrg(orgId);
    const before = { plan: was?.plan, status: was?.plan_status };
    const org = identity.setPlan(orgId, {
      plan,
      status,
      billing_ref: b.billing_ref,
      renews_at: b.renews_at,
    });
    if (!org) return c.json({ error: "not found" }, 404);

    /**
     * Entitlement changes go in the hash chain.
     *
     * Without this, "why did this business stop running jobs on the fourteenth" is unanswerable from
     * anything we hold: the org row shows only the current state, and Stripe shows charges rather
     * than the decisions we made from them. A trial that lapsed, a card that failed and an operator
     * who moved someone by hand all look identical afterwards. `actor: "system"` because the caller
     * is the control plane holding a product key, not a person.
     *
     * Written into the org's first project chain — the audit log is project-scoped, and an org-level
     * fact belongs with the business it is about rather than in a global stream no tenant can read.
     */
    await audit({
      project_id: identity.listProjects(orgId)[0]?.id ?? "",
      actor: "system",
      action: "org.plan_changed",
      entity: "org",
      entity_id: orgId,
      detail: {
        from: before,
        to: { plan: org.plan, status: org.plan_status },
        renews_at: org.plan_renews_at,
        // Deliberately NOT `billing_ref`. It is Stripe's customer id, and the audit log is readable
        // by the tenant — a payment-account identifier is not something a chain entry needs to carry
        // to be useful, and `detail` is documented as non-secret.
        cross_org: !!targetOrg && targetOrg !== scope.org_id,
      },
    });

    /**
     * ═══ THE REFERRAL PAYS HERE, ON A PAID CONVERSION, ONCE ═══
     *
     * Not at sign-up. A reward that lands when somebody creates an account is a reward that gets
     * farmed within a week, and this one is worth a month of somebody's plan.
     *
     * `active` and `trialing` both count as started paying: a trial on this product exists only
     * behind a card (`plan_status: "none"` is the window before one), so reaching either means a
     * payment method was accepted. `creditReferral` is idempotent and returns the referrer only on
     * the call that actually credited, so an org that lapses and comes back cannot pay twice.
     *
     * Audited into the REFERRER's project, not this one: it is a fact about their account, it is
     * the evidence behind a credit somebody will ask about, and the referred org has no business
     * reading it.
     */
    /**
     * ═══ A CANCELLED PLAN GIVES THE DEDICATED IPs BACK ═══
     *
     * A LinkedIn connection leases a dedicated ISP address in the member's country, and that address
     * bills every month whether anybody uses it or not. Nothing gave it back. So the shape of the
     * bug was: a founder cancels, their work stops the same minute (`INACTIVE_LIMITS`), and we go on
     * paying a proxy vendor for an address nobody will ever connect through again.
     *
     * HERE, on the plan write, because this is the only moment the kernel learns a subscription
     * ended. It is not a cron: a nightly sweep would leave up to a day of paid-for silence, and a
     * sweep that reads "which orgs are cancelled" is a query that gets one predicate wrong and
     * releases a paying customer's address.
     *
     * FAIL-SOFT AND LOGGED. The plan write must land whatever the proxy vendor is doing — a founder
     * cancelling cannot be blocked by Bright Data being unreachable — and an address we failed to
     * release is money, so it says so rather than disappearing into a catch.
     *
     * The connection rows are LEFT ALONE. Nothing here deletes anything; see `workBlockedBy`, which
     * makes the same promise about tasks and artifacts. Reconnecting after paying again buys a new
     * address, which is the honest outcome — the old one belongs to somebody else by then.
     */
    if (org.plan_status === "cancelled" || org.plan_status === "none") {
      void releaseOrgProxies(orgId).catch((e) =>
        console.error("[mycel] releasing dedicated IPs after cancellation failed:", (e as Error)?.message),
      );
    }

    if (org.plan_status === "active" || org.plan_status === "trialing") {
      const referrer = identity.creditReferral(orgId);
      if (referrer) {
        await audit({
          project_id: identity.listProjects(referrer)[0]?.id ?? "",
          actor: "system",
          action: "referral.credited",
          entity: "org",
          entity_id: referrer,
          // The referred org's NAME, never its id or its plan. A referrer is owed "who", not a
          // handle they could use against somebody else's account.
          detail: { referred: org.name, months: REFERRAL_REWARD_MONTHS },
        });
      }
    }

    return c.json({ org, limits: identity.limitsFor(orgId) });
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════════════
   * GET /v1/referrals — the link a founder shares, and what it has done
   * ═══════════════════════════════════════════════════════════════════════════════════════════════
   *
   * MEMBER-ONLY. A product API key belongs to an integration, not to a person, and a referral link
   * is a personal credential in the sense that matters: whoever holds it collects. Keys are refused
   * rather than served a read-only view, because the only reason a key would ask is that somebody
   * put one in a script that posts the link somewhere.
   *
   * The code is minted on first read — see `referralCode` — so this route is also the backfill for
   * every org that existed before referrals did.
   *
   * ── WHAT IT SAYS ABOUT THE PEOPLE WHO JOINED ──
   *
   * A name and a state, and nothing else. Not their email, not their plan, not their id. A referrer
   * is owed enough to recognise who they brought and to know whether it counted; anything past that
   * is one founder reading another founder's account through a feature they were given as a thank
   * you.
   */
  app.get("/v1/referrals", (c) => {
    const scope = c.get("scope");
    if (scope.kind !== "member") {
      return c.json({ error: "a referral link belongs to a person, not to an API key" }, 403);
    }
    const code = identity.referralCode(scope.org_id);
    if (!code) return c.json({ error: "not found" }, 404);

    const joined = identity.referredBy(scope.org_id).map((o) => ({
      name: o.name,
      joined_at: o.created_at,
      /*
        Three states, and they are the three a founder asks about: it worked, it is early, or it
        never converted. Derived rather than stored — a second copy of "did this count" would be one
        more thing to keep in step with the plan.
      */
      credited: !!o.referral_credited_at,
      ...(o.referral_credited_at ? { credited_at: o.referral_credited_at } : {}),
    }));

    return c.json({
      code,
      reward_months: REFERRAL_REWARD_MONTHS,
      joined,
      credited: joined.filter((j) => j.credited).length,
    });
  });

  /**
   * ── Team ── /v1/team* lives in team.routes.ts.
   *
   * Six routes that are all one concern: who is in this org and what they may do.
   */
  mountTeamRoutes(app, { identity });


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

    /**
     * Validate at the boundary: the wedge must exist, and if it declares task_types the requested
     * one must be among them. A typo shouldn't queue a task that dies 60s later.
     *
     * PROJECT-SCOPED, and the resolution has to happen before the tenancy block below rather than
     * after it — which is why `writeProjectId` is read twice in this route. A service Mycel wrote
     * for one business is invisible to `loadWedge` by construction (see wedge.ts), so resolving it
     * without a tenant here would have refused every authored service at the door with "unknown
     * wedge", and the whole feature would have looked broken from its only entry point.
     *
     * `?? ""` rather than an early 400: the caller may legitimately have named no project yet, and
     * the block below already has the right sentence for that. An empty project id makes
     * `loadProjectWedge` throw for an authored slug, so it is short-circuited to a plain refusal —
     * an unauthenticated probe must not be able to raise a 500.
     */
    const forProject = writeProjectId(c) ?? "";
    const wedge = isAuthoredSlug(body.wedge) && !forProject ? null : await loadProjectWedge(forProject, body.wedge);
    if (!wedge) {
      return c.json(
        {
          error: isAuthoredSlug(body.wedge)
            ? // Says which of the three reasons it is, without confirming that another tenant's
              // service exists: "not yours" and "does not exist" get the same sentence, and the one
              // that is actionable — you have not agreed to run it — is named.
              `no service by that name is running for this business — a drafted service has to be agreed to before it can do anything`
            : unknownService(body.wedge),
        },
        400,
      );
    }
    const types = wedge.manifest.task_types;
    if (types && Object.keys(types).length && !types[body.task_type]) {
      return c.json({ error: `the "${body.wedge}" service does not do "${body.task_type}"` }, 400);
    }

    /**
     * ═══ A JOB THE HARNESS DISPATCHES CANNOT BE CREATED BY HAND ═══
     *
     * Four GTM task types say it in their own descriptions — "Harness work, not agent work: no model
     * is invoked. Spawned by the sequencer's own schedule — do not create these by hand." That
     * sentence is read by a model and enforced by nothing, which is this repo's oldest shape: an
     * instruction where a rule was needed.
     *
     * Posting `gtm_autonomous` to this route did exactly what the description forbids. It took the
     * ordinary agent path: provisioned a sandbox, invoked a model, charged for two turns, spent the
     * whole run blocked on file reads it was not permitted to make, discovered nobody, and reported
     * SUCCESS. The real work — `runAutonomousGtm`, called from the scheduler — never ran.
     *
     * Every part of that is bad on its own. Together they are the worst kind: money spent, nothing
     * done, and a green tick. So the route refuses it and names what does create it, because a
     * refusal that does not say where the door is just moves the confusion.
     */
    const spec = types?.[body.task_type] as { harness_dispatched?: boolean } | undefined;
    if (spec?.harness_dispatched) {
      return c.json(
        {
          error:
            `"${body.task_type}" is run by the harness on its own schedule, not created by hand — ` +
            `posting one here would spend a sandbox and a model on work the scheduler does without either`,
        },
        400,
      );
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

    /**
     * No subscription — say so, in words, before any number is compared.
     *
     * `INACTIVE_LIMITS` sets `tasks_per_month: 0`, so the numeric check below would already refuse
     * this. It would refuse it with "your plan includes 0 jobs a month, and 0 have run", which is
     * technically true and completely useless: it reads like a bug, it does not say a trial ended
     * or a subscription was cancelled, and it does not say what fixes it.
     *
     * That distinction is the whole requirement. A business whose scheduled work stops must not find
     * out from a silence or from a nonsense number — every refusal carries the reason and the
     * remedy, and `code` lets the product render an upgrade prompt instead of an error toast.
     *
     * Note which statuses are deliberately NOT here. `trialing` runs at the full limits of the plan
     * being trialled. `past_due` — which is where Stripe puts a subscription whose FIRST charge is
     * declined at the end of the seven days — also runs at full limits, for weeks, while it retries.
     * A declined card does not stop somebody's business.
     */
    const planStatus = identity.workBlockedBy(scope.org_id);

    /**
     * The one exception, and the reason it exists: onboarding's own drafting runs.
     *
     * OBSERVED IN PRODUCTION. A real signup on app.mycelai.dev pressed "Work it out" on step two of
     * onboarding and read "Couldn't start that. Try again in a moment." — because this route
     * refused it with 402 below. Onboarding is linear and the card is step seven, so the thing that
     * convinces somebody to pay was gated behind their having paid, and no hosted signup could
     * reach the close at all.
     *
     * Bounded on four axes and unraisable by anything in this request — see presubscription.ts for
     * the full argument, including why `app_building` is NOT here and why `cancelled` is not either.
     */
    const presub = planStatus === "none" && isPresubscriptionWork(body.wedge, body.task_type);

    if (planStatus && !presub) {
      return c.json(
        {
          error:
            planStatus === "none"
              ? "this business doesn't have a subscription yet — start a plan to run jobs. Everything already here stays where it is."
              : "your subscription ended, so new jobs are paused. Everything already here stays where it is, and starting a plan again resumes it.",
          code: "plan_inactive",
          plan_status: planStatus,
        },
        402,
      );
    }

    if (presub) {
      /**
       * The allowance, counted over the org's whole lifetime rather than this month.
       *
       * Both numbers come from rows the store already has, so there is nothing here a caller could
       * send that changes them, and nothing that resets when the calendar turns over. An org in this
       * state can only ever have created shaping tasks — everything else is refused above — so the
       * task count IS the count of free drafts taken.
       *
       * Refused with the same `plan_inactive` code as every other plan refusal, because that is what
       * the product keys its upgrade prompt off, and with a sentence that says what ran out and what
       * fixes it. `allowance: "spent"` distinguishes it for anything that wants to.
       */
      const reach = identity.accessibleProjectIds(scope);
      const runs = await store.countTasksSince([...reach], PRESUB_SINCE);
      const spent = runs > 0 ? await store.sumCostSince([...reach], PRESUB_SINCE) : 0;
      if (runs >= PRESUB_MAX_RUNS || spent >= PRESUB_MAX_SPEND_USD) {
        return c.json(
          {
            error: PRESUB_SPENT_MESSAGE,
            code: "plan_inactive",
            plan_status: planStatus,
            allowance: "spent",
          },
          402,
        );
      }
    }

    const limits = identity.limitsFor(scope.org_id);
    // `INACTIVE_LIMITS` is all zeroes, so an exempt run has to skip the metered checks or the
    // exemption above would be undone two lines later by "your plan includes 0 jobs a month" — the
    // arithmetic refusal that the plan-status check exists to pre-empt. The allowance it was checked
    // against instead is strictly tighter than any plan's.
    /**
     * ═══ A CEILING THAT STOPS THE WORK MUST SAY WHAT HAPPENS NEXT ═══
     *
     * Both messages named the number and nothing else: "this month's model spend has reached your
     * plan's $30 ceiling". True, and the worst sentence in the product to read — a founder's client
     * work has just stopped, mid-month, and they are told a fact about our billing.
     *
     * Two things they need and neither was there. WHEN it clears, because "the first of the month"
     * turns a dead end into a wait somebody can plan around. And that upgrading is the other way
     * out, because a ceiling reached is the only moment a plan limit has ever persuaded anyone of
     * anything, and this product currently has no other upgrade trigger that binds.
     *
     * `Intl` rather than a hand-rolled date: this is read by a person, in their month, and the 1st
     * of next month is a different day depending on which one you are in.
     */
    const resetsOn = (): string => {
      const now = new Date();
      const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
      /*
        Locale-free. `toLocaleDateString("en-GB", …)` rendered every customer's date the way London
        writes it, on a product that prices in dollars — and on a server whose locale is whatever the
        container image happens to carry, so dropping the argument would be unpredictable rather than
        neutral. Indexed from a table instead.
      */
      const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
      return `${next.getUTCDate()} ${MONTHS[next.getUTCMonth()]}`;
    };

    const monthly = presub ? null : limits.tasks_per_month;
    if (monthly !== null) {
      const used = await tasksThisMonth(identity.accessibleProjectIds(scope));
      if (used >= monthly) {
        return c.json(
          {
            error:
              `Your plan includes ${monthly} jobs a month and ${used} have run. It clears on ` +
              `${resetsOn()}, or moving up a plan restarts it now.`,
            code: "task_limit",
          },
          402,
        );
      }
    }

    /**
     * A SHOWROOM ORG NEVER STARTS WORK.
     *
     * Checked here rather than left to the ceilings below, because those read the PLAN and the
     * demo tenant's real budget lives on its LiteLLM key. With plan $90 and key $0 the task was
     * created, a sandbox booted, the model call was refused at the gateway, and the run died — one
     * microVM per click for anybody bored enough to keep clicking.
     *
     * Refused at the door instead: no task row, no sandbox, no run. See showroom.ts for why this is
     * an env allowlist rather than a column.
     */
    if (isShowroomOrg(scope.org_id)) {
      return c.json({ error: SHOWROOM_REFUSAL, code: "showroom" }, 403);
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
    if (!presub && limits.model_spend_usd_per_month !== null) {
      const spent = await spendThisMonth(identity.accessibleProjectIds(scope));
      if (spent >= limits.model_spend_usd_per_month) {
        return c.json(
          {
            error:
              `This month's work has reached your plan's ceiling. Nothing is lost and nothing is ` +
              `charged: it clears on ${resetsOn()}, or moving up a plan restarts it now.`,
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
    // A service Mycel wrote for THIS business and that this founder promoted is enabled by that act
    // — the allowlist is about which of the INSTALLED services a project may run, and an authored
    // service is not in it and never will be. Without this, a project with any explicit allowlist
    // would promote a service and then be told it is not enabled for them, with no way to fix it.
    if (!isAuthoredSlug(body.wedge) && !identity.projectAllowsWedge(projectId, body.wedge)) {
      return c.json({ error: serviceNotEnabled(body.wedge) }, 403);
    }
    if (!presub && body.wedge !== (wedgeForRole("outreach") ?? "") && !limits.fulfillment) {
      return c.json(fulfillmentRefusal(), 402);
    }

    /**
     * ═══ THE SAME REQUEST, SENT TWICE, MUST NOT BE TWO JOBS ═══
     *
     * This used to be a process-local `Map`, and the comment on it said so: "In-process for now
     * (single-instance); back with the store for multi-instance." We run several replicas. A caller
     * whose POST timed out at the proxy retries, the retry lands on a different kernel, that kernel
     * has never heard of the key, and a second task is created — a second sandbox, a second run, and
     * for a `chase_invoice` a second email to somebody's client. The caller cannot detect it,
     * because their retry succeeded.
     *
     * a comparable runtime state the principle in `session-lifecycle/requeue-policy.ts`: "retryability
     * is a property of WHO OWNS THE OUTCOME, not of the error", and describe the same outcome when
     * both owners act — "Two billed sandboxes execute the baked initial_prompt."
     *
     * It was also not atomic on ONE replica: `has()` then `await store.getTask()` then, much later,
     * `set()`. Two concurrent requests both pass the check inside that await.
     *
     * So the claim is taken in the grant store, in one statement, before any work happens.
     *
     * SCOPED BY TENANT. The key is caller-supplied, so an unscoped nonce would let one org's "1"
     * collide with another's — either leaking a task across the boundary or refusing a legitimate
     * request because a stranger used the same word.
     */
    /**
     * DOES THE INPUT SATISFY THE CONTRACT THE TASK TYPE DECLARES?
     *
     * Checked HERE, at creation, because this is the last moment the caller is still listening. A
     * task that provisions a sandbox, runs for twenty minutes and then reports "the accounting
     * period is missing" spent real money discovering something this route already knew, and told
     * the founder about it through a failed job rather than through a 400.
     *
     * `output_schema` has been validated and described to the agent since the beginning. The input
     * side had neither, and 23 task types have carried an `input_schema` that nothing ever read.
     *
     * A task type with NO declared schema is unaffected — see `inputFaults`. Thirty-seven of them
     * declare nothing, and rejecting their inputs on a guess would break every one at once.
     */
    const declared = types?.[body.task_type] as { input_schema?: unknown } | undefined;
    const badInput = inputFaults(body.input ?? {}, declared?.input_schema);
    if (badInput.length) {
      return c.json(
        { error: `this task's input does not match what \`${body.task_type}\` needs: ${badInput.join("; ")}` },
        400,
      );
    }

    const idem = c.req.header("idempotency-key");
    const idemNonce = idem ? `${scope.org_id}:${projectId}:${idem}` : "";
    if (idem) {
      const grants = await getGrantStore();
      const held = await grants.putIfAbsent("idem", idemNonce, {}, new Date(Date.now() + IDEM_TTL_MS));
      if (held) {
        const priorId = typeof held.task_id === "string" ? held.task_id : "";
        const existing = priorId ? await store.getTask(priorId) : undefined;
        if (existing) return c.json(existing, 200);
        /**
         * Someone holds the key and has not recorded a task id yet — they are between the claim and
         * the insert, milliseconds wide.
         *
         * 409 rather than proceeding. Proceeding is the one answer that recreates the bug: it makes
         * a duplicate precisely when two copies of the request are in flight together, which is the
         * case this exists for. A retry moments later reads the winner's task and gets a 200.
         *
         * A task id that no longer resolves lands here too — deleted, or expired out of the store —
         * and 409 is right for that as well: the key was spent, and answering 200 with nothing or
         * silently starting a second job would both be worse than saying so.
         */
        return c.json({ error: "a request with this Idempotency-Key is already in flight" }, 409);
      }
    }

    // A client_id on a task decides whose context that task's artifacts show up in, so it is
    // checked against the caller's own project before it is stored. See `clientInProject`.
    if (body.client_id !== undefined && !(await clientInProject(body.client_id, projectId))) {
      return c.json({ error: "unknown client_id for this project" }, 400);
    }



    const cfg = loadConfig();
    const clamped = clampConstraints(body.constraints, cfg.maxCostCeilingUsd, cfg.maxRuntimeCeilingS, loadWedge(body.wedge), body.task_type);
    /**
     * A free draft gets a free draft's budget, whatever it asked for.
     *
     * `Math.min` and applied AFTER the caller's constraints have been read, which is the whole
     * point: a crafted `POST /v1/tasks` with `constraints.max_cost_usd: 1000` from an org that has
     * never paid us anything would otherwise turn one exempt run into a real bill. Deliberately not
     * a refusal — the honest path already asks for exactly this number, so clamping costs nobody a
     * run, and refusing on a number the client did not know about would be a worse first experience
     * than a cheaper one.
     */
    const constraints = presub
      ? { ...clamped, max_cost_usd: Math.min(clamped.max_cost_usd, PRESUB_MAX_COST_USD) }
      : clamped;
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
    if (idem) {
      // Now the key can answer with something. Best-effort: the claim above is what prevents the
      // duplicate, and this only upgrades a 409 into a replayed 200. Failing the founder's task
      // because we could not file the note would trade the job for the receipt.
      await (await getGrantStore())
        .put("idem", idemNonce, { task_id: task.id }, new Date(Date.now() + IDEM_TTL_MS))
        .catch((e) => console.error("[mycel] idempotency record failed:", (e as Error)?.message));
    }
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
    /*
      ═══ SCOPED IN THE QUERY. THE `* 4` WAS A HOPE, AND IT LOST ═══

      This fetched `limit * 4` of the newest rows ACROSS EVERY TENANT and filtered afterwards. The
      multiplier is a guess at how much over-fetch is enough, and it fails exactly when the
      installation is busiest — which is also when it matters.

      Measured on production, 14 September: of the 100 most recent tasks installation-wide, `default`
      owned 75 and `Northstar Creative` 24. The showroom — 1,987 tasks of its own — got **zero**, so
      Home rendered "Nothing has run yet" directly beneath its own "1,740 jobs run". Every tenant we
      add makes every other tenant's Home emptier.

      `listTasks` has taken `project_ids` for a while and its own comment names this bug: "a busy
      neighbour fills the window and a small customer's own rows never appear in it —
      `countTasksSince` carries the same warning about the same bug, fixed there and not here." The
      parameter existed, the remedy was written down, and this route never used it.
    */
    const tasks = await store.listTasks({
      status,
      wedge,
      client_id: clientId,
      project_ids: [...set],
      limit: limit ?? 100,
    });
    return c.json(tasks);
  });

  // GET /v1/approvals — the approvals queue (?status=pending), scoped to the caller's projects.
  /**
   * ── The calendar ── what is next, and what fell out.
   *
   * A read rather than a store: every fact is already on the cases, and a second copy of "when is
   * this meeting" would be a second thing to keep in step with the stage. See calendar.ts for why
   * the ordering is the product.
   */
  app.get("/v1/calendar", async (c) => {
    /**
     * Per project, because `CaseFilter.project_id` is required and failing closed is the point — a
     * calendar that listed every case and filtered afterwards would be one forgotten `.filter()`
     * away from showing a founder somebody else's meetings.
     */
    const set = accessible(c);
    const cases: Case[] = [];
    for (const pid of set) cases.push(...(await domain.listCases({ project_id: pid })));
    const entries = buildCalendar(cases);
    return c.json({ entries, summary: calendarSummary(entries) });
  });

  /**
   * The signing secret this business pastes into their scheduler.
   *
   * Cloud's public webhook needs it to verify Cal.com / Calendly HMAC, and it cannot read
   * `/v1/gtm/audience` as a member. Same control-token gate as `/ops/calendar/book`.
   */
  app.get("/v1/ops/calendar/hook", async (c) => {
    const scope = c.get("scope");
    if (scope.kind !== "key") return c.json({ error: "not found" }, 404);
    const control = process.env.MYCEL_CONTROL_TOKEN ?? "";
    const presented = c.req.header("x-mycel-control") ?? "";
    if (!control || !safeEqual(presented, control)) return c.json({ error: "not found" }, 404);
    const projectId = (c.req.query("project_id") ?? "").trim();
    if (!projectId || !identity.getProject(projectId)) return c.json({ error: "not found" }, 404);
    const audience = await loadAudience(domain, projectId);
    return c.json({
      signing_secret: audience?.booking_hook_secret ?? null,
      provider: audience?.booking_provider ?? null,
    });
  });

  /**
   * A booking from Cal.com / Calendly, posted by the cloud webhook with the control token.
   *
   * The kernel is private. The public URL lives on cloud (`/api/calendar/webhook/:token`). This
   * route is the write: match a prospect by email, stamp `booked` and `meeting_at`. A miss is
   * `{ ignored }` and 200 — a retry storm over a stranger's booking is worse than one unmatched row.
   */
  app.post("/v1/ops/calendar/book", async (c) => {
    const scope = c.get("scope");
    if (scope.kind !== "key") return c.json({ error: "not found" }, 404);
    const control = process.env.MYCEL_CONTROL_TOKEN ?? "";
    const presented = c.req.header("x-mycel-control") ?? "";
    if (!control || !safeEqual(presented, control)) return c.json({ error: "not found" }, 404);

    const b = (await c.req.json().catch(() => ({}))) as {
      project_id?: string;
      emails?: string[];
      starts_at?: string;
      url?: string;
      title?: string;
      uid?: string;
      cancelled?: boolean;
    };
    const projectId = (b.project_id ?? "").trim();
    if (!projectId || !identity.getProject(projectId)) return c.json({ error: "not found" }, 404);

    const cases = await domain.listCases({ project_id: projectId });
    const kase = matchBookingCase(cases, b.emails ?? []);
    if (!kase) return c.json({ ok: true, action: "ignored" });

    if (b.cancelled) {
      const updated = await applyCaseUpdate(
        kase,
        { stage: "no_show", note: "cancelled in the booking tool" },
        "calendar-webhook",
      );
      if ("error" in updated) return c.json({ error: updated.error }, 400);
      return c.json({ ok: true, action: "cancelled", case_id: kase.id });
    }

    const updated = await applyCaseUpdate(
      kase,
      {
        stage: "booked",
        meeting_at: typeof b.starts_at === "string" ? b.starts_at : undefined,
        data: {
          meeting_url: typeof b.url === "string" ? b.url : undefined,
          booked_at: new Date().toISOString(),
          has_reply: true,
          ...(typeof b.uid === "string" ? { cal_uid: b.uid } : {}),
        },
        note: b.title ? `booked: ${b.title}` : "booked via calendar webhook",
      },
      "calendar-webhook",
    );
    if ("error" in updated) return c.json({ error: updated.error }, 400);
    return c.json({ ok: true, action: "booked", case_id: kase.id });
  });

  app.get("/v1/approvals", async (c) => {
    const status = c.req.query("status") as Approval["status"] | undefined;
    const set = accessible(c);
    const aps = await store.listApprovals(status || undefined);
    /**
     * ONE QUERY FOR THE TASKS, NOT ONE PER APPROVAL.
     *
     * This loop did `await store.getTask(...)` on every iteration — sequential round trips, on the
     * endpoint Home calls first, measured at 1.8s. The tasks are needed for tenancy and for the
     * terminal-status check below, so they cannot be skipped; they can be fetched together.
     */
    const owners = await store.getTasksByIds(aps.map((a) => a.task_id));
    const out: Approval[] = [];
    for (const a of aps) {
      const t = owners.get(a.task_id);
      if (!t || !inScope(set, t.project_id)) continue;
      /**
       * Tenancy was the only filter here, so a PENDING approval on a task that had already
       * cancelled, expired or failed kept rendering as a live decision. The founder's queue is meant
       * to be the list of things actually blocked on them; a card for a dead job costs a read and a
       * click and gives back nothing. Resolved approvals still list — that is history. This drops
       * only the ones still claiming to be waiting when nothing is.
       */
      if (a.status === "pending" && TERMINAL_STATUSES.includes(t.status)) continue;
      /**
       * A DUNNING APPROVAL CARRIES HOW SURE WE ARE THAT THE INVOICE IS STILL UNPAID.
       *
       * This is the last human checkpoint before an escalating demand for money reaches a real
       * client, and the person holding it was being shown the words and the recipient but nothing
       * about the evidence. "We notice invoice INV-0007 remains unpaid" reads identically whether we
       * confirmed that against Stripe ten minutes ago or have never once been able to check — and
       * only one of those is safe to press send on.
       *
       * Read off the task's own input (written by `chaseTaskInput` at the moment the chase started,
       * so it is the confidence the DECISION was made on, not a fresher one taken now) rather than
       * recomputed here: recomputing would show the approver a number that never gated anything.
       * Attached as a sibling field so no existing consumer of `preview` changes shape.
       */
      const input = t.input as Record<string, unknown> | undefined;
      const paymentState = t.task_type === CHASE_TASK_TYPE ? input?.payment_state : undefined;
      out.push(paymentState ? ({ ...a, payment_state: paymentState } as Approval) : a);
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
  /**
   * ═══ HAS THIS BUSINESS GONE QUIET, AND WHAT IS HOLDING IT ═══
   *
   * `time-to-value` in the console owns the founder who signed up and never reached a first accepted
   * deliverable. Once they reach it, nothing watched them again — and month three is where churn
   * actually happens, when the habit dies rather than when the setup fails.
   *
   * The arithmetic is `going-quiet`, which compares against the BUSINESS'S OWN rhythm rather than a
   * threshold: a bookkeeper running a monthly close is silent for twenty-eight days as a matter of
   * course, and a product that nags them on day fifteen has announced it does not understand what
   * they do. It refuses until there is a rhythm to compare against, which is exactly the window
   * `time-to-value` covers — so the two cannot both speak about the same founder.
   *
   * WHAT IS WAITING IS THE POINT. Most of the time somebody goes quiet because the product is
   * holding something and did not say so loudly enough, so the answer leads with the specific thing
   * rather than with the silence.
   */
  app.get("/v1/product/quiet", async (c) => {
    const projectId = writeProjectId(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    if (!accessible(c).has(projectId)) return c.json({ error: "not found" }, 404);

    // Scoped in the QUERY — see `/v1/tasks` for the production measurement of what happens when
    // a busy neighbour fills the window.
    const tasks = await store.listTasks({ project_ids: [projectId], limit: 500 });
    /**
     * THINGS THE FOUNDER DID, not things the machine did.
     *
     * A scheduled job firing on its own is not evidence anybody is still here — a business can look
     * busy for a month after its owner stopped opening the console. So: runs a person started, and
     * approvals a person decided. `source` distinguishes them and it is the only field that can.
     */
    const events = tasks
      .filter((t) => t.status === "succeeded" && t.source !== "schedule")
      .map((t) => ({ at: t.created_at }));
    /**
     * Approvals are not project-scoped in the store — they hang off a task, and the task carries the
     * tenant. Same join `GET /v1/approvals` does, and it is done the same way here rather than a
     * shorter way, because "the caller will remember to filter" is the assumption behind both
     * cross-tenant leaks this repo has shipped.
     */
    const ours = new Set(tasks.map((t) => t.id));
    const allApprovals = await store.listApprovals().catch(() => []);
    const mine = allApprovals.filter((a) => ours.has(a.task_id));
    for (const a of mine) {
      if ((a.status === "approved" || a.status === "rejected") && a.decided_at) events.push({ at: a.decided_at });
    }

    const pendingApprovals = mine
      .filter((a) => a.status === "pending")
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    const inReview = (await getDeliverableStore().listDeliverables({ project_id: projectId }).catch(() => []))
      .filter((d) => d.status === "in_review")
      .sort((a, b) => String(a.updated_at).localeCompare(String(b.updated_at)));

    const waiting: { what: string; since: string; count: number }[] = [];
    if (inReview.length) {
      waiting.push({
        what: inReview.length === 1 ? "piece of work waiting for you to send it" : "pieces of work waiting for you to send them",
        since: String(inReview[0]!.updated_at).slice(0, 10),
        count: inReview.length,
      });
    }
    if (pendingApprovals.length) {
      waiting.push({
        what: pendingApprovals.length === 1 ? "thing waiting for your approval" : "things waiting for your approval",
        since: String(pendingApprovals[0]!.created_at).slice(0, 10),
        count: pendingApprovals.length,
      });
    }

    /**
     * Imported, not dispatched through a wedge.
     *
     * The first version called `runWorkflow(<a wedge slug>, "going_quiet", …)` and a contract test
     * refused it: no kernel source file may name a wedge directory, because the moment one does the
     * roles index stops being the single place that mapping lives. That test was right, and it also
     * pointed at the real mistake — this is not a wedge job. No agent asks whether a business has
     * gone quiet; the console does, about its own tenant. Routing product machinery through a wedge
     * to reach a pure function would have declared a capability on `harness-operator` that nothing
     * would ever call, which is the defect this repo keeps finding in its own work.
     */
    return c.json(goingQuiet({ events, waiting, now: new Date().toISOString().slice(0, 10) }));
  });

  /**
   * ═══ WHICH CLIENTS ARE ACTUALLY MAKING THIS BUSINESS MONEY ═══
   *
   * Every agency has one they subsidise and cannot prove it. The evidence is normally split across
   * systems that do not talk — the invoicing tool knows what was billed, the project tool knows what
   * was done, neither knows what it COST, and nobody counts the founder's own interruptions. This is
   * the only place all four meet, which is why this endpoint can exist here and almost nowhere else.
   *
   * Scoped like every other read on this plane: per project, from `accessible`, never filtered after
   * the fact. A margin screen that leaked a row would leak somebody's revenue.
   */
  app.get("/v1/analytics/clients", async (c) => {
    const set = accessible(c);
    const projectId = writeProjectId(c);
    if (!projectId || !inScope(set, projectId)) return c.json({ clients: [], findings: [] });

    const kit = getIdentityStore().brandKit(projectId);
    const [clients, tasks, invoices, approvals] = await Promise.all([
      domain.listClients().then((xs) => xs.filter((x) => x.project_id === projectId)),
      // Bounded. This is an admin read over the biggest table in the product, and an unbounded scan
      // on a page somebody opens to find out why things are slow is a page that makes them slower.
      // Scoped in the QUERY — see `/v1/tasks`.
      store.listTasks({ project_ids: [projectId], limit: 2000 }),
      getBillingStore().listInvoices({ project_id: projectId }).catch(() => [] as Invoice[]),
      store.listApprovals().catch(() => []),
    ]);
    const mineTasks = tasks.filter((t: Task) => t.project_id === projectId);

    const rows = clients.map((cl: Client) =>
      clientEconomics({
        client_id: cl.id,
        tasks: mineTasks,
        invoices,
        approvals,
        currency: kit?.currency ?? "USD",
        // Rework, counted from what the client actually said rather than from a status field.
        revisions: 0,
      }),
    );
    const names = new Map<string, string>(clients.map((cl: Client) => [cl.id, cl.display_name || cl.handles?.[0] || cl.id]));
    return c.json({ clients: rows, findings: bookFindings(rows, names) });
  });

  /**
   * WHAT THE MACHINE IS BEING TOLD ABOUT THEIR OWN NEGOTIATION.
   *
   * The same numbers `draft_engagement` reads before it prices anything. This route exists because a
   * founder is entitled to read them and disagree: a system that quietly learned "you always cave on
   * term" from four deals and started pricing accordingly, with no screen that says so, would be
   * making the most consequential decision in the business behind their back.
   *
   * Scoped like every other margin read — a leaked row here is somebody's negotiating position.
   */
  /**
   * WHICH ANSWER ENGINES WE CAN CURRENTLY REACH.
   *
   * A monitoring retainer whose measurement is quietly blocked is the worst version of this product:
   * the reports keep arriving, they cover fewer surfaces every week, and the founder finds out when
   * their client asks about ChatGPT in a meeting.
   *
   * Only PERSISTENT blocks reach this. Surfaces refuse the odd probe for all sorts of reasons, and a
   * warning that is usually noise is a warning nobody reads on the day it matters.
   */
  /**
   * CAN THIS BUSINESS ACTUALLY RUN, END TO END?
   *
   * The question a founder has right after describing their business and watching the system
   * instantiate something. Not "here are six task types" — **it can find work, do it and invoice for
   * it, and it cannot yet chase a renewal.** One of those they can act on.
   *
   * Derived from the manifests actually installed, never from a label a generator wrote about
   * itself. See loop-coverage.ts: a generated service claiming it collects and raising no invoice
   * would report a closed loop and have an open one, and a generated service is precisely what this
   * is for.
   */
  app.get("/v1/business/loop", async (c) => {
    const set = accessible(c);
    const projectId = writeProjectId(c);
    if (!projectId || !inScope(set, projectId)) return c.json({ stages: [], closed: false, says: [] });
    /**
     * WHAT THIS PROJECT ACTUALLY RUNS, from its cases.
     *
     * Not the identity allowlist, which says what a project MAY run and is empty for most (meaning
     * "anything") — a business would report a closed loop on the strength of wedges it has never
     * provisioned. A case is what `provision` creates, so a wedge with a case is a wedge that is
     * actually there.
     *
     * `loadProjectWedge` rather than `loadWedge`, because the interesting case is the one the
     * meta-agent wrote: an authored service lives in the store, not on disk, and reporting that a
     * founder's own generated trade delivers nothing would be exactly backwards.
     */
    const cases = await domain.listCases({ project_id: projectId }).catch(() => []);
    const slugs = [...new Set(cases.map((k) => k.wedge).filter(Boolean))];
    const manifests = (
      await Promise.all(slugs.map((w) => loadProjectWedge(projectId, w).catch(() => null)))
    )
      .filter((w): w is NonNullable<typeof w> => !!w)
      .map((w) => w.manifest);
    const report = loopCoverage(manifests);
    return c.json({ ...report, says: explainLoop(report) });
  });

  /**
   * ═══ IS EVERY JOB IN THIS BUSINESS EQUIPPED TO PRODUCE EXPERT WORK? ═══
   *
   * `compile()` answers exactly this and only ever got asked mid-run, one task at a time, arriving
   * as a thrown refusal after a founder pressed go. Its own header says the question is answerable
   * "from data, before a sandbox boots and before a token is spent". This is that question, asked
   * for every job the business actually runs.
   *
   * The four things it checks are the four an expert has and an improvising model does not: a
   * definition of done, written craft, a human ceiling in that craft, and a bar for what ships. A
   * job missing one does not produce mediocre work — it produces work that LOOKS finished and is
   * not, which compile.ts calls the single most expensive output this system can make.
   *
   * Same project scoping as `/business/loop` next door, and for the same reason: what a project
   * RUNS is its cases, not the identity allowlist, which is empty for most and would report on
   * wedges nobody provisioned. `loadProjectWedge`, so an authored service is graded like any other.
   *
   * `missing_access` is excluded by `jobReadiness`, matching the run path — a client mid-onboarding
   * is not an unequipped business.
   */
  /**
   * IS THE MACHINE LEARNING THIS BUSINESS? — the number the whole product rests on.
   *
   * `DeliverableVersion.author` calls the gap between an agent draft and the founder version that
   * replaced it "the most valuable signal this product generates". It has been accumulating since
   * founders could edit, and until now nothing read it. This does.
   *
   * The claim being tested is that month three needs less editing than month one. If that is false
   * we would rather learn it from our own rows than from a customer who left, so the verdict is
   * allowed to come back negative, and `learningVerdict` refuses to guess a direction on thin
   * evidence rather than flattering the screen.
   *
   * Compared on `summary` — the words both versions carry on the row itself. The artifact body is
   * the better text and needs a fetch per version; this is the honest cheap version, and the shape
   * does not change when that arrives because `correctionPairs` takes the extractor as an argument.
   */
  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════════════
   * WHAT THE AGENT HAS WRITTEN DOWN, AND THE FOUNDER'S ABILITY TO ARGUE WITH IT
   * ═══════════════════════════════════════════════════════════════════════════════════════════════
   *
   * `memory.ts` chose Markdown over embeddings and its FIRST stated reason is this route:
   *
   *   "A human can read it. When an agent gets a client wrong, somebody opens the file and sees
   *    why. An embedding cannot be inspected, corrected, or argued with."
   *
   * Without a reader that argument is unearned — a vault only the agent can see could have been a
   * vector index for less work, and `MemoryDoc.updated_by` was a field documented as being "for a
   * person reading the history" when no person could. Three verbs close it: read what it thinks,
   * correct what is wrong, forget what should never have been written.
   *
   * ── FOUNDER PLANE, AND THE AUTHORSHIP IS THE ROUTE'S TO DECIDE ──
   *
   * `PUT` stamps `updated_by` from the SESSION, never from the body — the same rule
   * `deliverables.routes.ts` states for version authorship: "who submitted a version is a property
   * of the ROUTE, and a caller that could name itself could name the other side." That is what makes
   * the field finally mean something: a note reading `agent` was concluded, one reading a member id
   * was corrected by a person, and the difference is visible in the UI rather than assumed.
   *
   * A founder's correction is NOT promoted to a rule. `knowledge.ts` requires a human witness on a
   * correction made against REAL WORK; editing a note is not that, and quietly turning one into
   * something that binds behaviour would be the exact provenance-shaped decoration that file refuses.
   */
  app.get("/v1/memory", async (c) => {
    const set = accessible(c);
    const projectId = writeProjectId(c);
    if (!projectId || !inScope(set, projectId)) return c.json({ notes: [] });
    const drawer = c.req.query("drawer");
    const notes = await getMemoryStore()
      .list(projectId, MEMORY_DRAWERS.includes(drawer as never) ? (drawer as never) : undefined)
      .catch(() => []);
    return c.json({ notes });
  });

  app.put("/v1/memory", async (c) => {
    const set = accessible(c);
    const projectId = writeProjectId(c);
    if (!projectId || !inScope(set, projectId)) return c.json({ error: "no project" }, 400);
    const scope = c.get("scope");
    if (!scope?.member_id) return c.json({ error: "member session required" }, 403);
    const b = (await c.req.json().catch(() => ({}))) as { path?: unknown; body?: unknown };
    const wrote = await rememberFromRun({
      project_id: projectId,
      path: String(b.path ?? ""),
      body: String(b.body ?? ""),
      // From the session. See the note above: a caller that could name itself could name the agent.
      by: scope.member_id,
    });
    if (!wrote.ok) return c.json({ error: wrote.reason }, 400);
    return c.json({ note: wrote.doc });
  });

  app.delete("/v1/memory", async (c) => {
    const set = accessible(c);
    const projectId = writeProjectId(c);
    if (!projectId || !inScope(set, projectId)) return c.json({ error: "no project" }, 400);
    if (!c.get("scope")?.member_id) return c.json({ error: "member session required" }, 403);
    const path = String(c.req.query("path") ?? "");
    if (!path) return c.json({ error: "name the note to forget" }, 400);
    // Removed and already-gone are the same outcome to a founder pressing the button twice.
    const gone = await getMemoryStore().forget(projectId, path).catch(() => false);
    return c.json({ ok: true, removed: gone });
  });

  app.get("/v1/business/learning", async (c) => {
    const set = accessible(c);
    const projectId = writeProjectId(c);
    if (!projectId || !inScope(set, projectId)) {
      return c.json({ curve: [], verdict: { corrections: 0, note: "" } });
    }

    const store = getDeliverableStore();
    const list = await store.listDeliverables({ project_id: projectId, limit: 500 }).catch(() => []);
    const versions = (
      await Promise.all(list.map((d) => store.listVersions(projectId, d.id).catch(() => [])))
    ).flat();

    const text = (v: { summary?: string }) => v.summary ?? "";
    /**
     * BOTH HUMANS WHO CORRECT THE WORK, NOT JUST THE ONE WE EMPLOY.
     *
     * `correctionPairs` reads founder edits. `clientSendBacks` reads the versions a CLIENT asked to
     * be changed — which used to be counted as untouched drafts, so a rejected deliverable pulled
     * the curve in the direction that reads as "improving". See the note on `untouchedDrafts`.
     *
     * The client's correction is arguably the better signal: it is a labelled complaint, on real
     * work, by the person paying for it.
     */
    const pairs = [...correctionPairs(versions, text), ...clientSendBacks(versions, text)];
    // The untouched drafts are the half that carries the good news: as this works, the founder
    // edits FEWER drafts rather than editing them less, so a curve built only from corrections
    // would show a flat line on the best month they ever had.
    const curve = learningCurve(pairs, untouchedDrafts(versions));

    /**
     * HOW MANY HAVE ACTUALLY REACHED A CLIENT.
     *
     * `released_at` and not a status, for the same reason the portal reads it: a status can be set
     * by a founder who believes they sent something, and only the stamp means a human on the other
     * side has it. This is the count the first-win and milestone lines on Home are drawn from, and
     * a milestone announced over work nobody received would be the worst thing this product could
     * congratulate somebody for.
     */
    const released = versions.filter((v) => v.released_at).length;

    return c.json({ curve, verdict: learningVerdict(curve), released });
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════════════
   * HOW A MODEL TRIAL IS GOING — THE READOUT WITHOUT WHICH THE TRIAL IS JUST A COST
   * ═══════════════════════════════════════════════════════════════════════════════════════════════
   *
   * `models.ts` twice defers the choice of model to "a trial, not a switch", and `challengerFor`
   * now makes one runnable. A trial that runs on real client work and cannot be read is strictly
   * worse than no trial: it spends the deliverables and returns nothing, and whoever started it
   * eventually forgets it is on.
   *
   * Judged by `judgeTrial`, unchanged and on purpose — the same floor, the same ten-point margin,
   * the same refusal to conclude early that governs a skill trial. The question "is the cheaper
   * model as good" deserves no softer test than "is this playbook better", and the metric is the
   * one this whole product is organised around: the share that went out without an edit.
   *
   * Reports even when nothing is configured, rather than 404ing. "No trial is running" is the
   * answer to the question a founder is asking, and it is the answer that stops a forgotten
   * experiment from being invisible.
   */
  app.get("/v1/business/model-trial", async (c) => {
    const set = accessible(c);
    const projectId = writeProjectId(c);
    const model = process.env.MYCEL_MODEL_TRIAL?.trim() || null;
    const tier = process.env.MYCEL_MODEL_TRIAL_TIER?.trim() || "standard";
    if (!projectId || !inScope(set, projectId)) return c.json({ running: false, model: null, tier });
    const { incumbent, challenger } = await trialArms(domain, { project_id: projectId }).catch(() => ({
      incumbent: { decisions: 0, released: 0, paid: 0 },
      challenger: { decisions: 0, released: 0, paid: 0 },
    }));
    return c.json({
      running: Boolean(model),
      model,
      tier,
      incumbent_model: modelForTier(isTier(tier) ? tier : "standard"),
      incumbent,
      challenger,
      verdict: judgeTrial(incumbent, challenger),
    });
  });

  app.get("/v1/business/equipped", async (c) => {
    const set = accessible(c);
    const projectId = writeProjectId(c);
    if (!projectId || !inScope(set, projectId)) return c.json({ jobs: [], ready: true });

    const cfg = loadConfig();
    const ceilings = { maxRuntimeS: cfg.maxRuntimeCeilingS, maxCostUsd: cfg.maxCostCeilingUsd };
    // The plan only moves the tier CEILING, which none of the four author-controlled refusals reads.
    // Passed anyway so the resolved profile is the one a real run would get.
    const identity = getIdentityStore();
    const plan = identity.getOrg(identity.getProject(projectId)?.org_id ?? "")?.plan;

    const cases = await domain.listCases({ project_id: projectId }).catch(() => []);
    const slugs = [...new Set(cases.map((k) => k.wedge).filter(Boolean))];
    const loaded = (await Promise.all(slugs.map((w) => loadProjectWedge(projectId, w).catch(() => null)))).filter(
      (w): w is NonNullable<typeof w> => !!w,
    );

    const jobs: {
      wedge: string;
      task_type: string;
      title: string;
      ok: boolean;
      refusals: { code: string; message: string }[];
    }[] = [];

    for (const wedge of loaded) {
      // Async and it reads the store — resolved once per wedge rather than per task type.
      const library = await librarySkillsForWedge(domain, wedge.manifest).catch(() => []);
      for (const [taskType, tt] of Object.entries(wedge.manifest.task_types ?? {})) {
        // Internal steps are machinery — no client ever opens their output, and holding them to a
        // client-facing bar is how a readiness screen fills with rows nobody can act on.
        if ((tt as { internal?: boolean })?.internal) continue;
        const r = jobReadiness({ wedge, taskType, projectId, ...(plan ? { plan } : {}), ceilings, library });
        jobs.push({
          wedge: wedge.manifest.wedge,
          task_type: taskType,
          title: String((tt as { description?: string })?.description ?? taskType).slice(0, 140),
          ok: r.ok,
          refusals: r.refusals.map((x: { code: string; message: string }) => ({ code: x.code, message: x.message })),
        });
      }
    }

    return c.json({ jobs, ready: jobs.every((j) => j.ok) });
  });

  app.get("/v1/geo/surfaces", async (c) => {
    const set = accessible(c);
    const projectId = writeProjectId(c);
    if (!projectId || !inScope(set, projectId)) return c.json({ warnings: [] });
    const rows = await domain
      .queryRecords({ project_id: projectId, wedge: "kernel", collection: SURFACE_HEALTH_COLLECTION })
      .catch(() => [] as unknown[]);
    const health = (rows as { data?: unknown }[]).map((r) => r.data).filter(Boolean) as Parameters<typeof surfaceWarnings>[0];
    return c.json({ warnings: surfaceWarnings(health) });
  });

  app.get("/v1/analytics/deals", async (c) => {
    const set = accessible(c);
    const projectId = writeProjectId(c);
    if (!projectId || !inScope(set, projectId)) return c.json({ closed: 0, lessons: [] });
    return c.json(dealLessons(await listEnvelopes(projectId).catch(() => [])));
  });

  app.get("/v1/analytics", async (c) => {
    const set = accessible(c);
    const days = Math.min(Math.max(Number(c.req.query("days") ?? 30), 1), 365);
    const since = Date.now() - days * 86400_000;

    /**
     * ═══ THE SLOWEST CALL IN THE PRODUCT, AND A TENANCY BUG WEARING A PERFORMANCE COSTUME ═══
     *
     * This was `listTasks({ limit: 5000 })` followed by a JavaScript filter. Measured from the
     * cloud's own slow-call log over three hours: 17 calls, 89.7 SECONDS total, 9.5s at the worst.
     * Eight times the next endpoint, and it is on Home — so it WAS Home's load time.
     *
     * The correctness half is worse than the speed. `limit: 5000` takes the five thousand most
     * recent tasks ACROSS EVERY TENANT and only then keeps the ones this caller may see. A busy
     * neighbour fills that window, so a small customer opens their analytics and reads zero — their
     * rows exist and were never fetched. `countTasksSince` in `store.ts` carries a warning about
     * this exact bug, in these words, because it was found and fixed there. It was still here.
     *
     * Both halves are one fix: scope and window in the QUERY. `project_id = ANY($n)` with an empty
     * array matches nothing, which is the right answer for a caller who can see no projects.
     */
    const tasks = await store.listTaskFacts({
      project_ids: [...set],
      since: new Date(since).toISOString(),
      limit: 5000,
    });
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
    /**
     * ═══ WINDOW FIRST, THEN RESOLVE — NOT THE OTHER WAY ROUND ═══
     *
     * This resolved `getTask` for EVERY approval ever recorded, across every tenant, and only then
     * dropped the ones outside the window. One round trip per approval, almost all of them for rows
     * about to be thrown away — an N+1 whose N was the whole table.
     *
     * The window is cheap and it is already the filter, so it goes first. Then scope is answered
     * from `tasks`, which is the same window, already fetched and already scoped: an approval whose
     * task is in that map is in scope by construction and costs nothing to check. The fallback query
     * covers the one real case the map cannot — an approval raised inside the window on a task
     * created before it — so the semantics are unchanged.
     */
    const inWindow = (await store.listApprovals()).filter((a) => Date.parse(a.created_at) >= since);
    const known = new Map(tasks.map((t) => [t.id, t] as const));
    // The remainder, in one query rather than one apiece — approvals raised inside the window
    // against a task created before it.
    const strays = await store.getTasksByIds(
      inWindow.filter((a) => !known.has(a.task_id)).map((a) => a.task_id),
    );
    const approvals: typeof inWindow = [];
    for (const a of inWindow) {
      const t = known.get(a.task_id) ?? strays.get(a.task_id);
      if (t && inScope(set, t.project_id)) approvals.push(a);
    }
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
    /**
     * The comment above said "computed from the rows already in hand rather than a second query".
     * It was a second query, and an unscoped one — the same five-thousand-across-every-tenant scan
     * as the block at the top of this handler, with the same tenancy hole. Now it really is scoped
     * and windowed in the database; only the upper bound is applied here, because the store's
     * `since` is a floor.
     */
    const prior = (
      await store.listTaskFacts({
        project_ids: [...set],
        since: new Date(prevSince).toISOString(),
        limit: 5000,
      })
    ).filter((t) => Date.parse(t.created_at) < since);
    const priorTerminal = prior.filter((t) => TERMINAL.has(t.status));
    const priorSucceeded = prior.filter((t) => t.status === "succeeded");

    // Outcome ledger: did chases, asks, and touches actually land? Same rows autonomy already
    // learns from — surfaced so Analytics is not only "jobs finished" but "business moved".
    const outcomeTallies = new Map<string, { taken: number; worked: number; ignored: number; rejected: number }>();
    for (const pid of set) {
      try {
        const auth = await moveAuthorityForProject(domain, pid);
        const stats = await outcomeStats(domain, auth);
        for (const [kind, s] of stats) {
          const row = outcomeTallies.get(kind) ?? { taken: 0, worked: 0, ignored: 0, rejected: 0 };
          row.taken += s.taken;
          row.worked += s.worked;
          row.ignored += s.ignored;
          row.rejected += s.rejected;
          outcomeTallies.set(kind, row);
        }
      } catch {
        /* a single project's ledger must not blank the whole analytics page */
      }
    }
    const outcomes = [...outcomeTallies.entries()]
      .map(([kind, v]) => ({
        kind,
        ...v,
        hit_rate: v.taken ? Math.round((v.worked / v.taken) * 100) : null,
      }))
      .sort((a, b) => b.taken - a.taken);

    /**
     * ═══ THE PROMISE, MEASURED ═══
     *
     * This product tells a founder they will need it less over time, because it learns their
     * judgement. Nothing anywhere measured that. Asked of production for the first time, the answer
     * was ten straight weeks of 234 approvals and NOT ONE cleared without a person.
     *
     * A whole window rather than the `days` one: involvement is a trend and a trend needs weeks.
     * Read on its own query so a founder narrowing the task window to a day does not also throw
     * away the only series on the page that is supposed to move slowly.
     */
    const involvement = await store
      .involvementByWeek([...set], new Date(Date.now() - 120 * 86400_000).toISOString())
      .catch(() => [] as Awaited<ReturnType<typeof store.involvementByWeek>>);

    return c.json({
      window_days: days,
      involvement,
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
        /**
         * ═══ THE SAME COUNTS, BUT ONLY FOR BEHAVIOUR THAT IS STILL HAPPENING ═══
         *
         * A window is not enough on its own, and the 30-day one is currently proving it. Counted
         * on 13 September: 219 approvals, 208 expired — and 197 of them belong to a Composio
         * integration that was REMOVED ON 25 AUGUST. The founder, told the product was asking too
         * much: "this is obsolete stuff. You should just ignore it."
         *
         * They are right, and the lesson is not about Composio. Anything the product stops doing
         * keeps arguing for a month afterwards, because a fixed window cannot tell "we do this too
         * often" from "we used to". A claim the PRODUCT makes about its own behaviour has to be
         * about behaviour it still has, or it is a confident wrong answer with a big number
         * attached — and a number that survives its own cause is how every other number on the page
         * loses its credibility.
         *
         * Strip the dead integration and the same window reads 22 raised, 12 expired. Still worth
         * saying. An order of magnitude smaller, and a different sentence.
         *
         * FREE: the rows are already in memory, scoped and windowed. No second query, no second
         * round trip on the screen a founder opens every morning.
         */
        recent: (() => {
          const cut = Date.now() - APPROVAL_RECENT_DAYS * 86_400_000;
          const r = approvals.filter((a) => Date.parse(a.created_at) >= cut);
          return {
            days: APPROVAL_RECENT_DAYS,
            total: r.length,
            auto_approved: r.filter((a) => a.status === "auto_approved").length,
            pending: r.filter((a) => a.status === "pending").length,
            expired: r.filter((a) => a.status === "expired").length,
          };
        })(),
      },
      clients: { total: clients.length },
      outcomes,
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
    /**
     * WHICH OF THOSE CAN START COLD — a fact about each wedge, read from each wedge.
     *
     * This exists so the console can stop naming a vertical. `cloud/lib/first-hour-live.ts` had
     * `deliveryWedges.includes("geo-monitor") ? "geo-monitor" : deliveryWedges[0]` in the go-live
     * path: one trade privileged in the core, in the code that decides what a founder sees in their
     * first hour. See `WedgeManifest.cold_start` for the whole argument.
     *
     * Failures are per-wedge and silent by design. A manifest that will not parse is already
     * reported everywhere it matters — `loadWedge` is how a wedge runs at all — and a `/v1/meta`
     * that 500s because one wedge directory is malformed would take the entire console down with it.
     * The cost of the quiet path is that the founder is offered a generic first job instead of a
     * cold-start one, which is the same thing that happens when no wedge declares the flag.
     */
    const coldStart = wedges.filter((slug) => {
      try {
        return loadWedge(slug)?.manifest.cold_start === true;
      } catch {
        return false;
      }
    });
    /**
     * WHICH OF THOSE ARE THE PLATFORM'S OWN MACHINERY — read from each wedge, like `cold_start`.
     *
     * `WedgeManifest.internal` already says this, and it already says why it cannot be inferred:
     * "nothing separates machinery from work except intent, and intent has to be stated." What was
     * missing is that nothing REPORTED it, so every surface that needed the answer guessed.
     *
     * The guess in the console was `wedges.filter((w) => w !== GTM_WEDGE)` — one hardcoded slug —
     * and it feeds the picker on a client's page. So a founder opening their first job for a
     * customer was offered "Business shaper" and "Product builder": one is the onboarding
     * interviewer, the other builds the founder's own website. Neither is work anybody sells, and
     * picking one would have opened a client engagement carried by a wedge with no client in it.
     *
     * Same failure mode as the `geo-monitor` hardcode this file already argues against two comments
     * up, and the same fix: the fact lives on the wedge, and the kernel reports it.
     */
    const internal = wedges.filter((slug) => {
      try {
        return loadWedge(slug)?.manifest.internal === true;
      } catch {
        // Per-wedge and silent, exactly like `coldStart` above. A malformed manifest must not 500
        // `/v1/meta` and take the whole console with it; the cost is one wedge misreported as
        // sellable, which is what the console did for all of them until now.
        return false;
      }
    });

    return c.json({
      version: "v0.1",
      wedges,
      cold_start_wedges: coldStart,
      internal_wedges: internal,
      // No `langfuse_url` / `tracing` state any more. Tracing was an optional external sink that
      // could be configured-but-broken, so a UI had to ask whether it was working before linking to
      // it. It isn't optional now: every run's trace is folded from the event log the kernel always
      // writes, at `GET /v1/tasks/:id/trace`, so a client can just ask for it.
      /**
       * WHETHER SIGN-UP IS GATED. Reported so a console can hide the screen that ADMINISTERS the
       * gate — allowlisted emails, one-time links, the queue of people who asked to get in — when
       * there is no gate to administer. All three are meaningless on an open deployment, and a
       * settings row that is dead in every deployment we operate is one more thing to read past.
       */
      signup_invite_only: signupInviteOnly(),
      store: databaseUrl() ? "postgres" : "memory",
      sandbox: cfg.sandboxBackend,
      /**
       * WHETHER THIS KERNEL CAN BUILD AND PUBLISH A FOUNDER'S APP.
       *
       * Reported so a console can be ABSENT rather than broken. Onboarding offers to build the
       * founder's site; on a developer machine, a self-hosted install, or any deployment where the
       * build plane was never configured, that offer is a button that cannot work. The rule the
       * composer's microphone set is that a capability which does not exist is not rendered — and a
       * client cannot apply that rule without being told, because `MYCEL_DEPLOY_BUCKET` is a
       * server-side environment variable it has no way to see.
       *
       * TWO BITS, NOT ONE, because they fail differently and only one of them is fatal to the offer:
       * `verify` is the CodeBuild project a run compiles against (`remotebuild.ts`), and without it a
       * build run still runs and still hands back a working app — it is just not proven to compile.
       * `deploy` is what puts the result on a URL (`deploy.ts`); without it there is no site, and
       * "we will build you a site" is a promise this kernel cannot keep.
       *
       * Booleans and nothing else. A bucket name is infrastructure, and there is no reason for it to
       * cross into a browser.
       */
      build: { verify: !!remoteBuildConfig(), deploy: !!deployConfig() },
    });
  });

  // GET /v1/tasks/:id
  app.get("/v1/tasks/:id", async (c) => {
    const t = await store.getTask(c.req.param("id"));
    if (!t || !inScope(accessible(c), t.project_id)) return c.json({ error: "not found" }, 404);
    /**
     * ═══ WHAT THIS RUN ENDED AS, ALWAYS, INCLUDING WHEN IT ENDED AS NOTHING ═══
     *
     * openwork's admission rule: every accepted request must end in a NAMED terminal state, and
     * plain idle with no result must never silently clear the task. Our plain idle is a run that
     * reaches `succeeded` and leaves nothing anybody can point at — 2,065 of 6,559 over fourteen
     * days — and `RunOutcome` on the work page returns null for `succeeded`, so those render as
     * nothing at all. A run that did everything right and a run that did nothing look identical.
     *
     * Counted here rather than in the browser because the browser has the task and not the rest,
     * and a page that fetched four more collections to answer "did anything happen" would be paying
     * four round trips for one sentence.
     *
     * Fail-soft on each count: a store that cannot answer contributes zero, which can only ever move
     * the ending DOWN the order — toward `nothing_visible`, the honest answer when we cannot see
     * that anything happened. It can never invent a stronger ending than the run earned.
     */
    const traces = await runTracesFor(store, t);
    const ending = runEnding(traces);
    /**
     * `quiet` is derived here rather than by each surface re-deriving `ending === "nothing_visible"`.
     * Two places that decide what counts as silence is two places for them to disagree, and the one
     * that drifts is the one that stops showing it.
     */
    return c.json({ ...t, ending, ending_said: ENDING_SAID[ending], quiet: endedQuietly(ending) });
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
   * POST /v1/tasks/:id/steer — say something to a LIVE run's agent while it works.
   *
   * The message enters the same opencode session as the original prompt, so the agent's response
   * streams back over the very same event channel the founder is already watching — no read-side
   * plumbing. Works only while the run is executing on THIS replica (see runregistry): a missing
   * handle is "the run is over or is elsewhere", answered 409, distinct from "no such task" (404).
   * Pure text into an already-authenticated session — no credential crosses into the sandbox.
   */
  app.post("/v1/tasks/:id/steer", async (c) => {
    const t = await store.getTask(c.req.param("id") ?? "");
    if (!t || !inScope(accessible(c), t.project_id)) return c.json({ error: "not found" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { text?: unknown };
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) return c.json({ error: "text is required" }, 400);
    if (text.length > 8000) return c.json({ error: "that message is too long" }, 400);

    const run = getRun(t.id);
    if (!run || run.projectId !== t.project_id) return c.json({ error: "run is not live" }, 409);
    /**
     * RECORDED BEFORE IT IS DELIVERED, so a message that fails to reach the session still shows on
     * the feed as something the founder said. The opposite order would drop the evidence in exactly
     * the case somebody needs it.
     */
    await emitEvent(store, t.id, "steer.sent", { text });

    /**
     * THROUGH THE QUEUE, NOT STRAIGHT AT THE DAEMON.
     *
     * This called `oc.startPrompt` directly — the `/prompt_async` route that a comparable runtime's
     * `session-lifecycle/inbox-admission.ts` says "interleaves inputs posted during a live turn".
     * Two messages typed quickly both posted concurrently and arrived in whichever order the network
     * settled, so a founder correcting themselves could have the correction land first.
     *
     * It also answered a busy daemon by giving up. a comparable runtime's `deliverWithRetry` exists because "a
     * just-woken sandbox is flaky for a beat" and their old path "bounced on the FIRST such hiccup
     * ... and dropped their message even though the session was up". Ours did the same thing with a
     * 409 and no retry. See `steer-queue.ts`.
     */
    const sent = await run.steer.send(text);
    if (!sent.delivered) return c.json({ error: sent.why }, 409);
    return c.json({ ok: true });
  });

  /**
   * POST /v1/tasks/:id/preview — boot the live preview dev server ON DEMAND.
   *
   * Called by the cloud when a founder opens the Preview tab, so an unwatched build never pays for a
   * dev server nobody sees. Idempotent (the run starts it at most once). The `preview.ready` event
   * with the URL follows on the run's event stream once dev binds. 409 once the run is over; 200 with
   * `{ started: false }` for a non-build run that has no preview to start.
   */
  app.post("/v1/tasks/:id/preview", async (c) => {
    const t = await store.getTask(c.req.param("id") ?? "");
    if (!t || !inScope(accessible(c), t.project_id)) return c.json({ error: "not found" }, 404);
    /**
     * The run is almost never in THIS process — it executes on a worker and this route is served by
     * the API service. So a missing handle means "not here", and the shared target is what says
     * whether a preview exists at all. See preview-target.ts.
     *
     * There is nothing to start from here in that case, and nothing needs starting: the run boots
     * its own preview when it begins (see runtime.ts, "THE PREVIEW STARTS NOW"). This route's real
     * job is to mint the grant the iframe presents.
     */
    const run = getRun(t.id);
    const local = run && run.projectId === t.project_id ? run : undefined;
    const shared = local ? undefined : await readPreviewTarget(t.id);
    /**
     * ═══ "NOT YET" IS NOT "OVER", AND THE PANE CANNOT TELL THEM APART ═══
     *
     * This answered 409 whenever there was no run handle and no shared row, and `LivePreview` turns
     * a 409 into a terminal "The build is finished". Both are absent for the most ordinary sequence
     * there is: the founder starts a build and opens the page while the task is still `queued` or
     * `provisioning`. Nothing has claimed it, so nothing has published a target — and they are told
     * their build has finished, on a build that has not begun. It never retries, so that is the last
     * thing that pane ever says.
     *
     * The run's own auto-start (runtime.ts) fixed the OTHER half of this — the preview no longer
     * races the founder opening the tab — but a task that has not been claimed yet has no run to
     * auto-start anything, and this route was still calling that state "over".
     *
     * So the task's status decides. Not terminal means the preview is still coming and the pane
     * should show the boot ladder; terminal means the sandbox is genuinely gone and 409 is honest.
     * The grant is minted either way, because it is TTL-bound and task-scoped and the proxy resolves
     * the target at request time — an address that is not answering yet costs nothing.
     */
    const over = TERMINAL_STATUSES.includes(t.status);
    if (!local && !shared && over) return c.json({ error: "run is not live" }, 409);
    if (local && !local.startPreview) return c.json({ ok: true, started: false });
    if (local?.startPreview) await local.startPreview();
    /**
     * Mint the browser's way in. An `<iframe src>` can carry no Authorization header, so the
     * founder's credential cannot travel with the frame — instead this route (which HAS the
     * credential) mints a task-scoped, TTL-bound grant and the iframe presents it in the path:
     * `GET /v1/preview/<grant>/...`. The grant resolves to exactly one task, the proxy resolves
     * that task to exactly one sandbox, and both die with the run.
     */
    const nonce = randomBytes(24).toString("base64url");
    await getGrantStore().then((g) =>
      g.put("preview", nonce, { task_id: t.id, project_id: t.project_id ?? "" }, new Date(Date.now() + grantTtlMs())),
    );
    const base = loadConfig().publicUrl.replace(/\/+$/, "");
    return c.json({
      ok: true,
      started: true,
      stage: local?.preview?.stage ?? shared?.stage ?? "starting",
      url: `${base}/v1/preview/${nonce}/`,
    });
  });

  /**
   * GET /v1/tasks/:id/preview — where the live preview is on its boot ladder.
   *
   * Polled by the founder UI while the "boot in progress" card is up. Reads the run handle's
   * `preview` status, which the boot sequence in runtime.ts advances on real observations (npm
   * exited 0, the port answered). 409 when the run is over or elsewhere — the caller flips to its
   * "workspace is gone" state, same contract as /steer and /files.
   */
  app.get("/v1/tasks/:id/preview", async (c) => {
    const t = await store.getTask(c.req.param("id") ?? "");
    if (!t || !inScope(accessible(c), t.project_id)) return c.json({ error: "not found" }, 404);
    // Same as the POST: the handle is on a worker, this is the API. The shared row is the answer for
    // every real deployment; the local handle is the fresher answer when we happen to have it.
    const run = getRun(t.id);
    const local = run && run.projectId === t.project_id ? run : undefined;
    const shared = local ? undefined : await readPreviewTarget(t.id);
    // Same rule as the POST: a task nobody has claimed yet is "starting", not "over". See there.
    if (!local && !shared && TERMINAL_STATUSES.includes(t.status)) {
      return c.json({ error: "run is not live" }, 409);
    }
    if (local && !local.startPreview) return c.json({ supported: false, stage: "none" });
    const p = local?.preview ?? shared;
    return c.json({
      supported: true,
      stage: p?.stage ?? "starting",
      ...(p?.stage === "failed" && p.error ? { error: p.error } : {}),
    });
  });

  /**
   * ═══ THE GATE THAT EARNS THE RIGHT TO LIFT ITSELF ═══
   *
   * `STANDARD.md` §4 calls selective auto-release "the thing that decides whether the vision is
   * real", and says: "Nothing else on the roadmap changes the shape of the business; this does."
   * `release-policy.ts` implements it completely and correctly — and it was gated on the environment
   * variable `MYCEL_AUTO_RELEASE_PROJECTS`, so no founder could turn it on, none could see a track
   * record accumulating, and enabling it for one customer needed a deploy. The mechanism had never
   * run for anybody.
   *
   * These three routes are the whole missing surface.
   *
   *   GET  /v1/release-policy          — is it on, and what is the bar
   *   PUT  /v1/release-policy          — turn it on or off, and set the bar
   *   GET  /v1/release-policy/record   — the track record for one client and one service
   *
   * THE RECORD ROUTE IS THE IMPORTANT ONE, and it is a READ with no side effects. A founder cannot
   * decide to trust this from a settings toggle; they decide from "GEO monitor for Harborline has
   * been accepted first-time three times in a row". The number is what makes the switch meaningful,
   * so it is available whether or not the switch is on — a business watching a run build up before
   * they enable anything is exactly the adoption path this feature needs.
   */
  app.get("/v1/release-policy", async (c) => {
    const pid = writeProjectId(c);
    if (!pid || !accessible(c).has(pid)) return c.json({ error: "no project" }, 400);
    const policy = await releasePolicyFor(pid, {
      queryRecords: getDomainStore().queryRecords.bind(getDomainStore()),
    });
    return c.json({
      enabled: policy.enabled,
      clean_run_required: policy.cleanRunRequired ?? CLEAN_RUN_REQUIRED,
      // So a console can explain the asymmetry without hardcoding it: after a lapse the bar goes UP
      // rather than back, which is the entire safety argument and is worth saying on the screen.
      penalty_per_lapse: PENALTY_PER_LAPSE,
    });
  });

  /**
   * HOW OFTEN THIS BUSINESS CHASES ITS OWN CLIENTS.
   *
   * The ladder used to be three `if` statements in dunning.ts, so a founder asking us to ease off had
   * nothing to change. See chase-policy.ts for what is configurable and what deliberately is not:
   * the 48-hour floor and the ten-chase ceiling are ours, and everything between them is theirs.
   */
  app.get("/v1/chase-policy", async (c) => {
    const pid = writeProjectId(c);
    if (!pid || !accessible(c).has(pid)) return c.json({ error: "no project" }, 400);
    const policy = await chasePolicyFor(pid, dunningWedge() ?? "", {
      queryRecords: (q) => getDomainStore().queryRecords(q),
    });
    // The bounds travel with the values so a settings screen does not have to hardcode our floor and
    // then drift from it — the same reason the ship contract is described to the agent rather than
    // restated in each wedge.
    return c.json({
      policy,
      bounds: {
        min_interval_days: MIN_CHASE_INTERVAL_DAYS,
        max_interval_days: MAX_INTERVAL_DAYS,
        max_chases_ceiling: MAX_CHASES_CEILING,
      },
      default: DEFAULT_CHASE_POLICY,
    });
  });

  app.put("/v1/chase-policy", async (c) => {
    const pid = writeProjectId(c);
    if (!pid || !accessible(c).has(pid)) return c.json({ error: "no project" }, 400);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    /**
     * Named bounds rather than a silent clamp, the same argument the release policy makes one route
     * down: a founder who typed 1 meant something, and quietly storing 2 would leave them believing
     * their clients are chased daily when they are not.
     *
     * `toChasePolicy` still clamps on the READ, because a row can also arrive from an older shape or
     * a hand edit, and that path has no one to tell.
     */
    for (const k of ["firstDays", "secondDays", "laterDays"] as const) {
      if (b[k] === undefined) continue;
      const n = Number(b[k]);
      if (!Number.isFinite(n) || n < MIN_CHASE_INTERVAL_DAYS || n > MAX_INTERVAL_DAYS) {
        return c.json(
          { error: `${k} has to be between ${MIN_CHASE_INTERVAL_DAYS} and ${MAX_INTERVAL_DAYS} days — we will not chase a client more often than that` },
          400,
        );
      }
    }
    if (b.maxChases !== undefined) {
      const n = Number(b.maxChases);
      if (!Number.isFinite(n) || n < 1 || n > MAX_CHASES_CEILING) {
        return c.json(
          { error: `maxChases has to be between 1 and ${MAX_CHASES_CEILING} — past that an email is not the tool, a decision is` },
          400,
        );
      }
    }
    const merged = toChasePolicy(
      { ...(await chasePolicyFor(pid, dunningWedge() ?? "", { queryRecords: (q) => getDomainStore().queryRecords(q) })), ...b },
    );
    await getDomainStore().upsertRecord({
      project_id: pid,
      wedge: dunningWedge() ?? "",
      collection: CHASE_POLICY_COLLECTION,
      key: "policy",
      data: merged as unknown as Record<string, unknown>,
    });
    /**
     * ON THE AUDIT CHAIN. This decides how often our sending address contacts somebody else's
     * customer, which is the class of setting whose history has to be answerable later — "who
     * loosened this, and when" is the first question after a complaint.
     */
    await audit({
      project_id: pid,
      actor: "member",
      action: "chase_policy.changed",
      entity: "project",
      entity_id: pid,
      detail: merged as unknown as Record<string, unknown>,
    });
    return c.json({ policy: merged });
  });

  app.put("/v1/release-policy", async (c) => {
    const pid = writeProjectId(c);
    if (!pid || !accessible(c).has(pid)) return c.json({ error: "no project" }, 400);
    const b = (await c.req.json().catch(() => ({}))) as { enabled?: unknown; clean_run_required?: unknown };
    if (typeof b.enabled !== "boolean") return c.json({ error: "enabled must be true or false" }, 400);
    const n = Number(b.clean_run_required);
    if (b.clean_run_required !== undefined && (!Number.isFinite(n) || n < 1 || n > 20)) {
      // Named bounds rather than a silent clamp: a founder who typed 100 meant something, and
      // quietly storing 20 would leave them believing a thing that is not true.
      return c.json({ error: "the clean run has to be between 1 and 20 deliverables" }, 400);
    }
    await getDomainStore().upsertRecord({
      project_id: pid,
      wedge: RELEASE_WEDGE,
      collection: POLICY_COLLECTION,
      key: POLICY_KEY,
      data: {
        enabled: b.enabled,
        ...(Number.isFinite(n) && n >= 1 && n <= 20 ? { clean_run_required: Math.floor(n) } : {}),
      },
    });
    /**
     * ON THE AUDIT CHAIN, and this is the same argument `standing.granted` makes.
     *
     * Auto-release is the only mechanism in this product by which finished work reaches a client
     * without a human looking at it in the moment. "Who turned that on, and when" has to be
     * answerable from the tamper-evident record rather than from a mutable row that only knows what
     * is true now — and the interesting question is almost always about the window before somebody
     * turned it off again.
     */
    await audit({
      project_id: pid,
      actor: "member",
      action: b.enabled ? "standing.granted" : "standing.revoked",
      entity: "project",
      entity_id: pid,
      detail: { kind: "auto_release", ...(Number.isFinite(n) ? { clean_run_required: Math.floor(n) } : {}) },
    });
    return c.json({ ok: true, enabled: b.enabled });
  });

  /**
   * The track record for one pairing — this service, for this client.
   *
   * Per WEDGE and per CLIENT, never global and never per-wedge alone, for the reason
   * `release-policy.ts` gives at length: a business doing brilliant bookkeeping for six months tells
   * you nothing about the first website it builds, and a brand-new client has no shared vocabulary
   * with us yet no matter how good the wedge is elsewhere.
   */
  app.get("/v1/release-policy/record", async (c) => {
    const pid = writeProjectId(c);
    if (!pid || !accessible(c).has(pid)) return c.json({ error: "no project" }, 400);
    const q = c.req.query();
    const clientId = String(q.client_id ?? "");
    const wedge = String(q.wedge ?? "");
    if (!clientId || !wedge) return c.json({ error: "client_id and wedge are both required" }, 400);

    const url = databaseUrl();
    // No Postgres means no deliverable history to read, so the honest answer is an empty record
    // rather than an error — a developer on the memory store should see "no track record yet".
    const rec = url
      ? await readRecord(getPool(url), { project_id: pid, client_id: clientId, wedge })
      : { wedge, client_id: clientId, outcomes: [] };
    const policy = await releasePolicyFor(pid, {
      queryRecords: getDomainStore().queryRecords.bind(getDomainStore()),
    });
    return c.json({
      wedge,
      client_id: clientId,
      clean_run: cleanRun(rec),
      bar: barFor(rec, policy),
      lapses: lapses(rec),
      enabled: policy.enabled,
      // The decision this pairing would get RIGHT NOW on fit work, so a console can print the
      // sentence rather than re-deriving the rule and getting it subtly different.
      would: explain(mayAutoRelease({ record: rec, policy, clientReady: true })),
      outcomes: rec.outcomes.slice(0, 12),
    });
  });

  /**
   * ═══ GET /v1/tasks/:id/screen — what the agent's browser is showing, right now ═══
   *
   * The `operate` shape puts a real Chromium in the sandbox and lets the agent work inside somebody
   * else's software. All a founder could see of that was a list of tool calls —
   * `browseruse_browser_click {index: 14}` — which is an audit trail nobody watches, and is close to
   * useless for working out why a run went wrong, because the interesting information is what the
   * PAGE did and 14 turns out to have been a cookie banner.
   *
   * ONE FRAME, POLLED, and deliberately not a stream. Same decision `live-preview.tsx` documents:
   * whoever is looking wants to see what the browser shows NOW, so a buffered stream of what it
   * showed thirty seconds ago is worse than useless while a run is going. A reader who opens the tab
   * late is immediately current, there is nothing to seek, and a dropped connection costs one frame.
   *
   * IT SERVES JPEG BYTES, NOT JSON. Base64 in a JSON envelope would be a third larger for a payload
   * fetched several times a second, and an `<img src>` cannot read JSON — so the browser's own image
   * pipeline does the decoding, which is the one part of this nobody has to write.
   *
   * NO-STORE, and that is a privacy line rather than a caching preference: these frames are a
   * customer's logged-in session in somebody else's software. They live in one variable inside the
   * run, they are replaced on every repaint, they are never written to an artifact, and they die
   * with the sandbox. Nothing about them should end up in a proxy cache.
   *
   * `204` when there is no picture yet, with the reason in a header. A missing frame is the ordinary
   * case for the first few seconds of any run and it is not an error — and the three reasons for it
   * ("the agent has not opened a browser yet", "waiting for it to paint", "it crashed") are
   * different sentences a viewer needs to be told apart.
   */
  app.get("/v1/tasks/:id/screen", async (c) => {
    const t = await store.getTask(c.req.param("id") ?? "");
    if (!t || !inScope(accessible(c), t.project_id)) return c.json({ error: "not found" }, 404);
    const run = getRun(t.id);
    if (!run || run.projectId !== t.project_id) return c.json({ error: "run is not live" }, 409);
    // Absent for every shape that is not `operate`. Reported as unsupported rather than as an
    // error, so a console can hide the tab instead of showing a broken one.
    if (!run.screen) return c.json({ supported: false }, 200);

    // The catch has to widen to the success shape or TypeScript narrows the union to the error arm
    // and `frame` stops existing — the same annotation `deliverInvoice`'s catch carries, for the
    // same reason.
    type Shot = { frame?: { bytes: Buffer; at: number; width: number; height: number }; why?: string };
    const shot: Shot = await run
      .screen()
      .catch((e): Shot => ({ why: `could not watch the browser: ${(e as Error)?.message}` }));
    if (!shot.frame) {
      return new Response(null, {
        status: 204,
        headers: {
          "x-mycel-screen": (shot.why ?? "no picture").slice(0, 200),
          "cache-control": "no-store",
        },
      });
    }
    return new Response(new Uint8Array(shot.frame.bytes), {
      status: 200,
      headers: {
        "content-type": "image/jpeg",
        "cache-control": "no-store",
        // So a viewer can show how fresh the picture is without a second request, and so a poller
        // can notice a frozen browser — a timestamp that stops advancing is the signal.
        "x-mycel-frame-at": String(shot.frame.at),
        "x-mycel-frame-size": `${shot.frame.width}x${shot.frame.height}`,
      },
    });
  });

  /**
   * GET /v1/preview/:grant/* — the live-preview proxy: the sandbox's dev server, on OUR address.
   *
   * WHY A PROXY AT ALL: the Daytona preview link is authenticated by the `x-daytona-preview-token`
   * HEADER, and an iframe cannot send headers; locally the dev server binds 127.0.0.1 of the kernel
   * host, which the founder's browser cannot reach either. So the kernel — the one party that can
   * reach the sandbox and hold the token — relays.
   *
   * THE SECURITY SHAPE, stated plainly:
   *   · The grant in the path IS the credential (minted behind the founder's key, TTL-bound,
   *     task-scoped). No cookie, no bearer — there is nothing ambient on this origin to steal.
   *   · This serves MODEL-AUTHORED HTML, so it must never be same-origin with the founder console.
   *     It is on the kernel's API origin, whose auth is bearer-only: a malicious document here has
   *     no cookie jar and no localStorage of ours to read.
   *   · `Content-Security-Policy: sandbox allow-scripts` is stamped on every response, so even a
   *     direct, un-framed navigation to this URL runs the document in an opaque origin.
   *   · GET/HEAD only. A preview is for looking at.
   */
  /**
   * How long the proxy waits for the sandbox's dev server before answering the ladder page itself.
   *
   * Chosen against what it is bounding, not as a round number: a cold Next route compile is tens of
   * seconds and a healthy one is milliseconds, so this sits above the slow case and far below the
   * 300s that undici and the ALB would otherwise spend saying nothing.
   */
  const PREVIEW_UPSTREAM_MS = 45_000;

  app.all("/v1/preview/:grant/*", async (c) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      return c.json({ error: "preview is read-only" }, 405);
    }
    const nonce = c.req.param("grant") ?? "";

    /**
     * A PAGE FOR EVERY STATE, NOT JSON WITH A 5xx. See `preview-page.ts` for the full argument; the
     * short version is that this route answered `{"error":"preview is not up yet"}` with a 503 for
     * the whole of a normal first boot, that answer went into an `<iframe>`, and a founder saw a
     * blank frame or a CDN's error page. It was reported many times as "the preview has never
     * worked". It was working, and reporting its ordinary first minute as a server failure.
     */
    const page = (state: PreviewPageState, detail?: string) =>
      c.html(previewPage(state, detail), previewStatus(state), { [PREVIEW_STATE_HEADER]: state });

    const grant = await getGrantStore().then((g) => g.get("preview", nonce)).catch(() => undefined);
    if (!grant) return page("unknown");
    const taskId = String(grant.task_id ?? "");
    const run = getRun(taskId);

    /**
     * ═══ A MISSING HANDLE MEANS "NOT ON THIS REPLICA", NOT "OVER" ═══
     *
     * `getRun` is process-local (runregistry.ts says so). Runs execute on the WORKER service;
     * `/v1/preview/*` has no ALB listener rule so it lands on the API service. The handle is
     * therefore absent for every real preview request in production, and this route answered its
     * "the run is over" page every single time. It worked locally, where both are one process,
     * which is exactly why it shipped.
     *
     * So ask the shared table before concluding anything. Present but not live still gets the
     * ladder page; genuinely absent — cleared when the run ended — is the honest "finished".
     */
    const shared = run?.preview ? undefined : await readPreviewTarget(taskId);
    if (!run && !shared) return page("finished");

    /**
     * START IT, rather than report that nobody has.
     *
     * The founder opening this frame IS the demand signal `startPreview` was made on-demand for, and
     * the proxy is the first thing their browser touches. Requiring a separate POST first meant any
     * path that reached the frame without one — a pasted link, a reopened tab, a refresh after the
     * console reloaded — showed "not up yet" for ever, because nothing was ever going to start it.
     * Idempotent by contract, so the refresh loop below re-entering here costs nothing.
     */
    if (run && !run.preview && run.startPreview) {
      await run.startPreview().catch(() => {});
    }

    // The local handle when we have it (freshest), the shared row when the run is elsewhere.
    const p = run?.preview ?? shared;
    if (!p || p.stage !== "live" || !p.url) {
      const stage = p?.stage;
      return page(
        stage === "failed" ? "failed" : stage === "installing" ? "installing" : stage === "booting" ? "booting" : "starting",
        p?.error,
      );
    }

    // Everything after the grant segment, plus the query string, straight through to the dev
    // server — that is what lets the app's own relative assets (/_next/*, fonts, images) resolve.
    const prefix = `/v1/preview/${nonce}`;
    const rest = c.req.path.slice(prefix.length) || "/";
    const search = new URL(c.req.url).search;
    const target = `${p.url.replace(/\/+$/, "")}${rest}${search}`;

    let upstream: Response;
    try {
      upstream = await fetch(target, {
        method: c.req.method,
        headers: {
          accept: c.req.header("accept") ?? "*/*",
          ...(c.req.header("accept-encoding") ? { "accept-encoding": "identity" } : {}),
          ...(p.token ? { "x-daytona-preview-token": p.token } : {}),
        },
        redirect: "manual",
        /**
         * ═══ THE HANG THAT READ AS "THE PREVIEW TIMES OUT" ═══
         *
         * This fetch had NO SIGNAL. The `catch` below only fires when the connection is refused or
         * reset — a socket that opens and then goes quiet throws nothing, so the request sat on
         * undici's 300s default while the browser, and the ALB's own 300s idle timeout, waited with
         * it. The founder's report was "we hit time limits getting a response", and that is exactly
         * what this is: not a wrong page, no page at all, for five minutes.
         *
         * It is the ordinary state of a preview, too. A Next dev server compiles a route on FIRST
         * REQUEST — the very request this proxy makes — and while it compiles it has accepted the
         * socket and sent nothing. So the common path was the hanging path.
         *
         * `http.ts` argues this case at length after the same bug took the outbound engine dark for
         * a day, and its `fetchWithDeadline` is the fix everywhere a body can be read as text. A
         * proxy cannot use it: this response is STREAMED so that images, fonts and JS bundles pass
         * through as bytes, and reading to text would corrupt every one of them.
         *
         * So the same discipline, applied directly. `AbortSignal.timeout` covers the whole exchange
         * rather than resetting per packet — the trade http.ts already made deliberately — which
         * means a genuinely enormous asset on a slow link is cut off at the deadline. For a dev
         * server one hop away that is not a real case, and forty-five seconds of silence is not a
         * slow asset, it is a route that is still compiling.
         */
        signal: AbortSignal.timeout(PREVIEW_UPSTREAM_MS),
      });
    } catch (e) {
      /**
       * NOT A 502, in either branch. The dev server going quiet for a moment is the ordinary
       * consequence of the agent editing a file that forces a restart — and a 5xx here is the exact
       * response an intermediary replaces with its own error page, which is how the careful answer
       * stops arriving at all.
       *
       * A TIMEOUT IS "BOOTING", NOT "UNREACHABLE". `TimeoutError` means the socket opened and the
       * server never answered, which for a dev server is a route still compiling — the honest page
       * says so and the pane retries. "Unreachable" would send the founder to look for a crash that
       * has not happened.
       */
      return (e as { name?: string })?.name === "TimeoutError"
        ? page("booting", `the dev server has not answered in ${Math.round(PREVIEW_UPSTREAM_MS / 1000)}s — it is probably still compiling this page`)
        : page("unreachable");
    }

    const headers = new Headers();
    for (const h of ["content-type", "content-length", "location", "etag", "last-modified"] as const) {
      const v = upstream.headers.get(h);
      if (v) headers.set(h, v);
    }
    // Never forward the sandbox's cookies, and never let a preview document cache past the run.
    headers.set("cache-control", "no-store");
    // Opaque origin even on direct navigation — see the header comment. `allow-scripts` because a
    // Next.js dev page that cannot hydrate previews nothing; no `allow-same-origin`, ever.
    headers.set("content-security-policy", "sandbox allow-scripts allow-forms");
    // Named on the way through as well, so a probe reading this header never has to special-case the
    // happy path — the state is legible on every response the proxy makes.
    headers.set(PREVIEW_STATE_HEADER, "live");
    return new Response(upstream.body, { status: upstream.status, headers });
  });

  /**
   * GET /v1/tasks/:id/files            → the workspace file tree (paths only)
   * GET /v1/tasks/:id/files?path=x/y   → one file's contents
   *
   * Reads the LIVE sandbox through the run registry, so it works only while the run executes here;
   * a finished or elsewhere run is 409 and the caller falls back to the exported workspace artifact.
   * Reads are physically confined to the run's workspace dir — no traversal to the opencode config.
   */
  app.get("/v1/tasks/:id/files", async (c) => {
    const t = await store.getTask(c.req.param("id") ?? "");
    if (!t || !inScope(accessible(c), t.project_id)) return c.json({ error: "not found" }, 404);
    const run = getRun(t.id);
    if (!run || run.projectId !== t.project_id) return c.json({ error: "run is not live" }, 409);
    const root = run.workspaceDir ?? "";
    if (!root) return c.json({ error: "run has no workspace" }, 409);

    const rel = c.req.query("path");
    if (rel === undefined) {
      const r = await run.sandbox.exec(
        `cd ~/${root} && find . \\( -name node_modules -o -name .git -o -name .next \\) -prune ` +
          `-o -type f -print | head -n 2000 | sed 's|^\\./||'`,
        15000,
      );
      const files = r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
      return c.json({ root, files, truncated: files.length >= 2000 });
    }

    if (rel.startsWith("/") || rel.split("/").includes("..")) return c.json({ error: "invalid path" }, 400);
    const content = await run.sandbox.readFile(`${root}/${rel}`);
    if (content === null) return c.json({ error: "not found" }, 404);
    const MAX = 512 * 1024;
    return content.length > MAX
      ? c.json({ path: rel, truncated: true, content: content.slice(0, MAX) })
      : c.json({ path: rel, truncated: false, content });
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

  /**
   * GET /v1/events — everything happening in the org, as one stream.
   *
   * `/v1/tasks/:id/events` answers "what is this run doing", which presumes you already know which
   * run to ask about. This answers the question the operator surface actually has: what is the
   * machine doing right now, at all. One connection, every task in the caller's projects, live.
   *
   * Four decisions worth stating, because each is the difference between a feed and an outage:
   *
   *   1. **Live only, no replay.** There is no `Last-Event-ID` here and no history dump. Event ids
   *      are monotonic PER TASK — there is no global cursor to resume from — and a feed that
   *      replayed would have to read every event of every recent task on every connect, which for a
   *      run that streamed forty thousand `token.delta` is a self-inflicted outage on page load.
   *      History belongs to `GET /v1/tasks` and `GET /v1/tasks/:id/trace`, which are indexed for it.
   *   2. **`token.delta` never appears.** It is the overwhelming majority of all events and it is
   *      meaningless out of the context of its own run. The per-task stream still carries it.
   *   3. **Tenancy is decided per task, once, and cached.** The in-process bus is deliberately
   *      unscoped (see bus.ts), so every event is checked against `accessible(c)` before it is
   *      written. An unknown or out-of-scope task is remembered as a refusal so a busy foreign run
   *      cannot turn into a `getTask` per event.
   *   4. **Cross-replica coverage by polling task rows**, the same trick the per-task stream uses.
   *      The bus only carries what this process emitted; the durable log is the authority.
   */
  const FEED_EXCLUDE: ReadonlySet<EventType> = new Set<EventType>(["token.delta"]);

  app.get("/v1/events", async (c) => {
    const scope = accessible(c);
    // Nothing to stream and nothing to leak — but a 200 with an idle stream is the honest answer for
    // a session whose project list is empty, and it keeps the client's "calm idle" path identical.
    return streamSSE(c, async (stream) => {
      /** task_id → may this caller see it, and what is it. Decided once per task. */
      const known = new Map<string, { ok: boolean; wedge: string; task_type: string }>();
      /** task_id → highest event id already written, so the bus and the poll cannot duplicate. */
      const cursor = new Map<string, number>();
      const queue: TaskEvent[] = [];
      // Small on purpose. This is a status feed, not a log: when it backs up, the interesting frames
      // are the newest ones, so the oldest are dropped rather than the connection.
      const MAX_QUEUE = 500;
      let wake: (() => void) | null = null;

      const nudge = () => {
        const w = wake;
        wake = null;
        w?.();
      };

      const unsub = subscribeAll((ev) => {
        if (FEED_EXCLUDE.has(ev.type)) return;
        if (queue.length >= MAX_QUEUE) queue.shift();
        queue.push(ev);
        nudge();
      });

      const meta = async (taskId: string) => {
        let m = known.get(taskId);
        if (!m) {
          const t = await store.getTask(taskId).catch(() => undefined);
          m = {
            ok: !!t && inScope(scope, t.project_id),
            wedge: t?.wedge ?? "",
            task_type: t?.task_type ?? "",
          };
          // Bounded: a long-lived tab on a busy org would otherwise hold every task id it ever saw.
          if (known.size > 1000) known.delete(known.keys().next().value as string);
          known.set(taskId, m);
        }
        return m;
      };

      const send = async (ev: TaskEvent) => {
        if (FEED_EXCLUDE.has(ev.type)) return;
        if ((cursor.get(ev.task_id) ?? 0) >= ev.id) return;
        const m = await meta(ev.task_id);
        if (!m.ok) return;
        cursor.set(ev.task_id, ev.id);
        await stream.writeSSE({
          event: ev.type,
          // The wedge and task type ride along because the reader is looking at a mixed feed: "sent
          // an email" is a different sentence depending on which business sent it, and the client
          // has no other way to know without a request per row.
          data: JSON.stringify({ ...ev, wedge: m.wedge, task_type: m.task_type }),
        });
      };

      /**
       * The cross-instance half, plus the only history this endpoint serves.
       *
       * A task seen for the first time gets its recent tail — anything in the last minute, capped —
       * so connecting mid-run shows the run rather than waiting for its next event. Everything
       * older is skipped by setting the cursor past it, which is what stops a page load from
       * pulling a finished run's entire log.
       */
      const SEEN_TAIL_MS = 60_000;
      const SEEN_TAIL_MAX = 20;
      const poll = setInterval(async () => {
        try {
          // Scoped in the QUERY — see `/v1/tasks`.
          const tasks = await store.listTasks({ project_ids: [...scope], limit: 80 });
          for (const t of tasks) {
            // Only tasks that can still say something. A terminal task already emitted its last
            // event, and either the bus or an earlier poll has it.
            if (TERMINAL.has(t.status) && cursor.has(t.id)) continue;
            const first = !cursor.has(t.id);
            if (first) known.set(t.id, { ok: true, wedge: t.wedge, task_type: t.task_type });
            const events = (await store.eventsAfter(t.id, cursor.get(t.id) ?? 0)).filter(
              (ev) => !FEED_EXCLUDE.has(ev.type),
            );
            const fresh = first
              ? events
                  .filter((ev) => Date.now() - Date.parse(ev.ts) < SEEN_TAIL_MS)
                  .slice(-SEEN_TAIL_MAX)
              : events;
            // Skip past whatever was deliberately NOT sent, so it is never reconsidered — `send`
            // advances the cursor for everything that is. A task whose whole tail was too old to
            // show still gets a cursor, or every poll would re-read its entire log.
            const last = events[events.length - 1];
            if (fresh.length) cursor.set(t.id, Math.max(cursor.get(t.id) ?? 0, fresh[0]!.id - 1));
            else if (last) cursor.set(t.id, Math.max(cursor.get(t.id) ?? 0, last.id));
            else if (first) cursor.set(t.id, 0);
            for (const ev of fresh) queue.push(ev);
          }
          while (queue.length > MAX_QUEUE) queue.shift();
        } catch {
          /* a transient read failure must not kill a live feed */
        }
        nudge();
      }, 1500);
      (poll as unknown as { unref?: () => void }).unref?.();
      stream.onAbort(nudge);

      try {
        // A frame on connect, before anything has happened. Without it a proxy can sit on the
        // response until the first event, and a quiet org would render as a stalled connection.
        await stream.writeSSE({ event: "ready", data: JSON.stringify({ at: new Date().toISOString() }) });
        let idle = 0;
        while (!stream.aborted) {
          if (queue.length === 0) {
            await new Promise<void>((r) => {
              wake = r;
              // Also wakes on a timer, so the keepalive below goes out on a silent org.
              setTimeout(() => {
                if (wake === r) {
                  wake = null;
                  r();
                }
              }, 5_000).unref?.();
            });
          }
          if (stream.aborted) break;
          if (queue.length === 0) {
            idle += 5;
            // A comment frame, not an event: it keeps proxies and load balancers from reaping an
            // idle connection without the client having to know it exists.
            if (idle >= 20) {
              idle = 0;
              await stream.writeSSE({ event: "ping", data: "{}" });
            }
            continue;
          }
          idle = 0;
          // Ordered by task then id within a drain; across tasks the order is arrival order, which
          // is what a feed of concurrent runs actually means.
          const batch = queue.splice(0, queue.length).sort((a, b) => a.id - b.id);
          for (const ev of batch) await send(ev);
        }
      } finally {
        clearInterval(poll);
        unsub();
      }
    });
  });

  app.post("/v1/tasks/:id/cancel", async (c) => {
    const t = await store.getTask(c.req.param("id"));
    if (!t || !inScope(accessible(c), t.project_id)) return c.json({ error: "not found" }, 404);
    markCancelled(t.id);
    await store.setStatus(t.id, "cancelled");
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
      // Authority: approving is taking responsibility for something reaching a customer, and a
      // `viewer` is sold as read-only. A member session that cannot approve is refused here rather
      // than at the effect — the same 403 for approve and reject, so a viewer cannot settle either
      // way. Key auth (a product integration acting as the org) is not a member and is unaffected.
      const scope = c.get("scope");
      if (scope.kind === "member" && !canApprove(scope.role)) {
        return c.json({ error: "your role can read this but can't approve or reject it" }, 403);
      }
      // Atomic decide: only the first transition off "pending" wins (no approve/reject TOCTOU).
      if (a.status !== "pending") return c.json({ error: `already ${a.status}` }, 409);
      /**
       * The job this was gating is over. Nothing is waiting for this answer.
       *
       * a comparable runtime's `pending-questions.ts`: a stale ask "is worse than none: it invites an answer nothing
       * is waiting for". Approving here used to be half-effective in the worst direction — the
       * status flip and the event were correctly suppressed downstream, but the side effects that
       * ran on the way there were not. Refuse at the door instead, and say which state it ended in
       * so the answer reads as an explanation rather than a glitch.
       */
      if (TERMINAL_STATUSES.includes(at.status)) {
        return c.json({ error: `this job already ${at.status} — there's nothing left to ${decision === "approved" ? "approve" : "reject"}` }, 409);
      }
      // Approve-with-edit: the human may correct the action before it happens ({ edited: {...} }).
      const body = (await c.req.json().catch(() => ({}))) as { edited?: Record<string, unknown> };
      const settled = resolveApproval(id, decision, body.edited); // resolves local waiter if this replica holds it
      if (!settled) {
        // Multi-replica / worker mode: the in-process waiter lives on another container.
        // Persist the decision directly to the database so the worker's 700ms polling loop resolves it!
        // The edit is part of the DECISION, recorded on the row: "approved, but only after I fixed
        // it" must stay distinguishable from "approved untouched" forever, because the standing
        // suggester treats the first as a no-vote for autonomy.
        const updated = await store.setApproval(id, decision, undefined, !!(body.edited && Object.keys(body.edited).length));
        if (!updated) {
          const fresh = await store.getApproval(id);
          return c.json({ error: `already ${fresh?.status ?? "resolved"}` }, 409);
        }
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
       *
       * This is the founder-facing artefact — a file they can open, edit and delete. The RETRIEVABLE
       * form of the same correction (scoped, subject-keyed, supersedable) is distilled in
       * `awaitApproval`, which is where every settlement path converges: a capture wired to this
       * route alone would learn nothing from an approval that lands on another replica. The two are
       * not redundant. A file the founder cannot find is not editable knowledge, and a markdown blob
       * cannot be ranked, budgeted or contradicted.
       *
       * The scope is carried in metadata so retrieval can rank it: an old note about a different
       * task type is not competing on equal terms with this client's correction from last week.
       */
      /**
       * ═══════════════════════════════════════════════════════════════════════════════════════════
       * THE HUMAN DECISION ITSELF, IN THE AUDIT LOG — WHICH IT HAS NEVER BEEN
       * ═══════════════════════════════════════════════════════════════════════════════════════════
       *
       * `approval.auto_approved` has always been audited. `standing.granted` and `standing.revoked`
       * have always been audited. The one event a person actually performs — a founder reading a
       * draft and deciding it may go to a customer — was not, anywhere.
       *
       * That was survivable only because the console had a screen listing it: "Recently decided", on
       * the standing-approvals page. That page is deleted (the founder's verdict on it is quoted in
       * `cloud/app/(app)/work/approvals/page.tsx`), and deleting a screen is only honest if the
       * record it showed lives somewhere that is built for records. `/audit` is: actor, timestamp,
       * hash chain, and it already describes itself as holding "approvals granted or refused".
       * It just never received them.
       *
       * THE VOCABULARY WAS ALREADY THERE. `AuditAction` has carried `approval.granted` and
       * `approval.rejected` since the union was written, and nothing in the product ever emitted
       * either one — built, typed, never invoked. That is the dominant bug class in this codebase and
       * this is the cheapest possible instance of it: two string literals that made the log look
       * complete to anybody reading the type.
       *
       * `edited` is on the detail because it is the difference between "this was fine" and "this was
       * sent only after I rewrote it", and the standing suggester treats those as opposite votes.
       * The words themselves are NOT here: an audit entry is a record that a decision happened, and
       * a client's message pasted into a permanent hash-chained log is a disclosure nobody asked for.
       * The correction is written to knowledge below, where it is the founder's own and deletable.
       *
       * Fail-soft like every other write on this path. The human has decided and the action is in
       * flight; failing their approval because a log line could not be appended would trade the job
       * for the record of it.
       */
      await audit({
        project_id: at.project_id ?? "",
        actor: scope.kind === "member" ? "member" : "key",
        action: decision === "approved" ? "approval.granted" : "approval.rejected",
        entity: "task",
        entity_id: a.task_id,
        detail: {
          action: a.action,
          approval_id: id,
          edited: !!(body.edited && Object.keys(body.edited).length),
          ...(scope.kind === "member" && scope.member_id ? { by: scope.member_id } : {}),
        },
      }).catch((e) => console.error("[mycel] could not audit an approval decision:", e));

      let correctionId: string | undefined;
      /**
       * ═══ AND THE RETRIEVABLE HALF OF THE SAME CORRECTION ═══
       *
       * The block below writes the founder-facing FILE. `recordApprovalOutcome` writes the other
       * half — the scoped, subject-keyed, supersedable rule the next run actually retrieves, plus
       * the observation that says whether the agent got it right.
       *
       * It used to live inside `awaitApproval`, in the waiting run. A founder who decides two hours
       * later decides after a deploy or a stall has killed that run, so it never fired: 21 decided
       * approvals, zero observations, and all 22 production rules stamped `"source": "onboarding"`.
       * The landing page says "You correct it once, and it stops needing you"; nothing was learning.
       *
       * Here instead, because THIS is where a human decision enters the system — whichever replica
       * holds the waiter, and whether or not the run outlived the wait. Fail-soft for the reason the
       * original had: the human has decided and the action is in flight, so failing their approval
       * because a lesson could not be filed would trade the job for the note.
       */
      await recordApprovalOutcome(getKnowledgeStore(), {
        project_id: at.project_id,
        wedge: at.wedge,
        task_type: at.task_type,
        // `taskClientId`, not `at.client_id`: a task may carry its client inside `input` rather than
        // as a column, and reading the column alone files the lesson against nobody. The original
        // call did this and I dropped it in the move — `distillation.test.ts` caught it.
        client_id: taskClientId(at),
        action: a.action,
        decision,
        proposed: (a.preview ?? {}) as Record<string, unknown>,
        edited: body.edited,
        task_id: a.task_id,
        approval_id: a.approval_id,
      }).catch((e) => console.error("[mycel] could not distil an approval outcome:", e));

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
            metadata: {
              task_id: a.task_id,
              approval_id: id,
              action: a.action,
              task_type: at.task_type,
              // A correction on a client's task quotes that client's numbers and that client's
              // wording. It teaches house style AND it discloses them; only the second is decisive.
              ...scopeMeta(taskClientId(at)),
            },
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
    const gated = body.task_id ? await store.getTask(body.task_id) : undefined;
    if (!body.task_id || !gated) return c.json({ allow: false, decision: "unknown_task" }, 404);
    /**
     * The risk is decided HERE, not by the caller.
     *
     * The plugin posts `risk: "high"` as a string literal for every tool it matches — it runs inside
     * the sandbox, it has the tool name and nothing else, and it is the least trustworthy thing in
     * the system. Taking its word meant a `bash` call the pattern list happened to match arrived in
     * the founder's queue looking exactly like a refund. `body.risk` is now a FLOOR only: a caller
     * may insist something is more serious than we worked out, never less.
     */
    const action = body.action ?? "action";
    const assessed = assessRisk({
      action,
      capability: action,
      payload: body.preview ?? {},
      manifest: loadWedge(gated.wedge)?.manifest,
    });
    const floor: Risk[] = ["low", "medium", "high"];
    const risk =
      body.risk && floor.indexOf(body.risk) > floor.indexOf(assessed.risk) ? body.risk : assessed.risk;
    /**
     * ═══ LOW RISK PROCEEDS. IT DOES NOT WAIT FOR A HUMAN. ═══
     *
     * This route used to call `awaitApproval` unconditionally, so `risk` decided what the CARD said
     * and never whether one was raised. Everything blocked.
     *
     * MEASURED: 196 approvals in production, 195 expired, one ever approved — and in the same period
     * LinkedIn fired zero actions. Not zero successes: zero ATTEMPTS. The two facts are the same
     * fact. `awaitApproval` blocks the run and expires after five minutes (approvals.ts), and no
     * founder approves outbound in five-minute windows around the clock, so every sourcing read and
     * every sequence step queued, waited, expired, and died. The gate was not protecting the
     * business from bad sends; it was preventing all sends.
     *
     * A gate that stops everything is indistinguishable from a switch that is off, and it is worse
     * than one, because it looks like a safety feature while it is really an outage.
     *
     * WHY LOW IS SAFE TO PASS, specifically — it is not "low means we stopped caring":
     *   · a read changes nothing and reaches nobody (READ_ONLY in risk.ts)
     *   · a routine message is a reply on a thread the recipient already started
     *   · money, commitments, first contact, destructive and public-irreversible verbs are all
     *     scored medium or high by assessRisk and still block here, exactly as before
     *   · the volume ceilings are the real control for bounded work: the per-inbox ramp and the
     *     LinkedIn daily caps mean the worst case is a normal day's activity, not a runaway. A human
     *     click on top of a hard numeric limit adds no safety — it only adds the chance that the
     *     limit never gets used.
     *
     * STILL RECORDED, JUST NOT BLOCKING. `auto_approved` is a real decision with a real card, so the
     * feed shows what ran and why. The founder keeps the audit trail; what they lose is the
     * obligation to be awake for it.
     */
    if (risk === "low") {
      await recordAutoApproval(store, body.task_id, {
        action,
        risk,
        preview: { ...(body.preview ?? {}), why: assessed.why },
      }).catch(() => {});
      return c.json({ allow: true, decision: "auto_approved" });
    }

    const { decision } = await awaitApproval(store, body.task_id, {
      action,
      risk,
      preview: { ...(body.preview ?? {}), why: assessed.why },
    });
    return c.json({ allow: decision === "approved" || decision === "auto_approved", decision });
  });

  // ── Internal: the BUILD tool ─────────────────────────────────────────────────────────────────
  //
  // `next build` used to run inside the Daytona sandbox, after the agent had stopped, as the
  // workspace `verify` command. It OOM'd the microVM once and — more importantly — delivered its
  // verdict to nobody: the agent was gone, so a compile error had to be resurrected into a
  // follow-up task instead of fixed on the spot.
  //
  // Here it is a tool the agent calls mid-run. The sandbox posts its source; the KERNEL stages it
  // in S3 and starts CodeBuild with the kernel's own role; the agent gets a verdict and, on
  // failure, the tail of the real build log. Build → fail → read → fix → build again → done, all
  // inside one run. The sandbox holds no AWS credential at any point — see remotebuild.ts.
  //
  // Two routes rather than one blocking route, because the load balancer in front of this hostname
  // has AWS's default 60-second idle timeout and a build takes minutes. The wrapper script in the
  // sandbox does the looping; each request here is short. See `pollBuild`.

  /**
   * How many builds this run has already spent, counted from the DURABLE event log.
   *
   * Not an in-process counter like `readsExceeded`. That works for reads because the cost of a
   * miscount is one extra API call; here a miscount is a real dollar and several minutes, and the
   * worker tier runs two replicas — an in-memory count would let an agent get up to 2N builds by
   * being unlucky about which replica answered. `tool.called` is written before the build starts,
   * so the count is authoritative at the moment it matters.
   */
  const buildAttempts = async (taskId: string): Promise<number> => {
    const events = await store.eventsAfter(taskId, 0);
    return events.filter((e) => e.type === "tool.called" && e.data?.tool === "codebuild").length;
  };

  app.post("/v1/internal/build", async (c) => {
    const grant = await getBuildGrant((c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, ""));
    if (!grant) return c.json({ ok: false, error: "invalid build token" }, 401);
    const cfg = remoteBuildConfig();
    // Should be unreachable: the grant is only minted when the config exists. Answered honestly
    // anyway, because "the tool silently did nothing" is the failure mode this whole file avoids.
    if (!cfg) return c.json({ ok: false, error: "this kernel has no build plane configured" }, 503);

    const used = await buildAttempts(grant.task_id);
    if (used >= MAX_BUILDS_PER_RUN) {
      // AN HONEST REFUSAL, never a silent no-op. The agent is told the exact number so its next
      // move is "finish with what I have and say so", not "try again".
      return c.json(
        {
          ok: false,
          status: "refused",
          error:
            `build limit reached: this task has used all ${MAX_BUILDS_PER_RUN} of its builds. ` +
            `No further build will be started. Fix what you can from the last log, or stop and ` +
            `say plainly in your final message that the app does not build and why.`,
          attempts_used: used,
          attempts_remaining: 0,
        },
        429,
      );
    }

    const body = Buffer.from(await c.req.arrayBuffer());
    if (body.byteLength > MAX_SOURCE_BYTES) {
      // Refused BEFORE it counts as an attempt: an oversized upload is a packaging mistake, and
      // charging one of three builds for it would be punishing the agent for the wrong thing.
      return c.json(
        {
          ok: false,
          status: "refused",
          error:
            `source archive is ${(body.byteLength / 1024 / 1024).toFixed(1)}MB, over the ` +
            `${(MAX_SOURCE_BYTES / 1024 / 1024).toFixed(0)}MB ceiling. Exclude node_modules and ` +
            `.next — the build installs dependencies itself. This did not count as an attempt.`,
          attempts_used: used,
          attempts_remaining: MAX_BUILDS_PER_RUN - used,
        },
        413,
      );
    }

    const attempt = used + 1;
    await emitEvent(store, grant.task_id, "tool.called", {
      tool: "codebuild",
      args: { attempt, of: MAX_BUILDS_PER_RUN, bytes: body.byteLength },
    });
    try {
      const started = await startRemoteBuild(cfg, {
        projectId: grant.project_id,
        taskId: grant.task_id,
        attempt,
        source: body,
      });
      return c.json({
        ok: true,
        status: "building",
        build_id: started.buildId,
        attempts_used: attempt,
        attempts_remaining: MAX_BUILDS_PER_RUN - attempt,
      });
    } catch (e) {
      const error = String((e as Error)?.message ?? e).slice(0, 500);
      await emitEvent(store, grant.task_id, "tool.result", { tool: "codebuild", ok: false, error });
      return c.json({ ok: false, status: "failed", error }, 502);
    }
  });

  /**
   * The evidence read — the other half of the loop, and the only READ a build sandbox may make.
   *
   * ── Why the grant, and nothing but the grant, decides the project ──
   *
   * `getBuildGrant` resolves the nonce to one task and one project. `grant.project_id` is what this
   * summary is built for, and there is no branch below that reads a project from a body, a query
   * string or a header. That is the same rule as `/v1/insight/events`, and it is not a coincidence:
   * this answer is read by a model that will then REWRITE A WEBSITE, so an answer built from another
   * tenant's visitors would not be a disclosure that stops at disclosure — it would end with a
   * stranger's homepage edited to suit somebody else's traffic.
   *
   * ── Why it is not counted against the build cap ──
   *
   * A build costs a dollar and six minutes; this costs a query. Charging for it would create exactly
   * the incentive we do not want, which is an agent that guesses rather than looks. The only thing
   * the caller may vary is the window, and `buildSummary` clamps that to 1..90 days.
   *
   * ── Why there is no write here ──
   *
   * A sandbox running model-authored code holds this nonce. It may ask what happened. It cannot
   * record what happened, start a task, reach another project, or learn anything about an individual
   * — the summary is aggregate by construction, because nothing per-visitor was ever stored
   * (`insight/schema.ts` discards the anonymous id on arrival).
   */
  app.post("/v1/internal/build/insight", async (c) => {
    const grant = await getBuildGrant((c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, ""));
    if (!grant) return c.json({ ok: false, error: "invalid build token" }, 401);
    const body = (await c.req.json().catch(() => ({}))) as { days?: unknown };
    const days = Number(body.days);
    return c.json(await buildSummary(domain, grant.project_id, { days: Number.isFinite(days) ? days : 14 }));
  });

  app.post("/v1/internal/build/status", async (c) => {
    const grant = await getBuildGrant((c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, ""));
    if (!grant) return c.json({ ok: false, error: "invalid build token" }, 401);
    const cfg = remoteBuildConfig();
    if (!cfg) return c.json({ ok: false, error: "this kernel has no build plane configured" }, 503);
    const { build_id } = (await c.req.json().catch(() => ({}))) as { build_id?: string };
    if (typeof build_id !== "string" || !build_id.trim()) {
      return c.json({ ok: false, error: "build_id is required" }, 400);
    }

    // Bounded well under the load balancer's 60s idle timeout. A build that is still running comes
    // back as `building` and the sandbox's wrapper script asks again.
    const waitMs = Math.max(1, Number(process.env.MYCEL_BUILD_WAIT_S ?? 40)) * 1000;
    const verdict = await pollBuild(cfg, build_id.trim(), waitMs);
    if (verdict.status === null) {
      return c.json({ ok: true, status: "building", build_id: verdict.buildId });
    }
    // `tool.result` is emitted only on a TERMINAL verdict, and it is what `handOffWorkspace` reads
    // to decide whether this run may be exported at all. See `assertRemoteBuildSucceeded`.
    await emitEvent(store, grant.task_id, "tool.result", {
      tool: "codebuild",
      ok: verdict.status === "succeeded",
      build_id: verdict.buildId,
    });
    return c.json({
      ok: verdict.status === "succeeded",
      status: verdict.status,
      build_id: verdict.buildId,
      ...(verdict.status === "failed" ? { log_tail: verdict.tail ?? "" } : {}),
    });
  });

  // Internal: proxy-mode model routing. The sandbox calls this with an opaque nonce; the harness
  // looks up the real key, forwards to the OpenAI-compatible upstream, streams the response back,
  // and traces the call. The provider key never enters the sandbox. The model and token budget are
  // pinned server-side so a compromised nonce can't switch models or run up an unbounded bill.
  const ALLOWED_LLM_PATHS = new Set(["chat/completions", "completions", "embeddings", "responses"]);

  /**
   * ═══ THE RUN READING ITS OWN WORK, WITH THE REVIEWER'S INSTRUMENT ═══
   *
   * `mycel-check <file.html>` in the sandbox posts here. This runs the SAME `lintArtifact` the
   * submit gate runs (`slopFault` in deliverables.routes.ts) and checks the same declared shape the
   * run was mounted — so an agent that goes green here cannot then be refused for a reason it was
   * never shown, which is the two-gates-disagreeing failure that file documents at length.
   *
   * The sandbox sends the HTML and NOTHING ELSE. The expected sections are resolved from the proxy
   * grant's `task_id` → task → wedge → task type → `deliverable_shape`. A check whose answer key is
   * supplied by the subject is not a check.
   *
   * Read-only, on the grant the run already holds: starts nothing, writes nothing, reaches no other
   * project. Same reasoning as `mycel-insight` sharing the build grant.
   */
  app.post("/v1/internal/check", async (c) => {
    const nonce = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
    const grant = await getGrant(nonce);
    if (!grant) return c.json({ error: "invalid proxy token" }, 401);

    let body: { html?: unknown; name?: unknown } = {};
    try {
      body = JSON.parse(await c.req.text());
    } catch {
      return c.json({ error: "body must be JSON" }, 400);
    }
    const html = typeof body.html === "string" ? body.html : "";
    const name = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 200) : "the file";
    if (!html) return c.json({ error: "nothing to check — the file was empty" }, 400);

    // P0 only, matching the gate exactly. P1/P2 are judgement calls the submit does not block on,
    // and reporting them here as if they were rejections would make the tool cry wolf.
    const findings = lintArtifact(html)
      .filter((f) => f.severity === "P0")
      .map((f) => ({ id: f.id, message: f.message, fix: f.fix }));

    /**
     * And the sections this job declared. Missing headings are reported with the same shape as a
     * lint finding so the tool renders one list — the agent has one thing to fix, not two reports.
     *
     * NOT blocking at submit today, deliberately: a heading match is a weaker signal than a colour
     * literal (a run may legitimately title a section in the client's own words), so this tells the
     * run what the shape asked for and leaves the judgement with it. It is the cheap half —
     * pointing out a section that is simply absent, which is the common miss.
     */
    try {
      const task = await store.getTask(grant.task_id);
      const wedge = task?.wedge ? loadWedge(task.wedge) : null;
      const shape = readDeliverableShape(
        wedge?.manifest.task_types?.[task?.task_type ?? ""]?.deliverable_shape,
      );
      if (shape) {
        const flat = html.toLowerCase().replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
        for (const section of shape.sections) {
          const heading = section.heading.toLowerCase();
          // Whole heading, then its distinctive words — a run that wrote "Reconciliation to the
          // statement" has not missed the "Reconciliation" section, and saying it did is the kind
          // of false finding that gets a tool ignored.
          const words = heading.split(/[^a-z0-9]+/).filter((w) => w.length > 3);
          const present =
            flat.includes(heading) || (words.length > 0 && words.every((w) => flat.includes(w)));
          if (!present) {
            findings.push({
              id: "shape-section-missing",
              message: `the shape for this job has a section "${section.heading}" and this file does not`,
              fix: section.must || `add it, in the order the-shape-of-the-finished-work.md gives`,
            });
          }
        }
      }
    } catch {
      // A shape lookup that fails must never turn a clean file into a failed check. The slop rules
      // above already ran and are the half that blocks.
    }

    return c.json({ checked: name, findings });
  });
  /**
   * IMAGE GENERATION, ON THE BUSINESS'S OWN AWS CREDITS, WITH NOTHING SECRET IN THE SANDBOX.
   *
   * `mycel-image` posts here with the run's proxy nonce — the same short-lived, task-scoped grant
   * the model proxy uses — and the kernel makes the Bedrock call with its task role. The alternative
   * is an AWS credential inside an agent sandbox, which would reach S3, ECS and everything else the
   * role can touch. A scoped provider key is merely bad; that would be worse than bad.
   *
   * REGION IS EXPLICIT because Bedrock's image models are not everywhere: eu-west-1 and us-east-1
   * carry `amazon.nova-canvas-v1:0`, and eu-west-2 — where this kernel runs — carries none. The
   * call is cross-region on purpose, which costs a few hundred milliseconds on an operation that
   * takes seconds, and saves a region migration whose real price is an SES sending reputation.
   *
   * NO PROMPT REACHES A LOG. It is a founder's business description on its way to a picture, and
   * `console.error` on a proxy is the easiest place in a system for one to end up somewhere it was
   * never meant to be.
   */
  app.post("/v1/internal/image", async (c) => {
    const nonce = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
    const grant = await getGrant(nonce);
    if (!grant) return c.json({ error: "invalid proxy token" }, 401);

    /**
     * WHO IS PAYING, resolved from the grant rather than trusted from the body.
     *
     * The nonce names a task; the task names a project; the project names the org whose plan holds
     * the allowance. A `project_id` in the request body would be the sandbox choosing whose budget
     * to spend, which is the whole reason none of these routes take one.
     */
    const imgTask = await store.getTask(String(grant.task_id ?? ""));
    const projectId = imgTask?.project_id ?? "";
    if (!projectId) return c.json({ error: "this run is not attached to a project" }, 409);

    /**
     * THE PROVIDER IS RESOLVED HERE, not in the sandbox.
     *
     * Every provider now runs through this route — see `imageToolScript`. The sandbox holds a
     * task-scoped nonce and nothing else, so a run cannot reach a provider directly, cannot read a
     * key out of its own environment, and cannot spend around the ceiling below by calling the API
     * itself. That last part is what makes the cap a cap.
     */
    const provider = imageProviderFromEnv();
    if (!provider) return c.json({ error: "image generation is not configured on this kernel" }, 501);

    const b = (await c.req.json().catch(() => ({}))) as { prompt?: unknown; width?: unknown; height?: unknown };
    const prompt = typeof b.prompt === "string" ? b.prompt.trim().slice(0, 1000) : "";
    if (!prompt) return c.json({ error: "a prompt is required" }, 400);

    /**
     * ═══ THE MARGIN CONTROL, AND THE ONE PLACE IT HAS TO LIVE ═══
     *
     * Text spend is bounded by LiteLLM, which holds the org's virtual key with a `max_budget` and
     * refuses at the proxy. Image generation does not pass through LiteLLM at all — it is a Bedrock
     * call the kernel makes with its own role — so until this line it was bounded by NOTHING. An
     * agent in a loop could have generated images until somebody read a bill.
     *
     * BUMPED BEFORE THE CALL, NOT AFTER. The counter's own increment is atomic and returns the new
     * value, so two concurrent runs cannot both read "under the limit" and both proceed — which is
     * exactly the failure `policy.ts` documents when per-replica Maps turned a `max_per_day: 40`
     * into roughly 160. The cost is that a generation which then fails still consumes a unit. That
     * is the correct direction for a spend control, and the alternative — refund on failure — is a
     * second source of truth about how much somebody has used.
     *
     * SCOPED TO THE PROJECT because that is what the counter store keys on, and metered per ORG's
     * plan because that is who pays. A project is owned by exactly one org, so the two agree.
     */
    const month = new Date().toISOString().slice(0, 7);
    const limits = getIdentityStore().limitsFor(getIdentityStore().getProject(projectId)?.org_id ?? "");
    const cap = limits.images_per_month;
    if (cap !== null) {
      if (cap === 0) {
        return c.json({ error: "image generation is not included on this plan" }, 402);
      }
      const endOfMonth = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1));
      const used = await (await getPolicyCounters())
        .bump(projectId, "month", `images:${month}`, endOfMonth)
        .catch(() => 0);
      // A counter we could not reach returns 0 and lets the image through: losing a founder's hero
      // to our own outage is worse than one uncounted image, and the ceiling is a margin control
      // rather than a security boundary.
      if (used > cap) {
        return c.json(
          { error: `this month's image allowance (${cap}) is used up — it resets on the 1st` },
          402,
        );
      }
    }

    try {
      const image = await generateImage(provider, { prompt, width: Number(b.width), height: Number(b.height) });
      if (!image) return c.json({ error: "the image service returned nothing" }, 502);
      return c.json({ image_base64: image });
    } catch (e) {
      // The MESSAGE only, never the prompt. An access-denied or a content-filter refusal is
      // actionable; a founder's description of their business is not ours to write down.
      const msg = (e as Error)?.message ?? "unknown";
      console.error(`[mycel] image generation failed on ${provider.kind}: ${msg.slice(0, 200)}`);
      return c.json({ error: "the image service refused or was unavailable" }, 502);
    }
  });

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
    // Bound the wait. A hung LiteLLM/Anthropic connection used to hold this open until the ALB
    // idle timeout, leaving the run without a `task.finished` and the founder staring at a spinner.
    // Abort → 504 below → OpenCode fails the prompt → orchestrator emits `task.finished` failed.
    const timeoutMs = Math.max(1_000, cfg.llmUpstreamTimeoutMs);
    try {
      /**
       * ═══ THE SHAPES ONLY LiteLLM WAS FIXING ═══
       *
       * Every tier in TIER_MODELS is a GPT-5-class model, and `/v1/chat/completions` refuses two of
       * the things opencode sends them. The hosted deployment never sees either, because LiteLLM
       * rewrites on the way through. Point the same proxy straight at api.openai.com — every
       * self-hosted install, every local eval — and the FIRST model call of every run 400s. Not
       * degraded: no task can start at all.
       *
       * Repaired from the provider's OWN REFUSAL rather than by pre-detecting the model, for the
       * reason `litellm.ts` gives at length about this exact family of errors: "a list of which
       * models accept which values is a list that is wrong the week after it is written", while the
       * refusal "is the only source that is never out of date". A provider happy with the original
       * shape never matches, never retries, and pays nothing.
       *
       * Each repair applies at most once — `applies` stops matching after its own fix lands — so the
       * loop cannot spin on a 400 it does not understand.
       */
      const REQUEST_REPAIRS: {
        when: RegExp;
        applies: (p: Record<string, unknown>) => boolean;
        fix: (p: Record<string, unknown>) => Record<string, unknown>;
      }[] = [
        {
          // "Unsupported parameter: 'max_tokens' is not supported with this model.
          //  Use 'max_completion_tokens' instead."
          when: /max_completion_tokens/,
          applies: (p) => p.max_tokens !== undefined,
          fix: ({ max_tokens, ...rest }) => ({ ...rest, max_completion_tokens: max_tokens }),
        },
        {
          // "Function tools with reasoning_effort are not supported for <model> in
          //  /v1/chat/completions. … or set reasoning_effort to 'none'."
          //
          // Their instruction, followed literally. The alternative they offer is /v1/responses,
          // which is a different API opencode does not speak, so `none` is the only door here.
          when: /reasoning_effort/,
          applies: (p) => p.reasoning_effort !== undefined && p.reasoning_effort !== "none",
          fix: (p) => ({ ...p, reasoning_effort: "none" }),
        },
      ];

      const send = (body: Record<string, unknown>) =>
        fetch(upstream, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${grant.api_key}` },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });

      let res = await send(payload);

      /**
       * ═══ `max_tokens` IS THE OLD NAME, AND ONLY LiteLLM WAS TRANSLATING IT ═══
       *
       * GPT-5-class models — which is every tier in TIER_MODELS — reject `max_tokens` outright:
       *
       *     400 Unsupported parameter: 'max_tokens' is not supported with this model.
       *         Use 'max_completion_tokens' instead.
       *
       * The hosted deployment never sees this because LiteLLM rewrites the field on the way through.
       * Point the same proxy straight at api.openai.com — which is every self-hosted install and
       * every local eval — and the FIRST model call of every run 400s. Not degraded: no task can
       * start at all.
       *
       * `litellm.ts` already hit this and documented it ("they demand `max_completion_tokens`"), and
       * fixed it for its own path. The proxy the AGENT calls never got the same treatment, so the
       * two paths disagreed about what OpenAI accepts.
       *
       * Retried on the provider's own refusal rather than by pre-detecting the model, for the reason
       * that file gives at length about `reasoning_effort`: "a list of which models accept which
       * values is a list that is wrong the week after it is written", where the refusal "is the only
       * source that is never out of date". One retry, only on a 400 that names the replacement, so a
       * provider that is happy with `max_tokens` keeps sending it and pays nothing.
       */
      for (let attempt = 0; attempt < REQUEST_REPAIRS.length && res.status === 400; attempt++) {
        const detail = await res.clone().text().catch(() => "");
        const repair = REQUEST_REPAIRS.find((r) => r.when.test(detail) && r.applies(payload));
        if (!repair) break;
        payload = repair.fix(payload);
        res = await send(payload);
      }

      traceLlmCall({ task_id: grant.task_id, model: grant.model, path, status: res.status, ms: Date.now() - started });
      return new Response(res.body, {
        status: res.status,
        headers: {
          "content-type": res.headers.get("content-type") ?? (stream ? "text/event-stream" : "application/json"),
        },
      });
    } catch (e) {
      const timedOut =
        (e instanceof Error && e.name === "TimeoutError") ||
        (e instanceof Error && /aborted|timeout/i.test(e.message));
      const status = timedOut ? 504 : 502;
      traceLlmCall({ task_id: grant.task_id, model: grant.model, path, status, ms: Date.now() - started });
      return c.json(
        {
          error: timedOut ? "upstream timeout" : "upstream error",
          detail: String(e instanceof Error ? e.message : e),
        },
        status,
      );
    }
  });

  /**
   * ── Small project reads ── /v1/knowledge, /v1/records, /v1/artifacts, /v1/threads live in
   * project-reads.routes.ts.
   */
  mountProjectReadRoutes(app, {
    domain, store, accessible, writeProjectId, inScope,
    serveArtifact, withContent, validateRecordInput,
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
    listConnections: () => domain.listConnections(),
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

  // ── Meeting join ── Chromium-on-Fargate into Meet, Zoom or Teams; Amazon Transcribe takes the words.
  // Catalogue is honest: URL join, no Connect buttons.
  mountMeetings(app, { domain, writeProjectId, accessible });
  mountPaidAds(app, { domain, writeProjectId, getConnection: (id) => domain.getConnection(id), inScope, accessible });

  // ── Product analytics ── /v1/insight/* lives in insight/routes.ts. The generated product reports
  // what its customers actually did; the agent that wrote it reads the summary and improves it.
  // Ingest authenticates with a per-project key and takes the project from that key's signature, so
  // it gets no tenancy helper — there is nothing here for it to trust.
  mountInsight(app, { domain, accessible });

  // ── What we need from you ── /v1/requests/* and /v1/portal/requests/* live in requests.routes.ts.
  // The client-facing half sits under `/v1/portal/*`, so the session middleware registered above
  // has already run by the time any of it executes.
  /**
   * Is this wedge on disk AND turned on for this business? Hoisted out of `mountInvoiceRoutes` so
   * the chase, the nudge and the resume are all asking the same question of the same function.
   */
  const wedgeEnabled = (projectId: string, wedge: string) =>
    !!loadWedge(wedge) && identity.projectAllowsWedge(projectId, wedge);

  /**
   * Spawn ONE clamped, queued run on the kernel's own behalf.
   *
   * Hoisted for the reason `startChase` was extracted from its two callers: this closure is the only
   * place that knows how to build a task the deployment's ceilings and the wedge manifest both agree
   * with, and a second copy for the nudge carrier or the wait resume would have drifted on
   * `output_schema` first — the field whose absence turns a run into an agent with no contract.
   */
  const spawnKernelTask = async (args: {
    project_id: string;
    wedge: string;
    task_type: string;
    client_id?: string;
    case_id?: string;
    batch_id?: string;
    source: TaskSource;
    input: Record<string, unknown>;
  }): Promise<string> => {
    const cfg = loadConfig();
    const at = new Date().toISOString();
    const spawned = loadWedge(args.wedge);
    const task: Task = {
      id: randomUUID(),
      project_id: args.project_id,
      case_id: args.case_id,
      batch_id: args.batch_id,
      wedge: args.wedge,
      task_type: args.task_type,
      actor: { kind: "system", id: "kernel" },
      input: args.input,
      /**
       * THE PROFILE'S OWN BUDGETS, exactly as `POST /v1/tasks` resolves them for the same work.
       *
       * `clampConstraints({}, …)` with no wedge and no task type falls through to
       * `profileConstraintDefaults(null, "")` — the permissive `general` shape, 600s and $2. So a
       * chase spawned by the dunning sweep got two and a half times the deadline of the identical
       * chase started by hand, which resolves `decide`'s 240s. Cost is re-clamped later in the
       * runtime; runtime is NOT (see the note above `clampConstraints`), so the divergence was real
       * and it was on the sweep side, where the tail of a 25-invoice batch already sits behind a
       * worker concurrency of 4. Longer runs there mean more rows still `queued` when the ten-minute
       * reclaim window closes — the population that showed up in production as `failed` at `$0.00`.
       *
       * `startChase` was extracted so the two doors could not drift. This was the last place they had.
       */
      constraints: clampConstraints(
        {},
        cfg.maxCostCeilingUsd,
        cfg.maxRuntimeCeilingS,
        spawned,
        args.task_type,
      ),
      tools: [],
      output_schema: spawned?.manifest.task_types?.[args.task_type]?.output_schema,
      source: args.source,
      client_id: args.client_id,
      assigned_to: "agent",
      status: "queued",
      cost_usd: 0,
      created_at: at,
      updated_at: at,
    };
    await store.createTask(task);
    await enqueueTask(store, task.id);
    return task.id;
  };

  mountRequestRoutes(app, {
    domain,
    store,
    accessible,
    writeProjectId,
    clientInProject,
    // The SAME post-and-spawn the reply route uses. A second implementation would drift on actor
    // scoping, constraints and case attribution — see `RequestRouteDeps.spawnFromThread`.
    spawnFromThread,
    /**
     * The founder attaching the document their client already sent them.
     *
     * `ingestUpload` is a closure over `store` and the artifact backend and cannot be imported, so
     * it is handed over the same way `spawnFromThread` is. The tenancy check is done by the CALLER
     * (the request must be in an accessible project) and re-done here against the task, because
     * ownership at route time is not ownership at write time.
     */
    uploadToTask: async (c, taskId, projectId) => {
      const t = await store.getTask(taskId);
      if (!t || t.project_id !== projectId) return c.json({ error: "not found" }, 404);
      const scope = c.get("scope");
      const art = await ingestUpload(c, t.id, { uploadedBy: scope?.member_id ?? "product-key" });
      if ("error" in art) return c.json({ error: art.error }, art.status as 400);
      return c.json(stripArtifactContent(art.artifact), 201);
    },
    // The two capabilities the nudge carrier needs. Registered from here, exactly as the chase's
    // are, so a nudge the sweep starts and one a founder starts differ in nothing but their `source`.
    wedgeEnabled,
    spawnTask: spawnKernelTask,
  });

  /**
   * ── Services Mycel wrote ── /v1/services/drafts* lives in authored.routes.ts.
   *
   * Mounted here rather than written inline for the reason every other `*.routes.ts` gives: the
   * tenancy argument for this surface is long and belongs next to the routes it governs, not eight
   * thousand lines into this file where the next person will not find it.
   */
  mountAuthoredRoutes(app, {
    store,
    accessible,
    writeProjectId,
    // A promotion with no name on it is not a decision anybody can be asked about later. Both auth
    // planes produce one: a member session names the person, an API key names the key's project.
    actorId: (c) => {
      const scope = c.get("scope") as { member_id?: string; project_id?: string } | undefined;
      return scope?.member_id ?? (scope?.project_id ? `key:${scope.project_id}` : "unknown");
    },
  });

  // ── The client signing off ── /v1/portal/approvals/* lives in portal-approvals.ts. It reuses
  // `resolveApproval` verbatim; the whole of the work there is scoping and redaction.
  mountPortalApprovals(app, { store });

  // ── The client speaking first ── POST /v1/portal/threads and GET /v1/portal/business live in
  // portal-threads.ts. Mounted here, below the `/v1/portal/*` session middleware, so `c.get("client")`
  // is set: registration order is what decides that in Hono, and a portal route declared above it
  // would be answered by the product-key check with a bare 401 (see the note on that middleware).
  //
  // `spawnFromThread` is handed over rather than reimplemented — the same one the reply route calls.
  mountPortalThreads(app, {
    domain,
    spawnFromThread,
    brandKit: (id) => identity.brandKit(id),
    listChannels: () => domain.listChannels(),
    store,
  });

  // ── The fulfilment loop ── /v1/internal/deliverables/*, /v1/deliverables/* and
  // /v1/portal/deliverables/* live in deliverables.routes.ts. Three planes, one file, because the
  // whole value of the loop is that the agent's, the founder's and the client's halves cannot drift.
  setDeliverableDeps({
    wedgeEnabled,
    // The `wedgeCarriesNudge` question, asked of the verdict task type. Resolved from what the
    // manifest DECLARES — never from a directory name, which is the law roles.ts exists to enforce.
    wedgeCarries: (wedge, taskType) => !!loadWedge(wedge)?.manifest.task_types?.[taskType],
  });
  mountDeliverableRoutes(app, {
    store,
    domain,
    accessible,
    writeProjectId,
    getActionGrant,
    // Injected rather than re-derived: `serveArtifact` already strips header injection out of the
    // filename, rewrites executable content types and sets `nosniff`. A second download path that
    // got one of those wrong would be a stored-XSS on the founder's own domain.
    withContent,
    serveArtifact,
    // Same spawn the wait resume uses — regenerate must not invent a second path.
    spawnTask: spawnKernelTask,
    /**
     * ═══ TELL THE CLIENT THE WORK IS READY ═══
     *
     * Measured in production on 14 September: fifteen of fifteen released deliverables, every
     * tenant, zero outbound messages to that client within a day of the release. The founder pressed
     * Release, the row moved to `with_client`, and nothing happened anywhere a customer could see
     * it. `THE-BAR.md` gate 1 — "0 of 8 accepted" — had been read as a quality problem for weeks.
     *
     * Wired HERE because reaching a customer needs the connection planner, the action executor and
     * the tenant's portal address, and all three live in this file. `release-announce.ts` holds the
     * decisions; this holds the plumbing.
     *
     * It sends without an approval, and that does not break "a human on every send": releasing IS
     * the send. The founder read the draft and pressed the button that moves it to the client. The
     * precedent is the invoice mail below, on the same argument and through the same two calls.
     */
    announceRelease: (d, version) =>
      announceRelease(
        {
          getClient: (id) => domain.getClient(id),
          mintLink: (a) => mintPortalLink(a),
          portalBase: (projectId) => {
            /*
              A custom domain beats a slug, and an explicit env beats both — a self-hoster's portal
              is not under `mycelai.dev` and a link that points there is a link to somebody else's
              product. `undefined` is a real answer: a tenant can be delivering work before its
              portal address is live, and `announceRelease` still sends, without a link.
            */
            const override = process.env.MYCEL_PORTAL_URL?.trim();
            if (override) return override;
            const p = identity.getProject(projectId);
            if (!p) return undefined;
            if (p.custom_domain) return `https://${p.custom_domain}`;
            const site = process.env.MYCEL_APPS_DOMAIN?.trim() || process.env.MYCEL_ROOT_DOMAIN?.trim() || "mycelai.dev";
            return p.slug ? `https://${p.slug}.${site}` : undefined;
          },
          send: async ({ project_id, to, subject, text }) => {
            const connections = (await domain.listConnections()).filter((cn) => cn.project_id === project_id);
            const plan = planSendEmail({ project_id, connections, send: { to: [to], subject, text } });
            // A refusal is the founder's sentence — no mailbox connected, two connected and no rule
            // for which. Never swallowed into a boolean; see the invoice send.
            if (!plan.ok) return { ok: false, detail: plan.refusal };
            const conn = await domain.getConnection(plan.call.connection_id);
            if (!conn || conn.project_id !== project_id) {
              return { ok: false, detail: "the mailbox this send resolved to is not connected to this business" };
            }
            const res = await executeAction(conn, "send_email", { ...plan.call.arguments, arguments: plan.call.arguments, to });
            return { ok: res.ok, detail: res.detail };
          },
        },
        d,
        version,
      ),
  });

  // ── Accounts receivable ── /v1/invoices/* and /v1/portal/invoices/* live in invoices.routes.ts.
  mountInvoiceRoutes(app, {
    accessible,
    writeProjectId,
    clientInProject,
    wedgeEnabled,
    // The SAME closure the nudge and the resume spawn through. See `spawnKernelTask`.
    spawnTask: spawnKernelTask,
    /**
     * The chase runs still in flight for one invoice, so a payment landing can stop them.
     *
     * THE TENANCY IS DONE HERE BECAUSE IT CAN ONLY BE DONE HERE. `Store.listTasks` filters on
     * status/wedge/client_id and has no project dimension, so the `project_id` check is a post-filter
     * on the fetched page — acceptable only because the page is already narrowed to one wedge and a
     * handful of live statuses, and because the alternative (handing `dunning.ts` the store) would
     * put the tenant rule somewhere it can be forgotten. Both the project AND the invoice id must
     * match: matching on invoice id alone would let a guessed id cancel another tenant's run.
     *
     * The statuses are every non-terminal one a chase can be sitting in. `awaiting_approval` is the
     * important one — that is a written dunning email waiting for a human to press send.
     */
    openChasesFor: async ({ project_id, invoice_id }) => {
      const wedge = dunningWedge();
      if (!wedge || !project_id || !invoice_id) return [];
      const live: TaskStatus[] = ["queued", "provisioning", "running", "awaiting_approval", "awaiting_batch", "validating"];
      const found: string[] = [];
      for (const status of live) {
        for (const t of await store.listTasks({ status, wedge, limit: 200 })) {
          if (t.project_id !== project_id) continue;
          if (t.task_type !== CHASE_TASK_TYPE) continue;
          if ((t.input as Record<string, unknown> | undefined)?.invoice_id !== invoice_id) continue;
          found.push(t.id);
        }
      }
      return [...new Set(found)];
    },
    /**
     * Render an invoice into the project's brand and attach it to a run.
     *
     * Three tenant checks, in order, and all three matter: the task must exist, it must belong to
     * the SAME project as the invoice (otherwise a founder with two businesses could hang one's
     * invoice off the other's run and hand it to the wrong client), and the project must resolve to
     * a brand kit. `identity.brandKit` fails closed on an unknown id rather than returning house
     * branding, so an invoice never renders under a default brand by accident.
     */
    attachInvoiceDocument: async ({ task_id, invoice, format, kind }) => {
      const t = await store.getTask(task_id);
      if (!t || t.project_id !== invoice.project_id) return undefined;
      const kit = identity.brandKit(invoice.project_id);
      if (!kit) return undefined;
      // Who it is addressed to. Read here, not in the template — a template is a pure function of
      // what it is handed, which is what makes its output testable.
      const client = invoice.client_id ? await domain.getClient(invoice.client_id) : undefined;
      const clientAddress = Array.isArray(client?.metadata?.address)
        ? (client!.metadata.address as unknown[]).map(String).filter(Boolean)
        : typeof client?.metadata?.address === "string"
          ? String(client.metadata.address).split(/\n/).map((l) => l.trim()).filter(Boolean)
          : undefined;
      const billTo = client
        ? { name: client.display_name, email: client.handles?.find((h) => h.includes("@")), address: clientAddress }
        : undefined;
      const rails = invoice.project_id
        ? await getPaymentRails(invoice.project_id).catch(() => undefined)
        : undefined;
      /**
       * Two templates, one render path, and the READS DIFFER BECAUSE THE DOCUMENTS DO.
       *
       * A receipt needs the payment rows and must NOT carry payment instructions (bank details on a
       * settled invoice invite a second payment). An invoice needs the rails and has no
       * payments worth listing. Both reads fail soft to an empty value rather than failing the
       * render: a document with no "how to pay" block is a worse invoice, but a chase that lost its
       * enclosure because a settings read timed out is a lost chase.
       */
      const doc =
        kind === "receipt"
          ? render(
              "receipt",
              {
                invoice,
                bill_to: billTo,
                payments: await getBillingStore()
                  .listExternalPayments({ project_id: invoice.project_id, invoice_id: invoice.id })
                  .catch((e) => {
                    console.error(`[mycel] could not read the payments behind invoice ${invoice.id}:`, e);
                    return [];
                  }),
              },
              kit,
              format,
            )
          : render(
              "invoice",
              {
                invoice,
                bill_to: billTo,
                seller: rails?.seller,
                seller_missing: rails ? sellerMissingSentence(rails.seller) : undefined,
                how_to_pay: await howToPay(invoice).catch((e) => {
                  console.error(`[mycel] could not read how to pay for invoice ${invoice.id}:`, e);
                  return undefined;
                }),
                payment_instructions: await getPaymentInstructions(invoice.project_id).catch((e) => {
                  console.error(`[mycel] could not read payment instructions for project ${invoice.project_id}:`, e);
                  return [] as string[];
                }),
              },
              kit,
              format,
            );
      const artifact = await store.addArtifact({
        task_id,
        name: doc.name,
        content_type: doc.content_type,
        content: doc.content,
        encoding: doc.encoding,
        size_bytes: doc.size_bytes,
        source: "agent",
        client_id: invoice.client_id,
      });
      // Through the SAME artifact backend as every other artifact, so `MYCEL_ARTIFACTS=s3` moves
      // invoice PDFs off the database without this code knowing that happened.
      const backend = await getArtifactBackend();
      if (!backend.inline) await backend.put(artifact.id, artifact.content);
      await emitEvent(store, task_id, "artifact.created", {
        artifact_id: artifact.id,
        name: artifact.name,
        content_type: artifact.content_type,
        size_bytes: artifact.size_bytes,
        source: "agent",
      });
      return {
        artifact_id: artifact.id,
        name: artifact.name,
        content_type: artifact.content_type,
        size_bytes: doc.size_bytes,
      };
    },
  });

  // ── Composio: OAuth, brokered ──
  // The founder clicks once per toolkit; Composio owns the callback and the refresh cycle. Mycel
  // exposes no public redirect route, so there's no internet-facing OAuth surface here and no
  // half-finished grant to persist — we ask Composio for the status when we want to know.
  /**
   * A toolkit's auth requirements, cached.
   *
   * `GET /toolkits/{slug}` is now on the critical path of every connect, so it cannot be a fresh
   * upstream round trip per click. Requirements change on Composio's release schedule, not ours; the
   * one case where staleness bites — a toolkit we believe is managed and isn't — is handled by
   * invalidating this entry the moment Composio says so, rather than by a short TTL.
   */
  const TOOLKIT_AUTH_TTL_MS = 10 * 60_000;
  const toolkitAuthCache = new Map<string, { at: number; value: ComposioToolkitAuth }>();
  const toolkitAuthOf = async (
    cfg: ReturnType<typeof composioConfig> & {},
    slug: string,
  ): Promise<ComposioToolkitAuth | undefined> => {
    const hit = toolkitAuthCache.get(slug);
    if (hit && Date.now() - hit.at < TOOLKIT_AUTH_TTL_MS) return hit.value;
    try {
      const value = await composioToolkitAuth(cfg, slug);
      toolkitAuthCache.set(slug, { at: Date.now(), value });
      return value;
    } catch {
      // Not fatal. If we cannot read the toolkit we fall back to the old behaviour (managed OAuth),
      // which is right for the ~120 toolkits it was ever right for, and the managed-auth rejection
      // below still turns the failure into a sentence a founder can act on.
      return undefined;
    }
  };

  /** What a connect request may carry. `credentials` configure the auth config (the founder's own
   *  OAuth client); `fields` configure the connection itself (the API key, a subdomain). */
  interface ConnectBody {
    auth_scheme?: string;
    credentials?: Record<string, unknown>;
    fields?: Record<string, unknown>;
  }

  /** Only strings, and only non-empty ones — a blank input is an unanswered field, not an answer. */
  const strings = (raw: unknown): Record<string, string> => {
    const out: Record<string, string> = {};
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === "string" && v.trim()) out[k] = v;
      else if (typeof v === "number" || typeof v === "boolean") out[k] = String(v);
    }
    return out;
  };

  type ConnectPlanned = {
    scheme: ComposioAuthScheme;
    managed: boolean;
    toolkitName: string;
    /** Goes to `POST /auth_configs` under `credentials`. */
    configCredentials: Record<string, string>;
    /** Goes to `POST /connected_accounts` under `connection.state.val`. */
    connectCredentials: Record<string, string>;
    /** Everything the founder typed that Composio marked secret. Sealed, never stored in `config`. */
    secrets: Record<string, string>;
  };

  type ConnectRefused = {
    /** The sentence the founder reads. Never Composio's prose about auth configs. */
    error: string;
    /** Exactly which fields to render, so the UI can ask for them instead of guessing. */
    needs: { auth_scheme: string; credentials: ComposioAuthField[]; fields: ComposioAuthField[] };
  };

  /**
   * Decide how to connect a toolkit, and refuse — with the requirement — when we cannot.
   *
   * This is the branch the founder report was missing. Composio provides managed OAuth credentials
   * for a subset of its catalogue; outside it, connecting means either the founder's own OAuth app
   * or a scheme that isn't OAuth at all. Asking the toolkit first is the only way to know which.
   *
   * Pure given the toolkit detail and the request, so the two connect routes cannot drift apart.
   */
  const planConnectFor = (
    detail: ComposioToolkitAuth | undefined,
    toolkit: string,
    body: ConnectBody,
  ): ConnectPlanned | ConnectRefused | { invalid: string } => {
    const requested = body.auth_scheme ? parseAuthScheme(body.auth_scheme) : undefined;
    if (body.auth_scheme && !requested) return { invalid: `unknown auth scheme "${body.auth_scheme}"` };

    /**
     * No detail, or detail that declares no schemes at all: try the one-click path anyway.
     *
     * Optimism is the right default HERE and nowhere else. Managed OAuth succeeds for the toolkits
     * a founder actually reaches for, and when it doesn't, Composio says so in a single 400 that the
     * caller turns into the real requirement. The failure mode of the opposite default — demanding
     * an OAuth client id for Gmail because a metadata read timed out — is worse and silent.
     */
    if (!detail || detail.connect.requirement === "unknown") {
      return {
        scheme: requested ?? "OAUTH2",
        managed: !requested || requested === "OAUTH2",
        toolkitName: toolkit,
        configCredentials: strings(body.credentials),
        connectCredentials: strings(body.fields),
        secrets: { ...strings(body.credentials), ...strings(body.fields) },
      };
    }

    /**
     * A NO-AUTH TOOLKIT HAS NOTHING TO CONNECT, AND SAYING SO IS OUR JOB, NOT THE BROKER'S.
     *
     * Composio's own meta-toolkits (Composio, Composio Search, Code Interpreter) require no
     * authentication. `POST /auth_configs` for one of them is an error by construction at the
     * broker, so this request cannot be made to succeed by any credential or retry. Before this
     * guard the founder got the broker's sentence quoted back at them as a failure — *"cannot
     * create an auth config for Toolkit Composio because it does not require authentication"* —
     * which reads as something being broken rather than as nothing being needed.
     *
     * 400 with a plain sentence, not 502: the request is the thing that is wrong. The UI's real fix
     * is upstream of here — `planConnect` marks these `requirement: "none"` and the card offers no
     * button at all — so reaching this line means a stale catalogue or a hand-made call, and both
     * deserve the true reason rather than a broker error.
     */
    if (detail.no_auth) {
      return {
        invalid: `${detail.name} needs no connection — it requires no sign-in and is already available to the agent.`,
      };
    }

    if (requested && detail.auth_schemes.length && !detail.auth_schemes.includes(requested)) {
      return { invalid: `${detail.name} does not support ${requested}` };
    }
    const scheme = requested ?? detail.connect.scheme;
    const entry = detail.schemes.find((s) => s.scheme === scheme);
    const managed = detail.managed_schemes.includes(scheme);

    const supplied = { credentials: strings(body.credentials), fields: strings(body.fields) };
    // Managed means Composio's own client id and secret. Anything the founder sent for the auth
    // config is dropped rather than forwarded — there is nothing on the other side to receive it.
    const configWanted = managed ? [] : (entry?.config_fields ?? []);
    const connectWanted = entry?.connect_fields ?? [];

    const missingConfig = configWanted.filter((f) => f.required && !supplied.credentials[f.name]);
    const missingConnect = connectWanted.filter((f) => f.required && !supplied.fields[f.name]);
    if (missingConfig.length || missingConnect.length) {
      return {
        error: requirementMessage({ toolkitName: detail.name, scheme }),
        needs: { auth_scheme: scheme, credentials: configWanted, fields: connectWanted },
      };
    }

    // Forward only fields the toolkit declared. A key allowlist has bitten this codebase before, so
    // to be clear about the direction of the risk: the danger here is the opposite one — passing a
    // caller-chosen key straight into a provider credential blob.
    const pick = (want: ComposioAuthField[], from: Record<string, string>) =>
      Object.fromEntries(want.filter((f) => from[f.name] !== undefined).map((f) => [f.name, from[f.name]]));
    const configCredentials = pick(configWanted, supplied.credentials);
    const connectCredentials = pick(connectWanted, supplied.fields);
    const secretNames = new Set(
      [...configWanted, ...connectWanted].filter((f) => f.is_secret).map((f) => f.name),
    );
    return {
      scheme,
      managed,
      toolkitName: detail.name,
      configCredentials,
      connectCredentials,
      secrets: Object.fromEntries(
        [...Object.entries(configCredentials), ...Object.entries(connectCredentials)].filter(([k]) =>
          secretNames.has(k),
        ),
      ),
    };
  };

  /**
   * Where a Composio connection's founder-supplied credentials live.
   *
   * NOT `conn.id` — that key is the generic connection secret, and `resolveSecret` falls back to it,
   * so reusing it here would make an OAuth client secret resolvable as if it were the connection's
   * own credential. Namespaced instead, and sealed by the vault exactly like LinkedIn's session.
   */
  const composioVaultKey = (connectionId: string) => `composio:${connectionId}`;

  /**
   * Remember what the founder pasted, so Reconnect does not demand it a second time.
   *
   * The values also go to Composio — that is the point of them — but Composio will not give them
   * back, and an expired API key that needs re-attaching is a bad moment to discover the founder no
   * longer has the original. Sealed with AES-256-GCM by secrets.ts; the connection's `config`, which
   * is returned by the API and rendered in the UI, never sees any of it.
   */
  const rememberComposioSecrets = async (
    connectionId: string,
    parts: { credentials: Record<string, string>; fields: Record<string, string> },
  ) => {
    if (!Object.keys(parts.credentials).length && !Object.keys(parts.fields).length) return;
    const prior = await recallComposioSecrets(connectionId);
    await setSecret(
      composioVaultKey(connectionId),
      JSON.stringify({
        credentials: { ...prior.credentials, ...parts.credentials },
        fields: { ...prior.fields, ...parts.fields },
      }),
    );
  };

  const recallComposioSecrets = async (
    connectionId: string,
  ): Promise<{ credentials: Record<string, string>; fields: Record<string, string> }> => {
    const raw = await getSecret(composioVaultKey(connectionId));
    if (!raw) return { credentials: {}, fields: {} };
    try {
      const parsed = JSON.parse(raw) as { credentials?: unknown; fields?: unknown };
      return { credentials: strings(parsed.credentials), fields: strings(parsed.fields) };
    } catch {
      return { credentials: {}, fields: {} };
    }
  };

  /**
   * Finish a connection, honestly.
   *
   * A redirect scheme is not connected — the founder has not authorised anything yet — so nothing is
   * written and the catalogue keeps showing `pending` until `/composio/status` sees ACTIVE. A
   * credential scheme completes in this request, but "completes" is Composio's word to say, not
   * ours: we ask, and write `verified_at` only if the answer is ACTIVE. A pasted key that Composio
   * rejects must leave the app looking exactly as unconnected as it is.
   */
  const verifyComposioAccount = async (
    cfg: ReturnType<typeof composioConfig> & {},
    conn: Connection,
    connectedAccountId: string,
    initialStatus: string,
  ): Promise<{ status: string; active: boolean }> => {
    let status = initialStatus;
    if (status !== "ACTIVE") {
      try {
        status = (await composioStatus(cfg, connectedAccountId)).status;
      } catch {
        // Leave it as Composio first reported. An unreachable status endpoint is not evidence of a
        // working connection, and `verified_at` stays unset — which is the safe direction.
      }
    }
    const active = status === "ACTIVE";
    if (active) {
      const fresh = (await getDomainStore().getConnection(conn.id)) ?? conn;
      await getDomainStore().updateConnection(conn.id, {
        config: { ...fresh.config, verified_at: new Date().toISOString() },
      });
    }
    return { status, active };
  };

  /** Portal only surfaces asks addressed to the client — not candidate/contractor packets. */
  const isClientFacingParty = (r: { party_role?: string }) => !r.party_role || r.party_role === "client";

  /** Resolve a connection invite once OAuth is ACTIVE — same atomic resolve as a typed answer. */
  const resolveConnectionRequest = async (
    projectId: string,
    requestId: string,
    toolkit: string,
    connectionId: string,
  ) => {
    await getRequestStore().resolveRequest(
      projectId,
      requestId,
      `Connected ${toolkit} (connection ${connectionId})`,
    );
  };

  /**
   * The one implementation of "connect this toolkit". Both routes are wrappers around it, because
   * the catalogue path and the blueprint path used to diverge and one of them was broken.
   */
  const runComposioConnect = async (args: {
    cfg: ReturnType<typeof composioConfig> & {};
    conn: Connection;
    toolkit: string;
    body: ConnectBody & { callback_url?: string };
    actor: string;
  }): Promise<{ status: 201 | 400 | 502; json: Record<string, unknown> }> => {
    const { cfg, conn, toolkit, body } = args;
    const cc = composioConnConfig(conn);

    // Anything the founder pasted on a previous attempt counts as supplied. Without this, "Connect"
    // on an already-configured app would re-demand a client secret they gave us weeks ago.
    const remembered = await recallComposioSecrets(conn.id);
    const merged: ConnectBody = {
      auth_scheme: body.auth_scheme ?? cc.auth_scheme,
      credentials: { ...remembered.credentials, ...strings(body.credentials) },
      fields: { ...remembered.fields, ...strings(body.fields) },
    };

    let detail = await toolkitAuthOf(cfg, toolkit);
    let plan = planConnectFor(detail, toolkit, merged);
    if ("invalid" in plan) return { status: 400, json: { error: plan.invalid } };
    if ("needs" in plan) return { status: 400, json: { error: plan.error, toolkit, ...plan.needs } };

    // Reuse the auth config only when it was built for the SAME scheme and carries no new
    // credentials — otherwise a founder correcting a mistyped client secret would keep the broken
    // config forever.
    const reusable =
      cc.auth_config_id &&
      (!cc.auth_scheme || cc.auth_scheme === plan.scheme) &&
      Object.keys(strings(body.credentials)).length === 0;

    let authConfigId = reusable ? cc.auth_config_id! : undefined;
    if (!authConfigId) {
      try {
        authConfigId = (
          await composioCreateAuthConfig(cfg, {
            toolkit,
            scheme: plan.scheme,
            managed: plan.managed,
            credentials: plan.configCredentials,
          })
        ).id;
      } catch (e) {
        /**
         * "Composio does not have managed credentials for this toolkit."
         *
         * We believed it was managed and it is not — a stale catalogue entry, or a toolkit Composio
         * moved. Drop the belief, re-read the toolkit, and come back with the real requirement.
         * This is the exact path that used to surface Composio's own sentence as a 502.
         */
        if (!isMissingManagedAuth(e)) throw e;
        toolkitAuthCache.delete(toolkit);
        detail = await toolkitAuthOf(cfg, toolkit);
        const retry = planConnectFor(detail, toolkit, { ...merged, auth_scheme: undefined });
        if ("invalid" in retry) return { status: 400, json: { error: retry.invalid } };
        if ("needs" in retry) return { status: 400, json: { error: retry.error, toolkit, ...retry.needs } };
        if (retry.managed) {
          // Still nothing to ask for and still refused: we genuinely cannot connect this one.
          return {
            status: 400,
            json: {
              error: `${retry.toolkitName} cannot be connected yet — the broker has no shared credentials for it and publishes no way to supply your own.`,
              toolkit,
            },
          };
        }
        plan = retry;
        authConfigId = (
          await composioCreateAuthConfig(cfg, {
            toolkit,
            scheme: retry.scheme,
            managed: false,
            credentials: retry.configCredentials,
          })
        ).id;
      }
    }

    const redirect = isRedirectScheme(plan.scheme);
    const out = await composioInitiate(cfg, {
      authConfigId,
      // Derived from the connection's owner, never from the request body — the whole point of the
      // per-client mapping is that nobody can ask to be someone else's Composio user.
      userId: composioUserId(conn),
      callbackUrl: body.callback_url,
      scheme: plan.scheme,
      // Only a non-redirect scheme carries a credential up front; an OAuth flow has none yet.
      credentials: redirect ? undefined : plan.connectCredentials,
    });

    await getDomainStore().updateConnection(conn.id, {
      config: {
        ...conn.config,
        toolkit,
        auth_config_id: authConfigId,
        auth_scheme: plan.scheme,
        connected_account_id: out.connected_account_id,
        // A fresh connect invalidates any previous verdict: whatever this account was, it is now
        // whatever the new attempt makes it, and `verifyComposioAccount` decides that.
        verified_at: undefined,
      },
    });
    await rememberComposioSecrets(conn.id, {
      credentials: plan.configCredentials,
      fields: plan.connectCredentials,
    });

    const verdict = redirect
      ? { status: out.status, active: false }
      : await verifyComposioAccount(cfg, conn, out.connected_account_id, out.status);

    await audit({
      project_id: conn.project_id ?? "",
      actor: args.actor,
      action: "connection.linked",
      entity: "connection",
      entity_id: conn.id,
      // The connected-account id is a reference, not a credential. The token stays at Composio, and
      // nothing the founder typed appears here.
      detail: {
        connection: conn.name,
        toolkit,
        auth_scheme: plan.scheme,
        composio_managed: plan.managed,
        connected_account_id: out.connected_account_id,
      },
    });

    return {
      status: 201,
      json: {
        connected_account_id: out.connected_account_id,
        status: verdict.status,
        redirect_url: out.redirect_url,
        connection_id: conn.id,
        toolkit,
        auth_scheme: plan.scheme,
        composio_managed: plan.managed,
        /** True only when Composio already reports the account ACTIVE — the API-key case. */
        connected: verdict.active,
      },
    };
  };

  const composioConn = async (c: import("hono").Context) => {
    const conn = await domain.getConnection(c.req.param("id") ?? "");
    if (!conn || !inScope(accessible(c), conn.project_id)) return { error: "not found" as const, status: 404 as const };
    if (conn.kind !== "composio") return { error: "not a composio connection" as const, status: 400 as const };
    const cfg = composioConfig();
    if (!cfg) return { error: "COMPOSIO_API_KEY is not set on the harness" as const, status: 501 as const };
    return { conn, cfg };
  };

  /**
   * TAKE A CONNECTION BACK.
   *
   * ═══ IT DID NOT EXIST, AND THAT WAS THE WHOLE PROBLEM ═══
   *
   * A founder could connect a mailbox, a bank feed or an accounting system and had no way to
   * disconnect one. `deleteConnection` was on the store interface and implemented in both backends,
   * and the only caller was a LinkedIn internal. Every credential a business ever attached was
   * permanent as far as the product was concerned.
   *
   * a comparable runtime hit the same shape in `lib/session-rescope.ts` and named it exactly: their per-session
   * secret allowlist was create-only, justified by an argument about BOOT — that a narrowed list
   * "could leave the session unbootable" — and "it silently became a refusal to change anything at
   * all." Ours had no argument at all; the route was simply never written.
   *
   * ═══ WHAT REVOKING DOES AND DOES NOT PROMISE ═══
   *
   * Their contract is the honest one and it is the one stated here, because a UI that overpromises
   * about a credential is how a credential gets left in place:
   *
   *   · GOING FORWARD IT IS EXACT — and ours is stronger than theirs. The action proxy re-reads
   *     `listConnections()` on every action and intersects it with the run's grant, so a connection
   *     deleted mid-run stops working for a run ALREADY IN FLIGHT, not merely for the next one.
   *   · RETROACTIVELY IT PROMISES NOTHING, and must not pretend to. Anything the agent already read
   *     is in its context and in whatever it has already sent. Revoking is "stop handing it out",
   *     never "unsay it".
   *
   * The response says both, in those terms, so a founder is not told "revoked" when the truth is
   * "revoked for anything that happens from now on".
   *
   * ═══ AND IT TAKES THE THINGS THAT HANG OFF IT ═══
   *
   * `deleteConnection` already removes the trigger subscriptions and channels bound to the
   * connection, which is what stops an inbound webhook arriving for a mailbox nobody can read any
   * more. A row left behind there would keep waking runs that cannot act.
   */
  app.delete("/v1/connections/:id", async (c) => {
    const projectId = writeProjectId(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    const id = c.req.param("id") ?? "";
    const conn = (await domain.listConnections()).find((x) => x.id === id);
    // The tenancy check is the same shape every other write here uses, and it fails closed: a
    // connection that is not this project's is answered "not found" rather than "forbidden", so the
    // route cannot be used to discover which ids exist elsewhere.
    if (!conn || conn.project_id !== projectId) return c.json({ error: "not found" }, 404);

    const removed = await domain.deleteConnection(id);
    if (!removed) return c.json({ error: "not found" }, 404);

    await audit({
      project_id: projectId,
      actor: c.get("scope")?.member_id ?? "member",
      action: "connection.revoked",
      entity: "connection",
      entity_id: id,
      detail: { kind: conn.kind, name: conn.name, owner: conn.owner },
    });

    return c.json({
      ok: true,
      revoked: { id, kind: conn.kind, name: conn.name },
      /**
       * Said in the response rather than left to the console to invent, so every surface tells the
       * same true thing. See the header: forward-exact, retroactively nothing.
       */
      note:
        `Nothing can be sent or read through "${conn.name}" from now on, including any job that is ` +
        `running right now. It does not undo anything already sent, and anything already read is ` +
        `still in the record of the jobs that read it.`,
    });
  });

  app.post("/v1/connections/:id/composio/connect", async (c) => {
    const r = await composioConn(c);
    if ("error" in r) return c.json({ error: r.error }, r.status);
    const { conn, cfg } = r;
    const cc = composioConnConfig(conn);
    const body = (await c.req.json().catch(() => ({}))) as ConnectBody & {
      auth_config_id?: string;
      callback_url?: string;
    };
    // A connection that came from a BLUEPRINT declares `{toolkit: "xero"}` with no auth config id
    // (it can't — those are per-project), so this route has to be able to create one. Two routes to
    // the same outcome, and they now share one implementation rather than drifting.
    if (!cc.toolkit && !body.auth_config_id) {
      return c.json({ error: "connection has no config.toolkit" }, 400);
    }
    try {
      // An explicitly-passed auth config short-circuits discovery: the caller has already decided.
      const seeded = body.auth_config_id
        ? ((await domain.updateConnection(conn.id, {
            config: { ...conn.config, auth_config_id: body.auth_config_id },
          })) ?? conn)
        : conn;
      const r = await runComposioConnect({
        cfg,
        conn: seeded,
        toolkit: cc.toolkit,
        body,
        actor: (c.get("scope").member_id ?? "system") as string,
      });
      return c.json(r.json, r.status);
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
      const active = st.status === "ACTIVE";

      /**
       * Persist the verdict, both ways.
       *
       * Nothing wrote `verified_at` before, so the catalogue had no way to tell a finished OAuth
       * flow from an abandoned one and fell back to "a row exists" — which is how an app the
       * founder never authorised showed a green connected pill.
       *
       * Clearing it on a non-ACTIVE answer matters as much as setting it: a revoked or expired
       * account must stop claiming to work, and a connection that silently keeps its badge after
       * being revoked sends the agent to fail at the moment it tries to do real work.
       */
      const already = !!(r.conn.config as Record<string, unknown>).verified_at;
      if (active !== already) {
        await getDomainStore().updateConnection(r.conn.id, {
          config: { ...r.conn.config, verified_at: active ? new Date().toISOString() : undefined },
        });
      }
      return c.json({ ...st, active });
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

  /**
   * The capabilities the wedges on THIS project declare — the same set `needed_by` is derived from.
   *
   * Extracted so the toolkit marks and the capabilities route cannot disagree about what this
   * business asked for. Membership is a SCHEDULE for the wedge, not a file on disk; every install
   * ships every blueprint, so disk presence says nothing. See the long note on `/v1/capabilities`.
   */
  const declaredCapabilities = async (projectId: string): Promise<Set<string>> => {
    const slugs = projectWedgeSlugs({
      schedules: await domain.listSchedules(),
      projectId,
      allows: (w) => identity.projectAllowsWedge(projectId, w),
      authored: isAuthoredSlug,
    });
    const loaded = await Promise.all(slugs.map((s) => loadProjectWedge(projectId, s).catch(() => null)));
    return new Set(loaded.flatMap((w) => (w?.manifest.capabilities ?? []) as string[]));
  };

  app.get("/v1/composio/toolkits", async (c) => {
    const cfg = composioConfig();
    if (!cfg) return c.json({ error: "COMPOSIO_API_KEY is not set on the harness" }, 501);
    const yes = (v: string | undefined) => ["1", "true", "yes"].includes((v ?? "").toLowerCase());
    const connectedOnly = yes(c.req.query("connected"));
    /**
     * `connected=1` IMPLIES the whole catalogue, and getting this wrong was a real bug I shipped.
     *
     * Without `all`, the fetch below is Composio's FIRST PAGE. Filtering that to the connected ones
     * answers "which of the first fifty toolkits have you connected", which is not the question —
     * a founder whose Xero sits on page three would have seen no marks at all, and the failure is
     * silent because an empty list is a legitimate answer for an account with nothing connected.
     *
     * `fullCatalogue` is CACHED behind a TTL, so this is also the cheaper branch after the first
     * call, not the expensive one it looks like.
     */
    const all = yes(c.req.query("all")) || connectedOnly;
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
      /**
       * A connection ROW is not a connection.
       *
       * `POST /connect` creates the row and stores `connected_account_id` the moment Composio hands
       * back a redirect URL — before the founder has authorised anything. Abandon the OAuth screen
       * and the row survives, so the catalogue showed ClickUp as connected to someone who never
       * finished connecting it. Worse than cosmetic: the agent would then be told the capability
       * exists, reach for it, and fail at the point of doing real work.
       *
       * The truth lives on `verified_at`, written only when Composio reports the account ACTIVE.
       * Everything else is `pending` — a state the catalogue can show honestly, with a way to
       * resume, rather than a lie with a green pill on it.
       */
      const mine = new Map(
        conns
          .filter((x) => x.kind === "composio" && inScope(set, x.project_id))
          .map((x) => [composioConnConfig(x).toolkit, x]),
      );
      const isLive = (conn: Connection | undefined): boolean =>
        !!conn && !!(conn.config as Record<string, unknown>).verified_at;
      /**
       * ═══ `connected=1` — THE FEW THIS BUSINESS ACTUALLY RUNS ON ═══
       *
       * Home wants to show the marks of the apps a founder has connected, and the only way to get
       * a logo was `all=1`: Composio's entire published catalogue, ~1,000 toolkits, to render three
       * 16px icons in a header. That is the sort of cost that gets a good idea cancelled.
       *
       * Filtered AFTER the catalogue is fetched rather than asked of Composio, because "connected"
       * is OUR fact — it lives in `verified_at` on our own connection rows — and the broker has no
       * opinion about it. Pending connections are excluded: a half-finished OAuth flow is not an
       * app this business runs on, and showing its logo would claim otherwise.
       */
      /**
       * ═══ AND `needed=1` — THE ONES THE WORK ITSELF ASKED FOR ═══
       *
       * `connected` alone put a Supabase logo on Home under the words "Your service". It is not a
       * service this business offers; it is our own plumbing, sitting in the same table as Xero
       * because both have credentials. This tenant's connected list is `xero`, `linkedin`,
       * `clickup` — and `neon`, `tavily`, `firecrawl`, `codeinterpreter`, `context7_mcp`,
       * `serpapi`, `composio`. Seven of ten are infrastructure a founder never chose and cannot
       * act on.
       *
       * `CapabilityStatus.needed_by` already carries the rule, in its own words: "Empty means
       * nothing here asked for it, and it must not be shown — a plumber offered a bank feed is the
       * nag this all came from." The marks were the one surface that bypassed it.
       *
       * Resolved HERE and not in cloud because the capability→toolkit table lives here
       * (`DEFAULT_CAPABILITY_PROVIDERS`), and a second copy of it over the wire is a second thing
       * to keep in step. Deliberately NOT a denylist of dev tools: the list of infrastructure
       * grows every time we add one, and the failure is silent. Asking what the work declared is
       * the question with a stable answer.
       */
      const neededOnly = yes(c.req.query("needed"));
      let wanted: Set<string> | undefined;
      if (neededOnly) {
        const projectId = c.req.header("x-mycel-project") ?? (set.size === 1 ? [...set][0] : undefined);
        const declared = projectId ? await declaredCapabilities(projectId) : new Set<string>();
        wanted = new Set(
          [...declared].flatMap((cap) =>
            isCapability(cap) ? capabilityProviders(cap).map((p) => p.toolkit.toLowerCase()) : [],
          ),
        );
      }
      const visible = list.items.filter(
        (t) =>
          (!connectedOnly || isLive(mine.get(t.slug))) && (!wanted || wanted.has(t.slug.toLowerCase())),
      );
      return c.json({
        ...list,
        items: visible.map((t) => {
          const conn = mine.get(t.slug);
          return {
            ...t,
            connection_id: conn?.id,
            connected: isLive(conn),
            // `pending` is a started-but-unfinished OAuth flow. Surfaced as its own state so the UI
            // can offer "finish connecting" instead of either lying or pretending nothing happened.
            pending: !!conn && !isLive(conn),
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

    const b = (await c.req.json().catch(() => ({}))) as ConnectBody & {
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

      /**
       * The row is created BEFORE anything is asked of Composio, and that ordering is deliberate.
       *
       * Founder-supplied secrets are keyed by connection id, so there has to be a connection to key
       * them to. The row on its own claims nothing: `verified_at` is what the catalogue reads, and
       * only Composio reporting ACTIVE writes it. A connect that stops at "Notion needs an API key"
       * therefore leaves an unverified row and an app that still reads as unconnected — which is
       * the truth.
       */
      const conn =
        existing ??
        (await domain.createConnection({
          project_id: projectId,
          kind: "composio",
          name: b.name ?? toolkit,
          owner,
          config: { toolkit, read_tools: b.read_tools ?? [] },
        }));
      if (existing && b.read_tools) {
        await domain.updateConnection(conn.id, {
          config: { ...conn.config, read_tools: b.read_tools },
        });
      }

      const r = await runComposioConnect({
        cfg,
        conn: (await domain.getConnection(conn.id)) ?? conn,
        toolkit,
        body: b,
        actor: (c.get("scope").member_id ?? "system") as string,
      });
      return c.json(r.json, r.status);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 502);
    }
  });

  /**
   * Client-plane twin of toolkit connect — clears a `connection` ClientRequest when OAuth completes.
   *
   * Owner is FORCED to the portal session's client. A client cannot connect a toolkit onto another
   * customer, and they cannot invent a toolkit that was not asked for on this request.
   */
  app.post("/v1/portal/requests/:id/connect", async (c) => {
    const sc = c.get("client") as { client_id: string; project_id: string } | undefined;
    if (!sc) return c.json({ error: "unauthorized" }, 401);
    const cfg = composioConfig();
    if (!cfg) return c.json({ error: "app connections are not configured on this deployment" }, 501);
    const req = await getRequestStore().getRequest(sc.project_id, c.req.param("id"));
    if (!req || req.client_id !== sc.client_id || !isClientFacingParty(req)) {
      return c.json({ error: "not found" }, 404);
    }
    if (req.kind !== "connection" || !req.connection_toolkit) {
      return c.json({ error: "this ask is not a connection invite" }, 400);
    }
    if (req.status !== "open") return c.json({ error: "that request is already closed" }, 409);

    const toolkit = req.connection_toolkit;
    const owner: ConnectionOwner = { kind: "client", id: sc.client_id };
    const b = (await c.req.json().catch(() => ({}))) as ConnectBody;
    try {
      const existing = (await domain.listConnections()).find(
        (x) =>
          x.project_id === sc.project_id &&
          x.kind === "composio" &&
          composioConnConfig(x).toolkit === toolkit &&
          x.owner.kind === owner.kind &&
          x.owner.id === owner.id,
      );
      const conn =
        existing ??
        (await domain.createConnection({
          project_id: sc.project_id,
          kind: "composio",
          name: toolkit,
          owner,
          config: { toolkit, read_tools: [] },
        }));
      const r = await runComposioConnect({
        cfg,
        conn: (await domain.getConnection(conn.id)) ?? conn,
        toolkit,
        body: b,
        actor: sc.client_id,
      });
      // Credential schemes can complete in one shot — clear the ask immediately.
      if (r.status === 201 && r.json.connected === true) {
        await resolveConnectionRequest(sc.project_id, req.id, toolkit, String(r.json.connection_id ?? conn.id));
      }
      return c.json({ ...r.json, request_id: req.id }, r.status);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 502);
    }
  });

  /** Poll a connection invite. When ACTIVE, resolve the ClientRequest (arms waits via request_resolved). */
  app.get("/v1/portal/requests/:id/connection-status", async (c) => {
    const sc = c.get("client") as { client_id: string; project_id: string } | undefined;
    if (!sc) return c.json({ error: "unauthorized" }, 401);
    const cfg = composioConfig();
    if (!cfg) return c.json({ error: "app connections are not configured on this deployment" }, 501);
    const req = await getRequestStore().getRequest(sc.project_id, c.req.param("id"));
    if (!req || req.client_id !== sc.client_id || !isClientFacingParty(req)) {
      return c.json({ error: "not found" }, 404);
    }
    if (req.kind !== "connection" || !req.connection_toolkit) {
      return c.json({ error: "this ask is not a connection invite" }, 400);
    }
    if (req.status === "resolved") {
      return c.json({ status: "ACTIVE", connected: true, request_status: "resolved" });
    }
    const toolkit = req.connection_toolkit;
    const conn = (await domain.listConnections()).find(
      (x) =>
        x.project_id === sc.project_id &&
        x.kind === "composio" &&
        composioConnConfig(x).toolkit === toolkit &&
        x.owner.kind === "client" &&
        x.owner.id === sc.client_id,
    );
    if (!conn) return c.json({ status: "INITIATED", connected: false, request_status: req.status });
    const cc = composioConnConfig(conn);
    if (!cc.connected_account_id) {
      return c.json({ status: "INITIATED", connected: false, request_status: req.status, connection_id: conn.id });
    }
    try {
      const st = await verifyComposioAccount(cfg, conn, cc.connected_account_id, "UNKNOWN");
      if (st.active && req.status === "open") {
        await resolveConnectionRequest(sc.project_id, req.id, toolkit, conn.id);
      }
      return c.json({
        status: st.status,
        connected: st.active,
        request_status: st.active ? "resolved" : req.status,
        connection_id: conn.id,
      });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 502);
    }
  });

  /**
   * What will connecting this app actually ask me for?
   *
   * The catalogue answers coarsely for a thousand apps at once (`connect.requirement`); this answers
   * precisely for the one the founder clicked, with the exact fields to render. Split because the
   * list endpoint cannot afford a per-toolkit round trip and the dialog cannot afford to guess.
   */
  app.get("/v1/composio/toolkits/:toolkit/auth", async (c) => {
    const cfg = composioConfig();
    if (!cfg) return c.json({ error: "COMPOSIO_API_KEY is not set on the harness" }, 501);
    const toolkit = (c.req.param("toolkit") ?? "").toLowerCase();
    if (!/^[a-z0-9_-]{1,64}$/.test(toolkit)) return c.json({ error: "invalid toolkit" }, 400);
    try {
      const detail = await composioToolkitAuth(cfg, toolkit);
      toolkitAuthCache.set(toolkit, { at: Date.now(), value: detail });
      return c.json(detail);
    } catch (e) {
      const status = e instanceof Error && "status" in e && (e as { status: number }).status === 404 ? 404 : 502;
      return c.json({ error: (e as Error).message }, status);
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
    if (!wedge) return c.json({ error: unknownService(b.wedge) }, 400);
    const types = wedge.manifest.task_types;
    if (types && Object.keys(types).length && !types[b.task_type]) {
      return c.json({ error: `the "${b.wedge}" service does not do "${b.task_type}"` }, 400);
    }
    if (!identity.projectAllowsWedge(conn.project_id ?? "", b.wedge)) {
      return c.json({ error: serviceNotEnabled(b.wedge) }, 403);
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
    /**
     * STRIPE PAYMENT, SETTLED HERE, BEFORE ANY RUN IS SPAWNED.
     *
     * A checkout.session.completed (or a succeeded charge) that names one of our invoices is
     * bookkeeping, not agent work. Settling it through `settleStripePayment` uses the same
     * idempotency ledger as the poll, so a double webhook cannot double-count, and a payload that
     * names another tenant's invoice is refused. The run still starts afterwards when the trigger
     * is configured to spawn one — noticing the money must not depend on that.
     *
     * `project_id` comes from the CONNECTION, never from the payload. A Stripe event that claims
     * to be for another project is the leak this check exists to make unrepresentable.
     */
    const toolkit = connection ? ((connection.config ?? {}) as Record<string, unknown>).toolkit : undefined;
    if (connection && connection.project_id && toolkit === "stripe") {
      const settlement = settlementFromStripeEvent(connection.project_id, event.data);
      if (settlement) {
        const settled = await settleStripePayment(settlement).catch((e) => {
          console.error(`[mycel] Stripe settlement from trigger failed:`, e);
          return undefined;
        });
        if (settled && !settled.applied && /not in project/.test(settled.detail)) {
          // Cross-tenant: acknowledge so Composio does not retry forever, and do not spawn a run
          // that would act on the wrong books.
          return c.json({ ok: true, ignored: settled.detail });
        }
      } else if (connection.project_id) {
        // Anything we could not name with certainty still goes through the poll, which is the
        // mechanism of record. Best-effort: a reconcile failure must not 500 a webhook Stripe
        // will retry into a loop.
        await reconcileProject({ project_id: connection.project_id }).catch((e) =>
          console.error(`[mycel] reconcile after Stripe trigger failed:`, e),
        );
      }
    }

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
    /**
     * A BROWSER SESSION IS CHECKED AGAINST ITS OWN ORIGIN, HERE, WHILE SOMEBODY IS STANDING THERE.
     *
     * These are captured by hand from a browser with several tabs open, and pasting the wrong tab
     * stores fine, mounts fine, and yields a run that browses a login page for twenty minutes and
     * reports the portal as empty. Nothing about that looks like a failure until somebody reads a
     * transcript. Caught at paste time it is one sentence to the person who still has the right tab
     * open.
     */
    if (conn.kind === BROWSER_CONNECTION_KIND) {
      const target = browserTarget(conn);
      if (!target) {
        return c.json({ error: "this connection has no usable https origin in config.origin" }, 400);
      }
      const state = parseSession(b.value);
      if (!state) {
        return c.json(
          { error: "that is not a browser session — expected a storage state with cookies or origins" },
          400,
        );
      }
      if (!sessionCovers(state, target.host)) {
        return c.json({ error: wrongSessionFor(state, target.host) }, 400);
      }
    }
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
    if (!loadWedge(String(b.wedge))) return c.json({ error: unknownService(b.wedge) }, 400);
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

  /**
   * ── Clients ── /v1/clients* lives in clients.routes.ts.
   *
   * Mounted here rather than written inline for the reason every other `*.routes.ts` gives: this
   * file was 10,460 lines, and a file that size cannot tell anybody where the next route belongs.
   */
  mountClientRoutes(app, { domain, store, accessible, writeProjectId, inScope });

  /**
   * ── Signatures ── /v1/envelopes* and /v1/portal/envelopes* live in signing.routes.ts.
   *
   * `readArtifact` is the one seam worth reading twice. It resolves the bytes the SAME way every
   * other reader does — `store.getArtifact` then `withContent` — rather than through a second path
   * of its own, because the integrity guarantee is "the signer was served these bytes and these
   * bytes are what is stored", and two ways of fetching a file is two chances for that to stop
   * being true. It returns undefined rather than throwing when the backend cannot produce content:
   * a missing document must fail the signature, not the request handler.
   */
  // The one ask this business has earned. See milestones.routes.ts for why it is a read on Home
  // rather than an email.
  mountMilestoneRoutes(app, { accessible, writeProjectId, inScope });

  mountSigningRoutes(app, {
    accessible,
    writeProjectId,
    inScope,
    // Read per request rather than captured: a founder who changes their letterhead should see it on
    // the next certificate they download, not on the next deploy.
    brandKit: (projectId) => getIdentityStore().brandKit(projectId),
    /**
     * The founder's uploaded revision, stored against the run that owns the document it replaces.
     *
     * Scoped twice on purpose. The previous artifact must belong to a task in THIS project (the same
     * check `readArtifact` makes below), and the upload then lands on that task — so a caller cannot
     * name somebody else's artifact to have their file filed under another tenant's run.
     */
    attachRevision: async (c, projectId, previousArtifactId) => {
      const prev = await store.getArtifact(previousArtifactId).catch(() => undefined);
      const owner = prev ? await store.getTask(prev.task_id).catch(() => undefined) : undefined;
      if (!owner || owner.project_id !== projectId) {
        return { error: "the agreement this replaces is no longer on file", status: 409 };
      }
      const scope = c.get("scope");
      const up = await ingestUpload(c, owner.id, { uploadedBy: scope?.member_id ?? "product-key" });
      if ("error" in up) return up;
      return {
        artifact_id: up.artifact.id,
        filename: up.artifact.name,
        // The DECODED length, which is what the envelope's `size_bytes` means everywhere else —
        // `sizeOf` is the one function allowed to answer that, because base64 is a third larger.
        size_bytes: up.artifact.size_bytes ?? sizeOf(up.artifact),
      };
    },
    readArtifact: async (projectId, artifactId) => {
      if (!artifactId) return undefined;
      const a = await store.getArtifact(artifactId).catch(() => undefined);
      if (!a) return undefined;
      const owner = await store.getTask(a.task_id).catch(() => undefined);
      if (!owner || owner.project_id !== projectId) return undefined;
      const full = await withContent(a).catch(() => undefined);
      if (!full?.content) return undefined;
      return Buffer.from(full.content, full.encoding === "base64" ? "base64" : "utf8");
    },
    /**
     * ═══ THE HOOK THAT WAS DECLARED HERE AND NEVER PASSED ═══
     *
     * `onExecuted` has been in `SigningRouteDeps` and called at both signature sites since the file
     * was written. Nobody ever supplied one. So a fully executed agreement did nothing at all: the
     * certificate sealed, the audit chain recorded it, and the founder's Deliverables screen stayed
     * empty forever. `openEngagementFromSignature` is what should have been on this line.
     *
     * Awaited rather than fired and forgotten, so a failure is at least logged inside the request —
     * but the function itself never throws past its own boundary, because a signature that is
     * recorded and a kickoff that is not is recoverable, and failing the route would tell a client
     * their signature did not go through when it did.
     */
    onExecuted: async (env) => {
      await openEngagementFromSignature(env, store).catch((e) =>
        console.error(`[mycel] envelope ${env.id} executed but no engagement opened:`, e),
      );
    },
  });


  /**
   * What this business can do, by capability — and for the ones it cannot, what it could connect.
   *
   * The one surface the onboarding connect step reads. It exists so that step can ask "which of
   * these do you use?" with real alternatives in the question, instead of rendering one app card off
   * a vendor slug an LLM or a JSON file happened to name.
   *
   * Scoped to ONE project, chosen the same way readiness chooses, and never aggregated across the
   * caller's projects: a capability binding names connection ids, and a list of another tenant's
   * connection ids is the leak this repo has shipped twice.
   */
  app.get("/v1/capabilities", async (c) => {
    const scope = c.get("scope");
    const projectId = c.req.query("project_id") ?? scope.project_id ?? [...accessible(c)][0];
    if (!projectId || !accessible(c).has(projectId)) return c.json({ error: "not found" }, 404);
    const conns = await domain.listConnections();
    /**
     * WHO ON THIS PROJECT ACTUALLY WANTS EACH CAPABILITY.
     *
     * The reason the list is not simply "all four". A plumber shown a question about bank feeds is
     * the exact failure the founder named — "I'm not a bookkeeping company, for fuck's sake" — and
     * it is caused by a surface that lists what the SOFTWARE can do rather than what THIS business
     * asked for. So a capability is attributed to the wedges that declare it AND are enabled here,
     * and a UI shows the ones with a claimant.
     */
    /**
     * ═══ THE GATE ABOVE WAS NEVER A GATE, AND THE FOUNDER SAW IT ═══
     *
     * This block used to be `readdirSync(wedgesDir())` narrowed by `identity.projectAllowsWedge`.
     * The comment above described the right rule; the code did not implement it, for one reason:
     * `projectAllowsWedge` is `p.wedges.length === 0 || p.wedges.includes(wedge)`, an empty
     * allowlist means "all wedges", and NOTHING in the kernel ever populates that list —
     * `createProject` takes `wedges = []` and the bootstrap project ships `[]`. So for every real
     * tenant the filter was a no-op and `enabled` was every wedge on disk, `books-keeper` included.
     *
     * The visible consequence, in production, on the sixth screen of onboarding, to a design
     * studio: *"Read the invoices you've raised — For Monthly Close for E-commerce"*, with Xero,
     * QuickBooks and FreshBooks under it. That is the founder's complaint verbatim: *"I'm not a
     * bookkeeping company, for fuck's sake."* It had been routed around in ONE consumer
     * (`cloud/lib/app-suggestions.ts`, whose header diagnoses this exact hazard correctly) and left
     * unfixed at the source, so every other consumer inherited it.
     *
     * WHAT MAKES A WEDGE THIS PROJECT'S: a SCHEDULE for it. That is the rule `app-suggestions.ts`
     * already applies and argues — a blueprint file on disk means nothing, since every install
     * ships all of them, and the durable trace that a business was actually set up is the schedule
     * setting it up creates. Matching on the schedule's `wedge` rather than its name survives a
     * rename.
     *
     * `loadProjectWedge` rather than `loadWedge`, and this is the second half of the same bug in
     * the opposite direction: authored wedges are per-project and NOT on disk, so the studio's own
     * service — the only wedge it genuinely runs — could never appear in `needed_by`. The route
     * reported every capability except the ones this business had actually declared.
     *
     * `projectAllowsWedge` is kept, as a narrowing filter and only for on-disk slugs. It is a
     * PERMISSION check, never a membership check, and conflating the two is what produced this.
     */
    const slugs = projectWedgeSlugs({
      schedules: await domain.listSchedules(),
      projectId,
      allows: (w) => identity.projectAllowsWedge(projectId, w),
      authored: isAuthoredSlug,
    });
    const loaded = await Promise.all(slugs.map((s) => loadProjectWedge(projectId, s).catch(() => null)));
    const enabled = loaded.filter((w): w is NonNullable<typeof w> => !!w);
    /**
     * ═════════════════════════════════════════════════════════════════════════════════════════════
     * AND THE NEEDS A WRITTEN SERVICE DECLARED, WHICH ARE NOT IN `ALL_CAPABILITIES`
     * ═════════════════════════════════════════════════════════════════════════════════════════════
     *
     * This listed the eleven the kernel implements, and nothing else. A service written for a
     * physiotherapy practice can now say `read_appointments` and have it answered by whatever the
     * founder connects — but this is the surface where a founder LEARNS a service needs something,
     * and a need that never appears here is a need nobody is ever asked to meet.
     *
     * That is the whole loop, not a cosmetic gap: the service declares, this page asks, the founder
     * connects, `resolveCapability` binds. Leaving the eleven hardcoded here would have made the
     * declaration reachable in theory and unreachable in practice.
     *
     * Taken from the wedges THIS PROJECT runs — `enabled` already resolves authored slugs through
     * `loadProjectWedge` — so nobody is shown a question about a trade they do not run, which is the
     * failure the comment above records in the founder's own words.
     */
    const declaredHere = [
      ...new Set(
        enabled
          .flatMap((w) => (w.manifest.capabilities ?? []) as string[])
          .filter((cap) => typeof cap === "string" && !isCapability(cap) && isDeclarableCapability(cap)),
      ),
    ].sort();
    return c.json({
      project_id: projectId,
      items: [...ALL_CAPABILITIES, ...declaredHere].map((name) => {
        const binding = resolveCapability(name, conns, projectId);
        const known = isCapability(name);
        const impl = known ? capabilityImplementation(name) : undefined;
        return {
          capability: name,
          /*
            A declared capability has no hand-written title or question, and inventing one would be
            inventing knowledge of a trade this kernel does not have. Its own name, said plainly, is
            the honest label — the service that declared it chose those words.
          */
          title: known ? CAPABILITIES[name].title : name.replace(/_/g, " "),
          question: known
            ? CAPABILITIES[name].question
            : `Which tool does your business use to ${name.replace(/_/g, " ")}?`,
          /**
           * WHAT THIS KERNEL ACTUALLY DOES WITH THE VERB, next to whether it is connected.
           *
           * These two facts were previously indistinguishable on this surface: `ok: true` meant
           * "something is connected", and a founder reading a green row could not tell a capability
           * the kernel reads and composes itself from one where the connection is simply handed to
           * an agent to improvise against. Six of eleven were the second kind and none of them said
           * so. `detail` now carries the same sentence in prose; these fields are for a UI that
           * wants to render the difference rather than parse it.
           */
          /*
            A DECLARED capability is brokered by construction: the kernel has no reader or composer
            for a trade it has never heard of, and the agent is handed the vendor's own tools. Saying
            "brokered" here is the same honesty `brokeredCaveat` gives the agent — a founder reading
            a green row is entitled to know which kind of green it is.
          */
          implementation: impl?.adapter ?? "brokered",
          kernel_reads: impl?.reads ?? false,
          kernel_acts: impl?.acts ?? false,
          implementation_note:
            impl?.note ??
            `This kernel has no reader of its own for "${name}" — whatever you connect is handed ` +
              `to the service as that tool's own actions.`,
          needed_by: enabled.filter((w) => (w.manifest.capabilities ?? []).includes(name)).map((w) => w.manifest.title),
          /**
           * THE SAME SERVICES, BY SLUG — because a title is for reading and a slug is for joining.
           *
           * `needed_by` carries display titles, which is right for the sentence the console writes
           * with it. It is wrong for everything else, and the console was using it for everything
           * else: `apps/used-by.tsx` passes a title straight into `WedgeFace slug=`, which hashes
           * whatever it is given to pick a colour and a silhouette.
           *
           * So `books-keeper` is one character on the Apps page (hashed from "Monthly Close for
           * E-commerce") and a different one on Files (hashed from "books-keeper"). The whole point
           * of those faces is that a founder learns which is which without reading — two faces for
           * one service is the single thing that cannot happen.
           *
           * Titles are also not stable: a founder renaming a service would silently re-roll its
           * character everywhere it was joined by name.
           */
          needed_by_slugs: enabled
            .filter((w) => (w.manifest.capabilities ?? []).includes(name))
            .map((w) => w.manifest.wedge),
          ok: binding.ok,
          ambiguous: binding.ambiguous,
          // Always populated, including when nothing provides it. A UI that has to invent the
          // "nothing is connected" sentence invents a different one on every screen.
          detail: binding.detail,
          connected: binding.bound.map((b) => ({
            toolkit: b.provider.toolkit,
            label: b.provider.label,
            connection_id: b.connection.id,
            readable: !b.unreadable,
            // The write-side twin. A connected provider the kernel cannot send through is the one
            // that looks most like success and is not: nothing bounces, because nothing is attempted.
            actionable: !b.unactionable,
          })),
          options: binding.candidates.map((p) => ({ toolkit: p.toolkit, label: p.label, via: p.via })),
        };
      }),
    });
  });

  // ── Blueprints: provision a whole business, not a task ──
  // This is what Cloud's "describe it and it goes live" resolves to. Provisioning is idempotent and
  // creates schedules DISABLED, so a business with no credentials yet can't start failing on a timer.
  /**
   * ── /v1/blueprints ── moved to blueprints.routes.
   */
  mountBlueprintRoutes(app, { domain, store, identity, accessible, writeProjectId });


  // Apply a blueprint to a project → disabled schedules, seed knowledge, and a checklist of what the
  // founder must still supply. NOT connections: see the long note on `provision()` for the three
  // things that went wrong when this created an empty row per requirement.

  // Go live: enable the blueprint's schedules — but only once the checklist is actually satisfied.

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

  // ── deployments: what is live for this project ──────────────────────────────
  //
  // Read-only. A deployment is CREATED by a run finishing (orchestrator.ts) and never by a founder
  // asking, so there is no POST here: a route that could publish arbitrary bytes to a tenant
  // hostname is a far larger surface than "show me my URL".
  //
  // The tenant filter is pushed INTO the query rather than applied to the result. `GET /v1/records`
  // and `GET /v1/cases` above still post-filter, which is the exact pattern domain.ts warns about —
  // a post-filter only protects the rows the query happened to return, and leaks the moment a
  // `limit` truncates someone else's data into the window. `listDeployments` takes a REQUIRED
  // project_id so that mistake is not available here.
  app.get("/v1/deployments", async (c) => {
    // Iterate the accessible set rather than resolving a single project: a member session with
    // several projects must see all of theirs, and `writeProjectId` deliberately refuses to pick
    // one for them. An empty set yields an empty list, never every tenant's deployments.
    const limit = Math.min(Number(c.req.query("limit") ?? 50) || 50, 200);
    const out = [];
    for (const pid of accessible(c)) {
      out.push(...(await domain.listDeployments({ project_id: pid, limit })));
    }
    out.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    return c.json(out.slice(0, limit));
  });

  // The one a console actually wants: "is my app up, and where?"
  /**
   * THE LIVE DEPLOYMENT — of one site, not of "the project".
   *
   * This asked for the project's live deployment with `limit: 1`, which was a complete question for
   * as long as a project could only have one site. It is not one any more: an agency that builds for
   * its clients has several, and "give me one of them" would answer differently depending on which
   * was deployed most recently. A founder checking their own site's address would sometimes be shown
   * a client's.
   *
   * So the default is the FOUNDER'S OWN SITE — `site_id = project_id`, which is exactly what every
   * row written before sites existed means and exactly what this route used to return. `?site=`
   * names another one. The old behaviour is preserved for the old callers rather than reinterpreted
   * under them.
   */
  app.get("/v1/deployments/current", async (c) => {
    const wanted = c.req.query("site");
    for (const pid of accessible(c)) {
      const [live] = await domain.listDeployments({
        project_id: pid,
        site_id: wanted || pid,
        status: "live",
        limit: 1,
      });
      if (live) return c.json(live);
    }
    // 404 rather than an empty object: "not deployed yet" and "deployed, but I cannot tell you
    // where" must not look the same to a caller.
    return c.json({ error: wanted ? "no live deployment for that site" : "no live deployment" }, 404);
  });

  // ── Company brain (founder plane) ───────────────────────────────────────────
  //
  // The sandbox already has `/v1/internal/brain/*` behind the run nonce. This is the same facade
  // for the founder, behind their session/API key, so "what do we know about Brightline" is a page
  // they can open rather than a curl they have to invent. Authority is the FULL set of clients and
  // cases in the project — the opposite of a house-wide run, on purpose; see `founderAuthority`.
  app.post("/v1/brain/ask", async (c) => {
    const projectId = writeProjectId(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const wedge =
      (typeof b.wedge === "string" && b.wedge.trim()) ||
      (await domain.listSchedules()).find((s) => s.project_id === projectId)?.wedge ||
      "";
    if (!wedge) return c.json({ error: "no service is running in this business yet" }, 404);
    const [clients, cases] = await Promise.all([
      domain.listClients(),
      domain.listCases({ project_id: projectId, wedge }),
    ]);
    const auth = founderAuthority({
      project_id: projectId,
      wedge,
      client_ids: clients.filter((cl) => cl.project_id === projectId).map((cl) => cl.id),
      case_ids: cases.map((k) => k.id),
    });
    const req: BrainRequest = {
      q: typeof b.q === "string" ? b.q : undefined,
      sources: Array.isArray(b.sources) ? (b.sources.filter((s) => typeof s === "string") as BrainSource[]) : undefined,
      client_id: typeof b.client_id === "string" ? b.client_id : undefined,
      case_id: typeof b.case_id === "string" ? b.case_id : undefined,
      limit: typeof b.limit === "number" ? b.limit : undefined,
    };
    const answer = await brainAsk(
      { domain, billing: getBillingStore(), knowledge: getKnowledgeStore() },
      auth,
      req,
    );
    return c.json(answer);
  });

  app.get("/v1/brain/digest", async (c) => {
    const projectId = writeProjectId(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    const wedge =
      c.req.query("wedge") ||
      (await domain.listSchedules()).find((s) => s.project_id === projectId)?.wedge ||
      "";
    // Empty is a state, not a missing resource. The Brain page used to catch this 404 into null
    // and render "Nothing to ask yet" — correct copy, wrong status. A founder who has not gone
    // live yet is the common case, and 404 made it look like the product was broken.
    if (!wedge) return c.json({ wedge: "", digest: null });
    const [clients, cases] = await Promise.all([
      domain.listClients(),
      domain.listCases({ project_id: projectId, wedge }),
    ]);
    const auth = founderAuthority({
      project_id: projectId,
      wedge,
      client_ids: clients.filter((cl) => cl.project_id === projectId).map((cl) => cl.id),
      case_ids: cases.map((k) => k.id),
    });
    const digest = await brainDigestFor(
      { domain, billing: getBillingStore(), knowledge: getKnowledgeStore() },
      auth,
    );
    return c.json({ wedge, digest });
  });

  /**
   * `POST /v1/ask` — a question in plain language, answered from this business's own state.
   *
   * FOUNDER PLANE, SESSION-AUTHENTICATED, PROJECT REQUIRED AND NEVER DEFAULTED. This is the
   * highest-risk read surface in the product: the question is free text and the answer spans every
   * noun, so a defaulted tenant here is not one leaked table, it is one leaked business. `writeProjectId`
   * refuses to pick for a session with several projects, and this returns 400 rather than guessing —
   * the same refusal `/v1/moves` makes, for the same reason.
   *
   * Not the sandbox nonce path. `/v1/internal/brain/*` is what a run uses; a run has a task, one
   * wedge and one client, and must not be handed the founder's whole-project view.
   *
   * NOTHING HERE ASSEMBLES A SCOPE. Both authorities are minted by their own modules' derived-only
   * constructors from the session's project, and `ask.ts` has no `project_id` parameter to forget.
   */
  const askStores = () => ({
    domain,
    billing: getBillingStore(),
    requests: getRequestStore(),
    knowledge: getKnowledgeStore(),
    tasks: store,
  });

  /**
   * The two authorities a whole-business read spans, derived from ONE project id.
   *
   * ONE implementation, shared by `/v1/ask` and `/v1/chat`. The chat route was about to hand-roll a
   * second copy of exactly this block, and two hand-written derivations of a tenant scope is the
   * shape of both cross-tenant leaks this codebase has shipped — see the same note on
   * `moveAuthorityFor` below.
   *
   * Nothing here reads the request body. The wedge is derived from what is actually running in the
   * business; a caller-named wedge would be a caller-assembled scope.
   */
  const askAuthoritiesFor = async (projectId: string) => {
    const [clients, cases] = await Promise.all([
      domain.listClients(),
      domain.listCases({ project_id: projectId }),
    ]);
    const mine = clients.filter((cl) => cl.project_id === projectId);
    /**
     * Empty wedge = the whole business. Pinning the first schedule used to scope the founder chat
     * to whichever wedge listed first — often `harness-operator` — so "how many clients do I have"
     * searched machinery knowledge, matched nothing, and reported the one unreadable row as
     * "you don't have access". `gather` treats an empty wedge as every wedge in the project.
     */
    return {
      brain: founderAuthority({
        project_id: projectId,
        wedge: "",
        client_ids: mine.map((cl) => cl.id),
        case_ids: cases.map((k) => k.id),
      }),
      // The multi-wedge half. `moveAuthorityFor` derives the wedge set from the project's own cases
      // and schedules, which is what lets one answer span a gtm prospect, a books engagement and the
      // invoice chasing the fee — see graph.ts for why traversal cannot be single-wedge.
      moves: await moveAuthorityFor(projectId),
    };
  };

  app.post("/v1/ask", async (c) => {
    const projectId = writeProjectId(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const question = typeof b.question === "string" ? b.question.trim().slice(0, MAX_QUESTION) : "";
    if (!question) return c.json({ error: "question is required" }, 400);

    const result = await groundedAsk(
      askStores(),
      await askAuthoritiesFor(projectId),
      question,
      // The org pays for composition on ITS OWN LiteLLM key, at its own plan's tier ceiling. Absent
      // (or LiteLLM unconfigured) degrades to the deterministic composer rather than to no answer.
      { orgId: (c.get("scope") as import("./identity").AuthScope | undefined)?.org_id },
    );
    return c.json(result);
  });

  /**
   * `POST /v1/chat` — the front door. One box, a question or a request, and files.
   *
   * SAME TENANT DISCIPLINE AS `/v1/ask`, and it matters more here because this door can lead to
   * work: project required and never defaulted, both authorities minted by `askAuthoritiesFor` from
   * the session's project, and `chat.ts` has no `project_id` parameter to forget.
   *
   * NOTHING IN THE BODY CAN AUTHORISE ANYTHING. `confirm` names move ids, and `takeMove` re-proposes
   * under this session's `MoveAuthority` before acting — an id naming another founder's invoice is
   * simply not in the proposal and comes back `unknown_move`, revealing nothing about whether it
   * exists. Every gate that stands in front of the "Take this on" button on the home surface stands
   * here, because this route calls the same function rather than a copy of it.
   *
   * ATTACHMENTS ARE READ AND DISCARDED. Extraction happens here, the text goes into the turn's fact
   * list, and no row is written anywhere. See the argument at the top of attachments.ts.
   */
  app.post("/v1/chat", async (c) => {
    const projectId = writeProjectId(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

    const message = typeof b.message === "string" ? b.message.trim().slice(0, MAX_MESSAGE) : "";
    const confirm = Array.isArray(b.confirm) ? b.confirm.filter((x): x is string => typeof x === "string") : [];
    if (!message && !confirm.length) return c.json({ error: "message is required" }, 400);

    // Decode, extract, bound. A refusal per file travels back beside the answer rather than failing
    // the turn: three good files and one scan should answer from the three and say so about the one.
    const attachments: { name: string; text: string }[] = [];
    const rejected: { name: string; reason: string; message: string }[] = [];
    const raw = Array.isArray(b.attachments) ? b.attachments.slice(0, MAX_ATTACHMENTS) : [];
    for (const a of raw) {
      const it = (a ?? {}) as Record<string, unknown>;
      const name = String(it.name ?? "file").slice(0, 200);
      const data = typeof it.data === "string" ? it.data : "";
      // Base64 is ~4/3 of the bytes. Refuse on the WIRE length before allocating a buffer for it —
      // a ceiling enforced after the decode has already spent the memory it was meant to protect.
      if (data.length > Math.ceil((MAX_ATTACHMENT_BYTES * 4) / 3) + 1024) {
        rejected.push({ name, reason: "too_large", message: `${name} is too large to attach here.` });
        continue;
      }
      const out = extractAttachmentText(name, String(it.media_type ?? ""), Buffer.from(data, "base64"));
      if (out.ok) attachments.push({ name: out.name, text: out.text });
      else rejected.push({ name: out.name, reason: out.reason, message: out.message });
    }

    const result = await chatTurn(
      askStores(),
      await askAuthoritiesFor(projectId),
      { message, attachments, confirm },
      { orgId: (c.get("scope") as import("./identity").AuthScope | undefined)?.org_id },
    );
    return c.json({ ...result, attachments_read: attachments.map((a) => a.name), attachments_rejected: rejected });
  });

  // ── Next moves (founder plane) ──────────────────────────────────────────────
  //
  // The pull half of the harness. `Schedule` and `TriggerSub` are push — somebody decided in advance
  // what happens and when. This route asks the opposite question: given the state of the business
  // right now, what could legally be done, and what is it worth? See moves.ts.
  //
  // IT PROPOSES, AND `POST /v1/moves/take` ENQUEUES. The human stays at the consequence boundary:
  // taking a move spawns the carrier run the move already named, and that run's first real-world
  // action goes through `awaitApproval` exactly as a swept one does. Nothing here sends.
  const moveStores = (): MoveStores => ({ domain, billing: getBillingStore(), requests: getRequestStore(), deliverables: getDeliverableStore() });

  /**
   * The founder's authority over their own project.
   *
   * REQUIRED, NEVER DEFAULTED. `resolveWriteProject` refuses to pick a project for a session that
   * has several, and this returns 400 rather than guessing — a defaulted scope here means one
   * founder ranking another's overdue invoices.
   *
   * The wedge set is DERIVED from what is actually running in the business (its schedules and its
   * cases) rather than from the caller. It can only ever narrow what `proposeMoves` reads: a project
   * with no wedges running proposes nothing, which is the correct answer for a business that has not
   * started.
   */
  // ONE implementation, in moves.ts, shared with the autonomy sweep. It used to be written out here
  // and the sweep was about to write it out again; two hand-written derivations of a tenant scope is
  // the shape of both cross-tenant leaks this codebase has shipped.
  const moveAuthorityFor = (projectId: string) => moveAuthorityForProject(domain, projectId);

  app.get("/v1/moves", async (c) => {
    const projectId = writeProjectId(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    const kinds = (c.req.query("kinds") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s): s is MoveKind => (MOVE_KINDS as readonly string[]).includes(s));
    const req: MoveRequest = {
      client_id: c.req.query("client_id") || undefined,
      case_id: c.req.query("case_id") || undefined,
      kinds: kinds.length ? kinds : undefined,
      limit: Number(c.req.query("limit")) || undefined,
    };
    const auth = await moveAuthorityFor(projectId);
    const proposal = await proposeMoves(moveStores(), auth, req);
    /**
     * Autonomy rides along with the proposal rather than living on a route (and a page) of its own.
     *
     * Vision Law 5 — "do not turn internals into product". Standing permission is not a subsystem
     * that deserves a room; it is the answer to "and what did you do without me?", and that question
     * is only meaningful next to the list of what it did NOT do. Two round trips to draw one
     * paragraph is also two chances for the founder's surface to show a policy that disagrees with
     * the list underneath it.
     *
     * Never fatal. A founder whose autonomy read blipped should still get their moves — the list is
     * the room, this is a section of it — and an absent key renders as "nothing runs on its own",
     * which is the truthful fail-closed reading.
     */
    const autonomy = await autonomyView(domain, auth).catch(() => undefined);
    return c.json({ ...proposal, ...(autonomy ? { autonomy } : {}) });
  });

  // ── Standing permission (founder plane) ─────────────────────────────────────
  //
  // `GET /v1/moves` returns the current policy; these two write it. There is deliberately no third
  // route and no per-rule endpoint: the document is written whole (see `saveAutonomyPolicy` — a
  // shallow-merged patch would leave a revoked rule in the row, and "I revoked that and it kept
  // running" is the one bug this surface must not have).
  //
  // NOTHING HERE GRANTS THE RIGHT TO SEND, CHARGE, PUBLISH OR DELETE. Those gates are `policy.ts`
  // and `approvals.ts` and are untouched by this route: a kind granted autonomy still produces a run
  // whose first outward action stops at `awaitApproval` unless the WEDGE's own auto-approve envelope
  // separately permits it. Two questions, two policies, and this one only answers "may it start".

  /**
   * Replace the autonomy policy for this project.
   *
   * The tenant comes from the SESSION and never from the body — a policy written into another
   * project would be standing permission to act on a business the caller cannot even see.
   *
   * `paused` alone is the kill switch, and it is accepted WITHOUT the rules: a founder stopping the
   * business mid-incident must not have to send back a well-formed document to do it.
   */
  app.post("/v1/autonomy", async (c) => {
    const projectId = writeProjectId(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const by = (c.get("scope") as import("./identity").AuthScope | undefined)?.member_id ?? "founder";
    const current = (await loadAutonomyPolicy(domain, projectId)) ?? EMPTY_POLICY;

    // The rules are only replaced when the caller SENT rules. A body carrying just `{paused:true}`
    // must not read as "and revoke everything" — see `AutonomyPolicy.paused`: pausing is reversible
    // precisely because it does not destroy what was granted.
    const next: AutonomyPolicy = {
      v: 1,
      paused: typeof b.paused === "boolean" ? b.paused : current.paused,
      allow: Array.isArray(b.allow) ? (b.allow as AutonomyRule[]) : current.allow,
      max_starts_per_sweep:
        b.max_starts_per_sweep !== undefined
          ? Number(b.max_starts_per_sweep)
          : current.max_starts_per_sweep,
      max_starts_per_day:
        b.max_starts_per_day !== undefined ? Number(b.max_starts_per_day) : current.max_starts_per_day,
      utc_offset_minutes:
        b.utc_offset_minutes !== undefined ? Number(b.utc_offset_minutes) : current.utc_offset_minutes,
    };
    const saved = await saveAutonomyPolicy(domain, projectId, next, by);
    // Ensured on the first grant rather than at project creation, exactly as `ensureWaitSchedule` is:
    // a business that has granted nothing should not carry a tick that finds nothing. Best-effort —
    // a schedule that could not be created must not lose the founder the policy they just wrote; the
    // next grant ensures it again.
    if ((saved.allow ?? []).length) await ensureAutonomySchedule(domain, projectId).catch(() => {});
    const auth = await moveAuthorityFor(projectId);
    return c.json(await autonomyView(domain, auth));
  });

  // ── Standing approvals ───────────────────────────────────────────────────────────────────────
  //
  // "Approve this kind, for this client, from now on." The OTHER half of the answer to approval
  // fatigue, and the half `/v1/autonomy` above cannot give: that one decides whether work may
  // START unasked, this one decides whether a routine, already-scored-as-not-serious action may
  // reach a client without stopping the run.
  //
  // Owner/admin only, on the same rule as the domain and branding routes. An operator can approve
  // one thing; deciding that a whole class of thing no longer needs approving is a change to how
  // the business is governed, and this product's answer to "who governs" is the same everywhere.
  //
  // See standing.ts. Nothing here can cover a high-risk action, nothing here can be written by the
  // agent, and everything here expires.

  app.get("/v1/standing", async (c) => {
    const projectId = writeProjectId(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    const grants = await listStanding(domain, projectId);
    const now = new Date();
    return c.json({
      // `live` is computed here rather than in the client, so two surfaces cannot disagree about
      // whether a grant that lapsed at midnight is still in force.
      grants: grants.map((g) => ({ ...g, live: isLive(g, now), sentence: describeGrant(g) })),
      max_days: MAX_GRANT_DAYS,
      hard_max_per_day: HARD_MAX_USES_PER_DAY,
    });
  });

  /**
   * The grants this project's own decision stream has EARNED — drafts, not authority.
   *
   * Computed live from decided approvals (human decisions only; auto-approvals are excluded at the
   * query so the suggester cannot learn from itself). Nothing here writes anything: accepting a
   * suggestion is the founder POSTing it to /v1/standing above, through the same owner/admin check
   * as a grant they typed by hand. standing.ts property 1 — "the only actor allowed to widen is a
   * person" — survives this feature because the machine's whole contribution is a sentence of
   * evidence and a pre-filled form.
   */
  app.get("/v1/standing/suggestions", async (c) => {
    const projectId = writeProjectId(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    const since = new Date(Date.now() - 60 * 86_400_000).toISOString();
    const [decided, grants] = await Promise.all([
      store.decidedApprovalsForProject(projectId, since),
      listStanding(domain, projectId),
    ]);
    return c.json({ suggestions: suggestStandingGrants(decided, grants) });
  });

  app.post("/v1/standing", async (c) => {
    const scope = c.get("scope") as import("./identity").AuthScope | undefined;
    const projectId = writeProjectId(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    if (!scope || !canManageMembers(scope.role)) {
      return c.json({ error: "only an owner or admin can grant a standing approval" }, 403);
    }
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

    // THE AUTHOR IS THE SESSION'S MEMBER, never the body. `member_id` is absent on a product-key
    // (machine) session, and that absence must refuse rather than default to a friendly string:
    // "founder" as a fallback here would mean an API key could write a permission and sign a
    // human's name to it. `grantStanding` rejects the empty author too — belt and braces, because
    // this is the one function in the product that hands out authority to skip a person.
    const by = scope.member_id ?? "";
    if (!by) {
      return c.json({ error: "a standing approval must be granted by a signed-in person, not an API key" }, 403);
    }

    // A grant naming a client must name a client of THIS project. Without the check a founder could
    // be handed a grant id that reads as another tenant's client on their own screen.
    const clientId = typeof b.client_id === "string" && b.client_id ? b.client_id : undefined;
    if (clientId && !(await clientInProject(clientId, projectId))) {
      return c.json({ error: "that client is not in this project" }, 400);
    }

    try {
      const grant = await grantStanding(
        domain,
        projectId,
        {
          action: String(b.action ?? ""),
          client_id: clientId,
          max_per_day: b.max_per_day === undefined ? undefined : Number(b.max_per_day),
          days: b.days === undefined ? undefined : Number(b.days),
        },
        by,
      );
      await audit({
        project_id: projectId, actor: "member", action: "standing.granted",
        entity: "project", entity_id: projectId,
        detail: { grant_id: grant.id, sentence: describeGrant(grant), by },
      });
      return c.json({ ...grant, live: true, sentence: describeGrant(grant) }, 201);
    } catch (e) {
      // The refusals in `grantStanding` are all things a person typed. 400 with the sentence.
      return c.json({ error: (e as Error)?.message ?? "could not grant that" }, 400);
    }
  });

  app.delete("/v1/standing/:id", async (c) => {
    const scope = c.get("scope") as import("./identity").AuthScope | undefined;
    const projectId = writeProjectId(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    if (!scope || !canManageMembers(scope.role)) {
      return c.json({ error: "only an owner or admin can revoke a standing approval" }, 403);
    }
    // Scoped by project inside `revokeStanding`, which reads the project's own list and matches by
    // id within it — an id from another tenant simply is not there, and the answer is 404 rather
    // than a revocation of somebody else's grant.
    const ok = await revokeStanding(domain, projectId, c.req.param("id"), scope.member_id ?? "member");
    if (!ok) return c.json({ error: "not found" }, 404);
    await audit({
      project_id: projectId, actor: "member", action: "standing.revoked",
      entity: "project", entity_id: projectId,
      detail: { grant_id: c.req.param("id"), by: scope.member_id ?? "member" },
    });
    return c.json({ ok: true });
  });

  /**
   * Take a move: spawn the carrier run it already names.
   *
   * WHAT THIS REPLACES: reading "chase INV-104" here, then navigating to Invoices and clicking
   * Chase. The move already knew its wedge, its task type and the wedge's own input; the product
   * threw that away at the edge of the UI and made the founder rebuild it by hand.
   *
   * IT DOES NOT SEND. `takeMove` calls `startChase`, which spawns the run — and the run's send goes
   * through the approval gate like every other consequence. A chase taken from `/next` and a chase
   * the 03:00 sweep started are the same run and land in the same queue.
   *
   * The tenant comes from the SESSION, never the body, and `takeMove` re-proposes under that
   * authority before acting: a `move_id` naming another founder's invoice is simply not in the
   * proposal, so the answer is "unknown move" and reveals nothing about whether it exists.
   *
   * A refusal is a 409 with a machine `reason` and a sentence, not a 500. "We chased this yesterday
   * and the ladder says wait" is a true and useful answer; "something went wrong" is neither.
   */
  app.post("/v1/moves/take", async (c) => {
    const projectId = writeProjectId(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const moveId = String(b.move_id ?? "").trim();
    if (!moveId) return c.json({ error: "move_id is required" }, 400);
    const taken = await takeMove(moveStores(), await moveAuthorityFor(projectId), moveId);
    if (!taken.ok) return c.json({ error: taken.message, code: `move.${taken.reason}` }, 409);
    return c.json(taken, 201);
  });

  /**
   * What happened after a move was taken — the half that makes the ranking learn.
   *
   * The tenant comes from the session, never from the body: an outcome written into another
   * project's ledger would quietly retrain that founder's list. `move_id` is not validated against a
   * live proposal on purpose — a move is recomputed on every read, so by the time a founder reports
   * that the client paid, the move that prompted it has correctly stopped being proposed.
   */
  app.post("/v1/moves/outcome", async (c) => {
    const projectId = writeProjectId(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const moveId = String(b.move_id ?? "").trim();
    const kind = String(b.kind ?? "") as MoveKind;
    const result = String(b.result ?? "") as MoveResult;
    if (!moveId) return c.json({ error: "move_id is required" }, 400);
    if (!(MOVE_KINDS as readonly string[]).includes(kind)) {
      return c.json({ error: `kind must be one of: ${MOVE_KINDS.join(", ")}` }, 400);
    }
    if (!(MOVE_RESULTS as readonly string[]).includes(result)) {
      return c.json({ error: `result must be one of: ${MOVE_RESULTS.join(", ")}` }, 400);
    }
    const auth = await moveAuthorityFor(projectId);
    const outcome = await recordOutcome(domain, auth, {
      move_id: moveId,
      kind,
      entity_id: String(b.entity_id ?? "").slice(0, 200),
      result,
      by: (c.get("scope") as import("./identity").AuthScope | undefined)?.member_id ?? "founder",
      note: typeof b.note === "string" ? b.note.trim().slice(0, 1000) : undefined,
    });
    return c.json({ ok: true, outcome });
  });

  app.get("/v1/deployments/:id", async (c) => {
    // The project is an ARGUMENT to the fetch, not a check on what came back. Fetch-then-compare is
    // one forgotten `if` away from handing a deployment — including its build id and its error
    // text — to whoever guessed the uuid.
    for (const pid of accessible(c)) {
      const d = await domain.getDeployment(c.req.param("id"), pid);
      if (d) return c.json(d);
    }
    return c.json({ error: "not found" }, 404);
  });

  /**
   * PUBLISH A BUILT SITE, or refuse it. The human half of the review gate.
   *
   * ═══ WHY THESE EXIST ═══
   *
   * A finished `build_feature` run used to publish itself: `orchestrator.ts` called `startDeploy` on
   * the way out, CloudFront invalidated, and a stranger was reading a new version of somebody's
   * business front door with no person in the loop. It is the only thing this product ever shipped
   * without a signature, and it is why `takeability` in `moves.ts` refuses to offer a "build my site"
   * button at all. The run now leaves the deployment at `awaiting_review`; these are the two answers.
   *
   * ═══ WHAT A CALLER MAY INFLUENCE, WHICH IS ONLY WHICH ROW ═══
   *
   * Nothing about WHERE the bytes go travels in this request. `publishDeploy` reads the project, the
   * site and the slug back off the row it was pointed at, and the row was written by the kernel —
   * so there is no parameter here that could aim one tenant's tarball at another tenant's address.
   * The row is fetched with the project as an ARGUMENT (`accessible(c)`), never fetched first and
   * compared after, which is the rule every deployment read in this file already follows.
   *
   * Both refuse anything that is not `awaiting_review`, which is what makes a double-click safe: the
   * second answer finds a row that has moved on and reports 409 rather than starting a second build
   * of the same bytes or overturning a refusal with a stale tab.
   */
  app.post("/v1/deployments/:id/publish", async (c) => {
    const cfg = deployConfig();
    // Not a 500. A self-hosted kernel genuinely cannot publish, and saying so is the honest answer —
    // the build still ran and its workspace is still downloadable from the run.
    if (!cfg) return c.json({ error: "this kernel is not configured to host sites" }, 501);
    for (const pid of accessible(c)) {
      const dep = await domain.getDeployment(c.req.param("id"), pid);
      if (!dep) continue;
      if (dep.status !== "awaiting_review") {
        return c.json({ error: `this deployment is ${dep.status}, not awaiting review` }, 409);
      }
      const out = await publishDeploy(domain, dep.id, pid, cfg);
      if (!out) return c.json({ error: "this deployment is no longer awaiting review" }, 409);
      /**
       * Audited, because this is the one click in the product that makes a page public.
       *
       * `actor` is the member who pressed it, not "system". The whole value of the gate is that a
       * named person decided, and an audit row saying "system" would erase exactly the fact the gate
       * was built to record.
       */
      await audit({
        project_id: pid,
        actor: c.get("scope")?.member_id ?? "system",
        action: "deployment.published",
        entity: "deployment",
        entity_id: out.id,
        detail: { slug: out.slug, url: out.url, task_id: out.task_id },
      });
      return c.json(out);
    }
    return c.json({ error: "not found" }, 404);
  });

  app.post("/v1/deployments/:id/discard", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { reason?: string };
    for (const pid of accessible(c)) {
      const dep = await domain.getDeployment(c.req.param("id"), pid);
      if (!dep) continue;
      if (dep.status !== "awaiting_review") {
        return c.json({ error: `this deployment is ${dep.status}, not awaiting review` }, 409);
      }
      // No `deployConfig()` check: a discard needs no AWS at all. Refusing to record a founder's
      // "no" because the hosting credentials are missing would be absurd.
      const out = await discardDeploy(domain, dep.id, pid, body.reason);
      if (!out) return c.json({ error: "this deployment is no longer awaiting review" }, 409);
      // A refusal is as much a decision as an approval, and is recorded the same way. "Nobody ever
      // said no" and "somebody said no three times" are different facts about a business.
      await audit({
        project_id: pid,
        actor: c.get("scope")?.member_id ?? "system",
        action: "deployment.discarded",
        entity: "deployment",
        entity_id: out.id,
        detail: { slug: out.slug, reason: body.reason, task_id: out.task_id },
      });
      return c.json(out);
    }
    return c.json({ error: "not found" }, 404);
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

  /**
   * ═══ THE RUN WRITES DOWN WHAT IT LEARNED ═══
   *
   * The write path whose absence got the whole memory module reverted an hour after it landed. A
   * memory system with no writer is not a partial feature — it is a spec with a passing test suite,
   * which looks MORE finished than dead code while proving nothing.
   *
   * WHY THIS NEEDS NO APPROVAL, WHICH IS THE ONLY INTERESTING QUESTION HERE. `knowledge.ts` refuses
   * a `self_reported` rule source, and is right to: a RULE binds behaviour, so a wrong one makes the
   * agent misbehave at a client on the firm's letterhead. A MEMORY binds nothing. It is retrieved as
   * context and labelled as recall, a run that reads it is exactly as gated as one that does not,
   * and a wrong one produces a draft that is off — which is the ordinary case the approval gate
   * already exists for. That asymmetry is what the deleted self-improvement system never had, and
   * it is why this can be a plain write instead of a proposal in a queue nobody drained.
   *
   * The project comes off the TASK, never the body — the same rule `records/upsert` above follows,
   * and the reason a path from another tenant is unreachable rather than merely denied.
   */
  app.post("/v1/internal/memory/write", async (c) => {
    const grant = await getActionGrant((c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, ""));
    if (!grant) return c.json({ ok: false, error: "invalid action token" }, 401);
    const task = await store.getTask(grant.task_id);
    if (!task) return c.json({ ok: false, error: "unknown task" }, 404);
    const b = (await c.req.json().catch(() => ({}))) as { path?: unknown; body?: unknown };
    const wrote = await rememberFromRun({
      project_id: task.project_id ?? "",
      path: String(b.path ?? ""),
      body: String(b.body ?? ""),
    });
    if (!wrote.ok) return c.json({ ok: false, error: wrote.reason }, 400);
    await emitEvent(store, grant.task_id, "tool.result", { tool: "memory:write", ok: true, path: wrote.doc.path });
    return c.json({ ok: true, path: wrote.doc.path, title: wrote.doc.title });
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

  // ── The company brain: two read verbs over everything this run is allowed to know ──
  //
  // Reached with the EXISTING action nonce. No new credential enters the sandbox: another credential
  // is another thing to mint, scope, rotate and revoke, and the one that already exists means
  // exactly "this run, right now".
  //
  // The authority is DERIVED here and nowhere else. Note what is NOT read from the body: no project,
  // no wedge, no client. The body can only narrow — the filters are intersected with the authority
  // inside brain.ts — and `BrainAuthority` is branded with a module-private symbol, so a handler
  // cannot hand-build one out of request fields even by accident.
  const brainStores = () => ({ domain, billing: getBillingStore(), knowledge: getKnowledgeStore() });

  /** The nonce → grant → task → authority chain both verbs share. One place, so they cannot diverge. */
  async function brainAuthorityFor(authHeader: string) {
    const grant = await getActionGrant(authHeader.replace(/^Bearer\s+/i, ""));
    if (!grant) return { status: 401 as const, error: "invalid action token" };
    const task = await store.getTask(grant.task_id);
    if (!task) return { status: 404 as const, error: "unknown task" };
    // The same refusal as `/v1/internal/records/query`, for the same reason: a task with no project
    // has no tenant, and a read with no tenant is a read of everyone's.
    const auth = deriveAuthority(task, grant);
    if (!auth) return { status: 403 as const, error: "task has no project scope" };
    return { auth };
  }

  app.post("/v1/internal/brain/ask", async (c) => {
    const got = await brainAuthorityFor(c.req.header("authorization") ?? "");
    if (!got.auth) return c.json({ ok: false, error: got.error }, got.status);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const req: BrainRequest = {
      q: typeof b.q === "string" ? b.q : undefined,
      sources: Array.isArray(b.sources) ? (b.sources.filter((s) => typeof s === "string") as BrainSource[]) : undefined,
      client_id: typeof b.client_id === "string" ? b.client_id : undefined,
      case_id: typeof b.case_id === "string" ? b.case_id : undefined,
      limit: typeof b.limit === "number" ? b.limit : undefined,
    };
    // TRACED ONTO THE TASK TIMELINE, call and result, the way `/reads` is. This is the surface that
    // can reach a client's invoices and messages, so "what did the agent look at" has to be
    // answerable afterwards — a brain read a founder cannot see is a leak nobody noticed.
    await emitEvent(store, got.auth.task_id, "tool.called", {
      tool: "brain:ask",
      args: { q: req.q, sources: req.sources, client_id: req.client_id, case_id: req.case_id },
    });
    const answer = await brainAsk(brainStores(), got.auth, req);
    await emitEvent(store, got.auth.task_id, "tool.result", {
      tool: "brain:ask",
      ok: true,
      returned: answer.returned,
      matched: answer.matched,
      truncated: answer.truncated,
      authority_excluded: answer.authority_excluded,
    });
    return c.json({ ok: true, ...answer });
  });

  app.post("/v1/internal/brain/get", async (c) => {
    const got = await brainAuthorityFor(c.req.header("authorization") ?? "");
    if (!got.auth) return c.json({ ok: false, error: got.error }, got.status);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const ref = typeof b.source_ref === "string" ? b.source_ref : "";
    if (!ref) return c.json({ ok: false, error: "source_ref is required" }, 400);
    await emitEvent(store, got.auth.task_id, "tool.called", { tool: "brain:get", args: { source_ref: ref } });
    // Re-authorised from scratch inside `brainGet`: the ref is a lookup key, never a capability.
    const doc = await brainGet(brainStores(), got.auth, ref);
    await emitEvent(store, got.auth.task_id, "tool.result", { tool: "brain:get", ok: !!doc, source_ref: ref });
    // 404 for "not yours" and "not there" alike. A refusal that tells them apart is an oracle for
    // the existence of another client's rows.
    if (!doc) return c.json({ ok: false, error: "not found" }, 404);
    return c.json({ ok: true, document: doc });
  });

  /**
   * `POST /v1/internal/moves/propose` — the next-move engine, for a run.
   *
   * Same nonce, same chain, same refusals as the two brain verbs above: no new credential enters the
   * sandbox, and the authority is DERIVED from the task rather than read from the body. What the
   * body may carry is only narrowing (`client_id`, `case_id`, `kinds`, `limit`); `MoveAuthority` is
   * branded with a module-private symbol so a handler cannot assemble one out of request fields.
   *
   * A run's authority is ONE wedge — its own — so this answers "what is the next thing to do in my
   * lane", not "what should the business do". A reflection run that could rank another wedge's work
   * would be one prompt injection away from proposing itself a chase against a client it has never
   * been scoped to.
   *
   * TRACED onto the task timeline, call and result, exactly as `brain:ask` is. This surface reaches
   * invoices and client requests; "what did the agent look at" has to be answerable afterwards.
   */
  app.post("/v1/internal/moves/propose", async (c) => {
    const grant = await getActionGrant((c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, ""));
    if (!grant) return c.json({ ok: false, error: "invalid action token" }, 401);
    const task = await store.getTask(grant.task_id);
    if (!task) return c.json({ ok: false, error: "unknown task" }, 404);
    const auth = deriveMoveAuthority(task, grant);
    if (!auth) return c.json({ ok: false, error: "task has no project scope" }, 403);

    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const kinds = Array.isArray(b.kinds)
      ? b.kinds.filter((k): k is MoveKind => typeof k === "string" && (MOVE_KINDS as readonly string[]).includes(k))
      : undefined;
    const req: MoveRequest = {
      client_id: typeof b.client_id === "string" ? b.client_id : undefined,
      case_id: typeof b.case_id === "string" ? b.case_id : undefined,
      kinds: kinds?.length ? kinds : undefined,
      limit: typeof b.limit === "number" ? b.limit : undefined,
    };
    await emitEvent(store, task.id, "tool.called", {
      tool: "moves:propose",
      args: { client_id: req.client_id, case_id: req.case_id, kinds: req.kinds },
    });
    const proposal = await proposeMoves(moveStores(), auth, req);
    await emitEvent(store, task.id, "tool.result", {
      tool: "moves:propose",
      ok: true,
      returned: proposal.moves.length,
      matched: proposal.matched,
      truncated: proposal.truncated,
      authority_excluded: proposal.authority_excluded,
    });
    return c.json({ ok: true, ...proposal });
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
    if (!loadWedge(String(b.wedge))) return { error: unknownService(b.wedge), status: 400 };
    if (!identity.projectAllowsWedge(projectId, String(b.wedge))) {
      return { error: serviceNotEnabled(b.wedge), status: 403 };
    }
    return null;
  }

  // ── Cases: long-lived engagements (tasks are episodes within one) ──
  // Stages come from the wedge manifest (`cases.stages`), so a transition to a stage the wedge
  // doesn't declare is rejected at the boundary rather than corrupting the engagement.
  const caseStages = (wedgeSlug: string): string[] => loadWedge(wedgeSlug)?.manifest.cases?.stages ?? [];

  app.get("/v1/cases", async (c) => {
    // Scoped per project INSIDE the query, like `/v1/records` and `/v1/deployments`. A case carries
    // a client's whole engagement history, so this is the last read that should have been reading
    // every tenant's rows and trusting a filter afterwards.
    const all = [];
    for (const pid of accessible(c)) {
      all.push(
        ...(await domain.listCases({
          project_id: pid,
          wedge: c.req.query("wedge") || undefined,
          status: (c.req.query("status") as "open" | "closed") || undefined,
          client_id: c.req.query("client_id") || undefined,
          stage: c.req.query("stage") || undefined,
        })),
      );
    }
    all.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    return c.json(all);
  });

  // The scales: which skills land the work. `?scope=global` is the cross-tenant scoreboard (counts
  // only, no tenant content); default is the caller's own view, aggregated across their projects.
  /**
   * ── /v1/skills ── moved to skills.routes.
   */
  mountSkillRoutes(app, { domain, accessible });


  // The shared skill library — cross-tenant procedure a wedge inherits by domain. `?domain=` filters.

  // Add a skill to the library from its markdown. PROSE ONLY: the body is the SKILL.md text; any
  // bundled executable scripts are the caller's to have dropped — nothing here runs. `domains` tags
  // which wedges it reaches. Global mutation, so it is gated on the operator key.

  // Pull a skill from the internet by URL. The prose-only line again: we fetch the SKILL.md text and
  // parse it; nothing it references is fetched or run. Host-allowlisted so this cannot be turned into
  // a request forger, https-only, operator-gated.

  app.post("/v1/cases", async (c) => {
    const projectId = writeProjectId(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    if (!b.wedge || !b.title) return c.json({ error: "wedge and title are required" }, 400);
    const w = loadWedge(String(b.wedge));
    if (!w) return c.json({ error: unknownService(b.wedge) }, 400);
    if (!identity.projectAllowsWedge(projectId, String(b.wedge))) {
      return c.json({ error: serviceNotEnabled(b.wedge) }, 403);
    }
    if (String(b.wedge) !== (wedgeForRole("outreach") ?? "")) {
      const limits = identity.limitsFor(c.get("scope").org_id);
      if (!limits.fulfillment) return c.json(fulfillmentRefusal(), 402);
    }
    const stages = caseStages(String(b.wedge));
    const stage = String(b.stage ?? w.manifest.cases?.initial ?? stages[0] ?? "open");
    if (stages.length && !stages.includes(stage)) {
      return c.json({ error: `there is no "${stage}" stage — this service has: ${stages.join(", ")}` }, 400);
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

  /**
   * Run the post-close kickoff playbook: connection invites, intake asks, money plan, optional deposit.
   *
   * Idempotent unless `force: true`. Convert calls this automatically; this route is the explicit
   * founder door when convert ran before a wedge gained a fulfillment block, or when re-arming.
   */
  app.post("/v1/cases/:id/kickoff", async (c) => {
    const kase = await domain.getCase(c.req.param("id"));
    if (!kase || !inScope(accessible(c), kase.project_id)) return c.json({ error: "not found" }, 404);
    if (!kase.client_id) return c.json({ error: "kickoff needs a client on the engagement" }, 400);
    if (!identity.limitsFor(c.get("scope").org_id).fulfillment) {
      return c.json(fulfillmentRefusal(), 402);
    }
    const b = (await c.req.json().catch(() => ({}))) as {
      force?: boolean;
      draft_deposit?: boolean;
      intake_only?: boolean;
    };
    try {
      const { runKickoffPlaybook } = await import("./kickoff");
      const intakeOnly = b.intake_only === true;
      const out = await runKickoffPlaybook({
        domain,
        kase,
        force: !!b.force,
        draft_deposit: intakeOnly ? false : b.draft_deposit !== false,
        intake_only: intakeOnly,
      });
      return c.json({
        ok: true,
        applied: out.applied,
        case: out.case,
        requests: out.requests,
        money_plan: out.money_plan,
        deposit_invoice: out.deposit_invoice,
        wait_id: out.wait?.id,
      });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  /**
   * Founder money-plan editor — replace deposit / milestone / retainer / period lines.
   *
   * Invoiced and paid lines are locked (cannot drop or reprice). This is the product door for
   * "promise → money" that kickoff seeds and draft-invoice consumes.
   */
  app.put("/v1/cases/:id/money-plan", async (c) => {
    const kase = await domain.getCase(c.req.param("id"));
    if (!kase || !inScope(accessible(c), kase.project_id)) return c.json({ error: "not found" }, 404);
    if (kase.status === "closed") return c.json({ error: "engagement is closed" }, 409);
    if (!identity.limitsFor(c.get("scope").org_id).fulfillment) {
      return c.json(fulfillmentRefusal(), 402);
    }
    const b = (await c.req.json().catch(() => ({}))) as {
      currency?: string;
      lines?: Array<Record<string, unknown>>;
    };
    if (!Array.isArray(b.lines)) return c.json({ error: "lines array is required" }, 400);
    try {
      const { applyMoneyPlanEdit, readMoneyPlan, writeMoneyPlan } = await import("./money-plan");
      const plan = applyMoneyPlanEdit(readMoneyPlan(kase.data), {
        currency: b.currency,
        lines: b.lines.map((l) => ({
          id: typeof l.id === "string" ? l.id : undefined,
          label: String(l.label ?? ""),
          amount_minor: Number(l.amount_minor),
          kind: l.kind as "deposit" | "milestone" | "retainer" | "period",
          status: l.status as "planned" | "invoiced" | "paid" | "waived" | undefined,
          deliverable_id: typeof l.deliverable_id === "string" ? l.deliverable_id : undefined,
          /**
           * THE FIELD THIS ROUTE DROPPED, AND DROPPING IT MEANT NO FOUNDER COULD SELL A RETAINER.
           *
           * `money-plan.ts` has had the whole engine for a while: `RetainerRecurrence`, pro-rata
           * first periods, pause that does not back-bill, a unique index that makes double-billing
           * impossible. `applyMoneyPlanEdit` reads and validates `recurrence` on the way in, and
           * preserves it when omitted. This mapping listed five fields and not that one, so a
           * `recurrence` sent by any caller was discarded here, silently, before validation — and
           * `MoneyPlanLine` says in as many words that a retainer line WITHOUT a recurrence "bills
           * like a one-off".
           *
           * So the only retainers that recurred in this product were ones a wedge's kickoff or a
           * proposal's cadence happened to stamp (`kickoff.ts`, `proposal-envelope.ts`). A founder
           * who won a one-time job and then agreed a monthly could set the line's KIND to retainer,
           * see the word on the screen, and never be told that nothing would bill twice. "We do the
           * fulfilment and retainers" was half true in the half that pays every month.
           *
           * Unvalidated on purpose: `readRetainerRecurrence` is the validator and it refuses
           * anything without a `YYYY-MM-DD` anchor, clamps the interval to 1..24, and ignores a
           * first period that ends before it starts. Parsing here would be a second opinion about
           * the same bytes.
           */
          recurrence: l.recurrence,
        })),
      });
      const actor = (c.get("scope").member_id ?? "system") as string;
      const iso = new Date().toISOString();
      const updated = await domain.updateCase(
        kase.id,
        { data: writeMoneyPlan(kase.data ?? {}, plan) },
        { at: iso, kind: "note", note: "money plan updated", actor },
      );
      return c.json({ ok: true, money_plan: plan, case: updated });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
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
    if (kase.wedge !== (wedgeForRole("outreach") ?? "") && !identity.limitsFor(c.get("scope").org_id).fulfillment) {
      return c.json(fulfillmentRefusal(), 402);
    }
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    if (!b.task_type) return c.json({ error: "task_type is required" }, 400);
    const w = loadWedge(kase.wedge);
    const types = w?.manifest.task_types;
    if (types && Object.keys(types).length && !types[String(b.task_type)]) {
      return c.json({ error: `the "${kase.wedge}" service does not do "${b.task_type}"` }, 400);
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
      // WITH the wedge and the task type, so the manifest's declared profile applies. Without them
      // this fell through to the permissive `general` defaults (600s, $2) while every kernel-spawned
      // twin of the same job resolved its declared budget — the drift `spawnKernelTask`'s own note
      // believed it had closed ("this was the last place they had"; it was not, this was). Caught by
      // the waits gate-parity test: a resumed run and a hand-started run of the same task type must
      // be indistinguishable, and they differed by 3× on cost ceiling.
      constraints: clampConstraints(b.constraints as Partial<Constraints>, cfg.maxCostCeilingUsd, cfg.maxRuntimeCeilingS, w, String(b.task_type)),
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

  // ── Work that waits ──────────────────────────────────────────────────────────────────────────
  //
  // vision.md §"What is left → 1": "this engagement paused for a client reply, resumed next Tuesday,
  // and never double-invoiced." The mechanics are in waits.ts; these are the four doors onto it.
  //
  // NO NEW PAGE — Law 5. A wait is not a subsystem a founder administers; it is a fact about an
  // engagement, and it surfaces where they already look: on the case timeline (armed, nudged,
  // expired, resumed are all `CaseEvent`s), in the Clock, and on `/next`.
  //
  // Registered here, once, for the reason `setChaseDeps` is: `sweepWaits` runs inside `fireSchedule`,
  // which has a store and a domain store and nothing else. Until this line runs, nothing resumes —
  // and that is the fail-closed direction, because the alternative is a resume built from a simpler
  // spawn that skipped the ceilings and the manifest.
  setWaitDeps({ wedgeEnabled, spawnTask: spawnKernelTask });
  // The ignition sweep starts a case's FIRST run the same way a wait resumes its next one — through
  // the one spawn seam that resolves the manifest and clamps constraints. Same deps, same reason.
  setIgniteDeps({ wedgeEnabled, spawnTask: spawnKernelTask });
  // A GEO week that reported is not done: the recommendation becomes a page. Same spawn seam.
  setShipDeps({ spawnTask: spawnKernelTask });
  // The look-first half of writing a service: `research_service` succeeds, the kernel queues the
  // `draft_service` that reads its findings. Registered here for the same reason `setShipDeps` is —
  // `spawnKernelTask` lives in this closure and the module that needs it must not import the server.
  setArsenalDeps({ listTasks: (a) => store.listTasks(a), spawnTask: spawnKernelTask });

  /**
   * Park an engagement on a condition.
   *
   * The resume task type is validated against THIS CASE'S WEDGE MANIFEST here, at the boundary, and
   * not inside `armWait` — same rule as `POST /v1/cases/:id/tasks` above, and the same reason: a
   * resume that spawns a task type no wedge declares produces a run with no output schema, no policy
   * and no knowledge, and it does it a fortnight later when nobody is watching. Failing at arm time
   * puts the error in front of the person who can fix it.
   */
  app.post("/v1/cases/:id/wait", async (c) => {
    const kase = await domain.getCase(c.req.param("id"));
    if (!kase || !inScope(accessible(c), kase.project_id)) return c.json({ error: "not found" }, 404);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const resume = (b.resume ?? {}) as { task_type?: unknown; input?: unknown };
    const taskType = String(resume.task_type ?? "");
    const types = loadWedge(kase.wedge)?.manifest.task_types;
    if (types && Object.keys(types).length && !types[taskType]) {
      return c.json({ error: `the "${kase.wedge}" service does not do "${taskType}"` }, 400);
    }
    const armed = await armWait(domain, {
      // The tenant comes from the CASE, never from the body. A wait armed under the wrong project is
      // a cross-tenant send with a delay fuse on it — see `armWait`.
      project_id: kase.project_id ?? "",
      case_id: kase.id,
      reason: String(b.reason ?? ""),
      // Both spellings, validated by `normalizeConditions` — which refuses BOTH at once, refuses an
      // empty set, and refuses an unknown mode rather than coercing it to `any`. A body that meant
      // "all seven receipts" and silently became "any one of them" would close the month on the
      // first receipt, which is the failure a defaulted mode buys.
      condition: b.condition as never,
      conditions: b.conditions as never,
      mode: b.mode as never,
      resume: { task_type: taskType, input: (resume.input as Record<string, unknown>) ?? {} },
      nudge_at: typeof b.nudge_at === "string" ? b.nudge_at : undefined,
      max_nudges: typeof b.max_nudges === "number" ? b.max_nudges : undefined,
      expires_at: typeof b.expires_at === "string" ? b.expires_at : undefined,
    });
    // 409 and not 500 for "already waiting": the caller asked for something the model forbids (one
    // live wait per case), and the message says which wait already holds it.
    if (!armed.ok) return c.json({ error: armed.error }, /already waiting/.test(armed.error) ? 409 : 400);
    // The schedule is ensured on the first arm rather than at project creation, exactly like
    // `ensureSequenceSchedule`: a business with no waits should not carry a tick that finds nothing.
    await ensureWaitSchedule(domain, kase.project_id ?? "").catch(() => {});
    return c.json(armed.wait, 201);
  });

  /**
   * What the business is blocked on. ONE PROJECT AT A TIME — `WaitFilter.project_id` fails closed
   * and there is deliberately no fleet-wide read.
   *
   * Defaults to the live states (`waiting` + `resuming`) rather than to everything, because the
   * question a founder is asking is "what are we waiting on", not "show me the table". A wait stuck
   * in `resuming` (a crash between the claim and the spawn) is IN that default answer on purpose:
   * it is the one that needs a human, and hiding it behind a filter is how it stays hidden.
   */
  app.get("/v1/waits", async (c) => {
    const set = accessible(c);
    const named = c.req.header("x-mycel-project");
    const projectId = named && set.has(named) ? named : set.size === 1 ? [...set][0] : undefined;
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    const status = c.req.query("status");
    const wanted: WaitStatus[] =
      status === "all"
        ? []
        : status && (["waiting", "resuming", "resumed", "expired", "cancelled", "failed"] as const).includes(status as never)
          ? [status as WaitStatus]
          : ["waiting", "resuming"];
    const rows = wanted.length
      ? (await Promise.all(wanted.map((s) => domain.listWaits({ project_id: projectId, status: s, case_id: c.req.query("case_id") || undefined })))).flat()
      : await domain.listWaits({ project_id: projectId, case_id: c.req.query("case_id") || undefined });
    rows.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    return c.json(rows);
  });

  /**
   * Stop waiting, by hand. Terminal, and it spawns NOTHING.
   *
   * Cancelling is not resuming: "we are no longer blocked on this" and "the thing we were blocked on
   * happened" are different facts with different consequences, and a cancel that quietly kicked off
   * the resume run would be a founder tidying their list into a client-facing send.
   */
  app.post("/v1/waits/:id/cancel", async (c) => {
    for (const pid of accessible(c)) {
      const settled = await domain.settleWait(pid, c.req.param("id"), "cancelled", undefined, ["waiting", "resuming"]);
      if (settled) {
        await domain
          .updateCase(settled.case_id, {}, {
            at: new Date().toISOString(),
            kind: "note",
            note: `stopped waiting: ${settled.reason}`,
            actor: (c.get("scope").member_id ?? "system") as string,
          })
          .catch(() => {});
        return c.json(settled);
      }
    }
    return c.json({ error: "not found" }, 404);
  });

  /**
   * The way back from a resume that stalled. The counterpart to cancel, and the opposite trade.
   *
   * Cancelling a stuck wait throws the engagement away; re-creating it by hand was the only other
   * option and means retyping a durable row at the worst possible moment. This puts it back on the
   * sweep's list — `resuming` → `waiting` — and spawns NOTHING. The next sweep re-evaluates the
   * condition and resumes through `resumeWait`, so a re-armed run passes every gate a fresh one does.
   * See `rearmWait` in waits.ts for why this cannot become a second way to resume.
   *
   * ═══ THE FOUNDER IS ASSERTING SOMETHING ═══
   *
   * We cannot distinguish a crashed resume from a slow one, so `confirm: "did-not-run"` is REQUIRED
   * in the body. Not ceremony: it is the record that a human made a claim about the world the system
   * could not check, and `by` puts their name on the case timeline next to it. A one-click button
   * would have implied the kernel verified something it did not.
   *
   * Scoped by trying each accessible project, exactly like cancel: `rearmWait` takes the tenant as an
   * argument, so no code path here has ever held another founder's row, and a wait id belonging to
   * another tenant reads as 404 rather than as a row to check afterwards.
   */
  app.post("/v1/waits/:id/rearm", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    if (b.confirm !== "did-not-run") {
      return c.json(
        {
          error:
            "Re-arming asserts that the stalled resume never ran. Send confirm: \"did-not-run\" to say so.",
          code: "rearm.unconfirmed",
        },
        400,
      );
    }
    const by = (c.get("scope").member_id ?? "founder") as string;
    let refusal: { message: string; code: string } | undefined;
    for (const pid of accessible(c)) {
      const r = await rearmWait(domain, { project_id: pid, wait_id: c.req.param("id"), by });
      if (r.ok) return c.json({ ok: true, wait: r.wait, attempts_left: MAX_REARMS - r.wait.rearm_count });
      // `not_found` in one project says nothing — the wait may live in the next one. Any OTHER
      // refusal means we found it and it is not re-armable, and that sentence is what the founder
      // needs; it is held rather than returned so the loop can still find a match in a later project.
      if (r.reason !== "not_found") refusal = { message: r.message, code: `rearm.${r.reason}` };
    }
    if (refusal) return c.json({ error: refusal.message, code: refusal.code }, 409);
    return c.json({ error: "not found" }, 404);
  });

  /**
   * An agent parking ITS OWN engagement. The producer that makes this a system rather than a table.
   *
   * Scoped by the action grant to exactly one case, exactly as `/v1/internal/case` is: a run cannot
   * park somebody else's engagement, and the project comes from the case the grant names rather than
   * from anything the model wrote. That matters more here than on most internal routes, because the
   * thing being written is an instruction to spawn a run later — the one kind of row where a bad
   * tenant is a delayed cross-tenant action rather than an immediate error.
   *
   * Not gated by an approval, because parking sends nothing and spends nothing. What the resume
   * spawns IS gated, by every gate a fresh run has.
   */
  app.post("/v1/internal/wait", async (c) => {
    const grant = await getActionGrant((c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, ""));
    if (!grant) return c.json({ ok: false, error: "invalid action token" }, 401);
    if (!grant.caseId) return c.json({ ok: false, error: "this task is not part of a case" }, 404);
    const kase = await domain.getCase(grant.caseId);
    if (!kase) return c.json({ ok: false, error: "not found" }, 404);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const resume = (b.resume ?? {}) as { task_type?: unknown; input?: unknown };
    const taskType = String(resume.task_type ?? "");
    const types = loadWedge(kase.wedge)?.manifest.task_types;
    if (types && Object.keys(types).length && !types[taskType]) {
      return c.json({ ok: false, error: `the "${kase.wedge}" service does not do "${taskType}"` }, 400);
    }
    const armed = await armWait(domain, {
      project_id: kase.project_id ?? "",
      case_id: kase.id,
      reason: String(b.reason ?? ""),
      // Same two spellings a founder's route accepts. An agent parking its own engagement on "every
      // receipt is in" is the motivating case for the join — `books-keeper` could only ever park on
      // one — and it goes through the identical validation.
      condition: b.condition as never,
      conditions: b.conditions as never,
      mode: b.mode as never,
      resume: { task_type: taskType, input: (resume.input as Record<string, unknown>) ?? {} },
      expires_at: typeof b.expires_at === "string" ? b.expires_at : undefined,
    });
    if (!armed.ok) return c.json({ ok: false, error: armed.error }, 400);
    await ensureWaitSchedule(domain, kase.project_id ?? "").catch(() => {});
    return c.json({ ok: true, wait: armed.wait });
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
        return { error: `there is no "${b.stage}" stage — this service has: ${stages.join(", ")}` };
      }
      patch.stage = b.stage;
      event = { at: iso, kind: "stage_changed", from: kase.stage, to: b.stage, note: typeof b.note === "string" ? b.note : undefined, actor };
    }
    /**
     * Link this case to a client — the conversion, and the join that did not exist.
     *
     * A prospect's case is opened before the client does; that is what a prospect IS. So `client_id`
     * being write-once-at-create meant a won deal could never be attached to the customer it
     * produced: `won` was a stage nothing could act on, delivered artifacts never appeared under
     * anyone, and the outbound half of the business had no edge into the fulfilment half.
     *
     * Three rules, each one a failure that would otherwise be silent:
     *   · the client must EXIST and be in THIS case's project. Trusting an id from a request body
     *     is how a case gets stapled to another tenant's customer, and this codebase has shipped a
     *     cross-tenant read before;
     *   · re-pointing an already-linked case is refused rather than accepted, because the caller
     *     that sends it is a double-submit or a bug, and both should be told;
     *   · re-sending the SAME id is a no-op that succeeds, so a retried conversion is safe.
     */
    if (typeof b.client_id === "string" && b.client_id && b.client_id !== kase.client_id) {
      if (kase.client_id) {
        return { error: `this case already belongs to client ${kase.client_id}` };
      }
      const cl = await domain.getClient(b.client_id);
      if (!cl || cl.project_id !== kase.project_id) return { error: "unknown client" };
      patch.client_id = b.client_id;
      if (!event) event = { at: iso, kind: "note", note: `linked to client ${b.client_id}`, actor };
    }
    // `data` merges rather than replaces, so a partial update can't wipe the engagement's state.
    if (b.data && typeof b.data === "object") patch.data = { ...kase.data, ...(b.data as Record<string, unknown>) };
    if (typeof b.title === "string") patch.title = b.title;
    if (typeof b.due_at === "string") patch.due_at = b.due_at;
    if (typeof b.meeting_at === "string") patch.meeting_at = b.meeting_at;
    if (b.meeting_at === null) patch.meeting_at = undefined;
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

  /**
   * What recurring work THIS project should be doing, and what it is not doing instead.
   *
   * ═══ WHY A ROUTE AND NOT JUST A LOG LINE ═══
   *
   * `/v1/schedules` answers "what is on the clock". It cannot answer the question that matters,
   * which is "what SHOULD be on the clock and is not" — and that is precisely the shape of the bug
   * upkeep.ts exists for. A business that raises invoices and has no dunning wedge, or one that asks
   * clients for documents on an install where nothing declares `nudge_client_request`, has a real,
   * permanent, silent gap; `/v1/schedules` shows it an empty list identical to a healthy quiet week.
   *
   * `ensureUpkeep` rather than a pure read, so opening this page REPAIRS a project whose schedules
   * predate the module. Idempotent, so it stays a read on every visit after the first.
   *
   * The role map rides along because it is the answer to "why is dunning blocked" one level down,
   * and because `wedgeRoleMap` was written for a `/v1/wedge-roles` route that its own comment
   * describes and that does not exist anywhere in this file. One surface for "what can this install
   * do" beats two, one of which is imaginary.
   */
  app.get("/v1/upkeep", async (c) => {
    const set = accessible(c);
    const named = c.req.header("x-mycel-project");
    // Same rule as every other single-project read here: an explicit header when the caller can see
    // more than one, and never a default. A defaulted scope is how both of this repo's cross-tenant
    // leaks shipped, and this route reports a project's invoicing and client-chasing posture.
    const projectId = named && set.has(named) ? named : set.size === 1 ? [...set][0] : undefined;
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    const report = await ensureUpkeep(domain, projectId);
    return c.json({ ...report, roles: wedgeRoleMap() });
  });
  /**
   * Which wedge holds which role on this install.
   *
   * ═══ IT WAS CALLED BEFORE IT EXISTED ═══
   *
   * `roles.ts` describes this route in two comments and `wedgeRoleMap` was written for it, but it
   * was never registered — while the cloud's "Write me one" path (`startWritingService`) fetches
   * `/v1/wedge-roles` to find the shaping agent by ROLE rather than by directory name, which is
   * exactly the discipline roles.ts exists to enforce. Every call 404'd, so the escape hatch for a
   * business no installed service fits — the whole answer to "we can't run this yet" — reported
   * "Couldn't reach the engine. Try again in a moment." for everyone, forever. Found while walking
   * the funnel for other instances of the pre-payment deadlock; it is the same class of bug, a step
   * that cannot be completed and says something transient about it.
   *
   * NOT PROJECT-SCOPED, and `roles.ts` gives the full argument: this is a fact about `wedges/` on
   * disk, baked into the image, not tenant data. The second question — "is that wedge enabled for
   * THIS project?" — is answered by `projectAllowsWedge` at the point of use and is not what this
   * route serves. `/v1/upkeep` also carries the map, for a project's posture; this is the bare fact
   * on its own, for callers that only need to know who does what.
   */
  app.get("/v1/wedge-roles", (c) => c.json(wedgeRoleMap()));

  app.post("/v1/schedules", async (c) => {
    const projectId = writeProjectId(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    if (!b.name || !b.wedge || !b.task_type || !b.cadence) {
      return c.json({ error: "name, wedge, task_type and cadence are required" }, 400);
    }
    const wedge = loadWedge(String(b.wedge));
    if (!wedge) return c.json({ error: unknownService(b.wedge) }, 400);
    const types = wedge.manifest.task_types;
    if (types && Object.keys(types).length && !types[String(b.task_type)]) {
      return c.json({ error: `the "${b.wedge}" service does not do "${b.task_type}"` }, 400);
    }
    if (!identity.projectAllowsWedge(projectId, String(b.wedge))) {
      return c.json({ error: serviceNotEnabled(b.wedge) }, 403);
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
      next_run_at: firstRun(cadence, new Date(), scheduleKey(projectId, String(b.task_type))),
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
      next_run_at: b.cadence ? firstRun(b.cadence as Cadence, new Date(), existing.id) : undefined,
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
    if (!task) return c.json({ error: "schedule produced no run" }, 409);
    await domain.updateSchedule(s.id, { last_run_at: new Date().toISOString(), last_task_id: task.id });
    return c.json({ ok: true, task_id: task.id }, 201);
  });

  // ── Wedge config + living knowledge ──
  // The definition (wedge.json + skills) is authored/versioned on disk; knowledge is DATA the
  // founder edits at runtime (uploads, corrections) — no redeploy. At task time the runtime merges
  // disk knowledge + these live items so the agent is grounded in the latest.

  /**
   * The catalogue: every wedge this kernel can actually run, condensed to what it does.
   *
   * `GET /v1/meta` already returns the slugs, and a slug is not an answer to "can you run my
   * business?". The onboarding flow has to tell a founder honestly whether what they sell maps to
   * anything here — and the shaper agent has to reason against the real list rather than against
   * the two blueprints that happen to be packaged. Both need the titles and the job descriptions,
   * so both read this.
   *
   * Deliberately NOT project-scoped. It describes the kernel's capabilities, not a tenant's data,
   * and there is nothing here a signed-in member of any org should not see. The `blueprint` field
   * is the join back to `/v1/blueprints` — present only when a wedge ships one, because a wedge
   * with no blueprint cannot be provisioned in one call and a UI that offers to is lying.
   */
  app.get("/v1/wedges", async (c) => {
    let slugs: string[] = [];
    try {
      slugs = readdirSync(wedgesDir()).filter((d) => existsSync(join(wedgesDir(), d, "wedge.json")));
    } catch {
      /* no wedges dir — an empty catalogue is a real answer, not a 500 */
    }
    /**
     * ═══════════════════════════════════════════════════════════════════════════════════════════
     * AND THE SERVICES THIS BUSINESS HAD WRITTEN FOR IT
     * ═══════════════════════════════════════════════════════════════════════════════════════════
     *
     * This read the wedges DIRECTORY and nothing else, so a written service was invisible to every
     * surface that asks "what can you run" — including the shaping agent, whose whole job is to
     * answer that question against a founder's own words.
     *
     * `brand-and-website-projects` was authored for a real brand studio on 14 August and promoted.
     * It is live. Every brand studio shaped since has been offered the same eight directory trades,
     * none of which is brand or web design, and has settled on the nearest miss — four of them on
     * `invoice-chaser`. The service that fits them existed the whole time and nothing could see it.
     *
     * A written service is the mechanism by which this product covers a trade nobody packaged. If
     * it is not in the catalogue, the mechanism runs once per business and never compounds.
     *
     * ═══ SCOPED TO THE CALLER, AND THAT IS A LIMIT WORTH NAMING ═══
     *
     * The header above says this route is "deliberately NOT project-scoped ... it describes the
     * kernel's capabilities, not a tenant's data". That stays true of the directory half. A written
     * service is the other thing — it belongs to the business it was written for, and publishing
     * one tenant's service definition to another is a decision about their work, not a cache
     * question. So a caller sees the directory plus THEIR OWN promoted services.
     *
     * Which means this fixes the founder whose service was written and then ignored, and does NOT
     * yet make the catalogue compound across businesses. That second step — a trade learned once
     * and offered to everyone in it afterwards — is the growth mechanism, and it is somebody's
     * decision rather than a refactor.
     */
    const set = accessible(c);
    const named = c.req.header("x-mycel-project");
    const projectId = named && set.has(named) ? named : set.size === 1 ? [...set][0] : undefined;
    // `LoadedWedge` carries the manifest and not the slug it was asked for, so the slug rides along.
    const written = projectId
      ? await Promise.all(
          (await promotedSlugs(projectId).catch(() => [] as string[])).map(async (slug: string) => ({
            slug,
            loaded: await loadProjectWedge(projectId, slug).catch(() => null),
          })),
        ).catch(() => [])
      : [];
    const blueprints = listBlueprints();
    const out = slugs.flatMap((slug) => {
      const w = loadWedge(slug);
      if (!w) return [];
      const m = w.manifest;
      return [
        {
          wedge: slug,
          title: m.title ?? slug,
          // The job descriptions are the only place a wedge says in prose what it DOES, which makes
          // them the thing worth matching a founder's own words against.
          jobs: Object.entries(m.task_types ?? {}).map(([name, t]) => ({
            task_type: name,
            description: t.description ?? "",
          })),
          connections: m.connections ?? [],
          // Normalised to a real boolean rather than passed through as `boolean | undefined`, so a
          // console can write `w.internal` without each caller re-deciding which way absent falls.
          // See `WedgeManifest.internal` for what it means and why it is declared, not inferred.
          internal: m.internal === true,
          blueprint: blueprints.find((b) => b.wedge === slug)?.blueprint,
        },
      ];
    });
    /*
      Appended, not merged: a written service has its own slug and cannot collide with a directory
      one (`authored.ts` prefixes them). Same shape as the directory entries, so every consumer —
      the shaper's catalogue, the services list, onboarding — reads one list and does not care which
      half a trade came from. `blueprint` is absent because a written service is provisioned with
      the business it was written for, not from a packaged blueprint.
    */
    for (const { slug, loaded } of written) {
      if (!loaded) continue;
      const m = loaded.manifest;
      out.push({
        wedge: slug,
        title: m.title ?? slug,
        jobs: Object.entries(m.task_types ?? {}).map(([name, t]) => ({
          task_type: name,
          description: (t as { description?: string }).description ?? "",
        })),
        connections: m.connections ?? [],
        internal: m.internal === true,
        blueprint: undefined,
      });
    }
    return c.json(out);
  });

  app.get("/v1/wedges/:wedge", async (c) => {
    const slug = c.req.param("wedge");
    const w = loadWedge(slug);
    if (!w) return c.json({ error: unknownService(slug) }, 404);
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


  // The wedge that reads one line about a business and drafts both the shape and the questions
  // worth asking about it. Onboarding's only agent, and the only source of questions in this system
  // that knows who is answering them.
  // Resolved from what a wedge DECLARES (`provides: ["business_shaping"]`), never from its
  // directory name. `wedgeForRole` returns undefined on an install that ships no shaper — which is a
  // legitimate install, not an error — and every reader below already treats "no shape" as a state
  // it can render. A slug here meant onboarding silently attributed questions to a directory that
  // might not exist.
  const SHAPER_WEDGE_SLUG = wedgeForRole("business_shaping");

  /** Disk catalogue, or a promoted written service for THIS project. `loadWedge` cannot see authored slugs. */
  async function loadedForProject(projectId: string, slug: string): Promise<LoadedWedge | null> {
    if (isAuthoredSlug(slug)) return loadProjectWedge(projectId, slug);
    return loadWedge(slug);
  }

  // ── Intake: what the business knows, and what it still needs to be told ──
  // The queue merges the wedge's declared questions with gaps the agent hit on real jobs. An answer
  // becomes a knowledge item the agent is grounded on — same store as everything else.
  app.get("/v1/wedges/:wedge/intake", async (c) => {
    const wedgeSlug = c.req.param("wedge") ?? "";
    const projectId = writeProjectId(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    const wedge = await loadedForProject(projectId, wedgeSlug);
    if (!wedge) return c.json({ error: unknownService(wedgeSlug) }, 404);
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

  /**
   * The onboarding interview: which few questions are worth this founder's patience.
   *
   * Distinct from `/intake` above, which is exhaustive by design because it backs a page someone
   * opens on purpose. This backs a conversation nobody opted into, and the founder's brief named the
   * hard part: "we should only ask the high-quality ones, the ones that matter."
   *
   * Three sources, one ranked queue, capped — see `buildInterview`. The ranking is deterministic
   * code, not a second model call, and every question comes back with `selected_because` so the UI
   * can print why it is being asked. A question whose reason would embarrass us on screen is a
   * question we should not be asking, and this is what makes that visible.
   *
   * `:wedge` is the wedge that will DO the work, so answers land on the knowledge the working agent
   * actually reads. The candidate questions come from the business-shaper run regardless, because
   * that is the only source in the system that knows who is answering.
   */
  app.get("/v1/wedges/:wedge/interview", async (c) => {
    const wedgeSlug = c.req.param("wedge") ?? "";
    // `writeProjectId`, not the accessible set. Every question, every answer and every knowledge
    // write in this flow belongs to exactly ONE project, and a route that fell back to "any project
    // this caller can see" is the shape of the cross-tenant leak this codebase has already had once.
    const projectId = writeProjectId(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    const wedge = await loadedForProject(projectId, wedgeSlug);
    if (!wedge) return c.json({ error: unknownService(wedgeSlug) }, 404);

    const budgetParam = Number(c.req.query("budget"));
    const drafted = await readDraftedQuestions(projectId);
    const [gaps, knowledge] = await Promise.all([
      domain.listGaps(projectId, wedgeSlug),
      domain.listKnowledge(wedgeSlug, projectId),
    ]);
    return c.json(
      buildInterview({
        wedge: wedgeSlug,
        drafted,
        declared: wedge.manifest.intake ?? [],
        gaps,
        knowledge,
        budget: Number.isFinite(budgetParam) && budgetParam > 0 ? Math.min(budgetParam, 10) : undefined,
      }),
    );
  });

  /**
   * The candidate questions the shaper drafted for this project, from its own run output.
   *
   * The task list IS the record — the newest succeeded `draft_questions` run — for the same reason
   * onboarding stores no pointer to the shaping run: an id in a column goes stale, and re-running
   * the draft is just another run that becomes the newest one.
   *
   * Anything unreadable comes back empty rather than throwing. An interview with no drafted
   * questions is still a real interview — the wedge's declared questions and any recorded gaps are
   * both still there — whereas an interview that 500s is a founder stuck on a screen.
   */
  async function readDraftedQuestions(projectId: string): Promise<DraftedQuestion[]> {
    try {
      // Scoped in the QUERY — see `/v1/tasks`. This is onboarding: it looks for the founder's OWN
      // shaping run, so a busy neighbour means a new signup cannot find what it is waiting on.
      const tasks = (await store.listTasks({ wedge: SHAPER_WEDGE_SLUG, project_ids: [projectId], limit: 200 }))
        .filter(
          (t) =>
            t.project_id === projectId &&
            t.task_type === "draft_questions" &&
            t.status === "succeeded",
        )
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
      if (!tasks.length) return [];
      // The NEWEST result.txt, not the first: a run can write its output more than once, and taking
      // the first would resurrect a stale set of questions.
      const arts = (await store.listArtifacts(tasks[0].id))
        .filter((a) => a.name === "result.txt")
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
      if (!arts.length) return [];
      // `listArtifacts` is metadata only — the bytes are the expensive half and it deliberately does
      // not carry them. Fetch the one row we want, then fill its content from the backend.
      const full = await store.getArtifact(arts[0].id);
      if (!full) return [];
      const raw = (await withContent(full)).content;
      // Tolerate a fenced block, the way the output validator does.
      const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
      const parsed = JSON.parse((fenced?.[1] ?? raw).trim()) as { questions?: unknown };
      if (!Array.isArray(parsed.questions)) return [];
      return parsed.questions.filter(
        (q): q is DraftedQuestion =>
          !!q &&
          typeof q === "object" &&
          typeof (q as DraftedQuestion).id === "string" &&
          typeof (q as DraftedQuestion).ask === "string",
      );
    } catch {
      return [];
    }
  }

  app.post("/v1/wedges/:wedge/intake/:question", async (c) => {
    const wedgeSlug = c.req.param("wedge") ?? "";
    const questionId = c.req.param("question") ?? "";
    const projectId = writeProjectId(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    const wedge = await loadedForProject(projectId, wedgeSlug);
    if (!wedge) return c.json({ error: unknownService(wedgeSlug) }, 404);

    const b = (await c.req.json().catch(() => ({}))) as {
      answer?: string;
      ask?: string;
      client_id?: string;
      /**
       * Set by the setup flow, and by nothing else. It downgrades the distilled rule's provenance
       * to `onboarding` — see `RuleSource` in knowledge.ts.
       *
       * Caller input deciding a provenance label looks alarming and is not: the only direction it
       * can move the label is WEAKER. A caller who lies by setting it gets a rule that loses more
       * arguments than it should. The dangerous direction is omission, and that would be a bug in
       * our own onboarding screen rather than anything a tenant can do to another.
       */
      during_onboarding?: boolean;
    };
    const answer = typeof b.answer === "string" ? b.answer.trim() : "";
    if (!answer) return c.json({ error: "answer is required" }, 400);

    const declared = (wedge.manifest.intake ?? []).find((q) => q.id === questionId);
    const gap = isGapId(questionId)
      ? (await domain.listGaps(projectId, wedgeSlug)).find((g) => g.id === questionId)
      : undefined;
    /**
     * The question text, resolved from the authoritative source before the caller's.
     *
     * The drafted lookup is new and is what makes the onboarding interview answerable: those
     * questions exist only in a run's output, so they are neither declared nor gaps. Resolving them
     * here rather than trusting `b.ask` means the file stores the question we actually ASKED — a
     * client that posted a different `ask` alongside the same id would otherwise leave the agent
     * grounded on an answer filed under a question nobody was ever shown.
     */
    const drafted = (await readDraftedQuestions(projectId)).find((q) => q.id === questionId);
    const ask = declared?.ask ?? gap?.question ?? drafted?.ask ?? b.ask;
    if (!ask) return c.json({ error: "unknown question" }, 404);

    /**
     * WHO THIS ANSWER IS ABOUT — decided here, never left blank.
     *
     * A gap is raised BY a run, and that run is about a client or it is not. Inheriting the task's
     * client is what makes "why is this invoice disputed?" — a question that can only be answered
     * about one customer — storable at all: before this it was filed unattributed, which retrieval
     * read as house-wide, and the founder's answer about one client's dispute was mounted into
     * every other client's run.
     *
     * A declared or drafted question carries no client and is `house`: it was authored by a wedge
     * author or asked on the onboarding screen, both of which happen before any client exists, and
     * both of which ask about the BUSINESS ("what is your late fee?"). That is an explicit label,
     * not a default — the default, wherever nothing decides, is `client` (see `sensitivityOf`).
     *
     * An explicit `client_id` in the body wins, and is checked against the caller's own project
     * first: a client id from a request body is caller input, and a caller must not be able to file
     * knowledge against a tenant it cannot see.
     */
    const asked = typeof b.client_id === "string" ? b.client_id.trim() : "";
    if (asked && !(await clientInProject(asked, projectId))) {
      return c.json({ error: "unknown client" }, 404);
    }
    let clientId: string | undefined = asked || undefined;
    if (!clientId && gap) {
      // The most recent task to hit it. A gap can span several runs; the latest is the one the
      // founder is looking at, and every task on the gap is in this project by construction.
      for (const taskId of [...gap.task_ids].reverse()) {
        const t = await store.getTask(taskId);
        if (t?.project_id !== projectId) continue;
        const cid = taskClientId(t);
        if (cid) { clientId = cid; break; }
      }
    }

    const item = await recordAnswer(domain, {
      projectId,
      wedge: wedgeSlug,
      questionId,
      ask,
      answer,
      kind: declared?.kind,
      ...(clientId ? { sensitivity: "client" as const, clientId } : { sensitivity: "house" as const }),
    });
    // Answering closes the gap, but recordGap reopens it if the agent hits it again — which is the
    // signal that the answer didn't actually cover the case.
    if (gap) await domain.setGapStatus(gap.id, projectId, "answered");

    /**
     * The same answer, distilled into a retrievable rule.
     *
     * The markdown file above is what the founder sees and edits; the rule is what retrieval can
     * rank, budget, contradict and supersede — and, crucially, its subject IS the question id, which
     * is what lets `detectRecurrence` see that this gap is now covered and stop asking. Before this,
     * answering a question wrote a file and the gap counter climbed forever.
     *
     * Both, not one: a file the founder cannot find in the UI is not editable knowledge, and a rule
     * is not readable prose.
     */
    const { rule, outcome } = await recordGapAnswer(getKnowledgeStore(), {
      project_id: projectId,
      wedge: wedgeSlug,
      question_id: questionId,
      question: ask,
      answer,
      // Stated, not observed — but only when the caller says so. A gap answered from the Knowledge
      // page after a real run is the strong kind and must keep its label.
      stated: b.during_onboarding === true,
      // The same scope as the file. `distillFromAnswer` has taken a `client_id` all along and this
      // was the one caller that never passed it, so the distilled rule — the form retrieval
      // actually ranks and inlines — was house-wide even when the answer was about one client.
      client_id: clientId,
    });
    /**
     * `learned` is what the setup flow renders on its "here is what that actually did" screen.
     *
     * It is returned rather than derived by the client because `declined` is invisible from the
     * outside: on a decline `rule` is the rule that was ALREADY there, which is byte-identical in
     * shape to a successful write. A screen that promised "learned" over a candidate the kernel
     * threw away would be exactly the dishonesty that screen exists to prevent.
     */
    return c.json(
      {
        ok: true,
        knowledge_id: item.id,
        name: item.name,
        rule_id: rule?.id,
        client_id: clientId,
        learned: outcome
          ? { outcome, rule_id: rule?.id, text: rule?.text, kind: rule?.kind, source: rule?.provenance.source }
          : undefined,
      },
      201,
    );
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
    const b = (await c.req.json().catch(() => ({}))) as {
      question?: string;
      fallback?: string;
      ask_client?: boolean;
      kind?: "document" | "answer" | "decision";
      detail?: string;
    };
    const question = typeof b.question === "string" ? b.question.trim() : "";
    if (!question) return c.json({ ok: false, error: "question is required" }, 400);

    const task = await store.getTask(grant.task_id);
    if (!task?.project_id) return c.json({ ok: false, error: "task has no project" }, 400);

    // WHICH QUEUE is a data-protection decision, not a routing detail — see `routeGap` in intake.ts.
    // A question only the customer can answer ("where is your receipt for the 14 March payment?")
    // used to land in the founder's intake queue, where it is unanswerable, and an answer filed
    // there becomes wedge-scoped grounding mounted into every OTHER customer's run.
    const route = routeGap(
      {
        question,
        fallback: typeof b.fallback === "string" ? b.fallback : undefined,
        ask_client: b.ask_client === true,
        kind: b.kind,
        detail: typeof b.detail === "string" ? b.detail : undefined,
      },
      {
        project_id: task.project_id,
        wedge: task.wedge,
        task_id: task.id,
        client_id: task.client_id,
        case_id: task.case_id,
      },
    );

    /**
     * ═══ AND CAN THIS CLIENT ACTUALLY BE REACHED? ═══
     *
     * All fifty-one client requests in production have `thread_id` NULL. Twenty-one projects, one
     * channel, one thread, one message ever sent. The chain that makes this product autonomous —
     * ask, wait, resume — has never once completed, because the ask was filed against somebody who
     * was never told.
     *
     * `portal-threads.ts` already refuses to open a conversation with no channel. This path handed
     * back a 201 and a request id for the identical missing thing. One refuses loudly, the other
     * files silently, and the silent one is where the value runs.
     *
     * REDIRECTED, NOT DISCARDED. The run genuinely does not know something; throwing that away
     * leaves it to guess, which is what this whole route exists to prevent. It becomes a founder
     * gap, in front of the one person who can act — and who can answer on the client's behalf.
     */
    if (route.to === "client") {
      const reach = clientReachable(
        await domain.listConnections().catch(() => []),
        route.request.project_id,
        route.request.client_id ? await domain.getClient(route.request.client_id).catch(() => undefined) : undefined,
      );
      if (!reach.ok) {
        /**
         * Re-routed through `routeGap` with `ask_client: false` rather than hand-building a gap.
         * That function owns the founder shape — the id derivation, which fields travel and which
         * deliberately do not (`fallback` is founder-plane and must never reach a customer). A second
         * copy here would drift from it the first time either changed.
         */
        const asFounder = routeGap(
          { question, fallback: typeof b.fallback === "string" ? b.fallback : undefined, ask_client: false },
          { project_id: task.project_id, wedge: task.wedge, task_id: task.id, client_id: task.client_id, case_id: task.case_id },
        );
        await emitEvent(store, grant.task_id, "progress", {
          note: redirectedNote(question, reach.because ?? "the client cannot be reached"),
        });
        const gap = asFounder.to === "founder" ? await domain.recordGap(asFounder.gap) : undefined;
        return c.json({
          ok: true,
          asked: "founder",
          redirected: true,
          recorded: gap?.id,
          because: reach.because,
          note: "Answer it yourself, or connect a mailbox so the next one reaches them. Do not wait on a client reply.",
        });
      }

      /**
       * THE SECOND DOOR ONTO THE SAME CLIENT. See `mayAskClient`.
       *
       * A run that refuses opens requests through `openMaterialRequests`; a run that asks mid-episode
       * arrives here. One production run used both, and the client finished with the same three
       * questions asked three times in three phrasings. A ceiling on one door is not a ceiling.
       *
       * Refused rather than queued, and the agent is TOLD so in the same breath: a run that believes
       * it has asked the client will park on a wait that nothing will ever satisfy, which is a
       * stalled engagement no log explains. Being told the client is already holding three questions
       * lets it either proceed on what it has or stop honestly.
       */
      if (route.request.case_id) {
        const openOnCase = await getRequestStore().listRequests({
          project_id: route.request.project_id,
          case_id: route.request.case_id,
          status: "open",
        });
        /**
         * THIS RUN'S OWN ASKS DO NOT COUNT AGAINST IT.
         *
         * `chase_receipts` asks for four missing receipts in one episode, and they join into ONE
         * wait the client answers as a single list — that is batching working exactly as
         * books-keeper's `what-not-to-guess` prescribes, and a flat ceiling would silently drop the
         * fourth receipt and file three quarters of a month looking entirely correct.
         *
         * What went wrong at Brightline was not a run asking for several things. It was a NEW run
         * piling onto questions the client had not answered yet — kickoff's three, then a run's
         * four, then the refusal path's three, all the same handful of questions in different
         * words. So the rule is about whose questions are already outstanding, not how many this
         * run has: a run may ask freely, and may not start a second pile on top of somebody else's.
         */
        const already = openOnCase.filter((r) => r.task_id !== grant.task_id);
        if (!mayAskClient(already.map((r) => r.ask), route.request.ask)) {
          await emitEvent(store, grant.task_id, "progress", {
            note: `Not asked — this client already has ${already.length} open question(s) on this engagement: ${already
              .map((r) => r.ask)
              .slice(0, 3)
              .join(" / ")}`,
          });
          return c.json({
            ok: false,
            asked: false,
            error: "this client already has the maximum open questions on this engagement",
            open_asks: already.map((r) => r.ask).slice(0, 5),
            note: "Proceed with what you have, or stop and say what is missing — do not wait on a question that was not sent.",
          });
        }
      }
      const req = await getRequestStore().createRequest(route.request);
      /**
       * THE DENOMINATOR. Production has raised fifty-one asks and had three answered; the portal
       * fires an event for the three and nothing fired for the fifty-one, so the worst conversion
       * rate in the product was invisible in the only place anyone would look for it.
       */
      capture(task.project_id, KERNEL_EVENT.requestRaised, {
        wedge: task.wedge,
        task_type: task.task_type,
        kind: req.kind,
        has_case: !!task.case_id,
      });
      // The timeline says who was asked, because "waiting on the customer" and "waiting on you" are
      // different states and a founder watching a stalled run needs to tell them apart.
      await emitEvent(store, grant.task_id, "progress", {
        note: `Asked the client: ${question}`,
        request_id: req.id,
        client_id: req.client_id,
      });
      /**
       * AND THE ENGAGEMENT PARKS ITSELF. This is the line that turns waiting from a capability into
       * a behaviour — see `armDeclaredWait`.
       *
       * Here rather than in `routeGap` because this is where the request row acquires the id the
       * wait's condition names. `.catch` and a discarded result on purpose: the ask is the point and
       * the wait is the follow-through, so a wedge that declares nothing, a case already parked on
       * something else, or a store that blipped must all leave the customer's request standing.
       */
      const parked = await armDeclaredWait(domain, {
        project_id: task.project_id,
        case_id: task.case_id,
        wedge: task.wedge,
        task_type: task.task_type,
        request_id: req.id,
        // The customer-facing sentence, so a seven-part join's outstanding list reads as "the March
        // receipt, the Amex statement" rather than as seven UUIDs.
        ask_label: req.ask,
        /**
         * The author's declaration, or the one they made INTO this job. See wait-declaration.ts —
         * in production, every ask ever raised came from a job with no `waits_for` of its own, so
         * this fallback is the difference between an answer starting the work and an answer
         * landing in a row nobody reads.
         */
        declaredBy: (w, t) => declaredWaitFor(loadWedge(w)?.manifest, t)?.spec,
        declaresTaskType: (w, t) => !!loadWedge(w)?.manifest.task_types?.[t],
      }).catch(() => undefined);
      if (parked) {
        // Ensured on the first arm rather than at project creation, exactly as the two hand-armed
        // doors do it: a business with no waits should not carry a tick that finds nothing.
        await ensureWaitSchedule(domain, task.project_id).catch(() => {});
        await emitEvent(store, grant.task_id, "progress", {
          note: `Parked this engagement until they answer — it resumes as ${parked.resume.task_type}.`,
          wait_id: parked.id,
        });
      } else if (task.case_id) {
        /**
         * A DEAD ASK, SAID OUT LOUD.
         *
         * The ask goes out either way — a run that needs a bank statement needs it, and refusing
         * here would trade a stuck engagement for a broken one. But when nothing parked, answering
         * this question starts nothing, forever. That was silent, and it is why production holds
         * nineteen open asks against three that were ever answered.
         *
         * Only when there IS a case: an ad-hoc ask from a run with no engagement has nothing to
         * resume by design, and warning about it would train everyone to ignore the warning.
         */
        console.warn(deadAskWarning(task.wedge, task.task_type, req.ask));
        await emitEvent(store, grant.task_id, "progress", {
          note:
            `Nothing will resume when they answer this — ${task.wedge}:${task.task_type} declares ` +
            `no follow-on job. The answer will be recorded and the engagement will stay parked on you.`,
          request_id: req.id,
        });
      }
      return c.json({ ok: true, asked: "client", request_id: req.id, because: route.because, wait_id: parked?.id });
    }

    const gap = await domain.recordGap(route.gap);
    // On the timeline too, so the founder sees it in context rather than only in a queue.
    await emitEvent(store, grant.task_id, "progress", {
      note: `Missing knowledge: ${question}`,
      gap_id: gap.id,
      hits: gap.hits,
    });
    return c.json({ ok: true, asked: "founder", recorded: gap.id, hits: gap.hits, because: route.because });
  });

  /**
   * What the agent has actually learned here — the distilled rules, not the markdown.
   *
   * Project-scoped as a REQUIRED argument, exactly like `listKnowledge`: rules are the most private
   * thing in the system (they are a description of how one specific business makes its judgements),
   * so this reads per accessible project rather than reading globally and filtering after. The
   * post-filter pattern is what let the runtime leak survive unnoticed.
   *
   * `needs_review` and `corrections_since` ride along because they are the two things a founder
   * cannot see any other way: a prohibition that was quietly repealed by a weaker correction, and a
   * rule the agent is still being corrected against.
   */
  app.get("/v1/wedges/:wedge/rules", async (c) => {
    const wedgeSlug = c.req.param("wedge") ?? "";
    const knowledge = getKnowledgeStore();
    const rules = (
      await Promise.all([...accessible(c)].map((pid) => knowledge.listRules(pid, { wedge: wedgeSlug })))
    ).flat();
    const status = c.req.query("status");
    return c.json(status ? rules.filter((r) => r.status === status) : rules);
  });

  app.get("/v1/wedges/:wedge/knowledge/recurrence", async (c) => {
    const wedgeSlug = c.req.param("wedge") ?? "";
    const projectId = writeProjectId(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    const [gaps, rules] = await Promise.all([
      domain.listGaps(projectId, wedgeSlug),
      getKnowledgeStore().listRules(projectId, { wedge: wedgeSlug }),
    ]);
    const threshold = Number(c.req.query("threshold")) || undefined;
    return c.json(
      detectRecurrence(
        gaps.map((g) => ({
          id: g.id,
          question: g.question,
          hits: g.hits,
          task_ids: g.task_ids ?? [],
          status: g.status,
        })),
        rules,
        threshold,
      ),
    );
  });

  /**
   * IS IT GETTING BETTER? The one question the rules table structurally cannot answer.
   *
   * `recurrence` above reports what is still going wrong, which is the right thing to put in front
   * of a founder and a permanently discouraging way to answer "is this working". It reads the rules
   * table, and the rules table only holds corrections — a clean approval creates no row, so asking
   * it how often the agent was RIGHT is asking a list of complaints how the restaurant is doing.
   *
   * The `observations` table has held that answer since it shipped. It records every human verdict,
   * clean ones included, and until `knowledge-metrics.ts` nothing outside its own tests had ever
   * read it. This is the wire.
   *
   * TWO WINDOWS, because a single rate is a fact about today and the founder is asking about a
   * trend. Default is the last 30 days against the 30 before it. One fetch covers both — the store
   * filter has `since` and no `until`, and splitting in memory over a couple of hundred rows is
   * cheaper than the second round trip.
   */
  /**
   * WHAT DID THIS ACTUALLY SAVE THEM? — the question the product could never answer.
   *
   * It could always show a founder WHAT it did: a deliverable, a chased invoice, a sequence
   * advanced. It had no way to say what any of that was WORTH, which is why "does it work" stayed
   * an opinion and why a before-and-after on an acquired business would be unarguable in both
   * directions.
   *
   * `value-measure.ts` has held the method since it was written and could not run: it needs
   * `humanHours`, and nothing in the system produced that number. The chain that now does —
   * research finds what the trade takes, `draft_service` copies it onto the job, the submit route
   * stamps it on the version — ends here.
   *
   * ONE ITEM PER DELIVERABLE, NOT PER VERSION. A deliverable revised three times is one piece of
   * work that took one practitioner's day, and counting each version would multiply a founder's
   * savings by how many times their client asked for changes — which would make an unhappy
   * engagement look like the most valuable one on the page.
   *
   * `rate` is a query parameter rather than a stored field because it is the founder's own number
   * and they are the only authority on it. Without one the hours stand alone, which is the honest
   * shape: hours are the measurement and money is a conversion the founder applies.
   */
  app.get("/v1/value", async (c) => {
    const projectId = writeProjectId(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);

    const rate = Number(c.req.query("rate"));
    const store = getDeliverableStore();
    const rows = await store.listDeliverables({ project_id: projectId, limit: 500 });

    const items = await Promise.all(
      rows.map(async (d) => {
        const versions = await store.listVersions(projectId, d.id).catch(() => []);
        const current = versions.find((v) => v.version === d.current_version);
        return {
          id: d.id,
          kind: d.kind,
          releasedAt: current?.released_at,
          acceptedAt: d.accepted_at,
          /**
           * Withdrawn is the founder pulling work back; `change_requested` is the client sending it
           * back. `isProductive` treats a rejection as beating a release for exactly this case — work
           * that went out and came back is a spent hour, not a saved one.
           */
          rejectedAt:
            d.status === "withdrawn"
              ? d.updated_at
              : (current?.change_requested_at ?? undefined),
          humanHours: current?.human_hours,
        };
      }),
    );

    const report = measureValue(items, {
      ...(Number.isFinite(rate) && rate > 0 ? { hourlyRate: rate } : {}),
    });
    return c.json({
      ...report,
      /**
       * Said out loud, because it is the difference between "we saved you 40 hours" and "we saved
       * you at least 40 hours and could not price 12 more". A founder who sees the second one and
       * fills in the gaps gets a bigger number they can actually defend.
       */
      unestimated_note:
        report.unestimated > 0
          ? `${report.unestimated} finished ${report.unestimated === 1 ? "piece" : "pieces"} of work ` +
            `carry no time estimate, so none of them are counted above. Their jobs were authored ` +
            `without a "typical_hours" figure — the research did not find one.`
          : undefined,
    });
  });

  app.get("/v1/wedges/:wedge/knowledge/quality", async (c) => {
    const wedgeSlug = c.req.param("wedge") ?? "";
    const projectId = writeProjectId(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);

    const days = Math.min(Math.max(Number(c.req.query("days")) || 30, 1), 365);
    const now = Date.now();
    const cut = new Date(now - days * 86_400_000);
    const from = new Date(now - days * 2 * 86_400_000);

    const rows = await getKnowledgeStore().listObservations(projectId, {
      wedge: wedgeSlug,
      since: from.toISOString(),
    });
    const cutMs = cut.getTime();
    const recent = rows.filter((o) => Date.parse(o.at) >= cutMs);
    const prior = rows.filter((o) => Date.parse(o.at) < cutMs);

    const current = qualityTrend(recent);
    return c.json({
      days,
      current,
      previous: qualityTrend(prior),
      change: compareQuality(qualityTrend(prior), current),
      byTaskType: qualityByTaskType(recent),
    });
  });

  app.get("/v1/wedges/:wedge/knowledge", async (c) => {
    const set = accessible(c);
    const wedgeSlug = c.req.param("wedge");
    return c.json((await Promise.all([...set].map((pid) => domain.listKnowledge(wedgeSlug, pid)))).flat());
  });
  app.post("/v1/wedges/:wedge/knowledge", async (c) => {
    const wedge = c.req.param("wedge");
    const projectId = writeProjectId(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    // Authored services are not on disk — `loadWedge` refuses them by construction. A written
    // service that cannot receive knowledge is a service that cannot learn, which is the whole
    // product. Scope through the project so another tenant's slug is 404, not a write.
    if (!(await loadedForProject(projectId, wedge))) return c.json({ error: unknownService(wedge) }, 404);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    if (!b.name || typeof b.content !== "string") return c.json({ error: "name and content are required" }, 400);
    const item = await domain.createKnowledge({
      project_id: projectId,
      wedge,
      name: String(b.name),
      content: b.content,
      kind: (b.kind as KnowledgeItem["kind"]) ?? "document",
      source: (b.source as KnowledgeItem["source"]) ?? "uploaded",
      /**
       * A founder uploading through their own knowledge screen is describing THEIR BUSINESS —
       * there is no client in this request and no run behind it — so the row is `house` unless the
       * body names a client, in which case the label follows the name. The caller's own
       * `sensitivity`, if it sent one, is not honoured: labelling is a decision this route makes
       * from what it can verify, not a field a client gets to assert.
       */
      metadata: {
        ...((b.metadata as Record<string, unknown>) ?? {}),
        ...scopeMeta(typeof (b.metadata as any)?.client_id === "string" ? (b.metadata as any).client_id : undefined),
      },
    });
    return c.json(item, 201);
  });

  /**
   * Playbooks = the procedures this service mounts, editable without a redeploy.
   *
   * Disk skills stay the default. A save writes a versioned overlay the next run mounts. The
   * reason travels with the version so "why it got better" is a record, not a reconstruction.
   */
  app.get("/v1/wedges/:wedge/playbooks", async (c) => {
    const projectId = writeProjectId(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    const slug = c.req.param("wedge") ?? "";
    const loaded = await loadedForProject(projectId, slug);
    if (!loaded) return c.json({ error: "unknown service" }, 404);
    const live = await domain.listKnowledge(slug, projectId);
    return c.json({
      title: loaded.manifest.title ?? slug,
      jobs: Object.keys(loaded.manifest.task_types ?? {}),
      playbooks: listPlaybooks(loaded.skills, live),
    });
  });
  app.put("/v1/wedges/:wedge/playbooks", async (c) => {
    const projectId = writeProjectId(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    const slug = c.req.param("wedge") ?? "";
    const loaded = await loadedForProject(projectId, slug);
    if (!loaded) return c.json({ error: "unknown service" }, 404);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const rawName = typeof b.name === "string" ? b.name.trim() : "";
    const fromDisk = loaded.skills.find((s) => {
      const n = s.name.endsWith(".md") ? s.name : `${s.name}.md`;
      return n === rawName || n === `${rawName}.md` || s.name === rawName;
    });
    const name = fromDisk
      ? fromDisk.name.endsWith(".md")
        ? fromDisk.name
        : `${fromDisk.name}.md`
      : safePlaybookName(rawName);
    if (!name) return c.json({ error: "name the playbook with letters, numbers, hyphens" }, 400);
    const reason = typeof b.reason === "string" ? b.reason.trim() : "";
    if (!reason) return c.json({ error: "say why this version is better" }, 400);
    if (reason.length > 500) return c.json({ error: "that reason is too long" }, 400);
    const live = await domain.listKnowledge(slug, projectId);
    const knowledgeName = playbookKnowledgeName(name);
    const existing = live
      .filter((k) => k.name === knowledgeName)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
    const content =
      typeof b.content === "string"
        ? b.content
        : (existing?.content ?? fromDisk?.content ?? "");
    if (typeof b.content === "string" && !b.content.trim()) {
      return c.json({ error: "a playbook cannot be empty" }, 400);
    }
    if (!content.trim() && !existing && !fromDisk) {
      return c.json({ error: "write the playbook before saving" }, 400);
    }
    const enabled = typeof b.enabled === "boolean" ? b.enabled : (existing?.metadata?.enabled !== false);
    const now = new Date().toISOString();
    const task_types = Array.isArray(b.task_types)
      ? b.task_types.filter((t): t is string => typeof t === "string" && !!loaded.manifest.task_types?.[t])
      : undefined;
    const metadata = playbookSaveMeta(existing, { reason, enabled, now, ...(task_types ? { task_types } : {}) });
    if (existing) {
      const updated = await domain.updateKnowledge(existing.id, { content, metadata });
      return updated ? c.json(updated) : c.json({ error: "not found" }, 404);
    }
    const created = await domain.createKnowledge({
      project_id: projectId,
      wedge: slug,
      name: knowledgeName,
      content,
      kind: "document",
      source: "authored",
      metadata,
    });
    return c.json(created, 201);
  });
  // Bring your own skills: import a folder of SKILL.md files from a PUBLIC GitHub repo into THIS
  // business's own playbooks for a wedge. Founder-scoped (writes only the caller's project), and the
  // same prose-only line as the shared library — we read the markdown of each `.md`, nothing it
  // references. Hosts are fixed (api.github.com to list, raw.githubusercontent.com to fetch), so this
  // is not a request forger.
  /**
   * PUT IT BACK.
   *
   * The counterpart to every write above, and the reason `PlaybookVersion.content` exists. Until it
   * did, a founder could read that their procedure changed on Tuesday, for a reason they no longer
   * agreed with, and had no way to get Tuesday back — `updateKnowledge` overwrites content in place.
   *
   * Argued first from a machine doing the writing: the self-improvement system turned a reflection
   * run into a proposal that, once approved, rewrote a playbook. It was deleted in 59f1dd83 after
   * 261 sandbox-hours produced four proposals and nothing adopted, so every write here is now a
   * person's — which removes none of the need. An author with no undo can only walk in one
   * direction, and a founder is as capable of walking the wrong way as a reflection loop was.
   *
   * A RESTORE IS A NEW VERSION, never a rewind. The history is append-only: going back to Tuesday
   * writes Tuesday's text as today's version, with a reason saying so, and leaves everything between
   * in the record. A restore that erased the intervening versions would destroy exactly the evidence
   * somebody would need to argue about whether the restore was right.
   */

  /**
   * Read one playbook's trial and judge it. Shared by the GET and the POST so the two can never
   * disagree about whether a trial is decided — which would let a founder be shown "still running"
   * and have their conclude succeed, or the reverse.
   */
  const readTrial = async (
    pid: string,
    slug: string,
    name: string,
  ): Promise<
    | { error: string; status: 404 | 409 }
    | { body: { verdict: ReturnType<typeof judgeTrial>; row: KnowledgeItem; challenger?: string; incumbent: TrialArm; challengerArm: TrialArm } }
  > => {
    const knowledgeName = playbookKnowledgeName(name);
    const row = (await domain.listKnowledge(slug, pid))
      .filter((k) => k.name === knowledgeName)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
    if (!row) return { error: "there is no edited version of that playbook", status: 404 };
    const challenger = playbookChallenger(row.metadata);
    if (!challenger) return { error: "no version of that playbook is on trial", status: 409 };

    const file = name.endsWith(".md") ? name : `${name}.md`;
    const find = async (arm: "incumbent" | "challenger") =>
      armOf((await skillScales(domain, { project_id: pid, arm })).find((s) => s.skill === file && s.wedge === slug));
    const incumbent = await find("incumbent");
    const challengerArm = await find("challenger");
    return { body: { verdict: judgeTrial(incumbent, challengerArm), row, challenger, incumbent, challengerArm } };
  };

  /**
   * HOW A TRIAL IS GOING, AND ENDING IT.
   *
   * A trial is a challenger body sitting in a playbook's metadata while a fifth of runs read it. This
   * route is the only way to see that and the only way to finish it, and both matter: a trial nobody
   * can read is an experiment running on a business's real client work with no way to find out what
   * it decided, and one nobody can end is a permanent tax on quality that outlives whoever started it.
   *
   * GET reports. POST concludes, and refuses to conclude early — `judgeTrial` returns `running` until
   * both arms are past the floor, and this route will not override that. The whole value of the floor
   * is that it cannot be argued with in the moment somebody is impatient.
   *
   * PROMOTION GOES THROUGH THE ORDINARY SAVE PATH. `content = challenger`, written by the same call
   * a founder's own edit uses, which means the previous text lands in the version history and "put
   * this back" undoes a promotion exactly as it undoes anything else. A promotion with a bespoke
   * write path would be the one change in the system that could not be reversed.
   */
  app.get("/v1/wedges/:wedge/playbooks/trial", async (c) => {
    const pid = writeProjectId(c);
    if (!pid) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    const slug = c.req.param("wedge") ?? "";
    const name = safePlaybookName(String(c.req.query("name") ?? "").replace(/\.md$/, ""));
    if (!name) return c.json({ error: "name the playbook" }, 400);
    const t = await readTrial(pid, slug, name);
    if ("error" in t) return c.json({ error: t.error }, t.status);
    return c.json(t.body);
  });

  app.post("/v1/wedges/:wedge/playbooks/trial", async (c) => {
    const pid = writeProjectId(c);
    if (!pid) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    const slug = c.req.param("wedge") ?? "";
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const name = safePlaybookName(String(b.name ?? "").replace(/\.md$/, ""));
    if (!name) return c.json({ error: "name the playbook" }, 400);
    const t = await readTrial(pid, slug, name);
    if ("error" in t) return c.json({ error: t.error }, t.status);
    const { verdict, row, challenger } = t.body;

    if (verdict.outcome === "running") {
      return c.json({ error: `this trial is not decided yet — ${verdict.why}`, ...t.body }, 409);
    }

    const now = new Date().toISOString();
    const promote = verdict.outcome === "promote";
    const reason = (promote
      ? `promoted the version on trial: ${verdict.why}`
      : `ended the trial, kept the current procedure: ${verdict.why}`
    ).slice(0, 500);
    // The trial comes off the metadata either way. A concluded trial left in place would keep a
    // fifth of runs reading a version somebody already decided about.
    const metadata = playbookSaveMeta({ ...row, content: row.content }, {
      reason,
      enabled: playbookEnabled(row.metadata),
      now,
    });
    delete (metadata as Record<string, unknown>).challenger;
    const item = await domain.updateKnowledge(row.id, {
      content: promote ? challenger! : row.content,
      metadata,
    });
    if (!item) return c.json({ error: "not found" }, 404);
    await audit({
      project_id: pid,
      actor: c.get("scope")?.member_id ?? "member",
      action: promote ? "playbook.promoted" : "playbook.trial_ended",
      entity: "playbook",
      entity_id: name,
      detail: { wedge: slug, outcome: verdict.outcome, margin: verdict.margin },
    });
    return c.json({ ok: true, outcome: verdict.outcome, why: verdict.why, playbook: name });
  });


  /**
   * Save a playbook, refusing to clobber a concurrent write.
   *
   * `metadata` is stored as a WHOLE OBJECT and `playbookSaveMeta` is read-modify-write, so two
   * writers holding the same snapshot silently lose one of them. a comparable runtime named this exact shape in
   * `lib/metadata-merge.ts`: "a concurrent writer holding a STALE snapshot silently reverted the pin
   * (a classic read-modify-write lost update)."
   *
   * Here it is worse than a lost changelog line. Every version entry carries THE TEXT IT REPLACED,
   * so a lost update destroys the only copy of a procedure somebody could have restored — the
   * feature whose whole purpose is "you can always get it back" quietly stops being able to.
   *
   * The writers are not hypothetical or all human: a founder's own save, an improvement approval
   * starting a trial, and a trial being concluded all write this row.
   *
   * ONE RETRY, THEN A LOUD REFUSAL. The retry re-reads and recomputes against the row that actually
   * won, which is correct rather than merely hopeful. A second miss means genuine contention, and
   * telling the founder their edit did not save is far better than telling them it did while
   * silently discarding somebody else's.
   */
  const savePlaybookRow = async (
    projectId: string,
    slug: string,
    knowledgeName: string,
    build: (existing: KnowledgeItem | undefined) => { content?: string; metadata: Record<string, unknown> },
  ): Promise<KnowledgeItem | undefined | { conflict: true }> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const existing = (await domain.listKnowledge(slug, projectId))
        .filter((k) => k.name === knowledgeName)
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
      const next = build(existing);
      if (!existing) {
        return await domain.createKnowledge({
          project_id: projectId,
          wedge: slug,
          name: knowledgeName,
          content: next.content ?? "",
          kind: "document",
          source: "feedback",
          metadata: next.metadata,
        });
      }
      const saved = await domain.updateKnowledge(
        existing.id,
        next.content === undefined ? { metadata: next.metadata } : { content: next.content, metadata: next.metadata },
        { ifUpdatedAt: existing.updated_at },
      );
      if (saved) return saved;
    }
    return { conflict: true };
  };

  app.post("/v1/wedges/:wedge/playbooks/restore", async (c) => {
    const projectId = writeProjectId(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    const slug = c.req.param("wedge") ?? "";
    const loaded = await loadedForProject(projectId, slug);
    if (!loaded) return c.json({ error: "unknown service" }, 404);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const rawName = typeof b.name === "string" ? b.name.trim() : "";
    const name = safePlaybookName(rawName.endsWith(".md") ? rawName.slice(0, -3) : rawName);
    if (!name) return c.json({ error: "name the playbook you want to put back" }, 400);

    const knowledgeName = playbookKnowledgeName(name);
    const existing = (await domain.listKnowledge(slug, projectId))
      .filter((k) => k.name === knowledgeName)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
    if (!existing) return c.json({ error: "there is no edited version of that playbook to put back" }, 404);

    const history = playbookVersions(existing.metadata);
    const restorable = history.filter((v: PlaybookVersion) => typeof v.content === "string" && v.content.length > 0);
    if (!restorable.length) {
      return c.json(
        {
          error:
            "nothing to put back: this playbook has no earlier text on file. Versions saved before " +
            "restore existed recorded only when and why they changed, not what they said.",
          versions: history.map((v: PlaybookVersion) => ({ at: v.at, reason: v.reason, restorable: false })),
        },
        409,
      );
    }

    // `at` names the version, not an index. An index shifts every time a version is added, so a
    // founder who read the list a minute ago and posted the number would restore a different one.
    const at = typeof b.at === "string" ? b.at : "";
    const target = at ? restorable.find((v: PlaybookVersion) => v.at === at) : restorable[restorable.length - 1];
    if (!target) {
      return c.json(
        {
          error: `no restorable version saved at ${at}`,
          versions: restorable.map((v: PlaybookVersion) => ({ at: v.at, reason: v.reason, restorable: true })),
        },
        404,
      );
    }

    const now = new Date().toISOString();
    const reason = `restored the version saved ${target.at} (${target.reason})`.slice(0, 500);
    const saved = await savePlaybookRow(projectId, slug, knowledgeName, (row) => ({
      content: target.content!,
      // Recomputed against whatever row won, not against the snapshot read above — that is what
      // makes the retry correct rather than merely another attempt.
      metadata: playbookSaveMeta(row, { reason, enabled: playbookEnabled(row?.metadata), now }),
    }));
    if (saved && "conflict" in saved) {
      return c.json({ error: "somebody else saved this playbook while you were putting it back — try again" }, 409);
    }
    const item = saved;
    if (!item) return c.json({ error: "not found" }, 404);
    await audit({
      project_id: projectId,
      actor: c.get("scope")?.member_id ?? "member",
      action: "playbook.restored",
      entity: "playbook",
      entity_id: name,
      detail: { wedge: slug, restored_from: target.at, reason: target.reason },
    });
    return c.json({ ok: true, playbook: name, restored_from: target.at, reason });
  });

  app.post("/v1/wedges/:wedge/playbooks/import", async (c) => {
    const projectId = writeProjectId(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    const slug = c.req.param("wedge") ?? "";
    const loaded = await loadedForProject(projectId, slug);
    if (!loaded) return c.json({ error: "unknown service" }, 404);

    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const repo = typeof b.repo === "string" ? b.repo.trim() : "";
    const path = typeof b.path === "string" ? b.path.trim().replace(/^\/+|\/+$/g, "") : "";
    const ref = typeof b.ref === "string" && b.ref.trim() ? b.ref.trim() : "main";
    const m = repo.match(/^[\w.-]+\/[\w.-]+$/);
    if (!m) return c.json({ error: "give the repo as owner/name" }, 400);

    const api = `https://api.github.com/repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`;
    const listing = await fetch(api, {
      headers: { "user-agent": "mycel", accept: "application/vnd.github+json" },
    }).catch(() => null);
    if (!listing || !listing.ok) return c.json({ error: "could not read that repo — public repos only" }, 502);
    const entries = (await listing.json().catch(() => null)) as Array<Record<string, unknown>> | null;
    if (!Array.isArray(entries)) return c.json({ error: "that path is not a folder of skill files" }, 400);

    const files = entries
      .filter((e) => e?.type === "file" && typeof e.name === "string" && (e.name as string).endsWith(".md") && typeof e.download_url === "string")
      .slice(0, 50);
    const now = new Date().toISOString();
    const live = await domain.listKnowledge(slug, projectId);
    const imported: string[] = [];

    for (const f of files) {
      const dl = String(f.download_url);
      try {
        if (new URL(dl).hostname !== "raw.githubusercontent.com") continue;
      } catch {
        continue;
      }
      const res = await fetch(dl).catch(() => null);
      if (!res || !res.ok) continue;
      const content = (await res.text().catch(() => "")).slice(0, 200_000);
      const parsed = parseSkillDoc(content, { source_url: dl });
      if (!parsed) continue;
      const knowledgeName = playbookKnowledgeName(parsed.name);
      const existing = live
        .filter((k) => k.name === knowledgeName)
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
      const metadata = playbookSaveMeta(existing, { reason: `imported from ${repo}`, enabled: true, now });
      if (existing) await domain.updateKnowledge(existing.id, { content, metadata });
      else
        await domain.createKnowledge({
          project_id: projectId,
          wedge: slug,
          name: knowledgeName,
          content,
          kind: "document",
          source: "authored",
          metadata,
        });
      imported.push(parsed.name);
    }
    return c.json({ imported, count: imported.length });
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
        // Same rule as the approval-edit correction: "what good looks like" on a named client's
        // task is written in terms of that client.
        metadata: { task_id: task.id, rating: b.rating, ...scopeMeta(taskClientId(task)) },
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
    /**
     * The engagement this message is about, when the caller knows. NEVER trusted as given: it is
     * checked against the resolved client and this project below, because the only callers that can
     * supply it are webhook adapters holding a product key, and a product key that could name any
     * case id could file one tenant's client into another tenant's engagement.
     */
    caseId?: string;
    /**
     * The EXISTING conversation this message continues, when the caller resolved one from a record we
     * wrote ourselves — an AgentMail provider thread id, say. Same trust rule as `caseId`: it is
     * re-checked below against this project, this client and this channel, so a wrong id degrades to
     * the general thread rather than filing a reply into somebody else's conversation.
     *
     * Without it, threading is (client, channel, case) and a reply to a chase whose case we never
     * recorded opens the general thread — the message lands, but detached from what it answers, which
     * is exactly the orphan this whole path exists to avoid.
     */
    threadId?: string;
    /**
     * FILE IT, DO NOT START WORK ON IT.
     *
     * For mail a machine sent — an out-of-office, a no-reply notification. The founder should still
     * see it on the conversation (knowing a client is away until the 14th is worth knowing), and
     * nothing downstream should treat it as the client having answered.
     *
     * A flag here rather than a second code path at the call site: threading, client resolution and
     * the case check are the delicate part, and a caller that filed messages its own way would drift
     * from them. The only thing that changes is whether a task is spawned.
     */
    silent?: boolean;
    normalized: NormalizedIntake;
  }): Promise<{ task_id: string; thread_id?: string; client_id: string; case_id?: string; replayed?: boolean; silent?: boolean }> {
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

    /**
     * Mail from ourselves is filed, never worked, and never becomes a client.
     *
     * A founder opened their Clients room and found "Mycel Go-to-Market" sitting in it — our own
     * outreach mailbox, promoted to customer because intake creates a client for whoever sent the
     * message. The tenant's own desk address is the worse half of the same hole: the agent answers,
     * the answer arrives as new intake, and the business becomes a customer of itself.
     *
     * The message still lands. Losing a customer's email because a sender looked odd is the worse
     * failure, and this path cannot tell a misconfigured forward from a loop with certainty — so it
     * takes the two actions it IS certain about: no run, and no entry in the CRM.
     */
    const ownAddresses = (await domain.listChannels())
      .filter((ch) => ch.project_id === args.projectId)
      .map((ch) => ch.address)
      .filter((a): a is string => !!a);
    const fromUs = isOurOwnAddress(args.normalized.client.handle, ownAddresses);
    if (fromUs) args = { ...args, silent: true };

    let client = await domain.findClientByHandle(args.normalized.client.handle);
    if (!client || client.project_id !== args.projectId) {
      client = await domain.createClient({
        project_id: args.projectId,
        display_name: args.normalized.client.name,
        handles: [args.normalized.client.handle],
        metadata: fromUs ? { ...INTERNAL_CLIENT_METADATA } : {},
      });
    }

    // The engagement, if one was named AND it survives the check. A case in another project, or one
    // belonging to a different client, is dropped rather than refused: the message still has to
    // land — losing a customer's email because a webhook sent a stale id is the worse failure — it
    // just lands on the general thread, where a human can see it.
    let caseId: string | undefined;
    if (args.caseId) {
      const kase = await domain.getCase(args.caseId);
      if (kase && kase.project_id === args.projectId && kase.client_id === client.id) caseId = kase.id;
    }

    // A thread needs a channel to hang off. Form intake without one still creates a task — it is
    // just not a conversation, and pretending otherwise would mean inventing a channel row.
    let threadId: string | undefined;
    let history: { direction: string; body: string }[] = [];
    if (args.channelId) {
      // A named thread, if it survives all three checks. Project, client AND channel: the project
      // check is the tenant boundary, the client check stops one customer's reply being appended to
      // another's conversation with the same business, and the channel check stops an email landing
      // in a thread that belongs to a different surface. Any failure falls through to the ordinary
      // find-or-create rather than refusing — losing a customer's email is the worse failure.
      const named = args.threadId ? await domain.getThread(args.threadId) : undefined;
      const usable =
        named && named.project_id === args.projectId && named.client_id === client.id && named.channel_id === args.channelId
          ? named
          : undefined;
      if (args.threadId && !usable) {
        console.warn(`[mycel] intake named thread ${args.threadId} but it does not belong to this project/client/channel`);
      }
      const thread =
        usable ??
        (await domain.findOrCreateThread(
          client.id,
          args.channelId,
          args.projectId,
          args.normalized.subject,
          caseId,
        ));
      await domain.addMessage({
        thread_id: thread.id,
        direction: "inbound",
        author: client.id,
        body: args.normalized.body,
      });
      threadId = thread.id;
      // The engagement the CONVERSATION already names, when the caller did not name one. A reply on
      // the thread a chase was sent on is an episode of that chase's case, and without this the run
      // spawned from it carried no case — the exact gap `Thread.case_id` was added to close, reopened
      // one layer up.
      caseId = caseId ?? thread.case_id;
      history = (await domain.listMessages(thread.id)).map((m) => ({ direction: m.direction, body: m.body }));
    }

    const cfg = loadConfig();
    const now = new Date().toISOString();
    const task: Task = {
      id: randomUUID(),
      project_id: args.projectId,
      // The run is an episode of the engagement, not a free-floating job. Without this the case's
      // history had a gap exactly where the client spoke.
      case_id: caseId,
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
    if (args.silent) {
      /**
       * The message is filed by this point and that is the whole job. No task row, so nothing to
       * dedupe against and nothing to enqueue — and deliberately NOT `rememberIntake`, because a
       * later real reply on the same thread must not be mistaken for a replay of this one.
       */
      return { task_id: "", thread_id: threadId, client_id: client.id, case_id: caseId, silent: true };
    }
    await store.createTask(task);
    rememberIntake(dedupe, task.id);
    await enqueueTask(store, task.id);
    return { task_id: task.id, thread_id: threadId, client_id: client.id, case_id: caseId };
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
      // A provider adapter that knows which engagement this reply belongs to (a plus-address, a
      // reference in the subject the product parsed) can say so. Validated against the resolved
      // client inside `acceptIntake` — it is a hint, never an authorisation.
      caseId: typeof (raw as { case_id?: unknown })?.case_id === "string" ? (raw as { case_id: string }).case_id : undefined,
      normalized: normalized.value,
    });
    return c.json(out, out.replayed ? 200 : 201);
  });

  // ── AgentMail: the founder-facing half. Provisioning an identity, and the DNS the identity needs.
  //
  // Behind the product key like everything else, and project-scoped WRITE-side with the required-not-
  // defaulted rule: an inbox is a sending identity, and an identity created in the wrong project is a
  // business able to send as another one.

  /**
   * Register a sending domain and return exactly what the customer must publish.
   *
   * ═══ WHY THIS IS A PRODUCT SURFACE AND NOT A SUPPORT ARTICLE ═══
   *
   * A brand-new domain sending invoice chases lands in spam, and an unread chase is worse than no
   * chase — the ladder climbs against silence it caused itself, and on day 22 sends a final notice
   * nobody has ever seen. Whatever the customer must do therefore has to be VISIBLE, with a live
   * status, or it does not get done. `records` is the checklist and `advice` is the three things that
   * actually go wrong (a second SPF record, a Cloudflare-proxied DKIM CNAME, a missing MX that drops
   * every reply). See `deliverabilityAdvice`.
   */
  app.post("/v1/agentmail/domains", async (c) => {
    const cfg = agentMailConfig();
    if (!cfg) return c.json({ error: "AgentMail is not configured on this deployment (AGENTMAIL_API_KEY is unset)" }, 501);
    const projectId = writeProjectId(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    const b = (await c.req.json().catch(() => ({}))) as { domain?: string };
    const domainName = (b.domain ?? "").trim().toLowerCase();
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domainName)) return c.json({ error: "a valid domain is required" }, 400);

    const res = await registerAgentMailDomain(cfg, domainName);
    if (!res.ok || !res.data) return c.json({ error: res.detail }, 502);
    // Record the tenant BEFORE answering. AgentMail's domain list belongs to the deployment's single
    // account and cannot say whose a domain is; this row is the only thing that can. See
    // `claimDomainForProject` for the leak it closes.
    await claimDomainForProject(projectId, domainName);
    await audit({
      project_id: projectId,
      actor: (c.get("scope").member_id ?? "system") as string,
      action: "agentmail.domain_registered",
      entity: "connection",
      entity_id: domainName,
      detail: { domain: domainName, status: res.data.status },
    });
    return c.json(res.data, 201);
  });

  /** The sending domains THIS project registered — never the deployment's whole AgentMail account. */
  /**
   * ═══ IS MY EMAIL WORKING? ═══
   *
   * One route, one question. Everything underneath it — the warm-up schedule, the daily ceiling, the
   * per-address penalties, the suppression list — is machinery a founder must never be shown, and
   * `sendingReport` is where it becomes sentences. The translation lives in the kernel rather than in
   * the console so that a second surface (a digest, an alert, a mobile view) gets the same words and
   * cannot invent worse ones, and so a test can assert none of our vocabulary escapes.
   *
   * No project is a 400 and not an empty report: "we cannot tell which business you mean" and "your
   * sending is fine" must never render as the same screen.
   */
  app.get("/v1/outreach/sending", async (c) => {
    const projectId = writeProjectId(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    if (!accessible(c).has(projectId)) return c.json({ error: "not found" }, 404);
    return c.json(await sendingReport(projectId));
  });

  app.get("/v1/agentmail/domains", async (c) => {
    const projectId = writeProjectId(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    const domains = await listProjectDomains(projectId);
    const cfg = agentMailConfig();
    // Unconfigured lists the claims without their live status rather than 501ing. A founder who set
    // this up before the key was rotated out should still see what they registered; what they must
    // not see is a screen implying it is verified when we cannot check.
    if (!cfg) return c.json({ configured: false, items: domains.map((domain) => ({ domain, status: "unknown", records: [], advice: [] })) });
    const items = await Promise.all(
      domains.map(async (domain) => {
        const res = await getAgentMailDomain(cfg, domain);
        return res.data ?? { domain, status: "unknown", records: [], advice: [`Could not read this domain from AgentMail: ${res.detail}`] };
      }),
    );
    return c.json({ configured: true, items });
  });

  /**
   * Poll one domain's verification. What the "check again" button calls.
   *
   * 404 on a domain this project did not register, and the check is the project-scoped record rather
   * than AgentMail's own list. Without it this route reports any customer's verification state to any
   * other — their domain, whether their DKIM is right, whether they are live — because one AgentMail
   * account serves the whole deployment. 404 rather than 403, like every other by-id read here, so a
   * domain name cannot be probed for existence.
   */
  app.get("/v1/agentmail/domains/:domain", async (c) => {
    const cfg = agentMailConfig();
    if (!cfg) return c.json({ error: "AgentMail is not configured on this deployment (AGENTMAIL_API_KEY is unset)" }, 501);
    const projectId = writeProjectId(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    const domainName = c.req.param("domain").trim().toLowerCase();
    if (!(await projectOwnsDomain(projectId, domainName))) return c.json({ error: "unknown domain" }, 404);
    const res = await getAgentMailDomain(cfg, domainName);
    if (!res.ok || !res.data) return c.json({ error: res.detail }, res.status === 404 ? 404 : 502);
    return c.json(res.data);
  });

  /**
   * Provision a tenant's mailbox: an AgentMail inbox, a `agentmail` connection that owns it, and the
   * channel that says what an inbound on it runs.
   *
   * All three or none. A connection without a channel receives mail that has no wedge to run and ends
   * up in the unattributed buffer; an inbox with no connection receives mail that resolves to no
   * project at all. Creating them one route at a time would make both of those a normal intermediate
   * state rather than a fault, which is how a half-configured mailbox silently swallows replies.
   */
  app.post("/v1/agentmail/inboxes", async (c) => {
    const cfg = agentMailConfig();
    if (!cfg) return c.json({ error: "AgentMail is not configured on this deployment (AGENTMAIL_API_KEY is unset)" }, 501);
    const projectId = writeProjectId(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    const b = (await c.req.json().catch(() => ({}))) as {
      username?: string;
      domain?: string;
      display_name?: string;
      wedge?: string;
      task_type?: string;
      name?: string;
    };
    const username = (b.username ?? "").trim().toLowerCase();
    if (!/^[a-z0-9._-]{1,64}$/.test(username)) return c.json({ error: "a valid username is required" }, 400);
    if (typeof b.wedge !== "string" || typeof b.task_type !== "string") {
      return c.json({ error: "wedge and task_type are required — an inbox nothing runs on is a mailbox that swallows replies" }, 400);
    }
    if (!loadWedge(b.wedge)) return c.json({ error: unknownService(b.wedge) }, 400);
    if (!identity.projectAllowsWedge(projectId, b.wedge)) {
      return c.json({ error: serviceNotEnabled(b.wedge) }, 403);
    }

    /**
     * ═══ YOU MAY ONLY MAKE A MAILBOX ON A DOMAIN YOU REGISTERED ═══
     *
     * The sharpest edge on this whole surface, and it is not obvious: one AgentMail account serves
     * every tenant on this deployment, so `POST /inboxes {username, domain}` will cheerfully create
     * `billing@acme.test` for whoever asks — including the tenant next door. That is not a data leak,
     * it is impersonation with working DKIM: a mailbox that passes every authentication check as
     * Acme, sending invoices to Acme's clients, with replies arriving in a stranger's project.
     *
     * The same project-scoped claim that guards the status route is the fix, and it is checked BEFORE
     * the API call so a refusal leaves no orphan inbox behind on the account.
     */
    const wantDomain = b.domain ? b.domain.trim().toLowerCase() : undefined;
    if (wantDomain && !(await projectOwnsDomain(projectId, wantDomain))) {
      return c.json({ error: `this project has not registered the domain "${wantDomain}"`, code: "agentmail.domain_not_yours" }, 403);
    }

    const res = await createInbox(cfg, {
      username,
      ...(wantDomain ? { domain: wantDomain } : {}),
      ...(b.display_name ? { display_name: b.display_name } : {}),
    });
    if (!res.ok || !res.data?.inbox_id) {
      // A name somebody already took is the founder's input, not our outage. See `inboxNameTaken`.
      const taken = inboxNameTaken(res.detail);
      if (taken.taken) {
        return c.json(
          {
            error: taken.suggestions.length
              ? `"${username}" is already in use. Try ${taken.suggestions.slice(0, 3).join(", ")}.`
              : `"${username}" is already in use. Try another name.`,
            code: "agentmail.username_taken",
            suggestions: taken.suggestions,
          },
          409,
        );
      }
      return c.json({ error: res.detail || "AgentMail returned no inbox id" }, 502);
    }
    const inboxId = res.data.inbox_id;
    const address = wantDomain ? `${username}@${wantDomain}` : inboxId;

    const conn = await domain.createConnection({
      project_id: projectId,
      kind: "agentmail",
      name: b.name ?? `mailbox ${address}`,
      owner: { kind: "founder", id: "founder" },
      // The sending identity, and the inbound routing key. Config, not payload — see agentmail.ts.
      config: { inbox_id: inboxId, address, from: address },
    });
    const channel = await domain.createChannel({
      project_id: projectId,
      connection_id: conn.id,
      kind: "agentmail",
      address,
      wedge: b.wedge,
      task_type: b.task_type,
    });

    /**
     * ═══ AND MAKE SURE IT CAN ACTUALLY RECEIVE ═══
     *
     * This route already refuses a mailbox with no `wedge`/`task_type`, on the grounds that "an
     * inbox nothing runs on is a mailbox that swallows replies". It then created inboxes the
     * PROVIDER would never deliver to, which swallows replies just as completely and was invisible.
     *
     * The org webhook was scoped to two inboxes we registered by hand in August. Every inbox
     * provisioned since could send and could not receive. See `ensureInboxDelivery`.
     *
     * Reported, not thrown: the mailbox exists and sending through it works, so failing the request
     * would destroy something useful. But `delivery` travels in the response and the surface says
     * so, because a send-only mailbox is a thing the founder must know about BEFORE they let it ask
     * a client a question.
     */
    const delivery = await ensureInboxDelivery(cfg, inboxId).catch((e) => ({
      ok: false,
      detail: `could not check inbound delivery: ${(e as Error)?.message ?? "unknown"}`,
    }));
    if (!delivery.ok) {
      console.error(`[mycel] ${address} is send-only — ${delivery.detail}`);
    }
    await audit({
      project_id: projectId,
      actor: (c.get("scope").member_id ?? "system") as string,
      action: "agentmail.inbox_provisioned",
      entity: "connection",
      entity_id: conn.id,
      detail: { address, inbox_id: inboxId, wedge: b.wedge, task_type: b.task_type },
    });
    // `delivery` is part of the answer, not a log line. A mailbox that cannot receive is one the
    // founder must not point at a client, and the only place to say so is here.
    return c.json({ connection: conn, channel, address, inbox_id: inboxId, delivery }, 201);
  });

  /**
   * Inbound we verified and could not place. Operator-facing and deliberately NOT project-scoped:
   * the defining property of these rows is that we could not determine a project for them, so a
   * project filter would hide exactly the thing this exists to show. It carries no message content
   * for the same reason — we do not know whose it is. See `recordUnattributedInbound`.
   */
  app.get("/v1/agentmail/unattributed", async (c) => {
    const scope = c.get("scope");
    if (scope?.kind !== "key" && scope?.role !== "owner" && scope?.role !== "admin") {
      return c.json({ error: "operator access required" }, 403);
    }
    return c.json({ items: listUnattributedInbound() });
  });

  /**
   * ═══ AGENTMAIL INBOUND — THE PRODUCER `/v1/channels/:id/inbound` NEVER HAD ═══
   *
   * A client replies to a chase and the kernel finally sees it. Read the header of agentmail.ts for
   * why this vendor and how threading works; what follows is the trust reasoning, which is local.
   *
   * ─── THE SIGNATURE IS THE ENTIRE AUTHENTICATION ───
   *
   * This route is in the public bypass because AgentMail has no Mycel session and never will. Its
   * credential is a Svix signature over the exact bytes, so everything before verification is free of
   * side effects, and a failure leaves nothing behind — no client, no thread, no task, and no log
   * line carrying the body. An unauthenticated version of this endpoint would let a stranger stand
   * down another company's dunning ladder, or write text into a company's conversation history that
   * an agent will later read as fact. Unconfigured refuses everything (501) rather than degrading
   * into an open endpoint, exactly like /v1/composio/webhook.
   *
   * ─── THE PROJECT COMES FROM OUR RECORD, NEVER FROM THE PAYLOAD ───
   *
   * The only identifier here we are willing to route on is `inbox_id`, and only because WE minted it
   * when we provisioned the mailbox. It is used to FIND our connection row; the project, the channel,
   * the wedge and the task type are then read off our own records. There is no project id, no client
   * id and no case id in the payload that this route will believe — which is the standing rule after
   * two cross-tenant leaks, and the reason `findAgentMailThread` takes the project as a required
   * argument rather than looking a thread id up globally.
   *
   * ─── STATUS CODES ARE PART OF THE DESIGN ───
   *
   * 401 forged. 501 unconfigured. 200 for a delivery we understood and deliberately do not act on
   * (a bounce, a spam classification) — a 4xx there would have Svix redeliver it forever. And 503,
   * not 200, when the inbox matches no connection: that is OUR record being wrong, it is recoverable
   * by repairing the connection, and Svix's retry schedule is the recovery. It is also recorded in
   * the unattributed buffer, because a retry that eventually gives up must still leave a trace a
   * human can find. See `recordUnattributedInbound`.
   */
  app.post("/v1/agentmail/webhook", async (c) => {
    const cfg = agentMailConfig();
    if (!cfg?.webhookSecret) {
      return c.json({ error: "AgentMail inbound is not configured on this deployment", code: "agentmail.unconfigured" }, 501);
    }

    // Raw text, not c.req.json(): the signature covers the exact bytes and re-serialising a parsed
    // object cannot be trusted to reproduce them (key order, unicode escapes, whitespace).
    const raw = await c.req.text();
    const verdict = verifyAgentMailWebhook({
      secret: cfg.webhookSecret,
      webhookId: c.req.header(AGENTMAIL_WEBHOOK_HEADERS.id) ?? "",
      timestamp: c.req.header(AGENTMAIL_WEBHOOK_HEADERS.timestamp) ?? "",
      signature: c.req.header(AGENTMAIL_WEBHOOK_HEADERS.signature) ?? "",
      rawBody: raw,
      toleranceS: Number(process.env.AGENTMAIL_WEBHOOK_TOLERANCE_S ?? 300),
    });
    if (!verdict.ok) return c.json({ error: "invalid signature", reason: verdict.reason }, 401);

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    /**
     * ═══ A DELIVERY EVENT IS NOT A MESSAGE, AND IT IS NOT NOTHING EITHER ═══
     *
     * `message.bounced` and `message.complained` came down this pipe and were acknowledged with
     * `{ ok: true, ignored }`. So this kernel SAW every bounce and every complaint against every
     * agency running on it, and learned nothing from either: the address stayed on the list, the
     * next sequence step mailed it again, and the bounce rate that gets a sending domain blocked was
     * being fed one retry at a time.
     */
    const delivery = readDeliveryEvent(parsed);
    if (delivery) {
      const owner = await projectForInbox(parsed);
      const noted = await recordDeliveryFailure(delivery, owner.project_id, owner.inbox);
      return c.json({ ok: true, delivery: noted });
    }

    const inbound = parseAgentMailInbound(parsed);
    // Spam and unauthenticated senders must not become messages from the client. Acknowledged so they
    // are not redelivered; named so a 200 here is never mistaken for "we filed it".
    if (!inbound.ok) return c.json({ ok: true, ignored: inbound.reason });
    const msg = inbound.value;

    // THREAD-FIRST for a shared inbox: the provider thread id is a key WE wrote on send, so it
    // names the project. Inbox→connection is the fallback for cold mail with no prior outbound.
    const threadLink = await findAgentMailThreadGlobal(msg.thread_id);
    let projectId = threadLink?.project_id;
    let channel = threadLink
      ? (await domain.listChannels()).find((ch) => ch.id === threadLink.channel_id && ch.project_id === threadLink.project_id)
      : undefined;

    if (!projectId || !channel) {
      const conn = await connectionForInbox(msg.inbox_id);
      if (!conn?.project_id) {
        recordUnattributedInbound({
          inbox_id: msg.inbox_id,
          provider_thread_id: msg.thread_id,
          reason: conn
            ? "the connection for this inbox has no project scope"
            : threadLink
              ? `thread map points at project ${threadLink.project_id} but its channel is gone, and no connection owns this inbox`
              : "no connection on this deployment owns this inbox",
        });
        return c.json({ error: "this inbox is not attributable to a project", code: "agentmail.unattributed" }, 503);
      }
      projectId = conn.project_id;
      channel = (await domain.listChannels()).find((ch) => ch.connection_id === conn.id && ch.project_id === projectId);
      if (!channel) {
        recordUnattributedInbound({
          inbox_id: msg.inbox_id,
          provider_thread_id: msg.thread_id,
          reason: `connection "${conn.name}" has no channel, so inbound has no wedge or task type to run`,
        });
        return c.json({ error: "this inbox has no channel", code: "agentmail.no_channel" }, 503);
      }
    }

    /**
     * ═══ AND THE BOUNCE THAT ARRIVED AS AN ORDINARY EMAIL ═══
     *
     * When a receiving server rejects a message after accepting it, the failure comes back as a
     * delivery status notification: a normal email, from MAILER-DAEMON, to the mailbox that sent it.
     * It arrives as `message.received`, it parses cleanly, and until now it was filed as a message
     * on the client's thread.
     *
     * That was worse than silent. A dunning chase to an address that no longer exists produced a
     * "reply", and a ladder that stands down on an inbound reply stood down — so the client never
     * wrote, never read anything, and their invoice stopped being chased, because their mail server
     * told us the address was dead and we recorded it as them answering.
     *
     * Checked AFTER attribution because a suppression is per-tenant and this is where the project is
     * known. See `readDsn` for why the sender alone is not enough to claim one.
     */
    const dsn = readDsn(msg);
    if (dsn) {
      // The DSN came back TO the mailbox that sent the message, so our own inbox is the sender the
      // ramp is about — not the daemon in the `from`, which belongs to the receiving server.
      const noted = await recordDeliveryFailure(dsn, projectId, await addressForInbox(msg.inbox_id));
      return c.json({ ok: true, delivery: noted });
    }

    // Prefer the global link (already resolved); else the project-scoped row (inbox-first path).
    const link = threadLink ?? (await findAgentMailThread(projectId, msg.thread_id));

    const normalized = normalizeIntake("email", {
      from: { handle: msg.from_handle, ...(msg.from_name ? { name: msg.from_name } : {}) },
      body: msg.text,
      ...(msg.subject ? { subject: msg.subject } : {}),
      // Metadata, so `intakeDedupeKey` prefers the RFC 5322 Message-ID: Svix retries on any non-2xx,
      // and without a stable vendor id a retry would be a second task, a second reply and a second
      // stand-down attempt against a client who wrote once.
      message_id: msg.message_id,
      agentmail: { inbox_id: msg.inbox_id, thread_id: msg.thread_id, event_id: msg.event_id },
    });
    if (!normalized.ok) return c.json(normalized.error, 400);

    /**
     * ═══ AND THE OUT-OF-OFFICE THAT LOOKED LIKE A REPLY ═══
     *
     * `readDsn` above catches the bounce. This catches the other machine: a client on holiday whose
     * mailbox answers for them. Filed the same way — a founder wants to know somebody is away until
     * the 14th — but it starts no run and, further down, stands no chase down.
     *
     * Both halves matter and the second is the expensive one. A ladder that stops because a mail
     * server replied is an invoice that quietly stops being chased while the client is on a beach.
     */
    const auto = readAutoReply(msg);
    const out = await acceptIntake({
      projectId,
      wedge: channel.wedge,
      taskType: channel.task_type,
      channelId: channel.id,
      caseId: link?.case_id,
      threadId: link?.thread_id,
      ...(auto ? { silent: true } : {}),
      normalized: normalized.value,
    });
    if (auto) {
      console.log(
        `[mycel] inbound looks automated (${auto.because}: ${auto.detail}) — filed on the thread, no run started`,
      );
    }

    /**
     * AND NOW THE PART THAT CHANGES BEHAVIOUR.
     *
     * Filing the reply is necessary and not sufficient: a message sitting in a thread nobody opens is
     * the same outcome as `config.reply_to` and the ladder escalates anyway. So a reply that lands on
     * a conversation we chased an invoice on stands that chase down and puts the question in front of
     * a human. See `noteClientReplyOnInvoice` for why it suppresses rather than settles.
     *
     * Deliberately AFTER `acceptIntake` and deliberately non-fatal. The message is already durably
     * stored by this point; if the stand-down throws, the right outcome is a loud log and a 201 that
     * tells the caller what did and did not happen — not a 500 that has Svix redeliver an email we
     * have already filed, producing a duplicate task on every retry.
     */
    let standDown: { invoice_id: string; stood_down: string[]; refusal?: string } | undefined;
    // `!auto`: a machine's reply is not the client answering, so the ladder keeps going.
    if (!out.replayed && !auto) {
      const invoice = await invoiceForReply(projectId, link?.invoice_id, out.case_id);
      if (invoice) {
        try {
          const noted = await noteClientReplyOnInvoice(invoice, { thread_id: out.thread_id, body: msg.text });
          standDown = {
            invoice_id: invoice.id,
            stood_down: noted.stood_down,
            ...(noted.stand_down_refusal ? { refusal: noted.stand_down_refusal } : {}),
          };
        } catch (e) {
          console.error(`[mycel] a client replied about invoice ${invoice.number} but the ladder was not stood down:`, e);
          standDown = { invoice_id: invoice.id, stood_down: [], refusal: String((e as Error)?.message ?? e) };
        }
      }
    }

    return c.json({ ...out, ...(standDown ? { chase: standDown } : {}) }, out.replayed ? 200 : 201);
  });

  /**
   * Which invoice is a reply about? Project-scoped at every step; nothing here takes an id from the
   * payload.
   *
   * Two sources, in order of how much we know. The link row is exact — it says which invoice the
   * chase on this provider thread was about. The case is the fallback for a reply that arrived on a
   * conversation we did not chase from (a founder emailed from the AgentMail console, say): among the
   * invoices on that engagement, pick the one still owing that we chased most recently, because that
   * is the one the client is answering. An engagement with no chased invoice returns nothing and the
   * reply is simply filed — which is correct, and is why this returns undefined rather than guessing.
   */
  async function invoiceForReply(projectId: string, invoiceId?: string, caseId?: string): Promise<Invoice | undefined> {
    const billing = getBillingStore();
    if (invoiceId) {
      const inv = await billing.getInvoice(invoiceId);
      // The link row is ours, so this can only fail if the invoice was deleted — but a linked id that
      // resolves outside the project would be a tenancy hole, so it is checked rather than assumed.
      if (inv && inv.project_id === projectId) return inv;
    }
    if (!caseId) return undefined;
    const onCase = await billing.listInvoices({ project_id: projectId, case_id: caseId, limit: 100 });
    const chased = onCase
      .filter((i) => !!i.last_chased_at && invoiceTotals(i).amount_due > 0)
      .sort((a, b) => (a.last_chased_at! < b.last_chased_at! ? 1 : -1));
    return chased[0];
  }

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
      if (!loadWedge(wedge)) return c.json({ error: unknownService(wedge) }, 400);
      if (!identity.projectAllowsWedge(projectId, wedge)) {
        return c.json({ error: serviceNotEnabled(wedge) }, 403);
      }
    }
    if (!projectId) return c.json({ error: "channel has no project scope" }, 400);

    // Strip the routing keys before normalizing so they don't land in metadata as unknown form
    // fields — they are ours, not the form's. Any other extra still passes through the adapter.
    const { channel_id: _c, wedge: _w, task_type: _t, case_id: _k, ...formPayload } = body;
    const normalized = normalizeIntake("form", formPayload);
    if (!normalized.ok) return c.json(normalized.error, 400);

    const out = await acceptIntake({
      projectId,
      wedge: wedge!,
      taskType: taskType!,
      channelId,
      caseId: typeof body.case_id === "string" ? body.case_id : undefined,
      normalized: normalized.value,
    });
    return c.json(out, out.replayed ? 200 : 201);
  });

  /**
   * A GET to a POST-only internal endpoint answers with instructions, not 404.
   *
   * ═══ THE RUN THIS COST US ═══
   *
   * geo-monitor's weekly report is supposed to fan out probes through `POST /v1/internal/batches`.
   * A real run did this instead, and it is completely reasonable behaviour:
   *
   *   curl -s -i "$MYCEL_BATCHES_URL" -H "authorization: Bearer $MYCEL_ACTION_TOKEN"
   *   curl -s -i "$MYCEL_PACKS_URL"   ...
   *   curl -s -i "$MYCEL_WORKFLOWS_URL" ...
   *
   * Three GETs, to check the services were up before committing to a fan-out. Hono answers 404 to a
   * GET on a POST-only route, so the agent concluded — and wrote into the case — "configured batch,
   * pack, workflow, and records endpoints all returned HTTP 404", then refused the report. Every one
   * of those endpoints was working. It never made a real POST.
   *
   * The trap is that **404 from a POST-only route is indistinguishable from "this was never built"**,
   * and an agent that cannot tell those apart correctly refuses correct work. Which is the most
   * expensive failure shape in this system: not a wrong answer, a confident and well-reasoned
   * refusal that no log contradicts.
   *
   * So the door says what it is for. A probing GET now gets 405 with the method and the body shape,
   * which turns the dead end into the instruction the agent was looking for. Costs nothing, needs no
   * change to any wedge, and covers every future one — a skill that says "do not probe" only helps
   * the wedge that reads it.
   *
   * Registered BEFORE the POST handlers only for readability; Hono matches on method, so a GET here
   * can never shadow the POST below it.
   */
  const usageDoor = (path: string, body: Record<string, unknown>, note: string) => {
    app.get(path, (c) =>
      c.json(
        {
          ok: false,
          error: `this endpoint is POST-only — a GET tells you nothing about whether it works`,
          usage: { method: "POST", path, headers: { authorization: "Bearer $MYCEL_ACTION_TOKEN" }, body },
          note,
        },
        405,
      ),
    );
  };
  usageDoor(
    "/v1/internal/batches",
    { join: "all", children: [{ task_type: "<a task_type your wedge declares>", input: {} }] },
    "Fan out child runs and suspend this one until they join. `children` must be non-empty and every task_type must be declared by THIS wedge.",
  );
  usageDoor(
    "/v1/internal/packs/run",
    { pack: "<pack@version>", input: {} },
    "Run a deterministic computation pack. Its numbers go into your result unchanged.",
  );
  usageDoor(
    "/v1/internal/workflows/:name",
    { args: {} },
    "Call a named deterministic function this wedge ships. The name goes in the path, not the body.",
  );
  usageDoor(
    "/v1/internal/records/query",
    { collection: "<collection>", where: {} },
    "Read structured records this project has written. Scoped to your task's project.",
  );
  usageDoor(
    "/v1/internal/records/upsert",
    { collection: "<collection>", records: [] },
    "Write structured records for this project.",
  );
  usageDoor(
    "/v1/internal/case/update",
    { stage: "<stage>", data: {} },
    "Update the case this run belongs to. Scoped to that one case by the action grant.",
  );
  usageDoor(
    "/v1/internal/knowledge/gap",
    { question: "<what you could not answer>" },
    "Record that the knowledge needed for this run was missing, so a founder can fill it.",
  );

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

    /**
     * ═══ A WORKFLOW MAY RETURN A SPREADSHEET, AND THE KERNEL RENDERS IT ═══
     *
     * A client paying a monthly retainer received their close as a PDF and a CSV. Both correct. A CSV
     * is a text file with commas in it — the accountant imports it and nobody opens it twice — so the
     * work arrived looking like an export because it was shipped like one.
     *
     * The workflow cannot render the .xlsx itself: it is founder code, pure, no build step and no
     * imports from the kernel, and that is the property that makes it safe to run. So it returns a
     * `workbook` SPEC — sheets, headers, typed cells, all plain data — and this renders it, stores it
     * and hands back the artifact id.
     *
     * Storing it here rather than writing it into the sandbox is deliberate on two counts. An agent
     * cannot write binary through a text tool without a base64 round trip nobody should pay for. And
     * an artifact of the task is already what `wrapFulfillmentDeliverable` attaches to the delivery,
     * so the spreadsheet reaches the client without the model having to remember to declare it.
     *
     * The spec is replaced in the response by a one-line confirmation. Handing a model back a hundred
     * kilobytes of base64 it has no use for is how a context window gets spent on nothing.
     */
    const wbSpec = (result.data as { workbook?: unknown } | undefined)?.workbook;
    if (result.ok && wbSpec && typeof wbSpec === "object") {
      try {
        const doc = renderWorkbook(wbSpec as Parameters<typeof renderWorkbook>[0]);
        const wbName = String(
          (wbSpec as { filename?: unknown }).filename ?? `${name.replace(/_/g, "-")}.xlsx`,
        )
          .split(/[\\/]/)
          .pop()!
          .slice(0, 200);
        const artifact = await store.addArtifact({
          task_id: grant.task_id,
          name: wbName.endsWith(".xlsx") ? wbName : `${wbName}.xlsx`,
          content_type: doc.content_type,
          content: doc.content,
          encoding: doc.encoding,
          size_bytes: doc.size_bytes,
          source: "agent",
          client_id: task.client_id,
        });
        const backend = await getArtifactBackend();
        if (!backend.inline) await backend.put(artifact.id, artifact.content);
        await emitEvent(store, grant.task_id, "artifact.created", {
          artifact_id: artifact.id,
          name: artifact.name,
          content_type: artifact.content_type,
          size_bytes: artifact.size_bytes,
          url: `/v1/artifacts/${artifact.id}`,
        });
        (result.data as Record<string, unknown>).workbook = {
          written: artifact.name,
          artifact_id: artifact.id,
          size_bytes: artifact.size_bytes,
          note: "Already saved and attached to this engagement. Do not write it yourself, and do not list it in `artifacts` — it is not a file in ./output/.",
        };
      } catch (e) {
        // A workbook that will not render must not fail the computation that produced it: every
        // figure in `result.data` is still correct and the run can still deliver without the sheet.
        (result.data as Record<string, unknown>).workbook = {
          error: `the spreadsheet could not be rendered: ${String((e as Error)?.message ?? e)}`,
        };
      }
    }

    /**
     * ═══ AND A WORKFLOW MAY RETURN A WORD DOCUMENT, FOR THE TRADES WHOSE CLIENT EDITS IT ═══
     *
     * Same seam as `workbook` directly above and the same argument one format over. A workflow is
     * founder code — pure, no build step, no imports from the kernel — and that is the property
     * that makes it safe to run, so it cannot render OOXML itself. It returns a plain-data spec and
     * this renders it, stores it and hands back an id.
     *
     * Why a `.docx` at all, when we already ship PDFs: a PDF says *do not touch this* and a Word
     * file says *this is yours now*. For a contract a lawyer redlines, a proposal a client pastes
     * their numbers into, a grant a committee marks up or a bid procurement fills half of, the
     * format IS the deliverable's usefulness — and sending the PDF is how a firm gets asked for
     * "the Word version", which is the request that reveals the work was not finished.
     */
    const docSpec = (result.data as { document?: unknown } | undefined)?.document;
    if (result.ok && docSpec && typeof docSpec === "object") {
      try {
        const rendered = renderDocument(docSpec as Parameters<typeof renderDocument>[0]);
        const docName = String(
          (docSpec as { filename?: unknown }).filename ?? `${name.replace(/_/g, "-")}.docx`,
        )
          .split(/[\\/]/)
          .pop()!
          .slice(0, 200);
        const artifact = await store.addArtifact({
          task_id: grant.task_id,
          name: docName.endsWith(".docx") ? docName : `${docName}.docx`,
          content_type: rendered.content_type,
          content: rendered.content,
          encoding: rendered.encoding,
          size_bytes: rendered.size_bytes,
          source: "agent",
          client_id: task.client_id,
        });
        const backend = await getArtifactBackend();
        if (!backend.inline) await backend.put(artifact.id, artifact.content);
        await emitEvent(store, grant.task_id, "artifact.created", {
          artifact_id: artifact.id,
          name: artifact.name,
          content_type: artifact.content_type,
          size_bytes: artifact.size_bytes,
          url: `/v1/artifacts/${artifact.id}`,
        });
        (result.data as Record<string, unknown>).document = {
          written: artifact.name,
          artifact_id: artifact.id,
          size_bytes: artifact.size_bytes,
          note: "Already saved and attached to this engagement. Do not write it yourself, and do not list it in `artifacts` — it is not a file in ./output/.",
        };
      } catch (e) {
        // Same as the workbook: a document that will not render must not fail the work that
        // produced it. The content is still correct and the run can still deliver without the file.
        (result.data as Record<string, unknown>).document = {
          error: `the document could not be rendered: ${String((e as Error)?.message ?? e)}`,
        };
      }
    }

    await emitEvent(store, grant.task_id, "tool.result", {
      tool: `workflow:${name}`,
      ok: result.ok,
      ms: result.ms,
      error: result.error,
    });
    return c.json(result, result.ok ? 200 : 400);
  });

  // Internal: versioned packs. Same trust as workflows — agent picks name@version + JSON args,
  // never the code. Authored services may reference installed packs; digests are checked every run.
  app.post("/v1/internal/packs/run", async (c) => {
    const grant = await getActionGrant((c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, ""));
    if (!grant) return c.json({ ok: false, error: "invalid action token" }, 401);
    const task = await store.getTask(grant.task_id);
    if (!task) return c.json({ ok: false, error: "unknown task" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const ref = String(body.pack ?? body.ref ?? "").trim();
    if (!ref) return c.json({ ok: false, error: "pack is required (e.g. share_of_voice@1)" }, 400);
    const args = (body.args && typeof body.args === "object" ? body.args : body) as Record<string, unknown>;
    // Don't pass control fields into the pack.
    const { pack: _p, ref: _r, args: _a, ...rest } = args;
    const packArgs = (body.args && typeof body.args === "object" ? body.args : rest) as Record<string, unknown>;

    const wedge =
      (task.project_id ? await loadProjectWedge(task.project_id, task.wedge) : null) ??
      loadWedge(task.wedge);
    const allowed = wedge?.manifest.packs ?? [];
    // Disk wedges with no packs list may call any installed pack (same trust as workflows).
    // Authored services — and disk wedges that declare packs — may only call what they name.
    const mustDeclare = isAuthoredSlug(task.wedge) || allowed.length > 0;
    const declared = allowed.some((p) => {
      const want = parsePackRef(ref);
      const have = parsePackRef(p);
      return !!want && !!have && want.name === have.name && want.version === have.version;
    });
    if (mustDeclare && !declared) {
      return c.json({ ok: false, error: `service "${task.wedge}" does not declare pack "${ref}"` }, 403);
    }
    if (!resolvePack(ref)) return c.json({ ok: false, error: `unknown pack "${ref}"` }, 404);

    await emitEvent(store, grant.task_id, "tool.called", { tool: `pack:${ref}`, args: packArgs });
    const result = await runPack(ref, packArgs);
    await emitEvent(store, grant.task_id, "tool.result", {
      tool: `pack:${ref}`,
      ok: result.ok,
      ms: result.ms,
      digest: result.digest,
      error: result.error,
    });
    return c.json(result, result.ok ? 200 : 400);
  });

  // Internal: fan-out a Batch. The calling task becomes the parent (awaiting_batch); children are
  // ordinary queued tasks with the same ceilings and approvals. Join is coordination only — not an
  // approval gate. Cap children so one runaway call cannot flood the worker pool.
  const MAX_BATCH_CHILDREN = 40;
  app.post("/v1/internal/batches", async (c) => {
    const grant = await getActionGrant((c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, ""));
    if (!grant) return c.json({ ok: false, error: "invalid action token" }, 401);
    const parent = await store.getTask(grant.task_id);
    if (!parent) return c.json({ ok: false, error: "unknown task" }, 404);
    if (!parent.project_id) return c.json({ ok: false, error: "parent task has no project" }, 400);
    if (parent.status === "awaiting_batch") {
      return c.json({ ok: false, error: "this task is already waiting on a batch" }, 409);
    }
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const join = body.join === "quorum" ? "quorum" : "all";
    const quorum = typeof body.quorum === "number" ? Math.floor(body.quorum) : undefined;
    if (join === "quorum" && !(quorum && quorum > 0)) {
      return c.json({ ok: false, error: "quorum join requires quorum > 0" }, 400);
    }
    const rawChildren = Array.isArray(body.children) ? body.children : [];
    if (!rawChildren.length) return c.json({ ok: false, error: "children is required (non-empty array)" }, 400);
    if (rawChildren.length > MAX_BATCH_CHILDREN) {
      return c.json({ ok: false, error: `at most ${MAX_BATCH_CHILDREN} children per batch` }, 400);
    }

    const wedgeSlug = parent.wedge;
    const loaded =
      (await loadProjectWedge(parent.project_id, wedgeSlug).catch(() => null)) ?? loadWedge(wedgeSlug);
    if (!loaded) return c.json({ ok: false, error: unknownService(wedgeSlug) }, 400);

    type ChildSpec = { task_type: string; input: Record<string, unknown>; wedge?: string };
    const specs: ChildSpec[] = [];
    for (const raw of rawChildren) {
      if (!raw || typeof raw !== "object") {
        return c.json({ ok: false, error: "each child must be an object with task_type and input" }, 400);
      }
      const row = raw as Record<string, unknown>;
      const task_type = String(row.task_type ?? "").trim();
      if (!task_type) return c.json({ ok: false, error: "each child needs task_type" }, 400);
      const childWedge = typeof row.wedge === "string" && row.wedge.trim() ? row.wedge.trim() : wedgeSlug;
      // Children stay on the parent's wedge for v1 — cross-wedge fan-out would need capability
      // rebinding and a clearer Work UI story.
      if (childWedge !== wedgeSlug) {
        return c.json({ ok: false, error: "children must use the parent wedge (cross-wedge batches are not supported yet)" }, 400);
      }
      if (!loaded.manifest.task_types?.[task_type]) {
        return c.json({ ok: false, error: `the "${wedgeSlug}" service does not do "${task_type}"` }, 400);
      }
      specs.push({
        task_type,
        wedge: childWedge,
        input: (row.input && typeof row.input === "object" ? row.input : {}) as Record<string, unknown>,
      });
    }

    const batches = getBatchStore();
    const batch = await batches.createBatch({
      project_id: parent.project_id,
      parent_task_id: parent.id,
      wedge: wedgeSlug,
      case_id: parent.case_id,
      client_id: parent.client_id,
      join,
      quorum,
    });

    // Parent carries batch_id so Work can link the episode; children do too for join.
    await store.updateTask(parent.id, { batch_id: batch.id });
    await store.setStatus(parent.id, "awaiting_batch");

    const childIds: string[] = [];
    for (const spec of specs) {
      const id = await spawnKernelTask({
        project_id: parent.project_id,
        wedge: spec.wedge ?? wedgeSlug,
        task_type: spec.task_type,
        client_id: parent.client_id,
        case_id: parent.case_id,
        batch_id: batch.id,
        source: "case",
        input: spec.input,
      });
      await batches.addChild(batch.id, id);
      childIds.push(id);
    }

    await emitEvent(store, parent.id, "progress", {
      message: `batch ${batch.id} opened with ${childIds.length} children`,
      batch_id: batch.id,
      child_task_ids: childIds,
    });
    markAbort(parent.id, "awaiting_batch");

    const fresh = await batches.getBatch(batch.id);
    return c.json({ ok: true, batch: fresh, child_task_ids: childIds }, 201);
  });

  app.get("/v1/internal/batches/:id", async (c) => {
    const grant = await getActionGrant((c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, ""));
    if (!grant) return c.json({ ok: false, error: "invalid action token" }, 401);
    const task = await store.getTask(grant.task_id);
    if (!task?.project_id) return c.json({ ok: false, error: "unknown task" }, 404);
    const batch = await getBatchStore().getBatch(c.req.param("id"));
    if (!batch || batch.project_id !== task.project_id) return c.json({ ok: false, error: "not found" }, 404);
    return c.json({ ok: true, batch });
  });

  // Founder-facing: inspect a batch (Work UI / analytics). Same tenancy as records.
  app.get("/v1/batches/:id", async (c) => {
    const batch = await getBatchStore().getBatch(c.req.param("id"));
    if (!batch || !inScope(accessible(c), batch.project_id)) return c.json({ error: "not found" }, 404);
    return c.json(batch);
  });

  app.get("/v1/batches", async (c) => {
    const projectId = writeProjectId(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    if (!inScope(accessible(c), projectId)) return c.json({ error: "forbidden" }, 403);
    const limit = Math.min(Number(c.req.query("limit") ?? 50), 100);
    return c.json(await getBatchStore().listBatches(projectId, limit));
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
    const rawRead = await executeRead(conn, capability, params);
    /**
     * BOUND THE BODY BEFORE THE AGENT SEES IT.
     *
     * `executeRead` already caps the TRANSPORT at MAX_READ_BYTES (256 KB) — which is a cap on what
     * we are willing to receive, not on what a model can afford to read. 256 KB of JSON is roughly
     * 64,000 tokens, more than the entire budget of a `decide` run, and it arrives as the body of a
     * `curl` the agent is about to paste into its own context. A CRM query returning 10,000 rows
     * must not be able to end a run by succeeding. See toolresult.ts.
     */
    const bounded = boundData(rawRead.data, { bytes: 24 * 1024, items: 50 });
    const result = {
      ...rawRead,
      ...(rawRead.data !== undefined ? { data: bounded.data } : {}),
      // `truncated` already exists on ReadResult and meant "the HTTP body was cut off". It now also
      // means "the parsed result was summarised" — both are the same statement to the agent: you
      // did not see everything.
      truncated: rawRead.truncated || bounded.truncated || undefined,
      ...(bounded.note ? { note: bounded.note } : {}),
    };
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
    let capability = c.req.param("capability");
    let payload = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

    /**
     * ═══ THE CAPABILITY VERBS ═══
     *
     * `send_email` and `book_calendar` arrive here as themselves, not as a vendor's tool slug, and
     * this is where they become one. The agent writes what it wants to happen — recipients, subject,
     * body; a title and two instants — and the kernel decides which of the founder's providers
     * performs it and what that provider's arguments are called.
     *
     * WHY IT IS HERE AND NOT IN THE SANDBOX. Everything below this block is the human approval gate,
     * the risk assessment, the platform guard, the audit row and the outbound message record. A
     * capability verb that resolved anywhere else would need all of that again, and the second copy
     * is the one that eventually drifts. So the planner runs first, rewrites `conn`, `capability` and
     * `payload` into exactly what the existing path already knows how to gate, and then gets out of
     * the way. There is no branch below that skips the gate for a capability verb.
     *
     * TENANCY, TWICE. The plan is resolved only against connections this GRANT allows, and
     * `resolveCapability` inside the planner independently filters to this task's PROJECT and to
     * founder-owned rows. Either check alone would be enough today; both are here because the failure
     * is a chase sent from one business's mailbox to another business's client, and this repo has
     * shipped a cross-tenant leak twice.
     *
     * A REFUSAL IS AN ANSWER. Nothing connected, two mailboxes connected, a provider with no adapter,
     * a naive datetime with no offset — each comes back as a sentence with `ok: false`, before any
     * approval is queued. A founder must never be asked to authorise a send that could not have gone.
     */
    if (capability === "send_email" || capability === "book_calendar") {
      const plannedTask = await store.getTask(grant.task_id);
      if (!plannedTask?.project_id) {
        return c.json({ ok: false, error: `"${capability}" needs a project to resolve a provider against, and this task has none` }, 400);
      }
      const grantable = (await domain.listConnections()).filter(
        (cn) => cn.project_id === plannedTask.project_id && grant.connectionIds.includes(cn.id),
      );
      const plan: CapabilityPlan =
        capability === "send_email"
          ? planSendEmail({ project_id: plannedTask.project_id, connections: grantable, send: emailSendFrom(payload) })
          : planBookCalendar({ project_id: plannedTask.project_id, connections: grantable, booking: bookingFrom(payload) });
      if (!plan.ok) {
        await emitEvent(store, grant.task_id, "tool.result", { tool: capability, ok: false, detail: plan.refusal });
        return c.json({ ok: false, error: plan.refusal }, 200);
      }
      capability = plan.call.tool;
      // Both spellings on purpose, and neither is redundant. A brokered executor reads
      // `payload.arguments`; the kernel's own transports (`agentmail`, `email`) read `to`/`subject`/
      // `body` off the top level. One payload that satisfies both is what lets a single verb reach
      // four providers without a switch further down.
      //
      // `planned_preview` / `provider_label` ride along so the approval card can show the planned
      // call in the kernel's own words (provider + who + what) rather than only a toolkit slug.
      payload = {
        ...plan.call.arguments,
        arguments: plan.call.arguments,
        connection_id: plan.call.connection_id,
        planned_preview: plan.call.preview,
        provider_label: plan.call.provider_label,
        capability_verb: plan.call.capability,
      };
      if (capability === "send_email" || plan.call.capability === "send_email") {
        // Lifted so the approval card, the guard and the audit row all see WHO this reaches, whatever
        // the provider decided to call the field.
        payload.to = payload.to ?? (plan.call.arguments.recipient_email as unknown);
      }
    }

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
    /**
     * ═══ THE SAME SEND, ARRIVING TWICE ═══
     *
     * The dangerous case is not a write that fails — a failed send is visible and recoverable. It
     * is a write that SUCCEEDS while the caller never learns it did: the agent posts, the message
     * goes, the response is lost to a timeout, and the agent retries. From the agent's side the
     * call failed; from the prospect's side two emails arrived. Over an unreliable channel that is
     * close to inevitable rather than remote, and no protocol fixes it at the transport layer —
     * the Two Generals result says the two sides can never be jointly certain from messages alone.
     * At-least-once delivery plus idempotent APPLY is the only construction that works, and this
     * route is the apply side.
     *
     * `POST /v1/tasks` already does this with a caller-supplied `idempotency-key`. That is the
     * standard pattern and it is the wrong one HERE, for a reason specific to who calls this: the
     * client is a language model in a sandbox. Asking it to generate a key and then reproduce the
     * SAME key on its retry is asking it to be deterministic about the one thing it is least
     * reliable about — a retry would arrive with a fresh key and dedupe nothing.
     *
     * So the key is derived server-side from the INTENT, not the attempt: which task, which
     * capability, which connection, and the addressable content. Two genuinely different messages
     * from one task differ in that content and both go. The same message twice does not.
     *
     * FAILS OPEN, and that is a considered trade rather than laziness. The approval gate below is
     * the primary defence and it is unbypassable, so a duplicate still meets a human on every path
     * except a standing grant — which is exactly the path this protects. Blocking a legitimate send
     * because the grant store blipped would cost a real message to keep a receipt.
     */
    const intentKey = createHash("sha256")
      .update(
        JSON.stringify([
          grant.task_id,
          capability,
          conn?.id ?? "",
          // The addressable content, not the whole payload: a retry may carry a different
          // `planned_preview` or trace id without being a different message.
          payload.to ?? payload.recipient ?? (payload.arguments as { to?: unknown } | undefined)?.to ?? "",
          payload.subject ?? (payload.arguments as { subject?: unknown } | undefined)?.subject ?? "",
          // A planned send_email carries its body in provider-shaped `arguments`, not top-level.
          (payload.arguments as { body?: unknown; text?: unknown } | undefined)?.body ??
            (payload.arguments as { text?: unknown } | undefined)?.text ??
            payload.body ??
            payload.text ??
            "",
        ]),
      )
      .digest("hex")
      .slice(0, 32);
    let idemRecorded = false;
    try {
      const grants = await getGrantStore();
      const held = await grants.putIfAbsent(
        "action_idem",
        intentKey,
        {},
        new Date(Date.now() + IDEM_TTL_MS),
      );
      if (held) {
        // Someone got here first. If they finished, replay their answer; if they are still in
        // flight (or waiting on a human), say so rather than sending alongside them.
        const prior = (held as { result?: unknown }).result;
        return c.json(
          prior ?? { ok: false, duplicate: true, error: "this exact send is already in flight for this task" },
          200,
        );
      }
      idemRecorded = true;
    } catch (e) {
      console.error("[mycel] action idempotency check failed, proceeding:", (e as Error)?.message);
    }

    let requireHuman = false;
    /**
     * Has this person written to us on this thread?
     *
     * Computed for EVERY messaging send, not only the windowed platforms, because it is the
     * highest-signal thing on the approval card and it was previously computed only when a reply
     * window happened to need it. Opening a conversation with a stranger and answering a client who
     * asked a question are different decisions, and a queue that cannot tell them apart makes the
     * founder re-derive it by hand from the message body, every time.
     *
     * `undefined` means "we did not look" (not a messaging send, or no thread) and is deliberately
     * distinct from `false`. See `firstContact` below: an unknown never claims first contact.
     */
    let inboundSeen: boolean | undefined;
    /**
     * The reply window is measured from the customer's last inbound, which the thread already
     * records — without it every windowed platform would look permanently closed.
     *
     * Hoisted out of the guard block because `executeAction` now guards again on its own (see the
     * header there: the sequencer and the approved-reply path bypassed this one entirely), and the
     * second guard must be given the same facts as the first or it would refuse a windowed reply
     * this route had already allowed.
     */
    let lastInboundAt: string | undefined;
    if (isMessagingSend(cap, capability)) {
      const outbound = outboundFromPayload(payload, grant.threadId);
      if (grant.threadId) {
        const msgs = await domain.listMessages(grant.threadId);
        for (const m of msgs) if (m.direction === "inbound") lastInboundAt = m.created_at;
        inboundSeen = lastInboundAt !== undefined;
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
    //
    // The risk used to be the literal `"high"`, for every action this product has ever taken. See
    // risk.ts for why that was the most expensive line in the file: a queue where everything is
    // maximum severity trains the founder to clear it without reading, which is precisely the
    // failure the gate exists to prevent, arriving through the front door.
    //
    // Nothing about this SENDS anything. Every level still stops at a human unless a wedge envelope
    // (policy.ts) or a standing grant the founder wrote by hand (standing.ts) says otherwise.
    const actionId = `${conn.kind}:${capability}`;
    const gateTask = await store.getTask(grant.task_id);
    const verdict = assessRisk({
      action: actionId,
      capability,
      payload,
      manifest: loadWedge(gateTask?.wedge ?? "")?.manifest,
      // Only claimed when we actually looked at the thread. `undefined` (not a messaging send, or
      // no thread on the grant) must not read as "nobody has replied" — that would score a routine
      // webhook as an outreach cold open.
      firstContact: inboundSeen === false,
      forcedHuman: requireHuman,
      clientFacing: isMessagingSend(cap, capability),
    });
    const planned =
      typeof payload.planned_preview === "string" && payload.planned_preview.trim()
        ? payload.planned_preview.trim()
        : undefined;
    const providerLabel =
      typeof payload.provider_label === "string" && payload.provider_label.trim()
        ? payload.provider_label.trim()
        : undefined;
    const basePreview = actionPreview(conn, capability, payload);
    // For a planned send_email the body lives in provider-shaped `arguments`, not top-level
    // `body`/`preview`. Without lifting it, the approval card's editable box showed `gmail:
    // GMAIL_SEND_EMAIL` and edits never reached the message that actually goes out.
    const emailBody =
      payload.capability_verb === "send_email"
        ? (typeof payload.body === "string" && payload.body) ||
          (typeof (payload.arguments as { body?: unknown } | undefined)?.body === "string"
            ? ((payload.arguments as { body: string }).body)
            : undefined) ||
          (typeof (payload.arguments as { text?: unknown } | undefined)?.text === "string"
            ? ((payload.arguments as { text: string }).text)
            : undefined) ||
          (typeof payload.text === "string" ? payload.text : undefined)
        : undefined;
    const preview = {
      ...basePreview,
      why: verdict.why,
      ...(planned ? { planned } : {}),
      ...(providerLabel ? { provider_label: providerLabel } : {}),
      ...(emailBody ? { preview: emailBody.slice(0, 4000), body: emailBody } : {}),
    };
    const { decision, edited } = await awaitApproval(store, grant.task_id, {
      action: actionId,
      risk: verdict.risk,
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
    let finalPayload = edited ? { ...payload, ...edited } : payload;
    // Planned send_email stores the message in provider-shaped `arguments`. The approval card edits
    // arrive as `{ body }`. Without folding that into `arguments`, Approve & send with an edit still
    // dispatched the agent's original draft through Gmail/Outlook.
    if (edited && payload.capability_verb === "send_email" && typeof edited.body === "string") {
      const args = {
        ...((typeof finalPayload.arguments === "object" && finalPayload.arguments && !Array.isArray(finalPayload.arguments)
          ? finalPayload.arguments
          : {}) as Record<string, unknown>),
        body: edited.body,
        ...(Object.hasOwn(
          (typeof payload.arguments === "object" && payload.arguments && !Array.isArray(payload.arguments)
            ? payload.arguments
            : {}) as Record<string, unknown>,
          "text",
        )
          ? { text: edited.body }
          : {}),
      };
      finalPayload = { ...finalPayload, arguments: args, body: edited.body, text: edited.body };
    }
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
          // The content here is the full proposed and corrected payload — recipient, amount,
          // message body — so if the task belongs to a client this row is that client's.
          metadata: { task_id: grant.task_id, capability, ...scopeMeta(taskClientId(task)) },
        });
        await emitEvent(store, grant.task_id, "feedback.recorded", { kind: "correction", capability });
      }
    }

    // This send has been past the approval gate above — `decision` is how. The executor's own guard
    // needs to be told, or a LinkedIn cold open that a human just authorised would be refused by
    // the very rule that asked for the human.
    const result = await executeAction(conn, capability, finalPayload, {
      last_inbound_at: lastInboundAt,
      thread: grant.threadId,
      approved: `${decision} (approval on task ${grant.task_id})`,
    });
    const actedTask = await store.getTask(grant.task_id);
    await audit({
      project_id: actedTask?.project_id ?? "",
      actor: decision === "auto_approved" ? "policy" : "member",
      action: "action.executed",
      entity: "connection",
      entity_id: conn.id,
      detail: {
        capability,
        connection: conn.name,
        kind: conn.kind,
        ok: result.ok,
        decision,
        to: finalPayload.to,
        edited: !!edited,
        // Founder-facing why when the provider refused after approve — BounceList surfaces this.
        ...(result.ok ? {} : { detail: result.detail }),
      },
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
    /**
     * REMEMBER WHICH PROVIDER CONVERSATION WE JUST OPENED, or the reply has nothing to attach to.
     *
     * This is the write half of the threading design in agentmail.ts: AgentMail answers a send with
     * its own `thread_id`, and the inbound webhook joins on it to find this thread, this case and
     * this invoice. Without this line the loop still "works" — the reply arrives, is filed on the
     * client's general thread, and stands nothing down. That is the orphan failure, and it would look
     * like success from every angle except the one that matters.
     *
     * `invoice_id` is read from the TASK's input, not from the payload: the chase run carries the
     * invoice it was spawned for, whereas the payload is the agent's own words about it.
     *
     * Non-fatal and loud. The email has already gone; failing the action now would tell the agent the
     * send failed and invite a duplicate. A missing thread id is logged rather than swallowed because
     * the consequence — silently deaf threading — is invisible until a client is wrongly escalated at.
     */
    if (conn.kind === "agentmail" && result.ok && grant.threadId && actedTask?.project_id) {
      const providerThreadId = (result.data as { thread_id?: unknown } | undefined)?.thread_id;
      const thread = await domain.getThread(grant.threadId);
      if (typeof providerThreadId === "string" && providerThreadId && thread?.project_id === actedTask.project_id) {
        const invoiceId = (actedTask.input as Record<string, unknown> | undefined)?.invoice_id;
        await linkAgentMailThread(actedTask.project_id, {
          provider_thread_id: providerThreadId,
          thread_id: thread.id,
          channel_id: thread.channel_id,
          client_id: thread.client_id,
          ...(thread.case_id ? { case_id: thread.case_id } : {}),
          ...(typeof invoiceId === "string" && invoiceId ? { invoice_id: invoiceId } : {}),
        }).catch((e) => console.error(`[mycel] sent through AgentMail but could not record the thread link:`, e));
      } else if (!providerThreadId) {
        console.error(
          `[mycel] AgentMail accepted a send on task ${grant.task_id} but returned no thread_id — ` +
            "a reply to this message will not attach to the conversation it answers",
        );
      }
    }
    await emitEvent(store, grant.task_id, "tool.result", {
      tool: `${conn.kind}:${capability}`,
      ok: result.ok,
      detail: result.detail,
    });
    /**
     * The RESULT is the point, and it used to be thrown away.
     *
     * This line returned `data: result.data` raw. Two bugs in one: a create that answered with a
     * 40 KB provider object dumped all of it into the agent's context immediately after a side
     * effect had already happened (so aborting cost the work), and a search that answered with
     * thousands of rows did the same only worse. Meanwhile several executors return no `data` at
     * all, so the agent got `{ok:true,detail:"ok"}` and had to invent the invoice id for the next
     * step. `boundResult` fixes the flood; the fix for the emptiness is that executors now have a
     * reason to populate `data`, because it survives to the agent in a readable size.
     */
    /**
     * Record the answer under the intent key, so a retry REPLAYS it rather than sending again.
     *
     * The claim above is what prevents the duplicate; this only upgrades a bare "already in flight"
     * into the actual result. Best-effort for the same reason task creation's is: failing the send
     * because the receipt could not be filed would trade the message for the note about it.
     *
     * Only on the success path. A refusal, a rejected approval or a thrown error leaves the key
     * claimed and unrecorded, which expires with the TTL — and that is the right shape, because a
     * retry after a genuine failure SHOULD be allowed to try again once the window passes rather
     * than replaying a failure forever.
     */
    const answer = boundResult(result);
    if (idemRecorded) {
      await (await getGrantStore())
        .put("action_idem", intentKey, { result: answer }, new Date(Date.now() + IDEM_TTL_MS))
        .catch((e) => console.error("[mycel] action idempotency record failed:", (e as Error)?.message));
    }
    return c.json(answer);
  });


  return app;
}

/**
 * The agent's JSON → the kernel's own send shape.
 *
 * Generous about SPELLING, strict about SUBSTANCE. `body`/`text`/`message` are all accepted because
 * every wedge in this repo already uses a different one and rejecting two of the three would break
 * working businesses to make a point. What is not accepted is a missing recipient or a missing
 * subject — `planSendEmail` refuses those with a sentence, and a permissive parser that invented a
 * default for them would put the refusal beyond reach.
 *
 * `from` and `reply_to` are deliberately NOT read. They come off the connection inside the adapters,
 * because an agent that could choose its own From could send as another identity and an agent that
 * could choose its own Reply-To could route a client's answer away from the business.
 */
function emailSendFrom(payload: Record<string, unknown>): EmailSend {
  const list = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : typeof v === "string" ? [v] : [];
  const text = payload.text ?? payload.body ?? payload.message;
  return {
    to: list(payload.to ?? payload.recipient ?? payload.recipients),
    cc: list(payload.cc),
    subject: typeof payload.subject === "string" ? payload.subject : "",
    text: typeof text === "string" ? text : "",
    ...(typeof payload.html === "string" ? { html: payload.html } : {}),
  };
}

/**
 * The agent's JSON → the kernel's own booking shape.
 *
 * Nothing is defaulted, and `time_zone` least of all. An agent that omits the zone gets a refusal
 * naming it, which is a sentence it can act on inside the same run; a default of UTC would be a
 * booking that renders as the wrong hour on a client's screen and reports success to everyone.
 */
function bookingFrom(payload: Record<string, unknown>): BookingRequest {
  const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const attendees = Array.isArray(payload.attendees)
    ? payload.attendees.filter((x): x is string => typeof x === "string")
    : typeof payload.attendees === "string"
      ? [payload.attendees]
      : [];
  return {
    title: s(payload.title ?? payload.summary ?? payload.subject),
    starts_at: s(payload.starts_at ?? payload.start),
    ends_at: s(payload.ends_at ?? payload.end),
    time_zone: s(payload.time_zone ?? payload.timezone ?? payload.tz),
    attendees,
    ...(typeof payload.description === "string" ? { description: payload.description } : {}),
    ...(typeof payload.location === "string" ? { location: payload.location } : {}),
  };
}

/** Reject malformed cadences at the boundary rather than letting the tick loop trip over them. */
function validCadence(c: Cadence | undefined): boolean {
  if (!c || typeof c !== "object") return false;
  if (c.kind === "every") return Number.isFinite(c.seconds) && c.seconds >= 1;
  if (c.kind === "daily") return c.hour >= 0 && c.hour <= 23 && c.minute >= 0 && c.minute <= 59;
  // `weekday` 0..6, Sunday-first, matching Date.getUTCDay(). Validated STRICTLY here even though
  // nextRun normalises out-of-range values: normalisation exists so a stray 7 cannot silently
  // become a fortnightly schedule at run time, and this exists so nobody stores a 7 in the first
  // place and wonders later why the manifest and the fired day disagree.
  if (c.kind === "weekly") {
    return (
      Number.isInteger(c.weekday) && c.weekday >= 0 && c.weekday <= 6 &&
      c.hour >= 0 && c.hour <= 23 && c.minute >= 0 && c.minute <= 59
    );
  }
  if (c.kind === "monthly") return c.day >= 1 && c.day <= 31 && c.hour >= 0 && c.hour <= 23 && c.minute >= 0 && c.minute <= 59;
  // A cadence kind this function does not know is REFUSED, not passed through. Adding a variant to
  // the union without adding it here fails closed — the schedule cannot be created — which is the
  // correct direction: an unschedulable schedule is visible, an unvalidated one fires forever.
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


// ── Delivery failures ────────────────────────────────────────────────────────────────────────────

/**
 * A delivery failure, recorded: suppressed if the verdict says so, and always said in plain English.
 *
 * Returns what a person would want in a log line. Never throws — a webhook handler that dies on a
 * bounce is a webhook the provider retries forever, and the retry carries the same bounce.
 */
async function recordDeliveryFailure(
  verdict: { suppress?: SuppressReason; detail: string; address?: string; penaltyWeeks: number },
  projectId: string | undefined,
  inbox?: string,
): Promise<{ detail: string; suppressed: boolean; inbox_penalty?: number }> {
  if (!projectId) return { detail: verdict.detail, suppressed: false };
  let suppressed = false;
  try {
    if (verdict.suppress && verdict.address) {
      const { created } = await suppressAddress({
        project_id: projectId,
        email: verdict.address,
        reason: verdict.suppress,
        detail: { said: verdict.detail },
      });
      suppressed = created;
    }
  } catch {
    // Storage failed. Say what happened rather than 500ing into a retry loop — the provider will
    // send this bounce again and the next attempt writes it.
  }

  /**
   * ═══ AND THE MAILBOX THAT SENT IT STEPS BACK ═══
   *
   * Suppressing the address stops us mailing THAT person again. It does nothing about the reason a
   * receiver formed an opinion of this mailbox, and a mailbox drawing complaints needs to send less
   * tomorrow whether or not we ever write to that address again.
   *
   * The penalty is applied even when nothing was suppressed, because a transient bounce still costs
   * zero and a complaint against an address already on the list still costs two weeks — the ledger
   * and the ramp are answering different questions.
   */
  let inboxPenalty: number | undefined;
  if (inbox && inbox.includes("@")) {
    const kind = verdict.suppress === "complaint" ? "complaint" : verdict.suppress === "hard_bounce" ? "hard_bounce" : "transient_bounce";
    try {
      inboxPenalty = (await penaliseInbox({ project_id: projectId, address: inbox, kind })).penalty;
    } catch {
      // Same posture: a health counter that failed to write must not turn a bounce into a retry storm.
    }
  }
  return { detail: verdict.detail, suppressed, ...(inboxPenalty === undefined ? {} : { inbox_penalty: inboxPenalty }) };
}

/**
 * The project that owns the mailbox a delivery event is about.
 *
 * A delivery event carries no thread we wrote, so the inbox is the only routing key — the same
 * fallback the inbound path uses when a message arrives with no prior outbound.
 */
async function projectForInbox(raw: unknown): Promise<{ project_id?: string; inbox?: string }> {
  const e = (raw ?? {}) as Record<string, unknown>;
  const m = (e.message ?? {}) as Record<string, unknown>;
  const mail = (e.mail ?? {}) as Record<string, unknown>;
  const inboxId =
    (typeof m.inbox_id === "string" && m.inbox_id) ||
    (typeof e.inbox_id === "string" && e.inbox_id) ||
    (typeof mail.source === "string" && mail.source) ||
    "";
  if (!inboxId) return {};
  const conn = await connectionForInbox(String(inboxId));
  return { project_id: conn?.project_id, inbox: await addressForInbox(String(inboxId)) };
}

/**
 * The sending ADDRESS behind an inbox id.
 *
 * An AgentMail inbox id is already an address; a generic email connection keeps one in `config.from`.
 * The ramp is keyed on the address because that is what a receiver forms an opinion of, and because
 * two connections pointing at one mailbox must share one warm-up rather than each having their own.
 */
async function addressForInbox(inboxId: string | undefined): Promise<string | undefined> {
  if (!inboxId) return undefined;
  if (inboxId.includes("@")) return inboxId.trim().toLowerCase();
  const conn = await connectionForInbox(inboxId);
  const from = conn?.config?.from ?? conn?.config?.address;
  return typeof from === "string" && from.includes("@") ? from.trim().toLowerCase() : undefined;
}

/**
 * What a finished run left behind.
 *
 * TWO CHEAP READS, not four. The first version of this reached for a deliverable-version lookup by
 * task and a wait lookup by task; neither exists, because neither store is indexed that way — and
 * building the join for one sentence on a hot route would be paying for the sentence four times.
 *
 * The EVENT LOG is the one thing every run writes, and it already carries the kinds that name an
 * outcome: `drafted` for a submitted version, `artifact.created` for a file, `approval.requested`
 * for an outward action held at a gate. So the log answers most of it in a single query, and
 * `listArtifacts` covers files written without an event.
 *
 * Each read is independently fail-soft. A count that throws is zero, and zero can only move the
 * ending toward `nothing_visible` — the honest answer when we cannot see that anything happened,
 * and never a stronger claim than the run earned.
 */
async function runTracesFor(
  store: Store,
  t: { id: string; project_id?: string; status: string },
): Promise<RunTraces> {
  const [artifacts, events, requests] = await Promise.all([
    /**
     * NOT `result.txt`, which is 5,455 of the 7,565 artifacts in production.
     *
     * It is the run's raw stdout dump, written by the harness rather than by the work, and it exists
     * on almost every run that has ever executed. Counting it makes `filed` — "wrote files you can
     * open" — true of every run in the product, which turns the one ending that matters
     * (`nothing_visible`) into something that never fires.
     *
     * AND `size_bytes > 0`, which is the honest test for "this has bytes".
     *
     * 5,447 artifacts in production have a recorded size and an empty `content` column, and that is
     * the DESIGN rather than a defect: `getArtifactBackend()` puts the bytes in S3 and leaves the
     * column empty, and `size_bytes` is written precisely so a reader can tell "this artifact is
     * empty" from "this artifact's bytes are somewhere this process cannot read". The comment at
     * that write names the production incident it was added for — onboarding once told a founder his
     * draft came back empty when the shape had gone to S3.
     *
     * So a zero size is genuinely nothing, and the thirty-two rows with one are correctly not
     * counted as work.
     */
    store
      .listArtifacts(t.id)
      .then((a) => a.filter((x) => x.name !== "result.txt" && (x.size_bytes ?? 0) > 0).length)
      .catch(() => 0),
    store.eventsAfter(t.id, 0).catch(() => [] as TaskEvent[]),
    t.project_id
      ? getRequestStore()
          .listRequests({ project_id: t.project_id })
          .then((r) => r.filter((x) => x.task_id === t.id).length)
          .catch(() => 0)
      : Promise.resolve(0),
  ]);
  const kinds = new Set(events.map((e) => e.type));
  /**
   * THERE IS NO `deliverable.submitted` EVENT, and this deliberately does not invent one.
   *
   * A submitted version writes no event of its own — every version references artifacts, and those
   * are what `artifacts` above counts, so a delivering run already reads as `filed` rather than as
   * nothing. Calling that `delivered` here would be guessing, and the two endings say different
   * things to a founder: one means their client has something to open.
   *
   * The honest consequence is that `delivered` is currently unreachable from this route. That is a
   * missing event, not a missing ending — and naming the gap in the type is what will make somebody
   * add the event rather than quietly widen `filed` to cover both.
   */
  return {
    status: t.status,
    artifacts,
    requests,
    // An approval requested is an outward action the run took and had held at a gate — the
    // difference between "did nothing" and "did something that is waiting on you".
    actions: kinds.has("approval.requested") || kinds.has("service.drafted") ? 1 : 0,
    records: kinds.has("practice.derived") || kinds.has("output.validated") ? 1 : 0,
  };
}
