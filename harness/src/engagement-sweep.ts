// THE SWEEP THAT OPENS THE ENGAGEMENT NOBODY OPENED.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// WHY A CLIENT CAN SIT FOR A MONTH WITH NOTHING RUNNING
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// `clients.routes.ts` calls `openEngagementForNewClient` when a client is added, and that call is a
// ONE-SHOT wrapped in a `.catch` that logs. Every reason it can decline is transient or was true
// only at that instant:
//
//   · the shaping run had not landed yet, so `readBusinessShape` had nothing to read and
//     `deliveryWedge` returned undefined;
//   · the artifact backend blipped;
//   · the wedge was not yet installed for the project.
//
// Nothing ever asks again. The client row exists, the founder sees it in their clients room, and no
// engagement, no intake, no production and no deliverable will ever follow — for the life of the
// account.
//
// MEASURED IN PRODUCTION, 13 September: THIRTEEN clients across four businesses with no engagement,
// the oldest added on 16 August. Six of them belong to one real bookkeeping firm. And every signup
// in the last thirty days that got as far as adding a client is in this list.
//
// ═══ WHY THIS COULD NOT BE FIXED INSIDE THE IGNITION SWEEP ═══
//
// `fulfillment-ignite` is the sweep that STARTS production, and `upkeep.ts` arms it on
// `facts.does_fulfillment` — "at least one open engagement is on a wedge that produces a
// deliverable". So ignition only runs for a project that already has an engagement, which is exactly
// the thing these accounts do not have. The two sweeps are one step apart and the gap between them
// is where a new customer's first month goes.
//
// ═══ IT ADDS NO NEW JUDGEMENT ═══
//
// Every decision is `openEngagementForNewClient`'s, unchanged: it refuses when a case already
// exists, refuses when the business runs two producing services (whose letterhead the work goes out
// under is not ours to guess), reads the founder's own `runs_as.wedge` from the shape, and runs the
// kickoff. This module only asks the question again, later. A retry that re-decides is a second
// implementation of the decision, and the two drift.
import type { Schedule } from "./contract";
import type { DomainStore } from "./domain";
import type { Store } from "./store";
import { openEngagementForNewClient } from "./engagement-open";

export const OPEN_ENGAGEMENTS_TASK_TYPE = "open_engagements";

/**
 * Every ten minutes. The same cadence as ignition, and for the same reason: this is the recovery
 * path for a miss at signup, so a founder who adds a client and watches nothing happen should not
 * be watching for long.
 */
const SWEEP_SECONDS = 600;

/**
 * How many engagements one sweep will open for one project.
 *
 * A business that pastes in forty clients at once should not have forty kickoffs fire in the same
 * minute — each one sends intake questions to a real person, and forty emails leaving together is
 * how a domain gets burned. They open over the following sweeps instead, oldest client first, which
 * is also the order a founder would pick.
 */
const MAX_PER_SWEEP = 5;

export interface EngagementSweepSummary {
  project_id: string;
  /** Clients with no engagement at all. */
  stranded: number;
  opened: number;
  /** Declined by `openEngagementForNewClient` — no live service, or it runs two. */
  no_service: number;
  failed: string[];
  skipped_because?: string;
}

/**
 * The decision, injectable.
 *
 * Not a testing convenience — `fulfillment-ignite` takes its dependencies the same way, and for the
 * same reason: an ES module export cannot be redefined, so a sweep that reaches for its collaborator
 * through a static import can only be tested by standing up the entire engagement stack. The default
 * IS the real function, so nothing at a call site has to know this exists.
 */
export type OpenEngagement = (
  projectId: string,
  client: { id: string; display_name?: string },
  store: Store,
) => Promise<string | undefined>;

export async function sweepStrandedClients(args: {
  domain: DomainStore;
  store: Store;
  project_id: string;
  open?: OpenEngagement;
}): Promise<EngagementSweepSummary> {
  const { domain, store } = args;
  const open = args.open ?? openEngagementForNewClient;
  const project_id = args.project_id;
  if (!project_id) throw new Error("an engagement sweep must be scoped to a project");
  const summary: EngagementSweepSummary = { project_id, stranded: 0, opened: 0, no_service: 0, failed: [] };

  const clients = (await domain.listClients()).filter((c) => c.project_id === project_id);
  if (!clients.length) return summary;

  /*
    ONE read of the project's cases, not one per client. A business with forty clients would
    otherwise make forty round trips every ten minutes to answer a question one query answers.
  */
  const cases = await domain.listCases({ project_id });
  const engaged = new Set(cases.map((k) => k.client_id).filter(Boolean));

  const stranded = clients
    .filter((c) => !engaged.has(c.id))
    // Oldest first: the client who has been waiting longest is the one owed an answer.
    .sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""));
  summary.stranded = stranded.length;

  for (const client of stranded.slice(0, MAX_PER_SWEEP)) {
    try {
      const opened = await open(project_id, client, store);
      if (opened) summary.opened++;
      else summary.no_service++;
    } catch (e) {
      /*
        Reported per client and never thrown. One client whose kickoff mailbox is misconfigured must
        not stop the other four — the whole point of this module is that a single failure at one
        moment should stop costing an account its first month.
      */
      summary.failed.push(`${client.id}: ${(e as Error).message}`);
    }
  }
  return summary;
}

/** Idempotent: one schedule per project, created on first upkeep and reused after. */
export async function ensureEngagementSchedule(
  domain: DomainStore,
  projectId: string,
  wedge: string,
  now: Date = new Date(),
): Promise<Schedule> {
  if (!projectId) throw new Error("an engagement schedule must be scoped to a project");
  const existing = (await domain.listSchedules()).find(
    (s) => s.project_id === projectId && s.task_type === OPEN_ENGAGEMENTS_TASK_TYPE,
  );
  if (existing) return existing;
  return domain.createSchedule({
    project_id: projectId,
    name: "open engagements for clients that have none",
    wedge,
    task_type: OPEN_ENGAGEMENTS_TASK_TYPE,
    input: {},
    cadence: { kind: "every", seconds: SWEEP_SECONDS },
    enabled: true,
    next_run_at: new Date(now.getTime() + SWEEP_SECONDS * 1000).toISOString(),
  });
}
