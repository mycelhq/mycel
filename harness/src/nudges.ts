// The nudge: chasing a client for the thing they owe us.
//
// ═══ WHAT WAS WRONG ═══
//
// `ClientRequest` was the best noun in the kernel and the deadest one. A run raised "we need your
// March bank statement", the portal showed it to the customer, and then — nothing. Ever. Not one
// line of code in the repo moved an open request forward. The single thing a founder most wants
// automated (chasing a client for a document) was the single thing that never happened, while the
// next-move engine dutifully proposed `nudge_client_request` for a carrier that did not exist and
// greyed the button out.
//
// This is that carrier, and it is deliberately the dunning module's twin rather than a new idea:
// same single implementation shared by every door, same compare-and-set pacing, same "it enqueues,
// it does not dispatch" boundary. A second differently-shaped chasing mechanism is a second thing to
// get wrong, and the way it goes wrong is a customer receiving two emails.
//
// ═══ THE SHAPE, AND WHY IT IS THIS SHAPE ═══
//
//   · ONE IMPLEMENTATION, THREE DOORS. `startNudge` is called by the sweep, by
//     `POST /v1/requests/:id/nudge`, and by `takeMove`. dunning.ts:220-233 records what happened the
//     last time this repo let a take path and a sweep path be two copies of the same intent: they
//     agreed only because they shared an input builder, and they were one edit away from landing on
//     different rungs of the ladder. That bug was fixed this week; it is not being re-introduced.
//
//   · PACING IS A COMPARE-AND-SET, NOT A CHECK. `claimRequestForNudge` stamps `last_nudged_at` and
//     bumps `nudge_count` inside ONE statement whose WHERE clause holds every guard. With four
//     replicas, "read the row, decide a nudge is due, write that we nudged" passes the check in both
//     before either writes. See `ClientRequest.last_nudged_at`.
//
//   · IT IS HARNESS WORK DECIDING, AGENT WORK WRITING. Which requests are due a nudge is arithmetic
//     over stored rows — status, how long open, when we last nudged, how many times. A model asked
//     to do that over a list will eventually nudge a customer about something they already sent. The
//     model's job starts one level down, inside the `nudge_client_request` run, where it writes the
//     words in this firm's voice.
//
//   · IT ENQUEUES, IT DOES NOT DISPATCH. Nothing in this file sends anything. `startNudge` spawns a
//     run; the run's send goes through `awaitApproval` exactly as a dunning email does. A nudge that
//     a sweep put in a customer's inbox at 03:00 with no human in the loop would be autonomy no
//     evidence has earned.
//
//   · FAIL CLOSED ON WIRING AND ON THE WEDGE. A request with no engagement behind it has no wedge to
//     speak for it, and is refused rather than guessed at — see `nudgeWedgeFor`.
import type { ClientRequest, Schedule, TaskSource } from "./contract";
import type { DomainStore } from "./domain";
import { getRequestStore } from "./requests";
import { anyWedgeDeclares, wedgeDeclares, _resetWedgeDeclarations } from "./wedge";

/** The task type of ONE nudge — what a wedge must declare to be able to carry this. */
export const NUDGE_TASK_TYPE = "nudge_client_request";

/** The task type of the SWEEP schedule. Not the nudge itself — this is what spawns those. */
export const NUDGE_SWEEP_TASK_TYPE = "nudge_open_requests";

/** Reserved wedge slug for the sweep's own schedule, the way `WAITS_WEDGE` is. Not a wedge on disk. */
export const NUDGE_WEDGE = "requests";

/**
 * How often the sweep looks. Every four hours.
 *
 * Slower than the dunning sweep's hour because nothing here tips over at midnight: a request becomes
 * nudgeable by ageing, and the ladder below refuses anything under two days regardless. As with
 * dunning, cadence is a RESPONSIVENESS knob and not an aggression knob — `nudgeIntervalDays` decides
 * what the client experiences.
 */
export const SWEEP_SECONDS = 4 * 3600;

/** Requests one sweep will start runs for. Bounded for the reason `dunning.BATCH` is. */
export const BATCH = 25;

/**
 * Days a request must be open before the FIRST nudge, when nobody set a `due_at`.
 *
 * Three. Same number as `REQUEST_NUDGE_DAYS` in moves.ts, and it is imported from here rather than
 * restated there — two opinions about when a client has been sitting on something too long is how
 * the list proposes a nudge the carrier then refuses as paced.
 */
export const FIRST_NUDGE_DAYS = 3;

/**
 * The hard floor, mirroring `MIN_CHASE_INTERVAL_DAYS`. Never nudge the same request twice inside
 * two days, whatever else is true.
 */
export const MIN_NUDGE_INTERVAL_DAYS = 2;

/**
 * How many times we will ever chase one ask.
 *
 * Three, and then we stop and the request sits there. NOT because three is magic, but because the
 * fourth email is where an automated chaser stops being helpful and becomes the reason a client
 * mutes the sender. A request nobody answered after three asks is a conversation the founder needs
 * to have, and `check_in_case` on the engagement behind it is where that surfaces. The budget is
 * enforced inside `claimRequestForNudge`'s WHERE clause, not by a caller remembering to check.
 */
export const MAX_NUDGES = 3;

/**
 * Days between nudges, by how many have already gone out — the ladder.
 *
 * It SLOWS DOWN as it escalates, exactly like `chaseIntervalDays` and for the same reason stated
 * there: a friendly "any luck with that statement?" can reasonably repeat this week, while a third
 * ask arriving twice a week is nagging. Pure — no clock, no I/O — so the ladder is unit-testable
 * without waiting on time.
 */
export function nudgeIntervalDays(nudgesSoFar: number): number {
  if (!Number.isFinite(nudgesSoFar) || nudgesSoFar <= 0) return MIN_NUDGE_INTERVAL_DAYS;
  if (nudgesSoFar === 1) return 3;
  if (nudgesSoFar === 2) return 5;
  return 7;
}

const DAY_MS = 86_400_000;
const daysApart = (from: string, to: string): number => (Date.parse(to) - Date.parse(from)) / DAY_MS;

/**
 * Is this request due a nudge at all, ignoring pacing? (Pacing is the claim's job.)
 *
 * TWO-SIDED, matching `nudgeMove` in moves.ts: past its own `due_at`, OR open longer than
 * `FIRST_NUDGE_DAYS` when nobody set one. A request with no due date is the common case — an agent
 * raised it mid-run — and treating "no deadline" as "never urgent" is how the highest-value thing a
 * portal does quietly stops happening.
 */
export function nudgeIsDue(r: Pick<ClientRequest, "created_at" | "due_at">, nowIso: string): boolean {
  if (r.due_at && r.due_at <= nowIso) return true;
  return daysApart(r.created_at, nowIso) >= FIRST_NUDGE_DAYS;
}

// ── which wedge speaks ────────────────────────────────────────────────────────────────────────────

/**
 * Does this wedge declare the nudge task type on disk?
 *
 * The gate both `takeability` and `startNudge` consult, and neither keeps its own list. The lookup
 * and its memo moved to `wedge.ts` when `check_in_case` became the third caller of the same question
 * — see the note above `wedgeDeclares` for why three private `Map`s over the same files was a bug
 * waiting for a test that writes a manifest. This name stays because it reads better at both call
 * sites than `wedgeDeclares(w, NUDGE_TASK_TYPE)` does.
 */
export function wedgeCarriesNudge(wedge: string | undefined): boolean {
  return wedgeDeclares(wedge, NUDGE_TASK_TYPE);
}

/**
 * Does ANY installed wedge declare it?
 *
 * `upkeep.ts` asks this before giving the sweep a clock: if nothing can carry a nudge, every request
 * the sweep finds would be refused by `startNudge`, and a schedule over work that can only ever be
 * refused is the same lie as a schedule over no work.
 */
export function anyWedgeCarriesNudge(): boolean {
  return anyWedgeDeclares(NUDGE_TASK_TYPE);
}

/** Test seam — a test that writes a manifest must be able to invalidate the memo. */
export function _resetWedgeCache(): void {
  _resetWedgeDeclarations();
}

/**
 * WHICH WEDGE'S VOICE this nudge goes out in. Resolved from the ENGAGEMENT, never guessed.
 *
 * ═══ WHY THE CASE, AND WHY A REFUSAL WHEN THERE IS NONE ═══
 *
 * `ClientRequest` has no wedge column. The first version of `nudgeMove` filled the gap with
 * `scope.wedges[0] ?? DUNNING_WEDGE` — the authority's first wedge, whose order is whatever a `Set`
 * iterated in — which would have chased a client for a bank statement in the invoice-chaser's dunning
 * voice, with the dunning policy mounted as its knowledge. That is not an approximation, it is the
 * wrong firm speaking.
 *
 * A `Case` is the only row that knows both the tenant and the wedge, and an ask worth chasing is
 * almost always attached to one: it exists because some engagement is blocked. When it is not
 * attached, the honest answer is that nobody owns the voice, so this returns undefined and the move
 * stays greyed out with a sentence saying why. A founder can attach it to a case and the button
 * lights up — which is a truthful product; picking a wedge for them is not.
 */
export async function nudgeWedgeFor(domain: DomainStore, r: ClientRequest): Promise<string | undefined> {
  if (!r.case_id) return undefined;
  const kase = await domain.getCase(r.case_id);
  // The tenant of the CASE and the tenant of the REQUEST must be the same one. `getCase` cannot
  // scope itself, and the leak this codebase has shipped twice is exactly a scope checked one layer
  // up — here it would mean spawning a run under another founder's connections.
  if (!kase || kase.project_id !== r.project_id) return undefined;
  return kase.wedge;
}

// ── deps ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * What starting a nudge needs from the rest of the kernel.
 *
 * Injected rather than imported, for the reason `ChaseDeps` is: spawning a run means clamping
 * constraints against the deployment's ceilings, and all of that lives in `server.ts`. A sweep that
 * reached for it directly would drag the whole server graph into the scheduler.
 */
export interface NudgeDeps {
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

/**
 * Null until `server.ts` registers it, and a null here means the sweep does NOTHING.
 *
 * The same fail-closed wiring rule as `setChaseDeps`: it does not fall back to a simpler spawn. A
 * kernel booted without the request routes mounted has no business emailing anybody's clients.
 */
let deps: NudgeDeps | null = null;
export function setNudgeDeps(d: NudgeDeps | null): void {
  deps = d;
}

// ── starting one ─────────────────────────────────────────────────────────────────────────────────

/**
 * Why a nudge did not start. Machine codes, so a UI can say something true rather than "error".
 *
 * `paced` and `exhausted` are NOT failures. They are the ladder holding and the budget spent, and
 * the founder-facing sentence has to say so — a button reporting "something went wrong" when the
 * honest answer is "we asked them yesterday" teaches a founder to distrust the policy.
 */
export type NudgeRefusal =
  | "not_configured"
  | "no_wedge"
  | "wedge_disabled"
  | "no_carrier"
  | "not_open"
  | "too_soon"
  | "paced"
  | "exhausted"
  | "spawn_failed";

export type NudgeStart =
  | { ok: true; task_id: string; request_id: string; wedge: string; nudge_count: number }
  | { ok: false; reason: NudgeRefusal; message: string };

/**
 * The facts of an unanswered ask, as the `nudge_client_request` task type expects them.
 *
 * Lives here rather than in a route so that the swept nudge, the hand-pulled one and the one taken
 * off `/next` are provably the same input — the mistake `chaseTaskInput` was extracted to fix.
 * `nudges_sent` is the field that most changes the right tone, and it is the one a second builder
 * would have got wrong first.
 */
export function nudgeTaskInput(r: ClientRequest, nowIso: string): Record<string, unknown> {
  return {
    request_id: r.id,
    client_id: r.client_id,
    case_id: r.case_id,
    thread_id: r.thread_id,
    kind: r.kind,
    ask: r.ask,
    detail: r.detail,
    due_at: r.due_at,
    open_days: Math.max(0, Math.floor(daysApart(r.created_at, nowIso))),
    /** Past its own due date, as opposed to merely old. A different sentence, so a different fact. */
    overdue: !!r.due_at && r.due_at <= nowIso,
    /**
     * How many times we have already asked — INCLUDING this one, because the claim has already been
     * won by the time this is built. First ask reads 1, and the agent's escalation is written against
     * that rather than against an off-by-one it has to reason about.
     */
    nudges_sent: r.nudge_count ?? 1,
    max_nudges: MAX_NUDGES,
    last_nudged_at: r.last_nudged_at,
    today: nowIso.slice(0, 10),
  };
}

/**
 * Start ONE nudge. The single implementation, called by every door.
 *
 * ═══ `pacing` IS THE ONE THING CALLERS DISAGREE ABOUT, AND THEY SHOULD ═══
 *
 *   · `"ladder"` — claim only if `nudgeIntervalDays` has elapsed and the budget is not spent. What
 *     the sweep does, and what taking a move from `/next` does. It is also what makes taking a move
 *     IDEMPOTENT: move ids are deterministic, so the same row is the same move on Tuesday as on
 *     Monday, and without an atomic claim a founder double-clicking would put two emails in one
 *     inbox.
 *
 *   · `"override"` — a founder on the request itself deciding something the ladder cannot know. It
 *     still stamps `last_nudged_at`, so the sweep SEES it and does not add a second email four hours
 *     later, and it still respects `MAX_NUDGES`: the budget is about the customer's patience, which
 *     a founder clicking a button does not increase.
 *
 * NOTHING SENDS HERE. This spawns a run. The words, and the decision to put them in front of a real
 * client, go through `awaitApproval` like every other consequence.
 */
export async function startNudge(
  domain: DomainStore,
  r: ClientRequest,
  opts: { pacing: "ladder" | "override"; now?: Date },
): Promise<NudgeStart> {
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();

  if (!deps) return { ok: false, reason: "not_configured", message: "Client requests are not wired up in this deployment." };
  if (r.status !== "open") {
    return { ok: false, reason: "not_open", message: `A request that is ${r.status} cannot be nudged.` };
  }

  const wedge = await nudgeWedgeFor(domain, r);
  if (!wedge) {
    return {
      ok: false,
      reason: "no_wedge",
      message: "This ask is not attached to an engagement, so nothing owns the voice it would go out in. Attach it to a case first.",
    };
  }
  if (!deps.wedgeEnabled(r.project_id, wedge)) {
    return { ok: false, reason: "wedge_disabled", message: `The ${wedge} service is not switched on for this business.` };
  }
  if (!wedgeCarriesNudge(wedge)) {
    return {
      ok: false,
      reason: "no_carrier",
      message: `The ${wedge} service does not offer a way to chase a client for something yet — so this one is still yours to do by hand.`,
    };
  }

  // The ladder only gates the SWEEP's own patience floor. A founder overriding has already decided.
  if (opts.pacing === "ladder" && !nudgeIsDue(r, nowIso)) {
    return { ok: false, reason: "too_soon", message: `We only asked for this ${Math.floor(daysApart(r.created_at, nowIso))} day(s) ago.` };
  }

  const interval = nudgeIntervalDays(r.nudge_count ?? 0);
  const notNudgedSince =
    opts.pacing === "override"
      ? // `now` as the floor makes the pacing guard unconditional: record, don't gate. The BUDGET
        // guard below is not relaxed, because that one is the client's patience and not ours.
        nowIso
      : new Date(now.getTime() - interval * DAY_MS).toISOString();

  const claimed = await getRequestStore().claimRequestForNudge({
    project_id: r.project_id,
    id: r.id,
    notNudgedSince,
    maxNudges: MAX_NUDGES,
    at: nowIso,
  });
  if (!claimed) {
    // Two reasons the claim can be lost and they are not the same sentence to a founder. Re-read to
    // tell them apart — scoped by project, so a lost claim never reveals another tenant's row.
    const fresh = await getRequestStore().getRequest(r.project_id, r.id);
    if (fresh && (fresh.nudge_count ?? 0) >= MAX_NUDGES) {
      return {
        ok: false,
        reason: "exhausted",
        message: `We have asked ${MAX_NUDGES} times about "${r.ask}" with no answer. That is now a conversation, not another email.`,
      };
    }
    return {
      ok: false,
      reason: "paced",
      message: `We asked about "${r.ask}" recently — the next reminder is due in ${interval} day(s).`,
    };
  }

  try {
    const taskId = await deps.spawnTask({
      project_id: claimed.project_id,
      wedge,
      task_type: NUDGE_TASK_TYPE,
      client_id: claimed.client_id,
      case_id: claimed.case_id,
      // `schedule` when the ladder decided, `api` when a person asked. An operator reading the task
      // list needs to tell "the sweep did this" from "someone clicked".
      source: opts.pacing === "override" ? "api" : "schedule",
      input: nudgeTaskInput(claimed, nowIso),
    });
    return { ok: true, task_id: taskId, request_id: claimed.id, wedge, nudge_count: claimed.nudge_count ?? 1 };
  } catch (e) {
    console.error(`[mycel] failed to start a nudge for request ${r.id}:`, e);
    // A won claim that then fails to spawn is NOT rolled back — the request waits out one interval.
    // The failure mode of a claim that releases on error is two replicas racing the release, and a
    // missed nudge is cheaper than a duplicate one. Same trade as `startChase`.
    return { ok: false, reason: "spawn_failed", message: "The reminder could not be started. The next sweep will retry it." };
  }
}

// ── the sweep ────────────────────────────────────────────────────────────────────────────────────

export interface NudgeSweepSummary {
  project_id: string;
  considered: number;
  nudged: number;
  /** Passed over by the ladder, or another replica held the claim. */
  paced: number;
  /** Budget spent: asked `MAX_NUDGES` times already. Needs a human, not another email. */
  exhausted: number;
  /** Not due yet, or nothing owns the voice (no case behind the ask). */
  skipped: number;
  failed: string[];
}

/**
 * Sweep one project's open client requests and start a nudge for each one that is due one.
 *
 * `project_id` is a required field of a required argument, and it THROWS on empty. There is no
 * overload that sweeps everything; adding one would mean a single misconfigured schedule mailing
 * every tenant's clients from one project's connection.
 */
export async function sweepOpenRequests(args: {
  domain: DomainStore;
  project_id: string;
  now?: Date;
}): Promise<NudgeSweepSummary> {
  const now = args.now ?? new Date();
  const summary: NudgeSweepSummary = {
    project_id: args.project_id,
    considered: 0, nudged: 0, paced: 0, exhausted: 0, skipped: 0, failed: [],
  };
  if (!args.project_id) throw new Error("a nudge sweep must be scoped to a project");
  if (!deps) return summary;

  const rows = await getRequestStore().listRequests({
    // Pushed INTO the query, never post-filtered.
    project_id: args.project_id,
    status: "open",
    limit: 500,
  });
  // Least recently nudged first, never-nudged before that. Under a backlog bigger than BATCH this is
  // what makes successive sweeps fair instead of re-serving the head of the list for ever.
  rows.sort((a, b) => (a.last_nudged_at ?? "").localeCompare(b.last_nudged_at ?? ""));

  for (const r of rows) {
    if (summary.nudged >= BATCH) break;
    summary.considered++;
    try {
      const started = await startNudge(args.domain, r, { pacing: "ladder", now });
      if (started.ok) { summary.nudged++; continue; }
      if (started.reason === "paced") { summary.paced++; continue; }
      if (started.reason === "exhausted") { summary.exhausted++; continue; }
      if (started.reason === "spawn_failed") { summary.failed.push(r.id); continue; }
      summary.skipped++;
    } catch (e) {
      // One broken request must not stop the other twenty-four — the same rule `advanceSequences`
      // states. Counted rather than swallowed, so a systematic failure is visible in the summary.
      console.error(`[mycel] request ${r.id} could not be swept:`, (e as Error)?.message ?? e);
      summary.failed.push(r.id);
    }
  }
  return summary;
}

/**
 * Create (or find) the sweeping Schedule for a project.
 *
 * One per project. `claimDueSchedules` does the rest, including the guarantee that with four
 * replicas exactly one fires each tick. Modelled on `ensureDunningSchedule`, and it throws on an
 * empty project id for the same reason that one does.
 */
export async function ensureNudgeSchedule(
  domain: DomainStore,
  projectId: string,
  now: Date = new Date(),
): Promise<Schedule> {
  if (!projectId) throw new Error("a nudge schedule must be scoped to a project");
  const existing = (await domain.listSchedules()).find(
    (s) => s.project_id === projectId && s.task_type === NUDGE_SWEEP_TASK_TYPE,
  );
  if (existing) return existing;
  return domain.createSchedule({
    project_id: projectId,
    name: "chase unanswered client requests",
    wedge: NUDGE_WEDGE,
    task_type: NUDGE_SWEEP_TASK_TYPE,
    input: {},
    cadence: { kind: "every", seconds: SWEEP_SECONDS },
    enabled: true,
    next_run_at: new Date(now.getTime() + SWEEP_SECONDS * 1000).toISOString(),
  });
}
