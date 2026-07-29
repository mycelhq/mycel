# Contributing to Mycel

Mycel is the open kernel for AI-native service businesses. It's being extracted from real services
we run ourselves, so the most valuable contributions come from **running it on a real wedge** and
telling us where it broke.

## Getting set up

```bash
git clone https://github.com/mycelhq/mycel && cd mycel
npm i
MYCEL_RUNTIME=mock npm run dev     # boots with no OpenCode/keys — tasks stream canned events
```

You do **not** need an LLM key, Docker, or Daytona to develop most of the kernel. `MYCEL_RUNTIME=mock`
runs tasks end-to-end so you can work on the contract, the service surface, tenancy, or the portal.

## Before you open a PR

```bash
npx tsc --noEmit     # typecheck (CI runs this)
npm test             # the suite (in-process, mock runtime)

# optional: the durability test needs a throwaway Postgres
docker run -d --name mycel-pg -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=mycel_test -p 55432:5432 postgres:16-alpine
MYCEL_TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55432/mycel_test npm test
```

Install the pre-commit hooks if you plan to contribute regularly: `pre-commit install`.

## What we're looking for

**High value**
- **A wedge you actually ran.** New example wedges under `wedges/`, or an issue describing what the
  kernel couldn't express for your service. This is the single most useful thing.
- **Connection executors.** `harness/src/actions.ts` has real email + webhook; Stripe, SMS,
  WhatsApp, and calendar are structured stubs. Wiring one up doesn't touch the security model.
- **Sandbox backends.** Implement `Sandbox` (see `harness/src/sandbox.ts`) and add a case to
  `createSandbox()`.
- **Bug reports with a failing test.** The suite is fast; a reproducing test is worth ten paragraphs.

**Please discuss first** (open an issue): changes to the `/v1` contract, the auth/tenancy model, or
anything that touches how secrets reach the sandbox.

## Ground rules for the code

The kernel has a few invariants. If a change breaks one of these, it won't land:

1. **Secrets never enter the sandbox.** The agent gets opaque nonces; the harness holds real keys and
   mediates every call. This is the whole security model.
2. **Every outward action passes a human.** Send/charge/book suspend the task and surface a preview.
3. **Honest signals.** No fake successes. If something failed, the task says why (persisted, not just
   in the event stream). Output is validated against the schema.
4. **The contract is the product.** `/v1` and the event stream are what consumers depend on. Additive
   changes are easy; breaking ones need a discussion.
5. **Rented commodities behind interfaces.** Sandbox, model, store, artifacts are swappable. Don't
   let a vendor become load-bearing.
6. **No unhandled rejections on hot paths.** A database blip must not take down the process.

## Style

TypeScript, no build step in dev (`tsx`). Match the surrounding code: comments explain *why*, not
what. Small, focused PRs with a clear description of the failure mode you're fixing.

## Security

Please don't open public issues for vulnerabilities — see [SECURITY.md](./SECURITY.md).

## License

By contributing you agree your contributions are licensed under [Apache-2.0](./LICENSE).
