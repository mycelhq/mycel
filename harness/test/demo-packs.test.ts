// Pinned demo packs — chase ladder, reconcile cents, campaign pace (pre-proof C1).
import { test } from "node:test";
import assert from "node:assert/strict";
import { _resetPackCatalog, listPacks, resolvePack, runPack } from "../src/packs";

test("demo packs are installed with matching digests", () => {
  _resetPackCatalog();
  const names = listPacks().map((p) => `${p.name}@${p.version}`);
  for (const ref of ["chase_ladder@1", "reconcile_cents@1", "campaign_pace@1", "share_of_voice@1"]) {
    assert.ok(names.includes(ref), `missing pack ${ref}; have ${names.join(", ")}`);
    assert.ok(resolvePack(ref), `resolvePack(${ref})`);
  }
});

test("chase_ladder pack returns the policy step without inventing a rung", async () => {
  _resetPackCatalog();
  const r = await runPack("chase_ladder@1", { days_overdue: 10, today: "2026-08-11" });
  assert.equal(r.ok, true, r.error);
  assert.equal((r.data as { step: string }).step, "firm_reminder");
});

test("reconcile_cents pack balances to the cent", async () => {
  _resetPackCatalog();
  const r = await runPack("reconcile_cents@1", {
    bank_transactions: [{ amount_cents: 1000, date: "2026-08-01", reference: "a" }],
    ledger_entries: [{ amount_cents: 1000, date: "2026-08-01", reference: "a" }],
    sales_tax_rate_pct: 0,
  });
  assert.equal(r.ok, true, r.error);
  const d = r.data as { reconciled: boolean; difference_cents: number };
  assert.equal(d.reconciled, true);
  assert.equal(d.difference_cents, 0);
});

test("campaign_pace pack stops on reply", async () => {
  _resetPackCatalog();
  const r = await runPack("campaign_pace@1", { stage: "dm1", has_reply: true, touch_count: 1 });
  assert.equal(r.ok, true, r.error);
  assert.equal((r.data as { should_send: boolean }).should_send, false);
});
