---
name: admin-operations-and-expenses
description: How to run a client's recurring back-office admin — expenses, invoices, subscriptions, data entry, filing — accurately and audit-ready.
---

# Admin Operations and Expenses

This is the invisible plumbing: expense reports, invoice tracking, subscription management, receipts, CRM/data entry, document filing. The bar is accuracy and consistency — a single transposed number or a missed renewal costs real money and trust. Boring done perfectly is the whole job.

## Expense reports

- **Capture every receipt** at source: date, vendor, amount, currency, category, business purpose, and who was present (for meals/entertainment — many tax authorities require attendees and purpose). A receipt with no stated purpose is incomplete; add it.
- **Categorize consistently** using the client's or their accountant's chart of accounts. Don't invent categories. When unsure between two, pick the one used for similar past expenses and stay consistent.
- **Currency**: convert foreign expenses at the transaction-date rate (or the card statement's posted rate if reimbursing off the card) and keep both the original and converted amounts.
- **Reconcile against the card statement.** Every card line should map to a receipt; every receipt to a line. Flag missing receipts and personal charges. This reconciliation is what makes a report audit-ready.
- **Policy check**: flag anything over per-diem or policy limits before submitting, rather than after it's rejected.
- **Totals**: verify the report total against the sum of line items. Re-add. A wrong total is the most common and most embarrassing error.

## Invoices (payable and receivable)

- For **incoming** invoices: verify the vendor, amount, and that goods/services were actually received before queuing for payment. Match to the PO or agreement. Note the due date and any early-payment discount. Never pay a first-time vendor's new bank details without an out-of-band confirmation — invoice/payment-redirect fraud is common and expensive.
- For **outgoing** invoices: correct client details, line items, rates, tax, PO number if required, clear payment terms and due date, and a unique sequential invoice number. Send promptly — cash flow depends on it.
- Track an **aging view**: what's outstanding, by how many days. Chase politely at the terms boundary (e.g. on due date, then +7, +14) with escalating firmness. Log every touch.

## Subscription and vendor management

Maintain a living register of every recurring charge: service, owner, monthly/annual cost, renewal date, plan tier, and whether it's still used. Review before each renewal — flag unused or duplicate tools (two do the same job) and anything auto-escalating in price. Catch annual renewals ~30 days out so the client can cancel or renegotiate before the non-refundable charge hits. This register alone often pays for the VA.

## Data entry and CRM hygiene

- **Enter once, verify twice** for anything numeric or identifying (bank details, addresses, dollar amounts, dates). Read it back against the source.
- Follow the existing schema — field formats, naming conventions, required fields. Consistency beats cleverness; a CRM half-filled in three different formats is worse than useless.
- De-duplicate as you go: search before creating a new record. Merge duplicates rather than stacking them.
- Timestamp and note the source of each update so the trail is auditable.

## Filing and document management

Mirror the client's existing folder structure and naming convention — don't impose your own. A good default when none exists: `YYYY-MM-DD_Category_Descriptor`. Keep a consistent home for contracts, receipts, tax docs, and IDs. Never store sensitive documents (SSNs, passports, bank details, passwords) in plain, unsecured locations; use the client's designated secure store and follow least-exposure — don't paste secrets into notes or emails.

## Quality bar and failure modes

Great: reports reconcile to the cent, renewals are caught with time to act, the CRM is clean enough to trust, and an accountant or auditor could follow every entry without asking you a question. Acceptable: accurate entries, correct totals, nothing overdue slips. Failing: a math error in a total, a duplicate CRM record, a missed renewal that auto-charged, a receipt with no business purpose, or paying a fraudulent redirected invoice.

Discipline that prevents most failures: re-add every total, confirm changed bank details out-of-band, timestamp every entry, and reconcile card-to-receipt every cycle. When a number doesn't tie out, stop and find the discrepancy — never "round it to make it balance."
