// One place to configure the harness. Everything the founder tunes lives here:
// which sandbox backend runs OpenCode, and which LLM it uses. Extensible — add a backend
// by implementing Sandbox and registering it in createSandbox().
import { TIER_MODELS } from "./models";
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
  /** Container image for the docker backend, where `mycel/sandbox:latest` is built locally by setup.sh. */
  sandboxImage: string;
  /**
   * Explicit registry image for the daytona backend, or undefined for the built-in snapshot.
   *
   * Distinct from `sandboxImage` on purpose. `mycel/sandbox:latest` is a real image on a laptop that
   * ran `docker build`; it is a fiction in Daytona's registry, and passing it to `client.create`
   * failed every cloud task. So daytona defaults to the snapshot we build from our own image
   * definition (sandbox.snapshot.ts) and only takes an image when someone deliberately names one —
   * the escape hatch for anyone shipping their own sandbox.
   */
  sandboxImageOverride?: string;
  /** Port OpenCode's server listens on inside the sandbox. */
  opencodePort: number;
  /** Directory for per-task JSONL event logs (always on). */
  logsDir: string;
  /**
   * Langfuse tracing (opt-in). Present only when both keys are set.
   *
   * The operator's OWN sink — bring your own account and it points at your own org. Nothing here
   * provisions a Langfuse project for anyone else: that path was removed because it needed an API
   * that exists only on self-hosted Enterprise. Customer-facing traces come from `traces.ts`.
   */
  langfuse?: LangfuseConfig;
  /** Shared secret the sandbox plugin presents to /v1/internal/gate. */
  gateToken: string;
  /** Founder API key required (Bearer) on the public /v1 surface. */
  apiKey: string;
  /**
   * URL the sandbox uses to reach this harness (localhost / host.docker.internal / public).
   *
   * Read it as "the address of this harness AS SEEN FROM INSIDE THE SANDBOX", not "the address of
   * this harness". The default below is only correct when the sandbox shares a loopback interface
   * with the harness — i.e. the `local` backend on a laptop. In a Daytona microVM, 127.0.0.1 is the
   * microVM, so every callback the runtime injects (gate, actions, reads, case, workflows, gaps,
   * records, and the LLM proxy in proxy mode) resolves to a port nothing is listening on.
   * `sandboxReachability` in sandbox.ts refuses to boot on that combination.
   */
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
  /**
   * How long `/v1/internal/llm` waits on the upstream (LiteLLM / provider) before aborting.
   *
   * Without this, a hung Anthropic/OpenAI connection holds the sandbox's model call open until the
   * ALB idle timeout — and the task never reaches `task.finished`, so the UI spins forever. A
   * clean abort becomes a 504 on the proxy, which OpenCode surfaces as a failed prompt, which the
   * orchestrator turns into `failed` + `task.finished`. Default 120s: long enough for a slow
   * completion, short enough that a hang is not mistaken for progress.
   */
  llmUpstreamTimeoutMs: number;
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
    // The last-resort fallback only. Model choice normally comes from the tier ladder in models.ts,
    // which is what the plan gates and what the margin maths assumes. This was still Anthropic after
    // the move to OpenAI-via-LiteLLM, so a wedge that pinned it would have failed on every run with
    // no provider key to reach.
    model: process.env.MYCEL_MODEL ?? TIER_MODELS.standard,
    sandboxImage: process.env.MYCEL_SANDBOX_IMAGE ?? "mycel/sandbox:latest",
    sandboxImageOverride: (process.env.MYCEL_SANDBOX_IMAGE ?? "").trim() || undefined,
    opencodePort: Number(process.env.OPENCODE_PORT ?? 4444),
    logsDir: process.env.MYCEL_LOG_DIR ?? ".mycel/logs",
    langfuse,
    gateToken: GATE_TOKEN,
    apiKey: API_KEY,
    publicUrl: process.env.MYCEL_PUBLIC_URL ?? `http://127.0.0.1:${process.env.PORT ?? 4000}`,
    proxyMode: process.env.MYCEL_PROXY_MODE === "1",
    runtime: process.env.MYCEL_RUNTIME === "mock" ? "mock" : "opencode",
    maxCostCeilingUsd: Number(process.env.MYCEL_MAX_COST_USD ?? 50),
    /**
     * 3600, raised from 1800 when the production build became a TOOL the agent calls.
     *
     * The old ceiling was sized for a run that never blocked on anything slower than a model call.
     * A `build` run now spends real wall clock waiting on CodeBuild — `mycel-build` blocks for the
     * three to six minutes a Next.js + OpenNext build takes, up to three times (see
     * MAX_BUILDS_PER_RUN) — so up to ~18 minutes of a build run's budget can be spent watching a
     * compiler rather than working. At 1800 that left barely ten minutes to read a codebase, make a
     * change and fix what the first build found, and a run killed mid-fix delivers nothing while
     * having paid for everything.
     *
     * This is a CEILING, not a default: `general` still asks for 240s and `decide` for 600s, and
     * neither moves. Only a shape that asks for more can now get it.
     */
    maxRuntimeCeilingS: Number(process.env.MYCEL_MAX_RUNTIME_S ?? 3600),
    maxTokensCeiling: Number(process.env.MYCEL_MAX_TOKENS ?? 8192),
    llmUpstreamTimeoutMs: Number(process.env.MYCEL_LLM_UPSTREAM_TIMEOUT_MS ?? 120_000),
  };
}

/**
 * Would a sandbox on a DIFFERENT machine reach this URL?
 *
 * Only false for the loopback family and the unroutable wildcard, plus anything that isn't a URL at
 * all. Deliberately not a positive test ("is this a public https hostname"): a self-hosted install
 * may legitimately point the sandbox at an internal DNS name, a Tailscale address, an ngrok tunnel,
 * or `host.docker.internal`, and a whitelist would refuse every one of them. The only thing we can
 * say with certainty is that an address meaning "this machine" is wrong when "this machine" is the
 * sandbox rather than the harness.
 *
 * Blank counts as unreachable for the same reason `databaseUrl` treats it as absent: a secret store
 * that hands back an empty string is a normal way to deploy a half-configured stack, and the empty
 * string would otherwise sail past the `??` default and produce callback URLs like `/v1/internal/gate`.
 */
export function reachableFromOtherHosts(url: string): boolean {
  const raw = (url ?? "").trim();
  if (!raw) return false;
  let host: string;
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    return false;
  }
  // URL() keeps IPv6 literals in brackets; strip them so ::1 compares as itself.
  const h = host.replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost")) return false;
  if (h === "::1" || h === "0:0:0:0:0:0:0:1") return false;
  // 0.0.0.0 and :: mean "every interface here", which is never an address to dial.
  if (h === "0.0.0.0" || h === "::") return false;
  // The whole 127/8 block, not just 127.0.0.1 — 127.0.0.2 is just as local.
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return false;
  return true;
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
  // Prefer the transaction-mode pooler when one is configured. See `sessionDatabaseUrl` for why
  // there are two and which callers must not use this one.
  const pooled = (process.env.MYCEL_DATABASE_POOLED_URL ?? "").trim();
  if (pooled) return pooled;
  const raw = (process.env.MYCEL_DATABASE_URL ?? "").trim();
  return raw ? raw : undefined;
}

/**
 * The SESSION-mode URL. Always the direct connection, never the transaction pooler.
 *
 * There are two because Supabase's poolers are two different things behind one hostname:
 *
 *   · port 5432 — SESSION mode. One Postgres backend is held for the client's whole lifetime. Every
 *     session feature works and the ceiling is brutally low: 15 clients on nano, shared by every
 *     replica. Two kernels at a pool of five plus a worker spends the entire budget, which is why a
 *     read-only query from a laptop got EMAXCONNSESSION while the system was idle.
 *   · port 6543 — TRANSACTION mode. A backend is borrowed per transaction and handed back, so
 *     hundreds of clients share a few backends. The cost is that nothing may outlive a transaction.
 *
 * Almost everything here runs short autocommit queries and belongs on 6543. One thing does not:
 * graphile-worker uses LISTEN/NOTIFY, and a LISTEN is a subscription owned by a session. In
 * transaction mode the backend is given to someone else immediately afterwards and the notification
 * is never delivered. Nothing errors — jobs just stop arriving until the fallback poll finds them,
 * which presents as latency rather than as breakage, and is therefore the kind of bug that survives.
 *
 * Unset in a self-hosted install, where a single direct connection string is both.
 */
export function sessionDatabaseUrl(): string | undefined {
  const raw = (process.env.MYCEL_DATABASE_URL ?? "").trim();
  return raw ? raw : undefined;
}
