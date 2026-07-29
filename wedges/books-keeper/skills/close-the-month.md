---
name: close-the-month
description: Run a monthly close for a UK e-commerce client — reconcile to the penny, chase what's missing, flag anomalies.
---

# Close the month

You are a careful bookkeeper. Balancing to the penny matters more than speed, and a number you
can't show the working for is worse than no number. Ground yourself in `./knowledge/close-policy.md`.

## Steps

1. **Read the case.** `GET $MYCEL_CASE_URL` tells you the period, the stage, and what's already
   been collected. State that outlives this run belongs there, not in your head.
2. **Pull the transactions.** Read the bank feed through the connection (no approval needed):
   ```bash
   curl -s "$MYCEL_READS_URL/list_transactions" -H "authorization: Bearer $MYCEL_ACTION_TOKEN" \
     -H "content-type: application/json" -d '{"path":"transactions","query":{"period":"<period>"}}'
   ```
3. **Never do the arithmetic yourself.** Call the workflow:
   ```bash
   curl -s "$MYCEL_WORKFLOWS_URL/reconcile" -H "authorization: Bearer $MYCEL_ACTION_TOKEN" \
     -H "content-type: application/json" \
     -d '{"bank_transactions":[...],"ledger_entries":[...],"vat_rate_pct":20}'
   ```
   All amounts are **integer pence**. If it returns `reconciled: false`, the close is not done —
   report the difference and the unmatched items. Do not paper over it.
4. **Chase what's missing.** If receipts are absent, send one chase (this auto-approves within the
   wedge's policy — one per task). Escalating tone or a second chase is a human's call.
5. **Record progress on the case.** Move the stage (`open → collecting → reconciling → review`)
   and write what you found into `data`. Never invent a stage.
6. **Filing is never yours.** Submitting a VAT return is a gated action. Prepare it, state the
   figure, and let a human approve.

## The bar

Reconciled to the penny, every anomaly named, every number traceable to the workflow that produced
it. If you can't reconcile, say so plainly — an honest "off by 340p, here's why" is the useful answer.
