// The OpenCode event stream, mapped onto Mycel contract events.
//
// This file exists because of a production run that spent 165,000 tokens and left FOUR events in
// the log — `task.created`, two `step.started`, one `progress` — and not one of them from the
// agent. No tokens, no tool calls, no cost, no output. The event log is the spine of the trace
// view, the cost ledger, the portal timeline and the audit trail, so an agent that works and
// records nothing is indistinguishable from one that does nothing.
//
// Two independent faults produced that:
//
//   1. The runtime awaited `POST /session/:id/message`, which is SYNCHRONOUS in 1.17.6 (its body is
//      the finished assistant message), and only THEN subscribed to /event. The whole run happened
//      with nobody listening.
//   2. The mapping named events that this version does not send — `message.part.delta`,
//      `message.info`, `message.completed` — and read tool parts through fields
//      (`toolName`, `result`, `invocation.input`) that do not exist.
//
// The fixtures below are shaped from `@opencode-ai/sdk@1.17.6`'s generated types, which come from
// the server's own OpenAPI document. They are the closest thing to a recording that can live in a
// test, and their whole job is to fail loudly the next time the protocol moves.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import type { EventType, TaskEvent } from "../src/contract";
import { OpenCodeClient, OpenCodeEventMapper, type MycelEmission, type OpenCodeEvent } from "../src/opencode";
import { chargeUsageForTest } from "../src/runtime";
import { buildTrace } from "../src/traces";

const SID = "ses_real";

/** An assistant message as `message.updated` publishes it: cumulative totals, republished often. */
function assistantMessage(over: Record<string, unknown> = {}) {
  return {
    id: "msg_1",
    sessionID: SID,
    role: "assistant",
    parentID: "msg_0",
    mode: "build",
    modelID: "gpt-5.6-luna",
    providerID: "mycel",
    path: { cwd: "/home/daytona", root: "/home/daytona" },
    time: { created: 1_700_000_000 },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    ...over,
  };
}

function toolPart(state: Record<string, unknown>) {
  return {
    id: "prt_tool",
    sessionID: SID,
    messageID: "msg_1",
    type: "tool",
    callID: "call_1",
    tool: "bash",
    state,
  };
}

/** A whole run, in the order 1.17.6 publishes it. */
const RUN: OpenCodeEvent[] = [
  { type: "server.connected", properties: {} },
  { type: "session.status", properties: { sessionID: SID, status: { type: "busy" } } },
  { type: "message.updated", properties: { info: assistantMessage() } },
  {
    type: "message.part.updated",
    properties: { part: { id: "prt_s", sessionID: SID, messageID: "msg_1", type: "step-start" } },
  },
  // Reasoning streams exactly like text: a `delta` string SIBLING to the part, never a
  // `message.part.delta` event of its own.
  {
    type: "message.part.updated",
    properties: {
      part: { id: "prt_r", sessionID: SID, messageID: "msg_1", type: "reasoning", text: "Check", time: { start: 1 } },
      delta: "Check",
    },
  },
  // A tool call, through its real lifecycle. `pending` carries a half-parsed `raw` and an EMPTY
  // input — announcing then is how you record every tool call in the system with no arguments.
  {
    type: "message.part.updated",
    properties: { part: toolPart({ status: "pending", input: {}, raw: '{"comm' }) },
  },
  {
    type: "message.part.updated",
    properties: {
      part: toolPart({ status: "running", input: { command: "ls" }, title: "ls", time: { start: 1000 } }),
    },
  },
  {
    type: "message.part.updated",
    properties: {
      part: toolPart({
        status: "completed",
        input: { command: "ls" },
        output: "AGENTS.md\nknowledge",
        title: "ls",
        metadata: {},
        time: { start: 1000, end: 1200 },
      }),
    },
  },
  // Another session's traffic, which must not land on this task's timeline.
  {
    type: "message.part.updated",
    properties: {
      part: { id: "x", sessionID: "ses_other", messageID: "m", type: "text", text: "not ours" },
      delta: "not ours",
    },
  },
  {
    type: "message.part.updated",
    properties: {
      part: { id: "prt_t", sessionID: SID, messageID: "msg_1", type: "text", text: "All" },
      delta: "All",
    },
  },
  {
    type: "message.part.updated",
    properties: {
      part: { id: "prt_t", sessionID: SID, messageID: "msg_1", type: "text", text: "All done." },
      delta: " done.",
    },
  },
  {
    type: "message.updated",
    properties: {
      info: assistantMessage({
        cost: 0.0123,
        tokens: { input: 1200, output: 340, reasoning: 64, cache: { read: 900, write: 100 } },
        time: { created: 1_700_000_000, completed: 1_700_000_009 },
        finish: "stop",
      }),
    },
  },
  // Republished with the SAME cumulative totals — must not be charged twice.
  {
    type: "message.updated",
    properties: {
      info: assistantMessage({
        cost: 0.0123,
        tokens: { input: 1200, output: 340, reasoning: 64, cache: { read: 900, write: 100 } },
      }),
    },
  },
  { type: "session.idle", properties: { sessionID: SID } },
];

/** Drive the mapper the way runtime.ts does, and collect everything it produced. */
function drive(events: OpenCodeEvent[], sessionId = SID) {
  const mapper = new OpenCodeEventMapper(sessionId);
  const emissions: MycelEmission[] = [];
  const charges: { usd: number; meta: Record<string, unknown> }[] = [];
  let done = false;
  let error: string | undefined;
  for (const ev of events) {
    if (mapper.foreign(ev)) continue;
    const m = mapper.map(ev);
    emissions.push(...m.emissions);
    if (m.usage) {
      chargeUsageForTest(
        {
          emit: () => {},
          shouldAbort: () => null,
          onCost: (usd, meta) => charges.push({ usd, meta: (meta ?? {}) as Record<string, unknown> }),
        },
        "openai/gpt-5.6-luna",
        "standard",
        m.usage,
      );
    }
    if (m.error) error = m.error;
    if (m.done) {
      done = true;
      break;
    }
  }
  return { mapper, emissions, charges, done, error };
}

test("opencode: a realistic 1.17.6 stream produces the full Mycel event sequence", () => {
  const { mapper, emissions, charges, done } = drive(RUN);

  assert.equal(done, true, "session.idle ends the turn — there is no message.completed in 1.17.6");
  assert.equal(mapper.finalText, "All done.", "the answer is the LAST text part, not the last delta");

  // The sequence a trace needs, in order. Before this fix the log for this stream was EMPTY.
  assert.deepEqual(
    emissions.map((e) => e.type),
    ["token.delta", "tool.called", "tool.result", "token.delta", "token.delta"] satisfies EventType[],
  );

  const called = emissions.find((e) => e.type === "tool.called")!;
  assert.equal(called.data.tool, "bash", "the field is `tool`, never `toolName`");
  assert.deepEqual(called.data.args, { command: "ls" }, "args come from state.input, and NOT from the pending state");
  assert.equal(called.data.call_id, "call_1");

  const result = emissions.find((e) => e.type === "tool.result")!;
  assert.equal(result.data.ok, true, "completion is state.status, not the presence of a `result` field");
  assert.equal(result.data.call_id, "call_1", "the same callID pairs the two halves");
  assert.equal(result.data.duration_ms, 200);

  // Deltas ride on message.part.updated. Reasoning is tagged so a trace can tell it from the answer.
  const deltas = emissions.filter((e) => e.type === "token.delta");
  assert.deepEqual(
    deltas.map((d) => [d.data.kind, d.data.text]),
    [
      ["reasoning", "Check"],
      ["text", "All"],
      ["text", " done."],
    ],
  );

  // Charged once, from the one message that actually moved.
  assert.equal(charges.length, 1, "cumulative totals republished must not be billed again");
  assert.equal(charges[0].usd, 0.0123, "OpenCode's own cost wins when it has a price table");
  assert.equal(charges[0].meta.model, "openai/gpt-5.6-luna");
  assert.deepEqual(charges[0].meta.tokens, {
    input: 1200,
    output: 340,
    reasoning: 64,
    cache_read: 900,
    cache_write: 100,
  });

  assert.deepEqual(mapper.unmapped, {}, "every event in a normal run is accounted for");
});

test("opencode: the mapper is not fooled by another session's events", () => {
  const { emissions } = drive(RUN);
  assert.equal(
    emissions.some((e) => e.data.text === "not ours"),
    false,
  );
});

test("opencode: an idle published before the run starts does not end it", () => {
  // The stream is now opened BEFORE the prompt, so this window exists. Acting on an idle from it
  // would finish every task with an empty answer and a successful status.
  const { done } = drive([{ type: "session.idle", properties: { sessionID: SID } }]);
  assert.equal(done, false);
});

test("opencode: an unrecognised event is COUNTED, never silently dropped", () => {
  const { mapper, emissions } = drive([
    { type: "session.status", properties: { sessionID: SID, status: { type: "busy" } } },
    { type: "message.thinking.delta", properties: { sessionID: SID, delta: "hm" } },
    { type: "message.thinking.delta", properties: { sessionID: SID, delta: "mm" } },
    { type: "agent.handoff", properties: { sessionID: SID, to: "reviewer" } },
    // Known-but-uninteresting events must NOT inflate the counter, or every run looks broken.
    { type: "file.watcher.updated", properties: { file: "a.ts", event: "change" } },
    { type: "lsp.updated", properties: {} },
  ]);
  assert.deepEqual(mapper.unmapped, { "message.thinking.delta": 2, "agent.handoff": 1 });
  assert.equal(emissions.length, 0);
});

test("opencode: the unmapped counter is bounded — a drifting stream cannot exhaust memory", () => {
  const noise: OpenCodeEvent[] = Array.from({ length: 500 }, (_, i) => ({
    type: `mystery.${i}`,
    properties: { sessionID: SID },
  }));
  const { mapper } = drive(noise);
  assert.ok(Object.keys(mapper.unmapped).length <= 32, "distinct types are capped");
});

test("opencode: token counts survive onto the charge instead of collapsing into dollars", () => {
  // The proxy-mode case: the sandbox talks to a custom `mycel` provider with no price table, so
  // OpenCode reports cost 0 and OUR table is the only number. It must still say so.
  const charges: { usd: number; meta: Record<string, unknown> }[] = [];
  chargeUsageForTest(
    {
      emit: () => {},
      shouldAbort: () => null,
      onCost: (usd, meta) => charges.push({ usd, meta: (meta ?? {}) as Record<string, unknown> }),
    },
    "openai/gpt-5.6-luna",
    "standard",
    { model: "mycel/gpt-5.6-luna", input: 1000, output: 500, reasoning: 0, cache_read: 0, cache_write: 0, cost_usd: 0 },
  );
  assert.equal(charges.length, 1);
  assert.ok(charges[0].usd > 0, "a run with a thousand input tokens is not free");
  assert.equal(charges[0].meta.reason, "model_estimated", "priced by our table, and said so");
  assert.equal(charges[0].meta.model, "openai/gpt-5.6-luna");
  assert.equal(charges[0].meta.tier, "standard");
  assert.deepEqual(charges[0].meta.tokens, {
    input: 1000,
    output: 500,
    reasoning: 0,
    cache_read: 0,
    cache_write: 0,
  });
});

test("opencode: a provider error on the message surfaces as a run failure", () => {
  const { error } = drive([
    { type: "session.status", properties: { sessionID: SID, status: { type: "busy" } } },
    {
      type: "message.updated",
      properties: {
        info: assistantMessage({ error: { name: "APIError", data: { message: "Invalid model name", statusCode: 400 } } }),
      },
    },
  ]);
  // The 400 that used to surface only as a run silently burning its whole runtime budget.
  assert.match(String(error), /APIError.*Invalid model name/);
});

test("opencode: the mapped events fold into a trace that can answer what the run did", () => {
  // The point of all of it. `buildTrace` is what the trace view and the portal timeline read.
  const { emissions, charges } = drive(RUN);
  const log: TaskEvent[] = [
    { type: "task.created", data: { wedge: "invoice-chaser", task_type: "chase" } },
    { type: "step.started", data: { step: "agent" } },
    ...emissions.map((e) => ({ type: e.type, data: e.data })),
    ...charges.map((c) => ({ type: "cost.charged" as EventType, data: { cost_usd: c.usd, ...c.meta } })),
    { type: "task.finished", data: { status: "succeeded" } },
  ].map((e, i) => ({
    id: i + 1,
    task_id: "tsk_1",
    seq: i + 1,
    type: e.type,
    ts: new Date(1_700_000_000_000 + i * 1000).toISOString(),
    data: e.data,
  }));

  const trace = buildTrace(log);
  assert.equal(trace.root.name, "invoice-chaser:chase");
  assert.equal(trace.totals.tool_calls, 1);
  assert.equal(trace.totals.token_deltas, 3);
  assert.equal(trace.totals.cost_usd, 0.0123);
  assert.equal(trace.totals.errors, 0);

  const step = trace.root.children.find((c) => c.name === "agent")!;
  const tool = step.children.find((c) => c.type === "tool")!;
  assert.equal(tool.name, "bash");
  assert.equal(tool.status, "ok", "the call and its result paired — before this fix neither existed");
  assert.deepEqual(tool.preview, { command: "ls" });
});

// ---- The ordering bug, which no fixture can catch ----

test("opencode: the event stream is connected BEFORE the prompt is accepted", async () => {
  // The mapping was only half the fault. `POST /session/:id/message` blocks for the whole turn, so
  // awaiting it and then subscribing meant subscribing to a session that had already finished.
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    if (req.url === "/event") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`);
      return; // held open, exactly as the real server holds it
    }
    req.resume();
    res.writeHead(204).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;

  try {
    const oc = new OpenCodeClient(`http://127.0.0.1:${port}`, { username: "opencode", password: "pw" });
    const ac = new AbortController();
    // `openEvents` must have completed the handshake by the time it RETURNS. An async generator
    // would not have: its body does not run until the first `next()`.
    const stream = await oc.openEvents(ac.signal);
    assert.deepEqual(seen, ["GET /event"]);

    await oc.startPrompt("ses_1", "hello", "mycel/gpt-5.6-luna");
    assert.deepEqual(
      seen,
      ["GET /event", "POST /session/ses_1/prompt_async"],
      "the prompt goes to prompt_async (204, returns immediately), never to the blocking /message",
    );

    const first = await stream.next();
    assert.equal((first.value as OpenCodeEvent).type, "server.connected");
    ac.abort();
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});

test("opencode: a build without prompt_async falls back to /message without deadlocking", async () => {
  const seen: string[] = [];
  let messageBody = "";
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    if (req.url?.endsWith("/prompt_async")) {
      req.resume();
      res.writeHead(404).end("not found");
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      messageBody = Buffer.concat(chunks).toString();
      // Deliberately slow: the fallback must NOT be awaited, or the caller can never read the
      // stream that carries the answer.
      setTimeout(() => res.writeHead(200, { "content-type": "application/json" }).end("{}"), 300);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;

  try {
    const oc = new OpenCodeClient(`http://127.0.0.1:${port}`, { username: "opencode", password: "pw" });
    const started = Date.now();
    await oc.startPrompt("ses_1", "hello", "mycel/gpt-5.6-luna");
    // It returns before the fallback request has even been ISSUED, which is the point.
    assert.ok(Date.now() - started < 250, "returned without waiting for the synchronous endpoint");
    await new Promise((r) => setTimeout(r, 500));
    assert.deepEqual(seen, ["POST /session/ses_1/prompt_async", "POST /session/ses_1/message"]);
    // The model reference is split — 1.17.6 answers a bare string with
    // `400 Expected object | null, got "mycel/..." at ["model"]`.
    assert.deepEqual(JSON.parse(messageBody).model, { providerID: "mycel", modelID: "gpt-5.6-luna" });
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});
