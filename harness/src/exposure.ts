// The composed answer: given everything you have allowed, what can this business do to your
// customers without you?
//
// ═══ WHY THIS EXISTS ═══
//
// Two policies gate autonomous work, each individually correct and individually bounded:
//
//   · `autonomy.ts`  — INITIATIVE. May this work START without being asked? Per move kind, hard
//                      capped at 5 starts a sweep and 20 a day, with a kill switch.
//   · `policy.ts`    — CONSEQUENCE. Given a run is happening, may THIS ACTION skip the human gate?
//                      Per connector action, with `max_per_task` and `max_per_day` ceilings.
//
// Keeping them apart is right — conflating them is how a founder granting "chase invoices" would
// accidentally grant "send email". But a founder who grants BOTH has composed something neither
// screen displays. Autonomy starts a run; the connector envelope then lets that run send without
// asking. `/next` shows the grant. `wedge.json` holds the envelope, and was written weeks ago by
// somebody else. Nowhere does the product answer the only question that matters before a founder
// goes on holiday:
//
//   "What can this thing do to my customers while I am not looking?"
//
// THE MOTIVATING FAILURE, concretely: a founder presses "Let it run" on chase_invoice, reads the
// tooltip promising that anything it sends "still waits for you in Approvals", and believes nothing
// can be sent. But `wedges/invoice-chaser/wedge.json` declares
// `{action: "email:send_reminder", max_per_task: 3, max_per_day: 50}` — so every chase that starts
// on its own may auto-send three reminder emails to a client with no human in the loop. The tooltip
// was not lying; it was incomplete, and incomplete in the direction that costs a client.
//
// ═══ THIS IS A READ. IT GRANTS NOTHING ═══
//
// Nothing in this file writes. There is no third policy store — a business with three ideas about
// what it may do has none. Every number below is DERIVED from the two policies exactly as they are
// on disk and in the record store, and the derivation is a pure function (`composeExposure`) so it
// cannot acquire an opinion of its own. Grep this file: no `upsertRecord`, no `saveAutonomyPolicy`,
// no `evaluatePolicy` (which would CONSUME budget — see its `commit` flag), no counter `bump`.
//
// ═══ FAIL LOUD, NOT BLANK ═══
//
// "No limits found" must never render like "no risk". A policy we cannot read, a wedge manifest we
// cannot parse, a carrier we cannot name — each produces an explicit `unknown` that the surface is
// obliged to show as an unknown, not a zero. The one thing this module will not do is reassure.
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  HARD_MAX_PER_DAY,
  HARD_MAX_PER_SWEEP,
  SWEEP_SECONDS,
  readAutonomyPolicy,
  type AutonomyPolicy,
  type AutonomyRule,
} from "./autonomy";
import { dunningWedge } from "./dunning";
import { wedgeForRole } from "./roles";
import type { DomainStore } from "./domain";
import { MOVE_KINDS, type MoveAuthority, type MoveKind } from "./moves";
import type { PolicyRule } from "./policy";
import { loadWedge, wedgesDir, type WedgeManifest } from "./wedge";

// ── which rule binds ─────────────────────────────────────────────────────────────────────────────

/**
 * The name of the rule that actually decides a number.
 *
 * "At most 3 a day" is useless to a founder. "At most 3 a day, because your grant caps chase_invoice
 * at 3 even though the connector envelope allows 50 sends" is a sentence they can act on — they know
 * which of the two dials to turn. So every ceiling below carries the identity of its own binding
 * constraint, and the surface is built to print it.
 */
export type Binder =
  /** The founder's own `max_per_day` on this kind of move. The dial they most likely meant to turn. */
  | "your_grant"
  /** The project-wide `max_starts_per_day` in the autonomy policy. */
  | "project_day"
  /** `HARD_MAX_PER_DAY` — the ceiling nobody can raise. */
  | "kernel_day"
  /** `max_starts_per_sweep` × the number of sweeps that fall inside the permitted hours. */
  | "sweep_rate"
  /** The connector envelope's `max_per_task`, multiplied up by the number of runs that may start. */
  | "envelope_per_run"
  /** The connector envelope's `max_per_day`. Shared with every other run in the project. */
  | "envelope_per_day"
  /** Both an autonomy limit and an envelope limit land on the same number. */
  | "both"
  /** Nothing may start / nothing may send. A ceiling of zero has no binder worth naming. */
  | "nothing_granted";

/** A derived ceiling. `value` is absent exactly when `unbounded` or `unknown` is true. */
export interface Ceiling {
  value?: number;
  /** No rule anywhere caps this. Real, and the surface must say so rather than print a big number. */
  unbounded: boolean;
  /** We could not read a policy this depends on. NOT zero, and never rendered as zero. */
  unknown: boolean;
  binder: Binder;
  /** The clause a founder reads. Names the rule, never the system. */
  because: string;
}

const NONE: Ceiling = {
  value: 0,
  unbounded: false,
  unknown: false,
  binder: "nothing_granted",
  because: "it is not granted, so it waits to be asked",
};

const unknownCeiling = (because: string): Ceiling => ({
  unbounded: false,
  unknown: true,
  binder: "nothing_granted",
  because,
});

// ── the connector envelope, read honestly ────────────────────────────────────────────────────────

/**
 * What the carrier wedge's `policy.auto_approve` says, or why we cannot say.
 *
 * `loadWedge` returns `null` for a wedge that does not exist AND for one whose `wedge.json` is
 * malformed, which is fine for the runtime (both fail closed at `evaluatePolicy`) and NOT fine here:
 * "this wedge is not installed" and "this wedge's envelope is unparseable" are opposite things to
 * tell a founder. So the file's existence is checked separately.
 */
export type EnvelopeStatus =
  /** The wedge declares no envelope. Every outward action stops at Approvals — the safe default. */
  | { status: "gated"; wedge: string }
  | { status: "envelope"; wedge: string; rules: PolicyRule[] }
  /** The manifest is there and we cannot parse it. Loud, never silent. */
  | { status: "unreadable"; wedge: string; why: string }
  /** No such wedge on disk. A run would fail closed, but say so rather than imply an envelope. */
  | { status: "missing"; wedge: string }
  /** The carrier is chosen per engagement and this project runs none we can name. */
  | { status: "no_carrier"; why: string };

export function readEnvelope(wedge: string, load: typeof loadWedge = loadWedge): EnvelopeStatus {
  const manifest = load(wedge)?.manifest as WedgeManifest | undefined;
  if (!manifest) {
    // Distinguishing a missing wedge from a corrupt one is the whole reason this touches the
    // filesystem rather than trusting `loadWedge`'s single `null`.
    const present = existsSync(join(wedgesDir(), wedge, "wedge.json"));
    return present
      ? { status: "unreadable", wedge, why: `${wedge}/wedge.json could not be parsed` }
      : { status: "missing", wedge };
  }
  const rules = (manifest.policy?.auto_approve ?? []) as PolicyRule[];
  if (!Array.isArray(rules) || rules.length === 0) return { status: "gated", wedge };
  return { status: "envelope", wedge, rules };
}

// ── the carrier ──────────────────────────────────────────────────────────────────────────────────

/**
 * Which wedge would carry a kind of move, and therefore whose envelope applies.
 *
 * `moves.ts` resolves this three different ways and this mirrors it rather than inventing a fourth:
 * two hand-written derivations of the same answer diverge the day somebody wires a carrier.
 *
 *   · `chase_invoice`  → whichever wedge declares the `dunning` role.
 *   · `gtm_next_touch` → whichever wedge declares the `outreach` role.
 *   · the other three  → the ENGAGEMENT's own wedge, which is not knowable until there is an
 *                        engagement. So the candidates are the wedges this project is actually
 *                        running (`MoveAuthority.wedges`, derived from its cases and schedules) and
 *                        the WIDEST envelope among them is used.
 *
 * Widest, not first, and not narrowest: this is a worst case. A project running both `books-keeper`
 * (20 receipt chases a day) and `harness-operator` (no envelope) can produce either, and telling the
 * founder the smaller number would be the reassuring blank this module exists to refuse.
 *
 * ═══ AN EMPTY LIST IS AN ANSWER, AND THE RIGHT ONE ═══
 *
 * The first two used to be module constants naming a wedge DIRECTORY (`DUNNING_WEDGE`, `GTM_WEDGE`).
 * If nothing on this install declares the role, nothing can carry that kind of move unattended — so
 * the honest exposure is no carriers, which `envelopeFor` already renders as "nothing here does that
 * on its own". The tempting alternative, falling through to `projectWedges`, would attribute a chase
 * to whatever wedge happened to be running and quote the founder somebody else's auto-approve
 * ceiling — a number that is confident, specific and about the wrong wedge.
 */
export function carriersFor(kind: MoveKind, projectWedges: readonly string[]): string[] {
  if (kind === "chase_invoice") return onlyPresent(dunningWedge());
  if (kind === "gtm_next_touch") return onlyPresent(wedgeForRole("outreach"));
  return [...projectWedges].sort();
}

/** `wedgeForRole` returns undefined when nothing claims the role; that is zero carriers, not one. */
const onlyPresent = (w: string | undefined): string[] => (w ? [w] : []);

// ── how many runs may start on their own, in a day ───────────────────────────────────────────────

/**
 * Sweeps in a 24h day, at `SWEEP_SECONDS`. 96 at the shipped cadence.
 *
 * A FUNCTION and not a module constant, and that is not style. autonomy.ts imports this module for
 * its `ExposureView` and this module imports autonomy.ts for its ceilings — a genuine cycle, which
 * ES modules survive only as long as nothing reads an imported binding during module evaluation.
 * A top-level `const X = f(SWEEP_SECONDS)` here throws a temporal-dead-zone ReferenceError whenever
 * autonomy.ts happens to be the entry of the cycle, i.e. intermittently and only at boot.
 */
const sweepsPerDay = (): number => Math.floor(86_400 / SWEEP_SECONDS);

/**
 * Sweeps that fall inside a rule's permitted hours.
 *
 * An `hours: {from: 9, to: 18}` window is not decoration: it genuinely removes ticks from the day,
 * and a worst case that ignored it would over-state exposure — which is scaremongering, and a
 * founder who catches the product exaggerating stops reading it. `to` is exclusive (see `permits`).
 */
function sweepsInWindow(rule: AutonomyRule): number {
  if (!rule.hours) return sweepsPerDay();
  const hours = Math.max(0, rule.hours.to - rule.hours.from);
  return Math.floor((hours * 3600) / SWEEP_SECONDS);
}

/**
 * The number of runs of one kind that may start unattended in one permitted day, and which rule
 * decided it.
 *
 * FOUR ceilings apply at once and the real number is the MINIMUM — not the sum, and not whichever
 * one the founder happens to be looking at. They are compared in order of how actionable they are,
 * so a tie names the dial the founder can actually turn (their own grant) ahead of one they cannot
 * (the kernel's hard cap).
 *
 * "Permitted DAY" matters: `days: [1,2,3,4,5]` does not lower the ceiling on a Tuesday, it removes
 * Saturday entirely. Folding it into a daily number would understate what happens on a weekday, so
 * it is carried in the sentence instead.
 */
export function startsPerDay(policy: AutonomyPolicy, rule: AutonomyRule): Ceiling {
  const perSweep = Math.min(policy.max_starts_per_sweep ?? HARD_MAX_PER_SWEEP, HARD_MAX_PER_SWEEP);
  const rate = perSweep * sweepsInWindow(rule);
  const projectDay = Math.min(policy.max_starts_per_day ?? HARD_MAX_PER_DAY, HARD_MAX_PER_DAY);

  const candidates: Array<{ n: number; binder: Binder; because: string }> = [];
  if (rule.max_per_day !== undefined) {
    candidates.push({
      n: rule.max_per_day,
      binder: "your_grant",
      because: `you allowed at most ${rule.max_per_day} of these a day`,
    });
  }
  // Only a dial the founder ACTUALLY SET is attributed to them. `sanitisePolicy` defaults this field
  // to the hard cap, so a policy that has it is a policy that chose it; a document without it is
  // held by the kernel's ceiling, and telling a founder "you allowed 20" when they allowed nothing
  // of the sort sends them looking for a setting they never wrote.
  if (policy.max_starts_per_day !== undefined) {
    candidates.push({
      n: projectDay,
      binder: "project_day",
      because: `this business may start ${projectDay} things on its own a day in total`,
    });
  }
  candidates.push({
    n: HARD_MAX_PER_DAY,
    binder: "kernel_day",
    because: `no business may start more than ${HARD_MAX_PER_DAY} things on its own a day, whatever you allow`,
  });
  candidates.push({
    n: rate,
    binder: "sweep_rate",
    because: rule.hours
      ? `it looks ${sweepsInWindow(rule)} times inside your ${rule.hours.from}:00–${rule.hours.to}:00 window and takes at most ${perSweep} each time`
      : `it looks every ${Math.round(SWEEP_SECONDS / 60)} minutes and takes at most ${perSweep} each time`,
  });

  // Order-stable minimum: the first candidate wins a tie, and the list is ordered most-actionable
  // first on purpose.
  let best = candidates[0]!;
  for (const c of candidates) if (c.n < best.n) best = c;
  return { value: best.n, unbounded: false, unknown: false, binder: best.binder, because: best.because };
}

// ── what a started run may then do, without asking ───────────────────────────────────────────────

/** One thing the envelope lets an unattended run do to a customer, and how much of it, a day. */
export interface ActionExposure {
  /** The connector action, verbatim from `wedge.json`. Not classified, not prettified — see below. */
  action: string;
  wedge: string;
  /** Auto-approvals of this action inside one run. Absent means the envelope names no per-run cap. */
  per_run?: number;
  /** Auto-approvals of this action per project per day, across ALL runs, not just autonomous ones. */
  per_day?: number;
  /** Only auto-approved when the payload's amount is at or under this. Absent means no money cap. */
  max_amount_usd?: number;
  ceiling: Ceiling;
}

/**
 * Compose ONE envelope rule against the number of runs that may start.
 *
 * ═══ WHERE THE BINDING NUMBER COMES FROM ═══
 *
 *   starts × per_run   — what autonomy lets through the envelope's per-run cap
 *   per_day            — what the envelope lets through regardless of who started the run
 *   the answer         — the SMALLER of the two
 *
 * Either can bind and which one does is the useful fact. Three starts a day of a run that may send
 * three each is nine — bound by the grant, not by the envelope's 50. Twenty starts of a run with no
 * per-run cap is bound by the envelope's day cap alone.
 *
 * A rule with NEITHER cap is genuinely unbounded within a run, and says so. That is not a
 * theoretical shape: `evaluatePolicy` consults the counter store only when a rule declares a
 * ceiling, so such a rule auto-approves every matching action a run attempts, for ever.
 */
export function composeAction(rule: PolicyRule, wedge: string, starts: Ceiling): ActionExposure {
  const base: Omit<ActionExposure, "ceiling"> = {
    action: rule.action,
    wedge,
    per_run: rule.max_per_task,
    per_day: rule.max_per_day,
    max_amount_usd: rule.max_amount_usd,
  };
  if (starts.unknown) {
    return { ...base, ceiling: unknownCeiling("we cannot tell how many runs may start on their own") };
  }
  const startCount = starts.value ?? 0;
  if (startCount === 0) return { ...base, ceiling: NONE };

  const fromRuns = rule.max_per_task === undefined ? Infinity : startCount * rule.max_per_task;
  const fromDay = rule.max_per_day ?? Infinity;

  if (fromRuns === Infinity && fromDay === Infinity) {
    return {
      ...base,
      ceiling: {
        unbounded: true,
        unknown: false,
        binder: "envelope_per_run",
        because: `the ${wedge} envelope puts no ceiling at all on "${rule.action}" — it auto-approves every one a run attempts`,
      },
    };
  }

  const value = Math.min(fromRuns, fromDay);
  let binder: Binder;
  let because: string;
  if (fromRuns === fromDay) {
    binder = "both";
    because = `${startCount} starts × ${rule.max_per_task} per run is exactly the ${rule.max_per_day} a day the ${wedge} envelope allows — both bind`;
  } else if (fromRuns < fromDay) {
    binder = "envelope_per_run";
    because =
      `${starts.because}, and the ${wedge} envelope auto-approves ${rule.max_per_task} "${rule.action}" per run` +
      (fromDay === Infinity ? "" : ` — tighter than the ${rule.max_per_day} a day that envelope also allows`);
  } else {
    binder = "envelope_per_day";
    because =
      `the ${wedge} envelope auto-approves ${rule.max_per_day} "${rule.action}" a day across this whole business` +
      (fromRuns === Infinity
        ? ` and puts no per-run ceiling on it`
        : ` — tighter than the ${fromRuns} that ${startCount} starts × ${rule.max_per_task} per run would reach`);
  }
  return { ...base, ceiling: { value, unbounded: false, unknown: false, binder, because } };
}

// ── one kind of move, composed ───────────────────────────────────────────────────────────────────

export interface KindExposure {
  kind: MoveKind;
  /** Whether the founder has granted standing permission to START this kind. */
  granted: boolean;
  /** The wedges whose envelopes could apply. More than one when the carrier depends on the case. */
  carriers: string[];
  starts: Ceiling;
  envelopes: EnvelopeStatus[];
  /** Every auto-approvable action reachable unattended through this kind, worst carrier first. */
  actions: ActionExposure[];
  /**
   * THE SENTENCE. What a founder reads at the moment they press "Let it run".
   *
   * One paragraph, naming: how many runs may start, which rule caps that, what those runs may then
   * send without asking, and which of the two policies is the binding one. Assembled in the kernel
   * and not in the browser, because the surface holding its own copy of this arithmetic is how it
   * comes to disagree with the gate that actually runs.
   */
  sentence: string;
  /**
   * WHAT PRESSING "Let it run" WOULD AUTHORISE. Present only while the kind is NOT granted.
   *
   * The brief for this module is that the composed consequence belongs at the moment of granting,
   * and a sentence that only appears AFTER the grant is a receipt, not a decision aid. The founder
   * about to press the button is the one who has forgotten the connector envelope they approved
   * weeks ago, so the envelope's number has to be on screen BEFORE the press.
   *
   * Computed against a bare rule — `{ kind }`, no ceiling of its own — because that is exactly what
   * the button sends: `toggle()` in the surface appends `{ kind }` and nothing else. So this is not
   * an estimate of a hypothetical policy, it is the arithmetic over the policy that would exist.
   */
  if_granted?: { starts: Ceiling; actions: ActionExposure[]; sentence: string };
}

const KIND_NOUN: Record<MoveKind, string> = {
  chase_invoice: "chase an overdue invoice",
  nudge_client_request: "remind a client about something we asked for",
  advance_case: "push an engagement forward",
  check_in_case: "check in on a quiet engagement",
  gtm_next_touch: "send the next outreach touch",
  // Phrased as the decision it is, not as an action. Standing permission for this one would mean
  // granting an agent the right to close or re-scope an engagement whose client stopped answering,
  // and a founder reading the exposure sentence should feel exactly how large that is.
  unblock_wait: "decide what happens to an engagement whose wait gave up",
  // Phrased as the noticing it is. There is nothing to grant here — the move is permanently not
  // takeable (see `takeability`) — but the vocabulary is closed and every kind must have a sentence,
  // and an honest one is better than a placeholder that reads like a feature.
  invoice_accepted_work: "point out work a client accepted that has not been invoiced",
  release_deliverable: "point out finished work waiting to be sent to a client",
  // Phrased as PUBLISHING, not as writing, because that is what the carrier actually does — a
  // product-builder run deploys the page it wrote. A founder reading an exposure sentence about
  // "rewrite the losing marketing headline" would picture a draft; the thing they would be granting
  // is a live change to their front door. `takeability` refuses this kind outright, so no grant can
  // ever bind here today, and the noun is written for the day somebody wonders why not.
  rewrite_losing_arm: "rewrite and publish the losing headline on the marketing site",
};

function daysClause(rule: AutonomyRule): string {
  const NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  if (!rule.days || rule.days.length === 7) return "";
  return `, on ${rule.days.map((d) => NAMES[d] ?? String(d)).join(", ")} only`;
}

export function composeKind(args: {
  kind: MoveKind;
  policy?: AutonomyPolicy;
  policyUnreadable?: string;
  projectWedges: readonly string[];
  load?: typeof loadWedge;
}): KindExposure {
  const { kind } = args;
  const carriers = carriersFor(kind, args.projectWedges);
  const envelopes = carriers.map((w) => readEnvelope(w, args.load));

  // ── the initiative half ──
  let starts: Ceiling;
  let rule: AutonomyRule | undefined;
  if (args.policyUnreadable) {
    starts = unknownCeiling(`we could not read this business's standing permissions: ${args.policyUnreadable}`);
  } else if (!args.policy || args.policy.paused) {
    // A PAUSED policy is deliberately reported as zero and not as "not granted": the grant is still
    // there and un-pausing restores it, so the surface has to be able to say "0 today, and here is
    // what comes back the moment you turn it on".
    starts = args.policy?.paused
      ? { value: 0, unbounded: false, unknown: false, binder: "nothing_granted", because: "autonomy is paused for this business" }
      : NONE;
    rule = (args.policy?.allow ?? []).find((r) => r.kind === kind);
  } else {
    rule = (args.policy.allow ?? []).find((r) => r.kind === kind);
    starts = rule ? startsPerDay(args.policy, rule) : NONE;
  }
  const granted = !!rule;

  // ── the consequence half ──
  const actions: ActionExposure[] = [];
  for (const env of envelopes) {
    if (env.status !== "envelope") continue;
    for (const r of env.rules) actions.push(composeAction(r, env.wedge, starts));
  }
  // Worst first: unknown, then unbounded, then descending. A founder scanning one line should meet
  // the biggest number, not the alphabetically first action.
  actions.sort((a, b) => rankCeiling(b.ceiling) - rankCeiling(a.ceiling));

  const exposure: KindExposure = {
    kind,
    granted,
    carriers,
    starts,
    envelopes,
    actions,
    sentence: sentenceFor(kind, granted, rule, starts, envelopes, actions),
  };

  // The preview, for the button that is not pressed yet. Skipped when the policy is unreadable —
  // "here is what granting would do" computed from a policy we could not read would be a confident
  // number invented during an outage, which is the one thing this module refuses to produce.
  if (!granted && !args.policyUnreadable) {
    const asIf: AutonomyRule = { kind };
    // Against the policy as it is, INCLUDING its paused flag and its project-wide ceiling — pressing
    // the button while paused authorises nothing today, and the preview should say the same thing
    // the row will say a second later.
    const base = args.policy ?? { v: 1 as const, allow: [] };
    const wouldStart = base.paused
      ? { value: 0, unbounded: false, unknown: false, binder: "nothing_granted" as const, because: "autonomy is paused for this business" }
      : startsPerDay(base, asIf);
    const wouldDo: ActionExposure[] = [];
    for (const env of envelopes) {
      if (env.status !== "envelope") continue;
      for (const r of env.rules) wouldDo.push(composeAction(r, env.wedge, wouldStart));
    }
    wouldDo.sort((a, b) => rankCeiling(b.ceiling) - rankCeiling(a.ceiling));
    exposure.if_granted = {
      starts: wouldStart,
      actions: wouldDo,
      sentence: sentenceFor(kind, true, asIf, wouldStart, envelopes, wouldDo),
    };
  }

  return exposure;
}

/** Sortable severity. Unknown outranks unbounded outranks a number, because that is the reading order. */
function rankCeiling(c: Ceiling): number {
  if (c.unknown) return Number.MAX_SAFE_INTEGER;
  if (c.unbounded) return Number.MAX_SAFE_INTEGER - 1;
  return c.value ?? 0;
}

function sentenceFor(
  kind: MoveKind,
  granted: boolean,
  rule: AutonomyRule | undefined,
  starts: Ceiling,
  envelopes: EnvelopeStatus[],
  actions: ActionExposure[],
): string {
  const noun = KIND_NOUN[kind];

  if (starts.unknown) {
    return `We cannot tell you what this can do unattended — ${starts.because}. Treat this as unknown, not as nothing.`;
  }
  if (!granted) {
    return `Nothing. It will propose a ${noun} and wait for you.`;
  }
  if ((starts.value ?? 0) === 0) {
    return `Nothing right now — ${starts.because}. What you granted is kept, and comes back when you turn it on.`;
  }

  const head = `It can start up to ${starts.value} runs a day on its own to ${noun}${rule ? daysClause(rule) : ""}, because ${starts.because}.`;

  // The envelope is the half a founder has forgotten, so it is stated even when it is empty — "and
  // it cannot send anything" is the reassuring sentence, and it has to be EARNED by an actual read
  // rather than implied by the absence of a paragraph.
  const unreadable = envelopes.filter((e) => e.status === "unreadable");
  if (unreadable.length) {
    return `${head} We could not read the ${unreadable.map((e) => (e as { wedge: string }).wedge).join(", ")} envelope, so we cannot tell you what those runs may send without asking. Treat that as unknown, not as none.`;
  }

  if (!actions.length) {
    const missing = envelopes.filter((e) => e.status === "missing");
    if (missing.length === envelopes.length && envelopes.length > 0) {
      return `${head} No wedge on this kernel carries it, so in practice nothing runs.`;
    }
    return `${head} Nothing those runs draft can go out without you: no connector envelope auto-approves anything, so every send stops at Approvals.`;
  }

  const worst = actions[0]!;
  const tail = worst.ceiling.unknown
    ? `We cannot tell what those runs may then send — ${worst.ceiling.because}.`
    : worst.ceiling.unbounded
      ? `Those runs can then auto-send "${worst.action}" without asking you, with no ceiling at all — ${worst.ceiling.because}.`
      : `Those runs can then auto-send up to ${worst.ceiling.value} "${worst.action}" a day without asking you, because ${worst.ceiling.because}.`;
  const more =
    actions.length > 1
      ? ` They may also auto-approve ${actions.slice(1).map((a) => `"${a.action}"`).join(", ")}.`
      : "";
  return `${head} ${tail}${more}`;
}

// ── the whole business ───────────────────────────────────────────────────────────────────────────

export interface WorstCase {
  /** Customer-visible auto-approved actions a day, if everything permitted fired at its limit. */
  actions: Ceiling;
  /** Runs a day that may start with nobody watching. */
  starts: Ceiling;
  /** The paragraph. What is in the number and, just as importantly, what is not. */
  sentence: string;
  /** Limits folded into the number above. Stated so the founder can check our arithmetic. */
  included: string[];
  /** Limits that further constrain reality and are NOT in the number. Stated so it is not a lie. */
  excluded: string[];
}

export interface ExposureView {
  project_id: string;
  /** The kill switch, mirrored here so the surface showing the exposure can also stop it. */
  paused: boolean;
  /** `false` when a policy could not be read. The surface MUST say so rather than render blank. */
  readable: boolean;
  /** Every reason the answer is incomplete, in the founder's words. Empty on a healthy read. */
  unknowns: string[];
  kinds: KindExposure[];
  worst_case: WorstCase;
}

/**
 * PURE. Everything above assembled, with no store and no clock.
 *
 * Pure because "does the composed view grant anything" must be answerable by inspection, and a
 * function that cannot reach a store cannot write to one. `exposureView` below is the four lines of
 * I/O that feed it.
 */
export function composeExposure(args: {
  project_id: string;
  policy?: AutonomyPolicy;
  policyUnreadable?: string;
  projectWedges: readonly string[];
  load?: typeof loadWedge;
}): ExposureView {
  if (!args.project_id) throw new Error("an exposure view must be scoped to a project");

  const kinds = MOVE_KINDS.map((kind) =>
    composeKind({
      kind,
      policy: args.policy,
      policyUnreadable: args.policyUnreadable,
      projectWedges: args.projectWedges,
      load: args.load,
    }),
  );

  const unknowns: string[] = [];
  if (args.policyUnreadable) unknowns.push(`Standing permissions could not be read: ${args.policyUnreadable}.`);
  for (const k of kinds) {
    for (const e of k.envelopes) {
      if (e.status === "unreadable") {
        const line = `The ${e.wedge} connector envelope could not be read: ${e.why}.`;
        if (!unknowns.includes(line)) unknowns.push(line);
      }
    }
  }

  return {
    project_id: args.project_id,
    paused: args.policy?.paused === true,
    readable: unknowns.length === 0,
    unknowns,
    kinds,
    worst_case: worstCase(kinds, unknowns.length > 0),
  };
}

/**
 * ═══ THE CEILING, NOT THE AVERAGE ═══
 *
 * If every permission fired at its limit for one day, what would a customer see? That is the number
 * a founder can accept or turn down; an expected value is a number they cannot act on.
 *
 * ═══ WHAT IS IN IT ═══
 *
 * Both policies, in full: per-kind autonomy grants, the project's own daily cap, the kernel's hard
 * caps (5/sweep, 20/day), the sweep cadence narrowed by any hours window, the kill switch, and every
 * connector envelope rule reachable from a granted kind (`max_per_task` × starts, and `max_per_day`).
 *
 * ═══ WHAT IS DELIBERATELY NOT IN IT, AND WHY ═══
 *
 * Every exclusion below makes the number BIGGER than reality. That direction is chosen on purpose:
 * a worst case that assumed away a guard would be negligent, and each of these guards depends on
 * facts (how many invoices are overdue, how old a LinkedIn account is) that are not policy and that
 * change hourly. They are listed to the founder rather than silently applied, so the number is
 * honest about being an over-estimate:
 *
 *   · THE DUNNING LADDER. One invoice is chased at most once every 3/5/7 days
 *     (`chaseIntervalDays`), with a hard floor of 2 (`MIN_CHASE_INTERVAL_DAYS`). So N chases in a
 *     day need N DISTINCT overdue invoices; a business with three overdue invoices cannot reach 20.
 *   · NUDGE CAPS. `MAX_NUDGES = 3` is a lifetime cap per client request, with `MIN_NUDGE_INTERVAL_DAYS`
 *     between them. A single client cannot be nudged repeatedly no matter what is granted.
 *   · CONNECTION PACING (`pacing.ts`). Per-connection rolling budgets, an account-age ramp, an
 *     engagement multiplier, a Mon–Fri 08:00–19:00 sending window and a 45-second floor between
 *     touches. All per CONNECTION, none per project, so none of it can be folded into a project
 *     number without knowing which connection each run would use.
 *   · THE REJECTION STAND-DOWN. A kind rejected in a third of recent takes stops running on its own
 *     (`REJECTION_STANDDOWN`). It depends on history, not on policy, and it can lift again.
 *   · WHETHER THERE IS ANY WORK AT ALL. The ceiling assumes the business always has something to do.
 *
 * ═══ AND WHAT THIS NUMBER IS NOT ═══
 *
 * It is not the total the business can send unattended. The scheduled sweeps — dunning hourly, GTM
 * every 5 minutes, nudges every 4 hours — start runs without a founder too, and they never consult
 * `autonomy.ts`. They pass through the SAME connector envelope, so the envelope's `max_per_day` is
 * a shared ceiling rather than an additional one; what autonomy adds is more runs competing for it.
 * `excluded` says this out loud.
 */
function worstCase(kinds: KindExposure[], anyUnknown: boolean): WorstCase {
  const included = [
    "your standing permissions, and the kernel's hard caps of 5 starts a sweep and 20 a day",
    "any hours window you set, which removes sweeps from the day",
    "every connector envelope that auto-approves an action, per run and per day",
  ];
  const excluded = [
    "the dunning ladder — one invoice is chased at most once every 3–7 days, so reaching this number needs that many different overdue invoices",
    "nudge caps — a client request is chased at most 3 times, ever",
    "connection pacing — per-connection budgets, an account-age ramp and a Mon–Fri 08:00–19:00 sending window, none of which is a per-business number",
    "whether the business has that much work to do at all",
    "runs the scheduled sweeps start on their own, which never ask autonomy but do share the same connector envelopes",
  ];

  let starts = 0;
  let actions = 0;
  let unbounded = false;
  const drivers: string[] = [];

  for (const k of kinds) {
    if (k.starts.unknown) continue;
    starts += k.starts.value ?? 0;
    for (const a of k.actions) {
      if (a.ceiling.unknown) continue;
      if (a.ceiling.unbounded) {
        unbounded = true;
        drivers.push(`"${a.action}" with no ceiling at all`);
        continue;
      }
      if ((a.ceiling.value ?? 0) > 0) {
        actions += a.ceiling.value ?? 0;
        drivers.push(`${a.ceiling.value} × "${a.action}"`);
      }
    }
  }

  const startsCeiling: Ceiling = anyUnknown
    ? unknownCeiling("some of your permissions could not be read")
    : { value: starts, unbounded: false, unknown: false, binder: "project_day", because: "summed across every kind you granted" };

  const actionsCeiling: Ceiling = anyUnknown
    ? unknownCeiling("some of your permissions could not be read")
    : unbounded
      ? { unbounded: true, unknown: false, binder: "envelope_per_run", because: "at least one envelope names no ceiling" }
      : { value: actions, unbounded: false, unknown: false, binder: "envelope_per_day", because: "summed across every auto-approved action" };

  let sentence: string;
  if (anyUnknown) {
    sentence =
      "We cannot tell you the worst case, because at least one of your policies could not be read. " +
      "That is not the same as nothing — assume it is not zero until this reads clean.";
  } else if (unbounded) {
    sentence = `On its worst day this business could start ${starts} runs without you, and at least one of them could send without limit: ${drivers.join(", ")}. That is not a bound anybody set — it is a missing ceiling.`;
  } else if (starts === 0) {
    sentence =
      "Nothing can happen without you. Nothing starts on its own, and nothing goes out without an approval.";
  } else if (actions === 0) {
    sentence = `On its worst day this business could start ${starts} runs without you — and send nothing. Every one of them drafts and stops at Approvals.`;
  } else {
    sentence = `On its worst day this business could start ${starts} runs without you and reach your customers ${actions} times with nobody looking: ${drivers.join(", ")}.`;
  }

  return { actions: actionsCeiling, starts: startsCeiling, sentence, included, excluded };
}

/**
 * The composed view for one project. FOUR lines of I/O and not one write.
 *
 * `MoveAuthority` rather than a bare project id, deliberately: it is unforgeable outside `moves.ts`,
 * it carries the tenant as a required field, and its `wedges` set is DERIVED from what the business
 * is actually running rather than from a caller. Two cross-tenant leaks have shipped in this
 * codebase and both were a scope a caller supplied.
 */
export async function exposureView(domain: DomainStore, auth: MoveAuthority): Promise<ExposureView> {
  const state = await readAutonomyPolicy(domain, auth.project_id);
  return composeExposure({
    project_id: auth.project_id,
    policy: state.status === "granted" ? state.policy : undefined,
    policyUnreadable: state.status === "unreadable" ? state.why : undefined,
    projectWedges: auth.wedges,
  });
}
