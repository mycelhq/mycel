# Composing from primitives

## Why this exists

Given "build a bookkeeping portal" and an empty directory, you will produce something plausible and
mediocre: invented auth, a hand-rolled table, three different spacing systems, and a security model
nobody checked. It will look fine in a screenshot and be wrong in the ways that matter.

Given a catalogue of blocks that already work, you do the job you're actually good at — choosing,
wiring, adapting — and the floor is whatever the blocks are. So the quality of what you ship is set
by how faithfully you compose, not by how creatively you write.

## What the catalogue actually is

`primitives/manifest.json` is the machine-readable index: nine blocks, two recipes. Each block
declares:

| field | what it means for you |
|---|---|
| `provides` / `requires` | a dependency graph. `thread-list` requires `client-session`, which only `auth-magic-link` provides. Pick the provider first. |
| `conflicts` | `auth-magic-link` and `auth-password-oauth` cannot coexist. Choosing one is choosing an audience. |
| `env` | environment variables the block needs. If you can't set them, the block doesn't work — say so, don't stub it. |
| `kernel` | the kernel routes it calls. **This is the contract.** A route not listed here for any block probably does not exist. |
| `files` | where the implementation lives. |
| `notes` | the reason the block is shaped the way it is. Read these. Every one of them is a bug someone already had. |

**Where the code lives.** `primitives/blocks/` is currently an empty directory — the working
implementations are the corresponding files in `business-template/`, listed in each block's `files`.
So "copy the block" means "read `business-template/app/portal/enter/route.ts` and understand why it
is a Route Handler", not "there is a tarball somewhere." Don't hallucinate a source you haven't
opened.

## The decision procedure

Work down this list. Stop at the first hit.

**1. Is there a recipe?** `service-portal` (magic link + threads + reply + live run + landing) is a
service business with named clients. `operator-console` (password/OAuth + shell + stats + analytics)
is the founder running the business rather than selling it. If the ask matches a recipe, take the
whole recipe. Recipes are opinionated for a reason: `thread-list` without `reply-starts-work` is a
suggestion box, and `reply-starts-work` without `live-run` is a contact form.

**2. Is there a block?** Match on the `why`, not the title. `stat-row`'s why is "mono, tabular, and a
reserved hint row so values share a baseline whether or not each tile has a hint" — if you're about
to build a row of numbers, that reserved hint row is a detail you would have got wrong.

**3. Can an existing block be adapted?** This is the usual answer and it is a good one. Blocks are
plain files, not a framework; nothing imports back into `primitives/`. Once copied, the code belongs
to the app and you can change it freely. Adapting `thread-list` to show a case stage badge is
correct. Rewriting it from scratch because you wanted a different border radius is not.

**4. Only now, write something new** — and leave a comment saying which block you considered and why
it didn't fit. That comment is what stops the next agent from writing a third variant.

## When a new block is genuinely justified

A new block earns its place when it is a **surface the catalogue doesn't cover at all**: a payments
page, an appointment picker, a document-signature flow. Not when it is a variation on one that does.

The bar for adding it to `primitives/`:

- It builds in isolation.
- It passes `verify.mjs`.
- It declares honest `requires` / `conflicts` / `env` / `kernel` in `manifest.json`.
- Its `notes` field says the non-obvious thing — the constraint that makes it shaped this way.

Anything that can't clear that bar is a snippet, not a primitive. Leave it in the generated app and
document it there. A catalogue with a broken entry is worse than a smaller catalogue, because the
next agent trusts it.

## The verifier is the point

`node primitives/verify.mjs <app-dir>` fails the build. It is not a linter — ESLint covers style;
this covers the handful of things that are specific to a Mycel app and catastrophic when wrong.

**1. `server-only-in-client`** — no server-only module reachable from a `"use client"` file. Next
catches a *direct* `server-only` import; this traces the whole import graph, because in practice the
leak is three hops down a util file. The trace stops correctly at `"use server"` and `"use client"`
boundaries, so the normal patterns don't trip it.

*How you cause it:* a client component imports a helper for a type or a constant, and that helper
also imports `lib/portal.ts`, which is `import "server-only"`. **Fix:** move the shared type into its
own module with no runtime imports, or use `import type` (see the Next.js reference — a *mixed*
import does not count).

**2. `hardcoded-secret`** — patterns, not entropy: `sk-…`, `sk_live_…`, `ghp_…`, and anything named
`api_key` / `secret` / `password` / `token` assigned a 24+ character literal. Test fixtures are
exempt.

*How you cause it:* pasting a value "just to test it." Don't. Read it from `process.env` in a server
module from the start.

**3. `unguarded-route`** — every `app/**/page.tsx` that reads data must have a session check itself,
or in a layout above it, or the app must have a `proxy.ts`/`middleware.ts`. A page "reads" if it
calls `kernel(` / `portal(` / `api(` or `await fetch(`.

The check is smarter than a grep: a page counts as guarded if it *calls* something whose own module
reads the session (`cookies()`, `getSession`, `portalToken`, …). That's why
`await api<Thread[]>("threads")` satisfies it — `api()` in `lib/portal.ts` reads the session cookie.
A bare `await fetch(KERNEL_URL + …)` in the page satisfies nothing, which is exactly the case worth
catching.

*How you cause it:* adding a page that fetches directly instead of through `api()`. **Fix:** always
go through the app's kernel helper. It is also the only thing that scopes the request to the caller.

**4. `raw-html`** — no `dangerouslySetInnerHTML`, anywhere. Message bodies and agent output are
attacker-influenced; a customer typed them. There is no "but it's our own data" exception, because
the kernel's data is other people's text.

*If you need line breaks in a message body,* the answer is `whitespace-pre-wrap`, which is what
`app/portal/[thread]/page.tsx` already does.

**5. `typecheck` + `build`** — `npx tsc --noEmit` and `npm run build`, both. Skipped surprisingly
often. If `node_modules` is absent the verifier notes it and skips; a "passed" that skipped the build
has not proved much, so install first.

## How to treat a failure

Read the failure and fix the cause. The one thing you must not do is work around the gate — moving a
constant to make the import trace shorter, renaming a variable so it stops looking like a secret,
adding a `middleware.ts` stub so `unguarded-route` downgrades to a note. Each of those makes the gate
pass and the app wrong, and a gate with a false pass is worse than no gate: someone deletes it within
a week and then nobody is reading the code at all.

If you believe a failure is a false positive, say so in your answer with the trace, and leave it
failing. The verifier's own comments record two earlier versions that were wrong in opposite
directions; being wrong about it is normal, hiding it is not.
