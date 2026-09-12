// Deterministic dunning ladder. This looks like judgment but it is POLICY — given the facts, the
// step is fixed. Moving it out of the model makes it consistent, auditable, and testable, and it
// stops the agent inventing an escalation the contract doesn't permit.
//
// The prose in skills/chase-politely.md still decides HOW to write; this decides WHICH step.
// Founder code. Pure: no I/O, no clock (today is passed in).

export default function nextStep(args) {
  const daysOverdue = Number(args.days_overdue);
  if (!Number.isFinite(daysOverdue)) throw new Error("days_overdue must be a number");

  const disputed = args.disputed === true;
  const goodStanding = args.good_standing === true;
  const promisedDate = args.promised_payment_date ? String(args.promised_payment_date) : null;
  const today = args.today ? String(args.today) : null; // caller passes it — keeps this pure
  const lastChasedDaysAgo = args.last_chased_days_ago === undefined ? null : Number(args.last_chased_days_ago);

  // A dispute is never a dunning problem — it's a human problem.
  if (disputed) {
    return { step: "hold", reason: "invoice is disputed — escalate to a human, do not chase", escalate: true };
  }

  // A promise that hasn't come due yet is a promise, not a debt to chase.
  if (promisedDate && today && promisedDate > today) {
    return { step: "hold", reason: `client promised payment by ${promisedDate}`, follow_up_on: promisedDate, escalate: false };
  }

  // Never chase the same invoice twice inside 48h.
  if (lastChasedDaysAgo !== null && lastChasedDaysAgo < 2) {
    return { step: "hold", reason: "chased within the last 48h", escalate: false };
  }

  if (daysOverdue < 1) {
    return { step: "hold", reason: "not yet overdue", escalate: false };
  }
  if (daysOverdue <= 7 || goodStanding) {
    return { step: "reminder", reason: goodStanding ? "client in good standing — stay friendly" : `${daysOverdue}d overdue`, escalate: false };
  }
  if (daysOverdue <= 21) {
    return { step: "firm_reminder", reason: `${daysOverdue}d overdue`, escalate: false };
  }
  if (daysOverdue <= 35) {
    return { step: "final_notice", reason: `${daysOverdue}d overdue — reference contract terms only`, escalate: false };
  }
  return { step: "final_notice", reason: `${daysOverdue}d overdue — hand to a human for next steps`, escalate: true };
}
