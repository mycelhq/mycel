// The client's lever against the one automated-dunning failure nobody forgets: being chased for an
// invoice they already paid. A bank transfer has no webhook — the money is in flight for days and
// nothing tells us — so the client tells us, and the ladder stands down while the founder checks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CLAIM_STANDDOWN_DAYS } from "../src/dunning";
import { InMemoryBillingStore } from "../src/billing";

const DAY = 24 * 60 * 60 * 1000;

async function invoiceWith(claimAgeDays?: number) {
  const b = new InMemoryBillingStore();
  const inv = await b.createInvoice({
    project_id: "p1", client_id: "c1", currency: "USD", status: "sent",
    number: "INV-1", issue_date: "2026-08-01", due_date: "2026-08-10",
    lines: [{ id: "l1", kind: "fixed", description: "work", unit_amount: 50_000, quantity_milli: 1000 }],
  });
  if (claimAgeDays !== undefined) {
    await b.updateInvoice(inv.id, {
      payment_claimed_at: new Date(Date.now() - claimAgeDays * DAY).toISOString(),
      payment_claim_note: "ref 4471, sent Tuesday",
    });
  }
  return { b, id: inv.id };
}

test("the claim survives the store roundtrip — both fields, patch semantics", async () => {
  const { b, id } = await invoiceWith(1);
  const inv = (await b.getInvoice(id))!;
  assert.ok(inv.payment_claimed_at);
  assert.equal(inv.payment_claim_note, "ref 4471, sent Tuesday");

  // An unrelated patch must not eat the claim: undefined means "not mentioned".
  await b.updateInvoice(id, { note: "thanks!" });
  assert.ok((await b.getInvoice(id))!.payment_claimed_at, "a note edit must not clear the claim");
});

test("clearing the claim is an explicit null, not an omission", async () => {
  const { b, id } = await invoiceWith(1);
  await b.updateInvoice(id, {
    payment_claimed_at: null as unknown as string,
    payment_claim_note: null as unknown as string,
  });
  const inv = (await b.getInvoice(id))!;
  // Falsy, not strictly undefined: the in-memory store keeps the explicit null while Postgres reads
  // NULL back as undefined. Every consumer gates on truthiness (`if (inv.payment_claimed_at)`), so
  // the two are behaviourally identical — asserting the exact shape here would be testing which
  // backend ran, not what the product does.
  assert.ok(!inv.payment_claimed_at);
  assert.ok(!inv.payment_claim_note);
});

test("a claim never moves money — amount_paid is untouched", async () => {
  const { b, id } = await invoiceWith(0);
  assert.equal((await b.getInvoice(id))!.amount_paid, 0,
    "a claim is a statement, and money is only counted by recordPayment");
});

test("the stand-down window is seven days — long enough for a transfer, too short to hide behind", () => {
  assert.equal(CLAIM_STANDDOWN_DAYS, 7);
});
