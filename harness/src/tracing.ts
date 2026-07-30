// Observability. Every task and every contract event is traced. Two sinks:
//   - LocalLog (always on): one JSONL file per task under MYCEL_LOG_DIR.
//   - Langfuse (opt-in): full trace + timeline per task, self-hosted or cloud.
// Langfuse is dynamically imported so the harness has no hard dependency on it —
// `npm i langfuse` and set the keys to turn it on.
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
    // `project_id` is the tenancy key, and it has to be here.
    //
    // The cloud design is deliberately ONE Langfuse project with traces tagged per tenant, because
    // creating a Langfuse project per customer needs the Instance Management API, which is
    // Enterprise Edition. That design only works if there is something to filter on — without
    // project_id, every tenant's traces are indistinguishable except by raw task id, and the
    // "segmented by tags" plan has no segment.
    //
    // Tags as well as metadata: Langfuse can filter a trace list by tag, so these are what make a
    // per-project view possible at all, rather than just visible once you already found the trace.
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
 * Whether Langfuse is off, wired up, or configured-but-broken.
 *
 * The third state is the dangerous one and used to be invisible: the `langfuse` package is an
 * optional peer installed by the setup script only if you opt in, so setting the keys later gives you
 * a single `console.warn` at boot and no traces — while any UI that keys off "are the keys set?"
 * cheerfully shows a traces link pointing at an empty dashboard. Reported so the UI can tell the
 * difference instead of guessing.
 */
export type TracingState = "off" | "active" | "unavailable";
let tracingState: TracingState = "off";
export function langfuseState(): TracingState {
  return tracingState;
}

export async function getObserver(): Promise<Observer> {
  if (cached) return cached;
  const cfg = loadConfig();
  const observers: Observer[] = [new LocalLogObserver(cfg.logsDir)];
  if (cfg.langfuse) {
    const lf = await LangfuseObserver.create(cfg.langfuse);
    if (lf) observers.push(lf);
    tracingState = lf ? "active" : "unavailable";
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
