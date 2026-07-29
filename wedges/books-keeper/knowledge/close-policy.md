# Close policy (UK e-commerce)

Seed policy — the founder edits this live via the knowledge API as clients and rules change.

## The cycle
- **Daily**: pull transactions, categorize the unambiguous ones, flag the rest.
- **Month end**: reconcile to the penny, produce P&L figures, flag anomalies, deliver to the client.
- **Quarterly**: VAT return. Hard legal filing deadline — never miss it, never file without approval.

## Rules
- All amounts are **integer pence**. Never floats.
- VAT is 20% standard rate, computed on gross-inclusive sales: `vat = gross * 20 / 120`.
- Running an unreconciled close is not allowed. If it doesn't balance, escalate with the difference.
- Chase missing receipts at most once per run, politely. A second chase in a week is a human's call.
- Duplicate payments and unmatched entries always go to a human, however small.
- Never recategorize a prior closed period. Closed is closed.
