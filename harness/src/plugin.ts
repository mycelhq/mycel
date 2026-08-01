// The Mycel OpenCode plugin. It is written INTO the sandbox and referenced by opencode.json's
// `plugin` array. On every tool call, the `tool.execute.before` hook checks whether the action
// is gated; if so, it calls back to the harness (/v1/internal/gate), which suspends the task and
// waits for a human. Deny -> the tool is blocked. This is the approval-gate pattern.
//
// HOOK SIGNATURE — VERIFIED against @opencode-ai/plugin@1.17.6 (dist/index.d.ts, `interface Hooks`):
//
//   "tool.execute.before"?: (input: {tool, sessionID, callID}, output: {args}) => Promise<void>
//
// So the tool name is on INPUT and the arguments are on OUTPUT, which is what the code below reads.
// The `||` fallbacks are kept because they cost nothing and the two halves have swapped before.
// Also present at this pin, and unused here: `tool.execute.after` ({tool, sessionID, callID, args}
// -> {title, output, metadata}) and `shell.env`.
//
// WHAT THIS DOES AND DOES NOT GATE — read this before enabling a shell in a harness profile.
//
// `isGated()` below matches on the TOOL NAME, as a case-insensitive substring against the pattern
// list. OpenCode's real tool ids (verified against 1.17.6, GET /experimental/tool/ids) are:
// invalid, question, bash, read, glob, grep, edit, write, task, webfetch, todowrite, websearch,
// skill, apply_patch. None of those contains "send", "email", "pay", "charge" or any other default
// pattern. So in practice this plugin gates MCP tools and wedge-provided tools whose names happen
// to describe an action — and it gates NOTHING that opencode ships with.
//
// In particular `bash` matches nothing, and `bash` is how the agent reaches everything: the action
// proxy, the reads proxy, the case API, and the whole internet. A profile that enables the shell is
// therefore, at this layer, ungated by construction. Widening the pattern list would not fix it —
// the tool name is still "bash" whatever the command inside it is.
//
// The real boundary is the ACTION PROXY, and it is enforced by withholding a credential rather than
// by inspecting a name: `runtime.ts` mints MYCEL_ACTION_TOKEN only when the harness profile says
// `grants_actions`, and every side-effecting endpoint requires it. A `build` profile gets no token,
// so its shell can curl all it likes and reach nothing that belongs to the business. See
// SHAPE_DEFAULTS in harness.ts.
import type { Task } from "./contract";
import type { LoadedWedge } from "./wedge";

const DEFAULT_PATTERNS = [
  "send",
  "email",
  "message",
  "pay",
  "charge",
  "refund",
  "delete",
  "deploy",
  "book",
  "transfer",
];

/** Comma-separated patterns injected into the plugin via MYCEL_GATE_PATTERNS. */
export function buildGatePatterns(task: Task, wedge: LoadedWedge | null): string {
  const fromWedge = (wedge?.manifest.approvals ?? [])
    .filter((a) => a.required)
    .map((a) => a.action.toLowerCase());
  const set = new Set([...fromWedge, ...DEFAULT_PATTERNS]);
  return Array.from(set).join(",");
}

// The plugin source, written verbatim into the sandbox as mycel-plugin.ts.
export const MYCEL_PLUGIN_CODE = `
// Mycel approval-gate plugin (auto-generated). Blocks gated tool calls on human approval.
const GATE_URL = process.env.MYCEL_GATE_URL;
const TOKEN = process.env.MYCEL_GATE_TOKEN || "";
const TASK_ID = process.env.MYCEL_TASK_ID || "";
const PATTERNS = (process.env.MYCEL_GATE_PATTERNS || "")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

function isGated(name) {
  const n = String(name || "").toLowerCase();
  return PATTERNS.some((p) => n.includes(p));
}

export const MycelGate = async () => {
  return {
    "tool.execute.before": async (input, output) => {
      const name = (input && input.tool) || (output && output.tool) || "";
      if (!GATE_URL || !isGated(name)) return;
      const args = (output && output.args) || (input && input.args) || {};
      let res = { allow: false, decision: "error" };
      try {
        const r = await fetch(GATE_URL, {
          method: "POST",
          headers: { "content-type": "application/json", "x-mycel-gate-token": TOKEN },
          body: JSON.stringify({ task_id: TASK_ID, action: String(name), risk: "high", preview: { tool: name, args } }),
        });
        res = await r.json();
      } catch (e) {
        res = { allow: false, decision: "gate_unreachable" };
      }
      if (!res || !res.allow) {
        throw new Error('Mycel: action "' + name + '" was not approved (' + (res && res.decision) + '). Do not retry it.');
      }
    },
  };
};

export default MycelGate;
`;
