// Executors: perform a real-world action through a Connection using its server-held secret. This
// is the far side of the action proxy — reached only after the human approval gate has said yes.
// Secrets are resolved here (never returned by any API, never sent to the sandbox).
//
// email + webhook are real (generic provider-over-HTTP + outbound webhook). stripe/sms/whatsapp/
// calendar are structured stubs — wire the provider call and they light up without touching the
// security model.
import type { Connection, ConnectionKind } from "./contract";
import {
  composioConfig,
  composioUserId,
  connConfig as composioConnConfig,
  executeTool,
} from "./composio";
import { resolveSecret } from "./secrets";

export interface ActionResult {
  ok: boolean;
  detail?: string;
  data?: unknown;
}

/** A short, human-readable preview of what will happen — shown on the approval card. */
/**
 * What an approval card may carry.
 *
 * The preview is PERSISTED in the approvals row and RENDERED to a human, so whatever goes in here
 * outlives the run and gets read. That is right for the amount and the recipient — a human
 * approving "create an invoice in Xero" has to see them — and wrong for three things the agent can
 * put in a tool argument without anyone intending it:
 *
 *   · A credential. Some brokered tools take a token or a webhook secret as an argument. Once one
 *     lands in an approval row it is in the database, in the UI, and in anything that reads either.
 *   · A document. An argument can be an entire attachment or a 200KB body. A preview is a summary
 *     for a human to judge, not a copy of the payload.
 *   · Depth. Nested structures render as unreadable JSON, which trains people to approve without
 *     looking — the worst possible outcome for a gate whose whole value is that it is read.
 *
 * Subtractive by key name and size, deliberately: an allowlist would need to know every tool in
 * Composio's catalogue, and a tool added tomorrow would silently show nothing.
 */
const SECRET_KEY = /token|secret|password|passwd|api[-_]?key|authorization|credential|private[-_]?key|signature|bearer/i;
/** Long enough to show an invoice line or an email subject; short enough not to be a document. */
const MAX_STRING = 400;
const MAX_ITEMS = 20;
const MAX_DEPTH = 4;

export function redactPreview(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}… [${value.length} chars]` : value;
  }
  if (typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return "[nested]";
  if (Array.isArray(value)) {
    const head = value.slice(0, MAX_ITEMS).map((v) => redactPreview(v, depth + 1));
    return value.length > MAX_ITEMS ? [...head, `… ${value.length - MAX_ITEMS} more`] : head;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    // Redacted rather than dropped: a human deciding whether to approve should be able to see THAT
    // a token was going to be sent, just not what it is.
    out[k] = SECRET_KEY.test(k) ? "[redacted]" : redactPreview(v, depth + 1);
  }
  return out;
}

export function actionPreview(
  conn: Connection,
  capability: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  // `endpoint` is the host the credential will actually be sent to, taken from the CONNECTION
  // rather than the payload. A human approving an outbound call should be able to see the
  // destination; a preview that only echoes what the agent asked for isn't a check on the agent.
  const endpoint = conn.config.url ?? conn.config.api_url ?? undefined;
  if (conn.kind === "composio") {
    // For a brokered call the meaningful preview is the toolkit, the tool and its arguments — a
    // human approving "create an invoice in Xero" needs to see the amount and the customer, and
    // there is no `to`/`subject`/`body` to fall back on.
    const cc = composioConnConfig(conn);
    return {
      connection: conn.name,
      kind: conn.kind,
      capability,
      toolkit: cc.toolkit,
      tool: capability,
      // Arguments only. Never the Composio API key, and never the connected account's token —
      // neither is in `payload`, and this is the note that keeps it that way.
      arguments: redactPreview(payload.arguments ?? payload.body ?? {}),
      preview: `${cc.toolkit}: ${capability}`,
    };
  }
  return {
    connection: conn.name,
    kind: conn.kind,
    capability,
    to: redactPreview(payload.to ?? payload.recipient ?? undefined),
    endpoint,
    subject: payload.subject ?? undefined,
    preview: typeof payload.body === "string" ? payload.body.slice(0, 400) : payload.body,
  };
}

// ── reads ──
// Reads are the asymmetric half of the trust model: a read is *ungated* (an agent that has to
// wait for a human before it can look at today's transactions is useless) but still *scoped* —
// only through a granted connection, only GET, host set by the connection, size-capped, traced.
export const MAX_READ_BYTES = 256 * 1024;

/** Result of a scoped read. `truncated` tells the agent it didn't get everything. */
export interface ReadResult {
  ok: boolean;
  status?: number;
  detail?: string;
  bytes?: number;
  truncated?: boolean;
  body?: string;
  data?: unknown;
}

/** The security crux, for reads AND writes: the sandbox supplies a PATH, never a host. Anything that
 *  could escape the connection's base URL (absolute URL, protocol-relative, traversal) is rejected.
 *  No SSRF, and no sending a connection's credential to a host the agent chose. */
export function safeReadPath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const p = raw.trim();
  if (!p) return "";
  if (/^[a-z][a-z0-9+.-]*:/i.test(p)) return null; // http:, file:, gopher: …
  if (p.startsWith("//")) return null; // protocol-relative → different host
  if (p.includes("..")) return null; // traversal
  if (/[\r\n]/.test(p)) return null; // header injection
  return p.replace(/^\/+/, "");
}

export async function executeRead(
  conn: Connection,
  capability: string,
  params: Record<string, unknown>,
): Promise<ReadResult> {
  const secret = await resolveSecret(conn.secret_ref, conn.id);
  const base = String(conn.config.api_url ?? conn.config.base_url ?? conn.config.url ?? "");
  if (!base) return { ok: false, detail: `connection "${conn.name}" has no config.api_url to read from` };

  const path = safeReadPath(params.path ?? "");
  if (path === null) return { ok: false, detail: "invalid path: must be a relative path, not a URL" };

  const url = new URL(`${base.replace(/\/+$/, "")}/${path}`);
  const query = params.query;
  if (query && typeof query === "object") {
    for (const [k, v] of Object.entries(query as Record<string, unknown>)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }

  try {
    const res = await fetch(url, {
      method: "GET", // reads are reads
      headers: {
        accept: "application/json",
        ...(secret ? { authorization: `Bearer ${secret}` } : {}),
      },
      signal: AbortSignal.timeout(20_000),
    });
    const raw = await res.text();
    const truncated = raw.length > MAX_READ_BYTES;
    const body = truncated ? raw.slice(0, MAX_READ_BYTES) : raw;
    let data: unknown;
    try {
      data = JSON.parse(body);
    } catch {
      /* not json — the agent gets `body` */
    }
    return { ok: res.ok, status: res.status, bytes: raw.length, truncated, body: data ? undefined : body, data };
  } catch (e) {
    return { ok: false, detail: String((e as Error)?.message ?? e) };
  }
}

export async function executeAction(
  conn: Connection,
  capability: string,
  payload: Record<string, unknown>,
): Promise<ActionResult> {
  const secret = await resolveSecret(conn.secret_ref, conn.id);
  try {
    switch (conn.kind as ConnectionKind) {
      case "email":
        return await sendEmail(conn, payload, secret);
      case "webhook":
      case "custom":
        return await postWebhook(conn, payload, secret);
      case "composio":
        return await runComposioTool(conn, capability, payload);
      default:
        // Anything else is a config mistake, and saying so beats a stub that pretends to work.
        // Stripe, SMS, WhatsApp and calendars all live behind `composio` now.
        return {
          ok: false,
          detail: `no executor for connection kind "${conn.kind}" — use kind "composio" with the matching toolkit`,
        };
    }
  } catch (e) {
    return { ok: false, detail: String((e as Error)?.message ?? e) };
  }
}

// Generic email-over-HTTP (Postmark/SendGrid/Resend-style): POST to config.api_url with the
// secret as a bearer token. Configure api_url + from on the connection.
async function sendEmail(
  conn: Connection,
  payload: Record<string, unknown>,
  secret?: string,
): Promise<ActionResult> {
  const apiUrl = String(conn.config.api_url ?? "");
  if (!apiUrl) return { ok: false, detail: "email connection missing config.api_url" };
  const res = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(secret ? { authorization: `Bearer ${secret}` } : {}),
    },
    body: JSON.stringify({
      from: conn.config.from,
      to: payload.to,
      subject: payload.subject ?? "",
      text: payload.body ?? payload.text ?? "",
      html: payload.html,
    }),
  });
  return { ok: res.ok, detail: `HTTP ${res.status}`, data: await safeJson(res) };
}

async function postWebhook(
  conn: Connection,
  payload: Record<string, unknown>,
  secret?: string,
): Promise<ActionResult> {
  // The host comes from the CONNECTION, never from the payload.
  //
  // This used to be `payload.url ?? conn.config.url`, so an agent-supplied url won outright — and
  // since the connection's secret is attached below as a bearer token, that was a way to post the
  // credential itself to any host the agent named. Reads have always been guarded this way
  // (`safeReadPath`); writes were not, which is the wrong asymmetry: the gated half of the trust
  // boundary was the loose one.
  //
  // The agent may still choose a path within the connection's host, which is what a webhook
  // connection legitimately needs.
  const base = String(conn.config.url ?? conn.config.api_url ?? "");
  if (!base) return { ok: false, detail: "webhook connection missing config.url" };
  const suffix = payload.path ?? payload.url;
  const rel = suffix === undefined ? "" : safeReadPath(suffix);
  if (rel === null) {
    return { ok: false, detail: "path must stay within the connection's host (no absolute url, no traversal)" };
  }
  const url = rel ? `${base.replace(/\/+$/, "")}/${rel}` : base;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(secret ? { authorization: `Bearer ${secret}` } : {}),
    },
    body: JSON.stringify(payload.body ?? payload),
  });
  return { ok: res.ok, detail: `HTTP ${res.status}`, data: await safeJson(res) };
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

/**
 * Execute a Composio tool. The capability IS the tool slug.
 *
 * Note what the agent does not get to choose: the API key (harness-held), the Composio user
 * (derived from the connection owner) and the connected account (from the connection's config). It
 * chooses the tool and its arguments, and a human still approves. Same shape as every other action —
 * Composio widens what the business can reach without widening what the sandbox can hold.
 */
async function runComposioTool(
  conn: Connection,
  capability: string,
  payload: Record<string, unknown>,
): Promise<ActionResult> {
  const cfg = composioConfig();
  if (!cfg) return { ok: false, detail: "COMPOSIO_API_KEY is not set on the harness" };
  const cc = composioConnConfig(conn);
  if (!cc.connected_account_id) {
    return { ok: false, detail: `connection "${conn.name}" is not connected yet — authorise ${cc.toolkit || "the toolkit"} first` };
  }
  const args = (payload.arguments ?? payload.body ?? {}) as Record<string, unknown>;
  try {
    const r = await executeTool(cfg, {
      slug: capability,
      userId: composioUserId(conn),
      connectedAccountId: cc.connected_account_id,
      arguments: args,
    });
    return { ok: r.successful, detail: r.error ?? (r.successful ? "ok" : "tool reported failure"), data: r.data };
  } catch (e) {
    // A Composio error message can quote request context, so pass through the message only — never
    // headers, and never the key.
    return { ok: false, detail: `composio: ${(e as Error).message}` };
  }
}
