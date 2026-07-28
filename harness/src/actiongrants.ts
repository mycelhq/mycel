// Action-mode grants — the generalization of proxy-mode (proxygrants.ts) from "LLM calls" to
// "real-world side effects". When a task runs, the harness mints an opaque nonce and records
// which connections that task may act through (plus the thread its replies belong to). The
// sandbox's tools call /v1/internal/actions/* with the nonce; the harness looks up the real
// connection secret, runs the human approval gate, executes, and traces it. The connection
// secrets — Stripe/Postmark/Twilio keys — never enter the sandbox. Grant is revoked when the run
// ends. Process-local (mirrors proxygrants); back with Redis for multi-instance.
import { randomBytes } from "node:crypto";

export interface ActionGrant {
  task_id: string;
  /** Connection ids this task may act through (least privilege — only what the run needs). */
  connectionIds: string[];
  /** The thread outbound messages are recorded on (a reply's conversation), if any. */
  threadId?: string;
}

const grants = new Map<string, ActionGrant>();

export function registerActionGrant(g: ActionGrant): string {
  const nonce = randomBytes(24).toString("base64url");
  grants.set(nonce, g);
  return nonce;
}

export function getActionGrant(nonce: string): ActionGrant | undefined {
  return grants.get(nonce);
}

export function revokeActionGrant(nonce: string): void {
  grants.delete(nonce);
}
