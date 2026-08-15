---
name: mycel-workspace
description: Generate the Mycel agent-workspace UI (live stream, tool calls, approvals, artifacts) against the kernel event contract, styled to the host app's own design system.
---

# Generate a Mycel workspace UI

Your job: build the frontend that lets a human watch and supervise a Mycel task — in **this
app's** design system, not a generic one. Nothing is imported from Mycel; you generate real
components in the founder's codebase, matching their brand.

## Step 1 — read the host design first (do this before writing any UI)

- Read `globals.css` / the Tailwind config / design tokens. Note the color tokens
  (`--background`, `--foreground`, `--primary`, `--muted`, `--border`, `--card`), radius, and font.
- List the existing UI primitives (shadcn `Card`, `Button`, `Badge`, `ScrollArea`, `Separator`,
  `Avatar`, etc.). **Reuse them.** Do not introduce a second component library or a new palette.
- Match the app's spacing, typography scale, and density. The workspace should look like it was
  always part of this product.

## Step 2 — the contract you consume

Events arrive over SSE from your own proxy route (`/api/tasks/:id/events`; see
`docs/INTEGRATION.md`). Handle these `type`s:

| event | render as |
|---|---|
| `task.created` / `step.started` | a timeline entry / status change |
| `token.delta` | streaming assistant text (append incrementally) |
| `tool.called` / `tool.result` | a tool row (name + args, then ✓/✗) |
| `progress` | a subtle progress note |
| `approval.requested` | a **prominent approval card** — the preview + Approve / Reject |
| `approval.resolved` | collapse the card into a resolved chip |
| `artifact.created` | an artifact entry (open / download) |
| `cost.charged` | (optional) a running cost figure |
| `task.finished` | final status; close the stream |

Reconnect with `Last-Event-ID` to replay — the kernel persists events, so a refresh or a dropped
connection never loses the timeline.

## Step 3 — components to generate (in the host's style)

- **`TaskWorkspace`** — the container: submits/loads a task, opens the SSE stream, holds state.
- **`StreamTimeline`** — the ordered feed of steps, tool calls, streamed text, and progress.
  Use the host's `ScrollArea`/`Card`; auto-scroll while running.
- **`ToolCall`** — one tool invocation: name, args (collapsible), result state.
- **`ApprovalCard`** — the trust moment. Show `preview` clearly; two buttons wired to
  `/api/approvals/:id/approve|reject`. Make it visually distinct (the host's `primary` for
  approve, a `destructive`/outline for reject). This is the most important component — a human
  is deciding whether a real action happens.
- **`ArtifactViewer`** — render or link the artifact by `content_type`.
- **`StatusBadge`** — task status using the host's `Badge` variants.

## Step 4 — states and polish

Handle every state, using the host's conventions: **empty** (no task yet), **running** (live
stream, subtle activity), **awaiting_approval** (surface the approval, don't bury it),
**succeeded** (artifact prominent), **failed/expired/cancelled** (clear message + retry).
Loading and error states use the app's existing patterns.

## What "good" looks like

- It reads as a native part of the app — same tokens, same primitives, same spacing.
- The stream feels live; approvals are impossible to miss.
- Zero Mycel-branded styling leaks in. The only Mycel dependency is the **event contract**.
- No new dependencies beyond what the app already has (its shadcn set + an `EventSource`).
