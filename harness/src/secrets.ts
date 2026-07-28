// Secret resolution for connections. Two ref forms:
//   env:NAME    — a process env var (founder-level, static: his Stripe/Postmark key)
//   vault:KEY   — a stored secret (dynamic, per-connection: a client's OAuth token, refreshable)
// Secrets are resolved server-side, only inside executeAction, and never returned by any API or
// sent to the sandbox.
//
// v0 ships an in-memory vault (set via POST /v1/connections/:id/secret). This is NOT durable and
// NOT encrypted at rest — the interface is deliberately tiny so a real KMS/Vault backend drops in
// behind setSecret/getSecret without touching call sites.
const vault = new Map<string, string>();

export function setSecret(key: string, value: string): void {
  vault.set(key, value);
}
export function getSecret(key: string): string | undefined {
  return vault.get(key);
}
export function deleteSecret(key: string): void {
  vault.delete(key);
}
export function hasSecret(key: string): boolean {
  return vault.has(key);
}

/** Resolve a connection secret. Tries the explicit ref, then a vault entry keyed by the fallback
 *  (the connection id) — so `POST /connections/:id/secret` works without mutating the connection. */
export function resolveSecret(secret_ref?: string, fallbackKey?: string): string | undefined {
  if (secret_ref) {
    const env = /^env:(.+)$/.exec(secret_ref);
    if (env) return process.env[env[1]];
    const v = /^vault:(.+)$/.exec(secret_ref);
    if (v) return getSecret(v[1]);
  }
  if (fallbackKey && vault.has(fallbackKey)) return vault.get(fallbackKey);
  return undefined;
}
