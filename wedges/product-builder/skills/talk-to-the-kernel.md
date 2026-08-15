---
description: How the app reads business data — the complete closed surface of lib/kernel.ts, why it has no path parameter, and what to do when the data you need isn't there. Read before writing any request.
---

# Talking to the kernel

The app renders. **The kernel decides.** Every function below is scoped to the client's session
server-side, by Mycel — not by anything this app checks. This app holds no authority: it does not
verify links, does not check thread access, does not decide which files are downloadable. It
receives what was already authorised and puts it on a page.

## The whole surface

That is the complete list. `lib/kernel.ts` exports nothing else that reaches the network.

```ts
import { me, listThreads, getThread, sendMessage, listThreadFiles, listCases } from "@/lib/kernel";

await me();                          // Me | null — null means the session is gone; render <DeadLink />
await listThreads();                 // Thread[]   — never throws, [] on failure
await getThread(id);                 // { thread, messages } | null — null → notFound()
await sendMessage(threadId, body);   // { task_id? } — no task_id means "recorded, no run started"
await listThreadFiles(threadId);     // FileRef[]
await listCases();                   // Case[] — `stage` belongs to the wedge; render it, don't judge it
```

Three more return a raw `Response` to be piped, never buffered — `uploadToThread`, `downloadFile`,
`runEvents(taskId, lastEventId?, signal?)`. Plus `exchangeLink` (the one unauthenticated call; it
*is* the authentication) and `SESSION_COOKIE` / `KernelError`.

Types are hand-written in that file and are the portal projection only: `Me`, `Thread`, `Message`
(`direction: "inbound" | "outbound"`, where inbound is *from the client*), `Case`, `FileRef`.
Do not reach for the kernel's `contract.ts` — it describes the operator domain.

## Branding — one accessor, and it takes no argument

```ts
import { businessBrand, type BrandKit } from "@/lib/kernel";
const kit = await businessBrand();   // display_name, accent, neutral, support_email, logo?, mark?,
                                     // type: { heading, body }, letterhead, footer[]
```

Session-free, and **the only way to ask whose business this is.** There used to be three —
`business` (an env-var constant), `businessFor(host)` and `businessProfile()` — and all three are
gone. Two of them returned the legacy trio (name, accent, support email), which is a strict subset
of the same jsonb column that `BrandKit` comes from; a header reading one projection while the page
body read the other is exactly how a hosted deployment came to show a client their supplier's portal
wearing a stranger's name. If you find any of the old names in a file you are editing, it is stale —
replace it, don't work around it.

It takes **no argument**, deliberately. The hostname is what decides which founder's brand a render
belongs to, and it is read inside `lib/kernel.ts` from the request itself, so no caller can hand it
the wrong one. Never reintroduce a `host` parameter.

An absent `logo` and an empty `footer` are instructions, not holes: draw the display name as a
wordmark, and render no footer element at all — never an empty box, never a reserved blank strip.
`components/brand.tsx` (`BrandMark`, `Letterhead`, `BrandFooterLines`) already does this. Use it.

## The one other module that reaches the kernel

`lib/insight.ts`, and its authority is why it is allowed to. It holds an **ingest key** whose entire
power is "append an event to this one project" — it cannot read a thread, a client, a file or
anything else, and the project it writes to comes from the signature on the key rather than from
anything this app sends. It posts to exactly one path and takes no parameter that could change that.

Call it through `lib/analytics.ts`, never directly, and read `skills/read-the-evidence.md` before you
touch the marketing page. Do not add a third module that talks to the kernel, and do not add an
analytics vendor: there is none installed, on purpose.

## Why there is no `api(path)` function

Because if there were, "read another client's data" would be one typo away, and the person writing
that typo would be a model. So: **no exported function takes a URL, a path fragment, a token, or a
client / project / org id.** There is nowhere to put one. The session cookie is read inside
`lib/kernel.ts` and never handed out; the kernel's base URL is private to that module.

Ids like a thread id *are* fine to pass. The kernel answers 404 — never 403 — for a thread that is
not this session's, so guessing one cannot even confirm it exists.

## Rules

- **Never** `fetch` the kernel outside `lib/kernel.ts`. Not in a route handler, not in a Server
  Action, not "just this once for the SSE proxy" — `runEvents`, `uploadToThread` and `downloadFile`
  already exist for exactly those three cases.
- **Never** pass the session token, the kernel URL, or an unfiltered kernel response into a Client
  Component. Client Components receive rendered props, not credentials.
- **Never** add a `NEXT_PUBLIC_` variable pointing at the kernel. The browser has no address for it
  and must not get one.
- Every kernel call is `cache: "no-store"`, without exception, and every page is `force-dynamic`.
  Next's URL-keyed caching would serve one client's rendered thread to another — a leak at the
  framework layer, where no amount of kernel-side scoping can see it. If you add a data path, it is
  no-store too.
- Downloads stay proxied through this app so the kernel's `Content-Disposition: attachment` and
  `nosniff` survive. An uploaded HTML file rendered on this origin is stored XSS against every
  client on the thread.

## When the data you need isn't there

If no function above returns what a page needs, **that is the answer.** Say so in your final
summary and build what you can. Do not compose a request the kernel has not scoped, and do not add
a function here that takes a path or a foreign id. A new `/v1/portal/*` route is a kernel change,
made by a human — and a drift test (`test/contract-surface.test.ts`) already asserts that every
path this file requests exists kernel-side, so inventing one fails there rather than on a client's
page.
