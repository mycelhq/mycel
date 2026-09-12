# How a contract week runs

Seed knowledge. It describes the rhythm every contract desk runs on, not this desk's version of it —
the deadlines, approvers, rates and terms are answered at intake and those answers win over anything
written here.

## The week

A contract desk's week is a loop, and every step of it has a deadline somebody else controls.

- **Saturday** — the work week ends. Everything below is about that week.
- **Sunday/Monday** — contractors submit timesheets. Some will not.
- **Monday** — the client's line manager approves them. Some will not.
- **Monday/Tuesday** — every client whose week is fully approved is invoiced.
- **Friday** — contractors are paid, usually whether or not the client has settled.

That last line is the whole financial shape of the trade. The desk is funding two to six weeks of
contractor pay out of its own cash at any moment, so a week that does not get invoiced on Tuesday is
not a delayed invoice, it is a hole in the following month's cash.

## Who is holding it up

There are exactly two answers and they must never be confused:

- **The contractor has not submitted.** Chase the contractor.
- **The contractor submitted and the client has not approved.** Chase the client's approver. The
  contractor did their part and hearing about it again is how a desk loses people.

`week_status` returns this as `state` on every missing assignment. Read it before writing anything.

## Partial weeks

A client-week is billable when *every* assignment for that client that week is approved — not most
of them. Invoicing three of a client's four contractors produces an invoice the client believes is
the whole week, a second invoice a fortnight later that looks like a duplicate, and a conversation.
Hold the week instead, and say which assignment is holding it.

## Extensions

An assignment has an end date from the day it starts, and it is the most predictable revenue event
on the desk. The conversation opens inside the notice window — three weeks out is the common
convention and the desk sets its own — and it goes to the hiring manager, not to HR, because HR will
tell you to wait for a requisition that gets raised the week after the contractor has gone.

An assignment that reaches its end date with nobody having asked is recorded as `lapsed`, which is
deliberately not the same stage as `ended`. It is the failure this desk exists to stop.

## What is never guessed

- Rates, overtime multipliers, and what counts as a bank holiday.
- Payment terms, and whether contractor pay depends on the client having paid.
- Any consequence of a late timesheet — withheld pay, contract clauses, penalty terms.

Each of these is real on some desks and not on others, and inventing one puts a threat in writing on
the agency's letterhead. If it is needed and it is not known, raise it as a gap.
