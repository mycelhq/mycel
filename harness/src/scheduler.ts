// The scheduler: recurring work. A Schedule spawns a task on a cadence, which is what turns a
// wedge from "answers a request" into "runs an operation" (daily sync, month-end close, weekly
// report, a follow-up cadence).
//
// Design notes:
//  - `nextRun` is a pure function of (cadence, from) so the awkward part (wall-clock math, month
//    rollover) is unit-testable without waiting on time.
//  - The tick CLAIMS due schedules through the store (advancing `next_run_at` in the same
//    transaction), so a slow task can't double-fire AND N replicas can't both fire one schedule —
//    on Postgres the claim uses FOR UPDATE SKIP LOCKED. This is the one piece of multi-instance
//    safety that needs no Redis, and it's the most dangerous one to get wrong: without it every
//    replica sends the client its own copy of the same email.
//  - Catch-up policy: a schedule that was due while the kernel was down fires ONCE on boot, then
//    resumes its cadence. We don't replay every missed occurrence — for a daily sync you want
//    today's run, not thirty of them.
import { getDeliverableStore } from "./deliverables";
import { randomUUID } from "node:crypto";
import type { Cadence, Schedule, Task } from "./contract";
import { loadConfig } from "./config";
import type { DomainStore } from "./domain";
import { runTask } from "./orchestrator";
import { ADVANCE_TASK_TYPE, advanceSequences } from "./gtm/sequence";
import { AUTONOMOUS_GTM_TASK_TYPE, runAutonomousGtm } from "./gtm/autonomous";
import { CHASE_SWEEP_TASK_TYPE, sweepOverdueInvoices } from "./dunning";
import { PAYMENT_SYNC_TASK_TYPE, reconcileProject } from "./payments";
import {
  CALENDAR_SYNC_TASK_TYPE,
  CRM_IMPORT_TASK_TYPE,
  importCrmClients,
  syncCalendar,
} from "./capability-import";
import { NUDGE_SWEEP_TASK_TYPE, sweepOpenRequests } from "./nudges";
import { WAIT_SWEEP_TASK_TYPE, sweepWaits } from "./waits";
import { AUTONOMY_SWEEP_TASK_TYPE, emptySweepBackoffSeconds, sweepAutonomousMoves } from "./autonomy";
import { RETAINER_SWEEP_TASK_TYPE, sweepRetainers } from "./money-plan.retainer";
import { BEGIN_FULFILLMENT_TASK_TYPE, sweepFulfillmentIgnition } from "./fulfillment-ignite";
import { getBillingStore } from "./billing";
import { getRequestStore } from "./requests";
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

/** Fire a schedule once: create its task and kick it off. Exported so `POST :id/run` reuses it.
 *
 * `skipIdle`: the scheduler tick passes true so a harness intercept that started nothing does
 * not mint a 0ms job the founder then sees as "Recent work". Manual Run still records a task.
 */
export async function fireSchedule(
  store: Store,
  domain: DomainStore,
  s: Schedule,
  now = new Date(),
  opts: { skipIdle?: boolean } = {},
): Promise<Task | null> {
  const cfg = loadConfig();
  const iso = now.toISOString();
  const makeTask = (): Task => ({
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
  });

  const skipIdle = opts.skipIdle === true;

  const recordOrSkip = async (
    work: Promise<{ idle: boolean; backoffSeconds?: number }>,
    onError: string,
  ): Promise<Task | null> => {
    if (skipIdle) {
      void work
        .then(async (outcome) => {
          if (outcome.idle) {
            const streak = Number((s.input as { empty_streak?: unknown } | undefined)?.empty_streak) || 0;
            const backoff = outcome.backoffSeconds ?? 0;
            if (backoff > 0) {
              await domain.updateSchedule(s.id, {
                next_run_at: new Date(now.getTime() + backoff * 1000).toISOString(),
                input: { ...s.input, empty_streak: streak + 1 },
              });
            }
            return;
          }
          const task = makeTask();
          await store.createTask(task);
          await store.setStatus(task.id, "succeeded");
          await domain.updateSchedule(s.id, {
            last_task_id: task.id,
            input: { ...s.input, empty_streak: 0 },
          });
        })
        .catch((e) => {
          console.error(onError, e);
        });
      return null;
    }
    const task = makeTask();
    await store.createTask(task);
    void work
      .then(async (outcome) => {
        if (outcome.idle && outcome.backoffSeconds) {
          await domain.updateSchedule(s.id, {
            next_run_at: new Date(now.getTime() + outcome.backoffSeconds * 1000).toISOString(),
          });
        }
        await store.setStatus(task.id, "succeeded");
      })
      .catch(async (e) => {
        console.error(onError, e);
        await store.setStatus(task.id, "failed", String((e as Error)?.message ?? e)).catch(() => {});
      });
    return task;
  };

  if (s.task_type === ADVANCE_TASK_TYPE) {
    return recordOrSkip(
      advanceSequences(store, domain, { project_id: s.project_id, now }).then((summary) => ({
        idle: summary.sent === 0 && summary.processed === 0 && summary.accepted === 0 && summary.replies === 0,
      })),
      "[mycel] outreach tick error:",
    );
  }

  if (s.task_type === AUTONOMOUS_GTM_TASK_TYPE) {
    // Discovery → propose, on the audience's cadence. The loop never throws (it soft-skips), and it
    // only proposes: every send still waits for the founder's approval envelope, unchanged.
    return recordOrSkip(
      runAutonomousGtm({ store, domain, project_id: s.project_id ?? "", now }).then((r) => ({
        idle: r.idle,
      })),
      "[mycel] autonomous GTM tick error:",
    );
  }

  if (s.task_type === PAYMENT_SYNC_TASK_TYPE) {
    return recordOrSkip(
      reconcileProject({ project_id: s.project_id ?? "", now }).then(() => ({ idle: false })),
      "[mycel] payment reconciliation error:",
    );
  }

  if (s.task_type === CRM_IMPORT_TASK_TYPE) {
    return recordOrSkip(
      importCrmClients({ project_id: s.project_id ?? "", now }).then(() => ({ idle: false })),
      "[mycel] CRM import error:",
    );
  }

  if (s.task_type === CALENDAR_SYNC_TASK_TYPE) {
    return recordOrSkip(
      syncCalendar({ project_id: s.project_id ?? "", now }).then(() => ({ idle: false })),
      "[mycel] calendar sync error:",
    );
  }

  if (s.task_type === CHASE_SWEEP_TASK_TYPE) {
    return recordOrSkip(
      sweepOverdueInvoices({ project_id: s.project_id ?? "", now }).then((summary) => {
        if (summary.skipped_because) throw new Error(summary.skipped_because);
        return { idle: summary.chased === 0 && summary.awaiting_answer === 0 };
      }),
      "[mycel] dunning sweep error:",
    );
  }

  if (s.task_type === NUDGE_SWEEP_TASK_TYPE) {
    return recordOrSkip(
      sweepOpenRequests({ domain, project_id: s.project_id ?? "", now }).then((summary) => ({
        idle: summary.nudged === 0,
      })),
      "[mycel] nudge sweep error:",
    );
  }

  if (s.task_type === WAIT_SWEEP_TASK_TYPE) {
    return recordOrSkip(
      sweepWaits({ domain, project_id: s.project_id ?? "", now }).then((summary) => ({
        idle: summary.resumed === 0 && summary.nudged === 0 && summary.expired === 0 && summary.progressed === 0,
      })),
      "[mycel] wait sweep error:",
    );
  }

  if (s.task_type === AUTONOMY_SWEEP_TASK_TYPE) {
    const streak = Number((s.input as { empty_streak?: unknown } | undefined)?.empty_streak) || 0;
    return recordOrSkip(
      sweepAutonomousMoves({
        stores: { domain, billing: getBillingStore(), requests: getRequestStore(), deliverables: getDeliverableStore() },
        project_id: s.project_id ?? "",
        now,
      }).then((summary) => ({
        idle: summary.started === 0,
        backoffSeconds: summary.started === 0 ? emptySweepBackoffSeconds(streak) : 0,
      })),
      "[mycel] autonomy sweep error:",
    );
  }

  if (s.task_type === RETAINER_SWEEP_TASK_TYPE) {
    return recordOrSkip(
      sweepRetainers({ domain, project_id: s.project_id ?? "", now }).then((summary) => {
        if (summary.skipped_because) {
          console.warn(`[mycel] retainer sweep for ${s.project_id}: ${summary.skipped_because}`);
        }
        return { idle: false };
      }),
      "[mycel] retainer sweep error:",
    );
  }

  if (s.task_type === BEGIN_FULFILLMENT_TASK_TYPE) {
    return recordOrSkip(
      sweepFulfillmentIgnition({ domain, store, project_id: s.project_id ?? "", now }).then((summary) => {
        if (summary.skipped_because) {
          console.warn(`[mycel] fulfillment ignition for ${s.project_id}: ${summary.skipped_because}`);
        }
        return { idle: summary.ignited === 0 && summary.closed === 0 };
      }),
      "[mycel] fulfillment ignition error:",
    );
  }

  const task = makeTask();
  await store.createTask(task);
  void runTask(store, task.id).catch((e) => console.error("[mycel] scheduled runTask error:", e));
  return task;
}


export function startScheduler(store: Store, domain: DomainStore, intervalMs = 15_000): SchedulerHandle {
  let running = false;

  async function tick(now = new Date()): Promise<string[]> {
    if (running) return []; // never overlap ticks within one replica
    running = true;
    const fired: string[] = [];
    try {
      // CLAIM, don't list. The store advances next_run_at inside the same transaction and (on
      // Postgres) uses FOR UPDATE SKIP LOCKED, so with N replicas exactly one wins each schedule.
      // This is what stops a client receiving N duplicate emails.
      const claimed = await domain.claimDueSchedules(now.toISOString(), (s, at) => nextRun(s.cadence, at).toISOString());
      for (const s of claimed) {
        try {
          const task = await fireSchedule(store, domain, s, now, { skipIdle: true });
          if (task) await domain.updateSchedule(s.id, { last_task_id: task.id });
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
