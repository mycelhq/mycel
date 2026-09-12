// Orchestration: provision a sandbox, run OpenCode against the task, enforce cost/runtime
// limits, persist + stream + trace events, tear the sandbox down. Approval suspend/resume lives
// in approvals.ts (driven by the OpenCode plugin gate). v0.1 runs in-process; a durable engine
// slots in at the same seams.
import { getArtifactBackend } from "./artifacts";
import { createHash } from "node:crypto";
import { abortReason, clearAbort, markCancelled } from "./cancel";
import { repeatWarning, scoreSite, siteQualityFault } from "./sitequality";
import { databaseUrl, loadConfig } from "./config";
import type { EventType, Task, TaskStatus } from "./contract";
import { emitEvent } from "./events";
import { createSandbox, type Sandbox } from "./sandbox";
import { deliverRunMessage } from "./deliver-message";
import {
  MAX_PROVISION_RETRIES,
  ProvisioningUnavailable,
  provisioningUnavailable,
} from "./provisioning";
import { normaliseArtifactPaths, runOpenCodeTask, type CostMeta, declaredArtifactPaths } from "./runtime";
import { runMockTask } from "./runtime.mock";
import type { Store } from "./store";
import { getObserver } from "./tracing";
import { canonicaliseKeys, validateOutput } from "./validate";
import { PRACTICE_COLLECTION } from "./practice";
import { repairOutput } from "./repair";

import { wedgeHasRole } from "./roles";
import {
  assertExportableBackend,
  assertSubstantiveChange,
  collectSiteFiles,
  exportDirectory,
  readSeed,
  resolveWorkspace,
  verifyWorkspace,
} from "./workspace";
import { deployConfig, proposeDeploy } from "./deploy";
import { siteFor } from "./site-identity";
import { MAX_BUILDS_PER_RUN, remoteBuildConfig } from "./remotebuild";
import { getDomainStore } from "./domain";
import { getIdentityStore } from "./identity";
import { getKnowledgeStore } from "./knowledge.store";
import { authorWedgeFromOutput, faultSentence } from "./wedgeauthor";
import type { TradeIdentity, TradeMechanic } from "./trade-identities";
import { getAuthoredStore, loadProjectWedge } from "./authored";
import { onChildFinished } from "./batches";
import { assertSendPromiseKept, readPromises, releaseClaimFor } from "./promises";
import { wrapFulfillmentDeliverable } from "./deliverables.wrap";
import { reviewVersion } from "./review-version";
import { shippedPageFaults } from "./pages";
import {
  DRAFT_SHAPE_TASK_TYPE,
  keepServiceResearch,
  spawnDraftAfterResearch,
  spawnLearningResearch,
  RESEARCH_SERVICE_TASK_TYPE,
} from "./skill-arsenal";
import { noteProbe, PROBE_TASK_TYPE } from "./surface-health";
import { openProposalEnvelope } from "./proposal-envelope";
import { spawnShipFollowOn } from "./ship-follow-on";
import { publishPage, publishedPageUrl } from "./pages";
import { materialsForTask } from "./materials";
import { getRequestStore } from "./requests";
import { clipToBoundary, asksToOpen, decideFate, materialsAsk, MAX_OPEN_ASKS } from "./client-ready";
import { explain, mayAutoRelease, releasePolicyFor } from "./release-policy";
import { markAutoReleased, readRecord } from "./release-policy.pg";
import { getDeliverableStore } from "./deliverables";
import { getPool } from "./pool";
import { effectiveShipContract } from "./infer-checks";
import { readShipChecks } from "./ship-checks";
import { render, slidesFromBlocks, tasteBlockers } from "./render";
import { blocksFromMarkdown, chartBlock, figuresBlock, insertChart } from "./render/report";

/**
 * The job the shaper does when nothing installed fits the business it just read.
 *
 * A constant rather than an inline string because `roles.ts` names the same task type in the
 * `business_shaping` role, and the two must agree or the shaper produces a draft nobody parses.
 */
const DRAFT_SERVICE_TASK_TYPE = "draft_service";
/** The run that reads a founder's own work and derives how they practise. See practice.ts. */
const DRAFT_PRACTICE_TASK_TYPE = "draft_practice";

/**
 * The model's answer as an object — with its keys named the way the schema names them.
 *
 * `canonicaliseKeys` is why the schema is an argument. A close wrote a complete profit and loss
 * under `profit-and-loss`; the schema declares `profit_and_loss`; the ship bar reported "promises
 * `profit_and_loss` and delivered it empty" and withheld a correct month's books over a hyphen.
 * `validateOutput` already fixes this for the value it returns, and this function re-parsed the raw
 * text and threw that away — so the object every downstream verdict reasons about was the one with
 * the wrong key in it. See validate.ts for why the rename is safe.
 */
function parseJsonOutput(text: string, schema?: unknown): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  let value: unknown;
  try { value = JSON.parse((fenced?.[1] ?? text).trim()); } catch { return null; }
  return schema ? canonicaliseKeys(value, schema) : value;
}

/**
 * The hostname label this project publishes under, or null when it has none.
 *
 * A project's `slug` is optional in the type and allocated at creation, so an older project can
 * genuinely lack one. Null means "do not deploy" rather than "invent a name": a slug ends up in
 * links sent to a founder's customers, and one chosen here — after the fact, by a background worker
 * — would be a URL nobody agreed to and nobody can predict.
 */
async function deploySlugFor(projectId: string): Promise<string | null> {
  try {
    // `loadProject`, not `getProject`: this runs in the WORKER, whose identity cache was filled at
    // boot. A project created since the last deploy is not in it, and answering null here means the
    // founder's app is silently never published — the same stale-cache fault that made every new
    // org's model call fail with a provider 401.
    return (await getIdentityStore().loadProject(projectId))?.slug ?? null;
  } catch (e) {
    // An identity store that cannot answer must not fail a run that has already succeeded — but it
    // must not vanish either. The caller turns a null into a line on the run's feed; this log is
    // what tells an operator the null was a fault rather than a project that genuinely has no slug.
    console.error(`[mycel] could not read the publish slug for project ${projectId}:`, e);
    return null;
  }
}

/**
 * Turn "the run needs something only the client has" into an ask the client can actually answer.
 *
 * ═══ WHY A REQUEST AND NOT A DELIVERABLE ═══
 *
 * These arrived as deliverables. A client opening their portal found a branded PDF titled with
 * their engagement, an Accept button, and a body explaining that their bookkeeping could not be
 * done. Nobody should be invited to review and accept a list of things they failed to send — and
 * the founder, on the other side, sees a Deliverable in review that represents no work.
 *
 * `client_requests` is the noun that already fits: the portal renders it as an ask, `blocked.tsx`
 * shows an uploader when a thread is attached, and `resolveRequest` files the response artifacts
 * against the case. Which is precisely what `materialsForTask` reads back on the next run. Routing
 * to the right noun is what makes the loop close; nothing else here is new machinery.
 *
 * ═══ WHY IT DEDUPES ON THE ASK TEXT ═══
 *
 * The ignition sweep re-runs work every five minutes. Without a check, a wedge that refuses for a
 * missing bank statement opens a new "Your March bank statement" request on every pass — and each
 * one is a nudge candidate. That is a client receiving the same question hundreds of times before
 * anyone notices, which is the exact failure the touch budget exists to prevent, arriving from a
 * direction the touch budget cannot see because these are not tasks.
 *
 * So: an OPEN request with the same ask on the same case means the question has been put. Say
 * nothing further. It is already their turn.
 *
 * ═══ AND WHY A RUN MAY NOT PILE ONTO SOMEBODY ELSE'S QUESTIONS ═══
 *
 * Exact-text dedupe is not enough, and production proved it within one run. A model that refuses
 * twice does not phrase the ask identically twice:
 *
 *   "Please provide the most recent bank statement for the close period."   (the agent's own tool)
 *   "Your March bank statement"                                             (this path)
 *   "Confirm we can start the monthly close on this engagement"             (kickoff)
 *
 * The first real case ended with three distinct questions asked three times each, from three
 * different doors, none of which could see the others.
 *
 * The instrument is NOT a flat count of open asks. `chase_receipts` legitimately asks for four
 * missing receipts in one episode, and they join into one wait the client answers as a single list
 * — a flat ceiling silently drops the fourth and files three quarters of a month looking entirely
 * correct. That is the worse bug and it already has a test.
 *
 * The rule that fits both: a run may ask for everything IT needs, and may not start a second pile
 * on top of questions somebody else asked and the client has not answered. Nothing outstanding →
 * ask for all of it. Three already outstanding → say nothing; they are already the blocker, and a
 * fourth question changes nothing about what they must do next.
 *
 * Fuzzy matching is the tempting alternative and the wrong one: a similarity threshold will one day
 * suppress a genuinely different question, and a suppressed ask is invisible — the work never
 * unblocks and nobody can see why.
 *
 * The agent's own `ask_client` door enforces the same rule in `server.ts`; a ceiling on one of two
 * doors is not a ceiling. This is the touch budget's argument arriving from a direction that budget
 * cannot see, because requests are not tasks and nothing was counting them.
 */
async function openMaterialRequests(task: Task, needs: string[]): Promise<void> {
  if (!needs.length || !task.project_id || !task.case_id || !task.client_id) return;
  try {
    const requests = getRequestStore();
    const open = await requests.listRequests({
      project_id: task.project_id,
      case_id: task.case_id,
      status: "open",
    });
    const kase = await getDomainStore().getCase(task.case_id);
    // Trimmed to the ask text FIRST, so the dedupe compares what a client would actually read
    // rather than the raw need — `materialsAsk` truncates long ones, and two needs that differ only
    // past the cut are one question.
    const wanted = needs.map((n) => materialsAsk(kase?.title ?? "", n));
    // Everything already open came from an earlier run — this one has created nothing yet. Same
    // rule as the agent's own ask door: do not start a second pile on top of somebody else's
    // unanswered questions, but once there is room, ask for everything this run actually needs
    // rather than truncating a genuine list to fit a count. `needs` is capped at four by the
    // schema, and four things asked together is one ten-minute job for the client.
    if (open.length >= MAX_OPEN_ASKS) return;
    const toOpen = asksToOpen(
      wanted.map((w) => w.ask),
      open.map((r) => r.ask),
      open.length + wanted.length,
    );

    for (const ask of toOpen) {
      const detail = wanted.find((w) => w.ask === ask)?.detail ?? "";
      await requests.createRequest({
        project_id: task.project_id,
        client_id: task.client_id,
        case_id: task.case_id,
        // `document` so the portal offers an uploader. An answer is still typeable, so this is the
        // strictly wider door — asking for a file and receiving a sentence loses nothing, while
        // asking with `answer` and needing a statement leaves them nowhere to put it.
        kind: "document",
        ask,
        detail,
        party_role: "client",
        task_id: task.id,
      });
    }
  } catch (e) {
    // A run that produced no deliverable must not also fail. The founder still sees the held
    // progress line; this log is what says the ask itself never reached the client.
    console.error("[mycel] could not open material requests:", e);
  }
}

/**
 * How many times this task has already waited for the provider.
 *
 * Counted from the task's own EVENT LOG rather than held in the job payload, so a kernel restart
 * between attempts does not reset the budget and hand a genuinely-full provider an unbounded loop.
 * The events are already durable and already the record of what happened to this run.
 */
async function provisionAttemptFrom(store: Store, taskId: string): Promise<number> {
  const events = await store.eventsAfter(taskId, 0).catch(() => []);
  return events.filter(
    (e) =>
      e.type === "progress" &&
      String((e.data as { note?: unknown } | undefined)?.note ?? "").includes("could not start a machine"),
  ).length;
}

export async function runTask(store: Store, taskId: string): Promise<void> {
  const task = await store.getTask(taskId);
  if (!task) return;

  // One process-wide observer (the JSONL sink). The per-tenant variant existed for the Langfuse
  // sink, which is gone; see tracing.ts.
  const observer = await getObserver();
  await observer.onTaskStart(task);

  const emit = (type: EventType, data: Record<string, unknown> = {}) =>
    emitEvent(store, taskId, type, data);

  const deadline = Date.now() + task.constraints.max_runtime_s * 1000;
  let accruedCost = 0;

  /**
   * ═══ THE CLOCK STOPS WHILE A HUMAN HOLDS THE BALL ═══
   *
   * `max_runtime_s` was sized for a run that only ever waits on models and tools. But the approval
   * gate SUSPENDS a run mid-flight until a person decides (`awaitApproval` blocks; status flips to
   * `awaiting_approval`), and the deadline arithmetic below knew nothing about it — so a
   * `chase_invoice` run with a 420s ceiling and a founder at lunch expired at
   * `max_runtime_exceeded` seven separate times in production, each one a good draft killed for
   * the crime of asking permission. Punishing the run for the human's latency teaches wedge
   * authors to inflate ceilings, which then stop catching real hangs — the one job they have.
   *
   * So suspended time is credited back. The status row is the source of truth (the approval may
   * settle on another replica; in-memory bookkeeping over there is invisible here), sampled every
   * 2s — coarse, but an error of seconds against ceilings of minutes, and always in the run's
   * favour by at most one sample. Bounded by the approval's own TTL, so a run cannot ride a
   * forgotten approval forever. The interval is unref'd and cleared in `finally` with the rest.
   */
  let suspendedMs = 0;
  let suspendedSince = Date.now();
  const suspensionWatch = setInterval(async () => {
    const now = Date.now();
    try {
      const t = await store.getTask(taskId);
      if (t?.status === "awaiting_approval") suspendedMs += now - suspendedSince;
      if (t?.status === "cancelled") markCancelled(taskId);
    } catch {
      /* a store blip must not decide a timeout either way — skip the sample */
    }
    suspendedSince = now;
  }, 2000);
  (suspensionWatch as unknown as { unref?: () => void }).unref?.();

  /**
   * Unrecognised OpenCode event types seen during the run, reported on `task.finished`.
   *
   * The alternative is what happened before: a protocol change silently produced runs with no tool
   * calls, no tokens and no cost, and looked exactly like a quiet run. A counter here means the
   * next drift is visible on the very first task that hits it.
   */
  let drift: Record<string, number> | undefined;
  const onDrift = (counts: Record<string, number>) => {
    drift = counts;
  };

  const onCost = (usd: number, meta?: CostMeta) => {
    accruedCost += usd;
    // Fire-and-forget, but never leave an unhandled rejection (a pg blip must not crash the process).
    void store.addCost(taskId, usd).catch((e) => console.error("[mycel] addCost error:", e));
    void Promise.resolve(
      emit("cost.charged", {
        cost_usd: Number(usd.toFixed(6)),
        reason: meta?.reason ?? "model",
        // The model and the token counts ride ALONG with the dollars rather than being collapsed
        // into them. "Which model ran this?" is the first question anyone asks a trace, and until
        // now `cost.charged` carried `{cost_usd, reason}` and could not answer it.
        ...(meta?.model ? { model: meta.model } : {}),
        ...(meta?.tier ? { tier: meta.tier } : {}),
        ...(meta?.tokens ? { tokens: meta.tokens } : {}),
      }),
    ).catch((e) => console.error("[mycel] cost event error:", e));
  };

  // Synchronous, store-independent — safe to call on hot paths inside the run loop. The abort
  // registry carries user cancels AND approval outcomes (rejected/expired), so they end the run.
  const shouldAbort = (): string | null => {
    const r = abortReason(taskId);
    if (r) return r;
    if (Date.now() > deadline + suspendedMs) return "max_runtime_exceeded";
    if (accruedCost > task.constraints.max_cost_usd) return "max_cost_exceeded";
    return null;
  };

  /** `unmapped` only appears when something WAS unmapped — an absent key means a clean run. */
  const driftData = () => (drift ? { unmapped: drift } : {});

  // The client's own files, for `./inputs/`. Bound here because this is where the stores are.
  const materials = () =>
    materialsForTask(task, getRequestStore(), (id) => store.getArtifact(id));
  const ctx = { emit, onCost, shouldAbort, onDrift, materials };
  const useMock = loadConfig().runtime === "mock";
  let sandbox: Sandbox | undefined;
  try {
    // Provisioning is inside the try: a sandbox that fails to start must fail the task, not
    // strand it in `queued` with an SSE stream hanging forever.
    // Resolved BEFORE a sandbox exists, and checked against the artifact backend here rather than
    // at the end. A build costs dollars and half an hour, and discovering that the deliverable has
    // nowhere to live is the most expensive possible moment to find out — the inline backend keeps
    // artifact content in a Postgres row, which is the wrong home for megabytes of gzip.
    //
    // `!useMock` is not a loophole, it is the same condition the export itself runs under. A mock
    // run has no sandbox and therefore produces no tarball, so demanding an object store from it
    // would refuse every `product-builder` task on a developer's machine and in the whole test
    // suite — a hard dependency on S3 to run a fake task. That is exactly what this check did on
    // its first draft, and `product-builder` is the one wedge that could never start again.
    const ws = resolveWorkspace((await loadProjectWedge(task.project_id ?? "", task.wedge))?.manifest, task.task_type);
    if (ws && !useMock) assertExportableBackend(await getArtifactBackend());

    await store.setStatus(taskId, "provisioning");
    if (!useMock) {
      try {
        // The idle window follows this run's own budget rather than a flat hour — see
        // `idleMinutesFor`. 94% of the sandbox-hours we paid for last fortnight were dead runs
        // waiting out a 60-minute timer.
        sandbox = await createSandbox({ maxRuntimeS: task.constraints?.max_runtime_s });
        /**
         * WRITE DOWN WHAT WE ARE HOLDING, BEFORE ANY WORK RUNS.
         *
         * openwork's cloud automations "reserve and persist the worker, workspace, native thread
         * and deterministic message identity BEFORE submitting the prompt" so lease recovery can
         * reattach instead of starting duplicate work. We do not want to reattach — a killed run's
         * OpenCode session is gone — but we do want the id, because without it a restart leaves a
         * box nothing can name.
         *
         * `sandbox.ts` said so plainly: "Nothing reattaches — no sandbox id is persisted against a
         * task." The sweep cannot cover this case either: it refuses to touch a `started` box,
         * correctly, because a slow run looks identical from outside. Only the kernel that created
         * this one knows it is dead.
         *
         * Fail-soft. A run whose bookkeeping event fails is still a run; it just leaks the way
         * every run did before this.
         */
        await emitEvent(store, taskId, "sandbox.acquired", { sandbox_id: sandbox.id }).catch(() => {});
      } catch (e) {
        /**
         * A PROVIDER THAT COULD NOT ANSWER IS NOT A FAILED JOB — yet.
         *
         * Nothing has happened at this point: no turn has run, no action grant exists, no tool has
         * been called, nothing has been sent. So the reason `queue.ts` refuses to retry — "may have
         * already sent an email or moved money" — has no premise here. See `provisioning.ts` for the
         * argument in full and for the production task that died on `Total disk limit exceeded`.
         *
         * Rethrown as a distinct TYPE rather than handled here, because the decision to wait belongs
         * to the queue (which owns scheduling) and the proof that nothing happened belongs here
         * (which owns the ordering). Splitting them that way is what stops a failure from later in
         * the run ever reaching the retry path.
         */
        if (provisioningUnavailable(e)) {
          const attempt = await provisionAttemptFrom(store, taskId);
          if (attempt < MAX_PROVISION_RETRIES) {
            await emit("progress", {
              note:
                `the sandbox provider could not start a machine (${String((e as Error)?.message ?? e).slice(0, 160)}). ` +
                `Nothing has run yet, so this is waiting rather than failing — attempt ${attempt + 1} of ${MAX_PROVISION_RETRIES}.`,
            });
            throw new ProvisioningUnavailable(String((e as Error)?.message ?? e), attempt);
          }
        }
        throw e;
      }
    }
    await store.setStatus(taskId, "running");
    await emit("task.created", { wedge: task.wedge, task_type: task.task_type });

    let { text, capabilityGaps, missingArtifacts, brokenArtifacts } = useMock
      ? await runMockTask(task, ctx)
      : await runOpenCodeTask(task, sandbox!, ctx);

    // Honest validation against the wedge/task output_schema — not a hardcoded ok:true.
    const schema = task.output_schema;
    let v = validateOutput(text, schema);

    /**
     * ═══ A NEAR-MISS MUST NOT BLOW UP THE MOST IMPORTANT MOMENT ═══
     *
     * There used to be no retry at any layer, so a single missing or misplaced field on the final
     * message threw and wasted the whole run — and this is the run behind the flagship first
     * impression (`business-shaper` / `draft_shape`, a founder describing their business). Live
     * dogfooding on openai/gpt-5.6-luna came back `$.sells / $.sells_to / $.runs_as / $.first_job /
     * $.confidence: required`: the answer was there, one key deep, and we hard-failed it.
     *
     * `repairOutput` is a bounded, deterministic recovery — unwrap a wrapper object, fill schema-
     * declared defaults — that runs ONLY after validation has already failed and invents no business
     * fact (see repair.ts). A value it cannot honestly recover still fails, exactly as before, and
     * degrades to the cloud's "Set it up myself" fallback. So the repair can only ever turn a
     * hard-fail into a success, never the reverse.
     */
    if (!v.ok) {
      const repaired = repairOutput(text, schema);
      if (repaired) {
        const rv = validateOutput(repaired.text, schema);
        if (rv.ok) {
          text = repaired.text;
          v = rv;
          await emit("output.repaired", { changes: repaired.changes });
        }
      }
    }

    /**
     * ═══ AND WHEN DETERMINISTIC REPAIR CANNOT, THE MODEL GETS ONE CHANCE TO ═══
     *
     * `repairOutput` fixes shape (unwrap, defaults) and refuses to invent facts — correctly. But
     * six production failures were the model KNOWING the answer and phrasing it wrong: prose around
     * the JSON, a missing required key it plainly had ("$.sells: required" on a run whose text
     * described what the business sells). The industry-standard recovery is a single retry that
     * carries the validator's own message — the specific violation, not "try again" — which is
     * exactly what fixes a near-miss and does nothing for a genuinely absent answer.
     *
     * ONE round, in the same sandbox, only after deterministic repair declined. A model that fails
     * the schema twice with the errors in front of it does not know the answer, and the honest
     * outcome is the same failure as before. Mock runs skip it: canned text either validates or
     * the test wanted the failure.
     */
    if (!v.ok && !useMock && sandbox) {
      await emit("progress", {
        note: `output failed validation — one retry carrying the validator's message: ${v.errors.join("; ").slice(0, 200)}`,
      });
      const retry = await runOpenCodeTask(
        {
          ...task,
          input: {
            ...task.input,
            schema_retry: true,
            repair_feedback:
              `Your previous final message failed schema validation: ${v.errors.join("; ").slice(0, 1500)}. ` +
              `The work is done — do not redo it. Reply with EXACTLY the corrected JSON result and nothing else.`,
          },
        },
        sandbox,
        ctx,
      );
      const rv = validateOutput(retry.text, schema);
      if (rv.ok) {
        text = retry.text;
        v = rv;
        await emit("output.repaired", { changes: ["model retry with validator feedback"] });
      }
    }

    await emit("output.validated", { ok: v.ok, errors: v.errors });
    if (!v.ok) throw new Error(`output failed validation: ${v.errors.join("; ")}`);

    /**
     * A service the kernel wrote for this business, filed as a DRAFT nobody has agreed to run.
     *
     * Deliberately the same shape as the improvement hook above, and for the same reason: model
     * output is a hypothesis until a human accepts it. The stake here is higher than a knowledge
     * file — a promoted service is one a client eventually hears from — so the gate is stronger.
     * `loadProjectWedge` refuses to load anything that is not `promoted`, so nothing can be spawned
     * against what is stored here until a founder says so.
     *
     * ═══ AN INVALID DRAFT IS NOT STORED ═══
     *
     * A draft that fails validation is NOT written, and the founder is shown the sentences instead.
     * Writing it and marking it broken would put a row in the list that looks like progress, and the
     * recurring expensive bug in this repo is something failing while reporting success. The task
     * still SUCCEEDS — the run did its job and its output passed its own schema — but
     * `service.draft_refused` carries every fault, so the refusal is visible in the timeline rather
     * than inferred from an absence.
     */
    /**
     * ═══ HOW THIS FIRM PRACTISES, FILED WHERE EVERY DELIVERY RUN LOOKS ═══
     *
     * `draft_practice` reads the work a founder uploaded and derives their method. It ran, it
     * validated against its schema, and its output went into an artifact and nowhere else — so
     * `practiceSkills` found no record, mounted nothing, and every delivery run fell back to the
     * wedge exactly as if the derivation had never happened. Found by running it: the task said
     * `succeeded`, the trace said `output.validated`, and the thing the whole feature exists to
     * produce was not there.
     *
     * FILED AS A RECORD, NOT PROMOTED TO TRUTH. Same shape as the two hooks above and for the same
     * reason: model output is a hypothesis until a human accepts it. Nothing here stamps
     * `confirmed_at`, so the practice mounts as "a strong prior, NOT YET CONFIRMED" until the
     * founder reads it back and says otherwise. See practice.ts.
     *
     * Keyed `current`, matching what the console writes when they correct it, so a correction
     * REPLACES the inference rather than sitting beside it as a second opinion the agent has to
     * arbitrate between.
     */
    if (wedgeHasRole(task.wedge, "business_shaping") && task.task_type === DRAFT_PRACTICE_TASK_TYPE && task.project_id) {
      const parsed = parseJsonOutput(text) as Record<string, unknown> | null;
      const body = typeof parsed?.practice === "string" ? parsed.practice.trim() : "";
      if (body) {
        const list = (v: unknown) =>
          Array.isArray(v) ? v.map((x) => String(x ?? "").trim()).filter(Boolean).slice(0, 24) : [];
        await getDomainStore().upsertRecord({
          project_id: task.project_id,
          wedge: task.wedge,
          collection: PRACTICE_COLLECTION,
          key: "current",
          data: {
            deliverable: String(parsed?.deliverable ?? "").trim(),
            answers: String(parsed?.answers ?? "").trim(),
            cadence: String(parsed?.cadence ?? "").trim(),
            needs: list(parsed?.needs),
            checks: list(parsed?.checks),
            practice: body,
            derived_at: new Date().toISOString(),
            task_id: task.id,
          },
        });
        await emit("practice.derived", { deliverable: String(parsed?.deliverable ?? "").slice(0, 120) });
      }
    }

    /**
     * THE SHAPE LANDED — NOW GO AND READ THE TRADE.
     *
     * Chained here, next to the other two shaping hooks, for the reason the research→draft chain
     * gives a hundred lines down: onboarding tells a founder they can close the tab, and a follow-on
     * driven by a poller in a browser makes that a lie.
     *
     * Runs for EVERY shape, covered or not. A covered trade means one installed service matches one
     * job; it says nothing about the other six things the firm sells, and the research is the only
     * thing in the product that goes and looks. `learn_only` stops it writing anything.
     *
     * Fire-and-forget, and the `catch` is the point. Nothing in onboarding waits on this and nothing
     * downstream requires it — a founder whose research never lands gets the flow that existed
     * before it did.
     */
    if (wedgeHasRole(task.wedge, "business_shaping") && task.task_type === DRAFT_SHAPE_TASK_TYPE && task.project_id) {
      const parsed = parseJsonOutput(text) as Record<string, unknown> | null;
      const sells = String(parsed?.sells ?? "").trim();
      await spawnLearningResearch({ task, sells }).catch((e) =>
        console.error("[mycel] could not start the trade research:", e),
      );
    }

    if (wedgeHasRole(task.wedge, "business_shaping") && task.task_type === DRAFT_SERVICE_TASK_TYPE && task.project_id) {
      const described = typeof task.input?.description === "string" ? task.input.description : "";
      const parsed = parseJsonOutput(text) as Record<string, unknown> | null;
      const manifestTitle = (parsed?.manifest as Record<string, unknown> | undefined)?.title;
      const nameHint =
        (typeof parsed?.slug === "string" && parsed.slug) ||
        (typeof manifestTitle === "string" && manifestTitle) ||
        described;
      /**
       * THE TRADE'S ARITHMETIC, TAKEN FROM THE RESEARCH AND NOT FROM THE DRAFT.
       *
       * `withDraftServiceArsenal` put the `research_service` findings into this run's input, and the
       * identities among them become gates the finished work must pass. They are read back off the
       * INPUT rather than out of `parsed`, deliberately: a drafting run that restated the identities
       * it liked and quietly dropped the one it found awkward would produce gates exactly as
       * optimistic as the service they are meant to hold. What the research found is not the
       * drafter's to edit.
       */
      const research = (task.input as { research?: { identities?: unknown } } | undefined)?.research;
      const identities = Array.isArray(research?.identities)
        ? (research.identities as TradeIdentity[])
        : [];
      // Never gateable, always worth telling the run — see `mechanicsAsSkill`.
      const mechanics = Array.isArray((research as { mechanics?: unknown } | undefined)?.mechanics)
        ? ((research as { mechanics: TradeMechanic[] }).mechanics)
        : [];
      const authored = authorWedgeFromOutput(parsed, { slugBase: nameHint, identities, mechanics });
      /**
       * ═══ NOT A SECOND COPY OF A SERVICE THEY ALREADY HAVE ═══
       *
       * `coherentWedge` guards the first decision well: a specialist is refused unless the founder's
       * own words overlap the trade, and `fit: none` is what starts this run. Nothing guards the
       * SECOND one. A founder who describes their business again — a slightly different sentence, a
       * month later, a second attempt after skipping the review — gets another service written, and
       * ends up with two that do the same job.
       *
       * That is not a work collision: a case names one service, so nothing runs twice. It is worse in
       * a quieter way. They now choose between two things they cannot tell apart, every time they
       * start a job, forever, and neither accumulates a track record.
       *
       * Matched on the TITLE reduced to its words, not the slug. `authorWedgeFromOutput` already
       * makes slugs unique — that is what stops the write failing and exactly why it does not stop
       * the duplicate. "Monthly bookkeeping" and "Bookkeeping, monthly" are the same service and get
       * different slugs.
       */
      if (authored.draft && task.project_id) {
        const words = (t: string): string =>
          [...new Set(t.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2))]
            .sort()
            .join(" ");
        const mine = words(authored.draft.manifest.title ?? authored.draft.slug);
        const existing = await getAuthoredStore()
          .listAuthored({ project_id: task.project_id, limit: 50 })
          .catch(() => []);
        const twin = existing.find((r) => words(r.title) === mine);
        if (twin) {
          await emit("service.draft_refused", {
            reasons: [`this business already has a service called "${twin.title}"`],
            summary:
              `We started writing a service and stopped: you already have one called "${twin.title}" ` +
              `that does this. Open that one instead — a second copy would mean choosing between two ` +
              `things you cannot tell apart every time you start a job.`,
          });
          // NOT `return`. Everything below still has to happen — the run's files are collected and
          // the task is marked succeeded down there, and returning here would leave it `running` for
          // ever. The run did its job; we are declining to install a second copy of the answer.
          authored.draft = undefined;
        }
      }
      if (authored.draft) {
        const saved = await getAuthoredStore().createDraft({
          project_id: task.project_id,
          slug: authored.draft.slug,
          title: authored.draft.manifest.title ?? authored.draft.slug,
          manifest: authored.draft.manifest,
          skills: authored.draft.skills,
          knowledge: authored.draft.knowledge,
          described_as: described,
          // See `AuthoredWedge.notices`. Written here because it cannot be recovered later: the
          // repaired manifest no longer contains what was stripped out of it.
          notices: authored.notices.map((n) => n.message),
          source_task_id: task.id,
        });
        await emit("service.drafted", { slug: saved.slug, title: saved.title, status: saved.status });
      } else if (authored.faults.length) {
        // `faults.length` guards the twin case: `draft` is cleared above with no faults, and the
        // refusal was already emitted there with a reason a founder can act on. Without this, they
        // would get a second, emptier refusal saying nothing.
        await emit("service.draft_refused", {
          reasons: authored.faults.map((f) => f.message),
          summary: faultSentence(authored.faults),
        });
      }
    }

    /**
     * ═══ COLLECT THE WORK THE RUN WROTE, NOT JUST ITS ANSWER ═══
     *
     * `artifacts` asks a deliverable to carry the work, and a run under that contract does write it:
     * a real close produced `september-2026-ledger.json` and a VAT return in `output/`. Nothing
     * collected them. Only `result.txt` was ever uploaded, the sandbox was destroyed, and the files
     * the client was buying went with it — while the deliverable card said "September ledger",
     * because the agent had honestly declared one.
     *
     * That is the worst shape available: the contract satisfied, the check for phantom files
     * satisfied (they existed), and the client still receives nothing.
     *
     * So every file the run declared is pulled out before the box dies. Declared rather than
     * globbed, deliberately — `output/` also collects scratch files, and shipping whatever happens
     * to be in a directory is how a client receives a debug dump. The agent names what it produced;
     * we fetch exactly that.
     */
    for (const named of declaredArtifactPaths(text)) {
      if (!sandbox) break;
      const body = await sandbox.readFile(`output/${named.path}`).catch(() => null);
      // A path with no file behind it is the phantom case, already reported by `decideFate`. Nothing
      // to collect and nothing to say twice.
      if (body === null || body === undefined) continue;
      const extra = await store.addArtifact({
        task_id: taskId,
        name: named.path,
        content_type: named.path.endsWith(".json")
          ? "application/json"
          : named.path.endsWith(".csv")
            ? "text/csv"
            : "text/plain",
        content: (await getArtifactBackend()).inline ? body : "",
        size_bytes: Buffer.byteLength(body, "utf8"),
      }).catch(() => null);
      if (!extra) continue;
      const be = await getArtifactBackend();
      if (!be.inline) await be.put(extra.id, body);
      await emit("artifact.created", {
        artifact_id: extra.id,
        name: extra.name,
        content_type: extra.content_type,
        size_bytes: extra.size_bytes,
      });
    }

    const backend = await getArtifactBackend();
    const art = await store.addArtifact({
      task_id: taskId,
      name: "result.txt",
      content_type: "text/plain",
      content: backend.inline ? text : "",
      // Recorded even when the bytes go elsewhere, because it is the ONLY thing that distinguishes
      // "this artifact is empty" from "this artifact's bytes are somewhere this process cannot
      // read". Production served the second as the first: the shape went to S3, the API was still
      // configured inline, and onboarding told the founder his draft came back empty.
      size_bytes: Buffer.byteLength(text, "utf8"),
    });
    if (!backend.inline) await backend.put(art.id, text);
    await emit("artifact.created", {
      artifact_id: art.id,
      name: art.name,
      content_type: art.content_type,
      url: `/v1/artifacts/${art.id}`,
    });
    // ── The deliverable that is a DIRECTORY, not a paragraph ────────────────────────────────
    //
    // Everything above persists `result.txt` and would then destroy the sandbox in `finally`. For a
    // wedge whose output is a sentence that is complete; for the `build` shape, whose entire purpose
    // is to construct a Next.js application, it meant the run did the work, wrote the files, and the
    // files were deleted seconds later. `workspace.ts` has existed to fix that and was never called
    // from anywhere — imported at the top of this file and dead, so `product-builder` has never
    // produced anything a customer could receive.
    //
    // Additive by construction: `resolveWorkspace` returns null for every wedge that declares no
    // `workspace` block, which is all of them today, and such a run is byte-for-byte unchanged.
    let hostedAt: string | undefined;
    if (ws && sandbox) {
      /**
       * ═══ VERIFY FAILURE IS FEEDBACK, NOT A VERDICT — until the repair budget is spent ═══
       *
       * The styled-verify guard did its job the day it landed: prod run 2026-08-16 16:30 correctly
       * FAILED a build whose stylesheet was 1.5KB of raw CSS. But the run ended there — half an
       * hour of build, killed by a fixable fault, with the exact compiler/verify output in hand and
       * nobody to hand it to. That is the worst of both worlds: the guard without the mechanic.
       *
       * This is the bounded reflection loop every serious harness runs (Aider caps at 3; SWE-agent's
       * lint gate exists for the same reason): feed the ACTUAL verify output — not a critique, the
       * real failing command and its tail — back to the agent in the SAME sandbox, and re-verify.
       * The session from the main run is gone (aborted on contract satisfaction), but the sandbox
       * and the workspace are alive until `finally`, so the repair is a fresh, narrow session over
       * the same files. Two rounds, then the failure stands: a build that cannot fix itself twice
       * is failed honestly, exactly as before — this loop can only turn a failure into a verified
       * success, never ship anything the verify did not pass.
       */
      const MAX_REPAIR_ROUNDS = 2;
      for (let round = 0; ; round++) {
        try {
          hostedAt = await handOffWorkspace({ store, task, ws, sandbox, backend, emit });
          break;
        } catch (e) {
          const msg = (e as Error)?.message ?? "";
          const repairable = msg.startsWith("workspace verification failed");
          if (useMock || !repairable || round >= MAX_REPAIR_ROUNDS) throw e;
          await emit("progress", {
            note: `verification failed — repair round ${round + 1} of ${MAX_REPAIR_ROUNDS}: handing the verify output back to the agent`,
          });
          await runOpenCodeTask(
            {
              ...task,
              input: {
                ...task.input,
                repair_round: round + 1,
                repair_feedback:
                  `Your previous session already built the application in ~/app — do NOT start over ` +
                  `and do NOT scaffold anything new. The kernel's verification of that workspace ` +
                  `failed; your ONLY job now is to fix the fault below and stop.\n${msg.slice(0, 4000)}`,
              },
            },
            sandbox,
            ctx,
          );
        }
      }
    }

    /**
     * ═══ DID THE RUN DO WHAT IT SAID IT WOULD? ═══
     *
     * The last thing before `succeeded`, and deliberately AFTER `result.txt` is persisted: a run
     * that drafted a good chase and then failed to ask about sending it has still produced writing
     * the founder should be able to read, and failing before the artifact exists would destroy the
     * one piece of evidence that explains the failure.
     *
     * See promises.ts for the production run this exists because of — it reported success, created
     * no approval, sent nothing, and removed the invoice from the ranked list on its way out.
     *
     * `loadProjectWedge` (not `loadWedge`) so an authored, project-local service is held to its own
     * declaration exactly as a shipped one is.
     */
    const loadedSpec = (await loadProjectWedge(task.project_id ?? "", task.wedge))?.manifest.task_types?.[
      task.task_type
    ] as (Record<string, unknown> & { promises?: unknown }) | undefined;
    const promised = readPromises(loadedSpec?.promises);
    const kept = assertSendPromiseKept({ promised, output: text, events: await store.eventsAfter(taskId, 0) });
    if (kept.kept) await emit("progress", { note: kept.note });

    // A fulfillment run that produced bytes but no Deliverable is work the client cannot accept
    // and the founder cannot invoice. Mock runs are skipped: `[mock]` is not a delivery.
    // `let`, because a successful ship-contract repair replaces it — delivering the held answer
    // after fixing it would be the worst of both.
    /**
     * ═══ A HARNESS TICK IS NOT A DELIVERABLE, AND WAS BEING JUDGED AS ONE ═══
     *
     * `gtm_autonomous` ran and the founder's timeline said: "not delivered — the run's output is
     * machine text with no client-facing summary — held from the portal." It is a five-minute
     * outreach tick. There is no client, no portal, nothing to deliver, and its own description says
     * "harness work, not agent work".
     *
     * `compile()` has read `task_types.<type>.internal` since it was added — that is what stops the
     * ship bar and the craft rules being applied to machinery. `decideFate` never learned about it,
     * so every tick still went through the full client-facing verdict and emitted a "not delivered"
     * line. Four GTM task types run on timers; that is a founder's timeline filling with a failure
     * report about work that succeeded.
     *
     * The flag is read HERE rather than only fixed in the manifests, because a wedge that forgets it
     * gets the same wrong behaviour, and the manifests forgot it four times out of four.
     */
    const internalStep = !!(loadedSpec as { internal?: boolean } | undefined)?.internal;

    let parsedOut = parseJsonOutput(text, task.output_schema) as Record<string, unknown> | null;
    // `./output/` is our instruction to the agent, not a place the client has. See
    // `artifactPathForClient` — a declared path that does not match the delivered filename reads to a
    // client as a file that was never sent.
    normaliseArtifactPaths(parsedOut);

    /**
     * WHAT THE RESEARCH FOUND, KEPT FOR THE DRAFT THAT COMES AFTER IT.
     *
     * `research_service` is the `operate`-shape job that leaves the building — the only one in the
     * shaping wedge with a browser. `draft_service` runs on `decide`, which has no network at all,
     * so without this the meta-agent writes somebody's business entirely from the model's priors and
     * the one line they typed.
     *
     * Kept on the record store rather than passed along, because the two are separate runs minutes
     * or hours apart. `keepServiceResearch` drops a run that did not reach anything: storing a
     * `reached: false` would tell the next reader there was nothing out there, which is a far
     * stronger claim than "we could not look".
     */
    if (task.task_type === RESEARCH_SERVICE_TASK_TYPE && task.project_id) {
      await keepServiceResearch(getDomainStore(), { project_id: task.project_id, output: parsedOut }).catch((e) =>
        console.error("[mycel] could not keep the service research:", e),
      );
      /**
       * AND THEN WRITE THE THING. The research is the first half of one action a founder took.
       *
       * Chained here rather than in the console, because the card tells them "you can leave this
       * page — it carries on without you" and that has to stay true. A follow-on driven by a poller
       * in a browser tab means a founder who closes it gets a research run and no service, which is
       * the worst of both: the fifteen minutes spent and nothing to show.
       *
       * Fails soft and loudly. A draft that was not queued is recoverable — the founder presses the
       * button again — but only if somebody can see it happened.
       */
      await spawnDraftAfterResearch({ task }).catch((e) =>
        console.error("[mycel] could not start the draft after research:", e),
      );
    }

    /**
     * WHETHER WE COULD REACH THE SURFACE AT ALL, which nothing was keeping.
     *
     * The same seam, the opposite rule: `keepServiceResearch` above drops a run that reached nothing,
     * and this keeps exactly those. The two records are for different things. That one stores what
     * was learned about a market, and a failed look teaches nothing about a market. This one stores
     * what was learned about the SURFACE, and a failed look is the whole lesson.
     *
     * Without it the eighth blocked probe of the week cost the same thirty seconds as the first and
     * the founder was never told why their report had a hole in it — which they find out about in
     * the client meeting, which is the worst available moment.
     */
    if (task.task_type === PROBE_TASK_TYPE && task.project_id) {
      await noteProbe(getDomainStore(), { project_id: task.project_id, output: parsedOut }).catch((e) =>
        console.error("[mycel] could not record surface health:", e),
      );
    }

    if (!useMock && !internalStep) {
      try {
        // The client never sees the internal schema fields. When the wedge's output carries a
        // first-class `client_summary` (the report wedges — books-keeper monthly_close,
        // contract-desk weekly_run, geo-monitor weekly_report — require it), that plain-language
        // field IS the deliverable body: it is what the founder chose to hand over, and rendering
        // the raw JSON of reconciliation notes / sweep fields instead is the exact "jargon, not
        // client-ready" failure this closes. Falls back to the full text when absent.
        const clientSummary =
          typeof parsedOut?.client_summary === "string" && parsedOut.client_summary.trim()
            ? parsedOut.client_summary.trim()
            : undefined;

        /**
         * `?? text` USED TO BE THE FALLBACK HERE, and it was the whole defect.
         *
         * Every deliverable in production on the day this changed was a refusal that had taken that
         * fallback: clients' portals showed `{"query":"...","surface":"unavailable","cited":[]}` and
         * "Retry the weekly run after the probe and measurement endpoints are available". A fallback
         * that can leak machine text is not a fallback, it is a default — and it defaulted to the
         * one thing a customer must never see.
         *
         * `decideFate` returns one of three, and only `deliver` produces a deliverable. `ask` means
         * the run stopped for material only the client has, which becomes a REQUEST they can answer
         * in the portal — and `materialsForTask` above then carries what they send into the next
         * run's `./inputs/`, closing the loop. `hold` leaves the work on the task where the founder
         * can see it and the client cannot.
         */
        // The wedge's own ship bar rides in from the manifest. The kernel checks substance; the
        // wedge says which fields constitute the work. See `missingSubstance` for the rule.
        // DECLARED ∪ INFERRED. This read the manifest alone, and 31 of the 49 client-facing task
        // types in this repo declare no `ship_checks` — so most fulfillment prose was graded against
        // nothing at all. `effectiveShipContract` fills the silence from the output schema's shape
        // and leaves every declared bar exactly as its author wrote it. Same function `runtime` uses
        // to SHOW the agent the contract, so the two lists cannot drift apart.
        const { ship_requires: shipRequires, ship_checks: shipChecks } = effectiveShipContract(loadedSpec);
        let fate = decideFate({ text, clientSummary, parsed: parsedOut, shipRequires, shipChecks, capabilityGaps, missingArtifacts, brokenArtifacts });

        /**
         * ═══ A NEAR-MISS IS NOT A HOLD ═══
         *
         * `ship_checks` graded every run and nothing handed the verdict back. A monthly close whose
         * summary was fourteen words was held — correctly — and the fix was one sentence the agent
         * that wrote it could have produced in a turn. Instead it cost the founder an afternoon, and
         * the agent learned nothing, because it never saw the rule. (It sees the rule up front now
         * too; see `describeShipContract`. This is the other half: the rule at the moment it was
         * broken, which is the only feedback that has ever taught anything.)
         *
         * The same shape as the workspace repair loop above, and the same three guarantees. It can
         * only ever turn a HOLD into a delivery: the checks are re-run on whatever comes back, the
         * work still stops at review if they fail again, and a run with nothing to repair pays
         * nothing for this block existing.
         *
         * ONE ROUND, where the workspace loop gets two. A build repair reads a compiler error and
         * fixes a file; this is prose that missed a bar it can now see, which either lands next turn
         * or is a run that does not understand the job. A second round on that is minutes of model
         * time spent producing a differently-wrong summary.
         *
         * ONLY for `ship_checks` faults. `fate.faults` is set nowhere else on purpose — a hold
         * because the client has to answer a question is not repairable by trying harder, and
         * looping on one would be the agent inventing an answer on the client's behalf, which is the
         * single worst thing this product could do.
         */
        const MAX_SHIP_REPAIR = 1;
        for (let round = 0; fate.faults?.length && round < MAX_SHIP_REPAIR && !useMock; round++) {
          await emit("progress", {
            note: `held on the output contract — asking it to fix ${fate.faults.length} thing${fate.faults.length === 1 ? "" : "s"} and answer again`,
          });
          // `sandbox` is optional on this path (a mock run has none), and the loop is already
          // guarded on `!useMock` — but the type does not know that, and asserting it would be the
          // one place in this block where a wrong assumption becomes a crash rather than a hold.
          if (!sandbox) break;
          const again = await runOpenCodeTask(
            {
              ...task,
              input: {
                ...task.input,
                repair_round: round + 1,
                repair_feedback:
                  `Your previous answer was complete and was HELD before it reached the client, ` +
                  `because it failed the output contract you were given. Do not start the job again ` +
                  `and do not change anything that was not named below — fix these and return the ` +
                  `whole result:\n${fate.faults.map((f) => `  - ${f}`).join("\n")}`,
              },
            },
            sandbox,
            ctx,
          ).catch(() => undefined);
          // A repair that produced nothing usable leaves the original verdict standing, which is the
          // gated direction: the founder still gets the work and the reason it was held.
          if (!again?.text?.trim()) break;

          // Re-validated against the SAME schema the first answer was. A repair that fixes a word
          // count by returning prose instead of JSON is not a repair, and accepting it here would
          // walk past the one gate that never lets an unvalidated answer through.
          const rv = validateOutput(again.text, schema);
          if (!rv.ok) break;
          // With the schema, exactly like the first parse. Without it the repair round would judge
          // a `profit-and-loss` that the first round would have accepted — the drift this fix exists
          // to close, reintroduced one branch away from itself.
          const reparsed = parseJsonOutput(again.text, schema) as Record<string, unknown> | null;
          normaliseArtifactPaths(reparsed);
          const nextSummary =
            typeof reparsed?.client_summary === "string" && reparsed.client_summary.trim()
              ? reparsed.client_summary.trim()
              : clientSummary;
          const next = decideFate({
            text: again.text,
            clientSummary: nextSummary,
            parsed: reparsed,
            shipRequires,
            shipChecks,
            // The repair run's own gaps, not the first run's: the loop re-runs the task, and a
            // connection the founder added in between would otherwise be invisible until the next
            // task. Same reason the checks are re-run on whatever comes back rather than assumed.
            capabilityGaps: again.capabilityGaps,
            // The repair run's own artifacts, not the first run's — the point of the round is that
            // it writes the files it forgot.
            missingArtifacts: again.missingArtifacts,
            // The repair round's own files, for the same reason: the point of the round is that it
            // rewrites the one it wrote wrong.
            brokenArtifacts: again.brokenArtifacts,
          });
          if (!next.faults?.length) {
            await emit("progress", { note: "fixed — the second answer clears the contract" });
            text = again.text;
            parsedOut = reparsed;
            fate = next;
            break;
          }
          fate = next;
        }

        if (fate.fate !== "deliver") {
          await emit("progress", { note: `not delivered — ${fate.reason}` });
          if (fate.fate === "ask") await openMaterialRequests(task, fate.needs ?? []);
        } else if (fate.needs?.length) {
          /**
           * DELIVERED, AND STILL ASKING.
           *
           * A monthly close that balances and needs three transactions classified is finished work
           * with an attached ask — which is what a real bookkeeper sends. `client-ready.ts` used to
           * fold `questions` in with `needs`, so every such close returned `ask`, no deliverable was
           * ever created, the client never saw the work and the founder could not invoice it.
           *
           * Separating them fixed that and would have introduced something worse on its own: the
           * client receiving a close and never being told three items are unclassified. So the same
           * requests an `ask` would have opened are opened here too, ALONGSIDE the deliverable
           * rather than instead of it.
           */
          await openMaterialRequests(task, fate.needs);
        }
        // A cream stub with two paragraphs is not GEO fulfillment. Hosting it would be the
        // product lying. The page run still succeeded; the founder sees the HTML on the task.
        const pageHtml = typeof parsedOut?.html === "string" ? parsedOut.html : "";
        const pageFaults =
          fate.fate === "deliver" && task.task_type === "ship_page" && pageHtml
            ? shippedPageFaults(pageHtml)
            : [];
        if (pageFaults.length) {
          await emit("progress", {
            note: `not delivered — this is not a page a client would publish (${pageFaults[0]})`,
          });
        }
        const clientBody = fate.body ?? "";
        const wrapped =
          fate.fate !== "deliver" || pageFaults.length
            ? undefined
            : await wrapFulfillmentDeliverable({
          task,
          artifactId: art.id,
          // The covering note the client reads. Was `.slice(0, 2_000)`, which cut one mid-word and
          // reached a client ending "…and if business". See `clipToBoundary`; 4,000 is what the
          // version store itself accepts, so the tighter cap here was a second cliff for no reason.
          summary: clipToBoundary(clientBody, 4_000),
          content: clientBody,
          // `deliver` and then silence was the worst outcome this path could produce — see the
          // `onSkip` note in deliverables.wrap.ts. The founder gets the reason on the timeline.
          onSkip: async (reason) => {
            await emit("progress", { note: `not delivered — ${reason}` });
          },
          /**
           * The independent read, injected on the path that actually delivers. Same function the
           * submit route uses — see review-version.ts for why it had to stop being a private helper
           * inside a route file.
           */
          review: async (a) =>
            await reviewVersion({
              store,
              projectId: task.project_id ?? "",
              artifactIds: a.artifactIds,
              kind: a.kind,
              summary: a.summary,
            }),
          /**
           * ═══════════════════════════════════════════════════════════════════════════════════════
           * THE RUN GETS THE REVIEWER'S SENTENCE BACK, ONCE
           * ═══════════════════════════════════════════════════════════════════════════════════════
           *
           * `review` above already reads the finished bytes and names disqualifying faults. Until
           * now nothing could act on what it found: the run was over, and the only outcome was a
           * hold — a founder opening a job that needs rewriting, with the rewrite note already
           * written by a machine that could not do anything with it.
           *
           * The sandbox is still alive here. It is destroyed in `finally`, hundreds of lines below,
           * so the box this run has already paid for can be used to fix what the reader found.
           *
           * Same shape as the schema retry above, deliberately: one round, in the same sandbox,
           * carrying the reviewer's OWN words rather than "try again". The wrap decides whether the
           * result was actually an improvement — see its note on keeping a repair only if it has
           * fewer disqualifying faults.
           *
           * `useMock` skips it: canned output is not a rewrite and would make every mock test pay
           * for a second pass that cannot change anything.
           */
          repair: async ({ faults, headline }) => {
            if (useMock || !sandbox) return undefined;
            const before = new Set((await store.listArtifacts(task.id)).map((a) => a.id));
            const out = await runOpenCodeTask(
              {
                ...task,
                input: {
                  ...task.input,
                  review_retry: true,
                  repair_feedback:
                    `An independent reader checked the work you just produced and found ` +
                    `${faults.length} disqualifying ${faults.length === 1 ? "problem" : "problems"}` +
                    `${headline ? ` — ${headline}` : ""}: ${faults.join("; ").slice(0, 1200)}. ` +
                    `Fix exactly those and write the corrected deliverable out again. Do not start ` +
                    `the job over, and do not argue with the reader.`,
                },
              },
              sandbox,
              ctx,
            ).catch(() => undefined);
            if (!out) return undefined;
            /**
             * The artefacts the REPAIR wrote, not everything on the task. A repair that produced
             * nothing new must return nothing rather than re-offering the same bytes and inviting
             * the wrap to re-grade work that did not change.
             */
            const after = (await store.listArtifacts(task.id)).filter((a) => !before.has(a.id) && a.name !== "result.txt");
            return after.length ? after.map((a) => a.id) : undefined;
          },
          pageHtml: typeof parsedOut?.html === "string" ? parsedOut.html : undefined,
          pageSlug: typeof parsedOut?.slug === "string" ? parsedOut.slug : undefined,
          pageUrl: hostedAt,
          title: typeof parsedOut?.page_title === "string" ? parsedOut.page_title.trim() : undefined,
          /**
           * Host authored HTML at an unlisted public URL. A `link` deliverable without this is
           * not a delivery — wrap refuses rather than falling back to an iframe of a file.
           */
          publishPage: async ({ html, title }) => {
            const page = await publishPage({
              project_id: task.project_id ?? "",
              html,
              title,
            });
            if (!page) return undefined;
            return { url: publishedPageUrl(page.token) };
          },
          // For a `file_set`: the files the run authored, minus its own `result.txt`.
          listArtifacts: (id) => store.listArtifacts(id),
          // A decide-shaped run has no workspace. The page lives in `html` until we write it here.
          writePage: async ({ task: t, name, html }) => {
            const page = await store.addArtifact({
              task_id: t.id,
              name,
              content_type: "text/html; charset=utf-8",
              content: backend.inline ? html : "",
              size_bytes: Buffer.byteLength(html, "utf8"),
              source: "agent",
              client_id: t.client_id,
            });
            if (!backend.inline) await backend.put(page.id, html);
            await emit("artifact.created", {
              artifact_id: page.id,
              name: page.name,
              content_type: page.content_type,
              url: `/v1/artifacts/${page.id}`,
            });
            return page.id;
          },
          /**
           * The track record decides. Reads the pairing's history, applies the policy, and answers
           * a boolean — every failure inside it ends in `false`, which is the gated direction and
           * the behaviour that was already correct before this existed.
           */
          autoRelease: async (a) => {
            /**
             * `databaseUrl()`, and the `?? ""` it replaces was not a harmless default.
             *
             * `DATABASE_URL` is never set for the kernel or the worker (`infra/services.tf` sets
             * `MYCEL_DATABASE_URL`), so in production this was `getPool("")` — a pool with an empty
             * connection string, which node-postgres resolves from PGHOST/PGUSER/libpq defaults and
             * which connects to nothing here. `readRecord` therefore threw on every call, and the
             * catch below turned that into `false`.
             *
             * `false` is the GATED direction, so nothing unsafe happened and nothing failed loudly:
             * auto-release simply never fired. Production has 0 rows with `auto_released = true`,
             * which is what a feature that cannot read its own track record looks like from outside.
             */
            const pool = getPool(databaseUrl() ?? "");
            const rec = await readRecord(pool, a);
            const d = mayAutoRelease({
              record: rec,
              // `queryRecords` off the domain store, which carries the fail-closed tenant filter.
              // Async now: the policy is a project SETTING rather than an environment variable, so
              // a founder can turn this on without a deploy. See release-policy.ts.
              policy: await releasePolicyFor(a.project_id, { queryRecords: getDomainStore().queryRecords.bind(getDomainStore()) }),
              clientReady: true,
            });
            if (d.release === "auto") await emit("progress", { note: `release — ${explain(d)}` });
            return d.release === "auto";
          },
          release: async ({ deliverable_id, version }) => {
            const at = new Date().toISOString();
            const ds = getDeliverableStore();
            await ds.releaseVersion(task.project_id!, deliverable_id, version, at);
            await ds.transitionDeliverable(task.project_id!, deliverable_id, "with_client", ["in_review"], at);
            await markAutoReleased(getPool(databaseUrl() ?? ""), deliverable_id);
            await emit("progress", { note: "sent to the client without review — it is on your desk now" });
          },
          // Render the run's markdown into a branded PDF for a `document` deliverable. Same
          // server-side pipeline as `attachInvoiceDocument`: resolve the project's kit (fails closed
          // on an unknown project, so nothing renders under house branding), render, attach through
          // the same artifact backend. Returns undefined on any miss, and the wrapper keeps the text.
          renderDocument: async ({ task: t, content, title }) => {
            const projectId = t.project_id;
            if (!projectId) return undefined;
            const kit = getIdentityStore().brandKit(projectId);
            if (!kit) return undefined;
            /**
             * The wedge's declared chart, from the output that was already checked.
             *
             * Placed after the opening paragraph rather than appended: the covering note ends with
             * the questions the client has to answer, and a picture after those is a picture nobody
             * scrolls back up from. `chartBlock` returns undefined for a wedge that declares none,
             * for a path that resolves to nothing, and for a series with no usable rows — a report
             * without a picture is a report.
             */
            const blocks = insertChart(
              blocksFromMarkdown(content),
              // The run's INPUT is the second place to look for the currency: `monthly_close` takes
              // it at the door and does not require the model to echo it back, and a chart is not
              // allowed to be the only thing on the page that guessed at somebody's money.
              chartBlock((loadedSpec as { chart?: Parameters<typeof chartBlock>[0] } | undefined)?.chart, parsedOut, t.input),
            );
            /**
             * THE HEADLINE FIGURES, ABOVE THE PROSE.
             *
             * Straight after the opening paragraph and before everything else, because a client who
             * opens a close pack is looking for two numbers, and reading nine lines of covering note
             * to find them is the complaint this document was rebuilt to answer. Found on a real
             * run: the card grid `report.ts` grew for figures had never once fired, because
             * `blocksFromMarkdown` only makes one out of `Key: value` lines and a model writing a
             * covering note writes prose.
             *
             * Declared by the wedge and read off the output that already passed `ship_checks`, so
             * no figure is retyped — retyping is what every arithmetic gate here exists to prevent.
             */
            const figures = figuresBlock(
              (loadedSpec as { figures?: Parameters<typeof figuresBlock>[0] } | undefined)?.figures,
              parsedOut,
              t.input,
            );
            if (figures) {
              const afterLede = blocks.findIndex((b) => b.kind === "paragraph");
              /**
               * WITH A HEADING, because on the deck path this panel becomes an entire slide and
               * `slidesFromBlocks` titles a stats slide from the heading in front of it.
               *
               * FOUND BY READING A REAL DECK: three cards reading 25% / 3 / 12 floated in the middle
               * of an otherwise empty slide under a rule with nothing on it. The numbers were right
               * and the slide did not say what they measured, which is the one thing a client
               * forwarding it to their board needs it to say.
               *
               * "The numbers" and not a wedge-declared string: every deliverable that declares
               * figures wants the same plain label here, and a field nobody varies is a field that
               * gets filled in wrong once.
               */
              blocks.splice(afterLede < 0 ? 0 : afterLede + 1, 0, { kind: "heading", text: "The numbers", level: 2 }, figures);
            }
            /**
             * ═══ A DECK, WHEN THE WEDGE SAYS THIS DELIVERABLE IS ONE ═══
             *
             * `"deck": true` on the task type, declared the same way `chart` is and read the same
             * way. The model's job does not change: it writes the markdown it already writes, the
             * declared chart is spliced in from the output that was already checked, and
             * `slidesFromBlocks` turns the result into slides.
             *
             * Which is the whole argument for having put the design system in `design.ts` rather
             * than in `report.ts`. A GEO week is three numbers, a chart of who is beating you and
             * three sized recommendations — a client forwards that to their board, and a client does
             * not forward an A4 page of 10pt text.
             */
            const asDeck = !!(loadedSpec as { deck?: boolean } | undefined)?.deck;
            const doc = asDeck
              ? render("deck", { title, footer: kit.display_name, slides: slidesFromBlocks(blocks, { title }, kit) }, kit)
              : render("report", { title, blocks }, kit);
            /**
             * ═══ THE LAYOUT LINT THAT RAN ON EVERY DOCUMENT AND WAS READ BY NOBODY ═══
             *
             * `render()` attaches `doc.taste` to every document it produces, and `taste.ts` says of
             * the blocking subset: "text off the page, text on text, a page that is one line".
             * `render/index.ts` documents the consequence — "the delivery path holds the task when
             * one of them is `isBlocking`" — and the delivery path is THIS, and it never looked.
             * Outside tests, `isBlocking` had no caller at all.
             *
             * So a client could be sent a PDF with a heading printed past the right margin, and the
             * kernel measured it, wrote it down, and attached it to an object nothing read.
             *
             * Surfaced, not blocked. A blocking finding is a fact about geometry the model cannot
             * fix by rewriting markdown in the same run — the render is deterministic from the
             * blocks — so refusing here would fail the run with no path forward, which is the
             * "gate with no door" this repo has already built once. On the feed it reaches the
             * founder before the client, which is the outcome that was actually missing.
             */
            const layoutFaults = tasteBlockers(doc);
            if (layoutFaults.length) {
              await emit("progress", {
                note:
                  `${doc.name} has ${layoutFaults.length} layout fault(s) a reader would see: ` +
                  layoutFaults.slice(0, 4).map((f) => f.rule).join(", "),
              });
            }
            const pdf = await store.addArtifact({
              task_id: t.id,
              name: doc.name,
              content_type: doc.content_type,
              content: backend.inline ? doc.content : "",
              encoding: doc.encoding,
              size_bytes: doc.size_bytes,
              source: "agent",
              client_id: t.client_id,
            });
            if (!backend.inline) await backend.put(pdf.id, doc.content);

            /**
             * ═════════════════════════════════════════════════════════════════════════════════════
             * THE SOURCE THE PDF WAS RENDERED FROM, KEPT — SO THE FOUNDER CAN CHANGE IT
             * ═════════════════════════════════════════════════════════════════════════════════════
             *
             * MEASURED: five of the ten deliverable versions in production carry a PDF and NOTHING
             * ELSE. A PDF is a rendering — positioned glyphs — so `editableFormat` refuses it, and
             * refusing is right: we cannot rewrite one without reflowing a document whose source we
             * do not hold.
             *
             * Except we DO hold it, for one statement, and then drop it on the floor. `content` is
             * the markdown the run wrote; `blocksFromMarkdown(content)` is the first thing this
             * function does with it. So the deliverable a founder was least able to fix was the one
             * where the fixable original existed and was never written down.
             *
             * Saved as a sibling artifact on the same run. The founder edits the markdown with the
             * ordinary block editor — the same one validated byte-identical against 399 real client
             * documents — and `renderedFrom` tells the edit route to re-render this PDF from their
             * version. No new editor, no PDF surgery, and the client keeps receiving a PDF.
             *
             * ═══ WHY IT IS NOT ON THE DELIVERABLE ═══
             *
             * `attachDeliverable` decides what the client receives, and the client should receive
             * the PDF, not the PDF plus its own source. This is attached to the RUN, which is where
             * the founder-plane inspector already looks for a version's files — so it is reachable
             * where the correction happens and absent from what goes out.
             */
            const sourceName = doc.name.replace(/\.pdf$/i, "") + ".md";
            const source = await store.addArtifact({
              task_id: t.id,
              name: sourceName,
              /**
               * `profile=deck` records HOW this was rendered, so the re-render matches.
               *
               * A media-type parameter rather than a new column: it rides on a field every reader
               * already carries, and `editableFormat` still sees "markdown" because it tests for the
               * substring. Without it a founder correcting a slide deck would get a report back —
               * same words, completely different document, and no warning.
               */
              content_type: asDeck ? "text/markdown; profile=deck" : "text/markdown",
              content: backend.inline ? content : "",
              encoding: "utf8",
              size_bytes: Buffer.byteLength(content, "utf8"),
              source: "agent",
              client_id: t.client_id,
              // The link, in the direction the edit route reads it: "changing me should re-render
              // that". Stored on the SOURCE because that is the artifact a founder opens.
              renders_to: pdf.id,
            });
            if (!backend.inline) await backend.put(source.id, content);
            await emit("artifact.created", {
              artifact_id: pdf.id,
              name: pdf.name,
              content_type: pdf.content_type,
              url: `/v1/artifacts/${pdf.id}`,
            });
            return pdf.id;
          },
        });
        /**
         * ═══ A PROPOSAL BECOMES A SIGNABLE ENVELOPE ═══
         *
         * `"signs": true` on the task type, declared and read exactly the way `deck`, `chart` and
         * `figures` are. When it is set and the output carries a `proposal`, the structured
         * proposal is RENDERED (not the model's prose — see the header of render/proposal.ts) and
         * an envelope is opened over the resulting PDF.
         *
         * ── IT IS OPENED AS A DRAFT, AND THAT IS THE WHOLE POINT ──
         *
         * `createEnvelope` leaves it in `draft`, which is invisible to the client and unsignable by
         * anyone. Sending it is a separate act the founder takes after reading it. A run that could
         * put a contract in front of a customer on its own would be the one place in this product
         * where a machine reaches a client unattended, and the approval gate exists precisely so
         * that is never true.
         *
         * ── AND IT FAILS SOFT ──
         *
         * A run that produced a good proposal and could not open the envelope has still produced a
         * good proposal; the founder can send it by hand. Throwing here would turn a paperwork
         * problem into a failed task and lose the work.
         *
         * ═══ IT IS NOT GATED ON `wrapped`, AND IT USED TO BE ═══
         *
         * `if (wrapped && …signs)` made the whole signing path unreachable, by an argument that is
         * obvious once written down and was invisible for as long as nobody drove the loop:
         *
         *   · `wrapped` is a CLIENT DELIVERABLE. `wrapFulfillmentDeliverable` skips outright when
         *     the run's case has no `client_id` — correctly, since a deliverable is something a
         *     named client accepts and invoices against.
         *   · A PROPOSAL IS FOR SOMEBODY WHO IS NOT A CLIENT YET. That is what a proposal is. The
         *     prospect case `draft_engagement` runs against has no client on it and must not.
         *
         * So the one task type in the product declaring `signs: true` could never satisfy the
         * condition guarding the code that reads it. Every piece existed and was correct —
         * `openProposalEnvelope`, the structured render, the signer resolution that refuses to take
         * an address from the model, `POST /v1/envelopes/:id/{send,revise,sign}` — behind a door
         * that could not open. Found by `evals/driver/scenario-close-the-loop.mjs`, which drafted a
         * real engagement, then reported `nothing to sign` three stages later.
         *
         * Signing and delivering are two different acts against two different counterparties at two
         * different moments, and hanging one off the other was the mistake. They are independent now.
         */
        /**
         * ═════════════════════════════════════════════════════════════════════════════════════════
         * THE MESSAGE THE RUN WROTE, ACTUALLY SENT
         * ═════════════════════════════════════════════════════════════════════════════════════════
         *
         * `"sends": true`, declared and read exactly the way `deck`, `chart` and `signs` are.
         *
         * 51 client requests raised in production, 0 ever answered — because the ask never left the
         * building. All four `nudge_client_request` runs that have ever succeeded produced a
         * reminder, called `send_email` zero times, and reported success. No approval row exists
         * against any of them, which is the proof: nothing outbound happens here without one.
         *
         * The refusal is written to the timeline rather than swallowed. A reminder that did not go
         * because a client has no email on file is a thing the founder can fix in ten seconds, and
         * for the whole time this was broken it was invisible.
         */
        if (loadedSpec?.sends) {
          try {
            /**
             * ═══ THE BOX GOES BEFORE THE SEND, NOT AFTER ═══
             *
             * `/v1/internal/actions/send_email` BLOCKS on the human gate — `awaitApproval` suspends
             * until a founder clicks, for up to thirty minutes. The sandbox is otherwise destroyed
             * in `finally`, which is after this, so a founder at lunch would hold a Daytona box for
             * half an hour per reminder.
             *
             * That is precisely the failure that made 94% of the sandbox-hours we paid for last
             * fortnight dead runs waiting out a timer, and putting it back on the most frequent job
             * in the product would undo the whole fix.
             *
             * Safe here and nowhere else: `sends` is declared only on `decide` jobs, which cannot
             * create or edit files — their deliverable is the validated output, which is already in
             * hand. There is nothing left in the workspace for anything below to read.
             */
            if (sandbox) {
              await sandbox.destroy().catch((e) => console.error("[mycel] early sandbox release failed:", e));
              sandbox = undefined;
            }
            const delivery = await deliverRunMessage({ task, parsed: parsedOut });
            await emit("progress", {
              note: delivery.sent
                ? "Sent to the client."
                : `Not sent — ${delivery.reason ?? "no reason given"}.`,
            });
          } catch (e) {
            // Never fails the run: the nudge ladder will try again tomorrow, and failing here would
            // lose the drafted message and burn one of the client's reminders on nothing.
            console.error("[mycel] could not deliver the run's message:", e);
          }
        }
        if ((loadedSpec as { signs?: boolean } | undefined)?.signs) {
          try {
            // The kit is resolved here rather than threaded down from the render callback above: it
            // is a read off the identity store, and passing it through three closures to save one
            // lookup is how a stale brand ends up on a contract.
            await openProposalEnvelope({
              task,
              parsed: parsedOut,
              store,
              kit: getIdentityStore().brandKit(task.project_id ?? ""),
              emit,
            });
          } catch (e) {
            console.error("[mycel] proposal envelope error:", e);
          }
        }
        if (wrapped) {
          await emit("progress", { note: `Ready for you to review: ${wrapped.title}` });
          try {
            const shipped = await spawnShipFollowOn({ task, parsed: parsedOut, store });
            if (shipped) {
              await emit("progress", {
                note: "Drafting this week's page from the recommendation — it will land next to the report.",
              });
            }
          } catch (e) {
            console.error("[mycel] ship follow-on error:", e);
          }
        }
      } catch (e) {
        console.error("[mycel] deliverable wrap error:", e);
      }
    }

    await store.setStatus(taskId, "succeeded");
    await emit("task.finished", { status: "succeeded", ...driftData() });
  } catch (e) {
    const reason = failureReason(e);
    // Batch fan-out: parent deliberately parked until children join. Not a failure — leave
    // `awaiting_batch` and skip `task.finished` (emitted later by onChildFinished).
    if (reason.includes("awaiting_batch")) {
      const cur = await store.getTask(taskId);
      if (cur?.status !== "awaiting_batch") {
        await store.setStatus(taskId, "awaiting_batch");
      }
    } else {
      const status = terminalStatusFor(reason);
      /**
       * GIVE BACK WHAT THIS RUN CLAIMED, before it is filed as finished.
       *
       * A chase wins the right to chase an invoice by stamping it, seconds before the run exists,
       * so that four replicas cannot chase it four times. In production a chase then did nothing
       * and the stamp stood, which kept a $4,800 unpaid invoice off the ranked list for three days
       * — the failure quietly deleting its own retry. See promises.ts.
       *
       * Before `task.finished` so that anything watching the feed sees the release and the failure
       * together, and never a terminal run whose claim is still outstanding.
       *
       * ═══ `failed` ONLY, AND THE EXCLUSIONS ARE THE INTERESTING PART ═══
       *
       * `rejected` and `expired` are a HUMAN's answer at the approval gate — "do not send this" and
       * "I did not answer in time". Handing the invoice straight back to the ranker there would
       * re-propose, within the hour, the exact chase the founder had just refused, and with the
       * autonomy sweep switched on it would re-send it. A refusal has to cost the ladder an
       * interval or it is not a refusal.
       *
       * `cancelled` is `standDownChases`, whose only caller is "this invoice has just been paid".
       * A paid invoice is refused by `chaseMove` on `amount_due` anyway, so releasing would change
       * nothing except to make the claim's meaning harder to state.
       */
      const returned = status === "failed" ? await releaseClaimFor(task) : undefined;
      if (returned) await emit("progress", { note: returned });
      await store.setStatus(taskId, status, reason);
      await emit("task.finished", { status, error: reason, ...driftData() });
    }
  } finally {
    clearInterval(suspensionWatch);
    clearAbort(taskId);
    if (sandbox) await sandbox.destroy();
    const final = await store.getTask(taskId);
    await observer.onTaskEnd(taskId, final?.status ?? "unknown");
    // Fan-in: if this task was a batch child, try to join and release the parent.
    if (final?.batch_id) {
      try {
        // The runner, so a joined batch can put the parent back to work rather than
        // declaring it finished three steps short of writing anything. See batches.ts.
        await onChildFinished(store, final, (id) => runTask(store, id));
      } catch (e) {
        console.error(`[mycel] batch join after ${taskId} failed:`, e);
      }
    }
  }
}

/**
 * Verify the workspace, store it, and try to publish it. THROWS on the first two.
 *
 * ── Why this is fatal, when it used to swallow everything ─────────────────────────────────────
 *
 * The old version of this block was wrapped in a `try` whose `catch` emitted an `artifact.created`
 * event with an `error` field and carried on to `setStatus("succeeded")`. The reasoning was written
 * down and sounded right: "the run SUCCEEDED — the model did the work and result.txt is already
 * stored; converting an expensive successful run into a failed one because the export had a problem
 * is worse."
 *
 * Task e4dbc13f-c8b8-4587-81fc-a284124a8b06 is what that reasoning actually produces. It finished
 * `succeeded`. Its only record of what happened was `artifact.created {name: "app.tar.gz", error:
 * "workspace export: the run produced no ~/app directory"}` — the missing deliverable reduced to a
 * field on an event nobody reads. `result.txt` had validated, so the contract watcher was satisfied,
 * and a prose summary of an application stood in for the application.
 *
 * The premise was wrong. For a wedge that declares a `workspace`, the DIRECTORY is the deliverable
 * and `result.txt` is a note about it. A run that produced the note and not the thing did not
 * succeed, and the only defensible status is `failed` — visible, retryable, and honest.
 *
 * ── The split ────────────────────────────────────────────────────────────────────────────────
 *
 * VERIFY and EXPORT throw; DEPLOY does not. Publishing is a separate step operating on bytes that
 * are already stored and downloadable, so a hosting outage costs a URL rather than a build — and
 * unlike the other two, it is retryable without re-running an agent for half an hour. The original
 * argument was sound; it was applied to the wrong half.
 *
 * Extracted from `runTask` so this is reachable from a test. Inline, "a workspace-declaring wedge
 * that exports nothing must fail" could only be asserted by driving a real sandbox through a real
 * OpenCode run, which is to say it could not be asserted at all — which is how the behaviour it
 * replaced survived.
 */
export async function handOffWorkspace(args: {
  store: Store;
  // `case_id` is here for the deploy: it decides WHICH SITE this build publishes, for a wedge whose
  // workspace declares `site: "case"`. Narrow on purpose — this function has no business reading
  // the rest of a Task.
  task: { id: string; project_id?: string; case_id?: string };
  ws: NonNullable<ReturnType<typeof resolveWorkspace>>;
  sandbox: Pick<Sandbox, "exec" | "writeFile">;
  backend: { inline: boolean; put(id: string, content: string): Promise<void> };
  emit: (type: EventType, data?: Record<string, unknown>) => Promise<void> | void;
}): Promise<string | undefined> {
  const { store, task, ws, sandbox, backend, emit } = args;
  const taskId = task.id;

  // THE APPLICATION ACTUALLY BUILDS — checked, not claimed. Before the cheap in-sandbox verify,
  // because it is the expensive-to-fake one and there is no point running anything else if the
  // deliverable does not compile.
  await assertRemoteBuildSucceeded({ store, taskId, ws, emit });

  // Verification comes BEFORE the export, so a broken app is never stored, never deployed and never
  // downloaded. See `verifyWorkspace` for why the kernel runs the command rather than trusting the
  // agent's claim to have run it.
  if (ws.verify) {
    await emit("step.started", { step: "verify_workspace" });
    const v = await verifyWorkspace(sandbox, ws);
    await emit("progress", {
      note: v?.ok
        ? `verified: \`${ws.verify}\` succeeded in ~/${ws.dir}`
        : `verification FAILED: \`${ws.verify}\` exited ${v?.code} in ~/${ws.dir}`,
    });
    if (v && !v.ok) {
      throw new Error(
        `workspace verification failed: \`${ws.verify}\` exited ${v.code} in ~/${ws.dir}. ` +
          `The app does not build, so it is not a deliverable.\n--- output (tail) ---\n${v.tail}`,
      );
    }
  }

  /**
   * AND IT IS ACTUALLY A BUILD — not the seed template handed back with new colours.
   *
   * Last of the three gates and the newest, because it is the one whose absence let the other two
   * be satisfied by a no-op: an app that compiles and boots and serves a styled page is a perfect
   * score for a run that changed six strings and a hex value. See substantive.ts.
   *
   * Deliberately AFTER `verify`: a run that is both broken and trivial should be reported as broken,
   * since "it does not compile" is the more actionable half. And deliberately BEFORE the export, so
   * a template-shaped deliverable is never stored, never deployed, and never put in front of the
   * founder as their site.
   *
   * The seed side of the comparison is re-read from disk rather than threaded out of the runtime.
   * `readSeed` is pure and deterministic over the same directory and the same exclusion list that
   * `seedWorkspace` used minutes earlier, so it reproduces exactly the bytes that went in — and it
   * keeps the run's return path free of one more piece of state that only one wedge reads.
   *
   * The thrown message starts with `workspace verification failed` on purpose: that prefix is what
   * the repair loop matches on (see `MAX_REPAIR_ROUNDS` above), so an agent that shipped the
   * template gets told so, in these words, and gets another go at authoring something.
   */
  await assertSubstantiveChange({
    sandbox,
    ws,
    seed: ws.seed ? readSeed(ws.seed, ws.exclude) : null,
    emit,
  });

  /**
   * ═══ AND IS IT A SITE, OR THE TEMPLATE WITH DIFFERENT WORDS IN IT? ═══
   *
   * `assertSubstantiveChange` above is an EFFORT gate: did the agent author bytes. sitequality.ts
   * was written to answer the other question and its header is explicit that effort is not quality —
   * "a run can change four files, add a component, clear every threshold, and still hand back the
   * template with different words in it." It then sat unwired: `scoreSite` and `siteQualityFault`
   * were reachable from their own tests and from nothing else, so the strongest negative signal we
   * have — the seed's own fictional customer, deployed in public under the founder's domain — was
   * measured by nobody.
   *
   * Placed here for the reason stated directly above: before the export, so a template-shaped
   * deliverable is never stored, never deployed and never shown to the founder as their site.
   *
   * RESIDUE FAILS, THE SCORE DOES NOT. Template copy on the page is a wrong answer, not a weak one.
   * The score is reported on every run and gates only when a wedge sets `min_site_quality`, because
   * failing builds on a threshold nobody has calibrated would block real work — report first, gate
   * once the distribution is known.
   *
   * The thrown message carries the `workspace verification failed` prefix on purpose: that is what
   * the repair loop matches on, so an agent that left the seed's copy on the page is told so in
   * these words and gets another go, exactly as it does for a trivial build.
   */
  if (ws.seed) {
    const seeded = readSeed(ws.seed, ws.exclude);
    const { files: siteFiles, ok: readOk } = await collectSiteFiles(sandbox, ws);
    if (!readOk) {
      // Same bias as every other declension in this sequence: an unreadable workspace is a
      // transport problem, and reporting our own read failure to a founder as "your site is the
      // template" is the kernel punishing the agent for the kernel's situation.
      await emit("progress", {
        note: `site-quality check skipped: could not read the source files under ~/${ws.dir}`,
      });
    } else {
      const quality = scoreSite(siteFiles, new Set(seeded.files.map((f) => f.name)));

      /**
       * SAMENESS, which is the founder's complaint at a different altitude: "do not build the same
       * thing every time." Two builds can each diverge from the template and be identical to each
       * other, so the comparison has to be across builds rather than against the seed.
       *
       * The fingerprint is carried in the ARTIFACT NAME rather than its content, because
       * `listArtifacts` returns metadata without bodies — putting it in the name makes reading the
       * history one indexed query per task instead of a fetch per candidate. It is hashed because
       * the raw signature contains `[`, `]` and commas and is not a filename.
       *
       * Entirely best-effort. A history we cannot read is not evidence that this design is novel,
       * and it is certainly not a reason to fail a finished site.
       */
      let repeat: string | undefined;
      try {
        const fpHash = createHash("sha256").update(quality.fingerprint).digest("hex").slice(0, 16);
        const previous: string[] = [];
        // Not narrowed by wedge: `handOffWorkspace` takes a deliberately minimal task shape and does
        // not carry one. Scoped to the project, which is the boundary that actually matters — the
        // question is whether THIS business's earlier sites look like this one.
        const recent = (await store.listTasks({ limit: 60 }))
          .filter((t) => t.project_id === task.project_id && t.id !== taskId && t.status === "succeeded")
          .sort((a, b) => b.created_at.localeCompare(a.created_at))
          .slice(0, 15);
        for (const t of recent) {
          for (const a of await store.listArtifacts(t.id)) {
            const m = /^site-fingerprint-([0-9a-f]{16})\.txt$/.exec(a.name ?? "");
            if (m) previous.push(m[1]!);
          }
        }
        repeat = repeatWarning(fpHash, previous);
        await store.addArtifact({
          task_id: taskId,
          name: `site-fingerprint-${fpHash}.txt`,
          content_type: "text/plain",
          content: quality.fingerprint,
        });
      } catch (e) {
        console.error(`[mycel] could not record the site fingerprint for task ${taskId}:`, e);
      }

      await emit("progress", {
        note:
          `site quality ${quality.score}/100 · ${quality.authored} authored component(s) · ` +
          `${quality.hardcodedColors} hardcoded colour(s) · motif ` +
          (quality.motif ? `${quality.motif.token} used ${quality.motif.uses}×` : "none") +
          (repeat ? ` · ${repeat}` : ""),
        site_quality: quality.score,
        residue: quality.residue,
        notes: quality.notes,
        repeat: repeat ?? null,
      });

      const fault = siteQualityFault(quality, ws.minSiteQuality);
      if (fault) throw new Error(`workspace verification failed: ${fault}`);
    }
  }

  /**
   * ═══ THE PICTURE THE BUILD ALREADY TOOK, WHICH NOTHING EVER LOOKED AT ═══
   *
   * `verify-build.sh` runs `scripts/screenshot.mjs`, which boots the site in chromium and writes
   * PNGs to `.mycel/shots`. Its own header states why it exists: "THE FOUNDER SEES IT. Attached to
   * the run" and "IT CAN BE JUDGED. A rendered page is the only artifact a design critic — human or
   * model — can actually assess."
   *
   * Neither happened. `.mycel/shots` was written by that script and read by NOTHING — grep the repo
   * and the only hit is the line that defines the path. So every build took a photograph of the
   * finished site and filed it somewhere nobody opens, while the founder got a tarball and the eval
   * that declares `judge: "screenshot"` scored the agent's written SUMMARY against a rubric of
   * visual properties.
   *
   * Attaching them here, before the export, makes the run's own evidence first-class: the founder
   * opens a picture instead of a link, and anything grading this work can grade the rendered page
   * instead of a description of it.
   *
   * FAIL-SOFT, for the same reason `screenshot.mjs` exits 0 on every path: a missing picture is a
   * missing picture, and a finished site withheld because a screenshotter had a bad moment is a far
   * worse outcome than a build that hands back no image. A local sandbox has no playwright and will
   * legitimately produce none.
   */
  try {
    const shots = await sandbox
      .exec(`ls -1 ${ws.dir}/.mycel/shots/*.png 2>/dev/null | head -6`, 15_000)
      .then((r) => r.stdout.split("\n").map((l) => l.trim()).filter(Boolean))
      .catch(() => [] as string[]);
    for (const path of shots) {
      // base64 so the bytes survive the same exec pipe the tarball uses.
      const b64 = (await sandbox.exec(`base64 < ${path} | tr -d '\n'`, 30_000)).stdout.trim();
      if (!b64) continue;
      const art = await store.addArtifact({
        task_id: taskId,
        name: path.split("/").pop() ?? "screenshot.png",
        content_type: "image/png",
        content: backend.inline ? b64 : "",
      });
      if (!backend.inline) await backend.put(art.id, b64);
      await emit("artifact.created", {
        artifact_id: art.id,
        name: art.name,
        content_type: art.content_type,
        bytes: Math.floor((b64.length * 3) / 4),
        url: `/v1/artifacts/${art.id}`,
      });
    }
  } catch {
    /* a picture is never worth failing a finished build over */
  }

  const dir = await exportDirectory(sandbox, ws);
  const wsArt = await store.addArtifact({
    task_id: taskId,
    name: dir.name,
    content_type: dir.content_type,
    content: backend.inline ? dir.base64 : "",
  });
  if (!backend.inline) await backend.put(wsArt.id, dir.base64);
  await emit("artifact.created", {
    artifact_id: wsArt.id,
    name: wsArt.name,
    content_type: wsArt.content_type,
    bytes: dir.bytes,
    url: `/v1/artifacts/${wsArt.id}`,
  });

  // ── and then, if this kernel can host, it goes live ──────────────────────────────────────────
  //
  // `deployConfig()` is null on every developer machine and in every test, and that is the intended
  // default: without the deploy environment a build still runs and still hands back a downloadable
  // app. Only the hosted product sets these.
  try {
    const cfg = deployConfig();
    if (cfg && task.project_id) {
      const projectSlug = await deploySlugFor(task.project_id);
      if (projectSlug) {
        /**
         * WHICH SITE, read off the wedge rather than guessed from the task.
         *
         * `workspace.site` defaults to `"project"`, so every manifest that existed before sites did
         * keeps publishing to exactly the address it always has. Only a wedge that declares `"case"`
         * — a studio building for its clients — gets one address per engagement.
         */
        const site = siteFor({
          scope: ws?.site,
          projectId: task.project_id,
          projectSlug,
          caseId: task.case_id,
        });
        /**
         * PROPOSE, DO NOT PUBLISH. See `proposeDeploy`.
         *
         * This called `startDeploy` and the page was live before the run had finished winding down:
         * no step at all between a model deciding it was done and a stranger reading the front door
         * of somebody's business. It is the only thing this product ever published without a human
         * signature, and `takeability` in `moves.ts` refuses to offer a "build my site" button
         * BECAUSE of it.
         *
         * The bytes are uploaded here, while the run still holds them — the sandbox is destroyed
         * minutes from now and cannot be asked again. CodeBuild is not called until somebody says so.
         */
        const dep = await proposeDeploy(getDomainStore(), {
          projectId: task.project_id,
          siteId: site.site_id,
          slug: site.slug,
          taskId,
          base64: dir.base64,
        }, cfg);
        /**
         * `deploy.proposed`, not `deploy.started`, and the rename is the honest part.
         *
         * The old event said "we are publishing your app, here is where it will be" at a point where
         * that was true. It is no longer: nothing is being published, and a feed that claims
         * otherwise would teach a founder that a finished build means a live site — which is exactly
         * the belief the gate exists to correct. The URL still rides along, because "this is the
         * address it would take" is the useful half and the reviewer needs it.
         */
        await emit("deploy.proposed", { deployment_id: dep.id, url: dep.url, status: dep.status });
        return dep.url;
      } else {
        /**
         * THE SILENT HALF, AND IT WAS THE COMMON ONE.
         *
         * This kernel CAN host — `deployConfig()` answered — and the run built an app, and then the
         * project turned out to have no slug (an older project, or an identity store that threw).
         * Nothing was emitted at all: no deploy line, no failure, nothing. The founder watched a run
         * succeed and waited for an address that was never going to arrive, and `deploySlugFor`'s
         * own comment already said out loud that this was "silently never published" while the code
         * went on doing it. A deployment that will not happen is a fact about the run, and every
         * other fact about the run is on its feed.
         */
        await emit("deploy.started", {
          status: "failed",
          error:
            "this app was built but not published: the business has no address allocated yet. " +
            "It is downloadable from this run in the meantime.",
        });
      }
    }
  } catch (e) {
    // Reported on the run's own feed, not swallowed silently — but not fatal. See the split above.
    await emit("deploy.started", {
      status: "failed",
      error: String((e as Error)?.message ?? e).slice(0, 500),
    });
  }
}

/**
 * "This task completes only when the application actually builds."
 *
 * The guarantee the build tool exists to make, enforced here — and enforceable ONLY here, because
 * the thing being checked is a fact about the run's history rather than about its final state.
 *
 * WHY THE EVENT LOG. `tool.result {tool: "codebuild", ok: true}` is written by the kernel's own
 * `/v1/internal/build/status` handler after CodeBuild reported SUCCEEDED. The sandbox cannot append
 * events — it holds a build nonce that opens two paths, neither of which writes an arbitrary event
 * — so an agent cannot manufacture this evidence, and a summary that says "the app builds" is not
 * evidence at all. That distinction is the entire reason `verifyWorkspace` was written in the first
 * place; this is the same argument applied to a build that no longer runs in the sandbox.
 *
 * DEGRADES WHEN THERE IS NO BUILD PLANE. `remoteBuildConfig()` is null on every developer machine
 * and in the whole test suite. Failing a run there would mean a kernel that cannot run
 * `product-builder` at all without an AWS account — the same mistake `assertExportableBackend`
 * nearly made, and the same resolution: the tool was never offered, so its absence is not the
 * agent's fault, and the run proceeds on the cheap in-sandbox checks alone. Said out loud on the
 * feed, because a weaker guarantee that nobody is told about is worse than no guarantee.
 */
export async function assertRemoteBuildSucceeded(args: {
  store: Pick<Store, "eventsAfter">;
  taskId: string;
  ws: { requireRemoteBuild: boolean; dir: string };
  emit: (type: EventType, data?: Record<string, unknown>) => Promise<void> | void;
}): Promise<void> {
  const { store, taskId, ws, emit } = args;
  if (!ws.requireRemoteBuild) return;
  if (!remoteBuildConfig()) {
    await emit("progress", {
      note:
        `remote build NOT required on this kernel: no build plane is configured ` +
        `(MYCEL_DEPLOY_BUCKET + MYCEL_VERIFY_PROJECT), so \`mycel-build\` was never offered to the ` +
        `agent. The app was not compiled with the deploy toolchain.`,
    });
    return;
  }

  const events = await store.eventsAfter(taskId, 0);
  const results = events.filter((e) => e.type === "tool.result" && e.data?.tool === "codebuild");
  if (results.some((e) => e.data?.ok === true)) {
    await emit("progress", { note: `remote build succeeded — the application compiles.` });
    return;
  }

  const attempts = events.filter((e) => e.type === "tool.called" && e.data?.tool === "codebuild").length;
  throw new Error(
    attempts === 0
      ? `the run never proved the app builds: \`mycel-build\` was never called. ~/${ws.dir} is not a ` +
        `deliverable until it has compiled on the build plane, so this task is failed rather than ` +
        `shipped. (${MAX_BUILDS_PER_RUN} builds were available and none were used.)`
      : `the run did not produce a building application: ${attempts} of ${MAX_BUILDS_PER_RUN} build ` +
        `attempt(s) were made and none succeeded. An app that does not compile is not a partial ` +
        `deliverable, it is a broken one.`,
  );
}

/**
 * A sentence for the row, from whatever was thrown.
 *
 * `String((e as Error)?.message ?? e)` was correct for every throw that carries a message and silent
 * for the ones that do not: `new Error("")` writes an EMPTY STRING into `tasks.error`, which is not
 * `undefined` so it is persisted, and `/work/<id>` renders `row.error ? … : {}` — an empty string is
 * falsy, so the founder sees a failed run with no reason. That is indistinguishable on screen from
 * the crash-recovery hole this was found next to (see recovery.ts), and both were in the population
 * of `invoice-chaser` runs sitting `failed` at `$0.00` in production.
 *
 * Naming the class of the thing thrown is not much, but it is the difference between "we do not know"
 * and looking like we never asked.
 */
export function failureReason(e: unknown): string {
  const message = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  if (message.trim()) return message;
  const kind = e instanceof Error ? e.name || "Error" : e === null ? "null" : typeof e;
  return `the run threw ${kind} with no message — see the kernel logs for this task id`;
}

/** Map an abort/error reason to the terminal status the contract defines. */
function terminalStatusFor(reason: string): TaskStatus {
  if (reason.includes("cancelled")) return "cancelled";
  if (reason.includes("rejected")) return "rejected";
  if (reason.includes("expired")) return "expired";
  if (reason.includes("max_runtime")) return "expired";
  return "failed";
}
