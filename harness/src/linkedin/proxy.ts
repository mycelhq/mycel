// The egress proxy for every LinkedIn call — and the rule that there must be one.
//
// WHY THIS IS A HARD REQUIREMENT, NOT AN OPTION
// Logging in or calling Voyager from a datacenter IP is the single most reliable way to get a
// LinkedIn account restricted. The kernel runs on ECS. So an "optional" proxy is not a knob, it is
// a loaded gun with the safety off: the founder who forgets to pass `proxy_url` does not get a
// slower path, he gets his personal LinkedIn account locked. This module refuses to connect or send
// without a proxy, and the refusal is only waivable by an explicit environment variable
// (MYCEL_LINKEDIN_ALLOW_DIRECT=1) that a human has to type on a laptop — never by a request body.
//
// AND A PROXY THAT SILENTLY DOESN'T APPLY IS WORSE THAN NO PROXY
// The obvious implementation — `fetch(url, { agent: new HttpsProxyAgent(url) })` — is a no-op.
// Node's global `fetch` is undici, and undici ignores `agent` entirely; it wants a `dispatcher`.
// Code written that way reports success, appears proxied, and egresses from the datacenter IP
// anyway. That is exactly the failure this file exists to prevent, so proxying here goes through
// undici's `ProxyAgent`/`Agent` and a missing proxy library is a hard error, never a fallback to a
// direct connection.
//
// `undici` is a real kernel dependency (needed for every proxied Voyager call). `socks` stays
// optional — only socks5:// proxies pay for it (see docs/VERIFY-LINKEDIN.md).

import { Agent, ProxyAgent, buildConnector, fetch as undiciFetch } from "undici";

/** Thrown when a LinkedIn call would leave the box without a proxy. Callers turn this into a 400. */
export class ProxyRequiredError extends Error {
  readonly code: string;
  constructor(message: string, code = "linkedin_proxy_required") {
    super(message);
    this.name = "ProxyRequiredError";
    this.code = code;
  }
}

/** The one escape hatch, and it is a local-development one: an env var, set by a human, on a box. */
export function directEgressAllowed(): boolean {
  const v = process.env.MYCEL_LINKEDIN_ALLOW_DIRECT;
  return v === "1" || v === "true";
}

const PROXY_HELP =
  "LinkedIn requires a per-account sticky ISP proxy: pass `proxy_url` " +
  "(http://user:pass@host:port or socks5://user:pass@host:port), or configure the host pool " +
  "(MYCEL_LINKEDIN_PROXY_PROVIDER=brightdata or MYCEL_LINKEDIN_PROXY_POOL). " +
  "Connecting from a datacenter IP is the most common cause of an account being restricted. " +
  "For local development only, set MYCEL_LINKEDIN_ALLOW_DIRECT=1 to egress directly.";

/**
 * Enforce the rule. Returns the proxy url to use, or undefined when direct egress is explicitly
 * allowed. Throws ProxyRequiredError otherwise — including for a proxy url that doesn't parse,
 * because "we tried and it was malformed so we went direct" is the failure mode being designed out.
 */
export function requireProxy(proxyUrl?: string, what = "this LinkedIn call"): string | undefined {
  const url = (proxyUrl ?? "").trim();
  if (!url) {
    if (directEgressAllowed()) return undefined;
    throw new ProxyRequiredError(`refusing ${what} without a proxy. ${PROXY_HELP}`);
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ProxyRequiredError(`proxy_url is not a valid URL. ${PROXY_HELP}`);
  }
  if (!/^(https?|socks[45]?h?):$/.test(parsed.protocol)) {
    throw new ProxyRequiredError(
      `proxy_url scheme "${parsed.protocol.replace(":", "")}" is not supported (use http, https or socks5). ${PROXY_HELP}`,
    );
  }
  if (!parsed.hostname) throw new ProxyRequiredError(`proxy_url has no host. ${PROXY_HELP}`);
  return url;
}

/** Playwright's proxy option shape. Parsed here so login.ts and Voyager agree on one interpretation. */
export function playwrightProxy(
  proxyUrl?: string,
): { server: string; username?: string; password?: string } | undefined {
  if (!proxyUrl) return undefined;
  const u = new URL(proxyUrl);
  return {
    server: `${u.protocol}//${u.host}`,
    // Credentials go in the dedicated fields rather than the server string — Chromium wants them
    // separately, and it keeps the password out of anything that logs a URL.
    username: u.username ? decodeURIComponent(u.username) : undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
  };
}

/** A proxy url with its credentials removed. The ONLY form allowed anywhere near a log line. */
export function redactProxy(proxyUrl?: string): string {
  if (!proxyUrl) return "(direct)";
  try {
    const u = new URL(proxyUrl);
    return `${u.protocol}//${u.username ? "***@" : ""}${u.host}`;
  } catch {
    return "(malformed)";
  }
}

// ── Dispatchers ──────────────────────────────────────────────────────────────────────────────────

async function optionalImport(pkg: string): Promise<any | null> {
  try {
    // Non-literal specifier: an optional, possibly-uninstalled dep resolved only at runtime, so a
    // bundler doesn't pull it in and the kernel boots without it.
    return await import(pkg);
  } catch {
    return null;
  }
}

const dispatchers = new Map<string, unknown>();

/** Test seam: force dispatcher construction to throw (missing undici, bad proxy, …). */
let dispatcherOverride: ((proxyUrl: string) => Promise<unknown>) | null = null;

export function _setDispatcherFor(fn: ((proxyUrl: string) => Promise<unknown>) | null): void {
  dispatcherOverride = fn;
}

/**
 * Build (and cache) an undici dispatcher for a proxy url. Cached per url because a dispatcher owns
 * a connection pool — one per account, reused, which is also what keeps the account's TLS
 * fingerprint and source IP stable across calls.
 */
export async function dispatcherFor(proxyUrl: string): Promise<unknown> {
  if (dispatcherOverride) return dispatcherOverride(proxyUrl);
  const cached = dispatchers.get(proxyUrl);
  if (cached) return cached;
  const u = new URL(proxyUrl);
  let dispatcher: unknown;
  if (u.protocol === "http:" || u.protocol === "https:") {
    const token = u.username
      ? `Basic ${Buffer.from(
          `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`,
        ).toString("base64")}`
      : undefined;
    dispatcher = new ProxyAgent({
      uri: `${u.protocol}//${u.host}`,
      token,
      // HTTP/2 over an HTTP CONNECT tunnel is a common `fetch failed` / `other side closed` on
      // LinkedIn through ISP proxies. `/me` and search must share this setting — a second Agent
      // that negotiated h2 would look proxied and still reset mid-search.
      allowH2: false,
      requestTls: { timeout: 20_000 },
      proxyTls: { timeout: 20_000 },
    });
  } else {
    // SOCKS: undici has no built-in SOCKS support, so we open the tunnel ourselves and hand the raw
    // socket to undici's own connector, which then does TLS over it.
    const socks = await optionalImport("socks");
    if (!socks?.SocksClient) {
      throw new ProxyRequiredError(
        "a socks5:// proxy needs the `socks` package (`npm i socks`), or use the provider's " +
          "http:// endpoint. Refusing to fall back to a direct connection.",
      );
    }
    const connector = buildConnector({});
    const type = u.protocol.startsWith("socks4") ? 4 : 5;
    dispatcher = new Agent({
      allowH2: false,
      connect(opts: any, cb: (err: Error | null, socket?: unknown) => void) {
        socks.SocksClient.createConnection({
          proxy: {
            host: u.hostname,
            port: Number(u.port || 1080),
            type,
            userId: u.username ? decodeURIComponent(u.username) : undefined,
            password: u.password ? decodeURIComponent(u.password) : undefined,
          },
          command: "connect",
          destination: { host: opts.hostname, port: Number(opts.port || 443) },
        })
          .then(({ socket }: any) => connector({ ...opts, httpSocket: socket }, cb as any))
          .catch((e: Error) => cb(e));
      },
    } as ConstructorParameters<typeof Agent>[0]);
  }
  dispatchers.set(proxyUrl, dispatcher);
  return dispatcher;
}

// ── The one fetch every LinkedIn call goes through ───────────────────────────────────────────────

export type FetchLike = (url: string, init?: Record<string, unknown>) => Promise<Response>;

let fetchOverride: FetchLike | null = null;

/** Test seam: swap the transport so the whole Voyager layer runs hermetically. */
export function _setFetch(f: FetchLike | null): void {
  fetchOverride = f;
}

/** Test/ops helper: drop cached dispatchers (e.g. after rotating an account's proxy). */
export function _resetDispatchers(): void {
  dispatchers.clear();
}

/**
 * Undici's TypeError message is literally `"fetch failed"` — the socket reset, CONNECT timeout,
 * TLS alert or AbortSignal lives on `.cause`, nested. `error.message` at the Voyager call site is
 * how Find printed an empty wrapper while `/me` on the same session still worked.
 */
export function describeNetworkError(e: unknown): string {
  const chunks: string[] = [];
  const seen = new Set<unknown>();
  let cur: unknown = e;
  while (cur && typeof cur === "object" && !seen.has(cur)) {
    seen.add(cur);
    const err = cur as Error & { code?: unknown; cause?: unknown };
    const code = typeof err.code === "string" && !/^\d+$/.test(err.code) ? err.code : "";
    const msg = typeof err.message === "string" ? err.message.trim() : "";
    const wrapper = !msg || msg === "fetch failed";
    if (code) chunks.push(code);
    if (!wrapper) {
      if (msg !== code) chunks.push(msg);
      break;
    }
    const name = typeof err.name === "string" ? err.name : "";
    if (name && name !== "Error" && name !== "TypeError") chunks.push(name);
    cur = err.cause;
  }
  if (typeof cur === "string" && cur.trim()) chunks.push(cur.trim());
  const out = [...new Set(chunks.filter(Boolean))].join(": ");
  return out || "fetch failed";
}

function isTransientTransport(e: unknown): boolean {
  const blob = `${describeNetworkError(e)} ${typeof (e as { code?: string })?.code === "string" ? (e as { code: string }).code : ""}`;
  if (/aborted due to timeout|TimeoutError|TIMEOUT_ERR/i.test(blob)) return false;
  return /UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT|ECONNRESET|EPIPE|ECONNREFUSED|other side closed|socket hang up/i.test(
    blob,
  );
}

function wrapFetchError(e: unknown, what: string): Error {
  if (e instanceof ProxyRequiredError) return e;
  return new Error(`${what} failed (${describeNetworkError(e)})`, { cause: e instanceof Error ? e : undefined });
}

/** Cap our own walker. Undici's default follow is 20 and that is how Find printed this error. */
export const MAX_LINKEDIN_REDIRECTS = 5;

const AUTH_PATH = /\/(uas\/login|checkpoint(?:\/|$)|authwall|login-challenge)/i;

/** Login / checkpoint / authwall — following these is how a live session looks like a transport loop. */
export function isAuthRedirect(location: string): boolean {
  try {
    return AUTH_PATH.test(new URL(location, "https://www.linkedin.com").pathname);
  } catch {
    return AUTH_PATH.test(location);
  }
}

/** Same-host Voyager (or realtime) API. */
export function isVoyagerApiUrl(location: string): boolean {
  try {
    const u = new URL(location, "https://www.linkedin.com");
    if (!/(^|\.)linkedin\.com$/i.test(u.hostname)) return false;
    return /^\/voyager\//i.test(u.pathname) || /^\/realtime\//i.test(u.pathname);
  } catch {
    return false;
  }
}

/** Same-host people SRP. Brave follows a 302 onto this page, with or without `?keywords=`. */
export function isPeopleSearchUrl(location: string): boolean {
  try {
    const u = new URL(location, "https://www.linkedin.com");
    if (!/(^|\.)linkedin\.com$/i.test(u.hostname)) return false;
    return /^\/search\/results\/people\/?$/i.test(u.pathname);
  } catch {
    return false;
  }
}

/** Path-only people SRP. Still a document hop — results live in the HTML, not the querystring. */
export function isEmptyPeopleSearch(location: string): boolean {
  try {
    const u = new URL(location, "https://www.linkedin.com");
    if (!isPeopleSearchUrl(location)) return false;
    return !u.search || u.search === "?";
  } catch {
    return /\/search\/results\/people\/?$/i.test(location) && !location.includes("?");
  }
}

/** Absolute Location including query. For the next GET — never log this (use safeRedirectLocation). */
export function absoluteRedirectUrl(from: string, location: string): string | undefined {
  if (!location.trim()) return undefined;
  try {
    const u = new URL(location, from);
    if (!/(^|\.)linkedin\.com$/i.test(u.hostname)) return undefined;
    if (u.protocol === "http:") u.protocol = "https:";
    u.hash = "";
    u.username = "";
    u.password = "";
    return u.toString();
  } catch {
    return undefined;
  }
}

/** Document GET of the people SRP. Rest.li + JSON accept on this URL is how LinkedIn 302s it. */
export const DOCUMENT_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

export function asDocumentRequest(init: Record<string, unknown>): Record<string, unknown> {
  const headers = { ...((init.headers as Record<string, string>) ?? {}) };
  headers.accept = DOCUMENT_ACCEPT;
  if (!headers.referer) headers.referer = "https://www.linkedin.com/feed/";
  delete headers["x-restli-protocol-version"];
  delete headers["csrf-token"];
  delete headers.origin;
  delete headers["x-li-lang"];
  headers["sec-fetch-dest"] = "document";
  headers["sec-fetch-mode"] = "navigate";
  headers["sec-fetch-site"] = "none";
  headers["upgrade-insecure-requests"] = "1";
  const next: Record<string, unknown> = { ...init, method: "GET", headers, redirect: "manual" as const };
  delete next.body;
  return next;
}

/**
 * Path-only Voyager API — no query. LinkedIn 302s a parameterized GraphQL GET onto
 * `/voyager/api/graphql` (and the dead blended search onto `/search/blended`), then 302s that GET
 * again with no people JSON. Following the empty path is not a hop. Do not follow.
 */
export function isEmptyVoyagerApi(location: string): boolean {
  try {
    const u = new URL(location, "https://www.linkedin.com");
    if (u.search) return false;
    return /\/voyager\/api\/(graphql|search\/blended)$/i.test(u.pathname);
  } catch {
    return /\/voyager\/api\/(graphql|search\/blended)$/i.test(location) && !location.includes("?");
  }
}

/** @deprecated Use isEmptyVoyagerApi — kept so existing tests keep their name. */
export function isEmptyBlendedSearch(location: string): boolean {
  return isEmptyVoyagerApi(location) && /\/search\/blended/i.test(location);
}

/** Host + path only. Query can carry `session_redirect`; cookies must never appear next to this. */
export function safeRedirectLocation(location: string): string {
  try {
    const u = new URL(location, "https://www.linkedin.com");
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return "(invalid location)";
  }
}

export function linkedinRedirectKind(
  status: number,
  location: string | null | undefined,
): "auth" | "api" | "page" | "other" | null {
  if (status < 300 || status >= 400) return null;
  const loc = (location ?? "").trim();
  if (!loc) return "other";
  if (isAuthRedirect(loc)) return "auth";
  if (isVoyagerApiUrl(loc)) return "api";
  if (isPeopleSearchUrl(loc)) return "page";
  return "other";
}

function normalizeHop(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol === "http:" && /(^|\.)linkedin\.com$/i.test(u.hostname)) u.protocol = "https:";
    u.hash = "";
    return u.toString();
  } catch {
    return url;
  }
}

/** http↔https on the same host+path+query. Following both directions is the ping-pong 8d5267a stopped. */
function isSchemeOnlyBounce(from: string, location: string): boolean {
  try {
    const cur = new URL(from);
    const loc = new URL(location, from);
    if (cur.protocol === loc.protocol) return false;
    if (!/(^|\.)linkedin\.com$/i.test(loc.hostname)) return false;
    const a = new URL(cur.href);
    const b = new URL(loc.href);
    a.hash = "";
    b.hash = "";
    a.protocol = "https:";
    b.protocol = "https:";
    return a.toString() === b.toString();
  } catch {
    return false;
  }
}

function resolveRedirect(from: string, location: string): string {
  const abs = new URL(location, from);
  if (abs.protocol === "http:" && /(^|\.)linkedin\.com$/i.test(abs.hostname)) abs.protocol = "https:";
  // Follow Location as LinkedIn sent it. Copying the original `?keywords=` onto a path-only
  // `/voyager/api/search/blended` (78e54a4) made the next hop the same GET, so live Find 302'd
  // again and the walker returned that 302 as failure.
  return abs.toString();
}

function isGraphqlPost(url: string, init: Record<string, unknown>): boolean {
  if (String(init.method ?? "GET").toUpperCase() !== "POST") return false;
  try {
    return /\/voyager\/api\/graphql$/i.test(new URL(url, "https://www.linkedin.com").pathname);
  } catch {
    return /\/voyager\/api\/graphql/i.test(url);
  }
}

/** 301/302/303 become GET with no body (what browsers and LinkedIn do). 307/308 keep the verb. */
function redirectFollowInit(status: number, init: Record<string, unknown>): Record<string, unknown> {
  if (status !== 301 && status !== 302 && status !== 303) {
    return { ...init, redirect: "manual" as const };
  }
  const next: Record<string, unknown> = { ...init, method: "GET", redirect: "manual" as const };
  delete next.body;
  return next;
}

function hopKey(url: string, init: Record<string, unknown>): string {
  const method = String(init.method ?? "GET").toUpperCase();
  return `${method} ${normalizeHop(url)}`;
}

/**
 * Walk LinkedIn 3xxs ourselves. Undici's `redirect: 'follow'` is the bug: a 302 to `/uas/login`
 * (missing browser headers) or `http://` (Decodo / Akamai scheme bounce) is chased until
 * `redirect count exceeded`, which Find reported as a transport failure while `/me` still worked.
 *
 * Auth and off-site Locations are returned as the 3xx — a real LinkedIn status — never followed as
 * success. Same-origin Voyager API hops and people-SRP hops (with or without keywords) stay on this
 * dispatcher, same cookies, same UA. A hop onto `/search/results/people/` is a document GET: HTML
 * Accept, no Rest.li. Path-only `/voyager/api/graphql` or `/search/blended` is not a hop. GraphQL
 * POST 302 is not followed as GET. http↔https on the same path is not followed. Each Location is
 * logged (path only).
 */
async function followLinkedInRedirects(
  url: string,
  init: Record<string, unknown>,
  send: (url: string, init: Record<string, unknown>) => Promise<Response>,
  what: string,
  proxyUrl?: string,
): Promise<Response> {
  let reqInit: Record<string, unknown> = { ...init, redirect: "manual" as const };
  const seen = new Set<string>();
  const chain: string[] = [];
  let current = url;

  for (let hop = 0; hop <= MAX_LINKEDIN_REDIRECTS; hop++) {
    const key = hopKey(current, reqInit);
    if (seen.has(key)) {
      throw new Error(`redirect loop ${chain.join(" → ")}`);
    }
    seen.add(key);
    const res = await send(current, reqInit);
    if (res.status < 300 || res.status >= 400) return res;
    const location = res.headers?.get?.("location") ?? "";
    const kind = linkedinRedirectKind(res.status, location);
    const shown = location ? safeRedirectLocation(location) : "(no location)";
    chain.push(shown);
    console.warn(`[mycel] ${what} ${res.status} → ${shown} (${kind ?? "redirect"}) via ${redactProxy(proxyUrl)}`);
    if (!location || (kind !== "api" && kind !== "page")) return res;
    if (isEmptyVoyagerApi(location)) return res;
    // GraphQL POST 302 → GET drops queryId+variables. LinkedIn then 302-strips the GET
    // querystring onto path-only /graphql. Do not follow; the caller retries a POST shape.
    if (isGraphqlPost(current, reqInit)) return res;
    if (isSchemeOnlyBounce(current, location)) return res;
    const next = resolveRedirect(current, location);
    const nextInit = kind === "page" ? asDocumentRequest(reqInit) : redirectFollowInit(res.status, reqInit);
    if (hopKey(next, nextInit) === key) return res;
    reqInit = nextInit;
    current = next;
  }
  throw new Error(`redirect count exceeded: ${chain.join(" → ")}`);
}

/**
 * Fetch through the account's proxy, or throw. There is deliberately no "proxy failed, going
 * direct" branch anywhere in this function.
 *
 * Search, `/me`, sync and send all come through here so they share one dispatcher. A stale CONNECT
 * tunnel (LinkedIn or Decodo closed the socket, pool still held it) is retried once on a fresh
 * dispatcher — spraying further is how a flagged session gets worse.
 *
 * Redirects are manual and bounded. Passing `redirect: 'follow'` through to undici is how a login
 * Location became `redirect count exceeded` instead of a LinkedIn status.
 */
export async function proxiedFetch(
  url: string,
  init: Record<string, unknown>,
  proxyUrl: string | undefined,
  what = "this LinkedIn call",
): Promise<Response> {
  // The rule is enforced BEFORE the test seam on purpose: a mocked transport must not be a way to
  // accidentally exercise (or ship) a code path that skips the proxy requirement.
  const resolved = requireProxy(proxyUrl, what);
  const send = (target: string, reqInit: Record<string, unknown>): Promise<Response> => {
    if (fetchOverride) return fetchOverride(target, reqInit);
    if (!resolved) return fetch(target, reqInit as RequestInit); // MYCEL_LINKEDIN_ALLOW_DIRECT, local only
    return dispatcherFor(resolved).then(
      (dispatcher) => undiciFetch(target, { ...reqInit, dispatcher } as any) as Promise<Response>,
    );
  };
  const run = (): Promise<Response> => followLinkedInRedirects(url, init, send, what, resolved);
  try {
    return await run();
  } catch (e) {
    if (resolved && isTransientTransport(e)) {
      dispatchers.delete(resolved);
      try {
        return await run();
      } catch (e2) {
        throw wrapFetchError(e2, what);
      }
    }
    throw wrapFetchError(e, what);
  }
}
