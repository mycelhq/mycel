---
name: bill-a-week
description: Turn one client's approved timesheets for one week into an invoice a payables clerk can pay without asking anybody a question.
---

# Bill a week

Ground yourself in `./knowledge/when-an-invoice-gets-disputed.md` and in the desk's own answers under
`intake/` — `intake/invoice-terms.md` is the one that decides whether this gets paid, because it
holds what each client insists on seeing.

The measure of a good invoice is not that it is correct. It is that nobody has to email about it.

## Steps

1. **Refuse an incomplete week.** `week_status` decides whether a client-week is billable, and it
   only says yes when *every* assignment for that client that week is approved. If it is not in
   `ready_to_bill`, do not build a partial invoice — say which assignment is holding it and stop.
   A partial invoice for a week the client thinks is whole is the most common way a good desk gets
   a payment held.
2. **Call `bill_lines` for every number.** All of them: line totals, subtotal, tax, total, margin.
   Do not add anything up yourself, do not restate a figure in prose that the workflow did not
   return, and do not convert minor units into pounds and pence anywhere — the schema is integer
   minor units end to end and something downstream is relying on that.
3. **Check the references before the arithmetic.** A PO number in the wrong place, a missing
   employee reference, a consolidated invoice for a client who wants one per contractor — each of
   these bounces an invoice that is arithmetically perfect. The desk's intake answers say which
   client wants what. If a client needs a PO and the assignment has none, put that in
   `covering_note` in plain words and leave `purchase_order` absent. **Never invent a reference.**
4. **Write the covering note for a payables clerk, not for the hiring manager.** Week ending date,
   the contractors by name, the PO, the total. Three lines. They are matching your document against
   something on their side and the faster that match happens the sooner you are paid.
5. **Say what the week's margin was** in your reasoning, from `margin_bp`. If `bill_lines` returned
   `margin_unavailable`, repeat that sentence rather than leaving margin out — a missing margin
   figure and a zero margin figure look identical on a dashboard, and only one of them is true.

## Sending it (always gated)

`send_invoice` is a separate, required, high-risk approval on this desk and it is separate from
`send` on purpose: a desk head who has learned to wave chases through has not thereby agreed to
wave invoices through. Draft it, hand it over, and wait.

If the desk edits your draft before approving, that edit is the house standard from then on — it is
captured as a correction and you will see it next week. Do not re-send a rejected invoice.
