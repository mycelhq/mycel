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
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Connection } from "./contract";

const DEFAULT_BASE = "https://backend.composio.dev";

/**
 * Trigger instances live on a DIFFERENT API version to everything else.
 *
 * Toolkits, auth configs, connected accounts and tool execution are `/api/v3`. Trigger instances
 * and webhook subscriptions moved to `/api/v3.1` — the docs still show `/api/v3` for the upsert,
 * their own generated client only ever calls `/api/v3.1`. Pinned here rather than guessed at each
 * call site, and overridable without a release when they move it again.
 */
const TRIGGERS_API = process.env.COMPOSIO_TRIGGERS_API_VERSION ?? "v3.1";

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
  /**
   * Which scheme that auth config was built for.
   *
   * Remembered because an auth config is scheme-bound: one built for managed OAuth cannot be reused
   * to attach an API key. Without this, a founder who connected a toolkit one way and later needed
   * the other would silently reuse the wrong config and get a connection that never activates.
   */
  auth_scheme?: AuthScheme;
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
    /**
     * Composio's stable machine-readable error identifier, e.g. `Auth_Config_DefaultAuthConfigNotFound`.
     *
     * Kept because the MESSAGE is the wrong thing to branch on and we have been bitten by exactly
     * that before. Their prose interpolates the toolkit slug and has been reworded at least once;
     * the slug is what their own SDK matches. Undefined when the body carried no slug.
     */
    readonly slug?: string,
    readonly code?: number,
  ) {
    super(message);
  }
}

/**
 * "Composio has no managed credentials for this toolkit."
 *
 * This is THE error behind the founder report: `POST /auth_configs` with
 * `type: "use_composio_managed_auth"` returns 400 / code 306 / slug
 * `Auth_Config_DefaultAuthConfigNotFound` for every toolkit outside the ~120 Composio registered an
 * OAuth app for. We used to let that surface raw as a 502, which told a bookkeeper nothing.
 *
 * Matched on the slug first and the prose only as a fallback, because a 400 that we mis-classify as
 * a transport failure sends the founder to a retry button that can never work.
 */
export function isMissingManagedAuth(e: unknown): boolean {
  if (!(e instanceof ComposioError)) return false;
  if (e.slug && /DefaultAuthConfigNotFound/i.test(e.slug)) return true;
  return /default auth config not found for toolkit/i.test(e.message);
}

// ─────────────────────────────────────────────────────────────────────────────
// Auth schemes — the thing we used to assume
//
// Mycel assumed every one of Composio's ~1000 toolkits was managed OAuth. It is not: Composio
// registered its own OAuth app for roughly 120 of them, and everything else either needs the
// developer's own OAuth client or does not use OAuth at all (an API key, a bearer token, basic
// credentials). Connecting anything outside that subset therefore failed with an error that was
// completely accurate and completely unactionable.
//
// The enum below is Composio's, verbatim from the v3 OpenAPI spec (`auth_config.authScheme`). It is
// wider than the obvious four; `SAML`, `DCR_OAUTH` and `S2S_OAUTH2` are real values we will not
// meet often but must not crash on.
// ─────────────────────────────────────────────────────────────────────────────

export const AUTH_SCHEMES = [
  "OAUTH2",
  "OAUTH1",
  "API_KEY",
  "BASIC",
  "BILLCOM_AUTH",
  "BEARER_TOKEN",
  "GOOGLE_SERVICE_ACCOUNT",
  "NO_AUTH",
  "BASIC_WITH_JWT",
  "CALCOM_AUTH",
  "SERVICE_ACCOUNT",
  "SAML",
  "DCR_OAUTH",
  "S2S_OAUTH2",
] as const;

export type AuthScheme = (typeof AUTH_SCHEMES)[number];

/**
 * Schemes that finish in a browser: Composio hands back a URL, the founder authorises at the
 * provider, and the account only goes ACTIVE afterwards. Everything NOT in this set completes in the
 * same request that started it, because we hand Composio the credential directly.
 *
 * This split is the whole reason the connect flow branches. Sending a redirect-less scheme down the
 * OAuth path produces a connection with no redirect URL and no credential — a row that exists and
 * does nothing, which is precisely the failure `verified_at` was added to stop.
 */
const REDIRECT_SCHEMES = new Set<AuthScheme>(["OAUTH2", "OAUTH1", "DCR_OAUTH", "S2S_OAUTH2", "SAML"]);

export function isRedirectScheme(scheme: AuthScheme): boolean {
  return REDIRECT_SCHEMES.has(scheme);
}

/** Preference order when a toolkit offers several. OAuth first: it is the one where the founder
 *  never has to hold a long-lived secret, and Composio refreshes it. A pasted API key is the
 *  fallback, not the goal. */
const SCHEME_PREFERENCE: AuthScheme[] = [
  "OAUTH2",
  "OAUTH1",
  "DCR_OAUTH",
  "S2S_OAUTH2",
  "API_KEY",
  "BEARER_TOKEN",
  "BASIC",
  "BASIC_WITH_JWT",
  "GOOGLE_SERVICE_ACCOUNT",
  "SERVICE_ACCOUNT",
  "BILLCOM_AUTH",
  "CALCOM_AUTH",
  "SAML",
  "NO_AUTH",
];

/** Parse whatever Composio put in the array. The spec's examples are lowercase (`"oauth2"`) while
 *  every other surface — and their own SDK's strict equality — uses uppercase, so normalise rather
 *  than trust either. Unknown strings are dropped: offering a scheme we cannot build a form for is
 *  worse than not offering it. */
export function parseAuthScheme(raw: unknown): AuthScheme | undefined {
  if (typeof raw !== "string") return undefined;
  const up = raw.trim().toUpperCase();
  return (AUTH_SCHEMES as readonly string[]).includes(up) ? (up as AuthScheme) : undefined;
}

function parseSchemes(raw: unknown): AuthScheme[] {
  if (!Array.isArray(raw)) return [];
  const out: AuthScheme[] = [];
  for (const r of raw) {
    const s = parseAuthScheme(r);
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/**
 * What connecting this toolkit will actually COST the founder, decided before the click.
 *
 *   none          — nothing to connect. The toolkit needs no authentication and is already usable.
 *   one_click     — Composio's own OAuth app. Click, authorise, done.
 *   secret        — paste an API key / token / username+password. No redirect, completes at once.
 *   own_oauth_app — register an OAuth client with the provider and paste id + secret. A project.
 *   unknown       — Composio told us nothing about this toolkit's auth. We ask before we act.
 *
 * ═══ WHY `none` IS NOT `one_click` ═══
 *
 * It used to be. `no_auth` collapsed into `one_click` on the grounds that both are "click and it
 * works", and for a year that was harmless because nothing in the catalogue was `no_auth`. Then the
 * founder opened `/apps` in production, clicked Composio, Code Interpreter and Composio Search —
 * Composio's own meta-toolkits, which really do require no authentication — and got the broker's
 * own sentence back as a red toast:
 *
 *   *"cannot create an auth config for Toolkit Composio because it does not require
 *   authentication."*
 *
 * The button was not merely unhelpful, it was UNSATISFIABLE: `POST /auth_configs` for a `no_auth`
 * toolkit is an error by construction at the broker, so no retry, no credential and no amount of
 * founder effort could ever have made that click succeed. `one_click` is a promise about what
 * happens after the click, and for these toolkits the promise was false.
 *
 * These are SHOWN, not hidden. Hiding them would trade a broken button for a quieter lie: the tools
 * genuinely are reachable — the agent can already call them, with no connection row and no consent
 * to gather — so a founder searching "code interpreter" and finding nothing would be told this
 * product cannot do a thing it does. `none` lets the card say the true thing instead: available,
 * nothing to connect, no button.
 */
export type ConnectRequirement = "none" | "one_click" | "secret" | "own_oauth_app" | "unknown";

export interface ConnectPlan {
  scheme: AuthScheme;
  /** True when Composio supplies the credentials for THIS scheme (not merely for the toolkit). */
  managed: boolean;
  requirement: ConnectRequirement;
}

/**
 * Pick the scheme a click should use.
 *
 * Managed wins outright wherever it exists — that is the one-click product. Otherwise a pasteable
 * secret beats an own-OAuth-app flow, because "paste your Notion key" is thirty seconds and
 * "register an OAuth application with Notion" is an afternoon.
 */
export function planConnect(t: {
  auth_schemes: AuthScheme[];
  managed_schemes: AuthScheme[];
  no_auth: boolean;
}): ConnectPlan {
  const pick = (from: AuthScheme[]) => SCHEME_PREFERENCE.find((s) => from.includes(s));

  /**
   * NO_AUTH IS CHECKED FIRST, AND IT WINS OVER A MANAGED SCHEME.
   *
   * Order is load-bearing. Composio's meta-toolkits arrive carrying `no_auth: true` AND, in at
   * least one observed payload, a stray managed scheme — and with the managed branch first that
   * stray won, planned an OAuth connect, and sent the founder into the auth-config call that the
   * broker refuses by construction for a no-auth toolkit. `no_auth` is a statement about the
   * toolkit; a managed scheme is a statement about credentials the toolkit has no use for.
   */
  if (t.no_auth || t.auth_schemes.includes("NO_AUTH")) {
    return { scheme: "NO_AUTH", managed: false, requirement: "none" };
  }
  const managed = pick(t.managed_schemes);
  if (managed) return { scheme: managed, managed: true, requirement: "one_click" };
  const secret = pick(t.auth_schemes.filter((s) => !isRedirectScheme(s)));
  if (secret) return { scheme: secret, managed: false, requirement: "secret" };
  const oauth = pick(t.auth_schemes);
  if (oauth) return { scheme: oauth, managed: false, requirement: "own_oauth_app" };
  // Composio listed no schemes at all. Don't guess OAuth — guessing OAuth is the bug.
  return { scheme: "OAUTH2", managed: false, requirement: "unknown" };
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
    auth_scheme: parseAuthScheme(c.auth_scheme),
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
  init: RequestInit & { timeoutMs?: number; apiVersion?: string } = {},
): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), init.timeoutMs ?? 30_000);
  try {
    const res = await fetch(`${cfg.baseUrl}/api/${init.apiVersion ?? "v3"}${path}`, {
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
      // `{ error: { message, code, slug, status } }` is the current envelope; the bare `message` is
      // the older one and still turns up on a few paths.
      const err = (body as { error?: { message?: string; slug?: string; code?: number } })?.error;
      const detail = err?.message ?? (body as { message?: string })?.message ?? `composio ${res.status}`;
      throw new ComposioError(res.status, detail, err?.slug, err?.code);
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
 *
 * `credentials` is the OTHER half of the story, and it is the half that was missing. For a
 * non-redirect scheme there is no browser step: the secret the founder pasted goes up here, in
 * `connection.state`, and the account is ACTIVE by the time this returns. `state` — not the legacy
 * `connection.data`, which the current spec marks deprecated — and `status` is required inside
 * `val`, so it is always sent.
 *
 * Nothing in `credentials` is ever logged, echoed, or written to a connection's config; see the
 * caller in server.ts, which seals it in the vault instead.
 */
export async function initiateConnection(
  cfg: ComposioConfig,
  args: {
    authConfigId: string;
    userId: string;
    callbackUrl?: string;
    /** The scheme this connection uses. Only needed when sending credentials. */
    scheme?: AuthScheme;
    /** Scheme-specific credential fields — `generic_api_key`, `token`, `username`/`password`… */
    credentials?: Record<string, string>;
  },
): Promise<InitiateResult> {
  // ACTIVE is Composio's own convention for "here is a credential I already hold", as opposed to
  // INITIALIZING which means "run a redirect flow for me". Sending the wrong one on a pasted API key
  // leaves the account stuck INITIALIZING forever with the key silently ignored.
  const state =
    args.scheme && args.credentials && Object.keys(args.credentials).length > 0
      ? { authScheme: args.scheme, val: { status: "ACTIVE", ...args.credentials } }
      : undefined;

  const body = await call<{
    id: string;
    connectionData?: { val?: { status?: string; redirectUrl?: string } };
    status?: string;
    redirect_url?: string;
  }>(cfg, "/connected_accounts", {
    method: "POST",
    body: JSON.stringify({
      auth_config: { id: args.authConfigId },
      connection: {
        user_id: args.userId,
        ...(args.callbackUrl ? { callback_url: args.callbackUrl } : {}),
        ...(state ? { state } : {}),
      },
    }),
  });
  const val = body.connectionData?.val ?? {};
  return {
    connected_account_id: body.id,
    // The top-level `status`/`redirect_url` are deprecated in favour of the ones inside
    // `connectionData.val`; read the live pair first and fall back rather than pick one and hope.
    status: (val.status as ConnectedAccountStatus) ?? (body.status as ConnectedAccountStatus) ?? "INITIALIZING",
    redirect_url: val.redirectUrl ?? body.redirect_url,
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
  /**
   * The tool's documented RESPONSE schema.
   *
   * Carried since the tool-context work (composio.tools.ts): an agent told only what a tool takes
   * calls it, gets an object back, and has no idea that the invoice id it needs for the next step
   * is at `invoiceID`. Composio publishes this; we were dropping it on the floor here.
   */
  output_parameters?: unknown;
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
    output_parameters: t.output_parameters,
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

/** A catalogue category, kept as (slug, display name) because the UI needs both: one to group and
 *  link by, one to print. Composio calls the slug `id`. */
export interface ToolkitCategory {
  slug: string;
  name: string;
}

export interface Toolkit {
  slug: string;
  name: string;
  /** Logo / description live under `meta`, which Composio types loosely. */
  logo?: string;
  description?: string;
  /** The provider's own site. Useful as the "what is this?" escape hatch on a card. */
  app_url?: string;
  categories: ToolkitCategory[];
  /** How much surface this app has. A 4-tool toolkit and an 871-tool one are not the same offer. */
  tools_count?: number;
  triggers_count?: number;
  /** True when Composio supplies the OAuth app, so the founder registers nothing. */
  composio_managed: boolean;
  no_auth: boolean;
  /** Every scheme this toolkit accepts, and the subset Composio has credentials for. Carried on the
   *  LIST response so a catalogue card can say what connecting costs before anyone clicks it. */
  auth_schemes: AuthScheme[];
  managed_schemes: AuthScheme[];
  /** The scheme a click would use, and what it will ask the founder for. */
  connect: ConnectPlan;
}

interface RawToolkit {
  slug: string;
  name: string;
  no_auth?: boolean;
  /**
   * NOT a boolean in the live API, whatever the name suggests: every toolkit carries
   * `deprecated: { toolkitId: "<uuid>" }`, which is a legacy id and truthy for all 1069 of them.
   * Treating it as a flag emptied the entire catalogue. Only an explicit `true` (or a future
   * `is_deprecated`) counts — see `isDeprecated`.
   */
  deprecated?: boolean | { toolkitId?: string; is_deprecated?: boolean };
  composio_managed_auth_schemes?: string[];
  auth_schemes?: string[];
  meta?: {
    logo?: string;
    description?: string;
    app_url?: string;
    tools_count?: number;
    triggers_count?: number;
    categories?: Array<{ name?: string; slug?: string; id?: string } | string>;
  };
}

function isDeprecated(t: RawToolkit): boolean {
  const d = t.deprecated;
  if (d === true) return true;
  return typeof d === "object" && d !== null && d.is_deprecated === true;
}

function slugify(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, "-");
}

function normaliseToolkit(t: RawToolkit): Toolkit {
  const managed_schemes = parseSchemes(t.composio_managed_auth_schemes);
  const no_auth = !!t.no_auth;
  // A toolkit that lists managed schemes but no schemes at all is possible in the wild; the managed
  // set is by definition a subset, so union rather than trust one field to be complete.
  const auth_schemes = [...new Set([...parseSchemes(t.auth_schemes), ...managed_schemes])];
  const seen = new Set<string>();
  const categories: ToolkitCategory[] = [];
  for (const raw of t.meta?.categories ?? []) {
    const name = (typeof raw === "string" ? raw : (raw.name ?? raw.slug ?? raw.id ?? "")).trim();
    if (!name) continue;
    const slug = slugify(typeof raw === "string" ? raw : (raw.id ?? raw.slug ?? name));
    if (seen.has(slug)) continue;
    seen.add(slug);
    categories.push({ slug, name });
  }
  return {
    slug: t.slug,
    name: t.name,
    logo: t.meta?.logo,
    description: t.meta?.description,
    app_url: t.meta?.app_url,
    categories,
    tools_count: t.meta?.tools_count,
    triggers_count: t.meta?.triggers_count,
    // Composio-managed auth is what makes this one click: their OAuth app, not one the founder
    // has to go and register with the provider first.
    composio_managed: managed_schemes.length > 0,
    no_auth,
    auth_schemes,
    managed_schemes,
    connect: planConnect({ auth_schemes, managed_schemes, no_auth }),
  };
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
  // 500 is the largest page the live API honours; the previous cap of 100 meant eleven round trips
  // to see a catalogue that fits in three.
  q.set("limit", String(Math.min(args.limit ?? 40, 500)));
  const body = await call<{ items?: RawToolkit[]; next_cursor?: string; total_items?: number }>(
    cfg,
    `/toolkits?${q}`,
  );
  const items = (body.items ?? []).filter((t) => !isDeprecated(t)).map(normaliseToolkit);
  return { items, next_cursor: body.next_cursor, total: body.total_items };
}

/**
 * The WHOLE catalogue, paged through.
 *
 * A store you can browse by category has to know every app before it can group them; a 60-item
 * first page cannot tell you there are 26 accounting apps. Three requests at the API's real page
 * size, hard-capped so a Composio pagination bug can't turn one page view into an infinite loop.
 */
export async function listAllToolkits(
  cfg: ComposioConfig,
  args: { search?: string; category?: string; max?: number } = {},
): Promise<{ items: Toolkit[]; total?: number }> {
  const max = Math.min(args.max ?? 2000, 5000);
  const items: Toolkit[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  let total: number | undefined;
  for (let page = 0; page < 20 && items.length < max; page++) {
    const res = await listToolkits(cfg, {
      search: args.search,
      category: args.category,
      limit: 500,
      cursor,
    });
    total = res.total ?? total;
    for (const t of res.items) {
      if (seen.has(t.slug)) continue;
      seen.add(t.slug);
      items.push(t);
    }
    if (!res.next_cursor || res.items.length === 0) break;
    cursor = res.next_cursor;
  }
  return { items, total };
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
 * One credential field a toolkit wants, as Composio describes it.
 *
 * Deliberately taken from the API rather than hardcoded per scheme. The field name for an API key is
 * `generic_api_key` on most toolkits and something else on others, `legacy_template_name` exists
 * precisely because these names have moved, and several toolkits additionally demand a `subdomain`
 * or a `base_url` that no scheme-shaped guess would ever produce. Reading the toolkit is the only
 * way the form asks for the right things.
 */
export interface AuthField {
  name: string;
  display_name: string;
  type: string;
  description?: string;
  required: boolean;
  /** True for anything that must be masked in the UI and sealed in the vault, never in `config`. */
  is_secret: boolean;
  default?: string;
}

export interface ToolkitScheme {
  scheme: AuthScheme;
  /** Composio's own display name for the mode, e.g. "OAuth 2.0". */
  name: string;
  /** Composio holds credentials for THIS scheme — connecting through it needs nothing from us. */
  managed: boolean;
  /** Fields needed to CREATE the auth config: the founder's own OAuth client id and secret. Empty
   *  when managed, because that is exactly what managed means. */
  config_fields: AuthField[];
  /** Fields needed to START a connection: the API key itself, a workspace subdomain, and so on. */
  connect_fields: AuthField[];
  /** Where the provider documents getting these. The single most useful link on the dialog. */
  hint_url?: string;
  /** False when this scheme completes in-request rather than in a browser tab. */
  redirect: boolean;
}

export interface ToolkitAuth {
  slug: string;
  name: string;
  no_auth: boolean;
  auth_schemes: AuthScheme[];
  managed_schemes: AuthScheme[];
  schemes: ToolkitScheme[];
  connect: ConnectPlan;
  guide_url?: string;
}

interface RawField {
  name?: string;
  displayName?: string;
  display_name?: string;
  type?: string;
  description?: string;
  required?: boolean;
  is_secret?: boolean;
  default?: string | null;
}

function normaliseFields(raw: unknown, required: boolean): AuthField[] {
  if (!Array.isArray(raw)) return [];
  const out: AuthField[] = [];
  for (const f of raw as RawField[]) {
    const name = typeof f?.name === "string" ? f.name : "";
    if (!name) continue;
    out.push({
      name,
      display_name: f.displayName ?? f.display_name ?? name,
      type: f.type ?? "string",
      description: f.description || undefined,
      // Composio nests fields under `required`/`optional` arrays AND puts a `required` boolean on
      // each. The array it arrived in is the authoritative one — the boolean has been seen unset.
      required,
      // Default to secret when unstated. Treating an unknown field as public is the failure that
      // ends with a client secret in a connection's plaintext config.
      is_secret: f.is_secret !== false,
      default: typeof f.default === "string" ? f.default : undefined,
    });
  }
  return out;
}

/**
 * What does connecting THIS toolkit actually require?
 *
 * `GET /toolkits/{slug}` is the endpoint the whole fix rests on. Its `auth_config_details` lists one
 * entry per supported scheme, each carrying two field sets: `auth_config_creation` (what the auth
 * config needs — an OAuth client id and secret when it isn't managed) and
 * `connected_account_initiation` (what the connection itself needs — the API key, a subdomain).
 *
 * We used to call none of this and assume managed OAuth for all thousand toolkits.
 */
export async function toolkitAuth(cfg: ComposioConfig, slug: string): Promise<ToolkitAuth> {
  const body = await call<{
    slug?: string;
    name?: string;
    no_auth?: boolean;
    auth_schemes?: string[];
    composio_managed_auth_schemes?: string[];
    auth_guide_url?: string | null;
    auth_config_details?: Array<{
      mode?: string;
      name?: string;
      auth_hint_url?: string | null;
      fields?: {
        auth_config_creation?: { required?: unknown; optional?: unknown };
        connected_account_initiation?: { required?: unknown; optional?: unknown };
      };
    }>;
  }>(cfg, `/toolkits/${encodeURIComponent(slug)}`);

  const managed_schemes = parseSchemes(body.composio_managed_auth_schemes);
  const detail = body.auth_config_details ?? [];
  const schemes: ToolkitScheme[] = [];
  for (const d of detail) {
    const scheme = parseAuthScheme(d.mode);
    if (!scheme || schemes.some((s) => s.scheme === scheme)) continue;
    const managed = managed_schemes.includes(scheme);
    schemes.push({
      scheme,
      name: d.name || scheme,
      managed,
      // Managed means Composio's own client id and secret — asking the founder for one would be
      // asking for something we neither need nor should hold.
      config_fields: managed
        ? []
        : [
            ...normaliseFields(d.fields?.auth_config_creation?.required, true),
            ...normaliseFields(d.fields?.auth_config_creation?.optional, false),
          ],
      connect_fields: [
        ...normaliseFields(d.fields?.connected_account_initiation?.required, true),
        ...normaliseFields(d.fields?.connected_account_initiation?.optional, false),
      ],
      hint_url: d.auth_hint_url || undefined,
      redirect: isRedirectScheme(scheme),
    });
  }

  const no_auth = !!body.no_auth;
  const auth_schemes = [
    ...new Set([...parseSchemes(body.auth_schemes), ...schemes.map((s) => s.scheme), ...managed_schemes]),
  ];
  return {
    slug: body.slug ?? slug,
    name: body.name ?? slug,
    no_auth,
    auth_schemes,
    managed_schemes,
    schemes,
    connect: planConnect({ auth_schemes, managed_schemes, no_auth }),
    guide_url: body.auth_guide_url || undefined,
  };
}

/** Short, human phrasing for a scheme. Used in the sentence a founder reads when a connect attempt
 *  stops for want of a credential — "Notion needs an API key", not "auth config creation failed". */
export function schemeNoun(scheme: AuthScheme): string {
  switch (scheme) {
    case "API_KEY":
      return "an API key";
    case "BEARER_TOKEN":
      return "an access token";
    case "BASIC":
    case "BASIC_WITH_JWT":
      return "a username and password";
    case "GOOGLE_SERVICE_ACCOUNT":
    case "SERVICE_ACCOUNT":
      return "a service-account key";
    case "NO_AUTH":
      return "no credentials";
    default:
      return "your own OAuth app (a client ID and secret)";
  }
}

/**
 * The sentence that replaces a 502.
 *
 * The founder's report was that Composio's own error leaked through verbatim: "default auth config
 * not found for toolkit. Composio does not have managed credentials for this." That is true and
 * useless. What they need to read is the requirement and where to satisfy it.
 */
export function requirementMessage(args: { toolkitName: string; scheme: AuthScheme }): string {
  return (
    `${args.toolkitName} needs ${schemeNoun(args.scheme)} — the app broker has no shared credentials ` +
    `for it, so this connection uses yours.`
  );
}

/**
 * Create an auth config for a toolkit.
 *
 * Two shapes behind one function, because the choice is not ours to make — it is a property of the
 * toolkit. `use_composio_managed_auth` is what turns "connect Xero" into one click: Composio's OAuth
 * app, nothing for the founder to register. For the ~80 toolkits Composio has no credentials for,
 * that request is rejected outright (see `isMissingManagedAuth`) and the only way through is
 * `use_custom_auth` carrying the founder's own client id and secret — or, for an API-key toolkit,
 * carrying nothing at all, because the secret arrives later with the connection itself.
 *
 * `authScheme` is camelCase on the wire while the RESPONSE returns `auth_scheme`. That is Composio's
 * inconsistency, not a typo here.
 *
 * Idempotent by intent: created once per (toolkit, scheme) per project and then reused.
 */
export async function createAuthConfig(
  cfg: ComposioConfig,
  args: {
    toolkit: string;
    scheme: AuthScheme;
    managed: boolean;
    /** Own-OAuth-app credentials: `client_id`, `client_secret`, optionally `oauth_redirect_uri`. */
    credentials?: Record<string, string>;
    name?: string;
  },
): Promise<{ id: string }> {
  const name = args.name ?? `mycel-${args.toolkit}`;
  const auth_config = args.managed
    ? { type: "use_composio_managed_auth", name }
    : {
        type: "use_custom_auth",
        authScheme: args.scheme,
        name,
        // `{}` is meaningful and correct for API-key toolkits: the config declares the scheme, the
        // credential travels with the connected account so each client can hold their own.
        credentials: args.credentials ?? {},
      };
  const body = await call<{ auth_config?: { id?: string }; id?: string }>(cfg, "/auth_configs", {
    method: "POST",
    body: JSON.stringify({ toolkit: { slug: args.toolkit }, auth_config }),
  });
  const id = body.auth_config?.id ?? body.id;
  if (!id) throw new ComposioError(502, "composio did not return an auth config id");
  return { id };
}

/** Back-compat shim for the managed path. Kept so callers that genuinely mean "the one-click one"
 *  read as such. */
export async function createManagedAuthConfig(
  cfg: ComposioConfig,
  args: { toolkit: string; name?: string },
): Promise<{ id: string }> {
  return createAuthConfig(cfg, { ...args, scheme: "OAUTH2", managed: true });
}

/** A tool slug looks like TOOLKIT_ACTION. Used to match a capability to a Composio connection. */
export function slugToolkit(slug: string): string | undefined {
  const m = /^([A-Za-z0-9]+)_/.exec(slug.trim());
  return m ? m[1].toLowerCase() : undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Triggers — the difference between a scheduler and a service
//
// Everything above is Mycel asking Composio for something. This half is Composio telling Mycel
// something happened: a customer replied, an invoice arrived, a bill needs coding. A trigger
// instance is registered per (connected account, trigger slug); when it fires, Composio POSTs to
// one webhook URL registered for the whole project.
//
// That one URL is the awkward part of their model. There is no per-subscription secret and no
// per-subscription path — every trigger for every one of a founder's customers arrives at the same
// endpoint, signed with the same project secret. So the webhook cannot be trusted to say who it is
// for: the signature proves it came from Composio, and the *stored subscription* (looked up by the
// trigger id Composio hands back at registration) decides which project and which client the
// resulting run belongs to. Nothing in the payload is allowed to choose that. See triggers.ts.
// ─────────────────────────────────────────────────────────────────────────────

/** The project-wide webhook signing secret, from the Composio dashboard. */
export function composioWebhookSecret(): string | undefined {
  return process.env.COMPOSIO_WEBHOOK_SECRET || undefined;
}

/**
 * Register (or re-register) a trigger instance.
 *
 * `POST /api/v3.1/trigger_instances/{slug}/upsert`. Upsert rather than create is Composio's own
 * shape and happens to be exactly what we want: re-subscribing after a restart, or after a founder
 * edits the config, converges instead of accumulating duplicate instances that would each deliver
 * the same event.
 *
 * `userId` is derived from the connection owner by the caller, never from a request body — the same
 * rule as `executeTool`. A trigger the agent could point at another customer's mailbox would be a
 * far worse hole than a tool call, because nobody is watching when it fires.
 */
export async function upsertTrigger(
  cfg: ComposioConfig,
  args: {
    slug: string;
    userId: string;
    connectedAccountId?: string;
    triggerConfig?: Record<string, unknown>;
  },
): Promise<{ trigger_id: string }> {
  const body = await call<{ trigger_id?: string; triggerId?: string; id?: string }>(
    cfg,
    `/trigger_instances/${encodeURIComponent(args.slug.toUpperCase())}/upsert`,
    {
      method: "POST",
      apiVersion: TRIGGERS_API,
      body: JSON.stringify({
        user_id: args.userId,
        ...(args.connectedAccountId ? { connected_account_id: args.connectedAccountId } : {}),
        trigger_config: args.triggerConfig ?? {},
      }),
    },
  );
  const id = body.trigger_id ?? body.triggerId ?? body.id;
  if (!id) throw new ComposioError(502, "composio did not return a trigger id");
  return { trigger_id: id };
}

/** Pause or resume delivery without losing the instance's config. */
export async function setTriggerEnabled(
  cfg: ComposioConfig,
  triggerId: string,
  enabled: boolean,
): Promise<void> {
  await call(cfg, `/trigger_instances/manage/${encodeURIComponent(triggerId)}`, {
    method: "PATCH",
    apiVersion: TRIGGERS_API,
    body: JSON.stringify({ status: enabled ? "enable" : "disable" }),
  });
}

/** Delete the instance outright. Used when a founder unsubscribes for good. */
export async function deleteTrigger(cfg: ComposioConfig, triggerId: string): Promise<void> {
  await call(cfg, `/trigger_instances/manage/${encodeURIComponent(triggerId)}`, {
    method: "DELETE",
    apiVersion: TRIGGERS_API,
  });
}

/**
 * Point Composio's project-wide webhook subscription at this harness.
 *
 * Note the version: webhook subscriptions are `/api/v3.1`, and the endpoint is a list-then-patch
 * because Composio allows one subscription per project and has no idempotent PUT.
 */
export async function setWebhookSubscription(
  cfg: ComposioConfig,
  webhookUrl: string,
): Promise<{ id: string; webhook_url: string }> {
  const body = { webhook_url: webhookUrl, version: "v3" };
  const existing = await call<{ items?: Array<{ id?: string }> }>(
    cfg,
    "/webhook_subscriptions?limit=1",
    { apiVersion: TRIGGERS_API },
  );
  const id = existing.items?.[0]?.id;
  const out = await call<{ id?: string; webhook_url?: string }>(
    cfg,
    id ? `/webhook_subscriptions/${encodeURIComponent(id)}` : "/webhook_subscriptions",
    { method: id ? "PATCH" : "POST", apiVersion: TRIGGERS_API, body: JSON.stringify(body) },
  );
  return { id: out.id ?? id ?? "", webhook_url: out.webhook_url ?? webhookUrl };
}

/** The three headers Composio signs every delivery with. */
export const WEBHOOK_HEADERS = {
  id: "webhook-id",
  timestamp: "webhook-timestamp",
  signature: "webhook-signature",
} as const;

export type VerifyFailure =
  | "no_secret"
  | "missing_headers"
  | "empty_body"
  | "bad_timestamp"
  | "stale"
  | "no_v1_signature"
  | "mismatch";

/**
 * Verify a Composio webhook. This is the ENTIRE security of the inbound route — there is no session
 * behind it, so a bug here is an unauthenticated "make my kernel run a job" endpoint.
 *
 * Composio signs `HMAC-SHA256("{webhook-id}.{webhook-timestamp}.{raw body}", secret)`, base64, and
 * sends it as `webhook-signature: v1,<base64>` (space-separated when several keys are live, e.g.
 * during a rotation — any one matching is enough).
 *
 * One detail worth stating because it is a real trap: this LOOKS like Svix / Standard Webhooks,
 * whose secrets are `whsec_<base64>` and are base64-DECODED before use. Composio's is not — their
 * own SDK feeds the secret string to the HMAC as raw UTF-8 bytes. Decoding it here would produce a
 * verifier that rejects every genuine delivery, which is exactly the bug in their issue tracker.
 *
 * The timestamp check is not decoration: without it a signed delivery captured once is replayable
 * forever, and a replayed delivery is a run that costs the founder money.
 */
export function verifyWebhook(args: {
  secret: string;
  webhookId: string;
  timestamp: string;
  rawBody: string;
  signature: string;
  /** Max age in seconds. 0 disables the check — for tests with frozen fixtures only. */
  toleranceS?: number;
  now?: number;
}): { ok: true } | { ok: false; reason: VerifyFailure } {
  if (!args.secret) return { ok: false, reason: "no_secret" };
  if (!args.webhookId || !args.timestamp || !args.signature) {
    return { ok: false, reason: "missing_headers" };
  }
  if (!args.rawBody) return { ok: false, reason: "empty_body" };

  const tolerance = args.toleranceS ?? 300;
  if (tolerance > 0) {
    const seconds = Number.parseInt(args.timestamp, 10);
    if (!Number.isFinite(seconds)) return { ok: false, reason: "bad_timestamp" };
    const skewMs = Math.abs((args.now ?? Date.now()) - seconds * 1000);
    if (skewMs > tolerance * 1000) return { ok: false, reason: "stale" };
  }

  // "v1,<sig>" — possibly several, space separated, possibly other versions we don't understand.
  const presented = args.signature
    .split(" ")
    .map((part) => part.split(","))
    .filter(([version, value]) => version === "v1" && !!value)
    .map(([, value]) => value);
  if (!presented.length) return { ok: false, reason: "no_v1_signature" };

  const expected = createHmac("sha256", args.secret)
    .update(`${args.webhookId}.${args.timestamp}.${args.rawBody}`)
    .digest("base64");
  const expectedBuf = Buffer.from(expected);
  const matched = presented.some((sig) => {
    const buf = Buffer.from(sig);
    // Length is not secret; timingSafeEqual throws on a mismatch, so guard before comparing.
    return buf.length === expectedBuf.length && timingSafeEqual(buf, expectedBuf);
  });
  return matched ? { ok: true } : { ok: false, reason: "mismatch" };
}

/** A trigger delivery, reduced to the fields Mycel routes on. Never the payload's own opinions. */
export interface TriggerEvent {
  /** Composio's per-delivery message id. The idempotency key — see triggers.ts. */
  event_id: string;
  /** The trigger INSTANCE id, i.e. the thing we registered. The join key to a subscription. */
  trigger_id?: string;
  trigger_slug: string;
  connected_account_id?: string;
  /** Composio's user id. Advisory only — it is checked against the subscription, never trusted. */
  user_id?: string;
  timestamp?: string;
  data: Record<string, unknown>;
}

/**
 * Normalise a delivery. Composio has two live envelope shapes and we get whichever the project's
 * subscription is configured for, so both are handled rather than one being assumed:
 *
 *   V3 (current default): `{ id, type: "composio.trigger.message", metadata: { trigger_id,
 *                            trigger_slug, connected_account_id, user_id }, data, timestamp }`
 *   V2 (legacy):          `{ type: "<TRIGGER_SLUG>", data: { trigger_nano_id, connection_nano_id,
 *                            user_id, ...event } }`
 *
 * Returns undefined for anything that isn't a trigger message — Composio also delivers lifecycle
 * events (a connection expired, for instance) down the same pipe, and those must not start runs.
 */
export function parseTriggerEvent(raw: unknown): TriggerEvent | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const body = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  const obj = (v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

  const type = str(body.type);
  const meta = obj(body.metadata);

  // V3: routing lives in `metadata`, which is what makes it safe to leave `data` entirely alone.
  if (str(meta.trigger_slug)) {
    if (type && type !== "composio.trigger.message") return undefined;
    return {
      event_id: str(body.id) ?? str(meta.trigger_id) ?? "",
      trigger_id: str(meta.trigger_id),
      trigger_slug: str(meta.trigger_slug)!.toUpperCase(),
      connected_account_id: str(meta.connected_account_id),
      user_id: str(meta.user_id),
      timestamp: str(body.timestamp),
      data: obj(body.data),
    };
  }

  // V2: `type` IS the slug, and routing is mixed in with the event fields.
  if (type && /^[A-Z0-9]+_[A-Z0-9_]+$/.test(type.toUpperCase())) {
    const data = obj(body.data);
    const { trigger_nano_id, trigger_id, connection_nano_id, connection_id, user_id, ...rest } = data;
    return {
      event_id: str(body.id) ?? str(trigger_nano_id) ?? str(trigger_id) ?? "",
      trigger_id: str(trigger_nano_id) ?? str(trigger_id),
      trigger_slug: type.toUpperCase(),
      connected_account_id: str(connection_nano_id) ?? str(connection_id),
      user_id: str(user_id),
      timestamp: str(body.timestamp),
      data: rest,
    };
  }

  return undefined;
}
