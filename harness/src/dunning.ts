// The dunning sweep: the thing that actually chases.
//
// WHAT WAS WRONG
// --------------
// `POST /v1/invoices/:id/chase` was complete, tested, and called only by a human clicking a button.
// So the invoice-chaser — a wedge whose entire purpose is chasing — never ran unless someone
// remembered to run it, which is the one thing a founder buying an AR chaser is paying not to do.
//
// The blueprint made this worse rather than better. `blueprints/invoice-chaser.json` declared a
// "daily overdue sweep" schedule with `task_type: "chase_invoice"`, which would have fired ONE
// chase_invoice run per day with an empty input: no invoice id, no amount, no due date, no
// `days_overdue` for `next_step` to branch on. An agent handed that has nothing to chase and every
// opportunity to invent something. That schedule now points at `CHASE_SWEEP_TASK_TYPE` below.
//
// THE SHAPE, AND WHY IT IS THIS SHAPE
// -----------------------------------
//
//   · IT IS HARNESS WORK, NOT AGENT WORK. The sweep spawns no model call of its own. Deciding
//     WHICH invoices are due a chase is arithmetic over stored rows — status, amount due, days
//     overdue, when we last chased — and an LLM asked to do arithmetic over a list of debts will
//     eventually chase a paid invoice. The model's job starts one level down, inside each
//     `chase_invoice` run, where it writes the words. This mirrors `advanceSequences` exactly, and
//     `fireSchedule` dispatches both the same way.
//
//   · THE CLAIM IS TWO CLAIMS, AND BOTH ARE NEEDED. `claimDueSchedules` (FOR UPDATE SKIP LOCKED)
//     already guarantees that with N worker replicas exactly one fires a given schedule tick, so
//     one replica sweeps a project. That alone is NOT enough, and the gap is worth naming: a
//     founder hitting `POST /v1/schedules/:id/run`, a retried tick, an overlapping manual chase, or
//     an operator running two sweeps of different cadences all put a second chaser on the same
//     invoice with no schedule row to serialise them. So every invoice is claimed individually via
//     `claimInvoiceForChase` — a compare-and-set on `last_chased_at`, guard in the WHERE clause —
//     before any run is spawned. Two sweeps racing the same invoice: one wins, one gets undefined.
//
//   · PACING IS THE LADDER'S, NOT THE CADENCE'S. The sweep may run hourly; an invoice must not be
//     chased hourly. `wedges/invoice-chaser/knowledge/dunning-policy.md` says "never chase the same
//     invoice twice in 48h" and describes three rungs, and `chaseIntervalDays` below encodes a
//     cadence per rung with that 48h as the hard floor. This means the sweep's schedule cadence and
//     the client's experience are decoupled: making the sweep more frequent makes it more RESPONSIVE
//     (a newly overdue invoice is picked up sooner) and not more AGGRESSIVE.
//
//   · FAIL CLOSED, AND PROJECT-SCOPED WITH NO DEFAULT. There is no "sweep every project". A project
//     is swept only if it has a Schedule of this task type AND the dunning wedge enabled.
//     `ensureDunningSchedule` throws on a missing project id rather than defaulting to one, because
//     the failure mode of a defaulted scope here is a dunning email sent to another tenant's client.
//
//   · AND WHICH WEDGE CHASES IS A DECLARATION, NOT THIS FILE'S OPINION. This module used to hold
//     `DUNNING_WEDGE = "invoice-chaser"` — a directory name. So a sweep on an install without that
//     directory spawned a `chase_invoice` run for a wedge that was not there: no output schema, no
//     policy envelope, no dunning policy mounted as knowledge, and a summary that reported it as a
//     started chase. `dunningWedge()` resolves the wedge that DECLARES `provides: ["dunning"]`, and
//     when nothing does the sweep does nothing and says so once. See roles.ts.
import type { Connection, Invoice, Schedule, TaskSource } from "./contract";
import { whyNoWedge, wedgeForRole } from "./roles";
import { getDomainStore, type DomainStore } from "./domain";
import { loadWedge } from "./wedge";
import { capabilityConnections, selectGrantableConnections } from "./runtime";
import { registerClaimRelease } from "./promises";
import { markAbort } from "./cancel";
import { failWaitersForTask } from "./approvals";
import { paymentConfidence, type PaymentConfidence } from "./payments";
import { paymentQuestionGate, QUESTION_GRACE_HOURS, type LadderGate } from "./payments.manual";
import { howToPay, type PaymentOffer } from "./payments.rails";
import { armWait } from "./waits";
import {
  daysBetween,
  effectiveStatus,
  getBillingStore,
  invoiceTotals,
  minorUnitExponent,
  paymentLinkFor,
} from "./billing";

/**
 * The wedge that chases, or undefined on an install where nothing claims the role.
 *
 * Returns `string | undefined` rather than throwing, because "this business does not chase invoices"
 * is a legitimate configuration — a bookkeeping-only install has no dunning wedge — and every caller
 * below has a truthful thing to do with the absence. It is `requireWedgeForRole`'s counterpart; see
 * roles.ts for why both exist.
 */
export function dunningWedge(): string | undefined {
  return wedgeForRole("dunning");
}

/** The task type of the SWEEP schedule. Not `chase_invoice` — that is what the sweep spawns. */
export const CHASE_SWEEP_TASK_TYPE = "chase_overdue_invoices";

/** The task type of one chase, the wedge's own. Declared in `wedges/invoice-chaser/wedge.json`. */
export const CHASE_TASK_TYPE = "chase_invoice";

/**
 * How often the sweep looks, by default. Hourly, not daily.
 *
 * The pacing above means this is a responsiveness knob and not an aggression knob: an invoice that
 * tips overdue at 00:01 is picked up within the hour instead of waiting for tomorrow's 09:30, and
 * `chaseIntervalDays` still refuses to chase it again for days.
 */
export const SWEEP_SECONDS = 3600;

/**
 * How many invoices one sweep will start runs for.
 *
 * Bounded for the same reason `advanceSequences` is: a project that imports two years of unpaid
 * invoices must not spawn eight hundred runs in one tick, blow through the day's model budget and
 * arrive in a client's inbox as a wall. The remainder is not lost — the query orders by
 * `last_chased_at` nulls first, so the ones passed over are exactly the ones the next sweep takes.
 */
export const BATCH = 25;

/**
 * The floor from the wedge's own policy: "Never chase the same invoice twice in 48h".
 *
 * Duplicated here as a NUMBER because that markdown is founder-editable knowledge read by a model,
 * and a rule that only exists in a prompt is a rule that holds most of the time. The prose decides
 * tone; this decides whether a request is made at all.
 */
export const MIN_CHASE_INTERVAL_DAYS = 2;

/**
 * Days between chases for an invoice this far overdue — the ladder in
 * `wedges/invoice-chaser/knowledge/dunning-policy.md`, as a cadence.
 *
 * The rungs are that file's, unchanged: 1–7 days is `reminder`, 8–21 is `firm_reminder`, 22+ is
 * `final_notice`. What is added here is how OFTEN each rung repeats, which the policy leaves
 * implicit, and the shape of the answer is deliberate: chasing gets SLOWER as it escalates, not
 * faster. A friendly nudge about a five-day-old invoice can reasonably repeat this week; a formal
 * final notice repeating twice a week is a debt collector, which is the thing the whole wedge's
 * knowledge is written to avoid.
 *
 * Pure — no clock, no I/O — so the ladder is unit-testable without waiting on time, the same
 * property `nextRun` and `next_step.mjs` have.
 */
export function chaseIntervalDays(daysOverdue: number): number {
  if (!Number.isFinite(daysOverdue)) return MIN_CHASE_INTERVAL_DAYS;
  if (daysOverdue <= 7) return 3;
  if (daysOverdue <= 21) return 5;
  return 7;
}

/**
 * The facts of a debt, as the wedge's `chase_invoice` task type expects them.
 *
 * Lives here rather than in the route so that the hand-pulled chase and the swept chase are
 * provably the same input. They were about to be two builders, and the field they would have
 * drifted on first is `days_overdue` — the single number `next_step` branches on to pick the rung.
 *
 * Every amount is minor units, never divided, never formatted. See the MONEY comment on `Invoice`.
 */
export function chaseTaskInput(
  inv: Invoice,
  today: string,
  confidence?: PaymentConfidence,
  gate?: LadderGate,
  offer?: PaymentOffer,
): Record<string, unknown> {
  const totals = invoiceTotals(inv);
  return {
    invoice_id: inv.id,
    invoice_number: inv.number,
    currency: inv.currency,
    minor_unit_exponent: minorUnitExponent(inv.currency),
    amount_due: totals.amount_due,
    amount_paid: totals.amount_paid,
    total: totals.total,
    issue_date: inv.issue_date,
    due_date: inv.due_date,
    days_overdue: chaseDaysOverdue(inv, today),
    partially_paid: totals.amount_paid > 0,
    payment_link_url: offer?.online?.url ?? paymentLinkFor(inv),
    /**
     * HOW THIS CLIENT CAN ACTUALLY PAY, in the order the rails are offered.
     *
     * Until rails existed the only pay method a chase could name was `payment_link_url` — a string
     * a founder pasted in. A chase toward a bank transfer or cash on collection had nothing to
     * point at, so the email asked for money and gave no way to send it. The offer is the same
     * object the invoice document and the portal render, so the three surfaces cannot disagree.
     */
    how_to_pay: offer
      ? {
          online: offer.online,
          blocks: offer.blocks,
          missing: offer.missing,
        }
      : undefined,
    note: inv.note,
    today,
    /**
     * How long since the last chase, or undefined if never. This is `next_step`'s
     * `last_chased_days_ago` input — the one that returns `hold` inside 48h — and until now nothing
     * could supply it, so the workflow's own duplicate-chase guard was dead code on every call.
     */
    last_chased_days_ago: inv.last_chased_at
      ? Math.max(0, daysBetween(inv.last_chased_at.slice(0, 10), today))
      : undefined,
    /**
     * HOW SURE WE ARE THAT THIS IS STILL UNPAID, travelling with the debt itself.
     *
     * `amount_due > 0` is a fact about our database, not about the client's bank. Until this field
     * existed, the agent writing the chase — and the human approving it — had no way to tell an
     * invoice we verified as unpaid ten minutes ago from one belonging to a business that has never
     * connected a payment provider and settles everything by bank transfer. Those two deserve very
     * different words and very different scrutiny, and the second is where "we notice your invoice
     * remains unpaid" gets sent to somebody who paid three weeks ago.
     *
     * It is in the task INPUT rather than only in the approval preview so the model can soften its
     * own copy on it, and in the preview (see `server.ts`) so the human can refuse on it.
     */
    payment_state: confidence
      ? {
          level: confidence.level,
          confirmed_at: confidence.confirmed_at,
          confirmed_hours_ago: confidence.age_hours,
          detail: confidence.detail,
        }
      : undefined,
    /**
     * WE ASKED THE FOUNDER WHETHER THIS WAS PAID, AND THIS IS WHAT CAME BACK.
     *
     * Only ever present when the ladder went ahead anyway — a blocked gate never reaches here,
     * because no run is spawned. So there are exactly two things this can say, and both change what
     * the agent should write and what the human at the approval gate should think:
     *
     *   · answered `not_paid` — the strongest signal in the whole input. A person looked and
     *     confirmed the debt, so the chase can be written with confidence rather than hedged.
     *   · asked and unanswered past the grace window — the weakest. We are escalating on nobody's
     *     say-so, and the words should carry that (and the approver should read it before clicking).
     *
     * Without this the two are indistinguishable from each other and from an invoice nobody ever
     * asked about, which would make the question decorative.
     */
    payment_question: gate?.question
      ? {
          asked_at: gate.question.asked_at,
          answer: gate.question.answer,
          answered_at: gate.question.answered_at,
          unanswered_hours: gate.unanswered_hours,
          grace_hours: QUESTION_GRACE_HOURS,
          detail: gate.detail,
        }
      : undefined,
  };
}

/** Whole days past due, clamped at zero. Zero when there is no due date at all. */
export function chaseDaysOverdue(inv: Pick<Invoice, "due_date">, today: string): number {
  return inv.due_date ? Math.max(0, daysBetween(inv.due_date, today)) : 0;
}

/**
 * What the sweep needs from the rest of the kernel.
 *
 * Injected rather than imported for the reason `InvoiceRouteDeps` is: spawning a run means clamping
 * constraints against the deployment's ceilings, and rendering a document means the brand kit, the
 * artifact backend and the event log. All of that lives in `server.ts`, and a sweep that reached
 * for it directly would drag the whole server graph into the scheduler.
 */
export interface ChaseDeps {
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
  attachInvoiceDocument(args: {
    task_id: string;
    invoice: Invoice;
    format: "pdf" | "svg";
    kind?: "invoice" | "receipt";
  }): Promise<unknown>;
  /**
   * Every chase run for this invoice that has not finished yet — queued, running, or parked on the
   * approval gate. Project-scoped by the implementation in `server.ts`; `project_id` is passed rather
   * than inferred so the query cannot be satisfied by an invoice id alone.
   *
   * Optional so the existing tests and any embedder that never adopted it keep working; `standDown`
   * degrades to a no-op and SAYS SO, rather than silently reporting a chase as cancelled.
   */
  openChasesFor?(args: { project_id: string; invoice_id: string }): Promise<string[]>;
}

/**
 * Stand down every chase in flight for an invoice, because it has just been paid.
 *
 * ═══ THE BUG THIS PREVENTS ═══
 *
 * A chase is not an instant. `startChase` spawns a run; the run writes the words; the send then sits
 * on `awaitApproval` — by default for up to five minutes, and in practice for however long it takes
 * a founder to look at their phone. Payment detection runs on its own clock. So the window between
 * "we decided to chase" and "the email leaves" routinely contains a payment, and until now nothing
 * closed it: the invoice would go `paid`, and the already-queued dunning email would be approved and
 * sent afterwards to the client who had just paid. That is the founder's question in its most
 * embarrassing form, and it is the one case where every earlier guard in this file has already been
 * passed legitimately.
 *
 * Two mechanisms, because a run can be in two different places:
 *
 *   · `markAbort(task, "cancelled")` — the orchestrator's `shouldAbort()` polls this on the run loop,
 *     so a run still thinking stops at its next checkpoint.
 *   · `failWaitersForTask(task, "rejected")` — a run already SUSPENDED on the approval gate is not
 *     polling anything and would sit there until its TTL, then possibly be approved by a human who
 *     has not noticed. This settles the gate as a rejection, which `awaitApproval` turns into a
 *     terminal task. This is the half that actually stops the email.
 *
 * Both are in-process (`cancel.ts` is a Map, `approvals.ts` a registry), so on a multi-replica
 * deployment this only reaches runs held by THIS process. That is a real limitation and it is named
 * here rather than hidden: the durable half of the defence is that the settled invoice fails
 * `effectiveStatus`/`amount_due` on any later chase, and that the approving human sees the invoice
 * is paid. Making cancellation cross-replica is the same Redis pub/sub note `cancel.ts` already
 * carries, and it should be done at the same time for both.
 */
export async function standDownChases(inv: Invoice, why: string): Promise<{ cancelled: string[]; reason?: string }> {
  if (!inv.project_id) throw new Error("standing down a chase must be scoped to a project");
  if (!deps?.openChasesFor) {
    // NOT a silent success. A caller that believes it cancelled a chase and did not is exactly the
    // failure-while-reporting-success shape this repo keeps paying for.
    return { cancelled: [], reason: "this deployment cannot look up in-flight chases, so none were stood down" };
  }
  const ids = await deps.openChasesFor({ project_id: inv.project_id, invoice_id: inv.id });
  for (const id of ids) {
    // Order matters. `markAbort` first, so that when the waiter resolves and the run wakes up, the
    // abort reason is already set and it cannot proceed to a send in between.
    markAbort(id, "cancelled");
    failWaitersForTask(id, "rejected");
  }
  if (ids.length) console.warn(`[mycel] stood down ${ids.length} chase(s) for invoice ${inv.number}: ${why}`);
  return { cancelled: ids };
}

/**
 * Registered once, by `mountInvoiceRoutes`, from the same deps object the manual chase route uses.
 *
 * Null until then, and a null here means the sweep does NOTHING — it does not fall back to a
 * simpler spawn, does not chase without a document. That is the fail-closed rule at the top of this
 * file applied to wiring: a kernel booted without the invoice routes mounted has no business
 * emailing anybody's clients.
 */
let deps: ChaseDeps | null = null;

export function setChaseDeps(d: ChaseDeps | null): void {
  deps = d;
}

/**
 * Put an invoice back on the list when the chase we started for it did nothing.
 *
 * Registered here — next to `startChase`, the only thing that ever takes this claim — rather than
 * discovered by the orchestrator, which knows nothing about invoices and should not learn. See the
 * registry note in promises.ts.
 *
 * Returns a sentence for the run's own feed, or undefined when there was nothing to give back:
 * a task with no claim receipt (spawned before this existed), or a row somebody has re-stamped
 * since, which the compare-and-set refuses on purpose.
 */
export async function releaseChaseClaim(task: { id: string; input?: Record<string, unknown> }): Promise<string | undefined> {
  const claim = task.input?.chase_claim as { claimed_at?: unknown; previously_chased_at?: unknown } | undefined;
  const invoiceId = typeof task.input?.invoice_id === "string" ? task.input.invoice_id : undefined;
  const claimedAt = typeof claim?.claimed_at === "string" ? claim.claimed_at : undefined;
  if (!invoiceId || !claimedAt) return undefined;
  const previous = typeof claim?.previously_chased_at === "string" ? claim.previously_chased_at : undefined;
  const released = await getBillingStore().releaseInvoiceChaseClaim(invoiceId, claimedAt, previous);
  return released
    ? "nothing was sent, so this invoice goes back on your list rather than counting as chased"
    : undefined;
}

registerClaimRelease(CHASE_TASK_TYPE, (task) => releaseChaseClaim(task));

/**
 * Is this invoice already parked on a live wait (pay OR next chase date)?
 *
 * Used by the sweep so a resume and a schedule tick cannot both fire a chase for the same debt.
 */
export async function isInvoiceChaseParked(projectId: string, invoiceId: string): Promise<boolean> {
  if (!projectId || !invoiceId) return false;
  const waits = await getDomainStore().listWaits({
    project_id: projectId,
    status: "waiting",
    limit: 200,
  });
  return waits.some((w) =>
    (w.conditions ?? []).some((c) => c.kind === "invoice_paid" && c.invoice_id === invoiceId),
  );
}

/**
 * After a chase send is approved (or auto-approved), park until they pay OR the next ladder date.
 *
 * ═══ THE CLOSED LOOP ═══
 *
 * Draft → approve → send → wait → escalate via schedule is the product claim for invoice chase.
 * Without this, the only continuity is `last_chased_at` pacing — invisible on `/next`, and blind to
 * a payment that arrives mid-window. A wait with `mode: "any"` on `invoice_paid` OR `date` is the
 * vision sentence: pause Tue, resume next week, never double-invoice (claim is still exactly-once).
 *
 * Best-effort: a missing case_id means we cannot park an engagement that does not exist, and failing
 * the approval because the wait could not arm would trade a sent chase for a stuck gate. Logged.
 */
export async function parkAfterChaseSend(task: {
  id?: string;
  project_id?: string;
  case_id?: string;
  task_type?: string;
  input?: Record<string, unknown>;
}): Promise<void> {
  if (task.task_type !== CHASE_TASK_TYPE) return;
  const projectId = task.project_id;
  const invoiceId = typeof task.input?.invoice_id === "string" ? task.input.invoice_id : undefined;
  if (!projectId || !invoiceId) return;

  const inv = await getBillingStore().getInvoice(invoiceId);
  if (!inv || inv.project_id !== projectId) return;
  // Prefer the run's case; fall back to the invoice's engagement. No case → nothing to park.
  const caseId = task.case_id ?? inv.case_id;
  if (!caseId) {
    console.warn(
      `[mycel] chase ${task.id ?? "?"} approved for ${inv.number} but has no case — cannot park wait/resume`,
    );
    return;
  }

  if (await isInvoiceChaseParked(projectId, invoiceId)) return;

  const today = new Date().toISOString().slice(0, 10);
  const overdue = chaseDaysOverdue(inv, today);
  const days = chaseIntervalDays(overdue);
  const nextAt = new Date(Date.now() + days * 86_400_000).toISOString();

  const armed = await armWait(getDomainStore(), {
    project_id: projectId,
    case_id: caseId,
    reason: `waiting for payment on ${inv.number}, or the next chase on ${nextAt.slice(0, 10)}`,
    mode: "any",
    conditions: [
      { kind: "invoice_paid", invoice_id: invoiceId, label: inv.number },
      { kind: "date", at: nextAt, label: `next chase ${nextAt.slice(0, 10)}` },
    ],
    resume: {
      task_type: CHASE_TASK_TYPE,
      input: { invoice_id: invoiceId, because_of_chase_wait: true },
    },
    // Nudges for dunning are the ladder itself — a second nudge ladder here would double-message.
    max_nudges: 0,
  });

  if (!armed.ok) {
    // Already waiting on something else for this case is survivable; other refusals are logged.
    console.warn(`[mycel] could not park chase wait for ${inv.number}: ${armed.error}`);
  }
}

/**
 * Why a chase did not start. Machine codes, so a UI can say something true rather than "error".
 *
 * `paced` is not a failure. It is the ladder holding, and the founder-facing sentence has to say so
 * — a button that reports "something went wrong" when the honest answer is "we chased this
 * yesterday and the policy says wait" teaches a founder to distrust the policy.
 */
export type ChaseRefusal =
  | "not_configured"
  /**
   * No wedge on this install DECLARES the dunning role — distinct from `wedge_disabled`, which is a
   * wedge that exists and is switched off for this project. Two different sentences and two different
   * fixes (install a chasing wedge vs enable the one you have), and collapsing them into one refusal
   * would send a founder to a settings screen that cannot help him.
   */
  | "no_dunning_wedge"
  | "wedge_disabled"
  | "not_chaseable"
  | "nothing_outstanding"
  | "paced"
  /**
   * A payment provider IS connected to this business and we cannot currently see it, so we do not
   * know whether this invoice has been paid — and an automatic ladder must not send on that.
   *
   * Distinct from every other refusal here because it is the only one that is about OUR state rather
   * than the invoice's, and because the fix is a founder's (reconnect Stripe) rather than a
   * client's. A human clicking Chase still gets through; see `startChase`.
   */
  | "payment_state_stale"
  /**
   * We have asked the founder whether this invoice has already been paid, and are waiting.
   *
   * Not a failure and not an error — it is the product asking a question instead of guessing, which
   * is the whole point of `paymentQuestionGate`. It is BOUNDED: after `QUESTION_GRACE_HOURS` the
   * ladder escalates regardless, so this can delay a chase but can never cancel one. See the long
   * note in payments.manual.ts for why a permanent halt would be the worse bug.
   */
  | "awaiting_payment_answer"
  /**
   * NOTHING IN THIS BUSINESS CAN SEND THE CHASE — so there is no point writing one.
   *
   * ═══ THE PRODUCTION FAILURE THIS REFUSAL EXISTS FOR ═══
   *
   * Observed on 2026-08-10 against project `3dd801ba`. That project has ZERO connection rows, so
   * `capabilityConnections` resolved `send_email` to nothing, so `runOpenCodeTask` never printed
   * its "Taking real-world actions" block, so the agent was never told the action proxy existed.
   * It drafted `{"step":…,"channel":"email","message":…}`, the output validated, the run went
   * `succeeded` — and `awaitApproval` was never reached. The `approvals` table in production held
   * ZERO ROWS, account-wide, at the time this was written. Meanwhile the founder had been told
   * "the draft will be waiting for you in Approvals", and `last_chased_at` had been stamped 37ms
   * BEFORE the task row was even created, so `chaseMove` stopped proposing a $4,800 unpaid invoice.
   *
   * A promise, unkept, reported as success, with the retry affordance removed. All from one
   * missing mailbox that nothing checked for.
   *
   * ═══ WHY REFUSING BEATS DEGRADING TO A DRAFT ═══
   *
   * `capabilityConnections` documents the opposite policy — "an install with no mailbox connected
   * is a legitimate install, and the run degrades to drafting" — and for most task types that is
   * right: a run that reads, decides and files something is still worth its cost with no outbound
   * hands. A chase is not one of those. Its entire deliverable is a message in a client's inbox.
   * A chase that cannot send is not a partial chase, it is a paid-for model call that produces a
   * paragraph nobody will ever read, and it burns the ladder claim on the way past.
   *
   * So this is checked BEFORE `claimInvoiceForChase`, not after. Refusing after the claim would
   * still bury the invoice for a ladder interval, which is the half of the bug that hurt.
   */
  | "cannot_send"
  /**
   * A wait is already live on this invoice (payment OR next ladder date). The sweep must not start
   * a second chase while that engagement is parked — that is the double-invoice bug with a nicer
   * name. Distinct from `paced` (ladder interval on `last_chased_at`) so operators can tell "we
   * chased recently" from "we are waiting on them".
   */
  | "waiting_on_client"
  | "spawn_failed";

export type ChaseStart =
  | {
      ok: true;
      task_id: string;
      invoice_id: string;
      document: unknown;
      /**
       * WHY THERE IS NO INVOICE ATTACHED — present only when there was supposed to be one.
       *
       * `document: null` used to be the whole story, and it told two completely different stories in
       * the same three characters: "this deployment renders no PDFs" and "rendering this one was
       * REFUSED because the brand kit belongs to another tenant". The attach was a
       * `.catch(() => undefined)` and the chase still reported `{ok: true}`, so a chase that went out
       * with nothing enclosed looked exactly like a chase that went out complete. A client reading
       * "please see the attached invoice" with no attachment is the visible half of that; the
       * invisible half is that nobody ever found out why.
       */
      document_error?: string;
    }
  | { ok: false; reason: ChaseRefusal; message: string };

/**
 * Start ONE chase. The single implementation, called by all three doors into it.
 *
 * ═══ WHY THIS FUNCTION EXISTS ═══
 *
 * There were two copies of "chase this invoice": the body of `POST /v1/invoices/:id/chase` and the
 * loop in `sweepOverdueInvoices`. They agreed only because `chaseTaskInput` was shared, and the
 * agreement was already partial — the sweep attaches the PDF from the CLAIMED row and the route from
 * the pre-claim row, which is the same invoice but not the same code. Adding a third caller (a move
 * taken from `/next`) by copying the route's body a second time is how the fourth one ends up
 * chasing on a different rung. So the body moved here and every caller is now provably one run:
 * same wedge, same task type, same input builder, same enclosure, same refusals.
 *
 * ═══ `pacing` IS THE ONE THING CALLERS DISAGREE ABOUT, AND THEY SHOULD ═══
 *
 *   · `"ladder"` — claim only if `chaseIntervalDays` has elapsed. What the sweep does, and what
 *     taking a move from the next-move list does. It is also what makes taking a move IDEMPOTENT:
 *     the claim is a compare-and-set on `last_chased_at`, so the second click inside the window
 *     loses the claim and no second run is spawned. A move id is stable across reads, so without
 *     this a founder double-clicking a row would put two dunning emails in one inbox.
 *
 *   · `"override"` — stamp unconditionally and chase anyway. What the Invoices page's Chase button
 *     does, and it must keep doing it: a founder who goes to an invoice and clicks Chase has decided
 *     something the ladder cannot know, and a button that silently declines is worse than a
 *     duplicate email. The stamp still happens so the hourly sweep SEES it and does not add a second
 *     email an hour later.
 *
 * The input is built from `inv` — the row as it was BEFORE the claim stamped it. `chaseTaskInput`
 * derives `last_chased_days_ago` from `last_chased_at`, and `next_step` returns `hold` when that is
 * under 2; building it from the stamped row would tell the workflow this invoice was chased zero
 * days ago (by this very run) and every chase would decline itself.
 *
 * NOTHING SENDS HERE. This spawns a run. The words, and the decision to put them in front of a real
 * client, are the agent's — and the agent's send goes through `awaitApproval` like every other
 * consequence. Starting a chase enqueues work; it does not dispatch it.
 */
/**
 * Will the run we are about to spawn have anything to send with?
 *
 * ═══ IT ASKS THE QUESTION THE RUN WILL ASK, WITH THE RUN'S OWN FUNCTIONS ═══
 *
 * `capabilityConnections` and `selectGrantableConnections` are imported from runtime.ts rather than
 * re-implemented, because a second opinion about which mailbox a chase may use is exactly how this
 * gate ends up refusing a chase the run could have sent, or waving through one it cannot. This is
 * the same composition `runOpenCodeTask` performs — capabilities, then the wedge's named
 * connections, then the client-entitlement filter — minus `task.input.connections`, which does not
 * exist yet at this point and which `chaseTaskInput` never sets.
 *
 * ═══ IT IS NOT A CAPABILITY CHECK ALONE ═══
 *
 * A client-owned mailbox is granted automatically by `selectGrantableConnections` and is invisible
 * to `resolveCapability` (founder-owned only, deliberately). Checking capabilities alone would
 * refuse chases for exactly the businesses that operate a client's own inbox on their behalf.
 *
 * ═══ IT FAILS OPEN ON AN UNREADABLE CONNECTION STORE ═══
 *
 * A store that throws means we do not know, and "we do not know" must not become an accounts-
 * receivable outage that nobody notices — the same trade `paymentQuestionGate` makes one screen
 * down. The run then either sends (fine) or is caught by `assertSendPromiseKept` at the end
 * (honest). What this gate exists to stop is the KNOWN-empty case, which is what production had.
 *
 * ═══ COST ═══
 *
 * One connection read per invoice that has already passed every money and status check — at most
 * `BATCH` per project per sweep, and zero for a project with nothing overdue. Not hoisted out of
 * the loop deliberately: the answer depends on `inv.client_id`, because a client-owned mailbox is
 * granted for that client's invoices and nobody else's, so a per-project answer would be wrong in
 * the direction that sends a chase through the wrong customer's account.
 */
export async function chaseHands(
  inv: Invoice,
  /**
   * The project's connections, when the caller has already read them.
   *
   * Exists for `proposeMoves`, which asks this question about every overdue invoice on a founder's
   * home page at once and would otherwise issue one connection read per row to get the same answer
   * each time. The per-invoice evaluation below still runs per invoice — it depends on
   * `inv.client_id`, because a client-owned mailbox is granted for that client's invoices and
   * nobody else's — so hoisting the READ is safe in a way that hoisting the ANSWER is not.
   *
   * Not a required argument: the sweep's own call site is one invoice at a time, and making every
   * caller pre-read connections to ask "can we send?" is how a gate stops being called.
   */
  preloaded?: readonly Connection[],
): Promise<{ ok: true } | { ok: false; message: string }> {
  const wedge = dunningWedge();
  const manifest = wedge ? loadWedge(wedge)?.manifest : undefined;
  let all;
  try {
    all = (preloaded ?? (await getDomainStore().listConnections())).filter(
      (c) => c.project_id === inv.project_id,
    );
  } catch (e) {
    console.error(`[mycel] could not read connections for project ${inv.project_id}:`, e);
    return { ok: true };
  }
  const byCapability = capabilityConnections(manifest?.capabilities ?? [], all, inv.project_id);
  const wanted = new Set<string>([...byCapability.ids, ...(manifest?.connections ?? [])]);
  const grantable = selectGrantableConnections(all, wanted, inv.project_id, inv.client_id);
  if (grantable.length) return { ok: true };

  // A sentence about the founder's business, not about ours. No machinery words — see narration.ts.
  return {
    ok: false,
    message:
      `Not chasing ${inv.number}: this business has no mailbox connected, so the reminder could be ` +
      `written but never sent and nothing would reach your client. Connect the email account you ` +
      `invoice from and this will start on its own.`,
  };
}

export async function startChase(
  inv: Invoice,
  opts: { pacing: "ladder" | "override"; now?: Date },
): Promise<ChaseStart> {
  const now = opts.now ?? new Date();
  const today = now.toISOString().slice(0, 10);

  // Fail closed on wiring, exactly as the sweep does. A kernel booted without the invoice routes
  // mounted has no business emailing anybody's clients.
  if (!deps) return { ok: false, reason: "not_configured", message: "Invoicing is not wired up in this deployment." };

  // TWO GATES, IN THIS ORDER, AND THEY ASK DIFFERENT QUESTIONS. First: does any wedge on this
  // INSTALL declare the dunning role (a fact about `wedges/` on disk). Second: is that wedge enabled
  // for THIS PROJECT (tenant data, project id required and never defaulted — see the fail-closed note
  // at the top of this file). Skipping the first is what spawned chases for a wedge that was not
  // installed; skipping the second is what mails another tenant's clients.
  const wedge = dunningWedge();
  if (!wedge) {
    return { ok: false, reason: "no_dunning_wedge", message: `Nothing here chases invoices: ${whyNoWedge("dunning")}.` };
  }
  if (!deps.wedgeEnabled(inv.project_id, wedge)) {
    return { ok: false, reason: "wedge_disabled", message: `The ${wedge} wedge is not enabled for this business.` };
  }

  // The same three refusals every door makes: chasing a draft is chasing something the client has
  // never seen, chasing a settled or void invoice is a dunning email about money that is not owed,
  // and chasing a zero balance is both.
  const status = effectiveStatus(inv, today);
  if (status !== "sent" && status !== "overdue") {
    return { ok: false, reason: "not_chaseable", message: `An invoice that is ${status} cannot be chased.` };
  }
  if (invoiceTotals(inv).amount_due <= 0) {
    return { ok: false, reason: "nothing_outstanding", message: "Nothing is outstanding on that invoice." };
  }

  // CAN THIS BUSINESS ACTUALLY SEND THE THING? Before the claim, always — see `cannot_send`.
  const hands = await chaseHands(inv);
  if (!hands.ok) return { ok: false, reason: "cannot_send", message: hands.message };

  // Already parked on pay-or-date? The ladder must not start a parallel chase.
  if (opts.pacing === "ladder" && (await isInvoiceChaseParked(inv.project_id, inv.id))) {
    return {
      ok: false,
      reason: "waiting_on_client",
      message: `${inv.number} is waiting for payment or the next chase date — not starting another chase.`,
    };
  }

  /**
   * ═══ THE STALENESS RULE ═══
   *
   * Every check above this line asks a question about our own database, and our own database only
   * changes when someone tells it about a payment. So all of them together still permit the exact
   * failure the founder asked about: an invoice paid in the real world, chased by us.
   *
   * `paymentConfidence` is the one check that asks how recently anybody actually LOOKED, and the
   * asymmetry in what we do about it is deliberate and defended at length on that function:
   *
   *   · `fresh` and `unverifiable` proceed. `unverifiable` — no provider connected at all, which is
   *     most small businesses — proceeds because halting there would make the product quietly stop
   *     working for them, and because the honest uncertainty travels on to the human at the approval
   *     gate instead of being hidden.
   *
   *   · `stale` and `unknown` stop the LADDER. Both mean a provider is connected and we are blind to
   *     it right now, which is precisely the state in which our "unpaid" is most likely to be wrong
   *     in the direction that damages a client relationship.
   *
   * A HUMAN CLICKING CHASE STILL GOES THROUGH (`pacing: "override"`). That is the same judgement the
   * override already encodes everywhere else in this file: a founder who navigated to this invoice
   * knows things the ladder does not — including, often, that they just spoke to the client. What
   * they get instead of a refusal is the confidence written into the run's input and preview, so the
   * uncertainty is in front of them rather than swallowed.
   */
  const confidence = await paymentConfidence(inv.project_id, now).catch((e) => {
    // A confidence read that throws must not be read as confidence. Fail toward not sending.
    console.error(`[mycel] could not read payment confidence for project ${inv.project_id}:`, e);
    return {
      level: "unknown" as const,
      detail: "the payment-state check could not be read at all",
      safe_to_chase_automatically: false,
    } satisfies PaymentConfidence;
  });
  if (opts.pacing === "ladder" && !confidence.safe_to_chase_automatically) {
    return {
      ok: false,
      reason: "payment_state_stale",
      message: `Not chasing ${inv.number} automatically: ${confidence.detail}.`,
    };
  }

  /**
   * ═══ ASK, DON'T GUESS ═══
   *
   * The staleness rule above lets `unverifiable` through, and it is right to: a business with no
   * payment provider — most of them — would otherwise be silently stopped from chasing anything at
   * all. But "proceed" and "escalate without ever asking" are not the same thing. For those
   * businesses our belief that an invoice is unpaid rests on nothing but the absence of a human
   * telling us otherwise, and before the ladder moves to a firmer rung it is worth one question.
   *
   * `paymentQuestionGate` decides, and it only ever holds an ESCALATION (never a first reminder) and
   * only for `QUESTION_GRACE_HOURS`. Ladder only: a founder clicking Chase has answered the question
   * by clicking it.
   *
   * A gate that throws is treated as "carry on", NOT as "hold". The invoice question is an
   * improvement to a chase that would otherwise have gone out; a bug in the question mechanism must
   * not become an accounts-receivable outage that nobody notices, which is the failure mode this
   * whole subsystem exists to avoid.
   */
  let questionGate: LadderGate | undefined;
  if (opts.pacing === "ladder") {
    questionGate = await paymentQuestionGate(inv, now).catch((e) => {
      console.error(`[mycel] the payment question gate failed for invoice ${inv.id}:`, e);
      return undefined;
    });
    if (questionGate?.blocked) {
      return { ok: false, reason: "awaiting_payment_answer", message: `Holding ${inv.number}: ${questionGate.detail}.` };
    }
  }

  const nowIso = now.toISOString();
  /**
   * Read BEFORE the claim, and that is not paranoia. `InMemoryBillingStore.claimInvoiceForChase`
   * mutates the very object callers hold, so `inv.last_chased_at` read after the claim is the stamp
   * this run just wrote — and a release built from it would restore the claim it was undoing,
   * leaving the invoice permanently marked as chased by a chase that did nothing. The Postgres
   * store returns a fresh row and would not have shown this, which is exactly why it is pinned by a
   * test rather than left to whichever store happens to be configured.
   */
  const previouslyChasedAt = inv.last_chased_at ?? null;
  const overdue = chaseDaysOverdue(inv, today);
  const notChasedSince =
    opts.pacing === "override"
      ? // `now` as the floor makes the claim unconditional: record, don't gate.
        nowIso
      : new Date(now.getTime() - chaseIntervalDays(overdue) * 86_400_000).toISOString();
  const claimed = await getBillingStore().claimInvoiceForChase(inv.id, notChasedSince, nowIso);
  if (!claimed) {
    return {
      ok: false,
      reason: "paced",
      message: `${inv.number} was chased recently — the dunning ladder allows another in ${chaseIntervalDays(overdue)} day(s).`,
    };
  }

  try {
    const taskId = await deps.spawnTask({
      project_id: claimed.project_id,
      wedge,
      task_type: CHASE_TASK_TYPE,
      client_id: claimed.client_id,
      case_id: claimed.case_id,
      // `schedule` when the ladder decided on its own, `api` when a person asked. An operator
      // reading the task list needs to tell "the sweep did this" from "someone clicked chase".
      source: opts.pacing === "override" ? "api" : "schedule",
      input: {
        ...chaseTaskInput(
          inv,
          today,
          confidence,
          questionGate,
          await howToPay(inv).catch((e) => {
            console.error(`[mycel] could not attach how-to-pay to the chase for invoice ${inv.id}:`, e);
            return undefined;
          }),
        ),
        /**
         * THE RECEIPT FOR THE CLAIM THIS RUN IS HOLDING — so a run that does nothing can give it
         * back. Read only by `releaseChaseClaim`; see promises.ts for the production failure.
         *
         * On the task INPUT rather than in a side table because it must survive a process restart
         * and a different replica finishing the run, and the task row is the one thing that
         * certainly does. It carries no information the agent does not already have: `invoice_id`
         * and `last_chased_days_ago` are sitting next to it.
         */
        chase_claim: { claimed_at: nowIso, previously_chased_at: previouslyChasedAt },
      },
    });
    // The document the chase is about, attached to the run that will send it. A render failure must
    // not lose the run — the chase is the point, the PDF is an enclosure — but it must not be
    // SWALLOWED either. This was `.catch(() => undefined)` and returned `{ok: true, document: null}`,
    // so a chase with nothing attached was indistinguishable from a healthy one, and the operator's
    // only clue was the client asking where the invoice was. The run still starts; the reason is
    // now carried out with it and logged. See `document_error` on ChaseStart.
    let document: unknown;
    let documentError: string | undefined;
    try {
      document = await deps.attachInvoiceDocument({ task_id: taskId, invoice: claimed, format: "pdf" });
    } catch (e) {
      documentError = String((e as Error)?.message ?? e).slice(0, 300);
      console.error(`[mycel] chase ${taskId} for invoice ${inv.id} has no invoice attached:`, e);
    }
    return {
      ok: true,
      task_id: taskId,
      invoice_id: inv.id,
      document: document ?? null,
      ...(documentError ? { document_error: documentError } : {}),
    };
  } catch (e) {
    console.error(`[mycel] failed to start a chase for invoice ${inv.id}:`, e);
    // A won claim that then fails to spawn is NOT rolled back — the invoice waits out one interval.
    // The failure mode of a claim that releases on error is two replicas racing the release, and a
    // missed chase is cheaper than a duplicate one.
    return { ok: false, reason: "spawn_failed", message: "The chase could not be started. It will be retried by the next sweep." };
  }
}

export interface SweepSummary {
  project_id: string;
  /** Invoices the sweep looked at. */
  considered: number;
  /** Runs actually started. */
  chased: number;
  /** Passed over because the pacing window has not elapsed, or another replica held the claim. */
  paced: number;
  /**
   * Held because we have asked the founder whether these were already paid and are still waiting.
   *
   * Its own counter rather than part of `skipped`, because it is the only line in this summary that
   * is waiting on a PERSON. An operator looking at a sweep that chased nothing needs to tell "there
   * was nothing to chase" from "eleven questions are sitting unanswered on somebody's screen" — the
   * second has an action attached to it and the first does not. It also cannot grow without bound:
   * the grace window expires and these become `chased`.
   */
  awaiting_answer: number;
  /**
   * Overdue, due a chase, and refused because nothing in this business can send it.
   *
   * ITS OWN COUNTER, not part of `skipped`. Before this, a project with no mailbox connected swept
   * cleanly and reported `skipped: 11` — the same number it reports for eleven paid invoices — and
   * that is how a business with £40k outstanding and no way to chase any of it looked healthy on
   * every screen we had. This is the only line in the summary whose fix is one click by the founder.
   */
  cannot_send: number;
  /** Parked on a live wait (payment or next ladder date) — see `waiting_on_client`. */
  waiting_on_client: number;
  /** Not chaseable: draft, paid, void, nothing outstanding, or not yet due. */
  skipped: number;
  /** Invoice ids whose run failed to spawn. They wait out one interval; see `claimInvoiceForChase`. */
  failed: string[];
  /**
   * Invoice ids chased WITHOUT the invoice attached — the render or the attach was refused.
   *
   * A separate list from `failed` because these runs started and will write a chase; what they will
   * not do is enclose the document the chase is about. This used to be a `.catch(() => undefined)`
   * inside `startChase` returning `{ok: true, document: null}`, which made "this deployment renders
   * no PDFs" and "the brand kit belongs to another tenant and was refused" the same three characters.
   */
  no_document: string[];
  /**
   * Why this sweep read no rows at all, when that is the case. Absent on a sweep that ran.
   *
   * ─── WHY A FIELD AND NOT A BARE `return summary` ───
   *
   * All three early exits used to return an all-zeroes summary, which the scheduler logs as a
   * successful sweep that found nothing to chase. That is indistinguishable from "every invoice is
   * paid" and it is this repo's recurring bug: failing while reporting success. An operator looking at
   * a business with £40k outstanding and a sweep reporting `considered: 0` needs the sentence, and the
   * newly possible cause — no wedge on this install declares the dunning role — is one a founder can
   * actually act on.
   */
  skipped_because?: string;
}

/**
 * Sweep one project's overdue invoices and start a chase for each one that is due one.
 *
 * `project_id` is a required field of a required argument. There is no overload that sweeps
 * everything, and adding one would mean a single misconfigured schedule mailing every tenant's
 * clients from one project's connection.
 */
export async function sweepOverdueInvoices(args: {
  project_id: string;
  now?: Date;
}): Promise<SweepSummary> {
  const now = args.now ?? new Date();
  const summary: SweepSummary = {
    project_id: args.project_id,
    considered: 0,
    chased: 0,
    paced: 0,
    awaiting_answer: 0,
    cannot_send: 0,
    waiting_on_client: 0,
    skipped: 0,
    failed: [],
    no_document: [],
  };
  if (!args.project_id) throw new Error("a dunning sweep must be scoped to a project");
  // All three fail-closed gates, before a single row is read. Each names itself in the summary rather
  // than returning a silent all-zeroes — see `skipped_because`.
  if (!deps) return { ...summary, skipped_because: "invoicing is not wired up in this deployment" };
  const wedge = dunningWedge();
  if (!wedge) return { ...summary, skipped_because: whyNoWedge("dunning") };
  if (!deps.wedgeEnabled(args.project_id, wedge)) {
    return { ...summary, skipped_because: `the ${wedge} wedge is not enabled for this business` };
  }

  const billing = getBillingStore();
  const today = now.toISOString().slice(0, 10);

  // Both live statuses. `overdue` is normally DERIVED (`effectiveStatus`) and the stored status
  // stays `sent`, but an operator may flag one overdue early — and a sweep that queried only `sent`
  // would then never chase precisely the invoices someone thought worth flagging.
  const rows = [
    ...(await billing.listInvoices({ project_id: args.project_id, status: "sent", limit: 500 })),
    ...(await billing.listInvoices({ project_id: args.project_id, status: "overdue", limit: 500 })),
  ];
  // Least recently chased first, never-chased before that. Under a backlog bigger than BATCH this
  // is what makes successive sweeps fair instead of re-serving the same head of the list forever.
  rows.sort((a, b) => (a.last_chased_at ?? "") .localeCompare(b.last_chased_at ?? ""));

  for (const inv of rows) {
    if (summary.chased >= BATCH) break;
    summary.considered++;

    // Nothing is chased on or before its due date. `effectiveStatus` calls an unpaid invoice `sent`
    // until the due date passes, but an invoice with NO due date is `sent` forever — and chasing one
    // is chasing a debt with no agreed date, which is the founder's conversation and not the
    // agent's. Checked here rather than in `startChase` because a hand-pulled chase on a
    // no-due-date invoice is a founder's judgement to make; a sweep's is not.
    if (chaseDaysOverdue(inv, today) < 1) { summary.skipped++; continue; }

    // ONE implementation of "chase this invoice", shared with the manual route and with taking a
    // move off the next-move list. See `startChase` for why that had to stop being three copies.
    const started = await startChase(inv, { pacing: "ladder", now });
    if (started.ok) {
      summary.chased++;
      // A chase that went out with no invoice enclosed is counted, not swallowed. It is not a failed
      // sweep — the run started and the words will be written — but "we chased twelve" and "we
      // chased twelve, none of them carrying the invoice" are different facts about a business's
      // receivables and used to be the same number.
      if (started.document_error) summary.no_document.push(inv.id);
      continue;
    }
    if (started.reason === "paced") { summary.paced++; continue; }
    if (started.reason === "awaiting_payment_answer") { summary.awaiting_answer++; continue; }
    if (started.reason === "spawn_failed") { summary.failed.push(inv.id); continue; }
    if (started.reason === "cannot_send") { summary.cannot_send++; continue; }
    if (started.reason === "waiting_on_client") { summary.waiting_on_client++; continue; }
    summary.skipped++;
  }
  /**
   * A sweep that chased nothing BECAUSE it has no hands says so, in the field an operator already
   * reads for "why was this sweep empty". Without it the only trace is a counter nobody looks at.
   */
  if (!summary.chased && summary.cannot_send) {
    summary.skipped_because =
      `${summary.cannot_send} invoice(s) are due a chase and this business has no mailbox connected, ` +
      `so none were written — a reminder nobody can send is not a chase`;
  }
  return summary;
}

/**
 * Create (or find) the sweeping Schedule for a project.
 *
 * One per project. The scheduler's `claimDueSchedules` does the rest — including the guarantee that
 * with four replicas exactly one of them fires each tick. Modelled on `ensureSequenceSchedule`, and
 * it throws on an empty project id for the same reason that one does.
 */
export async function ensureDunningSchedule(
  domain: DomainStore,
  projectId: string,
  now: Date = new Date(),
): Promise<Schedule> {
  if (!projectId) throw new Error("a dunning schedule must be scoped to a project");
  // THROWS where the sweep degrades, and the asymmetry is the decision. Sweeping is a clock tick over
  // an install we did not choose; creating this schedule is somebody asking for AR chasing (a
  // blueprint provision, an API call). Writing a Schedule whose `wedge` names nothing installed would
  // put a row on `/clock` that fires forever and can never chase anything — a configured feature that
  // does not exist, which is the failure this whole module is against.
  const wedge = dunningWedge();
  if (!wedge) throw new Error(`cannot schedule an overdue invoice sweep: ${whyNoWedge("dunning")}`);
  const existing = (await domain.listSchedules()).find(
    (s) => s.project_id === projectId && s.task_type === CHASE_SWEEP_TASK_TYPE,
  );
  if (existing) return existing;
  return domain.createSchedule({
    project_id: projectId,
    name: "overdue invoice sweep",
    wedge,
    task_type: CHASE_SWEEP_TASK_TYPE,
    input: {},
    cadence: { kind: "every", seconds: SWEEP_SECONDS },
    enabled: true,
    next_run_at: new Date(now.getTime() + SWEEP_SECONDS * 1000).toISOString(),
  });
}
