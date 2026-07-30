// Composio — OAuth and 250+ toolkits, without putting a single provider token in the sandbox.
//
// Why this exists: every credential in Mycel was paste-a-token-by-hand, which rules out most real
// accounting and CRM software outright. Xero's access tokens last 30 minutes and need a refresh
// round trip; a founder is not going to re-paste one every half hour. Composio holds the OAuth grant
// and refreshes it, so "connect Xero" becomes a click instead of a project.
//
// How it fits the trust boundary — this is the part that matters:
//
//   · The Composio API key lives HERE, in the harness, exactly like a model provider key. It is
//     never handed to the sandbox, never echoed in a response, never put in an approval preview.
//     The agent gets an opaque action nonce and asks for a capability; the harness makes the call.
//
//   · `user_id` is derived from the CONNECTION's owner, never from anything the agent sends. This is
//     the whole per-client story: a client-owned connection maps to that client's Composio account,
//     and since the agent cannot influence `user_id`, it cannot act as a different customer even if
//     it tries. (`selectGrantableConnections` already stops it from reaching the connection at all;
//     this is the second lock on the same door.)
//
//   · Composio tools are mostly WRITES. Sending them all down the ungated read path would quietly
//     destroy the read/write asymmetry — `XERO_CREATE_INVOICE` is not a read just because the agent
//     called it through /reads. So a connection must explicitly list which tool slugs are readable;
//     everything else has to go through the human gate. See `isReadTool`.
//
// Implemented against the REST API with plain fetch rather than the SDK: the kernel's dependency
// list is deliberately three packages, and a fake base URL makes the whole thing testable offline.
import type { Connection } from "./contract";

const DEFAULT_BASE = "https://backend.composio.dev";

export interface ComposioConfig {
  apiKey: string;
  baseUrl: string;
}

/** The Composio-specific settings that live on a connection's (non-secret) config. */
export interface ComposioConnConfig {
  /** Composio toolkit slug — "xero", "quickbooks", "hubspot", "gmail". */
  toolkit: string;
  /** The auth config to connect through. Created once per toolkit in the Composio dashboard. */
  auth_config_id?: string;
  /** Set once OAuth completes. Its presence is what "connected" means for a Composio connection. */
  connected_account_id?: string;
  /**
   * Tool slugs the agent may call through the UNGATED read path. Explicit allowlist, because
   * Composio does not tell us which of its tools have side effects, and guessing from the name
   * ("GET", "LIST") would be a security control built on a naming convention.
   */
  read_tools?: string[];
}

export class ComposioError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function composioConfig(): ComposioConfig | undefined {
  const apiKey = process.env.COMPOSIO_API_KEY;
  if (!apiKey) return undefined;
  return { apiKey, baseUrl: process.env.COMPOSIO_BASE_URL ?? DEFAULT_BASE };
}

export function isComposio(conn: Pick<Connection, "kind">): boolean {
  return conn.kind === "composio";
}

export function connConfig(conn: Pick<Connection, "config">): ComposioConnConfig {
  const c = (conn.config ?? {}) as Record<string, unknown>;
  return {
    toolkit: String(c.toolkit ?? ""),
    auth_config_id: typeof c.auth_config_id === "string" ? c.auth_config_id : undefined,
    connected_account_id:
      typeof c.connected_account_id === "string" ? c.connected_account_id : undefined,
    read_tools: Array.isArray(c.read_tools) ? (c.read_tools as unknown[]).map(String) : undefined,
  };
}

/**
 * The Composio account a connection speaks for.
 *
 * Founder-owned → one shared identity. Client-owned → that client's id, so each customer's Xero is a
 * separate Composio account under the same API key. Derived from the connection alone, on purpose:
 * see the header note.
 */
export function composioUserId(conn: Pick<Connection, "owner" | "project_id">): string {
  const scope = conn.project_id ? `${conn.project_id}:` : "";
  return conn.owner.kind === "client" ? `${scope}client:${conn.owner.id}` : `${scope}founder`;
}

/** Whether a tool slug may be called through the ungated read path. Default: no. */
export function isReadTool(conn: Pick<Connection, "config">, slug: string): boolean {
  const allow = connConfig(conn).read_tools ?? [];
  return allow.some((s) => s.toUpperCase() === slug.toUpperCase());
}

async function call<T>(
  cfg: ComposioConfig,
  path: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), init.timeoutMs ?? 30_000);
  try {
    const res = await fetch(`${cfg.baseUrl}/api/v3${path}`, {
      ...init,
      signal: ctrl.signal,
      headers: {
        // The one place this key appears. Never logged, never returned, never sent to the sandbox.
        "x-api-key": cfg.apiKey,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = text;
    }
    if (!res.ok) {
      const detail =
        (body as { error?: { message?: string }; message?: string })?.error?.message ??
        (body as { message?: string })?.message ??
        `composio ${res.status}`;
      throw new ComposioError(res.status, detail);
    }
    return body as T;
  } finally {
    clearTimeout(timer);
  }
}

export type ConnectedAccountStatus =
  | "INITIALIZING"
  | "INITIATED"
  | "ACTIVE"
  | "FAILED"
  | "EXPIRED"
  | "INACTIVE"
  | "REVOKED";

export interface InitiateResult {
  connected_account_id: string;
  status: ConnectedAccountStatus;
  /** Where to send the founder to authorise. Absent for API-key toolkits, which need no redirect. */
  redirect_url?: string;
}

/**
 * Begin authorising a toolkit. For OAuth this returns the URL the founder must visit; Composio owns
 * the callback, so Mycel needs no public redirect route of its own — one less internet-facing
 * surface, and no half-finished OAuth state to store.
 */
export async function initiateConnection(
  cfg: ComposioConfig,
  args: { authConfigId: string; userId: string; callbackUrl?: string },
): Promise<InitiateResult> {
  const body = await call<{
    id: string;
    connectionData?: { val?: { status?: string; redirectUrl?: string } };
  }>(cfg, "/connected_accounts", {
    method: "POST",
    body: JSON.stringify({
      auth_config: { id: args.authConfigId },
      connection: {
        user_id: args.userId,
        ...(args.callbackUrl ? { callback_url: args.callbackUrl } : {}),
      },
    }),
  });
  const val = body.connectionData?.val ?? {};
  return {
    connected_account_id: body.id,
    status: (val.status as ConnectedAccountStatus) ?? "INITIALIZING",
    redirect_url: val.redirectUrl,
  };
}

export async function connectionStatus(
  cfg: ComposioConfig,
  connectedAccountId: string,
): Promise<{ status: ConnectedAccountStatus; toolkit?: string; status_reason?: string }> {
  const body = await call<{
    status: ConnectedAccountStatus;
    status_reason?: string;
    toolkit?: { slug?: string };
  }>(cfg, `/connected_accounts/${encodeURIComponent(connectedAccountId)}`);
  return { status: body.status, toolkit: body.toolkit?.slug, status_reason: body.status_reason };
}

export interface ToolSummary {
  slug: string;
  name?: string;
  description?: string;
  input_parameters?: unknown;
}

/** What can I call? For a founder authoring a wedge, not for the agent at run time. */
export async function listTools(
  cfg: ComposioConfig,
  args: { toolkit?: string; search?: string; limit?: number },
): Promise<ToolSummary[]> {
  const q = new URLSearchParams();
  if (args.toolkit) q.set("toolkit_slug", args.toolkit);
  if (args.search) q.set("search", args.search);
  q.set("limit", String(Math.min(args.limit ?? 50, 200)));
  const body = await call<{ items?: ToolSummary[] }>(cfg, `/tools?${q}`);
  return (body.items ?? []).map((t) => ({
    slug: t.slug,
    name: t.name,
    description: t.description,
    input_parameters: t.input_parameters,
  }));
}

export interface ExecuteResult {
  successful: boolean;
  data?: unknown;
  error?: string;
  log_id?: string;
}

/**
 * Run one tool. `slug` is the capability the agent asked for; `userId` and `connectedAccountId` come
 * from the connection, so the agent chooses *what* to do and never *whose account* to do it in.
 */
export async function executeTool(
  cfg: ComposioConfig,
  args: {
    slug: string;
    userId: string;
    connectedAccountId?: string;
    arguments?: Record<string, unknown>;
  },
): Promise<ExecuteResult> {
  const body = await call<{ successful?: boolean; data?: unknown; error?: string; log_id?: string }>(
    cfg,
    `/tools/execute/${encodeURIComponent(args.slug)}`,
    {
      method: "POST",
      body: JSON.stringify({
        user_id: args.userId,
        ...(args.connectedAccountId ? { connected_account_id: args.connectedAccountId } : {}),
        arguments: args.arguments ?? {},
      }),
      timeoutMs: 60_000,
    },
  );
  return {
    successful: !!body.successful,
    data: body.data,
    // Composio returns `error: ""` on success; don't surface an empty string as a failure reason.
    error: body.error || undefined,
    log_id: body.log_id,
  };
}

export interface Toolkit {
  slug: string;
  name: string;
  /** Logo / description live under `meta`, which Composio types loosely. */
  logo?: string;
  description?: string;
  categories: string[];
  /** True when Composio supplies the OAuth app, so the founder registers nothing. */
  composio_managed: boolean;
  no_auth: boolean;
}

interface RawToolkit {
  slug: string;
  name: string;
  no_auth?: boolean;
  deprecated?: boolean;
  composio_managed_auth_schemes?: string[];
  meta?: { logo?: string; description?: string; categories?: Array<{ name?: string; slug?: string } | string> };
}

/** The app catalogue. What a founder browses when they want to connect something. */
export async function listToolkits(
  cfg: ComposioConfig,
  args: { search?: string; category?: string; limit?: number; cursor?: string },
): Promise<{ items: Toolkit[]; next_cursor?: string; total?: number }> {
  const q = new URLSearchParams();
  if (args.search) q.set("search", args.search);
  if (args.category) q.set("category", args.category);
  if (args.cursor) q.set("cursor", args.cursor);
  q.set("limit", String(Math.min(args.limit ?? 40, 100)));
  const body = await call<{ items?: RawToolkit[]; next_cursor?: string; total_items?: number }>(
    cfg,
    `/toolkits?${q}`,
  );
  const items = (body.items ?? [])
    .filter((t) => !t.deprecated)
    .map((t) => ({
      slug: t.slug,
      name: t.name,
      logo: t.meta?.logo,
      description: t.meta?.description,
      categories: (t.meta?.categories ?? []).map((c) => (typeof c === "string" ? c : (c.name ?? c.slug ?? ""))).filter(Boolean),
      // Composio-managed auth is what makes this one click: their OAuth app, not one the founder
      // has to go and register with the provider first.
      composio_managed: (t.composio_managed_auth_schemes ?? []).length > 0,
      no_auth: !!t.no_auth,
    }));
  return { items, next_cursor: body.next_cursor, total: body.total_items };
}

export async function listCategories(cfg: ComposioConfig): Promise<{ slug: string; name: string }[]> {
  const body = await call<{ items?: Array<{ slug?: string; id?: string; name?: string }> }>(
    cfg,
    "/toolkits/categories",
  );
  return (body.items ?? [])
    .map((c) => ({ slug: String(c.slug ?? c.id ?? ""), name: String(c.name ?? c.slug ?? "") }))
    .filter((c) => c.slug);
}

/**
 * Create an auth config for a toolkit using COMPOSIO-MANAGED auth.
 *
 * This is what turns "connect Xero" into one click instead of a project. The alternative —
 * `use_custom_auth` — means the founder registers an OAuth app with the provider, copies a client id
 * and secret, and configures redirect URIs. Nobody running a bookkeeping practice is doing that, so
 * the product default has to be the managed path.
 *
 * Idempotent by intent: created once per toolkit per project and then reused (see the caller).
 */
export async function createManagedAuthConfig(
  cfg: ComposioConfig,
  args: { toolkit: string; name?: string },
): Promise<{ id: string }> {
  const body = await call<{ auth_config?: { id?: string }; id?: string }>(cfg, "/auth_configs", {
    method: "POST",
    body: JSON.stringify({
      toolkit: { slug: args.toolkit },
      auth_config: { type: "use_composio_managed_auth", name: args.name ?? `mycel-${args.toolkit}` },
    }),
  });
  const id = body.auth_config?.id ?? body.id;
  if (!id) throw new ComposioError(502, "composio did not return an auth config id");
  return { id };
}

/** A tool slug looks like TOOLKIT_ACTION. Used to match a capability to a Composio connection. */
export function slugToolkit(slug: string): string | undefined {
  const m = /^([A-Za-z0-9]+)_/.exec(slug.trim());
  return m ? m[1].toLowerCase() : undefined;
}
