import { test } from "node:test";
import assert from "node:assert/strict";
import { runWorkflow, validWorkflowName } from "../src/workflows";
import { api, makeApp } from "./helpers";
import { registerActionGrant } from "../src/actiongrants";

test("workflow names are constrained (no path traversal into the filesystem)", () => {
  assert.ok(validWorkflowName("yields"));
  assert.ok(validWorkflowName("next_step"));
  for (const bad of ["../../etc/passwd", "a/b", "x.mjs", "", "a b", "a;rm -rf", null, 7]) {
    assert.equal(validWorkflowName(bad as unknown), false, `should reject: ${String(bad)}`);
  }
});

test("workflows: only declared names run, args and output are validated", async () => {
  // undeclared name
  const undeclared = await runWorkflow("property-sourcer", "not_declared", {});
  assert.equal(undeclared.ok, false);
  assert.match(undeclared.error!, /does not declare/);

  // declared, but args fail the input schema
  const badArgs = await runWorkflow("property-sourcer", "yields", { price_gbp: 150000 }); // rent missing
  assert.equal(badArgs.ok, false);
  assert.match(badArgs.error!, /invalid args/);

  // a wedge with no workflows declares nothing
  const none = await runWorkflow("enrollment-operator", "yields", {});
  assert.equal(none.ok, false);
});

test("workflows: the yield math is exact and matches the wedge's own example report", async () => {
  // knowledge/example-report.md: £150,000 @ £995/mo → gross 7.96%, net 5.89%, just under the 6% box
  const r = await runWorkflow("property-sourcer", "yields", { price_gbp: 150_000, monthly_rent_gbp: 995 });
  assert.equal(r.ok, true, r.error);
  const d = r.data as Record<string, number | boolean | null>;
  assert.equal(d.gross_yield_pct, 7.96);
  assert.equal(d.net_yield_pct, 5.89);
  assert.equal(d.clears_box, false);
  assert.equal(d.price_to_clear_box_gbp, 147_100, "tells the sourcer what to offer to clear the box");

  // deterministic: same inputs, same numbers
  const again = await runWorkflow("property-sourcer", "yields", { price_gbp: 150_000, monthly_rent_gbp: 995 });
  assert.deepEqual(again.data, r.data);

  // a flat carries service charge + ground rent, so its net yield must be lower
  const flat = await runWorkflow("property-sourcer", "yields", {
    price_gbp: 150_000, monthly_rent_gbp: 995, property_type: "flat", service_charge_gbp: 1200, ground_rent_gbp: 250,
  });
  assert.ok((flat.data as { net_yield_pct: number }).net_yield_pct < d.net_yield_pct!);
});

test("workflows: the dunning ladder is policy, not vibes", async () => {
  const step = async (args: Record<string, unknown>) =>
    ((await runWorkflow("invoice-chaser", "next_step", args)).data as { step: string; escalate: boolean });

  assert.equal((await step({ days_overdue: 0 })).step, "hold");
  assert.equal((await step({ days_overdue: 3 })).step, "reminder");
  assert.equal((await step({ days_overdue: 14 })).step, "firm_reminder");
  assert.equal((await step({ days_overdue: 30 })).step, "final_notice");
  // a dispute is a human problem, never a chase
  const disputed = await step({ days_overdue: 60, disputed: true });
  assert.equal(disputed.step, "hold");
  assert.equal(disputed.escalate, true);
  // a live promise pauses the ladder
  assert.equal((await step({ days_overdue: 30, promised_payment_date: "2026-12-01", today: "2026-11-20" })).step, "hold");
  // and we never chase twice inside 48h
  assert.equal((await step({ days_overdue: 30, last_chased_days_ago: 1 })).step, "hold");
  // long-overdue escalates to a human
  assert.equal((await step({ days_overdue: 90 })).escalate, true);
});

test("workflows: a throwing workflow fails loudly instead of returning junk", async () => {
  const r = await runWorkflow("property-sourcer", "yields", { price_gbp: -5, monthly_rent_gbp: 100 });
  assert.equal(r.ok, false);
  assert.match(r.error!, /positive number/);
});

test("workflows: the agent calls them by name over the internal endpoint, traced", async () => {
  const { store, app } = makeApp();
  const kase = (await api(app, "cases", { method: "POST", body: JSON.stringify({ wedge: "property-sourcer", title: "wf" }) })).json;
  const task = (await api(app, `cases/${kase.id}/tasks`, { method: "POST", body: JSON.stringify({ task_type: "source_property" }) })).json;
  const nonce = await registerActionGrant({ task_id: task.id, connectionIds: [], caseId: kase.id });
  const H = { authorization: `Bearer ${nonce}`, "content-type": "application/json" };

  const res = await app.request("/v1/internal/workflows/yields", {
    method: "POST", headers: H, body: JSON.stringify({ price_gbp: 200_000, monthly_rent_gbp: 1400 }),
  });
  const out = await res.json();
  assert.equal(out.ok, true);
  assert.ok(typeof out.data.net_yield_pct === "number");

  // traced onto the timeline so the founder sees which computation ran on what inputs
  const events = await store.eventsAfter(task.id, 0);
  assert.ok(events.some((e) => e.type === "tool.called" && (e.data as { tool: string }).tool === "workflow:yields"));
  assert.ok(events.some((e) => e.type === "tool.result" && (e.data as { ok: boolean }).ok === true));

  // unauthenticated callers get nothing
  assert.equal((await app.request("/v1/internal/workflows/yields", { method: "POST", headers: { authorization: "Bearer nope" }, body: "{}" })).status, 401);
});
