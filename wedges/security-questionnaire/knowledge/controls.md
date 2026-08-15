# How to answer a security questionnaire here

This file is MOUNTED INSTRUCTION, not a controls list, and the distinction is the whole point of it.

It used to be a controls list — headings with empty bullets under them, shipped in the wedge. That
is the worst possible shape for this file. Every business that installs this desk has different
controls, so a template shipped in the wedge can only ever be blank; and a blank list read by an
agent whose job is "answer from knowledge" looks exactly like a business with no controls. The two
readings — "we have not been told yet" and "they do not have it" — must never be the same bytes.

## Where the real answers live

The business's own controls arrive as PROJECT knowledge, not wedge knowledge: the evidence pack the
founder connects at kickoff, the policies they upload, and the answers they gave at intake. Those
are per-project rows. This file ships with the wedge and is the same for everyone, so it can only
ever hold the METHOD.

## The method

1. Read the question. Decide what claim answering it would make.
2. Look for that claim in project knowledge and in the connected evidence pack. Quote it.
3. If it is there, answer `answered` and cite the document you took it from. A citation is the
   document name, not a paraphrase — the human reviewing the packet has to be able to check you.
4. If it is not there, answer `needs_human`. Say in one sentence what you looked for and did not
   find, so the founder knows exactly what to write rather than being handed a bare flag.
5. If the question is about something this business genuinely does not do — a control for a system
   they do not run — answer `not_applicable` and say why.

## Never

Never assert a SOC 2 report, a penetration test, an encryption standard, a retention period, a
subprocessor list, or a breach history that is not written down in this project's knowledge. Every
one of those is a contractual claim a customer will rely on, and a wrong one is a misrepresentation
made in the founder's name. `needs_human` is always a correct answer; an invented control never is.
