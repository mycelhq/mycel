// Connections as real tools: schema context (B), MCP mounting (A), bounded results (C).
//
// Every test here names the bug it prevents. Three of them are about things that used to be
// asserted in a COMMENT rather than in a test — the plugin's claim that it "gates MCP tools" being
// the one that started this work.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __clearToolCatalogue,
  __setToolCatalogue,
  DEFAULT_TOOL_LIMITS,
  compactTool,
  relevance,
  renderToolContext,
  selectToolContext,
  taskQuery,
  type ConnectionToolRequest,
} from "../src/composio.tools";
import { boundData, boundResult } from "../src/toolresult";
import {
  BRIDGE_MANIFEST_PATH,
  GATE_EXEMPT_PREFIX,
  MCP_SERVER_NAME,
  MYCEL_MCP_BRIDGE_CODE,
  buildBridgeManifest,
  buildMcpConfig,
} from "../src/mcpbridge";
import { MYCEL_PLUGIN_CODE } from "../src/plugin";
import { buildOpencodeConfig } from "../src/opencode";
import { buildAgentsMdForTest } from "../src/runtime";
import type { ComposioConfig, ToolSummary } from "../src/composio";
import type { Task } from "../src/contract";

const CFG: ComposioConfig = { apiKey: "unused-in-these-tests", baseUrl: "http://127.0.0.1:1" };

const tool = (slug: string, description: string, props: Record<string, unknown> = {}, required: string[] = []): ToolSummary => ({
  slug,
  name: slug,
  description,
  input_parameters: { type: "object", properties: props, required },
  output_parameters: { type: "object", properties: { data: {}, invoiceID: { type: "string" }, total: { type: "number" } } },
});

const req = (over: Partial<ConnectionToolRequest> = {}): ConnectionToolRequest => ({
  connection_id: "conn_1",
  connection_name: "Xero",
  toolkit: "xero",
  read_tools: [],
  named_tools: [],
  ...over,
});

// ── B. tool context ───────────────────────────────────────────────────────────────────────────

test("the agent is given real tool SLUGS, not just a connection name — the guessed-slug bug", async () => {
  // THE BUG: AGENTS.md said `- **Xero** (composio) — id conn_1` and told the agent to POST to
  // $MYCEL_ACTIONS_URL/<capability>. `<capability>` IS the Composio tool slug, and nothing ever
  // said what the slugs were. The agent guessed `create_invoice`, the proxy rejected it, and the
  // run reported it could not invoice a customer through a fully authorised Xero connection.
  __clearToolCatalogue();
  __setToolCatalogue("xero", [
    tool("XERO_CREATE_INVOICE", "Create a draft invoice", { amount: { type: "number" }, contactID: { type: "string" } }, ["contactID"]),
  ]);
  const groups = await selectToolContext(CFG, [req({ named_tools: ["XERO_CREATE_INVOICE"] })], new Set());
  const md = renderToolContext(groups).join("\n");
  assert.match(md, /XERO_CREATE_INVOICE/, "the exact slug must appear in the prompt");
  assert.match(md, /`contactID`: string \*\*\(required\)\*\*/, "required arguments must be named and marked");
  assert.match(md, /returns: `invoiceID`/, "the id the next step needs must be documented");
});

test("a tool sharing no word with the task is EXCLUDED, not ranked last — prompt budget", async () => {
  // THE BUG this prevents: "fill the remaining budget with the best-scoring tools" pads a prompt
  // with whatever is left when nothing matches. A `decide` run whose whole budget is a few thousand
  // tokens then spends them on eight irrelevant schemas, and the task itself gets crowded out.
  // Score must be STRICTLY positive to be included.
  __clearToolCatalogue();
  __setToolCatalogue("xero", [
    tool("XERO_CREATE_INVOICE", "Create a draft invoice"),
    tool("XERO_ARCHIVE_TRACKING_CATEGORY", "Archive a tracking category"),
  ]);
  const groups = await selectToolContext(CFG, [req()], taskQuery({ type: "invoice_chase" }));
  assert.equal(groups.length, 1);
  assert.deepEqual(
    groups[0].tools.map((t) => t.slug),
    ["XERO_CREATE_INVOICE"],
    "only the tool the task's own words point at",
  );
  assert.equal(groups[0].omitted, 1, "the agent is told tools exist that it was not shown");
});

test("declared tools survive even when the scorer would drop them, and even when Composio has no schema", async () => {
  // THE BUG: a founder puts XERO_GET_INVOICES on the connection's read allowlist, the relevance
  // scorer does not like it for this task, and it silently vanishes from the prompt — so the agent
  // uses the gated write path for something the founder deliberately made an ungated read. And a
  // MISSPELLED declared slug must be visible, or a broken read allowlist rots invisibly.
  __clearToolCatalogue();
  __setToolCatalogue("xero", [tool("XERO_GET_INVOICES", "List invoices")]);
  const groups = await selectToolContext(
    CFG,
    [req({ read_tools: ["XERO_GET_INVOICES", "XERO_TYPOED_SLUG"] })],
    taskQuery({ type: "unrelated_thing" }),
  );
  const slugs = groups[0].tools.map((t) => t.slug);
  assert.deepEqual(slugs, ["XERO_GET_INVOICES", "XERO_TYPOED_SLUG"]);
  assert.equal(groups[0].tools[0].read, true, "a declared read must be marked ungated");
  assert.match(groups[0].tools[1].summary, /no schema/i, "a slug Composio does not publish is surfaced, not hidden");
});

test("caps hold per connection AND overall — six connected apps must not mean a six-times prompt", async () => {
  // THE BUG: per-connection caps alone. A business that connects Gmail, Xero, HubSpot, Sheets,
  // Slack and Stripe would assemble 48 schemas and blow the context on a task that needed one app.
  __clearToolCatalogue();
  const many = (prefix: string) =>
    Array.from({ length: 40 }, (_, i) => tool(`${prefix}_INVOICE_ACTION_${i}`, "invoice thing"));
  for (const t of ["a", "b", "c", "d"]) __setToolCatalogue(t, many(t.toUpperCase()));
  const groups = await selectToolContext(
    CFG,
    ["a", "b", "c", "d"].map((t, i) => req({ connection_id: `c${i}`, connection_name: t, toolkit: t })),
    taskQuery({ type: "invoice" }),
    { ...DEFAULT_TOOL_LIMITS, perConnection: 8, total: 20 },
  );
  const total = groups.reduce((n, g) => n + g.tools.length, 0);
  assert.equal(total, 20, "the overall cap is the binding one");
  for (const g of groups) assert.ok(g.tools.length <= 8, `${g.toolkit} exceeded the per-connection cap`);
});

test("schemas are TRUNCATED: required arguments first, optional ones counted, nesting not expanded", () => {
  // THE BUG: recursing into a provider schema. One Gmail send descends through attachments,
  // headers and MIME parts into several hundred lines. Also: if the parameter cap bites, the
  // arguments that survive must be the REQUIRED ones, or the agent gets a call it cannot make.
  const props: Record<string, unknown> = { zzz_required: { type: "string" } };
  for (let i = 0; i < 20; i++) props[`opt_${i}`] = { type: "string", description: "x".repeat(500) };
  props.attachments = { type: "object", properties: { parts: { type: "object", properties: { body: {} } } } };
  const c = compactTool(tool("GMAIL_SEND_EMAIL", "Send an email", props, ["zzz_required"]), {
    read: false,
    declared: true,
  });
  assert.equal(c.params[0].name, "zzz_required", "required first");
  assert.equal(c.params.length, DEFAULT_TOOL_LIMITS.params);
  assert.ok(c.dropped_params > 0, "the agent must be told the list is partial");
  assert.ok(c.params.every((p) => (p.note ?? "").length <= DEFAULT_TOOL_LIMITS.paramChars));
  const rendered = renderToolContext([
    { connection_id: "c", connection_name: "Gmail", toolkit: "gmail", tools: [c], omitted: 0 },
  ]).join("\n");
  assert.ok(!rendered.includes("body"), "nested schema must not be expanded into the prompt");
});

test("the toolkit's own name is not a relevance signal", () => {
  // THE BUG: leaving "gmail" in the query made every tool in the Gmail toolkit score at least one
  // point, so the ranking collapsed to alphabetical order and the selection was effectively random.
  const q = taskQuery({ type: "send reply", wedge: "inbox" });
  assert.ok(relevance(tool("GMAIL_SEND_EMAIL", "Send a reply"), q) > 0);
  assert.equal(relevance(tool("GMAIL_LIST_LABELS", "List labels"), q), 0);
});

// ── A. MCP mounting ───────────────────────────────────────────────────────────────────────────

test("the mcp block matches the shape OpenCode 1.17.6 actually accepts", () => {
  // Asserted against the config the pinned binary echoed back from `opencode debug config` and
  // connected with `opencode mcp list` (see mcpbridge.ts for the transcript). THE BUG this
  // prevents is writing a plausible-looking config the binary ignores, which produces a run with
  // no tools and no error anywhere.
  const manifest = buildBridgeManifest([
    {
      connection_id: "conn_1",
      connection_name: "Xero",
      toolkit: "xero",
      tools: [compactTool(tool("XERO_CREATE_INVOICE", "Create an invoice"), { read: false, declared: true })],
      omitted: 0,
    },
  ]);
  const mcp = buildMcpConfig(manifest, { actionsUrl: "https://k/v1/internal/actions", readsUrl: "https://k/v1/internal/reads", token: "NONCE" })!;
  const server = mcp[MCP_SERVER_NAME] as Record<string, any>;
  assert.equal(server.type, "local");
  assert.ok(Array.isArray(server.command) && server.command[0] === "node");
  assert.ok(server.command[1].startsWith("/"), "MCP servers spawn with no shell — `~` is not expanded");
  assert.equal(server.enabled, true);
  assert.equal(server.environment.MYCEL_ACTION_TOKEN, "NONCE");
});

test("NO PROVIDER CREDENTIAL reaches the sandbox through the mcp config", () => {
  // THE BUG this exists to make impossible: mounting Composio's own remote MCP endpoint. That is
  // three lines and it puts an authenticating URL/header — a real credential — into
  // ~/.config/opencode/opencode.json, on a filesystem the agent can read. The bridge is local and
  // carries a per-run NONCE instead.
  const manifest = buildBridgeManifest([
    {
      connection_id: "conn_1",
      connection_name: "Xero",
      toolkit: "xero",
      tools: [compactTool(tool("XERO_CREATE_INVOICE", "Create an invoice"), { read: false, declared: true })],
      omitted: 0,
    },
  ]);
  const built = buildOpencodeConfig(
    "openai/gpt",
    { proxyBaseUrl: "https://k/v1/internal/llm", nonce: "PROXY_NONCE", modelId: "gpt" },
    undefined,
    buildMcpConfig(manifest, { actionsUrl: "https://k/a", readsUrl: "https://k/r", token: "ACTION_NONCE" }),
  );
  const json = JSON.stringify(built.config);
  assert.match(json, /"mcp"/, "the mcp block must reach opencode.json");
  assert.ok(!/composio/i.test(json), "no composio endpoint or key may appear in the sandbox config");
  assert.ok(!/"type":\s*"remote"/.test(json), "a remote MCP server would carry its credential into the sandbox");
  assert.equal(built.providerEnv.OPENAI_API_KEY, undefined, "proxy mode still ships no provider key");
});

test("two connections to the same toolkit get DISTINCT tool names", () => {
  // THE BUG: keying the mounted tool on the slug alone. A founder's Gmail and a client's Gmail both
  // publish GMAIL_SEND_EMAIL; one name for both means every send lands on whichever connection was
  // mounted last. This codebase has had a cross-tenant leak; this is the same shape.
  const g = (id: string, name: string) => ({
    connection_id: id,
    connection_name: name,
    toolkit: "gmail",
    tools: [compactTool(tool("GMAIL_SEND_EMAIL", "Send"), { read: false, declared: true })],
    omitted: 0,
  });
  const manifest = buildBridgeManifest([g("conn_founder", "Founder Mail"), g("conn_client", "Acme Mail")]);
  assert.equal(new Set(manifest.tools.map((t) => t.name)).size, 2);
  assert.deepEqual(manifest.tools.map((t) => t.connection_id), ["conn_founder", "conn_client"]);
});

test("mounted tools route to the gated proxy for writes and the read proxy for declared reads", () => {
  // THE BUG: a mounted tool that reaches a provider directly. Every bridge tool must land on one of
  // the two existing endpoints, both of which re-check the grant; the read branch is exactly the
  // declared allowlist /v1/internal/reads already enforces.
  const manifest = buildBridgeManifest([
    {
      connection_id: "conn_1",
      connection_name: "Xero",
      toolkit: "xero",
      tools: [
        compactTool(tool("XERO_CREATE_INVOICE", "Create"), { read: false, declared: true }),
        compactTool(tool("XERO_GET_INVOICES", "List"), { read: true, declared: true }),
      ],
      omitted: 0,
    },
  ]);
  assert.deepEqual(manifest.tools.map((t) => t.route), ["action", "read"]);
  assert.ok(manifest.tools.every((t) => t.connection_id === "conn_1"));
  // The bridge dispatches on the manifest and nothing else — no tool name it did not mount can be
  // turned into a URL path.
  assert.match(MYCEL_MCP_BRIDGE_CODE, /if \(!tool\) return fail\(id, -32602, "unknown tool/);
});

// ── the approval gate, against the REAL shipped plugin ────────────────────────────────────────

/**
 * Load the actual `MYCEL_PLUGIN_CODE` string as a module and run its hook.
 *
 * Deliberately not a re-implementation of `isGated` in the test. The plugin ships as SOURCE that is
 * written into the sandbox; a test that reasons about a copy of its logic would keep passing after
 * the shipped string drifted, which is precisely the "we believed we had a gate" failure.
 */
async function loadGate(env: Record<string, string>, n: number) {
  const dir = await mkdtemp(join(tmpdir(), "mycel-gate-"));
  const file = join(dir, `plugin-${n}.mjs`);
  await writeFile(file, MYCEL_PLUGIN_CODE);
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  const mod = await import(`file://${file}`);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const hooks = await mod.default();
  return hooks["tool.execute.before"];
}

test("the approval gate STILL FIRES on an MCP-shaped tool name", async () => {
  // The comment in plugin.ts claimed this for months without anyone asking the binary. It is now
  // measured end to end against opencode 1.17.6 (transcript in mcpbridge.ts) AND asserted here
  // against the shipped plugin source. THE BUG: mounting tools under a new naming scheme and
  // silently losing the gate — which is worse than having no gate, because we would believe we had
  // one. MCP tools arrive as `<serverName>_<toolName>`.
  const seen: any[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_u: any, init: any) => {
    seen.push(JSON.parse(init.body));
    return { json: async () => ({ allow: false, decision: "denied" }) } as any;
  }) as any;
  try {
    const hook = await loadGate(
      { MYCEL_GATE_URL: "http://gate", MYCEL_GATE_PATTERNS: "send,email,pay", MYCEL_GATE_EXEMPT: "", MYCEL_TASK_ID: "t1" },
      1,
    );
    await assert.rejects(
      () => hook({ tool: "mycelprobe_send_invoice", sessionID: "s", callID: "c" }, { args: { amount: 5 } }),
      /was not approved/,
    );
    assert.equal(seen[0].action, "mycelprobe_send_invoice");
    assert.deepEqual(seen[0].preview.args, { amount: 5 });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the kernel's own bridge tools are exempt by PREFIX only — and a lookalike name is not", async () => {
  // Two bugs at once.
  //   (1) Without the exemption, `mycel_act_gmail_gmail_send_email` gates HERE on the name and then
  //       again at the action proxy on the action: two approval cards for one email, which teaches
  //       a founder to click through without reading.
  //   (2) If the exemption were a SUBSTRING test, a third-party tool called `gmail_mycel_send`
  //       would inherit it and become ungated. Prefix, and only prefix.
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_u: any, init: any) => {
    calls.push(JSON.parse(init.body).action);
    return { json: async () => ({ allow: false, decision: "denied" }) } as any;
  }) as any;
  try {
    const hook = await loadGate(
      { MYCEL_GATE_URL: "http://gate", MYCEL_GATE_PATTERNS: "send,email", MYCEL_GATE_EXEMPT: GATE_EXEMPT_PREFIX, MYCEL_TASK_ID: "t1" },
      2,
    );
    await hook({ tool: "mycel_act_gmail_gmail_send_email" }, { args: {} }); // exempt: no throw, no call
    assert.deepEqual(calls, [], "an exempt tool must not reach the gate at all");
    await assert.rejects(() => hook({ tool: "gmail_mycel_send" }, { args: {} }), /was not approved/);
    assert.deepEqual(calls, ["gmail_mycel_send"], "a lookalike must still be gated");
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ── C. bounded results ────────────────────────────────────────────────────────────────────────

test("a 10,000-row query is headed and COUNTED, never pasted into a model context", () => {
  // THE BUG: `return c.json({data: result.data})`. A HubSpot search or a Sheets range read answers
  // with thousands of rows, straight into a curl body, straight into the next model call — one
  // call exceeding the whole token budget of a decide run, AFTER the side effect happened.
  const rows = Array.from({ length: 10_000 }, (_, i) => ({ id: `c_${i}`, email: `p${i}@x.co` }));
  const b = boundData(rows);
  assert.equal(b.truncated, true);
  const d = b.data as any;
  assert.equal(d.total, 10_000, "the agent must learn the real size");
  assert.ok(d.shown <= 20);
  assert.ok(JSON.stringify(b.data).length <= 8 * 1024);
  assert.match(b.note!, /only the first/i);
});

test("truncation is ANNOUNCED, so the agent cannot report a partial answer as the whole one", () => {
  // THE BUG: silent truncation. An agent handed 20 of 4,312 invoices with no note will write "you
  // have 20 overdue invoices" — a confident, checkable, wrong statement sent to a customer.
  const r = boundResult({ ok: true, detail: "ok", data: Array.from({ length: 500 }, (_, i) => ({ id: i })) });
  assert.equal(r.truncated, true);
  assert.ok(r.note && r.note.length > 0);
});

test("when a result is too big to show, the IDENTIFIERS are what survive", () => {
  // THE BUG: dropping an oversized object whole. `[dropped]` is small and useless; `{"id":"INV-204"}`
  // is small and is the entire reason the agent made the call.
  const fat = { id: "INV-204", status: "AUTHORISED", body: "x".repeat(200_000), notes: "y".repeat(200_000) };
  const b = boundData(fat, { bytes: 512 });
  const json = JSON.stringify(b.data);
  assert.match(json, /INV-204/, "the id must survive the clipping");
  assert.equal(b.truncated, true);
  assert.ok(json.length <= 2048);
});

test("a small, useful result passes through untouched — bounding must not damage the common case", () => {
  // THE BUG the caps could easily introduce: mangling the 95% case to protect against the 5%.
  const r = boundResult({ ok: true, detail: "ok", data: { invoiceID: "abc-123", total: 240 } });
  assert.deepEqual(r.data, { invoiceID: "abc-123", total: 240 });
  assert.equal(r.truncated, undefined);
  assert.equal(r.note, undefined);
});

test("a non-serialisable provider response does not throw inside the action response", () => {
  // THE BUG: a circular object reaching `c.json` and turning a completed side effect into a 500,
  // so the agent believes the action failed and retries something that already happened.
  const circular: any = { id: "x" };
  circular.self = circular;
  const b = boundData(circular, { depth: 100 });
  assert.equal(b.truncated, true);
});

// ── the prompt actually carries it ────────────────────────────────────────────────────────────

test("AGENTS.md carries the slugs, the arguments and the truncation warning", () => {
  // THE BUG: building all of the above and never wiring it into the prompt the agent reads.
  const task: Task = {
    id: "t1",
    wedge: "bookkeeping",
    task_type: "invoice_chase",
    actor: { kind: "system", id: "s" },
    input: {},
    constraints: { max_runtime_s: 300, max_cost_usd: 1 },
    tools: [],
    status: "running",
    cost_usd: 0,
    created_at: new Date().toISOString(),
  } as Task;
  const md = buildAgentsMdForTest(
    task,
    null,
    [{ id: "conn_1", kind: "composio", name: "Xero", owner: { kind: "founder", id: "founder" }, config: {}, created_at: "" }],
    undefined,
    undefined,
    undefined,
    [
      {
        connection_id: "conn_1",
        connection_name: "Xero",
        toolkit: "xero",
        tools: [compactTool(tool("XERO_CREATE_INVOICE", "Create an invoice", { contactID: { type: "string" } }, ["contactID"]), { read: false, declared: true })],
        omitted: 3,
      },
    ],
  );
  assert.match(md, /XERO_CREATE_INVOICE/);
  assert.match(md, /contactID/);
  assert.match(md, /truncated/, "the agent must be warned that results are bounded");
  assert.match(md, /3 further `xero` tool\(s\) exist/, "the agent must know the list is partial");
  assert.match(md, new RegExp(`${MCP_SERVER_NAME}_`), "the native-tool prefix must be explained");
  assert.ok(BRIDGE_MANIFEST_PATH.endsWith(".json"));
});
