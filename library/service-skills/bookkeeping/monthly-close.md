---
name: monthly-close
description: Run a disciplined month-end close for an SMB client — from cutoff through reconciliation, accruals, and a reviewed, lock-ready trial balance.
---

# Monthly Close

You are closing the books for a client for a specific accounting period. The goal is a trial balance that is complete, accurate, and defensible — one an outside CPA could pick up without questions. Work to a checklist; a close is a sequence, not a vibe.

## Sequence (do not reorder)

1. **Confirm cutoff.** Fix the period end (usually last calendar day of month). Every transaction dated on/before that date belongs in the period; anything after does not. Flag transactions posted in the period but dated outside it — they are the #1 source of restated closes.
2. **Import and verify feeds.** Confirm every bank, credit card, loan, and merchant-processor (Stripe, Square, PayPal) feed pulled through period end. Check for gaps: a missing day in a feed silently drops transactions. Compare the feed's closing balance to the actual statement closing balance before you reconcile anything.
3. **Reconcile cash and cards first** (see the reconciliation skill). Nothing else is trustworthy until cash ties. Reconcile every bank and card account to its statement. Zero unexplained difference — not "close."
4. **Reconcile clearing/suspense accounts to zero.** Undeposited funds, payroll clearing, Stripe/PayPal clearing, and any "Ask My Accountant" account should net to zero or a fully explained residual. A ballooning clearing account is unrecorded revenue or fees.
5. **Sub-ledger tie-outs.** A/R aging total = Accounts Receivable GL balance. A/P aging = Accounts Payable GL. Inventory valuation report = Inventory GL. Fixed asset register = asset GL less accumulated depreciation. Any variance is a mis-posting to the control account.
6. **Accruals and deferrals (the accrual-basis heart of close).**
   - Accrue expenses incurred but unbilled (utilities, contractor work, interest).
   - Defer revenue collected but unearned (prepaid retainers, annual subscriptions — recognize ratably).
   - Amortize prepaids (insurance, software annual plans) — record the month's portion.
   - Record depreciation per the fixed-asset schedule.
   - Accrue payroll for days worked in the period but paid next period, plus employer taxes and PTO.
7. **Recurring/standard journal entries.** Post depreciation, amortization, loan interest split (principal vs. interest per the amortization schedule — do not expense principal), and any allocation entries.
8. **Review the P&L for reasonableness.** Compare each line to prior month and same-month prior year. Investigate any swing >10% or >$500 (scale the threshold to client size). A zero in a normally-populated line (e.g., rent) is a missed bill, not a good month.
9. **Review the balance sheet.** Every balance should be explainable. Negative asset or negative liability balances are red flags. Retained earnings should equal prior-year close plus/minus current-year net income — if it moved unexpectedly, someone posted to a closed period.
10. **Produce the trial balance and close package**, then lock the period.

## Quality bar

- **Great:** every reconciliation ties to zero; every balance sheet line has supporting documentation (statement, schedule, or amortization table); flux analysis is done with written explanations for material swings; the close is finished within 5–10 business days of month end.
- **Acceptable:** cash and cards reconciled, sub-ledgers tie, obvious accruals booked.
- **Failing:** plugging a difference to an expense account to "make it balance." Never plug. Find it.

## Common failure modes

- **Double-counting revenue:** recording both the Stripe deposit and the invoice payment. Reconcile the processor as a clearing account so gross revenue and fees land correctly and the net deposit clears.
- **Expensing loan principal** instead of splitting principal/interest.
- **Missing accruals** because "the bill hasn't come in" — accrual basis records the expense when incurred, not when billed.
- **Owner personal expenses** run through the business — reclass to owner's draw/distribution, do not deduct.
- **Reclassing to fix the P&L** after the fact without documenting why. Every reclass entry gets a memo.

## Close package deliverable

Hand the client (and file in their workpapers): trial balance, P&L (month and YTD), balance sheet, statement of cash flows, A/R and A/P aging, and a short narrative flagging anything unusual, decisions made, and items needing owner input. Lock the period in the accounting system so no one posts to it. If something must change post-lock, reopen deliberately, document the change, and re-lock — never leave a period silently reopened.
