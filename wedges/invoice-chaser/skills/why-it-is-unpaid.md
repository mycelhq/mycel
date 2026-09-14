---
name: why-it-is-unpaid
description: How to work out why an invoice has not been paid, and chase the actual reason. Read this before drafting any reminder — the wrong diagnosis produces a polite email that changes nothing and costs the relationship.
---

# Work out why it is unpaid, then chase that

Almost every overdue invoice at this size is **friction, not refusal**. The client is not deciding
whether to pay; something is in the way and nobody has removed it. A reminder that assumes refusal —
firmer tone, mention of terms, a hint of consequence — insults somebody whose finance person is
simply on holiday, and it is the single fastest way to turn a late payment into a lost client.

So the first job is diagnosis. Read the evidence before writing a word.

## The five reasons, and what each one looks like

**1. It never arrived where it needed to go.** Sent to the person who commissioned the work, not to
accounts. No bounce, no reply, invoice sitting in a project manager's inbox. **Tell:** total silence,
including on earlier friendly notes. **Chase:** ask who handles invoices and re-send there. Do not
re-send the same invoice to the same address a third time; that is the definition of shouting into a
void.

**2. It is stuck in their process.** Needs a PO number, a portal upload, a manager's approval, a
supplier form. **Tell:** they replied warmly once and nothing happened, or the delay is oddly
uniform across every invoice you send them. **Chase:** ask what the invoice needs to clear their
system. That one question resolves more late invoices than every reminder combined, because it moves
the work from "chase them" to "help them".

**3. They are unhappy with something.** The work, a scope disagreement, a line item they did not
expect. **Tell:** a specific query about the invoice, a delay that started after a particular piece
of work, or an unusually terse reply. **Chase:** DO NOT chase. Escalate to the founder immediately.
A payment reminder sent to somebody with an unspoken complaint converts a fixable disagreement into
a formal dispute, and no automated message should ever be the thing that does that.

**4. They cannot pay right now.** Cash is tight and yours is in a queue with others. **Tell:**
apologetic replies, promises with no dates, part-payments. **Chase:** ask for a date rather than
payment. A client who commits to the 15th usually pays on the 15th; one asked to "pay as soon as
possible" pays after whoever asked for a date. Where the founder allows it, offering to split it is
the move that gets paid — half now beats all of it never.

**5. They are avoiding it.** Genuinely ignoring you, no intention of paying soon. **Tell:** several
touches, no response of any kind, and evidence they are active elsewhere. **Chase:** stop chasing by
email. This is a phone call or a founder-to-founder message, and it is a decision for a person.

**When the evidence does not distinguish these, assume (1) or (2) and ask a question.** Those two are
the overwhelming majority, both are answered by asking rather than pressing, and both are undamaged
by being wrong.

## What actually gets an invoice paid

- **One invoice per message.** "You have three outstanding" is a project; "Invoice 104, $1,200, due
  the 3rd" is a task somebody can finish before lunch.
- **The number, the date, and the reference in the first line.** The person reading this is looking
  for it in a system. Make it findable, not persuasive.
- **A question beats a request.** "Is there anything holding this up?" outperforms "please arrange
  payment", because it gives a reply that costs them nothing and tells you which of the five it is.
- **Make paying one action.** A link, or the bank details inline. Every step between the message and
  the payment is a place it stops.
- **Say what happens next, once, plainly.** "If it is easier I can re-send to your accounts team" is
  a next step. "Failure to remit may result in…" is a threat from a stranger.

## What never to send

- **A threat the founder will not carry out.** Late fees that will not be charged, "final notice"
  followed by a sixth notice, legal language nobody intends to use. The first empty threat teaches
  the client that none of them mean anything.
- **Guilt.** "We are a small business and this affects us" is true and it is not their problem. It
  reads as pressure and it is remembered long after the invoice is paid.
- **A number you have not checked.** A reminder for an invoice already paid, or for the wrong
  amount, destroys the credibility of every future one. Check the ledger before every send.
- **Anything at all on a disputed invoice.** See reason 3. That goes to the founder, not to the
  client.

## A word on `reminder` / `firm_reminder` / `final_notice`

The output schema names three rungs and `dunning.ts` picks between them by the invoice's AGE — 1 to
7 days, 8 to 21, 22 and over. They are a **cadence**, not an instruction about tone. A
`final_notice` on a 25-day invoice whose diagnosis is `stuck_in_process` should still read as a
helpful question about their approval workflow, because that is what will get it paid. The rung
tells you how much has elapsed; the diagnosis tells you what to say.

## Escalation is a change of PERSON, not of TONE

The instinct is to write the same email angrier. That does not work, and it costs the relationship.
Escalate by changing who is involved:

1. **A reminder** to the same contact — friendly, one invoice, a question.
2. **A different contact** — accounts, or whoever they name. Most invoices resolve here.
3. **A phone call**, from the founder. Not automatable and usually decisive.
4. **Pausing work**, if the founder decides it. Announced before it happens, never as a surprise.
5. **Formal recovery.** A founder's decision, always. Never proposed by this system.

**Steps 3 to 5 are the founder's.** This wedge's job is to make 1 and 2 excellent and to escalate to
a human with a clear account of what has been tried — not to run a ladder to its end unattended.

## The relationship is usually worth more than the invoice

A client who pays late for three years is worth more than the $1,200 they owe today, and the whole
point of automating this is that it stays polite when a tired founder would not. **If a chase would
read as aggressive to somebody having a bad week, do not send it — surface it instead.**

The one exception is the client who has stopped replying entirely across several months. That
relationship has already ended; the only remaining question is the money, and that is a
conversation for the founder to have.
