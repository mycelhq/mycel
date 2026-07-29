// Secret resolution for connections. Two ref forms:
//   env:NAME    — a process env var (founder-level, static: his Stripe/Postmark key)
//   vault:KEY   — a vault secret (dynamic, per-connection: a client's OAuth token, refreshable)
//
// Secrets are resolved server-side, only inside executeAction/executeRead, and never returned by
// any API, never logged, never sent to the sandbox.
//
// AT REST: vault secrets are encrypted with AES-256-GCM (authenticated, so tampering is detected on
// decrypt). The key comes from MYCEL_SECRET_KEY; a `v1:` prefix and a stored key id leave room for
// rotation without a migration. The ciphertext — never the plaintext — is what a durable backend
// persists, so a database dump is useless without the key.
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

export interface SealedSecret {
  /** Format version, so the envelope can change without breaking stored rows. */
  v: 1;
  /** Which key sealed this (first 8 hex of the key's SHA-256) — enables rotation. */
  kid: string;
  iv: string; // base64
  tag: string; // base64 GCM auth tag
  ct: string; // base64 ciphertext
}

let cachedKey: { key: Buffer; kid: string } | null = null;
let warned = false;

/** Resolve the master key. Generated (ephemeral) if unset — with a loud warning, because then
 *  secrets do not survive a restart. Accepts base64 or hex, and requires 32 bytes. */
function masterKey(): { key: Buffer; kid: string } {
  if (cachedKey) return cachedKey;
  const raw = process.env.MYCEL_SECRET_KEY;
  let key: Buffer;
  if (raw) {
    const buf = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
    if (buf.length !== 32) {
      throw new Error(
        `MYCEL_SECRET_KEY must be 32 bytes (got ${buf.length}). Generate one with: openssl rand -base64 32`,
      );
    }
    key = buf;
  } else {
    key = randomBytes(32);
    if (!warned) {
      warned = true;
      console.warn(
        "[mycel] ⚠  MYCEL_SECRET_KEY is not set — vault secrets are encrypted with an EPHEMERAL key " +
          "and will be unreadable after a restart. Set it in any real deployment: openssl rand -base64 32",
      );
    }
  }
  cachedKey = { key, kid: createHash("sha256").update(key).digest("hex").slice(0, 8) };
  return cachedKey;
}

export function seal(plaintext: string): SealedSecret {
  const { key, kid } = masterKey();
  const iv = randomBytes(12); // 96-bit nonce, the GCM recommendation
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { v: 1, kid, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ct: ct.toString("base64") };
}

export function open_(sealed: SealedSecret): string | undefined {
  const { key, kid } = masterKey();
  if (sealed.v !== 1) return undefined;
  // Wrong key → don't even try; the GCM tag would fail anyway, but this gives a clearer signal.
  if (sealed.kid !== kid) {
    console.error(`[mycel] vault secret was sealed with key ${sealed.kid}, current key is ${kid} — cannot decrypt`);
    return undefined;
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64"));
    decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(sealed.ct, "base64")), decipher.final()]).toString("utf8");
  } catch {
    // Authentication failure = the ciphertext or tag was tampered with. Never return junk.
    console.error("[mycel] vault secret failed authentication — refusing to use it");
    return undefined;
  }
}

/** The pluggable backend. Stores only sealed envelopes; plaintext never reaches it. */
export interface SecretStore {
  put(key: string, sealed: SealedSecret): Promise<void>;
  get(key: string): Promise<SealedSecret | undefined>;
  del(key: string): Promise<void>;
}

class MemorySecretStore implements SecretStore {
  private m = new Map<string, SealedSecret>();
  async put(k: string, s: SealedSecret) { this.m.set(k, s); }
  async get(k: string) { return this.m.get(k); }
  async del(k: string) { this.m.delete(k); }
}

let backend: SecretStore = new MemorySecretStore();

/** Boot-time: Postgres when MYCEL_DATABASE_URL is set, else in-memory. */
export async function initSecretStore(): Promise<{ backend: string }> {
  const url = process.env.MYCEL_DATABASE_URL;
  if (url) {
    const { PostgresSecretStore } = await import("./secrets.pg");
    backend = await PostgresSecretStore.connect(url);
    return { backend: "postgres" };
  }
  backend = new MemorySecretStore();
  return { backend: "memory" };
}

export async function closeSecretStore(): Promise<void> {
  await (backend as SecretStore & { close?: () => Promise<void> }).close?.();
}

export async function setSecret(key: string, value: string): Promise<void> {
  await backend.put(key, seal(value));
}
export async function getSecret(key: string): Promise<string | undefined> {
  const sealed = await backend.get(key);
  return sealed ? open_(sealed) : undefined;
}
export async function deleteSecret(key: string): Promise<void> {
  await backend.del(key);
}
export async function hasSecret(key: string): Promise<boolean> {
  return !!(await backend.get(key));
}

/** Resolve a connection secret. Tries the explicit ref, then a vault entry keyed by the fallback
 *  (the connection id) — so `POST /connections/:id/secret` works without mutating the connection. */
export async function resolveSecret(secret_ref?: string, fallbackKey?: string): Promise<string | undefined> {
  if (secret_ref) {
    const env = /^env:(.+)$/.exec(secret_ref);
    if (env) return process.env[env[1]];
    const v = /^vault:(.+)$/.exec(secret_ref);
    if (v) return getSecret(v[1]);
  }
  if (fallbackKey) return getSecret(fallbackKey);
  return undefined;
}

/** Constant-time compare for secret material (e.g. verifying a presented token). */
export function secretEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a), bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** Test hook. */
export function _resetKeyCache(): void {
  cachedKey = null;
  warned = false;
}
