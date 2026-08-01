// Durable Postgres backing for accounts-receivable. Mirrors store.pg.ts / domain.pg.ts: raw SQL,
// tables created on connect under the schema lock, one shared pool. Selected automatically when
// MYCEL_DATABASE_URL is set.
//
// This file exists because the alternative — keeping invoices in a Map — loses money on every
// deploy. Read the MONEY comment on `Invoice` in contract.ts and the `BillingStore` docs in
// billing.ts before changing anything here; the two guarantees this backend owns are:
//
//   1. `transitionInvoice` is ONE statement whose WHERE contains the legal-source allowlist, so two
//      operators clicking "void" and "mark paid" at the same instant cannot both win.
//   2. `recordPayment` is `amount_paid = amount_paid + $2`, so two payments landing together cannot
//      lose one. Read-merge-write here is a silent write-off.
//
// Everything mechanical (the WHERE builder, the row mapping, the patch allowlist, the transition
// statement) is a pure exported function rather than a method, because there is no Postgres in the
// test environment and the parts that get tenancy and money wrong are exactly those parts. See
// test/billing-pg.test.ts.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { getPool } from "./pool";
import { withSchemaLock } from "./schema-lock";
import type { Invoice, InvoiceLine, InvoiceStatus } from "./contract";
import type { BillingStore, InvoiceFilter, InvoicePatch, NewInvoice } from "./billing";

/**
 * The narrow slice of `pg.Pool` this store actually uses.
 *
 * Typing the field as this rather than as `pg.Pool` is what makes the class drivable by a fake in
 * tests — the whole point being that SQL shape and row mapping are verifiable with no database.
 * `pg.Pool` satisfies it structurally; nothing here constructs a pool (see pool.ts).
 */
export interface Queryable {
  query(sql: string, values?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}

const iso = (v: unknown) => new Date(v as string).toISOString();

/**
 * The schema.
 *
 * Choices worth the ink:
 *
 * `id`/`client_id`/`case_id` are `text`, NOT `uuid`, unlike tasks in store.pg.ts. They hold UUIDs we
 * generate, but they are also looked up straight from a URL path, and `WHERE id = $1` against a
 * `uuid` column raises 22P02 (`invalid input syntax for type uuid`) on a malformed id — a 500 where
 * the in-memory store returns undefined and the route returns 404. A miss should be a miss.
 *
 * `issue_date`/`due_date` are `text`, not `date`. The contract says YYYY-MM-DD and node-pg parses a
 * `date` column into a JS `Date` at local midnight, which is one timezone away from silently
 * reporting an invoice overdue a day early. Storing the string the contract already specifies keeps
 * `effectiveStatus`'s string comparison exact.
 *
 * `amount_paid` is `bigint`: an exact integer count of minor units, never `numeric` and never
 * `double precision`. node-pg hands bigint back as a string, so the mapping goes through `Number()`
 * once, in one place — see `rowToInvoice`.
 *
 * `project_id` is NOT NULL. `Invoice.project_id` is required in the contract precisely so the tenant
 * filter can fail closed with no legacy-NULL exception; the column says the same thing.
 */
async function initSchema(pool: pg.Pool): Promise<void> {
  // Serialised across processes: `CREATE TABLE IF NOT EXISTS` is not concurrency-safe, and
  // four kernel containers boot together on every deploy. See schema-lock.ts.
  await withSchemaLock(pool, async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS invoices (
        id text PRIMARY KEY,
        project_id text NOT NULL,
        client_id text NOT NULL,
        case_id text,
        number text NOT NULL,
        currency text NOT NULL DEFAULT 'GBP',
        status text NOT NULL DEFAULT 'draft',
        lines jsonb NOT NULL DEFAULT '[]',
        issue_date text,
        due_date text,
        amount_paid bigint NOT NULL DEFAULT 0,
        payment_link_url text,
        note text,
        internal_note text,
        sent_at timestamptz,
        paid_at timestamptz,
        voided_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      -- The reference a client quotes on a bank transfer. Unique per project because two invoices
      -- answering to "INV-0007" is an unresolvable support conversation, and the counter below is
      -- what normally guarantees it — this is the backstop for a caller-supplied number.
      CREATE UNIQUE INDEX IF NOT EXISTS invoices_number_key ON invoices (project_id, number);
      -- Every list is tenant-scoped and newest-first; this is that query.
      CREATE INDEX IF NOT EXISTS invoices_scope_idx ON invoices (project_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS invoices_client_idx ON invoices (project_id, client_id);
      -- Invoice numbering. A row per project holding the last number handed out.
      --
      -- A separate table rather than MAX(number)+1 over invoices: MAX is a read-then-write, so two
      -- workers issuing at once both read 6 and both try to write INV-0007 — one crashes on the
      -- unique index and, worse, a deleted draft would let a number be reused. Here the allocation
      -- is a single upserting UPDATE, so it is monotonic even under concurrency and even if the
      -- invoice that claimed a number is later deleted.
      CREATE TABLE IF NOT EXISTS invoice_counters (
        project_id text PRIMARY KEY,
        last_number bigint NOT NULL DEFAULT 0
      );
    `);
  });
}

/** The insert column list. Exported with `invoiceValues` so a test can round-trip a row without a database. */
export const INVOICE_COLUMNS = [
  "id", "project_id", "client_id", "case_id", "number", "currency", "status", "lines",
  "issue_date", "due_date", "amount_paid", "payment_link_url", "note", "internal_note",
  "sent_at", "paid_at", "voided_at", "created_at", "updated_at",
] as const;

/** Bind values for `INVOICE_COLUMNS`, in order. `lines` is serialised; everything else is scalar. */
export function invoiceValues(inv: Invoice): unknown[] {
  return [
    inv.id,
    inv.project_id,
    inv.client_id,
    inv.case_id ?? null,
    inv.number,
    inv.currency,
    inv.status,
    JSON.stringify(inv.lines ?? []),
    inv.issue_date ?? null,
    inv.due_date ?? null,
    // Truncated, not rounded: money is a whole number of minor units and a fractional one is a bug
    // upstream, not something this layer should quietly average out.
    Math.trunc(inv.amount_paid ?? 0),
    inv.payment_link_url ?? null,
    inv.note ?? null,
    inv.internal_note ?? null,
    inv.sent_at ?? null,
    inv.paid_at ?? null,
    inv.voided_at ?? null,
    inv.created_at,
    inv.updated_at,
  ];
}

/** Row → contract type. The one place bigint-as-string becomes a JS integer. */
export function rowToInvoice(r: any): Invoice {
  return {
    id: r.id,
    project_id: r.project_id,
    client_id: r.client_id,
    case_id: r.case_id ?? undefined,
    number: r.number,
    currency: r.currency,
    status: r.status as InvoiceStatus,
    lines: (r.lines ?? []) as InvoiceLine[],
    issue_date: r.issue_date ?? undefined,
    due_date: r.due_date ?? undefined,
    // node-pg returns bigint as a string to avoid a silent precision loss. `Number` is exact to
    // 2^53 minor units — about ninety trillion pounds — so the conversion is safe, but it must
    // happen here rather than by accident in arithmetic somewhere downstream.
    amount_paid: Number(r.amount_paid ?? 0),
    payment_link_url: r.payment_link_url ?? undefined,
    note: r.note ?? undefined,
    internal_note: r.internal_note ?? undefined,
    sent_at: r.sent_at ? iso(r.sent_at) : undefined,
    paid_at: r.paid_at ? iso(r.paid_at) : undefined,
    voided_at: r.voided_at ? iso(r.voided_at) : undefined,
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
  };
}

/**
 * The list filter — the tenancy boundary, and it fails CLOSED.
 *
 * `project_id=$n` never matches a NULL, and it never matches a different tenant's string; passing
 * `project_id` therefore returns exactly that project's invoices and nothing else. This mirrors
 * `listCases`/`queryRecords`, whose in-memory form is
 * `if (q.project_id !== undefined && r.project_id !== q.project_id) return false` — note the
 * `!== undefined` rather than a truthiness test, so an empty-string project id filters to nothing
 * rather than degrading to "no filter at all", which is how you leak every tenant at once.
 *
 * The other three use `!val` to match InMemoryBillingStore exactly: they are conveniences, not
 * boundaries, and the two backends must agree or a memory-backed test cannot catch a divergence.
 */
export function invoiceWhere(f: InvoiceFilter): { clause: string; vals: unknown[] } {
  const where: string[] = [];
  const vals: unknown[] = [];
  if (f.project_id !== undefined) { vals.push(f.project_id); where.push(`project_id=$${vals.length}`); }
  for (const [col, val] of [["client_id", f.client_id], ["case_id", f.case_id], ["status", f.status]] as const) {
    if (val) { vals.push(val); where.push(`${col}=$${vals.length}`); }
  }
  return { clause: where.length ? "WHERE " + where.join(" AND ") : "", vals };
}

/**
 * The patchable columns, as an allowlist.
 *
 * Built from a fixed table rather than from `Object.entries(patch)`, because the patch arrives from
 * an HTTP body: iterating the caller's keys into `SET ${k}=...` is a SQL-injection primitive, and
 * even without the quoting bug it lets a request write `status` or `amount_paid` — the two columns
 * that have atomic methods precisely so they are never set this way.
 */
const PATCHABLE = [
  ["lines", "jsonb"],
  ["currency", null],
  ["due_date", null],
  ["issue_date", null],
  ["note", null],
  ["internal_note", null],
  ["payment_link_url", null],
  ["case_id", null],
] as const;

export function invoicePatchSql(patch: InvoicePatch): { sets: string[]; vals: unknown[] } {
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [col, cast] of PATCHABLE) {
    const val = (patch as Record<string, unknown>)[col];
    // `undefined` means "not mentioned", exactly as the in-memory store reads it. An explicit null
    // does clear the column, which is how a founder removes a payment link.
    if (val === undefined) continue;
    vals.push(col === "lines" ? JSON.stringify(val ?? []) : val);
    sets.push(`${col}=$${vals.length}${cast ? `::${cast}` : ""}`);
  }
  return { sets, vals };
}

/**
 * The atomic status move.
 *
 * `allowedFrom` is in the WHERE clause, not in an `if` above it. That is the entire guarantee: an
 * invoice already moved to `paid` by another request matches no row, the UPDATE affects nothing,
 * and this returns undefined instead of stamping `void` over a payment someone just recorded.
 * An empty `allowedFrom` matches nothing, which is the right reading of "no legal source states".
 *
 * The stamps are COALESCEd so an omitted one leaves the column alone — the in-memory store's
 * `if (val !== undefined)` loop, in SQL.
 */
export function transitionUpdate(
  id: string,
  to: InvoiceStatus,
  allowedFrom: readonly InvoiceStatus[],
  stamps: Partial<Pick<Invoice, "issue_date" | "sent_at" | "paid_at" | "voided_at">> = {},
): { sql: string; vals: unknown[] } {
  return {
    sql:
      `UPDATE invoices SET
         status     = $2,
         issue_date = COALESCE($4, issue_date),
         sent_at    = COALESCE($5::timestamptz, sent_at),
         paid_at    = COALESCE($6::timestamptz, paid_at),
         voided_at  = COALESCE($7::timestamptz, voided_at),
         updated_at = now()
       WHERE id=$1 AND status = ANY($3::text[])
       RETURNING *`,
    vals: [
      id, to, [...allowedFrom],
      stamps.issue_date ?? null, stamps.sent_at ?? null, stamps.paid_at ?? null, stamps.voided_at ?? null,
    ],
  };
}

/** `INV-0001`. Zero-padded to four so a year of invoices sorts lexically; wider numbers just grow. */
export function formatInvoiceNumber(n: number): string {
  return `INV-${String(n).padStart(4, "0")}`;
}

export class PostgresBillingStore implements BillingStore {
  private constructor(private db: Queryable) {}

  static async connect(url: string): Promise<PostgresBillingStore> {
    const pool = getPool(url);
    await initSchema(pool);
    return new PostgresBillingStore(pool);
  }

  /**
   * Test seam. There is no Postgres in the test environment, and the failure modes this class exists
   * to prevent (an unscoped read, a read-then-write transition, a lost payment) are all visible in
   * the SQL it emits. This lets a test assert on exactly that.
   */
  static _withQueryable(db: Queryable): PostgresBillingStore {
    return new PostgresBillingStore(db);
  }

  /**
   * Allocate the next reference for a project, atomically.
   *
   * One upsert. Two workers issuing simultaneously serialise on the row and get 7 and 8; neither
   * reads a stale value, and nothing is ever handed out twice. A number is burned if the invoice
   * that claimed it fails to insert — deliberately, because reusing a reference a client may already
   * have seen is worse than a gap in the sequence.
   */
  async nextInvoiceNumber(projectId: string): Promise<string> {
    const r = await this.db.query(
      `INSERT INTO invoice_counters (project_id, last_number) VALUES ($1, 1)
       ON CONFLICT (project_id) DO UPDATE SET last_number = invoice_counters.last_number + 1
       RETURNING last_number`,
      [projectId],
    );
    return formatInvoiceNumber(Number(r.rows[0].last_number));
  }

  async createInvoice(i: NewInvoice): Promise<Invoice> {
    const at = new Date().toISOString();
    const inv: Invoice = {
      ...i,
      id: randomUUID(),
      number: i.number ?? (await this.nextInvoiceNumber(i.project_id)),
      amount_paid: i.amount_paid ?? 0,
      created_at: at,
      updated_at: at,
    };
    const cols = INVOICE_COLUMNS.join(", ");
    const placeholders = INVOICE_COLUMNS.map((_, n) => `$${n + 1}`).join(",");
    const r = await this.db.query(
      `INSERT INTO invoices (${cols}) VALUES (${placeholders}) RETURNING *`,
      invoiceValues(inv),
    );
    // Returned from the row, not from `inv`: the database is the authority on what was actually
    // stored, and reading it back is what would surface a truncation or a default we didn't expect.
    return rowToInvoice(r.rows[0]);
  }

  async getInvoice(id: string): Promise<Invoice | undefined> {
    const r = await this.db.query(`SELECT * FROM invoices WHERE id=$1`, [id]);
    return r.rows[0] ? rowToInvoice(r.rows[0]) : undefined;
  }

  async listInvoices(f: InvoiceFilter = {}): Promise<Invoice[]> {
    const { clause, vals } = invoiceWhere(f);
    // The limit is pushed into SQL rather than applied to the result, for the reason spelled out on
    // `InvoiceFilter.project_id`: a post-filter over a truncated page is both wrong and a leak.
    vals.push(f.limit ?? 200);
    const r = await this.db.query(
      `SELECT * FROM invoices ${clause} ORDER BY created_at DESC LIMIT $${vals.length}`,
      vals,
    );
    return r.rows.map(rowToInvoice);
  }

  async updateInvoice(id: string, patch: InvoicePatch): Promise<Invoice | undefined> {
    const { sets, vals } = invoicePatchSql(patch);
    if (!sets.length) return this.getInvoice(id);
    vals.push(id);
    const r = await this.db.query(
      `UPDATE invoices SET ${sets.join(", ")}, updated_at=now() WHERE id=$${vals.length} RETURNING *`,
      vals,
    );
    return r.rows[0] ? rowToInvoice(r.rows[0]) : undefined;
  }

  async transitionInvoice(
    id: string,
    to: InvoiceStatus,
    allowedFrom: readonly InvoiceStatus[],
    stamps: Partial<Pick<Invoice, "issue_date" | "sent_at" | "paid_at" | "voided_at">> = {},
  ): Promise<Invoice | undefined> {
    const { sql, vals } = transitionUpdate(id, to, allowedFrom, stamps);
    const r = await this.db.query(sql, vals);
    return r.rows[0] ? rowToInvoice(r.rows[0]) : undefined;
  }

  async recordPayment(id: string, amountMinor: number): Promise<Invoice | undefined> {
    // `amount_paid + $2` inside the UPDATE, so two payments arriving together serialise on the row
    // lock and the second adds to the first's committed value. This is the whole reason the method
    // exists separately from `updateInvoice`. See BillingStore.recordPayment.
    const r = await this.db.query(
      `UPDATE invoices SET amount_paid = amount_paid + $2, updated_at=now() WHERE id=$1 RETURNING *`,
      [id, Math.trunc(amountMinor)],
    );
    return r.rows[0] ? rowToInvoice(r.rows[0]) : undefined;
  }

  async deleteInvoice(id: string): Promise<boolean> {
    // Unconditional, matching the in-memory store: "drafts only" is the route's rule, because
    // deleting an issued invoice is a void — a different document with its own audit trail.
    const r = await this.db.query(`DELETE FROM invoices WHERE id=$1`, [id]);
    return (r.rowCount ?? 0) > 0;
  }

  async close(): Promise<void> {
    // No-op: the pool is shared process-wide. See pool.ts — the first store to end
    // it would close the connections every other store is still using. Shutdown calls
    // closeAllPools() once.
  }
}
