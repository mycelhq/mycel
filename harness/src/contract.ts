// Mycel Contract v0.1 — the typed spine (mirrors docs/CONTRACT.md).
// The harness emits these; frontend skills generate against them; every wedge speaks them.

export type TaskStatus =
  | "queued"
  | "provisioning"
  | "running"
  | "awaiting_approval"
  /** Parent of a Batch: children are running; join has not finished. Not an approval gate. */
  | "awaiting_batch"
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
   * Case IS the engagement hierarchy — there is no `parent_task_id` for business structure.
   * Ephemeral fan-out (query×model, N receipt chases that must join) uses `batch_id` → Batch,
   * which is a work-tree for one episode, not a second engagement model.
   */
  case_id?: string;
  /** When this task is a child (or parent) of a Batch fan-out. See `Batch`. */
  batch_id?: string;
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

/**
 * Ephemeral fan-out for one episode of work: N sibling child tasks, then a join.
 *
 * Case remains the long engagement. Batch is how "ask these 40 queries across 5 models" or
 * "chase these 40 receipts and summarise" becomes worker-count latency instead of serial latency
 * inside one sandbox — without inventing a second engagement hierarchy.
 *
 * `join: "all"` waits for every child to reach a terminal status. `join: "quorum"` waits until
 * `quorum` children have succeeded (failures still count toward "done" for the wait, but the
 * aggregate marks partial). The parent task sits in `awaiting_batch` until join fires.
 */
export type BatchStatus = "open" | "joining" | "succeeded" | "failed" | "cancelled";

export interface Batch {
  id: string;
  project_id: string;
  /** The task that spawned the children and waits for the join. */
  parent_task_id: string;
  wedge: string;
  case_id?: string;
  client_id?: string;
  status: BatchStatus;
  join: "all" | "quorum";
  /** Required when `join` is `quorum`. */
  quorum?: number;
  child_task_ids: string[];
  /** Filled on join: counts + optional merged output the parent resumes with. */
  aggregate?: {
    succeeded: number;
    failed: number;
    cancelled: number;
    outputs?: unknown[];
  };
  created_at: string;
  updated_at: string;
  joined_at?: string;
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
  /**
   * A near-miss final message was deterministically recovered BEFORE `output.validated`. Carries
   * `{changes}` — the honest list of what the repair did (unwrapped a nested answer, filled a
   * schema-declared default). Never fabricates a substantive field; see repair.ts. Its presence in a
   * timeline is the signal that the model's raw answer failed the schema and was salvaged rather than
   * wasting the run — most importantly the flagship "describe your business" first impression.
   */
  | "output.repaired"
  | "artifact.created"
  | "cost.charged"
  | "task.finished"
  | "batch.joined"
  | "feedback.recorded"
  | "improvement.proposed"
  /**
   * Mycel wrote a service definition for this business. Carries `{slug, title, status}`.
   *
   * Always `status: "drafted"` today — the event marks the PROPOSAL, and a founder promoting it is a
   * separate, human act on a separate route. The field is on the event anyway so a timeline reading
   * it never has to assume.
   */
  | "service.drafted"
  /**
   * Mycel wrote a service definition and then refused its own work. Carries `{reasons, summary}`.
   *
   * A separate event rather than a `service.drafted` with an `ok: false`, because these two are read
   * by different people for different reasons and a consumer filtering for "we drafted something"
   * must not have to remember to also check a flag. The run that produced it still succeeded: the
   * agent did its job and its output passed its own schema; what failed was the CONTENT, against the
   * rules in wedgeauthor.ts. Silence here would leave a founder waiting for a draft that is not coming.
   */
  | "service.draft_refused"
  /**
   * The run's output is being published to a URL. Carries `{deployment_id, url, status}`.
   *
   * Emitted when the build is HANDED OFF, not when it finishes — CodeBuild takes minutes, and the
   * person watching a run wants "we are publishing your app, here is where it will be" now rather
   * than a silent gap followed by a link. The authoritative state is the Deployment row; this event
   * is the notification, and `GET /v1/deployments` is the answer.
   */
  | "deploy.started"
  /**
   * A live, editable dev server is up for a BUILD run. Data: `{ url, token?, port }`.
   *
   * LIFETIME: valid ONLY while the run is executing. The sandbox — and this URL — are destroyed when
   * the run ends. This is the interactive-builder model: the founder watches their app build live,
   * not a permanent hosting URL. The permanent artifacts are the exported workspace
   * (`artifact.created`) and, when the kernel can host, the Deployment (`deploy.started`). `token` is
   * the Daytona preview token; a client cannot put it on an `<iframe src>`, so the cloud proxies the
   * preview server-side with the token as a header.
   */
  | "preview.ready";

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
  | "linkedin"
  /**
   * AgentMail: a programmatically provisioned mailbox that can RECEIVE.
   *
   * Added against the standing rule above, and it earns the exception by being the thing the deleted
   * four were not — implemented end to end. `email` sends and is deaf: see the "WHERE DOES A REPLY
   * GO?" comment in actions.ts, which concluded that a client answering a dunning email was invisible
   * to the kernel and the ladder escalated at them anyway. This kind sends through the tenant's own
   * inbox AND has a signature-verified inbound webhook that lands on the same intake pipeline a form
   * uses, so a reply becomes a Message on the Thread it answers and stands the chase down.
   *
   * `config.inbox_id` is the tenant's mailbox and `config.address` its address; the deployment-level
   * API key is an env var (see agentmail.ts). Deliberately NOT folded into `email`, which is defined
   * as "POST a body at config.api_url" and has no notion of an inbox to receive on. Overloading it
   * would produce a connection whose behaviour depended on which optional config keys happened to be
   * present, which is a subtler version of the menu-with-no-kitchen problem, not a fix for it.
   */
  | "agentmail";
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
  /**
   * The engagement this conversation is about.
   *
   * THE JOIN THAT WAS MISSING. `Case` was already a good engagement object and nothing pointed at
   * it, so `findOrCreateThread` keyed on (client, channel, open) alone: every job a client ever
   * sent about, on one channel, collapsed into ONE thread. A bookkeeping client with a tax return
   * and a year-end filed both into the same conversation, the run spawned from that thread carried
   * no case, and the audit that found this watched an agency answer a February question with
   * March's context.
   *
   * Undefined is a first-class value, NOT a gap to be backfilled: a new lead has no engagement yet
   * and their message must still land. Undefined means "the general conversation with this client
   * on this channel", which is precisely what an unattributed inbound is.
   *
   * Write-once — see `DomainStore.updateThread`. Reassigning it would move a client's message
   * history under a different engagement, which is worse than leaving it where it is.
   */
  case_id?: string;
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
 *  This is what makes "which receipts are still missing?" a query rather than a prompt.
 *
 *  TIME SERIES. Point-in-time rows omit `observed_at` and replace on `(project, wedge, collection,
 *  key)`. A measurement over time sets `observed_at` — uniqueness then includes that instant, so
 *  weekly share-of-voice for the same query accumulates instead of overwriting last week. The
 *  storage sentinel for "no instant" is the empty string in the unique index (see domain.pg.ts),
 *  never NULL, so two point-in-time upserts cannot both exist. */
export interface Record_ {
  id: string;
  project_id?: string;
  wedge: string;
  collection: string;
  /** Natural key, unique within (project, wedge, collection[, observed_at]). Upserts match on it. */
  key: string;
  data: Record<string, unknown>;
  /** The engagement this record belongs to, when there is one. */
  case_id?: string;
  /**
   * When this observation was true. Absent/undefined = current state (replace on upsert).
   * ISO-8601 instant when set. Required for any metric a client is billed against over time.
   */
  observed_at?: string;
  created_at: string;
  updated_at: string;
}

/**
 * What is LIVE for a project, and how it got there.
 *
 * A `build` run produces a Next.js application. Until this existed the only thing that survived the
 * run was a tarball artifact, and "your business app is ready, here is a .tar.gz" is not a product —
 * nothing in the system could answer "what is my URL?", "is it up?", or "when did it last change?".
 * This row is that answer, and it is the only durable link between a task and a hostname.
 *
 * One row PER DEPLOY, not per project. An append-only history is what makes "it broke this
 * afternoon" a diff between two rows rather than a support conversation, and the build id on each
 * row is what turns a failure into a log a human can actually open.
 */
export interface Deployment {
  id: string;
  /**
   * REQUIRED, unlike `Record_.project_id`. There is no legacy row to be kind to here: this table is
   * new, so the tenant can be mandatory from the first insert rather than optional-and-fail-closed.
   * A deployment that belongs to nobody is a URL nobody can be shown and nobody can revoke.
   */
  project_id: string;
  /** The run that produced the bytes. Absent only for a deploy triggered by hand. */
  task_id?: string;
  /** The DNS label this app answers on: `<slug>.apps.<root>`. Validated by `assertDeployableSlug`. */
  slug: string;
  /** Where a human should click. Stored rather than derived, so a custom domain can change it. */
  url: string;
  /**
   * `queued`     — the tarball is in S3 and the build has been asked for
   * `building`   — CodeBuild is running
   * `live`       — the build succeeded and CloudFront is serving it
   * `failed`     — it did not, and `error` says what the build said
   * `superseded` — a later deployment for this project went live
   */
  status: "queued" | "building" | "live" | "failed" | "superseded";
  /** CodeBuild's build id. Useless to a customer, and the only handle that leads to the log. */
  build_id?: string;
  /** S3 key of the workspace tarball this deploy was built from. */
  source_key?: string;
  /** Why it failed, in the words the build used. Never rendered to a customer. */
  error?: string;
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

// ── Work that waits ──────────────────────────────────────────────────────────────────────────────
//
// The gap this closes is vision.md §"What is left → 1": the kernel is strong at "run one bounded
// job safely" and weak at "this engagement paused for a client reply, resumed next Tuesday, and
// never double-invoiced."
//
// ═══ WHY A CASE, AND NOT A TASK ═══
//
// The kernel already has a wait: `awaitApproval` suspends a RUN on a human. It is the right shape
// for a decision that resolves in minutes and the wrong shape for one that resolves in a fortnight,
// because it is an in-process promise holding a live sandbox open. A deploy, a crash or an OOM ends
// it, and the engagement it belonged to has no memory that it ever existed.
//
// A `Case` is the only noun in the kernel that already outlives a run. It has the tenant, the
// client, the stage, the operational `data`, and a `history` a founder can read. So a wait is
// anchored to a Case: the engagement is what is blocked, and the run is merely what happened to be
// executing when we found out. That also makes resumption a NEW run rather than a revived one,
// which is the only honest option — nothing durable holds a half-finished model conversation, and
// pretending otherwise is how "resume" becomes a lie the second time a container restarts.
//
// ═══ WHY A ROW, AND NOT A FIELD ON `Case.data` ═══
//
// Because the claim has to be one statement. `Case.data` is a jsonb blob written by read-modify-
// write (`updateCase` COALESCEs the whole object), and "read the wait, decide it is satisfied,
// write that we resumed it" across two statements is precisely the race that makes two replicas
// both send. See `DomainStore.claimWait`.

/**
 * What an engagement is blocked ON. Every variant is satisfied by a signal that ALREADY EXISTS —
 * there is deliberately no new event bus, because a second source of truth about "the client
 * replied" is a second thing to keep in sync with the first.
 */
export type WaitCondition =
  /** An inbound `Message` on this thread, posted after the wait was armed. */
  | { kind: "client_reply"; thread_id: string; label?: string }
  /** A `ClientRequest` reaching `resolved`. Cancelled is NOT satisfaction — see `evaluateWait`. */
  | { kind: "request_resolved"; request_id: string; label?: string }
  /** An `Invoice` reaching `paid`. */
  | { kind: "invoice_paid"; invoice_id: string; label?: string }
  /**
   * A `Deliverable` the client has been shown reaching a verdict — accepted, or changes asked for.
   *
   * WHY THIS IS NOT `client_reply` ON THE CASE'S THREAD. It nearly was, and it is wrong in the
   * direction that costs money: a client who writes "got it, thanks, will look Monday" is an inbound
   * message, so a `client_reply` wait resumes, the run reads "they replied" and moves the engagement
   * on as though the work were signed off. Acceptance is a specific act against a specific VERSION,
   * and the only signal that means it is the one the client took deliberately on the deliverable
   * itself. A chatty client and a decided one must be distinguishable, because they are the two
   * halves of "can we bill for this".
   *
   * Satisfied by `accepted` AND by `changes_requested`, which reads odd and is deliberate: both are
   * the client answering. The work that resumes differs — write the invoice, or write the next
   * version — but it is work either way, and the resumed run is told which by reading the row. A
   * condition satisfied only by acceptance would park a revision request behind a nudge ladder
   * chasing a client who had already answered.
   */
  | { kind: "deliverable_settled"; deliverable_id: string; label?: string }
  /** A date arriving. "Resumed next Tuesday", literally. */
  | { kind: "date"; at: string; label?: string };

/**
 * `label` on a condition is the founder's name for it, and it exists for the JOIN.
 *
 * "Waiting on 3 of 7" is a useless sentence without "…and the four missing ones are March, April,
 * the Amex statement and the Stripe payout". The kernel can derive `request:9f3c-…` from the row and
 * nothing else — the id of a `ClientRequest` is not a thing a person can read — so the caller that
 * knows what each part MEANS gets to say so once, at arm time, rather than the surface guessing
 * later from a foreign key. Optional: `describeCondition` falls back to a derived phrase.
 */

/**
 * How a wait's conditions combine.
 *
 * ═══ WHY OR EXISTS (`any`) ═══
 *
 * Every real wait in a service business has more than one way out. "Chase the unpaid invoice" ends
 * when they PAY, or when they REPLY ("we're disputing line 3"), or when the deadline arrives — and
 * before this the honest model could not be written, so a caller had to pick one exit and be wrong
 * about the other two. A wait that only watched the payment slept through the dispute; one that only
 * watched the thread resumed on "thanks!" and never noticed the money.
 *
 * ═══ WHY AND EXISTS (`all`) ═══
 *
 * "Close the month once every receipt is in" is the canonical service-business join, and it is
 * exactly what `books-keeper` could not express: it parks on ONE client request, and a month-end
 * close waits on several.
 *
 * ═══ WHY THIS IS NOT A DAG OF WAITS ═══
 *
 * The obvious alternative — a wait that depends on other WAITS — was designed and rejected. See
 * `WAIT_JOIN` in waits.ts for the argument; the short version is that "at most one live wait per
 * case" is the constraint that stops two resumes racing to advance one engagement, and a join over
 * seven receipts would need eight live waits on one case to survive.
 */
export type WaitMode = "any" | "all";

/**
 * One condition of an `all` wait that has already come good.
 *
 * PERSISTED, and that is the point: a `request_resolved` part records that the receipt landed on the
 * 4th even though the join did not complete until the 19th. Recomputing it every sweep would be
 * cheaper and would lose the date, and "3 of 7 in" with no dates is a progress bar rather than an
 * account of what happened.
 *
 * It is NOT the exactly-once gate. Satisfaction is still decided by re-reading the world and the
 * resume is still won by ONE `claimWait` — parts are evidence, not a lock. Two replicas that both
 * append the same part write the same row twice and nothing downstream can tell; two replicas that
 * both decide the join is complete still produce one resume.
 */
export interface WaitPart {
  /** Index into `CaseWait.conditions`. Stable — conditions are never reordered after arming. */
  index: number;
  /** The evidence, in the same shape `satisfied_by` uses: `request:<id>`, `message:<id>`, … */
  by: string;
  at: string;
}

/**
 * `waiting` → `resuming` → `resumed` is the exactly-once path; the rest are terminal and inert.
 *
 * `resuming` is a real persisted state and not an implementation detail. It is the claim: a replica
 * that wins the transition owns the resume, and a crash between the claim and the spawn leaves the
 * wait STUCK IN `resuming` rather than eligible again. That is the fail-closed direction on purpose
 * — a wait a founder can see and re-arm is strictly better than an invoice sent twice.
 *
 * `failed` is for a wait we cannot even evaluate (an unknown condition kind, a thread that no longer
 * exists). It never resumes and it stays on the list, because a malformed wait that silently
 * vanished would take a client engagement with it.
 */
export type WaitStatus = "waiting" | "resuming" | "resumed" | "expired" | "cancelled" | "failed";

/** What to do when the wait is met. A task spec, not a continuation. */
export interface WaitResume {
  /** Must be a task type of the case's wedge — validated at the boundary, not here. */
  task_type: string;
  /**
   * The INTENT, frozen at the moment we stopped: "you were drafting the statement of work".
   *
   * Facts are NOT frozen here. The resumed run is handed the case's live `stage`/`data` and the
   * evidence that satisfied the wait — see `resumeInput`. Freezing the facts too would resume a
   * fortnight-old picture of the engagement; freezing nothing would lose why we were waiting at all.
   */
  input: Record<string, unknown>;
}

export interface CaseWait {
  id: string;
  /**
   * REQUIRED, like `Invoice.project_id` and for the same reason: waits are new, so there is no
   * legacy unscoped row to accommodate, and every read below can therefore fail closed with no
   * exception for NULL. Two cross-tenant leaks have shipped from optional-with-a-default scoping.
   */
  project_id: string;
  case_id: string;
  /** Denormalised from the case so the sweep can check the wedge is still enabled without a join. */
  wedge: string;
  /** One sentence a founder reads: "waiting on Acme to confirm the scope change". */
  reason: string;
  /**
   * The ways out. NEVER EMPTY — a wait with no condition can only ever expire, which is an
   * engagement parked for ninety days with nothing that could release it.
   *
   * Ordered, and the order is load-bearing for `mode: "any"`: evaluation returns the FIRST satisfied
   * condition, so two conditions that come good in the same sweep resolve deterministically rather
   * than by whichever store answered first. Never reordered after arming, because `WaitPart.index`
   * points into this array.
   */
  conditions: WaitCondition[];
  mode: WaitMode;
  /**
   * Which conditions of an `all` wait are already in. Always empty for `any` — the first satisfied
   * condition of an OR does not park, it resumes.
   */
  parts: WaitPart[];
  resume: WaitResume;
  status: WaitStatus;
  /** When to chase. Re-armed by `claimWaitNudge`; absent means never nudge. */
  nudge_at?: string;
  nudge_count: number;
  /** Stop nudging after this many. A wait that nudges forever is spam with a scheduler. */
  max_nudges: number;
  /** When to give up. Absent means never — allowed, but the sweep says so out loud. */
  expires_at?: string;
  /** The signal that met the condition ("message:<id>", "invoice:<id>", "date"). Evidence, for Law 6. */
  satisfied_by?: string;
  /**
   * WHICH condition fired, as an index into `conditions`. Set by the claim, in the same statement.
   *
   * The whole reason OR is worth having: "they replied" and "they paid" lead to different next
   * moves, and a resume that cannot say which happened is a resume that has to guess — it re-reads
   * the invoice, finds it unpaid, and drafts a chase at the client who just told us they are
   * disputing it. `resumeInput` hands this to the run as `resumed_from_wait.satisfied_condition`.
   *
   * Absent on an `all` wait: every condition fired, and `parts` says when each one did.
   */
  satisfied_index?: number;
  satisfied_at?: string;
  /** The run the resume spawned. The join from "we were blocked" to "here is what we did next". */
  resumed_task_id?: string;
  /**
   * How many times a human has put this wait back to `waiting` after a resume stalled in `resuming`.
   *
   * Bounded (`MAX_REARMS`) and part of the re-arm's WHERE clause, not checked by a caller. An
   * engagement whose resume dies three times is not a button problem — something about that resume is
   * broken, and a fourth click is a founder generating load instead of a diagnosis.
   */
  rearm_count: number;
  /** When the last re-arm happened, and who asserted the stalled resume never ran. Law 6. */
  rearmed_at?: string;
  rearmed_by?: string;
  /** Why a `failed` wait failed. Never empty when status is `failed`. */
  error?: string;
  created_at: string;
  updated_at: string;
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
// Every amount below is a whole number of the currency's smallest unit — 1250 in USD is $12.50,
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
  /** Tax on this line, in basis points (2000 = 20% sales tax). Absent means untaxed. */
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
  /**
   * When a chase was last STARTED for this invoice — the pacing clock for the dunning sweep.
   *
   * Written by `BillingStore.claimInvoiceForChase`, which tests it and sets it in the SAME
   * statement. That compare-and-set is the whole reason this is a stored column rather than "the
   * newest chase_invoice task carrying this invoice id": the derived form is a read-then-write, so
   * two worker replicas sweeping the same project both read "not chased yet" and both send.
   *
   * "Started", not "sent". A chase run can suspend for approval or fail, and pacing must still
   * count it — otherwise a project with a backed-up approval queue spawns a fresh chase every
   * sweep and the client gets the pile all at once when someone finally clicks approve.
   */
  last_chased_at?: string;
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
/**
 * What shape of ask this is.
 *
 * `connection` is the missing kickoff primitive: "please OAuth your Xero / Ads / Drive". Satisfying
 * it is not a typed answer — it is an ACTIVE client-owned Connection — and the portal clears the
 * row when that happens. Waits still use `request_resolved`; there is no second wait kind.
 */
export type ClientRequestKind = "document" | "answer" | "decision" | "connection";
export type ClientRequestStatus = "open" | "resolved" | "cancelled";

/**
 * Who must answer this ask.
 *
 * Default / absent = the client on the row (`client_id`). Recruiting, contract-desk, and compliance
 * trades need a third party (candidate, contractor, assessor) on the same ask/wait/nudge grammar
 * without making them a Customer. The client portal only lists `client` (and unset) roles; party
 * asks use a scoped party link.
 */
export type RequestPartyRole = "client" | "candidate" | "contractor" | "assessor";

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
  /**
   * Composio toolkit slug when `kind === "connection"` — e.g. `xero`, `gmail`. Required for that
   * kind; ignored otherwise. Lowercased at write time.
   */
  connection_toolkit?: string;
  /** Who answers. Absent means the client. */
  party_role?: RequestPartyRole;
  /** Human name for a non-client party — "Alex Chen", "Acme contractor". */
  party_label?: string;
  /** Where to send a party link when the counterparty is not the client. */
  party_email?: string;
  /** What the client said back, when they cleared it. */
  response?: string;
  /**
   * Files the client attached when clearing a `document` ask. Validated at respond time to belong
   * to this client; listed here so the next episode can open them without scraping the thread.
   */
  response_artifact_ids?: string[];
  resolved_at?: string;
  /**
   * When we last chased the client about this — the twin of `Invoice.last_chased_at`, and it exists
   * for the identical reason.
   *
   * WHY IT HAD TO BE A COLUMN. Until this field existed, `nudge_client_request` was the one move
   * kind with no carrier, and it could not have gained one: a nudge sweep with nothing to compare
   * against re-nudges every open request on every tick, so a client asked for a bank statement on
   * Monday hears about it twelve times before lunch. The pacing has to be a COMPARE-AND-SET on a
   * stored timestamp (`claimRequestForNudge`) rather than a check followed by a write, because with
   * four worker replicas the check-then-write races and both send. Same mechanism as the dunning
   * ladder, deliberately — a second, differently-shaped pacing mechanism is a second thing to get
   * wrong.
   */
  last_nudged_at?: string;
  /**
   * How many nudges have gone out. The budget, not a statistic: `claimRequestForNudge` refuses past
   * `MAX_NUDGES` inside the same statement that bumps it, so "stop nagging" is enforced atomically
   * rather than by a caller remembering to check. A request nudged forever is spam with a scheduler.
   */
  nudge_count?: number;
  created_at: string;
  updated_at: string;
}

// ── deliverables ─────────────────────────────────────────────────────────────────────────────────

/**
 * WHAT A DELIVERABLE IS, AND WHY IT IS A NOUN.
 *
 * The rule this repo settled on is that a noun is A THING WITH A COUNTERPARTY. It is why the
 * generated marketing site was refused a row: nobody is on the other side of a homepage, the market
 * does not reply to it, and a row whose whole state is "what we think of it" is a file, not a noun.
 *
 * A deliverable has exactly one counterparty and it is the same one the `Case` and the `Invoice`
 * have — the client. More than that: the counterparty is the ONLY thing that moves it. The business
 * cannot decide that work is accepted; it can only offer it. Every state below `with_client` is a
 * state the client put it in. That is the strongest form of the test, so this is a noun, and it is
 * modelled exactly as `Case` and `Invoice` are: `project_id` required and failing closed, real
 * foreign keys to the client and the engagement, and NO stored edges — "which invoice billed this"
 * is derived at read time from `Invoice.case_id` the same way graph.ts derives everything else.
 *
 * WHY IT IS NOT AN ARTIFACT WITH A FLAG. Artifacts are the OUTPUT OF A RUN — keyed to `task_id`,
 * project-scoped only transitively through the task, with no notion of a version after them or a
 * verdict on them. A deliverable outlives the run that produced it, survives being redone three
 * times by three different runs, and is the thing an invoice is eventually for. Putting
 * `client_accepted: boolean` on `Artifact` would mean the second version is a different row with no
 * link to the first, and "show me what changed" would be unanswerable — which is the single request
 * a client actually makes.
 *
 * WHY IT IS NOT A CASE STAGE. A stage is where an engagement IS; a deliverable is what the
 * engagement PRODUCED, and one engagement produces several (a scope, then the work, then the
 * report). Stages are also wedge-declared, so encoding review-and-accept as stages would put the
 * loop back inside each trade's manifest — which is the hardcoding this whole exercise exists to
 * delete.
 */
/**
 * What SHAPE the work is — never what trade it came from. The tables that give each entry its
 * rendering rules and its payload requirement live in deliverables.ts; the union lives here for the
 * same reason `InvoiceStatus` does, so a row type can name it without importing the machinery.
 */
export type DeliverableKind = "document" | "file_set" | "link";

/** The state machine. Drawn, with the authority argument, at the top of deliverables.ts. */
export type DeliverableStatus =
  | "drafting"
  | "in_review"
  | "with_client"
  | "changes_requested"
  | "accepted"
  | "withdrawn";

export interface Deliverable {
  id: string;
  /**
   * Required, and failing closed, for the same reason `Invoice.project_id` is: this row is new, so
   * there are no legacy unscoped rows to stay compatible with. "A deliverable with no project" is
   * unrepresentable rather than merely unusual — and the leak shape this forecloses is the one this
   * repo has already shipped twice, a client fetching by id across a tenant boundary.
   */
  project_id: string;
  /** The engagement that produced it. Required: work with no engagement cannot be billed or chased. */
  case_id: string;
  /** WHO IT IS FOR. The counterparty that makes this a noun, and the portal's whole access check. */
  client_id: string;
  /** What the client sees at the top of the card. Their words where possible, never a task id. */
  title: string;
  kind: DeliverableKind;
  status: DeliverableStatus;
  /**
   * Which version is the live one. An integer, starting at 1, and the ONLY pointer — versions are
   * append-only and none of them carries "am I current", because two places to write that is two
   * places for it to be true at once.
   */
  current_version: number;
  /** Set exactly once, by the client, and never cleared. This is the field an invoice is owed to. */
  accepted_at?: string;
  /** Why it was pulled, when it was. Absent otherwise. A withdrawal with no reason is a disappearance. */
  withdrawn_reason?: string;
  created_at: string;
  updated_at: string;
}

/**
 * ONE OFFERED VERSION. Append-only: nothing here is ever overwritten after the client has seen it.
 *
 * ═══ WHY VERSIONS ARE ROWS AND NOT A JSON HISTORY ARRAY ═══
 *
 * `Case.history` is a JSON array of events and that is right for a timeline nobody queries. This is
 * not that. A version is fetched by id from a portal route, authorised on its own, downloaded from,
 * and pointed at by a change request — so it needs a real primary key and a real tenant column, or
 * else "GET the second version of this deliverable" is a scan-and-index-into-an-array, which is the
 * shape that leaks the moment the index comes off a URL.
 *
 * ═══ WHAT MAKES REVISION NON-DESTRUCTIVE ═══
 *
 * `change_request` is stored ON THE VERSION IT WAS MADE AGAINST, not on the deliverable. That is the
 * entire "a client who asked for changes must be able to see what changed" requirement, and storing
 * it on the parent would lose it on the next round: round three would overwrite round two's ask, and
 * the answer to "why does version 3 look like this" would be gone. Version 2 keeps "make the logo
 * bigger" forever, next to the thing that was in front of them when they said it.
 */
export interface DeliverableVersion {
  id: string;
  /** Tenant scope, on the row itself — not inherited from the parent, so a read can fail closed. */
  project_id: string;
  deliverable_id: string;
  /** 1-based, contiguous, allocated by the store. Unique per deliverable. */
  version: number;
  /** What changed since last time, in the agent's words. Shown to the founder AND to the client. */
  summary: string;
  /**
   * THE PAYLOAD, and the reason there is no switch statement over trades anywhere below.
   *
   * A contract, a month-end close, a set of renders and a reconciliation report differ in what bytes
   * they are, and not at all in what happens to them: they are produced, reviewed, shown, argued
   * with and accepted identically. So the payload is `Artifact` ids — the kernel's existing content
   * primitive, already backed by inline/fs/s3, already streamed with the right download headers —
   * plus a URL for the case where the deliverable IS a place rather than a file. `kind` says which
   * shape to render, and `kind` is a shape, not a trade.
   */
  artifact_ids: string[];
  /** For `kind: "link"`: where the thing lives. The one payload that is not bytes. */
  url?: string;
  /** The run that produced this version, when a run did. Founder plane only — never crosses to the portal. */
  task_id?: string;
  /**
   * When the FOUNDER released it. Absent means the client has never seen this version and must not
   * be able to: every portal read filters on it, which is the structural half of the approval gate.
   */
  released_at?: string;
  /** What the client asked to be changed about THIS version. Absent until they ask. */
  change_request?: string;
  /** When they asked. */
  change_requested_at?: string;
  /** When the client accepted THIS version. At most one version per deliverable ever has it. */
  accepted_at?: string;
  /** The client's note on acceptance, if they left one. "Perfect, thanks." */
  accepted_note?: string;
  /** When a later version replaced it. History, not deletion. */
  superseded_at?: string;
  created_at: string;
}
