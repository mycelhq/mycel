// OpenCode integration — the REST/SSE surface OpenCode 1.17.6 actually exposes.
//
// Every path and payload below was checked against `@opencode-ai/sdk@1.17.6`, which is generated
// from the same OpenAPI document the server serves at GET /doc. Where this file used to describe
// something else, the old description is kept as a comment: the drift is the interesting part.
//
//   POST /session                      -> { id, title, ... }
//   POST /session/:id/prompt_async     { parts, model } -> 204, returns IMMEDIATELY
//   POST /session/:id/message          { parts, model } -> { info, parts }, BLOCKS for the whole turn
//   GET  /event   (SSE)                -> see OpenCodeEventMapper for the real event union
//   POST /session/:id/abort
//
// Auth is HTTP Basic (opencode:<password>); Daytona preview links add x-daytona-preview-token.
import type { EventType } from "./contract";
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

export interface ComponentMcpConfig {
  /** opencode `mcp` server entries to merge into the config for a build run. */
  servers: Record<string, unknown>;
}

/**
 * Component-library MCP servers for a BUILD run — the site-build agent composes from best-in-class UI
 * components (21st.dev "Magic") instead of hand-rolling every section, which is how a generated site
 * gets a Lovable-grade baseline. Returns undefined for any non-build shape, or when no provider is
 * configured.
 *
 * ═══ WHY THIS IS OPT-IN AND DORMANT BY DEFAULT ═══
 *
 * mcpbridge.ts's whole design keeps provider credentials OUT of the sandbox, and this is the one
 * place that bends it — knowingly and narrowly. Magic authenticates in-process (it is a stdio server
 * that reads its own API key) and has no server-side proxy today, so mounting it puts the key in the
 * opencode config the model can read. That is acceptable ONLY because: the key is MYCEL-OWNED (not a
 * founder's), LOW-VALUE (it fetches public UI components, rate-limited), and scoped to the founder's
 * OWN internal site build — not a client-facing run, not a cross-tenant surface. And it is dormant:
 * a provider mounts only when its key is set on the KERNEL env, so the default build touches no
 * credential at all. When a real server-side component proxy exists (buildgrants.ts is the template),
 * this moves behind it and the key leaves the sandbox for good.
 */
export function buildComponentMcpConfig(
  shape: string,
  env: NodeJS.ProcessEnv = process.env,
): ComponentMcpConfig | undefined {
  if (shape !== "build") return undefined;
  const servers: Record<string, unknown> = {};

  const magicKey = (env.MYCEL_MAGIC_API_KEY ?? "").trim();
  if (magicKey) {
    servers.magic = {
      type: "local",
      command: ["npx", "-y", "@21st-dev/magic@latest"],
      environment: { API_KEY: magicKey },
      enabled: true,
    };
  }

  return Object.keys(servers).length ? { servers } : undefined;
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
  /**
   * MCP servers to mount, in opencode's own `mcp` config shape.
   *
   * VERIFIED against the pinned 1.17.6 binary rather than assumed: `opencode debug config` echoes
   * this key back, `opencode mcp list` connects a `{"type":"local","command":[…]}` entry, and the
   * resulting tools reach the model as `<serverName>_<toolName>`. The full transcript, including why
   * the only server we mount is a local one we wrote, is in mcpbridge.ts.
   *
   * Placed BEFORE `...tuned` deliberately — a harness profile that ever needs to strip MCP for a
   * shape (a `build` run has no connections and should mount nothing) must be able to win.
   */
  mcp?: Record<string, unknown>,
): OpencodeConfig {
  const tuned = profile
    ? profileConfig(profile)
    : { instructions: ["AGENTS.md"], permission: PERMISSION };
  const mcpBlock = mcp && Object.keys(mcp).length ? { mcp } : {};

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
      ...mcpBlock,
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
    ...mcpBlock,
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
   * Start the prompt WITHOUT waiting for the turn to finish.
   *
   * `model` arrives provider-prefixed ("mycel/gpt-5.6-luna") because that is how it is named
   * everywhere else — in the tier ladder, in the config we write, in the proxy grant. OpenCode's
   * message endpoint wants it split:
   *
   *     400 Expected object | null, got "mycel/gpt-5.6-luna" at ["model"]
   *
   * Split on the FIRST slash only: model ids legitimately contain slashes
   * (openrouter's "anthropic/claude-3.5-sonnet" behind a provider, for one), and splitting on all of
   * them silently addresses the wrong model rather than failing.
   *
   * WHY `prompt_async` AND NOT `/message`
   *
   * `POST /session/:id/message` is SYNCHRONOUS. Its 200 body is
   * `{ info: AssistantMessage, parts: Part[] }` — the FINISHED assistant message — so awaiting it
   * blocks for the entire turn. The runtime used to `await` it and only THEN subscribe to /event,
   * which meant the whole run happened while nothing was listening: a production task burned
   * 165,000 tokens and recorded four events, none of them from the agent. The stream was opened
   * onto a session that had already gone quiet.
   *
   * `POST /session/:id/prompt_async` answers 204 the moment the prompt is accepted (verified in the
   * 1.17.6 OpenAPI document: response 204, "Prompt accepted"). That is what lets the caller hold an
   * open event stream for the duration, which is the only way any of this is observable.
   *
   * The `/message` fallback exists for a pin that predates `prompt_async`. It is deliberately NOT
   * awaited — awaiting it would reintroduce exactly the deadlock above — so on that path a prompt
   * rejection surfaces as a `session.error` on the stream rather than as a throw from here.
   */
  /**
   * WHY THIS BODY CARRIES NO `format` KEY.
   *
   * The comment that used to live here said `format: {type:"json_schema", ...}` was not part of the
   * 1.17.6 API and was silently stripped, so a strict-output run "believed it had native schema
   * enforcement and in fact had nothing". That was wrong, and production proved it wrong: once the
   * bind-address bug stopped masking every run before it reached the model, a shaping run read its
   * skill, planned three todos, worked for two minutes and died on
   *
   *     opencode StructuredOutputError: Model did not produce structured output
   *
   * — an error only reachable when `format` IS honoured. So the claim was inverted. It was checked
   * against `@opencode-ai/sdk@1.17.6`'s generated types, which are stale; the SHIPPED BINARY is the
   * only authority, and it says otherwise.
   *
   * WHAT THE PINNED BINARY ACTUALLY DOES (read out of `opencode-ai@1.17.6`'s `bin/opencode.exe`):
   *
   *   · `class OutputFormatJsonSchema` exists — `{type:"json_schema", schema, retryCount}`, with
   *     `retryCount` defaulting to 2. So the key is decoded, not dropped. Our request was correct.
   *   · When a prompt carries it, the session loop injects a synthetic tool named
   *     `StructuredOutput` whose `inputSchema` is our schema minus `$schema`, and sets
   *     `toolChoice: "required"` on EVERY step of the agentic loop.
   *   · The answer therefore arrives as a CALL to that tool. Its captured value is stored on the
   *     assistant message as `message.structured`; the tool's own visible output is the fixed
   *     string "Structured output captured successfully."
   *   · If the turn ever finishes with a reason other than `tool-calls`/`unknown` without that tool
   *     having fired, the loop hard-fails with
   *     `new StructuredOutputError({message:"Model did not produce structured output", retries:0})`.
   *   · `retries: 0` is a literal. Nothing in the binary reads `format.retryCount` on that path, so
   *     the `retryCount: 2` we were sending bought exactly nothing.
   *
   * That mechanism is incompatible with this harness in two independent ways, either of which alone
   * is fatal:
   *
   *   1. The answer lands in `message.structured`, which is not a text part. `OpenCodeEventMapper`
   *      builds `finalText` from text parts only, so a run that SUCCEEDS at structured output hands
   *      us an empty string — indistinguishable from a run that produced nothing. Under `format`,
   *      the best case is silent emptiness and the worst case is the error above.
   *   2. An agent that does the work correctly and states the JSON in its final message — which is
   *      precisely what the strict-output prompt now asks for, because asking for a file first
   *      doubled every run's cost — is killed by rule 4 above after the work is already done.
   *
   * So the request no longer asks for it. The schema is enforced where it always actually was: the
   * prompt states it, `runTask` validates the answer against it, and `contractWatch` accepts a
   * schema-valid `output/result.txt` if the agent writes one. One rule, one place, no silent
   * emptiness. Re-adding `format` here requires reading `message.structured` first.
   */
  async startPrompt(sessionId: string, text: string, model: string): Promise<void> {
    const slash = model.indexOf("/");
    const modelRef =
      slash > 0
        ? { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) }
        : null;

    const body = JSON.stringify({
      parts: [{ type: "text", text }],
      model: modelRef,
    });
    const init = {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body,
    };

    const r = await fetch(`${this.baseUrl}/session/${sessionId}/prompt_async`, init);
    if (r.ok) return;
    if (r.status !== 404) throw new Error(`send prompt failed: ${r.status} ${await r.text()}`);

    void fetch(`${this.baseUrl}/session/${sessionId}/message`, init)
      .then(async (m) => {
        if (!m.ok) console.error(`[mycel] opencode prompt failed: ${m.status} ${await m.text()}`);
      })
      .catch((e) => console.error("[mycel] opencode prompt failed:", e));
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

  /**
   * Open the global SSE stream and return an iterator over it.
   *
   * Separate from `events()` because the connection must be ESTABLISHED before the prompt is sent,
   * and an async generator does nothing at all until its first `next()`. `const it = oc.events()`
   * followed by `sendPrompt` looks like it subscribes first and does not: the fetch happens on the
   * first iteration, by which time the agent has been running for a while and everything it did in
   * the meantime is gone. `await openEvents()` has done the handshake by the time it returns.
   */
  async openEvents(signal?: AbortSignal): Promise<AsyncGenerator<OpenCodeEvent>> {
    const r = await fetch(`${this.baseUrl}/event`, {
      headers: this.headers({ accept: "text/event-stream" }),
      signal,
    });
    if (!r.ok || !r.body) throw new Error(`event stream failed: ${r.status}`);
    return parseSSE(r.body);
  }

  /** Global SSE stream. Yields parsed events; caller filters by sessionID. */
  async *events(signal?: AbortSignal): AsyncGenerator<OpenCodeEvent> {
    yield* await this.openEvents(signal);
  }
}

async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<OpenCodeEvent> {
  const reader = body.getReader();
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

// ---- OpenCode event stream -> Mycel contract events ----
//
// WHAT OPENCODE 1.17.6 ACTUALLY EMITS ON GET /event
//
// Verified by reading the generated types in `@opencode-ai/sdk@1.17.6` (dist/gen/types.gen.d.ts,
// `export type Event = ...`), which is produced from the server's own OpenAPI document. The full
// union is 32 members; the ones that carry any information about a run are:
//
//   message.part.updated   { part: Part, delta?: string }
//   message.updated        { info: AssistantMessage | UserMessage }
//   message.removed        { sessionID, messageID }
//   message.part.removed   { sessionID, messageID, partID }
//   session.idle           { sessionID }
//   session.status         { sessionID, status: {type:"idle"|"busy"|"retry", ...} }
//   session.error          { sessionID?, error?: {name, data:{message?}} }
//   session.compacted      { sessionID }
//   permission.updated     Permission  (id, sessionID, title, metadata, ...)
//   todo.updated           { sessionID, todos: Todo[] }
//   file.edited            { file }
//
// and the rest are lifecycle/editor noise: session.created/updated/deleted/diff, file.watcher.updated,
// vcs.branch.updated, lsp.*, installation.*, tui.*, pty.*, server.connected,
// server.instance.disposed, permission.replied, command.executed.
//
// WHAT THE OLD MAPPING BELIEVED, AND WHY THE LOG WAS EMPTY
//
//   · `message.part.delta`  — DOES NOT EXIST. Deltas ride on `message.part.updated` as a sibling
//     `delta` field next to `part`. So `token.delta` was never once emitted.
//   · `message.info`        — DOES NOT EXIST. Usage arrives on `message.updated` under
//     `properties.info`. So `onCost` was never called and `cost.charged` was never written: every
//     run in the system was, as far as the ledger knew, free.
//   · `message.completed` / `session.completed` — DO NOT EXIST. Only `session.idle` (which the old
//     switch did handle) and `session.status.type === "idle"` mean the turn is over.
//   · tool parts were read as `{ toolName, result, invocation.input, args }`. The real shape is
//     `{ tool, callID, state: {status, input, output|error, title, time} }`. `part.result` is
//     never defined, so the `result !== undefined` branch was dead: every tool update emitted
//     another `tool.called` with `args: undefined` and no `tool.result` ever paired with it.
//   · usage keys were read as `input_tokens|inputTokens|prompt_tokens`. The real shape is
//     `tokens: {input, output, reasoning, cache:{read, write}}`, so even had `message.info`
//     existed, `estimateCost` would have priced every run at exactly $0.00.
//
// The class below is a pure fold — no I/O, no clock — because that is the only way a stream mapper
// can be tested against a recorded fixture, and a mapper nobody can test is how the drift above
// survived this long.

/** One Mycel contract event the mapper wants written. */
export interface MycelEmission {
  type: EventType;
  data: Record<string, unknown>;
}

/**
 * An INCREMENT of usage, already differenced against what has been reported for the same message.
 *
 * OpenCode republishes `message.updated` many times per turn with CUMULATIVE totals on the message,
 * so anything that charged the raw numbers would bill a long turn dozens of times over. The mapper
 * keeps the last-seen totals per message id and hands out only the difference.
 */
export interface UsageDelta {
  /** "provider/model" as OpenCode reports it — inside a proxy sandbox this is `mycel/<id>`. */
  model: string;
  input: number;
  output: number;
  reasoning: number;
  cache_read: number;
  cache_write: number;
  /** OpenCode's own dollar figure. 0 when the provider has no price table — see runtime.ts. */
  cost_usd: number;
}

export interface MappedEvent {
  emissions: MycelEmission[];
  usage?: UsageDelta;
  /** The turn is over. */
  done?: boolean;
  /** The run failed inside OpenCode; the caller should throw with this. */
  error?: string;
}

const NOTHING: MappedEvent = { emissions: [] };

/**
 * Event types that carry nothing a Mycel trace wants, listed EXPLICITLY.
 *
 * The point of naming them is that everything not on this list and not handled below is counted as
 * unmapped drift. An empty allowlist would make every editor and LSP event look like a regression;
 * no allowlist at all would make the next protocol change look like normal operation, which is the
 * failure this whole class exists to prevent.
 */
const IGNORED = new Set([
  "server.connected",
  "server.instance.disposed",
  "session.created",
  "session.updated",
  "session.deleted",
  "session.diff",
  "message.removed",
  "message.part.removed",
  "permission.replied",
  "command.executed",
  "file.watcher.updated",
  "vcs.branch.updated",
  "installation.updated",
  "installation.update.available",
  "lsp.client.diagnostics",
  "lsp.updated",
  "tui.prompt.append",
  "tui.command.execute",
  "tui.toast.show",
  "pty.created",
  "pty.updated",
  "pty.exited",
  "pty.deleted",
]);

/** How many DISTINCT unrecognised event types are remembered. Bounded: this is a hostile input. */
const MAX_UNMAPPED_TYPES = 32;

/** Which session an event belongs to, across the four places 1.17.6 puts the id. */
export function sessionIdOf(ev: OpenCodeEvent): string | undefined {
  const p: any = ev.properties;
  const id =
    p?.sessionID ??
    p?.part?.sessionID ??
    p?.info?.sessionID ??
    // session.created/updated/deleted put the session under `info` where the id IS the session id.
    (typeof p?.info?.directory === "string" ? p?.info?.id : undefined);
  return typeof id === "string" ? id : undefined;
}

export class OpenCodeEventMapper {
  /** Tool calls announced, keyed by callID — OpenCode republishes a part on every state change. */
  private called = new Set<string>();
  private resolved = new Set<string>();
  /** Cumulative usage last seen per assistant message, so only deltas are charged. */
  private usageSeen = new Map<string, UsageDelta>();
  /** Text parts of the most recent assistant message, in arrival order. */
  private textParts = new Map<string, string>();
  private textMessageId?: string;
  /** Unrecognised types and how often each was seen. Bounded by MAX_UNMAPPED_TYPES. */
  private unmappedCounts = new Map<string, number>();
  private loggedUnmapped = new Set<string>();
  /**
   * Whether the session has visibly done anything yet.
   *
   * The stream is now opened BEFORE the prompt, so an idle signal published in that window is about
   * a session that has not started, not one that has finished. Acting on it would end every run
   * with an empty answer.
   */
  private started = false;

  constructor(private sessionId: string) {}

  /** The agent's answer: the text parts of its LAST message, joined in arrival order. */
  get finalText(): string {
    return Array.from(this.textParts.values()).join("").trim();
  }

  /** Unrecognised event types seen, for the drift counter on `task.finished`. */
  get unmapped(): Record<string, number> {
    return Object.fromEntries(this.unmappedCounts);
  }

  /** True when this event is for another session and should be skipped entirely. */
  foreign(ev: OpenCodeEvent): boolean {
    const sid = sessionIdOf(ev);
    return sid !== undefined && sid !== this.sessionId;
  }

  map(ev: OpenCodeEvent): MappedEvent {
    switch (ev.type) {
      case "message.part.updated":
        return this.onPartUpdated(ev);
      case "message.updated":
        return this.onMessageUpdated(ev);
      case "session.status": {
        const status: any = (ev.properties as any)?.status;
        if (status?.type === "busy") {
          this.started = true;
          return NOTHING;
        }
        if (status?.type === "retry") {
          return {
            emissions: [
              {
                type: "progress",
                data: { note: `retrying (attempt ${status.attempt ?? "?"}): ${status.message ?? ""}`.trim() },
              },
            ],
          };
        }
        return status?.type === "idle" && this.started ? { emissions: [], done: true } : NOTHING;
      }
      case "session.idle":
        return this.started ? { emissions: [], done: true } : NOTHING;
      case "session.compacted":
        // Worth saying out loud: a compacted run answered from a summary of its own context, which
        // is the usual explanation for an answer that forgot something it was told.
        return { emissions: [{ type: "progress", data: { note: "context compacted" } }] };
      case "session.error": {
        const err: any = (ev.properties as any)?.error;
        const name = typeof err?.name === "string" ? err.name : "UnknownError";
        const message = typeof err?.data?.message === "string" ? err.data.message : JSON.stringify(err?.data ?? {});
        return { emissions: [], error: `opencode ${name}: ${message}` };
      }
      case "permission.updated": {
        // Headless runs configure `permission: allow`, so this should never fire — and if it does,
        // the run is now SUSPENDED waiting for a POST to /permission/:id/reply that nobody is
        // making. Silence here is a run that dies on the runtime ceiling with no explanation.
        const p: any = ev.properties;
        return {
          emissions: [
            { type: "progress", data: { note: `opencode is waiting for permission: ${p?.title ?? p?.type ?? "unknown"}` } },
          ],
        };
      }
      case "todo.updated": {
        const todos: any[] = Array.isArray((ev.properties as any)?.todos) ? (ev.properties as any).todos : [];
        if (!todos.length) return NOTHING;
        const doneCount = todos.filter((t) => t?.status === "completed").length;
        const active = todos.find((t) => t?.status === "in_progress");
        return {
          emissions: [
            {
              type: "progress",
              data: {
                note: `plan: ${doneCount}/${todos.length} done${active?.content ? ` — ${active.content}` : ""}`,
                todos_total: todos.length,
                todos_done: doneCount,
              },
            },
          ],
        };
      }
      case "file.edited": {
        const file = (ev.properties as any)?.file;
        return typeof file === "string"
          ? { emissions: [{ type: "progress", data: { note: `edited ${file}`, file } }] }
          : NOTHING;
      }
      default:
        if (IGNORED.has(ev.type)) return NOTHING;
        this.noteUnmapped(ev);
        return NOTHING;
    }
  }

  /**
   * An unrecognised event, counted and logged ONCE with its shape.
   *
   * Logging the key names rather than the payload is deliberate: the payload can contain the
   * customer's data (a tool's output, a draft email), and this line goes to stdout. The key names
   * are enough to recognise the new event and go look it up in the SDK types.
   */
  private noteUnmapped(ev: OpenCodeEvent): void {
    const known = this.unmappedCounts.has(ev.type);
    if (!known && this.unmappedCounts.size >= MAX_UNMAPPED_TYPES) return;
    this.unmappedCounts.set(ev.type, (this.unmappedCounts.get(ev.type) ?? 0) + 1);
    if (!this.loggedUnmapped.has(ev.type)) {
      this.loggedUnmapped.add(ev.type);
      const keys = ev.properties && typeof ev.properties === "object" ? Object.keys(ev.properties) : [];
      console.warn(`[mycel] unmapped opencode event "${ev.type}" { ${keys.join(", ")} }`);
    }
  }

  private onPartUpdated(ev: OpenCodeEvent): MappedEvent {
    this.started = true;
    const p: any = ev.properties;
    const part: any = p?.part;
    const emissions: MycelEmission[] = [];

    // The delta is a SIBLING of the part, not a part type of its own. Both text and reasoning parts
    // stream this way, and the kind is kept on the event so a trace can tell thinking from answer.
    if (typeof p?.delta === "string" && p.delta) {
      emissions.push({ type: "token.delta", data: { text: p.delta, kind: part?.type ?? "text" } });
    }
    if (!part || typeof part.type !== "string") return { emissions };

    switch (part.type) {
      case "text": {
        // `synthetic` parts are OpenCode's own scaffolding (compaction notes, tool preambles) and
        // are not the agent's answer.
        if (part.synthetic || typeof part.text !== "string") break;
        // Only the LAST message's text is the deliverable. Joining every text part of the session
        // would prefix a strict-output run's JSON with whatever it said three steps ago, and
        // `validateOutput` would reject the whole run for it.
        if (part.messageID && part.messageID !== this.textMessageId) {
          this.textMessageId = part.messageID;
          this.textParts.clear();
        }
        this.textParts.set(part.id ?? String(this.textParts.size), part.text);
        break;
      }
      case "tool": {
        const key = String(part.callID ?? part.id ?? "");
        const name = String(part.tool ?? "tool");
        const state: any = part.state ?? {};
        const status = state.status;
        // Announced on the first update that is not `pending`: a pending part carries only a
        // half-parsed `raw` string and an empty `input`, so announcing then would record every
        // tool call in the system with no arguments.
        if (status && status !== "pending" && !this.called.has(key)) {
          this.called.add(key);
          emissions.push({
            type: "tool.called",
            data: { tool: name, call_id: key, args: state.input ?? {} },
          });
        }
        if ((status === "completed" || status === "error") && !this.resolved.has(key)) {
          this.resolved.add(key);
          const ok = status === "completed";
          const ms =
            typeof state.time?.end === "number" && typeof state.time?.start === "number"
              ? state.time.end - state.time.start
              : undefined;
          emissions.push({
            type: "tool.result",
            data: {
              tool: name,
              call_id: key,
              ok,
              ...(ok ? {} : { error: String(state.error ?? "tool failed") }),
              ...(state.title ? { title: String(state.title) } : {}),
              ...(ms === undefined ? {} : { duration_ms: ms }),
            },
          });
        }
        break;
      }
      case "retry": {
        emissions.push({
          type: "progress",
          data: { note: `provider retry ${part.attempt ?? "?"}: ${part.error?.data?.message ?? ""}`.trim() },
        });
        break;
      }
      case "patch": {
        const files: unknown[] = Array.isArray(part.files) ? part.files : [];
        if (files.length) emissions.push({ type: "progress", data: { note: `patched ${files.length} file(s)`, files } });
        break;
      }
      // reasoning is already covered by the delta above; step-start/step-finish/snapshot/agent/
      // compaction/file/subtask carry no timeline of their own. Usage on step-finish is deliberately
      // NOT charged here — see onMessageUpdated for why the message is the only safe unit.
      default:
        break;
    }
    return { emissions };
  }

  /**
   * Usage, cost and — for the first time — WHICH MODEL RAN.
   *
   * `properties.info` is the whole message, republished on every mutation with cumulative totals.
   * Charging the difference per message id is the only accounting that is correct whether OpenCode
   * publishes once or fifty times, and it is why `step-finish` parts (which carry their own `cost`
   * and `tokens`) are left alone: it is not documented whether those are per-step or cumulative,
   * and guessing wrong double-bills a customer.
   */
  private onMessageUpdated(ev: OpenCodeEvent): MappedEvent {
    const info: any = (ev.properties as any)?.info;
    if (!info || info.role !== "assistant") return NOTHING;
    this.started = true;

    const t = info.tokens ?? {};
    const total: UsageDelta = {
      model: [info.providerID, info.modelID].filter(Boolean).join("/") || "unknown",
      input: num(t.input),
      output: num(t.output),
      reasoning: num(t.reasoning),
      cache_read: num(t.cache?.read),
      cache_write: num(t.cache?.write),
      cost_usd: num(info.cost),
    };
    const seen = this.usageSeen.get(info.id) ?? {
      model: total.model,
      input: 0,
      output: 0,
      reasoning: 0,
      cache_read: 0,
      cache_write: 0,
      cost_usd: 0,
    };
    this.usageSeen.set(info.id, total);

    // Clamped at zero: OpenCode may revise a total downward (a retried step is re-costed), and a
    // negative charge would silently refund a customer for work that did happen.
    const delta: UsageDelta = {
      model: total.model,
      input: Math.max(0, total.input - seen.input),
      output: Math.max(0, total.output - seen.output),
      reasoning: Math.max(0, total.reasoning - seen.reasoning),
      cache_read: Math.max(0, total.cache_read - seen.cache_read),
      cache_write: Math.max(0, total.cache_write - seen.cache_write),
      cost_usd: Math.max(0, total.cost_usd - seen.cost_usd),
    };
    const moved =
      delta.input || delta.output || delta.reasoning || delta.cache_read || delta.cache_write || delta.cost_usd;

    const emissions: MycelEmission[] = [];
    // A message that ends in an error is how a provider 400 (bad model name, filtered content)
    // reaches us: `session.error` is not always published for it.
    if (info.error) {
      const name = typeof info.error.name === "string" ? info.error.name : "UnknownError";
      const message =
        typeof info.error.data?.message === "string" ? info.error.data.message : JSON.stringify(info.error.data ?? {});
      return { emissions, usage: moved ? delta : undefined, error: `opencode ${name}: ${message}` };
    }
    return { emissions, usage: moved ? delta : undefined };
  }
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
