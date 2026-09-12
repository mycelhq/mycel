// The read side. No new table: public.tasks already records every client-facing action, so the
// budget is computed from the same rows that caused the touches and the two cannot drift.
import { test } from "node:test";
import assert from "node:assert/strict";
import { recentTouches, checkClientTouch, heldLine, TOUCH_TASK_TYPES } from "../src/client-touch.pg";

const NOW = 1_800_000_000_000;
const H = 60 * 60 * 1000;
const db = (rows: any[] = []) => {
  const seen: { sql: string; vals: any }[] = [];
  return {
    seen,
    query: async (sql: string, vals?: unknown[]) => {
      seen.push({ sql: sql.replace(/\s+/g, " ").trim(), vals });
      return { rows, rowCount: rows.length };
    },
  } as any;
};

test("THE QUERY FILTERS ON CLIENT, NEVER ON WEDGE", () => {
  // A per-wedge version would reproduce the exact blindness the budget exists to fix.
  const d = db();
  return recentTouches(d, "c1").then(() => {
    const q = d.seen[0].sql;
    assert.match(q, /WHERE t\.client_id = \$1/);
    assert.ok(!/wedge\s*=/.test(q), "must not narrow by wedge");
    assert.match(q, /interval '1 day'/);
  });
});

test("A RUN THAT NEVER TRIED TO REACH ANYONE IS NOT A TOUCH", () => {
  /**
   * MEASURED: 3,103 `monthly_close` runs in thirty days, exactly ONE of which attempted any
   * outbound action. `monthly_close` is a `report`, so all 3,103 counted against a budget of two
   * per day — Fairmont Dental hit 58 in a single day — and every `nudge_client_request` for those
   * clients was refused `day_full` for weeks. That is why 51 asks were raised and none chased.
   *
   * An approval row is the honest test of "we tried to reach them": nothing outbound happens in
   * this kernel without one. It does NOT weaken the stated rule that a touch counts even if its
   * send later failed — a run that never attempted one has no send to have failed.
   */
  const d = db();
  return recentTouches(d, "c1").then(() => {
    const q = d.seen[0].sql;
    assert.match(q, /EXISTS \(/, "the query counts every spawned run, including ones that contacted nobody");
    assert.match(q, /FROM public\.approvals a WHERE a\.task_id/, "the contact test is not an approval row");
    // Every status counts — a send that was queued and refused still costs the client a slot, or a
    // broken mailbox produces MORE attempts at them rather than fewer.
    assert.ok(!/a\.status/.test(q), "filtering by approval status reintroduces the retry storm");
  });
});

test("task rows become touches, and unmapped types are dropped", async () => {
  const rows = [
    { task_type: "chase_invoice", wedge: "invoice-chaser", created_at: new Date(NOW - H) },
    { task_type: "build_feature", wedge: "product-builder", created_at: new Date(NOW - 2 * H) },
    { task_type: "weekly_report", wedge: "geo-monitor", created_at: new Date(NOW - 3 * H) },
  ];
  const touches = await recentTouches(db(rows), "c1");
  assert.equal(touches.length, 2, "build_feature is not a client touch");
  assert.deepEqual(touches.map((t) => t.kind), ["invoice_chase", "report"]);
  assert.equal(touches[0]!.wedge, "invoice-chaser", "the wedge is carried for the explanation");
});

test("no client means no budget — internal work is never stalled", async () => {
  const d = db([]);
  const v = await checkClientTouch(d, { taskType: "ops_distribution_tick" }, NOW);
  assert.equal(v.allow, true);
  assert.equal(d.seen.length, 0, "and it does not even query");
});

test("the real decision: a second wedge is held after the first just touched", async () => {
  const rows = [{ task_type: "weekly_report", wedge: "geo-monitor", created_at: new Date(NOW - 20 * 60_000) }];
  const v = await checkClientTouch(db(rows), { taskType: "chase_invoice", clientId: "c1" }, NOW);
  assert.equal(v.allow, false);
  assert.equal(v.allow === false && v.reason, "too_soon");
});

test("a held touch produces a line a FOUNDER can read", async () => {
  // This is a decision the product made about their client. Deferring silently is
  // indistinguishable from a bug, and their first instinct will be that it is broken.
  const rows = [{ task_type: "weekly_report", wedge: "geo-monitor", created_at: new Date(NOW - 20 * 60_000) }];
  const v = await checkClientTouch(db(rows), { taskType: "chase_invoice", clientId: "c1" }, NOW);
  const line = heldLine("chase_invoice", "c1", v);
  assert.ok(line && line.includes("held chase_invoice"), line ?? "");
  assert.ok(line!.includes("retries after"), "and says when");
  assert.equal(heldLine("chase_invoice", "c1", { allow: true, reason: "within_budget" }), null);
});

test("the touch-type list is derived, never restated", () => {
  // Restating it is how the query and the budget drift apart six months from now.
  assert.ok(TOUCH_TASK_TYPES.includes("chase_invoice"));
  assert.ok(TOUCH_TASK_TYPES.includes("check_in_case"));
  assert.ok(!TOUCH_TASK_TYPES.includes("deliverable_verdict"), "responsive types are not touches");
});
