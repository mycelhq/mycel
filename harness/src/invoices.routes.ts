// The accounts-receivable surface — founder CRUD and the client's own view of what they owe.
//
// billing.ts / billing.pg.ts were complete, tested and UNREACHABLE: `initBillingStore()` was called
// by no non-test file, and there were no `/v1/invoices*` routes at all. A correct money model that
// nothing can reach is not a feature, and the invoice-chaser was meanwhile being handed the facts of
// an invoice as FREE TEXT in a task input — so the agent was chasing whatever a human had typed,
// with no amount it could verify, no currency it could format and nothing to mark paid afterwards.
// `POST /v1/invoices/:id/chase` at the bottom of this file is the fix for that half.
//
// Every amount that crosses this boundary is a whole number of minor units. Read the MONEY comment
// on `Invoice` in contract.ts. Nothing here divides.
import { randomUUID } from "node:crypto";
import type { Hono } from "hono";
import type { Invoice, InvoiceStatus, TaskSource } from "./contract";
import {
  canTransition,
  daysBetween,
  effectiveStatus,
  getBillingStore,
  INVOICE_TRANSITIONS,
  invoiceTotals,
  isPaymentMethod,
  minorUnitExponent,
  normalizeLines,
  paymentLinkFor,
} from "./billing";
import {
  answerPaymentQuestion,
  getPaymentInstructions,
  listPaymentQuestions,
  recordManualPayment,
  setPaymentInstructions,
  setReceiptDeps,
  startReceipt,
} from "./payments.manual";
import {
  emptyRails,
  getPaymentRails,
  howToPay,
  offerLines,
  sellerMissingSentence,
  setPaymentRails,
} from "./payments.rails";
import { ensureStripeCheckout, setCheckoutDeps } from "./payments.stripe";
import { setChaseDeps, standDownChases, startChase } from "./dunning";
import { paymentConfidence, reconcileProject, setReconcileDeps } from "./payments";
import {
  calendarSyncConfidence,
  crmImportConfidence,
  importCrmClients,
  setImportDeps,
  syncCalendar,
} from "./capability-import";
import { executeAction } from "./actions";
import { planSendEmail } from "./capabilities.act";
import { readMoneyPlan } from "./money-plan";
import {
  nextRetainerDue,
  retainerLines,
  setRetainer,
  sweepRetainers,
} from "./money-plan.retainer";
import { noteInvoiceSettled, systemMoveAuthority } from "./moves";
import { ensureUpkeepQuietly } from "./upkeep";
import { getDomainStore } from "./domain";
import { getIdentityStore, invoicingRefusal } from "./identity";
import type { ClientScope } from "./portal";

/**
 * Re-exported: this was defined here, and moved into `billing.ts` when the dunning sweep needed the
 * same function. Its callers and its test are unchanged, and there is still exactly one
 * implementation of "how many days between these two dates" — which is the whole point of moving it.
 */
export { daysBetween };

export interface InvoiceRouteDeps {
  /** The projects the caller may READ. Fails closed; see `identity.accessibleProjectIds`. */
  accessible(c: any): Set<string>;
  /** The project a write lands in, or undefined when the caller named none. */
  writeProjectId(c: any): string | undefined;
  clientInProject(clientId: string, projectId: string): Promise<boolean>;
  /** Does this project have this wedge enabled? The chase route refuses otherwise. */
  wedgeEnabled(projectId: string, wedge: string): boolean;
  /** Create + enqueue a run. Injected so constraint clamping stays in one place (server.ts). */
  spawnTask(args: {
    project_id: string;
    wedge: string;
    task_type: string;
    client_id?: string;
    case_id?: string;
    source: TaskSource;
    input: Record<string, unknown>;
  }): Promise<string>;
  /**
   * Render this invoice as a branded document and attach it to a run.
   *
   * Injected for the same reason `spawnTask` is: this file knows about money and nothing else, and
   * the store, the artifact backend, the brand kit and the event log all live in server.ts.
   * Returns undefined when the task does not exist or belongs to another project.
   */
  attachInvoiceDocument(args: {
    task_id: string;
    invoice: Invoice;
    format: "pdf" | "svg";
    /**
     * Which document. Optional and defaulting to `invoice`, so every existing caller is unchanged —
     * and named here rather than split into a second dep because the authorisation, the brand kit,
     * the artifact write and the event are identical for both. Two functions would be two places to
     * forget the tenant check on `task_id`.
     */
    kind?: "invoice" | "receipt";
  }): Promise<{ artifact_id: string; name: string; content_type: string; size_bytes: number } | undefined>;
  /**
   * The unfinished chase runs for one invoice, project-scoped.
   *
   * Injected rather than reached for because `Store.listTasks` has no project filter — it takes
   * status/wedge/client_id — so the tenant check has to be applied by the implementation in
   * server.ts, which holds the store. `dunning.ts` calls this to stand a chase down when a payment
   * lands; see `standDownChases` for what it does with the ids and why it must happen before the
   * invoice's status changes.
   *
   * Optional: an embedder that has not supplied it gets a stand-down that reports honestly that it
   * cancelled nothing, rather than one that pretends.
   */
  openChasesFor?(args: { project_id: string; invoice_id: string }): Promise<string[]>;
}

/**
 * The founder's view: everything, plus the derived numbers.
 *
 * `effectiveStatus` is computed on read rather than swept by a job, so the portal and the chaser
 * agree the moment midnight passes. `status` stays the stored value alongside it — an operator who
 * flagged something overdue early must still see that they did.
 */
function withTotals(inv: Invoice) {
  return {
    ...inv,
    totals: invoiceTotals(inv),
    effective_status: effectiveStatus(inv),
    minor_unit_exponent: minorUnitExponent(inv.currency),
  };
}

/**
 * What crosses to the client.
 *
 * Two removals, both deliberate. `internal_note` is the operator's own notes and the contract says
 * NEVER — it is where "chase harder, they always pay late" gets written. `task_ids` on a line is the
 * provenance link an operator uses to answer "what am I actually billing for"; a client has no use
 * for a run id and every use for not seeing one.
 *
 * `minor_unit_exponent` travels with the payload so a browser can format ¥1250 and $12.50 without
 * shipping a currency table to it — see `minorUnitExponent`.
 */
export function toPortalInvoice(inv: Invoice) {
  const { internal_note: _drop, lines, ...rest } = inv;
  return {
    ...rest,
    lines: lines.map(({ task_ids: _t, ...l }) => l),
    totals: invoiceTotals(inv),
    effective_status: effectiveStatus(inv),
    minor_unit_exponent: minorUnitExponent(inv.currency),
    payment_link_url: paymentLinkFor(inv),
  };
}

/** ISO-4217 shape only. The exponent table decides the arithmetic; this just refuses nonsense. */
function normalizeCurrency(v: unknown, fallback = "USD"): string {
  const s = String(v ?? "").toUpperCase();
  return /^[A-Z]{3}$/.test(s) ? s : fallback;
}

/** YYYY-MM-DD or nothing. `effectiveStatus` compares these as strings; a Date here would break it. */
function normalizeDate(v: unknown): string | undefined {
  const s = String(v ?? "");
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : undefined;
}

export function mountInvoiceRoutes(app: Hono, deps: InvoiceRouteDeps): void {
  const { accessible, writeProjectId, clientInProject, wedgeEnabled, spawnTask, attachInvoiceDocument, openChasesFor } =
    deps;
  const billing = () => getBillingStore();

  /**
   * Hand the scheduled sweep the SAME three capabilities this file was injected with.
   *
   * The sweep lives in `dunning.ts` and is driven by `fireSchedule`, which has a store and a domain
   * store and nothing else — no constraint ceilings, no brand kit, no artifact backend. Registering
   * here rather than importing there keeps `server.ts` the single place that knows how to spawn a
   * clamped run, and guarantees that a chase the sweep starts and a chase a founder starts differ in
   * nothing but their `source`.
   *
   * Until this line runs, the sweep does nothing at all. See `setChaseDeps`.
   */
  setChaseDeps({ wedgeEnabled, spawnTask, attachInvoiceDocument, openChasesFor });

  /**
   * Arm payment detection, from the same place and for the same reason.
   *
   * The reconciliation reads a project's own payment provider through the ordinary action executor
   * and the ordinary connection records — no second credential path, no second tenancy rule. It is
   * registered here rather than in payments.ts so that a kernel booted WITHOUT invoicing has neither
   * a chaser nor a reconciler, instead of a reconciler quietly reading a founder's Stripe on behalf
   * of a product surface that does not exist.
   *
   * `onSettled` is the link back: when detection settles an invoice, any chase already in flight for
   * it is stood down before the status moves. See `standDownChases`.
   */
  setReconcileDeps({
    listConnections: () => getDomainStore().listConnections(),
    execute: (conn, capability, payload) => executeAction(conn, capability, payload),
    onSettled: async (inv) => {
      await standDownChases(inv, "payment detection settled this invoice").catch((e) =>
        console.error(`[mycel] could not stand down chases for invoice ${inv.id}:`, e),
      );
    },
  });

  setImportDeps({
    listConnections: () => getDomainStore().listConnections(),
    execute: (conn, capability, payload) => executeAction(conn, capability, payload),
    domain: getDomainStore(),
  });

  /**
   * Arm the receipt path, from the same deps and the same place as the other two.
   *
   * `attachInvoiceDocument` is shared with the chase, which is the point: a receipt PDF and an
   * invoice PDF are produced by one function against one brand kit, so they cannot drift into looking
   * like documents from two different businesses.
   */
  setReceiptDeps({ wedgeEnabled, spawnTask, attachInvoiceDocument });

  setCheckoutDeps({
    listConnections: () => getDomainStore().listConnections(),
    execute: (conn, tool, payload) => executeAction(conn, tool, payload),
    publicUrl: () => process.env.MYCEL_PUBLIC_URL ?? `http://127.0.0.1:${process.env.PORT ?? 4000}`,
  });

  /**
   * Who is doing this, for the audit trail on a hand-recorded payment.
   *
   * A member id when there is a session, `founder` otherwise — the same fallback
   * `POST /v1/moves/outcome` uses, so one person shows up under one name across both ledgers. It is
   * for the record only and is never a tenancy decision; the project always comes from the invoice.
   */
  const memberLabel = (c: any): string =>
    (c.get("scope") as import("./identity").AuthScope | undefined)?.member_id ?? "founder";

  /**
   * ═══ MARKING AN INVOICE SENT NOW ACTUALLY SENDS IT ═══
   *
   * THE BUG: `POST /v1/invoices/:id/status {to:"sent"}` stamped `sent_at`, started the overdue
   * clock, armed the dunning ladder — and emailed nothing. Every downstream surface then believed
   * the client had the invoice: `effectiveStatus` turned it overdue on the due date, the sweep
   * chased a client who had never been asked for the money, and the first chase read as a reminder
   * about an invoice nobody had ever seen. A silent success in the money path, which is this repo's
   * signature bug standing directly on the cash.
   *
   * ═══ WHY IT SENDS DIRECTLY INSTEAD OF SPAWNING A RUN ═══
   *
   * A chase spawns a run because the WORDS are a judgement call — tone, rung, what the client said
   * last time. "Here is invoice INV-0007 for £1,200, due 3 March" is not a judgement call. It is the
   * same four facts every time, and a model asked to write it costs money to introduce the one thing
   * an invoice email must not have: variation in the numbers. So this composes the mail here and
   * puts it through `planSendEmail` + `executeAction` — the same single door every other send in the
   * kernel goes through, with the same tenancy filter and the same provider resolution.
   *
   * ═══ THE HUMAN IS THE CLICK ═══
   *
   * Nothing here bypasses approval, because this path only ever runs from a founder (or an agent
   * holding a standing grant) deliberately issuing an invoice. The click IS the approval, and it is
   * per-invoice. Retainer billing draws DRAFTS for exactly this reason: recurring money still meets
   * a person before it meets the client.
   *
   * ═══ IT NEVER FAILS THE TRANSITION, AND IT IS NEVER SILENT ═══
   *
   * "Sent" is also what a founder clicks having posted a paper copy or attached the PDF in their own
   * mail client, and refusing the status change because no mailbox is connected would make the
   * product unusable for them. So the transition stands and the ANSWER CARRIES THE TRUTH: `delivery`
   * says whether an email actually left and, when it did not, the sentence saying why. The one
   * outcome that is not allowed is the old one — reporting success while nothing happened.
   */
  const deliverInvoice = async (
    inv: Invoice,
  ): Promise<{ sent: boolean; detail: string; to?: string }> => {
    const client = await getDomainStore().getClient(inv.client_id);
    if (!client) return { sent: false, detail: "this invoice has no client on file, so there was nobody to email" };
    // The client's own addresses, and only those. `handles` is what inbound is matched on, so it is
    // the one list that is known to belong to this client rather than typed into a note.
    const to = (client.handles ?? []).find((h) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(h.trim()));
    if (!to) {
      return {
        sent: false,
        detail: `${client.display_name ?? "this client"} has no email address on file, so the invoice was not emailed — add one and send it again`,
      };
    }

    const totals = invoiceTotals(inv);
    const exp = minorUnitExponent(inv.currency);
    // Formatted for a human at the very last moment and NOWHERE ELSE. Every amount above is an
    // integer of minor units; this is a string for an email body, never a number anything computes
    // with. See the MONEY comment on `Invoice`.
    const money = (minor: number) =>
      exp === 0
        ? `${inv.currency} ${minor}`
        : `${inv.currency} ${Math.trunc(minor / 10 ** exp)}.${String(Math.abs(minor % 10 ** exp)).padStart(exp, "0")}`;
    const link = paymentLinkFor(inv);
    const offer = await howToPay(inv).catch((e) => {
      console.error(`[mycel] could not work out how to pay invoice ${inv.id}:`, e);
      return undefined;
    });
    const payLines = offer ? offerLines(offer) : link ? [`You can pay here: ${link}`] : [];
    const lines = [
      `Invoice ${inv.number}${inv.due_date ? `, due ${inv.due_date}` : ""}.`,
      ``,
      `Amount due: ${money(totals.amount_due)}`,
      ...(totals.amount_paid > 0 ? [`Already paid: ${money(totals.amount_paid)} of ${money(totals.total)}`] : []),
      ...(payLines.length ? [``, ...payLines] : []),
      ...(inv.note ? [``, inv.note] : []),
    ];

    const connections = (await getDomainStore().listConnections()).filter((cn) => cn.project_id === inv.project_id);
    const plan = planSendEmail({
      project_id: inv.project_id,
      connections,
      send: {
        to: [to.trim()],
        subject: `Invoice ${inv.number}`,
        text: lines.join("\n"),
      },
    });
    // A refusal is an answer, and it is the founder's sentence — no mailbox connected, two
    // connected and no rule for which. Never swallowed into a boolean.
    if (!plan.ok) return { sent: false, detail: plan.refusal, to };

    const conn = await getDomainStore().getConnection(plan.call.connection_id);
    if (!conn || conn.project_id !== inv.project_id) {
      // Belt and braces on the tenancy: the planner already filtered to this project, and this
      // re-reads the row it picked. A send from another tenant's mailbox is the failure this repo
      // has shipped twice, and it costs one indexed read to make it unrepresentable here.
      return { sent: false, detail: "the mailbox this send resolved to is not connected to this business", to };
    }
    const res = await executeAction(conn, "send_email", {
      ...plan.call.arguments,
      arguments: plan.call.arguments,
      to: to.trim(),
    });
    return res.ok
      ? { sent: true, detail: `invoice ${inv.number} emailed to ${to}`, to }
      : { sent: false, detail: res.detail ?? "the send failed with no reason given", to };
  };

  /** One project, always. `InvoiceFilter.project_id` fails closed, so this must resolve one. */
  const readProject = (c: any): string | undefined => {
    const set = accessible(c);
    const named = c.req.header("x-mycel-project");
    if (named) return set.has(named) ? named : undefined;
    return set.size === 1 ? [...set][0] : undefined;
  };

  /**
   * By-id read, tenant-scoped.
   *
   * `getInvoice` takes only an id — it is the one method on `BillingStore` that cannot scope itself
   * — so the check lives here, in the single helper every by-id route goes through, rather than
   * being repeated at seven call sites where the seventh forgets.
   */
  const owned = async (c: any, id: string): Promise<Invoice | undefined> => {
    const inv = await billing().getInvoice(id);
    if (!inv) return undefined;
    return accessible(c).has(inv.project_id) ? inv : undefined;
  };

  // ────────────────────────────── founder plane ──────────────────────────────

  app.get("/v1/invoices", async (c) => {
    const projectId = readProject(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    const status = c.req.query("status") as InvoiceStatus | undefined;
    const rows = await billing().listInvoices({
      project_id: projectId,
      client_id: c.req.query("client_id") || undefined,
      case_id: c.req.query("case_id") || undefined,
      status: status || undefined,
      limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
    });
    return c.json(rows.map(withTotals));
  });

  app.post("/v1/invoices", async (c) => {
    const projectId = writeProjectId(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    const project = getIdentityStore().getProject(projectId);
    if (project && !getIdentityStore().limitsFor(project.org_id).invoicing) {
      return c.json(invoicingRefusal(), 402);
    }
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const clientId = typeof b.client_id === "string" ? b.client_id : "";
    // An invoice pointed at a client in another tenant would show up in that tenant's portal as a
    // demand for money. The same check every route that attaches to a client makes.
    if (!(await clientInProject(clientId, projectId))) return c.json({ error: "unknown client" }, 400);

    const rails = await getPaymentRails(projectId).catch(() => emptyRails(projectId));
    const inv = await billing().createInvoice({
      project_id: projectId,
      client_id: clientId,
      case_id: typeof b.case_id === "string" ? b.case_id : undefined,
      currency: normalizeCurrency(b.currency, rails.currency || "USD"),
      // Always a draft. An invoice that arrives already `sent` skips `issue_date` and the sent
      // stamp, and then nobody can say when the clock started.
      status: "draft",
      // Line ids are ours, quantities and amounts are truncated to integers. See `normalizeLines`.
      lines: normalizeLines(b.lines),
      due_date: normalizeDate(b.due_date),
      note: typeof b.note === "string" ? b.note.slice(0, 5_000) : undefined,
      internal_note: typeof b.internal_note === "string" ? b.internal_note.slice(0, 5_000) : undefined,
      payment_link_url: typeof b.payment_link_url === "string" ? b.payment_link_url : undefined,
    });

    /**
     * RAISING AN INVOICE IS WHAT TURNS THE MONEY CLOCKS ON. See upkeep.ts for the whole argument.
     *
     * Payment sync and the overdue sweep used to exist only where somebody had provisioned
     * `blueprints/invoice-chaser.json`. A bookkeeper and a contract desk both raise invoices and both
     * get paid late, and both got neither — silently. Raising an invoice is the fact that calls for
     * both, so it is now the fact they follow from, and the blueprint is one door to that fact rather
     * than the only source of the feature.
     *
     * Awaited, because it is two indexed existence queries plus a `listSchedules` and a founder who
     * creates an invoice and opens `/clock` should see the sweep already there. It cannot fail the
     * write — an unclaimed `dunning` role is a logged sentence, never a 500 on an invoice.
     */
    await ensureUpkeepQuietly(getDomainStore(), projectId);
    return c.json(withTotals(inv), 201);
  });

  app.get("/v1/invoices/:id", async (c) => {
    const inv = await owned(c, c.req.param("id"));
    if (!inv) return c.json({ error: "not found" }, 404);
    const rails = await getPaymentRails(inv.project_id).catch(() => emptyRails(inv.project_id));
    const offer = await howToPay(inv).catch(() => undefined);
    return c.json({
      ...withTotals(inv),
      how_to_pay: offer,
      seller: rails.seller,
      seller_missing: sellerMissingSentence(rails.seller),
      default_currency: rails.currency,
    });
  });

  /** Edit the mutable half. Status has its own routes; money received has its own route. */
  app.put("/v1/invoices/:id", async (c) => {
    const inv = await owned(c, c.req.param("id"));
    if (!inv) return c.json({ error: "not found" }, 404);
    // Terminal means terminal. Editing the lines of a paid invoice changes what was owed after the
    // fact, which is a credit note — a different document with its own audit trail.
    if (inv.status === "paid" || inv.status === "void") {
      return c.json({ error: `a ${inv.status} invoice cannot be edited` }, 409);
    }
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const updated = await billing().updateInvoice(inv.id, {
      lines: b.lines === undefined ? undefined : normalizeLines(b.lines),
      currency: b.currency === undefined ? undefined : normalizeCurrency(b.currency, inv.currency),
      due_date: b.due_date === undefined ? undefined : normalizeDate(b.due_date),
      note: typeof b.note === "string" ? b.note.slice(0, 5_000) : undefined,
      internal_note: typeof b.internal_note === "string" ? b.internal_note.slice(0, 5_000) : undefined,
      payment_link_url: typeof b.payment_link_url === "string" ? b.payment_link_url : undefined,
      case_id: typeof b.case_id === "string" ? b.case_id : undefined,
    });
    return c.json(updated ? withTotals(updated) : { error: "not found" }, updated ? 200 : 404);
  });

  /**
   * Move an invoice's status.
   *
   * One route for every transition, because the legality table is the interesting part and it lives
   * in `INVOICE_TRANSITIONS` where it can be read. The allowlist is passed INTO the store so it
   * becomes part of the UPDATE's WHERE clause — two operators clicking "void" and "mark paid" at
   * the same instant cannot both win.
   */
  app.post("/v1/invoices/:id/status", async (c) => {
    const inv = await owned(c, c.req.param("id"));
    if (!inv) return c.json({ error: "not found" }, 404);
    const b = (await c.req.json().catch(() => ({}))) as { to?: string };
    const to = b.to as InvoiceStatus;
    if (!to || !(to in INVOICE_TRANSITIONS)) return c.json({ error: "unknown status" }, 400);
    if (!canTransition(inv.status, to)) {
      return c.json({ error: `cannot go from ${inv.status} to ${to}`, code: "invoice.illegal_transition" }, 409);
    }
    /**
     * MARKING PAID IS THE SAFETY VALVE, so it stands down the chase FIRST.
     *
     * This route is what "Mark as paid" clicks, and a founder clicks it precisely when they have
     * learned something we have not — a bank transfer landed, the client paid in cash, Stripe is
     * disconnected. If a chase for this invoice is already queued or sitting on the approval gate,
     * the click has to stop it, and it has to stop it BEFORE the status write: doing it afterwards
     * leaves a window in which the invoice is paid and the email is still going out. That window is
     * the whole failure this is here to close.
     *
     * Best-effort by design — a stand-down that fails must never turn "I marked it paid" into a 500
     * and leave the invoice owing. The refusal is logged instead.
     */
    if (to === "paid") {
      await standDownChases(inv, "a human marked this invoice paid")
        .then((r) => {
          if (r.reason) console.warn(`[mycel] invoice ${inv.number} marked paid but ${r.reason}`);
        })
        .catch((e) => console.error(`[mycel] could not stand down chases for invoice ${inv.id}:`, e));
      // Marking it paid ANSWERS the question, if one was open. A founder who has just told us the
      // invoice is settled must not find us still asking them about it on the next screen — and the
      // ladder must not keep holding for an answer it has already been given.
      await answerPaymentQuestion(inv.project_id, inv.id, "paid", memberLabel(c)).catch((e) =>
        console.error(`[mycel] could not close the payment question for invoice ${inv.id}:`, e),
      );
    }
    const today = new Date().toISOString().slice(0, 10);
    const stamps =
      to === "sent"
        ? // Issued now, unless it already was — a `sent → overdue → sent` round trip must not
          // rewrite the date the clock started from.
          { issue_date: inv.issue_date ?? today, sent_at: new Date().toISOString() }
        : to === "paid"
          ? { paid_at: new Date().toISOString() }
          : to === "void"
            ? { voided_at: new Date().toISOString() }
            : {};
    // Only the legal sources for THIS target, straight from the table.
    const allowed = (Object.keys(INVOICE_TRANSITIONS) as InvoiceStatus[]).filter((from) =>
      INVOICE_TRANSITIONS[from].includes(to),
    );
    const updated = await billing().transitionInvoice(inv.id, to, allowed, stamps);
    if (!updated) return c.json({ error: "that invoice changed underneath you", code: "invoice.conflict" }, 409);
    if (to === "paid") {
      /**
       * The same attribution the payments route makes, because this is the same event.
       *
       * "Mark as paid" is what a founder clicks when the money arrived somewhere we cannot see, which
       * on a business with no payment provider is EVERY settlement. Recording the outcome only on the
       * payments route meant the next-move engine learned from Stripe customers and learned nothing
       * at all from everybody else — so the ranking it showed them was trained on somebody else's
       * business. Gated on the successful transition, so it fires exactly once.
       */
      await noteInvoiceSettled(
        getDomainStore(),
        systemMoveAuthority(updated.project_id),
        updated,
        updated.paid_at ?? new Date().toISOString(),
      ).catch((e) => console.error(`[mycel] could not attribute the settlement of invoice ${updated.id}:`, e));
    }
    /**
     * SENDING IS THE SECOND DOOR ONTO THE SAME FACT, and it is the one that repairs history.
     *
     * `POST /v1/invoices` covers every invoice raised from now on. It does nothing for a business
     * that already had forty of them when this shipped, and nothing for one whose invoices are
     * created by an agent through another path — both of which would sit there un-swept until
     * somebody happened to raise invoice forty-one. Issuing an invoice is the moment the payment
     * clock actually starts, so it is the honest second trigger, and `ensureUpkeep` is idempotent:
     * on every subsequent send this is a read.
     */
    if (to === "sent" && updated.project_id) await ensureUpkeepQuietly(getDomainStore(), updated.project_id);

    /**
     * AND THE INVOICE ACTUALLY GOES OUT. See `deliverInvoice` for the whole argument.
     *
     * After the transition, deliberately: an email that leaves for an invoice whose status write
     * lost a race would be a demand the books do not record. The reverse ordering (send, then fail
     * to transition) is the worse of the two, because the client has the invoice and we do not think
     * we sent it. `delivery` is on the response either way — a founder must be able to see that
     * nothing left, on the screen where they pressed the button.
     */
    let delivery: { sent: boolean; detail: string; to?: string } | undefined;
    if (to === "sent") {
      /**
       * A CARD LINK, GENERATED NOW, FROM THE INTEGER THE INVOICE ACTUALLY ASKS FOR.
       *
       * Before the email, deliberately: the mail is the first time the client sees a way to pay,
       * and a checkout created after the send is a link that is not in the email. Failure is
       * logged and does not fail the issue — bank transfer and cash still print, and a founder
       * whose Stripe is disconnected must still be able to send the invoice.
       */
      const issued = await ensureStripeCheckout(updated)
        .then(async (url) => (url ? ((await billing().getInvoice(updated.id)) ?? updated) : updated))
        .catch((e) => {
          console.warn(`[mycel] could not create a Stripe checkout for invoice ${updated.number}:`, e);
          return updated;
        });
      delivery = await deliverInvoice(issued).catch((e) => ({
        sent: false,
        detail: `the invoice email could not be attempted: ${(e as Error)?.message ?? e}`,
      }));
      if (!delivery.sent) console.warn(`[mycel] invoice ${updated.number} marked sent but ${delivery.detail}`);
      return c.json({ ...withTotals(issued), ...(delivery ? { delivery } : {}) });
    }
    return c.json({ ...withTotals(updated), ...(delivery ? { delivery } : {}) });
  });

  /**
   * MONEY RECEIVED — the route a founder who was paid in cash or by transfer actually uses.
   *
   * ═══ WHAT CHANGED, AND WHY IT IS NOT A BIGGER ROUTE FOR THE SAKE OF IT ═══
   *
   * This used to take a bare `amount_minor` and call `recordPayment`, which is an unguarded
   * `amount_paid = amount_paid + n`. Three things were wrong with that and all three are the
   * majority case, not the edge: a double submit counted the money twice with no idempotency key, the
   * payment appeared in no audit trail because `GET /v1/invoices/:id/payments` reads the external
   * ledger and this never wrote to it, and the invoice was stamped paid TODAY rather than on the day
   * the money actually arrived. The body is bigger now because those are three real fields, not
   * because the route grew opinions.
   *
   * The work itself is `recordManualPayment` and deliberately not inline here: the status route below
   * and the reconciliation loop both settle invoices too, and this repo has already paid for the
   * lesson that three copies of "an invoice just got paid" agree until the day one of them is edited.
   *
   * BACKWARD COMPATIBLE ON THE ONLY FIELD THAT EXISTED. `amount_minor` alone still works — method
   * defaults to `other` and the date to today — because the cloud UI and this route ship separately
   * and a founder mid-payment should not meet a 400.
   */
  app.post("/v1/invoices/:id/payments", async (c) => {
    const inv = await owned(c, c.req.param("id"));
    if (!inv) return c.json({ error: "not found" }, 404);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

    const outcome = await recordManualPayment({
      // From the INVOICE we already authorised, never from the body. A project id a caller can name
      // is a project id a caller can change, and this is the write that moves money onto books.
      project_id: inv.project_id,
      invoice_id: inv.id,
      amount_minor: typeof b.amount_minor === "number" ? b.amount_minor : NaN,
      method: (isPaymentMethod(b.method) ? b.method : "other"),
      // Today only as a fallback for a caller that named no date. `recordManualPayment` itself
      // refuses to default it — see the note on `ManualPaymentInput.paid_on`.
      paid_on: typeof b.paid_on === "string" && b.paid_on ? b.paid_on : new Date().toISOString().slice(0, 10),
      reference: typeof b.reference === "string" ? b.reference.slice(0, 200) : undefined,
      // A caller that mints no key still gets one, and gets it PER REQUEST rather than per form —
      // which is honestly weaker, and is the price of not breaking an older client. Anything that
      // wants a real double-submit guard sends its own; the cloud UI does.
      entry_id: typeof b.entry_id === "string" && b.entry_id ? b.entry_id.slice(0, 100) : randomUUID(),
      recorded_by: memberLabel(c),
    });

    if (!outcome.ok) {
      // 404 for a missing invoice, 409 for a state that forbids the write, 400 for a malformed one.
      const http = outcome.reason === "not_found" ? 404 : outcome.reason === "void_invoice" || outcome.reason === "draft_invoice" ? 409 : 400;
      return c.json({ error: outcome.message, code: `payment.${outcome.reason}` }, http);
    }
    return c.json({
      ...withTotals(outcome.invoice),
      // The consequences, alongside the row. A UI that had to infer "did this settle it" by comparing
      // totals would get it wrong on the replay case, where nothing changed but everything is fine.
      payment: {
        applied: outcome.applied,
        settled: outcome.settled,
        stood_down: outcome.stood_down,
        stand_down_warning: outcome.stand_down_warning,
        overpaid_by: outcome.overpaid_by,
        chased_after_payment: outcome.chased_after_payment,
        receipt: outcome.receipt,
      },
    });
  });

  /**
   * Offer the client their receipt. Spawns a run; nothing is sent until a human approves it.
   *
   * A ROUTE RATHER THAN A CONSEQUENCE OF THE ONE ABOVE, and that is the founder's "should we tell the
   * user" answered in the other direction. Recording a payment is bookkeeping — it is often done in
   * bulk, weeks late, against invoices whose clients were thanked in person at the time. Emailing
   * somebody's client is a separate act with a separate audience, and folding it into the payment
   * write would mean a founder catching up on a month of cash receipts silently mails thirty people.
   * So the payment response CARRIES THE OFFER (`payment.receipt`) and this is the accept.
   */
  app.post("/v1/invoices/:id/receipt", async (c) => {
    const inv = await owned(c, c.req.param("id"));
    if (!inv) return c.json({ error: "not found" }, 404);
    const started = await startReceipt(inv, { requested_by: memberLabel(c) });
    if (!started.ok) {
      const http = started.reason === "wedge_disabled" || started.reason === "no_receipt_wedge" ? 403 : started.reason === "spawn_failed" ? 500 : 409;
      return c.json({ error: started.message, code: `receipt.${started.reason}` }, http);
    }
    return c.json({ task_id: started.task_id, invoice_id: started.invoice_id, document: started.document }, 201);
  });

  /**
   * The invoices we have asked the founder about, and are waiting on.
   *
   * Its own route rather than a field per invoice for the reason `/v1/payments/confidence` is: the
   * Invoices screen wants the whole set at once to render one block, and computing it per row would
   * be the same store read repeated down the page.
   */
  app.get("/v1/payments/questions", async (c) => {
    const projectId = readProject(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    return c.json(await listPaymentQuestions(projectId, { open_only: c.req.query("open") !== "false" }));
  });

  /**
   * Answer one: "yes it was paid" or "no, go ahead and chase".
   *
   * `paid` here is the ANSWER ONLY and records no money — the founder still has to say how much and
   * when, through the payments route, and in the UI that is the same click. Making this route able to
   * settle an invoice would be a second way to move `amount_paid` that skips the ledger, the
   * idempotency key and the date, which is the exact path this work removed.
   */
  app.post("/v1/invoices/:id/payment-question", async (c) => {
    const inv = await owned(c, c.req.param("id"));
    if (!inv) return c.json({ error: "not found" }, 404);
    const b = (await c.req.json().catch(() => ({}))) as { answer?: unknown };
    if (b.answer !== "paid" && b.answer !== "not_paid") {
      return c.json({ error: 'answer must be "paid" or "not_paid"' }, 400);
    }
    const answered = await answerPaymentQuestion(inv.project_id, inv.id, b.answer, memberLabel(c));
    if (!answered) return c.json({ error: "nothing was asked about that invoice" }, 404);
    return c.json(answered);
  });

  /**
   * How this business gets paid — the bank details that go on every invoice.
   *
   * Project-level, because a sort code does not change per invoice. See the long note in
   * payments.manual.ts for why these are free-form lines and not typed banking fields.
   */
  app.get("/v1/payments/instructions", async (c) => {
    const projectId = readProject(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    return c.json({ lines: await getPaymentInstructions(projectId) });
  });

  app.put("/v1/payments/instructions", async (c) => {
    const projectId = writeProjectId(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    const b = (await c.req.json().catch(() => ({}))) as { lines?: unknown };
    return c.json({ lines: await setPaymentInstructions(projectId, b.lines) });
  });

  /**
   * How this business gets paid — the rails, the default currency, the identity on the document.
   *
   * Project-scoped, required, never defaulted. A sort code does not change per invoice; neither
   * does "we take cash on collection". See payments.rails.ts.
   */
  app.get("/v1/payments/rails", async (c) => {
    const projectId = readProject(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    return c.json(await getPaymentRails(projectId));
  });

  app.put("/v1/payments/rails", async (c) => {
    const projectId = writeProjectId(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    const b = await c.req.json().catch(() => ({}));
    return c.json(await setPaymentRails(projectId, b));
  });

  /**
   * How recently we actually confirmed this business's payment state — and therefore how much to
   * trust every "unpaid" on the invoices screen.
   *
   * Its own route rather than a field on every invoice because it is a fact about the PROJECT, not
   * about a row: computing it per invoice would be the same store read repeated once per line of a
   * list, all returning the same answer. The Invoices page reads it once and shows one banner.
   */
  app.get("/v1/payments/confidence", async (c) => {
    const projectId = readProject(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    return c.json(await paymentConfidence(projectId));
  });

  /**
   * Check payments NOW, for this project.
   *
   * The scheduled sync is the mechanism of record (see the header of payments.ts for why a poll and
   * not a webhook); this is the same function behind a button, for the founder who has just
   * connected Stripe or who is looking at an invoice and wants to know before they chase.
   *
   * It returns the whole summary including `discrepancies`, and it returns HTTP 200 with `ok: false`
   * rather than an error status when the provider could not be read — because "we could not check"
   * is a real, useful, actionable answer that the UI must render, not an exception to swallow.
   */
  app.post("/v1/payments/reconcile", async (c) => {
    const projectId = writeProjectId(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    return c.json(await reconcileProject({ project_id: projectId }));
  });

  app.get("/v1/imports/crm/confidence", async (c) => {
    const projectId = writeProjectId(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    return c.json(await crmImportConfidence(projectId));
  });

  app.post("/v1/imports/crm", async (c) => {
    const projectId = writeProjectId(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    return c.json(await importCrmClients({ project_id: projectId }));
  });

  app.get("/v1/imports/calendar/confidence", async (c) => {
    const projectId = writeProjectId(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    return c.json(await calendarSyncConfidence(projectId));
  });

  app.post("/v1/imports/calendar", async (c) => {
    const projectId = writeProjectId(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    return c.json(await syncCalendar({ project_id: projectId }));
  });

  // ────────────────────────────── recurring revenue ──────────────────────────────
  //
  // Retainers live on the money plan of an engagement (`money-plan.ts`) and bill on a schedule
  // (`money-plan.retainer.ts`). These three routes are the founder's whole control surface over
  // them: SEE what is running and what it has billed, CHANGE the cadence or the price, and STOP it.
  // Mounted here rather than next to the case routes because a retainer is accounts receivable —
  // this is the file whose deps already reach the billing store, and the ledger these routes read is
  // the same one the sweep writes.

  /**
   * Every retainer this business is running, with its next due date and its billing history.
   *
   * PROJECT-SCOPED, REQUIRED, never defaulted — the same rule as every read on this page.
   *
   * The next-due date is COMPUTED from the recurrence rather than stored, which is the same decision
   * `effectiveStatus` makes about overdue: a stored next-due is a second calendar that drifts from
   * the one the sweep actually bills on, and the day they disagree is the day a founder is told the
   * client will be billed on the 1st and they are billed on the 3rd.
   */
  app.get("/v1/retainers", async (c) => {
    const projectId = readProject(c);
    if (!projectId) return c.json({ error: "specify a project (X-Mycel-Project header)" }, 400);
    const today = new Date().toISOString().slice(0, 10);
    const domain = getDomainStore();
    const cases = (await domain.listCases({ project_id: projectId })).filter((k) => k.status !== "closed");
    const out: unknown[] = [];
    for (const kase of cases) {
      const plan = readMoneyPlan(kase.data);
      if (!plan) continue;
      for (const line of retainerLines(plan)) {
        const periods = await billing().listRetainerPeriods({
          project_id: projectId,
          case_id: kase.id,
          line_id: line.id,
          limit: 24,
        });
        out.push({
          case_id: kase.id,
          case_title: kase.title,
          client_id: kase.client_id,
          line_id: line.id,
          label: line.label,
          amount_minor: line.amount_minor,
          currency: plan.currency,
          minor_unit_exponent: minorUnitExponent(plan.currency),
          recurrence: line.recurrence,
          next_due: nextRetainerDue(line.recurrence!, today),
          billed_periods: periods,
        });
      }
    }
    return c.json(out);
  });

  /**
   * Start, reprice, re-cadence, pause, resume or end one retainer.
   *
   * ═══ RE-ANCHORING A RETAINER THAT HAS ALREADY BILLED IS REFUSED ═══
   *
   * The anchor is the input every period key is derived from, so moving it moves the boundaries —
   * and the ledger's already-billed rows are keyed on the OLD boundaries, which means a re-anchored
   * retainer can raise a second invoice covering days a client has already paid for. That is the one
   * failure this whole subsystem is built to make impossible, so it is refused rather than warned
   * about: end this retainer and start a new line, which leaves both histories intact and legible.
   *
   * Every other change is allowed and takes effect from the NEXT period — periods already claimed
   * have invoices, and an invoice is edited on the invoice.
   */
  app.put("/v1/retainers/:case_id/:line_id", async (c) => {
    const projectId = writeProjectId(c);
    if (!projectId || !accessible(c).has(projectId)) return c.json({ error: "not found" }, 404);
    const domain = getDomainStore();
    const kase = await domain.getCase(c.req.param("case_id"));
    // Tenancy from the ROW, and it fails closed on a case with no project. A retainer is a standing
    // instruction to invoice somebody every month; a defaulted scope here bills the wrong business's
    // client for ever, not once.
    if (!kase || kase.project_id !== projectId) return c.json({ error: "not found" }, 404);
    if (kase.status === "closed") return c.json({ error: "this engagement is closed" }, 409);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const lineId = c.req.param("line_id");

    if (typeof b.anchor === "string") {
      const already = await billing().listRetainerPeriods({
        project_id: projectId,
        case_id: kase.id,
        line_id: lineId,
        limit: 1,
      });
      const plan = readMoneyPlan(kase.data);
      const current = plan?.lines.find((l) => l.id === lineId)?.recurrence?.anchor;
      if (already.length && current && current !== b.anchor) {
        return c.json(
          {
            error:
              "this retainer has already billed, so its start date cannot be moved — periods are " +
              "identified by it, and moving it could invoice a month the client has already paid. " +
              "End this retainer and add a new line instead.",
            code: "retainer.anchored",
          },
          409,
        );
      }
    }

    try {
      const out = await setRetainer({
        domain,
        kase,
        line_id: lineId,
        patch: {
          state: b.state === "paused" || b.state === "ended" || b.state === "active" ? b.state : undefined,
          every: b.every === "week" || b.every === "month" ? b.every : undefined,
          interval: b.interval === undefined ? undefined : Number(b.interval),
          anchor: typeof b.anchor === "string" ? b.anchor : undefined,
          first_period_ends: typeof b.first_period_ends === "string" ? b.first_period_ends : undefined,
          amount_minor: b.amount_minor === undefined ? undefined : Number(b.amount_minor),
        },
      });
      /**
       * A RETAINER WITH NO CLOCK IS THE FAILURE THIS REPO KEEPS HAVING (upkeep.ts).
       *
       * Turning one on is the moment the sweep becomes worth having, so the schedule is ensured here
       * rather than waiting for the first invoice — which, on a project whose only revenue is
       * recurring, would never come.
       */
      await ensureUpkeepQuietly(domain, projectId);
      const today = new Date().toISOString().slice(0, 10);
      return c.json({
        ok: true,
        note: out.note,
        line: out.line,
        next_due: out.line.recurrence ? nextRetainerDue(out.line.recurrence, today) : undefined,
        money_plan: out.plan,
      });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  /**
   * Bill everything due on this project's retainers, now.
   *
   * The same `sweepRetainers` the schedule fires, on the same claims — a founder clicking this and a
   * tick firing in the same second cannot produce two invoices, because both go through the unique
   * index. That is the property that makes offering a button here safe at all, and it is why this
   * route is three lines rather than a second implementation of "work out what is due".
   */
  app.post("/v1/retainers/run", async (c) => {
    const projectId = writeProjectId(c);
    if (!projectId || !accessible(c).has(projectId)) return c.json({ error: "not found" }, 404);
    return c.json(await sweepRetainers({ domain: getDomainStore(), project_id: projectId }));
  });

  /**
   * The provider payments behind one invoice's balance.
   *
   * `amount_paid` is a single number, and the moment anything automatic writes to it a founder needs
   * to be able to ask "which of these did you decide, and on what basis". `basis` on each row is
   * `reference` (the client quoted our invoice number), `amount_and_date`, or `human`.
   */
  app.get("/v1/invoices/:id/payments", async (c) => {
    const inv = await owned(c, c.req.param("id"));
    if (!inv) return c.json({ error: "not found" }, 404);
    return c.json(await billing().listExternalPayments({ project_id: inv.project_id, invoice_id: inv.id }));
  });

  /** Drafts only. Deleting an issued invoice is a void — a decision with an audit trail. */
  app.delete("/v1/invoices/:id", async (c) => {
    const inv = await owned(c, c.req.param("id"));
    if (!inv) return c.json({ error: "not found" }, 404);
    if (inv.status !== "draft") return c.json({ error: "only a draft can be deleted; void it instead" }, 409);
    await billing().deleteInvoice(inv.id);
    return c.json({ ok: true });
  });

  /**
   * The document. A structured invoice in, a branded PDF out, deterministically.
   *
   * WHY `task_id` IS REQUIRED. An artifact hangs off a run — `GET /v1/artifacts/:id` authorises by
   * looking up `artifact.task_id` and checking its project, and the portal route additionally checks
   * that task's client. An artifact attached to no run is one that nobody can be authorised to
   * download, so this route refuses to make one rather than inventing a synthetic task to hang it
   * from. In practice the task is the chase run, and the PDF is the attachment on the dunning email.
   *
   * Nothing about the layout is decided here or by the model. `render()` is a pure function of the
   * stored invoice and the project's brand kit: the same invoice renders to the same bytes every
   * time, for every tenant, with that tenant's logo and accent on it.
   */
  app.post("/v1/invoices/:id/document", async (c) => {
    const inv = await owned(c, c.req.param("id"));
    if (!inv) return c.json({ error: "not found" }, 404);
    const b = (await c.req.json().catch(() => ({}))) as { task_id?: unknown; format?: unknown };
    const taskId = typeof b.task_id === "string" ? b.task_id : "";
    if (!taskId) {
      return c.json(
        { error: "task_id is required — an artifact belongs to a run, and one attached to no run cannot be downloaded by anyone" },
        400,
      );
    }
    // SVG is the layout language and the PDF is emitted from the same scene, so the preview is
    // exactly what the client receives. It is offered because a founder reviewing a template wants
    // something a browser renders instantly.
    const format = b.format === "svg" ? "svg" : "pdf";
    // A draft has no number a client should ever see quoted back at them, and rendering one produces
    // a document that looks issued and is not.
    if (inv.status === "draft") return c.json({ error: "a draft has no document; send it first" }, 409);
    const doc = await attachInvoiceDocument({ task_id: taskId, invoice: inv, format });
    if (!doc) return c.json({ error: "no such run in this project" }, 404);
    return c.json({ ...doc, url: `/v1/artifacts/${doc.artifact_id}` }, 201);
  });

  /**
   * Chase this invoice — the invoice-chaser reading a real row.
   *
   * What this replaces: a `chase_invoice` task whose entire knowledge of the debt was a sentence
   * someone typed into `input.message`. The agent could not verify an amount, could not format a
   * currency it was never told, could not tell a partial payment from none, and nothing it did
   * could be reconciled afterwards because there was no row to reconcile against. `days_overdue`
   * in particular — the single input the wedge's `next_step` workflow branches on — was a number a
   * human had worked out in their head.
   *
   * Now it is derived, here, from the stored invoice: integer minor units, integer days, and the
   * invoice id travels on the task so the run can be tied back to the debt.
   */
  app.post("/v1/invoices/:id/chase", async (c) => {
    const inv = await owned(c, c.req.param("id"));
    if (!inv) return c.json({ error: "not found" }, 404);
    const project = getIdentityStore().getProject(inv.project_id);
    if (project && !getIdentityStore().limitsFor(project.org_id).invoicing) {
      return c.json(invoicingRefusal(), 402);
    }

    /**
     * `"override"`, and that is this button's whole character.
     *
     * A founder who navigated to an invoice and clicked Chase has decided something the dunning
     * ladder cannot know, and a button that silently declines is worse than a duplicate email. So
     * the claim is unconditional — but it still STAMPS, so the hourly sweep sees it and does not
     * send the same client a second dunning email an hour later.
     *
     * Taking the same chase off the `/next` list uses `"ladder"` instead, because that click is on a
     * row the ladder itself proposed and it must be idempotent. See `startChase`.
     */
    const started = await startChase(inv, { pacing: "override" });
    if (!started.ok) {
      // Codes preserved: the cloud UI and the tests both key off `invoice.not_chaseable`.
      const http = started.reason === "wedge_disabled" ? 403 : started.reason === "spawn_failed" ? 500 : 409;
      return c.json({ error: started.message, code: `invoice.${started.reason}` }, http);
    }
    return c.json({ task_id: started.task_id, invoice_id: started.invoice_id, document: started.document }, 201);
  });

  // ─────────────────────────────── client plane ───────────────────────────────

  /**
   * What this client owes, as they should see it.
   *
   * Both ids come from the SESSION and go into the QUERY. Drafts are excluded because a draft is
   * the business thinking out loud — showing one to a client is a demand for money that nobody has
   * decided to make yet.
   */
  app.get("/v1/portal/invoices", async (c) => {
    const sc = c.get("client") as ClientScope;
    const rows = await billing().listInvoices({ project_id: sc.project_id, client_id: sc.client_id });
    return c.json(rows.filter((i) => i.status !== "draft").map(toPortalInvoice));
  });

  app.get("/v1/portal/invoices/:id", async (c) => {
    const sc = c.get("client") as ClientScope;
    const inv = await billing().getInvoice(c.req.param("id"));
    // Three conditions, all required. A client changing the id in the URL must not reach another
    // client's invoice, another tenant's invoice, or a draft of their own.
    if (!inv || inv.project_id !== sc.project_id || inv.client_id !== sc.client_id || inv.status === "draft") {
      return c.json({ error: "not found" }, 404);
    }
    /**
     * HOW TO PAY IT, on the one screen the client is actually looking at when they wonder.
     *
     * Read from the SESSION's project, never the invoice's — they are equal by the check above, and
     * using the session's makes that a property of the code rather than of the check staying correct.
     *
     * On the detail route only. The list is a list of what you owe; the details of how to send money
     * belong beside one specific debt, and repeating a business's bank details on every row of a
     * table is how they end up in a screenshot.
     *
     * Suppressed once nothing is owed, for the same reason the PDF suppresses them: payment details
     * on a settled invoice are an invitation to pay it twice.
     */
    const portal = toPortalInvoice(inv);
    const offer =
      portal.totals.amount_due > 0
        ? await howToPay(inv).catch((e) => {
            console.error(`[mycel] could not read how to pay for project ${sc.project_id}:`, e);
            return undefined;
          })
        : undefined;
    const lines = offer
      ? offer.blocks.flatMap((b) => [b.heading, ...b.lines])
      : portal.totals.amount_due > 0
        ? await getPaymentInstructions(sc.project_id).catch((e) => {
            console.error(`[mycel] could not read payment instructions for project ${sc.project_id}:`, e);
            return [] as string[];
          })
        : [];
    return c.json({
      ...portal,
      payment_instructions: lines,
      how_to_pay: offer,
      payment_link_url: offer?.online?.url ?? portal.payment_link_url,
    });
  });
}
