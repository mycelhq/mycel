// THE RETAINER ENGINE — recurring revenue, with double-billing made structurally impossible.
//
// ═══ THE GAP THIS CLOSES ═══
//
// The founder's promise is "we do the fulfilment AND retainers". Recurring revenue was half the
// pitch and none of the code: `"retainer"` was a string in a union type (`MoneyPlanLineKind`), a
// retainer line had no cadence and no next-due, its status was a one-way ratchet
// (`draftInvoiceFromPlanLine` throws unless the line is `planned`), and NO SCHEDULER BRANCH EVER
// CREATED AN INVOICE. A monthly retainer billed exactly once, ever — and the "once" happened by
// accident, because deliverable acceptance used to fall back to the first planned line in ARRAY
// ORDER, so accepting any piece of work billed an arbitrary month.
//
// ═══ THE ONE BUG THAT MATTERS, AND HOW IT IS MADE IMPOSSIBLE ═══
//
// Every other bug in this file's neighbourhood costs a founder some annoyance. THIS one charges a
// real client twice, and it is the kind of bug that compounds silently: a duplicate March invoice is
// discovered in April, by the client, usually by their accountant.
//
// So idempotency is not a check in this module. It is a UNIQUE INDEX:
//
//     UNIQUE (project_id, case_id, line_id, period_key)      -- billing.pg.ts
//
// `period_key` is the period's START DATE, and it is a PURE FUNCTION of the line's recurrence
// (`anchor`, `every`, `interval`, `first_period_ends`). Nothing about it depends on when the sweep
// ran, how many replicas are up, whether the process restarted, or what order rows come back in. So
// the second attempt at March — from a second replica in the same second, from a re-run after a
// crash, from a founder clicking a button, from a schedule that fired twice — presents the SAME KEY
// and loses the insert. `claimRetainerPeriod` returns `{ claimed: false }` and this module draws no
// invoice. There is no ordering of events in which one period is billed twice, and no "if we already
// billed" read for a race to slip between.
//
// The mirror-image failure — a period claimed and then NOT billed, because the draft threw — is
// handled by `releaseRetainerPeriod`, a compare-and-set that only gives the claim back while
// `invoice_id IS NULL` and the claim stamp still matches. A claim is a loan taken to serialise
// replicas, not a record that a client was billed; the same argument `releaseInvoiceChaseClaim`
// makes one file over.
//
// ═══ WHAT FIRES IT ═══
//
// A `Schedule` of task type `bill_retainers`, created by `ensureUpkeep` for any project that has a
// live retainer, claimed by the scheduler's tick (`FOR UPDATE SKIP LOCKED`) and dispatched by
// `fireSchedule` as HARNESS WORK — no model call. Deciding which months are due is arithmetic over
// stored rows, and an LLM asked to do arithmetic over a billing calendar will eventually bill
// February twice. This is the same shape as the dunning sweep and the autonomy sweep, deliberately.
//
// A sweep with no clock is this repo's signature bug (see upkeep.ts), so the schedule is derived
// from what the project actually does — a case whose money plan carries an active retainer — rather
// than from a blueprint somebody may or may not have provisioned.
//
// ═══ NOTHING SENDS ═══
//
// A period produces a DRAFT invoice. Drafts reach nobody. Issuing one is `POST
// /v1/invoices/:id/status {to:"sent"}`, which a human clicks (or a standing approval covers), and
// which now actually sends. A recurring invoice landing in a client's inbox every month with no
// human in the loop is exactly where a silent bug compounds twelve times before anyone notices.
//
// ═══ MONEY ═══
//
// Integer minor units throughout. Nothing here divides by 100, nothing converts currency: the
// invoice takes the money plan's own currency, and a plan has exactly one.
import type { Case, Invoice, InvoiceLine } from "./contract";
import { randomUUID } from "node:crypto";
import type { DomainStore } from "./domain";
import type { Schedule } from "./contract";
import { getBillingStore, normalizeLines, type NewInvoice } from "./billing";
import {
  readMoneyPlan,
  writeMoneyPlan,
  type MoneyPlan,
  type MoneyPlanLine,
  type RetainerRecurrence,
  type RetainerState,
} from "./money-plan";

/** The `Schedule.task_type` the scheduler branches on. Not a wedge task type — nothing runs a model. */
export const RETAINER_SWEEP_TASK_TYPE = "bill_retainers";

/**
 * How often the sweep looks. Six-hourly, not hourly and not daily.
 *
 * A retainer period is a month or a week, so responsiveness costs nothing and buys the property that
 * a founder who starts a retainer this morning sees its first draft the same working day rather than
 * tomorrow. It cannot make billing more AGGRESSIVE: the periods are fixed by the anchor, and a
 * period that is already claimed is refused by the index however often we look.
 */
export const SWEEP_SECONDS = 6 * 3600;

/** Invoices one sweep will draft, across the whole project. A ceiling, like every other sweep's. */
export const BATCH = 25;

/**
 * How far back a sweep will catch up.
 *
 * The kernel being down for a week must not cost the founder a month's revenue, so missed periods
 * ARE billed. But a project restored from a stale backup, or a retainer whose anchor a founder typed
 * as 2019, must not fire eleven invoices into one client's inbox at once. Three is the compromise
 * and it is stated rather than implied: up to three periods are caught up per line; anything older
 * is reported by name in the summary as needing a hand-raised invoice. Reported — never dropped
 * silently, which would be this repo's recurring bug wearing a billing hat.
 */
export const MAX_CATCHUP_PERIODS = 3;

/** Days a period covers, and what it is worth. All integers. */
export interface RetainerPeriod {
  /** Period start, YYYY-MM-DD. THE IDEMPOTENCY KEY. Pure function of the recurrence. */
  start: string;
  /** Exclusive end, YYYY-MM-DD. The next period's start. */
  end: string;
  /** Days this period actually covers. */
  days: number;
  /** Days a full period of this cadence would cover, starting here. */
  natural_days: number;
  /** True when `days < natural_days` — the aligned first period. */
  prorated: boolean;
}

const DAY = 86_400_000;

function parseDay(d: string): number {
  return Date.parse(`${d}T00:00:00Z`);
}

function toDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Add one period to a start date. Pure, UTC, no clock read.
 *
 * MONTHS CLAMP to the last day of the target month, exactly as `nextRun` does for a monthly cadence:
 * a retainer anchored on the 31st bills on the 28th in February and on the 31st again in March. The
 * alternative — rolling into the 1st or 2nd of the next month — makes the anchor drift, and an
 * anchor that drifts changes the period keys, which is the one thing the whole idempotency argument
 * rests on never happening.
 */
export function addPeriod(start: string, rec: Pick<RetainerRecurrence, "every" | "interval">): string {
  const ms = parseDay(start);
  if (!Number.isFinite(ms)) return start;
  const interval = Math.max(1, Math.trunc(rec.interval) || 1);
  if (rec.every === "week") return toDay(ms + interval * 7 * DAY);
  const d = new Date(ms);
  const anchorDay = d.getUTCDate();
  const targetMonth = d.getUTCMonth() + interval;
  const year = d.getUTCFullYear() + Math.floor(targetMonth / 12);
  const month = ((targetMonth % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return toDay(Date.UTC(year, month, Math.min(anchorDay, lastDay)));
}

/**
 * Pro-rata amount for a short period, in EXACT integer minor units.
 *
 * ═══ WHY IT IS WRITTEN LIKE THIS ═══
 *
 * `Math.round(amount * days / total)` is the obvious version and it is a float division: for the
 * amounts a service business bills it is right, and "right for the amounts we have seen" is how a
 * half-penny goes missing on the invoice that finally has eight figures on it. Here `amount * days`
 * is an exact integer under 2^53 for any realistic retainer (a £10m monthly retainer over 31 days is
 * 3.1e10), the quotient and remainder are computed exactly, and the half-up rounding is a comparison
 * of two integers. Nothing divides by 100 and nothing produces a float.
 *
 * Rounds HALF UP, in the client's favour never being the rule — it is the founder's revenue, and a
 * consistent rule matters more than its direction. A prorated period never exceeds a full one.
 */
export function proratedAmount(amountMinor: number, days: number, naturalDays: number): number {
  const amount = Math.max(0, Math.trunc(amountMinor));
  const d = Math.max(0, Math.trunc(days));
  const total = Math.trunc(naturalDays);
  if (total <= 0) return amount;
  if (d >= total) return amount;
  const n = amount * d;
  const q = Math.floor(n / total);
  const r = n - q * total;
  return r * 2 >= total ? q + 1 : q;
}

/**
 * Every period of this retainer that is DUE on `today`, oldest first. Pure — no clock, no I/O.
 *
 * ═══ BILLED IN ADVANCE ═══
 *
 * A period becomes due when it STARTS, not when it ends. That is how retainers are actually sold —
 * you pay for the coming month — and it is the choice that makes `not_before` (see below) able to
 * mean something simple. Arrears billing would be the same function with `end <= today`.
 *
 * ═══ EVERY WAY A RETAINER STOPS, IN ONE PLACE ═══
 *
 *   · `state !== "active"` — paused or ended: nothing is due, full stop. Checked first, so a paused
 *     retainer costs one comparison and reads no rows.
 *   · `ended_at` — no period starting on or after it. Ending mid-period does NOT credit back the
 *     part already invoiced: a credit note is a different document with its own audit trail, and
 *     inventing one from a sweep would put money back into a client's account with nobody deciding
 *     to. The founder raises it by hand, and the retainer route says so.
 *   · `not_before` — no period starting before it. Written on RESUME, so un-pausing after three
 *     months never back-bills three months.
 *
 * The iteration is hard-bounded. A malformed anchor from 1970 with a weekly cadence is 2,900
 * periods; the bound turns that into a bad summary line rather than a hung sweep.
 */
export function retainerPeriodsDue(
  rec: RetainerRecurrence,
  today: string,
  limit = MAX_CATCHUP_PERIODS,
): RetainerPeriod[] {
  const due: RetainerPeriod[] = [];
  if (rec.state !== "active") return due;
  if (!Number.isFinite(parseDay(rec.anchor))) return due;

  let start = rec.anchor;
  let first = true;
  for (let guard = 0; guard < 5_000; guard++) {
    const natural = addPeriod(start, rec);
    const end = first && rec.first_period_ends && rec.first_period_ends > start ? rec.first_period_ends : natural;
    first = false;
    // Not started yet. Every later period starts later still, so this is the end of the walk.
    if (start > today) break;
    if (rec.ended_at && start >= rec.ended_at) break;
    if (!(rec.not_before && start < rec.not_before)) {
      const naturalDays = Math.round((parseDay(natural) - parseDay(start)) / DAY);
      const days = Math.round((parseDay(end) - parseDay(start)) / DAY);
      due.push({ start, end, days, natural_days: naturalDays, prorated: days < naturalDays });
    }
    if (end <= start) break; // malformed; refuse to loop rather than bill the same key forever
    start = end;
  }
  // Oldest first, but never more than the catch-up window — and the window is applied from the END
  // so that a long-dormant retainer bills the CURRENT month rather than one from last spring.
  return due.slice(Math.max(0, due.length - Math.max(1, limit)));
}

/** The next period start after `today`, for display. Undefined when the retainer will never bill again. */
export function nextRetainerDue(rec: RetainerRecurrence, today: string): string | undefined {
  if (rec.state !== "active") return undefined;
  let start = rec.anchor;
  let first = true;
  for (let guard = 0; guard < 5_000; guard++) {
    const natural = addPeriod(start, rec);
    const end = first && rec.first_period_ends && rec.first_period_ends > start ? rec.first_period_ends : natural;
    first = false;
    if (rec.ended_at && start >= rec.ended_at) return undefined;
    if (start > today && !(rec.not_before && start < rec.not_before)) return start;
    if (end <= start) return undefined;
    start = end;
  }
  return undefined;
}

/** Retainer lines on a plan that actually recur. */
export function retainerLines(plan: MoneyPlan): MoneyPlanLine[] {
  return plan.lines.filter((l) => l.kind === "retainer" && !!l.recurrence);
}

/** Why one period was not billed. Machine codes so a summary can say something true. */
export type RetainerRefusal =
  | "already_billed"
  | "no_price"
  | "case_closed"
  | "not_active"
  | "draft_failed";

export type RetainerBill =
  | { ok: true; invoice: Invoice; period: RetainerPeriod; amount_minor: number }
  | { ok: false; reason: RetainerRefusal; message: string };

/**
 * Bill ONE period of ONE retainer line. The single implementation, and the only door.
 *
 * The claim comes FIRST — before the draft, before any read that could be raced — because the claim
 * is the thing that decides, and every check above a claim is advisory. `already_billed` is a
 * SUCCESS of the mechanism, not an error, and is reported as such by every caller.
 *
 * `project_id` comes off the CASE, never off an argument a caller could get wrong: this writes an
 * invoice, and a defaulted or passed-in scope here is a demand for money landing in another tenant's
 * portal. Two cross-tenant leaks have shipped in this repo.
 */
export async function billRetainerPeriod(args: {
  domain: DomainStore;
  kase: Case;
  line: MoneyPlanLine;
  period: RetainerPeriod;
  now?: Date;
}): Promise<RetainerBill> {
  const { kase, line, period } = args;
  const now = args.now ?? new Date();
  if (!kase.project_id) throw new Error("billing a retainer must be scoped to a project");
  if (!kase.client_id) return { ok: false, reason: "case_closed", message: "this engagement has no client" };
  if (kase.status === "closed") {
    return { ok: false, reason: "case_closed", message: "this engagement is closed, so its retainer does not bill" };
  }
  const plan = readMoneyPlan(kase.data);
  if (!plan) return { ok: false, reason: "not_active", message: "this engagement has no money plan" };
  const live = plan.lines.find((l) => l.id === line.id);
  if (!live?.recurrence || live.recurrence.state !== "active") {
    return { ok: false, reason: "not_active", message: `“${line.label}” is not an active retainer` };
  }

  // Mid-cycle price changes take effect from the NEXT period, which is what re-reading the line here
  // gives you for free: a period already claimed has an invoice drawn at the price of the day it was
  // claimed, and repricing the line cannot reach back into it (invoice lines are edited on the
  // invoice, with its own audit trail). A period not yet claimed bills at today's price.
  const amount = live.recurrence && period.prorated
    ? proratedAmount(live.amount_minor, period.days, period.natural_days)
    : Math.max(0, Math.trunc(live.amount_minor));
  if (amount <= 0) {
    return {
      ok: false,
      reason: "no_price",
      message: `“${live.label}” has no amount set, so there is nothing to bill for ${period.start}`,
    };
  }

  const billing = getBillingStore();
  const claimedAt = now.toISOString();
  const claim = await billing.claimRetainerPeriod({
    project_id: kase.project_id,
    case_id: kase.id,
    line_id: live.id,
    period_key: period.start,
    period_end: period.end,
    amount_minor: amount,
    currency: plan.currency,
    claimed_at: claimedAt,
  });
  if (!claim.claimed) {
    return {
      ok: false,
      reason: "already_billed",
      message:
        `the period starting ${period.start} on “${live.label}” was already billed` +
        (claim.existing?.invoice_id ? ` (invoice ${claim.existing.invoice_id})` : " by another run"),
    };
  }

  try {
    const invoiceLine: InvoiceLine = {
      id: randomUUID(),
      // The client reads this. The dates are in it on purpose: "Retainer — 1 Mar to 31 Mar" is the
      // line that stops a support conversation about whether last month was billed twice.
      description: period.prorated
        ? `${live.label} — ${period.start} to ${period.end} (part period, ${period.days} of ${period.natural_days} days)`
        : `${live.label} — ${period.start} to ${period.end}`,
      quantity_milli: 1000,
      unit_amount: amount,
      kind: "fixed",
    };
    const draft: NewInvoice = {
      project_id: kase.project_id,
      client_id: kase.client_id,
      case_id: kase.id,
      currency: plan.currency,
      // ALWAYS a draft. See the header: a recurring invoice that reaches a client with no human in
      // the loop is where a silent bug compounds every month.
      status: "draft",
      issue_date: period.start,
      due_date: toDay(parseDay(period.start) + 14 * DAY),
      lines: normalizeLines([invoiceLine]),
      amount_paid: 0,
    };
    const invoice = await billing.createInvoice(draft);
    await billing.recordRetainerInvoice({
      project_id: kase.project_id,
      case_id: kase.id,
      line_id: live.id,
      period_key: period.start,
      invoice_id: invoice.id,
    });
    return { ok: true, invoice, period, amount_minor: amount };
  } catch (e) {
    // A claim held by a draft that never happened is a loan not repaid: the period would look billed
    // for ever and the founder would lose that month's revenue silently. The release is a
    // compare-and-set guarded on `invoice_id IS NULL` and on our own claim stamp, so it cannot undo
    // a period somebody else has since billed.
    const detail = (e as Error)?.message ?? String(e);
    console.error(`[mycel] retainer draft failed for ${kase.id}/${live.id} ${period.start}: ${detail}`);
    await billing
      .releaseRetainerPeriod({
        project_id: kase.project_id,
        case_id: kase.id,
        line_id: live.id,
        period_key: period.start,
        claimed_at: claimedAt,
      })
      .catch((err) => console.error("[mycel] could not release a retainer claim:", err));
    return { ok: false, reason: "draft_failed", message: `could not draft the invoice for ${period.start}: ${detail}` };
  }
}

export interface RetainerSweepSummary {
  project_id: string;
  /** Retainer lines looked at. */
  considered: number;
  /** Invoices drafted. */
  billed: number;
  /** Periods that were already on the ledger — the idempotency mechanism working, not a failure. */
  already_billed: number;
  /** Live retainers with no price set. Named, because the fix is one number the founder types. */
  no_price: number;
  /** Paused or ended retainers passed over. */
  stopped: number;
  /** Periods older than the catch-up window. Reported by name; see `skipped_because`. */
  too_old: number;
  /** Lines whose draft threw. The claim was given back; the next sweep retries. */
  failed: string[];
  /**
   * Why this sweep drafted nothing, when that is the case. Absent on a sweep that did work.
   *
   * A sweep returning all zeroes is indistinguishable from "every retainer is up to date", and this
   * repo's recurring bug is failing while reporting success. A founder whose retainer has no price,
   * or whose anchor is eleven months in the past, needs the sentence.
   */
  skipped_because?: string;
}

/**
 * Draft every retainer invoice this project is due, and say what it did not do.
 *
 * `project_id` is a required field of a required argument and there is no sweep-everything overload.
 * A defaulted scope here bills one tenant's clients for another tenant's retainer.
 */
export async function sweepRetainers(args: {
  domain: DomainStore;
  project_id: string;
  now?: Date;
}): Promise<RetainerSweepSummary> {
  const now = args.now ?? new Date();
  const today = now.toISOString().slice(0, 10);
  const summary: RetainerSweepSummary = {
    project_id: args.project_id,
    considered: 0,
    billed: 0,
    already_billed: 0,
    no_price: 0,
    stopped: 0,
    too_old: 0,
    failed: [],
  };
  if (!args.project_id) throw new Error("a retainer sweep must be scoped to a project");

  // Open engagements only. A closed case is a finished engagement and its retainer is over whatever
  // the line still says — a client who was offboarded in March must not receive an April invoice
  // because nobody remembered to end the line as well as close the case.
  const cases = (await args.domain.listCases({ project_id: args.project_id })).filter(
    (k) => k.status !== "closed",
  );
  const notices: string[] = [];

  for (const kase of cases) {
    if (summary.billed >= BATCH) break;
    const plan = readMoneyPlan(kase.data);
    if (!plan) continue;
    for (const line of retainerLines(plan)) {
      if (summary.billed >= BATCH) break;
      summary.considered++;
      const rec = line.recurrence!;
      if (rec.state !== "active") {
        summary.stopped++;
        continue;
      }
      // Unbounded first, so we can SAY how much history was skipped rather than silently dropping it.
      const all = retainerPeriodsDue(rec, today, 5_000);
      const window = all.slice(Math.max(0, all.length - MAX_CATCHUP_PERIODS));
      if (all.length > window.length) {
        summary.too_old += all.length - window.length;
        notices.push(
          `“${line.label}” has ${all.length - window.length} period(s) older than ${window[0]?.start ?? today} ` +
            `that this sweep will not raise on its own — invoice them by hand if they are still owed`,
        );
      }
      for (const period of window) {
        if (summary.billed >= BATCH) break;
        const out = await billRetainerPeriod({ domain: args.domain, kase, line, period, now });
        if (out.ok) {
          summary.billed++;
          continue;
        }
        if (out.reason === "already_billed") summary.already_billed++;
        else if (out.reason === "no_price") {
          summary.no_price++;
          notices.push(out.message);
        } else if (out.reason === "draft_failed") summary.failed.push(`${line.id}:${period.start}`);
        else summary.stopped++;
      }
    }
  }

  if (!summary.billed && notices.length) summary.skipped_because = notices.slice(0, 5).join("; ");
  return summary;
}

/**
 * Does this project have a retainer worth putting on a clock?
 *
 * Reads the same rows the sweep reads, for the reason upkeep.ts gives at length: a clock derived
 * from a flag somebody remembered to set is a clock that does not exist for everyone who forgot.
 * PAUSED AND ENDED RETAINERS STILL COUNT AS WANTED — a paused retainer is one click from being live
 * again, and tearing the schedule down on a pause and never rebuilding it is precisely how the
 * resumed retainer would then never bill.
 */
export async function projectHasRetainer(domain: DomainStore, projectId: string): Promise<boolean> {
  if (!projectId) throw new Error("this check must be scoped to a project");
  const cases = await domain.listCases({ project_id: projectId });
  for (const kase of cases) {
    if (kase.status === "closed") continue;
    const plan = readMoneyPlan(kase.data);
    if (plan && retainerLines(plan).length) return true;
  }
  return false;
}

/**
 * Create (or find) the retainer-billing Schedule for a project. One per project, idempotent.
 *
 * Throws on a missing project id rather than defaulting one, exactly like `ensureDunningSchedule`:
 * the failure mode of a defaulted scope here is an invoice raised against another tenant's client.
 *
 * `wedge` is a label on the schedule row, not a dispatch decision — `fireSchedule` branches on the
 * task type and runs no model — so this needs no role to be claimed and cannot be blocked by an
 * install that has no billing wedge. That is the whole point: recurring revenue must not depend on
 * which tile a founder clicked during onboarding.
 */
export async function ensureRetainerSchedule(
  domain: DomainStore,
  projectId: string,
  wedge: string,
  now: Date = new Date(),
): Promise<Schedule> {
  if (!projectId) throw new Error("a retainer schedule must be scoped to a project");
  const existing = (await domain.listSchedules()).find(
    (s) => s.project_id === projectId && s.task_type === RETAINER_SWEEP_TASK_TYPE,
  );
  if (existing) return existing;
  return domain.createSchedule({
    project_id: projectId,
    name: "retainer billing",
    wedge,
    task_type: RETAINER_SWEEP_TASK_TYPE,
    input: {},
    cadence: { kind: "every", seconds: SWEEP_SECONDS },
    enabled: true,
    next_run_at: new Date(now.getTime() + SWEEP_SECONDS * 1000).toISOString(),
  });
}

/**
 * Start, change, pause, resume or end a retainer on one money-plan line.
 *
 * ═══ WHY EVERY TRANSITION IS HERE AND NOT SPREAD OVER ROUTES ═══
 *
 * Pausing and resuming are not symmetric — resuming writes `not_before` so that the paused months
 * never arrive as a batch — and that asymmetry is exactly the sort of thing that survives in one
 * function and gets lost when a second caller reimplements "just set state back to active". There is
 * one implementation, and the route, the Cloud UI and any future agent move all call it.
 *
 * ENDING DOES NOT CREDIT. A period already invoiced stays invoiced; if the founder owes the client
 * money back, that is a credit note they raise deliberately. Reported in the returned `note` so the
 * decision is in front of them at the moment they end it, rather than discovered later.
 */
export async function setRetainer(args: {
  domain: DomainStore;
  kase: Case;
  line_id: string;
  patch: {
    state?: RetainerState;
    every?: "week" | "month";
    interval?: number;
    anchor?: string;
    first_period_ends?: string;
    amount_minor?: number;
  };
  today?: string;
}): Promise<{ plan: MoneyPlan; line: MoneyPlanLine; case: Case; note?: string }> {
  const today = args.today ?? new Date().toISOString().slice(0, 10);
  const plan = readMoneyPlan(args.kase.data);
  if (!plan) throw new Error("this engagement has no money plan");
  const line = plan.lines.find((l) => l.id === args.line_id);
  if (!line) throw new Error("that money-plan line is not on this engagement");
  if (line.kind !== "retainer") throw new Error("only a retainer line can recur");

  const prev = line.recurrence;
  const state = args.patch.state ?? prev?.state ?? "active";
  const anchor = args.patch.anchor ?? prev?.anchor ?? today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(anchor)) throw new Error("a retainer needs a start date as YYYY-MM-DD");
  if (prev && args.patch.anchor && args.patch.anchor !== prev.anchor) {
    // Moving the anchor moves every period key, which is the one input the idempotency ledger
    // depends on. Periods already billed under the old anchor keep their rows; the new anchor's keys
    // are simply different, so re-anchoring a running retainer CAN bill an overlapping month. Loud,
    // and refused for a retainer that has already billed — see the route, which checks the ledger.
    console.warn(`[mycel] retainer ${line.id} re-anchored ${prev.anchor} → ${args.patch.anchor}`);
  }

  let note: string | undefined;
  const recurrence: RetainerRecurrence = {
    every: args.patch.every ?? prev?.every ?? "month",
    interval: Math.min(24, Math.max(1, Math.trunc(args.patch.interval ?? prev?.interval ?? 1) || 1)),
    anchor,
    state,
    ...(args.patch.first_period_ends ?? prev?.first_period_ends
      ? { first_period_ends: args.patch.first_period_ends ?? prev?.first_period_ends! }
      : {}),
    ...(prev?.not_before ? { not_before: prev.not_before } : {}),
    ...(prev?.paused_at ? { paused_at: prev.paused_at } : {}),
    ...(prev?.ended_at ? { ended_at: prev.ended_at } : {}),
  };

  if (state === "paused" && prev?.state !== "paused") {
    recurrence.paused_at = today;
    note = "paused from today — no further invoices until you resume, and resuming will not bill the gap";
  }
  if (state === "active" && prev?.state === "paused") {
    // THE RESUME RULE. Periods that started while paused are gone for good, on purpose.
    recurrence.not_before = today;
    recurrence.paused_at = undefined;
    note = "resumed — billing restarts from today; the paused periods are not billed retrospectively";
  }
  if (state === "ended") {
    recurrence.ended_at = today;
    note =
      "ended from today — nothing further will be billed. Anything already invoiced stays invoiced; " +
      "if part of a paid-up period is owed back, raise a credit note yourself";
  }
  if (state === "active" && prev?.state === "ended") {
    // Restarting an ended retainer is legitimate (a client comes back) and must not silently
    // resurrect the months it was off.
    recurrence.ended_at = undefined;
    recurrence.not_before = today;
    note = "restarted — billing resumes from today";
  }

  const nextLines = plan.lines.map((l) =>
    l.id === line.id
      ? {
          ...l,
          amount_minor:
            args.patch.amount_minor === undefined
              ? l.amount_minor
              : Math.max(0, Math.trunc(args.patch.amount_minor)),
          recurrence,
        }
      : l,
  );
  const nextPlan: MoneyPlan = { ...plan, lines: nextLines };
  const updated = await args.domain.updateCase(
    args.kase.id,
    { data: writeMoneyPlan(args.kase.data ?? {}, nextPlan) },
    { at: new Date().toISOString(), kind: "note", note: `retainer “${line.label}” ${state}`, actor: "founder" },
  );
  if (!updated) throw new Error("could not update the engagement money plan");
  return { plan: nextPlan, line: nextLines.find((l) => l.id === line.id)!, case: updated, note };
}
