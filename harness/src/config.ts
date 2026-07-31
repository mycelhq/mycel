// One place to configure the harness. Everything the founder tunes lives here:
// which sandbox backend runs OpenCode, and which LLM it uses. Extensible — add a backend
// by implementing Sandbox and registering it in createSandbox().
import { randomBytes } from "node:crypto";

export type SandboxBackend = "local" | "docker" | "daytona";

// Stable for the life of the process: the shared secret the sandbox plugin presents to the
// gate endpoint. Set MYCEL_GATE_TOKEN to fix it across restarts.
const GATE_TOKEN = process.env.MYCEL_GATE_TOKEN ?? randomBytes(16).toString("hex");

// The founder API key that guards the public /v1 surface. Set MYCEL_API_KEY in prod (and in the
// product's server env so its proxy routes can present it). If unset we generate an ephemeral
// one per boot and print it — the API is NEVER unauthenticated, even in dev.
const API_KEY_ENV = process.env.MYCEL_API_KEY;
const API_KEY = API_KEY_ENV ?? `msk_${randomBytes(24).toString("base64url")}`;
export const API_KEY_GENERATED = !API_KEY_ENV;

export interface LangfuseConfig {
  secretKey: string;
  publicKey: string;
  baseUrl: string;
}

export interface MycelConfig {
  /** Where OpenCode runs: local host process, a local Docker container, or a Daytona microVM. */
  sandboxBackend: SandboxBackend;
  /** Default model, provider-prefixed (e.g. "anthropic/claude-opus-4-8", "openai/gpt-...", "google/gemini-..."). Per-task override via task.input.model. */
  model: string;
  /** Container/snapshot image for docker + daytona backends. */
  sandboxImage: string;
  /** Port OpenCode's server listens on inside the sandbox. */
  opencodePort: number;
  /** Directory for per-task JSONL event logs (always on). */
  logsDir: string;
  /** Langfuse tracing (opt-in). Present only when both keys are set. */
  langfuse?: LangfuseConfig;
  /** Shared secret the sandbox plugin presents to /v1/internal/gate. */
  gateToken: string;
  /** Founder API key required (Bearer) on the public /v1 surface. */
  apiKey: string;
  /** URL the sandbox uses to reach this harness (localhost / host.docker.internal / public). */
  publicUrl: string;
  /** Proxy mode: route model calls through the harness so provider keys never enter the sandbox. */
  proxyMode: boolean;
  /** Runtime: "opencode" drives a real agent in a sandbox; "mock" streams canned events (no
   *  OpenCode/keys) — for demos and the test suite. */
  runtime: "opencode" | "mock";
  /** Hard server-side ceilings; client-supplied constraints are clamped to these. */
  maxCostCeilingUsd: number;
  maxRuntimeCeilingS: number;
  /** Cap on max_tokens the sandbox may request through the LLM proxy. */
  maxTokensCeiling: number;
}

export function loadConfig(): MycelConfig {
  const explicit = process.env.MYCEL_SANDBOX as SandboxBackend | undefined;
  const backend: SandboxBackend =
    explicit ?? (process.env.DAYTONA_API_KEY ? "daytona" : "local");

  const lfSecret = process.env.LANGFUSE_SECRET_KEY;
  const lfPublic = process.env.LANGFUSE_PUBLIC_KEY;
  const langfuse: LangfuseConfig | undefined =
    lfSecret && lfPublic
      ? {
          secretKey: lfSecret,
          publicKey: lfPublic,
          baseUrl: process.env.LANGFUSE_HOST ?? "https://cloud.langfuse.com",
        }
      : undefined;

  return {
    sandboxBackend: backend,
    model: process.env.MYCEL_MODEL ?? "anthropic/claude-opus-4-8",
    sandboxImage: process.env.MYCEL_SANDBOX_IMAGE ?? "mycel/sandbox:latest",
    opencodePort: Number(process.env.OPENCODE_PORT ?? 4444),
    logsDir: process.env.MYCEL_LOG_DIR ?? ".mycel/logs",
    langfuse,
    gateToken: GATE_TOKEN,
    apiKey: API_KEY,
    publicUrl: process.env.MYCEL_PUBLIC_URL ?? `http://127.0.0.1:${process.env.PORT ?? 4000}`,
    proxyMode: process.env.MYCEL_PROXY_MODE === "1",
    runtime: process.env.MYCEL_RUNTIME === "mock" ? "mock" : "opencode",
    maxCostCeilingUsd: Number(process.env.MYCEL_MAX_COST_USD ?? 50),
    maxRuntimeCeilingS: Number(process.env.MYCEL_MAX_RUNTIME_S ?? 1800),
    maxTokensCeiling: Number(process.env.MYCEL_MAX_TOKENS ?? 8192),
  };
}

/**
 * The database URL, or undefined.
 *
 * Trimmed, and blank counts as absent. A secret store that hands back an empty string is a common
 * way to deploy: the secret exists because infrastructure created it, and nobody has put a value in
 * yet. Reading `process.env.MYCEL_DATABASE_URL` directly made that case a crash loop on boot rather
 * than the in-memory fallback the kernel already has.
 */
export function databaseUrl(): string | undefined {
  const raw = (process.env.MYCEL_DATABASE_URL ?? "").trim();
  return raw ? raw : undefined;
}
