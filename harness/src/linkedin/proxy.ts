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
// The proxy libraries stay OPTIONAL dependencies: the kernel builds and boots without them, and you
// only pay for them when you actually connect a LinkedIn account (see docs/VERIFY-LINKEDIN.md).

/** Thrown when a LinkedIn call would leave the box without a proxy. Callers turn this into a 400. */
export class ProxyRequiredError extends Error {
  readonly code = "linkedin_proxy_required";
  constructor(message: string) {
    super(message);
    this.name = "ProxyRequiredError";
  }
}

/** The one escape hatch, and it is a local-development one: an env var, set by a human, on a box. */
export function directEgressAllowed(): boolean {
  const v = process.env.MYCEL_LINKEDIN_ALLOW_DIRECT;
  return v === "1" || v === "true";
}

const PROXY_HELP =
  "LinkedIn requires a per-account residential proxy: pass `proxy_url` " +
  "(http://user:pass@host:port or socks5://user:pass@host:port) when connecting the account. " +
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

/**
 * Build (and cache) an undici dispatcher for a proxy url. Cached per url because a dispatcher owns
 * a connection pool — one per account, reused, which is also what keeps the account's TLS
 * fingerprint and source IP stable across calls.
 */
export async function dispatcherFor(proxyUrl: string): Promise<unknown> {
  const cached = dispatchers.get(proxyUrl);
  if (cached) return cached;
  const undici = await optionalImport("undici");
  if (!undici) {
    throw new ProxyRequiredError(
      "the `undici` package is required to route LinkedIn traffic through a proxy " +
        "(`npm i undici`). Refusing to fall back to a direct connection.",
    );
  }
  const u = new URL(proxyUrl);
  let dispatcher: unknown;
  if (u.protocol === "http:" || u.protocol === "https:") {
    const token = u.username
      ? `Basic ${Buffer.from(
          `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`,
        ).toString("base64")}`
      : undefined;
    dispatcher = new undici.ProxyAgent({ uri: `${u.protocol}//${u.host}`, token });
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
    const connector = undici.buildConnector({});
    const type = u.protocol.startsWith("socks4") ? 4 : 5;
    dispatcher = new undici.Agent({
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
          .then(({ socket }: any) => connector({ ...opts, httpSocket: socket }, cb))
          .catch((e: Error) => cb(e));
      },
    });
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
 * Fetch through the account's proxy, or throw. There is deliberately no "proxy failed, going
 * direct" branch anywhere in this function.
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
  if (fetchOverride) return fetchOverride(url, init);
  if (!resolved) return fetch(url, init as RequestInit); // MYCEL_LINKEDIN_ALLOW_DIRECT, local only
  const dispatcher = await dispatcherFor(resolved);
  const undici = await optionalImport("undici");
  // Prefer undici's own fetch with the dispatcher. Node's global fetch accepts `dispatcher` too,
  // but only the userland pairing is guaranteed to match across Node versions.
  const f = undici?.fetch ?? fetch;
  return f(url, { ...init, dispatcher }) as Promise<Response>;
}
