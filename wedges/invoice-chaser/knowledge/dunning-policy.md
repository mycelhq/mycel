# Dunning policy (the escalation ladder)

Seed policy — the founder tunes this live via the knowledge API. Tone beats aggression: most late
payment is friction, not refusal.

## The ladder (by days overdue, adjusted for client standing)
- **reminder** (1–7 days, or any good-standing client): friendly nudge. "Just checking this didn't
  slip through — invoice #, amount, due date, pay link. Anything I can help with?"
- **firm_reminder** (8–21 days): clear and direct, still warm. Restate the amount and the original
  due date. Ask for a payment date if they can't pay now.
- **final_notice** (22–35 days): formal. Reference the terms, state what happens next per contract.
  No surprises — only escalate to steps the contract actually permits.
- **hold**: they've promised a date that hasn't passed, or it's under active dispute. Do nothing;
  note the follow-up date.

## Rules
- One clear ask per message; always include invoice #, amount, and a way to pay.
- No late fees or legal language unless the contract explicitly allows them.
- Never chase the same invoice twice in 48h.
- If a client disputes the work, switch to `hold` and escalate to a human — do not argue.
- Charging a saved card or issuing a refund is always a separate, human-approved action.
