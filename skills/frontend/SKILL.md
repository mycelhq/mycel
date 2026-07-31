---
name: mycel-frontend
description: Build or edit the customer-facing business app — the Next.js portal a founder's CLIENTS see. Compose from primitives/, obey the Next.js rules that bite in this repo, render the founder's brand, and pass primitives/verify.mjs. Use whenever you touch business-template/ or generate a business app.
---

# Build the business app

The thing you are about to write is opened by **someone else's customer**. Not the founder, not an
operator, not you. A bookkeeping client who gets an email once a month, clicks a link on a phone,
and forms an opinion about whether this business is competent. That is the whole design brief, and
everything below follows from it.

Two hard facts before you write a line:

1. **The catalogue exists.** `primitives/manifest.json` lists nine vetted blocks and two recipes,
   and the working implementations of those blocks are the files in `business-template/`. You are
   composing and adapting, not inventing. → `references/composing-from-primitives.md`
2. **`node primitives/verify.mjs <app-dir>` is a gate, not a suggestion.** It fails the build. It
   catches the failures that are catastrophic and invisible: a credential reachable from a browser
   bundle, a page that reads customer data with no session above it, raw HTML from kernel data. Run
   it before you say you're done, and read what it says rather than working around it.

## The four rules, in one screen

**Compose before you invent.** Check `manifest.json` for a block that does the job. Check the recipe
list. Only then write something new — and if you write something new, say why in a comment. A
hand-rolled auth flow next to `auth-magic-link` is a bug, not a variation.

**The Next.js rules here are load-bearing, not style.** A Server Component cannot set a cookie.
`"use server"` and `"use client"` are bundler boundaries with security consequences. `import type` is
erased but a mixed import is not. `params` is a Promise in Next 16. A stale `.next` produces
hydration errors that look like your code is broken. Each of these has cost real hours in this
repo. → `references/nextjs-in-this-repo.md`

**Interface quality is a checklist, not a vibe.** One accent, neutral everything else. A spacing
scale, used consistently. Empty states that offer an action. Loading and error states written at the
same time as the success state, not bolted on. Forms with real labels. → `references/interface-quality.md`

**This app renders the founder's brand and leaks nothing operational.** The name and accent come
from `businessFor(host)` at request time — one deployment serves every founder's clients. Never
Mycel's name, never Mycel's colour. Never a cost, a model name, a stack trace, a raw kernel error,
or an internal id in front of a customer. → `references/customer-facing.md`

## The order to work in

1. **Read the host first.** `business-template/app/globals.css` for the tokens
   (`--background`, `--foreground`, `--muted`, `--border`, `--surface`, `--color-accent`),
   `components/ui.tsx` for the existing `Shell` / `Card` / `DeadLink`, `lib/portal.ts` for how the
   kernel is reached. Match what is there. A second design system inside one app is worse than a
   mediocre first one.
2. **Pick blocks.** From `primitives/manifest.json`. Note each block's `requires`, `conflicts`,
   `env` and `kernel` routes — a block whose kernel route you haven't wired renders an error state
   forever.
3. **Write the server side first.** Which route is a Server Component, which must be a Route
   Handler, which needs `"use server"`. Getting this wrong is not refactorable later; it's a
   rewrite. The reference file tells you which is which.
4. **Then the interface**, with every state present: empty, loading, error, success.
5. **Run the gate.** `node primitives/verify.mjs business-template` (add `--skip-build` only while
   iterating; never for the final answer).

## What you must never do

- Ship a page that reads customer data without a session check above it. `verify.mjs` catches this,
  but you should not need it to.
- Put a token in a URL. Not in a query string, not in a path. It lands in browser history, server
  logs, and the `Referer` header on the next outbound link. If a browser API can't carry an
  `Authorization` header — `EventSource` can't — proxy it same-origin instead.
- Use `dangerouslySetInnerHTML` on anything derived from kernel data. Message bodies and agent
  output are attacker-influenced by definition: a customer typed them.
- Add a dependency. This app has `next`, `react`, `@sentry/nextjs` and Tailwind. A component library,
  an icon pack, a date library, a state manager — none of these are worth the bundle, and every one
  of them is a second design system arriving through the back door. Everything in
  `references/interface-quality.md` is achievable with Tailwind and the tokens already defined.
- Invent a kernel endpoint. If the data isn't in `manifest.json`'s `kernel` list for some block,
  it probably doesn't exist. Say so rather than calling a route you hope is there.

## The bar

A founder shows this to a client without apologising for it. It looks like *their* business, loads
fast, says something useful when there's nothing to show, and says something a human can act on when
something breaks. Nothing on the screen reveals that an AI, a model, or a company called Mycel is
involved.

If you've produced three shades of purple, a gradient hero, emoji instead of icons, and a table with
"No data" in the middle of it — start again. That is the failure mode this skill exists to prevent.
