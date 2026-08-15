// Stripe as one rail: checkout from integer minor units, settle through the same ledger as the poll.
//
// No live Stripe. CheckoutDeps are mocked. The payload is asserted to carry `price_data` and never
// a Product or Price id — writing those into a founder's live catalogue is forbidden.
import { test } from "node:test";
import assert from "node:assert/strict";
import { _resetBilling, getBillingStore, invoiceTotals } from "../src/billing";
import { getDomainStore } from "../src/domain";
import type { Invoice } from "../src/contract";
import { MOVES_WEDGE, OUTCOME_COLLECTION } from "../src/moves";
import { setPaymentRails } from "../src/payments.rails";
import {
  STRIPE_CHECKOUT_TOOL,
  checkoutUrlFrom,
  ensureStripeCheckout,
  setCheckoutDeps,
  settleStripePayment,
  settlementFromStripeEvent,
} from "../src/payments.stripe";

const PROJECT = "proj-stripe-ours";
const OTHER = "proj-stripe-theirs";

async function invoice(o: Partial<Invoice> = {}): Promise<Invoice> {
  return getBillingStore().createInvoice({
    project_id: PROJECT,
    client_id: "cli-1",
    currency: "GBP",
    status: "sent",
    lines: [{ id: "l1", description: "March retainer", kind: "fixed", quantity_milli: 1000, unit_amount: 400_000 }],
    issue_date: "2026-02-01",
    due_date: "2026-03-01",
    last_chased_at: "2026-03-08T09:00:00Z",
    ...o,
  } as Invoice);
}

async function enableStripe(projectId = PROJECT): Promise<void> {
  await setPaymentRails(projectId, {
    rails: [{ kind: "stripe", enabled: true, lines: [] }],
    currency: "GBP",
  });
}

test("checkoutUrlFrom reads the shapes Composio actually returns", () => {
  assert.equal(checkoutUrlFrom({ url: "https://checkout.stripe.com/c/pay/cs_test_1" }), "https://checkout.stripe.com/c/pay/cs_test_1");
  assert.equal(checkoutUrlFrom({ data: { url: "https://checkout.stripe.com/c/pay/cs_test_2" } }), "https://checkout.stripe.com/c/pay/cs_test_2");
  assert.equal(checkoutUrlFrom({ checkout_url: "http://insecure.example/pay" }), undefined, "http is not a checkout");
  assert.equal(checkoutUrlFrom({}), undefined);
});

test("ensureStripeCheckout: a draft is refused, and so is a void", async () => {
  _resetBilling();
  await enableStripe();
  const payloads: unknown[] = [];
  setCheckoutDeps({
    listConnections: async () => [],
    execute: async (_c, _t, p) => {
      payloads.push(p);
      return { ok: true, data: { url: "https://checkout.stripe.com/c/pay/cs_test" } };
    },
    publicUrl: () => "https://app.example",
  });
  const draft = await invoice({ status: "draft" });
  assert.equal(await ensureStripeCheckout(draft), undefined);
  const voided = await invoice({ status: "void" });
  assert.equal(await ensureStripeCheckout(voided), undefined);
  assert.equal(payloads.length, 0, "Stripe was not called for a document nobody has been asked to pay");
});

test("ensureStripeCheckout: checkout uses inline price_data, never a Product or Price", async () => {
  _resetBilling();
  const projectId = "proj-stripe-price";
  await enableStripe(projectId);
  const conn = await getDomainStore().createConnection({
    project_id: projectId,
    kind: "composio",
    name: "Stripe",
    owner: { kind: "founder", id: "founder" },
    config: { toolkit: "stripe", verified_at: "2026-03-01T00:00:00Z" },
  });
  let tool = "";
  let payload: Record<string, unknown> = {};
  setCheckoutDeps({
    listConnections: async () => [conn],
    execute: async (_c, t, p) => {
      tool = t;
      payload = p;
      return { ok: true, data: { url: "https://checkout.stripe.com/c/pay/cs_test_abc" } };
    },
    publicUrl: () => "https://app.example",
  });
  const inv = await invoice({ project_id: projectId });
  const url = await ensureStripeCheckout(inv);
  assert.equal(url, "https://checkout.stripe.com/c/pay/cs_test_abc");
  assert.equal(tool, STRIPE_CHECKOUT_TOOL);
  const items = payload.line_items as { quantity: number; price_data: { currency: string; unit_amount: number } }[];
  assert.equal(items[0]?.price_data.unit_amount, 400_000);
  assert.equal(Number.isSafeInteger(items[0]?.price_data.unit_amount), true);
  assert.equal(items[0]?.price_data.currency, "gbp");
  assert.equal("price" in (items[0] ?? {}), false);
  assert.equal("product" in ((items[0]?.price_data as object) ?? {}), false);
  const dumped = JSON.stringify(payload);
  assert.doesNotMatch(dumped, /"price":\s*"price_/);
  assert.doesNotMatch(dumped, /"product":\s*"prod_/);
  const stored = await getBillingStore().getInvoice(inv.id);
  assert.equal(stored?.payment_link_url, url);
});

test("ensureStripeCheckout: a client-owned Stripe is not used to charge that client's customers", async () => {
  _resetBilling();
  const projectId = "proj-stripe-client-owned";
  await enableStripe(projectId);
  await getDomainStore().createConnection({
    project_id: projectId,
    kind: "composio",
    name: "Client Stripe",
    owner: { kind: "client", id: "cli-1" },
    config: { toolkit: "stripe", verified_at: "2026-03-01T00:00:00Z" },
  });
  let called = 0;
  setCheckoutDeps({
    listConnections: () => getDomainStore().listConnections(),
    execute: async () => {
      called += 1;
      return { ok: true, data: { url: "https://checkout.stripe.com/c/pay/stolen" } };
    },
    publicUrl: () => "https://app.example",
  });
  const inv = await invoice({ project_id: projectId });
  assert.equal(await ensureStripeCheckout(inv), undefined);
  assert.equal(called, 0);
});

test("settleStripePayment: a second delivery of the same id does not double-count", async () => {
  _resetBilling();
  const inv = await invoice();
  const input = {
    project_id: PROJECT,
    external_id: "cs_test_once",
    amount_minor: 400_000,
    currency: "GBP",
    paid_at: "2026-03-09T12:00:00Z",
    invoice_id: inv.id,
    reference: inv.number,
  };
  const first = await settleStripePayment(input);
  assert.equal(first.applied, true);
  assert.equal(first.settled, true);
  const fresh = (await getBillingStore().getInvoice(inv.id))!;
  assert.equal(fresh.status, "paid");
  assert.equal(invoiceTotals(fresh).amount_due, 0);

  const second = await settleStripePayment(input);
  assert.equal(second.applied, false);
  assert.equal(second.settled, false);
  const again = (await getBillingStore().getInvoice(inv.id))!;
  assert.equal(again.amount_paid, 400_000, "the same Stripe id counted twice would fabricate revenue");
});

test("settleStripePayment: an event that names another tenant's invoice is refused", async () => {
  _resetBilling();
  const theirs = await getBillingStore().createInvoice({
    project_id: OTHER,
    client_id: "cli-x",
    currency: "GBP",
    status: "sent",
    lines: [{ id: "l1", description: "Theirs", kind: "fixed", quantity_milli: 1000, unit_amount: 50_000 }],
  } as Invoice);
  const out = await settleStripePayment({
    project_id: PROJECT,
    external_id: "cs_test_cross",
    amount_minor: 50_000,
    currency: "GBP",
    paid_at: "2026-03-09T12:00:00Z",
    invoice_id: theirs.id,
  });
  assert.equal(out.applied, false);
  assert.match(out.detail, /not in project/);
  const untouched = await getBillingStore().getInvoice(theirs.id);
  assert.equal(untouched?.amount_paid, 0);
  assert.equal(untouched?.status, "sent");
});

test("settleStripePayment: the first settle attributes the chase; a double webhook does not", async () => {
  _resetBilling();
  const inv = await invoice();
  const input = {
    project_id: PROJECT,
    external_id: "pi_test_learn",
    amount_minor: 400_000,
    currency: "GBP",
    paid_at: "2026-03-09T12:00:00Z",
    invoice_id: inv.id,
  };
  const first = await settleStripePayment(input);
  assert.equal(first.settled, true);
  const rows = await getDomainStore().queryRecords({
    project_id: PROJECT,
    wedge: MOVES_WEDGE,
    collection: OUTCOME_COLLECTION,
    limit: 20,
  });
  const paid = rows.filter((r) => (r.data as { result?: string }).result === "paid");
  assert.ok(paid.length >= 1, "ranking must learn that this chase was followed by payment");
  await settleStripePayment(input);
  const after = await getDomainStore().queryRecords({
    project_id: PROJECT,
    wedge: MOVES_WEDGE,
    collection: OUTCOME_COLLECTION,
    limit: 20,
  });
  const paidAfter = after.filter((r) => (r.data as { result?: string }).result === "paid");
  assert.equal(paidAfter.length, paid.length, "a double webhook must not write a second outcome");
});

test("settlementFromStripeEvent: project_id is the argument, never a field the payload gets to name", () => {
  const s = settlementFromStripeEvent(PROJECT, {
    id: "cs_test_meta",
    amount_total: 400_000,
    currency: "gbp",
    status: "complete",
    metadata: { mycel_invoice_id: "inv-1", mycel_project_id: OTHER },
  });
  assert.ok(s);
  assert.equal(s!.project_id, PROJECT);
  assert.equal(s!.invoice_id, "inv-1");
  assert.equal(s!.amount_minor, 400_000);
});

test("settlementFromStripeEvent: an open checkout is not money", () => {
  assert.equal(
    settlementFromStripeEvent(PROJECT, { id: "cs_open", amount_total: 400_000, currency: "gbp", status: "open" }),
    undefined,
  );
});
