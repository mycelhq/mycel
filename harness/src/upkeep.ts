// UPKEEP — the recurring work a project needs, derived from what that project actually does.
//
// ═══ THE FAILURE THIS EXISTS FOR ═══
//
// Three complete, tested, documented sweeps had NO CALLER anywhere in the repo:
//
//   `ensureNudgeSchedule`        (nudges.ts)   — chase a client for the thing they owe us
//   `ensureDunningSchedule`      (dunning.ts)  — chase an overdue invoice
//   `ensurePaymentSyncSchedule`  (payments.ts) — find out whether an invoice was actually paid
//
// Each one creates the Schedule that the scheduler's tick claims and fires. With no caller, no
// Schedule row is ever written, so `claimDueSchedules` finds nothing, so the sweep never runs. Every
// unit test passed, `sweepOpenRequests` was provably correct, and not one client request was ever
// chased in production. A sweep with no clock is this codebase's signature bug — something failing
// while reporting success — in its purest form: the tests assert the machine works, and nobody had
// asserted that anything turns it on.
//
// Meanwhile two of the three DID exist for some businesses, by accident of provisioning:
// `blueprints/invoice-chaser.json` declares schedules with the task types `reconcile_payments` and
// `chase_overdue_invoices`, and `provisionBlueprint` writes them. So a founder who clicked the AR
// chaser on the start screen got dunning and payment sync; a founder who set up bookkeeping or a
// contract desk — both of which raise invoices, both of which get paid late — got neither, and
// nothing anywhere said so. Whether the kernel watches your money depended on which tile you clicked
// during onboarding.
//
// ═══ WHAT DRIVES A SWEEP INSTEAD ═══
//
// What the PROJECT DOES. Not a blueprint, not a wedge directory name, not a flag someone remembered
// to set:
//
//   · the business has raised an invoice   → find out when it gets paid, and chase it when it does not
//   · the business has asked a client for something → chase them for it
//
// Those facts are rows, they are already project-scoped, and they are the same facts the sweeps
// themselves read. Deriving the clock from the same rows the sweep will read is what makes it
// impossible for one to exist without the other being worth having.
//
// ═══ WHY DERIVED AND NOT PASSED IN ═══
//
// `ensureUpkeep` reads the facts itself rather than taking "an invoice was just created" from its
// caller. Two reasons, and the second is the one that matters. A boolean from a route is a claim a
// route can get wrong, and the routes here are not the only door — an agent can create an invoice
// through a run. And a project that ALREADY had ten invoices before this module existed would never
// be repaired by a trigger-shaped API: it has to be enough to touch the project at all. Two indexed
// existence queries is the price, and it is paid on invoice creation, not per tick.
//
// ═══ DEGRADING HONESTLY IS THE WHOLE INTERFACE ═══
//
// Every sweep here can be WANTED and still not runnable, and each has a different reason:
//
//   · nothing declares the `dunning` role, so there is no wedge to hand a chase to (roles.ts)
//   · no connection provides `read_payments`, so a reconciliation has nothing to look at
//     (capabilities.ts)
//   · no installed wedge declares `nudge_client_request`, so the sweep could find work and would
//     have to refuse every item of it (nudges.ts)
//
// The answer in all three cases is the same and it is NOT to create the schedule. `dunning.ts` says
// why at its own gate: a Schedule whose wedge names nothing installed is a row on `/clock` that
// fires for ever and can never do anything — a configured feature that does not exist, which is
// worse than an absent one because it looks wired up.
//
// So `UpkeepReport` carries the refusal as a sentence rather than swallowing it, `GET /v1/upkeep`
// serves it, and the routes log it. "Not running, and here is the sentence" is a product. "Not
// running" is the bug this module was written to end.
import type { Schedule } from "./contract";
import type { DomainStore } from "./domain";
import { getBillingStore } from "./billing";
import { getRequestStore } from "./requests";
import { resolveCapability } from "./capabilities";
import { whyNoWedge, wedgeForRole } from "./roles";
import { CHASE_SWEEP_TASK_TYPE, ensureDunningSchedule } from "./dunning";
import { PAYMENT_SYNC_TASK_TYPE, ensurePaymentSyncSchedule } from "./payments";
import {
  CALENDAR_SYNC_TASK_TYPE,
  CRM_IMPORT_TASK_TYPE,
  calendarWanted,
  crmWanted,
  ensureCalendarSyncSchedule,
  ensureCrmImportSchedule,
} from "./capability-import";
import { NUDGE_SWEEP_TASK_TYPE, NUDGE_TASK_TYPE, ensureNudgeSchedule, anyWedgeCarriesNudge } from "./nudges";
import { PAYMENTS_WEDGE } from "./payments.manual";
import {
  BEGIN_FULFILLMENT_TASK_TYPE,
  ensureFulfillmentSchedule,
  projectDoesFulfillment,
} from "./fulfillment-ignite";
import {
  RETAINER_SWEEP_TASK_TYPE,
  ensureRetainerSchedule,
  projectHasRetainer,
} from "./money-plan.retainer";

/** One recurring job, as the founder's own surface reports it. */
export interface UpkeepSweep {
  /** The `Schedule.task_type` this becomes. What `fireSchedule` branches on. */
  task_type: string;
  /** What it does, in the founder's words. */
  title: string;
  /** Does this project's own work call for it? False means "you do not do this yet", not "broken". */
  wanted: boolean;
  /** Is there a Schedule row for it now? */
  running: boolean;
  /**
   * Why a WANTED sweep is not running. Always a sentence naming what is missing and what therefore
   * will not happen — never "false", never an error code. Absent when `running` or not `wanted`.
   */
  blocked?: string;
  schedule_id?: string;
}

export interface UpkeepReport {
  project_id: string;
  sweeps: UpkeepSweep[];
}

/** What this project does, as facts about rows rather than as configuration. */
export interface ProjectFacts {
  /** The business has raised at least one invoice. Draft counts: it is going to be sent. */
  raises_invoices: boolean;
  /** The business has at least one unanswered ask outstanding with a client. */
  asks_clients: boolean;
  /**
   * At least one open engagement carries a recurring retainer line.
   *
   * A fact about rows, like the other two, and for the same reason: recurring revenue that only
   * billed on projects where somebody had provisioned the right blueprint is exactly the failure
   * this module's header is about, with money attached. Paused and ended retainers still count —
   * see `projectHasRetainer`.
   */
  bills_retainers: boolean;
  /**
   * At least one open engagement is on a wedge that produces a deliverable — so there is work the
   * ignition sweep could start. A fact about the project's own cases, not an install-wide flag:
   * whether to arm ignition depends on what this business is actually engaged to do. See
   * `projectDoesFulfillment`.
   */
  does_fulfillment: boolean;
}

/**
 * Read the two facts. Existence queries, capped at one row each.
 *
 * `status: "open"` on the requests side and NO status filter on the invoices side, and the asymmetry
 * is deliberate. A resolved request is finished business and implies nothing about tomorrow, whereas
 * a business that has ever raised an invoice will raise another — and switching payment sync off
 * again the moment the last invoice settles would tear down the clock exactly when a founder is most
 * likely to be watching for the next payment.
 */
export async function projectFacts(projectId: string, domain?: DomainStore): Promise<ProjectFacts> {
  if (!projectId) throw new Error("upkeep must be scoped to a project");
  const [invoices, asks, retainers, fulfils] = await Promise.all([
    getBillingStore().listInvoices({ project_id: projectId, limit: 1 }),
    getRequestStore().listRequests({ project_id: projectId, status: "open", limit: 1 }),
    // Optional store, because `projectFacts` has a caller that holds no domain store and a retainer
    // fact it cannot read must degrade to "no retainers" rather than throwing an upkeep check that
    // three other sweeps depend on. `ensureUpkeep` always passes one.
    domain ? projectHasRetainer(domain, projectId).catch(() => false) : Promise.resolve(false),
    // Same optional-store contract: no domain ⇒ "no fulfillment", never a throw.
    domain ? projectDoesFulfillment(domain, projectId).catch(() => false) : Promise.resolve(false),
  ]);
  return {
    raises_invoices: invoices.length > 0,
    asks_clients: asks.length > 0,
    bills_retainers: retainers,
    does_fulfillment: fulfils,
  };
}

/**
 * Ensure this project has every sweep its own work calls for, and report what it does not.
 *
 * IDEMPOTENT by construction: each `ensureXSchedule` finds an existing Schedule by
 * `(project_id, task_type)` before creating one, so calling this on every invoice write is a read,
 * not a write, after the first time.
 *
 * NEVER THROWS for a reason the caller cannot fix. A blocked sweep, an unclaimed role and a store
 * blip all come back inside the report, because the callers are write routes: refusing to create an
 * invoice because the dunning wedge is missing would be the tail wagging the dog. An empty
 * `projectId` DOES throw — that one is a programming error, and defaulting a scope is how both of
 * this repo's cross-tenant leaks shipped.
 */
export async function ensureUpkeep(
  domain: DomainStore,
  projectId: string,
  now: Date = new Date(),
): Promise<UpkeepReport> {
  if (!projectId) throw new Error("upkeep must be scoped to a project");
  const facts = await projectFacts(projectId, domain);
  const existing = (await domain.listSchedules()).filter((s) => s.project_id === projectId);
  const found = (taskType: string) => existing.find((s) => s.task_type === taskType);

  const sweeps: UpkeepSweep[] = [];

  /** Run one spec: report it as not-wanted, already-running, blocked, or newly created. */
  const consider = async (
    spec: { task_type: string; title: string; wanted: boolean; blocked?: string },
    create: () => Promise<Schedule>,
  ) => {
    const already = found(spec.task_type);
    if (already) {
      // Reported as running even when `wanted` is false. A project whose last invoice settled still
      // has a payment sync, and saying "not wanted" over a row that is on the clock would make this
      // surface disagree with `/clock` — which is how an operator stops trusting both.
      sweeps.push({ ...spec, running: true, blocked: undefined, schedule_id: already.id });
      return;
    }
    if (!spec.wanted || spec.blocked) {
      sweeps.push({ ...spec, running: false });
      return;
    }
    try {
      const s = await create();
      sweeps.push({ ...spec, running: true, schedule_id: s.id });
    } catch (e) {
      // The last gate. `ensureDunningSchedule` throws when its role is unclaimed, and the check
      // above should already have caught that — but a throw arriving here anyway must become a
      // sentence rather than a 500 on an invoice write, and it must not become silence either.
      const detail = (e as Error)?.message ?? String(e);
      console.error(`[mycel] upkeep: could not schedule ${spec.task_type} for project ${projectId}: ${detail}`);
      sweeps.push({ ...spec, running: false, blocked: detail });
    }
  };

  // ── money in ──────────────────────────────────────────────────────────────────────────────────
  //
  // Payment detection is FIRST and is gated on a reader rather than on a wedge, exactly as
  // `ensurePaymentSyncSchedule` argues: knowing an invoice was paid is a property of the kernel's own
  // accounts receivable, not a feature of whoever chases. It is also what makes chasing safe —
  // `paymentConfidence` reads what this writes — so a project that reconciles for a week before
  // anyone installs a chaser has fresh state the first time a chase is ever considered.
  //
  // The gate is `read_payments` having a bound provider. Without one a reconciliation can only ever
  // observe nothing, and a 15-minute clock that observes nothing for ever is the "configured feature
  // that does not exist" this file's header refuses. A business taking money by bank transfer and
  // recording it by hand (`payments.manual.ts`) is exactly that case, and it is a legitimate install
  // rather than a misconfiguration — so the sentence says what to connect, not what went wrong.
  const payments = resolveCapability("read_payments", await domain.listConnections(), projectId);
  await consider(
    {
      task_type: PAYMENT_SYNC_TASK_TYPE,
      title: "check whether your invoices have been paid",
      wanted: facts.raises_invoices,
      blocked: payments.ok
        ? undefined
        : `${payments.detail} Until then nothing here can tell an invoice that was paid from one that was not, so payments you record by hand are the only ones this business knows about.`,
    },
    () => ensurePaymentSyncSchedule(domain, projectId, PAYMENTS_WEDGE, now),
  );

  // ── money, every month ────────────────────────────────────────────────────────────────────────
  //
  // Recurring revenue. NOTHING BLOCKS THIS ONE, and that is the decision: the sweep runs no model,
  // needs no wedge, no role and no connection — it draws a draft invoice from a promise the founder
  // already priced. Every other sweep on this page can be legitimately unavailable; a retainer that
  // does not bill is never a legitimate configuration, it is the founder not being paid.
  //
  // Placed above dunning deliberately: a retainer invoice has to exist before it can be chased.
  await consider(
    {
      task_type: RETAINER_SWEEP_TASK_TYPE,
      title: "raise your recurring retainer invoices",
      wanted: facts.bills_retainers,
      blocked: undefined,
    },
    () => ensureRetainerSchedule(domain, projectId, PAYMENTS_WEDGE, now),
  );

  // ── start the work ────────────────────────────────────────────────────────────────────────────
  //
  // The one sweep that STARTS production rather than chasing or billing it. Nothing blocks it at the
  // clock level for the same reason nothing blocks the per-invoice enabled toggle above: whether a
  // given wedge is on is a per-case gate the sweep applies itself (`IgniteDeps.wedgeEnabled`), and a
  // production type it cannot find is skipped per case, not a reason to tear the clock down. Armed
  // only when the project actually has a deliverable-producing engagement open.
  await consider(
    {
      task_type: BEGIN_FULFILLMENT_TASK_TYPE,
      title: "start production on engagements that are ready",
      wanted: facts.does_fulfillment,
      blocked: undefined,
    },
    () => ensureFulfillmentSchedule(domain, projectId, PAYMENTS_WEDGE, now),
  );

  // ── money late ────────────────────────────────────────────────────────────────────────────────
  //
  // Gated on the `dunning` ROLE and not on a directory name, so a second chaser with a better ladder
  // can replace the shipped one by editing a manifest. Zero claimants is a legitimate install — a
  // bookkeeping-only business issues invoices and never chases — which is why this reports a
  // sentence instead of throwing.
  //
  // NOT gated on the wedge being enabled for this project. That is a second, per-project gate that
  // `sweepOverdueInvoices` applies per invoice through `ChaseDeps.wedgeEnabled`, and it can be turned
  // on and off while the schedule exists. Checking it here would tear the clock down on a toggle and
  // never rebuild it.
  const chaser = wedgeForRole("dunning");
  await consider(
    {
      task_type: CHASE_SWEEP_TASK_TYPE,
      title: "chase invoices that have gone overdue",
      wanted: facts.raises_invoices,
      blocked: chaser ? undefined : `${whyNoWedge("dunning")} — an overdue invoice will sit on your next-move list instead.`,
    },
    () => ensureDunningSchedule(domain, projectId, now),
  );

  // ── things clients owe us ─────────────────────────────────────────────────────────────────────
  //
  // No ROLE here, and roles.ts:31 says why: the wedge is already known — it comes off the engagement
  // the ask is attached to — so the question is "can this wedge be asked to chase", which its
  // manifest answers. What CAN be checked install-wide is whether ANY wedge declares the type at
  // all. If none does, every item this sweep finds would be refused by `startNudge`, and a clock over
  // work that can only ever be refused is the same lie as a clock over no work.
  await consider(
    {
      task_type: NUDGE_SWEEP_TASK_TYPE,
      title: "remind clients about things you have asked them for",
      wanted: facts.asks_clients,
      blocked: anyWedgeCarriesNudge()
        ? undefined
        : `no wedge in this install declares a "${NUDGE_TASK_TYPE}" task type, so an unanswered ask cannot be chased automatically — it will sit on your next-move list instead.`,
    },
    () => ensureNudgeSchedule(domain, projectId, now),
  );

  // ── CRM contacts → clients ────────────────────────────────────────────────────────────────────
  //
  // Wanted when a CRM is actually connected. Without one the import can only ever observe nothing,
  // and a 15-minute clock over nothing is the lie this module refuses.
  const connections = await domain.listConnections();
  const wantsCrm = crmWanted(connections, projectId);
  await consider(
    {
      task_type: CRM_IMPORT_TASK_TYPE,
      title: "import contacts from your CRM into clients",
      wanted: wantsCrm,
      blocked: undefined,
    },
    () => ensureCrmImportSchedule(domain, projectId, PAYMENTS_WEDGE, now),
  );

  const wantsCal = calendarWanted(connections, projectId);
  await consider(
    {
      task_type: CALENDAR_SYNC_TASK_TYPE,
      title: "sync free/busy from your calendar",
      wanted: wantsCal,
      blocked: undefined,
    },
    () => ensureCalendarSyncSchedule(domain, projectId, PAYMENTS_WEDGE, now),
  );

  return { project_id: projectId, sweeps };
}

/**
 * Ensure upkeep from inside a write route, without ever failing that write.
 *
 * The caller has just created an invoice or an ask; that must succeed whatever the state of this
 * project's wedges. But it must not be SILENT either — the whole point of this module — so every
 * wanted-and-blocked sweep is logged with its sentence, once, at the moment the business first does
 * the thing that needed it. `GET /v1/upkeep` serves the same report on demand.
 */
export async function ensureUpkeepQuietly(domain: DomainStore, projectId: string, now: Date = new Date()): Promise<void> {
  try {
    const report = await ensureUpkeep(domain, projectId, now);
    for (const s of report.sweeps) {
      if (s.wanted && !s.running) {
        console.warn(`[mycel] upkeep: project ${projectId} will not "${s.title}" — ${s.blocked}`);
      }
    }
  } catch (e) {
    console.error(`[mycel] upkeep check failed for project ${projectId}:`, (e as Error)?.message ?? e);
  }
}
