// The gate that ran on 37% of the product.
//
// `inferChecks` exists because "hand-writing a bar per service does not scale past the services we
// personally wrote, which is the opposite of the product" — and it was wired into exactly one path:
// the GENERATED wedge. The wedges we personally wrote were left holding a hand-written bar, and 31
// of 49 client-facing task types never got one. `invoice-chaser/chase_invoice` was one of them,
// which is why `[amount]` and `[payment link]` left it and scored below bar on a real-key run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { effectiveShipContract } from "../src/infer-checks";

const wedge = (d: string) => JSON.parse(readFileSync(new URL(`../../wedges/${d}/wedge.json`, import.meta.url).pathname, "utf8"));

test("the wedge that shipped the placeholders is gated now", () => {
  const tt = wedge("invoice-chaser").task_types.chase_invoice;
  assert.equal(tt.ship_checks ?? null, null, "fixture drifted — this wedge is supposed to declare none");
  const c = effectiveShipContract(tt);
  assert.ok(
    c.ship_checks.some((x) => x.kind === "forbids" && "field" in x && x.field === "message" && x.vocabulary === "placeholder"),
    "chase_invoice still has no placeholder gate on `message`",
  );
});

test("every client-facing prose field a client reads is gated, in every wedge", () => {
  const ungated: string[] = [];
  for (const d of readdirSync(new URL("../../wedges/", import.meta.url).pathname)) {
    let w: { task_types?: Record<string, Record<string, unknown>> };
    try { w = wedge(d); } catch { continue; }
    for (const [name, tt] of Object.entries(w.task_types ?? {})) {
      const schema = tt.output_schema as { properties?: Record<string, { type?: string; enum?: unknown }> } | undefined;
      if (!schema?.properties || tt.internal === true) continue;
      const prose = Object.entries(schema.properties).filter(
        ([k, v]) => v?.type === "string" && !v.enum && /(summary|note|body|message|covering|narrative|report)/.test(k.toLowerCase()),
      );
      if (!prose.length) continue;
      const checks = effectiveShipContract(tt).ship_checks;
      for (const [field] of prose) {
        const gated = checks.some((c) => c.kind === "forbids" && "field" in c && c.field === field && c.vocabulary === "placeholder");
        if (!gated) ungated.push(`${d}/${name}.${field}`);
      }
    }
  }
  assert.deepEqual(ungated, [], `prose a client reads, graded against nothing:\n  ${ungated.join("\n  ")}`);
});

test("a declared bar is never overruled — this fills holes, it does not take decisions back", () => {
  const declared = {
    output_schema: { type: "object", properties: { message: { type: "string" } } },
    ship_checks: [{ kind: "min_words", field: "message", n: 5 }],
  };
  const c = effectiveShipContract(declared);
  const mins = c.ship_checks.filter((x) => x.kind === "min_words" && "field" in x && x.field === "message");
  assert.equal(mins.length, 1, "inference added a second min_words beside the author's");
  assert.equal((mins[0] as { n: number }).n, 5, "inference overwrote the author's own bar");
});

test("an internal step is not held to a client-facing bar", () => {
  // Applying prose rules to a routing decision is how a gate earns a reputation for getting in the
  // way, and a gate with that reputation gets switched off.
  const c = effectiveShipContract({
    internal: true,
    output_schema: { type: "object", properties: { summary: { type: "string" } } },
  });
  assert.deepEqual(c.ship_checks, []);
});
