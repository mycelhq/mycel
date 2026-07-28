// OpenCode integration — the exact REST/SSE surface OpenCode exposes:
//   POST /session                      -> { id }
//   POST /session/:id/message          { parts:[{type:"text",text}], model }
//   GET  /event   (SSE)                -> message.part.delta | message.part.updated | ...
//   POST /session/:id/abort
// Auth is HTTP Basic (opencode:<password>); Daytona preview links add x-daytona-preview-token.

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

// Native mode: the provider key is exported into the opencode server env. 's default
// is proxy mode (keys stay server-side behind a signed token) — add that as a hardening step
// (a signed-token model proxy).
export function buildOpencodeConfig(model: string): OpencodeConfig {
  const { providerId } = splitModel(model);
  const envVar = providerEnvVar(providerId);
  const providerEnv: Record<string, string> = {};
  const key = process.env[envVar];
  if (key) providerEnv[envVar] = key;

  const config: Record<string, unknown> = {
    $schema: "https://opencode.ai/config.json",
    instructions: ["AGENTS.md"],
    plugin: ["./mycel-plugin.ts"],
    model,
    // Headless: allow by default (no interactive prompt to hang on), hard-deny catastrophes.
    // Action-level approval is added via a Mycel opencode plugin (the Mycel plugin pattern).
    permission: {
      "*": "allow",
      bash: {
        "rm -rf /": "deny",
        "rm -rf /*": "deny",
        "mkfs*": "deny",
        ":(){ :|:& };:": "deny",
      },
    },
    share: "disabled",
    autoupdate: false,
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

  async waitReady(timeoutMs = 60000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
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

  async sendPrompt(sessionId: string, text: string, model: string): Promise<void> {
    const r = await fetch(`${this.baseUrl}/session/${sessionId}/message`, {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify({ parts: [{ type: "text", text }], model }),
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
