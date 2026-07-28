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
