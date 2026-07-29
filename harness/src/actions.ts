// Executors: perform a real-world action through a Connection using its server-held secret. This
// is the far side of the action proxy — reached only after the human approval gate has said yes.
// Secrets are resolved here (never returned by any API, never sent to the sandbox).
//
// email + webhook are real (generic provider-over-HTTP + outbound webhook). stripe/sms/whatsapp/
// calendar are structured stubs — wire the provider call and they light up without touching the
// security model.
import type { Connection, ConnectionKind } from "./contract";
import { resolveSecret } from "./secrets";

export interface ActionResult {
  ok: boolean;
  detail?: string;
  data?: unknown;
}

/** A short, human-readable preview of what will happen — shown on the approval card. */
export function actionPreview(
  conn: Connection,
  capability: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return {
    connection: conn.name,
    kind: conn.kind,
    capability,
    to: payload.to ?? payload.recipient ?? payload.url ?? undefined,
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

/** The security crux: the sandbox supplies a PATH, never a host. Anything that could escape the
 *  connection's base URL (absolute URL, protocol-relative, traversal) is rejected. No SSRF. */
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
      case "stripe":
      case "sms":
      case "whatsapp":
      case "calendar":
        return {
          ok: false,
          detail: `executor for "${conn.kind}" is not implemented yet — wire the provider call in actions.ts (security model unchanged)`,
        };
      default:
        return { ok: false, detail: `unknown connection kind: ${conn.kind}` };
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
  const url = String(payload.url ?? conn.config.url ?? "");
  if (!url) return { ok: false, detail: "webhook connection missing config.url" };
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
