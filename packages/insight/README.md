# @mycel/insight

Analytics for a founder's generated product, read by the agent that improves it.

A Mycel product is written by an agent. Once it is live, that agent is blind: it can read its own
code and nothing about what happened when a real customer met it, so the next iteration is guesswork
wearing the clothes of judgement. This package closes that loop. The product declares a funnel, the
client reports steps under consent, the kernel rolls them up per project, and
`GET /v1/insight/summary` hands the agent a terse structured answer to "which step is losing people,
and what changed since last week" — shaped to be the input to a task, not a chart for a human.

## Wiring it into a product

```tsx
// app/layout.tsx — a Server Component, so `enabled` is a per-request server env read
import { InsightProvider } from "@mycel/insight/next";

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <InsightProvider
      enabled={!!process.env.INSIGHT_INGEST_KEY}
      funnel={{ name: "intake", steps: ["viewed_service", "started_intake", "submitted", "paid"] }}
    >
      {children}
    </InsightProvider>
  );
}
```

```ts
// app/api/insight/route.ts — the same-origin hop that keeps the ingest key server-side
import { createInsightRoute } from "@mycel/insight/next";
export const { POST } = createInsightRoute();
```

```ts
// anywhere in a client component
import { track } from "@mycel/insight";
track("submitted", { service: "deep_clean" });
```

`INSIGHT_INGEST_KEY` comes from `GET /v1/insight/key` on the kernel. It is a **server** env var:
never `NEXT_PUBLIC_*`, which is inlined at build time and would both ship the key to every visitor
and keep using the old one after a rotation, silently.

## What it will not do

These are not settings. They are properties.

- **No IP, no user agent, no referrer, no cookies.** Not redacted afterwards — never read. A header
  you never look at cannot leak.
- **Paths, never URLs.** Query strings and fragments are stripped before anything else touches them,
  and id-shaped segments are masked (`/orders/9182` → `/orders/:id`). A magic sign-in link is a
  credential that lives in a query string; capturing `location.href` on the page it lands on posts a
  working login to an analytics endpoint, where it then sits in a database and a log.
- **No form contents.** Prop keys that could hold something a customer typed, or something that
  authenticates them, are dropped — not truncated, not hashed. Values that look like a token, a JWT,
  an email or an id are dropped even under an innocent key.
- **No per-visitor timeline.** The anonymous id is accepted on the wire and discarded at ingest, so a
  visit cannot be reconstructed afterwards. Funnels therefore count events rather than people; see
  `src/funnel.ts` for why that is the right side of the trade.
- **Nothing before consent.** `null` is not "not decided yet, so carry on". The provider does not
  even import the client until consent is `granted`, so an unconsented visitor never downloads the
  tracking code — a banner rendered next to an already-running tracker is a notice, not consent.
  Withdrawal sweeps first-party storage by prefix and drops the pending queue.
- **No project id from the client.** Every event is attributed server-side from the signature on the
  per-project ingest key. There is no field for one, in any layer.

Redaction runs client-side **and** again at the kernel. The client's pass is a courtesy to the
network; the server's is the one that is load-bearing, because a browser is a machine an attacker
owns and the client is code a founder can edit.

## Why `lib` includes DOM

Half of this package runs in a customer's browser, so it needs `navigator.sendBeacon` and
`localStorage`. The kernel's own tsconfig deliberately omits DOM; this one cannot. (Noted here
rather than in tsconfig.json, which must stay comment-free — the pre-commit JSON check parses it
strictly, and TypeScript's tolerance for JSONC is not shared by every tool that reads it.)

## Publishing — the seam, deliberately not wired

`"private": true`, and it stays that way. This is not a public utility: it ships inside a paid
product and phones home to our kernel, and a package on the public registry that posts to a Mycel
endpoint by default is a support burden and a trust problem at the same time.

The intended target is **AWS CodeArtifact**, on the IAM and CodeBuild wiring that already exists.
The seam is the two things a publish step would need, and neither is set here:

- `publishConfig.registry` — the CodeArtifact npm endpoint for the `mycel` domain.
- an auth token from `aws codeartifact get-authorization-token`, in CI only, never checked in.

Nothing in this repo runs `npm publish`. Adding it should be a deliberate act, not a side effect of
a version bump. Until then consumers resolve the package through the workspace.

## Tests

```
npx tsc --noEmit
npx tsx --test test/*.test.ts
```

The kernel half — ingest, project scoping, redaction on arrival, the summary — is tested in
`kernel/harness/test/insight.test.ts`. The funnel maths and the wire schema exist in both places on
purpose (the kernel ships as a container that does not contain this package, and an ingest endpoint
must treat its client as hostile), and both copies are pinned by tests asserting the same numbers —
so a divergence is a red test rather than an argument about whose conversion rate is right.
