// The org-wide feed: GET /v1/events.
//
// Everything here is about the two properties the surface above it depends on — it must show every
// run in YOUR projects without being asked which one, and it must never show anyone else's. The
// stream never ends by design, so each test reads frames until it has what it needs and then
// cancels, with a wall-clock ceiling so a regression fails the suite instead of hanging it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { api, makeApp, waitTask, KEY } from "./helpers";
import type { createServer } from "../src/server";

interface Frame {
  event: string;
  data: any;
}

/**
 * Read SSE frames until `stop` says so, or the deadline passes. Always cancels the body — a leaked
 * reader here keeps the poll interval alive and the test process never exits.
 */
async function frames(
  app: ReturnType<typeof createServer>,
  key: string,
  stop: (f: Frame[]) => boolean,
  timeoutMs = 6000,
): Promise<Frame[]> {
  const ctrl = new AbortController();
  const res = await app.request("/v1/events", {
    headers: { authorization: `Bearer ${key}`, accept: "text/event-stream" },
    signal: ctrl.signal,
  });
  assert.equal(res.status, 200);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const out: Frame[] = [];
  let buf = "";
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const read = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value?: undefined }>((r) =>
          setTimeout(() => r({ done: true }), Math.max(0, deadline - Date.now())),
        ),
      ]);
      if (read.done || !read.value) break;
      buf += decoder.decode(read.value, { stream: true });
      const chunks = buf.split("\n\n");
      buf = chunks.pop() ?? "";
      for (const chunk of chunks) {
        const event = /^event:\s*(.+)$/m.exec(chunk)?.[1]?.trim();
        const data = /^data:\s*(.*)$/m.exec(chunk)?.[1];
        if (!event) continue;
        let parsed: any;
        try {
          parsed = data ? JSON.parse(data) : undefined;
        } catch {
          parsed = data;
        }
        out.push({ event, data: parsed });
      }
      if (stop(out)) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
    ctrl.abort();
  }
  return out;
}

const NEW_TASK = JSON.stringify({
  wedge: "books-keeper",
  task_type: "daily_sync",
  input: { message: "hi" },
});

test("/v1/events streams every run in scope, without being told which run", async () => {
  const { app } = makeApp();

  // Connect first, then start work: this is the live path, not a replay.
  const collected = frames(app, KEY, (f) => f.some((x) => x.event === "task.finished"));
  await new Promise((r) => setTimeout(r, 50));
  const { json: task } = await api(app, "tasks", { method: "POST", body: NEW_TASK });
  await waitTask(app, task.id);

  const got = await collected;
  const types = got.map((f) => f.event);
  assert.ok(types.includes("ready"), "the stream announces itself before anything happens");
  assert.ok(types.includes("task.created"), `saw ${types.join(",")}`);
  assert.ok(types.includes("task.finished"));

  // Every frame carries the task it belongs to and what kind of work it was — the feed is mixed,
  // so a row with no run on it is a row nobody can act on.
  const created = got.find((f) => f.event === "task.created")!;
  assert.equal(created.data.task_id, task.id);
  assert.equal(created.data.wedge, "books-keeper");
  assert.equal(created.data.task_type, "daily_sync");

  // token.delta is the majority of all events and is meaningless outside its own run.
  assert.equal(types.filter((t) => t === "token.delta").length, 0);
});

test("/v1/events is scoped: another project's key sees nothing of yours", async () => {
  const { app } = makeApp();
  const login = await app.request("/v1/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: process.env.MYCEL_OWNER_EMAIL || "owner@test.co",
      password: process.env.MYCEL_OWNER_PASSWORD || "secret",
    }),
  });
  const tok = (await login.json()).token as string;
  const keyB = (await api(app, "projects", { method: "POST", body: JSON.stringify({ name: "project-b" }) }, tok))
    .json.api_key as string;

  // B watches while A works. Read for a fixed window rather than until a stop condition — the
  // assertion is about ABSENCE, so there is nothing to wait for.
  const watching = frames(app, keyB, () => false, 2500);
  await new Promise((r) => setTimeout(r, 50));
  const { json: task } = await api(app, "tasks", { method: "POST", body: NEW_TASK });
  await waitTask(app, task.id);

  const got = await watching;
  assert.deepEqual(
    got.filter((f) => f.event !== "ready" && f.event !== "ping").map((f) => f.data?.task_id),
    [],
    "a foreign project's events must never reach this stream",
  );
});

test("/v1/events requires a credential", async () => {
  const { app } = makeApp();
  assert.equal((await app.request("/v1/events")).status, 401);
});
