// The in-memory and Postgres backends must answer the same question the same way.
//
// This is the test that a whole class of tenancy bug hides from: each backend is individually
// reasonable, they disagree in one corner, and every test in the suite runs against the in-memory
// one — so the divergence is only ever observed in production, by a customer, looking at someone
// else's invoice.
//
// The pieces the two share outright (`toRow`, `INVOICE_TRANSITIONS`, `normalizeLines`) are imported
// by both and cannot drift. The pieces that are necessarily written twice — the filter predicate,
// the transition guard, the invoice-number format — are compared here.
//
// The WHERE clauses are evaluated by a deliberately tiny interpreter for the only grammar these
// builders emit: a conjunction of `col=$n`. It is not a Postgres; it cannot tell you that
// `at >= $3::timestamptz` compares the way you think. What it does check is the part that has
// actually gone wrong here before — which columns end up in the conjunction, and what they are
// bound to.
import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryBillingStore, INVOICE_TRANSITIONS, type InvoiceFilter } from "../src/billing";
import { InMemoryKnowledgeStore, toRow, type RuleFilter } from "../src/knowledge.store";
import {
  PostgresBillingStore,
  formatInvoiceNumber,
  invoiceValues,
  invoiceWhere,
  rowToInvoice,
  INVOICE_COLUMNS,
  type Queryable,
} from "../src/billing.pg";
import { ruleWhere } from "../src/knowledge.pg";
import type { Invoice, InvoiceStatus } from "../src/contract";
import type { NewRule } from "../src/knowledge";

/**
 * Evaluate `WHERE a=$1 AND b=$2` against a row. Equality only, which is all these builders emit.
 * Anything else in the clause is a test failure rather than a silent pass — a new operator must
 * come with a decision about what it means for tenancy.
 */
function matches(clause: string, vals: unknown[], row: Record<string, unknown>): boolean {
  if (!clause) return true;
  return clause
    .replace(/^WHERE /, "")
    .split(" AND ")
    .every((term) => {
      const m = /^([a-z_]+)=\$(\d+)$/.exec(term.trim());
      assert.ok(m, `the parity evaluator only understands equality, got: ${term}`);
      return row[m![1]] === vals[Number(m![2]) - 1];
    });
}

const inv = (over: Partial<Invoice>): Omit<Invoice, "id" | "created_at" | "updated_at" | "number" | "amount_paid"> => ({
  project_id: "proj-a",
  client_id: "cli-1",
  currency: "USD",
  status: "draft",
  lines: [],
  ...over,
});

test("parity: listInvoices scopes identically in both backends", async () => {
  const mem = new InMemoryBillingStore();
  const corpus: Invoice[] = [];
  for (const seed of [
    inv({}),
    inv({ status: "sent", case_id: "case-1" }),
    inv({ client_id: "cli-2", status: "paid" }),
    inv({ project_id: "proj-b" }),
    inv({ project_id: "proj-b", client_id: "cli-1", status: "sent" }),
    // The row nobody should see: a legacy invoice with no project. Unrepresentable in the contract,
    // constructed here anyway, because "can't happen" is how the last three cross-tenant bugs got in.
    inv({ project_id: undefined as unknown as string }),
  ]) {
    corpus.push(await mem.createInvoice(seed));
  }

  const filters: InvoiceFilter[] = [
    {},
    { project_id: "proj-a" },
    { project_id: "proj-b" },
    { project_id: "proj-a", client_id: "cli-1" },
    { project_id: "proj-a", status: "sent" },
    { project_id: "proj-a", case_id: "case-1" },
    { project_id: "proj-b", status: "sent" },
    { project_id: "nobody" },
    { project_id: "" },
    { client_id: "cli-1" },
  ];

  for (const f of filters) {
    const memIds = (await mem.listInvoices(f)).map((i) => i.id).sort();
    const { clause, vals } = invoiceWhere(f);
    const sqlIds = corpus
      .filter((i) => matches(clause, vals, i as unknown as Record<string, unknown>))
      .map((i) => i.id)
      .sort();
    assert.deepEqual(sqlIds, memIds, `disagreement on ${JSON.stringify(f)}`);
  }

  // And the specific thing the fail-closed rule exists for: the unscoped row belongs to nobody.
  const orphan = corpus.find((i) => i.project_id === undefined)!;
  for (const p of ["proj-a", "proj-b", ""]) {
    const { clause, vals } = invoiceWhere({ project_id: p });
    assert.equal(matches(clause, vals, orphan as unknown as Record<string, unknown>), false);
    assert.equal((await mem.listInvoices({ project_id: p })).some((i) => i.id === orphan.id), false);
  }
});

test("parity: listRules scopes identically in both backends", async () => {
  const mem = new InMemoryKnowledgeStore();
  const base: NewRule = {
    project_id: "proj-a",
    wedge: "bookkeeping",
    task_types: [],
    subject: "send_email.subject",
    text: "t",
    kind: "style",
    provenance: { source: "approval_edit", at: "2026-07-01T00:00:00.000Z" },
  };
  const corpus = [];
  for (const over of [
    {},
    { client_id: "cli-1" },
    { wedge: "sourcing" },
    { subject: "send_email.body" },
    { project_id: "proj-b" },
    { project_id: "proj-b", client_id: "cli-1" },
  ]) {
    corpus.push(await mem.putRule({ ...base, ...over }));
  }
  // One superseded rule, so the status filter is actually exercised.
  await mem.updateRule(corpus[0].id, "proj-a", { status: "superseded" });
  corpus[0] = (await mem.getRule(corpus[0].id, "proj-a"))!;

  const cases: Array<[string, RuleFilter]> = [
    ["proj-a", {}],
    ["proj-a", { wedge: "bookkeeping" }],
    ["proj-a", { status: "active" }],
    ["proj-a", { status: "superseded" }],
    ["proj-a", { subject: "send_email.subject" }],
    ["proj-a", { client_id: "cli-1" }],
    ["proj-b", { client_id: "cli-1" }],
    ["proj-b", {}],
    ["nobody", {}],
  ];
  for (const [project, f] of cases) {
    const memIds = (await mem.listRules(project, f)).map((r) => r.id).sort();
    const { clause, vals } = ruleWhere(project, f);
    const sqlIds = corpus
      .filter((r) => matches(clause, vals, r as unknown as Record<string, unknown>))
      .map((r) => r.id)
      .sort();
    assert.deepEqual(sqlIds, memIds, `disagreement on ${project} ${JSON.stringify(f)}`);
  }
});

/**
 * A fake that honours exactly the guard the UPDATE relies on: the row is only returned when its
 * current status is in the bound `allowedFrom` array. That is what `status = ANY($3::text[])`
 * means, so running the same matrix through it and through the in-memory store compares the two
 * implementations of transition legality rather than two copies of the same table.
 */
function transitionDb(current: InvoiceStatus, row: Invoice): Queryable {
  return {
    async query(_sql: string, vals: unknown[] = []) {
      const allowed = vals[2] as InvoiceStatus[];
      const to = vals[1] as InvoiceStatus;
      if (!allowed.includes(current)) return { rows: [], rowCount: 0 };
      const updated: Record<string, unknown> = { ...pgRowOf({ ...row, status: to }) };
      return { rows: [updated], rowCount: 1 };
    },
  };
}

function pgRowOf(i: Invoice): Record<string, unknown> {
  const vals = invoiceValues(i);
  const row: Record<string, unknown> = {};
  INVOICE_COLUMNS.forEach((c, n) => (row[c] = vals[n]));
  row.lines = JSON.parse(row.lines as string);
  row.amount_paid = String(row.amount_paid);
  return row;
}

const STATUSES: InvoiceStatus[] = ["draft", "sent", "paid", "overdue", "void"];

/** The source statuses from which `to` is a legal move — what a caller passes as `allowedFrom`. */
const sourcesFor = (to: InvoiceStatus): InvoiceStatus[] =>
  STATUSES.filter((f) => (INVOICE_TRANSITIONS[f] as readonly InvoiceStatus[]).includes(to));

test("parity: the status machine is enforced identically in memory and in SQL", async () => {
  for (const from of STATUSES) {
    for (const to of STATUSES) {
      const mem = new InMemoryBillingStore();
      const created = await mem.createInvoice(inv({ status: from }));
      const allowedFrom = sourcesFor(to);

      const memOut = await mem.transitionInvoice(created.id, to, allowedFrom);
      const pg = PostgresBillingStore._withQueryable(transitionDb(from, created));
      const pgOut = await pg.transitionInvoice(created.id, to, allowedFrom);

      assert.equal(
        pgOut === undefined,
        memOut === undefined,
        `${from} -> ${to}: one backend allowed it and the other did not`,
      );
      if (memOut && pgOut) assert.equal(pgOut.status, memOut.status);
      // And the machine itself is honoured: exactly the declared moves succeed, so `paid` and
      // `void` are terminal in both backends and nothing "un-pays" an invoice.
      const legal = (INVOICE_TRANSITIONS[from] as readonly InvoiceStatus[]).includes(to);
      assert.equal(memOut !== undefined, legal, `${from} -> ${to} should be ${legal ? "legal" : "refused"}`);
    }
  }
});

test("parity: an already-taken transition loses in both backends", async () => {
  // The concurrency case in miniature. A request that believes the invoice is `sent` arrives after
  // someone else moved it to `paid`: the source status no longer matches, so nothing is written.
  const mem = new InMemoryBillingStore();
  const created = await mem.createInvoice(inv({ status: "sent" }));
  await mem.transitionInvoice(created.id, "paid", sourcesFor("paid"));

  assert.equal(await mem.transitionInvoice(created.id, "void", ["sent"]), undefined);
  const pg = PostgresBillingStore._withQueryable(transitionDb("paid", created));
  assert.equal(await pg.transitionInvoice(created.id, "void", ["sent"]), undefined);
  assert.equal((await mem.getInvoice(created.id))!.status, "paid", "the decision that landed first stands");
});

test("parity: invoice numbers have the same format in both backends", async () => {
  const mem = new InMemoryBillingStore();
  assert.equal(await mem.nextInvoiceNumber("proj-a"), formatInvoiceNumber(1));
  for (let n = 2; n <= 7; n++) assert.equal(await mem.nextInvoiceNumber("proj-a"), formatInvoiceNumber(n));
  // Per project, not global — a second tenant starts at one.
  assert.equal(await mem.nextInvoiceNumber("proj-b"), formatInvoiceNumber(1));
});

test("parity: an invoice created in memory round-trips through the Postgres mapping unchanged", async () => {
  const mem = new InMemoryBillingStore();
  const created = await mem.createInvoice(
    inv({
      status: "sent",
      case_id: "case-1",
      lines: [
        { id: "l1", description: "Hours", kind: "unit", quantity_milli: 1500, unit_amount: 9000, tax_bps: 2000 },
        { id: "l2", description: "Credit", kind: "fixed", quantity_milli: 1000, unit_amount: -5000 },
      ],
      due_date: "2026-08-31",
      payment_link_url: "https://pay.example/x",
    }),
  );
  await mem.recordPayment(created.id, 12_345);
  const after = (await mem.getInvoice(created.id))!;

  const back = rowToInvoice({
    ...pgRowOf(after),
    created_at: new Date(after.created_at),
    updated_at: new Date(after.updated_at),
  });
  assert.deepEqual(JSON.parse(JSON.stringify(back)), JSON.parse(JSON.stringify(after)));
  // Negative minor units (a credit line) survive: the column is a signed bigint, not an unsigned one.
  assert.equal(back.lines[1].unit_amount, -5000);
});

test("parity: both backends fill a rule candidate's bookkeeping fields from the same function", async () => {
  // `toRow` is imported by the Postgres store rather than reimplemented, so this asserts the wiring:
  // a candidate acquires the same defaults whichever backend is mounted.
  const candidate: NewRule = {
    project_id: "proj-a",
    wedge: "bookkeeping",
    task_types: [],
    subject: "s",
    text: "t",
    kind: "style",
    provenance: { source: "approval_edit", at: "2026-07-01T00:00:00.000Z" },
  };
  const mem = await new InMemoryKnowledgeStore().putRule(candidate);
  const pgSeed = toRow(candidate);
  const strip = (r: Record<string, unknown>) => ({ ...r, id: "-", created_at: "-", updated_at: "-" });
  assert.deepEqual(strip(pgSeed as never), strip(mem as never));
});
