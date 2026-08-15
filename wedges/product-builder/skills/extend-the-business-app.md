---
description: The actual contents of ~/app, how the kernel verifies your work, and the Next.js 16 hazards this template sits on. Read this first, before any other skill.
---

# Extending the business app

`~/app` is a working Next.js 16 / React 19 / Tailwind v4 app, seeded before your first turn. **You
are extending it.** No `create-next-app`, no scaffolding, no building in your home directory —
`~/app` is the only thing exported when this run ends; everything else dies with the sandbox.

```bash
cd ~/app && npm install    # node_modules is neither seeded in nor exported — install first
```

## What is actually there

| Path | What it is |
|---|---|
| `app/page.tsx` | Public marketing page. Contains **no sentences** — copy lives in `content/marketing.ts`, and `middleware.ts` picks an A/B arm before render. Keep it that way. **Read `skills/read-the-evidence.md` before you change a word of it.** |
| `app/portal/**` | **The product.** A client's threads, files and live runs, behind a session cookie scoped to `path=/portal`. |
| `app/layout.tsx` | Sets `--business-accent` per request from the tenant's branding. |
| `lib/kernel.ts` | The only way to reach Mycel. Read `skills/talk-to-the-kernel.md` before any request. |
| `components/shell.tsx` | `Shell`, `Card`, `DeadLink` — the portal frame. |
| `components/marketing.tsx` | `Section`, `Eyebrow`, `PortalCta`, `Figures`, `Services`, `Testimonials`, `MarketingHeader`, `MarketingFooter`. |
| `components/ui/button.tsx` | The only shadcn component in the tree. See `skills/build-the-ui.md`. |
| `lib/format.ts` | `relative(iso)` — server-computed human dates. Use it; do not add a date library. |
| `lib/utils.ts` | `cn()`. |
| `lib/experiment.ts` | A/B plumbing: the arm, and the cookie that remembers whether this visitor has been counted. |
| `lib/analytics.ts` | The one measurement seam. Records an exposure on `/` and a conversion on `/portal`, and does nothing else, ever. |
| `lib/insight.ts` | The transport under it. Server-side only, no tracker on the page, silent when unconfigured. |
| `lib/session.ts` | The portal session cookie's NAME. Middleware needs it and must not import `lib/kernel.ts`. |

Everything under `app/` is a Server Component unless it says `"use client"`. Exactly three files do
— `reply.tsx`, `thread-files.tsx`, `live-run.tsx` — and each for genuine browser state (upload
progress, `EventSource`). That ratio is the convention, not an accident.

The portal is part of THIS app, not a shared service. It is the founder's product on the founder's
domain, and it is meant to grow into their business: a bookkeeper's portal grows tax deadlines, a
design studio's grows proofs. New pages go under `app/portal/`, and carry
`export const dynamic = "force-dynamic"` like every other page here — nothing in this app may be
cached, because one deployment serves every founder's clients.

## Next.js 16, which is not 15

- **`params` and `searchParams` are Promises.** `const { thread } = await params`. Synchronous
  access was removed in 16, not deprecated. Same for `cookies()`, `headers()`, `draftMode()`.
- **`next dev` takes a lockfile and writes to `.next/dev`.** Leave a dev server running when you
  stop and the kernel's verification cannot start its own — the task fails. Kill it.
- **There is no `next lint`.** Removed in 16, and there is no lint script here. Don't invent one.
- **Do not rename `middleware.ts` to `proxy.ts`.** The 16 rename is real, but `proxy` forces the
  nodejs runtime, and the A/B assignment is the one thing that must stay on the edge path of `/`.
- Turbopack is the default for dev and build alike. Never add a webpack config: `next build` fails
  outright when it finds one.

## Five things that will get your change rejected

1. **Fetching the kernel by hand.** Any `fetch` at a kernel URL outside `lib/kernel.ts` is wrong
   even when it works. Read `skills/talk-to-the-kernel.md` before you write a request.
2. **A second styling system.** No CSS modules, no styled-components, no hex literals. Tailwind v4
   utilities and the tokens in `app/globals.css`, nothing else.
3. **Rewriting the marketing hero without reading `mycel-insight` first.** This site measures its
   own arms and the kernel decides which one won. Rewriting on taste discards that, and rewriting on
   a result the kernel refused to call thrashes a paying client's front door. See
   `skills/read-the-evidence.md`.
4. **Adding an analytics vendor.** There is deliberately none, and no script runs in a visitor's
   browser. This app faces a client's own customers; installing a tracker in it is the founder's
   decision, not a default. `lib/insight.ts` says what happens instead.
5. **Leaving it broken** — and the kernel checks, so your summary does not get the last word.

## How the kernel verifies you, exactly

After you stop, the kernel runs this. Non-zero exit **fails the task**:

```
npm install --no-audit --no-fund  &&  npx tsc --noEmit  &&  next dev must answer 200 on /
```

Note what that is not: `npm run build`. A production build OOM'd the sandbox, so what is left is a
typecheck and a real boot. Which means `npx tsc --noEmit` and a `curl -o /dev/null -w '%{http_code}'
http://127.0.0.1:3000/` are the two checks worth running yourself, repeatedly, well before you are
finished. A type error found with turns left is a fix; the same error found after you stop is a
failed task that ships nothing.

There is also `npm test` — Node's own runner over `test/*.test.ts`, no framework. It covers the
measurement seam: that a missing analytics config records nothing, that the assignment cookie
round-trips, that an arm from a tampered cookie cannot become an arbitrary event. The kernel does
not run it, which is exactly why you should: it is the only check in this app that asserts the
NUMBERS an agent will later act on mean what they claim. If you touch `lib/experiment.ts`,
`lib/insight.ts` or `middleware.ts`, run it and extend it.

Separately, `mycel-build` (documented in your AGENTS.md) compiles the app on the real deploy
toolchain **during** the run and hands you the actual build log when it fails. The task is not
finished until it has succeeded.

## The rhythm

`mycel-insight` → read the neighbouring file → change it → `npm test` → typecheck → boot it →
`mycel-build`. The neighbouring file is not optional reading: almost every convention in this app is
written down in a comment directly above the code that implements it.
