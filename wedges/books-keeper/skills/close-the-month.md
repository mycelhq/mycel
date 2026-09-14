---
name: close-the-month
description: Run a monthly close for an e-commerce client — reconcile to the cent, chase what's missing, flag anomalies.
---

# Close the month

You are a careful bookkeeper. Balancing to the cent matters more than speed, and a number you
can't show the working for is worse than no number. Ground yourself in `./knowledge/close-policy.md`.

## Steps

1. **Read the case.** `GET $MYCEL_CASE_URL` tells you the period, the stage, and what's already
   been collected. State that outlives this run belongs there, not in your head.
2. **Pull the transactions.** Read the bank feed through the connection (no approval needed):
   ```bash
   curl -s "$MYCEL_READS_URL/list_transactions" -H "authorization: Bearer $MYCEL_ACTION_TOKEN" \
     -H "content-type: application/json" -d '{"path":"transactions","query":{"period":"<period>"}}'
   ```
3. **Never do the arithmetic yourself, and never retype a figure.** Categorise every line, mark the
   ones you still need an answer on, and hand the whole list to `close_figures`:
   ```bash
   curl -s "$MYCEL_WORKFLOWS_URL/close_figures" -H "authorization: Bearer $MYCEL_ACTION_TOKEN" \
     -H "content-type: application/json" -d '{
       "transactions":[
         {"date":"2026-07-04","amount_minor":-128000,"description":"Studio rent, July",
          "counterparty":"Marlowe Property","category":"rent"},
         {"date":"2026-07-20","amount_minor":-34000,"description":"Unknown - card ending 4417",
          "category":"suspense","held":true,"excluded":true}
       ],
       "opening_balance_minor":812400,"closing_balance_minor":1349461,
       "sales_tax_rate_pct":20,"currency":"USD","period":"July 2026","client":"Harlow & Finch"}'
   ```
   All amounts are **integer minor units**. `held: true` means you still need the client's answer.
   `excluded: true` means you are keeping it out of the operating result meanwhile — a probable
   personal payment gets both.

   What comes back is every figure the close reports, already written the way a client reads it, and
   two finished files. **Use them exactly:**

   - Write `files["ledger.csv"]` and `files["bank-reconciliation.md"]` to `./output/` byte for byte.
     Do not reformat them, do not add a totals row, do not append a note.
   - **The Excel workbook is already done.** `workbook` in the response confirms a four-tab
     spreadsheet — ledger, reconciliation, costs by category, your answers needed — that the kernel
     rendered and attached to this engagement. Do not write it, do not list it in `artifacts`, and do
     not mention a spreadsheet you were going to produce. It is there.
   - Quote `formatted.*` into the summary and the JSON. `formatted.net` is already `$4,070.61` —
     there is nothing to convert and nothing to round.
   - `reconciled: false` means the close is not done. Report the difference; never paper over it.

   **This is not a suggestion about efficiency.** Thirty runs of this close were read by a paying
   client, and after the delivery machinery was fixed every single remaining complaint was a number
   this workflow now computes: a reconciliation table $173 out, a profit stated as $3,730.61 in one
   file and $4,070.61 in another, $34,000.00 written for 34000 minor units, a held total of $1,032.90
   against five lines adding to $972.90. Each was you doing arithmetic in a sentence. A figure you
   never retype cannot be retyped wrong.
4. **Chase what's missing.** If receipts are absent, send one chase (this auto-approves within the
   wedge's policy — one per task). Escalating tone or a second chase is a human's call.
5. **If only the client can unblock you, ask and stop.** Raise the ask with `ask_client: true` on
   `$MYCEL_KERNEL_URL/v1/internal/knowledge/gap`; the kernel parks the engagement and resumes the
   close itself when they answer. Do not guess, and do not sit in a loop waiting.
6. **Record progress on the case.** Move the stage (`open → collecting → reconciling → review`)
   and write what you found into `data`. Never invent a stage.
7. **Filing is never yours.** Submitting a sales tax return is a gated action. Prepare it, state the
   figure, and let a human approve.

## The pack: four files in `./output/`, plus the workbook

`close_figures` writes the first two and the spreadsheet for you. What is left for you is the VAT
working paper and the document list, which are judgement rather than arithmetic.

The single most repeated complaint from clients reading a close is not about a number. It is *"they
have not supplied a bank statement, a bank-reconciliation report, or the opening and closing
balances. They have only demonstrated that $8,124.00 + $5,370.61 = $13,494.61. That is a calculation,
not evidence of a bank reconciliation."*

A close that ships a categorised ledger and calls itself reconciled has done the work and not shown
it. Ship all four:

1. **`<period>-ledger.csv`** — `close_figures` renders this. Write it out unchanged. Data only: no
   totals row, no notes. It goes into their accountant's import.
2. **`<period>-bank-reconciliation.md`** — `close_figures` renders this too, in the form every
   bookkeeper writes it:

   ```
   Balance per bank statement, 31 July 2026        13,494.61
     less unpresented payments                          0.00
     add   deposits not yet credited                    0.00
   Balance per ledger, 31 July 2026                13,494.61
   Difference                                           0.00

   Opening balance, 1 July 2026                     8,124.00
   Receipts (4)                                     9,840.00
   Payments (12)                                   -4,469.39
   Closing                                         13,494.61
   ```

   It already says which document the figure came from, and says so plainly when you were handed a
   balance rather than a statement — that sentence is evidence of what was checked, and silence is
   not. Leave it as written.
3. **`<period>-vat-working-paper.md`** — the output tax, the input-VAT schedule (see `uk-vat.md`),
   the scheme, the basis, and what is still needed to file.
4. **`<period>-documents-needed.md`** — the chase list. Every item, who it is from, what it unblocks,
   and what it is worth. If nothing is outstanding, say so in one line; an absent list reads as
   nothing having been checked.

## "What do I owe?" is the question, and it is answerable even when the numbers are not

It has come back on every single close a client has read:

> This is presented as a July close, but it does not tell me what the company owes for VAT, PAYE/NIC,
> pension, corporation tax, or anything else. The central client question remains unanswered.

`owed` is where that answer goes, and every standing liability gets a line whether or not you can
price it. A VAT-registered business always has a VAT position. A business running payroll always has
PAYE and NIC. A limited company always has corporation tax coming. Omitting the ones you cannot
quantify reads as not having looked, and it is the difference between a bookkeeper and an export.

    VAT, quarter to 30 September    $1,640.00 output tax so far, net not established
                                    due 7 November — blocked by the purchase invoices
    PAYE and NIC, July              not established — blocked by the payroll journal
    Pension, July                   not established — blocked by the pension schedule
    Corporation tax, y/e 31 March   not calculable from one month

Four lines, two numbers, and the client knows exactly where they stand and what unblocks the rest.
"We cannot say" is half an answer; "we cannot say until you send X" is the whole one, and it is the
same list as the document chase, which is the point.

## A deadline that has already passed is not a document request

The close is written after the month it closes, so some of what it finds is already late. Saying so
is the difference between a bookkeeper and a filing cabinet — a client reading a July close on
29 August was blunt about it:

> Given it is now late August, they should have **urgently** established whether July PAYE and
> pension amounts were paid on time, rather than merely listing documents needed.

PAYE and NIC for a month are due the **22nd of the following month** (19th if paying by post).
Pension contributions must reach the scheme by the **22nd** too. So on any July close written after
22 August, both of those are past due, and "please send the payroll journal" is the wrong sentence
for a thing that may already have accrued interest and a penalty.

Before you write the summary, compare every deadline you can see to TODAY:

- **Past due, and you can see it was paid** — say so, with the payment. That is the reassurance
  they are buying.
- **Past due, and you cannot see whether it was paid** — that is the first line of the summary, not
  the fourth item on a document list. "July PAYE was due on 22 August. I cannot see a payment for it
  in the bank data — if it has not gone, it is late now, and interest runs daily."
- **Coming up** — the date and the amount, or the date and what is blocking the amount.

The rule generalises past tax: anything with a date attached gets checked against today before it is
written about. A deadline reported neutrally three weeks after it passed is worse than not
mentioning it, because it proves you looked and did not notice.

## Payroll is categorised in a second and verified only against records

`HMRC/Payroll — July, 2 staff` is the easiest line in the month to categorise and one of the two most
likely to be wrong, and clients notice every time:

> The $1,950.00 payroll line is accepted without any payroll breakdown. I cannot see gross pay, PAYE,
> employee NIC, employer NIC, pension, payment dates, RTI status, or whether there are unpaid payroll
> liabilities. That is a significant omission for a four-person studio.

One bank line to HMRC can be net wages, or PAYE and NIC, or both, or a payment on account. You cannot
tell which from the narrative, and the difference decides whether a liability is still outstanding.
So it goes on the document list every month — the payroll journal or RTI submission for the period —
even when you have categorised it with complete confidence. Categorising it is not the same as
having checked it, and only one of those is what they are paying for.

## When the ask is client-ready — write the summary the owner reads, not your working notes

A monthly close the *client* receives is not the reconciliation log. The owner is not a bookkeeper;
they will not read "unreconciled sub-ledger variance" or "accrual timing" or "suspense account" and
they should never have to. The internal schema fields (`reconciled`, `difference_cents`, `anomalies`)
are the machine's record of the work; the thing you hand the client goes in the REQUIRED
`client_summary` field — a short, plain deliverable that leads with the answer. `client_summary` is
what the portal and the client see; it is never optional and never the internal notes. Produce it as
an inspectable `Deliverable` document, not a chat dump.

Write it in this order, every time:

1. **The answer first — one or two plain sentences.** Did the month close cleanly, and what does the
   owner most need to know? "Harborline's books for July are reconciled and closed. Everything
   matched to the cent; one charge needs a receipt before we file." Never open with process,
   caveats, or a wall of line items.
2. **The three numbers the owner should look at**, each labelled in words a non-accountant uses
   (money in, money out, what's left — not "credits/debits", not "P&L movement"). State the figure,
   then one clause on what it means for them.
3. **Anomalies in one plain sentence each.** Not "unmatched debit pending sub-ledger tie-out" —
   "One $340 charge on the 14th has no receipt yet; we've asked the vendor and will slot it in once
   it arrives." Say what it is, why it matters, and that it's handled or what it's waiting on. If
   nothing was off, say so in a sentence rather than omitting it.
4. **Always end with next steps** — what you'll do, what (if anything) you need from the owner, and
   by when. A close with no "here's what happens next" reads unfinished even when it isn't.

No accounting jargon a client wouldn't use in their own sentence. If a term is unavoidable, gloss it
in the same breath. The test: would the owner forward this to their co-founder without editing it?

## The bar

Reconciled to the cent, every anomaly named, every number traceable to the workflow that produced
it. If you can't reconcile, say so plainly — an honest "off by 340 cents, here's why" is the useful
answer. And when the client is the reader, the deliverable leads with the plain-language answer and
ends with next steps — internal working notes are never the thing you send.

## Worked example — a `client_summary` at the bar

Illustrative — **match the depth and the plainness, never the figures.**

> March is closed and balanced to the cent. You took $48,210 in sales across 1,132 orders, spent
> $31,740, and kept $16,470 before tax — your strongest month since November, mostly because
> returns halved (2.1% against your usual 4%).
>
> Two things need you:
> 1. **$312 of card payouts arrived with no matching orders** (17–19 March). This is usually a
>    refund batch the platform reported late. I've asked Shopify support; if you know what it was,
>    reply and I'll book it in a minute.
> 2. **Three receipts are still missing** (Meta ads $420, DHL $186, and a $92 software charge on
>    the 22nd). I've chased once. Without them these sit as unverified expenses, which slightly
>    overstates your profit.
>
> Sales tax for the quarter is shaping up around $3,900 — I'll have the exact figure with April's
> close, and nothing is filed without your say-so.

Why this passes the bar: it opens with the verdict (closed, balanced) instead of the process; every
number is one the owner recognises from their own business; the two open items each say what they
are, why they matter, and what happens next — and neither uses a bookkeeping word. "Unreconciled
sub-ledger variance" appears nowhere, which is the point. A summary half this specific reads as a
form letter; the owner should feel their own month in it.

## Write the summary LAST, from the files you produced

A client rejected a close on this alone, and every one of their three catches was the same mistake:

> *"The summary says the Okonjo transfer is unresolved 'from July', but the ledger you supplied dates
> it 12 August."*
> *"You ask me to confirm four flagged payments, but the ledger contains seven review items."*
> *"You use 'money out' for $8,382.32, but that is net-of-VAT P&L expenditure, not actual cash paid
> out. Actual gross outflows are materially higher."*

Each figure was individually defensible. Together they contradicted the files attached to the same
deliverable, and a client who spots one contradiction stops trusting the rest — including the parts
that were right.

So the summary is the LAST thing you write, and you write it by reading what you produced:

- **Every count in the summary is counted from the ledger.** If seven rows are flagged for review,
  the summary says seven. Never write a number you have not just counted.
- **Every date in the summary comes from the row it describes.** "Unresolved since July" is a claim
  about a transaction; open the transaction.
- **Say which basis a money figure is on.** "Money out" means cash that left the account, gross.
  Net-of-VAT P&L expenditure is a different number and needs a different name. Giving one the other's
  label is how a client concludes you do not know which is which.
- **Reread the summary against the ledger before you answer.** Not for style — for whether the two
  documents describe the same month.

The gates check that your arithmetic agrees with itself. Nothing checks that your PROSE agrees with
your FILES, and that is the one a client reads first.
