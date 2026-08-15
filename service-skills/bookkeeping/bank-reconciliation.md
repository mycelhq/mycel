---
name: bank-reconciliation
description: Reconcile a bank, credit card, or payment-processor account to its statement so the GL balance is provably correct with zero unexplained difference.
---

# Bank & Account Reconciliation

Reconciliation proves that the cash (or card, or processor) balance in the books matches reality. It is the foundation every other number rests on. The output is a reconciliation report where the difference is exactly zero and every reconciling item is identified — not estimated, not plugged.

## The core identity

Statement ending balance
− outstanding checks/withdrawals (recorded in books, not yet cleared bank)
+ deposits in transit (recorded in books, not yet cleared bank)
= adjusted bank balance = GL cash balance.

If those don't equal, you have unrecorded transactions, duplicates, timing differences, or errors. Your job is to find which.

## Procedure

1. **Get the real statement.** Reconcile to the bank/processor statement PDF, not to the feed. Feeds can double-post, drop transactions, or lag. The statement is the source of truth.
2. **Match the endpoints.** Set the statement ending date and ending balance in the reconciliation tool. Confirm the beginning balance equals last month's reconciled ending balance — if it doesn't, a prior reconciliation was altered; investigate before proceeding.
3. **Clear matched items.** Tick off every transaction that appears on both the statement and the books. Most auto-match; scrutinize the auto-matches for wrong-amount or wrong-date pairings.
4. **Resolve unmatched book items** (in books, not on statement): legitimately outstanding (a check not yet cashed — fine, list it) vs. a transaction that will never clear (voided, duplicate, or dated wrong).
5. **Resolve unmatched statement items** (on statement, not in books): bank fees, interest, merchant fees, chargebacks, auto-drafts, NSF fees. These are almost always missing from the books — record them now.
6. **Drive the difference to zero.** Do not finish with a residual. A $0.02 difference is still a difference and often signals a transposition elsewhere.

## Finding a difference (in order of likelihood)

- **Equal to a single transaction amount:** one missing or duplicated entry — search the statement for that exact figure.
- **Divisible by 9:** transposition error (e.g., $54 entered as $45). Check digit order.
- **Exactly double a transaction:** a duplicate posting.
- **Round number:** often a manual entry error or a transposed decimal.
- **Grows each month:** a systematic issue — a recurring auto-draft never being recorded, or a feed consistently dropping one transaction type.

## Processor accounts (Stripe, Square, PayPal)

Treat these as clearing accounts, never as simple bank accounts. Gross charges, refunds, processing fees, chargebacks, and payout timing all move through them. Reconcile using the processor's payout/balance report: gross sales − fees − refunds = net payout to bank. The clearing account should net near zero after payouts settle; a persistent balance is unrecorded fees or in-transit payouts. Booking only the net deposit understates both revenue and expenses and will misstate the P&L.

## Credit cards

Reconcile to the statement closing date, not month end (they differ). The card's ending balance is a liability — it should be a credit/negative on the asset side and match the statement's balance owed. Confirm the payment from the bank account matches a payment on the card statement so you don't double-count.

## Quality bar

- **Great:** every account reconciled to statement, zero difference, all fees/interest captured, outstanding items are genuinely outstanding (aged checks >90 days investigated for staleness), and the reconciliation is locked.
- **Acceptable:** difference zero, minor unexplained-but-immaterial timing items documented.
- **Failing:** a "reconciled" report with a residual difference, or force-matching transactions of different amounts to clear the screen. Both hide errors that compound.

## Never

- Never post a plug to "Reconciliation Discrepancy" to close it out. That account existing with a balance is a failed reconciliation wearing a disguise.
- Never delete a transaction to make it match — void with a memo, or correct it, so the audit trail survives.
- Never reconcile to the feed balance when the statement is available.
