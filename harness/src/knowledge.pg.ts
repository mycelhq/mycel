// Durable Postgres backing for distilled rules and the observations that measure them. Mirrors
// store.pg.ts / domain.pg.ts: raw SQL, tables created on connect under the schema lock, one shared
// pool. Selected automatically when MYCEL_DATABASE_URL is set.
//
// What is being protected here is not throughput, it is the founder's corrections. A rule is the
// residue of a human taking the time to fix the agent; losing the table on a deploy means the system
// silently un-learns and the same correction has to be made again, which is the fastest way to make
// someone stop bothering.
//
// TENANCY: every read takes `projectId` as a required argument and FAILS CLOSED — see the header of
// knowledge.store.ts. In SQL that is `project_id=$1`, which matches no NULL and no other tenant. An
// empty project id returns nothing rather than everything, and that is checked in JS before the
// query as well, so the fail-closed behaviour does not depend on the column staying NOT NULL.
import pg from "pg";
import { getPool } from "./pool";
import { withSchemaLock } from "./schema-lock";
import type { Rule, NewRule, RuleKind, RuleProvenance } from "./knowledge";
import { toRow } from "./knowledge.store";
import type {
  KnowledgeStore,
  NewObservation,
  Observation,
  ObservationFilter,
  ImprovementFilter,
  RuleFilter,
} from "./knowledge.store";
import type { ImprovementProposal, ImprovementStatus, NewImprovementProposal } from "./improvement";
import type { Queryable } from "./billing.pg";

const iso = (v: unknown) => new Date(v as string).toISOString();

/**
 * The schema.
 *
 * `id` is `text`, not `uuid`, for the same reason as invoices: rule ids reach `getRule` straight
 * from a URL and `WHERE id=$1` against a `uuid` column raises 22P02 on a malformed one — a 500 where
 * the in-memory store returns undefined. `knowledge_gaps` in domain.pg.ts already uses `text` ids.
 *
 * `task_types` is jsonb rather than `text[]` so it round-trips through node-pg as the plain JS array
 * the contract declares, with no array-literal quoting to get wrong.
 *
 * The counters (`corroborations`, `corrections_since`, `uses`) are NOT NULL with defaults so that
 * `col = col + 1` can never turn a row into NULL — an increment against NULL is NULL, which would
 * quietly erase a rule's entire measurement history on its first update.
 */
async function initSchema(pool: pg.Pool): Promise<void> {
  // Serialised across processes: `CREATE TABLE IF NOT EXISTS` is not concurrency-safe, and
  // four kernel containers boot together on every deploy. See schema-lock.ts.
  await withSchemaLock(pool, async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS rules (
        id text PRIMARY KEY,
        project_id text NOT NULL,
        wedge text NOT NULL,
        client_id text,
        sensitivity text,
        task_types jsonb NOT NULL DEFAULT '[]',
        subject text NOT NULL,
        text text NOT NULL,
        kind text NOT NULL,
        status text NOT NULL DEFAULT 'active',
        superseded_by text,
        corroborations int NOT NULL DEFAULT 1,
        corrections_since int NOT NULL DEFAULT 0,
        uses int NOT NULL DEFAULT 0,
        needs_review boolean NOT NULL DEFAULT false,
        provenance jsonb NOT NULL DEFAULT '{}',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      -- Added after the table shipped. Deliberately NULLable with no default: a pre-existing row is
      -- legacy and unlabelled, and ruleSensitivityOf reads that as client-sensitive -- dark until
      -- something says whose lesson it was. Backfilling it to house would re-open the leak by SQL.
      ALTER TABLE rules ADD COLUMN IF NOT EXISTS sensitivity text;
      -- Retrieval is always (project, wedge) and usually active-only: that is the prompt-assembly
      -- read, on the hot path of every run.
      CREATE INDEX IF NOT EXISTS rules_scope_idx ON rules (project_id, wedge, status);
      -- noteCorrectionOn updates every active rule on one subject. Without this it is a scan of
      -- the whole table on a human decision, which is the moment you least want to be slow.
      CREATE INDEX IF NOT EXISTS rules_subject_idx ON rules (project_id, wedge, subject);
      -- Append-only. Nothing updates a row here: an observation is what happened, and rewriting
      -- history is how a quality metric stops being a measurement.
      CREATE TABLE IF NOT EXISTS observations (
        id text PRIMARY KEY,
        project_id text NOT NULL,
        wedge text NOT NULL,
        task_type text NOT NULL,
        client_id text,
        kind text NOT NULL,
        subject text,
        task_id text,
        at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS observations_scope_idx ON observations (project_id, wedge, at DESC);
      CREATE TABLE IF NOT EXISTS improvement_proposals (
        id text PRIMARY KEY,
        project_id text NOT NULL,
        wedge text NOT NULL,
        task_id text NOT NULL,
        task_type text NOT NULL,
        target text NOT NULL,
        title text NOT NULL,
        summary text NOT NULL,
        proposed_change text NOT NULL,
        evidence jsonb NOT NULL DEFAULT '[]',
        confidence text NOT NULL,
        status text NOT NULL DEFAULT 'proposed',
        metadata jsonb NOT NULL DEFAULT '{}',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS improvement_scope_idx ON improvement_proposals (project_id, status, created_at DESC);
    `);
  });
}

/** The rules insert column list. Exported with `ruleValues` so a test can round-trip a row without a database. */
export const RULE_COLUMNS = [
  "id", "project_id", "wedge", "client_id", "sensitivity", "task_types", "subject", "text", "kind", "status",
  "superseded_by", "corroborations", "corrections_since", "uses", "needs_review", "provenance",
  "created_at", "updated_at",
] as const;

export function ruleValues(r: Rule): unknown[] {
  return [
    r.id,
    r.project_id,
    r.wedge,
    r.client_id ?? null,
    r.sensitivity ?? null,
    JSON.stringify(r.task_types ?? []),
    r.subject,
    r.text,
    r.kind,
    r.status,
    r.superseded_by ?? null,
    r.corroborations,
    r.corrections_since,
    r.uses,
    r.needs_review,
    JSON.stringify(r.provenance ?? {}),
    r.created_at,
    r.updated_at,
  ];
}

export function rowToRule(r: any): Rule {
  return {
    id: r.id,
    project_id: r.project_id,
    wedge: r.wedge,
    client_id: r.client_id ?? undefined,
    // Left undefined when the column is NULL rather than defaulted here: `ruleSensitivityOf` owns
    // the fail-closed reading, and a default applied at the row mapper would be a second opinion.
    sensitivity: r.sensitivity ?? undefined,
    task_types: (r.task_types ?? []) as string[],
    subject: r.subject,
    text: r.text,
    kind: r.kind as RuleKind,
    status: r.status as Rule["status"],
    superseded_by: r.superseded_by ?? undefined,
    // Counters are `int`, which node-pg already returns as a number; `Number` is belt and braces
    // for the day one of them is widened to bigint and starts arriving as a string.
    corroborations: Number(r.corroborations ?? 0),
    corrections_since: Number(r.corrections_since ?? 0),
    uses: Number(r.uses ?? 0),
    needs_review: !!r.needs_review,
    provenance: (r.provenance ?? {}) as RuleProvenance,
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
  };
}

export function rowToObservation(r: any): Observation {
  return {
    id: r.id,
    project_id: r.project_id,
    wedge: r.wedge,
    task_type: r.task_type,
    client_id: r.client_id ?? undefined,
    kind: r.kind as Observation["kind"],
    subject: r.subject ?? undefined,
    task_id: r.task_id ?? undefined,
    at: iso(r.at),
  };
}

export function rowToImprovement(r: any): ImprovementProposal {
  return {
    id: r.id,
    project_id: r.project_id,
    wedge: r.wedge,
    task_id: r.task_id,
    task_type: r.task_type,
    target: r.target,
    title: r.title,
    summary: r.summary,
    proposed_change: r.proposed_change,
    evidence: Array.isArray(r.evidence) ? r.evidence : [],
    confidence: r.confidence,
    status: r.status,
    metadata: r.metadata ?? {},
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
  };
}

/**
 * The rule list filter.
 *
 * `projectId` is a positional argument, not part of the filter object, so it cannot be forgotten —
 * and it is bound as `$1` before anything else is considered. The optional filters use
 * `!== undefined` rather than truthiness, matching `InMemoryKnowledgeStore.listRules` exactly: an
 * empty-string `client_id` means "rules with no client scope", not "don't filter by client".
 */
export function ruleWhere(projectId: string, f: RuleFilter): { clause: string; vals: unknown[] } {
  const vals: unknown[] = [projectId];
  const where: string[] = ["project_id=$1"];
  for (const [col, val] of [
    ["wedge", f.wedge], ["status", f.status], ["subject", f.subject], ["client_id", f.client_id],
  ] as const) {
    if (val !== undefined) { vals.push(val); where.push(`${col}=$${vals.length}`); }
  }
  return { clause: "WHERE " + where.join(" AND "), vals };
}

export function observationWhere(projectId: string, f: ObservationFilter): { clause: string; vals: unknown[] } {
  const vals: unknown[] = [projectId];
  const where: string[] = ["project_id=$1"];
  if (f.wedge !== undefined) { vals.push(f.wedge); where.push(`wedge=$${vals.length}`); }
  if (f.task_type !== undefined) { vals.push(f.task_type); where.push(`task_type=$${vals.length}`); }
  // `>=`, inclusive, matching the in-memory `o.at >= filter.since`. Compared as a timestamp rather
  // than as a string so an offset-bearing ISO instant orders correctly against a Z-suffixed one.
  if (f.since !== undefined) { vals.push(f.since); where.push(`at >= $${vals.length}::timestamptz`); }
  return { clause: "WHERE " + where.join(" AND "), vals };
}

/**
 * The patchable columns of a rule, as an allowlist.
 *
 * Fixed table, never `Object.entries(patch)`: the patch can originate from a request body, and
 * iterating caller keys into `SET ${k}=...` is a SQL-injection primitive. `project_id`, `wedge` and
 * `subject` are deliberately absent — moving a rule to another tenant or another subject is not an
 * edit, it is a new rule, and allowing it here would make the tenancy filter above meaningless.
 */
const PATCHABLE = [
  ["text", null],
  ["kind", null],
  ["status", null],
  ["superseded_by", null],
  ["corroborations", null],
  ["corrections_since", null],
  ["uses", null],
  ["needs_review", null],
  ["task_types", "jsonb"],
  ["client_id", null],
  ["provenance", "jsonb"],
] as const;

export function rulePatchSql(patch: Parameters<KnowledgeStore["updateRule"]>[2]): {
  sets: string[];
  vals: unknown[];
} {
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [col, cast] of PATCHABLE) {
    const val = (patch as Record<string, unknown>)[col];
    if (val === undefined) continue;
    vals.push(cast === "jsonb" ? JSON.stringify(val) : val);
    sets.push(`${col}=$${vals.length}${cast ? `::${cast}` : ""}`);
  }
  return { sets, vals };
}

export class PostgresKnowledgeStore implements KnowledgeStore {
  private constructor(private db: Queryable) {}

  static async connect(url: string): Promise<PostgresKnowledgeStore> {
    const pool = getPool(url);
    await initSchema(pool);
    return new PostgresKnowledgeStore(pool);
  }

  /** Test seam — see PostgresBillingStore._withQueryable. */
  static _withQueryable(db: Queryable): PostgresKnowledgeStore {
    return new PostgresKnowledgeStore(db);
  }

  /**
   * Insert or replace a rule.
   *
   * `toRow` is imported from knowledge.store.ts rather than reimplemented, so both backends fill the
   * bookkeeping fields of a candidate identically — a second copy of those defaults is a divergence
   * waiting to happen.
   *
   * The `WHERE rules.project_id = EXCLUDED.project_id` on the conflict branch is a deliberate
   * departure from the in-memory store, which would let a caller-supplied id overwrite another
   * tenant's rule outright. Ids are ours and collisions are not expected; if one ever happens across
   * projects this refuses rather than silently rewriting someone else's judgement, and says so.
   */
  async putRule(r: NewRule | Rule): Promise<Rule> {
    const row = toRow(r);
    const cols = RULE_COLUMNS.join(", ");
    const placeholders = RULE_COLUMNS.map((_, n) => `$${n + 1}`).join(",");
    const updates = RULE_COLUMNS.filter((c) => c !== "id" && c !== "created_at")
      .map((c) => `${c} = EXCLUDED.${c}`)
      .join(", ");
    const res = await this.db.query(
      `INSERT INTO rules (${cols}) VALUES (${placeholders})
       ON CONFLICT (id) DO UPDATE SET ${updates}
       WHERE rules.project_id = EXCLUDED.project_id
       RETURNING *`,
      ruleValues(row),
    );
    if (!res.rows[0]) {
      throw new Error(`putRule: rule id ${row.id} already exists under a different project`);
    }
    return rowToRule(res.rows[0]);
  }

  async getRule(id: string, projectId: string): Promise<Rule | undefined> {
    // Fail closed: no project named, no row. Never "it had no owner, so anyone can have it".
    if (!projectId) return undefined;
    const r = await this.db.query(`SELECT * FROM rules WHERE id=$1 AND project_id=$2`, [id, projectId]);
    return r.rows[0] ? rowToRule(r.rows[0]) : undefined;
  }

  async listRules(projectId: string, filter: RuleFilter = {}): Promise<Rule[]> {
    if (!projectId) return [];
    const { clause, vals } = ruleWhere(projectId, filter);
    // Oldest first, matching the in-memory sort: the distiller reads these as a history, and
    // "which answer came later" is the question supersession turns on.
    const r = await this.db.query(`SELECT * FROM rules ${clause} ORDER BY created_at`, vals);
    return r.rows.map(rowToRule);
  }

  async updateRule(
    id: string,
    projectId: string,
    patch: Parameters<KnowledgeStore["updateRule"]>[2],
  ): Promise<Rule | undefined> {
    if (!projectId) return undefined;
    const { sets, vals } = rulePatchSql(patch);
    // The tenant predicate is part of the same statement, so an id from another project simply
    // updates nothing — there is no window in which the row is read, then written.
    vals.push(id, projectId);
    const r = await this.db.query(
      `UPDATE rules SET ${[...sets, "updated_at=now()"].join(", ")}
       WHERE id=$${vals.length - 1} AND project_id=$${vals.length} RETURNING *`,
      vals,
    );
    return r.rows[0] ? rowToRule(r.rows[0]) : undefined;
  }

  /**
   * Increment `corrections_since` for every active rule on a subject.
   *
   * `corrections_since = corrections_since + 1` in SQL, never read-modify-write: this fires on a
   * human decision, several of which can land in the same second from different workers, and a lost
   * increment makes a rule look like it is working when it is not. Same reasoning as
   * `DomainStore.bumpPacing`.
   *
   * `updated_at` is deliberately NOT bumped. It means "when was this rule last edited"; a correction
   * elsewhere is evidence about the rule, not a change to it.
   */
  async noteCorrectionOn(projectId: string, wedge: string, subject: string): Promise<void> {
    if (!projectId) return;
    await this.db.query(
      `UPDATE rules SET corrections_since = corrections_since + 1
       WHERE project_id=$1 AND wedge=$2 AND subject=$3 AND status='active'`,
      [projectId, wedge, subject],
    );
  }

  /** Increment `uses`. One statement for the whole batch, and the same lost-update reasoning. */
  async noteUses(projectId: string, ruleIds: string[]): Promise<void> {
    if (!projectId || !ruleIds.length) return; // an empty list must not become an unfiltered UPDATE
    await this.db.query(
      `UPDATE rules SET uses = uses + 1 WHERE project_id=$1 AND id = ANY($2::text[])`,
      [projectId, ruleIds],
    );
  }

  async recordObservation(o: NewObservation): Promise<Observation> {
    const r = await this.db.query(
      `INSERT INTO observations (id, project_id, wedge, task_type, client_id, kind, subject, task_id, at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [
        crypto.randomUUID(), o.project_id, o.wedge, o.task_type, o.client_id ?? null,
        o.kind, o.subject ?? null, o.task_id ?? null, o.at ?? new Date().toISOString(),
      ],
    );
    return rowToObservation(r.rows[0]);
  }

  async listObservations(projectId: string, filter: ObservationFilter = {}): Promise<Observation[]> {
    if (!projectId) return [];
    const { clause, vals } = observationWhere(projectId, filter);
    const r = await this.db.query(`SELECT * FROM observations ${clause} ORDER BY at`, vals);
    return r.rows.map(rowToObservation);
  }

  async createImprovementProposal(p: NewImprovementProposal): Promise<ImprovementProposal> {
    const r = await this.db.query(
      `INSERT INTO improvement_proposals
        (id, project_id, wedge, task_id, task_type, target, title, summary, proposed_change, evidence, confidence, status, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,'proposed',$12::jsonb) RETURNING *`,
      [p.id, p.project_id, p.wedge, p.task_id, p.task_type, p.target, p.title, p.summary, p.proposed_change,
        JSON.stringify(p.evidence), p.confidence, JSON.stringify(p.metadata ?? {})],
    );
    return rowToImprovement(r.rows[0]);
  }

  async getImprovementProposal(id: string, projectId: string): Promise<ImprovementProposal | undefined> {
    if (!projectId) return undefined;
    const r = await this.db.query(
      `SELECT * FROM improvement_proposals WHERE id=$1 AND project_id=$2`,
      [id, projectId],
    );
    return r.rows[0] ? rowToImprovement(r.rows[0]) : undefined;
  }

  async listImprovementProposals(projectId: string, filter: ImprovementFilter = {}): Promise<ImprovementProposal[]> {
    if (!projectId) return [];
    const values: unknown[] = [projectId];
    const where = ["project_id=$1"];
    for (const [column, value] of [["wedge", filter.wedge], ["status", filter.status], ["target", filter.target]] as const) {
      if (value !== undefined) { values.push(value); where.push(`${column}=$${values.length}`); }
    }
    values.push(Math.max(1, Math.min(filter.limit ?? 100, 500)));
    const r = await this.db.query(
      `SELECT * FROM improvement_proposals WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT $${values.length}`,
      values,
    );
    return r.rows.map(rowToImprovement);
  }

  async setImprovementProposalStatus(id: string, projectId: string, status: ImprovementStatus): Promise<ImprovementProposal | undefined> {
    if (!projectId) return undefined;
    const r = await this.db.query(
      `UPDATE improvement_proposals SET status=$1, updated_at=now() WHERE id=$2 AND project_id=$3 RETURNING *`,
      [status, id, projectId],
    );
    return r.rows[0] ? rowToImprovement(r.rows[0]) : undefined;
  }

  async close(): Promise<void> {
    // No-op: the pool is shared process-wide. See pool.ts — the first store to end
    // it would close the connections every other store is still using. Shutdown calls
    // closeAllPools() once.
  }
}
