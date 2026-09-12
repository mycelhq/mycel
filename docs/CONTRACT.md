# Mycel Contract v0.1 (the keystone)

> The one hard artifact Mycel owns besides the harness. The harness **emits** this, frontend
> skills **generate against** it, every wedge
> **speaks** it. Wedge-agnostic. This doc is also the skill Claude Code reads to build a
> Mycel frontend. Versioned; additive-first (new event types / fields never break old readers).

## 1. Task — the durable primitive (not a chat message)

```jsonc
{
  "id": "uuid",
  "wedge": "uk-property-sourcing",     // which wedge config this task runs under
  "task_type": "source_properties",    // wedge-defined verb
  "actor": { "kind": "user|business|system", "id": "..." },
  "input": { /* wedge-defined */ },
  "constraints": {
    "max_runtime_s": 300,
    "max_cost_usd": 1.0,
    "approval_required": false
  },
  "tools": ["web_search", "..."],       // granted, least-privilege, per task
  "output_schema": { /* optional JSON Schema the result is validated against */ },
  "status": "queued",
  "cost_usd": 0,
  "created_at": "iso8601",
  "updated_at": "iso8601"
}
```

### Lifecycle
```
queued → provisioning → running → awaiting_approval → running
       → validating → succeeded | failed | rejected | expired | cancelled
```
Terminal states: `succeeded, failed, rejected, expired, cancelled`. `awaiting_approval` is the
only pause state; it resumes to `running` on approval, or ends `rejected`/`expired`.

## 2. Event stream — append-only, persisted + streamed

Every event shares one envelope. `id` is a monotonic integer per task; it is the SSE event id,
so a client that reconnects with `Last-Event-ID: N` replays everything after N. `seq` mirrors
`id` for consumers that don't use SSE ids.

```jsonc
{ "id": 42, "task_id": "uuid", "seq": 42, "type": "tool.called",
  "ts": "iso8601", "data": { /* type-specific */ } }
```

### Event types (additive; unknown types must be ignored, not errored)
| type | when | key `data` fields |
|---|---|---|
| `task.created` | accepted | `wedge, task_type` |
| `step.started` | agent begins a step | `step` |
| `tool.called` | agent invokes a tool | `tool, args` |
| `tool.result` | tool returns | `tool, ok, result?` |
| `progress` | coarse progress | `pct, note` |
| `token.delta` | streaming model text (optional) | `text` |
| `approval.requested` | high-risk action needs a human | `approval_id, action, risk, preview` |
| `approval.resolved` | human decided | `approval_id, decision` |
| `output.validated` | result checked vs `output_schema` | `ok, errors?` |
| `artifact.created` | an output artifact stored | `artifact_id, name, content_type, url?` |
| `cost.charged` | incremental cost | `cost_usd, reason` |
| `task.finished` | terminal | `status` |
| `feedback.recorded` | outcome captured (self-improve) | `metric, value` |

Ordering: strictly increasing `id` per task. `task.created` is always id 1; `task.finished`
is always last. Consumers render from the stream; they never poll for state.

## 3. Approval — the trust primitive

```jsonc
{
  "approval_id": "uuid",
  "task_id": "uuid",
  "action": "send_message",       // the thing about to happen
  "risk": "low|medium|high",
  "preview": { /* exactly what will happen, e.g. the drafted message */ },
  "status": "pending|approved|rejected|expired",
  "expires_at": "iso8601"          // TTL; on expiry the task ends `expired`
}
```
Gate on **actions** (send/book/pay/delete/share), never on content. The task suspends on
`approval.requested` and resumes only on `approval.resolved`.

## 4. HTTP surface (what a founder's product / the harness expose)

```
POST /v1/tasks                      → create a task            → {task}
GET  /v1/tasks/:id                  → fetch a task             → {task}
GET  /v1/tasks/:id/events           → SSE stream (Last-Event-ID replay)
POST /v1/tasks/:id/cancel           → request cancel           → {task}
POST /v1/approvals/:id/approve       → resolve approval         → {ok, decision}
POST /v1/approvals/:id/reject        → resolve approval         → {ok, decision}
GET  /v1/artifacts/:id              → fetch/download an artifact
```
Auth (v0.1): founder **API key** as `Authorization: Bearer <key>`, required on every public
endpoint. In the recommended topology the browser never holds it — your product's server-side
proxy adds it and layers on per-user auth/tenancy. Short-lived **task-scoped JWTs** (for direct
browser→kernel embeds) are on the roadmap, not yet implemented.

The service surface (`/v1/connections`, `/v1/channels`, `/v1/clients`, `/v1/threads`,
`/v1/channels/:id/inbound`) and the action proxy (`/v1/internal/actions/:capability`) are
documented in [INTEGRATION.md](./INTEGRATION.md), which also states what v0.1 does and does not
yet enforce.

## 5. Wedge config — how a wedge is defined (the ~20% the founder writes)

```jsonc
{
  "wedge": "uk-property-sourcing",
  "agent": { "model": "opus", "skills": ["source", "qualify"], "tools": ["web_search"] },
  "memory": { "entities": ["property", "lead"], "policy": "read-write" },
  "approvals": [ { "action": "send_message", "risk": "medium", "required": true } ],
  "channels": ["web", "email"],
  "task_types": {
    "source_properties": { "input_schema": { /* ... */ }, "output_schema": { /* ... */ } }
  }
}
```
The harness loads this per task. Everything else (runtime, sandbox, streaming, approvals,
memory, cost limits) is Mycel's job.

## 6. Versioning
`/v1`. Additive changes (new event types, new optional fields) never bump. A breaking change
bumps to `/v2` with a migration note. Readers ignore unknown event types and fields.
