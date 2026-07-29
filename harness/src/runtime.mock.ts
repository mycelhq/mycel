// Mock runtime — streams canned contract events and returns a schema-conforming result, with no
// sandbox, no OpenCode, no provider key. Selected by MYCEL_RUNTIME=mock. Lets anyone run the
// kernel end-to-end out of the box (demos), and powers the test suite. It honors cancel/runtime
// aborts so the abort paths are exercised too.
import type { Task } from "./contract";
import type { RuntimeCtx } from "./runtime";
import { loadWedge } from "./wedge";

export async function runMockTask(task: Task, ctx: RuntimeCtx): Promise<{ text: string }> {
  const wedge = loadWedge(task.wedge);
  await ctx.emit("step.started", { step: "mock_runtime" });
  await ctx.emit("progress", { note: "mock runtime — no sandbox, canned result" });

  const message = typeof task.input?.message === "string" ? task.input.message : "";
  const reply =
    `[mock] handled "${task.task_type}" for wedge "${task.wedge}"` +
    (message ? ` — re: ${message.slice(0, 60)}` : "");

  // fake token streaming (abortable)
  for (const tok of reply.split(" ")) {
    const reason = ctx.shouldAbort();
    if (reason) throw new Error(`aborted: ${reason}`);
    await ctx.emit("token.delta", { text: tok + " " });
    await new Promise((r) => setTimeout(r, 2));
  }
  await ctx.emit("tool.called", { tool: "mock.tool", args: {} });
  await ctx.emit("tool.result", { tool: "mock.tool", ok: true });
  ctx.onCost(0.0001);

  // produce output conforming to the wedge/task output_schema (so output.validated passes)
  const schema = (wedge?.manifest.task_types?.[task.task_type]?.output_schema ?? task.output_schema) as
    | { type?: string; properties?: Record<string, { type?: string; enum?: unknown[] }>; required?: string[] }
    | undefined;
  if (schema && typeof schema === "object" && schema.type === "object") {
    const obj: Record<string, unknown> = {};
    for (const [k, spec] of Object.entries(schema.properties ?? {})) {
      // Respect `enum` — otherwise the mock emits output its own wedge's schema rejects, and the
      // validator (correctly) fails the task.
      obj[k] = Array.isArray(spec.enum) && spec.enum.length
        ? spec.enum[0]
        : spec.type === "number" || spec.type === "integer" ? 0
        : spec.type === "boolean" ? true
        : spec.type === "array" ? []
        : spec.type === "object" ? {}
        : reply;
    }
    return { text: JSON.stringify(obj) };
  }
  return { text: reply };
}
