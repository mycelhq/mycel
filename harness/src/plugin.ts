// The Mycel OpenCode plugin. It is written INTO the sandbox and referenced by opencode.json's
// `plugin` array. On every tool call, the `tool.execute.before` hook checks whether the action
// is gated; if so, it calls back to the harness (/v1/internal/gate), which suspends the task and
// waits for a human. Deny -> the tool is blocked. This is the approval-gate
// pattern. The exact hook name/signature follows @opencode-ai/plugin; confirm against the
// installed version when wiring a real sandbox.
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
