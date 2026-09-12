// Fan-out / fan-in: one parent episode, N sibling child tasks, then a join.
//
// ═══ THE FAILURE THIS EXISTS FOR ═══
//
// GEO (query × model), localisation (N locales), questionnaire desks (200 questions), and
// "chase 40 receipts then summarise" all need worker-count latency, not serial latency inside one
// sandbox. The scheduler already fans out chases as independent tasks — what it never had was a
// JOIN: wait until the children finish and hand the parent an aggregate.
//
// Case remains the long engagement. Batch is an ephemeral work-tree for one episode. That is why
// there is still no `parent_task_id` on Case hierarchy — Batch is not a second CRM object.
//
// ═══ TRUST ═══
//
// Children are ordinary tasks: same approvals, same capabilities, same spend ceilings. The parent
// sitting in `awaiting_batch` is NOT an approval gate and must never be confused with one — joining
// does not send, charge, or publish. It only aggregates what already happened.
import { randomUUID } from "node:crypto";
import type { Batch, BatchStatus, Task, TaskStatus } from "./contract";
import type { Store } from "./store";
import { clearAbort } from "./cancel";
import { databaseUrl } from "./config";

const TERMINAL: ReadonlySet<TaskStatus> = new Set([
  "succeeded",
  "failed",
  "rejected",
  "expired",
  "cancelled",
]);

export interface BatchStore {
  createBatch(b: Omit<Batch, "id" | "created_at" | "updated_at" | "child_task_ids" | "status"> & {
    child_task_ids?: string[];
    status?: BatchStatus;
  }): Promise<Batch>;
  getBatch(id: string): Promise<Batch | undefined>;
  listBatches(projectId: string, limit?: number): Promise<Batch[]>;
  addChild(batchId: string, taskId: string): Promise<Batch | undefined>;
  /**
   * If every child is terminal (or quorum succeeded), mark the batch joined and return it.
   * Idempotent: a second call on an already-joined batch returns the same row.
   */
  tryJoin(batchId: string, children: readonly Task[]): Promise<Batch | undefined>;
}

const now = () => new Date().toISOString();

export class InMemoryBatchStore implements BatchStore {
  private rows = new Map<string, Batch>();

  async createBatch(
    b: Omit<Batch, "id" | "created_at" | "updated_at" | "child_task_ids" | "status"> & {
      child_task_ids?: string[];
      status?: BatchStatus;
    },
  ): Promise<Batch> {
    if (!b.project_id) throw new Error("batch requires a project_id");
    if (!b.parent_task_id) throw new Error("batch requires a parent_task_id");
    if (b.join === "quorum" && !(b.quorum && b.quorum > 0)) {
      throw new Error("quorum join requires quorum > 0");
    }
    const row: Batch = {
      ...b,
      id: randomUUID(),
      status: b.status ?? "open",
      child_task_ids: b.child_task_ids ?? [],
      created_at: now(),
      updated_at: now(),
    };
    this.rows.set(row.id, row);
    return row;
  }

  async getBatch(id: string): Promise<Batch | undefined> {
    return this.rows.get(id);
  }

  async listBatches(projectId: string, limit = 50): Promise<Batch[]> {
    if (!projectId) return [];
    return [...this.rows.values()]
      .filter((b) => b.project_id === projectId)
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
      .slice(0, limit);
  }

  async addChild(batchId: string, taskId: string): Promise<Batch | undefined> {
    const b = this.rows.get(batchId);
    if (!b || b.status !== "open") return b;
    if (!b.child_task_ids.includes(taskId)) b.child_task_ids.push(taskId);
    b.updated_at = now();
    return b;
  }

  async tryJoin(batchId: string, children: readonly Task[]): Promise<Batch | undefined> {
    const b = this.rows.get(batchId);
    if (!b) return undefined;
    if (b.status === "succeeded" || b.status === "failed" || b.status === "cancelled") return b;

    const byId = new Map(children.map((t) => [t.id, t]));
    const kids = b.child_task_ids.map((id) => byId.get(id)).filter((t): t is Task => !!t);
    if (kids.length !== b.child_task_ids.length) return b; // not all loaded — do not join yet

    const succeeded = kids.filter((t) => t.status === "succeeded").length;
    const failed = kids.filter((t) => t.status === "failed" || t.status === "rejected" || t.status === "expired").length;
    const cancelled = kids.filter((t) => t.status === "cancelled").length;
    const done = kids.every((t) => TERMINAL.has(t.status));

    const quorumMet = b.join === "quorum" && succeeded >= (b.quorum ?? 0);
    if (!done && !quorumMet) return b;

    b.status = "joining";
    b.aggregate = {
      succeeded,
      failed,
      cancelled,
      outputs: kids.filter((t) => t.status === "succeeded").map((t) => t.input?.__batch_output ?? null),
    };
    // Parent success if at least one child succeeded and (all done or quorum). Total failure only
    // when nothing succeeded.
    b.status = succeeded > 0 ? "succeeded" : "failed";
    b.joined_at = now();
    b.updated_at = b.joined_at;
    return b;
  }
}

/** Module-level store so server + orchestrator share one without threading DomainStore yet. */
let batchStore: BatchStore = new InMemoryBatchStore();

export function getBatchStore(): BatchStore {
  return batchStore;
}

/** Test / boot seam. Postgres backing can swap this later the same way DomainStore does. */
export function setBatchStore(store: BatchStore): void {
  batchStore = store;
}

export function _resetBatchStore(): void {
  batchStore = new InMemoryBatchStore();
}

/**
 * Give batches a database, or leave them in memory for a local run with no DATABASE_URL.
 *
 * THIS WAS THE `later` THAT NEVER CAME. The seam above has said "Postgres backing can swap this
 * later the same way DomainStore does" since it was written, and nothing ever called it — so the
 * in-memory map WAS the production store. The first real fan-out to get through the ALB spawned
 * twelve children, sixteen runs succeeded, and the parent sat in `awaiting_batch` for two hours
 * because the batch had died with the process that made it.
 *
 * No `catch`, matching `initRequestStore` and for the sharper version of its reason: a batch lost
 * mid-fan-out leaves a parent parked for ever with every child succeeded. Nothing errors, nothing
 * logs, and a stalled engagement is indistinguishable from a patient one.
 */
export async function initBatchStore(): Promise<{ backend: string }> {
  /**
   * `databaseUrl()`, NOT `process.env.DATABASE_URL`.
   *
   * ═══ THIS READ THE ONE VARIABLE PRODUCTION DOES NOT SET ═══
   *
   * `infra/services.tf` gives the kernel and the worker `MYCEL_DATABASE_URL` and
   * `MYCEL_DATABASE_POOLED_URL`. `DATABASE_URL` is set for the console and the landing app and for
   * litellm — never for these two. So this resolved to `undefined` on every production boot, fell
   * through to `InMemoryBatchStore`, and the `batches` table was never created.
   *
   * Found by `src/db/verify.ts` on its first run against production: 47 tables checked, `batches`
   * absent. Thirty-one tasks in that database carry a `batch_id`, so fan-out really has run — with
   * its coordination records living in one worker's memory.
   *
   * The consequence is the one written out immediately above the call site in `index.ts`: "lose a
   * record, it PARKS A RUN FOR EVER. The children keep succeeding, the parent stays
   * `awaiting_batch`, and nothing anywhere says why — the only invisible failure in this list." A
   * deploy restarts every worker, so any batch in flight across one was exactly that loss.
   *
   * `databaseUrl()` is the resolver every other store uses, and it prefers the transaction pooler
   * when one is configured, which is also the right answer here.
   */
  const url = databaseUrl();
  if (url) {
    const { PgBatchStore } = await import("./batches.pg");
    batchStore = await PgBatchStore.connect(url);
    return { backend: "postgres" };
  }
  batchStore = new InMemoryBatchStore();
  return { backend: "memory" };
}

/**
 * After a child task finishes, try to join its batch and advance the parent out of `awaiting_batch`.
 *
 * Pure coordination: the caller owns loading children. Aggregate lives on the Batch row (not on
 * parent.input — Store forbids mutating input after create). Returns the joined batch when join
 * fired, otherwise undefined.
 */
/**
 * How many times one task may fan out before we call it a loop. See the argument at the resume.
 */
const MAX_BATCH_ROUNDS = 2;

export async function onChildFinished(
  store: Store,
  child: Task,
  /**
   * Runs a task. Injected rather than imported, because the orchestrator imports this module and a
   * direct import back would be a cycle. Omitted, the parent still terminates as it always did.
   */
  resume?: (taskId: string) => Promise<void>,
): Promise<Batch | undefined> {
  if (!child.batch_id) return undefined;
  const batches = getBatchStore();
  const batch = await batches.getBatch(child.batch_id);
  if (!batch) return undefined;
  // Parent also carries batch_id (so Work UI can link the episode). Only children join.
  if (child.id === batch.parent_task_id) return undefined;
  if (!batch.child_task_ids.includes(child.id)) return undefined;

  const children: Task[] = [];
  for (const id of batch.child_task_ids) {
    const t = await store.getTask(id);
    if (t) children.push(t);
  }
  // Prefer validated result.txt over the `__batch_output` input hint (input is immutable after create).
  const withOutputs = await Promise.all(
    children.map(async (t) => {
      if (t.status !== "succeeded") return t;
      if (t.input?.__batch_output !== undefined) return t;
      const arts = await store.listArtifacts(t.id);
      const meta = [...arts].reverse().find((a) => a.name === "result.txt");
      if (!meta) return t;
      const full = await store.getArtifact(meta.id);
      let text = full?.content ?? "";
      if (!text) {
        try {
          const { getArtifactBackend } = await import("./artifacts");
          text = (await (await getArtifactBackend()).get(meta.id)) ?? "";
        } catch {
          text = "";
        }
      }
      if (!text) return t;
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* keep raw string */
      }
      return { ...t, input: { ...t.input, __batch_output: parsed } };
    }),
  );

  const joined = await batches.tryJoin(batch.id, withOutputs);
  if (!joined || (joined.status !== "succeeded" && joined.status !== "failed")) return undefined;

  const parent = await store.getTask(batch.parent_task_id);
  if (parent && parent.status === "awaiting_batch") {
    await store.appendEvent(parent.id, "batch.joined", {
      batch_id: joined.id,
      status: joined.status,
      succeeded: joined.aggregate?.succeeded ?? 0,
      failed: joined.aggregate?.failed ?? 0,
      cancelled: joined.aggregate?.cancelled ?? 0,
    });

    /**
     * ═══ THE PARENT FINISHES ITS JOB ═══
     *
     * This used to call `setStatus(parent, "succeeded")` and stop, and that was the most expensive
     * bug in the product.
     *
     * A `weekly_report` compiles a deliver job, plans five steps, reaches step two — "run probes or
     * aggregate supplied measurements" — spawns six probes, and parks. The probes come back, this
     * ran, the parent was marked SUCCEEDED with three steps of its plan never executed. The report
     * was never written. `wrapFulfillmentDeliverable` was never reached. No deliverable was created
     * and the task reported success.
     *
     * That is why nothing has ever been delivered. Not because deliverables fail — because the
     * flagship one structurally cannot finish whenever it fans out, and says it did.
     *
     * `Batch.aggregate` is documented in contract.ts as "counts + optional merged output THE PARENT
     * RESUMES WITH". The field was built for this. Nothing resumed.
     *
     * ═══ RE-RUN, NOT RESUME ═══
     *
     * The parent is torn down at the fan-out: the sandbox is destroyed and the agent process is
     * gone, because parking is implemented by throwing. There is no session to re-enter, so the
     * honest verb is re-run. The children's outputs go onto the task's input first, so the second
     * run reads the measurements instead of taking them again.
     *
     * ═══ AND IT CANNOT LOOP ═══
     *
     * A parent that fans out on every run would spawn children forever. `_batch_rounds` counts, and
     * past the cap the task fails with a reason a human can act on rather than quietly costing money
     * in a circle. Two is deliberate: one fan-out is the designed shape, a second is a job genuinely
     * working in stages, and a third is a bug.
     */
    /**
     * How many batches this parent has already finished. Counted from the batches themselves rather
     * than stashed on the task, because `Store.updateTask` deliberately refuses to touch `input` -
     * "fixed at creation because a run already reading them must not have them changed underneath
     * it" - and that rule is worth more than the convenience of a counter.
     */
    const priors = await batches.listBatches(batch.project_id, 200);
    const rounds = priors.filter(
      (b) => b.parent_task_id === parent.id && b.id !== batch.id && b.joined_at,
    ).length;

    if (joined.status !== "succeeded") {
      await store.setStatus(parent.id, "failed", "batch joined with no successful children");
      await store.appendEvent(parent.id, "task.finished", { status: "failed", batch_id: joined.id });
    } else if (!resume) {
      // No runner injected — the caller is a test or a tool that only aggregates. Preserve the old
      // terminal behaviour rather than leaving the parent parked forever.
      await store.setStatus(parent.id, "succeeded");
      await store.appendEvent(parent.id, "task.finished", { status: "succeeded", batch_id: joined.id });
    } else if (rounds >= MAX_BATCH_ROUNDS) {
      await store.setStatus(
        parent.id,
        "failed",
        `fanned out ${rounds + 1} times without finishing — this job is looping, not working in stages`,
      );
      await store.appendEvent(parent.id, "task.finished", { status: "failed", batch_id: joined.id });
    } else {
      /**
       * Nothing is written to the task. The children's outputs already live on the batch, in
       * `aggregate.outputs`, and the resumed run reads them from there - see `priorBatchResults`,
       * which the runtime mounts. Copying them onto the task would be a second home for the same
       * bytes and would require mutating `input`, which the store forbids for good reason.
       */
      /**
       * CLEAR THE ABORT THAT PARKED IT.
       *
       * Fanning out is implemented by `markAbort(parent, "awaiting_batch")`, which unwinds the
       * agent mid-run. The orchestrator reads `abortReason` at the START of a run, so a parent put
       * back in the queue with that flag still set aborts instantly for the reason it was parked
       * with — parks again, joins again, parks again. A resumed task must never inherit the abort
       * that suspended it.
       *
       * In production the parent's own `finally` clears this as it unwinds, so the flag is usually
       * gone by the time the children join. Usually is not a guarantee, and it was not true at all
       * for a parent whose batch was opened without it ever going through `runTask`.
       */
      clearAbort(parent.id);
      await store.setStatus(parent.id, "queued");
      await store.appendEvent(parent.id, "batch.resumed", {
        batch_id: joined.id,
        round: rounds + 1,
        children: joined.aggregate?.succeeded ?? 0,
      });
      // Detached on purpose. This is called from a CHILD's teardown, and awaiting the parent here
      // would hold that child's finally block open for the length of an entire second run.
      void resume(parent.id).catch((e) =>
        console.error(`[mycel] resuming ${parent.id} after batch ${joined.id} failed:`, e),
      );
    }
  }
  return joined;
}


/**
 * WHAT THE CHILDREN CAME BACK WITH, for a parent that is running again.
 *
 * A resumed parent has no memory of its first run: parking is implemented by throwing, the sandbox
 * is destroyed and the agent process is gone. Without this it would reach the same step, decide it
 * needs measurements, and fan out again — which the round cap would then correctly kill as a loop.
 * The cap catches the symptom; this removes the cause.
 *
 * Mounted as a skill rather than pushed into `input`, because `Store.updateTask` refuses to touch
 * `input` after creation and it is right to: a run already reading it must not have it change
 * underneath. The batch is where these outputs live and this reads them from there.
 */
/**
 * The page itself, pure — ONE definition of the text.
 *
 * Split out because the wording is the mechanism: this is the only thing standing between a
 * resumed parent and a second identical fan-out, and it is asserted directly in tests. A second
 * copy for the tests to read would drift from this one the first time the wording is tuned, and
 * the test would keep passing against text nothing mounts.
 */
export function batchResultsPage(outputs: readonly unknown[]): { name: string; content: string } {
  return {
    name: "batch:results",
    /**
     * FRONTMATTER, because the index line is what decides whether this gets opened at all.
     *
     * `fileSummary` prefers a `description` and otherwise takes the first non-heading line, which
     * here was "You spawned 2 job(s) earlier in this task and they have finished. Their" — cut at a
     * line break, mid-sentence, with the one instruction that matters ("DO NOT SPAWN THEM AGAIN")
     * six lines further down and never surfaced. On task b8ef3b01 the agent skipped it three times
     * and looped until the round cap failed the run.
     */
    content: [
      "---",
      "description: The children you already spawned have finished and their output is here. Read this before planning; do NOT open another batch for the same measurement.",
      "---",
      "",
      "# The work you already sent out, and what came back",
      "",
      `You spawned ${outputs.length} job(s) earlier in this task and they have finished. Their`,
      "output is below.",
      "",
      "DO NOT SPAWN THEM AGAIN. This is the measurement you asked for. Asking for it a second time",
      "costs the same money, takes the same time, and produces the same answer. Carry on from where",
      "the plan left off and use what is here.",
      "",
      "```json",
      JSON.stringify(outputs, null, 2).slice(0, 24_000),
      "```",
    ].join("\n"),
  };
}

export async function priorBatchResults(
  taskId: string,
  projectId: string,
): Promise<{ name: string; content: string } | undefined> {
  const done = (await getBatchStore().listBatches(projectId, 200).catch(() => []))
    .filter((b) => b.parent_task_id === taskId && b.joined_at && b.aggregate?.outputs?.length);
  if (!done.length) return undefined;
  return batchResultsPage(done.flatMap((b) => b.aggregate?.outputs ?? []));
}
