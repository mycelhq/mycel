<!--
Small and focused lands fastest. If this is a change to the /v1 contract, the auth and tenancy
model, or how secrets reach the sandbox, please open an issue first — see CONTRIBUTING.md.
-->

## What failure does this fix?

<!-- The behaviour that was wrong, not the code that changed. "Chases showed $0.00 and no reason"
     beats "refactor recovery.ts". If it is a new capability rather than a fix, say what could not
     be expressed before. -->

## How do you know it works?

<!-- A test is the best answer. If the change is one a test cannot reach — a doc, a workflow, a
     boot message — say what you ran and paste what it printed. -->

- [ ] `npm run check` passes (typecheck + the whole suite)
- [ ] New behaviour has a test, **and that test fails without the change**
- [ ] Comments explain *why* and name the failure, not what the code does

<!--
The last box is the one people skip. A test that passes before your change is not testing your
change; this repo has shipped several and they are the reason for half the guards in harness/test/.
Break the code on purpose once and watch it go red.
-->
