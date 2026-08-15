---
name: transaction-categorization
description: Categorize bank and card transactions into the correct GL accounts with consistent, tax-aware coding and clean owner/personal separation.
---

# Transaction Categorization

Every transaction must land in the right account. Consistency matters as much as correctness: the same vendor should hit the same account every month so trends are readable and tax prep is clean. You are building a chart-of-accounts discipline, not just clearing an inbox.

## Principles

1. **Substance over label.** A charge from "Amazon" could be office supplies, equipment (capitalize), software, or shipping. Categorize by what was bought, not by the merchant name. When unclear, check the amount, the frequency, and prior coding of the same vendor.
2. **Consistency via rules.** Once you determine a recurring vendor's category, set a rule so it auto-codes. But audit auto-coded transactions monthly — a vendor's charge type can change (SaaS vendor now also sells hardware).
3. **Match the chart of accounts to the tax return.** Categories should map cleanly to Schedule C / Form 1120 / 1120-S lines. If the client files Schedule C, your expense accounts should mirror its lines (advertising, car & truck, contract labor, supplies, etc.). This makes tax prep mechanical instead of a re-categorization project.

## High-stakes distinctions

- **Expense vs. capital asset.** Items with a useful life >1 year and above the client's capitalization threshold (commonly $2,500 per the de minimis safe harbor, or the client's written policy) are fixed assets, depreciated — not expensed. A $400 keyboard is supplies; a $6,000 laptop fleet is likely capitalized. Get the threshold right; it changes taxable income.
- **Owner personal vs. business.** Personal spending on a business card is an owner's draw (sole prop/partnership) or distribution/shareholder loan (S-corp), never an expense. Miscoding these inflates deductions and creates audit exposure. When in doubt, flag to the owner rather than deduct.
- **Meals vs. entertainment.** Meals are partially deductible (generally 50%); entertainment is generally nondeductible post-TCJA. Code them to separate accounts so the tax preparer applies the right limitation. Keep the business purpose in the memo.
- **Cost of goods sold vs. operating expense.** Direct costs of producing the product/service (materials, direct labor, inbound freight) are COGS and sit above gross profit. Overhead (rent, admin) is opex. Mixing them destroys margin analysis.
- **Loan payments.** Split into principal (balance sheet, reduces liability) and interest (expense) per the amortization schedule. Never expense the whole payment.
- **Transfers.** Moving money between the client's own accounts is not income or expense — code as a transfer so it nets out. Miscoding transfers as revenue is a classic overstatement.
- **Draws/contributions/distributions** hit equity, not the P&L.

## Sales tax, tips, and gross-up

When a merchant deposit is net of fees or a sale includes collected sales tax, record gross revenue and break out the fee/tax liability. Sales tax collected is a liability owed to the state, not revenue.

## Workflow

1. Pull all uncategorized transactions for the period.
2. Auto-apply established vendor rules; then review each auto-code for plausibility.
3. For unknowns, research: look at the memo, the amount, the vendor website, and prior treatment. Categorize confidently or route to the client — do not guess into a real account.
4. Use an "Ask Client" / clearing account for genuine unknowns, and drive it to zero before close. It should never carry a balance into the trial balance.
5. Add a memo for anything a reviewer or the IRS would question (large, round, unusual, or personal-looking charges).

## Quality bar

- **Great:** 100% categorized, zero in the Ask-Client account at close, recurring vendors coded consistently, capital items correctly capitalized, personal spend cleanly separated, memos on anything unusual, chart maps to the tax form.
- **Acceptable:** all categorized, minor immaterial items in a catch-all with notes.
- **Failing:** dumping ambiguous charges into "Miscellaneous" or "Office Expense" to clear the queue, expensing capital assets, or deducting personal spending. Each of these misstates income and creates tax risk.

## Never

- Never invent a business purpose. If you can't substantiate it, flag it.
- Never let "Uncategorized Income/Expense" survive into the financials.
- Never change a prior-period categorization without a documented reason and awareness that it may alter a closed/filed period.
