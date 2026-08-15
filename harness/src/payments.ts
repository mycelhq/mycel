// Payment detection: how we know whether a client actually paid.
//
// ═══════════════════════════ THE QUESTION THIS ANSWERS ═══════════════════════════
//
// "How would we know if they paid or not?" Before this file, the honest answer was: we would not.
// `Invoice.payment_link_url` is a Stripe link a founder pasted in by hand, `POST /v1/invoices/:id/
// payments` is BOOKKEEPING — it records a payment a human already knew about — and the dunning sweep
// chases on `effectiveStatus` and `amount_due > 0`, both of which are computed from a number that
// only ever changes when a person types it in.
//
// So the live failure was this: a client pays by card on the 3rd, nobody transcribes it, and on the
// 5th, 8th and 15th our automation sends that client an escalating series of demands for money they
// have already paid. It is our name on those emails. There is no worse thing this product can do.
//
// ═══════════════════════════ POLL, NOT WEBHOOK, AND WHY ═══════════════════════════
//
// Composio triggers exist and would be lower-latency: `triggers.ts` + `POST /v1/composio/webhook`
// already turn a signed provider event into a task, and Stripe publishes the events. They were not
// chosen as the mechanism of record, for one decisive reason.
//
//   A WEBHOOK CANNOT TELL YOU THAT NOTHING HAPPENED. Silence on a webhook is indistinguishable from
//   "no payments arrived", "the subscription lapsed", "MYCEL_PUBLIC_URL changed at the last deploy",
//   "COMPOSIO_WEBHOOK_SECRET was rotated" and "Composio is down". Every one of those looks exactly
//   like a client who has not paid, and the thing we do to a client who has not paid is chase them.
//   A dunning system whose safety depends on a delivery that may silently never come is a dunning
//   system that fails toward sending the email.
//
// A poll fails the other way. It runs on a clock we own, it either reaches the provider or it does
// not, and either outcome is written down (`recordPaymentCheck`). That written-down fact — WHEN we
// last actually looked — is what `paymentConfidence` below turns into a gate on chasing, and it is
// simply not expressible in a webhook-only design. Latency is the price: up to `SYNC_SECONDS`
// between the money landing and us knowing, against a dunning ladder whose fastest rung is three
// days. That trade is not close.
//
// A trigger subscription remains the right LATENCY optimisation on top of this, and the seam is
// `reconcileProject` — it is idempotent and safe to call from a webhook handler at any time. What it
// must never become is the only way we find out.
//
// ═══════════════════════════ WHAT IT REFUSES TO DO ═══════════════════════════
//
// It never guesses which invoice a payment belongs to. Matching is `match.ts` — reference first,
// then exact amount and date, one-to-one, no fuzzy fallback and no tolerance window. Anything it
// cannot place with certainty is reported as unplaced, for a human, and the invoice stays exactly as
// it was. See the comment at the top of match.ts for the specific bug that a "helpful" fuzzy match
// causes on a business that bills the same retainer every month.
//
// It also never calls a tool the founder has not declared as a read on the connection. The provider
// table names slugs, but `isReadTool` is the authority on whether we may run one — the same gate
// `/v1/internal/reads/:capability` enforces. A payment reconciliation that could reach an arbitrary
// Stripe slug is a payment reconciliation that can issue a refund.
//
// ═══════════════════════════ IT IS NO LONGER ABOUT STRIPE ═══════════════════════════
//
// This file used to carry its own one-vendor catalogue:
//
//   const PAYMENT_READS = { stripe: [...] }
//   export const PAYMENT_TOOLKITS = Object.keys(PAYMENT_READS);
//
// with a comment saying the toolkit list was the seam. It was, and it has been widened rather than
// duplicated: the catalogue is now `DEFAULT_CAPABILITY_PROVIDERS.read_payments` in capabilities.ts
// and the parsers are capabilities.normalise.ts. What that changes in practice is that a business
// paid through QuickBooks, Xero, Square or PayPal gets the SAME protection this file was written to
// provide, instead of being told to connect Stripe. Nothing about the money logic below moved.
import type { Connection, Invoice, Schedule } from "./contract";
import type { ActionResult } from "./actions";
import type { DomainStore } from "./domain";
import { capabilityProviders } from "./capabilities";
import { readCapability, whyNothingRead } from "./capabilities.read";
import {
  INVOICE_SHAPES,
  PAYMENT_SHAPES,
  normaliseStripeCharges,
  normaliseStripeInvoices,
  type ObservedInvoice,
  type ObservedPayment,
} from "./capabilities.normalise";
import { matchTwoPass, type Matchable } from "./match";
import {
  canTransition,
  getBillingStore,
  invoiceTotals,
  type ExternalPayment,
  type PaymentCheck,
} from "./billing";

/** The schedule that keeps payment state fresh. Not the dunning sweep — this must run whether or
 *  not anything is being chased, because its output is what makes chasing safe. */
export const PAYMENT_SYNC_TASK_TYPE = "reconcile_payments";

/**
 * How often to look. Quarter-hourly.
 *
 * Bounded by two things pulling opposite ways: every run is N provider API calls against a founder's
 * rate limit, and every minute of delay is a minute in which a paid invoice could be chased. Fifteen
 * minutes is comfortably inside both — and note the dunning ladder's floor is 48 HOURS, so this is
 * three orders of magnitude faster than the thing it protects.
 */
export const SYNC_SECONDS = 900;

/**
 * After this long without a successful check, payment state is STALE and chasing stops.
 *
 * 26 hours, not 26 minutes, and the gap between this and `SYNC_SECONDS` is the entire point. The
 * sync runs every 15 minutes, so reaching 26 hours means roughly a hundred consecutive failures —
 * this is not a blip, it is a broken integration, and the founder has had a day of `ok: false` on
 * the check row to notice. Setting it tight would mean a five-minute Stripe wobble halting a
 * business's accounts receivable; setting it loose (or omitting it) means we chase on day-old
 * information, which is how the paid-invoice email gets sent.
 */
export const STALE_AFTER_HOURS = 26;

/** Re-exported from the normalisation seam, where it is now shared by four readers. */
export type { ObservedPayment } from "./capabilities.normalise";

/**
 * Toolkits this kernel knows how to read money out of.
 *
 * Derived from the capability table rather than from a literal in this file — that literal was the
 * bug. Kept as an export because it is the honest answer to "which payment providers work", and it
 * is now seven rather than one.
 */
export const PAYMENT_TOOLKITS = capabilityProviders("read_payments").map((p) => p.toolkit);

/**
 * The Stripe parsers, at their old names and old signatures.
 *
 * They live in capabilities.normalise.ts now, beside Xero's and QuickBooks'. These two lines exist so
 * that nothing importing them has to move, and so `payments.test.ts` keeps pinning the two behaviours
 * that cost the most to get wrong (`amount_paid` not `total`; `amount_captured` net of refunds)
 * through the same door it always did.
 */
export const parseStripeInvoices = (data: unknown): ObservedPayment[] => normaliseStripeInvoices(data).items;
export const parseStripeCharges = (data: unknown): ObservedPayment[] => normaliseStripeCharges(data).items;

/**
 * What reconciliation needs from the rest of the kernel.
 *
 * Injected for the same reason `ChaseDeps` is: reaching for the domain store and the action executor
 * directly would drag the server graph into the scheduler, and — more usefully — it makes the
 * tenancy rule testable without a Composio account.
 */
export interface ReconcileDeps {
  /** ALL connections. This module does the project filtering, and its test asserts that it does. */
  listConnections(): Promise<Connection[]>;
  execute(conn: Connection, capability: string, payload: Record<string, unknown>): Promise<ActionResult>;
  /**
   * Called once per invoice that a detected payment settled in full, BEFORE anything else happens to
   * it. This is where a chase queued or awaiting approval for that invoice gets killed. Optional
   * only so tests can omit it; production wires it in `mountInvoiceRoutes`.
   */
  onSettled?(inv: Invoice): Promise<void>;
}

let deps: ReconcileDeps | null = null;
export function setReconcileDeps(d: ReconcileDeps | null): void {
  deps = d;
}

/** One thing a human has to look at. Never merged into a count — a count is not actionable. */
export interface Discrepancy {
  kind:
    /** A payment we could not tie to any open invoice. Money in, nothing settled. */
    | "unplaced_payment"
    /** The provider's currency is not the invoice's. Never converted; never applied. */
    | "currency_mismatch"
    /** More money than the invoice asked for. Applied — the surplus is a credit the founder owes back. */
    | "overpayment"
    /** A refund left a settled invoice owing again. `paid` is terminal, so this needs a credit note. */
    | "refund_on_settled_invoice"
    /** Two payments quote the same reference. Neither is matched by it; see `ambiguous_references`. */
    | "ambiguous_reference"
    /** The invoice id we matched to is not in this project. Should be impossible; loud if it happens. */
    | "cross_tenant_refused";
  detail: string;
  invoice_id?: string;
  external_id?: string;
}

export interface ReconcileSummary {
  project_id: string;
  /** Payments read from the provider. */
  observed: number;
  /** Payments tied to an invoice with certainty. */
  matched: number;
  /** Payments that actually moved `amount_paid` this run. The rest were already applied. */
  applied: number;
  /** Invoices this run took from owing to settled. */
  settled: string[];
  discrepancies: Discrepancy[];
  /**
   * Whether we actually reached the provider and read something.
   *
   * FALSE IS NOT AN ERROR RETURN — it is the answer, and it is written to the payment-check row so
   * `paymentConfidence` can act on it. The bug this shape exists to prevent is the one this repo
   * keeps having: a reconciliation that fails to reach Stripe, returns an all-zeroes summary, gets
   * logged as a clean run, and leaves every invoice looking confidently unpaid.
   */
  ok: boolean;
  /** Always populated, on success and failure alike. Never an empty string. */
  detail: string;
}

/**
 * Reconcile one project's payments. THE ENTRY POINT — poll or webhook, this is what runs.
 *
 * `project_id` is a required field of a required argument and is never defaulted. There is no
 * overload that reconciles everything. The failure mode of a defaulted scope here is the worst one
 * in the product: reading one tenant's Stripe and writing the payments onto another tenant's
 * invoices, which both fabricates revenue for one business and keeps chasing the client of another.
 */
export async function reconcileProject(args: { project_id: string; now?: Date }): Promise<ReconcileSummary> {
  const projectId = args.project_id;
  if (!projectId) throw new Error("a payment reconciliation must be scoped to a project");
  const now = args.now ?? new Date();
  const billing = getBillingStore();
  const base: ReconcileSummary = {
    project_id: projectId,
    observed: 0,
    matched: 0,
    applied: 0,
    settled: [],
    discrepancies: [],
    ok: false,
    detail: "",
  };

  // Every exit below records a check row. That is the contract of this function: after it returns,
  // the answer to "when did we last look, and did it work" is durable and true. An early return that
  // skipped the write would leave a stale `confirmed_at` looking fresh.
  const finish = async (s: ReconcileSummary): Promise<ReconcileSummary> => {
    const check: PaymentCheck = {
      project_id: projectId,
      // ONLY a successful read moves `confirmed_at`. This is the line that makes staleness mean
      // something — if it were stamped unconditionally, a permanently broken Stripe connection would
      // report perfect freshness forever and the whole guard would be decorative.
      confirmed_at: s.ok ? now.toISOString() : undefined,
      attempted_at: now.toISOString(),
      ok: s.ok,
      detail: s.detail,
    };
    await billing.recordPaymentCheck(check).catch((e) => {
      // Loud, and it does not swallow the result: a failure to record freshness makes the NEXT
      // chase's confidence worse, never better, so the safe direction is already the default.
      console.error(`[mycel] could not record the payment check for project ${projectId}:`, e);
    });
    if (!s.ok) console.error(`[mycel] payment reconciliation for project ${projectId} did not run: ${s.detail}`);
    return s;
  };

  if (!deps) {
    return finish({ ...base, detail: "payment reconciliation is not wired up in this deployment" });
  }

  // ── the connection, and the tenancy boundary ──
  //
  // `resolveCapability` (inside `readCapability`) does the filtering, and it does it the same way
  // this loop used to: founder-owned only, exact `project_id` string equality, and — new —
  // `verified_at` required, so an abandoned OAuth screen no longer counts as a connected provider.
  //
  // Founder-owned only, because a client-owned Composio connection is a CLIENT's own account that the
  // founder operates on their behalf (see `ConnectionOwner`); reading it for accounts receivable
  // would settle our invoices out of the client's own customers' payments.
  const all = await deps.listConnections();
  const read = await readCapability<ObservedPayment>({
    capability: "read_payments",
    project_id: projectId,
    connections: all,
    execute: deps.execute,
    shapes: PAYMENT_SHAPES,
  });
  const observed = read.items;
  const sources = read.sources;
  // Normaliser refusals are failures for reporting purposes. They are rows the provider DID return
  // and we declined to guess at — a founder needs to see "three Xero payments were in a currency we
  // cannot size" rather than a summary that quietly read three fewer payments than exist.
  const failures = [...read.failures, ...read.skipped];

  if (!read.reached) {
    return finish({
      ...base,
      // `whyNothingRead` distinguishes nothing-connected from connected-and-broken from
      // connected-but-not-granted, and `paymentConfidence` below branches on the first of those by
      // matching the leading words of `binding.detail`. Collapsing them would turn a business that
      // has never connected anything (chase, honestly) into one whose integration is down (do not
      // chase) or the other way round.
      detail: whyNothingRead(read) ?? "nothing was read from the connected payment provider",
    });
  }

  base.observed = observed.length;

  // ── the open invoices this could settle ──
  const open = [
    ...(await billing.listInvoices({ project_id: projectId, status: "sent", limit: 500 })),
    ...(await billing.listInvoices({ project_id: projectId, status: "overdue", limit: 500 })),
  ];

  // ── match ──
  //
  // Payments on the left, invoices on the right — same shape as reconcile.mjs (bank on the left,
  // ledger on the right), and for the same reason: the left-hand side is the outside world's version
  // of events and the right-hand side is ours.
  //
  // The invoice's `date` for pass 2 is its DUE DATE, and the honest note is that pass 2 will rarely
  // fire here: clients pay on the 4th for an invoice due on the 1st, and match.ts allows no window.
  // That is intended. Nearly every real match comes from pass 1 (the reference the client quoted),
  // and a payment that pass 2 misses becomes an `unplaced_payment` a human sees — which is exactly
  // the outcome we want over a plausible-looking guess. See the retainer bug at the top of match.ts.
  const left: (Matchable<string> & { p: ObservedPayment })[] = observed.map((p) => ({
    key: p.external_id,
    reference: p.reference,
    amount: p.amount_minor,
    date: p.paid_at.slice(0, 10),
    p,
  }));
  const right: (Matchable<string> & { inv: Invoice })[] = open.map((inv) => ({
    key: inv.id,
    reference: inv.number,
    amount: invoiceTotals(inv).amount_due,
    date: inv.due_date,
    inv,
  }));
  const result = matchTwoPass(left, right);
  base.matched = result.matched.length;

  for (const ref of result.ambiguous_references) {
    base.discrepancies.push({
      kind: "ambiguous_reference",
      detail: `more than one open invoice answers to "${ref}", so no payment was matched to it by reference — a human has to say which`,
    });
  }
  // ── unplaced payments, and where the accounting system says they belong ──
  //
  // "Matches no open invoice" was true and unhelpful. For a business that raises its invoices in Xero
  // or QuickBooks rather than here, the overwhelmingly likely answer is "it settles an invoice Mycel
  // has never seen", and until now the founder had to go and find that out by hand for every one.
  //
  // So when `read_invoices` is bound, the unplaced payments are run through the SAME matcher against
  // the accounting system's invoices, and a hit is NAMED in the discrepancy. Nothing is applied —
  // there is no local invoice to apply it to, and inventing one is not this process's decision — so
  // this is strictly extra information on a row a human was already going to read.
  const external = result.unmatched_left.length
    ? // The payment providers just read are EXCLUDED: Stripe's invoices were already read above as
      // payments, and reading them again here would put the same money in front of the founder twice
      // under two names.
      await readExternalInvoices(projectId, all, deps.execute, read.binding.bound.map((b) => b.connection.id)).catch((e) => {
        // Enrichment failing must never fail a reconciliation that otherwise worked. It degrades to
        // the sentence we had before, and says why in the summary.
        failures.push(`could not read the accounting system's invoices for context: ${(e as Error).message}`);
        return [] as ObservedInvoice[];
      })
    : [];
  const placedElsewhere = external.length
    ? matchTwoPass(
        result.unmatched_left.map((l) => ({ key: l.key, reference: l.reference, amount: l.amount, date: l.date })),
        external.map((x) => ({ key: x.external_id, reference: x.number, amount: x.amount_due_minor, date: x.due_date, x })),
      )
    : undefined;
  const elsewhere = new Map((placedElsewhere?.matched ?? []).map((m) => [m.left.key, m.right.x]));

  for (const l of result.unmatched_left) {
    const hit = elsewhere.get(l.key);
    base.discrepancies.push({
      kind: "unplaced_payment",
      external_id: l.key,
      detail: hit
        ? `a payment of ${l.amount} ${l.p.currency} on ${l.date} matches no invoice here, but it matches ${hit.number ?? hit.external_id}` +
          `${hit.client_name ? ` for ${hit.client_name}` : ""} in your accounting system — raised outside Mycel, so nothing was applied`
        : `a payment of ${l.amount} ${l.p.currency} on ${l.date} matches no open invoice — it may be for something we did not invoice, or the client quoted no reference`,
    });
  }

  // ── apply ──
  for (const m of result.matched) {
    const inv = m.right.inv;
    const p = m.left.p;

    // CURRENCY IS NEVER CONVERTED, AND A MISMATCH IS NEVER APPLIED. There is no exchange rate in this
    // process and there must not be one: applying 4000 minor units of USD to a EUR invoice would
    // settle a €4,000 debt with $4,000, and the arithmetic would look perfectly clean at every step.
    // A conversion is a business decision with a rate, a date and a fee, and it belongs to a human.
    if (p.currency && inv.currency && p.currency.toUpperCase() !== inv.currency.toUpperCase()) {
      base.discrepancies.push({
        kind: "currency_mismatch",
        invoice_id: inv.id,
        external_id: p.external_id,
        detail: `a payment in ${p.currency} matched invoice ${inv.number}, which is in ${inv.currency} — nothing was applied, because converting money is not this process's decision`,
      });
      continue;
    }

    const before = invoiceTotals(inv);
    const record: ExternalPayment = {
      project_id: projectId,
      invoice_id: inv.id,
      external_id: p.external_id,
      amount_minor: p.amount_minor,
      currency: (p.currency || inv.currency).toUpperCase(),
      paid_at: p.paid_at,
      basis: m.basis,
      source: sources.get(p.external_id) ?? "provider",
    };
    const { applied, invoice } = await billing.applyExternalPayment(record);
    if (!invoice) {
      // The store refused because the invoice is not in this project. This should be unreachable —
      // `open` came from a project-scoped list — so if it ever fires, something upstream is wrong in
      // exactly the way that leaks across tenants, and it must be visible rather than a silent skip.
      base.discrepancies.push({
        kind: "cross_tenant_refused",
        invoice_id: inv.id,
        external_id: p.external_id,
        detail: `refused to apply a payment to invoice ${inv.id}, which is not in project ${projectId}`,
      });
      console.error(`[mycel] cross-tenant payment refused: invoice ${inv.id} is not in project ${projectId}`);
      continue;
    }
    if (!applied) continue; // Already seen on an earlier run. The idempotency ledger doing its job.
    base.applied++;

    const after = invoiceTotals(invoice);

    if (after.amount_paid > after.total) {
      base.discrepancies.push({
        kind: "overpayment",
        invoice_id: inv.id,
        external_id: p.external_id,
        detail: `invoice ${inv.number} has been paid ${after.amount_paid - after.total} minor units more than it asked for — the surplus is a credit the business owes back, and this process cannot decide how to return it`,
      });
    }

    // SETTLED IN FULL — and only then. A partial payment moves `amount_paid` and CHANGES NOTHING
    // ELSE: the invoice is still owed, so it stays chaseable and the ladder carries on (with
    // `partially_paid: true` in the chase input, which is what changes the agent's tone). Marking a
    // part-paid invoice `paid` would be the mirror-image bug of chasing a settled one — quietly
    // writing off the remainder.
    if (after.amount_due === 0 && canTransition(invoice.status, "paid")) {
      // BEFORE the transition, so a chase already queued or sitting on the approval gate is killed
      // rather than sent. See `onSettled` and `cancelChasesForInvoice`.
      await deps.onSettled?.(invoice).catch?.((e: unknown) =>
        console.error(`[mycel] could not stand down the chase for invoice ${invoice.id}:`, e),
      );
      const done = await billing.transitionInvoice(invoice.id, "paid", ["sent", "overdue"], {
        paid_at: p.paid_at,
      });
      if (done) base.settled.push(done.id);
    } else if (after.amount_due > 0 && before.amount_due === 0) {
      // A refund reopened a settled invoice. `paid` is terminal by design (un-paying is a credit
      // note, a different document with its own audit trail), so this is deliberately NOT walked
      // back automatically — it is handed to a person.
      base.discrepancies.push({
        kind: "refund_on_settled_invoice",
        invoice_id: inv.id,
        external_id: p.external_id,
        detail: `a refund left invoice ${inv.number} owing ${after.amount_due} again after it had been settled — that is a credit note, not a status change, so nothing was reopened automatically`,
      });
    }
  }

  const parts = [
    `read ${base.observed} payment(s)`,
    `matched ${base.matched}`,
    `applied ${base.applied}`,
    `settled ${base.settled.length}`,
  ];
  if (failures.length) parts.push(`${failures.length} read(s) failed: ${failures.join("; ")}`);
  if (base.discrepancies.length) parts.push(`${base.discrepancies.length} need a human`);
  return finish({ ...base, ok: true, detail: parts.join(", ") });
}

/**
 * The invoices this business raises somewhere else, normalised.
 *
 * ONE-WAY AND READ-ONLY. It reports what the accounting system says; it never creates, updates or
 * settles a local invoice from it. Two ledgers that write to each other is a synchronisation problem
 * with a conflict-resolution policy, and there is no such policy here — so the honest scope is
 * "answer a question a human is about to ask", which is what the unplaced-payment enrichment above
 * does with it.
 *
 * `projectId` is required and never defaulted, for the same reason every other read here is scoped.
 */
export async function readExternalInvoices(
  projectId: string,
  connections: readonly Connection[],
  execute: ReconcileDeps["execute"],
  alreadyRead: readonly string[] = [],
): Promise<ObservedInvoice[]> {
  if (!projectId) throw new Error("reading external invoices must be scoped to a project");
  const read = await readCapability<ObservedInvoice>({
    capability: "read_invoices",
    project_id: projectId,
    connections,
    execute,
    shapes: INVOICE_SHAPES,
    exclude_connection_ids: alreadyRead,
  });
  // A connected-but-unreadable accounting system is already a sentence in `read.failures`; the caller
  // decides how loud to be. What must not happen is this returning `[]` for "FreshBooks is connected
  // and we have no reader" as if the business had no invoices.
  for (const f of read.failures) console.error(`[mycel] reading invoices for project ${projectId}: ${f}`);
  return read.items;
}

/**
 * Create (or find) the payment-sync Schedule for a project. One per project.
 *
 * Modelled on `ensureDunningSchedule`, with one deliberate difference: that one THROWS when no wedge
 * declares the dunning role, and this one has no such gate. Payment detection is not a wedge's
 * feature — it is a property of the kernel's own accounts receivable, and a business that has
 * invoices but no chaser still wants to know when they get paid. It is also the reason the ordering
 * works: a project can be reconciling for a week before anyone installs a chaser, so the first chase
 * that ever runs already has fresh state to check.
 */
export async function ensurePaymentSyncSchedule(
  domain: DomainStore,
  projectId: string,
  wedge: string,
  now: Date = new Date(),
): Promise<Schedule> {
  if (!projectId) throw new Error("a payment sync must be scoped to a project");
  const existing = (await domain.listSchedules()).find(
    (s) => s.project_id === projectId && s.task_type === PAYMENT_SYNC_TASK_TYPE,
  );
  if (existing) return existing;
  return domain.createSchedule({
    project_id: projectId,
    name: "payment sync",
    // `Schedule.wedge` is required by the contract, but `fireSchedule` never loads it for a harness
    // sweep — it branches on `task_type` before any wedge is touched. The caller passes whichever
    // wedge it is already holding rather than this file naming one, which is also what keeps the
    // roles.ts contract test (no wedge directory names in src/) satisfiable here.
    wedge,
    task_type: PAYMENT_SYNC_TASK_TYPE,
    input: {},
    cadence: { kind: "every", seconds: SYNC_SECONDS },
    enabled: true,
    // Soon, not in fifteen minutes. A founder who has just connected Stripe should see their
    // payment state confirmed while they are still looking at the screen.
    next_run_at: new Date(now.getTime() + 60_000).toISOString(),
  });
}

// ═══════════════════════════ THE GUARD THE CHASE ACTUALLY USES ═══════════════════════════

export type PaymentConfidenceLevel =
  /** Checked recently and it worked. Chasing is safe. */
  | "fresh"
  /** We have looked before, but not recently enough to bet a client relationship on. */
  | "stale"
  /** No payment provider is connected. We have never been able to look, and never will be. */
  | "unverifiable"
  /** A provider is connected and the last check FAILED. Something is broken right now. */
  | "unknown";

export interface PaymentConfidence {
  level: PaymentConfidenceLevel;
  /** When a check last succeeded, if ever. Shown in the approval preview. */
  confirmed_at?: string;
  /** Whole hours since that, or undefined if never. */
  age_hours?: number;
  /** A sentence for a human approving a chase. Always populated. */
  detail: string;
  /**
   * May an automated ladder send on this? A human overriding is a separate decision — see
   * `startChase`'s `"override"` pacing, which deliberately still goes through.
   */
  safe_to_chase_automatically: boolean;
}

/**
 * How much we currently trust "this invoice is unpaid", for one project.
 *
 * ═══ THE DEFENCE OF `unverifiable` BEING CHASEABLE ═══
 *
 * There are two ways to be wrong here and they are not symmetric.
 *
 * A business with no Stripe connected — a founder invoicing by bank transfer, which is most of them
 * — can NEVER have a fresh check. If "we cannot verify" halted chasing, the product would silently
 * do nothing at all for that customer: the single most expensive failure mode in this repo is
 * something failing while reporting success, and an AR chaser that has quietly stopped chasing is
 * the purest form of it. So `unverifiable` still chases. What it does NOT do is pretend: the
 * confidence travels into the chase's task input and into the approval preview, so the human holding
 * the gate reads "nobody has ever checked whether this was paid — a bank transfer would not show
 * up here" before they approve, and the one-click Mark as paid is right there.
 *
 * `stale` and `unknown` are different, and they halt the automatic ladder. In both cases a provider
 * IS connected — so a payment WOULD normally be visible to us — and it is not visible now because
 * something is broken. That is the precise situation in which our information is likely to be wrong
 * in the dangerous direction: the client paid, Stripe knows, and we cannot see it. The founder has a
 * failing check row saying so, and a chase that waits a day for a fixed integration costs a day. A
 * chase sent on broken information costs the client relationship. So: connected-and-blind fails
 * closed, never-connected fails open-but-honest.
 */
export async function paymentConfidence(projectId: string, now: Date = new Date()): Promise<PaymentConfidence> {
  if (!projectId) throw new Error("payment confidence must be scoped to a project");
  const check = await getBillingStore().getPaymentCheck(projectId);

  if (!check) {
    return {
      level: "unverifiable",
      detail:
        "no payment provider has ever been checked for this business, so nothing here can confirm whether this invoice was paid — a bank transfer or a cash payment would not show up",
      safe_to_chase_automatically: true,
    };
  }

  const ageMs = check.confirmed_at ? now.getTime() - Date.parse(check.confirmed_at) : undefined;
  const ageHours = ageMs === undefined || !Number.isFinite(ageMs) ? undefined : Math.max(0, Math.floor(ageMs / 3_600_000));

  // A never-successful check whose failure reason is "nothing is connected" is `unverifiable`, not
  // `unknown` — the two demand different things from a founder (connect something vs fix something)
  // and, more importantly here, only one of them is grounds to stop chasing. `reconcileProject`
  // writes that exact sentence, and this is the one place that reads it back.
  const nothingConnected = !check.ok && check.detail.startsWith("no payment provider is connected");
  if (nothingConnected && !check.confirmed_at) {
    return {
      level: "unverifiable",
      confirmed_at: undefined,
      detail: `no payment provider is connected to this business, so nothing here can confirm whether this invoice was paid (last looked ${check.attempted_at})`,
      safe_to_chase_automatically: true,
    };
  }

  if (!check.ok) {
    return {
      level: "unknown",
      confirmed_at: check.confirmed_at,
      age_hours: ageHours,
      detail: `the last attempt to check payments failed (${check.detail}), so we cannot currently tell whether this invoice has been paid${check.confirmed_at ? ` — the last good check was ${ageHours}h ago` : ""}`,
      safe_to_chase_automatically: false,
    };
  }

  if (ageHours === undefined || ageHours >= STALE_AFTER_HOURS) {
    return {
      level: "stale",
      confirmed_at: check.confirmed_at,
      age_hours: ageHours,
      detail: `payment state was last confirmed ${ageHours ?? "never"} hours ago, which is too long to chase on automatically`,
      safe_to_chase_automatically: false,
    };
  }

  return {
    level: "fresh",
    confirmed_at: check.confirmed_at,
    age_hours: ageHours,
    detail: `payment state was confirmed ${ageHours}h ago against the connected payment provider`,
    safe_to_chase_automatically: true,
  };
}
