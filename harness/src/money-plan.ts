// Money plan on a Case — promise → deliverable → draft invoice without a leak.
//
// Stored on `Case.data.money_plan` (not a new noun). Acceptance is still the client's act; pricing
// is still the founder's. What this closes is the handoff gap: an accepted deliverable that nobody
// remembers to bill, and an invoice whose lines have no relation to what was promised at close.
import { randomUUID } from "node:crypto";
import type { Case, Deliverable, Invoice, InvoiceLine } from "./contract";
import { getBillingStore, normalizeLines, type NewInvoice } from "./billing";
import type { DomainStore } from "./domain";

export type MoneyPlanLineKind = "deposit" | "milestone" | "retainer" | "period";
export type MoneyPlanLineStatus = "planned" | "invoiced" | "paid" | "waived";

/** How often a retainer bills. `month` clamps (the 31st of a 30-day month is the 30th). */
export type RetainerInterval = "week" | "month";

/** Active bills, paused holds, ended never bills again. Only the founder moves this. */
export type RetainerState = "active" | "paused" | "ended";

/**
 * WHAT MAKES A RETAINER LINE RECUR — the thing this codebase did not have.
 *
 * ═══ THE FAILURE THIS EXISTS FOR ═══
 *
 * `"retainer"` was a string in a union type and nothing else. A retainer line had no cadence, no
 * anchor and no next-due, `draftInvoiceFromPlanLine` refused any line that was not `planned`, and the
 * only two callers of it were the one-time deposit and a deliverable acceptance. So a monthly
 * retainer billed EXACTLY ONCE, ever, and the founder's own pitch — "we do the fulfilment and
 * retainers" — was half untrue in the half that pays every month. `contract.ts` says recurrence
 * belongs on a Schedule rather than on an Invoice, and it is right; what was missing is the
 * description of the recurrence for the Schedule to read. This is that description.
 *
 * ═══ WHY THE STATE MACHINE IS ON THE LINE AND THE LEDGER IS NOT ═══
 *
 * Everything here is INTENT: what should bill, how often, from when, and whether it is currently
 * running. What has ALREADY BILLED is deliberately NOT here. A case row is a read-modify-write
 * through `updateCase` with no compare-and-set, so a "billed periods" array living on it would be
 * lost-update-prone in exactly the situation that matters — two replicas sweeping the same second —
 * and the loss would present as a second invoice to a real client. The ledger is a uniquely-indexed
 * table (`claimRetainerPeriod` in billing.ts), and the unique index is the whole safety property.
 *
 * ═══ EVERY DATE IS YYYY-MM-DD, UTC, AND COMPARED AS A STRING ═══
 *
 * The same decision `Invoice.issue_date` made and for the same reason: a `Date` here is one timezone
 * away from billing a client on the last day of the previous month.
 */
export interface RetainerRecurrence {
  every: RetainerInterval;
  /** How many `every` units per period. 1 = monthly; 3 = quarterly. Bounded 1..24. */
  interval: number;
  /**
   * The FIRST period's start date, and thereafter the origin every subsequent period is derived
   * from. Never mutated by billing — the period boundaries have to be a pure function of the plan,
   * or a restart computes different months from the ones already invoiced.
   */
  anchor: string;
  state: RetainerState;
  /**
   * Optional end of the FIRST period only, when the founder wants billing aligned to calendar
   * months but the engagement started on the 12th. The first period is then `[anchor,
   * first_period_ends)` and is billed PRO RATA by day count; every period after it is a natural
   * full one. See `proratedAmount` — the arithmetic is exact integer minor units.
   */
  first_period_ends?: string;
  /**
   * No period starting before this date is ever billed.
   *
   * Written when a paused retainer is RESUMED, and it is the whole of the "resume never back-bills"
   * decision. Without it, un-pausing a retainer that was paused for three months would find three
   * unbilled periods sitting in the past and send a client three invoices in one morning — which is
   * the single most expensive way this feature could be wrong.
   */
  not_before?: string;
  paused_at?: string;
  /** Periods starting on or after this date never bill. Ending mid-period does NOT credit back. */
  ended_at?: string;
}

export interface MoneyPlanLine {
  id: string;
  label: string;
  amount_minor: number;
  kind: MoneyPlanLineKind;
  status: MoneyPlanLineStatus;
  /** When this line is for a specific piece of finished work. */
  deliverable_id?: string;
  invoice_id?: string;
  /**
   * Present only on a `retainer` line, and its presence is what makes the line recurring. A retainer
   * line WITHOUT this bills like a one-off — which is what every retainer line in the database did
   * before this field existed, and is why absence has to stay legal rather than throwing.
   */
  recurrence?: RetainerRecurrence;
}

export interface MoneyPlan {
  currency: string;
  lines: MoneyPlanLine[];
}

const LINE_KINDS: readonly MoneyPlanLineKind[] = ["deposit", "milestone", "retainer", "period"];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Longest a retainer may go between invoices, as a multiple of its unit. Two years of weeks. */
const MAX_INTERVAL = 24;

/**
 * Parse recurrence off stored JSON, or return undefined.
 *
 * REFUSES rather than repairs when the anchor is missing or malformed, and that asymmetry with the
 * rest of this file (which defaults a bad `kind` to `milestone`) is deliberate. A defaulted label is
 * cosmetic; a defaulted anchor decides WHICH MONTHS GET BILLED. Silently anchoring a broken row to
 * today would make a retainer bill from today forward and quietly lose the periods before it — or,
 * worse on a re-parse after a deploy, move the boundaries under a ledger that has already claimed
 * them. Undefined here means "this line does not recur", which every caller handles, and the founder
 * sees a retainer that is not running rather than one that is running on invented dates.
 */
export function readRetainerRecurrence(raw: unknown): RetainerRecurrence | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const anchor = typeof o.anchor === "string" && DATE_RE.test(o.anchor) ? o.anchor : undefined;
  if (!anchor) return undefined;
  const every: RetainerInterval = o.every === "week" ? "week" : "month";
  const interval = Math.min(MAX_INTERVAL, Math.max(1, Math.trunc(Number(o.interval)) || 1));
  const state: RetainerState =
    o.state === "paused" ? "paused" : o.state === "ended" ? "ended" : "active";
  const date = (v: unknown): string | undefined =>
    typeof v === "string" && DATE_RE.test(v) ? v : undefined;
  const first = date(o.first_period_ends);
  return {
    every,
    interval,
    anchor,
    state,
    // A first period that ends at or before it starts is not a short period, it is a typo, and
    // honouring it would make `retainerPeriodsDue` loop on a zero-length period forever.
    ...(first && first > anchor ? { first_period_ends: first } : {}),
    ...(date(o.not_before) ? { not_before: date(o.not_before)! } : {}),
    ...(date(o.paused_at) ? { paused_at: date(o.paused_at)! } : {}),
    ...(date(o.ended_at) ? { ended_at: date(o.ended_at)! } : {}),
  };
}

export function readMoneyPlan(data: Record<string, unknown> | undefined): MoneyPlan | undefined {
  const raw = data?.money_plan;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const currency = typeof o.currency === "string" && o.currency.trim() ? o.currency.trim().toUpperCase() : "";
  if (!currency) return undefined;
  const linesIn = Array.isArray(o.lines) ? o.lines : [];
  const lines: MoneyPlanLine[] = [];
  for (const item of linesIn) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const l = item as Record<string, unknown>;
    const kind = LINE_KINDS.includes(l.kind as MoneyPlanLineKind) ? (l.kind as MoneyPlanLineKind) : "milestone";
    const amount = Math.trunc(Number(l.amount_minor));
    if (!Number.isFinite(amount) || amount < 0) continue;
    const label = String(l.label ?? "").trim().slice(0, 200);
    if (!label) continue;
    const status = (["planned", "invoiced", "paid", "waived"] as const).includes(l.status as MoneyPlanLineStatus)
      ? (l.status as MoneyPlanLineStatus)
      : "planned";
    lines.push({
      id: typeof l.id === "string" && l.id ? l.id : randomUUID(),
      label,
      amount_minor: amount,
      kind,
      status,
      deliverable_id: typeof l.deliverable_id === "string" ? l.deliverable_id : undefined,
      invoice_id: typeof l.invoice_id === "string" ? l.invoice_id : undefined,
      // Only a retainer line recurs. A `recurrence` block that has drifted onto a milestone is
      // dropped rather than honoured: the retainer sweep reads by kind, so an honoured one would be
      // an invisible field that bills nothing, and a dropped one is a founder re-stating the intent.
      ...(kind === "retainer" && readRetainerRecurrence(l.recurrence)
        ? { recurrence: readRetainerRecurrence(l.recurrence)! }
        : {}),
    });
  }
  return { currency, lines };
}

export function writeMoneyPlan(data: Record<string, unknown>, plan: MoneyPlan): Record<string, unknown> {
  return { ...data, money_plan: plan };
}

export type MoneyPlanTemplateLine = {
  label: string;
  amount_minor: number;
  kind: MoneyPlanLineKind;
  /** Present on a retainer that should actually recur. Copied through; never invented here. */
  recurrence?: RetainerRecurrence;
};

/** Build a fresh plan from a wedge template (or founder overrides). Zero-amount lines are kept —
 *  the founder fills them; dropping them would hide the promise. Retainer recurrence is copied
 *  when the template named it — kickoff stamps a monthly default when it did not. */
export function moneyPlanFromTemplate(
  currency: string,
  lines: MoneyPlanTemplateLine[],
): MoneyPlan {
  return {
    currency: currency.trim().toUpperCase() || "USD",
    lines: lines.map((l) => {
      const kind = LINE_KINDS.includes(l.kind) ? l.kind : "milestone";
      const recurrence = kind === "retainer" ? readRetainerRecurrence(l.recurrence) : undefined;
      return {
        id: randomUUID(),
        label: l.label.trim().slice(0, 200),
        amount_minor: Math.max(0, Math.trunc(l.amount_minor)),
        kind,
        status: "planned" as const,
        ...(recurrence ? { recurrence } : {}),
      };
    }),
  };
}

/**
 * What a kickoff retainer bills on when the wedge forgot to say.
 *
 * `readRetainerRecurrence` refuses a missing anchor rather than inventing one — correct for a
 * re-parse of a live ledger. Kickoff is the opposite moment: a NEW line, no periods claimed yet,
 * and a `kind: "retainer"` with no cadence is the bug that left books-keeper and geo-monitor
 * retainers billing once. Monthly, active, anchored today (UTC date).
 */
export function stampRetainerRecurrence(
  raw?: unknown,
  today = new Date().toISOString().slice(0, 10),
): RetainerRecurrence {
  const parsed = readRetainerRecurrence(raw);
  if (parsed) return parsed;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>;
    const filled = {
      every: o.every === "week" ? "week" : "month",
      interval: Number(o.interval) || 1,
      state: o.state === "paused" || o.state === "ended" ? o.state : "active",
      anchor:
        typeof o.anchor === "string" && DATE_RE.test(o.anchor) ? o.anchor : today,
      ...(typeof o.first_period_ends === "string" && DATE_RE.test(o.first_period_ends)
        ? { first_period_ends: o.first_period_ends }
        : {}),
    };
    return readRetainerRecurrence(filled) ?? { every: "month", interval: 1, anchor: today, state: "active" };
  }
  return { every: "month", interval: 1, anchor: today, state: "active" };
}

/**
 * Which plan line an accepted deliverable should bill — or a reason nobody can answer that.
 *
 * ═══ THE BUG THIS REPLACES ═══
 *
 * The previous version fell back to `plan.lines.find(first planned milestone/period/RETAINER)`. On a
 * plan with twelve monthly retainer lines, accepting ANY deliverable billed an arbitrary one — the
 * first in array order, which is a JSON serialisation detail and not a decision anybody made. The
 * client got an invoice labelled "March retainer" for a logo, and March later billed again.
 *
 * ═══ THE THREE RULES, IN ORDER ═══
 *
 *   1. A line explicitly linked to THIS deliverable wins. That is the founder having already said
 *      which promise this piece of work discharges, and it is the only unambiguous case.
 *   2. Otherwise, exactly ONE unlinked planned milestone/period line may be inferred. One candidate
 *      is not a guess, it is the only reading of the plan. Two or more is ambiguous and refused —
 *      the founder names the line (`line_id`) or raises the invoice by hand.
 *   3. A RETAINER LINE IS NEVER PICKED HERE, whatever the count. A retainer bills on its own clock
 *      (`money-plan.retainer.ts`); billing one because a deliverable was accepted double-bills that
 *      period the moment the sweep comes round, and it is the founder's recurring revenue that gets
 *      the duplicate.
 *
 * A refusal carries the sentence rather than a bare undefined — a route that answers "no line" and a
 * route that answers "four lines could be meant, pick one" send a founder to different screens.
 */
export type AcceptedLinePick =
  | { ok: true; line: MoneyPlanLine }
  | { ok: false; reason: "none" | "ambiguous"; message: string; candidates: MoneyPlanLine[] };

export function lineForAcceptedDeliverable(plan: MoneyPlan, deliverableId: string): AcceptedLinePick {
  const linked = plan.lines.find(
    (l) => l.status === "planned" && l.deliverable_id === deliverableId && l.amount_minor > 0,
  );
  if (linked) return { ok: true, line: linked };

  const candidates = plan.lines.filter(
    (l) =>
      l.status === "planned" &&
      l.amount_minor > 0 &&
      !l.deliverable_id &&
      (l.kind === "milestone" || l.kind === "period"),
  );
  if (candidates.length === 1) return { ok: true, line: candidates[0]! };
  if (candidates.length === 0) {
    return {
      ok: false,
      reason: "none",
      message:
        "no planned milestone with an amount is left on the money plan — set a price, link this work " +
        "to a line, or raise the invoice by hand",
      candidates,
    };
  }
  return {
    ok: false,
    reason: "ambiguous",
    message:
      `${candidates.length} planned lines could be meant by this work (${candidates
        .map((l) => `“${l.label}”`)
        .join(", ")}) — say which one, or raise the invoice by hand`,
    candidates,
  };
}

export function depositLine(plan: MoneyPlan): MoneyPlanLine | undefined {
  return plan.lines.find((l) => l.kind === "deposit" && l.status === "planned" && l.amount_minor > 0);
}

export type MoneyPlanEditLine = {
  id?: string;
  label: string;
  amount_minor: number;
  kind: MoneyPlanLineKind;
  /** Founder may set planned → waived; invoiced/paid are locked. */
  status?: MoneyPlanLineStatus;
  deliverable_id?: string;
  /**
   * Recurrence, when the editor knows about it. OMITTING IT PRESERVES WHAT IS THERE.
   *
   * That default is the important half. The money-plan editor in Cloud and the `PUT
   * /v1/cases/:id/money-plan` route both predate retainers and send no `recurrence` field; if
   * omission meant "clear", a founder renaming a line would silently switch off a live monthly
   * retainer and nothing anywhere would say so. To stop a retainer you end it — explicitly, through
   * the retainer route — which is a different sentence and a different click.
   */
  recurrence?: unknown;
};

/**
 * Founder editor save — replace the plan while refusing to rewrite history.
 *
 * Invoiced / paid lines must stay (same id, amount, kind, invoice_id). Planned lines may be
 * edited, added, removed, or waived. This is what the Cloud money-plan UI calls.
 */
export function applyMoneyPlanEdit(
  existing: MoneyPlan | undefined,
  input: { currency?: string; lines: MoneyPlanEditLine[] },
): MoneyPlan {
  const currency = (input.currency ?? existing?.currency ?? "").trim().toUpperCase();
  if (!currency) throw new Error("money plan needs a currency");

  const prevById = new Map((existing?.lines ?? []).map((l) => [l.id, l]));
  const locked = (existing?.lines ?? []).filter((l) => l.status === "invoiced" || l.status === "paid");
  const seenLocked = new Set<string>();

  const lines: MoneyPlanLine[] = [];
  for (const raw of input.lines) {
    const label = String(raw.label ?? "").trim().slice(0, 200);
    if (!label) throw new Error("every money-plan line needs a label");
    const kind = LINE_KINDS.includes(raw.kind) ? raw.kind : "milestone";
    const amount = Math.trunc(Number(raw.amount_minor));
    if (!Number.isFinite(amount) || amount < 0) throw new Error(`bad amount on "${label}"`);

    const prev = raw.id ? prevById.get(raw.id) : undefined;
    if (prev && (prev.status === "invoiced" || prev.status === "paid")) {
      seenLocked.add(prev.id);
      if (amount !== prev.amount_minor || kind !== prev.kind) {
        throw new Error(`cannot change amount or kind on ${prev.status} line "${prev.label}"`);
      }
      lines.push({
        ...prev,
        label,
        deliverable_id: typeof raw.deliverable_id === "string" ? raw.deliverable_id : prev.deliverable_id,
        ...(prev.kind === "retainer"
          ? { recurrence: readRetainerRecurrence(raw.recurrence) ?? prev.recurrence }
          : {}),
      });
      continue;
    }

    // Editor may only toggle planned ↔ waived. Invoiced/paid arrive from billing, never from this
    // path (locked lines already continued above). Preserve waived when the client omits status.
    let status: MoneyPlanLineStatus =
      raw.status === "waived"
        ? "waived"
        : raw.status === "planned"
          ? "planned"
          : prev?.status === "waived"
            ? "waived"
            : "planned";

    lines.push({
      id: prev?.id ?? (typeof raw.id === "string" && raw.id ? raw.id : randomUUID()),
      label,
      amount_minor: amount,
      kind,
      status,
      deliverable_id: typeof raw.deliverable_id === "string" ? raw.deliverable_id : prev?.deliverable_id,
      invoice_id: undefined,
      // Preserved, never cleared by omission. See `MoneyPlanEditLine.recurrence`.
      ...(kind === "retainer"
        ? { recurrence: readRetainerRecurrence(raw.recurrence) ?? prev?.recurrence }
        : {}),
    });
  }

  for (const l of locked) {
    if (!seenLocked.has(l.id)) {
      throw new Error(`cannot remove ${l.status} line "${l.label}" — void the invoice first`);
    }
  }

  return { currency, lines };
}

/**
 * Draft an invoice from a money-plan line and mark the line invoiced on the case.
 *
 * Founder still gates send/charge — this only removes the "remember to price it" leak.
 */
export async function draftInvoiceFromPlanLine(args: {
  domain: DomainStore;
  kase: Case;
  line: MoneyPlanLine;
  deliverable?: Deliverable;
  due_date?: string;
}): Promise<{ invoice: Invoice; case: Case; line: MoneyPlanLine }> {
  const plan = readMoneyPlan(args.kase.data);
  if (!plan) throw new Error("this engagement has no money plan");
  if (!args.kase.client_id) throw new Error("this engagement has no client");
  if (!args.kase.project_id) throw new Error("this engagement has no project");

  const line = plan.lines.find((l) => l.id === args.line.id);
  if (!line) throw new Error("that money-plan line is not on this engagement");
  if (line.status !== "planned") throw new Error("that line is already invoiced or closed");
  // A RECURRING LINE MUST NOT GO THROUGH THE ONE-SHOT DOOR. This function flips the line to
  // `invoiced`, which is a one-way ratchet — doing that to a live retainer would bill it once and
  // then silently stop it for ever, which is the exact bug the retainer engine was built to end.
  // Recurring billing has its own door (`billRetainerPeriod`) with its own idempotency ledger.
  if (line.recurrence) {
    throw new Error(
      "that line is a recurring retainer — it bills on its own schedule, so it cannot be raised as a one-off here",
    );
  }
  if (line.amount_minor <= 0) throw new Error("that line has no amount — set the price on the money plan first");

  const invoiceLine: InvoiceLine = {
    id: randomUUID(),
    description: args.deliverable
      ? `${line.label} — ${args.deliverable.title}`
      : line.label,
    quantity_milli: 1000,
    unit_amount: line.amount_minor,
    kind: "fixed",
  };

  const draft: NewInvoice = {
    project_id: args.kase.project_id,
    client_id: args.kase.client_id,
    case_id: args.kase.id,
    currency: plan.currency,
    status: "draft",
    issue_date: new Date().toISOString().slice(0, 10),
    due_date: args.due_date ?? new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10),
    lines: normalizeLines([invoiceLine]),
    amount_paid: 0,
  };

  const invoice = await getBillingStore().createInvoice(draft);
  const nextLines = plan.lines.map((l) =>
    l.id === line.id
      ? {
          ...l,
          status: "invoiced" as const,
          invoice_id: invoice.id,
          deliverable_id: args.deliverable?.id ?? l.deliverable_id,
        }
      : l,
  );
  const nextPlan: MoneyPlan = { ...plan, lines: nextLines };
  const updated = await args.domain.updateCase(args.kase.id, {
    data: writeMoneyPlan(args.kase.data ?? {}, nextPlan),
  });
  if (!updated) throw new Error("could not update the engagement money plan");
  return { invoice, case: updated, line: nextLines.find((l) => l.id === line.id)! };
}
