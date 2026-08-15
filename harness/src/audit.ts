// Tamper-evident audit log.
//
// The event stream already tells you what a task did. This is different: it's the legally
// interesting subset — who approved what, which action actually executed, whose secret changed —
// recorded as a HASH CHAIN. Each entry embeds the hash of the previous one, so editing or deleting
// history breaks the chain and `verify()` reports exactly where. You cannot quietly rewrite what
// the AI was authorised to do.
//
// Deliberately narrow: consequential decisions only, not every token. A regulated wedge
// (bookkeeping, legal, healthcare) needs this to be usable as evidence; noise would ruin that.
import { databaseUrl } from "./config";
import { createHash } from "node:crypto";

export type AuditAction =
  | "approval.granted"
  | "approval.rejected"
  | "approval.auto_approved"
  | "approval.expired"
  | "action.executed"
  | "secret.written"
  | "secret.deleted"
  | "case.stage_changed"
  | "case.closed"
  | "policy.envelope_used"
  /**
   * A founder decided, in advance, that a class of routine action no longer stops at a person.
   *
   * On the chain, and not negotiably. A standing grant is the only mechanism in this product by
   * which something reaches a client without a human looking at it in the moment, so "who decided
   * that, on what day, and when did they take it back" has to be answerable from the tamper-evident
   * record rather than from a mutable row that only knows what is true now. The grant document is
   * revocable and a revocation rewrites it; these two entries are what survive it.
   */
  | "standing.granted"
  | "standing.revoked"
  | "project.created"
  /** An external account was linked through a broker (Composio OAuth). Never records the token. */
  | "connection.linked"
  /** A portal link was minted for a client. Never records the token itself. */
  | "client.portal_link"
  // Standing permission for an outside system to start work here. Worth a chain entry for the same
  // reason a linked account is: it is a durable capability someone granted on a particular day, so
  // "why did this run at 2am" has an answer that predates the run by weeks.
  | "trigger.subscribed"
  | "trigger.unsubscribed"
  // Where a business answers is a security-relevant fact: it decides whose certificate serves whose
  // customers. Both halves are recorded — the claim and the proof — so "who pointed this domain
  // here, and when did it check out" has an answer.
  | "domain.claimed"
  | "domain.verified"
  /**
   * A tenant got a mailbox, or a sending domain was registered for one.
   *
   * On the chain for the same reason `domain.claimed` is, and arguably a stronger one: a mailbox is a
   * SENDING IDENTITY. "Who gave this project the ability to send as billing@acme.com, and on what
   * day" has real consequences — an identity created in the wrong project is one business able to
   * write to another's clients under their name — and the connection row cannot answer it, because it
   * records what is true now and not who made it true.
   */
  | "agentmail.inbox_provisioned"
  | "agentmail.domain_registered"
  /**
   * What an org is entitled to changed. Recorded because entitlement is the one fact in the system
   * whose history nobody can reconstruct afterwards: Stripe knows what it charged, and the org row
   * knows what it is now, and neither of them can answer "what were they on last Tuesday, and what
   * told us to change it". A trial that expired, a card that failed and a plan somebody was moved
   * to by hand are indistinguishable from each other once the row has been overwritten.
   */
  | "org.plan_changed"
  /**
   * A session was minted for an account with no ceilings.
   *
   * The one entry that exists purely so that a privilege is not invisible. See `issue()` in
   * identity.ts for why it is recorded per sign-in rather than per limit check.
   */
  | "superadmin.session";

export interface AuditEntry {
  seq: number;
  project_id: string;
  at: string;
  /** member id, "agent", "system", or "policy" — who caused this. */
  actor: string;
  action: AuditAction;
  /** What it happened to: "task"/"case"/"connection"/… + its id. */
  entity: string;
  entity_id: string;
  /** Small, non-secret detail. NEVER put secret material here. */
  detail: Record<string, unknown>;
  prev_hash: string;
  hash: string;
}

export const GENESIS = "0".repeat(64);

/**
 * Canonical JSON: object keys sorted, recursively. This is load-bearing.
 *
 * Postgres `jsonb` does NOT preserve key insertion order — `{a,b}` can come back as `{b,a}`. Hashing
 * raw `JSON.stringify` therefore made every persisted chain verify as TAMPERED, which is worse than
 * having no audit log at all (an alarm that always fires gets ignored). A content hash must not
 * depend on key order.
 */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(",")}}`;
}

/** The chain link. Any change to any field changes the hash, and every later hash with it. */
export function entryHash(e: Omit<AuditEntry, "hash">): string {
  return createHash("sha256")
    .update(
      canonical([e.seq, e.project_id, e.at, e.actor, e.action, e.entity, e.entity_id, e.detail, e.prev_hash]),
    )
    .digest("hex");
}

export interface VerifyResult {
  ok: boolean;
  entries: number;
  /** The seq of the first entry whose hash doesn't reconcile, if any. */
  broken_at?: number;
  reason?: string;
}

/** Recompute the chain. Detects edited fields, deleted rows (seq gaps), and reordering. */
export function verifyChain(entries: AuditEntry[]): VerifyResult {
  let prev = GENESIS;
  let expectedSeq = 1;
  for (const e of entries) {
    if (e.seq !== expectedSeq) {
      return { ok: false, entries: entries.length, broken_at: e.seq, reason: `sequence gap: expected ${expectedSeq}, found ${e.seq} (an entry was deleted or reordered)` };
    }
    if (e.prev_hash !== prev) {
      return { ok: false, entries: entries.length, broken_at: e.seq, reason: "prev_hash does not match the previous entry's hash" };
    }
    if (entryHash(e) !== e.hash) {
      return { ok: false, entries: entries.length, broken_at: e.seq, reason: "entry hash does not match its contents (a field was modified)" };
    }
    prev = e.hash;
    expectedSeq++;
  }
  return { ok: true, entries: entries.length };
}

export interface AuditStore {
  append(e: Omit<AuditEntry, "seq" | "prev_hash" | "hash" | "at"> & { at?: string }): Promise<AuditEntry>;
  list(projectId: string, limit?: number): Promise<AuditEntry[]>;
  close?(): Promise<void>;
}

class MemoryAuditStore implements AuditStore {
  private byProject = new Map<string, AuditEntry[]>();
  async append(e: Omit<AuditEntry, "seq" | "prev_hash" | "hash" | "at"> & { at?: string }): Promise<AuditEntry> {
    const chain = this.byProject.get(e.project_id) ?? [];
    const prev = chain.at(-1);
    const base = {
      seq: (prev?.seq ?? 0) + 1,
      project_id: e.project_id,
      at: e.at ?? new Date().toISOString(),
      actor: e.actor,
      action: e.action,
      entity: e.entity,
      entity_id: e.entity_id,
      detail: e.detail ?? {},
      prev_hash: prev?.hash ?? GENESIS,
    };
    const entry: AuditEntry = { ...base, hash: entryHash(base) };
    chain.push(entry);
    this.byProject.set(e.project_id, chain);
    return entry;
  }
  async list(projectId: string, limit = 500): Promise<AuditEntry[]> {
    return (this.byProject.get(projectId) ?? []).slice(0, limit);
  }
}

let backend: AuditStore = new MemoryAuditStore();

export async function initAuditStore(): Promise<{ backend: string }> {
  const url = databaseUrl();
  if (url) {
    const { PostgresAuditStore } = await import("./audit.pg");
    backend = await PostgresAuditStore.connect(url);
    return { backend: "postgres" };
  }
  backend = new MemoryAuditStore();
  return { backend: "memory" };
}
export async function closeAuditStore(): Promise<void> {
  await backend.close?.();
}

/** Record a consequential decision. Never throws into a caller's happy path — an audit failure is
 *  logged loudly but must not take down a task mid-action. */
export async function audit(
  e: Omit<AuditEntry, "seq" | "prev_hash" | "hash" | "at"> & { at?: string },
): Promise<void> {
  try {
    if (!e.project_id) return; // nothing to chain against
    await backend.append(e);
  } catch (err) {
    console.error("[mycel] audit append failed:", err);
  }
}

export async function auditList(projectId: string, limit?: number): Promise<AuditEntry[]> {
  return backend.list(projectId, limit);
}
export async function auditVerify(projectId: string): Promise<VerifyResult> {
  return verifyChain(await backend.list(projectId, 100_000));
}
