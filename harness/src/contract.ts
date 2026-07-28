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

export interface Task {
  id: string;
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
export type ApprovalDecision = "approved" | "rejected" | "expired";

export interface Approval {
  approval_id: string;
  task_id: string;
  action: string;
  risk: Risk;
  preview: Record<string, unknown>;
  status: "pending" | ApprovalDecision;
  expires_at: string;
}

export interface Artifact {
  id: string;
  task_id: string;
  name: string;
  content_type: string;
  content: string;
  created_at: string;
}

export interface CreateTaskInput {
  wedge: string;
  task_type: string;
  actor?: { kind: "user" | "business" | "system"; id: string };
  input?: Record<string, unknown>;
  constraints?: Partial<Constraints>;
  tools?: string[];
  output_schema?: unknown;
}

// ── The service surface: who the work is for, where it comes from/goes, and the external
//    capabilities the agent may use. Secrets live behind Connections and never enter the sandbox;
//    every outward action passes the human approval gate. ──

/** An external capability with server-held secrets. The secret is referenced, never returned. */
export type ConnectionKind = "email" | "sms" | "whatsapp" | "stripe" | "calendar" | "webhook" | "custom";
export interface Connection {
  id: string;
  kind: ConnectionKind;
  name: string;
  /** Non-secret settings (from address, api base url, account id, …). Safe to return. */
  config: Record<string, unknown>;
  /** How the harness resolves the real secret — an env var name (env:NAME). Never returned. */
  secret_ref?: string;
  created_at: string;
}

/** A conversation surface bound to a connection; inbound here spawns a task of the given type. */
export interface Channel {
  id: string;
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
  display_name?: string;
  handles: string[]; // normalized emails/phones/ids used to match inbound
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface Thread {
  id: string;
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
  wedge: string;
  name: string; // filename-like: "pricing.md", "example-reply-04.md"
  content: string;
  kind: "document" | "fact" | "example" | "correction";
  source: "authored" | "uploaded" | "feedback";
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
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
