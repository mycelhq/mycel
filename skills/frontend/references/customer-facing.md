# This app is seen by a founder's clients

Every other surface in this repo has an operator on the other side of it. This one does not. The
reader is a bookkeeping client, a landlord, a small-business owner who has never heard of Mycel and
should not start now. Two constraints follow, and they are the ones most likely to be violated by an
agent working quickly.

---

## 1. It renders the founder's brand. Never Mycel's.

**One deployment serves every founder's clients**, resolved from the `Host` header. The name, the
accent and the support email come from `businessFor(host)` at request time — not from a build, not
from a constant, not from you.

```tsx
// ✅ app/layout.tsx
const b = await businessFor((await headers()).get("host"));
return (
  <html lang="en">
    <body style={{ ["--business-accent" as string]: b.accent }}>{children}</body>
  </html>
);
```

```tsx
// ✅ any page that names the business
const business = await businessFor((await headers()).get("host"));
<p>{`What ${business.name} is doing for you, and everywhere we've spoken.`}</p>
```

```tsx
// ❌ every one of these is a bug
<h1>Mycel</h1>
<p>Powered by Mycel</p>
<span className="text-emerald-600">…</span>          // a hardcoded accent
<title>Client Portal</title>                          // generic, not the founder's name
const ACCENT = "#16a34a";                             // that is the SOLO fallback, not a default
```

Notes that matter:

- **`lib/portal.ts`'s exported `business` const is deprecated.** It is the self-hosted `SOLO`
  fallback, kept so a single-founder deployment keeps rendering. New code takes the host:
  `businessFor(host)`. `components/ui.tsx`'s `Shell` still uses the old const — if you touch it,
  thread the business through rather than adding a second import of the deprecated value.
- **The accent is validated as a hex triple twice** — once kernel-side and again in `businessFor` —
  because it lands in a `style` attribute on a page served to *someone else's* customers. If you
  introduce another path for branding to reach the DOM, validate it there too. Never interpolate a
  kernel-supplied string into a `className`, a `<style>` block, or a URL.
- **Voice is first-person plural, from the business.** "What we're doing for you." "Ask us for a
  fresh one." "Someone here will pick it up." Not "the agent", not "the system", not "Mycel".
- **`robots: { index: false, follow: false }`.** A customer's private page has no business in a
  search index. This is set in `generateMetadata`; keep it on any new customer-facing route.
- **No "AI" in the copy.** The founder may or may not want their clients to know how the work gets
  done. That is their decision to make in their own words, not yours to make in a footer.

---

## 2. Operator internals never reach this screen

The kernel already withholds costs, raw model output and approvals from the portal event stream.
That is the security half. The half you are responsible for is **legibility** — the same judgement,
applied to everything that does come through.

### Never render, under any circumstance

| leak | why it's a leak |
|---|---|
| **Cost** — `cost.charged`, USD figures, token counts | The client is paying the founder for an outcome. Showing the founder's cost of goods reframes the entire relationship. |
| **Model names** — "claude-opus", "gpt-…", "opencode" | Tells the client the work is automated, in the founder's voice, without the founder having chosen to. |
| **Raw kernel errors and stack traces** | `PortalError: portal 502` teaches an attacker your topology and tells a customer nothing. |
| **Internal identifiers** — task ids, wedge slugs, connection ids, `sk_…`-shaped anything | A wedge slug names the founder's internal service catalogue. |
| **Approval state** — "waiting for human review", "approved by" | The client should not learn that a person checks the work before it is sent, or that one didn't. |
| **Raw event type names** — `tool.called`, `step.started`, `output.validated` | Meaningless to a bookkeeping client and reads as a debug view someone forgot to hide. |

### Translate, don't dump

`app/portal/[thread]/live-run.tsx` is the model to follow:

```ts
const LABELS: Record<string, string> = {
  "task.created": "Started",
  "step.started": "Working",
  "tool.called": "Looking something up",
  "tool.result": "Got it",
  progress: "Progress",
  "output.validated": "Checked the result",
  "artifact.created": "Produced something",
  "task.finished": "Done",
};
```

"A customer wants to know something is happening and roughly what, not a trace view." An unknown
event type gets folded or dropped — **never** rendered raw as a fallback. The default case in a
translation map is silence, not `event.type`.

### Errors, translated

Same discipline. `reply.tsx`'s `message(xhr)` is the reference implementation: prefer the kernel's own
sentence when it wrote one (it knows the configured limit), otherwise map the status to something a
customer can act on, and normalise it — capitalise, add a full stop, `25MB` → `25 MB`. Never
`String(error)`.

And note `components/ui.tsx`'s `DeadLink`: **one honest message for used, expired and forged links
alike.**

> This link has expired. Links open once and last a week, so they can't be reused if an email is
> forwarded. Ask us for a fresh one and it'll take you straight back in.

One message for three causes is deliberate — distinguishing them tells someone probing the app which
of their guesses was closer. That principle generalises: the kernel answers **404, never 403**, for a
thread that isn't yours, so editing an id in the address bar can't even confirm another conversation
exists. Your UI must honour that. `notFound()` on both 404 and 401; never render "you don't have
access to this thread", which confirms the thread.

```tsx
// ✅ app/portal/[thread]/page.tsx
const data = await api<…>(`threads/${id}`).catch((e) => {
  if (e instanceof PortalError && (e.status === 404 || e.status === 401)) notFound();
  throw e;
});
```

### Ids in URLs are fine; tokens never are

A run id in the address bar is safe — the kernel checks the session owns the run and answers 404 to
anyone else, so an id in someone's browser history opens nothing. That's why `?run=<task_id>` is
deliberately kept in the URL: it's the only handle a customer gets on a run, and a refresh would
otherwise lose sight of the files.

A **token** in a URL is never safe. History, server logs, `Referer`. If a browser API can't carry an
`Authorization` header, proxy it same-origin.

### Send nothing the kernel can derive

```ts
// app/portal/[thread]/actions.ts — note what ISN'T sent
await api(`threads/${threadId}/messages`, { method: "POST", body: JSON.stringify({ body }) });
```

No author, no direction, no client id. The kernel derives all three from the session, so a customer
cannot post a message that appears to come from the business — and the attempt doesn't need to be
defended against, because there is nothing to send it with. **Any field you add to a client-side
request is a field a customer can forge.** If the kernel can derive it, don't send it.

---

## The test

Read every string that will render, out loud, as if you are the founder speaking to a client who
pays them. If any sentence would make the founder wince — because it names a vendor they didn't
choose, exposes a margin they didn't disclose, or reads like a log file — it doesn't ship.

Then check the network tab and the page source. A cost, a model name, a wedge slug or a stack trace
in a JSON payload the browser received is the same leak as one on the screen; the customer just has
to press F12 first.
