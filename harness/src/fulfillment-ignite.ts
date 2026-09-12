// THE IGNITION SWEEP — the half of fulfillment that stops waiting to be poked.
//
// ═══ THE GAP THIS CLOSES ═══
//
// Fulfillment was built end to end EXCEPT for the thing that starts it. `deliverables.wrap.ts` turns
// a run's bytes into a Deliverable, the portal lets a client accept it, an accepted deliverable
// drafts an invoice — but ALL OF THAT is downstream of a run happening, and the only thing that ever
// started a fulfillment run was the wait spine: kickoff parks a case on a `client_request`, the
// client answers, `resumeWait` spawns the next step. Two holes in that:
//
//   1. A wedge that declares NO `client_request` wait never parks, so nothing ever resumes it, so it
//      never produces. `declaredWaitTaskType` returns undefined and the case sits open forever. The
//      business is "doing the work" and the Deliverables page is empty.
//   2. "Scoped and PAID" is a money event, not a `client_request`. A client who pays a deposit has
//      told you to start; nothing in the kernel hears it.
//
// So this module answers one question on a clock: which OPEN cases are ready to start and have not
// started, and it spawns the production run for each. Same shape as `sweepRetainers` — a `Schedule`
// of a task type the scheduler branches on, HARNESS bookkeeping with no model call of its own, armed
// by `ensureUpkeep` from what the project actually does (its open cases), ceilinged per project.
//
// ═══ WHAT "READY" AND "NOT STARTED" MEAN, AND WHY BOTH FAIL CLOSED ═══
//
//   · READY  = intake satisfied (no OPEN `client_request` on the case) OR a paid invoice on the case.
//              Either is a real go-signal; a service that needs no intake and takes no deposit is
//              ready the moment its case is open, which is correct — there is nothing to wait for.
//   · STARTED = a Deliverable already exists for the case (production ran at least once, even if that
//              deliverable was later withdrawn) OR a production task for the case is in flight. Both
//              are required: the deliverable check misses a run still going (bytes appear only on
//              success), the in-flight check misses a finished-then-withdrawn one.
//
// ═══ THE ONE BUG THAT MATTERS — DOUBLE IGNITION ═══
//
// The in-flight-task check is a READ above the ACT, and this repo's scars (money-plan.retainer.ts,
// checkin.ts) are all the same lesson: a read that two replicas pass before either writes is not a
// guard. So the actual guard is `claimCaseMarker` — the exactly-once seam already used for check-ins
// — stamping `fulfillment_ignited_at` indivisibly BEFORE the spawn. Two ticks in the same second
// present the same case; one claims it and spawns, the other is refused and does nothing. The claim
// window is one sweep interval, so a run that failed and produced no deliverable is retried on the
// next sweep rather than wedged forever — the marker serialises replicas, it does not permanently
// consume the case.
//
// ═══ IT ONLY DRAFTS ═══
//
// A spawned run reaches `wrapFulfillmentDeliverable`, which creates the deliverable in `drafting` /
// `in_review` — NEVER `released`, never `accepted`. Nothing here releases to a client; the founder
// still does. And because only a CLIENT transition reaches `accepted` (deliverables.ts), the close
// ceremony below can key on `accepted` and know a human on the other side said yes.
import type { Case, Schedule, TaskSource, TaskStatus } from "./contract";
import type { DomainStore } from "./domain";
import type { Store } from "./store";
import { getBillingStore } from "./billing";
import { getRequestStore } from "./requests";
import type { ClientRequest } from "./contract";
import { getDeliverableStore } from "./deliverables";
import { loadProjectWedge } from "./authored";
import { fulfillmentOf } from "./kickoff";
import { isOperationalTaskType } from "./deliverables.wrap";
import { wasInterruptedByRestart } from "./recovery";

/** The `Schedule.task_type` the scheduler branches on. Not a wedge task type — nothing runs a model here. */

/**
 * The month that just ended, as `YYYY-MM`.
 *
 * UTC throughout, deliberately. A close fired at 00:30 on the 1st in London is 23:30 on the 31st in
 * UTC, and a local-time derivation would label it with the wrong month for half the world. The
 * kernel timestamps everything in UTC, so the period agrees with the `scheduled_at` beside it.
 */
export function previousMonth(now: Date): string {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth(); // 0-indexed, so this IS the previous month in 1-indexed terms
  return m === 0 ? `${y - 1}-12` : `${y}-${String(m).padStart(2, "0")}`;
}

export const BEGIN_FULFILLMENT_TASK_TYPE = "begin_fulfillment";

/**
 * How often the sweep looks. Six-hourly, matching the retainer sweep for the same reason: readiness
 * is not latency-critical to the minute, six-hourly means a client who pays this morning sees a
 * draft the same working day, and the claim marker means looking more often cannot double-ignite.
 */
/**
 * HOW OFTEN READY ENGAGEMENTS ARE STARTED. Five minutes, and it used to be six HOURS.
 *
 * Six hours is a sensible cadence for a background sweep and a catastrophic one for this sweep,
 * because this is the step between "the founder asked for work" and "the work begins". Measured
 * against production: a case kicked off at 19:20 had `next_run_at` of 01:41 the following morning.
 * The founder sees nothing for six hours, having just signed up.
 *
 * That is the mechanism behind the time-to-value grade of F with zero orgs ever reaching value. It
 * is not a slow product; it is a product that has not started yet.
 *
 * Five minutes is cheap: the sweep is one indexed query per project and does nothing when nothing
 * is ready — the overwhelming common case. `idle` is already reported back to the scheduler so an
 * empty sweep costs a query and nothing else. Paying that every five minutes to keep a new
 * customer inside their first session is the trade, and it is not close.
 */
export const SWEEP_SECONDS = 5 * 60;

/** Production runs one sweep will start, across the whole project. A ceiling, like every sibling. */
export const BATCH = 25;

/** In-flight task states — a production task in any of these means the work is already going. */
const IN_FLIGHT: readonly TaskStatus[] = [
  "queued",
  "provisioning",
  "running",
  "awaiting_approval",
  "awaiting_batch",
  "validating",
];

/**
 * The seam that spawns a production run. IDENTICAL to `WaitDeps` on purpose: both start a case's next
 * step, and the one place that resolves the wedge manifest, clamps constraints against the profile,
 * sets the output schema and enqueues through the real orchestrator is `spawnKernelTask` in server.ts.
 * Constructing a task inline here would skip all of that and run with permissive `general` constraints
 * off the schedule rather than the case. Injected so the sweep is testable without the orchestrator.
 */
export interface IgniteDeps {
  wedgeEnabled(projectId: string, wedge: string): boolean;
  spawnTask(args: {
    project_id: string;
    wedge: string;
    task_type: string;
    client_id?: string;
    case_id?: string;
    source: TaskSource;
    input: Record<string, unknown>;
  }): Promise<string>;
}

let deps: IgniteDeps | null = null;
export function setIgniteDeps(d: IgniteDeps | null): void {
  deps = d;
}

/**
 * The task type whose run PRODUCES the deliverable for this wedge, or undefined if the wedge has no
 * such thing (in which case the case must never ignite — igniting it would run a model whose output
 * `wrapFulfillmentDeliverable` refuses, burning cost and producing nothing).
 *
 * Selection, in priority order:
 *   1. `fulfillment.production_task_type` — the wedge naming the job. Task-type order on disk is an
 *      authoring accident; geo-monitor's first type is a single probe, a child of the weekly report.
 *      A typo or an operational name refuses rather than guessing: the wrong job starting is worse
 *      than this case waiting one more sweep.
 *   2. The resume target of a declared `client_request` wait — the NEXT step by construction, and the
 *      exact type the wait spine already runs, so ignite and resume agree on what production is.
 *   3. Fallback (the wedge-with-no-wait hole): the first task type that is neither operational
 *      (chase/nudge/outreach/… — `isOperationalTaskType`) nor itself an ask-raiser (declares its own
 *      `waits_for`, i.e. it asks the client something rather than producing work).
 *
 * Guarded by `fulfillmentOf`: the wedge must actually turn a run into a deliverable, or we return
 * undefined and the case is skipped and named in the summary rather than ignited.
 */
export async function productionTaskType(
  projectId: string,
  wedge: string,
): Promise<string | undefined> {
  const loaded = await loadProjectWedge(projectId, wedge).catch(() => null);
  if (!loaded) return undefined;
  const types = loaded.manifest.task_types ?? {};
  const spec = fulfillmentOf(wedge, loaded.manifest as { fulfillment?: unknown });

  const declared = spec?.production_task_type;
  let production: string | undefined;
  if (declared) {
    if (!types[declared] || isOperationalTaskType(declared)) return undefined;
    production = declared;
  }
  if (!production) {
    for (const t of Object.values(types)) {
      if (t?.waits_for?.on === "client_request" && t.waits_for.resume) {
        production = t.waits_for.resume;
        break;
      }
    }
  }
  if (!production) {
    for (const [name, t] of Object.entries(types)) {
      if (isOperationalTaskType(name)) continue;
      if (t?.waits_for) continue; // raises an ask; does not produce the work
      production = name;
      break;
    }
  }
  if (!production) return undefined;

  // The wedge must declare (or, for an authored service, default to) a deliverable shape, else the
  // wrap step will refuse the run's output. Fail closed.
  const shapes = fulfillmentOf(wedge, loaded.manifest as { fulfillment?: unknown })?.deliverable_shapes;
  if (!shapes?.length) return undefined;
  return production;
}

/**
 * HOW LONG A CASE WAITS ON SOMEBODY ELSE'S CLIENT BEFORE STARTING ANYWAY.
 *
 * Ten minutes, and the number is chosen against RETENTION rather than politeness. Time-to-value is
 * the strongest predictor of SMB churn, and a founder who sees nothing in their first sitting does
 * not come back for a second. Ten minutes keeps the first result inside the session they signed up
 * in, while still giving a client who is actually at their desk a chance to answer first — in which
 * case `intake_satisfied` fires and this path never runs.
 */
export const FIRST_PASS_AFTER_MS = 10 * 60 * 1000;

/**
 * The go-signal, or undefined if the case is not ready.
 *
 * ═══ WHY THERE IS A THIRD PATH, AND WHY IT IS THE IMPORTANT ONE ═══
 *
 * There were two: intake satisfied, or a deposit paid. Both are correct and both wait on THE
 * CUSTOMER'S CUSTOMER — a second human, outside the founder's control, with no relationship to us.
 *
 * Measured end to end against production: a synthetic agency added a client, opened a case and
 * kicked it off. Every call returned 2xx. `applied: true`. Zero tasks ran, zero deliverables
 * appeared, and the case sat parked on an intake question that would never be answered because the
 * client was synthetic. Four green responses and an abandoned customer.
 *
 * A real customer's version of that is worse, not better: their client takes two days to reply, so
 * time-to-value is two days, so they churn before the product ever demonstrates itself. The
 * measured TTV across every org in production was F with ZERO orgs ever reaching value, and this
 * is the mechanism.
 *
 * So intake now REFINES the work rather than GATING it. After the grace period the first pass runs
 * on what the founder already told us at kickoff, produces a real deliverable, and the client's
 * answers — whenever they arrive — improve the next version. That is also how a good agency
 * behaves: they start on the brief and adjust, they do not sit idle until every question is
 * answered.
 *
 * Order matters and is unchanged where it was already right: a client who DID answer still wins
 * (`intake_satisfied`), and a paid deposit still wins, because both are better signals than a
 * timer. The timer is the floor, not the preference.
 */
async function readyReason(project_id: string, kase: Case): Promise<string | undefined> {
  const openAsks = await getRequestStore().listRequests({
    project_id,
    case_id: kase.id,
    status: "open",
    limit: 1,
  });
  if (openAsks.length === 0) return "intake_satisfied";

  const paid = await getBillingStore().listInvoices({
    project_id,
    case_id: kase.id,
    status: "paid",
    limit: 1,
  });
  if (paid.length > 0) return "deposit_paid";

  // The floor. Only after both better signals have had their chance.
  const opened = Date.parse(String(kase.created_at ?? ""));
  if (Number.isFinite(opened) && Date.now() - opened >= FIRST_PASS_AFTER_MS) return "first_pass";

  return undefined;
}

/**
 * ═══ RETRY IS RIGHT; RETRY EVERY FIVE MINUTES FOREVER IS NOT ═══
 *
 * The header above says the claim marker "does not permanently consume the case", so a run that
 * failed and produced no deliverable is retried on the next sweep. That is the correct instinct — a
 * case wedged forever by one transient failure is the worse bug — and with a five-minute sweep it
 * has no ceiling.
 *
 * Measured in production on 2026-09-05: `monthly_close` ran 2,975 times in thirty days against TWO
 * clients, peaking at 566 a day. A monthly deliverable. Every one of those was this loop: the run
 * fails, it is no longer in flight, five minutes later the sweep starts it again. It accounted for
 * 1,105 of the 2,696 failed tasks on the account and it burned real model spend doing it.
 *
 * With a paying customer it is worse than noise. A client whose close has a genuine problem — a
 * missing feed, a malformed statement — generates 288 attempts a day and 288 charges, and nobody is
 * told, because from the outside every sweep looks like the first one.
 *
 * So the retry survives and grows a spine: exponential backoff from the sweep interval, and a
 * ceiling. A transient failure still recovers on the next sweep, which is the property worth
 * keeping. A case that keeps failing goes quiet and stays visible in the summary instead of
 * spending money in a circle.
 */
/** Consecutive production failures after which the sweep stops re-igniting on its own. */
export const MAX_IGNITE_ATTEMPTS = 6;

/**
 * ═══ THE CEILING THE FAILURE COUNTER CANNOT REACH ═══
 *
 * `MAX_IGNITE_ATTEMPTS` counts FAILURES, and the 3,077-run incident above was built entirely out of
 * runs that SUCCEEDED. That is not a corner case, it is the whole shape of the bug: this sweep only
 * ignites a case with zero deliverables, so a run that finishes cleanly and produces nothing leaves
 * the case in the exact state that caused the ignition. The next sweep sees an un-started case and
 * starts it again, and no counter anywhere moves.
 *
 * `waitingOnClient` below closes the one reason we had MEASURED — the run stopped to ask the client
 * something. It does not close the class. A run can also finish having filed something, recorded a
 * note, acted on another system, or found nothing to say (`run-ending.ts` names all of them), and
 * every one of those leaves the same no-deliverable case behind for the same infinite retry.
 *
 * So this is the backstop, and it is deliberately reason-blind: three runs that COMPLETED and left
 * no deliverable stops the case, whatever they were doing. Cheap to compute — the task rows are
 * already loaded — and it bounds the worst case at three runs instead of three thousand.
 */
export const MAX_BARREN_RUNS = 3;

/** Backoff for the Nth consecutive failure: 5m, 10m, 20m, 40m, 80m, capped at three hours. */
export function igniteBackoffMs(consecutiveFailures: number): number {
  const base = SWEEP_SECONDS * 1000;
  const grown = base * 2 ** Math.max(0, consecutiveFailures - 1);
  return Math.min(grown, 3 * 60 * 60 * 1000);
}

/** Why the sweep is leaving this case alone, or undefined when it is free to start. */
type Holdoff =
  | { reason: "in_flight" }
  | { reason: "backoff"; until: number }
  | { reason: "exhausted"; failures: number }
  /** Ran to completion `attempts` times and left no deliverable behind. See `MAX_BARREN_RUNS`. */
  | { reason: "producing_nothing"; attempts: number };

async function productionHoldoff(
  store: Store,
  kase: Case,
  productionType: string,
  now: number,
): Promise<Holdoff | undefined> {
  /**
   * PRECONDITION: this case has NO deliverable. The caller returns on `existing.length > 0` twice
   * over — once to close, once as `already_started` — so by here the case has nothing to show, and
   * the barren ceiling below reads every completed run as a run that produced nothing.
   *
   * This was briefly a `hasDeliverable` parameter. The caller could only ever pass `false`, so the
   * branch guarding it was unreachable — a dead limb of exactly the kind
   * `declared-but-unreachable.test.ts` exists to find. The invariant is pinned by
   * "a case that already has a deliverable is left alone" in the suite instead, where it is real.
   */
  const tasks = kase.client_id
    ? await store.listTasks({ client_id: kase.client_id, limit: 200 })
    : await store.listTasks({ limit: 500 });
  const mine = tasks.filter((t) => t.case_id === kase.id && t.task_type === productionType);

  if (mine.some((t) => IN_FLIGHT.includes(t.status))) return { reason: "in_flight" };

  /**
   * CONSECUTIVE, counted from the most recent backwards. A case that failed four times last week
   * and succeeded since is not on its fifth attempt — it is on its first, and treating it as
   * exhausted would silently retire a working case. The run of failures ends at the first task that
   * did not fail.
   */
  /**
   * ═══ WHERE COUNTING STARTS, AND WHY THERE HAS TO BE A LINE ═══
   *
   * `ignition_retired_at` is a RECORD of a decision, not the decision itself — the gate is
   * `failures >= MAX_IGNITE_ATTEMPTS`, recomputed from task history on every sweep. So clearing the
   * field does nothing: the next sweep counts the same old failures and writes it straight back.
   *
   * Which meant a retired case could not be un-retired. Not by a founder, not by an operator, not by
   * anyone — and the failures that retire a case are frequently NOT the case's fault. Two of them
   * here were retired by a Daytona hang that was fixed twenty minutes later, and they stayed retired
   * through the fix.
   *
   * A halt with no way back is the shape this codebase keeps finding and keeps calling a trap. So
   * clearing the record now sets `ignition_rearmed_at`, and counting starts after it. Delete the
   * pair and the case gets a clean slate; the history stays on the tasks where it belongs.
   */
  const rearmedAt = Date.parse(String(kase.data?.ignition_rearmed_at ?? "")) || 0;

  const recent = [...mine].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  let failures = 0;
  let lastFailedAt = 0;
  for (const t of recent) {
    // Anything from before the re-arm is somebody else's argument.
    if ((Date.parse(String(t.created_at)) || 0) < rearmedAt) break;
    if (t.status !== "failed" && t.status !== "expired") break;
    /**
     * A DEPLOY IS NOT THE CASE'S FAULT.
     *
     * ECS SIGKILLs at `stopTimeout`, which Fargate caps at 120s, and a production run is 300-600s.
     * So every deploy lands on somebody's engagement and marks it failed — 120 such rows in one
     * day, measured. Counting those toward the ceiling means six deploys during one month-end
     * retire a working case, and the founder is told it failed six times running when it never
     * actually failed once.
     *
     * Skipped rather than treated as a success: it does not reset a genuine run of failures
     * either. A case that failed three times on its merits and was then interrupted by a restart
     * is still on three.
     */
    /**
     * The CLOCK is set by the newest attempt of any kind; the COUNT skips restarts.
     *
     * Setting the clock only from genuine failures leaves a case with real failures behind it
     * re-igniting every five minutes forever, as long as each retry happens to be killed by a
     * deploy — and cfe29b4d measured 37 of the last 38 failures as restart rows, so that is the
     * common case, not the corner. The backoff a case has earned should still be served even when
     * the attempt that would have served it was cut short by us.
     */
    const at = Date.parse(String(t.updated_at ?? t.created_at)) || 0;
    if (at > lastFailedAt) lastFailedAt = at;
    if (wasInterruptedByRestart(t.error)) continue;
    failures++;
  }
  if (failures >= MAX_IGNITE_ATTEMPTS) return { reason: "exhausted", failures };

  /**
   * ═══ RUNS THAT FINISHED AND LEFT NOTHING ═══
   *
   * TOTAL since the re-arm, not consecutive, and that difference is the argument. Consecutive is
   * right for failures because an intervening success proves the case can work — the run of bad
   * luck is genuinely over. Nothing proves that here. The only evidence that production works on
   * this case is a deliverable, and if one existed the caller would have taken the `already_started`
   * branch and we would never have been called. So an intervening FAILURE resets nothing: three
   * completed runs that produced nothing are three completed runs that produced nothing, whatever
   * happened between them.
   *
   * Checked AFTER the failure ceiling so a case whose recent runs are genuinely erroring is
   * reported as erroring. A founder reading "it ran and produced nothing" about a case that has
   * been throwing for a day would go looking in the wrong place.
   */
  const barren = mine.filter(
    (t) => t.status === "succeeded" && (Date.parse(String(t.created_at)) || 0) >= rearmedAt,
  ).length;
  if (barren >= MAX_BARREN_RUNS) return { reason: "producing_nothing", attempts: barren };

  if (failures === 0) return undefined;

  return backoffFrom(failures, lastFailedAt, now);
}

/** The earned wait after `failures` consecutive failures, or undefined when it has already elapsed. */
function backoffFrom(failures: number, lastFailedAt: number, now: number): Holdoff | undefined {
  const until = lastFailedAt + igniteBackoffMs(failures);
  // An unparseable timestamp must not become `NaN > now` and hold the case forever.
  if (lastFailedAt && until > now) return { reason: "backoff", until };
  return undefined;
}

export interface IgnitionSweepSummary {
  project_id: string;
  considered: number;
  ignited: number;
  already_started: number;
  /** Waiting out a backoff after a failure. Not started, and not the same as in-flight. */
  backing_off: number;
  /** Retired after MAX_IGNITE_ATTEMPTS consecutive failures. Needs a person. */
  exhausted: number;
  /** Retired after MAX_BARREN_RUNS runs that completed and produced no deliverable. Needs a person. */
  producing_nothing: number;
  not_ready: number;
  /** Already asked the client something and has not been answered. Not a failure — a wait. */
  waiting_on_client: number;
  closed: number;
  no_production_type: number;
  failed: string[];
  skipped_because?: string;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * A CASE WAITING ON A CLIENT IS NOT A CASE THAT NEEDS STARTING
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * MEASURED IN PRODUCTION, over fourteen days: 3,077 `monthly_close` runs across TWO engagements —
 * one every thirty-one minutes, each one refusing for the same missing bank statement, each one
 * costing a model call. The two real `monthly_close` schedules were disabled and had never fired;
 * every one of those runs came from this sweep.
 *
 * The mechanism is exact and it is worth stating, because the obvious reading is wrong. Nothing was
 * broken in the backoff: `productionHoldoff` counts consecutive FAILURES, and a run that ends in
 * `ask` SUCCEEDS. `client-ready.ts` is right to call it a success — the run did its job, discovered
 * it could not proceed without something only the client has, and raised the request. But a
 * successful run that produced no deliverable leaves this sweep nothing to see: the case still has
 * no work on it, so it still looks un-started, so it is started again on the next pass. Forever, at
 * whatever the sweep interval is, with no counter anywhere reaching a ceiling.
 *
 * So the sweep asks the question it was missing. Not "did the last run fail" — it did not — but
 * "does this engagement already have an unanswered question in front of the client".
 *
 * ═══ AND WHY `readyReason` DOES NOT ALREADY ANSWER IT ═══
 *
 * It looks like it should: its first act is to list open asks, and no open asks means
 * `intake_satisfied`. But when there ARE open asks it falls through to the money, and A PAID
 * DEPOSIT WINS. That is right — a client who has paid has bought an engagement, and holding their
 * work hostage to an unreturned form would be the wrong way round.
 *
 * It is right about the ENGAGEMENT and says nothing about the RUN. Money means this is live; it
 * does not mean today's close has the bank statement it needs. Both of the cases burning runs had a
 * paid deposit and eighteen open asks between them, so `readyReason` returned `deposit_paid` on
 * every single pass. This gate is the missing half of that sentence, which is why it sits after it
 * rather than inside it.
 *
 * ═══ WHY IT IS SCOPED TO ASKS A RUN RAISED ═══
 *
 * `task_id` is set by `openMaterialRequests` and by nothing else: it means A RUN STOPPED ON THIS.
 * Kickoff's own asks — the bank statement requested when the engagement opened, the decision to
 * confirm scope — deliberately do not carry one, because a fresh engagement is entitled to try. A
 * broader gate would mean an engagement could never make its first attempt while any intake ask was
 * outstanding, which is the opposite failure and would look identical from the outside.
 *
 * ═══ IT CANNOT DEADLOCK, AND IT IS NOT SUPPOSED TO TIME OUT ═══
 *
 * The moment the client answers, `resolveRequest` closes the row and the next sweep ignites
 * normally. If they never answer, the engagement waits — which is CORRECT and is the honest state.
 * `/requests` already shows every open ask with its age and a chase, and the oldest of the eighteen
 * open on that tenant is fourteen days. The bug was never that we waited too long; it was that we
 * spent three thousand runs pretending we were not waiting at all.
 */
async function waitingOnClient(projectId: string, kase: Case): Promise<ClientRequest | undefined> {
  const open = await getRequestStore()
    .listRequests({ project_id: projectId, case_id: kase.id, status: "open", limit: 50 })
    .catch(() => [] as ClientRequest[]);
  // Oldest first, so the reason shown names the one that has been waiting longest.
  return [...open]
    .filter((r) => !!r.task_id)
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))[0];
}

/**
 * One project. Lists its open cases; for each, either closes it (all deliverables accepted) or ignites
 * it (ready + not started). Ceilinged, fail-closed, exactly-once via the claim marker.
 */
export async function sweepFulfillmentIgnition(args: {
  domain: DomainStore;
  store: Store;
  project_id: string;
  now?: Date;
}): Promise<IgnitionSweepSummary> {
  const { domain, store } = args;
  const project_id = args.project_id;
  if (!project_id) throw new Error("a fulfillment ignition sweep must be scoped to a project");
  const now = args.now ?? new Date();
  const nowIso = now.toISOString();

  const summary: IgnitionSweepSummary = {
    project_id,
    considered: 0,
    ignited: 0,
    already_started: 0,
    backing_off: 0,
    exhausted: 0,
    producing_nothing: 0,
    not_ready: 0,
    waiting_on_client: 0,
    closed: 0,
    no_production_type: 0,
    failed: [],
  };

  if (!deps) {
    summary.skipped_because = "ignition deps not wired (setIgniteDeps)";
    return summary;
  }

  const cases = await domain.listCases({ project_id, status: "open" });
  const dstore = getDeliverableStore();

  for (const kase of cases) {
    if (summary.ignited >= BATCH) break;
    summary.considered += 1;

    // ── close ceremony ── all deliverables accepted → the engagement is done.
    const existing = await dstore.listDeliverables({ project_id, case_id: kase.id });
    if (existing.length > 0 && existing.every((d) => d.status === "accepted")) {
      try {
        await domain.updateCase(
          kase.id,
          { status: "closed", closed_at: nowIso },
          {
            at: nowIso,
            kind: "closed",
            note: "all deliverables accepted — engagement closed",
            actor: "system",
          },
        );
        summary.closed += 1;
      } catch (e) {
        summary.failed.push(`close ${kase.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
      continue;
    }

    // ── not started ── any deliverable at all means production already ran once.
    if (existing.length > 0) {
      summary.already_started += 1;
      continue;
    }

    // ── does this wedge even produce a deliverable? ── fail closed, name it.
    const productionType = await productionTaskType(project_id, kase.wedge);
    if (!productionType) {
      summary.no_production_type += 1;
      continue;
    }

    // ── enabled ── a founder who turned the wedge off does not get production restarted under them.
    if (!deps.wedgeEnabled(project_id, kase.wedge)) {
      summary.already_started += 1; // not "not ready"; it is deliberately held
      continue;
    }

    // ── ready ── intake satisfied or money arrived.
    const because = await readyReason(project_id, kase);
    if (!because) {
      summary.not_ready += 1;
      continue;
    }

    /**
     * ── waiting on the client ── a run already asked and nobody has answered. See `waitingOnClient`.
     *
     * BEFORE the holdoff check, because holdoff counts failures and these runs succeed — it will
     * never hold this case off, which is the whole defect.
     */
    const waiting = await waitingOnClient(project_id, kase);
    if (waiting) {
      summary.waiting_on_client += 1;
      continue;
    }

    // ── in flight, backing off, or given up ── see productionHoldoff.
    // `existing.length === 0` here — the branch above returned for every case that has one.
    const holdoff = await productionHoldoff(store, kase, productionType, now.getTime());
    if (holdoff) {
      if (holdoff.reason === "exhausted" || holdoff.reason === "producing_nothing") {
        /**
         * ═══ RETIRING A CASE HAS TO LEAVE A MARK SOMEWHERE A PERSON LOOKS ═══
         *
         * The first version of this pushed a line into `summary.failed` and stopped. Nothing reads
         * `summary.failed` — scheduler.ts logs `skipped_because` and returns
         * `{ idle: ignited === 0 && closed === 0 }` — so retiring a case made the sweep report
         * itself MORE idle, i.e. healthier, at the exact moment it gave up on somebody's
         * engagement. That is the failure mode this whole file has been fixing all day, written
         * fresh.
         *
         * So it is persisted on the case, as an event in its history and a timestamp in `data`,
         * which is what CONTRIBUTING's third ground rule asks for: the reason lives on the record,
         * not only in a stream nobody tails. `moves.ts` already ranks a stalled engagement for the
         * founder's attention, and a case carrying `ignition_retired_at` is exactly that.
         *
         * Written ONCE. This sweep runs every five minutes; an event per sweep would bury the case
         * history it is meant to explain.
         */
        /**
         * ONE RETIREMENT, TWO REASONS.
         *
         * Both verdicts mean the same thing operationally — stop spending money on this case and
         * put it in front of a person — so they share the record, the event and the re-arm. What
         * they must NOT share is the wording. "Six consecutive failures" and "three runs that
         * finished and produced nothing" send a founder to completely different places, and the
         * second one is the sentence that would have ended the 3,077-run incident on day one.
         */
        const retired =
          holdoff.reason === "exhausted"
            ? {
                count: holdoff.failures,
                line: `${holdoff.failures} consecutive ${productionType} failures — not retrying`,
                note:
                  `stopped starting "${productionType}" after ${holdoff.failures} consecutive failures. ` +
                  `Nothing further will be attempted for this engagement until the cause is fixed.`,
              }
            : {
                count: holdoff.attempts,
                line: `${holdoff.attempts} ${productionType} runs finished and produced no deliverable — not retrying`,
                note:
                  `stopped starting "${productionType}". It ran ${holdoff.attempts} times, finished each time, ` +
                  `and produced no deliverable — so running it again would do the same thing. ` +
                  `Check what the run is waiting on or missing before re-arming.`,
              };
        if (holdoff.reason === "exhausted") summary.exhausted += 1;
        else summary.producing_nothing += 1;
        summary.failed.push(`ignite ${kase.id}: ${retired.line}`);
        if (!kase.data?.ignition_retired_at) {
          const note = retired.note;
          await domain
            .updateCase(
              kase.id,
              {
                data: {
                  ...kase.data,
                  ignition_retired_at: nowIso,
                  ignition_failures: retired.count,
                  ignition_retired_reason: holdoff.reason,
                  /**
                   * How to undo this, on the record that records it. Clearing
                   * `ignition_retired_at` alone does nothing — the gate recomputes from task
                   * history — so the note names both keys.
                   */
                  ignition_rearm_hint:
                    "set ignition_rearmed_at to now and clear ignition_retired_at to try again",
                },
              },
              { at: nowIso, kind: "note", note, actor: "system" },
            )
            .catch((e) => {
              summary.failed.push(`ignite ${kase.id}: could not record retirement: ${String(e)}`);
            });
          console.error(`[mycel] ignition retired case ${kase.id} (${project_id}): ${note}`);
        }
      } else {
        // `backoff` is not `in_flight`. Counting a waiting case as "already started" is the same
        // dishonesty one branch up, quieter — the sweep would claim work is underway when none is.
        summary.backing_off += 1;
      }
      continue;
    }

    // ── EXACTLY ONCE ── claim before spawning. Refused = a sibling tick already took it.
    const claimed = await domain.claimCaseMarker({
      project_id,
      id: kase.id,
      marker: "fulfillment_ignited_at",
      notSince: new Date(now.getTime() - SWEEP_SECONDS * 1000).toISOString(),
      at: nowIso,
    });
    if (!claimed) {
      summary.already_started += 1;
      continue;
    }

    try {
      const task_id = await deps.spawnTask({
        project_id, // OFF THE CASE ROW below, never a sweep argument — cross-tenant guard.
        wedge: kase.wedge,
        task_type: productionType,
        client_id: kase.client_id,
        case_id: kase.id,
        source: "schedule",
        /**
         * ═══════════════════════════════════════════════════════════════════════════════════════
         * THE PERIOD, BECAUSE THE SCHEDULER IS THE ONLY THING THAT KNOWS IT
         * ═══════════════════════════════════════════════════════════════════════════════════════
         *
         * Found in production: `6 consecutive monthly_close failures — not retrying`, and the
         * engagement retired. Every scheduled close for that client had been refused, at schedule
         * time, by its own input schema:
         *
         *     this task's input does not match what `monthly_close` needs: $.period: required
         *
         * `books-keeper.monthly_close` declares `period` required, and the reasoning on that field
         * is RIGHT and worth keeping: *"a close with no period is a close of nothing, and production
         * runs have failed asking for exactly this after spending a sandbox to discover it."* Failing
         * at schedule time beats burning a sandbox to reach the same answer.
         *
         * What nobody closed is the other half. This is the only caller that starts a recurring
         * deliverable, and it sent `{ because, scheduled_at }` — so the contract could never be
         * satisfied and the work never ran at all. Failing fast is better than failing slow; never
         * running is worse than both.
         *
         * ── WHY DERIVED HERE AND NOT MADE OPTIONAL ──
         *
         * `geo-monitor` hit the same wall from the other side and solved it by relaxing the field,
         * and its schema comment names this exact case while doing so. That was right there and is
         * wrong here: geo's `client` is a fact the RUN holds and the caller does not. A period is the
         * opposite — it is a fact about the CLOCK, which is precisely what a scheduler is.
         *
         * A close firing now closes the month that just ended. Derived from `now` rather than from
         * the case, so a late sweep on the 3rd still closes September rather than October.
         *
         * Sent for every task type, not just closes: a period is the right thing for any recurring
         * deliverable to know, and a wedge whose schema does not mention it simply ignores the field.
         */
        input: { because, scheduled_at: nowIso, period: previousMonth(now) },
      });
      await domain
        .updateCase(
          kase.id,
          {},
          {
            at: nowIso,
            kind: "task_spawned",
            note: `production started on its own — ${because}. Nothing goes to the client until you release it.`,
            task_id,
            actor: "system",
          },
        )
        .catch(() => undefined);
      summary.ignited += 1;
    } catch (e) {
      summary.failed.push(`ignite ${kase.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return summary;
}

/**
 * Does this project do fulfillment at all? A PROJECT fact, not an install fact — whether ignition is
 * wanted depends on the project's own open cases and their wedges. Mirrors `projectHasRetainer`:
 * the project's wedges come from its open cases (there is no standalone "project wedges" list).
 */
export async function projectDoesFulfillment(domain: DomainStore, projectId: string): Promise<boolean> {
  if (!projectId) return false;
  const cases = await domain.listCases({ project_id: projectId, status: "open" }).catch(() => []);
  const seen = new Set<string>();
  for (const kase of cases) {
    if (seen.has(kase.wedge)) continue;
    seen.add(kase.wedge);
    if (await productionTaskType(projectId, kase.wedge)) return true;
  }
  return false;
}

/** Ensure this project has an ignition clock. A line-for-line sibling of `ensureRetainerSchedule`. */
export async function ensureFulfillmentSchedule(
  domain: DomainStore,
  projectId: string,
  wedge: string,
  now: Date = new Date(),
): Promise<Schedule> {
  if (!projectId) throw new Error("a fulfillment ignition schedule must be scoped to a project");
  const existing = (await domain.listSchedules()).find(
    (s) => s.project_id === projectId && s.task_type === BEGIN_FULFILLMENT_TASK_TYPE,
  );
  if (existing) return existing;
  return domain.createSchedule({
    project_id: projectId,
    name: "start ready engagements",
    wedge,
    task_type: BEGIN_FULFILLMENT_TASK_TYPE,
    input: {},
    cadence: { kind: "every", seconds: SWEEP_SECONDS },
    enabled: true,
    next_run_at: new Date(now.getTime() + SWEEP_SECONDS * 1000).toISOString(),
  });
}
