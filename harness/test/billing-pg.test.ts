// What the Postgres billing store can be held to WITHOUT a database.
//
// There is no Postgres in this environment, and the three ways this class could lose real money are
// all visible in the SQL it emits: an unscoped list, a transition that reads before it writes, and a
// payment that merges in JS. So the store is driven against a fake `Queryable` that records every
// statement, and the assertions are about the statements themselves — one query, the guard in the
// WHERE, the increment in the SET.
//
// What this canNOT prove is that Postgres agrees: the DDL is valid, `status = ANY($3::text[])`
// actually filters, and the row lock actually serialises concurrent writers. See postgres.test.ts
// and the report — that needs MYCEL_TEST_DATABASE_URL.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  INVOICE_COLUMNS,
  PostgresBillingStore,
  formatInvoiceNumber,
  invoicePatchSql,
  invoiceValues,
  invoiceWhere,
  rowToInvoice,
  transitionUpdate,
  type Queryable,
} from "../src/billing.pg";
import { INVOICE_TRANSITIONS } from "../src/billing";
import type { Invoice } from "../src/contract";

interface Call {
  sql: string;
  vals: unknown[];
}

/** A `Queryable` that records what it was asked and answers with whatever the test decides. */
class FakeDb implements Queryable {
  calls: Call[] = [];
  constructor(private respond: (c: Call) => any[] = () => []) {}
  async query(sql: string, values: unknown[] = []) {
    const call = { sql, vals: values };
    this.calls.push(call);
    const rows = this.respond(call);
    return { rows, rowCount: rows.length };
  }
  get sql(): string {
    return this.calls.map((c) => c.sql).join("\n---\n");
  }
}

const INV: Invoice = {
  id: "inv-1",
  project_id: "proj-a",
  client_id: "cli-1",
  case_id: "case-9",
  number: "INV-0007",
  currency: "GBP",
  status: "sent",
  lines: [{ id: "l1", description: "Retainer", kind: "fixed", quantity_milli: 1000, unit_amount: 125_000, tax_bps: 2000 }],
  issue_date: "2026-07-01",
  due_date: "2026-07-31",
  amount_paid: 25_000,
  note: "Thanks",
  internal_note: "chase on the 5th",
  created_at: "2026-07-01T09:00:00.000Z",
  updated_at: "2026-07-01T09:00:00.000Z",
};

/**
 * The row Postgres would hand back for `INV`, built from the production insert path.
 *
 * Three type coercions are simulated because they are exactly where a mapping bug hides: jsonb comes
 * back parsed, `bigint` comes back as a STRING, and `timestamptz` comes back as a JS Date.
 */
export function pgRow(inv: Invoice): Record<string, unknown> {
  const vals = invoiceValues(inv);
  const row: Record<string, unknown> = {};
  INVOICE_COLUMNS.forEach((c, i) => (row[c] = vals[i]));
  row.lines = JSON.parse(row.lines as string);
  row.amount_paid = String(row.amount_paid);
  for (const c of ["sent_at", "paid_at", "voided_at", "created_at", "updated_at"]) {
    if (row[c]) row[c] = new Date(row[c] as string);
  }
  return row;
}

test("billing.pg: an invoice survives the insert path and comes back identical", async () => {
  const back = rowToInvoice(pgRow(INV));
  // JSON-normalised because the mapper writes explicit `undefined` keys for absent columns, which
  // deepStrictEqual counts as a difference and no consumer can observe.
  assert.deepEqual(JSON.parse(JSON.stringify(back)), JSON.parse(JSON.stringify(INV)));
});

test("billing.pg: money comes back as an exact integer, never a float", async () => {
  const row = pgRow({ ...INV, amount_paid: 9_007_199_254_740 });
  assert.equal(typeof row.amount_paid, "string", "bigint arrives as a string — the bug this guards");
  const back = rowToInvoice(row);
  assert.equal(back.amount_paid, 9_007_199_254_740);
  assert.ok(Number.isInteger(back.amount_paid));
  // A fractional amount is a bug upstream; truncation is the honest response, not rounding up.
  assert.equal(rowToInvoice(pgRow({ ...INV, amount_paid: 1250.9 })).amount_paid, 1250);
});

test("billing.pg: dates stay YYYY-MM-DD strings, never shifted through a JS Date", async () => {
  // A `date` column would come back as local midnight and could read a day early — which would
  // flag an invoice overdue before it is. `text` in, `text` out.
  const back = rowToInvoice(pgRow({ ...INV, due_date: "2026-01-01" }));
  assert.equal(back.due_date, "2026-01-01");
  assert.equal(back.issue_date, "2026-07-01");
});

test("billing.pg: the list filter binds project_id and never interpolates", async () => {
  assert.deepEqual(invoiceWhere({}), { clause: "", vals: [] });
  assert.deepEqual(invoiceWhere({ project_id: "p" }), { clause: "WHERE project_id=$1", vals: ["p"] });
  assert.deepEqual(invoiceWhere({ project_id: "p", client_id: "c", status: "sent" }), {
    clause: "WHERE project_id=$1 AND client_id=$2 AND status=$3",
    vals: ["p", "c", "sent"],
  });
  // Fail closed: an empty project id is still a filter. `project_id=''` matches no invoice, which is
  // right — degrading it to "no filter" would list every tenant's invoices at once.
  assert.deepEqual(invoiceWhere({ project_id: "" }), { clause: "WHERE project_id=$1", vals: [""] });
  // Nothing from the caller reaches the SQL text.
  const nasty = invoiceWhere({ project_id: "p'; DROP TABLE invoices; --" });
  assert.equal(nasty.clause, "WHERE project_id=$1");
  assert.ok(!nasty.clause.includes("DROP"));
});

test("billing.pg: listInvoices pushes the limit into SQL, after the scope", async () => {
  const db = new FakeDb(() => [pgRow(INV)]);
  const store = PostgresBillingStore._withQueryable(db);
  await store.listInvoices({ project_id: "proj-a", limit: 5 });
  assert.equal(db.calls.length, 1);
  assert.match(db.calls[0].sql, /WHERE project_id=\$1 .*LIMIT \$2/s);
  assert.deepEqual(db.calls[0].vals, ["proj-a", 5]);
  // A truncating post-filter is the leak this avoids: the limit must apply to the scoped set.
  const idx = db.calls[0].sql.indexOf("LIMIT");
  assert.ok(db.calls[0].sql.indexOf("WHERE") < idx);
});

test("billing.pg: transitionInvoice is ONE statement with the allowlist in the WHERE", async () => {
  const db = new FakeDb(() => [pgRow({ ...INV, status: "paid" })]);
  const store = PostgresBillingStore._withQueryable(db);
  await store.transitionInvoice("inv-1", "paid", ["sent", "overdue"], { paid_at: "2026-07-10T00:00:00.000Z" });

  assert.equal(db.calls.length, 1, "no read-then-write — a second query here is the race");
  assert.ok(!/SELECT/i.test(db.sql), "nothing is read first; the guard is in the UPDATE");
  assert.match(db.calls[0].sql, /WHERE id=\$1 AND status = ANY\(\$3::text\[\]\)/);
  assert.deepEqual(db.calls[0].vals[2], ["sent", "overdue"]);
});

test("billing.pg: a transition the database refuses returns undefined, not a lie", async () => {
  const db = new FakeDb(() => []); // zero rows updated: someone else got there first
  const store = PostgresBillingStore._withQueryable(db);
  assert.equal(await store.transitionInvoice("inv-1", "void", ["draft"]), undefined);
});

test("billing.pg: a terminal status has an empty allowlist, which matches no row", async () => {
  // `paid` and `void` are terminal, so `allowedFrom` is `[]` and `status = ANY('{}')` is false for
  // every row. The illegal move cannot be expressed as a matching UPDATE.
  for (const from of ["paid", "void"] as const) {
    const { vals } = transitionUpdate("inv-1", "sent", INVOICE_TRANSITIONS[from]);
    assert.deepEqual(vals[2], []);
  }
});

test("billing.pg: omitted stamps leave their columns alone", async () => {
  const { sql, vals } = transitionUpdate("inv-1", "sent", ["draft"], { sent_at: "2026-07-02T00:00:00.000Z" });
  assert.match(sql, /sent_at\s+= COALESCE\(\$5::timestamptz, sent_at\)/);
  assert.deepEqual(vals.slice(3), [null, "2026-07-02T00:00:00.000Z", null, null]);
});

test("billing.pg: recordPayment increments in SQL — two payments cannot lose one", async () => {
  const db = new FakeDb(() => [pgRow({ ...INV, amount_paid: 75_000 })]);
  const store = PostgresBillingStore._withQueryable(db);
  const out = await store.recordPayment("inv-1", 50_000.4);
  assert.equal(db.calls.length, 1);
  assert.match(db.calls[0].sql, /amount_paid = amount_paid \+ \$2/);
  assert.deepEqual(db.calls[0].vals, ["inv-1", 50_000], "the delta is truncated to whole minor units");
  assert.equal(out?.amount_paid, 75_000);
});

test("billing.pg: nextInvoiceNumber allocates in one upserting statement", async () => {
  const db = new FakeDb(() => [{ last_number: "7" }]);
  const store = PostgresBillingStore._withQueryable(db);
  assert.equal(await store.nextInvoiceNumber("proj-a"), "INV-0007");
  assert.equal(db.calls.length, 1);
  assert.match(db.calls[0].sql, /ON CONFLICT \(project_id\) DO UPDATE SET last_number = invoice_counters\.last_number \+ 1/);
  assert.ok(!/SELECT/i.test(db.sql), "no MAX()+1 read — that is how two workers claim the same number");
  assert.equal(formatInvoiceNumber(12_345), "INV-12345", "wider numbers grow rather than truncate");
});

test("billing.pg: the patch allowlist refuses the columns with atomic methods", async () => {
  const patch = {
    note: "revised terms",
    payment_link_url: null,
    // None of these are patchable: two have atomic methods, and the rest would move an invoice
    // between tenants. Passed as an untyped object because this is what an HTTP body looks like.
    status: "paid",
    amount_paid: 999_999,
    project_id: "someone-else",
    "note=$1, amount_paid=999999 --": "injection",
  } as Record<string, unknown>;
  const { sets, vals } = invoicePatchSql(patch as never);
  assert.deepEqual(sets, ["note=$1", "payment_link_url=$2"]);
  assert.deepEqual(vals, ["revised terms", null]); // explicit null clears the link; undefined would not
  assert.ok(!sets.join(" ").includes("status"));
  assert.ok(!sets.join(" ").includes("amount_paid"));
  assert.ok(!sets.join(" ").includes("project_id"));
  assert.ok(!sets.join(" ").includes("injection"));
});

test("billing.pg: lines are serialised and cast, not concatenated", async () => {
  const { sets, vals } = invoicePatchSql({ lines: INV.lines });
  assert.deepEqual(sets, ["lines=$1::jsonb"]);
  assert.deepEqual(JSON.parse(vals[0] as string), INV.lines);
});

test("billing.pg: an empty patch is a read, not an UPDATE with no SET", async () => {
  const db = new FakeDb(() => [pgRow(INV)]);
  const store = PostgresBillingStore._withQueryable(db);
  await store.updateInvoice("inv-1", {});
  assert.equal(db.calls.length, 1);
  assert.match(db.calls[0].sql, /^SELECT/);
});

test("billing.pg: delete reports whether a row actually went", async () => {
  const gone = PostgresBillingStore._withQueryable(new FakeDb(() => [{}]));
  assert.equal(await gone.deleteInvoice("inv-1"), true);
  const missing = PostgresBillingStore._withQueryable(new FakeDb(() => []));
  assert.equal(await missing.deleteInvoice("nope"), false);
});

test("billing.pg: every statement is parameterised", async () => {
  const db = new FakeDb(() => [pgRow(INV)]);
  const store = PostgresBillingStore._withQueryable(db);
  // Distinctive values, so a hit is a real leak rather than "sent" matching the `sent_at` column.
  const Z = "zz-caller-value";
  await store.createInvoice({ ...INV, project_id: Z, client_id: Z, number: Z } as never);
  await store.getInvoice(Z);
  await store.listInvoices({ project_id: Z, client_id: Z, case_id: Z });
  await store.updateInvoice(Z, { note: Z });
  await store.transitionInvoice(Z, "paid", ["sent"]);
  await store.recordPayment(Z, 1);
  await store.deleteInvoice(Z);
  for (const c of db.calls) {
    // Every value a caller supplied is a bind, so no statement can carry caller text.
    assert.ok(!c.sql.includes(Z), `a caller value leaked into: ${c.sql}`);
    assert.ok(c.vals.some((v) => v === Z || (Array.isArray(v) && v.includes(Z)) || String(v).includes(Z)));
  }
});
