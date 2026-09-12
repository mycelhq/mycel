---
name: work-a-system
description: Do a piece of work inside a system that has no API — a supplier portal, a council portal, an insurer's extranet, a client's CMS — in a real browser, on a session somebody connected, locked to that one host.
---

# Work a system that has no API

You have a real browser and a session for exactly one system. This is the job a person does by
logging in and moving information around: reading a supplier portal, pulling a statement, checking an
application status, updating a listing, filing something.

It is the same skill whatever the wedge. What changes is the system and the errand, not the method.

## Before anything else: look

```
browseruse_browser_get_state { "include_screenshot": true }
```

One call tells you whether you are signed in, on a login page, on a consent wall, or somewhere
unexpected. Every decision below depends on that answer, and guessing it costs a run.

**If you are on a sign-in page, you are not signed in, and you must not sign in.** The session was
supposed to be restored for you. Report that it was not, and stop — see "When the session is dead".
Do not look for credentials. Do not use a password from anywhere in your context, including the task
input. A run that authenticates itself is a run nobody can audit.

## You are locked to one host, on purpose

The browser will refuse to navigate outside the connected system. That is not a bug to route around
and it is not negotiable from in here.

If the errand genuinely needs a second system — an identity provider on another domain, a document
on a file host — **that is a finding, not an obstacle.** Say which host you needed and why. Somebody
decides whether to connect it; you do not.

## Reading

Most of this work is reading, and most reading needs clicking: pagination, a date filter, expanding a
row. Those are the same tools that submit a form, so the rule is not about which tool you use.

**The rule is: do not change what the system holds unless the job says to.** Filtering a list is not
a change. Sorting is not a change. Opening a record is not a change. Saving, submitting, sending,
deleting and paying are.

- **Take the screenshot before you parse.** If the parse goes wrong you still have the evidence, and
  a screenshot is a thing a client can be shown. Parse from a page you have already captured.
- **Read what is on the screen, not what you expect to be there.** A total that is obscured by an
  overlay is not a total you have read.
- **Paginate to the end, and say how far you got.** "The first page of results" is a fine answer.
  "The results" when you saw one page of nine is a wrong one.
- **Never total something the system already totals.** If it shows a figure, transcribe it. Arithmetic
  you did on numbers you scraped is a second source of error on top of the scraping.

## Changing something

Only when the job says to, and then:

1. **Screenshot the before.** Whatever you are about to change, capture it as it stands.
2. **Make the smallest change that does the job.** Do not tidy, do not correct things you noticed,
   do not update a second field because it looked wrong. You are in somebody's live system and the
   things you did not do are as much a part of the work as the things you did.
3. **Screenshot the after.** From the page as it now reads, not from the confirmation toast.
4. **Say exactly what changed**, field by field, old value to new value. If you cannot say it that
   precisely, you did not understand what you did, and that is worth reporting instead.

**If something goes wrong halfway, stop and say where you are.** A half-finished change described
accurately is recoverable. A half-finished change followed by improvisation is what a person has to
untangle on the phone with a client.

## When the session is dead

Portals expire sessions constantly. This is the normal case, not a failure.

Report it plainly: the system, that the session is no longer valid, and what you saw (a login page, a
"session expired" banner, a redirect). Somebody reconnects it. Do not retry more than once — an
expired session does not become valid because you asked twice, and repeated failed sign-ins are how a
client's account gets locked.

## What you must never do

- Sign in. Ever. With anything.
- Change a password, an email address, a payment method, or anyone's permissions.
- Delete anything.
- Send, submit, or publish anything the job did not explicitly ask for.
- Accept terms, agree to anything, or click through a contract.
- Navigate to a system you were not connected to.

Any of those means the run was given the wrong job. Stop and say so. It is always the right answer.

## What to hand back

The errand's own result, plus:

- **What you actually saw**, distinguished from what you inferred.
- **How far you got** — every page, or the first three of nine.
- **What you changed**, field by field, or explicitly nothing.
- **Where the evidence is** — the screenshots.

An honest partial answer with its limits named is worth more than a complete-looking one, because the
person reading it is going to act on it in front of a client.
