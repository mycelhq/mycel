// Mounting connections as REAL TOOLS, via a kernel-authored MCP server that holds no credential.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHAT OPENCODE 1.17.6 ACTUALLY DOES — measured against the pinned binary, not the docs
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// plugin.ts used to claim, in a comment, that its gate "gates MCP tools". That was an assertion
// about a binary nobody had asked. So it was asked. Everything below was produced by running the
// exact build `sandbox.snapshot.ts` pins (OPENCODE_VERSION = 1.17.6, fetched from the npm platform
// tarball, the same artefact the image build installs):
//
//   1. MCP IS SUPPORTED. `opencode --help` lists `opencode mcp  manage MCP (Model Context Protocol)
//      servers`, with `add | list | auth | logout | debug` beneath it.
//
//   2. THE CONFIG KEY IS `mcp`, top level, alongside `provider` and `plugin`. `opencode debug
//      config` echoes it back verbatim, so the resolver accepts it — which is the only definition
//      of "supported" that matters here, since `buildOpencodeConfig` writes that file.
//
//   3. TWO ENTRY SHAPES, taken from the binary's own `mcp add` handler:
//         { "type": "local",  "command": ["node", "…"], "environment": {…}, "enabled": true }
//         { "type": "remote", "url": "https://…",       "headers": {…},     "enabled": true }
//      `opencode mcp list` reported `✓ mycelprobe connected` against a hand-written stdio server.
//
//   4. MCP TOOLS ARE NAMED `<serverName>_<toolName>` when they reach the model. Proven by pointing
//      opencode at a stub OpenAI-compatible endpoint and recording the tools array it sent:
//         ["bash","edit","glob","grep","mycelprobe_list_rows","mycelprobe_send_invoice",
//          "read","skill","task","todowrite","webfetch","write"]
//      Note also what is NOT there: `GET /experimental/tool/ids` returns only the fourteen built-ins
//      and never mentions MCP tools, so that endpoint — which plugin.ts and harness.ts both cite —
//      cannot be used to enumerate the real tool surface. It is a list of built-ins, not of tools.
//
//   5. THE APPROVAL GATE STILL FIRES ON MCP TOOLS. With the shipped `MYCEL_PLUGIN_CODE` loaded and
//      `MYCEL_GATE_PATTERNS=send,email,pay`, the stub model called `mycelprobe_send_invoice`; the
//      gate URL received
//         {"task_id":"probe","action":"mycelprobe_send_invoice","risk":"high",
//          "preview":{"tool":"mycelprobe_send_invoice","args":{"amount":5}}}
//      and the denial blocked execution: `✗ mycelprobe_send_invoice {"amount":5} failed`. So
//      `tool.execute.before` covers MCP tools by name, exactly as the old comment guessed — now
//      with a receipt.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THE BRIDGE IS LOCAL AND OURS, AND NOT COMPOSIO'S REMOTE MCP URL
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// Composio publishes remote MCP endpoints, and `{"type":"remote","url":…}` would mount one in three
// lines. It is forbidden here, and this is the single most important paragraph in the file.
//
// A Composio MCP URL authenticates the caller — the credential is in the URL or in `headers`. Both
// of those live in `~/.config/opencode/opencode.json`, INSIDE the sandbox, on a filesystem the
// agent can `read` and whose shell it may hold. That is a provider credential in the sandbox, which
// is the one thing this whole architecture exists to prevent (see the header of composio.ts, and
// proxygrants.ts, and actiongrants.ts — all three are the same idea applied three times). Mounting
// a remote MCP server would undo every one of them at once, quietly, in a config file.
//
// So the MCP server is a LOCAL stdio process, written by the kernel into the sandbox, and it holds
// exactly one secret-shaped thing: the run's action NONCE, which it already has in
// `MYCEL_ACTION_TOKEN` and which is worthless outside this run and this project's connections. Every
// `tools/call` becomes an HTTP POST back to `/v1/internal/actions/<slug>` or
// `/v1/internal/reads/<slug>` — the same two endpoints the `curl` instructions already used, with
// the same grant check, the same tenant boundary, the same human approval gate, and the same
// bounded result. Nonce in, kernel executes, result out. The bridge is a nicer front door onto the
// existing one, not a second door.
//
// (Verified as an aside, since it would otherwise be the obvious alternative: a `remote` MCP URL
// pointed at 127.0.0.1 is NOT rejected by opencode's SSRF-ish hostname guard — `opencode mcp list`
// reported a connection failure, not a policy refusal. A loopback HTTP bridge would therefore also
// work. Stdio was still chosen: no port to allocate, no port to collide, nothing listening inside
// the sandbox for the agent's own shell to talk to.)
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THE PLUGIN GATE IS EXEMPTED FOR THESE TOOLS, AND WHY THAT IS NOT A HOLE
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// Evidence item 5 above is a problem as well as a reassurance. `mycel_act_xero_XERO_CREATE_INVOICE`
// contains no default pattern, but `mycel_act_gmail_GMAIL_SEND_EMAIL` contains both "send" and
// "email" — so a mounted write tool would hit the plugin gate, suspend the task, wait for a human,
// and then, once approved, execute the bridge call which reaches the action proxy and suspends the
// task AGAIN for a second human approval of the same action. Two cards for one invoice is not twice
// the safety; it is the fastest known way to teach a founder to approve without reading, which
// destroys the value of the gate we actually rely on.
//
// So bridge tools carry a prefix that the plugin skips, and the AUTHORITATIVE gate for them is the
// action proxy: server-side, with a real rendered preview (`actionPreview`), the wedge policy
// envelope, the platform guard, and the audit row. That is a strictly stronger gate than a
// substring match on a tool name.
//
// Three things keep the exemption from becoming the "we believed we had a gate" failure:
//   · The prefix is `mycel_`, and MCP server names are chosen HERE, by the kernel. Nothing the
//     agent or a wedge can name reaches it.
//   · The exemption applies to a name shape that ONLY the bridge produces, and every bridge tool
//     routes to an endpoint that gates. There is no bridge tool that both skips the plugin and
//     skips the proxy — `toolRoute` below has exactly two branches, and the read branch is the
//     same declared-read allowlist `/v1/internal/reads` already enforces (`isReadTool`).
//   · A non-Mycel MCP server, should one ever be mounted, is NOT exempt and is gated by name
//     exactly as evidence item 5 showed. The test suite asserts both halves.
import type { ConnectionTools } from "./composio.tools";

/**
 * The MCP server name, which becomes the prefix of every mounted tool (`<server>_<tool>`).
 *
 * Short and ours. It is also the gate exemption prefix, so it must not be configurable: a wedge
 * that could name the server could name it "gmail" and inherit the exemption for a server we did
 * not write.
 */
export const MCP_SERVER_NAME = "mycel";

/** What the plugin skips. Assembled from the server name so the two cannot drift apart. */
export const GATE_EXEMPT_PREFIX = `${MCP_SERVER_NAME}_`;

/** Where the bridge's tool manifest is written inside the sandbox. Contains ids and schemas only. */
export const BRIDGE_MANIFEST_PATH = "~/.config/opencode/mycel-mcp-tools.json";
export const BRIDGE_SCRIPT_PATH = "~/.config/opencode/mycel-mcp-bridge.mjs";
/** Absolute forms — the sandbox's HOME is /root (see sandbox.snapshot.ts) and MCP spawns with no shell. */
const BRIDGE_MANIFEST_ABS = "/root/.config/opencode/mycel-mcp-tools.json";
const BRIDGE_SCRIPT_ABS = "/root/.config/opencode/mycel-mcp-bridge.mjs";

export interface BridgeTool {
  /** The MCP tool name, WITHOUT the server prefix opencode adds. */
  name: string;
  description: string;
  /** JSON Schema for the arguments, rebuilt from the compacted spec. */
  inputSchema: Record<string, unknown>;
  /** Which harness endpoint this tool posts to. `read` is ungated; `action` passes the human gate. */
  route: "action" | "read";
  connection_id: string;
  /** The Composio tool slug, i.e. the `<capability>` path segment. */
  slug: string;
}

export interface BridgeManifest {
  tools: BridgeTool[];
}

/**
 * MCP tool names must be stable, unique across connections, and legal.
 *
 * Two connections to the SAME toolkit are ordinary — a founder's Gmail and a client's Gmail — and
 * both publish `GMAIL_SEND_EMAIL`. Keying on the slug alone would silently collapse them into one
 * tool pointing at whichever connection was mounted last, which is a cross-connection mix-up in a
 * codebase that has already had a cross-tenant one. The connection name is therefore in the tool
 * name, and the connection ID is in the manifest entry that the bridge actually dispatches on — the
 * name is for the model, the id is for the routing.
 */
export function bridgeToolName(route: "action" | "read", connectionName: string, slug: string): string {
  const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const base = `${route === "read" ? "read" : "act"}_${clean(connectionName)}_${clean(slug)}`;
  // MCP implementations and provider tool-name validators cap length (OpenAI's is 64, and opencode
  // prepends `mycel_` on top of whatever we return). Clip the middle rather than the end: the slug
  // is the part that identifies the capability and must survive.
  return base.length <= 56 ? base : `${base.slice(0, 28)}_${base.slice(-27)}`;
}

/**
 * Turn the selected tool context into a bridge manifest.
 *
 * Reuses `selectToolContext`'s output on purpose: the tools the agent is TOLD about and the tools it
 * can CALL are then the same set, by construction. They were allowed to differ once — the prompt
 * described the action proxy generically while the agent had no list at all — and the result was an
 * agent guessing slugs. A mounted tool the prompt never mentions is the same bug facing the other
 * way.
 */
export function buildBridgeManifest(groups: ConnectionTools[]): BridgeManifest {
  const tools: BridgeTool[] = [];
  const seen = new Set<string>();
  for (const g of groups) {
    for (const t of g.tools) {
      const route: "action" | "read" = t.read ? "read" : "action";
      let name = bridgeToolName(route, g.connection_name, t.slug);
      // Names must be unique within the server or the later one shadows the earlier one and a call
      // lands on the wrong connection. Suffix rather than drop: dropping loses a capability.
      let n = 2;
      while (seen.has(name)) name = `${bridgeToolName(route, g.connection_name, t.slug).slice(0, 52)}_${n++}`;
      seen.add(name);

      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const p of t.params) {
        properties[p.name] = {
          // MCP clients validate against this, so an unknown type must be permissive rather than
          // wrong: a tool the agent cannot call because we guessed "string" is worse than one whose
          // schema is vague.
          ...(p.type === "any" || p.type.includes("|") ? {} : { type: jsonType(p.type) }),
          ...(p.note ? { description: p.note } : {}),
        };
        if (p.required) required.push(p.name);
      }
      const detail = [
        t.summary,
        route === "read" ? "Read-only; runs immediately." : "Side effect; a human approves before it runs.",
        t.returns.length ? `Returns: ${t.returns.join(", ")}.` : "",
        t.dropped_params ? `(${t.dropped_params} further optional argument(s) are accepted but not listed.)` : "",
      ]
        .filter(Boolean)
        .join(" ");

      tools.push({
        name,
        description: detail,
        inputSchema: {
          type: "object",
          properties,
          ...(required.length ? { required } : {}),
          // Composio accepts arguments we did not list (see `dropped_params`), and a closed schema
          // would make the client reject them before the kernel ever sees them.
          additionalProperties: true,
        },
        route,
        connection_id: g.connection_id,
        slug: t.slug,
      });
    }
  }
  return { tools };
}

function jsonType(t: string): string {
  if (t.endsWith("[]")) return "array";
  if (t === "enum") return "string";
  return t;
}

/**
 * The `mcp` block for opencode.json, or undefined when there is nothing to mount.
 *
 * `environment` carries the NONCE and the two proxy URLs and nothing else. Worth being explicit
 * about why the nonce is safe here while a Composio key would not be: the nonce is minted per run,
 * TTL'd, revoked when the run ends, and authorises exactly the connections `selectGrantableConnections`
 * allowed — it is a capability handle, not a credential. It is already in the sandbox's process
 * environment for the `curl` path; this puts the same value in the same sandbox.
 */
export function buildMcpConfig(
  manifest: BridgeManifest,
  env: { actionsUrl: string; readsUrl: string; token: string },
): Record<string, unknown> | undefined {
  if (manifest.tools.length === 0) return undefined;
  return {
    [MCP_SERVER_NAME]: {
      type: "local",
      // Absolute paths: MCP servers are spawned as a bare process, so `~` is not expanded and the
      // cwd is not guaranteed to be HOME. A relative path here produced a server that silently
      // failed to start and a run with no tools and no error.
      command: ["node", BRIDGE_SCRIPT_ABS],
      environment: {
        MYCEL_MCP_MANIFEST: BRIDGE_MANIFEST_ABS,
        MYCEL_ACTIONS_URL: env.actionsUrl,
        MYCEL_READS_URL: env.readsUrl,
        MYCEL_ACTION_TOKEN: env.token,
      },
      enabled: true,
    },
  };
}

/**
 * The bridge itself, written verbatim into the sandbox.
 *
 * Plain Node, no dependencies: the sandbox image (sandbox.snapshot.ts) has node and nothing from
 * npm, and adding an install step to the image build to get an MCP SDK would be a new way for the
 * image build to fail for a protocol that is a hundred lines of JSON-RPC over stdio.
 *
 * It speaks the subset that matters: `initialize`, `tools/list`, `tools/call`, plus `ping` and the
 * `notifications/initialized` no-op. Anything else gets a proper JSON-RPC method-not-found rather
 * than silence, because a bridge that stops answering makes opencode hang at session start and the
 * failure surfaces as "opencode did not become ready", which points at entirely the wrong thing.
 */
export const MYCEL_MCP_BRIDGE_CODE = `#!/usr/bin/env node
// Mycel MCP bridge (auto-generated). Holds a per-run NONCE, never a provider credential.
// Every tools/call becomes an authenticated POST to the harness, which resolves the connection,
// runs the human approval gate, executes, and bounds the result.
import { readFileSync } from "node:fs";

const MANIFEST = JSON.parse(readFileSync(process.env.MYCEL_MCP_MANIFEST, "utf8"));
const TOKEN = process.env.MYCEL_ACTION_TOKEN || "";
const URLS = { action: process.env.MYCEL_ACTIONS_URL || "", read: process.env.MYCEL_READS_URL || "" };
const BY_NAME = new Map(MANIFEST.tools.map((t) => [t.name, t]));

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (line.trim()) handle(line);
  }
});

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\\n");
}
function reply(id, result) {
  if (id !== undefined && id !== null) send({ jsonrpc: "2.0", id, result });
}
function fail(id, code, message) {
  if (id !== undefined && id !== null) send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handle(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  try {
    if (method === "initialize") {
      return reply(id, {
        protocolVersion: (params && params.protocolVersion) || "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "mycel", version: "1" },
      });
    }
    if (method === "notifications/initialized" || method === "initialized") return;
    if (method === "ping") return reply(id, {});
    if (method === "tools/list") {
      return reply(id, {
        tools: MANIFEST.tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });
    }
    if (method === "tools/call") return await callTool(id, params || {});
    // Explicit, so an unimplemented method is a protocol error and not a hang. See the note above.
    return fail(id, -32601, "method not found: " + method);
  } catch (e) {
    fail(id, -32603, String((e && e.message) || e));
  }
}

async function callTool(id, params) {
  const tool = BY_NAME.get(params.name);
  // The manifest is the whole authorisation surface the bridge has any say over, and it says no by
  // default. A tool name the kernel did not mount cannot be turned into a URL path here.
  if (!tool) return fail(id, -32602, "unknown tool: " + params.name);
  const base = URLS[tool.route];
  if (!base) return fail(id, -32603, "this run has no " + tool.route + " proxy");

  const body = { connection_id: tool.connection_id };
  const args = params.arguments || {};
  if (tool.route === "read") {
    // The reads proxy takes path/query at the top level for HTTP-shaped connections; a Composio
    // read takes arguments. Send both shapes: the server reads whichever its executor needs.
    Object.assign(body, args);
    body.arguments = args;
  } else {
    body.arguments = args;
  }

  let out;
  try {
    const res = await fetch(base + "/" + encodeURIComponent(tool.slug), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + TOKEN },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    try { out = JSON.parse(text); } catch { out = { ok: res.ok, detail: text.slice(0, 2000) }; }
  } catch (e) {
    out = { ok: false, detail: "could not reach the harness: " + String((e && e.message) || e) };
  }

  // isError makes the model TREAT a refusal as a failure instead of as data. An approval that was
  // rejected used to come back as a cheerful 200 with ok:false, and agents would carry on as though
  // the thing had happened.
  const isError = out && out.ok === false;
  return reply(id, {
    content: [{ type: "text", text: JSON.stringify(out) }],
    isError: !!isError,
  });
}
`;
