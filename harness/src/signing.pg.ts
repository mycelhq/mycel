// Durable signature envelopes.
//
// Every other store in this repo treats the database as "the copy that matters" and the in-process
// map as a cache. Here the difference is sharper than usual, and worth saying once: a session that
// only existed on the replica which minted it is an inconvenience — the customer clicks the link
// again. A SIGNATURE that only existed on the replica which took the request is gone, and there is
// no version of asking somebody to sign a contract a second time that is not a bad conversation.
//
// So the envelope is written on every transition, not just at the end. A partially-signed envelope
// is itself evidence: it says one party has committed and the other has not, which is the state a
// chase is about.
//
// The signers array is stored as jsonb rather than as a second table. It is small, it is always
// read whole, and it is never queried by a field inside it — and the alternative would put the
// signing evidence one join away from the envelope it belongs to, which is the wrong shape for a
// record whose entire job is to be read as one document years later.
import pg from "pg";
import { getPool } from "./pool";
import { withSchemaLock } from "./schema-lock";
import type { Envelope } from "./signing";

interface Row {
  id: string;
  revision: number | null;
  supersedes: string | null;
  superseded_by: string | null;
  change_requested: Envelope["change_requested"] | null;
  terms: Envelope["terms"] | null;
  project_id: string;
  client_id: string | null;
  case_id: string | null;
  title: string;
  document: Envelope["document"];
  signers: Envelope["signers"];
  status: Envelope["status"];
  created_at: string;
  sent_at: string | null;
  completed_at: string | null;
  expires_at: string;
  voided_reason: string | null;
  on_execute: Envelope["on_execute"] | null;
}

const toEnvelope = (r: Row): Envelope => ({
  id: r.id,
  project_id: r.project_id,
  ...(r.client_id ? { client_id: r.client_id } : {}),
  ...(r.case_id ? { case_id: r.case_id } : {}),
  title: r.title,
  // Rows written before revisions existed carry no number. They are all first attempts by
  // definition, so 1 is the truth here rather than a default.
  revision: r.revision ?? 1,
  ...(r.supersedes ? { supersedes: r.supersedes } : {}),
  ...(r.superseded_by ? { superseded_by: r.superseded_by } : {}),
  ...(r.change_requested ? { change_requested: r.change_requested } : {}),
  ...(r.terms ? { terms: r.terms } : {}),
  document: r.document,
  signers: r.signers,
  status: r.status,
  created_at: r.created_at,
  ...(r.sent_at ? { sent_at: r.sent_at } : {}),
  ...(r.completed_at ? { completed_at: r.completed_at } : {}),
  expires_at: r.expires_at,
  ...(r.voided_reason ? { voided_reason: r.voided_reason } : {}),
  ...(r.on_execute ? { on_execute: r.on_execute } : {}),
});

export class SigningPg {
  private constructor(private pool: pg.Pool) {}

  static async connect(url: string): Promise<SigningPg> {
    const pool = getPool(url);
    const self = new SigningPg(pool);
    // Serialised across processes: `CREATE TABLE IF NOT EXISTS` is not concurrency-safe and the
    // kernel containers boot together on every deploy. See schema-lock.ts.
    await withSchemaLock(pool, async (client) => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS signature_envelopes (
          id text PRIMARY KEY,
          project_id text NOT NULL,
          client_id text,
          case_id text,
          title text NOT NULL,
          document jsonb NOT NULL,
          signers jsonb NOT NULL,
          status text NOT NULL,
          created_at text NOT NULL,
          sent_at text,
          completed_at text,
          expires_at text NOT NULL,
          voided_reason text,
          on_execute jsonb
        )
      `);
      // ALTERs rather than a CREATE change: the table already exists in every environment that has
      // ever run this, and four nullable columns are cheaper than a migration framework.
      for (const col of ["revision int", "supersedes text", "superseded_by text", "change_requested jsonb", "terms jsonb"]) {
        await client.query(`ALTER TABLE signature_envelopes ADD COLUMN IF NOT EXISTS ${col}`);
      }
      await client.query(
        `CREATE INDEX IF NOT EXISTS signature_envelopes_project_idx ON signature_envelopes (project_id, created_at DESC)`,
      );
      // The chain is walked forward from a superseded envelope, so the lookup is by predecessor.
      await client.query(
        `CREATE INDEX IF NOT EXISTS signature_envelopes_supersedes_idx ON signature_envelopes (supersedes)`,
      );
      // The sweep reads by status and date across every project; without this it is a full scan on
      // a table that only ever grows, because an executed contract is never deleted.
      await client.query(
        `CREATE INDEX IF NOT EXISTS signature_envelopes_open_idx ON signature_envelopes (status, expires_at)`,
      );
    });
    return self;
  }

  async put(e: Envelope): Promise<void> {
    await this.pool.query(
      `INSERT INTO signature_envelopes
         (id, project_id, client_id, case_id, title, document, signers, status,
          created_at, sent_at, completed_at, expires_at, voided_reason, on_execute,
          revision, supersedes, superseded_by, change_requested, terms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       ON CONFLICT (id) DO UPDATE SET
         document = EXCLUDED.document,
         signers = EXCLUDED.signers,
         status = EXCLUDED.status,
         sent_at = EXCLUDED.sent_at,
         completed_at = EXCLUDED.completed_at,
         expires_at = EXCLUDED.expires_at,
         voided_reason = EXCLUDED.voided_reason,
         on_execute = EXCLUDED.on_execute,
         change_requested = EXCLUDED.change_requested,
         terms = EXCLUDED.terms
       -- AN EXECUTED AGREEMENT IS FINAL, IN THE DATABASE AND NOT ONLY IN THE CODE.
       --
       -- signing.ts refuses every transition out of a terminal status, and that is the check that
       -- produces a good error message. This is the one that holds when a future route, a repair
       -- script or a migration forgets to ask. The cost of getting it wrong is a contract that
       -- silently stopped being executed, which is not a class of bug worth trusting one layer for.
       WHERE signature_envelopes.status NOT IN ('executed','declined','voided','expired')`,
      [
        e.id,
        e.project_id,
        e.client_id ?? null,
        e.case_id ?? null,
        e.title,
        JSON.stringify(e.document),
        JSON.stringify(e.signers),
        e.status,
        e.created_at,
        e.sent_at ?? null,
        e.completed_at ?? null,
        e.expires_at,
        e.voided_reason ?? null,
        e.on_execute ? JSON.stringify(e.on_execute) : null,
        e.revision,
        e.supersedes ?? null,
        e.superseded_by ?? null,
        e.change_requested ? JSON.stringify(e.change_requested) : null,
        e.terms ? JSON.stringify(e.terms) : null,
      ],
    );
  }

  /**
   * The ONE field that may be written to a terminal row.
   *
   * `put` refuses to update an executed, declined, voided or expired envelope — that guard is what
   * makes a settled agreement settled in the database as well as in the code. But a revision has to
   * point BACK at the closed envelope it replaced, or the chain is only walkable in one direction
   * and the certificate cannot show a negotiation that ended in a decline.
   *
   * So the link gets its own statement, naming the one column it may touch. A guard with an
   * exception written into it is a guard with a hole; a guard plus a named, minimal escape is two
   * things a reader can check.
   */
  async linkSuccessor(previousId: string, successorId: string): Promise<void> {
    await this.pool.query(`UPDATE signature_envelopes SET superseded_by = $2 WHERE id = $1`, [previousId, successorId]);
  }

  async get(id: string): Promise<Envelope | undefined> {
    const { rows } = await this.pool.query<Row>(`SELECT * FROM signature_envelopes WHERE id = $1`, [id]);
    return rows[0] ? toEnvelope(rows[0]) : undefined;
  }

  async list(projectId: string): Promise<Envelope[]> {
    const { rows } = await this.pool.query<Row>(
      `SELECT * FROM signature_envelopes WHERE project_id = $1 ORDER BY created_at DESC LIMIT 500`,
      [projectId],
    );
    return rows.map(toEnvelope);
  }

  /**
   * Every open envelope past its date, across all projects. The one query in this file that is not
   * scoped to a project, because expiry is not somebody's request — it is a clock.
   *
   * `signature_envelopes_open_idx` is exactly this predicate; it was created for a sweep that then
   * spent months not existing. Bounded, because a first run after a long gap could otherwise load
   * the entire backlog into memory at once, and the sweep repeats on an interval anyway.
   *
   * `expires_at` is text holding ISO-8601, which sorts correctly as a string only while every value
   * is UTC with the same precision — they are, `new Date().toISOString()` at both write sites.
   */
  async dueForExpiry(nowIso: string, limit = 500): Promise<Envelope[]> {
    const { rows } = await this.pool.query<Row>(
      `SELECT * FROM signature_envelopes
        WHERE status IN ('sent', 'partially_signed') AND expires_at <= $1
        ORDER BY expires_at ASC LIMIT $2`,
      [nowIso, limit],
    );
    return rows.map(toEnvelope);
  }

  async close(): Promise<void> {
    // The pool is shared (pool.ts); closing it here would take every other store down with it.
  }
}
