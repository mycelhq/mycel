# The Next.js rules that bite in this repo

Next 16, React 19, App Router, Tailwind 4. Every rule below has cost real time here, and each one
fails in a way that does not look like its cause. Read this before you write a route, not after the
error.

---

## 1. A Server Component cannot set a cookie

Cookies are set on a *response*. A Server Component renders into a stream that may already have
begun; there is no response for it to write a header onto. `cookies().set()` in a page throws at
runtime, and the error names the API rather than the reason, so it reads like a bug in Next.

**Only two things can set a cookie:** a Route Handler (`route.ts`) and a Server Action
(`"use server"`).

This is why the magic-link exchange is `app/portal/enter/route.ts` and not a page. From
`manifest.json`'s note on `auth-magic-link`:

> The exchange MUST be a route handler — a Server Component cannot set a cookie, and redirecting
> immediately keeps the one-time token out of history and Referer.

Note the second half. The handler exchanges the one-time token, sets the session cookie, and
`redirect()`s in the same response. If you render a page at the token URL instead, the token stays in
the address bar, goes into browser history, and is sent as the `Referer` on the next outbound link.

```ts
// ✅ app/portal/enter/route.ts — a Route Handler
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") ?? "";
  const session = token ? await exchange(token) : null;
  if (!session) return NextResponse.redirect(new URL("/portal?expired=1", req.nextUrl.origin));

  const res = NextResponse.redirect(new URL("/portal", req.nextUrl.origin));
  res.cookies.set(SESSION_COOKIE, session.token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/portal",          // scoped, so the credential isn't sent to the rest of the site
    maxAge: 60 * 60 * 24 * 30,
    // NO `domain:` — deliberately. Omitting it makes the cookie host-only, so a session minted on
    // acme.mycelai.dev is never sent to beta.mycelai.dev. `domain: ".mycelai.dev"` would let one
    // business's customer carry their session onto another's portal.
  });
  return res;
}
```

```tsx
// ❌ app/portal/enter/page.tsx — will not work, and will not tell you why
export default async function Enter({ searchParams }) {
  const session = await exchange((await searchParams).t);
  (await cookies()).set(SESSION_COOKIE, session.token); // throws
  redirect("/portal");
}
```

**Cookie scoping is the other half of this**, and it is called out in the real file because it is
load-bearing: omit `domain:` entirely so the cookie is host-only, and scope `path:` to the segment
that needs it. One deployment serves every founder's clients on their own hostname; a cookie on
`.mycelai.dev` carries one business's client session onto another's portal.

---

## 2. `"use server"` and `"use client"` are bundler boundaries with security consequences

They are not annotations. They tell the bundler where to cut the module graph, and everything
reachable from the browser side of that cut **ships to the browser**.

The rules, stated exactly:

- A module with `"use client"` and everything it imports at runtime is compiled into the client
  bundle. If any of it transitively reaches `import "server-only"`, that's a credential in someone's
  browser. This is `verify.mjs` rule 1, and the reason it traces the graph rather than checking one
  file: it happens three hops down a util file, never directly.
- A module with `"use server"` is a *boundary*, not a leak. A client component importing a Server
  Action is the correct pattern — Next replaces the import with an RPC stub and the module never
  reaches the browser. `verify.mjs` stops tracing there on purpose; an earlier version didn't and
  reported every correctly-written form as a credential leak.
- A `"use client"` boundary further down also stops the trace. The bundler splits there too.

```tsx
// ✅ app/portal/[thread]/reply.tsx
"use client";
import { send, type State } from "./actions"; // "use server" — becomes an RPC stub
```

```tsx
// ❌ the shape that leaks
"use client";
import { KERNEL_TIMEOUT } from "@/lib/portal"; // lib/portal.ts has `import "server-only"`
```

The fix for the second is never "delete the `server-only` import." It's to move the shared constant
into a module with no server imports, or to make the import type-only — which brings us to:

---

## 3. `import type` is erased. A mixed import is not.

TypeScript deletes a type-only import at compile time; the module never enters the bundle. So a
client component importing a *type* from a server-only module is completely safe, and `verify.mjs`
skips it — not skipping it flagged three correct files and a gate with a 100% false-positive rate is
a gate someone deletes.

But the erasure is all-or-nothing per statement:

```ts
import type { Thread } from "@/lib/portal";      // ✅ erased. Nothing is imported at runtime.
import { type Thread, api } from "@/lib/portal"; // ❌ NOT erased. `api` is a value, so the whole
                                                 //    module is imported — server-only and all.
```

The second line is the one that catches people, because it looks tidier and TypeScript is perfectly
happy with it. `verify.mjs` deliberately does not skip it. In a client component, use the first form,
always. In a Server Component the distinction doesn't matter for safety and
`import { api, type Thread } from "@/lib/portal"` is fine — which is what
`app/portal/page.tsx` does.

---

## 4. `params` and `searchParams` are Promises in Next 16

They are async. Awaiting them is not optional, and TypeScript will only catch it if you typed them
correctly in the first place — which is why the wrong version usually ships.

```tsx
// ✅ app/portal/[thread]/page.tsx
export default async function ThreadPage({
  params,
  searchParams,
}: {
  params: Promise<{ thread: string }>;
  searchParams: Promise<{ run?: string }>;
}) {
  const [{ thread: id }, { run }] = await Promise.all([params, searchParams]);
```

```tsx
// ❌ renders `[object Promise]` into a URL, or 404s on every request
export default async function ThreadPage({ params }: { params: { thread: string } }) {
  const data = await api(`threads/${params.thread}`); // params.thread is undefined
```

Await them together with `Promise.all` when you need both; they're independent and sequential awaits
cost a round of latency for nothing.

The same "it's async now" applies to `cookies()`, `headers()` and `draftMode()`. `app/layout.tsx`
does `await businessFor((await headers()).get("host"))` for exactly this reason.

---

## 5. A stale `.next` produces hydration mismatches that look like your bug

The symptom: `Hydration failed because the server rendered HTML didn't match the client`, pointing at
a component you didn't touch. You read the component, it's fine, you start changing correct code.

The cause is usually the build cache holding a compiled client chunk from before your edit — most
often after switching branches, changing `next.config.ts`, adding or removing a `"use client"`
directive, or upgrading a dependency.

**Before you debug a hydration error, do this:**

```bash
rm -rf business-template/.next && npm run dev
```

If it goes away, it was the cache. If it survives, it's a real mismatch, and there are only a few
real causes worth checking:

- **A value that differs between server and client render.** `Date.now()`, `new Date().toLocaleString()`,
  `Math.random()`, `window.matchMedia`. This is why `lib/format.ts` computes relative times on the
  server and never re-formats them on the client — its own comment calls this out as "the classic way
  a date turns into a console error."
- **Reading `localStorage` during render** to decide a layout. Read it in an effect, or better, put
  the state in a cookie the server can read. The `operator-shell` block does exactly this: "collapse
  state is a cookie read server-side, not localStorage — otherwise the sidebar renders wide then
  snaps narrow on every navigation."
- **Invalid HTML nesting** — a `<div>` inside a `<p>`, a `<form>` inside a `<form>`. The browser
  silently repairs it and the repaired tree no longer matches React's.

---

## 6. Three more that are specific to this app

**A Server Action's body is capped at ~1MB.** "Here is my bank statement" is usually a scan several
times that. `app/portal/[thread]/reply.tsx` submits text through the Server Action and switches to a
Route Handler with `XMLHttpRequest` the moment a file is attached — not a stylistic choice, and the
`XMLHttpRequest` is because `fetch` reports no upload progress at all, and on a phone a button that
just sits there gets pressed twice.

**`EventSource` cannot send an `Authorization` header.** The only two options are a token in the
query string — which leaks into history, logs and `Referer` — or a same-origin proxy route that adds
the header server-side. Always the proxy. See the `live-run` block's note and
`app/portal/[thread]/stream/route.ts`.

**Session-reading pages need `export const dynamic = "force-dynamic"`.** Without it Next may
statically render at build time, and a page that reads `cookies()` either throws or, worse, caches
one customer's data for everyone. Both portal pages set it.

**Per-request branding means `generateMetadata`, not `metadata`.** One deployment serves every
founder's clients, resolved from the `Host` header, so the title and description cannot be computed
at build time. `app/layout.tsx` exports `async function generateMetadata()` for this.

---

## The bar

Before you call a route done: is it a Route Handler if it sets a cookie? Does anything reachable from
a `"use client"` file import a value from a `server-only` module? Are `params` and `searchParams`
awaited? Is every timestamp formatted on the server? Does the page declare `force-dynamic` if it
reads the session?

Then run `node primitives/verify.mjs business-template`. It checks the first two mechanically. The
rest are yours.
