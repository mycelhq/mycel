import { test } from "node:test";
import assert from "node:assert/strict";
import { api, makeApp, waitTask } from "./helpers";
import { buildTrace, type Span } from "../src/traces";
import type { EventType, TaskEvent } from "../src/contract";

// The fold is the whole product here: the events were always being written, and nothing read them.
// So these tests are about the read — including the ugly cases (a crashed run, a replica writing a
// skewed clock, thousands of token deltas) that decide whether the view is usable on a bad day.

let clock = Date.parse("2026-07-31T12:00:00.000Z");
/** Each event a fixed step after the last, so durations in assertions are exact. */
const ev = (type: EventType, data: Record<string, unknown> = {}, stepMs = 100): TaskEvent => {
  clock += stepMs;
  return { id: 0, task_id: "task-1", seq: 0, type, ts: new Date(clock).toISOString(), data };
};

/** Stamp seq in list order. Tests that care about ordering override it explicitly. */
const seq = (events: TaskEvent[]): TaskEvent[] =>
  events.map((e, i) => ({ ...e, id: i + 1, seq: i + 1 }));

const find = (s: Span, name: string): Span | undefined =>
  s.name === name ? s : s.children.map((c) => find(c, name)).find(Boolean);

test("traces: steps nest their tool calls and the root closes on task.finished", () => {
  const trace = buildTrace(
    seq([
      ev("task.created", { wedge: "books-keeper", task_type: "daily_sync" }),
      ev("step.started", { step: "configure_sandbox" }),
      ev("step.started", { step: "start_opencode" }),
      ev("tool.called", { tool: "read:composio:XERO_GET_INVOICES", args: { query: "unpaid" } }),
      ev("tool.result", { tool: "read:composio:XERO_GET_INVOICES", ok: true }),
      ev("task.finished", { status: "succeeded" }),
    ]),
  );

  assert.equal(trace.root.name, "books-keeper:daily_sync");
  assert.equal(trace.root.status, "ok");
  assert.equal(trace.root.children.length, 2, "two steps hang off the root");

  const first = trace.root.children[0]!;
  assert.equal(first.name, "configure_sandbox");
  assert.equal(first.duration_ms, 100, "a step ends when the next one starts");
  assert.equal(first.children.length, 0);

  const second = trace.root.children[1]!;
  assert.equal(second.children.length, 1, "the tool call belongs to the step it ran in, not the root");
  const tool = second.children[0]!;
  assert.equal(tool.type, "tool");
  assert.equal(tool.status, "ok");
  assert.equal(tool.duration_ms, 100);
  assert.deepEqual(tool.preview, { query: "unpaid" });

  assert.equal(trace.totals.tool_calls, 1);
  assert.equal(trace.totals.tool_ms["read:composio:XERO_GET_INVOICES"], 100);
  assert.equal(trace.totals.duration_ms, 500);
  assert.equal(trace.totals.errors, 0);
});

test("traces: a crashed run still renders — unclosed spans are `running` with no end", () => {
  // The log just stops: the process died between the call and the result. This is the case a trace
  // view exists FOR, so it must not throw and must not pretend the tool returned.
  const trace = buildTrace(
    seq([
      ev("task.created", { wedge: "outreach", task_type: "sequence" }),
      ev("step.started", { step: "start_opencode" }),
      ev("tool.called", { tool: "email:send_email", args: {} }),
    ]),
  );

  assert.equal(trace.root.status, "running");
  assert.equal(trace.root.end_ts, undefined);
  const step = trace.root.children[0]!;
  assert.equal(step.status, "running");
  assert.equal(step.end_ts, undefined);
  const tool = step.children[0]!;
  assert.equal(tool.status, "running");
  assert.equal(tool.end_ts, undefined);
  assert.equal(tool.duration_ms, undefined);
  // No end on the root, so wall clock falls back to the last event actually recorded.
  assert.equal(trace.totals.duration_ms, 200);
});

test("traces: thousands of token deltas collapse into one generation span", () => {
  // One span per delta would be a 3,000-node tree carrying no information a count doesn't.
  const events: TaskEvent[] = [
    ev("task.created", { wedge: "w", task_type: "t" }),
    ev("step.started", { step: "start_opencode" }),
  ];
  for (let i = 0; i < 3000; i++) events.push(ev("token.delta", { text: "x" }, 1));
  events.push(ev("tool.called", { tool: "write" }));
  events.push(ev("tool.result", { tool: "write", ok: true }));
  for (let i = 0; i < 5; i++) events.push(ev("token.delta", { text: "y" }, 1));
  events.push(ev("cost.charged", { cost_usd: 0.0125, reason: "model" }));
  events.push(ev("task.finished", { status: "succeeded" }));

  const trace = buildTrace(seq(events));
  const step = trace.root.children[0]!;
  const generations = step.children.filter((s) => s.type === "generation");
  assert.equal(generations.length, 2, "one span per burst, split by the tool call between them");
  assert.equal(generations[0]!.token_deltas, 3000);
  assert.equal(generations[1]!.token_deltas, 5);
  assert.equal(generations[0]!.duration_ms, 2999, "the burst's span is first delta to last");
  assert.equal(trace.totals.token_deltas, 3005);
  assert.equal(trace.totals.cost_usd, 0.0125);
});

test("traces: an empty event list yields an empty trace instead of throwing", () => {
  const trace = buildTrace([]);
  assert.equal(trace.event_count, 0);
  assert.equal(trace.root.children.length, 0);
  assert.equal(trace.root.status, "running");
  assert.equal(trace.totals.duration_ms, 0);
  assert.equal(trace.totals.cost_usd, 0);
});

test("traces: out-of-order rows are folded by seq, not by arrival or timestamp", () => {
  // `eventsAfter` orders by seq, but the local JSONL sink and any future batch reader do not, and a
  // tool.result arriving before its tool.called would silently produce an orphan span.
  const ordered = seq([
    ev("task.created", { wedge: "w", task_type: "t" }),
    ev("step.started", { step: "one" }),
    ev("tool.called", { tool: "search" }),
    ev("tool.result", { tool: "search", ok: true }),
    ev("task.finished", { status: "succeeded" }),
  ]);
  const shuffled = [ordered[4]!, ordered[1]!, ordered[3]!, ordered[0]!, ordered[2]!];

  const trace = buildTrace(shuffled);
  assert.equal(trace.root.name, "w:t");
  assert.equal(trace.root.status, "ok");
  const step = trace.root.children[0]!;
  assert.equal(step.name, "one");
  assert.equal(step.children.length, 1, "the result paired with its call, not with nothing");
  assert.equal(step.children[0]!.status, "ok");
  assert.equal(trace.totals.tool_calls, 1);
});

test("traces: a failed run carries the reason, and a skewed clock never prints a negative duration", () => {
  const events = seq([
    ev("task.created", { wedge: "w", task_type: "t" }),
    ev("step.started", { step: "one" }),
    ev("tool.called", { tool: "email:send_email" }),
    ev("tool.result", { tool: "email:send_email", ok: false, detail: "550 rejected" }),
    ev("task.finished", { status: "failed", error: "output failed validation" }),
  ]);
  // A different replica wrote the result, a second behind.
  events[3] = { ...events[3]!, ts: new Date(Date.parse(events[2]!.ts) - 1000).toISOString() };

  const trace = buildTrace(events);
  assert.equal(trace.root.status, "error");
  assert.equal(trace.root.error, "output failed validation");
  const tool = find(trace.root, "email:send_email")!;
  assert.equal(tool.status, "error");
  assert.equal(tool.error, "550 rejected");
  assert.equal(tool.duration_ms, 0, "clamped, not negative");
  assert.equal(trace.totals.errors, 2, "the tool failure and the task failure");
});

test("traces: approvals become spans, and an action's lone tool.result is not dropped", () => {
  // The action proxy announces the call as an approval and only emits `tool.result` afterwards, so
  // there is no `tool.called` to pair with. Dropping it would hide the single most consequential
  // thing on the timeline: the email that actually went out.
  const trace = buildTrace(
    seq([
      ev("task.created", { wedge: "w", task_type: "t" }),
      ev("step.started", { step: "one" }),
      ev("approval.requested", {
        approval_id: "ap-1",
        action: "email:send_email",
        risk: "high",
        preview: { to: "a@b.co", api_key: "sk-live-should-not-render" },
      }),
      ev("approval.resolved", { approval_id: "ap-1", decision: "approved" }),
      ev("tool.result", { tool: "email:send_email", ok: true }),
      ev("task.finished", { status: "succeeded" }),
    ]),
  );

  const step = trace.root.children[0]!;
  const approval = step.children.find((s) => s.type === "approval")!;
  assert.equal(approval.name, "email:send_email — approved");
  assert.equal(approval.status, "ok");
  assert.equal(approval.duration_ms, 100, "how long a human took to answer");
  assert.equal(
    (approval.preview as Record<string, unknown>).api_key,
    "[redacted]",
    "the trace view runs the same redaction as the approval card",
  );
  const sent = step.children.find((s) => s.type === "tool")!;
  assert.equal(sent.name, "email:send_email");
  assert.equal(sent.status, "ok");
  assert.equal(trace.totals.tool_calls, 1);
});

test("traces: GET /v1/tasks/:id/trace serves a real run, and is scoped like every other task read", async () => {
  const { app } = makeApp();
  const created = await api(app, "tasks", {
    method: "POST",
    body: JSON.stringify({ wedge: "books-keeper", task_type: "daily_sync", input: { message: "hi" } }),
  });
  assert.equal(created.status, 201);
  const id = created.json.id;
  await waitTask(app, id);

  const res = await api(app, `tasks/${id}/trace`);
  assert.equal(res.status, 200);
  assert.equal(res.json.task_id, id);
  assert.equal(res.json.root.status, "ok");
  assert.ok(res.json.event_count > 0);
  assert.ok(res.json.root.children.length > 0, "the mock runtime emits a step and a tool call");

  const unknown = await api(app, "tasks/does-not-exist/trace");
  assert.equal(unknown.status, 404);
  const noKey = await api(app, `tasks/${id}/trace`, {}, "wrong-key");
  assert.equal(noKey.status, 401);
});
