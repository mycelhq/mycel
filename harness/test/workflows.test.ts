import { test } from "node:test";
import assert from "node:assert/strict";
import { runWorkflow, validWorkflowName } from "../src/workflows";
import { api, makeApp } from "./helpers";
import { registerActionGrant } from "../src/actiongrants";

test("workflow names are constrained (no path traversal into the filesystem)", () => {
  assert.ok(validWorkflowName("reconcile"));
  assert.ok(validWorkflowName("next_step"));
  for (const bad of ["../../etc/passwd", "a/b", "x.mjs", "", "a b", "a;rm -rf", null, 7]) {
    assert.equal(validWorkflowName(bad as unknown), false, `should reject: ${String(bad)}`);
  }
});

test("workflows: only declared names run, args and output are validated", async () => {
  // undeclared name
  const undeclared = await runWorkflow("books-keeper", "not_declared", {});
  assert.equal(undeclared.ok, false);
  assert.match(undeclared.error!, /does not declare/);

  // declared, but args fail the input schema
  const badArgs = await runWorkflow("books-keeper", "reconcile", { bank_transactions: [] }); // ledger missing
  assert.equal(badArgs.ok, false);
  assert.match(badArgs.error!, /invalid args/);

  // a wedge with no workflows declares nothing
  const none = await runWorkflow("product-builder", "reconcile", {});
  assert.equal(none.ok, false);
});

test("workflows: the reconciliation math is exact, to the cent", async () => {
  // $1,200.00 in, $45.00 out, both matched by reference. Sales tax is tax-inclusive at 20%:
  // 120000 × 20 / 120 = 20000 cents on sales only, so the refund never reduces the tax due.
  const rows = [
    { amount_cents: 120_000, reference: "INV-1", date: "2026-10-01", counterparty: "Acme" },
    { amount_cents: -4_500, reference: "REF-1", date: "2026-10-02", counterparty: "Courier" },
  ];
  const r = await runWorkflow("books-keeper", "reconcile", { bank_transactions: rows, ledger_entries: rows, sales_tax_rate_pct: 20 });
  assert.equal(r.ok, true, r.error);
  const d = r.data as Record<string, number | boolean | string[]>;
  assert.equal(d.reconciled, true);
  assert.equal(d.difference_cents, 0, "balanced to the cent, not to the dollar");
  assert.equal(d.gross_sales_cents, 120_000);
  assert.equal(d.sales_tax_due_cents, 20_000, "tax-inclusive sales tax, computed on sales only");
  assert.deepEqual(d.anomalies, []);

  // deterministic: same inputs, same numbers
  const again = await runWorkflow("books-keeper", "reconcile", { bank_transactions: rows, ledger_entries: rows, sales_tax_rate_pct: 20 });
  assert.deepEqual(again.data, r.data);

  // a bank row the ledger has never seen is exactly what a human must look at
  const short = await runWorkflow("books-keeper", "reconcile", { bank_transactions: rows, ledger_entries: [rows[0]] });
  const s = short.data as Record<string, number | boolean | string[]>;
  assert.equal(s.reconciled, false);
  assert.equal(s.difference_cents, -4_500, "the gap is reported signed, not as an absolute");
  assert.deepEqual(s.unmatched_bank, ["REF-1"]);
  assert.ok((s.anomalies as string[]).some((a) => a.includes("REF-1")), "and it is surfaced, not buried");
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
  // A fractional penny is not a rounding problem, it is a corrupt input — reconcile refuses it
  // rather than silently producing books that are out by a bit.
  const r = await runWorkflow("books-keeper", "reconcile", {
    bank_transactions: [{ amount_cents: 1200.5, date: "2026-10-01" }],
    ledger_entries: [],
  });
  assert.equal(r.ok, false);
  assert.match(r.error!, /integer cents/);
});

test("workflows: the agent calls them by name over the internal endpoint, traced", async () => {
  const { store, app } = makeApp();
  const kase = (await api(app, "cases", { method: "POST", body: JSON.stringify({ wedge: "books-keeper", title: "wf" }) })).json;
  const task = (await api(app, `cases/${kase.id}/tasks`, { method: "POST", body: JSON.stringify({ task_type: "monthly_close" }) })).json;
  const nonce = await registerActionGrant({ task_id: task.id, connectionIds: [], caseId: kase.id });
  const H = { authorization: `Bearer ${nonce}`, "content-type": "application/json" };

  const res = await app.request("/v1/internal/workflows/reconcile", {
    method: "POST",
    headers: H,
    body: JSON.stringify({
      bank_transactions: [{ amount_cents: 200_000, reference: "A", date: "2026-10-01" }],
      ledger_entries: [{ amount_cents: 200_000, reference: "A", date: "2026-10-01" }],
    }),
  });
  const out = await res.json();
  assert.equal(out.ok, true);
  assert.ok(typeof out.data.sales_tax_due_cents === "number");

  // traced onto the timeline so the founder sees which computation ran on what inputs
  const events = await store.eventsAfter(task.id, 0);
  assert.ok(events.some((e) => e.type === "tool.called" && (e.data as { tool: string }).tool === "workflow:reconcile"));
  assert.ok(events.some((e) => e.type === "tool.result" && (e.data as { ok: boolean }).ok === true));

  // unauthenticated callers get nothing
  assert.equal((await app.request("/v1/internal/workflows/reconcile", { method: "POST", headers: { authorization: "Bearer nope" }, body: "{}" })).status, 401);
});
