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
  /**
   * A whole business hidden, or brought back. On the chain because it silences every clock the
   * project owns — a founder asking later why work stopped needs to find this, and because
   * un-archiving is a second decision that deserves its own row.
   */
  | "project.archived"
  | "project.unarchived"
  /**
   * A person published, or refused, a built version of a public website.
   *
   * On this list rather than left as a generic event because it is the only action in the product
   * that makes a page visible to strangers, and the gate it belongs to exists precisely so that a
   * NAMED PERSON is on the record for it. A discard is audited too: "nobody ever said no" and
   * "somebody said no three times" are different facts about a business, and only one of them is a
   * reason to stop offering the button.
   */
  | "deployment.published"
  | "deployment.discarded"
  | "policy.envelope_used"
  /**
   * A founder put an earlier version of a procedure back.
   *
   * On the chain because a playbook decides how work gets done for that agency's clients, and
   * because "who reverted the procedure, when, and to which version" is the question somebody asks
   * after a month of deliverables came out differently, and a mutable row only knows what is true
   * now. This was originally argued from a machine doing the writing — the self-improvement system
   * proposed revisions an approval applied — and that system was deleted in 59f1dd83. The need did
   * not go with it: a founder editing their own procedure on a Tuesday leaves exactly the same
   * unanswerable question a month later.
   */
  /**
   * A founder took a credential back.
   *
   * On the chain because it is the moment a business stops being able to reach a mailbox, a bank
   * feed or a ledger — and because the question afterwards is always "when did we lose access, and
   * who did that". A mutable connections table only knows what is true now.
   */
  | "connection.revoked"
  | "playbook.restored"
  /**
   * A founder ran a written service that the deliverable grade said was not ready.
   *
   * Recorded because the finding it overrides is specific: with nothing in `output_schema.required`
   * every output validates, including an empty one, so a run reports success and the client receives
   * a blank. That is their decision to make on their own business — and a year later the question is
   * what they were told, so the entry carries the findings themselves rather than a count.
   */
  | "service.promoted_over_blocking"
  /**
   * A trial concluded: the version under test either replaced the procedure or was dropped.
   *
   * On the chain because this is the moment a MACHINE'S proposal becomes how a business's work gets
   * done. The trial's verdict is computed from a ledger that could in principle be argued with; who
   * acted on it, when, and which way, should not be.
   */
  | "playbook.promoted"
  | "playbook.trial_ended"
  /**
   * A founder decided, in advance, that a class of routine action no longer stops at a person.
   *
   * On the chain, and not negotiably. A standing grant is the only mechanism in this product by
   * which something reaches a client without a human looking at it in the moment, so "who decided
   * that, on what day, and when did they take it back" has to be answerable from the tamper-evident
   * record rather than from a mutable row that only knows what is true now. The grant document is
   * revocable and a revocation rewrites it; these two entries are what survive it.
   */
  /**
   * The chase ladder changed. On the chain because this decides how often our sending address
   * contacts somebody else's customer — "who loosened this, and when" is the first question after a
   * complaint, and a mutable settings row only knows what is true now.
   */
  | "chase_policy.changed"
  | "standing.granted"
  | "standing.revoked"
  /**
   * A founder stopped, or restarted, a live outbound campaign.
   *
   * On the chain for the same reason the standing grant is: this is the switch that decides whether
   * a machine keeps contacting strangers in the business's name. "Who stopped it, when, and why"
   * has to be answerable from the tamper-evident record rather than from a mutable status field
   * that only knows what is true now — and the interesting question is almost always about the
   * window BEFORE somebody stopped it.
   */
  | "campaign.paused"
  | "campaign.resumed"
  /**
   * ═══ THE SIGNATURE ENTRIES, WHICH ARE THE SIGNATURE ═══
   *
   * Everything else on this chain is a record OF an act that happened elsewhere. These six are
   * different: they are the act. An electronic signature is not a row in a table that says somebody
   * clicked — it is evidence that a named person, having consented to transact electronically,
   * performed a deliberate act against a document whose exact bytes we can name, at a time and from
   * a place, and that nothing has edited that record since.
   *
   * The last clause is what a hash chain gives and a status column cannot, and it is the one a
   * dispute actually turns on. `signature.signed` carries the sha256 of the document THAT signer
   * was served; `certificate()` in signing.ts prints it beside the sha256 of the executed file, so
   * a mismatch is visible on the face of the certificate rather than buried in a log.
   *
   * `signing.ts` writes these through `auditOrThrow` rather than `audit`, which is the one place in
   * the kernel where a failed chain write fails the work it describes. An executed contract with no
   * evidence is worse than a signature that did not happen: it looks complete and cannot be
   * defended.
   */
  | "signature.sent"
  | "signature.signed"
  | "signature.declined"
  | "signature.voided"
  | "signature.changes_requested"
  | "signature.revised"
  | "signature.expired"
  | "signature.executed"
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
  // The moment a founder's own name starts serving their site — a certificate was issued and their
  // tenant distribution now answers on it. Audited because it is the one step in the flow the
  // FOUNDER did not perform: everything before it is their DNS, this one is our AWS call.
  | "domain.live"
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
  /*
    A referral converted to a paying account. In the REFERRER's chain, because it is the evidence
    behind a credit they will eventually ask about — and because the referred org has no business
    reading a record of who introduced them.
  */
  | "referral.credited"
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
