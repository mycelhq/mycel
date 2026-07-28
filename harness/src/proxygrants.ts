// Proxy-mode credential grants. In proxy mode the sandbox never sees a provider key — it gets
// an opaque nonce. The harness holds the real key here, keyed by that nonce; the LLM proxy
// (/v1/internal/llm) looks it up and forwards with the real key. Grant is revoked when the run
// ends. Process-local (proxy + runtime share a process); back with Redis for multi-instance.
import { randomBytes } from "node:crypto";

export interface ProxyGrant {
  base_url: string; // OpenAI-compatible upstream (provider or a LiteLLM proxy)
  api_key: string; // the REAL provider key — never leaves the server
  model: string; // the real model id
  task_id: string;
}

const grants = new Map<string, ProxyGrant>();

export function registerGrant(g: ProxyGrant): string {
  const nonce = randomBytes(24).toString("base64url");
  grants.set(nonce, g);
  return nonce;
}

export function getGrant(nonce: string): ProxyGrant | undefined {
  return grants.get(nonce);
}

export function revokeGrant(nonce: string): void {
  grants.delete(nonce);
}
