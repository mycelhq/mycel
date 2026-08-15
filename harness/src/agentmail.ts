/**
 * AgentMail — the inbound half of email, which this kernel did not have.
 *
 * ═══ WHY THIS FILE EXISTS ═══
 *
 * Read the "WHERE DOES A REPLY GO?" comment in actions.ts first. Its conclusion was that the kernel
 * could send a dunning email and had no way at all to see the answer: `config.reply_to` routes a
 * reply to a mailbox a human reads, and that is where the loop ended. So the sequence that actually
 * happens in a service business — we chase, the client replies "I paid on the 3rd, reference X", we
 * escalate three days later — was not merely possible, it was the designed behaviour.
 *
 * `POST /v1/channels/:id/inbound` existed for two years with no producer. A route with no caller is
 * not a feature; it is a plan. This file is the producer.
 *
 * ═══ WHY AGENTMAIL AND NOT POSTMARK/RESEND ═══
 *
 * The generic `email` connection kind posts to a `config.api_url` and that is all it can do. Sending
 * is the easy half of email. What was missing is everything else:
 *
 *   · A MAILBOX THAT EXISTS. Postmark's inbound is a parse hook on an address you already own and
 *     administer. AgentMail's unit is a programmatically created inbox (`POST /inboxes`), so
 *     onboarding a tenant is an API call rather than a DNS-and-mail-server project.
 *   · SERVER-SIDE THREADING. Every AgentMail message carries a `thread_id` the provider maintains.
 *     That matters more than it sounds — see THREADING below.
 *   · SIGNED WEBHOOKS. Delivery is over Svix, so an inbound carries a real credential and not merely
 *     an origin IP. An unauthenticated inbound endpoint would let a stranger stand down a dunning
 *     ladder or plant text in a company's knowledge, so this was a hard requirement, not a nicety.
 *   · DOMAIN AUTHENTICATION AS AN API. `POST /domains/{domain}` returns the exact SPF/DKIM/DMARC/MX
 *     records to publish and a status we can poll, which is what lets the product SHOW a founder
 *     what they must do instead of mailing them a support article. See deliverability below.
 *
 * The honest counter-argument, recorded so it is not re-litigated: AgentMail is a young vendor and
 * this is a hard dependency for a business-critical path. The mitigation is the shape of this file —
 * everything vendor-specific is here, and it produces the SAME canonical email envelope that
 * `intake-normalize.ts` already defined for Postmark and Typeform. Swapping providers means writing
 * a second file like this one, not touching the intake pipeline, the threading rules or the ladder.
 *
 * ═══ THREADING: WHY THE PROVIDER'S THREAD ID AND NOT In-Reply-To ═══
 *
 * The obvious approach is RFC 5322: stamp a `Message-ID` on the chase, read `In-Reply-To` /
 * `References` off the reply, join. It is the wrong choice here for a boring reason — AgentMail's
 * `message.received` payload does not carry those headers. Parsing them would mean a second fetch of
 * the raw message on every inbound, and the join would still be at the mercy of clients that drop
 * References (Outlook Web strips them on "new message to same person", and a forwarded-then-replied
 * chase loses them entirely).
 *
 * Instead: we send through AgentMail, the send response returns `{message_id, thread_id}`, and we
 * store that `thread_id` against OUR thread and OUR case in a project-scoped record. A reply arrives
 * carrying the same `thread_id`, and the join is against a row we wrote ourselves. The provider id is
 * a LOOKUP KEY, never an authority: the project, the case and the client all come out of our record,
 * so a payload naming someone else's thread id resolves to nothing rather than to their engagement.
 * `AGENTMAIL_THREADS` below is that record.
 *
 * ═══ DELIVERABILITY: WHAT THE CUSTOMER MUST DO ═══
 *
 * A brand-new sending domain chasing invoices lands in spam, and an unread chase is strictly worse
 * than no chase — the ladder keeps climbing against silence it caused itself. AgentMail requires the
 * customer to publish DNS records before their domain will send:
 *
 *   · SPF   — one TXT record, and only one per domain. If they already send through Google
 *             Workspace they must MERGE `include:spf.agentmail.to` into the existing record. Two SPF
 *             records is a permerror and fails everything, so `spfConflict()` below detects it.
 *   · DKIM  — CNAMEs to AgentMail-managed keys. Behind Cloudflare these must be "DNS only" (grey
 *             cloud); a proxied CNAME breaks DKIM and the failure is silent.
 *   · DMARC — one TXT record at `_dmarc`, which is what makes SPF and DKIM enforceable.
 *   · MX    — required to RECEIVE, which is the whole point here. A domain with SPF/DKIM but no MX
 *             sends beautifully and drops every reply on the floor.
 *
 * None of that can be a support ticket. `domainSetup()` returns the records and the status as data,
 * so the product renders a checklist with a per-record state; the founder is never asked to read
 * this comment.
 *
 * ═══ PER-TENANT SENDING IDENTITY ═══
 *
 * A chase must arrive from the customer's own address. The inbox id lives on the CONNECTION row,
 * which is project-scoped, and the API key resolves through `resolveSecret(conn.secret_ref, conn.id)`
 * exactly like every other connection — so "tenant A sends as tenant B" would require tenant A to
 * hold a granted connection belonging to B, which the action-grant check already prevents. Nothing
 * in this file takes a sending identity from a payload, for the same reason `sendEmail` takes `from`
 * from the connection: an agent that could choose its own sender could impersonate one client to
 * another.
 *
 * ═══ UNCONFIGURED MEANS ABSENT, NOT BROKEN ═══
 *
 * `agentMailConfig()` returns null with no key set, and every route reading it answers 501 with a
 * sentence rather than throwing. A deployment that has never heard of AgentMail must behave exactly
 * as it did before this file existed.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Connection } from "./contract";
import { getDomainStore } from "./domain";

/** The reserved slug provider-thread mappings are filed under.
 *
 * NOT a wedge on disk — the same device as `PAYMENTS_WEDGE` in payments.manual.ts and `MOVES_WEDGE`
 * in moves.ts. These are kernel-owned rows that want `Record_`'s tenant-scoped storage without a new
 * table, and naming the slug here rather than passing a directory name around is what keeps the
 * roles.ts contract test (no wedge directory names in `src/`) satisfiable. */
export const AGENTMAIL_WEDGE = "agentmail";
export const AGENTMAIL_THREADS = "agentmail_thread";
export const AGENTMAIL_DOMAINS = "agentmail_domain";

export interface AgentMailConfig {
  apiKey: string;
  baseUrl: string;
  /** Svix endpoint secret, `whsec_…`. Absent means the webhook route refuses everything. */
  webhookSecret?: string;
}

/**
 * Read config from the environment, or null.
 *
 * The API key is founder-level and static (it provisions inboxes and domains for every tenant on
 * this deployment), so it is an env var and not a per-connection secret — the same call `composio.ts`
 * makes about `COMPOSIO_API_KEY`. What IS per-tenant is the inbox, and that lives on the connection.
 */
export function agentMailConfig(): AgentMailConfig | null {
  const apiKey = (process.env.AGENTMAIL_API_KEY ?? "").trim();
  if (!apiKey) return null;
  return {
    apiKey,
    baseUrl: (process.env.AGENTMAIL_API_URL ?? "https://api.agentmail.to").replace(/\/+$/, ""),
    webhookSecret: (process.env.AGENTMAIL_WEBHOOK_SECRET ?? "").trim() || undefined,
  };
}

// ═══════════════════════════ SIGNATURE VERIFICATION ═══════════════════════════

/** The three headers Svix signs every delivery with. Lowercase: Hono normalises header lookups. */
export const AGENTMAIL_WEBHOOK_HEADERS = {
  id: "svix-id",
  timestamp: "svix-timestamp",
  signature: "svix-signature",
} as const;

export type AgentMailVerifyFailure =
  | "no_secret"
  | "missing_headers"
  | "empty_body"
  | "bad_secret"
  | "bad_timestamp"
  | "stale"
  | "no_v1_signature"
  | "mismatch";

/**
 * Verify an AgentMail (Svix) webhook. This is the ENTIRE security of the inbound route.
 *
 * There is no session behind it and there cannot be one, so a bug here is an unauthenticated "put
 * words in this company's inbox and stop their invoice chasing" endpoint. Everything before this
 * returns must therefore be free of side effects, and a failure must leave nothing behind.
 *
 * Svix signs `HMAC-SHA256("{svix-id}.{svix-timestamp}.{raw body}", key)`, base64, presented as
 * `svix-signature: v1,<base64>` — space-separated when several keys are live during a rotation, any
 * one of which matching is enough.
 *
 * ═══ THE TRAP, AND IT IS THE EXACT MIRROR OF THE ONE IN composio.ts ═══
 *
 * `verifyWebhook` in composio.ts carries a comment warning that Composio's scheme LOOKS like Svix but
 * feeds the secret to the HMAC as raw UTF-8. AgentMail really is Svix, and Svix secrets are
 * `whsec_<base64>` and must be base64-DECODED before use. Copying the Composio verifier here — which
 * is the obvious "reuse" and was the first thing tried — produces a verifier that rejects every
 * genuine delivery while passing a test suite that signs with the same wrong key. Two schemes that
 * differ in one line, in one direction each; hence two functions rather than a shared one with a
 * flag, because a flag is a thing a caller can get backwards.
 *
 * The timestamp check is not decoration: without it a delivery captured once is replayable forever,
 * and a replayed inbound is a chase stood down on command.
 */
export function verifyAgentMailWebhook(args: {
  secret: string;
  webhookId: string;
  timestamp: string;
  rawBody: string;
  signature: string;
  /** Max age in seconds. 0 disables the check — for tests with frozen fixtures only. */
  toleranceS?: number;
  now?: number;
}): { ok: true } | { ok: false; reason: AgentMailVerifyFailure } {
  if (!args.secret) return { ok: false, reason: "no_secret" };
  if (!args.webhookId || !args.timestamp || !args.signature) return { ok: false, reason: "missing_headers" };
  if (!args.rawBody) return { ok: false, reason: "empty_body" };

  const key = svixKey(args.secret);
  if (!key) return { ok: false, reason: "bad_secret" };

  const tolerance = args.toleranceS ?? 300;
  if (tolerance > 0) {
    const seconds = Number.parseInt(args.timestamp, 10);
    if (!Number.isFinite(seconds)) return { ok: false, reason: "bad_timestamp" };
    const skewMs = Math.abs((args.now ?? Date.now()) - seconds * 1000);
    if (skewMs > tolerance * 1000) return { ok: false, reason: "stale" };
  }

  const presented = args.signature
    .split(" ")
    .map((part) => part.split(","))
    .filter(([version, value]) => version === "v1" && !!value)
    .map(([, value]) => value);
  if (!presented.length) return { ok: false, reason: "no_v1_signature" };

  const expected = createHmac("sha256", key).update(`${args.webhookId}.${args.timestamp}.${args.rawBody}`).digest("base64");
  const expectedBuf = Buffer.from(expected);
  const matched = presented.some((sig) => {
    const buf = Buffer.from(sig);
    // Length is not secret; timingSafeEqual throws on a length mismatch, so guard before comparing.
    return buf.length === expectedBuf.length && timingSafeEqual(buf, expectedBuf);
  });
  return matched ? { ok: true } : { ok: false, reason: "mismatch" };
}

/** `whsec_<base64>` → raw key bytes. Returns null on anything that does not decode, so a fat-fingered
 *  secret is a named refusal rather than a verifier that silently HMACs with the empty string. */
function svixKey(secret: string): Buffer | null {
  const b64 = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;
  const buf = Buffer.from(b64, "base64");
  return buf.length ? buf : null;
}

/** Sign a body the way AgentMail will. Exported for tests — nothing in the product signs inbound. */
export function signAgentMailWebhook(args: { secret: string; webhookId: string; timestamp: string; rawBody: string }): string {
  const key = svixKey(args.secret);
  if (!key) throw new Error("not a usable Svix secret");
  return `v1,${createHmac("sha256", key).update(`${args.webhookId}.${args.timestamp}.${args.rawBody}`).digest("base64")}`;
}

// ═══════════════════════════ INBOUND EVENT ═══════════════════════════

/** A `message.received` delivery, reduced to the fields we route on. Never the payload's opinions
 *  about which project, client or engagement it belongs to — those come from our own records. */
export interface AgentMailInbound {
  event_id: string;
  /** OUR inbox, minted when we provisioned the tenant. The only routing key in the payload. */
  inbox_id: string;
  /** AgentMail's server-side conversation id. The threading join key — see the header. */
  thread_id: string;
  /** RFC 5322 Message-ID. Used as the intake dedupe key, so a Svix retry replays. */
  message_id: string;
  from_handle: string;
  from_name?: string;
  subject?: string;
  text: string;
  timestamp?: string;
}

/**
 * Parse a delivery, or explain why not.
 *
 * Only `message.received` produces an inbound. `message.received.spam` and `.blocked` deliberately do
 * NOT: a spam reply must not stand down a dunning ladder, and that is exactly the payload an attacker
 * who has learned a client's address would send. `.unauthenticated` is excluded for the same reason —
 * a message that failed SPF/DKIM claiming to be from the client is the forgery this is defending
 * against, not evidence the client answered. All three are acknowledged and dropped, loudly, by the
 * route; they are not silent, they are just not replies.
 */
export function parseAgentMailInbound(raw: unknown): { ok: true; value: AgentMailInbound } | { ok: false; reason: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "payload is not an object" };
  const e = raw as Record<string, unknown>;
  const type = typeof e.event_type === "string" ? e.event_type : "";
  if (type !== "message.received") return { ok: false, reason: `not a received message (${type || "no event_type"})` };

  const m = e.message && typeof e.message === "object" && !Array.isArray(e.message) ? (e.message as Record<string, unknown>) : undefined;
  if (!m) return { ok: false, reason: "no message on a message.received event" };

  const inboxId = str(m.inbox_id);
  const threadId = str(m.thread_id);
  const messageId = str(m.message_id);
  if (!inboxId) return { ok: false, reason: "message has no inbox_id, so it cannot be routed" };
  if (!threadId) return { ok: false, reason: "message has no thread_id" };
  if (!messageId) return { ok: false, reason: "message has no message_id" };

  const from = parseAddress(str(m.from) ?? "");
  if (!from.handle) return { ok: false, reason: "message has no parseable sender" };

  // Body: `text` is the plain part. An html-only message would otherwise arrive with an empty body
  // and be refused by the normalizer as `intake.missing_body` — which reads to a founder as "we lost
  // the email". A crude de-tag is a worse body than a real text part and a much better one than none.
  const text = str(m.text) ?? stripHtml(str(m.html) ?? "") ?? "";
  if (!text.trim()) return { ok: false, reason: "message has no readable body" };

  return {
    ok: true,
    value: {
      event_id: str(e.event_id) ?? messageId,
      inbox_id: inboxId,
      thread_id: threadId,
      message_id: messageId,
      from_handle: from.handle,
      ...(from.name ? { from_name: from.name } : {}),
      ...(str(m.subject) ? { subject: str(m.subject)! } : {}),
      text: text.trim(),
      ...(str(m.timestamp) ? { timestamp: str(m.timestamp)! } : {}),
    },
  };
}

/**
 * `"Jane Doe <jane@example.com>"` → `{ name: "Jane Doe", handle: "jane@example.com" }`.
 *
 * Lowercased, because client handles are matched by exact string in `findClientByHandle` and a reply
 * from `Jane@Example.com` to a chase sent to `jane@example.com` must be the same person. Getting this
 * wrong creates a duplicate client per capitalisation, and the duplicate has no invoices, so the
 * reply attaches to nothing and the ladder carries on.
 */
export function parseAddress(input: string): { name?: string; handle: string } {
  const angled = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(input);
  const handle = (angled ? angled[2] : input).trim().toLowerCase();
  const name = angled ? angled[1].replace(/^"|"$/g, "").trim() : "";
  return { handle, ...(name ? { name } : {}) };
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ═══════════════════════════ THREAD MAPPING ═══════════════════════════

/** What we remember about a conversation AgentMail is holding for us. */
export interface AgentMailThreadLink {
  /** AgentMail's thread id — the key. */
  provider_thread_id: string;
  /** Our `Thread.id`. */
  thread_id: string;
  channel_id: string;
  client_id: string;
  case_id?: string;
  /** The invoice a chase on this thread was about, so a reply can find the ladder it must stop. */
  invoice_id?: string;
  updated_at: string;
}

/** Thread link plus the project we stored it under — used by shared-inbox (thread-first) routing. */
export type AgentMailThreadLinkResolved = AgentMailThreadLink & { project_id: string };

/**
 * Remember that an outbound we just sent opened (or continued) this provider thread.
 *
 * Idempotent on `provider_thread_id` within the project. The second chase up the same ladder lands on
 * the same provider thread and rewrites the same row, which is what we want: `invoice_id` should
 * track the most recent thing we said, because that is what the client is replying to.
 *
 * `project_id` is also written INTO `data` so a shared-inbox webhook can resolve the tenant from the
 * thread map (a key we minted on send) without trusting the payload's inbox alone.
 */
export async function linkAgentMailThread(projectId: string, link: Omit<AgentMailThreadLink, "updated_at">): Promise<void> {
  if (!projectId) throw new Error("linking an AgentMail thread must be scoped to a project");
  await getDomainStore().upsertRecord({
    project_id: projectId,
    wedge: AGENTMAIL_WEDGE,
    collection: AGENTMAIL_THREADS,
    key: link.provider_thread_id,
    data: { ...link, project_id: projectId, updated_at: new Date().toISOString() },
    ...(link.case_id ? { case_id: link.case_id } : {}),
  });
}

function linkFromRecord(r: { project_id?: string; data: Record<string, unknown> }, providerThreadId: string): AgentMailThreadLinkResolved | undefined {
  const d = r.data;
  if (str(d.provider_thread_id) !== providerThreadId) return undefined;
  const projectId = str(r.project_id) ?? str(d.project_id);
  const threadId = str(d.thread_id);
  const channelId = str(d.channel_id);
  const clientId = str(d.client_id);
  if (!projectId || !threadId || !channelId || !clientId) return undefined;
  return {
    project_id: projectId,
    provider_thread_id: providerThreadId,
    thread_id: threadId,
    channel_id: channelId,
    client_id: clientId,
    case_id: str(d.case_id),
    invoice_id: str(d.invoice_id),
    updated_at: str(d.updated_at) ?? "",
  };
}

/**
 * The conversation a provider thread id belongs to — WITHIN a project we already resolved.
 *
 * `projectId` is a required argument and it is not a formality. The provider thread id arrives in an
 * untrusted payload; if this were a global lookup, a payload naming another tenant's thread id would
 * return that tenant's client and case, and the reply would be filed into their engagement. The
 * project is resolved first, from the inbox, from our own connection row — and this query then cannot
 * see outside it, because `queryRecords` fails closed on `project_id`.
 */
export async function findAgentMailThread(projectId: string, providerThreadId: string): Promise<AgentMailThreadLink | undefined> {
  if (!projectId) throw new Error("reading an AgentMail thread link must be scoped to a project");
  const rows = await getDomainStore().queryRecords({
    project_id: projectId,
    wedge: AGENTMAIL_WEDGE,
    collection: AGENTMAIL_THREADS,
    where: { provider_thread_id: providerThreadId },
    limit: 2,
  });
  for (const r of rows) {
    const link = linkFromRecord(r, providerThreadId);
    if (link) return link;
  }
  return undefined;
}

/**
 * Shared-inbox routing: resolve a provider thread id to the project WE filed it under on send.
 *
 * ═══ WHY THIS EXISTS, AND WHY IT IS SAFE ═══
 *
 * One AgentMail inbox for the whole deployment (Pro caps at 10 inboxes) means `inbox_id → connection
 * → project` collapses every reply into a single project. The join key that still works is the
 * `thread_id` AgentMail returned when WE sent — we wrote that row ourselves, with our project id.
 *
 * This is NOT "believe the payload's project". The only thing looked up is a key we minted; a forged
 * or guessed thread id that is not in our map resolves to nothing. Signature verification still
 * gates the route. Prefer this over inbox-first whenever a link exists; fall back to inbox→connection
 * only for cold inbound with no prior outbound (unattributed / new conversation).
 */
export async function findAgentMailThreadGlobal(providerThreadId: string): Promise<AgentMailThreadLinkResolved | undefined> {
  if (!providerThreadId) return undefined;
  const row = await getDomainStore().findRecordByNaturalKey({
    wedge: AGENTMAIL_WEDGE,
    collection: AGENTMAIL_THREADS,
    key: providerThreadId,
  });
  if (!row) return undefined;
  return linkFromRecord(row, providerThreadId);
}

// ═══════════════════════════ HTTP ═══════════════════════════

export interface AgentMailCall<T> {
  ok: boolean;
  status: number;
  data?: T;
  detail: string;
}

async function call<T>(cfg: AgentMailConfig, path: string, init: RequestInit = {}): Promise<AgentMailCall<T>> {
  let res: Response;
  try {
    res = await fetch(`${cfg.baseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${cfg.apiKey}`,
        "content-type": "application/json",
        ...(init.headers as Record<string, string> | undefined),
      },
    });
  } catch (e) {
    // A network failure is not a 4xx. Saying "HTTP 0" would send a founder looking at their DNS.
    return { ok: false, status: 0, detail: `could not reach AgentMail: ${String((e as Error)?.message ?? e)}` };
  }
  const text = await res.text().catch(() => "");
  let data: T | undefined;
  try {
    data = text ? (JSON.parse(text) as T) : undefined;
  } catch {
    data = undefined;
  }
  return {
    ok: res.ok,
    status: res.status,
    data,
    // The body of a failure, truncated. It is AgentMail's own error text, not a customer's mail.
    detail: res.ok ? "ok" : `AgentMail HTTP ${res.status}: ${text.slice(0, 300)}`,
  };
}

/** Provision an inbox. `username@domain` — the tenant's own sending identity. */
export function createInbox(
  cfg: AgentMailConfig,
  args: { username: string; domain?: string; display_name?: string },
): Promise<AgentMailCall<{ inbox_id?: string; display_name?: string }>> {
  return call(cfg, "/v0/inboxes", { method: "POST", body: JSON.stringify(args) });
}

export interface AgentMailSendResult {
  message_id?: string;
  thread_id?: string;
}

/**
 * Send from a tenant's inbox.
 *
 * `inboxId` comes from the CONNECTION and never from the payload — see the per-tenant note in the
 * header. `labels` marks the message as ours so a human browsing the AgentMail console can tell an
 * agent's chase from something they typed themselves.
 */
export function sendMessage(
  cfg: AgentMailConfig,
  inboxId: string,
  body: { to: string[]; subject?: string; text?: string; html?: string; cc?: string[]; labels?: string[] },
): Promise<AgentMailCall<AgentMailSendResult>> {
  return call(cfg, `/v0/inboxes/${encodeURIComponent(inboxId)}/messages/send`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// ═══════════════════════════ DELIVERABILITY ═══════════════════════════

export interface DnsRecord {
  name: string;
  type: string;
  value: string;
  priority?: number;
}

export interface DomainSetup {
  domain: string;
  /** AgentMail's own word: pending | verifying | verified | invalid | failed | not_started. */
  status: string;
  /** Everything the customer must publish. Rendered as a checklist by the product. */
  records: DnsRecord[];
  /** Founder-facing, and the reason this is not a support article. Never a stack trace. */
  advice: string[];
}

/** Register a domain for sending AND receiving, and get back what the customer must publish. */
export async function registerDomain(cfg: AgentMailConfig, domain: string): Promise<AgentMailCall<DomainSetup>> {
  const res = await call<Record<string, unknown>>(cfg, `/v0/domains/${encodeURIComponent(domain)}`, {
    method: "POST",
    // Receiving is the entire point of this integration, so subdomains stay off (one less way to
    // mis-attribute an inbound) and feedback stays on (a bounce is how we learn a chase never landed).
    body: JSON.stringify({ feedback_enabled: true, subdomains_enabled: false }),
  });
  return { ...res, data: res.data ? toDomainSetup(domain, res.data) : undefined };
}

/** Poll a domain's verification. The product calls this behind a "check again" button. */
export async function getDomain(cfg: AgentMailConfig, domain: string): Promise<AgentMailCall<DomainSetup>> {
  const res = await call<Record<string, unknown>>(cfg, `/v0/domains/${encodeURIComponent(domain)}`);
  return { ...res, data: res.data ? toDomainSetup(domain, res.data) : undefined };
}

function toDomainSetup(domain: string, raw: Record<string, unknown>): DomainSetup {
  const records: DnsRecord[] = Array.isArray(raw.records)
    ? (raw.records as unknown[]).flatMap((r) => {
        if (!r || typeof r !== "object") return [];
        const o = r as Record<string, unknown>;
        const name = str(o.name);
        const type = str(o.type);
        const value = str(o.value);
        if (!name || !type || !value) return [];
        return [{ name, type: type.toUpperCase(), value, ...(typeof o.priority === "number" ? { priority: o.priority } : {}) }];
      })
    : [];
  const status = str(raw.status) ?? "unknown";
  return { domain, status, records, advice: deliverabilityAdvice(records, status) };
}

/**
 * The sentences a founder actually needs, derived from the records rather than written once and left
 * to rot. Each one exists because it is a real way this fails silently.
 */
export function deliverabilityAdvice(records: DnsRecord[], status: string): string[] {
  const out: string[] = [];
  const has = (t: string) => records.some((r) => r.type === t);
  if (has("TXT")) {
    out.push(
      "You may only have ONE SPF record on a domain. If you already send mail (Google Workspace, Microsoft 365), " +
        "merge include:spf.agentmail.to into the record you have rather than adding a second one — two SPF records " +
        "fail every check, including the ones you had working before.",
    );
  }
  if (has("CNAME")) {
    out.push(
      "If your DNS is behind Cloudflare, set these CNAMEs to DNS only (grey cloud). A proxied CNAME breaks DKIM, " +
        "and it breaks it silently: mail keeps sending and starts landing in spam.",
    );
  }
  if (has("MX")) {
    out.push(
      "The MX record is what lets replies come BACK. Without it your chasers send fine and every answer your " +
        "clients write is dropped before it reaches us — which is the exact failure this feature exists to fix.",
    );
  }
  out.push("DNS can take up to 48 hours to propagate, though it is usually minutes. Nothing sends until this says verified.");
  if (status !== "verified") {
    out.push("Until this domain is verified, chases go out from your fallback address and replies will not be picked up.");
  }
  return out;
}

/**
 * Does this domain already publish an SPF record that does not include AgentMail?
 *
 * Two SPF records is a permerror, and a permerror is worse than no SPF: it fails the domain's
 * EXISTING mail too. So the product must be able to tell a founder "you already have one, here is
 * what to change it to" instead of "add this record".
 */
export function spfConflict(existing: string[]): { conflict: boolean; detail?: string } {
  const spf = existing.filter((r) => /^\s*"?v=spf1\b/i.test(r));
  if (spf.length === 0) return { conflict: false };
  if (spf.some((r) => /include:spf\.agentmail\.to/i.test(r))) return { conflict: false };
  return {
    conflict: true,
    detail:
      `This domain already publishes an SPF record (${spf[0].slice(0, 120)}). Do not add a second one — ` +
      "edit that record to include:spf.agentmail.to before the all mechanism.",
  };
}

/**
 * ═══ WHICH PROJECT OWNS A SENDING DOMAIN, AND WHY WE MUST WRITE THAT DOWN ═══
 *
 * AgentMail's domain list is per-ACCOUNT, and the account is the deployment's — one AgentMail key
 * serves every tenant on this kernel. So AgentMail cannot answer "which of these domains is Acme's",
 * and if we asked it to, `GET /v1/agentmail/domains/:domain` would happily tell any founder the
 * verification state of any other customer's domain: their domain name, whether they have got their
 * DKIM right, whether they are live yet. That is a competitor-intelligence leak dressed as a status
 * endpoint, and it is the third instance of the same shape this repo has now paid for — a lookup
 * whose scope came from the vendor rather than from us.
 *
 * So the tenant boundary is a row we write at registration. `queryRecords` fails closed on
 * `project_id`, which makes "is this domain mine" a query that structurally cannot answer yes for
 * somebody else's.
 */
export async function claimDomainForProject(projectId: string, domain: string): Promise<void> {
  if (!projectId) throw new Error("claiming a sending domain must be scoped to a project");
  await getDomainStore().upsertRecord({
    project_id: projectId,
    wedge: AGENTMAIL_WEDGE,
    collection: AGENTMAIL_DOMAINS,
    key: domain,
    data: { domain, claimed_at: new Date().toISOString() },
  });
}

/** The sending domains this project registered. Never the deployment's whole AgentMail account. */
export async function listProjectDomains(projectId: string): Promise<string[]> {
  if (!projectId) throw new Error("listing sending domains must be scoped to a project");
  const rows = await getDomainStore().queryRecords({
    project_id: projectId,
    wedge: AGENTMAIL_WEDGE,
    collection: AGENTMAIL_DOMAINS,
    limit: 100,
  });
  return rows.map((r) => str((r.data as Record<string, unknown>).domain)).filter((d): d is string => !!d).sort();
}

export async function projectOwnsDomain(projectId: string, domain: string): Promise<boolean> {
  return (await listProjectDomains(projectId)).includes(domain);
}

// ═══════════════════════════ CONNECTION HELPERS ═══════════════════════════

/** The inbox a connection sends from. Config, not payload; see the header. */
export function inboxIdFor(conn: Connection): string | undefined {
  return str(conn.config.inbox_id);
}

/**
 * Which connection owns this inbox — OUR record, which is what makes the routing unspoofable.
 *
 * Deliberately a scan over `listConnections()` and not a lookup by a payload-supplied project. This
 * is the same shape `server.ts` uses to resolve a Composio `connected_account_id`, and for the same
 * reason: the identifier in the delivery is one WE minted when we provisioned the inbox, so it is the
 * only thing in the payload allowed to decide routing — and it decides it by finding our row, not by
 * being believed.
 */
export async function connectionForInbox(inboxId: string): Promise<Connection | undefined> {
  if (!inboxId) return undefined;
  const conns = await getDomainStore().listConnections();
  return conns.find((c) => c.kind === "agentmail" && inboxIdFor(c) === inboxId);
}

// ═══════════════════════════ INBOUND THAT COULD NOT BE ATTRIBUTED ═══════════════════════════

/**
 * An inbound we verified but could not place, kept so a human can find it.
 *
 * ═══ WHY THIS EXISTS AT ALL ═══
 *
 * The obvious handling of "a signed webhook for an inbox we have no record of" is to answer 200 and
 * move on — it keeps Svix quiet and the code short. It is also the failure mode this repo keeps
 * paying for: something goes wrong and reports success, and the evidence is a log line on a machine
 * nobody reads. Concretely, the way this actually happens is a founder deleting and recreating a
 * connection, or a restore from a backup taken before an inbox was provisioned; the mailbox keeps
 * receiving, every reply is silently binned, and the first anyone hears of it is a client asking why
 * they were sent to collections after answering twice.
 *
 * So: the route answers 5xx so Svix RETRIES (recoverable — if the operator repairs the connection
 * inside the retry schedule the message lands for real), logs, and records the fact here so
 * `GET /v1/agentmail/unattributed` can show an operator exactly which inbox is orphaned.
 *
 * Bounded, and it holds NO MESSAGE CONTENT. This is fed by the public internet, so an unbounded
 * buffer is a memory-exhaustion primitive; and the whole reason we cannot attribute the message is
 * that we do not know whose it is, which makes retaining its body the one thing we must not do.
 */
export interface UnattributedInbound {
  at: string;
  inbox_id: string;
  provider_thread_id: string;
  reason: string;
}

const UNATTRIBUTED_MAX = 100;
const unattributed: UnattributedInbound[] = [];

export function recordUnattributedInbound(entry: Omit<UnattributedInbound, "at">): void {
  unattributed.unshift({ at: new Date().toISOString(), ...entry });
  if (unattributed.length > UNATTRIBUTED_MAX) unattributed.length = UNATTRIBUTED_MAX;
  console.error(
    `[mycel] AGENTMAIL INBOUND DROPPED — inbox ${entry.inbox_id} matches no connection on this deployment: ${entry.reason}. ` +
      "Replies to this mailbox are not reaching any project. See GET /v1/agentmail/unattributed.",
  );
}

/** Most recent first. Operator-facing; deliberately not project-scoped, because the defining property
 *  of these rows is that we could not determine a project for them. */
export function listUnattributedInbound(): UnattributedInbound[] {
  return [...unattributed];
}

/** Test hook — the buffer is process-global, so a test that fills it must be able to clear it. */
export function _resetUnattributedInbound(): void {
  unattributed.length = 0;
}
