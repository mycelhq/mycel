// Deterministic reconciliation. Bookkeeping has to balance to the penny, so every number here is
// integer pence — no floats, no drift. An LLM must never do this arithmetic.
//
// Founder code. Pure: no I/O, no clock, no randomness.

const asPence = (v, label) => {
  const n = typeof v === "string" ? Number(v) : v;
  if (!Number.isFinite(n)) throw new Error(`${label} must be a number (pence)`);
  if (!Number.isInteger(n)) throw new Error(`${label} must be integer pence, got ${n}`);
  return n;
};

export default function reconcile(args) {
  const bank = Array.isArray(args.bank_transactions) ? args.bank_transactions : [];
  const ledger = Array.isArray(args.ledger_entries) ? args.ledger_entries : [];
  const vatRate = Number(args.vat_rate_pct ?? 20);

  const bankTotal = bank.reduce((s, t, i) => s + asPence(t.amount_pence, `bank_transactions[${i}].amount_pence`), 0);
  const ledgerTotal = ledger.reduce((s, e, i) => s + asPence(e.amount_pence, `ledger_entries[${i}].amount_pence`), 0);
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
      (e) => !usedLedger.has(e) && asPence(e.amount_pence, "ledger") === asPence(t.amount_pence, "bank") && e.date === t.date,
    );
    if (byAmount) {
      usedLedger.add(byAmount);
      continue;
    }
    unmatchedBank.push(String(t.reference ?? `${t.date}:${t.amount_pence}`));
  }
  const unmatchedLedger = ledger.filter((e) => !usedLedger.has(e)).map((e) => String(e.reference ?? `${e.date}:${e.amount_pence}`));

  // VAT on sales only (positive amounts), gross-inclusive: vat = gross * rate / (100 + rate).
  const grossSales = bank.filter((t) => t.amount_pence > 0).reduce((s, t) => s + t.amount_pence, 0);
  const vatDue = Math.round((grossSales * vatRate) / (100 + vatRate));

  // Anomalies worth a human's attention.
  const anomalies = [];
  const seen = new Map();
  for (const t of bank) {
    const key = `${t.amount_pence}|${t.counterparty ?? ""}`;
    if (seen.has(key)) anomalies.push(`possible duplicate: ${t.counterparty ?? "?"} ${t.amount_pence}p on ${t.date} and ${seen.get(key)}`);
    else seen.set(key, t.date);
  }
  for (const r of unmatchedBank) anomalies.push(`bank transaction with no ledger entry: ${r}`);
  for (const r of unmatchedLedger) anomalies.push(`ledger entry with no bank transaction: ${r}`);

  return {
    reconciled: difference === 0 && unmatchedBank.length === 0 && unmatchedLedger.length === 0,
    difference_pence: difference,
    bank_total_pence: bankTotal,
    ledger_total_pence: ledgerTotal,
    gross_sales_pence: grossSales,
    vat_due_pence: vatDue,
    unmatched_bank: unmatchedBank,
    unmatched_ledger: unmatchedLedger,
    anomalies,
  };
}
