# What is open, what is paid, and how the line was drawn

Apache-2.0. No metering, no seat limit, no expiry, no key that phones home. Bring your own model key
and run it.

This document exists because "open core" is usually a way of saying *the useful half is upstairs*,
and the only honest answer to that is a list you can check. So every claim below is a command.

---

## The one-line version

**The engine is open. The interfaces and the hosted operation are paid.**

Everything that runs a service business is in this repository. What is not here is anything with a
screen on it or a bill attached.

---

## Check it yourself

Every capability below is either in this repo or it is not. One command prints the whole surface,
from the repo root:

```bash
grep -rhoE '"/v1/[a-z-]+' harness/src | sed 's/"//' | sort | uniq -c | sort -rn
```

The top of that list, on the commit this file was written against:

```
  41 /v1/portal        what your client opens
  23 /v1/gtm           finding the next client
  17 /v1/wedges        services as config
  15 /v1/tasks         the runs
  13 /v1/invoices      the money
  13 /v1/deliverables  the work itself
   8 /v1/cases          engagements
   7 /v1/clients
```

| Capability | Here? | Where |
|---|---|---|
| The `/v1` contract and the harness | **yes** | `harness/` |
| Sandboxed runs, harness profiles, budgets | **yes** | `harness/src/runtime.ts`, `docker/` |
| The approval gate, and the nonce that keeps secrets out of the box | **yes** | `harness/src/approvals.ts` |
| Clients, cases, engagements, threads | **yes** | `harness/src/server.ts` |
| Deliverables, review, grading | **yes** | `harness/src/deliverables.ts`, `deliverable-grade.ts` |
| **Invoices and the chase ladder** | **yes** | `harness/src/invoices.routes.ts`, `dunning.ts` |
| **The client portal contract** | **yes** | `harness/src/portal.ts` |
| **Finding clients** — prospects, sequences, campaigns | **yes** | `harness/src/gtm/` |
| Autonomy that narrows itself and never widens | **yes** | `harness/src/autonomy.ts` |
| Knowledge, memory, distilled rules | **yes** | `harness/src/knowledge.ts`, `memory.ts` |
| Scheduler, connections, hash-chained audit | **yes** | `harness/src/scheduler.ts`, `audit.ts` |
| Wedges, blueprints, skills — every service definition we ship | **yes** | `wedges/`, `skills/`, `library/blueprints/` |
| Writing a service from a description of a business | **yes** | `wedges/business-shaper/`, `harness/src/wedgeauthor.ts` |
| — | | |
| An operator console | **yes** | its own repo — [mycelhq/console](https://github.com/mycelhq/console) |
| The client-facing portal **app** (the contract is here; the web app is not) | no | hosted |
| Sign-up, billing, plans | no | hosted |
| Our own go-to-market — the outreach that sells Mycel itself | no | not a product |
| Managed infrastructure, backups, on-call | no | hosted |

If a row in the top half is wrong, that is a bug in this document and worth an issue.

---

## The three rules

**1. If it decides, it is open. If it displays, it is not.**

The judgement is the product: what work to do, whether a deliverable is good enough to send, when a
human must be asked, what a correction taught. All of that is here, because a kernel you cannot fully
inspect is a kernel you cannot trust with a client's money — and because the alternative is the
pattern where the open repo is a wrapper and the decisions happen on a server you do not control.

Screens are mostly different — and the operator console is the exception that proves the rule, so it
is worth being exact about.

It is open, at [mycelhq/console](https://github.com/mycelhq/console), and it is a SEPARATE repository
rather than a directory in this one. That is the claim rather than a packaging decision: it depends
on nothing but `/v1`, so a console living inside the kernel would quietly suggest it is privileged
when the entire argument is that it is not. Anything it does, your own app can do —
`docs/INTEGRATION.md` is written for exactly that.

Shipping the kernel alone was the earlier answer and it was wrong. A stranger's install finished at a
curl command, and a kernel with no interface is not something a person adopts; it is an API they read
about once.

What stays closed is the CLIENT-facing portal app, sign-up and billing — the surfaces that only exist
because somebody is paying us to run this.

**2. If withholding it would make the open half dishonest, it is open.**

This is the rule that put invoices, dunning, the portal contract and GTM on the open side, and it
overruled an earlier draft of this file that had all four listed as paid.

A "kernel for service businesses" that cannot invoice is not a kernel for service businesses, it is a
task runner with a landing page. The same goes for the rest: no portal contract means no way for a
client to answer a question, and an engagement that cannot ask its client anything stalls forever.
Shipping those closed would have made the top of the README a lie, and we would rather lose the
upsell than have to be careful about how we describe the repo.

**3. If it is ours rather than yours, it is not open — and it is not paid either.**

`growth/` is the machinery that sells Mycel. It is not withheld to make you buy something; it is
withheld because it is our sales team, it has our sequences and our sending reputation in it, and it
is not a product in any direction. Same for our Terraform and our deployment.

---

## What this means in practice

**Self-hosting is a real option, not a demo.** Point `MYCEL_DATABASE_URL` at Postgres, give it a
model key, and you have a service firm's back office with no ceiling on clients, work or users. We do
not gate on volume, and there is nothing in here that stops working after a trial, because there is no
trial.

**Nothing is crippled to create an upsell.** There are no `// pro only` branches and no feature flags
keyed to a licence. If you find one, it is a bug — open an issue and we will remove it.

**Defaults that are right for us are bugs.** A kernel that treats *our* mailboxes as the platform and
gives you no way to name yours is the vendor's assumptions leaking into your deployment. See
`MYCEL_PLATFORM_DOMAINS` and `MYCEL_PLATFORM_ADDRESSES` in `internal-sender.ts` for the worked
example and the reasoning. More of these exist; they are worth reporting.

**The paid thing is an operation, not a permission.** Cloud runs this kernel for you: the console,
the portal app, sign-up, the upgrades, the backups, and somebody awake when a run fails at 2am. If
you would rather run it yourself, run it yourself — that is what the licence is for.

---

## Contributing

`CONTRIBUTING.md`. The one thing worth knowing up front: a change is expected to come with a test
that fails without it, and this repository takes the further step of checking that the test would
have caught the bug — see any commit message mentioning *sabotage*. It is not ceremony. Most of the
bugs recorded in these files were things that ran, reported success, and did nothing.
