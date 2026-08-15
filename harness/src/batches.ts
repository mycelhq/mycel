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
 * After a child task finishes, try to join its batch and advance the parent out of `awaiting_batch`.
 *
 * Pure coordination: the caller owns loading children. Aggregate lives on the Batch row (not on
 * parent.input — Store forbids mutating input after create). Returns the joined batch when join
 * fired, otherwise undefined.
 */
export async function onChildFinished(
  store: Store,
  child: Task,
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
    await store.setStatus(
      parent.id,
      joined.status === "succeeded" ? "succeeded" : "failed",
      joined.status === "failed" ? "batch joined with no successful children" : undefined,
    );
    await store.appendEvent(parent.id, "task.finished", {
      status: joined.status === "succeeded" ? "succeeded" : "failed",
      batch_id: joined.id,
    });
  }
  return joined;
}
