// The next-move engine — the pull half of the harness.
//
// ═══ WHAT THIS FIXES ═══
//
// Everything the kernel does today is PUSH. `Schedule` fires a task on a cadence; `TriggerSub`
// fires one when a webhook lands. Both are workflows: a human decided in advance what happens and
// when, and the business only moves as far as that decision reached. A service business does not
// work like that — it loops, waits on clients, reworks, and discovers work nobody planned. vision.md
// line 45: "The important word is **next**, not **workflow**."
//
// So this module reads the state of the business and answers a different question: given everything
// that is true right now, what COULD legally be done, and which one is worth the most? That is the
// difference between a task runner and an operator, and it is the product's core claim.
//
// ═══ IT PROPOSES. NOTHING HERE SENDS. ═══
//
// `proposeMoves` is a pure read that returns a ranked list; `carrier` on each Move describes what
// WOULD carry it out. `takeMove` — added later, at the bottom of this file — will spawn that carrier
// when a founder asks, and that is the ONLY thing in here with a side effect on the business.
//
// The distinction it preserves is the whole trust story. Taking a move ENQUEUES a run; the run's
// first real-world action still goes through `awaitApproval`, so a chase a founder took from this
// list lands in `/approvals` exactly as a swept one does. Human gates stay at consequence
// boundaries; what moved is the navigation, not the boundary. An autonomous executor that skipped
// the queue would spend a founder's reputation on a ranking function nobody has audited yet.
//
// ═══ NO SECOND HOME FOR THE TRUTH ═══
//
// Every signal below is DERIVED from a noun that already exists: `Invoice.due_date` and
// `last_chased_at`, `ClientRequest.status`/`due_at`, `Case.due_at`/`updated_at`/`history`, and the
// GTM sequence's own step conditions. There is no `moves` table and no schema migration, for the
// reason client-context.ts:1-23 gives: a second copy of "this invoice is overdue" starts disagreeing
// with the first one the day someone writes a migration that touches only one of them. A Move is
// computed on read and thrown away.
//
// The ONE genuinely new piece of state is the outcome of a move — what happened after it was taken.
// It cannot be derived, because "the client paid BECAUSE we chased" is not a fact any existing row
// holds. It is stored the way insight/store.ts stores its events: append-only `Record_` rows under a
// reserved wedge slug, so it inherits `queryRecords`'s fail-closed tenant filter instead of getting
// a fifth hand-written one. See `recordOutcome`.
//
// ═══ THE LADDERS ARE NOT REIMPLEMENTED HERE ═══
//
// The dunning cadence is `chaseIntervalDays` in dunning.ts, which encodes the rungs from
// `wedges/invoice-chaser/knowledge/dunning-policy.md`. The GTM step gate is `evaluateCondition` over
// `factsFor`, from gtm/. Both are IMPORTED and CALLED. A second opinion about when to chase, living
// in a ranking function, is how a client ends up chased twice on the same day by two subsystems that
// each think they are the one doing it.
import { randomUUID } from "node:crypto";
import type { Case, CaseWait, ClientRequest, Connection, Deliverable, Invoice, Task, WaitCondition, WaitMode } from "./contract";
import type { DomainStore } from "./domain";
import { wedgeForRole } from "./roles";
import type { BillingStore } from "./billing";
import type { RequestStore } from "./requests";
import type { DeliverableStore } from "./deliverables";
import type { ActionGrant } from "./actiongrants";
import { daysBetween, effectiveStatus, invoiceTotals, minorUnitExponent } from "./billing";
import {
  CHASE_TASK_TYPE,
  chaseDaysOverdue,
  dunningWedge,
  chaseIntervalDays,
  chaseTaskInput,
  chaseHands,
  startChase,
  type ChaseRefusal,
} from "./dunning";
import {
  CHECK_IN_TASK_TYPE,
  CASE_STALE_DAYS as CHECK_IN_STALE_DAYS,
  checkInTaskInput,
  startCheckIn,
  wedgeCarriesCheckIn,
  type CheckInRefusal,
} from "./checkin";
import {
  FIRST_NUDGE_DAYS,
  MAX_NUDGES,
  NUDGE_TASK_TYPE,
  nudgeIntervalDays,
  nudgeTaskInput,
  nudgeWedgeFor,
  startNudge,
  wedgeCarriesNudge,
  type NudgeRefusal,
} from "./nudges";
// The re-arm budget, so the founder surface and the route that enforces it cannot drift. Two
// opinions about how many attempts are left is a button that offers one the kernel then refuses.
import { MAX_REARMS, describeCondition } from "./waits";
import { loadCampaign } from "./gtm/campaign";
import { evaluateCondition } from "./gtm/conditions";
import { factsFor } from "./gtm/sequence";
import { gtmWedge, isActive } from "./gtm/stages";
import { TOUCH_TASK_TYPE, startNextTouch, type TouchRefusal } from "./gtm/sequence";
import { wedgeDeclares } from "./wedge";
// The verdict is IMPORTED, never re-derived. Same rule as `chaseIntervalDays`: a second opinion
// about whether an A/B test has decided, living in a ranking function, is how a founder's home
// screen tells them to rewrite a page that `mycel-insight` is simultaneously telling the agent to
// leave alone. There is one set of thresholds and it is in insight/experiment.ts.
import { CONVERSION_METRIC, analyseExperiment, type ExperimentReport } from "./insight/experiment";
import { aggregateWindow } from "./insight/store";
import { getKnowledgeStore } from "./knowledge.store";
import { appliedRuleIds, applyStatedRules } from "./rules.rank";

/** The stores a proposal reads. Passed in, never reached for — same rule as `BrainStores`. */
export interface MoveStores {
  domain: DomainStore;
  billing: BillingStore;
  requests: RequestStore;
  /**
   * REQUIRED, not optional-with-a-singleton-fallback. The rule this module states about its other
   * three stores applies here for a sharper reason: an optional store would make
   * `invoice_accepted_work` silently absent from every caller that forgot it, and the failure mode
   * of that is a founder's home screen quietly stopping mentioning unbilled work. A missing prompt
   * is invisible; a compile error is not.
   */
  deliverables: DeliverableStore;
}

// ── authority ────────────────────────────────────────────────────────────────────────────────────
//
// ═══ DERIVED, NEVER PASSED ═══
//
// Identical in construction to `BrainAuthority` (brain.ts:64), for the same reason and after the same
// two cross-tenant leaks: `unique symbol` in a non-exported const cannot be written as a property key
// outside this module, so `const a: MoveAuthority = { project_id: "…" }` is a type error at every
// call site in the repo. The only ways to obtain one are the two constructors below, and neither
// takes a scope from a caller.
//
// WHY NOT JUST REUSE `BrainAuthority`? Because it holds exactly ONE `wedge`, and it is right to: a
// run belongs to one wedge and reads that wedge's knowledge. A move proposal is the opposite shape —
// the whole point is that an overdue invoice (invoice-chaser), a stalled engagement (books-keeper)
// and a due outreach touch (gtm-operator) compete for the same founder minute, and a
// one-wedge authority can only ever rank within a silo. Widening `BrainAuthority.wedge` to a set
// would loosen the knowledge-sensitivity gate that every brain read depends on, to serve a module
// that reads no knowledge at all. Two authorities, each tight for its own surface.

declare const BRAND: unique symbol;

/** WHAT THIS CALLER MAY PROPOSE OVER. Immutable, and only ever narrowed. */
export interface MoveAuthority {
  readonly [BRAND]: "move-authority";
  /** `"founder"` on the founder plane, so a trace that mixed planes would be obvious. */
  readonly task_id: string;
  /** Tenant. Never empty — both constructors refuse. */
  readonly project_id: string;
  /**
   * The wedges whose work may be proposed. Empty means NOTHING is proposed, never "all of them" —
   * the empty set is the tightest scope here exactly as it is in `BrainAuthority.client_ids`.
   */
  readonly wedges: readonly string[];
  /**
   * The clients whose rows may be read. Empty is a house-wide caller and reads NO client-owned row.
   * Reading empty as "unfiltered" is the bug family this whole pattern exists to make unwriteable.
   */
  readonly client_ids: readonly string[];
  readonly case_ids: readonly string[];
}

/**
 * Run plane. Derived from a task that was looked up from an action grant's nonce.
 *
 * Refuses a task with no project, the same refusal `deriveAuthority` makes and for the same reason:
 * an unattributed task must propose nothing rather than everything.
 */
export function deriveMoveAuthority(
  task: Task | undefined,
  grant?: Pick<ActionGrant, "caseId">,
): MoveAuthority | undefined {
  if (!task?.project_id) return undefined;
  const caseIds = [task.case_id, grant?.caseId].filter((v): v is string => !!v);
  return {
    task_id: task.id,
    project_id: task.project_id,
    // One wedge, because a run is one wedge's. A run must not be handed a ranked list of another
    // wedge's work and decide to carry it.
    wedges: Object.freeze([task.wedge]),
    client_ids: Object.freeze(task.client_id ? [task.client_id] : []),
    case_ids: Object.freeze([...new Set(caseIds)]),
  } as MoveAuthority;
}

/**
 * Founder plane: everything in THIS project the founder owns.
 *
 * The mirror of `founderAuthority` in brain.ts. A founder looking at their own business owns every
 * client in it, so the full sets are passed and `narrowMoves` can still only shrink the answer —
 * which is what keeps "empty means all" from ever being a code path for runs.
 */
export function founderMoveAuthority(args: {
  project_id: string;
  wedges: readonly string[];
  client_ids: readonly string[];
  case_ids: readonly string[];
}): MoveAuthority {
  if (!args.project_id) throw new Error("founderMoveAuthority: project_id is required");
  return {
    task_id: "founder",
    project_id: args.project_id,
    wedges: Object.freeze([...new Set(args.wedges)]),
    client_ids: Object.freeze([...args.client_ids]),
    case_ids: Object.freeze([...args.case_ids]),
  } as MoveAuthority;
}

/**
 * The kernel acting on its own behalf inside ONE project.
 *
 * Exists because the two derived outcomes below (`noteInvoiceSettled`, `noteReplyToTouch`) are
 * written by the harness, not by a founder and not by a run, and neither existing constructor fits:
 * `deriveMoveAuthority` needs a `Task` and there is none — a payment webhook is not a run — while
 * `founderMoveAuthority` would mean the settlement path assembling the project's full client and
 * case lists just to append one row.
 *
 * Every set is EMPTY, which is the tightest possible scope and not a shortcut: an authority built
 * here can propose literally nothing (`ownerAllowed` refuses every client-owned row, and
 * `scope.wedges` excludes every case), so if this ever leaks into a read path the answer is an empty
 * list rather than another tenant's business. The only thing it can do is what it is for: write an
 * outcome into the project the invoice or case it was derived from actually belongs to.
 */
export function systemMoveAuthority(projectId: string): MoveAuthority {
  if (!projectId) throw new Error("systemMoveAuthority: project_id is required");
  return {
    task_id: "system",
    project_id: projectId,
    wedges: Object.freeze([] as string[]),
    client_ids: Object.freeze([] as string[]),
    case_ids: Object.freeze([] as string[]),
  } as MoveAuthority;
}

/**
 * The founder-plane authority for a whole project, derived from what is actually running in it.
 *
 * ═══ WHY THIS IS A FUNCTION AND NOT A PATTERN ═══
 *
 * It lived inside `createServer` as a local, and then the autonomy sweep needed the same answer.
 * Two hand-written derivations of "which wedges, clients and cases may this founder's view reach"
 * is precisely the shape of both cross-tenant leaks this codebase has shipped: they start identical
 * and they diverge on the day somebody adds a source of wedges to one of them. There is one
 * implementation, it takes the project as an argument, and `founderMoveAuthority` still refuses an
 * empty one.
 *
 * The wedge set is DERIVED from the project's own cases and schedules rather than from a caller. It
 * can only ever narrow what `proposeMoves` reads: a project with no wedges running proposes nothing,
 * which is the correct answer for a business that has not started.
 */
export async function moveAuthorityForProject(
  domain: DomainStore,
  projectId: string,
): Promise<MoveAuthority> {
  const [clients, cases, schedules] = await Promise.all([
    domain.listClients(),
    domain.listCases({ project_id: projectId }),
    domain.listSchedules(),
  ]);
  const wedges = new Set<string>();
  for (const k of cases) wedges.add(k.wedge);
  for (const s of schedules) if (s.project_id === projectId) wedges.add(s.wedge);
  return founderMoveAuthority({
    project_id: projectId,
    wedges: [...wedges],
    // `listClients` is not project-scoped, so the filter is here and it is an INCLUDE rather than an
    // exclude: a client with no project never enters a founder's authority by accident.
    client_ids: clients.filter((cl) => cl.project_id === projectId).map((cl) => cl.id),
    case_ids: cases.map((k) => k.id),
  });
}

// ── the unit ─────────────────────────────────────────────────────────────────────────────────────

export const MOVE_KINDS = [
  "chase_invoice",
  "nudge_client_request",
  "advance_case",
  "check_in_case",
  "gtm_next_touch",
  "unblock_wait",
  "rewrite_losing_arm",
  /**
   * Work the client accepted that nobody has invoiced. See `invoiceAcceptedWorkMove`.
   *
   * ═══ WHY THIS EARNED A KIND OF ITS OWN ═══
   *
   * Every other kind here is a prompt to CHASE something — an unpaid invoice, an unanswered ask, a
   * stalled engagement. This one is the opposite end of the business and it is the only one that
   * names money the business has already earned. A small service firm's most expensive habit is
   * finishing work and forgetting to bill for it, and until the fulfilment loop existed the kernel
   * could not see it: there was no `accepted_at` anywhere to join an invoice against, so "done and
   * unbilled" and "never started" were the same absence of a row.
   *
   * It is not a sub-case of `chase_invoice`, which is the alternative that was considered. That kind
   * starts from an invoice and asks whether to chase it. This one starts from the absence of an
   * invoice, which no query over the invoice table can ever return.
   */
  "invoice_accepted_work",
  /**
   * A deliverable a run finished and left in `in_review`, waiting for the founder to release it to
   * the client. See `releaseDeliverableMove`.
   *
   * Ignition (fulfillment-ignite.ts) drafts work on its own and parks it at `in_review` — the one
   * transition the founder owns (deliverables.ts: `in_review → with_client`). Nothing surfaced that
   * anywhere: the deliverable sat invisible until someone opened the Deliverables page. This is the
   * pull-side counterpart of that push, the mirror of `invoice_accepted_work` one lifecycle step
   * earlier: certain, unquantified, NOT agent work (releasing to a client is a founder consequence
   * gate), and the value is entirely in the noticing.
   */
  "release_deliverable",
] as const;
export type MoveKind = (typeof MOVE_KINDS)[number];

/**
 * What a move is ABOUT — the thing an outcome is recorded against, and the thing a row links to.
 *
 * ═══ "experiment" IS NOT A CLAIM THAT THE MARKETING SITE IS A NOUN ═══
 *
 * It is close to the opposite, and the distinction is worth writing next to the code rather than in
 * a design note nobody reads.
 *
 * The three ontology nouns — client, case, invoice — share a property that is not decorative: each
 * is a row with a FOREIGN KEY to another one. That is what lets `graph.ts` derive edges without
 * storing an edge table, and what lets `ask.ts` walk from "Acme" to Acme's overdue invoice without
 * being told they are related. A noun here is a thing with a counterparty.
 *
 * The marketing site has no counterparty. No `client_id`, no `case_id`, no row of its own; it is a
 * PROPERTY OF THE PROJECT, like the brand kit or the domain — one per tenant, related to nothing,
 * reachable from no root. Adding it to the graph would add a node with zero edges, which is not an
 * ontology entry; it is a one-row table wearing an ontology's clothes, and every traversal in
 * `neighbourhood` would step over it forever.
 *
 * What IS real, and what this kind ranks, is a DECIDED EXPERIMENT: a verdict `insight/experiment.ts`
 * computed from counters, naming one arm to rewrite, recomputed on every read exactly as every other
 * move in this file is recomputed from an invoice or a case. So the honest answer to "is the site a
 * noun, or is a decided experiment a move with no noun behind it" is the second. `entity.kind:
 * "experiment"` exists only so the outcome ledger and the UI have something stable to key on — NOT
 * so something new appears in the graph. `NodeKind` in graph.ts is deliberately unchanged.
 */
export type MoveEntityKind =
  | "invoice"
  | "client_request"
  | "case"
  /**
   * A `Deliverable`. Added under the same test the comment above sets and passing it plainly: a noun
   * is a thing with a counterparty, and this row's counterparty is the client — `client_id` and
   * `case_id` are real, required foreign keys on it, so `graph.ts` could derive its edges tomorrow
   * with no edge table and no migration, exactly as it does for the other three. It is the opposite
   * of the `experiment` case directly above, which is a computed verdict with nothing to link to.
   */
  | "deliverable"
  | "experiment";

/**
 * One term of the score, with the sentence that justifies it.
 *
 * The list of these IS the answer to "why this one?", and it is computed rather than narrated: a
 * founder who disagrees with a ranking can see which term dominated and argue with that number
 * instead of with a black box. vision.md's "explaining why it did something when asked" is a
 * property of the data structure here, not of a prompt.
 */
export interface ScoreTerm {
  term: string;
  points: number;
  because: string;
}

/** The raw facts the score was computed from. Numbers, so the UI never re-derives them. */
export interface MoveSignals {
  /** Minor units, always — see the MONEY comment on `Invoice`. Never divided, never a float. */
  money_at_stake?: number;
  currency?: string;
  minor_unit_exponent?: number;
  /** Whole days past a due date. Absent when the entity has no deadline. */
  days_overdue?: number;
  /** Whole days until a due date. Absent when there is no deadline or it has passed. */
  days_until_due?: number;
  /** Whole days since anything happened on this entity. */
  days_stale?: number;
  /** What past moves of this kind achieved in this project. Absent below the evidence floor. */
  learned?: OutcomeStat;
}

/**
 * A proposed next action over the business.
 *
 * `id` is DETERMINISTIC — `${kind}:${entity_id}` — and that is load-bearing rather than tidy. A
 * proposal is recomputed on every read, so a random id would mean the outcome a founder records
 * against a move they saw an hour ago references a row nothing can ever find again. With a derived
 * id, "we chased invoice X" is the same move on Tuesday as it was on Monday, and the outcome ledger
 * accumulates against something stable.
 */
export interface Move {
  id: string;
  project_id: string;
  kind: MoveKind;
  entity: { kind: MoveEntityKind; id: string; label: string };
  client_id?: string;
  case_id?: string;
  /** One sentence a founder reads. The headline; `score_terms` is the working. */
  why: string;
  signals: MoveSignals;
  score: number;
  score_terms: ScoreTerm[];
  /**
   * What would carry this out. A PROPOSAL — nothing in this module spawns it.
   *
   * `input` is built by the wedge's own input builder where one exists (`chaseTaskInput`), so a move
   * taken from this list and a chase started by the dunning sweep are provably the same run. They
   * were about to be two builders that drift on `days_overdue`, which is the field the chase ladder
   * branches on.
   */
  carrier: { wedge: string; task_type: string; input: Record<string, unknown> };
  /**
   * Whether `takeMove` would actually run this, and the sentence to show when it would not.
   *
   * TRAVELS ON THE MOVE so the UI never holds a second copy of the answer. The first version of the
   * take button had its own list of takeable kinds in the browser, which is the same mistake as a
   * `moves` table: two copies of "can this be carried" disagree the day somebody wires a carrier and
   * updates only one of them, and the failure mode is a live button that throws on click.
   *
   * `takeable: false` is a real product state, not an unfinished corner, and it is now a DECISION
   * for every kind rather than a gap. Four kinds are refused on purpose and each for its own reason
   * (see `takeability`): advancing an engagement is the work in it, deciding a dead wait is a
   * judgement, rewriting a page would publish it, and pricing your own work is not agent work. A
   * greyed-out control that says which of those it is, and what to do instead, is honest — one that
   * errors is broken, and one that lights up over an empty declaration is worse than both.
   */
  takeable: boolean;
  unavailable_reason?: string;
  /**
   * Set when the next step belongs to someone else. A nudge is still worth making — but it is worth
   * less than work we can finish ourselves, and the ranking says so.
   */
  blocked_on?: "client";
  proposed_at: string;
}

// ── the ranking, and why it is this ranking ──────────────────────────────────────────────────────
//
// A move nobody can justify is worse than no move. So the score is a sum of four terms a founder
// would recognise from running the business by hand, each capped so no single term can bully the
// list, plus a fifth learned from what actually worked here.
//
//   money (0..40) + deadline (0..30) + staleness (0..20) − blocked (15) + learned (−12..+8)
//
// The caps are the argument. Money is the biggest single term because a service business that
// collects is a business and one that does not is a hobby — but it is capped at 40 of a ~90 ceiling
// so a large invoice cannot bury an engagement that ships tomorrow. If you change one number here,
// change this comment.

/** Money's ceiling. The largest single term, deliberately: cash is the business's oxygen. */
const MONEY_MAX = 40;
/**
 * The invoice size, in MAJOR units, at which the money term saturates.
 *
 * $100k. Log-scaled below it, because attention does not scale with money: a $10,000 invoice matters
 * far more than a $100 one, but not 100× more — chasing either costs the founder about the same
 * minute, so the marginal value of size falls off fast. A linear term made every small overdue
 * invoice invisible behind one big one, which is precisely the backlog a chaser is bought to clear.
 */
const MONEY_SATURATION_MAJOR = 100_000;

/** Deadline's ceiling. Reached the moment something is actually late. */
const DEADLINE_MAX = 30;
/**
 * How far ahead a deadline starts to pull. Two weeks.
 *
 * Beyond it a due date is a fact, not a signal — there is nothing useful to do about a deadline a
 * month out, and scoring it non-zero pushes a founder to touch work that is not ready.
 */
const DEADLINE_HORIZON_DAYS = 14;

/** Staleness's ceiling. */
const STALENESS_MAX = 20;
/**
 * Where staleness saturates. Thirty days.
 *
 * The cliff is in the first fortnight: silence between day 2 and day 14 is where a client decides
 * whether we are on it. After a month the marginal harm of one more silent day is ~0 and the
 * relationship problem is not one more email — so the term flattens rather than growing without
 * bound and parking dead engagements permanently at the top of the list.
 */
const STALENESS_SATURATION_DAYS = 30;

/**
 * The penalty for a move whose next step is the client's.
 *
 * NOT zero and not a filter. Nudging IS the move — a client sitting on a document is exactly the
 * thing that never gets chased when a human runs the business. But a nudge cannot be COMPLETED by
 * us, so it must rank below work we can finish, or a founder's list fills with waiting.
 */
const BLOCKED_PENALTY = 15;

/**
 * A case with no activity for this long is worth a check-in even with nothing else due.
 *
 * RE-EXPORTED from checkin.ts rather than restated, exactly as `REQUEST_NUDGE_DAYS` is re-exported
 * from nudges.ts and for the identical reason. It was a literal `7` here and the carrier's cooldown
 * would have been a second one: two opinions about how long silence is allowed to last means the
 * list proposes a check-in the carrier then refuses as `paced`, and the founder gets a button that
 * does nothing. The name stays because three surfaces already read it.
 */
export const CASE_STALE_DAYS = CHECK_IN_STALE_DAYS;
/**
 * A `ClientRequest` open longer than this stops being polite and starts being a problem.
 *
 * RE-EXPORTED from nudges.ts rather than restated. It was a literal `3` here and a second literal in
 * the carrier, which is the `chaseIntervalDays` mistake in miniature: two opinions about when a
 * client has been sitting on something too long means the list proposes a nudge that the carrier then
 * refuses as `too_soon`, and the founder gets a button that does nothing.
 */
export const REQUEST_NUDGE_DAYS = FIRST_NUDGE_DAYS;
/** How far ahead a `Case.due_at` counts as "approaching". */
export const CASE_DUE_SOON_DAYS = 7;

/** Number of moves one proposal returns. Bounded for the same reason every sweep in here is. */
export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 100;

const round = (n: number): number => Math.round(n * 10) / 10;
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/**
 * Money at stake, log-scaled and capped. Pure, so the curve is testable without a store.
 *
 * FX IS NOT MODELLED, and that is a stated limitation rather than an oversight. The kernel has no
 * rate source, and inventing one would make an invoice's rank depend on a number nobody in the
 * business can see. Within a currency the ordering is exact; across currencies it compares
 * magnitudes, which is right for the overwhelmingly common case (a firm bills in one currency) and
 * honestly approximate otherwise. A founder billing in both JPY and USD will see this; that is when
 * a rate belongs in the product.
 */
export function moneyPoints(amountMinor: number, currency: string): number {
  if (!Number.isFinite(amountMinor) || amountMinor <= 0) return 0;
  const major = amountMinor / 10 ** minorUnitExponent(currency);
  const scaled = Math.log10(1 + major) / Math.log10(1 + MONEY_SATURATION_MAJOR);
  return round(clamp(scaled, 0, 1) * MONEY_MAX);
}

/**
 * Deadline proximity. `daysUntil` is negative once the date has passed.
 *
 * Late is FLAT at the maximum rather than growing with how late it is. Deliberate: a thing 90 days
 * late is not three times more urgent than one 30 days late — it is a different conversation, and
 * letting overdue-ness grow unbounded would let one ancient item hold the top of the list for ever
 * while everything that could still be saved on time sat under it. How late something is belongs to
 * the money term (an old debt is usually a big one) and to the wedge's own ladder.
 */
export function deadlinePoints(daysUntil: number | undefined): number {
  if (daysUntil === undefined || !Number.isFinite(daysUntil)) return 0;
  if (daysUntil <= 0) return DEADLINE_MAX;
  if (daysUntil >= DEADLINE_HORIZON_DAYS) return 0;
  // Linear ramp toward the deadline: two weeks out is nothing, tomorrow is nearly everything.
  return round((1 - daysUntil / DEADLINE_HORIZON_DAYS) * DEADLINE_MAX);
}

/** Staleness, saturating. See `STALENESS_SATURATION_DAYS` for why it flattens rather than grows. */
/**
 * The flat worth of "finished and signed off". Sits between the deadline maximum (30) and the money
 * maximum (40) on purpose: accepted work beats every deadline-driven prompt in the list, and still
 * loses to a large overdue invoice, whose money term alone can reach 40 before its own deadline and
 * staleness terms are added. That is the ordering `moves.test.ts` pins.
 */
const ACCEPTED_WORK_POINTS = 32;

export function stalenessPoints(daysStale: number | undefined): number {
  if (daysStale === undefined || !Number.isFinite(daysStale) || daysStale <= 0) return 0;
  return round(clamp(daysStale / STALENESS_SATURATION_DAYS, 0, 1) * STALENESS_MAX);
}

// ── ranking speculative work against certain money ───────────────────────────────────────────────
//
// ═══ THE PROBLEM, STATED BEFORE THE ANSWER ═══
//
// "Rewrite the landing page that lost the A/B test" and "chase a $4,000 overdue invoice" have to
// share one list. The invoice's claim is CERTAIN and SPECIFIC — a named client owes a named number
// on a date that has passed. The rewrite's claim is REAL but SPECULATIVE and DIFFUSE — a page that
// converts 18% better on a proxy metric (`CONVERSION_METRIC` says out loud that it measures intent,
// not revenue) will probably, eventually, over unknown traffic, produce unknown money.
//
// There are two obvious ways to do this and both are bad:
//
//   (a) Score it on the existing terms. It has no invoice, so `money` is 0 and `deadline` is 0 —
//       roughly 55 of the ~90 ceiling gone. It lands under every stale case and is never seen. The
//       loop stays one that turns when somebody remembers to turn it, which is the thing this
//       change exists to stop.
//   (b) Invent a money value. Multiply the lift by an estimated traffic by an imagined deal size,
//       write the product into `signals.money_at_stake`, and let it compete on the money axis.
//
// ═══ (b) IS REFUSED, AND THE REASON IS A CONCRETE BUG, NOT A PRINCIPLE ═══
//
// `money_at_stake` is not a scoring input. It is a FACT ON THE WIRE, in integer minor units, and the
// founder surface sums it: `moneyInPlay()` in cloud/app/(app)/next/moves-view.tsx adds it up across
// every move and prints "$X in play" on the home screen. Putting a modelled number in that field
// does not merely rank one row wrongly — it makes the total on the founder's home screen a number
// that is part real debt and part arithmetic we made up, with nothing on the surface distinguishing
// them. There is no version of that which is honest, and the founder's response to a number they
// later discover was inflated is to stop believing the whole screen.
//
// So this kind has NO MONEY TERM AT ALL. It does not compete on the money axis; it competes on two
// terms of its own, and the caps are chosen so that it CANNOT cross into the money band.
//
// ═══ (a) IS ANSWERED BY GIVING IT ITS OWN AXIS, WITH A CEILING ═══
//
//   evidence (0..18) + waste (0..12) + learned (−12..+8)   ⇒   maximum 38
//
// Against that, ANY invoice that is actually late already scores `DEADLINE_MAX` (30) before a penny
// of money is counted, so it needs only 8 more points of money to win — which `moneyPoints` reaches
// at about $10. The property, stated so it can be tested and so the next person changing a constant
// knows what they are breaking:
//
//   **An overdue invoice for $10 or more outranks the best possible site move, always.**
//
// `moves.test.ts` asserts it at $100 for headroom. It is a claim about the CAPS, not about the
// scores that happen to occur, so it holds for every experiment that will ever be decided rather
// than for the ones we thought of. If you raise either cap below, you break it — go and change the
// test, and be ready to defend a home screen where a landing page beats money owed.
//
// The other half of the claim is that it is not buried: a `check_in_case` on a silent engagement
// tops out at STALENESS_MAX + LEARNED_MAX = 28, so a decided experiment sits ABOVE housekeeping and
// BELOW cash. That band — "worth your afternoon, not worth your morning" — is exactly what a
// speculative-but-evidenced improvement is worth, and it is the one place in the list where it can
// sit without either lying or hiding.

/** Evidence's ceiling. Below `STALENESS_MAX` on purpose: this is the softer of two soft signals. */
const EVIDENCE_MAX = 18;
/**
 * The relative lift at which evidence saturates: a doubling.
 *
 * Log-scaled for the same reason money is. `experiment.ts` already refused everything under
 * `MIN_RELATIVE_LIFT` (10%), so the floor of this curve is ~9 points, not 0 — every move that
 * exists at all has already cleared four statistical gates and deserves a non-trivial number. Above
 * a doubling the curve flattens because "the new page converts three times better" is not three
 * times more urgent than "twice as well"; both mean *rewrite the loser now*, and the work is the
 * same size either way.
 */
const LIFT_SATURATION = 1.0;

/** Waste's ceiling. The smallest term here — it is a proxy for cost, not a measure of it. */
const WASTE_MAX = 12;
/**
 * Exposures on the losing arm at which waste saturates.
 *
 * WHAT THIS TERM IS: the number of real visitors who were shown the arm we now know is worse. It is
 * the closest honest analogue to "money at stake" that does not require inventing money — a count of
 * observed events, not a model of revenue. Ten thousand people meeting the worse front door is a
 * different situation from two hundred, and the ranking should know.
 *
 * WHAT IT IS NOT: a conversion of visitors into dollars. Nothing here multiplies by a deal value.
 * `experiment.ts`'s floor is 200 exposures per arm, so the curve starts at ~7 rather than at 0 —
 * which is correct, since an experiment that decided at all has already been seen by enough people
 * to matter.
 */
const WASTE_SATURATION = 10_000;

/**
 * How much of the recent past a proposal reads when looking for a decided experiment. Fourteen days.
 *
 * Longer than the summary's default 7 because the gates in `experiment.ts` are strict enough that a
 * small business's marketing page can take a fortnight to accumulate 200 exposures per arm, and a
 * verdict that exists on a 14-day window but not a 7-day one is a verdict, not noise. Shorter than
 * 90 because an arm that won two months ago against copy that has since been rewritten is a stale
 * comparison, and a move proposed from it would send an agent to edit a file that no longer says
 * what the numbers were about.
 */
export const EXPERIMENT_WINDOW_DAYS = 14;

/** Strength of a verdict, log-scaled in the relative lift. Pure — testable without a store. */
export function evidencePoints(relativeLift: number | null | undefined): number {
  if (typeof relativeLift !== "number" || !Number.isFinite(relativeLift) || relativeLift <= 0) return 0;
  const scaled = Math.log10(1 + relativeLift * 100) / Math.log10(1 + LIFT_SATURATION * 100);
  return round(clamp(scaled, 0, 1) * EVIDENCE_MAX);
}

/** Visitors shown the losing arm, log-scaled and capped. Pure. */
export function wastePoints(exposures: number | undefined): number {
  if (typeof exposures !== "number" || !Number.isFinite(exposures) || exposures <= 0) return 0;
  const scaled = Math.log10(1 + exposures) / Math.log10(1 + WASTE_SATURATION);
  return round(clamp(scaled, 0, 1) * WASTE_MAX);
}


// ── outcomes: the half that makes it learn ───────────────────────────────────────────────────────
//
// vision.md's loop is "see state → choose next economic action → act inside policy → measure cash /
// retention / quality → update judgment → ask less next time". Everything above is the first half.
// Without this the engine would propose the same ranking for ever and could never be shown to be
// wrong, which is the thing that separates an operator from a very confident list.

export const MOVE_RESULTS = ["paid", "replied", "done", "ignored", "rejected"] as const;
export type MoveResult = (typeof MOVE_RESULTS)[number];

/** Results that mean the move earned its place. */
const WORKED: readonly MoveResult[] = ["paid", "replied", "done"];

/** Reserved wedge slug for this module's rows, exactly as `INSIGHT_WEDGE` is. Not a wedge on disk. */
export const MOVES_WEDGE = "moves";
export const OUTCOME_COLLECTION = "move_outcome";

/**
 * What happened after a move was taken.
 *
 * Deliberately tiny: which move, which entity, what happened, who said so. Everything else about the
 * move is recomputable from the entity, and copying the score in would freeze a number that the
 * ranking function is expected to change.
 */
export interface MoveOutcome {
  v: 1;
  move_id: string;
  kind: MoveKind;
  entity_id: string;
  result: MoveResult;
  /** Member id, `"agent"`, or `"system"`. */
  by: string;
  note?: string;
  at: string;
}

export interface OutcomeStat {
  kind: MoveKind;
  taken: number;
  worked: number;
  ignored: number;
  rejected: number;
}

/**
 * Persist one outcome. APPEND-ONLY, with a UUID in the natural key so the upsert never merges.
 *
 * The same trap insight/store.ts documents at length: `upsertRecord` merges `data` SHALLOWLY with no
 * arithmetic, so a running per-kind counter row would be a read-modify-write that loses updates the
 * moment two tabs record an outcome at once. Rows are immutable; the counting happens on read.
 */
export async function recordOutcome(
  domain: DomainStore,
  auth: MoveAuthority,
  o: Omit<MoveOutcome, "v" | "at"> & { at?: string },
): Promise<MoveOutcome> {
  const row: MoveOutcome = { v: 1, ...o, at: o.at ?? new Date().toISOString() };
  await domain.upsertRecord({
    // The tenant comes from the AUTHORITY, never from the caller's body. An outcome written into
    // another project's ledger would quietly retrain that founder's ranking.
    project_id: auth.project_id,
    wedge: MOVES_WEDGE,
    collection: OUTCOME_COLLECTION,
    // Move-prefixed so the history of one move is a `LIKE` during an incident, not a table scan.
    key: `${row.move_id}:${randomUUID()}`,
    data: row as unknown as Record<string, unknown>,
  });
  return row;
}

/** How many outcome rows one proposal will read before it stops learning and just ranks. */
export const MAX_OUTCOME_ROWS = 2_000;

/**
 * Evidence floor before a kind's history is allowed to move its rank.
 *
 * Five. Adjusting a founder's list from two data points is superstition wearing a percentage sign,
 * and the first thing a founder would notice is the engine confidently deprioritising the one thing
 * they happened to ignore twice while on holiday.
 */
export const MIN_EVIDENCE = 5;

/** The learned term's bounds. Asymmetric on purpose — see `learnedPoints`. */
const LEARNED_MIN = -12;
const LEARNED_MAX = 8;

/**
 * The ceiling a `rewrite_losing_arm` move can never exceed. See the long note above `evidencePoints`.
 *
 * Exported so the guarantee "certain overdue money always wins" is a VALUE the test can compare
 * against, not a sentence in a comment. A test that recomputed the sum itself would keep passing no
 * matter which constant somebody raised, which is exactly how a defended ranking becomes an
 * undefended one six months later. Declared here rather than beside `WASTE_MAX` only because
 * `LEARNED_MAX` is initialised on this line and a module-level const cannot read ahead of itself.
 */
export const MAX_SITE_MOVE_SCORE = EVIDENCE_MAX + WASTE_MAX + LEARNED_MAX;

/**
 * Every outcome row this authority may read, newest first. ONE query, TWO readers.
 *
 * `outcomeStats` and `consequencesOf` are the same rows asked two different questions — "how well
 * does this kind of move work here" and "what did the business achieve this fortnight". Reading them
 * twice would double the cost of every home page load to compute two views of one answer, and would
 * be two places for the tenant filter to be written differently. `queryRecords` orders newest first
 * on both backends, which is what makes `MAX_OUTCOME_ROWS` a safe truncation for the recency-based
 * reader: the rows it drops are the old ones nothing was going to show.
 */
async function readOutcomes(domain: DomainStore, auth: MoveAuthority): Promise<MoveOutcome[]> {
  const rows = await domain.queryRecords({
    // Pushed INTO the query, never post-filtered. A post-filter only protects the rows the query
    // happened to return and leaks the moment a `limit` truncates another tenant's rows into view.
    project_id: auth.project_id,
    wedge: MOVES_WEDGE,
    collection: OUTCOME_COLLECTION,
    limit: MAX_OUTCOME_ROWS,
  });
  const out: MoveOutcome[] = [];
  for (const r of rows) {
    const o = r.data as unknown as MoveOutcome | undefined;
    // A row whose kind or result this kernel no longer knows is SKIPPED, not coerced. The ledger is
    // append-only and outlives the enum, so a kind deleted in a later version must not be counted as
    // whatever sorts first.
    if (!o || !(MOVE_KINDS as readonly string[]).includes(o.kind)) continue;
    if (!(MOVE_RESULTS as readonly string[]).includes(o.result)) continue;
    out.push(o);
  }
  return out;
}

export async function outcomeStats(
  domain: DomainStore,
  auth: MoveAuthority,
): Promise<Map<MoveKind, OutcomeStat>> {
  return statsOf(await readOutcomes(domain, auth));
}

/** The per-kind tally. Pure, so `learnedPoints`'s inputs are testable without a store. */
export function statsOf(rows: readonly MoveOutcome[]): Map<MoveKind, OutcomeStat> {
  const out = new Map<MoveKind, OutcomeStat>();
  for (const o of rows) {
    const stat = out.get(o.kind) ?? { kind: o.kind, taken: 0, worked: 0, ignored: 0, rejected: 0 };
    stat.taken += 1;
    if (WORKED.includes(o.result)) stat.worked += 1;
    if (o.result === "ignored") stat.ignored += 1;
    if (o.result === "rejected") stat.rejected += 1;
    out.set(o.kind, stat);
  }
  return out;
}

// ── consequences: the half a founder can feel ────────────────────────────────────────────────────
//
// ═══ WHAT THIS FIXES ═══
//
// The list answered "what should I do next" and nothing answered "and did any of it work". Every
// outcome the harness observed — an invoice settling after a chase, a client answering an ask after
// a reminder, a prospect replying after a touch — went straight into the ledger, moved
// `learnedPoints` by a point or two, and was never shown to anybody. So the loop turned invisibly:
// the founder took a move, the business moved, and their home screen looked exactly the same, one
// row shorter. A product whose whole claim is "take the next client without the next hire" cannot
// be a screen where nothing ever visibly lands.
//
// ═══ WHY IT IS DERIVED FROM THE SAME LEDGER AND NOT A NEW ONE ═══
//
// These are the rows `noteInvoiceSettled`, `noteRequestAnswered` and `noteReplyToTouch` already
// write, from facts the kernel watched go by — a payment webhook, a portal answer, an inbound reply.
// Nothing new is stored and nothing is inferred: a second table of "wins" would disagree with the
// ledger the first time somebody backdated a payment, and an inferred win is the `ignored` mistake
// in reverse (see the header above `PAID_ATTRIBUTION_DAYS` for why absence is never evidence here).
//
// ═══ WHY THEY ARE RANKED RATHER THAN LISTED ═══
//
// For the same reason the moves are. Sixteen things happened this fortnight and four of them are
// worth a founder's attention; a reverse-chronological feed puts a prospect's "thanks, not now"
// above eleven thousand pounds landing, and a surface that does that gets skimmed and then ignored.

/** How far back a proposal looks for things that landed. A fortnight — one billing conversation. */
export const CONSEQUENCE_WINDOW_DAYS = 14;
/** How many are returned. Bounded for the same reason every list in this file is. */
export const MAX_CONSEQUENCES = 8;

/**
 * Something the business ACHIEVED, ranked. Derived on read, exactly like a `Move`.
 */
export interface Consequence {
  /** The move it closes the loop on — the deterministic id, so the UI can link the two. */
  move_id: string;
  kind: MoveKind;
  entity_id: string;
  result: MoveResult;
  /** The sentence the observer wrote when it recorded the fact. Never re-worded here — see below. */
  what: string;
  /** Member id, `"agent"`, or `"system"`. `system` means the kernel watched it happen. */
  by: string;
  at: string;
  /** What put it at this position. Exposed for the same reason `score_terms` is: so it is arguable. */
  weight: number;
}

/**
 * How much each kind of landing is worth. Money first, and the gaps are the argument.
 *
 *   · `paid` (100) — cash arrived. Nothing else on this list is in the same category, and a founder
 *     who sees one settlement and seven replies should see the settlement first every time.
 *   · `done` (60) — an ask was answered, so work that was STOPPED is now moving. Second because it
 *     unblocks something real, and below money because it only unblocks it.
 *   · `replied` (40) — a stranger answered. Genuinely good and genuinely early: most replies are not
 *     revenue, and ranking them alongside a settlement would flatter the outbound machinery.
 *
 * `ignored` and `rejected` are absent, and their absence is deliberate rather than an omission: they
 * are outcomes but they are not consequences. A list of things that did not work is a different
 * surface with a different job (it is what `learnedPoints` is for), and mixing it in here would turn
 * the one place the founder sees the business move into another queue to feel bad about.
 */
const CONSEQUENCE_WEIGHT: Partial<Record<MoveResult, number>> = { paid: 100, done: 60, replied: 40 };

/**
 * Rank what landed. Pure — no store, no clock of its own — so the ordering is testable at a table.
 *
 * WITHIN a weight class the tiebreak is recency, and only within: age must never let a reply climb
 * above a payment, or the ordering is just a feed again. `move_id` breaks a remaining tie so two
 * things recorded in the same millisecond do not reorder between two page loads.
 *
 * The sentence is the observer's OWN `note`, verbatim. Rewriting it here would give the ledger and
 * the home screen two accounts of one event, and the day they disagree is the day the founder stops
 * believing either — the same rule `rewriteArmMove` follows with `report.verdict`.
 */
export function consequencesOf(rows: readonly MoveOutcome[], now: Date): Consequence[] {
  const floor = new Date(now.getTime() - CONSEQUENCE_WINDOW_DAYS * 86_400_000).toISOString();
  const out: Consequence[] = [];
  for (const o of rows) {
    const weight = CONSEQUENCE_WEIGHT[o.result];
    if (weight === undefined) continue;
    if (!o.at || o.at < floor) continue;
    out.push({
      move_id: o.move_id,
      kind: o.kind,
      entity_id: o.entity_id,
      result: o.result,
      // A row written before notes were required still has to render. The fallback is deliberately
      // plain rather than invented: it says what the ledger knows and claims nothing it does not.
      what: o.note ?? `${o.kind.replace(/_/g, " ")} — ${o.result}`,
      by: o.by,
      at: o.at,
      weight,
    });
  }
  out.sort((a, b) => b.weight - a.weight || b.at.localeCompare(a.at) || a.move_id.localeCompare(b.move_id));
  return out.slice(0, MAX_CONSEQUENCES);
}

/**
 * How much this firm's own history moves a kind's rank.
 *
 * ASYMMETRIC, and that is the point. The downside is larger than the upside (−12 vs +8) because the
 * two errors are not equal: a kind that keeps being REJECTED is a kind the founder has told us,
 * repeatedly, not to do — continuing to put it at the top is how a product gets closed. A kind that
 * keeps working is already being ranked well by the money and deadline terms; boosting it hard would
 * mostly starve everything else.
 *
 * Rejections count double against the score. "Ignored" means the founder had a busier minute;
 * "rejected" means they looked at it and said no.
 */
export function learnedPoints(stat: OutcomeStat | undefined): number {
  if (!stat || stat.taken < MIN_EVIDENCE) return 0;
  const workedRate = stat.worked / stat.taken;
  const rejectedRate = stat.rejected / stat.taken;
  // Centred on 0.5: a kind that works half the time is neither promoted nor demoted.
  const lift = (workedRate - 0.5) * 2 * LEARNED_MAX;
  const drag = rejectedRate * 2 * Math.abs(LEARNED_MIN);
  return round(clamp(lift - drag, LEARNED_MIN, LEARNED_MAX));
}

// ── the enumerator ───────────────────────────────────────────────────────────────────────────────

/** What a caller may ask for. Every field NARROWS; none of them can widen anything. */
export interface MoveRequest {
  client_id?: string;
  case_id?: string;
  kinds?: MoveKind[];
  limit?: number;
}

/** Authority ∩ request. Intersection only — there is no union anywhere in this file. */
export interface MoveScope {
  project_id: string;
  wedges: string[];
  client_ids: string[];
  case_ids: string[];
  kinds: MoveKind[];
  limit: number;
}

/**
 * Apply a caller's filters to an authority.
 *
 * Naming a client that is not in the authority yields the EMPTY set — not an error, and not the
 * authority's own set. Asking about someone else's client returns nothing and reveals neither that
 * they exist nor that we work for them. Copied deliberately from `narrow` in brain.ts, because two
 * differently-written versions of this function is how the first leak happened.
 */
export function narrowMoves(auth: MoveAuthority, req: MoveRequest): MoveScope {
  const wanted = req.kinds?.filter((k): k is MoveKind => (MOVE_KINDS as readonly string[]).includes(k));
  return {
    project_id: auth.project_id,
    wedges: [...auth.wedges],
    client_ids: req.client_id ? auth.client_ids.filter((c) => c === req.client_id) : [...auth.client_ids],
    case_ids: req.case_id ? auth.case_ids.filter((k) => k === req.case_id) : [...auth.case_ids],
    kinds: wanted?.length ? wanted : [...MOVE_KINDS],
    limit: clamp(Math.floor(req.limit ?? DEFAULT_LIMIT), 1, MAX_LIMIT),
  };
}

/** Is a row owned by `owner` readable here? Unowned rows are house-wide, as everywhere else. */
const ownerAllowed = (scope: MoveScope, owner?: string): boolean =>
  !owner ? true : scope.client_ids.includes(owner);

/**
 * An engagement that is deliberately parked, rendered for a founder.
 *
 * A PROJECTION of `CaseWait`, not the row: `/next` is the founder's surface and the row carries a
 * `resume.input` blob and a condition discriminant that mean nothing to them. What they need is the
 * sentence, who it is on, and when the kernel gives up.
 */
export interface WaitingOn {
  wait_id: string;
  case_id: string;
  client_id?: string;
  label: string;
  /** The founder-written sentence: "waiting on Acme to confirm the scope change". */
  reason: string;
  /**
   * The discriminants, so the UI can say "for a reply or a payment" without re-reading the row.
   *
   * A LIST since a wait learned to express OR. It was one discriminant, and one was a lie the moment
   * a chase could end three different ways: the surface rendered "waiting for the invoice to be
   * paid" over a wait that would equally have resumed on a reply, and a founder reading that has
   * been told something false about what the system is watching.
   */
  conditions: WaitCondition["kind"][];
  /** How they combine. `all` is a join; the count in `progress` is only meaningful for one. */
  mode: WaitMode;
  /**
   * How far along, when there is anything to be far along. Absent on a plain one-condition wait,
   * where "0 of 1" is noise.
   *
   * This is the sentence the join exists to produce. "Waiting on 3 of 7 receipts" is what a founder
   * needs to decide whether to phone the client, and it is also what makes the nudge meaningful —
   * without it, a parked month-end close and a dead one look identical from the outside.
   */
  progress?: { satisfied: number; total: number; outstanding: string[] };
  waiting_since: string;
  nudges_sent: number;
  expires_at?: string;
  /**
   * True when the wait is stuck in `resuming` — a replica died between claiming and spawning.
   *
   * Surfaced rather than hidden because it is the ONE wait state that needs a human: it will never
   * resume on its own (the claim deliberately does not release — see waits.ts), and a stuck
   * engagement that looks identical to a healthy parked one is exactly how it stays stuck.
   */
  needs_attention: boolean;
  /**
   * Re-arms still allowed on this wait (`MAX_REARMS` minus what has been used).
   *
   * Present so the founder surface can offer the way back from a stalled resume WITHOUT a second
   * round trip, and can stop offering it once the budget is spent — a button that is always there and
   * always refuses teaches a founder to ignore it. Zero on a healthy wait, because a wait that is not
   * stuck has nothing to re-arm.
   */
  rearms_left: number;
}

export interface MoveProposal {
  moves: Move[];
  /** Considered and refused by the authority. A COUNT ONLY — see `BrainCounts.authority_excluded`. */
  authority_excluded: number;
  /** Candidates found before the limit. Non-zero difference means the list is a page, not the whole. */
  matched: number;
  truncated: boolean;
  /**
   * What the business is blocked on, and therefore what is NOT in `moves`.
   *
   * This list is here rather than on a page of its own because of vision Law 5 — internals are not
   * automatically pages — and because it is the other half of the same question. "What should I do
   * next" is only honest alongside "and here is what is handled, waiting on somebody else": without
   * it, an engagement parked on a client reply is indistinguishable from one nobody is doing, and a
   * founder's correct response to a shorter list is to worry rather than to relax.
   */
  waiting: WaitingOn[];
  /**
   * What the business ACHIEVED recently, ranked. The other half of the same page.
   *
   * Here rather than on a surface of its own for the reason `waiting` is: "what should I do next"
   * is only honest next to "and here is what the last round of doing it produced". Without it the
   * founder's evidence that the loop turns is a list that is one row shorter than yesterday, which
   * is indistinguishable from a list that lost a row. See `consequencesOf`.
   *
   * It is NOT filtered by `scope.kinds`. A caller narrowing to one kind is asking "what chases are
   * due", not "hide the fact that a client paid" — and the autonomy sweep, which is the caller that
   * narrows, ignores this field entirely.
   */
  consequences: Consequence[];
}

/**
 * Read the business, enumerate what could legally be done now, rank it.
 *
 * The order of operations inside each block is the safety property, and it is the same order
 * `gather` uses in brain.ts: ask the store with the tenant pushed INTO the query, drop what the
 * authority forbids (counting it), only then decide whether it is a move. Deciding first and
 * filtering after is how a `limit` leaks.
 */
export async function proposeMoves(
  stores: MoveStores,
  auth: MoveAuthority,
  req: MoveRequest = {},
  now: Date = new Date(),
): Promise<MoveProposal> {
  const scope = narrowMoves(auth, req);
  const nowIso = now.toISOString();
  const today = nowIso.slice(0, 10);
  const moves: Move[] = [];
  let excluded = 0;
  const want = (k: MoveKind) => scope.kinds.includes(k);

  // ONE read of the outcome ledger, TWO readers: the learned term on every move, and the ranked
  // list of what actually landed. See `readOutcomes`.
  const outcomes = await readOutcomes(stores.domain, auth);
  const learned = statsOf(outcomes);

  // ── 1. Overdue invoices → chase, IF the dunning ladder says a chase is due ────────────────────
  if (want("chase_invoice")) {
    const invoices = await stores.billing.listInvoices({ project_id: scope.project_id, limit: 500 });
    /**
     * ONE connection read for the whole page, so the button can tell the truth.
     *
     * `chaseHands` is the exact gate `startChase` applies. Asking it here — where the row is built —
     * rather than only after the click is the difference between a founder seeing "connect a mailbox
     * and this starts on its own" on the row itself, and a founder clicking a live button five times
     * and getting a toast that vanishes while the row never moves.
     *
     * Read once and passed down: the answer is per-invoice (a client-owned mailbox is granted for
     * that client's invoices only) but the READ is not, and one query per overdue invoice on the
     * home page is a cost with no information in it. A store that throws leaves this undefined,
     * which means "not checked" and restores exactly the old behaviour — the gate still holds at
     * `startChase`, so the worst case is the button we used to render unconditionally.
     */
    let conns: readonly Connection[] | undefined;
    try {
      conns = (await stores.domain.listConnections()).filter((c) => c.project_id === scope.project_id);
    } catch (e) {
      console.error("[mycel] could not read connections while ranking chases:", e);
    }
    for (const inv of invoices) {
      if (!ownerAllowed(scope, inv.client_id)) { excluded++; continue; }
      // Asked BEFORE the move is built, and only for invoices that survived `ownerAllowed` — the
      // gate is part of the row, not an amendment to it.
      const hands = conns ? await chaseHands(inv, conns) : undefined;
      const move = chaseMove(inv, today, now, learned, hands?.ok === false ? hands.message : undefined);
      if (move) moves.push(move);
    }
  }

  // ── 2. Open client requests past their patience → nudge ──────────────────────────────────────
  if (want("nudge_client_request")) {
    const rows = await stores.requests.listRequests({
      project_id: scope.project_id,
      status: "open",
      limit: 500,
    });
    for (const r of rows) {
      if (!ownerAllowed(scope, r.client_id)) { excluded++; continue; }
      const move = await nudgeMove(stores.domain, r, nowIso, learned);
      if (move) moves.push(move);
    }
  }

  // ── 2b. Work the client accepted that nobody billed ──────────────────────────────────────────
  //
  // The tenant is pushed INTO both reads, and the second read is the reason this block is more than
  // a filter: "accepted" is a fact on the deliverable, "uninvoiced" is the ABSENCE of a row in a
  // different table, and an absence cannot be queried from the first table. Edges are derived, never
  // stored — the graph.ts rule — so the link is recomputed here from `Invoice.case_id` rather than
  // being cached as an `invoice_id` column on the deliverable that nothing would keep true.
  //
  // ONE invoice read for the whole block, not one per deliverable. A firm with forty accepted
  // deliverables would otherwise make forty round trips to answer a question one query answers.
  if (want("invoice_accepted_work")) {
    const accepted = await stores.deliverables.listDeliverables({
      project_id: scope.project_id,
      status: "accepted",
      limit: 200,
    });
    if (accepted.length) {
      const invoiced = new Set<string>();
      for (const inv of await stores.billing.listInvoices({ project_id: scope.project_id, limit: 500 })) {
        // A VOID invoice does not count as billed. It is the specific case that matters: a founder
        // raises an invoice, the client disputes the scope, it is voided pending a fix — and the
        // work is once again finished, accepted, and unbilled. Treating void as billed would delete
        // the row from this list at exactly the moment it became most worth showing. A DRAFT does
        // count: somebody has started, and nagging them about a half-written invoice is noise.
        if (inv.case_id && inv.status !== "void") invoiced.add(inv.case_id);
      }
      for (const d of accepted) {
        if (invoiced.has(d.case_id)) continue;
        if (!ownerAllowed(scope, d.client_id)) { excluded++; continue; }
        const move = invoiceAcceptedWorkMove(d, today, now, learned);
        if (move) moves.push(move);
      }
    }
  }

  // ── 2c. Work a run finished and left waiting on the founder to RELEASE ─────────────────────────
  //
  // Ignition (fulfillment-ignite.ts) drafts a deliverable on its own and parks it at `in_review` —
  // the one transition the founder owns. Nothing else surfaces it, so finished work sat invisible.
  // The tenant is pushed INTO the query, `ownerAllowed` runs before the move is built, and the status
  // filter is `in_review` SPECIFICALLY: `with_client` is the client's to accept and `accepted` is
  // `invoice_accepted_work`'s to bill. One query, no per-row round trips.
  if (want("release_deliverable")) {
    const inReview = await stores.deliverables.listDeliverables({
      project_id: scope.project_id,
      status: "in_review",
      limit: 200,
    });
    for (const d of inReview) {
      if (!ownerAllowed(scope, d.client_id)) { excluded++; continue; }
      const move = releaseDeliverableMove(d, today, now, learned);
      if (move) moves.push(move);
    }
  }

  // ── 3. The marketing experiment, IF it has decided ───────────────────────────────────────────
  //
  // Gated on `want(...)` so the common paths never pay for it: `takeMove` narrows to one kind from
  // the id prefix, and the autonomy sweep asks per kind. Only a full proposal — the home screen, and
  // `/v1/ask` — spends this query.
  //
  // ONE read of one window, not `buildSummary`. The summary computes two windows, a funnel, deltas
  // and a headline, all for a human or a model; the ranking needs exactly one thing, the verdict,
  // and reading it through the whole summary would double the query cost of every home page load to
  // throw away nine tenths of the answer. `project_id` is pushed INTO the query by
  // `aggregateWindow`, the same fail-closed filter every other block here relies on — there is no
  // post-filter, and no path by which a caller supplies a project.
  if (want("rewrite_losing_arm")) {
    const from = new Date(now.getTime() - EXPERIMENT_WINDOW_DAYS * 86_400_000).toISOString();
    // One millisecond past now, for the reason `buildSummary` gives: a batch ingested in this exact
    // millisecond would otherwise fall outside the window and vanish.
    const slice = await aggregateWindow(stores.domain, scope.project_id, from, new Date(now.getTime() + 1).toISOString());
    const report = analyseExperiment(slice.aggregate.names, CONVERSION_METRIC);
    if (report) {
      const move = rewriteArmMove(scope.project_id, report, nowIso, learned);
      if (move) moves.push(move);
    }
  }

  // ── 4/5/6. Cases: due, stale, or a GTM step whose condition is met ────────────────────────────
  //
  // ONE read of the project's cases feeds all three. Three reads would be three places for the
  // tenant filter to be written differently.
  const waiting: WaitingOn[] = [];
  if (want("advance_case") || want("check_in_case") || want("gtm_next_touch")) {
    const cases = await stores.domain.listCases({ project_id: scope.project_id, status: "open" });
    // Campaigns are shared by every case in them; one read each rather than one per case — the same
    // memoisation `advanceSequences` does, for the same reason.
    const campaigns = new Map<string, Awaited<ReturnType<typeof loadCampaign>>>();

    // ═══ WHY A BLOCKED ENGAGEMENT MUST NOT RANK ═══
    //
    // `checkInMove` fires on SILENCE: nothing has happened on this case for N days. An engagement
    // parked on a client reply is silent BY CONSTRUCTION — that is what waiting is — so without this
    // read, arming a wait would guarantee the engagement comes back here a fortnight later as
    // "nobody has touched this, check in". The founder would then chase a client the kernel is
    // already chasing on its own nudge ladder: the double-contact cousin of the double-invoice bug
    // the whole waits design exists to prevent, and the more corrosive one, because it teaches a
    // founder that the list is wrong.
    //
    // BOTH live states are read. `resuming` is a wait mid-resume; proposing manual work on an
    // engagement that is at this instant spawning its own run is the same race with a smaller
    // window. The tenant is pushed INTO the query — `WaitFilter.project_id` is required and fails
    // closed — which is the same order every other block here uses.
    const parked = new Map<string, CaseWait>();
    for (const status of ["waiting", "resuming"] as const) {
      for (const w of await stores.domain.listWaits({ project_id: scope.project_id, status })) {
        parked.set(w.case_id, w);
      }
    }

    // ═══ AND THE ENGAGEMENTS WHOSE WAIT GAVE UP ═══
    //
    // The dead end this closes: a wait that expired wrote a note on the case timeline and stopped.
    // The engagement then sat in no queue, appeared in no list and was proposed by nothing — a
    // client who went silent in March was still silent in June and the system had, by design,
    // forgotten to care. That is the exact opposite of "the business keeps moving", and it is worse
    // than never having parked the engagement at all, because parking it also removed it from the
    // staleness check-in that would otherwise have caught it.
    //
    // `failed` is here alongside `expired` because they are the same product state — a wait that is
    // over and did not resume — arrived at two ways: nobody answered, or the thing we were waiting
    // on became impossible (the request was withdrawn, one dependency of a join died). Both leave an
    // engagement that needs a human decision and neither can make it.
    //
    // NEWEST ONLY. `listWaits` is ordered `created_at DESC`, so the first dead wait seen for a case
    // is its most recent one — an engagement that expired in March, was re-parked in April and
    // expired again in May is ONE thing to decide, not two.
    const abandoned = new Map<string, CaseWait>();
    if (want("unblock_wait")) {
      for (const status of ["expired", "failed"] as const) {
        for (const w of await stores.domain.listWaits({ project_id: scope.project_id, status })) {
          const seen = abandoned.get(w.case_id);
          if (!seen || seen.created_at < w.created_at) abandoned.set(w.case_id, w);
        }
      }
    }

    for (const k of cases) {
      if (!ownerAllowed(scope, k.client_id)) { excluded++; continue; }
      // A wedge outside the authority is not this caller's work to propose. A run scoped to
      // invoice-chaser must not be handed a books-keeper engagement to advance.
      if (!scope.wedges.includes(k.wedge)) { excluded++; continue; }

      // AFTER the two authority checks, never before. A wait is reported to the founder here, so
      // reading it ahead of `ownerAllowed` would put an engagement this caller is not allowed to see
      // onto their list under the guise of being helpful — the exact shape of the two leaks this
      // codebase has already shipped. Blocked cases are not counted as `authority_excluded`: they
      // were not refused, they are accounted for, and the `waiting` list says so.
      const wait = parked.get(k.id);
      if (wait) {
        waiting.push({
          wait_id: wait.id,
          case_id: k.id,
          client_id: k.client_id,
          label: k.title,
          reason: wait.reason,
          conditions: (wait.conditions ?? []).map((c) => c.kind),
          mode: wait.mode ?? "any",
          progress: waitProgress(wait),
          waiting_since: wait.created_at,
          nudges_sent: wait.nudge_count,
          expires_at: wait.expires_at,
          needs_attention: wait.status === "resuming",
          rearms_left:
            wait.status === "resuming" ? Math.max(0, MAX_REARMS - (wait.rearm_count ?? 0)) : 0,
        });
        continue;
      }

      // A dead wait is proposed BEFORE the due/stale blocks and instead of them. An engagement whose
      // wait expired is also, necessarily, stale — that is what waiting looks like from the outside
      // — so falling through would put "check in on this, no activity for 40 days" next to "the
      // chase for a signed SOW gave up after 6 nudges", which is one situation described twice, the
      // second time without the reason. The dead wait's row carries strictly more information.
      const dead = abandoned.get(k.id);
      if (dead) {
        const move = unblockWaitMove(k, dead, nowIso, learned);
        if (move) { moves.push(move); continue; }
      }

      if (k.wedge === gtmWedge()) {
        if (!want("gtm_next_touch")) continue;
        const move = await gtmMove(stores.domain, k, nowIso, campaigns, learned);
        if (move) moves.push(move);
        // A GTM case is a prospect in a sequence, not an engagement with a deadline. Falling through
        // to the due/stale blocks would propose "check in on this engagement" for every prospect
        // whose sequence is deliberately waiting out a cadence gap.
        continue;
      }

      // Due before stale, and never both. An engagement that is due tomorrow AND untouched for a
      // fortnight is ONE move — "get it over the line" — and proposing two rows for it is how a
      // ranked list stops being a list of things to do and becomes a list of things it noticed.
      const due = want("advance_case") ? advanceMove(k, nowIso, learned) : undefined;
      if (due) { moves.push(due); continue; }
      const stale = want("check_in_case") ? checkInMove(k, nowIso, learned) : undefined;
      if (stale) moves.push(stale);
    }
  }

  // ── Founder-stated rules, applied HERE rather than only at draft time ────────────────────────
  //
  // See rules.rank.ts. Loaded once for the whole proposal; a miss (store down, empty project) leaves
  // ranking unchanged rather than inventing a hold. Uses are recorded for the rules that actually
  // held a move, so the Learning page stops saying "never used on a job" about a rule that just
  // stopped a chase.
  //
  // Only the FIRST hold increments. `GET /v1/moves` and the autonomy tick both call this on every
  // pass; counting each pass as a "job" would make "used on 40 jobs" a page-load counter, which
  // destroys the diagnostic `uses` exists for (never retrieved vs actually wrong).
  if (moves.length && scope.project_id) {
    try {
      const rules = await getKnowledgeStore().listRules(scope.project_id, { status: "active" });
      if (rules.length) {
        const names = new Map<string, string>();
        for (const cl of await stores.domain.listClients()) {
          if (cl.project_id === scope.project_id && cl.display_name) names.set(cl.id, cl.display_name);
        }
        const used = new Set<string>();
        for (let i = 0; i < moves.length; i++) {
          const m = moves[i]!;
          const clientName = m.client_id ? names.get(m.client_id) : undefined;
          const held = applyStatedRules(m, rules, clientName);
          moves[i] = held;
          for (const id of appliedRuleIds(held, rules, clientName)) {
            const rule = rules.find((r) => r.id === id);
            if (rule && rule.uses === 0) used.add(id);
          }
        }
        if (used.size) {
          await getKnowledgeStore().noteUses(scope.project_id, [...used]).catch((e) => {
            console.error("[mycel] could not record rank-time rule uses:", e);
          });
        }
      }
    } catch (e) {
      console.error("[mycel] could not apply stated rules while ranking:", e);
    }
  }

  // Highest score first. The tiebreak is the move id — deterministic, so two identical scores do not
  // reorder between two page loads. A list that shuffles is a list a founder stops trusting.
  moves.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const returned = moves.slice(0, scope.limit);
  // Longest-waiting first. The one most likely to need a human decision is the one that has been
  // sitting the longest, and unlike `moves` there is no score to rank these by — a wait is not
  // work, so scoring it would invent a priority the kernel cannot justify.
  waiting.sort((a, b) => a.waiting_since.localeCompare(b.waiting_since));
  return {
    moves: returned,
    authority_excluded: excluded,
    matched: moves.length,
    truncated: moves.length > returned.length,
    waiting,
    consequences: consequencesOf(outcomes, now),
  };
}

/** Assemble a move from its terms, so `score` can never disagree with `score_terms`. */
function assemble(
  base: Omit<Move, "score" | "score_terms" | "proposed_at" | "takeable" | "unavailable_reason">,
  terms: ScoreTerm[],
  now: Date | string,
  /** See `takeability`'s third argument. Only `chaseMove` has an answer to this today. */
  handsMissing?: string,
): Move {
  const kept = terms.filter((t) => t.points !== 0);
  // Derived from the kind AND the carrier it named, here, so every move carries the same answer
  // `takeMove` will give — and no caller has to know the rule. See `Move.takeable`.
  const gate = takeability(base.kind, base.carrier.wedge, handsMissing);
  return {
    ...base,
    takeable: gate.takeable,
    ...(gate.reason ? { unavailable_reason: gate.reason } : {}),
    score: round(kept.reduce((sum, t) => sum + t.points, 0)),
    score_terms: kept,
    proposed_at: typeof now === "string" ? now : now.toISOString(),
  };
}

function learnedTerm(kind: MoveKind, learned: Map<MoveKind, OutcomeStat>): ScoreTerm {
  const stat = learned.get(kind);
  const points = learnedPoints(stat);
  return {
    term: "learned",
    points,
    because: stat && stat.taken >= MIN_EVIDENCE
      ? `${stat.worked} of ${stat.taken} moves like this worked here; ${stat.rejected} were rejected`
      : "not enough history in this business yet to adjust",
  };
}

/**
 * An overdue invoice, IF the wedge's own ladder says a chase is due.
 *
 * `chaseIntervalDays` is imported from dunning.ts rather than restated: it encodes the rungs from
 * `wedges/invoice-chaser/knowledge/dunning-policy.md` (1–7 days reminder, 8–21 firm, 22+ final) and
 * the hard 48h floor. An invoice inside its window produces NO move at all — not a low-scoring one.
 * Showing a founder "chase this" for something the ladder has decided to hold is an invitation to
 * chase it, and the client on the other end experiences the ladder, not the ranking function.
 */
function chaseMove(
  inv: Invoice,
  today: string,
  now: Date,
  learned: Map<MoveKind, OutcomeStat>,
  /** See `takeability`'s third argument: the sentence to show instead of a live button. */
  handsMissing?: string,
): Move | undefined {
  // The same three refusals `sweepOverdueInvoices` makes: a draft the client has never seen, a
  // settled or void invoice, and a zero balance are all "money that is not owed".
  // NO DUNNING WEDGE ON THIS INSTALL, NO MOVE — checked first, before any of the money reasoning.
  //
  // A Move's whole promise is that its `carrier` can be handed to `takeMove` and become a real run.
  // Naming a wedge that is not in `wedges/` would produce a row a founder can click, which spawns a
  // task for a wedge with no output schema, no policy envelope and no knowledge — the agent gets a
  // verb nobody taught it and the click is reported as a started chase. Ranking the invoice first
  // and discovering the carrier is missing at take time would be the same bug one screen later.
  const wedge = dunningWedge();
  if (!wedge) return undefined;

  const status = effectiveStatus(inv, today);
  if (status !== "sent" && status !== "overdue") return undefined;
  const totals = invoiceTotals(inv);
  if (totals.amount_due <= 0) return undefined;
  const overdue = chaseDaysOverdue(inv, today);
  if (overdue < 1) return undefined;

  // The ladder's own pacing. Not a second opinion about it.
  const interval = chaseIntervalDays(overdue);
  if (inv.last_chased_at) {
    const sinceDays = daysBetween(inv.last_chased_at.slice(0, 10), today);
    if (sinceDays < interval) return undefined;
  }

  const exponent = minorUnitExponent(inv.currency);
  const money = moneyPoints(totals.amount_due, inv.currency);
  const deadline = deadlinePoints(-overdue);
  // Staleness here is "how long since we last said anything about this debt", which is a different
  // number from how overdue it is: an invoice 60 days late that we chased on Monday is not stale.
  const sinceChase = inv.last_chased_at
    ? daysBetween(inv.last_chased_at.slice(0, 10), today)
    : overdue;
  const stale = stalenessPoints(sinceChase);

  return assemble(
    {
      id: `chase_invoice:${inv.id}`,
      project_id: inv.project_id,
      kind: "chase_invoice",
      entity: { kind: "invoice", id: inv.id, label: `Invoice ${inv.number}` },
      client_id: inv.client_id,
      case_id: inv.case_id,
      why:
        `${inv.number} is ${overdue} day${overdue === 1 ? "" : "s"} overdue with ` +
        `${totals.amount_due / 10 ** exponent} ${inv.currency} outstanding` +
        (inv.last_chased_at
          ? `; last chased ${sinceChase} day${sinceChase === 1 ? "" : "s"} ago, and the ladder allows another after ${interval}`
          : "; never chased"),
      signals: {
        money_at_stake: totals.amount_due,
        currency: inv.currency,
        minor_unit_exponent: exponent,
        days_overdue: overdue,
        days_stale: sinceChase,
        learned: learned.get("chase_invoice"),
      },
      carrier: {
        wedge,
        task_type: CHASE_TASK_TYPE,
        // The wedge's OWN input builder. See the comment on `Move.carrier`.
        input: chaseTaskInput(inv, today),
      },
    },
    [
      { term: "money", points: money, because: `${totals.amount_due / 10 ** exponent} ${inv.currency} is outstanding` },
      // `day${n === 1 ? "" : "s"}`, not `day(s)`. This line is read by a founder on their home page,
      // and "the due date passed 23 day(s) ago" is a sentence written for a compiler.
      { term: "deadline", points: deadline, because: `the due date passed ${overdue} day${overdue === 1 ? "" : "s"} ago` },
      { term: "staleness", points: stale, because: `nothing has been said about it for ${sinceChase} day${sinceChase === 1 ? "" : "s"}` },
      learnedTerm("chase_invoice", learned),
    ],
    now,
    handsMissing,
  );
}

/**
 * Work the client accepted that has not been invoiced.
 *
 * ═══ WHY THE MONEY TERM IS ZERO AND THAT IS NOT A BUG ═══
 *
 * A deliverable carries no amount. It could have been given one — a `value_minor` field on the row —
 * and it was deliberately not, because the number would be a guess written down as a fact: nobody
 * quotes a statement of work by pasting a figure into the thing they deliver, and a wrong number
 * here would out-rank a real overdue invoice on the strength of an agent's estimate.
 *
 * So the claim this move makes is CERTAIN but UNQUANTIFIED, which is a third category the scoring
 * section above did not have. It is ranked on the two terms that are honest: how long the money has
 * been sitting there (`staleness`), and a flat `earned` term that says the work is finished and
 * signed off. The `earned` term is set so that this out-ranks a stale case and a nudge — because
 * billing for completed work beats almost any speculative activity — and does NOT out-rank a large,
 * badly overdue invoice, where the money term alone is worth more. That ordering is deliberate and
 * `moves.test.ts` pins it: certain, named, overdue money still wins.
 *
 * It is never `takeable`. See `takeability`.
 */
function invoiceAcceptedWorkMove(
  d: Deliverable,
  today: string,
  now: Date,
  learned: Map<MoveKind, OutcomeStat>,
): Move | undefined {
  if (!d.accepted_at) return undefined;
  const sinceDays = daysBetween(d.accepted_at.slice(0, 10), today);
  return assemble(
    {
      id: `invoice_accepted_work:${d.id}`,
      project_id: d.project_id,
      kind: "invoice_accepted_work",
      entity: { kind: "deliverable", id: d.id, label: d.title },
      client_id: d.client_id,
      case_id: d.case_id,
      why:
        `your client accepted "${d.title}" ${sinceDays === 0 ? "today" : `${sinceDays} day${sinceDays === 1 ? "" : "s"} ago`} ` +
        `and nothing has been invoiced against this engagement since`,
      signals: {
        days_stale: sinceDays,
        learned: learned.get("invoice_accepted_work"),
      },
      // NO CARRIER, and the empty wedge is what `takeability` reads to refuse the click. Raising an
      // invoice is a kernel operation (`POST /v1/invoices`), not a wedge task type, so naming one
      // here would be inventing a run that does not exist — the failure `chaseMove` guards against
      // in its very first line.
      carrier: { wedge: "", task_type: "", input: {} },
    },
    [
      {
        term: "earned",
        points: ACCEPTED_WORK_POINTS,
        because: "this work is finished and your client has signed it off",
      },
      {
        term: "staleness",
        points: stalenessPoints(sinceDays),
        because: `it has been billable for ${sinceDays} day(s)`,
      },
      learnedTerm("invoice_accepted_work", learned),
    ],
    now,
  );
}

/**
 * A deliverable a run finished and left in `in_review` — waiting for the founder to review it and
 * release it to the client. The mirror of `invoiceAcceptedWorkMove` one step earlier in the
 * lifecycle: ignition produces work on a clock and parks it at `in_review`, the single edge the
 * founder owns, and nothing else tells them it is there. Certain and unquantified — the work exists
 * and is ready, there is no amount to rank it on — so it is ranked on how long it has sat unreleased
 * (`staleness`) and a flat `ready` term. Never takeable: releasing to a client is a founder
 * consequence gate, not a wedge task type, so the carrier is empty and `takeability` refuses it.
 */
function releaseDeliverableMove(
  d: Deliverable,
  today: string,
  now: Date,
  learned: Map<MoveKind, OutcomeStat>,
): Move | undefined {
  if (d.status !== "in_review") return undefined; // belt-and-braces; the query already filters
  const sinceDays = daysBetween(d.updated_at.slice(0, 10), today);
  return assemble(
    {
      id: `release_deliverable:${d.id}`,
      project_id: d.project_id,
      kind: "release_deliverable",
      entity: { kind: "deliverable", id: d.id, label: d.title },
      client_id: d.client_id,
      case_id: d.case_id,
      why:
        `"${d.title}" is finished and waiting for you to review it and send it to your client` +
        (sinceDays === 0 ? " — ready today" : `; it has been ready for ${sinceDays} day${sinceDays === 1 ? "" : "s"}`) +
        ". Nothing goes to the client until you release it.",
      signals: {
        days_stale: sinceDays,
        learned: learned.get("release_deliverable"),
      },
      // NO CARRIER. Releasing to a client is `POST /v1/deliverables/:id/release` — a founder
      // consequence gate the founder owns, not a wedge task type. `takeability` reads the empty
      // wedge and refuses; the founder is sent to the deliverable to press release themselves.
      carrier: { wedge: "", task_type: "", input: {} },
    },
    [
      {
        term: "ready",
        points: ACCEPTED_WORK_POINTS,
        because: "this work is finished and waiting for you to send it to your client",
      },
      {
        term: "staleness",
        points: stalenessPoints(sinceDays),
        because: `it has been sitting ready for ${sinceDays} day${sinceDays === 1 ? "" : "s"}`,
      },
      learnedTerm("release_deliverable", learned),
    ],
    now,
  );
}

/**
 * A client request that has been open too long.
 *
 * The threshold is two-sided: past its own `due_at`, OR open longer than `REQUEST_NUDGE_DAYS` when
 * nobody set one. A request with no due date is the common case (an agent raised it mid-run), and
 * treating "no deadline" as "never urgent" is how the single highest-value thing a portal does —
 * telling a customer what they are blocking — quietly stops happening.
 *
 * ═══ THE LADDER IS ASKED, NOT RESTATED ═══
 *
 * `nudgeIntervalDays` and `MAX_NUDGES` come from nudges.ts, exactly as `chaseMove` imports
 * `chaseIntervalDays` from dunning.ts and for the identical reason. A request inside its window
 * produces NO move at all — not a low-scoring one. Showing a founder "chase this" for something the
 * ladder has decided to hold is an invitation to chase it, and the client on the other end
 * experiences the ladder rather than the ranking function. A request whose budget is spent likewise
 * disappears from this list: three unanswered asks is a conversation, and proposing a fourth email
 * would be the product recommending the thing that loses the client.
 */
async function nudgeMove(
  domain: DomainStore,
  r: ClientRequest,
  nowIso: string,
  learned: Map<MoveKind, OutcomeStat>,
): Promise<Move | undefined> {
  const today = nowIso.slice(0, 10);
  const openDays = daysBetween(r.created_at.slice(0, 10), today);
  const daysUntilDue = r.due_at ? daysBetween(today, r.due_at.slice(0, 10)) : undefined;
  const late = daysUntilDue !== undefined && daysUntilDue <= 0;
  if (!late && openDays < REQUEST_NUDGE_DAYS) return undefined;

  const sent = r.nudge_count ?? 0;
  if (sent >= MAX_NUDGES) return undefined;
  if (r.last_nudged_at) {
    const sinceDays = daysBetween(r.last_nudged_at.slice(0, 10), today);
    if (sinceDays < nudgeIntervalDays(sent)) return undefined;
  }

  const deadline = deadlinePoints(daysUntilDue);
  const stale = stalenessPoints(openDays);

  return assemble(
    {
      id: `nudge_client_request:${r.id}`,
      project_id: r.project_id,
      kind: "nudge_client_request",
      entity: { kind: "client_request", id: r.id, label: r.ask },
      client_id: r.client_id,
      case_id: r.case_id,
      why:
        `We have been waiting ${openDays} day${openDays === 1 ? "" : "s"} for "${r.ask}"` +
        (late ? ` — ${Math.abs(daysUntilDue ?? 0)} day(s) past the date we asked for` : "") +
        (sent ? `; asked ${sent} time${sent === 1 ? "" : "s"} already` : "; never chased") +
        ". The work behind it is stopped until it arrives.",
      signals: {
        days_stale: openDays,
        ...(daysUntilDue !== undefined && daysUntilDue > 0 ? { days_until_due: daysUntilDue } : {}),
        ...(late ? { days_overdue: Math.abs(daysUntilDue ?? 0) } : {}),
        learned: learned.get("nudge_client_request"),
      },
      // The ball is theirs. See `BLOCKED_PENALTY`.
      blocked_on: "client",
      carrier: {
        /**
         * WHOSE VOICE. Resolved from the ENGAGEMENT by the carrier's own function, so the move a
         * founder is shown and the run `startNudge` spawns cannot name different wedges.
         *
         * This was `scope.wedges[0] ?? DUNNING_WEDGE` — the authority's first wedge, in whatever
         * order a `Set` happened to iterate — which would have chased a client for a bank statement
         * in the invoice-chaser's dunning voice with the dunning policy mounted as its knowledge.
         * An empty string when nothing owns it: `takeability` reads that as no carrier and the
         * button greys out with a sentence, which is the honest answer. See `nudgeWedgeFor`.
         */
        wedge: (await nudgeWedgeFor(domain, r)) ?? "",
        task_type: NUDGE_TASK_TYPE,
        // The carrier's OWN input builder, so a nudge taken from this list and one the sweep started
        // are provably the same run. See the comment on `Move.carrier`.
        input: nudgeTaskInput({ ...r, nudge_count: sent + 1 }, nowIso),
      },
    },
    [
      { term: "deadline", points: deadline, because: late ? "the date we asked for has passed" : `due in ${daysUntilDue} day(s)` },
      { term: "staleness", points: stale, because: `open for ${openDays} day(s) with no answer` },
      { term: "blocked", points: -BLOCKED_PENALTY, because: "the next step is the client's, not ours — a nudge cannot finish it" },
      learnedTerm("nudge_client_request", learned),
    ],
    nowIso,
  );
}

/** A case whose deadline is approaching or has passed. */
function advanceMove(k: Case, nowIso: string, learned: Map<MoveKind, OutcomeStat>): Move | undefined {
  if (!k.due_at) return undefined;
  const today = nowIso.slice(0, 10);
  const daysUntil = daysBetween(today, k.due_at.slice(0, 10));
  if (daysUntil > CASE_DUE_SOON_DAYS) return undefined;

  const deadline = deadlinePoints(daysUntil);
  const stale = stalenessPoints(daysBetween(k.updated_at.slice(0, 10), today));

  return assemble(
    {
      id: `advance_case:${k.id}`,
      project_id: k.project_id ?? "",
      kind: "advance_case",
      entity: { kind: "case", id: k.id, label: k.title },
      client_id: k.client_id,
      case_id: k.id,
      why:
        daysUntil <= 0
          ? `"${k.title}" was due ${Math.abs(daysUntil)} day${Math.abs(daysUntil) === 1 ? "" : "s"} ago and is still at stage "${k.stage}".`
          : `"${k.title}" is due in ${daysUntil} day${daysUntil === 1 ? "" : "s"} and is still at stage "${k.stage}".`,
      signals: {
        ...(daysUntil <= 0 ? { days_overdue: Math.abs(daysUntil) } : { days_until_due: daysUntil }),
        days_stale: daysBetween(k.updated_at.slice(0, 10), today),
        learned: learned.get("advance_case"),
      },
      carrier: {
        wedge: k.wedge,
        task_type: "advance_case",
        input: { case_id: k.id, stage: k.stage, title: k.title, due_at: k.due_at, today },
      },
    },
    [
      { term: "deadline", points: deadline, because: daysUntil <= 0 ? `the deadline passed ${Math.abs(daysUntil)} day(s) ago` : `${daysUntil} day(s) left` },
      { term: "staleness", points: stale, because: `nothing has moved on it since ${k.updated_at.slice(0, 10)}` },
      learnedTerm("advance_case", learned),
    ],
    nowIso,
  );
}

/**
 * How far a join got, for the founder surface. Absent when there is nothing to count.
 *
 * Derived from the PERSISTED parts and not by re-evaluating the conditions, which is the whole
 * reason parts are persisted: `proposeMoves` is a read over a whole project, and re-checking seven
 * receipts against the requests store for every parked engagement would turn one page load into
 * hundreds of queries — and would still disagree with the sweep by up to five minutes.
 */
function waitProgress(w: CaseWait): { satisfied: number; total: number; outstanding: string[] } | undefined {
  const conditions = w.conditions ?? [];
  // A one-condition wait has no progress worth reporting: "0 of 1" is a fact and not information,
  // and an `any` wait banks nothing by construction — the first thing that lands resumes it.
  if (w.mode !== "all" || conditions.length <= 1) return undefined;
  const done = new Set((w.parts ?? []).map((p) => p.index));
  return {
    satisfied: done.size,
    total: conditions.length,
    outstanding: conditions.filter((_, i) => !done.has(i)).map(describeCondition),
  };
}

/**
 * An engagement whose wait is over and did not resume. The way out of the dead end.
 *
 * ═══ WHERE IT RANKS, AND WHY ═══
 *
 * Deadline is at the maximum, because the deadline in question is one the KERNEL set and the kernel
 * has already blown through it — an expired wait is by definition past its date. Staleness runs from
 * the moment we gave up, so an abandoned engagement climbs the list the longer nobody decides about
 * it, which is the correct pressure: the cost of an undecided client relationship is entirely in the
 * delay.
 *
 * There is deliberately NO money term even when the wait was on an invoice. The money is already
 * ranked — `chase_invoice` proposes that same debt with the real amount and the ladder's pacing —
 * and counting it twice would let one unpaid invoice occupy the top two rows of a founder's list.
 *
 * And no `blocked_on: "client"`. The client's move is exactly what stopped coming; the next move is
 * OURS, and it is a decision. Applying the blocked penalty would push the one row that needs a human
 * below the rows that do not.
 *
 * ═══ IT IS NOT TAKEABLE, AND THAT IS THE HONEST ANSWER ═══
 *
 * "The condition never arrived" resolves to drop them, phone them, re-scope, or write it off, and
 * nothing in the kernel can pick. waits.ts refuses to pick for the same reason at expiry time; this
 * row exists to make the choice VISIBLE and ranked, not to make it. See `takeability`.
 */
function unblockWaitMove(
  k: Case,
  w: CaseWait,
  nowIso: string,
  learned: Map<MoveKind, OutcomeStat>,
): Move | undefined {
  const today = nowIso.slice(0, 10);
  // `updated_at` is when the sweep settled it — when we gave up — not when it was armed.
  const daysSince = daysBetween(w.updated_at.slice(0, 10), today);
  const since = w.created_at.slice(0, 10);
  const progress = waitProgress(w);

  const gaveUp =
    w.status === "expired"
      ? `gave up after ${w.nudge_count} nudge${w.nudge_count === 1 ? "" : "s"}`
      : `stopped: ${w.error ?? "the thing it was waiting on became impossible"}`;

  return assemble(
    {
      // Keyed on the CASE and not the wait, deliberately. The move is "decide what happens to this
      // engagement", and a founder who records an outcome against it should be teaching the ranking
      // about the engagement rather than about one abandoned attempt at parking it.
      id: `unblock_wait:${k.id}`,
      project_id: k.project_id ?? "",
      kind: "unblock_wait",
      entity: { kind: "case", id: k.id, label: k.title },
      client_id: k.client_id,
      case_id: k.id,
      why:
        `${w.reason} since ${since}; ${gaveUp}.` +
        (progress ? ` ${progress.satisfied} of ${progress.total} in — still missing ${progress.outstanding.join(", ")}.` : "") +
        ` Nothing is watching this engagement any more, so it needs a decision: chase them yourself, re-scope it, or close it.`,
      signals: {
        // The wait's own deadline, blown. Reported as overdue rather than as staleness because it
        // was a real date with a real promise behind it, not merely a quiet period.
        days_overdue: w.expires_at ? Math.max(0, daysBetween(w.expires_at.slice(0, 10), today)) : 0,
        days_stale: daysSince,
        learned: learned.get("unblock_wait"),
      },
      carrier: {
        // Named so the row is legible and so the day a wedge declares it the button lights up
        // through `takeability` without a second list. Nothing declares it today.
        wedge: k.wedge,
        task_type: "unblock_wait",
        input: {
          case_id: k.id,
          stage: k.stage,
          wait_id: w.id,
          reason: w.reason,
          waited_since: w.created_at,
          gave_up_at: w.updated_at,
          nudges_sent: w.nudge_count,
          ...(progress ? { progress } : {}),
          today,
        },
      },
    },
    [
      { term: "deadline", points: DEADLINE_MAX, because: `the wait's own deadline passed and it stopped watching` },
      { term: "staleness", points: stalenessPoints(daysSince), because: `nobody has decided what happens next for ${daysSince} day(s)` },
      learnedTerm("unblock_wait", learned),
    ],
    nowIso,
  );
}

/**
 * A case nobody has touched.
 *
 * `updated_at` and not the newest `history` entry, and the difference matters: `history` records
 * stage changes and notes, so a case being worked on quietly (records written, messages exchanged)
 * would read as silent for weeks. `updated_at` moves on any write to the row, which is the closest
 * thing the schema has to "somebody is on this".
 */
function checkInMove(k: Case, nowIso: string, learned: Map<MoveKind, OutcomeStat>): Move | undefined {
  const today = nowIso.slice(0, 10);
  const daysStale = daysBetween(k.updated_at.slice(0, 10), today);
  if (daysStale < CASE_STALE_DAYS) return undefined;

  return assemble(
    {
      id: `check_in_case:${k.id}`,
      project_id: k.project_id ?? "",
      kind: "check_in_case",
      entity: { kind: "case", id: k.id, label: k.title },
      client_id: k.client_id,
      case_id: k.id,
      why: `"${k.title}" has had no activity for ${daysStale} days and is sitting at stage "${k.stage}".`,
      signals: { days_stale: daysStale, learned: learned.get("check_in_case") },
      carrier: {
        /**
         * WHOSE VOICE. The engagement's own wedge, and `takeability` refuses when that wedge does
         * not declare `check_in_case` — the same rule, and the same failure, as `nudgeWedgeFor`: a
         * client written to in the wrong firm's voice, with the wrong policy mounted as knowledge.
         */
        wedge: k.wedge,
        task_type: CHECK_IN_TASK_TYPE,
        // The carrier's OWN input builder, so a check-in taken from this list and one the autonomy
        // sweep started are provably the same run. See the comment on `Move.carrier`. It was four
        // hand-written fields here, and the first thing they would have drifted on is `days_silent`,
        // which is the field the agent's tone is written against.
        input: checkInTaskInput(k, nowIso, k.updated_at),
      },
    },
    [
      { term: "staleness", points: stalenessPoints(daysStale), because: `no activity for ${daysStale} day(s)` },
      learnedTerm("check_in_case", learned),
    ],
    nowIso,
  );
}

/**
 * The next outreach touch — asked of the sequencer's own logic, not recomputed.
 *
 * `factsFor` and `evaluateCondition` are the SAME two functions `advanceCase` calls before it sends,
 * so a move appears here exactly when the sequencer would act, and disappears when it would not.
 * Duplicating the gate would mean a founder is shown "message this prospect" for someone who already
 * replied — which the stage machine treats as terminal and this list would not.
 *
 * `advanceSequences` itself is deliberately NOT called: it sends. This module proposes.
 */
async function gtmMove(
  domain: DomainStore,
  k: Case,
  nowIso: string,
  campaigns: Map<string, Awaited<ReturnType<typeof loadCampaign>>>,
  learned: Map<MoveKind, OutcomeStat>,
): Promise<Move | undefined> {
  if (!isActive(k.stage)) return undefined;
  const data = (k.data ?? {}) as Record<string, unknown>;
  const campaignId = String(data.campaign_id ?? "");
  if (!campaignId) return undefined;
  // The cadence gate. `due_at` in the future means the sequencer is deliberately spacing this touch,
  // and pacing.ts's jitter is the whole reason the traffic does not look like a cron.
  if (k.due_at && k.due_at > nowIso) return undefined;

  if (!campaigns.has(campaignId)) campaigns.set(campaignId, await loadCampaign(domain, k.project_id, campaignId));
  const campaign = campaigns.get(campaignId);
  if (!campaign) return undefined;

  const step = campaign.steps.find((s) => s.from === k.stage);
  if (!step) return undefined;
  // The step's own precondition, evaluated over facts the HARNESS computed. Fails closed on an
  // unknown fact — see `evaluateCondition`.
  if (!evaluateCondition(step.only_if, factsFor(k))) return undefined;

  const today = nowIso.slice(0, 10);
  const daysStale = daysBetween(k.updated_at.slice(0, 10), today);

  return assemble(
    {
      id: `gtm_next_touch:${k.id}`,
      project_id: k.project_id ?? "",
      kind: "gtm_next_touch",
      entity: { kind: "case", id: k.id, label: k.title },
      client_id: k.client_id,
      case_id: k.id,
      why:
        `"${k.title}" is at stage "${k.stage}" in campaign "${campaign.name}" and the next step ` +
        `(${step.action}) is due` +
        (step.only_if ? ` — its condition "${step.only_if}" is met.` : "."),
      signals: {
        days_stale: daysStale,
        // A due_at in the past is a touch we are late on. It is the sequencer's schedule, not a
        // client-facing deadline, so it is reported as staleness rather than as an overdue promise.
        learned: learned.get("gtm_next_touch"),
      },
      carrier: {
        wedge: gtmWedge(),
        /**
         * THE REAL TASK TYPE, imported from the file that dispatches it.
         *
         * This said `"gtm_next_touch"` — a string that appears in no manifest, in no dispatcher and
         * in no scheduler, invented here to name the move's own kind. So `takeability` correctly
         * concluded that nothing could carry it and greyed the button out with a sentence saying no
         * wedge declared a carrier, while `advanceSequences` dispatched `outreach_touch` for the
         * very same case every five minutes. The list was not merely incomplete; it was wrong about
         * the business in a way the business could have contradicted on the hour.
         */
        task_type: TOUCH_TASK_TYPE,
        /**
         * The shape `dispatchStep` writes onto the Task it creates, field for field.
         *
         * It is a DESCRIPTION and not the run's input: unlike a chase or a nudge, nothing here is
         * handed to a model — the copy was written and approved before the founder said yes, which
         * is the whole reason one approval can honestly cover two hundred touches. `startNextTouch`
         * builds the row itself, inside the sequencer, from the campaign it re-reads. Matching the
         * shape anyway is what lets a founder see on `/next` exactly what will land in the task list.
         */
        input: { campaign_id: campaignId, case_id: k.id, step: step.action, stage: k.stage },
      },
    },
    [
      // No money term: a prospect has no invoice yet. Saying so in the terms is better than a silent
      // zero — a founder comparing an outreach touch with a chase should see WHY the chase wins.
      { term: "deadline", points: deadlinePoints(k.due_at ? daysBetween(today, k.due_at.slice(0, 10)) : 0), because: "the sequencer's cadence gap has elapsed" },
      { term: "staleness", points: stalenessPoints(daysStale), because: `this prospect has not been touched for ${daysStale} day(s)` },
      learnedTerm("gtm_next_touch", learned),
    ],
    nowIso,
  );
}

/**
 * The marketing experiment that has actually DECIDED — the one insight finding that names a file.
 *
 * ═══ THE UNDECIDED CASE PRODUCES NOTHING. NOT A LOW SCORE — NOTHING ═══
 *
 * This is the single most important line in the function and it is the first one: `if (!report ||
 * !report.winner || !report.loser) return undefined`.
 *
 * `experiment.ts` exists to refuse. Its four gates (200 exposures per arm, five outcomes per cell,
 * |z| ≥ 2.576, ≥10% relative lift) are there because an agent that rewrites a client's homepage on
 * three visitors split 2:1 will rewrite it back next week and thrash their front door forever, each
 * iteration justified by evidence that was never there. Putting an undecided experiment on the home
 * screen as a low-ranked "have a look at this" would relocate that exact thrashing from the agent to
 * the founder: they would look, see 14% versus 11%, and act — because a row on a ranked list is an
 * instruction, whatever hedging sits in its subtitle. The thresholds would still be in the kernel
 * and they would no longer be doing anything.
 *
 * So an undecided test is not a quiet row. It is not a row. The founder finds out how the site is
 * doing on the analytics surface, which is allowed to show numbers without demanding a decision;
 * this list only ever carries the verdict.
 *
 * ═══ WHY THE `why` QUOTES `verdict` VERBATIM ═══
 *
 * The same sentence the agent reads out of `mycel-insight` is the sentence the founder reads here.
 * Rewriting it for the surface would give the two readers of one decision two accounts of it, and
 * the day they disagree is the day the founder stops trusting the run.
 */
function rewriteArmMove(
  projectId: string,
  report: ExperimentReport,
  nowIso: string,
  learned: Map<MoveKind, OutcomeStat>,
): Move | undefined {
  if (!report.winner || !report.loser) return undefined;
  // Same rule as `chaseMove`: a move whose carrier is not installed is a row that cannot become a
  // run. An install with no app-building wedge still measures its experiments — the verdict is on
  // `/analytics/site` either way — it just has nothing to propose about them here.
  const builder = wedgeForRole("app_building");
  if (!builder) return undefined;
  const loser = report.arms.find((a) => a.arm === report.loser);
  const winner = report.arms.find((a) => a.arm === report.winner);
  // `winner`/`loser` are only ever set from rows in `arms`, so this is unreachable — and it is
  // checked anyway because the report crosses no network but does cross a module boundary, and the
  // alternative to checking is a move whose `why` reads "undefined beat undefined".
  if (!loser || !winner) return undefined;

  return assemble(
    {
      // Keyed on the LOSING ARM, not on the project. Two consequences, both wanted: the outcome
      // ledger accumulates against "we were told to rewrite arm B and did/ignored it", so a founder
      // who ignores this three times teaches `learnedPoints` to push it down; and when the verdict
      // flips — B beats A next quarter — that is a genuinely different move with a different id
      // rather than the same row silently changing what it means underneath a recorded outcome.
      id: `rewrite_losing_arm:${report.loser}`,
      project_id: projectId,
      kind: "rewrite_losing_arm",
      entity: { kind: "experiment", id: report.loser, label: `marketing hero "${report.loser}"` },
      // No `client_id` and no `case_id`, and their absence is load-bearing rather than an omission:
      // the marketing page has no counterparty. See `MoveEntityKind`.
      why: report.verdict,
      signals: {
        // Deliberately NO `money_at_stake`. See the long note above `evidencePoints` — that field is
        // summed into "$X in play" on the founder's home screen, and a modelled number in it makes
        // that total part fact and part arithmetic nobody can separate.
        learned: learned.get("rewrite_losing_arm"),
      },
      carrier: {
        // The APP-BUILDING wedge, resolved from what it declares. `build_feature` genuinely exists
        // on disk, unlike `advance_case` and friends — but which directory provides it is not this
        // module's business. Still not takeable; see `takeability`, where the reason is about the
        // deploy and not about the manifest.
        wedge: builder,
        task_type: "build_feature",
        input: {
          brief:
            `The marketing experiment has decided. ${report.verdict} ` +
            `Rewrite the "${report.loser}" hero in content/marketing.ts as a NEW attempt to beat ` +
            `"${report.winner}". Do not delete the arm and do not copy the winner into it, or there ` +
            `is no experiment left to run.`,
          metric: report.metric,
          winner: report.winner,
          loser: report.loser,
          confidence: report.confidence,
          relative_lift: report.relative_lift,
          today: nowIso.slice(0, 10),
        },
      },
    },
    [
      {
        term: "evidence",
        points: evidencePoints(report.relative_lift),
        because:
          `"${report.winner}" converts ${pctOf(winner.conversion_rate)} against ` +
          `${pctOf(loser.conversion_rate)}, at ${Math.round((report.confidence ?? 0) * 100)}% confidence`,
      },
      {
        term: "waste",
        points: wastePoints(loser.exposures),
        because: `${loser.exposures} visitor(s) were shown the arm we now know is the worse one`,
      },
      learnedTerm("rewrite_losing_arm", learned),
    ],
    nowIso,
  );
}

/** Local to the two score sentences above. `experiment.ts` has its own; a second import is noise. */
function pctOf(rate: number): string {
  return `${Math.round(rate * 1000) / 10}%`;
}

// ── taking a move ────────────────────────────────────────────────────────────────────────────────
//
// ═══ WHAT THIS FIXES ═══
//
// The list was READ-ONLY, and that made it a list rather than an operator. A founder read "chase
// INV-104", agreed, and then navigated to Invoices and clicked Chase — doing by hand the one thing
// the move already knew how to describe. The engine had computed the carrier (`wedge`, `task_type`
// and the wedge's own `input`) and then thrown it away at the edge of the UI.
//
// ═══ WHAT IT DELIBERATELY DOES NOT DO ═══
//
// It does not send. `takeMove` SPAWNS A RUN, and the run's first real-world action goes through
// `awaitApproval` exactly as a swept one does — a chase email lands in `/approvals` for a human
// whether the sweep started it at 03:00 or a founder took it from this list at 09:00. vision.md:
// "Human gates stay at consequence boundaries." Taking a move moves the boundary not one inch; it
// only removes the navigation between deciding and enqueueing.
//
// ═══ NO SECOND PATH TO THE SAME WORK ═══
//
// This calls `startChase` — the same function `sweepOverdueInvoices` and `POST
// /v1/invoices/:id/chase` call. Not the same INPUT BUILDER, which is what it was before and was
// never enough: two callers sharing `chaseTaskInput` still had their own claim, their own document
// attachment and their own refusals, and the first thing they would have drifted on is which rung of
// the ladder the run lands on. There is one implementation, and it is in the wedge's own module.

/**
 * Why a move could not be taken. `no_carrier` is the honest one — see `takeability`.
 */
export type TakeRefusal =
  | "no_carrier"
  | "not_proposed"
  | "unknown_move"
  | ChaseRefusal
  | NudgeRefusal
  | CheckInRefusal
  | TouchRefusal;

export type TakeOutcome =
  | { ok: true; move_id: string; task_id: string; message: string }
  | { ok: false; move_id: string; reason: TakeRefusal; message: string };

/**
 * The kinds that have an implementation behind them, UNCONDITIONALLY.
 *
 * ═══ WHY THIS LIST IS SHORT AND THE ANSWER IS STILL MOSTLY "YES" ═══
 *
 * Three of the eight kinds are takeable, and only ONE of them is on this list. That is not a
 * shortfall; it is the honest model. "Can this business chase a client for a document", "can it
 * check in on a quiet engagement" and "can it send the next outreach touch" are questions about
 * WHICH SERVICES THIS BUSINESS RUNS, not about the kernel — a books-keeper declares the nudge, a
 * contract-desk declares the check-in, and an install with neither can do neither. Those three are
 * resolved per wedge, against the manifest on disk, by `takeability` below. Only `chase_invoice` is
 * unconditional, because `dunningWedge()` has already resolved a role holder by the time a chase
 * move exists at all — `chaseMove`'s first line refuses to propose one otherwise.
 *
 * ═══ WHAT IS DELIBERATELY NOT TAKEABLE, AND WHY EACH ONE IS A DECISION ═══
 *
 *   · `advance_case` — "get this engagement over the line" means DOING THE WORK IN IT, which is
 *     different for every trade and already has task types of its own (`monthly_close`,
 *     `weekly_run`, `prepare_invoice`). A generic `advance_case` declared on each wedge to light up
 *     a button would be a verb nobody taught the agent: no rubric, no knowledge that fits, and an
 *     output schema that could only be a free-text blob. That is the hollow declaration this whole
 *     change refuses to make — a button that lights up on an empty contract is worse than no button.
 *   · `unblock_wait` — deciding what happens to a client who went silent for ninety days is a
 *     judgement about a relationship. waits.ts refuses the same choice at expiry, for the same reason.
 *   · `rewrite_losing_arm` — its carrier genuinely exists, and taking it would PUBLISH. See below.
 *   · `invoice_accepted_work` — pricing your own work is not agent work. See below.
 *
 * `moves.test.ts` asserts all of this against the wedge manifests on disk, so the day somebody
 * declares `advance_case` in a wedge, the test fails and points here.
 */
export const TAKEABLE_KINDS: readonly MoveKind[] = ["chase_invoice"];

/**
 * The kinds whose takeability is a property of the WEDGE behind the row, not of the kind.
 *
 * Exported so `takeMove`'s kind-level pre-gate and `moves.test.ts`'s manifest agreement check read
 * one list instead of each keeping their own. It was one entry (`nudge_client_request`) written out
 * as a literal in three places; a fourth conditional kind was added and two of the three were
 * updated, which is the whole argument for the constant.
 */
export const CONDITIONAL_KINDS: readonly MoveKind[] = [
  "nudge_client_request",
  "check_in_case",
  "gtm_next_touch",
];

/**
 * Can this move be taken, and if not, what does the founder get told?
 *
 * `carrierWedge` is the wedge the MOVE ITSELF named — passed rather than looked up, so the gate
 * shown on a row and the gate `takeMove` applies are computed from the same value. A second lookup
 * here would be a second opinion, and the two would disagree the first time a founder moved a
 * request to a different engagement between the page load and the click.
 */
export function takeability(
  kind: MoveKind,
  carrierWedge?: string,
  /**
   * Why the hands this move would need are missing, when the caller has already checked.
   *
   * `chase_invoice` was unconditionally takeable here while the mailbox check lived fourteen hundred
   * lines away in `startChase`. So the row rendered a live button whose tooltip promised "It drafts,
   * then waits for you in Approvals", the founder clicked, and the refusal arrived as a transient
   * bottom-left toast — the row never changed, because `revalidatePath` only runs on success. Clicked
   * five times in one walkthrough on 2026-08-12; the product looked broken rather than unconfigured.
   *
   * Passed in rather than looked up here because the answer is asynchronous and per-invoice, and
   * `takeability` is called from `assemble`, deep inside a synchronous ranking pass. An absent value
   * means "not checked" and changes nothing — the gate downstream still holds, so a caller that does
   * not know cannot accidentally promise anything this function would otherwise have refused.
   */
  handsMissing?: string,
): { takeable: boolean; reason?: string } {
  if (TAKEABLE_KINDS.includes(kind)) {
    return handsMissing ? { takeable: false, reason: handsMissing } : { takeable: true };
  }
  if (kind === "nudge_client_request") {
    if (!carrierWedge) {
      return {
        takeable: false,
        reason: "This ask is not attached to an engagement, so nothing owns the voice a reminder would go out in. Attach it to a case and this lights up.",
      };
    }
    if (wedgeCarriesNudge(carrierWedge)) return { takeable: true };
    return {
      takeable: false,
      reason: `The ${carrierWedge} service does not offer a way to chase a client for something yet — so this one is still yours to do by hand.`,
    };
  }
  if (kind === "check_in_case") {
    /**
     * PER-WEDGE, exactly like the nudge above and for the same reason: whether this business can
     * write a client a status update is a fact about the services it runs, not about the kernel.
     *
     * The refusal names the WEDGE rather than saying "no carrier", because the fix is a real and
     * reachable one — declare `check_in_case` on that service — and a founder told "unavailable"
     * learns nothing they can act on.
     */
    if (!carrierWedge) {
      return {
        takeable: false,
        reason: "This engagement is not attached to a service, so nothing owns the voice an update would go out in.",
      };
    }
    if (wedgeCarriesCheckIn(carrierWedge)) return { takeable: true };
    return {
      takeable: false,
      reason: `The ${carrierWedge} service does not declare a way to check in on an engagement yet — so this one is still yours to write.`,
    };
  }
  if (kind === "gtm_next_touch") {
    /**
     * PER-WEDGE against the manifest, and the check is not ceremony: `gtmMove` names `gtmWedge()`,
     * which resolves whichever wedge holds the outreach role on THIS install, and a founder's own
     * authored outreach service may perfectly well not declare a dispatched touch.
     *
     * ═══ WHY TAKING THIS IS ALLOWED TO SEND, WHEN A CHASE ONLY DRAFTS ═══
     *
     * A taken touch reaches a stranger, and it does so without stopping in `/approvals`. That looks
     * like a weaker boundary than `chase_invoice`'s and it is not, because the human gate happened
     * EARLIER and more meaningfully: the founder read this campaign's sequence and its copy and
     * approved it, before a single prospect was enrolled. Nothing is drafted at dispatch time —
     * `dispatchStep` sends words that were already approved — which is the entire reason one
     * approval can honestly cover two hundred touches. Every dispatch still writes an approval row,
     * `auto_approved`, WITH the envelope's reason, so each message stays individually inspectable.
     *
     * What taking it changes is the CLOCK, forwards to now, for one touch that is already due. The
     * `due_at` gate is re-applied inside `startNextTouch`, so this cannot be clicked into a burst,
     * and `assertSendAllowed` — store-backed, fail-closed, the account's own working hours — is
     * consulted before the send exactly as it is on the tick.
     */
    if (wedgeDeclares(carrierWedge, TOUCH_TASK_TYPE)) return { takeable: true };
    return {
      takeable: false,
      reason: carrierWedge
        ? `The ${carrierWedge} service does not declare a dispatched outreach step, so the sequencer has nothing to send.`
        : "No outbound service is installed on this business, so there is no sequence to advance.",
    };
  }
  if (kind === "advance_case") {
    /**
     * REFUSED, and this is the refusal most worth reading, because it is the one that could most
     * easily have been faked.
     *
     * Declaring an `advance_case` task type on each wedge would have lit this button up in an
     * afternoon. What would be behind it is an agent told "advance this engagement" with a stage
     * name, no rubric for what advancing means in this trade, and an output schema that could only
     * be free text — which is a run that always succeeds and never does anything. Meanwhile the work
     * this move is pointing at genuinely does have carriers, per trade, that were written for it:
     * `monthly_close`, `weekly_run`, `prepare_invoice`, `confirm_extension`.
     *
     * So the row stays, because NOTICING that a dated engagement is about to be late is real value
     * and nothing else in the product does it. The sentence sends the founder to the two things that
     * actually move it.
     */
    return {
      takeable: false,
      reason:
        "Getting this over the line means doing the work in it, which is your engagement's own job and not a button here. " +
        "Open it to run the next step — or check in with the client if what it needs is a conversation about the date.",
    };
  }
  if (kind === "rewrite_losing_arm") {
    /**
     * ═══ THE ONE KIND WHOSE CARRIER EXISTS AND IS STILL REFUSED ═══
     *
     * Every other refusal above is "no wedge declares a task type that carries this". This one is
     * different and the difference is the whole decision: `product-builder` DOES declare
     * `build_feature` in `wedges/product-builder/wedge.json`. Clicking would spawn a real run with a
     * real contract. It is refused anyway.
     *
     * WHY. `chase_invoice` is takeable because its consequence boundary is guarded: the run drafts
     * an email and `awaitApproval` puts it in `/approvals` before a client ever sees it. Taking a
     * chase moves the NAVIGATION and not the boundary — which is the promise the whole take button
     * rests on.
     *
     * `build_feature` has no such boundary. `orchestrator.ts` calls `startDeploy` when the run
     * completes: the new page goes to S3, CloudFront invalidates, and it is live. There is no
     * approval between the run finishing and a stranger reading the founder's front door. So a take
     * button here would not be "start work", it would be "publish a new homepage", and it would look
     * identical to the button next to it that only drafts an email. Two very different decisions
     * wearing one control is precisely how a founder learns the wrong thing about what a click does.
     *
     * It also spends real money — CodeBuild plus a `deep`-tier run with a $5 ceiling — on the
     * strength of a ranking function nobody has audited yet.
     *
     * WHAT WOULD MAKE IT TAKEABLE, so this is a decision and not a shrug: an approval gate on the
     * deploy, so the run produces a page a human confirms before it replaces the live one. That is a
     * real piece of work in `orchestrator.ts` and `deploy.ts`, it is not this change, and until it
     * exists the honest product is a ranked row that tells you what the evidence says and leaves the
     * publishing decision where it belongs.
     *
     * The consequence for autonomy is free rather than argued: `canStart` in autonomy.ts refuses any
     * move with `takeable: false` ("nothing in this business can carry that move yet"), so there is
     * no path by which a sweep republishes a marketing page at 03:00. One line, already written,
     * already tested.
     */
    return {
      takeable: false,
      reason:
        "Rewriting the page publishes it — a product-builder run deploys straight to the live site with no approval in between. " +
        "The evidence is here so you can decide; ask for the rewrite from the product surface when you want it shipped.",
    };
  }
  if (kind === "invoice_accepted_work") {
    /**
     * REFUSED, and for a different reason from every other refusal in this function.
     *
     * The others are "no wedge declares a task type that carries this". Here there is no task type
     * to declare: raising an invoice is not agent work at all. It is `POST /v1/invoices` — the
     * founder choosing lines, a currency and an amount, which are the three things nothing in this
     * kernel can know from a deliverable and the three things a client will argue about. An agent
     * that guessed them would produce a document a business sends in its own name.
     *
     * So the honest control is a link, not a button, and the sentence says where it goes. That is
     * also why the row is worth showing at all: the value here is entirely in the NOTICING.
     */
    return {
      takeable: false,
      reason:
        "Nothing here will invent a price. If this engagement has a money plan, open the deliverable and draft the invoice from the plan — then send it. Otherwise raise the invoice by hand and it drops off this list.",
    };
  }
  if (kind === "release_deliverable") {
    /**
     * REFUSED, same class as `invoice_accepted_work`: there is no task type to declare because
     * releasing is not agent work. It is `POST /v1/deliverables/:id/release` — the founder reviewing
     * finished work and deciding to put it in front of a client. That is a consequence gate the
     * founder owns (deliverables.ts: only the founder makes `in_review → with_client`, and no
     * auto-approve envelope can), so an agent that pressed it would spend the founder's client
     * relationship on a ranking function. The honest control is a link, and the sentence says so.
     */
    return {
      takeable: false,
      reason:
        "This is finished work waiting to go to your client. Open the deliverable to review it and release it — nothing here will send it to them for you.",
    };
  }
  if (kind === "unblock_wait") {
    return {
      takeable: false,
      // Not "no carrier yet" — this one will never have one, and saying so is the point. Deciding
      // what happens to a client who went silent for ninety days is judgement about a relationship;
      // an agent that picked would be autonomy no evidence earned. waits.ts refuses the same choice
      // at expiry time and for the same reason.
      reason: "Nothing is watching this engagement any more. What happens to it — chase them yourself, re-scope it, or close it — is a judgement call about a relationship, and nothing here will make it for you.",
    };
  }
  return {
    takeable: false,
    // The fall-through. Every kind above answers for itself, so reaching this line means a kind was
    // added to `MOVE_KINDS` and nobody decided about it — which is exactly the state that should read
    // as "not wired up" rather than as a live button. The sentence names no machinery: a founder does
    // not have a mental model of task types, and telling them about one is not an explanation.
    reason: "Nothing in this business can carry that yet — so it is still yours to do by hand.",
  };
}

/**
 * Take one move: spawn the carrier run it already named.
 *
 * ═══ IDEMPOTENT, AND BY THE SAME MECHANISM THAT PACES THE SWEEP ═══
 *
 * Move ids are deterministic (`${kind}:${entity_id}`), so the same row is the same move on Tuesday
 * as it was on Monday — which is exactly what makes a double click dangerous. The guard is NOT a
 * dedupe table: `startChase(pacing: "ladder")` claims the invoice with a compare-and-set on
 * `last_chased_at`, so the second take inside the ladder's window loses the claim and returns
 * `paced` rather than putting a second dunning email in one client's inbox. One mechanism, already
 * proven against four worker replicas, instead of a second one that only protects this door.
 *
 * ═══ THE AUTHORITY IS THE TENANT BOUNDARY, AND IT IS NOT A POST-FILTER ═══
 *
 * The move is looked up by RE-PROPOSING under `auth` and finding the id, rather than by parsing an
 * entity id out of the string and fetching it. That matters twice over: a move id naming another
 * tenant's invoice is simply not in the proposal, so it comes back `unknown_move` and reveals
 * nothing about whether that invoice exists; and a move the ladder has stopped proposing (already
 * chased, since paid, now a draft) cannot be taken from a stale page.
 *
 * A move sitting beyond `MAX_LIMIT` in the proposal is refused as `not_proposed`. That is a false
 * negative, and it is the correct direction to fail in: refusing to act on a move we cannot see is
 * survivable, acting on one we cannot see is not.
 */
export async function takeMove(
  stores: MoveStores,
  auth: MoveAuthority,
  moveId: string,
  now: Date = new Date(),
): Promise<TakeOutcome> {
  const id = String(moveId ?? "").trim();
  if (!id) return { ok: false, move_id: id, reason: "unknown_move", message: "No move was named." };

  // The kind is the prefix of the id, and it narrows the proposal so taking one chase does not read
  // every case in the business. It is a HINT ONLY — the move still has to be found in the proposal.
  const kind = MOVE_KINDS.find((k) => id.startsWith(`${k}:`));
  if (!kind) return { ok: false, move_id: id, reason: "unknown_move", message: "That is not a move id." };

  // The kind-level gate only. THREE kinds' answers depend on the wedge behind the row — which wedge
  // owns the ask, the engagement, or the sequence — and none of that is knowable from an id. They
  // are checked below, on the MOVE, once we have one. A guess here would either grey out a takeable
  // move or wave through one with no carrier. The set is derived from `takeability` itself rather
  // than restated: a fourth conditional kind added there and forgotten here would be refused at this
  // line for a reason that is not true.
  if (!CONDITIONAL_KINDS.includes(kind)) {
    const gate = takeability(kind);
    if (!gate.takeable) return { ok: false, move_id: id, reason: "no_carrier", message: gate.reason! };
  }

  const proposal = await proposeMoves(stores, auth, { kinds: [kind], limit: MAX_LIMIT }, now);
  const move = proposal.moves.find((m) => m.id === id);
  if (!move) {
    /**
     * IDEMPOTENCY BITES HERE FIRST, AND THE MESSAGE HAS TO SAY SO.
     *
     * There are two layers stopping a double take, and this is the outer one: the first take stamps
     * `last_chased_at`, so `chaseMove` — which asks the ladder, not a dedupe table — stops proposing
     * the invoice, and the second take never reaches `startChase`. (The inner layer is the claim's
     * compare-and-set, which is what protects two REPLICAS racing rather than two clicks.)
     *
     * The bare "the business has moved on" that stood here was true and useless. A founder who
     * double-clicked was told their business had changed underneath them, when what actually
     * happened is that we are already chasing. So the common cause is disambiguated before falling
     * back to the generic answer. It is a READ of a row this authority has already been proven to
     * own — `getInvoice` cannot scope itself, hence the explicit project comparison.
     */
    if (kind === "chase_invoice") {
      const inv = await stores.billing.getInvoice(id.slice(kind.length + 1));
      if (inv && inv.project_id === auth.project_id && inv.last_chased_at) {
        const since = daysApart(inv.last_chased_at, now.toISOString());
        const wait = chaseIntervalDays(chaseDaysOverdue(inv, now.toISOString().slice(0, 10)));
        if (since < wait) {
          return {
            ok: false,
            move_id: id,
            reason: "paced",
            message:
              since < 1
                ? `${inv.number} is already being chased — the draft is waiting in Approvals.`
                : `${inv.number} was chased ${Math.floor(since)} day(s) ago; the dunning ladder allows another after ${wait}.`,
          };
        }
      }
    }
    /**
     * The same disambiguation for a nudge, and it needs it MORE than a chase does.
     *
     * A request disappears from the list for three quite different reasons — the client answered it,
     * we asked recently, or we have asked our three times and stopped — and "the business has moved
     * on" is a useless sentence for all three. The read is scoped by project, so a request in
     * another tenant still comes back as the generic answer and reveals nothing.
     */
    if (kind === "nudge_client_request") {
      const req = await stores.requests.getRequest(auth.project_id, id.slice(kind.length + 1));
      if (req) {
        if (req.status === "resolved") {
          return { ok: false, move_id: id, reason: "not_open", message: `They have answered "${req.ask}" — nothing to chase.` };
        }
        if (req.status !== "open") {
          return { ok: false, move_id: id, reason: "not_open", message: `That ask was ${req.status}.` };
        }
        if ((req.nudge_count ?? 0) >= MAX_NUDGES) {
          return {
            ok: false,
            move_id: id,
            reason: "exhausted",
            message: `We have asked ${MAX_NUDGES} times about "${req.ask}" with no answer. That is now a conversation, not another email.`,
          };
        }
        if (req.last_nudged_at) {
          const wait = nudgeIntervalDays(req.nudge_count ?? 0);
          const since = daysApart(req.last_nudged_at, now.toISOString());
          if (since < wait) {
            return {
              ok: false,
              move_id: id,
              reason: "paced",
              message:
                since < 1
                  ? `We are already reminding them about "${req.ask}" — the draft is waiting in Approvals.`
                  : `We asked ${Math.floor(since)} day(s) ago; the next reminder is due after ${wait}.`,
            };
          }
        }
      }
    }
    return {
      ok: false,
      move_id: id,
      reason: "not_proposed",
      message: "That is not on the list any more — the business has moved on since this page was drawn.",
    };
  }

  if (move.kind === "chase_invoice") {
    const inv = await stores.billing.getInvoice(move.entity.id);
    // Belt and braces on the tenant. `proposeMoves` already refused every invoice outside the
    // authority, but this is the row we are about to spawn a client-facing run for, and the leak
    // this codebase has already had four times is exactly a scope that was checked one layer up.
    if (!inv || inv.project_id !== auth.project_id) {
      return { ok: false, move_id: id, reason: "unknown_move", message: "That invoice is not in this business." };
    }
    const started = await startChase(inv, { pacing: "ladder", now });
    if (!started.ok) return { ok: false, move_id: id, reason: started.reason, message: started.message };
    return {
      ok: true,
      move_id: id,
      task_id: started.task_id,
      /**
       * Says what actually happened. "Sent" would be a lie: the run drafts, and the send waits for
       * a human in `/approvals`.
       *
       * ═══ THIS SENTENCE WAS A PROMISE NOTHING KEPT ═══
       *
       * In production it was shown for a run that then created no approval at all, sent nothing,
       * and — because `startChase` had already stamped the invoice — removed itself from this very
       * list, leaving $4,800 unchased and no way to try again. The sentence was not wrong about
       * intent; nothing anywhere checked it against the outcome.
       *
       * Three things now stand behind it, and they are the reason it is still allowed to be said:
       *
       *   1. `startChase` refuses with `cannot_send` BEFORE claiming when this business has no
       *      mailbox connected, so a chase that structurally cannot reach the gate never starts.
       *   2. `chase_invoice` declares `promises.send`, so a run that finishes without reaching the
       *      gate is failed rather than reported as done (promises.ts).
       *   3. A failed chase gives its claim back, so the move returns to this list instead of
       *      vanishing for a ladder interval.
       *
       * The last clause is the one that has to stay literally true, so it says what CANNOT happen
       * ("before anything leaves") rather than guessing at a time.
       */
      message: `Chasing ${move.entity.label}. The draft will be waiting for you in Approvals before anything leaves.`,
    };
  }

  if (move.kind === "nudge_client_request") {
    // The gate, applied to the MOVE — which knows the wedge behind the ask. `Move.takeable` was
    // computed from exactly this call in `assemble`, so a founder never sees a live button here.
    const gate = takeability(move.kind, move.carrier.wedge);
    if (!gate.takeable) return { ok: false, move_id: id, reason: "no_carrier", message: gate.reason! };

    const req = await stores.requests.getRequest(auth.project_id, move.entity.id);
    // Belt and braces on the tenant. `proposeMoves` already refused every request outside the
    // authority, but this is the row we are about to spawn a client-facing run for, and the leak
    // this codebase has already had twice is exactly a scope that was checked one layer up.
    if (!req) return { ok: false, move_id: id, reason: "unknown_move", message: "That request is not in this business." };

    // ONE implementation of "chase this client", shared with the sweep and with the request route.
    // `pacing: "ladder"` is what makes a double click safe: the second take loses the
    // compare-and-set on `last_nudged_at` and returns `paced` rather than sending twice.
    const started = await startNudge(stores.domain, req, { pacing: "ladder", now });
    if (!started.ok) return { ok: false, move_id: id, reason: started.reason, message: started.message };
    return {
      ok: true,
      move_id: id,
      task_id: started.task_id,
      // Says what actually happened. "Sent" would be a lie: the run drafts, and the send waits for a
      // human in `/approvals`.
      message: `Reminding them about "${move.entity.label}". The draft will be waiting for you in Approvals before anything leaves.`,
    };
  }

  if (move.kind === "check_in_case") {
    // The gate, applied to the MOVE — which knows the wedge behind the engagement. `Move.takeable`
    // was computed from exactly this call in `assemble`, so a founder never sees a live button here.
    const gate = takeability(move.kind, move.carrier.wedge);
    if (!gate.takeable) return { ok: false, move_id: id, reason: "no_carrier", message: gate.reason! };

    const kase = await stores.domain.getCase(move.entity.id);
    // Belt and braces on the tenant. `proposeMoves` already refused every case outside the authority,
    // but this is the row we are about to spawn a client-facing run for, and the leak this codebase
    // has shipped twice is exactly a scope that was checked one layer up. `getCase` cannot scope
    // itself, hence the explicit comparison.
    if (!kase || kase.project_id !== auth.project_id) {
      return { ok: false, move_id: id, reason: "unknown_move", message: "That engagement is not in this business." };
    }

    // ONE implementation of "tell this client where their work is". `pacing: "ladder"` is what makes
    // a double click safe: the second take loses the compare-and-set on `data.last_checked_in_at`
    // and returns `paced` rather than putting two identical updates in one inbox.
    const started = await startCheckIn(stores.domain, kase, { pacing: "ladder", now });
    if (!started.ok) return { ok: false, move_id: id, reason: started.reason, message: started.message };
    return {
      ok: true,
      move_id: id,
      task_id: started.task_id,
      // Says what actually happened. The run drafts; the send waits for a human in `/approvals`.
      message: `Writing an update on "${move.entity.label}". The draft will be waiting for you in Approvals before anything leaves.`,
    };
  }

  if (move.kind === "gtm_next_touch") {
    const gate = takeability(move.kind, move.carrier.wedge);
    if (!gate.takeable) return { ok: false, move_id: id, reason: "no_carrier", message: gate.reason! };

    const kase = await stores.domain.getCase(move.entity.id);
    if (!kase || kase.project_id !== auth.project_id) {
      return { ok: false, move_id: id, reason: "unknown_move", message: "That prospect is not in this business." };
    }

    // The sequencer's own per-case path, unchanged: cadence rules, the step's `only_if`, pacing, and
    // the campaign envelope, in that order. See `startNextTouch` for why this one is allowed to send.
    const started = await startNextTouch(stores.domain, kase, { now });
    if (!started.ok) return { ok: false, move_id: id, reason: started.reason, message: started.message };
    return {
      ok: true,
      move_id: id,
      task_id: started.task_id,
      // "Sent" IS the truth here, unlike every other branch, and saying anything softer would be the
      // lie: the words were approved with the campaign and they have now gone out.
      message: `Sent the next touch to ${move.entity.label}. It is on the campaign timeline with the approval that allowed it.`,
    };
  }

  // Unreachable while `TAKEABLE_KINDS` is what it is, and it stays here so that adding a kind to
  // that list without wiring its carrier is a refusal rather than a silent no-op.
  return { ok: false, move_id: id, reason: "no_carrier", message: takeability(move.kind, move.carrier.wedge).reason! };
}

// ── outcomes the harness already knows ───────────────────────────────────────────────────────────
//
// ═══ WHAT THIS FIXES ═══
//
// `recordOutcome` had exactly one caller: a founder clicking one of three buttons. So the learning
// half of the loop only turned when somebody remembered to go back to a page and report what
// happened, which — for a product whose pitch is that it removes coordination work — is a
// coordination task. `MIN_EVIDENCE` is five, and five hand-entered outcomes per kind is a threshold
// most businesses would never cross, so `learnedPoints` returned 0 for ever and the engine could
// not be shown to be wrong.
//
// Two of the five results are not judgements at all — they are facts the kernel watches go by:
//
//   · `paid`    — an invoice settling. `POST /v1/invoices/:id/payments` already knows.
//   · `replied` — a prospect answering. `noteInboundReplies` already knows.
//
// ═══ WHAT IS NOT DERIVED, AND WHY THAT IS THE HARDER DISCIPLINE ═══
//
// `ignored` is NOT inferred, ever. It is the ABSENCE of evidence, and absence has no timestamp: an
// invoice that has not been paid might be one the client is disputing, one whose chase never went
// out because it is still sitting in `/approvals`, or one paid by bank transfer that nobody has
// reconciled yet. Manufacturing "ignored" from silence would feed the ranking a number that says
// more about our own reconciliation lag than about whether chasing works, and `learnedPoints`
// weights the downside heavily on purpose. It stays a founder judgement, or a timeout somebody
// designs deliberately.
//
// A THIRD result is now derived, and it is derived for exactly the reason the other two are:
//
//   · `done` — a `ClientRequest` reaching `resolved` after we nudged. `POST
//     /v1/portal/requests/:id/respond` already knows.
//
// This paragraph used to say the opposite, and the reason it said so is worth keeping: there was no
// `last_nudged_at` and nothing ever nudged, so there was no MOMENT to attribute an answer to, and
// crediting the move for an answer the client got round to on their own would have been inventing
// evidence. The field exists now and something does the nudging, so the attribution is a real one —
// but it is still refused when there is no nudge to credit. See `noteRequestAnswered`.

/**
 * How long after a chase a settlement can still be that chase's outcome. Thirty days.
 *
 * THE WINDOW IS AN ARGUMENT, not a round number. It has to be at least one payment cycle: the
 * default commercial term in the market this is built for is 30 days, and a chased client very often
 * answers "it will go out in the next run" — payment runs are typically fortnightly or monthly, so
 * anything under a month systematically fails to credit the chases that DID work and teaches the
 * engine that chasing does nothing.
 *
 * And it has to be short enough that the credit means something. Beyond a month, a settlement is
 * far more plausibly explained by the client's own cycle, a later chase, or the founder picking up
 * the phone, than by an email sent five weeks ago. The brief's example is exactly this: a payment
 * two months before — or two months after — a chase is not that chase's outcome.
 *
 * If this number changes, this paragraph changes with it.
 */
export const PAID_ATTRIBUTION_DAYS = 30;

/**
 * How long after an outreach touch a reply can still be that touch's outcome. Fourteen days.
 *
 * Shorter than the money window because the behaviour is different. Replies to outreach are fast —
 * the mass of them arrive within days — and the sequencer's own cadence gaps are days-scale, so
 * beyond a fortnight the reply is more plausibly the NEXT touch's outcome than this one's. Two
 * weeks is roughly two cadence steps: long enough to survive somebody's holiday, short enough that
 * a prospect answering out of the blue three months later does not retroactively make an old
 * sequence look effective.
 */
export const REPLY_ATTRIBUTION_DAYS = 14;

/**
 * How long after a nudge an answer can still be that nudge's outcome. Seven days.
 *
 * SHORTER THAN BOTH THE OTHERS, and the asymmetry is the argument. A reminder that works, works
 * fast: a client who is going to go and find the March statement does it in the day or two after
 * being asked, because the cost to them is minutes rather than a payment run. And the nudge ladder
 * itself repeats every 3–7 days, so a window much wider than one rung would credit THIS nudge for an
 * answer the NEXT one actually earned — the same reasoning that keeps `REPLY_ATTRIBUTION_DAYS` under
 * the money window, applied to a faster loop.
 *
 * Beyond a week, a document arriving is far more plausibly the client's own admin day, or the founder
 * picking up the phone, than an email sent last Tuesday.
 */
export const ANSWER_ATTRIBUTION_DAYS = 7;

/** Whole days between two instants, as a float — attribution needs sub-day resolution. */
const daysApart = (from: string, to: string): number =>
  (Date.parse(to) - Date.parse(from)) / 86_400_000;

/**
 * An invoice settled in full: credit the chase that plausibly caused it.
 *
 * `last_chased_at` is the evidence, and it is the RIGHT evidence: it is stamped by
 * `claimInvoiceForChase`, which is the single gate every chase goes through — swept, hand-pulled, or
 * taken off the next-move list. So "was this chased, and when" is one field rather than a scan of
 * the task table for runs that may or may not have got as far as sending.
 *
 * THREE REFUSALS, all of them "we do not actually know that":
 *
 *   1. Never chased. Nothing to credit. The client just paid, which is what is supposed to happen.
 *   2. Settled BEFORE the chase (negative elapsed). Clock skew or a backdated payment — either way
 *      a chase cannot be the cause of something that already happened.
 *   3. Settled more than `PAID_ATTRIBUTION_DAYS` after the chase. See that constant.
 *
 * Returns the outcome it wrote, or `undefined` when it credited nothing. Silence is a real answer
 * here and the caller treats it as one.
 */
export async function noteInvoiceSettled(
  domain: DomainStore,
  auth: MoveAuthority,
  inv: Invoice,
  at: string = new Date().toISOString(),
): Promise<MoveOutcome | undefined> {
  // The tenant of the ROW and the tenant of the AUTHORITY must be the same one. An outcome written
  // under the wrong project silently retrains another founder's ranking, which is the failure this
  // whole module's authority pattern exists to prevent — and here the row arrives from a caller.
  if (!inv.project_id || inv.project_id !== auth.project_id) return undefined;
  if (!inv.last_chased_at) return undefined;

  const elapsed = daysApart(inv.last_chased_at, at);
  if (elapsed < 0) return undefined;
  if (elapsed > PAID_ATTRIBUTION_DAYS) return undefined;

  const days = Math.floor(elapsed);
  return recordOutcome(domain, auth, {
    // The SAME id `chaseMove` computes, because a move id is derived and not stored. A founder who
    // clicked "Worked" on this chase and the settlement that arrives an hour later land on the same
    // ledger key, which is what makes the history of one move a `LIKE` and not a join.
    move_id: `chase_invoice:${inv.id}`,
    kind: "chase_invoice",
    entity_id: inv.id,
    result: "paid",
    // Not a member id: nobody clicked. An operator reading the ledger has to be able to tell an
    // observed fact from a human's opinion, because only one of them is evidence about the founder.
    by: "system",
    note: `${inv.number} settled in full ${days} day${days === 1 ? "" : "s"} after the last chase`,
    at,
  });
}

/**
 * A client answered an ask: credit the nudge that plausibly earned it.
 *
 * `last_nudged_at` is the evidence, and it is the right evidence for the same reason
 * `Invoice.last_chased_at` is: it is stamped by `claimRequestForNudge`, the single gate every nudge
 * goes through — swept, hand-pulled, or taken off the next-move list. So "did we chase this, and
 * when" is one field rather than a scan of the task table for runs that may not have got as far as
 * sending.
 *
 * THREE REFUSALS, all of them "we do not actually know that":
 *
 *   1. Never nudged. Nothing to credit — the client just answered, which is what is supposed to
 *      happen, and taking credit for it would teach the ranking that nudging works when nothing
 *      nudged.
 *   2. Answered BEFORE the nudge (negative elapsed). Clock skew, or an answer that crossed with the
 *      reminder in flight. Either way a nudge cannot have caused something that already happened.
 *   3. Answered more than `ANSWER_ATTRIBUTION_DAYS` after. See that constant.
 *
 * `"ignored"` is STILL never derived here, and the discipline is the same one the header states: a
 * request nobody answered might be one the client cannot find, one whose nudge is still sitting in
 * `/approvals`, or one they answered by replying to the thread instead of using the portal. Absence
 * has no timestamp, and `learnedPoints` weights the downside heavily on purpose.
 *
 * Returns the outcome it wrote, or `undefined` when it credited nothing. Silence is a real answer.
 */
export async function noteRequestAnswered(
  domain: DomainStore,
  auth: MoveAuthority,
  req: Pick<ClientRequest, "id" | "project_id" | "ask" | "last_nudged_at" | "nudge_count">,
  at: string = new Date().toISOString(),
): Promise<MoveOutcome | undefined> {
  // The tenant of the ROW and the tenant of the AUTHORITY must be the same one. An outcome written
  // under the wrong project silently retrains another founder's ranking — and here the row arrives
  // from a caller.
  if (!req.project_id || req.project_id !== auth.project_id) return undefined;
  if (!req.last_nudged_at) return undefined;

  const elapsed = daysApart(req.last_nudged_at, at);
  if (elapsed < 0) return undefined;
  if (elapsed > ANSWER_ATTRIBUTION_DAYS) return undefined;

  const days = Math.floor(elapsed);
  const asks = req.nudge_count ?? 1;
  return recordOutcome(domain, auth, {
    // The SAME id `nudgeMove` computes, because a move id is derived and not stored.
    move_id: `nudge_client_request:${req.id}`,
    kind: "nudge_client_request",
    entity_id: req.id,
    // `done`, not `replied`: the ask is CLEARED, which is a stronger fact than a reply. A client can
    // reply "I'll look next week" without the work becoming unblocked, and only one of those two
    // things is what the nudge was for.
    result: "done",
    // Not a member id: nobody clicked. An operator reading the ledger has to be able to tell an
    // observed fact from a human's opinion, because only one of them is evidence about the founder.
    by: "system",
    note: `"${req.ask}" was answered ${days} day${days === 1 ? "" : "s"} after reminder ${asks} of ${MAX_NUDGES}`,
    at,
  });
}

/**
 * A prospect replied: credit the outreach touch that plausibly earned it.
 *
 * `data.last_touch_at` is the evidence — stamped by `advanceSequences` at the moment a message
 * actually goes out, which is a stronger signal than `updated_at` (any write moves that, including
 * this very reply) and than the case history (a stage change is not a send).
 *
 * Called from `noteInboundReplies` BEFORE the stage flips, deliberately: once the case is `replied`
 * the touch that earned it is no longer identifiable from the row.
 */
export async function noteReplyToTouch(
  domain: DomainStore,
  auth: MoveAuthority,
  kase: Pick<Case, "id" | "project_id" | "data">,
  at: string = new Date().toISOString(),
): Promise<MoveOutcome | undefined> {
  if (!kase.project_id || kase.project_id !== auth.project_id) return undefined;
  const lastTouch = (kase.data as Record<string, unknown> | undefined)?.last_touch_at;
  // A prospect who answered a message this campaign never sent — enrolled mid-conversation, or
  // replying to something the founder wrote by hand. Real, and not ours to take credit for.
  if (typeof lastTouch !== "string" || !lastTouch) return undefined;

  const elapsed = daysApart(lastTouch, at);
  if (elapsed < 0) return undefined;
  if (elapsed > REPLY_ATTRIBUTION_DAYS) return undefined;

  const days = Math.floor(elapsed);
  return recordOutcome(domain, auth, {
    move_id: `gtm_next_touch:${kase.id}`,
    kind: "gtm_next_touch",
    entity_id: kase.id,
    result: "replied",
    by: "system",
    note: `they replied ${days} day${days === 1 ? "" : "s"} after the last touch`,
    at,
  });
}
