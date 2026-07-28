# Mycel Harness (v0.1)

The execution core: run a Mycel **task** by driving **OpenCode** inside a **sandbox**, stream
[contract](../docs/CONTRACT.md) events, enforce cost/runtime limits, gate approvals, return
artifacts. OpenCode *is* the agent — no custom loop. The sandbox backend and the LLM are both
configurable (see `.env.example`).

```
POST /v1/tasks ─► orchestrator ─► Sandbox (local | docker | daytona)
                                     └─ opencode serve ──► REST + SSE
   GET /v1/tasks/:id/events  ◄── contract events ◄── OpenCode event stream
```

## Configure (`.env`)

- **`MYCEL_SANDBOX`** = `local` (host) · `docker` (local container) · `daytona` (cloud microVM)
- **`MYCEL_MODEL`** = `provider/model`, e.g. `anthropic/claude-opus-4-8`, `openai/gpt-...`, `google/gemini-...`
- Provider key for the chosen model (`ANTHROPIC_API_KEY`, …); `DAYTONA_API_KEY` for the daytona backend.

## Run locally

```bash
npm install
# local backend needs the opencode binary:  npm i -g opencode-ai   (or use MYCEL_SANDBOX=docker)
export ANTHROPIC_API_KEY=sk-ant-...
npm run dev            # http://localhost:4000
```

Submit a task and watch it stream:

```bash
curl -s localhost:4000/v1/tasks -H 'content-type: application/json' \
  -d '{"wedge":"demo","task_type":"research","input":{"goal":"summarize the README"}}'
# → {"id":"...", ...}
curl -N localhost:4000/v1/tasks/<id>/events      # SSE: token.delta, tool.called, artifact.created, task.finished
curl localhost:4000/v1/artifacts/<artifact_id>   # the result
```

Approvals (when a task suspends): `POST /v1/approvals/<id>/approve` (or `/reject`).

## Backends

| `MYCEL_SANDBOX` | Where OpenCode runs | Needs |
|---|---|---|
| `local` | this host | `opencode` binary + provider key |
| `docker` | local container from `MYCEL_SANDBOX_IMAGE` | Docker + the sandbox image (`docker/sandbox/Dockerfile`) + provider key |
| `daytona` | isolated Daytona microVM | `DAYTONA_API_KEY` + the image pushed as a Daytona snapshot |

Build the sandbox image once: `docker build -t mycel/sandbox:latest docker/sandbox`.

## Deploy (cloud)

Deploy the **service** (`Dockerfile`) to Fly/Render with `MYCEL_SANDBOX=daytona` + `DAYTONA_API_KEY`
+ provider key. Same image runs local (`docker`) and cloud (`daytona`) sandboxes.

## Roadmap

- ✅ Task API + SSE (Last-Event-ID replay), orchestration, cost/runtime kill, sandbox
  abstraction (local/docker/daytona), OpenCode REST+SSE client, config-driven model,
  action-level approval gating, local + Langfuse tracing, wedge grounding.
- Next: proxy-mode model routing (provider keys stay server-side), Postgres store + durable
  engine, artifact upload to S3.
