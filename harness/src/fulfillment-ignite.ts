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
import { getDeliverableStore } from "./deliverables";
import { loadProjectWedge } from "./authored";
import { fulfillmentOf } from "./kickoff";
import { isOperationalTaskType } from "./deliverables.wrap";

/** The `Schedule.task_type` the scheduler branches on. Not a wedge task type — nothing runs a model here. */
export const BEGIN_FULFILLMENT_TASK_TYPE = "begin_fulfillment";

/**
 * How often the sweep looks. Six-hourly, matching the retainer sweep for the same reason: readiness
 * is not latency-critical to the minute, six-hourly means a client who pays this morning sees a
 * draft the same working day, and the claim marker means looking more often cannot double-ignite.
 */
export const SWEEP_SECONDS = 6 * 3600;

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
 *   1. The resume target of a declared `client_request` wait — the NEXT step by construction, and the
 *      exact type the wait spine already runs, so ignite and resume agree on what production is.
 *   2. Fallback (the wedge-with-no-wait hole): the first task type that is neither operational
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

  let production: string | undefined;
  for (const spec of Object.values(types)) {
    if (spec?.waits_for?.on === "client_request" && spec.waits_for.resume) {
      production = spec.waits_for.resume;
      break;
    }
  }
  if (!production) {
    for (const [name, spec] of Object.entries(types)) {
      if (isOperationalTaskType(name)) continue;
      if (spec?.waits_for) continue; // raises an ask; does not produce the work
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
 * The go-signal, or undefined if the case is not ready. Intake first (the common path), money second.
 * Both reads are project+case scoped and fail closed on a missing project id.
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

  return undefined;
}

/** True when a production run for this case is already going — the second half of NOT-STARTED. */
async function productionInFlight(store: Store, kase: Case, productionType: string): Promise<boolean> {
  const tasks = kase.client_id
    ? await store.listTasks({ client_id: kase.client_id, limit: 200 })
    : await store.listTasks({ limit: 500 });
  return tasks.some(
    (t) => t.case_id === kase.id && t.task_type === productionType && IN_FLIGHT.includes(t.status),
  );
}

export interface IgnitionSweepSummary {
  project_id: string;
  considered: number;
  ignited: number;
  already_started: number;
  not_ready: number;
  closed: number;
  no_production_type: number;
  failed: string[];
  skipped_because?: string;
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
    not_ready: 0,
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

    // ── in flight ── a run for this case is already going.
    if (await productionInFlight(store, kase, productionType)) {
      summary.already_started += 1;
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
        input: { because, scheduled_at: nowIso },
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
