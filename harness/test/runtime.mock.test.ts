// Mock ship_page must not author a vertical. The mock is a schema walk; the agent writes the page.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Task } from "../src/contract";
import { runMockTask } from "../src/runtime.mock";
import type { RuntimeCtx } from "../src/runtime";
import { looksLikeHtmlPage, shippedPageFaults } from "../src/pages";

const ctx: RuntimeCtx = {
  emit: async () => {},
  shouldAbort: () => null,
  onCost: () => {},
};

test("mock ship_page is a schema sample, not a canned jeweler or dentist page", async () => {
  const task: Task = {
    id: "t-ship",
    wedge: "geo-monitor",
    task_type: "ship_page",
    actor: { kind: "system", id: "test" },
    input: {
      client: "Atelier Vane",
      recommendation: { what: "lab-grown diamond engagement ring cost in Seattle" },
    },
    constraints: { max_runtime_s: 30, max_cost_usd: 1, approval_required: false },
    tools: [],
    status: "queued",
    cost_usd: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const { text } = await runMockTask(task, ctx);
  const out = JSON.parse(text) as { html?: string };
  const html = typeof out.html === "string" ? out.html : text;
  assert.match(html, /\[mock\]/);
  assert.equal(looksLikeHtmlPage(html), false);
  assert.ok(shippedPageFaults(html).length > 0);
});
