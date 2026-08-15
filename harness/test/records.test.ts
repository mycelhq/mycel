import { test } from "node:test";
import assert from "node:assert/strict";
import { api, makeApp } from "./helpers";
import { registerActionGrant } from "../src/actiongrants";

const WEDGE = "books-keeper";

test("records: writes are idempotent on the natural key — never double-post", async () => {
  const { app } = makeApp();
  const body = (data: unknown) => JSON.stringify({ wedge: WEDGE, collection: "transactions", key: "A1", data });

  const first = await api(app, "records", { method: "POST", body: body({ amount_cents: 12000, status: "unmatched" }) });
  assert.equal(first.status, 201);
  // re-ingesting the SAME transaction must update, not duplicate
  const second = await api(app, "records", { method: "POST", body: body({ status: "matched" }) });
  assert.equal(second.json.id, first.json.id, "same record");
  assert.equal(second.json.data.amount_cents, 12000, "merge, not truncate");
  assert.equal(second.json.data.status, "matched", "the update applied");

  const all = await api(app, `records?wedge=${WEDGE}&collection=transactions`);
  assert.equal(all.json.filter((r: { key: string }) => r.key === "A1").length, 1, "exactly one row");
});

test("records: the query the stress test couldn't answer", async () => {
  const { app } = makeApp();
  // ingest a period's worth of receipts, some missing
  for (let i = 0; i < 20; i++) {
    await api(app, "records", {
      method: "POST",
      body: JSON.stringify({ wedge: WEDGE, collection: "receipts", key: `r${i}`, data: { status: i % 4 === 0 ? "missing" : "present", period: "2026-10" } }),
    });
  }
  const missing = await api(app, `records?wedge=${WEDGE}&collection=receipts&where=${encodeURIComponent(JSON.stringify({ status: "missing" }))}`);
  assert.equal(missing.json.length, 5, "'which receipts are still missing?' is now a query");
  const present = await api(app, `records?wedge=${WEDGE}&collection=receipts&where=${encodeURIComponent(JSON.stringify({ status: "present" }))}`);
  assert.equal(present.json.length, 15);
  assert.equal((await api(app, "records?where=not-json")).status, 400);
});

test("records: validation and tenancy", async () => {
  const { app } = makeApp();
  assert.equal((await api(app, "records", { method: "POST", body: JSON.stringify({ collection: "x", key: "y" }) })).status, 400);
  assert.equal((await api(app, "records", { method: "POST", body: JSON.stringify({ wedge: "ghost", collection: "x", key: "y" }) })).status, 400);
  const rec = (await api(app, "records", { method: "POST", body: JSON.stringify({ wedge: WEDGE, collection: "c", key: "k" }) })).json;
  assert.ok(rec.project_id, "stamped with the tenant");
  assert.equal((await api(app, `records/${rec.id}`)).status, 200);
  assert.equal((await api(app, "records/nope")).status, 404);
  assert.equal((await api(app, `records/${rec.id}`, { method: "DELETE" })).json.ok, true);
});

test("records: the agent batches an ingest and queries it back, scoped to its wedge", async () => {
  const { store, app } = makeApp();
  const kase = (await api(app, "cases", { method: "POST", body: JSON.stringify({ wedge: WEDGE, title: "Oct close" }) })).json;
  const task = (await api(app, `cases/${kase.id}/tasks`, { method: "POST", body: JSON.stringify({ task_type: "daily_sync" }) })).json;
  const nonce = await registerActionGrant({ task_id: task.id, connectionIds: [], caseId: kase.id });
  const H = { authorization: `Bearer ${nonce}`, "content-type": "application/json" };

  // a 300-transaction ingest in one call
  const records = Array.from({ length: 300 }, (_, i) => ({
    collection: "transactions",
    key: `tx_${i}`,
    data: { amount_cents: (i + 1) * 10, status: i < 7 ? "unmatched" : "matched" },
  }));
  const up = await (await app.request("/v1/internal/records/upsert", { method: "POST", headers: H, body: JSON.stringify({ records }) })).json();
  assert.equal(up.ok, true);
  assert.equal(up.count, 300);

  const q = await (await app.request("/v1/internal/records/query", { method: "POST", headers: H, body: JSON.stringify({ collection: "transactions", where: { status: "unmatched" } }) })).json();
  assert.equal(q.ok, true);
  assert.equal(q.count, 7, "the agent can ask a precise question instead of scanning a blob");

  // records inherit the case, so an engagement's state is retrievable
  const byCase = await (await app.request("/v1/internal/records/query", { method: "POST", headers: H, body: JSON.stringify({ case_id: kase.id, limit: 5 }) })).json();
  assert.equal(byCase.count, 300);
  assert.equal(byCase.records.length, 5, "limit honoured");

  // traced
  const events = await store.eventsAfter(task.id, 0);
  assert.ok(events.some((e) => (e.data as { tool?: string }).tool === "records:upsert"));
  assert.ok(events.some((e) => (e.data as { tool?: string }).tool === "records:query"));

  // unauthenticated gets nothing
  assert.equal((await app.request("/v1/internal/records/query", { method: "POST", headers: { authorization: "Bearer no" }, body: "{}" })).status, 401);
  // and a batch that's too large is refused
  const huge = Array.from({ length: 1001 }, (_, i) => ({ collection: "c", key: `k${i}` }));
  assert.equal((await app.request("/v1/internal/records/upsert", { method: "POST", headers: H, body: JSON.stringify({ records: huge }) })).status, 400);
});
