// The half of the Postgres billing/knowledge backends that CANNOT be tested without Postgres.
//
// Everything in billing-pg.test.ts and knowledge-pg.test.ts is about the SQL these stores emit. That
// catches an unscoped filter or a read-then-write, and it catches nothing about whether the DDL is
// valid, whether `status = ANY($3::text[])` filters the way it reads, or whether the row lock
// actually serialises two writers. Those are the properties the whole design rests on, so they are
// asserted here against a real database and skipped when there isn't one — the same arrangement as
// postgres.test.ts, which is how the missing `project_id` column on tasks was found.
//
// Run with: MYCEL_TEST_DATABASE_URL=postgres://... npm test
import { test } from "node:test";
import assert from "node:assert/strict";

const URL = process.env.MYCEL_TEST_DATABASE_URL;
const skip = URL ? false : "set MYCEL_TEST_DATABASE_URL to run";

const project = () => `parity-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

test("postgres billing: schema creates, and an invoice survives a fresh connection", { skip }, async () => {
  const { PostgresBillingStore } = await import("../src/billing.pg");
  const p = project();
  const first = await PostgresBillingStore.connect(URL!);
  const created = await first.createInvoice({
    project_id: p,
    client_id: "cli-1",
    currency: "USD",
    status: "draft",
    lines: [{ id: "l1", description: "Retainer", kind: "fixed", quantity_milli: 1000, unit_amount: 125_000, tax_bps: 2000 }],
    due_date: "2026-08-31",
  });
  assert.equal(created.number, "INV-0001");

  // A second store object, as a redeployed container would be.
  const second = await PostgresBillingStore.connect(URL!);
  const back = await second.getInvoice(created.id);
  assert.deepEqual(back, created, "the row round-trips through Postgres byte for byte");
  assert.equal(back!.due_date, "2026-08-31", "a date column would have shifted this");
});

test("postgres billing: an id that isn't a UUID is a miss, not a 500", { skip }, async () => {
  const { PostgresBillingStore } = await import("../src/billing.pg");
  const store = await PostgresBillingStore.connect(URL!);
  // `text` ids rather than `uuid`: this would raise 22P02 against a uuid column.
  assert.equal(await store.getInvoice("not-a-uuid"), undefined);
  assert.equal(await store.deleteInvoice("not-a-uuid"), false);
});

test("postgres billing: only one of two racing transitions wins", { skip }, async () => {
  const { PostgresBillingStore } = await import("../src/billing.pg");
  const store = await PostgresBillingStore.connect(URL!);
  const p = project();
  const i = await store.createInvoice({ project_id: p, client_id: "c", currency: "USD", status: "sent", lines: [] });

  const [paid, voided] = await Promise.all([
    store.transitionInvoice(i.id, "paid", ["sent", "overdue"], { paid_at: new Date().toISOString() }),
    store.transitionInvoice(i.id, "void", ["draft", "sent", "overdue"], { voided_at: new Date().toISOString() }),
  ]);
  assert.equal([paid, voided].filter(Boolean).length, 1, "both operators cannot win");
  const final = await store.getInvoice(i.id);
  assert.ok(final!.status === "paid" || final!.status === "void");
  // And the loser cannot come back: both targets are terminal.
  assert.equal(await store.transitionInvoice(i.id, "sent", ["draft", "overdue"]), undefined);
});

test("postgres billing: concurrent payments all land", { skip }, async () => {
  const { PostgresBillingStore } = await import("../src/billing.pg");
  const store = await PostgresBillingStore.connect(URL!);
  const p = project();
  const i = await store.createInvoice({ project_id: p, client_id: "c", currency: "USD", status: "sent", lines: [] });
  await Promise.all(Array.from({ length: 20 }, () => store.recordPayment(i.id, 500)));
  assert.equal((await store.getInvoice(i.id))!.amount_paid, 10_000, "read-merge-write would lose most of these");
});

test("postgres billing: invoice numbers are monotonic per project under concurrency", { skip }, async () => {
  const { PostgresBillingStore } = await import("../src/billing.pg");
  const store = await PostgresBillingStore.connect(URL!);
  const p = project();
  const numbers = await Promise.all(Array.from({ length: 10 }, () => store.nextInvoiceNumber(p)));
  assert.equal(new Set(numbers).size, 10, "a number was handed out twice");
  assert.deepEqual([...numbers].sort(), Array.from({ length: 10 }, (_, n) => `INV-${String(n + 1).padStart(4, "0")}`));
  // Per project: another tenant starts again at one.
  assert.equal(await store.nextInvoiceNumber(project()), "INV-0001");
});

test("postgres billing: listInvoices never crosses a tenant", { skip }, async () => {
  const { PostgresBillingStore } = await import("../src/billing.pg");
  const store = await PostgresBillingStore.connect(URL!);
  const a = project();
  const b = project();
  const mine = await store.createInvoice({ project_id: a, client_id: "c", currency: "USD", status: "draft", lines: [] });
  await store.createInvoice({ project_id: b, client_id: "c", currency: "USD", status: "draft", lines: [] });
  const listed = await store.listInvoices({ project_id: a });
  assert.deepEqual(listed.map((i) => i.id), [mine.id]);
  assert.deepEqual(await store.listInvoices({ project_id: "" }), [], "an empty scope is not an open one");
});

test("postgres knowledge: rules and observations survive, scoped", { skip }, async () => {
  const { PostgresKnowledgeStore } = await import("../src/knowledge.pg");
  const store = await PostgresKnowledgeStore.connect(URL!);
  const a = project();
  const b = project();
  const base = {
    wedge: "bookkeeping",
    task_types: ["reply_to_lead"],
    subject: "send_email.subject",
    text: "Lead with the amount owed.",
    kind: "style" as const,
    provenance: { source: "approval_edit" as const, at: new Date().toISOString() },
  };
  const mine = await store.putRule({ ...base, project_id: a });
  await store.putRule({ ...base, project_id: b });

  assert.deepEqual(await store.getRule(mine.id, a), mine);
  assert.equal(await store.getRule(mine.id, b), undefined, "another tenant's id must simply miss");
  assert.equal(await store.getRule(mine.id, ""), undefined);
  assert.deepEqual((await store.listRules(a)).map((r) => r.id), [mine.id]);
  assert.equal(await store.updateRule(mine.id, b, { text: "mine now" }), undefined);

  const obs = await store.recordObservation({ project_id: a, wedge: "bookkeeping", task_type: "reply_to_lead", kind: "approval_edited" });
  assert.deepEqual((await store.listObservations(a)).map((o) => o.id), [obs.id]);
  assert.deepEqual(await store.listObservations(b), []);
});

test("postgres knowledge: counters cannot lose an increment", { skip }, async () => {
  const { PostgresKnowledgeStore } = await import("../src/knowledge.pg");
  const store = await PostgresKnowledgeStore.connect(URL!);
  const p = project();
  const rule = await store.putRule({
    project_id: p,
    wedge: "bookkeeping",
    task_types: [],
    subject: "send_email.subject",
    text: "t",
    kind: "style",
    provenance: { source: "approval_edit", at: new Date().toISOString() },
  });
  await Promise.all([
    ...Array.from({ length: 10 }, () => store.noteUses(p, [rule.id])),
    ...Array.from({ length: 10 }, () => store.noteCorrectionOn(p, "bookkeeping", "send_email.subject")),
  ]);
  const after = (await store.getRule(rule.id, p))!;
  assert.equal(after.uses, 10);
  assert.equal(after.corrections_since, 10);
  // A correction elsewhere is evidence about the rule, not an edit to it.
  assert.equal(after.updated_at, rule.updated_at);
});
