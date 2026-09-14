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
import { getIdentityStore } from "./identity";
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
import { OPEN_ENGAGEMENTS_TASK_TYPE, sweepStrandedClients } from "./engagement-sweep";
import { getBillingStore } from "./billing";
import { deliveryRefusal } from "./delivery-precondition";
import { loadProjectWedge } from "./authored";
import { getRequestStore } from "./requests";
import { scheduleWait } from "./waiting-on-client";
import { fillScheduleInput } from "./schedule-input";
import { inputFaults } from "./input-contract";
import { loadWedge } from "./wedge";
import type { Store } from "./store";

/**
 * ═══ WHY A WALL-CLOCK CADENCE NEEDS A KEY ═══
 *
 * `daily`, `weekly` and `monthly` pin to an exact hour and minute, so every schedule that shares a
 * cadence fires in the SAME SECOND. That is fine with one project and is a thundering herd with
 * seventeen.
 *
 * It was one. On 2026-09-05 production held 17 projects, each with its own `reflect_memory` at
 * 03:00, `review_work` at 04:00 and `review_artifacts` at 05:00 — three bursts of seventeen
 * simultaneous runs every night, confirmed in the task table as 17 rows sharing a created_at to the
 * second. Each run wants a 10 GiB sandbox, so each burst demanded 170 GiB against a 300 GiB quota
 * that already had 135 GiB of snapshots in it. The nightly `Total disk limit exceeded` cluster at
 * 03:00-05:00 was this, and no amount of cleaning up after runs can fix it: those seventeen
 * sandboxes are all legitimately alive at once.
 *
 * So a schedule may pass a stable `key` — its id — and get a deterministic offset inside the hour
 * it asked for. Same key always lands on the same minute and second, so a schedule does not wander
 * night to night, and seventeen different keys spread across the hour instead of stacking.
 *
 * WITHOUT A KEY THE BEHAVIOUR IS EXACTLY AS BEFORE. The offset is zero, every existing caller and
 * every existing test sees the same instants it always did, and the spreading is opt-in at the one
 * call site that actually knows a schedule's identity.
 *
 * `every` cadences are deliberately not offset. They are relative to when they last ran rather than
 * to a wall clock, so they only collide when they were created together, and shifting them would
 * change the interval a caller explicitly asked for.
 *
 */
function spreadSeconds(key: string | undefined): number {
  if (!key) return 0;
  // FNV-1a, then the murmur3 finalizer. Small, dependency-free, and this picks a start time — it
  // is not protecting anything.
  //
  // The finalizer is not decoration. FNV alone walks LINEARLY across keys that differ by one
  // character: ids ending 0,1,2,3 came out seven minutes apart in a fixed progression, so a run of
  // adjacent keys re-collided after wrapping the hour. Schedule ids are uuids and would have hidden
  // that, which is exactly why it is worth fixing — the day someone keys this on `project-1`,
  // `project-2` the spreading silently stops working.
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  h >>>= 0;
  return h;
}

/**
 * The offset for a cadence, in seconds, GUARANTEED to stay inside the hour it asked for.
 *
 * The first version was `h % (55 * 60)` added to the seconds field, which is correct only when the
 * cadence asks for minute 0. A `daily 07:30` — `seed-demo.ts` has one — could take a 55-minute
 * offset and land at 08:25, in the next hour, contradicting the whole promise that a three-o'clock
 * job stays a three-o'clock job. Every test covered `minute: 0`.
 *
 * So the room is what is actually left: 55 minutes minus whatever minute was requested, floored at
 * one minute so a cadence at :58 still gets a little spread rather than a division by zero.
 */
function spreadFor(key: string | undefined, minute: number): number {
  if (!key) return 0;
  const room = Math.max(60, (55 - Math.min(55, Math.max(0, Math.floor(minute)))) * 60);
  return spreadSeconds(key) % room;
}

/** The next due time strictly after `from`. Pure — no clock reads. UTC throughout. */
export function nextRun(cadence: Cadence, from: Date, key?: string): Date {
  if (cadence.kind === "every") {
    const secs = Math.max(1, Math.floor(cadence.seconds));
    return new Date(from.getTime() + secs * 1000);
  }
  const spread = spreadFor(key, cadence.minute);
  /**
   * THE ADVANCE CHECK USES THE UNSPREAD BASE, and that ordering is the whole of a migration bug.
   *
   * With the check applied AFTER the offset, a legacy row sitting at 03:00:00 and claimed at
   * 03:00:05 recomputed to today 03:00:47 — still in the future, so it fired a SECOND time the same
   * night, once per schedule, on the first night after the deploy.
   *
   * Comparing the base means "has three o'clock already happened today" is answered independently
   * of where this particular schedule sits inside the hour, which is the question that was actually
   * being asked.
   */
  if (cadence.kind === "daily") {
    const base = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), cadence.hour, cadence.minute, 0, 0);
    const d = new Date(base + spread * 1000);
    if (base <= from.getTime()) d.setUTCDate(d.getUTCDate() + 1);
    return d;
  }
  if (cadence.kind === "weekly") {
    // Same shape as `daily`, then walk forward to the requested weekday. `weekday` is normalised
    // into 0..6 rather than trusted: a manifest with `weekday: 7` meaning Sunday would otherwise
    // produce a date seven days out and quietly become a fortnightly schedule.
    const want = ((Math.floor(cadence.weekday) % 7) + 7) % 7;
    const base = new Date(
      Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), cadence.hour, cadence.minute, 0, 0),
    );
    // Days until the target weekday. 0 when it is already today, which is why the `<= from` check
    // below still has to advance a full week rather than a single day.
    const delta = (want - base.getUTCDay() + 7) % 7;
    if (delta > 0) base.setUTCDate(base.getUTCDate() + delta);
    if (base.getTime() <= from.getTime()) base.setUTCDate(base.getUTCDate() + 7);
    return new Date(base.getTime() + spread * 1000);
  }
  // monthly — clamp to the last day of the target month (day 31 in February → the 28th/29th)
  const build = (year: number, month: number) => {
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const day = Math.min(Math.max(1, cadence.day), lastDay);
    return Date.UTC(year, month, day, cadence.hour, cadence.minute, 0, 0);
  };
  let base = build(from.getUTCFullYear(), from.getUTCMonth());
  if (base <= from.getTime()) base = build(from.getUTCFullYear(), from.getUTCMonth() + 1);
  return new Date(base + spread * 1000);
}

/**
 * First run for a brand-new schedule: the next occurrence after now.
 *
 * PASS A KEY. Keying only the claim path (scheduler tick) spreads the SECOND run and leaves the
 * first one stacked — which is the burst, on the night a batch of projects is provisioned. Creation
 * has no schedule id yet, so callers key on `scheduleKey(projectId, taskType)`; the tick keys on
 * `s.id` once the row exists. The two differ, so a schedule's first run sits on a different minute
 * from its later ones. That is harmless — both are spread — and it is worth saying out loud so the
 * next reader does not treat it as a bug.
 */
export function firstRun(cadence: Cadence, now = new Date(), key?: string): string {
  return nextRun(cadence, now, key).toISOString();
}

/** The creation-time spread key. One per (project, task type), which is what collides. */
export function scheduleKey(projectId: string | undefined, taskType: string): string {
  return `${projectId ?? "-"}:${taskType}`;
}

export interface SchedulerHandle {
  stop(): void;
  /** Run one tick immediately (used by tests). Returns the ids of schedules that fired. */
  tick(now?: Date): Promise<string[]>;
  /**
   * Ask every project what clocks it should have, now. Returns how many were newly armed.
   *
   * Exposed so a test can assert the thing that was missing rather than the timer that calls it —
   * "a dormant project acquires its schedules" is the property, and a `setInterval` is not evidence
   * of it.
   */
  upkeepAll(): Promise<number>;
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
  /**
   * ═══ A CLOCK ON A DEAD PLAN IS A CLOCK THAT CAN ONLY PRODUCE FAILURES ═══
   *
   * `workBlockedBy` refuses `none` (never subscribed) and `cancelled` (was paying, stopped), and
   * `POST /v1/tasks` and `triggers.ts` both honour it. THIS PATH DID NOT: `fireSchedule` calls
   * `store.createTask` directly, so a schedule left enabled on a cancelled org kept minting task
   * rows on its cadence, every one of them refused further down.
   *
   * Found in production: a cancelled org and a never-subscribed one were carrying nine live
   * schedules between them. Cheap per run and endless — and it is the kind of cost that arrives as
   * a surprise, because nothing about a cancelled account suggests it is still doing anything.
   *
   * Fails OPEN on an unreadable org, like every other plan check in this codebase: a blipped
   * identity read must not silently stop a paying founder's clock. The only direction this can be
   * wrong is to run something it could have skipped.
   */
  const orgId = s.project_id ? await getIdentityStore().orgIdForProject(s.project_id).catch(() => undefined) : undefined;
  if (orgId && getIdentityStore().workBlockedBy(orgId)) return null;

  const cfg = loadConfig();
  const iso = now.toISOString();
  const makeTask = (): Task => ({
    id: randomUUID(),
    project_id: s.project_id,
    wedge: s.wedge,
    task_type: s.task_type,
    actor: { kind: "system", id: `schedule:${s.id}` },
    /*
      Tokens filled from the clock BEFORE the fixed fields are stamped on, so a template can never
      shadow `scheduled_at` with a token of its own. See `schedule-input.ts` — a closed vocabulary,
      five entries, whole-value only.
    */
    input: { ...fillScheduleInput(s.input, now), scheduled_at: iso, schedule_id: s.id, schedule_name: s.name },
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
      sweepOverdueInvoices({ project_id: s.project_id ?? "", now }).then((summary) => ({
        // `skipped_because` is informational, NOT an error — dunning.ts sets it for "invoices are
        // due but this business has no mailbox connected, so nothing was written". Throwing it (as
        // this used to) marked the run failed and logged a hard error EVERY sweep — the single
        // loudest line in prod. A sweep that chased nothing because it has no hands is idle: it
        // backs off quietly, and the reason already rides on the summary record for anyone reading
        // it. Only an actual thrown exception from the sweep is an error now.
        idle: summary.chased === 0 && summary.awaiting_answer === 0,
      })),
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

  /*
    ONE STEP BEFORE IGNITION. `begin_fulfillment` starts production on OPEN ENGAGEMENTS; this opens
    the engagement for a client that never got one. They are armed on different facts on purpose —
    ignition wants an engagement to exist, and this one exists because sometimes none does.
  */
  if (s.task_type === OPEN_ENGAGEMENTS_TASK_TYPE) {
    return recordOrSkip(
      sweepStrandedClients({ domain, store, project_id: s.project_id ?? "" }).then((summary) => {
        if (summary.opened > 0) {
          console.log(
            `[mycel] engagements for ${s.project_id}: opened ${summary.opened} of ${summary.stranded} stranded client(s)`,
          );
        }
        /**
         * A business whose service cannot be resolved is the case worth a line, because it is the
         * one a human has to settle: either the shape never landed, or the firm runs two producing
         * services and nothing may choose between them. Silent, it looks exactly like health.
         */
        if (summary.no_service > 0) {
          console.warn(
            `[mycel] engagements for ${s.project_id}: ${summary.no_service} client(s) have no live service to open against`,
          );
        }
        if (summary.failed.length) {
          console.error(`[mycel] engagements for ${s.project_id}: ${summary.failed.join("; ")}`);
        }
        // Opening an engagement is work. Only a sweep that found nothing stranded is idle.
        return { idle: summary.stranded === 0 };
      }),
      "[mycel] engagement sweep error:",
    );
  }

  if (s.task_type === BEGIN_FULFILLMENT_TASK_TYPE) {
    return recordOrSkip(
      sweepFulfillmentIgnition({ domain, store, project_id: s.project_id ?? "", now }).then((summary) => {
        if (summary.skipped_because) {
          console.warn(`[mycel] fulfillment ignition for ${s.project_id}: ${summary.skipped_because}`);
        }
        /**
         * A sweep that RETIRED a case is not idle. `idle` feeds the scheduler's own health signal,
         * and the first version of this returned true whenever nothing ignited — so giving up on an
         * engagement made the sweep look quieter than a sweep that did nothing at all.
         */
        if (summary.exhausted + summary.producing_nothing > 0) {
          console.error(
            `[mycel] fulfillment ignition for ${s.project_id}: ${summary.exhausted + summary.producing_nothing} engagement(s) retired — ${summary.failed.join("; ")}`,
          );
        }
        /**
         * Worth a line, because it is the new common case and it used to be three thousand runs.
         * Not an error: an engagement waiting on a client is the correct state, and the founder
         * already sees it on `/requests` with an age against it. This is what makes it diagnosable
         * from a log when somebody asks why a desk went quiet.
         */
        if (summary.waiting_on_client > 0) {
          console.log(
            `[mycel] fulfillment ignition for ${s.project_id}: ${summary.waiting_on_client} engagement(s) waiting on a client answer`,
          );
        }
        // `producing_nothing` retires a case exactly as `exhausted` does, so it owes `idle` the same
        // honesty — see the note above. Omitting it would recreate the bug one counter over.
        return {
          idle:
            summary.ignited === 0 &&
            summary.closed === 0 &&
            summary.exhausted === 0 &&
            summary.producing_nothing === 0,
        };
      }),
      "[mycel] fulfillment ignition error:",
    );
  }

  /**
   * ═══ THE LAST GATE, AND THE ONE THAT COST THE MOST ═══
   *
   * Everything above this line is a SWEEP — sequences, chases, nudges, waits, imports. Those must
   * never be held by an open request; `NUDGE_SWEEP_TASK_TYPE` exists precisely to chase open
   * requests, and holding it because one is open would switch off the only thing that closes them.
   *
   * Below this line is WEDGE WORK: a real task, a real sandbox, a real model. This is where
   * `monthly_close` fired 3,077 times across two engagements — one every 31 minutes for a
   * fortnight — each run refusing for the same missing bank statement. It is the single largest
   * line item behind "90% of model spend produced no deliverable", and none of it was a model
   * failure: it was asked to close a month, it had no statement, it asked, it stopped, and the
   * clock fired again.
   *
   * `fulfillment-ignite` already learned this on its own path — its `waiting_on_client` counter
   * carries the note "it used to be three thousand runs" — and the lesson never reached here,
   * which is the branch that mints the expensive ones.
   *
   * FAILS OPEN, like the plan check at the top of this function. An unreadable request store must
   * not stop a paying founder's clock; the only direction this can be wrong is to run something it
   * could have skipped, which is exactly what happens today.
   */
  if (s.project_id) {
    const caseId = typeof s.input?.case_id === "string" ? s.input.case_id : undefined;
    const verdict = await getRequestStore()
      .listRequests({ project_id: s.project_id, status: "open", ...(caseId ? { case_id: caseId } : {}) })
      .then((open) =>
        scheduleWait({
          open,
          caseId,
          lastTaskId: s.last_task_id,
          streak: Number((s.input as { wait_streak?: unknown } | undefined)?.wait_streak) || 0,
        }),
      )
      .catch(() => null);

    if (verdict?.wait) {
      /*
        A WAIT, NOT A FAILURE, and not a disable. The schedule stays enabled and its clock moves;
        answering the request is the only thing that has to happen for work to resume. A schedule
        switched off because a client was slow is one somebody has to remember to switch back on,
        and nobody does.

        The streak is stored on the schedule's own input rather than derived, because the ladder is
        about consecutive HELD firings and nothing else in the row records that. It is cleared the
        moment a firing gets through, at the bottom of this function.
      */
      const streak = Number((s.input as { wait_streak?: unknown } | undefined)?.wait_streak) || 0;
      await domain.updateSchedule(s.id, {
        next_run_at: new Date(now.getTime() + verdict.backoffSeconds * 1000).toISOString(),
        input: { ...s.input, wait_streak: streak + 1 },
      });
      console.log(
        `[mycel] ${s.name} (${s.task_type}) held: ${verdict.reason} — next check in ${Math.round(verdict.backoffSeconds / 3600)}h`,
      );
      return null;
    }
  }

  /**
   * ═══ AND DOES THE INPUT SATISFY WHAT THIS TASK TYPE SAYS IT NEEDS? ═══
   *
   * `POST /v1/tasks` has asked this since input contracts shipped. THIS PATH NEVER HAS, and this
   * path fires almost every run in production.
   *
   * What that cost, measured by running `inputFaults` over the shipped blueprints: TWO of the nine
   * scheduled templates violate their own task type's contract, and they are the two highest-volume
   * jobs in the product. `books-keeper/monthly_close` is scheduled with `input: {}` while declaring
   * `period` REQUIRED — 3,077 runs across two engagements in a fortnight, each a close of nothing.
   * `geo-monitor/weekly_report` was declaring `client` required and never being given one.
   *
   * REFUSES TO FIRE rather than deferring. This is not the wait above it and the difference is the
   * whole point: an unanswered client request resolves itself when somebody replies, so it defers.
   * A template that cannot satisfy its contract will fail identically at every future firing, so
   * deferring it is a slower version of the same burn. It is a product bug, not a founder's, which
   * is why it is loud in the log and why `blueprint-schedules-satisfy-their-contract.test.ts` now
   * makes it impossible to ship a tenth one.
   */
  /*
    `loadWedge` is synchronous and returns null for an AUTHORED slug — a service that belongs to one
    project and lives in a project-scoped table rather than on disk, which this function has no
    tenant in hand to read. That resolves to no declared contract, which resolves to no opinion, and
    that is the right answer rather than a gap: `inputFaults` refuses to invent a contract it was not
    given, and an authored service's own manifest is checked when it is written.
  */
  const declared = (
    loadWedge(s.wedge)?.manifest.task_types as Record<string, { input_schema?: unknown }> | undefined
  )?.[s.task_type];
  const faults = inputFaults(
    { ...fillScheduleInput(s.input, now), scheduled_at: iso, schedule_id: s.id, schedule_name: s.name },
    declared?.input_schema,
  );
  if (faults.length) {
    console.error(
      `[mycel] ${s.name} (${s.wedge}/${s.task_type}) cannot fire: its input does not satisfy the contract — ${faults.join("; ")}. The schedule template needs fixing; nothing was run.`,
    );
    return null;
  }

  /**
   * ═══ AND NOBODY AT THE OTHER END IS ALSO A REASON NOT TO FIRE ═══
   *
   * The check above asks whether the input satisfies the contract. This one asks whether there is
   * anyone to hand the result to, and it is the same trade for the same reason: a fulfilment job in
   * a business with no clients will produce an artifact nobody can receive, at every firing, for as
   * long as the schedule is on.
   *
   * Measured, in production, before this existed: a founder's own written service ran
   * `shape_brand_strategy` six times across five days with `client_id = NULL`, succeeded five
   * times, and left zero deliverables — see `delivery-precondition.ts` for the whole run.
   *
   * `loadProjectWedge` rather than `loadWedge`, because the services this protects are exactly the
   * ones that are not on disk. It is the only async read added to this path and it is skipped for
   * every schedule whose project has clients, which after week one is all of them.
   */
  const manifest = skipIdle
    ? await loadProjectWedge(s.project_id ?? "", s.wedge)
        .then((w) => w?.manifest)
        .catch(() => undefined)
    : undefined;
  /*
    ONLY ON THE UNATTENDED TICK, and the distinction is the whole point of the rule.

    `skipIdle` is set by the tick loop and by nothing else — a founder pressing "run it now", a
    blueprint activating, and a service going live all call this directly, and every one of those is
    a deliberate act by somebody who is watching. Refusing THEM is a gate in front of the one person
    entitled to decide, which is the opposite of what this is for: the waste being stopped is a
    schedule spending a sandbox every morning on work with no recipient, for as long as nobody
    notices.
  */
  if (manifest && skipIdle) {
    const clients = (await domain.listClients()).filter((c) => c.project_id === s.project_id).length;
    const refusal = deliveryRefusal({
      wedge: s.wedge,
      manifest,
      taskType: s.task_type,
      clients,
      clientId: typeof s.input?.client_id === "string" ? s.input.client_id : undefined,
      caseId: typeof s.input?.case_id === "string" ? s.input.case_id : undefined,
    });
    if (refusal) {
      console.error(
        `[mycel] ${s.name} (${s.wedge}/${s.task_type}) did not fire: ${refusal.message}`,
      );
      /*
        The schedule is NOT disabled. A founder who adds their first client tomorrow should find the
        desk already running, not a switch they have to notice is off — and disabling it here would
        be the product silently undoing a decision the founder made.
      */
      return null;
    }
  }

  const task = makeTask();
  await store.createTask(task);
  /*
    Cleared on a firing that got through, so a client who answers after four held checks does not
    leave the next hold starting at sixteen days. Best-effort: a failed write here costs one
    over-long backoff, never a missed run.
  */
  if (Number((s.input as { wait_streak?: unknown } | undefined)?.wait_streak) > 0) {
    await domain
      .updateSchedule(s.id, { input: { ...s.input, wait_streak: 0 } })
      .catch(() => {});
  }
  void runTask(store, task.id).catch((e) => console.error("[mycel] scheduled runTask error:", e));
  return task;
}


/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * HOW OFTEN EVERY PROJECT IS ASKED WHAT CLOCKS IT SHOULD HAVE
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Ten minutes, and its absence was a hole under everything else in this file.
 *
 * `ensureUpkeep` is what creates a project's schedules, and until now it had exactly ONE caller:
 * `GET /v1/upkeep`, which fires when a founder opens a page. The tick below claims DUE SCHEDULES —
 * so a project with no schedules is invisible to it, and a project whose founder has not logged in
 * since signup can never acquire one. Dormant is self-sealing.
 *
 * That is why the engagement sweep could not have worked without this. Meridian Growth Studio was
 * shaped on 9 September, added a client two minutes later, and has had nobody log in since; arming
 * its sweep from a page visit would have meant arming it never, for exactly the accounts that need
 * it most. The same is true of every sweep anyone adds here in future.
 *
 * CHEAP, because `ensureUpkeep` is idempotent by design ("it stays a read on every visit after the
 * first"): the steady state is a few existence queries per project per ten minutes, against 26
 * projects. It is the FIRST pass after a deploy that does work, which is the pass that matters.
 */
const UPKEEP_SWEEP_MS = 600_000;

export function startScheduler(store: Store, domain: DomainStore, intervalMs = 15_000): SchedulerHandle {
  let running = false;
  let upkeeping = false;

  /**
   * Ask every project what clocks it should have.
   *
   * Per project, and every failure is caught per project: one tenant with a broken wedge manifest
   * must not stop the other twenty-five from acquiring their schedules. Errors are logged with the
   * project id because "upkeep failed" without one is unactionable across a fleet.
   */
  async function upkeepAll(): Promise<number> {
    if (upkeeping) return 0;
    upkeeping = true;
    let armed = 0;
    try {
      const { getIdentityStore } = await import("./identity");
      const { ensureUpkeep } = await import("./upkeep");
      const identity = getIdentityStore();
      for (const org of identity.listOrgs()) {
        for (const p of identity.listProjects(org.id)) {
          try {
            /*
              COUNTED, not inferred. `UpkeepReport` says which sweeps are wanted and which are
              running; it does not say which of them this call created. Comparing the schedule rows
              either side is two cheap reads and answers the question actually being asked — "did
              this pass repair anything" — rather than a number that looks like it.
            */
            const before = (await domain.listSchedules()).filter((x) => x.project_id === p.id).length;
            const report = await ensureUpkeep(domain, p.id);
            const after = (await domain.listSchedules()).filter((x) => x.project_id === p.id).length;
            if (after > before) {
              armed += after - before;
              console.log(`[mycel] upkeep armed ${after - before} clock(s) for ${p.id}`);
            }
            /**
             * A sweep the project's own work calls for that is NOT running is the one thing here
             * worth a warning: `blocked` always names what is missing and what therefore will not
             * happen, and silently it is indistinguishable from a business that simply does not do
             * that yet.
             */
            for (const sweep of report.sweeps) {
              if (sweep.wanted && !sweep.running && sweep.blocked) {
                console.warn(`[mycel] upkeep ${p.id}: ${sweep.task_type} wanted but blocked — ${sweep.blocked}`);
              }
            }
          } catch (e) {
            console.error(`[mycel] upkeep failed for ${p.id}:`, (e as Error).message);
          }
        }
      }
    } catch (e) {
      console.error("[mycel] upkeep sweep error:", e);
    } finally {
      upkeeping = false;
    }
    return armed;
  }

  async function tick(now = new Date()): Promise<string[]> {
    if (running) return []; // never overlap ticks within one replica
    running = true;
    const fired: string[] = [];
    try {
      // CLAIM, don't list. The store advances next_run_at inside the same transaction and (on
      // Postgres) uses FOR UPDATE SKIP LOCKED, so with N replicas exactly one wins each schedule.
      // This is what stops a client receiving N duplicate emails.
      const claimed = await domain.claimDueSchedules(now.toISOString(), (s, at) => nextRun(s.cadence, at, s.id).toISOString());
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

  /*
    AFTER the first tick, not before it: a boot that has schedules already due should fire them
    rather than spend its first seconds asking 26 projects what clocks they want. Ten seconds is far
    enough behind to stay out of the way and near enough that a deploy repairs dormant projects
    within the same minute somebody is watching it.
  */
  const upkeepBoot = setTimeout(() => void upkeepAll(), 10_000);
  (upkeepBoot as { unref?: () => void }).unref?.();
  const upkeepTimer = setInterval(() => void upkeepAll(), UPKEEP_SWEEP_MS);
  (upkeepTimer as { unref?: () => void }).unref?.();

  return {
    stop() {
      clearInterval(timer);
      clearTimeout(boot);
      clearInterval(upkeepTimer);
      clearTimeout(upkeepBoot);
    },
    tick,
    upkeepAll,
  };
}
