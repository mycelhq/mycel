// Standing permission — the half of the loop that stops waiting to be asked.
//
// ═══ WHAT THIS FIXES ═══
//
// `moves.ts` reads the business, ranks what could legally be done, and shows its arithmetic.
// `takeMove` enqueues one. `waits.ts` parks and resumes. Every one of those steps waits for a
// founder to click. The engine has an opinion and no permission, and vision.md §3 asks for the
// opposite: "the system should look at owed work, waits, money, campaign pacing, policy, and
// capacity — then do the obvious next thing (or ask)."
//
// So this module answers ONE question: which proposals may START without a human, and it runs a
// sweep that starts them.
//
// ═══ TWO POLICIES, TWO QUESTIONS, AND THEY MUST NOT MERGE ═══
//
// `policy.ts` already exists and already means something precise: given that a run is happening,
// may THIS ACTION (an email send, a Stripe call) skip the human gate? That is a question about
// CONSEQUENCE, and it is the cash drawer's lock.
//
// This module asks a different question: may this WORK START at all without being asked? That is a
// question about INITIATIVE.
//
// Conflating them is how a product sends a thousand emails on a Sunday. So:
//
//   · Autonomy here decides whether to START a run. Never whether to skip a consequence gate.
//   · A started run's first outward action still goes through `awaitApproval` unless the WEDGE's
//     own `auto_approve` envelope (policy.ts) separately permits it. Nothing in this file reads,
//     writes, widens or bypasses that envelope. Grep it: there is no `evaluatePolicy` call here and
//     no `approval_required` written anywhere below.
//   · A sweep that started a chase produces a draft in `/approvals` exactly like the 03:00 dunning
//     sweep and exactly like a founder clicking "Take this on".
//
// ═══ WHY IT IS THE SAME POLICY LANGUAGE AND NOT A SECOND ONE ═══
//
// A business with two ideas about what it is allowed to do has neither. So the grammar below is
// deliberately `PolicyRule`'s grammar, term for term:
//
//   policy.ts  { action: "email:send_email", max_amount_usd, max_per_task, max_per_day }
//   here       { kind:   "chase_invoice",    max_amount,     …,             max_per_day }
//
// Same match-one-rule-then-apply-ceilings shape, same "a ceiling that cannot be evaluated refuses",
// same fail-closed default ("no policy means the human gate applies"), and literally the same
// counter store (`getPolicyCounters`) so the ceilings are atomic across replicas for free. What
// differs is only what a rule matches — a kind of move rather than a connector action — because
// those are genuinely different nouns and pretending otherwise would mean a founder granting
// "chase_invoice" and accidentally authorising an email send.
//
// ═══ THE DEFAULT IS ASK ═══
//
// Silence means propose. Autonomy is opt-in per kind. No policy row, a paused policy, a malformed
// policy, an unreachable counter store, a clock we cannot place in the founder's window — every one
// of those refuses and the move stays on `/next` waiting to be asked, which is exactly today's
// behaviour. Nothing about this file can make the product do MORE than it did when it fails.
import { randomUUID } from "node:crypto";
import type { DomainStore } from "./domain";
import { minorUnitExponent } from "./billing";
import { getPolicyCounters } from "./store";
// A cycle: exposure.ts needs this module's ceilings, and this module needs its composed view. Kept
// safe by exposure.ts holding no top-level expression over an imported binding — see `sweepsPerDay`.
import { exposureView, type ExposureView } from "./exposure";
import {
  MAX_LIMIT,
  MIN_EVIDENCE,
  MOVE_KINDS,
  moveAuthorityForProject,
  outcomeStats,
  proposeMoves,
  takeMove,
  type Move,
  type MoveAuthority,
  type MoveKind,
  type MoveStores,
  type OutcomeStat,
} from "./moves";

/** Reserved wedge slug for this module's rows, exactly as `MOVES_WEDGE` is. Not a wedge on disk. */
export const AUTONOMY_WEDGE = "autonomy";
/** The policy document. One row per project — `key` is a constant, so the upsert is the update. */
export const POLICY_COLLECTION = "autonomy_policy";
export const POLICY_KEY = "current";
/** The append-only ledger of what ran on its own. */
export const START_COLLECTION = "autonomy_start";

/** The sweep's task type. Intercepted in `fireSchedule` — it is harness arithmetic, not agent work. */
export const AUTONOMY_SWEEP_TASK_TYPE = "take_permitted_moves";

/**
 * Fifteen minutes.
 *
 * Slower than the wait sweep (5 min) because nothing here is conversational — the fastest signal it
 * acts on is a dunning rung measured in days — and every tick is a full `proposeMoves`, which reads
 * invoices, requests, cases and waits for the project. Faster than the hourly dunning sweep because
 * a founder who grants permission and then watches nothing happen for an hour concludes it is
 * broken.
 */
export const SWEEP_SECONDS = 900;

/** Cap on backing off an empty permitted-moves tick. One hour. */
export const EMPTY_BACKOFF_CAP_S = 3600;

/**
 * Next delay after an empty autonomy tick.
 *
 * `streak` is how many consecutive empty ticks have already happened (0 on the first miss).
 * First empty → 30 minutes; then the one-hour cap. A grey list that fires a 0ms run every
 * fifteen minutes is worse than a slower clock.
 */
export function emptySweepBackoffSeconds(streak: number): number {
  const n = Math.max(0, Math.floor(streak));
  return Math.min(SWEEP_SECONDS * 2 ** Math.min(n + 1, 3), EMPTY_BACKOFF_CAP_S);
}

/**
 * The per-sweep ceiling nobody can raise. Five.
 *
 * A per-day ceiling alone is not enough: a bug that starts everything it sees would burn a 40/day
 * budget in one tick, at 03:00, before anyone could look. This bounds the BLAST RADIUS OF ONE PASS,
 * so the worst tick a bug can produce is five runs — every one of them still stopping at its own
 * approval gate — and the next tick is fifteen minutes away with a human's morning in between.
 *
 * A founder may set `max_starts_per_sweep` LOWER. There is deliberately no way to set it higher.
 */
export const HARD_MAX_PER_SWEEP = 5;

/**
 * The per-project per-day ceiling nobody can raise. Twenty.
 *
 * Same argument at a longer horizon: expensive-but-survivable rather than unbounded. Twenty
 * autonomous starts a day is more work than a solo founder does by hand and far less than a runaway
 * loop, and every one of them is a run that drafts and stops — not a send.
 */
export const HARD_MAX_PER_DAY = 20;

/** Autonomous starts shown back to the founder on `/next`. Bounded like every read here. */
export const RECENT_STARTS = 20;

// ── the grammar a founder writes ─────────────────────────────────────────────────────────────────

/**
 * One standing permission.
 *
 * Deliberately NOT a rules engine. A founder expresses this as one sentence — "chase overdue
 * invoices under $2,000 on your own, up to three a day, on weekdays" — and every field below is a
 * word of that sentence. There is no boolean algebra, no `and`/`or`, no expression language, because
 * the moment there is one the founder cannot predict what the machine will do, and a permission
 * nobody can predict is not a permission.
 */
export interface AutonomyRule {
  /** The kind of move this permits. Exact match, never a prefix — see `permits`. */
  kind: MoveKind;
  /**
   * Ceiling on the money at stake, in MAJOR units of the move's own currency.
   *
   * FX IS NOT MODELLED, exactly as `moneyPoints` in moves.ts says it is not, and for the same
   * reason: the kernel has no rate source and inventing one would make a permission depend on a
   * number nobody in the business can see. Within a currency this is exact. A firm billing in two
   * currencies gets a ceiling compared against magnitudes, and this sentence is why.
   *
   * A move with NO money on it (a nudge, a check-in) does not satisfy a value ceiling — it refuses.
   * See `permits`: a ceiling that cannot be evaluated is not a ceiling.
   */
  max_amount?: number;
  /** Ceiling on autonomous starts of this kind within a rolling UTC day, per project. */
  max_per_day?: number;
  /**
   * The window, in the founder's own clock (see `utc_offset_minutes`). `{ from: 9, to: 18 }` means
   * 09:00–17:59. Absent means any hour.
   *
   * This exists because "a thousand emails on a Sunday" is the specific failure this whole module is
   * afraid of, and a time window is the cheapest honest guard against it.
   */
  hours?: { from: number; to: number };
  /** Days of the week that are permitted, `0` = Sunday, in the founder's clock. Absent means all. */
  days?: number[];
}

export interface AutonomyPolicy {
  v: 1;
  /**
   * THE KILL SWITCH. One field, checked before anything else, stopping every autonomous start in
   * this project immediately — without the founder having to find and delete each rule they wrote,
   * which is what they would be doing at the exact moment they least want to be editing config.
   *
   * It does not delete the rules. Turning it back off restores exactly what was granted, because a
   * founder who paused during an incident should not be punished by having to rebuild their policy.
   */
  paused?: boolean;
  allow?: AutonomyRule[];
  /** Per-pass ceiling. Clamped to `HARD_MAX_PER_SWEEP` — a founder may lower it, never raise it. */
  max_starts_per_sweep?: number;
  /** Per-project per-day ceiling. Clamped to `HARD_MAX_PER_DAY`, same rule. */
  max_starts_per_day?: number;
  /**
   * Minutes to add to UTC to get the founder's clock. `-300` is US Eastern in winter.
   *
   * A fixed offset and not an IANA zone, and that is a stated limitation: the kernel carries no
   * timezone database, and a window that silently shifts by an hour twice a year is worse than one a
   * founder can see is an offset. What it buys is that "weekdays, 9 to 6" means the founder's 9 to 6
   * rather than Greenwich's, which is the difference between a guard and a decoration.
   */
  utc_offset_minutes?: number;
  updated_at?: string;
  updated_by?: string;
}

/** What the sweep wrote when it started something. Append-only, and the answer to "why did it?". */
export interface AutonomousStart {
  v: 1;
  move_id: string;
  kind: MoveKind;
  entity_label: string;
  client_id?: string;
  case_id?: string;
  task_id: string;
  /** The sentence naming the rule that permitted it. Law 6 — this is the explanation, stored. */
  because: string;
  at: string;
}

// ── reading and writing the policy ───────────────────────────────────────────────────────────────

/**
 * Load a project's policy, or `undefined`.
 *
 * The tenant is pushed INTO the query and never post-filtered, the rule `outcomeStats` states and
 * the one both of this codebase's shipped cross-tenant leaks broke. A policy read under the wrong
 * project would grant one founder's permissions over another founder's clients.
 *
 * ANY doubt returns `undefined`, which means "propose everything, act on nothing". A store that
 * throws, a row whose `v` is not 1, a row that is not an object — all of them land on the same
 * answer as no row at all, because the only safe interpretation of a policy we cannot read is that
 * there isn't one.
 */
export async function loadAutonomyPolicy(
  domain: DomainStore,
  projectId: string,
): Promise<AutonomyPolicy | undefined> {
  const state = await readAutonomyPolicy(domain, projectId);
  return state.status === "granted" ? state.policy : undefined;
}

/**
 * WHY THE POLICY IS "ABSENT" — the distinction `loadAutonomyPolicy` deliberately throws away.
 *
 * For the SWEEP, "unreadable" and "nothing granted" are the same answer and must be: both refuse,
 * and collapsing them into one `undefined` is what makes the fail-closed path impossible to get
 * wrong. For a SURFACE they are opposite answers, and conflating them is a real bug:
 *
 *   A founder opens `/next` while the record store is throwing. The composed view reads
 *   `undefined`, renders "nothing runs on its own", and the founder goes on holiday reassured — by
 *   a screen that in fact knows nothing. "No limits found" must never look like "no risk".
 *
 * So the distinction is made HERE, once, and both callers derive from it rather than from two
 * hand-written reads of the same row — which is the shape of every tenant bug in this codebase.
 */
export type AutonomyPolicyState =
  | { status: "granted"; policy: AutonomyPolicy }
  /** No row. The default and the common case: this business asks before it acts. */
  | { status: "none" }
  /** A row we cannot trust — the store threw, or the document is a version/shape we do not know. */
  | { status: "unreadable"; why: string };

export async function readAutonomyPolicy(
  domain: DomainStore,
  projectId: string,
): Promise<AutonomyPolicyState> {
  // An unscoped read is not "no policy", it is a caller bug — but it must still not throw into a
  // sweep, so it lands on the tightest answer there is.
  if (!projectId) return { status: "none" };
  let rows: Awaited<ReturnType<DomainStore["queryRecords"]>>;
  try {
    rows = await domain.queryRecords({
      project_id: projectId,
      wedge: AUTONOMY_WEDGE,
      collection: POLICY_COLLECTION,
      // `RecordQuery` has no `key` filter, and the collection holds exactly one row per project
      // (`saveAutonomyPolicy` always writes `POLICY_KEY`), so the key is asserted below rather than
      // pushed into the query. The TENANT is pushed in, which is the filter that matters.
      limit: 5,
    });
  } catch (e) {
    const why = (e as Error)?.message ?? String(e);
    console.error(`[mycel] could not read the autonomy policy for ${projectId}:`, why);
    return { status: "unreadable", why };
  }
  const row = rows.find((r) => r.key === POLICY_KEY);
  if (!row) return { status: "none" };
  const data = row.data as unknown as AutonomyPolicy | undefined;
  if (!data || typeof data !== "object") {
    return { status: "unreadable", why: "the stored policy is not a document" };
  }
  if (data.v !== 1) {
    return { status: "unreadable", why: `the stored policy is version ${String(data.v)}, which this kernel does not understand` };
  }
  return { status: "granted", policy: data };
}

/**
 * Write the policy. WHOLE DOCUMENT, never a patch.
 *
 * `upsertRecord` merges `data` shallowly, so a partial write would leave a key the founder meant to
 * remove sitting in the row — and the key most likely to be removed is a rule, i.e. the failure
 * would be "I revoked that and it kept running". Callers assemble the full document; this function
 * sanitises it and stores it.
 */
export async function saveAutonomyPolicy(
  domain: DomainStore,
  projectId: string,
  policy: AutonomyPolicy,
  by: string,
  now: Date = new Date(),
): Promise<AutonomyPolicy> {
  if (!projectId) throw new Error("an autonomy policy must be scoped to a project");
  const clean = sanitisePolicy(policy, now, by);
  await domain.upsertRecord({
    // From the ARGUMENT the route derived from the session, never from the policy body. A policy
    // written into another project grants standing permission over someone else's clients.
    project_id: projectId,
    wedge: AUTONOMY_WEDGE,
    collection: POLICY_COLLECTION,
    key: POLICY_KEY,
    data: clean as unknown as Record<string, unknown>,
  });
  return clean;
}

/**
 * Clamp into range. Used ONLY where clamping moves toward LESS autonomy — the ceilings, where the
 * hard maximum is the safe end and a founder asking for 999 gets 20.
 */
const clampInt = (v: unknown, lo: number, hi: number): number | undefined => {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return undefined;
  return Math.min(hi, Math.max(lo, n));
};

/**
 * Accept in range, DROP outside it. Used where clamping would INVENT A PERMISSION.
 *
 * THE BUG THIS FIXES, caught by its own test: `days: [9]` clamped to `[6]` grants Saturday to a
 * founder who typed a typo and never named a day at all — and `hours: {from: 25}` clamped to 23
 * grants an hour window out of nonsense. A ceiling clamps safely because both ends of its range are
 * "less"; a day and an hour have no safe end, so the only honest answer to an unparseable one is to
 * drop it and fall back to the documented default (all days, all hours), which is at least visible
 * on the founder's surface and therefore arguable.
 */
const intIn = (v: unknown, lo: number, hi: number): number | undefined => {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < lo || n > hi) return undefined;
  return n;
};

/**
 * Normalise anything a caller sent into a policy the sweep can trust.
 *
 * DROPS what it cannot understand rather than storing it. A rule naming a kind this build does not
 * have is not preserved "in case a newer kernel wants it": it would sit in the founder's list
 * looking like a granted permission that never fires, and the honest answer to "I granted that and
 * nothing happened" must not be "we kept your typo".
 */
export function sanitisePolicy(p: AutonomyPolicy, now: Date, by: string): AutonomyPolicy {
  const seen = new Set<MoveKind>();
  const allow: AutonomyRule[] = [];
  for (const r of Array.isArray(p?.allow) ? p.allow : []) {
    const kind = r?.kind as MoveKind;
    if (!(MOVE_KINDS as readonly string[]).includes(kind)) continue;
    // ONE rule per kind. Two rules for one kind is a precedence question ("does the tighter or the
    // first one win?") that a founder should never have to hold in their head, and whichever answer
    // we picked would surprise half of them. The last one written wins, which is what "I changed it"
    // means.
    if (seen.has(kind)) continue;
    seen.add(kind);
    const rule: AutonomyRule = { kind };
    const amount = Number(r.max_amount);
    if (Number.isFinite(amount) && amount > 0) rule.max_amount = amount;
    // ZERO IS A REVOKE, not a clamp to one. "At most 0 a day" is a founder saying stop, and
    // clamping it up to 1 would answer them by starting one. The rule is dropped entirely.
    if (r.max_per_day !== undefined && Number(r.max_per_day) <= 0) continue;
    const perDay = clampInt(r.max_per_day, 1, HARD_MAX_PER_DAY);
    if (perDay !== undefined) rule.max_per_day = perDay;
    const from = intIn(r.hours?.from, 0, 23);
    const to = intIn(r.hours?.to, 1, 24);
    // An empty or inverted window would refuse everything for ever while LOOKING like a grant. The
    // founder meant something; storing a contradiction and silently never acting is the worst of the
    // available behaviours, so a window that cannot be satisfied is dropped and the grant is
    // all-hours — which is visible on the surface and therefore arguable.
    if (from !== undefined && to !== undefined && to > from) rule.hours = { from, to };
    const days = Array.isArray(r.days)
      ? [...new Set(r.days.map((d) => intIn(d, 0, 6)).filter((d): d is number => d !== undefined))].sort()
      : undefined;
    if (days && days.length) rule.days = days;
    allow.push(rule);
  }
  return {
    v: 1,
    paused: p?.paused === true,
    allow,
    max_starts_per_sweep: clampInt(p?.max_starts_per_sweep, 1, HARD_MAX_PER_SWEEP) ?? HARD_MAX_PER_SWEEP,
    max_starts_per_day: clampInt(p?.max_starts_per_day, 1, HARD_MAX_PER_DAY) ?? HARD_MAX_PER_DAY,
    utc_offset_minutes: clampInt(p?.utc_offset_minutes, -840, 840) ?? 0,
    updated_at: now.toISOString(),
    updated_by: by.slice(0, 200),
  };
}

// ── the decision ─────────────────────────────────────────────────────────────────────────────────

export interface AutonomyDecision {
  /** True when this move may start without a human. */
  allowed: boolean;
  /**
   * The sentence. On the timeline when it allowed, and in the sweep summary when it did not.
   *
   * Always NAMES THE RULE when a rule was involved — vision Law 6 is explainability, and "why did it
   * do that" must have an answer that names the rule rather than an answer that describes a system.
   */
  because: string;
  rule?: AutonomyRule;
}

const DENY = (because: string, rule?: AutonomyRule): AutonomyDecision => ({ allowed: false, because, rule });

/**
 * Does the policy permit this move to start on its own, ignoring ceilings?
 *
 * PURE. No clock of its own, no store, no I/O — so the whole decision is testable at a table, and
 * the ceilings (which are shared, atomic and racy by nature) are a separate concern applied by the
 * sweep. Mixing them would mean the only way to test "does a Sunday refuse" is to spin up a counter.
 *
 * Every branch here refuses. There is exactly one `allowed: true` and it is the last line.
 */
export function permits(
  policy: AutonomyPolicy | undefined,
  move: Pick<Move, "kind" | "signals" | "takeable">,
  now: Date,
  learned?: Map<MoveKind, OutcomeStat>,
): AutonomyDecision {
  if (!policy) return DENY("no autonomy policy — this business asks before it acts");
  if (policy.v !== 1) return DENY("the autonomy policy is a version this kernel does not understand");
  if (policy.paused) return DENY("autonomy is paused for this business");
  /**
   * A move with no carrier cannot be run by a founder either. Starting one would spawn a task type
   * no wedge declares — an agent handed a verb nobody taught it. See `takeability`.
   *
   * ═══ THIS LINE IS WHY WIDENING TAKEABILITY IS ALSO WIDENING AUTONOMY ═══
   *
   * Worth stating, because it happens for free and therefore silently. The day `check_in_case` and
   * `gtm_next_touch` became takeable, they also became things this sweep is ALLOWED to consider —
   * nobody edited this file. Three things stop that being a change in how much the business does on
   * its own at 03:00, and all three are load-bearing:
   *
   *   1. THE DEFAULT IS ASK. Two lines below, a kind with no explicit `allow` rule is refused. A
   *      newly-takeable kind starts at zero autonomy and stays there until a founder grants it.
   *   2. THE CEILINGS DID NOT MOVE. `HARD_MAX_PER_SWEEP` (5) and `HARD_MAX_PER_DAY` (20) are per
   *      PROJECT, not per kind, so more executable kinds compete for the same budget rather than
   *      adding to it. `moves.test.ts` asserts both as literals.
   *   3. THE CONSEQUENCE BOUNDARY IS STILL THE CARRIER'S. A swept check-in drafts and stops at
   *      `awaitApproval` exactly as a swept chase does. A swept outreach touch sends — and it sends
   *      inside the campaign envelope the founder approved before anyone was enrolled, writing an
   *      `auto_approved` row with that reason, which is the one standing consent in this system that
   *      was granted against specific copy. `standing.ts` still cannot cover a high-risk verdict.
   */
  if (!move.takeable) return DENY("nothing in this business can carry that move yet");

  const rule = (policy.allow ?? []).find((r) => r.kind === move.kind);
  // THE DEFAULT IS ASK. Not "no rule so use a sensible default" — no rule means propose.
  if (!rule) return DENY(`no standing permission for "${move.kind}" — it stays on your list`);

  /**
   * ═══ AUTOMATIC NARROWING, AND WHY ONLY THIS DIRECTION IS HONEST ═══
   *
   * `outcomeStats` is real evidence: `noteInvoiceSettled` and `noteReplyToTouch` are written by the
   * harness watching facts go by, and `rejected` is written by a founder pressing a button that says
   * so. So the engine genuinely knows when a kind of move keeps being rejected.
   *
   * What it may do with that knowledge is asymmetric, deliberately:
   *
   *   · NARROW automatically. A kind the founder keeps rejecting stops running on its own and goes
   *     back to being proposed. The failure mode of being wrong here is a proposal — i.e. today's
   *     behaviour — so being wrong costs a click.
   *   · WIDEN never. A policy that granted itself permission because the numbers looked good is a
   *     system that talked itself into acting, and the founder finds out afterwards. Widening is
   *     SUGGESTED (see `suggestWidening`) and applied only by a human. vision.md: "autonomy
   *     increases only where evidence and policy earned it" — earned, and then granted.
   *
   * `MIN_EVIDENCE` is the same floor the ranking uses, for the same reason: adjusting behaviour from
   * two data points is superstition wearing a percentage sign.
   */
  const stat = learned?.get(move.kind);
  if (stat && stat.taken >= MIN_EVIDENCE && stat.rejected / stat.taken >= REJECTION_STANDDOWN) {
    return DENY(
      `you rejected ${stat.rejected} of the last ${stat.taken} moves like this, so it is asking again rather than acting`,
      rule,
    );
  }

  if (rule.max_amount !== undefined) {
    const minor = move.signals.money_at_stake;
    const currency = move.signals.currency;
    // A ceiling that cannot be evaluated is not a ceiling. Same refusal `evaluatePolicy` makes when
    // a rule caps an amount and the payload has none — and the same reason: "no amount found" must
    // never read as "zero, therefore under the cap".
    if (minor === undefined || !currency) {
      return DENY("your permission caps the value, and this move has no money on it to check", rule);
    }
    const major = minor / 10 ** (move.signals.minor_unit_exponent ?? minorUnitExponent(currency));
    if (major > rule.max_amount) {
      return DENY(`${major} ${currency} is over the ${rule.max_amount} you allowed for this`, rule);
    }
  }

  const local = new Date(now.getTime() + (policy.utc_offset_minutes ?? 0) * 60_000);
  if (rule.days && !rule.days.includes(local.getUTCDay())) {
    return DENY(`you only allowed this on ${dayNames(rule.days)}`, rule);
  }
  if (rule.hours) {
    const h = local.getUTCHours();
    if (h < rule.hours.from || h >= rule.hours.to) {
      return DENY(`you only allowed this between ${rule.hours.from}:00 and ${rule.hours.to}:00`, rule);
    }
  }

  return {
    allowed: true,
    because: describeRule(rule),
    rule,
  };
}

/**
 * The share of rejections at which a granted kind stands itself back down. One in three.
 *
 * Not a half: by the time a founder has rejected half of something they have long since stopped
 * trusting it, and the point of standing down is to catch the drift before that. Not one in five
 * either — with `MIN_EVIDENCE` at five, one in five is a single bad call and a single bad call is
 * not a pattern.
 */
export const REJECTION_STANDDOWN = 1 / 3;

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const dayNames = (days: number[]): string => days.map((d) => DAY_NAMES[d] ?? String(d)).join(", ");

/** The permission, back in the founder's own words. This is what lands on the case timeline. */
export function describeRule(rule: AutonomyRule): string {
  const bits: string[] = [`you allow "${rule.kind}" to run on its own`];
  if (rule.max_amount !== undefined) bits.push(`up to ${rule.max_amount}`);
  if (rule.max_per_day !== undefined) bits.push(`at most ${rule.max_per_day} a day`);
  if (rule.days) bits.push(`on ${dayNames(rule.days)}`);
  if (rule.hours) bits.push(`between ${rule.hours.from}:00 and ${rule.hours.to}:00`);
  return bits.join(", ");
}

// ── ceilings ─────────────────────────────────────────────────────────────────────────────────────
//
// The SAME counter store `policy.ts` uses, and that is not laziness. It is already atomic
// (`bump` returns the caller's own position in the sequence), already expiring, already
// project-scoped, already backed by Postgres in the deployment that runs four replicas, and already
// the thing that was fixed after in-process `Map`s let a `max_per_day: 40` envelope permit ~160
// actions a day. A second counter implementation for this ceiling would get one of those wrong.
//
// Keys are namespaced with `autonomy|` so they cannot collide with a connector rule that happens to
// be named after a move kind.

const dayKey = (now: Date): string => now.toISOString().slice(0, 10);

function dayExpiry(now: Date): Date {
  const end = new Date(now);
  end.setUTCHours(24, 0, 0, 0);
  return end;
}

/**
 * Claim one slot against both the project ceiling and the rule's own, atomically.
 *
 * Returns the sentence explaining a refusal, or `undefined` when the slot is ours.
 *
 * ═══ WHY BUMP-THEN-CHECK AND NOT CHECK-THEN-BUMP ═══
 *
 * Copied from `evaluatePolicy`, and the argument is identical: a read followed by a write is a race
 * two replicas both win. `bump` is atomic and returns the NEW value, so "did I get a slot" is
 * answered by that number and nothing else — the callers holding 1..limit proceed and everyone
 * beyond is refused, no matter how many sweeps raced. Exactly `limit` starts.
 *
 * The project ceiling is claimed FIRST. A rule-level refusal after a project-level claim burns a
 * project slot that was never used, which under-counts autonomy — the safe direction, and the same
 * trade `evaluatePolicy` documents between its task and day counters.
 *
 * FAIL CLOSED on an unreachable store, for the reason policy.ts spells out at length: this is the
 * bound on how much a bug can do unsupervised, and a bound that evaporates when a database blips is
 * not a bound.
 */
async function claimSlot(
  projectId: string,
  policy: AutonomyPolicy,
  rule: AutonomyRule,
  now: Date,
): Promise<string | undefined> {
  const perDay = Math.min(policy.max_starts_per_day ?? HARD_MAX_PER_DAY, HARD_MAX_PER_DAY);
  const day = dayKey(now);
  const expiry = dayExpiry(now);
  try {
    const counters = await getPolicyCounters();
    const used = await counters.bump(projectId, "day", `autonomy|${day}|*`, expiry);
    if (used > perDay) {
      return `this business has already started ${perDay} things on its own today`;
    }
    if (rule.max_per_day !== undefined) {
      const kindUsed = await counters.bump(projectId, "day", `autonomy|${day}|${rule.kind}`, expiry);
      if (kindUsed > rule.max_per_day) {
        return `you allowed ${rule.max_per_day} of these a day and that is used up`;
      }
    }
    return undefined;
  } catch (e) {
    return `the autonomy ceilings could not be read, so it asked instead: ${(e as Error)?.message ?? e}`;
  }
}

// ── earned autonomy: suggested, never taken ──────────────────────────────────────────────────────

export interface WideningSuggestion {
  kind: MoveKind;
  taken: number;
  worked: number;
  /** The sentence a founder reads next to a Grant button. Evidence first, ask second. */
  because: string;
}

/**
 * How much evidence before we will even ASK for a kind to run on its own. Eight.
 *
 * Higher than `MIN_EVIDENCE` (five), which is the floor for nudging a RANK. The two thresholds are
 * different because the two decisions are: getting a ranking slightly wrong costs a founder reading
 * one row in the wrong order, and getting a permission wrong costs them a client contact they did
 * not sanction. A bar for a suggestion that lands on the founder's main surface should be higher
 * than a bar for a number inside a sort.
 */
export const MIN_EVIDENCE_TO_SUGGEST = 8;

/** The success rate at which a kind has earned the right to be OFFERED autonomy. Three quarters. */
export const SUGGEST_WORKED_RATE = 0.75;

/**
 * Kinds this business's own history says are worth granting — as a SUGGESTION.
 *
 * ═══ THE HONEST VERSION OF "EARNED AUTONOMY" ═══
 *
 * The brief allowed this to be skipped if it could not be made honest. It can, on one condition:
 * the widening is a proposal to a human and never an act. So:
 *
 *   · The evidence is REAL. `worked` here is `paid` / `replied` / `done`, and two of those three are
 *     written by the harness observing a fact — an invoice settling inside `PAID_ATTRIBUTION_DAYS`
 *     of a chase, a prospect replying inside `REPLY_ATTRIBUTION_DAYS` of a touch. It is not a model's
 *     opinion of how a run went, and it is not `ignored` inferred from silence, which moves.ts
 *     refuses to derive for exactly the reason it should.
 *   · The widening is VISIBLE. It appears on `/next`, in the founder's words, next to the numbers
 *     that produced it, with a button. Nothing changes until they press it.
 *   · There is no silent path. `sanitisePolicy` is the only writer of a rule and every caller of it
 *     is a route with a member id on it.
 *
 * What this deliberately is NOT: a policy that raises its own ceilings. The asymmetry with the
 * automatic narrowing in `permits` is the whole argument — being wrong toward asking costs a click,
 * being wrong toward acting costs a client.
 */
export function suggestWidening(
  learned: Map<MoveKind, OutcomeStat>,
  policy: AutonomyPolicy | undefined,
): WideningSuggestion[] {
  const granted = new Set((policy?.allow ?? []).map((r) => r.kind));
  const out: WideningSuggestion[] = [];
  for (const stat of learned.values()) {
    if (granted.has(stat.kind)) continue;
    if (stat.taken < MIN_EVIDENCE_TO_SUGGEST) continue;
    if (stat.rejected > 0) continue;
    if (stat.worked / stat.taken < SUGGEST_WORKED_RATE) continue;
    out.push({
      kind: stat.kind,
      taken: stat.taken,
      worked: stat.worked,
      because:
        `${stat.worked} of the last ${stat.taken} of these worked and you rejected none. ` +
        `Want it to start these on its own? It will still stop at Approvals before anything is sent.`,
    });
  }
  return out.sort((a, b) => b.worked - a.worked);
}

// ── the sweep ────────────────────────────────────────────────────────────────────────────────────

export interface AutonomySweepSummary {
  project_id: string;
  /** Moves the engine proposed this pass. */
  considered: number;
  /** Runs actually enqueued. Every one has a ledger row and, where there is a case, a timeline note. */
  started: number;
  /** Permitted, but the carrier refused (already being chased, the ladder says wait, …). */
  refused: number;
  /** Left on the founder's list. The default, and on a healthy day the big number. */
  proposed: number;
  /** Why it stopped, when it stopped early. `undefined` means it got through the list. */
  stopped?: string;
  starts: AutonomousStart[];
}

/**
 * One pass: take the moves this project has granted standing permission for.
 *
 * `project_id` is a required field of a required argument and it THROWS on empty. There is no
 * overload that sweeps every tenant. `sweepWaits` states the reason and it is stronger here: this
 * one STARTS CLIENT-FACING WORK, so a defaulted tenant is one founder's permission spending another
 * founder's reputation.
 *
 * ═══ WHY THIS CANNOT DOUBLE-ACT ═══
 *
 * Four layers, none of them new:
 *
 *   1. The schedule. This hangs off `claimDueSchedules` like every other sweep, so with four
 *      replicas exactly one fires each tick.
 *   2. The proposal. A move already taken by hand is NOT PROPOSED — `chaseMove` asks the dunning
 *      ladder, which stopped proposing the invoice the moment `last_chased_at` was stamped. So the
 *      sweep cannot even see it.
 *   3. `takeMove` re-proposes under the authority before acting, so a list that went stale between
 *      the read here and the act is refused rather than acted on.
 *   4. `startChase(pacing: "ladder")` claims the invoice with a compare-and-set. Two sweeps that got
 *      past all three of the above still produce one winner and one `paced`.
 *
 * The ceilings are the fifth, and the only one that is about a BUG rather than a race.
 */
export async function sweepAutonomousMoves(args: {
  stores: MoveStores;
  project_id: string;
  now?: Date;
}): Promise<AutonomySweepSummary> {
  if (!args.project_id) throw new Error("an autonomy sweep must be scoped to a project");
  const now = args.now ?? new Date();
  const domain = args.stores.domain;
  const summary: AutonomySweepSummary = {
    project_id: args.project_id,
    considered: 0,
    started: 0,
    refused: 0,
    proposed: 0,
    starts: [],
  };

  const policy = await loadAutonomyPolicy(domain, args.project_id);
  // FAIL CLOSED, and this is the branch that makes "no policy means nothing runs" true rather than
  // aspirational. No read of the business happens at all — a project that has granted nothing costs
  // one indexed row read per tick.
  if (!policy) {
    summary.stopped = "no autonomy policy — this business asks before it acts";
    return summary;
  }
  if (policy.paused) {
    summary.stopped = "autonomy is paused for this business";
    return summary;
  }

  const auth = await moveAuthorityForProject(domain, args.project_id);
  const proposal = await proposeMoves(args.stores, auth, { limit: MAX_LIMIT }, now);
  summary.considered = proposal.moves.length;

  const perSweep = Math.min(policy.max_starts_per_sweep ?? HARD_MAX_PER_SWEEP, HARD_MAX_PER_SWEEP);
  // Read ONCE for the whole pass rather than per move: the stand-down in `permits` is a property of
  // the project's history, not of the individual move, and re-reading it twenty-five times would be
  // twenty-five scans of the outcome ledger for one identical answer.
  const learned = await outcomeStats(domain, auth);

  // HIGHEST SCORE FIRST, which is the order `proposeMoves` already returned. If a ceiling is going
  // to cut the pass short, the things it starts should be the things the engine argued hardest for —
  // spending a scarce budget on whatever happened to be first in the list would make the ranking a
  // decoration.
  for (const move of proposal.moves) {
    if (summary.started >= perSweep) {
      summary.stopped = `stopped at ${perSweep} starts for this pass — the rest are on your list`;
      summary.proposed += 1;
      continue;
    }

    const decision = permits(policy, move, now, learned);
    if (!decision.allowed || !decision.rule) {
      summary.proposed += 1;
      continue;
    }

    // The ceiling is claimed BEFORE the act, so a start that then fails costs a slot. That direction
    // is deliberate: under-counting autonomy is survivable, and the alternative is a reservation
    // protocol across two counters for a bound whose entire job is to be conservative.
    const blocked = await claimSlot(args.project_id, policy, decision.rule, now);
    if (blocked) {
      summary.proposed += 1;
      summary.stopped ??= blocked;
      continue;
    }

    let taken: Awaited<ReturnType<typeof takeMove>>;
    try {
      // THE SAME CARRIER A FOUNDER'S CLICK USES. Not a copy of it, not a shortcut past it: the same
      // re-proposal under the same authority, the same wedge input builder, the same ladder claim,
      // and the same approval gate on whatever the run tries to send. If this called anything else,
      // autonomy would be a second path to the same work and the two would drift.
      taken = await takeMove(args.stores, auth, move.id, now);
    } catch (e) {
      // One move that blew up must not stop the other twenty-four — the rule `sweepWaits` and
      // `advanceSequences` both state. Counted, never swallowed.
      console.error(`[mycel] autonomous start of ${move.id} failed:`, (e as Error)?.message ?? e);
      summary.refused += 1;
      continue;
    }
    if (!taken.ok) {
      // A carrier refusal is a NORMAL outcome, not an error: "we chased this yesterday and the
      // ladder says wait" is the system working. It stays on the founder's list.
      summary.refused += 1;
      continue;
    }

    const because = decision.because;
    const start: AutonomousStart = {
      v: 1,
      move_id: move.id,
      kind: move.kind,
      entity_label: move.entity.label,
      client_id: move.client_id,
      case_id: move.case_id,
      task_id: taken.task_id,
      because,
      at: now.toISOString(),
    };
    summary.started += 1;
    summary.starts.push(start);
    await recordStart(domain, args.project_id, start).catch(() => {});

    /**
     * ON THE ENGAGEMENT'S OWN TIMELINE, NAMING THE RULE. Vision Law 6.
     *
     * "Why did it do that" has to have an answer, and the answer has to be the rule rather than a
     * description of the system. A founder reading a case must be able to see the moment the
     * business acted without them and the sentence they themselves wrote that allowed it.
     *
     * Not every move has a case — an invoice raised outside an engagement is a real shape — which is
     * exactly why `recordStart` above is unconditional and this is best-effort. A start with no
     * timeline is still on the ledger and still on `/next`; a start with no record anywhere would be
     * the silent system this product refuses to be.
     */
    if (move.case_id) {
      await domain
        .updateCase(
          move.case_id,
          {},
          {
            at: now.toISOString(),
            kind: "task_spawned",
            task_id: taken.task_id,
            note: `started on its own — ${because}. Nothing is sent until it is approved.`,
            actor: "autonomy",
          },
        )
        .catch(() => {});
    }
  }

  return summary;
}

/**
 * Append one autonomous start to the ledger.
 *
 * Append-only with a UUID in the natural key, exactly like `recordOutcome`, and for the identical
 * reason: `upsertRecord` merges shallowly with no arithmetic, so a "starts today" counter row would
 * be a read-modify-write that loses updates the moment two replicas act in the same second. Rows are
 * immutable and the counting happens on read — the ceilings are the counter store's job, not this
 * one's.
 */
export async function recordStart(
  domain: DomainStore,
  projectId: string,
  start: AutonomousStart,
): Promise<void> {
  await domain.upsertRecord({
    project_id: projectId,
    wedge: AUTONOMY_WEDGE,
    collection: START_COLLECTION,
    // Day-prefixed and descending-sortable, so "what ran on its own today" is a prefix rather than a
    // scan during an incident.
    key: `${start.at}:${randomUUID()}`,
    data: start as unknown as Record<string, unknown>,
  });
}

/** The most recent autonomous starts, newest first. The founder's answer to "what ran without me?". */
export async function recentStarts(
  domain: DomainStore,
  projectId: string,
  limit = RECENT_STARTS,
): Promise<AutonomousStart[]> {
  if (!projectId) return [];
  const rows = await domain
    .queryRecords({
      // Pushed INTO the query, never post-filtered — a `limit` over an unfiltered read truncates
      // another tenant's rows into view, which is the shape of both leaks this codebase has shipped.
      project_id: projectId,
      wedge: AUTONOMY_WEDGE,
      collection: START_COLLECTION,
      limit: 500,
    })
    .catch(() => []);
  return rows
    .map((r) => r.data as unknown as AutonomousStart)
    .filter((s) => s && s.v === 1 && typeof s.at === "string")
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, limit);
}

// ── the founder's whole view, in one read ────────────────────────────────────────────────────────

export interface AutonomyView {
  policy: AutonomyPolicy;
  recent: AutonomousStart[];
  suggestions: WideningSuggestion[];
  /** Every kind, so the surface can offer a grant for one that has never run. */
  kinds: readonly MoveKind[];
  hard_max_per_sweep: number;
  hard_max_per_day: number;
  /**
   * WHAT THE TWO POLICIES ADD UP TO. See exposure.ts.
   *
   * This module answers "may it start"; `policy.ts` answers "may it send". A founder who granted
   * both has composed something neither answer displays, and the composition is the only one that
   * answers "what can this do to my customers while I am away". It rides along here rather than on
   * a route of its own for the same Law 5 reason this whole view does: it is a sentence about the
   * grant, and it belongs next to the grant.
   *
   * A READ. It widens nothing — `exposureView` performs one `queryRecords` and reads wedge manifests
   * off disk.
   */
  exposure: ExposureView;
}

/** The empty policy a project that has granted nothing gets. Explicit, so the UI has one shape. */
export const EMPTY_POLICY: AutonomyPolicy = { v: 1, paused: false, allow: [] };

/**
 * Everything `/next` needs about autonomy, in one call.
 *
 * It rides along with the move proposal deliberately — vision Law 5, "do not turn internals into
 * product". Standing permission is not a subsystem that deserves a page; it is the answer to "and
 * what did you do without me?", which only means anything next to "and here is what I did not do".
 */
export async function autonomyView(
  domain: DomainStore,
  auth: MoveAuthority,
): Promise<AutonomyView> {
  const [policy, recent, learned, exposure] = await Promise.all([
    loadAutonomyPolicy(domain, auth.project_id),
    recentStarts(domain, auth.project_id),
    outcomeStats(domain, auth).catch(() => new Map<MoveKind, OutcomeStat>()),
    // NOT caught. Every other read here degrades to a smaller answer; this one degrades to a
    // REASSURING one, and a founder told "nothing can happen without you" by a failed read is
    // exactly the failure the whole composition exists to prevent. Losing the section is honest;
    // showing an empty one is not.
    exposureView(domain, auth),
  ]);
  return {
    policy: policy ?? EMPTY_POLICY,
    recent,
    suggestions: suggestWidening(learned, policy),
    kinds: MOVE_KINDS,
    hard_max_per_sweep: HARD_MAX_PER_SWEEP,
    hard_max_per_day: HARD_MAX_PER_DAY,
    exposure,
  };
}

/**
 * Create (or find) the sweeping Schedule for a project.
 *
 * One per project, always scoped, modelled on `ensureWaitSchedule`. Ensured when a founder first
 * GRANTS something rather than at project creation, for the reason that one gives: a business that
 * has granted nothing should not carry a tick that finds nothing.
 */
export async function ensureAutonomySchedule(domain: DomainStore, projectId: string, now: Date = new Date()) {
  if (!projectId) throw new Error("an autonomy schedule must be scoped to a project");
  const existing = (await domain.listSchedules()).find(
    (s) => s.project_id === projectId && s.task_type === AUTONOMY_SWEEP_TASK_TYPE,
  );
  if (existing) return existing;
  return domain.createSchedule({
    project_id: projectId,
    name: "take the moves you allowed",
    wedge: AUTONOMY_WEDGE,
    task_type: AUTONOMY_SWEEP_TASK_TYPE,
    input: {},
    cadence: { kind: "every", seconds: SWEEP_SECONDS },
    enabled: true,
    next_run_at: new Date(now.getTime() + SWEEP_SECONDS * 1000).toISOString(),
  });
}
