// HARD EVAL — bookkeeping exactness. "Does the money math survive the cases that break naive code?"
//
// Bookkeeping is a trust business: one wrong penny and the founder loses the client and maybe their
// licence. The whole vertical rests on `reconcile` (books-keeper references it by `lib`). This evals
// it on the adversarial money cases — floats, duplicates, unmatched rows, tax — where a wrong answer
// is not a rounding nit, it is a false "reconciled" that hides a real hole in the books.
//
// Integer cents throughout, by contract. A case that a float would fail is the point, not an edge.
import { test } from "node:test";
import assert from "node:assert/strict";
import reconcile from "../../workflows/reconcile.mjs";

type Recon = {
  difference_cents: number;
  sales_tax_due_cents: number;
  reconciled: boolean;
  anomalies: string[];
  unmatched_bank: unknown[];
};
const run = (a: Record<string, unknown>) => reconcile(a) as Recon;

test("EVAL: a clean set balances to exactly zero and is marked reconciled", () => {
  const r = run({
    bank_transactions: [{ amount_cents: 12000, date: "2026-10-02", reference: "A1" }],
    ledger_entries: [{ amount_cents: 12000, date: "2026-10-02", reference: "A1" }],
  });
  assert.equal(r.difference_cents, 0);
  assert.equal(r.reconciled, true);
});

test("EVAL: an off-by-one-penny is CAUGHT, not rounded away", () => {
  // The classic silent failure: (amount/100).toFixed(2) style code hides a 1c hole. It must not.
  const r = run({
    bank_transactions: [{ amount_cents: 10001, date: "2026-10-02", reference: "A1" }],
    ledger_entries: [{ amount_cents: 10000, date: "2026-10-02", reference: "A1" }],
  });
  assert.equal(r.difference_cents, 1, "a single penny of difference must survive as exactly 1c");
});

test("EVAL: a values that a float would corrupt stays exact (0.1 + 0.2 territory)", () => {
  // 10c + 20c must be 30c. In floats, 0.1 + 0.2 = 0.30000000000000004; in cents it is just 30.
  const r = run({
    bank_transactions: [
      { amount_cents: 10, date: "2026-10-02", reference: "A" },
      { amount_cents: 20, date: "2026-10-02", reference: "B" },
    ],
    ledger_entries: [{ amount_cents: 30, date: "2026-10-02", reference: "C" }],
  });
  assert.equal(r.difference_cents, 0, "10c + 20c must reconcile to exactly 30c");
});

test("EVAL: an unmatched bank transaction refuses to report a false 'reconciled'", () => {
  const r = run({
    bank_transactions: [
      { amount_cents: 5000, date: "2026-10-02", reference: "A1" },
      { amount_cents: 4500, date: "2026-10-09", reference: "C3" }, // no ledger match
    ],
    ledger_entries: [{ amount_cents: 5000, date: "2026-10-02", reference: "A1" }],
  });
  assert.equal(r.reconciled, false, "a hole in the books must never be reported as reconciled");
  assert.ok(r.anomalies.length > 0, "the unmatched row must surface as an anomaly a human can act on");
});

test("EVAL: sales tax is TAX-INCLUSIVE and exact in cents — the correct VAT model, never a defaulted rate", () => {
  // The right accounting model: a displayed sale of 12000c at 20% VAT already INCLUDES the tax, so
  // the tax portion is gross * rate / (100 + rate) = 12000 * 20 / 120 = 2000c — not 12000 * 0.20.
  // Getting this wrong (tax-exclusive) over-reports VAT owed and is a filing error. Tax on SALES
  // (positive amounts) only.
  const r = run({
    bank_transactions: [{ amount_cents: 12000, date: "2026-10-02", reference: "A1" }],
    ledger_entries: [{ amount_cents: 12000, date: "2026-10-02", reference: "A1" }],
    sales_tax_rate_pct: 20,
  });
  assert.equal(r.sales_tax_due_cents, 2000, "VAT must be extracted tax-inclusive, in exact integer cents");
  // No rate given → no tax invented.
  const noRate = run({
    bank_transactions: [{ amount_cents: 13750, date: "2026-10-02", reference: "A1" }],
    ledger_entries: [{ amount_cents: 13750, date: "2026-10-02", reference: "A1" }],
  });
  assert.equal(noRate.sales_tax_due_cents, 0, "an un-supplied tax rate must default to 0, not a guessed UK/US rate");
});

test("EVAL: a non-integer-cents input is rejected, not silently truncated", () => {
  // A float leaking into the ledger is exactly how drift starts. The contract is integer cents.
  assert.throws(
    () => run({ bank_transactions: [{ amount_cents: 100.5, date: "2026-10-02", reference: "A1" }], ledger_entries: [] }),
    /integer cents/i,
    "a fractional cent must throw, not be rounded into the books",
  );
});
