# Integrating a frontend with the Mycel kernel

The kernel is an engine. Your product (a Next.js app, or anything) drives it over one HTTP
contract. This doc is the consumer's guide: what the kernel exposes, the recommended topology,
and how a frontend consumes it. Full event/type reference is in [`CONTRACT.md`](./CONTRACT.md).

## What the kernel exposes (`/v1`)

Server-to-server. Everything a product needs is here:

```
POST /v1/tasks                    create + start a task            → { task }
GET  /v1/tasks/:id                fetch a task                     → { task }
GET  /v1/tasks/:id/events         SSE stream (Last-Event-ID replay)
POST /v1/tasks/:id/cancel         request cancel                   → { task }
POST /v1/approvals/:id/approve    resolve an approval              → { ok, decision }
POST /v1/approvals/:id/reject     resolve an approval              → { ok, decision }
GET  /v1/artifacts/:id            fetch/download an artifact
```

The event stream is the heart of it. A task emits, in order:
`task.created → step.started → tool.called/tool.result → token.delta → progress →
approval.requested (pauses) → approval.resolved → output.validated → artifact.created →
cost.charged → task.finished`. Render from the stream; never poll.

## Recommended topology: your backend fronts the kernel

**Keep the kernel private. The browser talks to your app; your app proxies to the kernel.**

```
Browser ──► your Next.js API routes ──► Mycel kernel /v1/* (private network)
  /api/tasks              proxies POST /v1/tasks
  /api/tasks/:id/events   proxies the kernel SSE stream
  /api/approvals/:id/...  proxies approve/reject
```

Why: the kernel needs no public auth, provider/kernel secrets stay server-side, and you add
*your* auth (who can create tasks, per-tenant scoping) in your routes. Same code local and
cloud — only `MYCEL_KERNEL_URL` changes.

### Minimal Next.js proxy routes

```ts
// app/api/tasks/route.ts — create a task
const KERNEL = process.env.MYCEL_KERNEL_URL ?? "http://localhost:4000";
export async function POST(req: Request) {
  // (add your auth + per-tenant checks here)
  const r = await fetch(`${KERNEL}/v1/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: await req.text(),
  });
  return new Response(r.body, { status: r.status, headers: { "content-type": "application/json" } });
}

// app/api/tasks/[id]/events/route.ts — proxy the SSE stream
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const r = await fetch(`${KERNEL}/v1/tasks/${params.id}/events`, {
    headers: { accept: "text/event-stream" },
  });
  return new Response(r.body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}
```

### Consuming the stream in the browser

```ts
const es = new EventSource(`/api/tasks/${id}/events`);
es.addEventListener("token.delta", (e) => append(JSON.parse(e.data).data.text));
es.addEventListener("tool.called", (e) => showTool(JSON.parse(e.data).data));
es.addEventListener("approval.requested", (e) => promptApproval(JSON.parse(e.data).data));
es.addEventListener("artifact.created", (e) => showArtifact(JSON.parse(e.data).data));
es.addEventListener("task.finished", () => es.close());
```
(Reconnect with `Last-Event-ID` to replay from where you left off — the kernel persists events.)

## Local vs cloud

| | Local (dev) | Cloud |
|---|---|---|
| Kernel | `mycel dev` on `localhost:4000`, `MYCEL_SANDBOX=local\|docker` | Fly/Render container, `MYCEL_SANDBOX=daytona`, `MYCEL_DATABASE_URL` set |
| Product | `next dev`, `MYCEL_KERNEL_URL=http://localhost:4000` | Vercel, `MYCEL_KERNEL_URL=https://kernel.internal…` |
| Only difference | — | `MYCEL_KERNEL_URL` + the kernel's backends (Daytona/Postgres/S3) |

Deploy the kernel with the service `Dockerfile`; deploy the product to Vercel; point the
product at the kernel URL. Nothing else changes.

## The frontend is generated, not imported

You do not `npm install` a Mycel UI. The **frontend skill** (`skills/mycel-workspace`) teaches
your coding agent to generate the workspace UI — live stream, tool calls, approval cards,
artifact viewer — against this contract, in **your** shadcn theme and `globals.css`. See that
skill for the component contract and generation guidance.
