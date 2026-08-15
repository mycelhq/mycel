// Deterministic reconciliation. Bookkeeping has to balance to the cent, so every number here is
// integer cents — no floats, no drift. An LLM must never do this arithmetic.
//
// Founder code. Pure: no I/O, no clock, no randomness.

const asCents = (v, label) => {
  const n = typeof v === "string" ? Number(v) : v;
  if (!Number.isFinite(n)) throw new Error(`${label} must be a number (cents)`);
  if (!Number.isInteger(n)) throw new Error(`${label} must be integer cents, got ${n}`);
  return n;
};

export default function reconcile(args) {
  const bank = Array.isArray(args.bank_transactions) ? args.bank_transactions : [];
  const ledger = Array.isArray(args.ledger_entries) ? args.ledger_entries : [];
  // No default rate. Sales tax varies by state, county and nexus; inventing 20% would be a UK VAT
  // rate wearing a US name. A caller that wants tax computed says so.
  const taxRate = Number(args.sales_tax_rate_pct ?? 0);

  const bankTotal = bank.reduce((s, t, i) => s + asCents(t.amount_cents, `bank_transactions[${i}].amount_cents`), 0);
  const ledgerTotal = ledger.reduce((s, e, i) => s + asCents(e.amount_cents, `ledger_entries[${i}].amount_cents`), 0);
  const difference = bankTotal - ledgerTotal;

  // Match on reference then (amount, date). Anything left is what the human needs to look at.
  const ledgerByRef = new Map(ledger.filter((e) => e.reference).map((e) => [String(e.reference), e]));
  const usedLedger = new Set();
  const unmatchedBank = [];
  for (const t of bank) {
    const byRef = t.reference ? ledgerByRef.get(String(t.reference)) : undefined;
    if (byRef && !usedLedger.has(byRef)) {
      usedLedger.add(byRef);
      continue;
    }
    const byAmount = ledger.find(
      (e) => !usedLedger.has(e) && asCents(e.amount_cents, "ledger") === asCents(t.amount_cents, "bank") && e.date === t.date,
    );
    if (byAmount) {
      usedLedger.add(byAmount);
      continue;
    }
    unmatchedBank.push(String(t.reference ?? `${t.date}:${t.amount_cents}`));
  }
  const unmatchedLedger = ledger.filter((e) => !usedLedger.has(e)).map((e) => String(e.reference ?? `${e.date}:${e.amount_cents}`));

  // Sales tax on sales only (positive amounts), tax-inclusive: tax = gross * rate / (100 + rate).
  const grossSales = bank.filter((t) => t.amount_cents > 0).reduce((s, t) => s + t.amount_cents, 0);
  const taxDue = Math.round((grossSales * taxRate) / (100 + taxRate));

  // Anomalies worth a human's attention.
  const anomalies = [];
  const seen = new Map();
  for (const t of bank) {
    const key = `${t.amount_cents}|${t.counterparty ?? ""}`;
    if (seen.has(key)) anomalies.push(`possible duplicate: ${t.counterparty ?? "?"} ${t.amount_cents}c on ${t.date} and ${seen.get(key)}`);
    else seen.set(key, t.date);
  }
  for (const r of unmatchedBank) anomalies.push(`bank transaction with no ledger entry: ${r}`);
  for (const r of unmatchedLedger) anomalies.push(`ledger entry with no bank transaction: ${r}`);

  return {
    reconciled: difference === 0 && unmatchedBank.length === 0 && unmatchedLedger.length === 0,
    difference_cents: difference,
    bank_total_cents: bankTotal,
    ledger_total_cents: ledgerTotal,
    gross_sales_cents: grossSales,
    sales_tax_due_cents: taxDue,
    unmatched_bank: unmatchedBank,
    unmatched_ledger: unmatchedLedger,
    anomalies,
  };
}
