import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "../src/contract";

// tracing.ts had no test coverage at all — the only kernel module in that state, and the one whose
// failure mode is silence rather than an error.

const task = (over: Partial<Task> = {}): Task =>
  ({
    id: "11111111-1111-4111-8111-111111111111",
    project_id: "proj-abc",
    wedge: "books-keeper",
    task_type: "daily_sync",
    status: "queued",
    input: { message: "go" },
    actor: { kind: "system", id: "scheduler" },
    constraints: {},
    cost_usd: 0,
    created_at: new Date().toISOString(),
    ...over,
  }) as Task;

test("tracing: a trace carries the tenancy key, so per-project filtering is possible", async () => {
  // The cloud design is one shared Langfuse project with traces tagged per tenant (creating a
  // project per customer needs Enterprise Edition). Without project_id on the trace there is
  // nothing to segment by, and every tenant's traces are indistinguishable.
  const captured: Record<string, unknown>[] = [];
  const fakeLangfuse = {
    trace(args: Record<string, unknown>) {
      captured.push(args);
      return { event() {}, update() {} };
    },
    async flushAsync() {},
  };

  const { _langfuseObserverForTest } = await import("../src/tracing");
  const obs = _langfuseObserverForTest(fakeLangfuse);
  await obs.onTaskStart(task({ case_id: "case-9" }));

  const t = captured[0];
  const tags = t.tags as string[];
  assert.ok(tags.includes("project:proj-abc"), `tags must carry the project: ${JSON.stringify(tags)}`);
  assert.ok(tags.includes("wedge:books-keeper"));
  assert.ok(tags.includes("case:case-9"));
  assert.equal((t.metadata as { project_id: string }).project_id, "proj-abc");
});

test("tracing: every task gets a local JSONL log, whether or not Langfuse is configured", async () => {
  // The always-on sink. Langfuse is optional; losing the record of what an agent did is not.
  const dir = mkdtempSync(join(tmpdir(), "mycel-trace-"));
  const { _localObserverForTest, flushLogs } = await import("../src/tracing");
  const obs = _localObserverForTest(dir);
  const t = task();
  await obs.onTaskStart(t);
  await obs.onEvent(t.id, { type: "tool.called", data: { tool: "read" }, ts: new Date().toISOString(), seq: 1 });
  await obs.onEvent(t.id, { type: "task.finished", data: { status: "succeeded" }, ts: new Date().toISOString(), seq: 2 });
  await obs.onTaskEnd(t.id, "succeeded");

  // Appends are non-blocking by design, so the test has to drain them — the same drain the SIGTERM
  // path now awaits, which is why it exists as real API rather than a test hook.
  await flushLogs();

  const files = readdirSync(dir);
  assert.ok(files.includes(`${t.id}.jsonl`), `expected a log for the task, got ${files.join(",")}`);
  const lines = readFileSync(join(dir, `${t.id}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 2, "one line per event, in order");
  assert.equal(lines[0].type, "tool.called");
  assert.equal(lines[1].type, "task.finished");
});
