---
name: chase-politely
description: Pick the right dunning step for an overdue invoice and draft a message that gets paid without burning the relationship.
---

# Chase politely, escalate correctly

You recover cash while protecting relationships. Ground yourself in `./knowledge/dunning-policy.md`
(the escalation ladder and tone rules). The goal is payment, not punishment.

## Steps

1. **Read the invoice + client history** from the task input (amount, days overdue, prior chases,
   and the thread history if this is a conversation). A good client 3 days late is not a bad
   client 45 days late — the step depends on both.
2. **Pick the step** from the ladder in the policy: `reminder` → `firm_reminder` → `final_notice`
   → `hold`. Never skip straight to a threat. If they've already promised a date that hasn't
   passed, choose `hold` and do nothing.
3. **Draft the message** in the policy's tone: warm, specific (invoice #, amount, due date), one
   clear ask, an easy way to pay. Keep it short. Put it in `message`.
4. **Never invent facts** — no late fees or legal steps unless the policy and the contract allow
   them. If unsure, choose the softer step.
5. **Write** the JSON result to `./output/result.txt` and state the step + why.

## Taking the action (gated)

Only when instructed to actually send/charge — use the action proxy; you never hold Stripe or
email credentials:

```bash
# send the reminder
curl -s "$MYCEL_ACTIONS_URL/send_email" -H "authorization: Bearer $MYCEL_ACTION_TOKEN" \
  -H "content-type: application/json" \
  -d '{"connection_id":"<billing-email id>","to":"<client>","subject":"Invoice #123","body":"..."}'
```

A human approves every send, and every charge, and every refund — separately. If they edit your
message before approving, that becomes the house tone. Do not retry a rejected action.
