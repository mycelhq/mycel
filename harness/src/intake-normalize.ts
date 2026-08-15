/**
 * Intake normalization — map raw source payloads into one standard envelope.
 *
 * Deliberately separate from `intake.ts` (founder knowledge questions). This module is about
 * *message* intake: email / form / … → clean fields the route stamps onto a Task.
 *
 * The adapters are pure — no I/O, no store, no UUIDs. The route owns durability (resolve the
 * client, open the thread, create the task). That split is what makes fail-closed cheap: a payload
 * with no sender and no body is rejected before anything is written.
 *
 * Adapter boundary: the kernel owns *source-type* shapes (email, form), never vendor SDKs
 * (Postmark, Typeform, …). A product verifies its provider's signature and maps vendor → these
 * canonical envelopes, so adding a provider never touches this file.
 */
import { createHash } from "node:crypto";
import type { TaskSource } from "./contract";

export interface NormalizedIntake {
  source: TaskSource;
  client: { handle: string; name?: string };
  body: string;
  subject?: string;
  metadata?: Record<string, unknown>;
}

export interface IntakeError {
  error: string;
  code: string;
}

export type NormalizeResult =
  | { ok: true; value: NormalizedIntake }
  | { ok: false; error: IntakeError };

const SUPPORTED: ReadonlySet<TaskSource> = new Set(["email", "form"]);

function fail(code: string, error: string): NormalizeResult {
  return { ok: false, error: { error, code } };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function nonEmptyString(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length ? t : undefined;
}

/** Canonical email envelope → NormalizedIntake. */
function adaptEmail(raw: Record<string, unknown>): NormalizeResult {
  const from = isPlainObject(raw.from) ? raw.from : undefined;
  const handle = from ? nonEmptyString(from.handle) : undefined;
  if (!handle) return fail("intake.missing_sender", "from.handle is required");

  const body = nonEmptyString(raw.body);
  if (!body) return fail("intake.missing_body", "body is required");

  const name = from ? nonEmptyString(from.name) : undefined;
  const subject = nonEmptyString(raw.subject);

  // Pass through fields the adapter doesn't claim, so vendor message-ids etc. survive.
  const { from: _f, body: _b, subject: _s, ...rest } = raw;
  const metadata = Object.keys(rest).length ? rest : undefined;

  return {
    ok: true,
    value: {
      source: "email",
      client: name ? { handle, name } : { handle },
      body,
      ...(subject ? { subject } : {}),
      ...(metadata ? { metadata } : {}),
    },
  };
}

/**
 * Canonical form envelope → NormalizedIntake.
 * handle: from.handle ?? fields.email (a sender is required even though `from` itself is optional)
 * body:   body ?? fields.message
 */
function adaptForm(raw: Record<string, unknown>): NormalizeResult {
  const fields = isPlainObject(raw.fields) ? raw.fields : undefined;
  if (!fields) return fail("intake.malformed", "fields object is required for form intake");

  const from = isPlainObject(raw.from) ? raw.from : undefined;
  const handle =
    (from ? nonEmptyString(from.handle) : undefined) ??
    nonEmptyString(fields.email);
  if (!handle) {
    return fail("intake.missing_sender", "sender identity required: from.handle or fields.email");
  }

  const body = nonEmptyString(raw.body) ?? nonEmptyString(fields.message);
  if (!body) return fail("intake.missing_body", "body or fields.message is required");

  const name = from ? nonEmptyString(from.name) : undefined;
  const subject = nonEmptyString(raw.subject) ?? nonEmptyString(fields.subject);

  const { fields: _fields, from: _from, body: _body, subject: _subject, ...rest } = raw;
  const metadata: Record<string, unknown> = { fields, ...rest };

  return {
    ok: true,
    value: {
      source: "form",
      client: name ? { handle, name } : { handle },
      body,
      ...(subject ? { subject } : {}),
      metadata,
    },
  };
}

/**
 * Normalize a raw intake payload for a known source type.
 * An unsupported source fails closed — do not invent a soft default, because the soft default here
 * was `handle ?? "anonymous"`, which merged every unidentifiable sender into one shared client.
 */
export function normalizeIntake(source: TaskSource, raw: unknown): NormalizeResult {
  if (!SUPPORTED.has(source)) {
    return fail("intake.unknown_source", `unsupported intake source: ${source}`);
  }
  if (!isPlainObject(raw)) {
    return fail("intake.malformed", "intake payload must be a JSON object");
  }
  switch (source) {
    case "email":
      return adaptEmail(raw);
    case "form":
      return adaptForm(raw);
    default:
      return fail("intake.unknown_source", `unsupported intake source: ${source}`);
  }
}

/**
 * Dedupe key for retried webhook deliveries.
 *
 * THE PROJECT ID IS PART OF THE KEY, and this is not decoration. A key derived only from sender +
 * content is attacker-choosable: anyone who can guess (or provoke) the email another business will
 * receive can pre-seed that key in their own project, and the victim's inbound then matches the
 * replay branch and is answered with the attacker's task — cross-tenant disclosure in one
 * direction and a denial of inbound in the other. Scoped per project, a collision can only ever be
 * with your own earlier delivery, which is exactly what dedupe is for.
 *
 * Prefer a vendor message id when the product put one in metadata; otherwise hash sender + content.
 */
export function intakeDedupeKey(projectId: string, n: NormalizedIntake): string {
  const meta = n.metadata ?? {};
  const vendorId =
    nonEmptyString(meta.message_id) ??
    nonEmptyString(meta.messageId) ??
    nonEmptyString(meta.MessageID) ??
    nonEmptyString(meta["Message-Id"]);
  if (vendorId) return `${projectId}:${n.source}:msgid:${vendorId}`;
  const digest = createHash("sha256").update(n.body).digest("hex").slice(0, 32);
  return `${projectId}:${n.source}:${n.client.handle.toLowerCase()}:${digest}`;
}

/**
 * Intake's OWN replay window — deliberately not the `Idempotency-Key` map that serves
 * POST /v1/tasks.
 *
 * Sharing that map was the bug: caller-supplied keys and derived intake keys landed in the same
 * namespace with no scope check, so one could be used to forge a hit on the other. Two different
 * trust levels (a key our own code computed vs. a key a client sent us) do not belong in one
 * lookup, whatever the key format.
 *
 * Bounded and TTL'd because a webhook endpoint is an unbounded stream of strangers: an
 * ever-growing Map keyed on inbound content is a memory-exhaustion primitive handed to the public
 * internet. In-process, so with N replicas a retry landing elsewhere creates a duplicate task
 * rather than a replay — the honest v1 trade, and the reason the vendor message id is preferred
 * (durable dedupe belongs on the natural key once inbound is stored).
 */
const INTAKE_REPLAY_TTL_MS = 24 * 60 * 60 * 1000; // a webhook that is still retrying after a day is not a retry
const INTAKE_REPLAY_MAX = 10_000;
const intakeReplay = new Map<string, { taskId: string; at: number }>();

function pruneIntakeReplay(now: number): void {
  for (const [k, v] of intakeReplay) {
    if (now - v.at > INTAKE_REPLAY_TTL_MS) intakeReplay.delete(k);
  }
  // Still over the cap after expiring? Drop oldest-first. Map preserves insertion order, and
  // entries are only ever inserted (never re-set), so the head is the oldest.
  while (intakeReplay.size > INTAKE_REPLAY_MAX) {
    const oldest = intakeReplay.keys().next();
    if (oldest.done) break;
    intakeReplay.delete(oldest.value);
  }
}

/** The task a previous delivery of this exact intake created, if it is still inside the window. */
export function lookupIntakeReplay(key: string, now = Date.now()): string | undefined {
  const hit = intakeReplay.get(key);
  if (!hit) return undefined;
  if (now - hit.at > INTAKE_REPLAY_TTL_MS) {
    intakeReplay.delete(key);
    return undefined;
  }
  return hit.taskId;
}

/** Remember that this intake produced this task, so a provider retry replays instead of duplicating. */
export function rememberIntake(key: string, taskId: string, now = Date.now()): void {
  intakeReplay.set(key, { taskId, at: now });
  pruneIntakeReplay(now);
}

/** Test hook — the window is process-global, so a test that seeds it must be able to clear it. */
export function resetIntakeReplay(): void {
  intakeReplay.clear();
}

/** Map a channel's connection kind onto an intake TaskSource the normalizer supports. */
export function intakeSourceForChannelKind(kind: string): TaskSource | undefined {
  // `agentmail` maps to `email` rather than to a source of its own, and that is the whole point of
  // this indirection: the canonical envelope above knows about EMAIL, not about vendors. A Postmark
  // parse hook, an AgentMail webhook and a hand-rolled IMAP poller all produce the same `from.handle`
  // + `body`, so they share one adapter, one dedupe key and one set of fail-closed rules. Adding a
  // provider must never mean adding a `TaskSource`.
  if (kind === "email" || kind === "agentmail") return "email";
  return undefined; // form has its own route; slack/upload land here once adapters exist
}
