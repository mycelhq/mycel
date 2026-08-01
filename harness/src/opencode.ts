// OpenCode integration — the exact REST/SSE surface OpenCode exposes:
//   POST /session                      -> { id }
//   POST /session/:id/message          { parts:[{type:"text",text}], model }
//   GET  /event   (SSE)                -> message.part.delta | message.part.updated | ...
//   POST /session/:id/abort
// Auth is HTTP Basic (opencode:<password>); Daytona preview links add x-daytona-preview-token.
import type { HarnessProfile } from "./harness";
import { SHAPE_DEFAULTS } from "./harness";

// ---- Model + provider config (model + provider-env mapping) ----

export interface OpencodeConfig {
  config: Record<string, unknown>;
  providerEnv: Record<string, string>;
}

export function splitModel(model: string): { providerId: string; modelId: string } {
  const i = model.indexOf("/");
  return i === -1
    ? { providerId: "anthropic", modelId: model }
    : { providerId: model.slice(0, i), modelId: model.slice(i + 1) };
}

export function providerEnvVar(providerId: string): string {
  switch (providerId) {
    case "anthropic":
      return "ANTHROPIC_API_KEY";
    case "openai":
      return "OPENAI_API_KEY";
    case "google":
      return "GOOGLE_GENERATIVE_AI_API_KEY";
    case "openrouter":
      return "OPENROUTER_API_KEY";
    default:
      return `${providerId.toUpperCase()}_API_KEY`;
  }
}

// The OpenAI-compatible base URL for a provider. Anthropic/Google aren't OpenAI-compatible —
// route those through a LiteLLM proxy via MYCEL_LLM_UPSTREAM.
export function openaiCompatibleBase(providerId: string): string | null {
  switch (providerId) {
    case "openai":
      return "https://api.openai.com/v1";
    case "openrouter":
      return "https://openrouter.ai/api/v1";
    case "groq":
      return "https://api.groq.com/openai/v1";
    case "deepseek":
      return "https://api.deepseek.com/v1";
    case "together":
      return "https://api.together.xyz/v1";
    case "mistral":
      return "https://api.mistral.ai/v1";
    default:
      return null;
  }
}

/**
 * The pre-profile permission block, kept as the fallback for a call site with no profile.
 *
 * Headless: allow by default (there is no interactive prompt to answer, and `permission: "ask"`
 * SUSPENDS the run waiting for a POST to /permission/:id/reply that nobody is making), hard-deny
 * catastrophes. Action-level approval is added via the Mycel opencode plugin.
 *
 * Everything richer than this now lives in harness.ts, per task type.
 */
const PERMISSION = SHAPE_DEFAULTS.general.permission;

/**
 * The parts of the opencode config that come from the harness profile rather than from the model.
 *
 * Every key here was checked against the real 1.17.6 binary with `opencode debug config` and
 * `opencode debug agent build` — see the header comment in harness.ts for the full inventory and
 * for what is only in the newer published schema (`subagent_depth`, notably) and must NOT be
 * emitted at this pin.
 */
function profileConfig(profile: HarnessProfile): Record<string, unknown> {
  const agent: Record<string, unknown> = {};
  // `agent.build` is the default primary agent (verified: `default_agent` falls back to "build"),
  // so this is where per-run sampling and the iteration cap belong.
  if (profile.temperature !== undefined) agent.temperature = profile.temperature;
  if (profile.steps !== undefined) agent.steps = profile.steps;

  const config: Record<string, unknown> = {
    instructions: profile.instructions,
    permission: profile.permission,
    // Redundant with `permission` — 1.17.6 folds `tools` INTO `permission` at load — but it is the
    // spelling the per-message `tools` map uses, and keeping both in sync means a future move to
    // per-message toolsets is a one-line change rather than a translation layer.
    ...(Object.keys(profile.tools).length ? { tools: profile.tools } : {}),
    ...(Object.keys(agent).length ? { agent: { build: agent } } : {}),
    /**
     * Filesystem snapshots exist so a user can undo the agent's edits. A `decide` run makes no
     * edits, so the tracking is pure cost on a run whose whole selling point is being cheap.
     */
    snapshot: profile.shape === "build",
    /**
     * Long runs need compaction or they die of context exhaustion; short ones must never compact,
     * because compaction on a four-minute decision means the model summarised away the invoice it
     * was reasoning about.
     */
    compaction: { auto: profile.long_lived },
    /**
     * Tool output truncation. A build greps a repository and legitimately wants the output; a
     * decision reading three knowledge files does not need 2,000 lines of anything, and every line
     * is billed on every subsequent turn.
     */
    tool_output: profile.long_lived ? { max_lines: 2000 } : { max_lines: 400 },
  };
  return config;
}

/**
 * Native mode exports the provider key into the opencode server env. Proxy mode (when `proxy` is
 * passed) points opencode at the harness proxy with an opaque nonce — the real key never enters the
 * sandbox.
 *
 * `profile` is optional so that a caller with no task in hand still gets the old permissive config
 * rather than a type error; every real run passes one.
 */
export function buildOpencodeConfig(
  model: string,
  proxy?: { proxyBaseUrl: string; nonce: string; modelId: string },
  profile?: HarnessProfile,
): OpencodeConfig {
  const tuned = profile
    ? profileConfig(profile)
    : { instructions: ["AGENTS.md"], permission: PERMISSION };

  if (proxy) {
    const config: Record<string, unknown> = {
      $schema: "https://opencode.ai/config.json",
      plugin: ["./mycel-plugin.ts"],
      model: `mycel/${proxy.modelId}`,
      /**
       * Side-work (session titles, summaries, compaction) runs on `small_model`, and if it is unset
       * opencode reaches for its own default provider — which, inside a proxy-mode sandbox, does not
       * exist and has no key. `mycel` has exactly one model registered, so that is the only honest
       * answer here.
       */
      small_model: `mycel/${proxy.modelId}`,
      provider: {
        mycel: {
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: proxy.proxyBaseUrl, apiKey: proxy.nonce },
          models: { [proxy.modelId]: { name: proxy.modelId, id: proxy.modelId } },
        },
      },
      share: "disabled",
      autoupdate: false,
      ...tuned,
    };
    return { config, providerEnv: {} }; // no real key in the sandbox
  }

  const { providerId } = splitModel(model);
  const envVar = providerEnvVar(providerId);
  const providerEnv: Record<string, string> = {};
  const key = process.env[envVar];
  if (key) providerEnv[envVar] = key;

  const config: Record<string, unknown> = {
    $schema: "https://opencode.ai/config.json",
    plugin: ["./mycel-plugin.ts"],
    model,
    share: "disabled",
    autoupdate: false,
    ...tuned,
  };
  return { config, providerEnv };
}

// ---- OpenCode server client (hand-rolled HTTP/SSE) ----

export interface OpenCodeEvent {
  type: string;
  properties?: any;
}

export class OpenCodeClient {
  constructor(
    private baseUrl: string,
    private auth: { username: string; password: string },
    private previewToken?: string,
  ) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const basic = Buffer.from(`${this.auth.username}:${this.auth.password}`).toString("base64");
    const h: Record<string, string> = { authorization: `Basic ${basic}`, ...extra };
    if (this.previewToken) h["x-daytona-preview-token"] = this.previewToken;
    return h;
  }

  async waitReady(timeoutMs = 60000, shouldAbort?: () => string | null): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const reason = shouldAbort?.();
      if (reason) throw new Error(`aborted: ${reason}`);
      try {
        const r = await fetch(`${this.baseUrl}/session`, { headers: this.headers() });
        if (r.ok) return;
      } catch {
        /* retry */
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error("opencode server did not become ready");
  }

  async createSession(title: string): Promise<string> {
    const r = await fetch(`${this.baseUrl}/session`, {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify({ title }),
    });
    if (!r.ok) throw new Error(`create session failed: ${r.status} ${await r.text()}`);
    const j: any = await r.json();
    return j.id ?? j.sessionID;
  }

  /**
   * Send the prompt.
   *
   * `model` arrives provider-prefixed ("mycel/gpt-5.6-luna") because that is how it is named
   * everywhere else — in the tier ladder, in the config we write, in the proxy grant. OpenCode's
   * message endpoint wants it split:
   *
   *     400 Expected object | null, got "mycel/gpt-5.6-luna" at ["model"]
   *
   * It used to take the string. This is the shape 1.17.6 wants, and it is the first thing a real run
   * hit after the sandbox finally booted — the API had moved and nothing here had noticed, because
   * no run had ever got this far to find out.
   *
   * Split on the FIRST slash only: model ids legitimately contain slashes
   * (openrouter's "anthropic/claude-3.5-sonnet" behind a provider, for one), and splitting on all of
   * them silently addresses the wrong model rather than failing.
   */
  async sendPrompt(
    sessionId: string,
    text: string,
    model: string,
    /**
     * Per-message harness controls. Verified present on POST /session/:id/message in 1.17.6's own
     * OpenAPI document (GET /doc): `agent`, `tools` (the boolean map again), `system`, `variant`
     * and `format`.
     *
     * `format: {type:"json_schema", schema, retryCount}` is OpenCode's NATIVE structured output —
     * it re-prompts the model itself when the answer does not validate. That is strictly better
     * than the sentence `buildPrompt` used to append ("Return a result conforming to this schema"),
     * because a schema violation currently costs the whole task: `runTask` validates the text and
     * throws, so the run is billed in full and delivers nothing.
     */
    opts?: { format?: { type: "json_schema"; schema: unknown; retryCount?: number } },
  ): Promise<void> {
    const slash = model.indexOf("/");
    const modelRef =
      slash > 0
        ? { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) }
        : null;

    const r = await fetch(`${this.baseUrl}/session/${sessionId}/message`, {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify({
        parts: [{ type: "text", text }],
        model: modelRef,
        ...(opts?.format ? { format: opts.format } : {}),
      }),
    });
    if (!r.ok) throw new Error(`send prompt failed: ${r.status} ${await r.text()}`);
  }

  async abort(sessionId: string): Promise<void> {
    try {
      await fetch(`${this.baseUrl}/session/${sessionId}/abort`, {
        method: "POST",
        headers: this.headers(),
      });
    } catch {
      /* noop */
    }
  }

  /** Global SSE stream. Yields parsed events; caller filters by sessionID. */
  async *events(signal?: AbortSignal): AsyncGenerator<OpenCodeEvent> {
    const r = await fetch(`${this.baseUrl}/event`, {
      headers: this.headers({ accept: "text/event-stream" }),
      signal,
    });
    if (!r.ok || !r.body) throw new Error(`event stream failed: ${r.status}`);
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line.startsWith("data:")) {
          const payload = line.slice(5).trim();
          if (payload) {
            try {
              yield JSON.parse(payload) as OpenCodeEvent;
            } catch {
              /* skip malformed */
            }
          }
        }
      }
    }
  }
}
