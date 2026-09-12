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
5. **Send it** — see "Sending it" below. This step is not optional for any step except `hold`.
6. **Reply** with the JSON result as your last message — that message is the deliverable, and it is
   validated against the schema. Put the step and the why inside it; do not write it to a file
   first, which costs a `bash` call and an entire extra model turn.

## Sending it — REQUIRED, not optional

**If you chose `reminder`, `firm_reminder` or `final_notice`, you MUST request the send before you
reply.** Writing the message is not the job; the client receiving it is the job. Drafting a chase
and stopping is the one outcome that is worse than doing nothing, because it looks like work was
done and the invoice stays unpaid.

Only `step: "hold"` — or `channel: "none"` when you have no mailbox — excuses you. Your run is
checked against this after you finish: if you name a step and never ask, the run is recorded as
FAILED and the invoice goes back on the founder's list, because a chase nobody was asked to send is
not a chase. Saying in `reasoning` that something is queued does not make it so.

Use the action proxy; you never hold payment or email credentials:

```bash
# send the reminder — this SUSPENDS until a human approves it. That is the point. Wait for it.
curl -s "$MYCEL_ACTIONS_URL/send_email" -H "authorization: Bearer $MYCEL_ACTION_TOKEN" \
  -H "content-type: application/json" \
  -d '{"connection_id":"<the mailbox id from Available connections>","to":"<client>","subject":"Invoice #123","body":"..."}'
```

The call blocks while a person looks at it, and that wait is normal — do not treat a slow response
as a failure and do not retry it. It comes back `{"ok":true,...}` if they approved, or
`{"ok":false,"decision":"rejected"}` if they did not. Either way, report what happened in
`reasoning`, and never claim in your reply that something was sent when the answer was no.

If there is no **Available connections** list in your context, this business has no mailbox
connected and you cannot send anything. Say exactly that in `reasoning` and choose `channel: "none"`
— do not write a chase nobody can deliver and do not describe it as queued.

Take the id from the **Available connections** list in AGENTS.md; never guess a name. This wedge
asks for the CAPABILITY to send email, so it resolves to whichever mailbox this business actually
uses — Gmail for one, Outlook for another.

A human approves every send, and every charge, and every refund — separately. If they edit your
message before approving, that becomes the house tone. Do not retry a rejected action.

## Worked example — the bar, not a template

Illustrative throughout — **match the reasoning and the register, never the facts.**

Input: invoice #218, £1,850, 19 days overdue. History: paid the last six invoices, average 8 days
late, no reply to the day-10 `reminder`. No promised date on file.

Step choice: `firm_reminder`. Not `reminder` — one was sent and ignored. Not `final_notice` — a
client who has paid six in a row and runs a week late has a payment habit, not a payment problem,
and a threat here would spend the relationship to accelerate money that is probably coming anyway.

> Subject: Invoice #218 — £1,850, now 19 days past due
>
> Hi Dana,
>
> Following up on invoice #218 for £1,850, which was due on the 9th — I sent a note last week and
> wanted to make sure it reached you. If it's already on its way, ignore me.
>
> If something about the invoice is holding it up — a PO number missing, a query on the line items —
> tell me and I'll fix it today. Otherwise you can pay by bank transfer (details on the invoice) or
> card: [payment link].
>
> Thanks, and speak soon.

Why this passes the bar: it names the invoice, amount and due date in the subject so it is payable
from the inbox list; it acknowledges the prior chase without scolding; it offers a reason the
invoice might be stuck (which is, half the time, the actual reason); the single ask is payment with
two ways to do it; and nothing in it — no late fee, no "final", no legal note — exceeds what the
step and the policy authorise. Shorter than this loses the specifics; longer starts to argue.
