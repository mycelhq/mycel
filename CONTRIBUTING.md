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

Working with a coding agent? Point it at [AGENTS.md](./AGENTS.md) — commands, layout, the invariants
below in more detail, and the two traps that eat a first afternoon.

## Before you open a PR

```bash
npm run check        # typecheck + the whole suite. This is what CI runs.

# optional: the durability test needs a throwaway Postgres
docker run -d --name mycel-pg -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=mycel_test -p 55432:5432 postgres:16-alpine
MYCEL_TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55432/mycel_test npm test
```

Install the pre-commit hooks if you plan to contribute regularly: `pre-commit install`.

## What we're looking for

**High value**
- **A wedge you actually ran.** New example wedges under `wedges/`, or an issue describing what the
  kernel couldn't express for your service. This is the single most useful thing.
- **Connection executors.** `email`, `webhook`, `custom`, and `composio` are real. New kinds must
  keep secrets on the harness side of the proxy — the agent only ever sees a nonce.
- **Sandbox backends.** Implement `Sandbox` (see `harness/src/sandbox.ts`) and add a case to
  `createSandbox()`.
- **Bug reports with a failing test.** The suite is fast; a reproducing test is worth ten paragraphs.

**A good first one: a provider.** Every outside service is pluggable and most of them have two
implementations already — web search, places, page crawling and email lookup each take whichever key
you set. Adding a third is a self-contained change with an obvious shape:

1. Add it to `PROVIDERS` in `harness/src/gtm/providers.ts` with `implemented: false`.
2. Write the client. Copy the nearest sibling — `harness/src/gtm/jina.ts` is the smallest.
3. Flip `implemented: true` and add it to `.env.example`.

`harness/test/provider-docs.test.ts` fails if the docs do not follow, and `resolveProvider` refuses
to CHOOSE an option with no code behind it, so step 1 can land on its own without lying to anybody.

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
7. **A mechanism with tests and no callers fails CI.** `harness/test/connectivity.test.ts` enforces
   it. A symbol with tests and no callers looks *more* finished than dead code, not less: it has a
   spec, it passes, and its tests prove the thing works while proving nothing about whether it RUNS.
   Wire it, delete it, or name the seam.

## Style

TypeScript, no build step in dev (`tsx`). Match the surrounding code: comments explain *why*, not
what — and name the failure that forced the rule, because a comment restating the code is noise
while a comment naming the outage is the reason the next person keeps the guard.

Tests assert the property, not the membership. A fixture copied from the source of truth is a test
that cannot fail when the source changes; we have shipped several and they are the reason for half
the guards in `harness/test/`.

Small, focused PRs with a clear description of the failure mode you're fixing.

## Security

Please don't open public issues for vulnerabilities — see [SECURITY.md](./SECURITY.md).

## Conduct

[CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md) — the Contributor Covenant. It applies to issues, pull
requests and review. A security report is not a conduct matter; that has its own door above.

## License

By contributing you agree your contributions are licensed under [Apache-2.0](./LICENSE).
