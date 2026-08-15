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
import type {
  BillingStore,
  ExternalPayment,
  ExternalPaymentResult,
  InvoiceFilter,
  InvoicePatch,
  NewInvoice,
  PaymentCheck,
  RetainerPeriodRow,
} from "./billing";
import { isPaymentMethod } from "./billing";

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
        currency text NOT NULL DEFAULT 'USD',
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
        last_chased_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      -- Additive, for tables that predate the dunning sweep. Every existing row is correctly NULL:
      -- the sweep has never chased them, because until now there was no sweep.
      ALTER TABLE invoices ADD COLUMN IF NOT EXISTS last_chased_at timestamptz;
      -- The dunning sweep's query — one project's live invoices, least recently chased first.
      -- Partial, because paid/void/draft rows are the permanent bulk of this table and not one of
      -- them is ever chaseable.
      CREATE INDEX IF NOT EXISTS invoices_dunning_idx
        ON invoices (project_id, last_chased_at NULLS FIRST)
        WHERE status IN ('sent', 'overdue');
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
      -- Payments observed in a payment provider. THE IDEMPOTENCY LEDGER behind amount_paid.
      --
      -- The unique index is the entire safety property: reconciliation re-reads the same window of
      -- Stripe history every hour, so without it an invoice's amount_paid grows by its own value on
      -- every sweep -- invisibly, because the status went paid on the first pass and nobody reads a
      -- number under a green badge. Keyed on (project_id, external_id) rather than external_id alone
      -- because the id space is the provider's and two tenants' Stripe accounts are unrelated
      -- namespaces; a global unique index there would let one tenant's charge id silently suppress
      -- another tenant's genuine payment.
      CREATE TABLE IF NOT EXISTS invoice_external_payments (
        id text PRIMARY KEY,
        project_id text NOT NULL,
        invoice_id text NOT NULL,
        external_id text NOT NULL,
        amount_minor bigint NOT NULL,
        currency text NOT NULL,
        paid_at timestamptz NOT NULL,
        basis text NOT NULL,
        source text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      -- Additive, for tables that predate hand-recorded payments. NULL on every existing row is
      -- correct rather than a gap: every payment written here before these columns existed was READ
      -- FROM A PROVIDER, where the method is implicit in the connection. Nullable rather than
      -- DEFAULT 'other' for exactly that reason — "nobody recorded a method" and "the founder chose
      -- other" are different facts, and a default would forge the second one across the backfill.
      ALTER TABLE invoice_external_payments ADD COLUMN IF NOT EXISTS method text;
      ALTER TABLE invoice_external_payments ADD COLUMN IF NOT EXISTS reference text;
      CREATE UNIQUE INDEX IF NOT EXISTS invoice_external_payments_key
        ON invoice_external_payments (project_id, external_id);
      -- The audit trail read: every provider payment behind one invoice's balance.
      CREATE INDEX IF NOT EXISTS invoice_external_payments_invoice_idx
        ON invoice_external_payments (project_id, invoice_id, paid_at DESC);
      -- When a project's payment state was last checked against the outside world. One row per
      -- project. confirmed_at is NULL until a reconciliation actually succeeds, and the dunning
      -- staleness rule reads exactly that NULL -- see PaymentCheck in billing.ts.
      -- RECURRING REVENUE'S IDEMPOTENCY LEDGER. One row per retainer period ever billed.
      --
      -- The unique index below is the entire safety property of the retainer engine, and it is the
      -- one index in this schema whose absence would charge a real client twice. period_key is the
      -- period's start date, computed as a pure function of the money-plan line's recurrence, so
      -- every replica, every restart and every re-fired schedule derives the SAME key for March.
      -- The claim is an INSERT ... ON CONFLICT DO NOTHING, so exactly one caller wins and the losers
      -- draft nothing. There is deliberately no read-then-write anywhere on that path.
      --
      -- Keyed with project_id rather than on (case_id, line_id, period_key) alone: those ids are
      -- ours and already unique, but a key without a tenant is a key one tenant can collide with
      -- another's, and the failure there is a retainer that silently never bills.
      CREATE TABLE IF NOT EXISTS invoice_retainer_periods (
        id text PRIMARY KEY,
        project_id text NOT NULL,
        case_id text NOT NULL,
        line_id text NOT NULL,
        period_key text NOT NULL,
        period_end text NOT NULL,
        amount_minor bigint NOT NULL,
        currency text NOT NULL,
        claimed_at timestamptz NOT NULL,
        invoice_id text,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS invoice_retainer_periods_key
        ON invoice_retainer_periods (project_id, case_id, line_id, period_key);
      -- The founder's "what has this retainer billed" read, newest period first.
      CREATE INDEX IF NOT EXISTS invoice_retainer_periods_scope_idx
        ON invoice_retainer_periods (project_id, case_id, period_key DESC);
      CREATE TABLE IF NOT EXISTS invoice_payment_checks (
        project_id text PRIMARY KEY,
        confirmed_at timestamptz,
        attempted_at timestamptz NOT NULL,
        ok boolean NOT NULL,
        detail text NOT NULL DEFAULT ''
      );
    `);
  });
}

/** The insert column list. Exported with `invoiceValues` so a test can round-trip a row without a database. */
export const INVOICE_COLUMNS = [
  "id", "project_id", "client_id", "case_id", "number", "currency", "status", "lines",
  "issue_date", "due_date", "amount_paid", "payment_link_url", "note", "internal_note",
  "sent_at", "paid_at", "voided_at", "last_chased_at", "created_at", "updated_at",
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
    inv.last_chased_at ?? null,
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
    // 2^53 minor units — about ninety trillion dollars — so the conversion is safe, but it must
    // happen here rather than by accident in arithmetic somewhere downstream.
    amount_paid: Number(r.amount_paid ?? 0),
    payment_link_url: r.payment_link_url ?? undefined,
    note: r.note ?? undefined,
    internal_note: r.internal_note ?? undefined,
    sent_at: r.sent_at ? iso(r.sent_at) : undefined,
    paid_at: r.paid_at ? iso(r.paid_at) : undefined,
    voided_at: r.voided_at ? iso(r.voided_at) : undefined,
    last_chased_at: r.last_chased_at ? iso(r.last_chased_at) : undefined,
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
  };
}

/** Row → contract type. `amount_minor` is bigint-as-string; the conversion happens here, once. */
export function rowToRetainerPeriod(r: any): RetainerPeriodRow {
  return {
    project_id: r.project_id,
    case_id: r.case_id,
    line_id: r.line_id,
    period_key: r.period_key,
    period_end: r.period_end,
    amount_minor: Number(r.amount_minor ?? 0),
    currency: r.currency,
    claimed_at: iso(r.claimed_at),
    invoice_id: r.invoice_id ?? undefined,
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
  // Unconditional now that the field is required: the clause is always emitted, so there is no
  // shape of `f` that produces a WHERE without a tenant.
  vals.push(f.project_id); where.push(`project_id=$${vals.length}`);
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

/**
 * The atomic chase claim — the statement that makes the dunning sweep multi-replica safe.
 *
 * Exactly the same trick as `transitionUpdate`: the guard lives in the WHERE clause, not in an `if`
 * above it. Two worker replicas sweeping the same project issue this concurrently; Postgres
 * serialises them on the row lock, the first sets `last_chased_at` to now, and the second's
 * predicate is then false, so it matches no row and returns undefined. One chase, one email.
 *
 * Written as an `UPDATE … WHERE` rather than `SELECT … FOR UPDATE SKIP LOCKED` deliberately. SKIP
 * LOCKED is the right tool when work is claimed for the duration of a transaction — that is what
 * `claimDueSchedules` does. Here the claim must outlive the transaction by days (an invoice chased
 * this morning must still be un-chaseable this afternoon, on a replica that has never seen it), and
 * a lock cannot express that. A durable timestamp can.
 */
export function chaseClaimUpdate(id: string, notChasedSince: string, at: string): { sql: string; vals: unknown[] } {
  return {
    sql:
      `UPDATE invoices
         SET last_chased_at = $3::timestamptz,
             updated_at     = now()
       WHERE id = $1
         AND (last_chased_at IS NULL OR last_chased_at <= $2::timestamptz)
       RETURNING *`,
    vals: [id, notChasedSince, at],
  };
}

/**
 * Give a chase claim back. The exact inverse of `chaseClaimUpdate`, and the guard is the point.
 *
 * `last_chased_at = $2` in the WHERE is what makes this safe on four replicas: it releases only the
 * stamp this run actually won. Anything that re-stamped the row since — the next sweep, a founder
 * clicking Chase, another replica — leaves this matching zero rows, which is the correct outcome.
 * See `BillingStore.releaseInvoiceChaseClaim` for the production failure it exists for.
 *
 * `$3` is NULL for an invoice that had never been chased, which is what `restoreTo: undefined`
 * means and what the column held before the claim.
 */
export function chaseClaimRelease(id: string, claimedAt: string, restoreTo?: string): { sql: string; vals: unknown[] } {
  return {
    sql:
      `UPDATE invoices
         SET last_chased_at = $3::timestamptz,
             updated_at     = now()
       WHERE id = $1
         AND last_chased_at = $2::timestamptz
       RETURNING id`,
    vals: [id, claimedAt, restoreTo ?? null],
  };
}

/**
 * Apply a provider payment at most once — remembering it and adding it in ONE statement.
 *
 * The whole guarantee is the CTE. `ON CONFLICT DO NOTHING` makes the insert the arbiter: it either
 * produces a row, in which case the UPDATE's subqueries find an invoice id and an amount and the
 * money is added, or it produces nothing, in which case `(SELECT invoice_id FROM ins)` is NULL,
 * `WHERE id = NULL` matches no row, and this returns zero rows. Both halves commit together, so
 * there is no crash point at which a payment is remembered but not counted (an invoice quietly short
 * of what was paid, and therefore chased) or counted but not remembered (an invoice whose balance
 * doubles on the next sweep).
 *
 * Written as `UPDATE … WHERE id = (SELECT …)` rather than a join for the same reason
 * `transitionUpdate` puts its allowlist in the WHERE: the guard has to be inside the statement.
 *
 * `project_id = $2` on the UPDATE is the tenancy boundary, and it is not redundant with the insert.
 * The insert would happily record a row claiming another tenant's invoice id; this clause is what
 * makes that record settle nothing, so the caller sees `applied: false, invoice: undefined` and says
 * so out loud instead of moving one tenant's money onto another's books.
 */
export function externalPaymentApply(p: {
  id: string;
  project_id: string;
  invoice_id: string;
  external_id: string;
  amount_minor: number;
  currency: string;
  paid_at: string;
  basis: string;
  source: string;
  method?: string;
  reference?: string;
}): { sql: string; vals: unknown[] } {
  return {
    sql:
      `WITH ins AS (
         INSERT INTO invoice_external_payments
           (id, project_id, invoice_id, external_id, amount_minor, currency, paid_at, basis, source, method, reference)
         VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8, $9, $10, $11)
         ON CONFLICT (project_id, external_id) DO NOTHING
         RETURNING invoice_id, amount_minor
       )
       UPDATE invoices
          SET amount_paid = amount_paid + (SELECT amount_minor FROM ins),
              updated_at  = now()
        WHERE id = (SELECT invoice_id FROM ins)
          AND project_id = $2
       RETURNING *`,
    vals: [
      p.id, p.project_id, p.invoice_id, p.external_id,
      // Truncated, never rounded — same rule as `invoiceValues`. A fractional minor unit is a bug
      // upstream, and averaging it out here is how it stops being findable.
      Math.trunc(p.amount_minor),
      p.currency, p.paid_at, p.basis, p.source,
      // `?? null` rather than `?? ""`: an absent method must read back as undefined, not as an
      // empty-string method that no `PAYMENT_METHODS` branch matches and every UI renders as blank.
      p.method ?? null, p.reference ?? null,
    ],
  };
}

/**
 * Upsert the payment-freshness row.
 *
 * `confirmed_at = COALESCE($2, invoice_payment_checks.confirmed_at)` is load-bearing: a failed
 * attempt records that we tried and why, and must NOT erase the last time we succeeded. Overwriting
 * it with NULL on a transient Stripe outage would flip every invoice in the project to "payment
 * state never verified" and — under the staleness rule in dunning.ts — halt all chasing for a
 * business whose Stripe was merely slow for a minute.
 */
export function paymentCheckUpsert(c: {
  project_id: string;
  confirmed_at?: string;
  attempted_at: string;
  ok: boolean;
  detail: string;
}): { sql: string; vals: unknown[] } {
  return {
    sql:
      `INSERT INTO invoice_payment_checks (project_id, confirmed_at, attempted_at, ok, detail)
       VALUES ($1, $2::timestamptz, $3::timestamptz, $4, $5)
       ON CONFLICT (project_id) DO UPDATE SET
         confirmed_at = COALESCE(EXCLUDED.confirmed_at, invoice_payment_checks.confirmed_at),
         attempted_at = EXCLUDED.attempted_at,
         ok           = EXCLUDED.ok,
         detail       = EXCLUDED.detail
       RETURNING *`,
    vals: [c.project_id, c.confirmed_at ?? null, c.attempted_at, c.ok, c.detail],
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

  async listInvoices(f: InvoiceFilter): Promise<Invoice[]> {
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

  async applyExternalPayment(p: ExternalPayment): Promise<ExternalPaymentResult> {
    if (!p.project_id) throw new Error("an external payment must be scoped to a project");
    const { sql, vals } = externalPaymentApply({ ...p, id: randomUUID() });
    const r = await this.db.query(sql, vals);
    if (r.rows[0]) return { applied: true, invoice: rowToInvoice(r.rows[0]) };
    // Zero rows means one of two things, and the caller has to be able to tell them apart: the
    // payment was already applied (fine, the mechanism working), or the invoice is not in this
    // project (a real fault). One extra scoped read decides it — cheap, and only on the path that
    // is already not doing any work.
    const existing = await this.db.query(
      `SELECT 1 FROM invoice_external_payments WHERE project_id=$1 AND external_id=$2`,
      [p.project_id, p.external_id],
    );
    if (!existing.rows[0]) return { applied: false, invoice: undefined };
    const inv = await this.db.query(`SELECT * FROM invoices WHERE id=$1 AND project_id=$2`, [
      p.invoice_id,
      p.project_id,
    ]);
    return { applied: false, invoice: inv.rows[0] ? rowToInvoice(inv.rows[0]) : undefined };
  }

  async listExternalPayments(args: { project_id: string; invoice_id: string }): Promise<ExternalPayment[]> {
    const r = await this.db.query(
      `SELECT * FROM invoice_external_payments WHERE project_id=$1 AND invoice_id=$2 ORDER BY paid_at DESC`,
      [args.project_id, args.invoice_id],
    );
    return r.rows.map((x: any) => ({
      project_id: x.project_id,
      invoice_id: x.invoice_id,
      external_id: x.external_id,
      // bigint arrives as a string; the conversion happens here, once, exactly as `rowToInvoice` does.
      amount_minor: Number(x.amount_minor ?? 0),
      currency: x.currency,
      paid_at: iso(x.paid_at),
      basis: x.basis,
      source: x.source,
      // Validated on the way out, not just on the way in. This column is nullable and was added by
      // an ALTER, so it can hold whatever a previous deploy or a hand-run UPDATE put there; handing
      // an unrecognised string back typed as `PaymentMethod` would push the lie into every caller.
      method: isPaymentMethod(x.method) ? x.method : undefined,
      reference: x.reference ?? undefined,
    }));
  }

  async getPaymentCheck(projectId: string): Promise<PaymentCheck | undefined> {
    const r = await this.db.query(`SELECT * FROM invoice_payment_checks WHERE project_id=$1`, [projectId]);
    const x = r.rows[0];
    if (!x) return undefined;
    return {
      project_id: x.project_id,
      confirmed_at: x.confirmed_at ? iso(x.confirmed_at) : undefined,
      attempted_at: iso(x.attempted_at),
      ok: !!x.ok,
      detail: x.detail ?? "",
    };
  }

  async recordPaymentCheck(check: PaymentCheck): Promise<PaymentCheck> {
    if (!check.project_id) throw new Error("a payment check must be scoped to a project");
    const { sql, vals } = paymentCheckUpsert(check);
    const r = await this.db.query(sql, vals);
    const x = r.rows[0];
    return {
      project_id: x.project_id,
      confirmed_at: x.confirmed_at ? iso(x.confirmed_at) : undefined,
      attempted_at: iso(x.attempted_at),
      ok: !!x.ok,
      detail: x.detail ?? "",
    };
  }

  async claimInvoiceForChase(id: string, notChasedSince: string, at: string): Promise<Invoice | undefined> {
    const { sql, vals } = chaseClaimUpdate(id, notChasedSince, at);
    const r = await this.db.query(sql, vals);
    return r.rows[0] ? rowToInvoice(r.rows[0]) : undefined;
  }

  async releaseInvoiceChaseClaim(id: string, claimedAt: string, restoreTo?: string): Promise<boolean> {
    const { sql, vals } = chaseClaimRelease(id, claimedAt, restoreTo);
    const r = await this.db.query(sql, vals);
    return (r.rowCount ?? 0) > 0;
  }

  /**
   * The claim. ONE STATEMENT, and that is the whole guarantee — see `claimRetainerPeriod` in
   * billing.ts. `RETURNING id` yields a row only when the insert actually happened, so `rowCount`
   * distinguishes "we won" from "somebody already has March" with no second query on the winning
   * path. The loser pays one scoped read to say WHICH invoice already covers the period, which is
   * the sentence a founder needs and the reason this is not a bare boolean.
   */
  async claimRetainerPeriod(
    row: Omit<RetainerPeriodRow, "invoice_id">,
  ): Promise<{ claimed: boolean; existing?: RetainerPeriodRow }> {
    if (!row.project_id) throw new Error("a retainer period must be scoped to a project");
    const r = await this.db.query(
      `INSERT INTO invoice_retainer_periods
         (id, project_id, case_id, line_id, period_key, period_end, amount_minor, currency, claimed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (project_id, case_id, line_id, period_key) DO NOTHING
       RETURNING id`,
      [
        randomUUID(),
        row.project_id,
        row.case_id,
        row.line_id,
        row.period_key,
        row.period_end,
        Math.trunc(row.amount_minor),
        row.currency,
        row.claimed_at,
      ],
    );
    if ((r.rowCount ?? 0) > 0) return { claimed: true };
    const existing = await this.db.query(
      `SELECT * FROM invoice_retainer_periods
        WHERE project_id=$1 AND case_id=$2 AND line_id=$3 AND period_key=$4`,
      [row.project_id, row.case_id, row.line_id, row.period_key],
    );
    return { claimed: false, existing: existing.rows[0] ? rowToRetainerPeriod(existing.rows[0]) : undefined };
  }

  async recordRetainerInvoice(args: {
    project_id: string;
    case_id: string;
    line_id: string;
    period_key: string;
    invoice_id: string;
  }): Promise<boolean> {
    const r = await this.db.query(
      `UPDATE invoice_retainer_periods SET invoice_id=$5
        WHERE project_id=$1 AND case_id=$2 AND line_id=$3 AND period_key=$4`,
      [args.project_id, args.case_id, args.line_id, args.period_key, args.invoice_id],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async releaseRetainerPeriod(args: {
    project_id: string;
    case_id: string;
    line_id: string;
    period_key: string;
    claimed_at: string;
  }): Promise<boolean> {
    // Both guards live in the WHERE clause, not in an `if` above it: `claimed_at` proves the claim
    // is ours, `invoice_id IS NULL` proves nobody has billed it since. Deleting a period somebody
    // else has invoiced would let the next sweep raise a second invoice for the same month.
    const r = await this.db.query(
      `DELETE FROM invoice_retainer_periods
        WHERE project_id=$1 AND case_id=$2 AND line_id=$3 AND period_key=$4
          AND claimed_at=$5 AND invoice_id IS NULL`,
      [args.project_id, args.case_id, args.line_id, args.period_key, args.claimed_at],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async listRetainerPeriods(args: {
    project_id: string;
    case_id?: string;
    line_id?: string;
    limit?: number;
  }): Promise<RetainerPeriodRow[]> {
    if (!args.project_id) throw new Error("listing retainer periods must be scoped to a project");
    const vals: unknown[] = [args.project_id];
    const where = ["project_id=$1"];
    if (args.case_id) { vals.push(args.case_id); where.push(`case_id=$${vals.length}`); }
    if (args.line_id) { vals.push(args.line_id); where.push(`line_id=$${vals.length}`); }
    vals.push(Math.max(1, Math.min(500, args.limit ?? 200)));
    const r = await this.db.query(
      `SELECT * FROM invoice_retainer_periods WHERE ${where.join(" AND ")}
        ORDER BY period_key DESC LIMIT $${vals.length}`,
      vals,
    );
    return r.rows.map(rowToRetainerPeriod);
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
