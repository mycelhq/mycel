# Security questionnaire — Meridian Health, vendor review

*(Reference document. Meridian Health and Larkspur Analytics are invented; every control, date and
document name below is made up to show the standard. Nothing in it is true of anybody.)*

---

## Client summary

38 of 46 questions answered from your own documentation, every one cited. 6 need you, and 2 are
answered "no" on purpose — saying no to a control you do not have is a normal answer that buyers
expect, and inventing a yes is the one thing that ends a deal after it has been signed.

The 6 that need you cluster on one theme: you almost certainly do these things and nothing writes
them down. That is a documentation gap, not a security gap, and it is worth two hours of your time
because the same six questions appear on every questionnaire you will ever receive.

---

## Answered — a sample of the range

**Q7. Do you encrypt customer data at rest?**

> Yes. All customer data is stored in AWS RDS and S3 with AES-256 encryption at rest, enabled at the
> account level and enforced by policy. Key management is via AWS KMS with annual key rotation.

*Cited: `soc2-summary.md` §4.2, `infrastructure-overview.md` §2.*

**Q12. How frequently do you review access permissions?**

> Quarterly. Access reviews cover all production systems and are performed by the engineering lead,
> with results recorded in the compliance log. Off-boarding removes access within one business day.

*Cited: `access-control-policy.md` §3.* — **Note the scope.** The policy documents the quarterly
review and the one-day off-boarding SLA. It does not document a review triggered by a role *change*
rather than a departure, so that is not claimed here.

**Q19. Do you maintain a formal incident response plan?**

> No formal written plan. Incidents are handled by the on-call engineer following the escalation
> path in the runbook, with a post-incident review for anything customer-affecting. A formal plan is
> not currently documented.

*Cited: `oncall-runbook.md` §1.* — **This is a deliberate no.** The runbook is real and the practice
is real, and calling it a formal IR plan would be a stretch a reviewer will test. A precise no with
the actual practice attached reads as competence; a vague yes that unravels in a follow-up call
poisons every other answer in the packet.

---

## Needs you — 6 questions

Each of these is almost certainly a yes in practice and has nothing to cite. I have not answered
them.

| # | Question | What is missing |
| --- | --- | --- |
| 23 | Background checks on employees with data access | No documented policy. Do you do them? |
| 27 | Annual security awareness training | Nothing in knowledge. Any training, even informal? |
| 31 | Vendor risk assessment before onboarding subprocessors | No process document, though your subprocessor list is current |
| 34 | Data retention and deletion schedule | Retention is implemented in code; nothing states the periods |
| 39 | Penetration test within the last 12 months | Nothing on file. Has one been done? |
| 44 | Documented business continuity plan | Nothing on file |

**Answer these six once and they are answered for ever.** They are the standard set — every
enterprise questionnaire asks them in some form, and each one you document now is one you never
research again. If you tell me the answers I will write them into knowledge as citable documents in
the right shape.

---

## What I did not do

I did not answer anything from what companies like yours usually do, from your marketing site, or
from what an adjacent question implied. A questionnaire answer is a warranty: the buyer's security
team files it and an auditor may hold you to it years later. On this desk "I don't know" is
professional and "probably" is malpractice.
