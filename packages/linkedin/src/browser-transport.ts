// VOYAGER CALLS ISSUED BY A REAL BROWSER, FROM A PAGE ALREADY ON LINKEDIN.COM.
//
// ═══ WHY THIS EXISTS, MEASURED RATHER THAN ASSUMED ═══
//
// One controlled experiment, 1 September. Same account, same jar, same proxy, same minute. The
// only variable is the HTTP client:
//
//   real Chromium behind Decodo   →  200, authenticated
//   undici behind Decodo          →  302 to the auth wall
//
// That isolates the rejection to the CLIENT. Not the cookies, not the IP, not a missing header:
// the TLS handshake and the HTTP/2 settings frame, which LinkedIn's edge fingerprints and which
// no request header can forge.
//
// ═══ THE MEASUREMENT THIS REPLACES, AND WHY IT WAS WORTHLESS ═══
//
// An earlier version of this comment recorded 403s and 302 loops and concluded "the cookies were
// never the problem". That conclusion was right by accident and the evidence for it was garbage:
// the extractor was writing CORRUPT cookies. Chromium ≥130 prefixes each decrypted value with a
// 32-byte domain hash, the script only stripped it when the leftover happened to fail UTF-8
// decoding, so `li_at` usually went out as binary noise instead of `AQED…`. Every arm of that
// experiment failed for the same boring reason and none of them measured what they claimed to.
//
// The test above is the one that means something, because ONE of its arms succeeds. A comparison
// where everything fails cannot tell you what the difference was. The extractor now detects the
// prefix structurally and refuses outright if the result is not a recognisable token, so a
// silently corrupt jar cannot come back and be mistaken for a network verdict again.
//
// So the request has to come from an actual browser. Not "a browser-like user-agent": a browser.
//
// ═══ THE PART THAT MAKES THIS CHEAP INSTEAD OF ENORMOUS ═══
//
// The obvious build drives the LinkedIn UI — click Connect, type into the message box. That is slow,
// brittle against every markup change, and re-implements in DOM what the API already does.
//
// This does not do that. It navigates ONCE to linkedin.com and then issues the same Voyager calls
// the existing code already makes, from INSIDE the page, via `fetch`. That is precisely what
// LinkedIn's own web app does, so:
//
//   · the TLS and HTTP/2 fingerprint is Chromium's, because it IS Chromium
//   · the request is same-origin, so the browser attaches cookies itself
//   · rotations are applied by the browser's own cookie jar with no merge logic at all
//   · `__cf_bm` and any future bot-management cookie are handled without us knowing they exist
//
// Every call site, every header, every parser upstream is unchanged. This is a transport swap.
//
// ═══ WHAT IT COSTS AND HOW THAT IS BOUNDED ═══
//
// A Chromium is ~300MB resident. One is kept warm and shared, because launching per request costs a
// second and gains nothing, and it is closed after `IDLE_MS` without work — the engine's LinkedIn
// steps are minutes apart, so it should be closed most of the time.

import type { FetchLike } from "./proxy";

/** Cookie as Playwright wants it, and as the session stores it. */
interface Ck {
  name: string;
  value: string;
  domain: string;
  path: string;
}

export interface BrowserTransportOptions {
  /** The proxy Chromium launches behind. Required: this transport must never egress directly. */
  proxyUrl: string;
  /** The stored jar, as a Cookie header string. */
  cookies: string;
  /** Called whenever the browser's jar differs from what we seeded, so the host can persist it. */
  onCookies?: (cookies: string) => void;
  /**
   * The user-agent the session was BORN with.
   *
   * LinkedIn ties a session to the device that created it, and the UA is part of that device. The
   * login flow captures the real browser's own string and stores it next to the jar, so the worker
   * presents the same one. A default here would quietly re-introduce the mismatch this exists to
   * remove, so it is only a fallback for jars created before the field existed.
   */
  userAgent?: string;
  /** Close the browser after this long with no calls. */
  idleMs?: number;
  /** Injected for tests. */
  launcher?: () => Promise<BrowserLike>;
}

// Structural types, so this file needs no playwright import at build time — the package ships
// without a browser and must still compile and load where there is none.
export interface PageLike {
  goto(url: string, opts?: Record<string, unknown>): Promise<unknown>;
  evaluate<T>(fn: string, arg?: unknown): Promise<T>;
}
export interface ContextLike {
  addCookies(cookies: Ck[]): Promise<void>;
  cookies(urls?: string[]): Promise<Ck[]>;
  newPage(): Promise<PageLike>;
}
export interface BrowserLike {
  newContext(opts?: Record<string, unknown>): Promise<ContextLike>;
  close(): Promise<void>;
}

/** `a=1; b=2` → Playwright cookies on `.linkedin.com`. */
export function toPlaywrightCookies(header: string): Ck[] {
  return header
    .split(/;\s*/)
    .map((p) => {
      const i = p.indexOf("=");
      return i > 0 ? { name: p.slice(0, i).trim(), value: p.slice(i + 1), domain: ".linkedin.com", path: "/" } : null;
    })
    .filter((c): c is Ck => c !== null && c.name.length > 0);
}

export const toCookieHeader = (cookies: readonly Ck[]): string =>
  cookies.map((c) => `${c.name}=${c.value}`).join("; ");

/**
 * The script that runs INSIDE the page.
 *
 * Returns a plain object rather than a Response, because nothing structured survives the bridge.
 * `redirect: "manual"` is preserved so the caller keeps seeing 302s as 302s — upstream reads a 3xx
 * as the auth wall and that meaning must not change just because the transport did.
 *
 * `credentials: "include"` is what makes the browser attach and update its own cookies, which is the
 * entire reason for doing it here rather than in Node.
 */
const IN_PAGE = `async ({ url, init }) => {
  const res = await fetch(url, { ...init, credentials: "include", redirect: "manual" });
  const body = await res.text();
  const headers = {};
  res.headers.forEach((v, k) => { headers[k] = v; });
  return { status: res.status, headers, body, type: res.type };
}`;

export class BrowserTransport {
  private browser: BrowserLike | null = null;
  private context: ContextLike | null = null;
  private page: PageLike | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private starting: Promise<void> | null = null;

  constructor(private readonly opts: BrowserTransportOptions) {}

  /** Launch, seed the jar, and land on linkedin.com. Idempotent and safe to call per request. */
  private async ensure(): Promise<void> {
    if (this.page) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const launch = this.opts.launcher ?? defaultLauncher(this.opts.proxyUrl);
      this.browser = await launch();
      this.context = await this.browser.newContext({
        userAgent:
          this.opts.userAgent ||
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
        locale: "en-US",
        viewport: { width: 1440, height: 900 },
      });
      await this.context.addCookies(toPlaywrightCookies(this.opts.cookies));
      this.page = await this.context.newPage();
      // ONE navigation. Everything after this is same-origin `fetch` from within the page, which is
      // what the LinkedIn web app itself does and why the cookies take care of themselves.
      await this.page.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded", timeout: 45_000 });
    })().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  /** Push whatever the browser now holds back to the host, if it changed. */
  private async syncCookies(): Promise<void> {
    if (!this.context || !this.opts.onCookies) return;
    try {
      const now = toCookieHeader(await this.context.cookies(["https://www.linkedin.com"]));
      if (now && now !== this.opts.cookies) this.opts.onCookies(now);
    } catch {
      // Reading the jar back is a nicety. Failing it must never fail the request that succeeded.
    }
  }

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const ms = this.opts.idleMs ?? 5 * 60_000;
    this.idleTimer = setTimeout(() => void this.close(), ms);
    // Never hold the process open for a browser that is only waiting to be closed.
    this.idleTimer.unref?.();
  }

  async close(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const b = this.browser;
    this.browser = this.context = this.page = null;
    await b?.close().catch(() => {});
  }

  /** The `FetchLike` the Voyager layer calls. */
  fetch: FetchLike = async (url, init = {}) => {
    await this.ensure();
    this.touch();
    const headers = { ...((init.headers as Record<string, string>) ?? {}) };
    // The browser owns the cookie jar now. Sending our own would overwrite what it has just
    // rotated, which is the bug this transport exists to make impossible.
    delete headers.cookie;
    delete headers.Cookie;

    /**
     * A SELF-INVOKING EXPRESSION, NOT A FUNCTION PLUS AN ARGUMENT.
     *
     * `evaluate(fnAsString, arg)` relies on the driver noticing that the string evaluates to a
     * function and calling it with `arg`. Against a real Chromium it returned `undefined` instead,
     * so `out.body` threw and every Voyager call through this transport failed — and the unit
     * tests could not see it, because they inject a fake page whose `evaluate` honours the
     * two-argument form. It only showed up when the whole path was run for real.
     *
     * Inlining the argument removes the detection step entirely: this is one expression that
     * evaluates to a promise, which is the case every driver handles the same way.
     */
    const script = `(${IN_PAGE})(${JSON.stringify({ url, init: { ...init, headers } })})`;
    const out = await this.page!.evaluate<{
      status: number;
      headers: Record<string, string>;
      body: string;
    }>(script);
    // A driver that hands back nothing must not surface as a null-property crash three lines later.
    if (!out || typeof out.status !== "number") {
      throw new Error("the browser transport returned no response — the page evaluate failed");
    }

    await this.syncCookies();
    return new Response(out.body || null, { status: out.status, headers: out.headers });
  };
}

/**
 * Chromium, behind the proxy, headless.
 *
 * `playwright-core` ships no browser and the production image installs Alpine's chromium and points
 * `PLAYWRIGHT_CHROMIUM_EXECUTABLE` at it, so the executable path is read from the environment rather
 * than assumed. A non-literal specifier keeps this an optional dependency: an install without a
 * browser never resolves it.
 */
function defaultLauncher(proxyUrl: string): () => Promise<BrowserLike> {
  return async () => {
    const spec = "playwright-core";
    const mod: { chromium?: unknown; default?: { chromium?: unknown } } = await import(spec);
    const chromium = (mod.chromium ?? mod.default?.chromium) as
      | { launch(o: Record<string, unknown>): Promise<BrowserLike> }
      | undefined;
    if (!chromium) throw new Error("playwright-core is installed but exposes no chromium");

    const u = new URL(proxyUrl);
    return chromium.launch({
      headless: true,
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
      // Chromium takes the proxy without credentials in the URL; they go in `proxy.username`/
      // `password`, or it prompts and hangs.
      proxy: {
        server: `${u.protocol}//${u.host}`,
        username: decodeURIComponent(u.username),
        password: decodeURIComponent(u.password),
      },
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled"],
    });
  };
}
