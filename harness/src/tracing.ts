// Observability. Every task and every contract event is traced. Two sinks:
//   - LocalLog (always on): one JSONL file per task under MYCEL_LOG_DIR.
//   - Langfuse (opt-in): full trace + timeline per task, self-hosted or cloud.
// Langfuse is dynamically imported so the harness has no hard dependency on it —
// `npm i langfuse` and set the keys to turn it on.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, type LangfuseConfig } from "./config";
import type { Task, TaskEvent } from "./contract";

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
    try {
      appendFileSync(join(this.dir, `${taskId}.jsonl`), JSON.stringify(ev) + "\n");
    } catch {
      /* logging must never break a task */
    }
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
      console.warn("[mycel] Langfuse tracing unavailable:", (e as Error).message);
      return null;
    }
  }

  onTaskStart(task: Task): void {
    const trace = this.lf.trace({
      id: task.id,
      name: `${task.wedge}:${task.task_type}`,
      input: task.input,
      metadata: { wedge: task.wedge, actor: task.actor },
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

let cached: Observer | null = null;

export async function getObserver(): Promise<Observer> {
  if (cached) return cached;
  const cfg = loadConfig();
  const observers: Observer[] = [new LocalLogObserver(cfg.logsDir)];
  if (cfg.langfuse) {
    const lf = await LangfuseObserver.create(cfg.langfuse);
    if (lf) observers.push(lf);
  }
  cached = new MultiObserver(observers);
  return cached;
}
