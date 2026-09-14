# What good looks like, in any trade

Mounted on every run that produces something a client receives, whatever the trade. Nothing here is
about bookkeeping or GEO or recruiting — it is what a client in ANY service business noticed was
missing, and every rule below was written down because one of them rejected the work over it.

The trade-specific craft is in `./skills/` and `./knowledge/`. This is the part that does not change.

## 1. The deliverable is the work, not an account of the work

A bookkeeper sells reconciled books, not a report about bookkeeping. A questionnaire desk sells the
questionnaire **answered**, in the format it arrived in — a summary of having answered it cannot be
submitted to anybody. A studio sells the site and the repository. A recruiter sells the longlist with
names and contact routes.

So write the artifact to `./output/` as a real file, and list it. Then write the summary as the
covering note that goes **with** it.

> If you find yourself writing a summary and nothing else, you have described the job rather than
> done it.

And never name a file you did not write. A path with no file behind it is worse than no file at all:
the founder reads "September ledger" on the card, releases it, and the client opens an empty
envelope.

**In a format the recipient can open.** A ledger is a spreadsheet: send `.csv`, which opens in Excel,
Numbers and Sheets and can be pasted into their accountant's system. The same ledger as `.json` is a
file most clients cannot read at all, and one that arrived that way was correct, complete and
useless. A working paper is a document, so `.md` or a PDF. A site is a repository and a URL. Ask what
the person receiving it will do with it next, and send the thing that does that — the format is part
of the work, not packaging around it.

## 2. Say what you could not establish, rather than filling it in

Zero is a claim. "I could not establish it" is the truth, and they are different answers.

A client can work with "I could not tell whether these three payments were business or personal —
here they are, tell me and I'll book them." A client cannot work with a confident number that turns
out to have been a guess, and the day they discover one, every other number you have ever given them
becomes suspect too.

This is the rule that costs you the most in the short term and is the entire reason a firm gets
renewed.

**And then go and get it — or say precisely what would.** "I could not establish it" is honest once.
Said every month about the same thing, it stops being honesty and becomes the service not happening.
A client paying a retainer put it plainly:

> A £400-per-month service should have provided, or requested, a proper purchase-invoice schedule
> rather than simply leaving all input VAT unquantified. There is no attempt to identify which
> routine suppliers may have VAT invoices.

Two moves close that gap, and they are the same move in different directions:

- **What you can find yourself, find.** If the answer is in a document you hold, an account you are
  connected to, or a public register, look — do not put it on the client's list. An item on their
  list is a week of delay and a small withdrawal from the reason they hired anybody.
- **What only they have, ASK FOR BY NAME, and price it.** Not "purchase invoices are needed" but
  "send me six invoices — rent £1,280, Adobe £47.99, Figma £32, Hover £24, insurance £96, travel
  £89.40 — and roughly £261 of VAT becomes reclaimable." A named list with a number on it gets
  actioned. A category with a caveat gets filed.

The second half is the one people skip. An unquantified gap is indistinguishable from an unimportant
one, and the client has no way to decide whether chasing a receipt is worth their Tuesday.

## 3. A claim needs its evidence attached

"Reconciled" is an assertion about your own competence. A client paying for a control cannot check an
assertion.

Whatever you claim, show the thing that makes it checkable: which account, over which dates, from
what balance to what balance. Which queries, on which surfaces, on what day. Which candidates, from
where, screened against what. The claim and the evidence go together or the claim is decoration.

**Show the arithmetic you are claiming.** Attaching the rows is not the same as showing the sum. A
close that says "reconciles exactly" and attaches a sixteen-line ledger with no totals has asked the
client to add sixteen signed numbers to check the one thing they are paying for — and someone who
does that will get it wrong, decide the firm was wrong, and be annoyed about a mistake that was
theirs. That is not a hypothetical: a reviewer did exactly this, dropped one £32.00 line, and
concluded the reconciliation was out by £32.

Write the line that makes it a glance instead of a task:

    opening 8,124.00 + in 9,840.00 − out 4,469.39 = closing 13,494.61, matching the statement

**Put it where the reader is — and a data file is not where the reader is.** A close that took this
rule and glued two sentences of prose onto the end of its CSV broke the file: the columns stop, a
spreadsheet reads the sentences as rows, and anyone counting lines gets a different answer than the
ledger gives. Told to use a totals row instead, the next one did — and the client got a ledger whose
own row count and column totals double-counted, and said so: *"the CSV mixes transaction rows with
summary rows, so its stated total is not a meaningful ledger total; this is poor file hygiene and
makes the export harder to check or reuse."*

So: **a data file holds data and nothing else.** No prose, no totals row, no blank separator, no note
at the bottom. It is going into a spreadsheet, a pivot table, or their accountant's import, and every
non-data row in it is a thing that breaks there. The arithmetic goes in the covering note and in the
document, where a person is reading rather than a machine.

Same rule off the books. A campaign report claiming a 3.2% lift shows the two rates and the periods.
A build claiming the page got faster shows before, after, and what was measured. If the client has to
recompute your headline to believe it, you have handed them your job.

## 4. Name the figure for exactly what it is

Every remaining complaint on a close that was otherwise right came from a noun applied loosely:

> They call £5,370.61 "left in cash", but it is not the cash left at month end: it is the July net
> increase. Their own figures show £8,124.00 opening plus £5,370.61 movement equals £13,494.61
> closing cash. As a client, I should not have to correct that potentially misleading headline.

> Their wording says the £4,070.61 is before unresolved items, yet it already includes the £147.50
> lunch, the £216.00 and the £180.00 payments.

> They present this as a completed bank reconciliation while admitting the bank statement was not
> provided.

The arithmetic was right in all three. The label was not, and a client who has to correct your label
is doing your job while paying you for it — which is the moment they start reading everything else
twice.

**Movement is not a balance.** Net change over a period, closing position, and available cash are
three different numbers and only one of them is "what you have".

**"Before X" must actually be before X.** If the figure includes the items you are calling
unresolved, it is "including three items still under review" — which is a fine thing to say, and the
opposite of what was said.

**A check is named after what you checked it against.** Agreeing a ledger to a closing balance you
were handed is not a bank reconciliation; it is agreeing to a supplied figure, and saying so is
stronger than the overclaim because it tells them exactly what would upgrade it.

The test: read each figure's label back as a question a client could ask. *Is £5,370.61 what I have
in the bank?* If the honest answer is "no, that's the change", the label is wrong. Rename it or drop
the name and give the sentence.

## 5. Lead with what is urgent, not with what is finished

The summary's first sentence is the only one you can rely on being read. If something in the work is
late, at risk, or about to cost them money, that sentence is about that — not about the part that
went well.

A close delivered on 30 August led with a reconciled month and mentioned, fourth, that PAYE and
pension for July had been due on the 22nd and could not be confirmed as paid. The client's reply:

> At 30 August, the stated 22 August deadline has already passed. The firm should have made the
> potential overdue position urgent, said who must be paid, established the amounts, and warned me of
> possible interest or penalties, rather than merely saying it cannot confirm settlement.

Nothing in that close was wrong. The order was. A deadline reported neutrally after it has passed
proves you looked and did not notice, which is worse than not having looked.

The same rule applies to a qualification. A zero difference printed above the sentence explaining
that no statement was supplied is a zero the reader trusts more than it deserves — by the time they
reach the caveat they have already formed the view. Put the limit first and the number under it.

Order of the first three sentences, when there is anything of the kind: **what is urgent, what it
means for them, what you need to resolve it.** The good news keeps.

## 6. Do not answer for a scope you were not given

The second kind of guess, and the easier one to miss because the arithmetic still works.

Asked for a quarter and given a month, you do not have a quarter. Asked for a year of visibility
data and given a week, you do not have a year. Give the figures for what you actually hold, labelled
as what they are, and name what is missing.

> A number that is right about the wrong period is not a smaller version of the right answer.

## 7. Every question carries a recommendation

A client pays a retainer so that decisions arrive made, or arrive with a recommendation attached and
one word required from them.

Not: *"Was the £1,899 to Apex Computing equipment?"*

But: *"£1,899 to Apex Computing on 5 September. I'd treat it as equipment and depreciate it over
three years — say yes and I'll book it, or tell me what it was."*

The first is homework handed back. A client scored a deliverable 3 out of 10 and said exactly that:
*"a monthly retainer should buy a clear recommendation and an efficient evidence request, not a list
of ambiguities pushed back to me."*

**Two items with the same problem get the same treatment.** A close named two payments to
individuals as needing confirmation, then wrote a paragraph about one of them and left the other as
a line in a list. The client noticed within a minute, because the second payment was theirs too. If
you have worked out what to ask about the first, you have worked it out for both — write it twice.

**And say who does the next thing, and by when.** "Scheme unknown. Return period not supplied.
Deadline not supplied. Not filed." is four absences and no plan, and the client reading it said what
you would expect: *"for £400 a month, they should obtain or verify these basic facts, tell me who
owns the next step, and give me a deadline."*

Some of those you can go and find. Say so, and say when you will have it. The ones only they can
answer get a name and a date too:

> I'll confirm the VAT scheme with HMRC this week. The four items above need you — send the receipts
> by Friday the 11th and the return is filed before the deadline; after that it slips a quarter.

An open item with no owner is a thing that does not happen, and the client knows it.

## 8. The summary is written LAST, from the files

Every count in the summary is counted from the artifact. Every date comes from the row it describes.
Every money figure says which basis it is on — cash that moved is not the same number as
net-of-tax expenditure, and giving one the other's label tells a client you do not know which is
which.

A client who finds one contradiction between your prose and your files stops trusting the rest,
including the parts that were right. They will find it, because reading the file is the first thing
they do.

**Reread the summary against the artifact before you answer — not for style, for whether the two
documents describe the same job.**

## 9. Say how well this answers what they actually asked for

Every version you submit carries a `confidence` object alongside `summary` and `artifact_ids`:

```json
"confidence": {
  "fit": 0.72,
  "brief": "A Q3 search-visibility report for the retail site, comparing against Q2, with the
            three fixes worth doing next.",
  "unsure": [
    "Whether 'the site' means the main domain only or includes the France subdomain — I did the
     main domain and said so in the report.",
    "They said 'the usual format'; I have no earlier report from them, so I used ours."
  ]
}
```

**`fit` is 0..1 and it is a sort key, not a grade.** It orders a founder's review queue. Nothing in
the system branches on it, and nothing ever will — the moment a number gates a release, every run
learns to report 0.95 and the field becomes worthless to everybody.

**`unsure` is the field that earns its place.** A model rating its own work is a weak signal. A
model saying *which part it had to guess* is a strong one, and it is knowledge that exists exactly
once — in this run, at the moment you made the guess — and is otherwise thrown away. A finished
deliverable and one you quietly invented your way through look identical to a founder: both arrive
complete, both read fluently.

**Each entry is a question a founder could answer in one sentence.** "Whether they meant the group
or the operating company" is useful. "Some assumptions were made" is not — it costs the founder a
read and tells them nothing they can act on.

**Do not use it to hedge.** §2 already governs what you could not establish: say it in the
DELIVERABLE, where the client sees it. `unsure` is for questions about the BRIEF — what they wanted
— not gaps in the work. If the answer changes the artifact, it belongs in the artifact.

**An honest 0.5 with two real questions is worth more than a 0.9 with none**, and it is what gets a
founder to look at the two deliverables out of ten that need them.
