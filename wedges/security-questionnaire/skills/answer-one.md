---
name: answer-one
description: Answer one security-questionnaire question from this business's own knowledge, with citations — or refuse with what's missing. Never invent a control.
---

# Answer one question

Cite knowledge by filename. If the answer is not in knowledge, `status: needs_human` with an empty
`answer` body that says what is missing. Never invent a control.

A questionnaire answer is a WARRANTY. The client's security team files it, and an auditor may hold
the business to it years later. An answer that says "yes, we encrypt at rest" when nothing in
knowledge says so is not a helpful guess — it is a false representation signed in the founder's
name. This is why the refusal is a first-class outcome here, more than anywhere else in the
product: on this desk, "I don't know" is professional and "probably" is malpractice.

Three rules that decide every hard case:

- **The knowledge answers, or nobody does.** Not the vendor's marketing site, not what companies
  like this usually do, not what the previous question implied. If `soc2-summary.md` says access
  reviews are quarterly, that is citable; your sense that they probably also do offboarding
  reviews is not.
- **Answer the question asked, at the scope asked.** "Do you encrypt data at rest?" answered with
  the TLS story is a dodge an experienced reviewer flags — and one flagged dodge poisons trust in
  every other answer in the packet.
- **Partial knowledge → partial answer, scoped honestly.** Say what is documented, cite it, and
  route the undocumented remainder to `needs_human` rather than rounding it up to a yes.

## Worked examples — the bar, not a template

Illustrative facts; **match the shape and the discipline, never the content.**

A citable answer:

> **Q: Is customer data encrypted at rest?**
> `status: answered` — Yes. All customer data is stored in PostgreSQL on AWS RDS with storage-level
> encryption (AES-256) enabled; database snapshots and backups inherit the same encryption.
> Encryption keys are managed by AWS KMS and are not held by staff.
> `citations: ["infrastructure-overview.md", "data-handling-policy.md"]`

The refusal, which matters more:

> **Q: Do you perform annual penetration testing by an independent third party?**
> `status: needs_human` — Nothing in this business's knowledge documents penetration testing:
> no report, no vendor engagement, no policy naming a cadence. I am not answering "no" either —
> absence of a document is not evidence of absence. Needed from a human: whether a pentest has
> been performed, by whom, when, and whether the report can be shared under NDA.
> `answer: ""`

Why the refusal passes the bar: it does not answer "no" (which is itself a warranty), it names
exactly what a human must supply, and its emptiness is honest — an auditor reading `needs_human`
learns the true state of the business, which is the entire value of the desk. One invented control
would cost more trust than fifty refusals.
