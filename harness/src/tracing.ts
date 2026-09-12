// Observability. Every task and every contract event is traced. Two sinks:
//   - LocalLog (always on): one JSONL file per task under MYCEL_LOG_DIR.
//   - Langfuse (opt-in): an OPERATOR'S OWN sink, not a product feature. Dynamically imported and
//     inert unless LANGFUSE_SECRET_KEY + LANGFUSE_PUBLIC_KEY are set, so `npm i langfuse` plus your
//     own keys points every trace at your own Langfuse org. Nobody is provisioned one by us.
//
// READ THIS BEFORE RE-ADDING PER-PROJECT PROVISIONING. There used to be a `langfuse.provision.ts`
// that created a Langfuse project per Mycel project and minted per-project keys, so each business
// got its own isolated tracing. It called Langfuse's Organization Management API, which does not
// exist on Langfuse Cloud on any plan — self-hosted Enterprise only. It could never have worked
// against the deployment it was written for, and it is gone.
//
// What replaced it for CUSTOMERS is `traces.ts`: the durable event log, folded into a span tree and
// served at `GET /v1/tasks/:id/trace` under the same scope check as the task. That is the tenant-safe
// trace view. Langfuse below is for whoever runs this kernel debugging their own agent, nothing more.
import { mkdirSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig, type LangfuseConfig } from "./config";
import type { Task, TaskEvent } from "./contract";

// Non-blocking JSONL appends, serialized per file so lines never interleave and the event loop is
// never blocked on disk (important while streaming token.delta events).
const chains = new Map<string, Promise<void>>();
function appendLine(path: string, line: string): void {
  const prev = chains.get(path) ?? Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(() => appendFile(path, line))
    .catch(() => {
      /* logging must never break a task */
    });
  chains.set(path, next);
}

/**
 * Wait for queued log writes to reach disk.
 *
 * Appends are deliberately fire-and-forget so a `token.delta` stream never blocks on disk, which
 * means at shutdown the tail of a run is still sitting in memory. Called from the SIGTERM path so a
 * restart doesn't silently truncate the record of what an agent just did — the log is the thing you
 * go back to when a customer asks why the business sent that.
 */
export async function flushLogs(): Promise<void> {
  await Promise.allSettled([...chains.values()]);
}

export interface Observer {
  onTaskStart(task: Task): void | Promise<void>;
  onEvent(taskId: string, ev: TaskEvent): void | Promise<void>;
  onTaskEnd(taskId: string, status: string): void | Promise<void>;
}

class LocalLogObserver implements Observer {
  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true });
  }
  onTaskStart(): void {}
  onEvent(taskId: string, ev: TaskEvent): void {
    appendLine(join(this.dir, `${taskId}.jsonl`), JSON.stringify(ev) + "\n");
  }
  onTaskEnd(): void {}
}

class LangfuseObserver implements Observer {
  private traces = new Map<string, any>();
  private constructor(private lf: any) {}

  static async create(cfg: LangfuseConfig): Promise<LangfuseObserver | null> {
    try {
      const pkg = "langfuse";
      const mod: any = await import(pkg);
      const Langfuse = mod.Langfuse ?? mod.default;
      const lf = new Langfuse({
        secretKey: cfg.secretKey,
        publicKey: cfg.publicKey,
        baseUrl: cfg.baseUrl,
      });
      return new LangfuseObserver(lf);
    } catch (e) {
      console.warn(
        "[mycel] Langfuse keys are set but tracing is NOT running:",
        (e as Error).message,
        "\n         Run `npm install langfuse` in the kernel to enable it.",
      );
      return null;
    }
  }

  onTaskStart(task: Task): void {
    // Everything goes to ONE Langfuse project — the operator's own. There is no per-tenant project
    // to route to (see the header), so tags are the only segmentation there is: without project_id
    // a multi-tenant operator's traces are indistinguishable except by raw task id.
    //
    // Tags as well as metadata, because Langfuse can filter a trace list by tag — that is what makes
    // a per-project view possible at all, rather than just visible once you already found the trace.
    // Note this is an operator convenience, NOT a tenancy boundary; the boundary is the scope check
    // on `GET /v1/tasks/:id/trace`, and nothing customer-facing reads from here.
    const tags = [
      `project:${task.project_id ?? "none"}`,
      `wedge:${task.wedge}`,
      ...(task.case_id ? [`case:${task.case_id}`] : []),
    ];
    const trace = this.lf.trace({
      id: task.id,
      name: `${task.wedge}:${task.task_type}`,
      input: task.input,
      tags,
      metadata: {
        project_id: task.project_id ?? null,
        wedge: task.wedge,
        task_type: task.task_type,
        case_id: task.case_id ?? null,
        actor: task.actor,
      },
    });
    this.traces.set(task.id, trace);
  }

  onEvent(taskId: string, ev: TaskEvent): void {
    const trace = this.traces.get(taskId);
    if (!trace) return;
    try {
      trace.event({ name: ev.type, metadata: ev.data, startTime: new Date(ev.ts) });
    } catch {
      /* noop */
    }
  }

  async onTaskEnd(taskId: string, status: string): Promise<void> {
    const trace = this.traces.get(taskId);
    try {
      trace?.update?.({ output: { status } });
    } catch {
      /* noop */
    }
    this.traces.delete(taskId);
    try {
      await this.lf.flushAsync();
    } catch {
      /* noop */
    }
  }
}

class MultiObserver implements Observer {
  constructor(private observers: Observer[]) {}
  async onTaskStart(task: Task): Promise<void> {
    for (const o of this.observers) await o.onTaskStart(task);
  }
  async onEvent(taskId: string, ev: TaskEvent): Promise<void> {
    for (const o of this.observers) await o.onEvent(taskId, ev);
  }
  async onTaskEnd(taskId: string, status: string): Promise<void> {
    for (const o of this.observers) await o.onTaskEnd(taskId, status);
  }
}

// Every model call routed through proxy mode is logged here (the "everything is traced" goal).
export function traceLlmCall(entry: {
  task_id: string;
  model: string;
  path: string;
  status: number;
  ms: number;
}): void {
  const dir = loadConfig().logsDir;
  if (!llmDirReady) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      /* noop */
    }
    llmDirReady = true;
  }
  appendLine(join(dir, "llm.jsonl"), JSON.stringify({ ...entry, ts: new Date().toISOString() }) + "\n");
}
let llmDirReady = false;

let cached: Observer | null = null;

/**
 * The process-wide observer.
 *
 * One observer for the whole kernel, not one per project. The per-project variant existed only to
 * hold per-project Langfuse keys, and those came from provisioning that cannot work (see the header).
 * Tenancy on traces is enforced on the READ side — `GET /v1/tasks/:id/trace` takes the same scope
 * check as the task itself — which is where it belonged all along.
 */
export async function getObserver(): Promise<Observer> {
  if (cached) return cached;
  const cfg = loadConfig();
  const observers: Observer[] = [new LocalLogObserver(cfg.logsDir)];
  if (cfg.langfuse) {
    const lf = await LangfuseObserver.create(cfg.langfuse);
    // Null means the optional `langfuse` package isn't installed; it has already warned. A missing
    // debugging sink must never fail a customer's run, so we carry on with the local log.
    if (lf) observers.push(lf);
  }
  cached = new MultiObserver(observers);
  return cached;
}

// ── test seams ──
// Exported so the two sinks can be driven directly. The Langfuse one otherwise needs a live account
// and a network round trip to exercise at all, which is why it went untested for so long — and its
// failure mode is silence, so "untested" reads exactly like "working".
export function _langfuseObserverForTest(fake: unknown): Observer {
  return new (LangfuseObserver as unknown as new (lf: unknown) => LangfuseObserver)(fake);
}
export function _localObserverForTest(dir: string): Observer {
  return new LocalLogObserver(dir);
}
