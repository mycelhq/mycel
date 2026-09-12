# @mycel/deliverability

Whether a message may be sent, which mailbox sends it, and what a bounce costs.

## Why it exists

Two sending systems live in this repo.

`growth/` sends cold mail for us, selling Mycel. It has a full deliverability stack that took real
incidents to get right: a warm-up ramp that steps down on complaints, inbox rotation with per-domain
ceilings, a suppression list with no override, and bounce feedback wired into all three.

`kernel/` — the product an agency actually runs their business on — had none of it. It could send
from a brand-new mailbox all day, mail an address that hard-bounced an hour earlier, and mail
somebody who had marked the previous message as spam. Worse, it *saw* every bounce: the AgentMail
webhook acknowledged each one with `{ ok: true, ignored }` and threw it away.

The targeting arithmetic in `@mycel/gtm-math` is worth nothing delivered into a spam folder, and the
first agency to burn their own domain would rightly have blamed the platform that let them.

The two apps stay independent — `growth/lib/db.ts` says so, deliberately — which leaves the same
honest option the arithmetic took: a small pure package both depend on. `@mycel/linkedin`,
`@mycel/insight` and `@mycel/gtm-math` set the pattern.

## What is in here

| module | answers |
| --- | --- |
| `address` | who is this a record about — normalisation, the hash key, role-address grading |
| `ramp` | how many may this mailbox send today, given its own age, volume and health |
| `rotation` | which mailbox sends next, and whether one should send at all |
| `verdict` | what a bounce, a complaint or a rejection costs — one answer for every transport |
| `suppression` | may we mail this person, and which reason wins when there are two |

## What belongs here

Pure functions over plain data. No I/O, no clock it was not handed, no randomness it was not handed,
no database, no vendor SDK.

A transport belongs in an app. The RULES a transport must obey belong here, because the failure mode
of duplicating them is two systems disagreeing about whether a domain may send today — and the one
that is wrong is the one that gets blocked.

The compiler has already caught this once: the penalty constants were briefly defined in both `ramp`
and `verdict`, and the package refused to build. A complaint costing two weeks in one file and three
in another is exactly the drift this package exists to stop, and it would otherwise have been
invisible until a domain was already burned.

## Tests

In `kernel/harness/test/deliverability.test.ts`, for the reason `@mycel/gtm-math` states: the
package is a dependency of two apps and has no runner of its own, and the kernel is where `npm test`
already runs on every gate.
