// The scheduler: recurring work. A Schedule spawns a task on a cadence, which is what turns a
// wedge from "answers a request" into "runs an operation" (daily sync, month-end close, weekly
// report, a follow-up cadence).
//
// Design notes:
//  - `nextRun` is a pure function of (cadence, from) so the awkward part (wall-clock math, month
//    rollover) is unit-testable without waiting on time.
//  - The tick loop is in-process and advances `next_run_at` BEFORE running, so a slow task can't
//    cause a double-fire. Single-instance (like cancel/grants/bus); a shared lock is what this
//    needs to run multi-instance, and that lands with the Redis work.
//  - Catch-up policy: a schedule that was due while the kernel was down fires ONCE on boot, then
//    resumes its cadence. We don't replay every missed occurrence — for a daily sync you want
//    today's run, not thirty of them.
import { randomUUID } from "node:crypto";
import type { Cadence, Schedule, Task } from "./contract";
import { loadConfig } from "./config";
import type { DomainStore } from "./domain";
import { runTask } from "./orchestrator";
import type { Store } from "./store";

/** The next due time strictly after `from`. Pure — no clock reads. UTC throughout. */
export function nextRun(cadence: Cadence, from: Date): Date {
  if (cadence.kind === "every") {
    const secs = Math.max(1, Math.floor(cadence.seconds));
    return new Date(from.getTime() + secs * 1000);
  }
  if (cadence.kind === "daily") {
    const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), cadence.hour, cadence.minute, 0, 0));
    if (d.getTime() <= from.getTime()) d.setUTCDate(d.getUTCDate() + 1);
    return d;
  }
  // monthly — clamp to the last day of the target month (day 31 in February → the 28th/29th)
  const build = (year: number, month: number) => {
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const day = Math.min(Math.max(1, cadence.day), lastDay);
    return new Date(Date.UTC(year, month, day, cadence.hour, cadence.minute, 0, 0));
  };
  let d = build(from.getUTCFullYear(), from.getUTCMonth());
  if (d.getTime() <= from.getTime()) d = build(from.getUTCFullYear(), from.getUTCMonth() + 1);
  return d;
}

/** First run for a brand-new schedule: the next occurrence after now. */
export function firstRun(cadence: Cadence, now = new Date()): string {
  return nextRun(cadence, now).toISOString();
}

export interface SchedulerHandle {
  stop(): void;
  /** Run one tick immediately (used by tests). Returns the ids of schedules that fired. */
  tick(now?: Date): Promise<string[]>;
}

/** Fire a schedule once: create its task and kick it off. Exported so `POST :id/run` reuses it. */
export async function fireSchedule(
  store: Store,
  domain: DomainStore,
  s: Schedule,
  now = new Date(),
): Promise<Task> {
  const cfg = loadConfig();
  const iso = now.toISOString();
  const task: Task = {
    id: randomUUID(),
    project_id: s.project_id,
    wedge: s.wedge,
    task_type: s.task_type,
    actor: { kind: "system", id: `schedule:${s.id}` },
    input: { ...s.input, scheduled_at: iso, schedule_id: s.id, schedule_name: s.name },
    constraints: {
      max_runtime_s: Math.min(1800, cfg.maxRuntimeCeilingS),
      max_cost_usd: Math.min(5, cfg.maxCostCeilingUsd),
      approval_required: false,
    },
    tools: [],
    status: "queued",
    cost_usd: 0,
    created_at: iso,
    updated_at: iso,
  };
  await store.createTask(task);
  void runTask(store, task.id).catch((e) => console.error("[mycel] scheduled runTask error:", e));
  return task;
}

/** Start the tick loop. Returns a handle so shutdown (and tests) can stop it. */
export function startScheduler(store: Store, domain: DomainStore, intervalMs = 15_000): SchedulerHandle {
  let running = false;

  async function tick(now = new Date()): Promise<string[]> {
    if (running) return []; // never overlap ticks
    running = true;
    const fired: string[] = [];
    try {
      for (const s of await domain.listDueSchedules(now.toISOString())) {
        // Advance FIRST so a slow or failing task can't cause a double-fire.
        const next = nextRun(s.cadence, now).toISOString();
        await domain.updateSchedule(s.id, { next_run_at: next, last_run_at: now.toISOString() });
        try {
          const task = await fireSchedule(store, domain, s, now);
          await domain.updateSchedule(s.id, { last_task_id: task.id });
          fired.push(s.id);
        } catch (e) {
          console.error(`[mycel] schedule ${s.name} failed to fire:`, e);
        }
      }
    } catch (e) {
      console.error("[mycel] scheduler tick error:", e);
    } finally {
      running = false;
    }
    return fired;
  }

  const timer = setInterval(() => void tick(), intervalMs);
  (timer as { unref?: () => void }).unref?.();
  // one tick shortly after boot handles anything that came due while we were down
  const boot = setTimeout(() => void tick(), 1_000);
  (boot as { unref?: () => void }).unref?.();

  return {
    stop() {
      clearInterval(timer);
      clearTimeout(boot);
    },
    tick,
  };
}
