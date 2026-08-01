// Persistence for distilled rules and the observations that measure them.
//
// A separate store rather than more methods on DomainStore, for one reason: DomainStore holds the
// service surface (who the work is for, where it comes from), and every one of its tables is read
// on the hot path of doing a job. This holds the learning loop, which is written on human decisions
// and read once per run. Different lifecycles, different failure tolerance — a distillation write
// that fails must never fail the approval it came from (see knowledge-learn.ts), and that is much
// easier to guarantee when it isn't sharing a transaction with the thing that matters.
//
// TENANCY: `project_id` is NOT NULL on every row and every read takes it as a required argument
// that FAILS CLOSED — an empty project id returns nothing rather than everything. This matches the
// rule `listCases`/`queryRecords` arrived at the hard way: a filter you can forget to apply is a
// leak waiting for a busy afternoon, and rules are the most private thing in the system. They are
// literally a description of how one specific business makes its judgements.
import { randomUUID } from "node:crypto";
import { databaseUrl } from "./config";
import type { NewRule, Rule } from "./knowledge";

/**
 * One human signal, recorded at the moment it happened.
 *
 * This exists because measurement cannot be reconstructed later. "How often was the agent edited
 * last month?" is not answerable from the rules table (which only holds successes) or from the
 * audit chain (which holds the fact of an edit but not the shape of the work). One narrow, append-
 * only table of the events that indicate quality is the cheapest honest answer.
 *
 * Nothing here is the agent's opinion of itself. Every kind is a human decision or a gap the agent
 * reported because it was blocked — see knowledge-metrics.ts.
 */
export interface Observation {
  id: string;
  project_id: string;
  wedge: string;
  task_type: string;
  client_id?: string;
  /**
   * approval_edited   — a human rewrote the action before it went out (the agent got it wrong)
   * approval_clean    — a human approved it unchanged (the agent got it right)
   * approval_rejected — a human refused it outright
   * gap               — the agent proceeded on a stated assumption because it did not know
   * feedback_bad      — a written correction after the fact
   */
  kind: "approval_edited" | "approval_clean" | "approval_rejected" | "gap" | "feedback_bad";
  /** The rule subject this touched, when there is one. Lets a metric be read per rule. */
  subject?: string;
  task_id?: string;
  at: string;
}

export type NewObservation = Omit<Observation, "id" | "at"> & { at?: string };

export interface RuleFilter {
  wedge?: string;
  status?: Rule["status"];
  client_id?: string;
  subject?: string;
}

export interface ObservationFilter {
  wedge?: string;
  task_type?: string;
  /** ISO instant. Observations at or after this. */
  since?: string;
}

export interface KnowledgeStore {
  putRule(r: NewRule | Rule): Promise<Rule>;
  getRule(id: string, projectId: string): Promise<Rule | undefined>;
  listRules(projectId: string, filter?: RuleFilter): Promise<Rule[]>;
  /** Patch a rule in place. Project-scoped so an id from another tenant simply misses. */
  updateRule(
    id: string,
    projectId: string,
    patch: Partial<Pick<Rule, "text" | "kind" | "status" | "superseded_by" | "corroborations" | "corrections_since" | "uses" | "needs_review" | "task_types" | "client_id" | "provenance">>,
  ): Promise<Rule | undefined>;
  /** Increment `corrections_since` for every active rule on a subject. See Rule.corrections_since. */
  noteCorrectionOn(projectId: string, wedge: string, subject: string): Promise<void>;
  /** Increment `uses` for rules that made it into a prompt. Distinguishes "wrong" from "never read". */
  noteUses(projectId: string, ruleIds: string[]): Promise<void>;
  recordObservation(o: NewObservation): Promise<Observation>;
  listObservations(projectId: string, filter?: ObservationFilter): Promise<Observation[]>;
}

const nowIso = () => new Date().toISOString();

const isFullRule = (r: NewRule | Rule): r is Rule => typeof (r as Rule).id === "string";

/** Fill the bookkeeping fields a candidate doesn't carry. Shared so both backends agree. */
export function toRow(r: NewRule | Rule): Rule {
  if (isFullRule(r)) return r;
  const at = nowIso();
  return {
    id: randomUUID(),
    status: "active",
    corroborations: r.corroborations ?? 1,
    corrections_since: 0,
    uses: 0,
    needs_review: r.needs_review ?? false,
    ...r,
    created_at: at,
    updated_at: at,
  };
}

export class InMemoryKnowledgeStore implements KnowledgeStore {
  private rules = new Map<string, Rule>();
  private observations: Observation[] = [];

  async putRule(r: NewRule | Rule): Promise<Rule> {
    const row = toRow(r);
    this.rules.set(row.id, row);
    return { ...row };
  }
  async getRule(id: string, projectId: string): Promise<Rule | undefined> {
    const r = this.rules.get(id);
    // Fail closed: no project named, no row — never "well, it had no owner, so anyone can have it".
    return r && projectId && r.project_id === projectId ? { ...r } : undefined;
  }
  async listRules(projectId: string, filter: RuleFilter = {}): Promise<Rule[]> {
    if (!projectId) return [];
    return [...this.rules.values()]
      .filter(
        (r) =>
          r.project_id === projectId &&
          (filter.wedge === undefined || r.wedge === filter.wedge) &&
          (filter.status === undefined || r.status === filter.status) &&
          (filter.subject === undefined || r.subject === filter.subject) &&
          (filter.client_id === undefined || r.client_id === filter.client_id),
      )
      .map((r) => ({ ...r }))
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }
  async updateRule(id: string, projectId: string, patch: Parameters<KnowledgeStore["updateRule"]>[2]): Promise<Rule | undefined> {
    const r = this.rules.get(id);
    if (!r || !projectId || r.project_id !== projectId) return undefined;
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) (r as unknown as Record<string, unknown>)[k] = v;
    r.updated_at = nowIso();
    return { ...r };
  }
  async noteCorrectionOn(projectId: string, wedge: string, subject: string): Promise<void> {
    if (!projectId) return;
    for (const r of this.rules.values()) {
      if (r.project_id === projectId && r.wedge === wedge && r.subject === subject && r.status === "active") {
        r.corrections_since += 1;
      }
    }
  }
  async noteUses(projectId: string, ruleIds: string[]): Promise<void> {
    if (!projectId) return;
    for (const id of ruleIds) {
      const r = this.rules.get(id);
      if (r && r.project_id === projectId) r.uses += 1;
    }
  }
  async recordObservation(o: NewObservation): Promise<Observation> {
    const row: Observation = { ...o, id: randomUUID(), at: o.at ?? nowIso() };
    this.observations.push(row);
    return { ...row };
  }
  async listObservations(projectId: string, filter: ObservationFilter = {}): Promise<Observation[]> {
    if (!projectId) return [];
    return this.observations
      .filter(
        (o) =>
          o.project_id === projectId &&
          (filter.wedge === undefined || o.wedge === filter.wedge) &&
          (filter.task_type === undefined || o.task_type === filter.task_type) &&
          (filter.since === undefined || o.at >= filter.since),
      )
      .map((o) => ({ ...o }));
  }
}

// Process-wide singleton, matching domain.ts: the server, the runtime and the learning hooks all
// need the same store and threading it through every call site would mean touching every module
// this feature deliberately stays out of.
let cached: KnowledgeStore | null = null;

export function getKnowledgeStore(): KnowledgeStore {
  if (!cached) cached = new InMemoryKnowledgeStore();
  return cached;
}

/** Boot-time backend selection: Postgres when MYCEL_DATABASE_URL is set, else in-memory. */
export async function initKnowledgeStore(): Promise<{ backend: "postgres" | "memory" }> {
  const url = databaseUrl();
  if (!url) {
    cached = new InMemoryKnowledgeStore();
    return { backend: "memory" };
  }
  // The Postgres backend is not written yet.
  //
  // Failing loudly here is deliberate. The alternative — quietly falling back to the in-memory
  // store when a database IS configured — gives a process that accepts writes, answers reads
  // correctly for its own lifetime, and loses everything on the next deploy. For invoices that is
  // money; for distilled knowledge it is the founder's corrections. Both are the kind of loss you
  // discover weeks later with no way to reconstruct it.
  //
  // In-memory remains the correct backend when no database is configured at all, which is dev and
  // the test suite.
  throw new Error(
    "knowledge: MYCEL_DATABASE_URL is set but the Postgres knowledge store is not implemented yet. " +
      "Refusing to start rather than lose distilled rules on restart.",
  );
}

/** Tests and shutdown. */
export function resetKnowledgeStore(store?: KnowledgeStore): void {
  cached = store ?? null;
}
