// How this business gets paid — rails, not a pasted URL.
//
// Every test names the failure it prevents. The expensive ones are tenancy (another business's
// sort code on this invoice) and a silent wipe (editing bank details turning Stripe off).
import { test } from "node:test";
import assert from "node:assert/strict";
import { _resetBilling, getBillingStore } from "../src/billing";
import { chaseHands, chaseTaskInput } from "../src/dunning";
import { connectMailbox } from "./helpers";
import type { Invoice } from "../src/contract";
import {
  getPaymentRails,
  howToPay,
  sellerGaps,
  sellerMissingSentence,
  setPaymentRails,
} from "../src/payments.rails";
import { setPaymentInstructions } from "../src/payments.manual";

const PROJECT = "proj-rails-ours";
const OTHER = "proj-rails-theirs";

async function invoice(o: Partial<Invoice> = {}): Promise<Invoice> {
  return getBillingStore().createInvoice({
    project_id: PROJECT,
    client_id: "cli-1",
    currency: "GBP",
    status: "sent",
    lines: [{ id: "l1", description: "March retainer", kind: "fixed", quantity_milli: 1000, unit_amount: 400_000 }],
    issue_date: "2026-02-01",
    due_date: "2026-03-01",
    ...o,
  } as Invoice);
}

test("payment rails: a missing project_id is refused, never defaulted", async () => {
  await assert.rejects(() => getPaymentRails(""), /scoped to a project/);
  await assert.rejects(() => setPaymentRails("", { rails: [] }), /scoped to a project/);
  await assert.rejects(
    () => howToPay({ id: "x", project_id: "", client_id: "c", number: "INV-1", currency: "GBP", status: "sent", lines: [], amount_paid: 0, created_at: "", updated_at: "" }),
    /scoped to a project/,
  );
});

test("payment rails: one project's details never appear on another's invoice", async () => {
  await setPaymentRails(PROJECT, {
    rails: [{ kind: "bank_transfer", enabled: true, lines: ["Sort code 04-00-04", "Account 12345678"] }],
    currency: "GBP",
    seller: { address: ["14 Harbour Lane"], company_number: "12345678" },
  });
  await setPaymentRails(OTHER, {
    rails: [{ kind: "cash_or_cheque", enabled: true, lines: ["Cash on collection"] }],
    currency: "EUR",
    seller: { address: ["Other St"], company_number: "999" },
  });
  const ours = await getPaymentRails(PROJECT);
  const theirs = await getPaymentRails(OTHER);
  assert.equal(ours.project_id, PROJECT);
  assert.equal(theirs.project_id, OTHER);
  const bank = ours.rails.find((r) => r.kind === "bank_transfer");
  const cash = theirs.rails.find((r) => r.kind === "cash_or_cheque");
  assert.equal(bank?.enabled, true);
  assert.deepEqual(bank?.lines, ["Sort code 04-00-04", "Account 12345678"]);
  assert.equal(cash?.enabled, true);
  assert.equal(ours.currency, "GBP");
  assert.equal(theirs.currency, "EUR");
  assert.equal(ours.seller.company_number, "12345678");
  assert.equal(theirs.seller.company_number, "999");
});

test("payment rails: legacy instruction lines read forward as an enabled bank-transfer rail", async () => {
  // THE BUG: shipping rails and reading pre-rails `lines` as "configured but off" would take the
  // payment details off every existing customer's invoices the day this ships.
  await setPaymentInstructions(PROJECT, ["Sort code 04-00-04", "Account 12345678"]);
  const rails = await getPaymentRails(PROJECT);
  const bank = rails.rails.find((r) => r.kind === "bank_transfer");
  assert.equal(bank?.enabled, true);
  assert.deepEqual(bank?.lines, ["Sort code 04-00-04", "Account 12345678"]);
});

test("payment rails: editing bank details the old way does not turn Stripe off", async () => {
  await setPaymentRails(PROJECT, {
    rails: [
      { kind: "stripe", enabled: true, lines: [] },
      { kind: "bank_transfer", enabled: true, lines: ["Sort code 04-00-04"] },
      { kind: "cash_or_cheque", enabled: true, lines: ["Cash on collection"] },
    ],
    currency: "GBP",
    seller: { address: ["14 Harbour Lane"], company_number: "12345678" },
  });
  await setPaymentInstructions(PROJECT, ["Sort code 20-00-00", "Account 87654321"]);
  const rails = await getPaymentRails(PROJECT);
  assert.equal(rails.rails.find((r) => r.kind === "stripe")?.enabled, true);
  assert.equal(rails.rails.find((r) => r.kind === "cash_or_cheque")?.enabled, true);
  assert.deepEqual(rails.rails.find((r) => r.kind === "bank_transfer")?.lines, [
    "Sort code 20-00-00",
    "Account 87654321",
  ]);
  assert.equal(rails.currency, "GBP");
  assert.equal(rails.seller.company_number, "12345678");
});

test("payment rails: seller gaps name what an accounts department will bounce", () => {
  assert.deepEqual(sellerGaps({ address: [] }), ["registered address", "company number"]);
  assert.deepEqual(sellerGaps({ address: ["14 Harbour Lane"] }), ["company number"]);
  assert.deepEqual(sellerGaps({ address: ["14 Harbour Lane"], company_number: "12345678" }), []);
  assert.match(sellerMissingSentence({ address: [] }) ?? "", /registered address and company number/);
  assert.equal(sellerMissingSentence({ address: ["x"], company_number: "1" }), undefined);
});

test("payment rails: howToPay prints bank details and the invoice number as the reference", async () => {
  _resetBilling();
  await setPaymentRails(PROJECT, {
    rails: [{ kind: "bank_transfer", enabled: true, lines: ["Sort code 04-00-04", "Account 12345678"] }],
  });
  const inv = await invoice();
  const offer = await howToPay(inv);
  assert.equal(offer.missing, undefined);
  assert.equal(offer.blocks[0]?.kind, "bank_transfer");
  assert.ok(offer.blocks[0]?.lines.includes("Sort code 04-00-04"));
  assert.ok(offer.blocks[0]?.lines.some((l) => l.includes(inv.number)));
});

test("payment rails: a business that has configured nothing gets a missing sentence, not an empty How to pay", async () => {
  _resetBilling();
  await setPaymentRails(PROJECT, { rails: [] });
  const inv = await invoice();
  const offer = await howToPay(inv);
  assert.equal(offer.online, undefined);
  assert.equal(offer.blocks.length, 0);
  assert.match(offer.missing ?? "", /has not said how it takes payment/);
});

test("payment rails: a chase can name a bank transfer without a pasted payment_link_url", async () => {
  _resetBilling();
  await setPaymentRails(PROJECT, {
    rails: [{ kind: "bank_transfer", enabled: true, lines: ["Sort code 04-00-04"] }],
  });
  const inv = await invoice({ payment_link_url: undefined });
  const offer = await howToPay(inv);
  const input = chaseTaskInput(inv, "2026-03-10", undefined, undefined, offer);
  assert.equal(input.payment_link_url, undefined);
  const how = input.how_to_pay as { blocks: { heading: string; lines: string[] }[] };
  assert.ok(how.blocks.some((b) => b.heading === "Pay by bank transfer"));
  assert.ok(how.blocks[0]?.lines.some((l) => l.includes("04-00-04")));
});

test("payment rails: chaseHands is a mailbox gate, not a pasted-URL gate", async () => {
  _resetBilling();
  const inv = await invoice({ payment_link_url: undefined });
  await connectMailbox(PROJECT);
  const hands = await chaseHands(inv);
  assert.equal(hands.ok, true, "a business that can email must be able to chase toward a bank transfer");
});
