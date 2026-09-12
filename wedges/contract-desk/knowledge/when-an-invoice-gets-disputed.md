# Why a correct invoice does not get paid

Seed knowledge. Contract invoices are rejected far more often for what is missing from them than for
what is wrong in them, and the rejection is done by someone with no authority to fix it and no
interest in calling you about it.

## The five that account for nearly all of it

1. **No purchase order, or the PO in the wrong place.** Some clients match on a PO in the header,
   some on the line. A payables system that cannot match drops the invoice into a queue nobody
   reads. If the PO is not known, that is a sentence in the covering note, never an invented
   reference.
2. **Consolidated when they wanted it split, or split when they wanted it consolidated.** One
   invoice per contractor versus one per week per client is a per-client fact and a common cause of
   a whole month being reissued.
3. **Hours that do not match the approved timesheet.** Not a rounding difference — a rounding
   difference *is* a mismatch to the person checking. Minutes times the rate, computed once, by
   `bill_lines`, and never restated to a different precision in the covering email.
4. **A week that was only partly approved.** Billing three of four contractors makes the second
   invoice look like a duplicate of the first.
5. **A name the client does not recognise.** Contractors are on client systems under a legal name,
   an employee reference, or a supplier code, and it is often not what the desk calls them.

## Tone when one is disputed

A dispute is not a dunning problem and it is not a tone problem. It is a fact that needs finding:
which line, which hours, which approval. Find the fact, put it in front of the desk head, and let
them answer. Do not argue with a payables clerk and do not re-send the same invoice with a friendlier
covering note.

## The number nobody should narrate

The total, the tax, the subtotal, and the margin all come from `bill_lines` in integer minor units.
None of them may be recomputed, converted, or rounded on the way into an email. A penny is enough to
hold a week, and a week is enough to make the desk fund another round of contractor pay itself.
