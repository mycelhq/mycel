// Mycel Contract v0.1 — the typed spine (mirrors docs/CONTRACT.md).
// The harness emits these; frontend skills generate against them; every wedge speaks them.

export type TaskStatus =
  | "queued"
  | "provisioning"
  | "running"
  | "awaiting_approval"
  | "validating"
  | "succeeded"
  | "failed"
  | "rejected"
  | "expired"
  | "cancelled";

export interface Constraints {
  max_runtime_s: number;
  max_cost_usd: number;
  approval_required: boolean;
}

/**
 * Where a task originated — the intake surface. Distinct from `actor` (WHO caused it): a portal
 * message and an inbound email can both carry actor.kind "user".
 * Keep this closed and short; map an unknown channel to `"channel"` rather than inventing one-offs.
 */
export type TaskSource =
  | "email"
  | "form"
  | "slack"
  | "upload"
  | "api"
  | "schedule"
  | "portal"
  | "case"
  | "channel";

/** Who currently owns the next action on the task. */
export type TaskAssignee = "agent" | "human";

export interface Task {
  id: string;
  /** The project (tenant) this task belongs to. Reads are filtered by the caller's projects. */
  project_id?: string;
  /**
   * The case (long-lived engagement) this task is an episode of, when there is one.
   * This IS the task hierarchy — there is no `parent_task_id`. Sub-work is another episode of the
   * same Case (or a new Case), not a child Task row.
   */
  case_id?: string;
  /**
   * Customer this work is for. Reachable via case/input too, but duplicated top-level so
   * list/filter and the client-context façade don't need a join through either.
   */
  client_id?: string;
  /** Intake surface that created this task (`api` when POSTed directly). */
  source?: TaskSource;
  /**
   * Who owns the next action. Defaults to `agent`. Set to `human` when an operator must act
   * (review, override) — assignment can outlive a single `awaiting_approval` gate, so it is not
   * merely inferred from status or the last TaskEvent.
   */
  assigned_to?: TaskAssignee;
  /**
   * 0..1 confidence from the last agent step that reported one; omitted until something sets it,
   * `null` once explicitly cleared. Mutable mid-run via `Store.updateTask`.
   */
  confidence_score?: number | null;
  wedge: string;
  task_type: string;
  actor: { kind: "user" | "business" | "system"; id: string };
  input: Record<string, unknown>;
  constraints: Constraints;
  tools: string[];
  output_schema?: unknown;
  status: TaskStatus;
  /** Set when the task reaches a non-success terminal state; the reason, persisted (not only in the event stream). */
  error?: string;
  cost_usd: number;
  created_at: string;
  updated_at: string;
}

export type EventType =
  | "task.created"
  | "step.started"
  | "tool.called"
  | "tool.result"
  | "progress"
  | "token.delta"
  | "approval.requested"
  | "approval.resolved"
  | "output.validated"
  | "artifact.created"
  | "cost.charged"
  | "task.finished"
  | "feedback.recorded";

export interface TaskEvent {
  id: number; // monotonic per task; == SSE event id for Last-Event-ID replay
  task_id: string;
  seq: number;
  type: EventType;
  ts: string;
  data: Record<string, unknown>;
}

export type Risk = "low" | "medium" | "high";
/** How an approval was resolved. `auto_approved` means a wedge policy envelope allowed it without
 *  a human; it still lands in the queue for batch review. */
export type ApprovalDecision = "approved" | "rejected" | "expired" | "auto_approved";

export interface Approval {
  approval_id: string;
  task_id: string;
  action: string;
  risk: Risk;
  preview: Record<string, unknown>;
  status: "pending" | ApprovalDecision;
  /** Set when a policy envelope resolved this instead of a human — the audit trail for batch review. */
  policy_reason?: string;
  expires_at: string;
  /** When it was raised, and when a decision landed. Their difference is how long a customer waited
   *  on a human — the number that decides whether the gate is a feature or the bottleneck, and the
   *  one thing about a human-in-the-loop product you cannot improve without measuring. */
  created_at: string;
  decided_at?: string;
}

/**
 * A file produced by a run, or handed to one.
 *
 * `content` is a string either way, because every backend (inline, fs, S3) already speaks text and
 * one representation is easier to reason about than two. Bytes are base64 in that string, which
 * costs 33% in storage and buys a model that can't get half-decoded. Read `encoding` before doing
 * anything with `content`; a PDF read as UTF-8 is silently corrupt rather than loudly broken.
 */
export interface Artifact {
  id: string;
  task_id: string;
  name: string;
  content_type: string;
  content: string;
  created_at: string;
  /** Absent means "utf8" — rows written before uploads existed are all text. */
  encoding?: "utf8" | "base64";
  /** Size of the DECODED bytes. What a human means by "how big is that file". */
  size_bytes?: number;
  /** How it got here. Absent means "agent", which is what every pre-upload row was. */
  source?: "agent" | "upload";
  /**
   * Set when a customer uploaded it through the portal.
   *
   * This is the isolation dimension: a client may download an artifact only if this matches their
   * session, or it belongs to a task run for them. Never filter on the task alone.
   */
  client_id?: string;
  /** The member or client id that uploaded it. Absent for agent output. */
  uploaded_by?: string;
}

export interface CreateTaskInput {
  wedge: string;
  task_type: string;
  actor?: { kind: "user" | "business" | "system"; id: string };
  input?: Record<string, unknown>;
  constraints?: Partial<Constraints>;
  tools?: string[];
  output_schema?: unknown;
  source?: TaskSource;
  client_id?: string;
  case_id?: string;
  assigned_to?: TaskAssignee;
  confidence_score?: number | null;
}

// ── The service surface: who the work is for, where it comes from/goes, and the external
//    capabilities the agent may use. Secrets live behind Connections and never enter the sandbox;
//    every outward action passes the human approval gate. ──

/** An external capability with server-held secrets. The secret is referenced, never returned. */
/**
 * What a connection speaks.
 *
 * Deliberately short. There used to be `stripe`, `sms`, `whatsapp` and `calendar` here, and all four
 * returned "not implemented yet" at run time — a menu advertising four dishes the kitchen couldn't
 * cook. Composio covers those and ~250 more through one executor that is actually written, so the
 * honest list is: the two transports the kernel implements itself, and the broker.
 */
export type ConnectionKind =
  /** Generic provider-over-HTTP send (Postmark/Resend-shaped). Also what channels reply through. */
  | "email"
  /** Outbound POST to a host fixed by the connection. */
  | "webhook"
  /** Read-only HTTP against a host fixed by the connection; no write executor. */
  | "custom"
  /** Composio-brokered: OAuth and 250+ toolkits. `config.toolkit` names which. See composio.ts. */
  | "composio"
  /**
   * Self-hosted LinkedIn: a captured member session (linkedin/), messaging over Voyager.
   *
   * The exception that proves the rule above. Every other kind here is either implemented by the
   * kernel or brokered by Composio; LinkedIn has no messaging API to broker, so this drives a real
   * member session, and it is opt-in and ToS-grey for that reason. `config` holds the account
   * email, the account's proxy HOST (its credentials are vaulted, never in config) and the inbox
   * sync cursor; the session itself lives in the vault under the connection id.
   */
  | "linkedin";
/** Who a connection belongs to. Founder-owned (his Stripe, his outreach domain) is shared across
 *  jobs; client-owned (a client's Gmail/calendar the founder operates on their behalf) is scoped
 *  to that client and only offered to tasks serving them. */
export interface ConnectionOwner {
  kind: "founder" | "client";
  id: string; // "founder" for founder-level, or the client id
}
export interface Connection {
  id: string;
  project_id?: string;
  kind: ConnectionKind;
  name: string;
  owner: ConnectionOwner;
  /** Non-secret settings (from address, api base url, account id, …). Safe to return. */
  config: Record<string, unknown>;
  /** How the harness resolves the real secret — `env:NAME` or `vault:KEY`. Never returned. */
  secret_ref?: string;
  created_at: string;
}

/**
 * A standing subscription to something happening in a connected app.
 *
 * The reactive counterpart to `Schedule`. A schedule says "at 6am"; a trigger says "when a bill
 * lands in Xero". Both end in a task, and both are owned exactly the way a `Connection` is —
 * founder-level or scoped to one client — because the run that comes out of a trigger must be
 * attributed to whoever the work is for.
 *
 * This row is the authority on routing. Composio delivers every project's triggers to ONE webhook
 * URL with no per-subscription secret, so the payload cannot be allowed to say which project or
 * client it belongs to. `trigger_id` (what Composio returned when we registered) is looked up here,
 * and everything that decides where the run lands is read from this row instead.
 */
export interface TriggerSub {
  id: string;
  project_id?: string;
  /** The Composio connection whose account is being watched. */
  connection_id: string;
  /** Composio trigger slug, uppercase — "GMAIL_NEW_GMAIL_MESSAGE", "STRIPE_INVOICE_CREATED". */
  trigger_slug: string;
  /** The trigger INSTANCE id Composio returned. Absent only if registration failed. */
  trigger_id?: string;
  /** Copied from the connection at subscribe time, so a webhook never needs to re-derive it. */
  owner: ConnectionOwner;
  /** What to run when it fires. */
  wedge: string;
  task_type: string;
  /** The `trigger_config` Composio needs (a repo, a label, a mailbox filter). Non-secret. */
  config: Record<string, unknown>;
  enabled: boolean;
  /** Observability a founder can act on: did this ever actually fire? */
  last_event_at?: string;
  last_task_id?: string;
  created_at: string;
  updated_at: string;
}

/** A conversation surface bound to a connection; inbound here spawns a task of the given type. */
export interface Channel {
  id: string;
  project_id?: string;
  connection_id: string;
  kind: ConnectionKind;
  address: string; // support@acme.com, a phone number, a widget id
  wedge: string;
  task_type: string;
  created_at: string;
}

/** The customer/contact the work is for. Identity handles let inbound resolve to one client. */
export interface Client {
  id: string;
  project_id?: string;
  display_name?: string;
  handles: string[]; // normalized emails/phones/ids used to match inbound
  metadata: Record<string, unknown>;
  /**
   * Operational preferences (tone, timezone, billing cadence, …) — client-scoped settings the
   * façade reads and writes directly. NOT grounding knowledge; that is a `KnowledgeItem`.
   */
  preferences?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface Thread {
  id: string;
  project_id?: string;
  client_id: string;
  channel_id: string;
  subject?: string;
  status: "open" | "closed";
  created_at: string;
  updated_at: string;
}

/** A piece of living domain knowledge that grounds a wedge's agent. Data, not code — created/
 *  edited at runtime (uploads, corrections) without a redeploy; merged with the wedge's on-disk
 *  knowledge/ at task time. This is where quality accretes as the service is used. */
export interface KnowledgeItem {
  id: string;
  project_id?: string;
  wedge: string;
  name: string; // filename-like: "pricing.md", "example-reply-04.md"
  content: string;
  kind: "document" | "fact" | "example" | "correction";
  source: "authored" | "uploaded" | "feedback";
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/** Structured, queryable per-wedge state — the thing `case.data` couldn't be. A record lives in a
 *  named `collection` ("transactions", "candidates", "campaigns") and carries a natural `key` so
 *  writes are idempotent: re-ingesting the same bank transaction updates it instead of double-posting.
 *  This is what makes "which receipts are still missing?" a query rather than a prompt. */
export interface Record_ {
  id: string;
  project_id?: string;
  wedge: string;
  collection: string;
  /** Natural key, unique within (project, wedge, collection). Upserts match on it. */
  key: string;
  data: Record<string, unknown>;
  /** The engagement this record belongs to, when there is one. */
  case_id?: string;
  created_at: string;
  updated_at: string;
}

/** A **Case** is long-lived work with a stage machine: a recruiting role open for six weeks, a
 *  monthly close, an ad account under management. Tasks become *episodes within a case*, so state
 *  that outlives a single run (which candidate is at which stage, what's still missing) has a home.
 *  Stages are declared by the wedge, so transitions can be validated at the boundary. */
export interface CaseEvent {
  at: string;
  kind: "created" | "stage_changed" | "note" | "task_spawned" | "closed" | "reopened";
  from?: string;
  to?: string;
  note?: string;
  task_id?: string;
  actor: string; // member id, "agent", or "system"
}

export interface Case {
  id: string;
  project_id?: string;
  wedge: string;
  title: string;
  /** The customer this engagement is for, when there is one. */
  client_id?: string;
  stage: string;
  status: "open" | "closed";
  /** Operational state for the engagement (per-wedge shape: candidates, missing receipts, …). */
  data: Record<string, unknown>;
  /** Deadline, if the work has one (a filing date, a client-promised ship date). */
  due_at?: string;
  history: CaseEvent[];
  created_at: string;
  updated_at: string;
  closed_at?: string;
}

/** A recurring job that spawns a task on a cadence. This is what lets a wedge *run an operation*
 *  (daily sync, month-end close, a weekly client report) instead of only answering requests.
 *  Deliberately not a cron parser: three explicit cadences cover the real cases and are testable.
 *  (Cron strings can be added later behind the same `cadence` field.) */
export type Cadence =
  | { kind: "every"; seconds: number }
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "monthly"; day: number; hour: number; minute: number };

export interface Schedule {
  id: string;
  project_id?: string;
  name: string;
  wedge: string;
  task_type: string;
  /** Task input template. Each run creates a task with this input (plus `scheduled_at`). */
  input: Record<string, unknown>;
  cadence: Cadence;
  enabled: boolean;
  /** UTC ISO timestamp of the next due run. */
  next_run_at: string;
  last_run_at?: string;
  last_task_id?: string;
  created_at: string;
}

export type MessageDirection = "inbound" | "outbound";
export interface Message {
  id: string;
  thread_id: string;
  direction: MessageDirection;
  author: string; // client id, "agent", or "system"
  body: string;
  status?: "draft" | "sent" | "failed";
  task_id?: string; // the task that produced an outbound message
  created_at: string;
}

// ── Billing: how a founder charges THEIR clients ──
//
// Distinct from Mycel's own subscription (cloud/lib/billing.ts), which is how Mycel charges the
// founder. This is the founder's accounts-receivable, and it is what makes the kernel a Business OS
// rather than a task runner: a service business that cannot raise an invoice is a hobby.
//
// ═══ MONEY IS AN INTEGER, IN MINOR UNITS, ALWAYS ═══
//
// Every amount below is a whole number of the currency's smallest unit — 1250 in GBP is £12.50,
// 1250 in JPY is ¥1250. Never a float, anywhere, for one reason that is not negotiable: 0.1 + 0.2
// is 0.30000000000000004 in IEEE-754, so a twelve-line invoice totalled in floats can disagree with
// the same invoice totalled in a different order, and an invoice whose total depends on the order
// of its lines is not an invoice. It is also how every payment provider on earth represents money
// (Stripe's `amount`, PayPal's minor units), so the seam below needs no conversion — and a
// conversion is exactly where the half-penny goes missing.
//
// `currency` carries the exponent implicitly; `MINOR_UNIT_EXPONENT` in billing.ts is the only place
// that maps one to the other, and it is exposed to the portal so a client's browser can format
// money without shipping a currency table to it.

export type InvoiceStatus = "draft" | "sent" | "paid" | "overdue" | "void";

/**
 * One billable line.
 *
 * Two kinds, because service businesses charge two ways and both matter from day one:
 *   `fixed` — a retainer or a flat fee. Quantity is 1 by definition.
 *   `unit`  — a per-unit charge (hours, transactions, properties sourced, invoices chased).
 *
 * Deliberately NOT here: recurrence. A monthly retainer is a `fixed` line on an invoice that a
 * `Schedule` issues every month — the kernel already has a recurrence primitive, and a second one
 * living on Invoice would be two calendars that eventually disagree about which month got billed.
 */
export interface InvoiceLine {
  id: string;
  /** What the client reads. Their language, not a task id. */
  description: string;
  kind: "fixed" | "unit";
  /**
   * Quantity in THOUSANDTHS of a unit — 1500 is 1.5 hours. An integer for the same reason money is;
   * 0.1 hours × 7 is not 0.7 in binary floating point. Always 1000 for a `fixed` line.
   */
  quantity_milli: number;
  /** Price of ONE unit, in minor units. */
  unit_amount: number;
  /** Tax on this line, in basis points (2000 = 20% VAT). Absent means untaxed. */
  tax_bps?: number;
  /**
   * The runs that produced this line. FOUNDER-PLANE ONLY — this is the provenance link that lets an
   * operator answer "what am I actually billing for", and it is stripped before an invoice crosses
   * to the portal because a client has no use for a task id and every use for not seeing one.
   */
  task_ids?: string[];
}

export interface Invoice {
  id: string;
  /**
   * Required, unlike every other row in this file. Invoices are new, so there are no legacy
   * unscoped rows to be compatible with — which means the tenant filter can fail closed without an
   * exception for `NULL`, and "an invoice with no project" is unrepresentable rather than
   * merely unusual.
   */
  project_id: string;
  client_id: string;
  /** The engagement that produced the work, when there is one. */
  case_id?: string;
  /** Human-facing reference, unique per project. Allocated on creation; never reused. */
  number: string;
  /** ISO-4217, uppercase. */
  currency: string;
  status: InvoiceStatus;
  lines: InvoiceLine[];
  /** YYYY-MM-DD. Set when the invoice is issued (leaves draft), because a draft has no issue date. */
  issue_date?: string;
  /** YYYY-MM-DD. What `overdue` is measured against. */
  due_date?: string;
  /** Received so far, in minor units. Incremented atomically — see `BillingStore.recordPayment`. */
  amount_paid: number;
  /**
   * THE PAYMENT-PROVIDER SEAM. See `PAYMENT_SEAM` in billing.ts before filling this in.
   *
   * A URL where the client can pay. Set by hand today (a Stripe payment link a founder pasted in);
   * the place a Stripe Connect / provider integration would write instead. Nothing in the kernel
   * moves money — deliberately.
   */
  payment_link_url?: string;
  /** Terms, thanks, a bank reference. The client reads this. */
  note?: string;
  /** The operator's own notes. NEVER crosses to the portal plane. */
  internal_note?: string;
  sent_at?: string;
  paid_at?: string;
  voided_at?: string;
  created_at: string;
  updated_at: string;
}

/**
 * What a client is blocked on — the single highest-value thing a portal does.
 *
 * A status page tells a customer to wait. This tells them what to do, and clearing it in thirty
 * seconds is worth more to the business than any amount of progress reporting, because the agent is
 * genuinely stopped until the receipt / the bank statement / the answer arrives.
 *
 * `thread_id` is what makes it a loop rather than a to-do list: answering a request posts into the
 * client's thread, which spawns the run that was waiting. See `mountRequestRoutes`.
 */
export type ClientRequestKind = "document" | "answer" | "decision";
export type ClientRequestStatus = "open" | "resolved" | "cancelled";

export interface ClientRequest {
  id: string;
  /** Required, and fails closed on read, for the same reason as `Invoice.project_id`. */
  project_id: string;
  client_id: string;
  case_id?: string;
  /** Where an answer goes, and therefore what gets unblocked when one arrives. */
  thread_id?: string;
  /** The run that stalled on this. FOUNDER-PLANE ONLY. */
  task_id?: string;
  kind: ClientRequestKind;
  /** One sentence, in the client's language: "Your March bank statement". */
  ask: string;
  /** Optional elaboration — where to find it, what format, why it's needed. */
  detail?: string;
  status: ClientRequestStatus;
  /** When it stops being polite and starts being a problem. */
  due_at?: string;
  /** What the client said back, when they cleared it. */
  response?: string;
  resolved_at?: string;
  created_at: string;
  updated_at: string;
}
