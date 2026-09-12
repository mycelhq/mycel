# @mycel/gtm-math

The go-to-market arithmetic both sides of this repo need.

## Why it exists

`kernel/` runs go-to-market for a customer's agency. `growth/` runs it for us, selling Mycel. They
answer the same questions — which source actually produced customers, which signals are still worth
acting on — and `growth/lib/db.ts` states the constraint plainly: *"this app is deliberately
independent of the kernel."*

That independence is worth keeping and it leaves one honest option. Not growth importing the kernel,
not the same hundred lines living twice and drifting: a small package both depend on, which is the
pattern `@mycel/linkedin` and `@mycel/insight` already established.

## What belongs here

Pure functions over plain data. No I/O, no clock, no randomness, no database, no vendor.

If it needs a connection or a key it belongs in the app. If two apps would otherwise each write their
own version of the same measure, it belongs here — because the failure mode of duplicated arithmetic
is not a bug, it is two dashboards disagreeing and nobody knowing which is right.

## Where the tests live

In `kernel/harness/test/`, not here.

`packages/` has no test runner installed — same as `@mycel/insight` — so a suite in this directory
would be one nobody runs, which is worse than none. The kernel's tests import the workflow adapter,
which imports this package, so the arithmetic is covered on the real path and runs in the gate on
every commit.

If this package ever grows something the kernel does not call, it needs its own runner before it
needs its own tests.
