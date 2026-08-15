// Orchestration: provision a sandbox, run OpenCode against the task, enforce cost/runtime
// limits, persist + stream + trace events, tear the sandbox down. Approval suspend/resume lives
// in approvals.ts (driven by the OpenCode plugin gate). v0.1 runs in-process; a durable engine
// slots in at the same seams.
import { getArtifactBackend } from "./artifacts";
import { abortReason, clearAbort } from "./cancel";
import { loadConfig } from "./config";
import type { EventType, TaskStatus } from "./contract";
import { emitEvent } from "./events";
import { createSandbox, type Sandbox } from "./sandbox";
import { runOpenCodeTask, type CostMeta } from "./runtime";
import { runMockTask } from "./runtime.mock";
import type { Store } from "./store";
import { getObserver } from "./tracing";
import { validateOutput } from "./validate";
import { repairOutput } from "./repair";

import { wedgeHasRole } from "./roles";
import { assertExportableBackend, exportDirectory, resolveWorkspace, verifyWorkspace } from "./workspace";
import { deployConfig, startDeploy } from "./deploy";
import { MAX_BUILDS_PER_RUN, remoteBuildConfig } from "./remotebuild";
import { getDomainStore } from "./domain";
import { getIdentityStore } from "./identity";
import { getKnowledgeStore } from "./knowledge.store";
import { parseImprovementProposal } from "./improvement";
import { authorWedgeFromOutput, faultSentence } from "./wedgeauthor";
import { getAuthoredStore, loadProjectWedge } from "./authored";
import { onChildFinished } from "./batches";
import { assertSendPromiseKept, readPromises, releaseClaimFor } from "./promises";
import { wrapFulfillmentDeliverable } from "./deliverables.wrap";
import { render } from "./render";
import { blocksFromMarkdown } from "./render/report";

/**
 * The job the shaper does when nothing installed fits the business it just read.
 *
 * A constant rather than an inline string because `roles.ts` names the same task type in the
 * `business_shaping` role, and the two must agree or the shaper produces a draft nobody parses.
 */
const DRAFT_SERVICE_TASK_TYPE = "draft_service";

function parseJsonOutput(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  try { return JSON.parse((fenced?.[1] ?? text).trim()); } catch { return null; }
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
    if (Date.now() > deadline) return "max_runtime_exceeded";
    if (accruedCost > task.constraints.max_cost_usd) return "max_cost_exceeded";
    return null;
  };

  /** `unmapped` only appears when something WAS unmapped — an absent key means a clean run. */
  const driftData = () => (drift ? { unmapped: drift } : {});

  const ctx = { emit, onCost, shouldAbort, onDrift };
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
    if (!useMock) sandbox = await createSandbox();
    await store.setStatus(taskId, "running");
    await emit("task.created", { wedge: task.wedge, task_type: task.task_type });

    let { text } = useMock
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

    await emit("output.validated", { ok: v.ok, errors: v.errors });
    if (!v.ok) throw new Error(`output failed validation: ${v.errors.join("; ")}`);

    // Reflection is a proposal-producing run, not a privileged write path. Persisting the
    // proposal separately from rules means the model can notice patterns, but only a founder can
    // promote one into the company's active knowledge.
    // `wedgeHasRole`, not a slug: this asks "did the SELF-IMPROVEMENT wedge produce this?", and the
    // answer must survive that wedge being renamed, replaced, or absent. As a string literal it also
    // silently governed which outputs get parsed as an improvement proposal — so a second reflection
    // wedge would have had its proposals dropped on the floor with nothing logged.
    if (wedgeHasRole(task.wedge, "self_improvement") && task.project_id) {
      const proposal = parseImprovementProposal(parseJsonOutput(text), {
        project_id: task.project_id,
        wedge: task.wedge,
        task_id: task.id,
        task_type: task.task_type,
      });
      if (proposal) {
        const saved = await getKnowledgeStore().createImprovementProposal(proposal);
        await emit("improvement.proposed", {
          proposal_id: saved.id,
          target: saved.target,
          confidence: saved.confidence,
          title: saved.title,
        });
      }
    }

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
    if (wedgeHasRole(task.wedge, "business_shaping") && task.task_type === DRAFT_SERVICE_TASK_TYPE && task.project_id) {
      const described = typeof task.input?.description === "string" ? task.input.description : "";
      const parsed = parseJsonOutput(text) as Record<string, unknown> | null;
      const manifestTitle = (parsed?.manifest as Record<string, unknown> | undefined)?.title;
      const nameHint =
        (typeof parsed?.slug === "string" && parsed.slug) ||
        (typeof manifestTitle === "string" && manifestTitle) ||
        described;
      const authored = authorWedgeFromOutput(parsed, { slugBase: nameHint });
      if (authored.draft) {
        const saved = await getAuthoredStore().createDraft({
          project_id: task.project_id,
          slug: authored.draft.slug,
          title: authored.draft.manifest.title ?? authored.draft.slug,
          manifest: authored.draft.manifest,
          skills: authored.draft.skills,
          knowledge: authored.draft.knowledge,
          described_as: described,
          source_task_id: task.id,
        });
        await emit("service.drafted", { slug: saved.slug, title: saved.title, status: saved.status });
      } else {
        await emit("service.draft_refused", {
          reasons: authored.faults.map((f) => f.message),
          summary: faultSentence(authored.faults),
        });
      }
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
    if (ws && sandbox) {
      await handOffWorkspace({ store, task, ws, sandbox, backend, emit });
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
    const promised = readPromises(
      (await loadProjectWedge(task.project_id ?? "", task.wedge))?.manifest.task_types?.[task.task_type]?.promises,
    );
    const kept = assertSendPromiseKept({ promised, output: text, events: await store.eventsAfter(taskId, 0) });
    if (kept.kept) await emit("progress", { note: kept.note });

    // A fulfillment run that produced bytes but no Deliverable is work the client cannot accept
    // and the founder cannot invoice. Mock runs are skipped: `[mock]` is not a delivery.
    if (!useMock) {
      try {
        const wrapped = await wrapFulfillmentDeliverable({
          task,
          artifactId: art.id,
          summary: text.slice(0, 2_000),
          content: text,
          // Render the run's markdown into a branded PDF for a `document` deliverable. Same
          // server-side pipeline as `attachInvoiceDocument`: resolve the project's kit (fails closed
          // on an unknown project, so nothing renders under house branding), render, attach through
          // the same artifact backend. Returns undefined on any miss, and the wrapper keeps the text.
          renderDocument: async ({ task: t, content, title }) => {
            const projectId = t.project_id;
            if (!projectId) return undefined;
            const kit = getIdentityStore().brandKit(projectId);
            if (!kit) return undefined;
            const doc = render("report", { title, blocks: blocksFromMarkdown(content) }, kit);
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
            await emit("artifact.created", {
              artifact_id: pdf.id,
              name: pdf.name,
              content_type: pdf.content_type,
              url: `/v1/artifacts/${pdf.id}`,
            });
            return pdf.id;
          },
        });
        if (wrapped) {
          await emit("progress", { note: `Ready for you to review: ${wrapped.title}` });
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
    clearAbort(taskId);
    if (sandbox) await sandbox.destroy();
    const final = await store.getTask(taskId);
    await observer.onTaskEnd(taskId, final?.status ?? "unknown");
    // Fan-in: if this task was a batch child, try to join and release the parent.
    if (final?.batch_id) {
      try {
        await onChildFinished(store, final);
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
  task: { id: string; project_id?: string };
  ws: NonNullable<ReturnType<typeof resolveWorkspace>>;
  sandbox: Pick<Sandbox, "exec">;
  backend: { inline: boolean; put(id: string, content: string): Promise<void> };
  emit: (type: EventType, data?: Record<string, unknown>) => Promise<void> | void;
}): Promise<void> {
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
      const slug = await deploySlugFor(task.project_id);
      if (slug) {
        const dep = await startDeploy(getDomainStore(), {
          projectId: task.project_id,
          slug,
          taskId,
          base64: dir.base64,
        }, cfg);
        // On the feed immediately, at `queued`, rather than when the build finishes minutes later.
        // "We are publishing your app, here is where it will be" is what the person watching the run
        // wants; a silent gap followed by a URL looks like nothing happened.
        await emit("deploy.started", { deployment_id: dep.id, url: dep.url, status: dep.status });
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
