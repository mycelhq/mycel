// The headless-browser login that captures a LinkedIn session — the fallback path.
//
// PREFER NOT TO USE THIS. `connect.ts` exposes a session handoff (`connectWithSession`) that takes
// the `li_at` + `JSESSIONID` cookies from a browser the member is already logged into, so the
// password never exists anywhere in this system. That is the path a hosted-auth product like
// Unipile is really selling: not a nicer form, but the property that the application never holds
// the credential. Keep this module for the case where the handoff is not available.
//
// When it IS used, the password is treated as radioactive:
//   · it exists only as an argument, for the duration of the call — never on PendingLogin, never in
//     the Connection config, never in the vault, never in a log line;
//   · error strings are scrubbed of it before they leave, because an exception from a browser
//     automation library can quote the input it was handed;
//   · a challenged login holds an open browser, not a credential, so a pending login that expires
//     leaks nothing.
//
// Playwright is loaded lazily and is an OPTIONAL dependency — `startLogin` fails closed with an
// install hint when it's absent, so the kernel builds and boots without it. Live logins can't run in
// CI (no real account, and LinkedIn flags datacenter logins); this module is structured and
// unit-tested around a mockable browser driver, and verified live on a real host
// (docs/VERIFY-LINKEDIN.md).
//
// OPERATIONAL REALITY: logging in from a server IP is the #1 thing LinkedIn flags. A proxy is
// therefore REQUIRED here, not suggested — see proxy.ts. Keep volume low and human-approved.
import type { LinkedInSession } from "./voyager";
import { ProxyRequiredError, playwrightProxy, requireProxy } from "./proxy";

const LOGIN_URL = "https://www.linkedin.com/login";
const FEED_URL = "https://www.linkedin.com/feed/";

export type LoginPhase =
  | "connected" // session captured
  | "needs_2fa" // a verification code is required — relay it via submitChallenge
  | "failed";

export interface LoginOutcome {
  phase: LoginPhase;
  session?: LinkedInSession;
  error?: string;
  /** Set when the failure was the proxy rule, so a caller can answer 400 rather than 502. */
  code?: string;
}

/** The slice of the Playwright API this module uses — enough to mock in tests, without the dep. */
export interface BrowserDriver {
  newContext(opts: {
    proxy?: { server: string; username?: string; password?: string };
  }): Promise<BrowserContextLike>;
  close(): Promise<void>;
}
export interface BrowserContextLike {
  page: PageLike;
  cookies(): Promise<Array<{ name: string; value: string }>>;
  close(): Promise<void>;
}
export interface PageLike {
  goto(url: string, opts?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  fill(selector: string, value: string): Promise<void>;
  click(selector: string): Promise<void>;
  url(): string;
  waitForTimeout(ms: number): Promise<void>;
  /** True if a selector is present within the timeout — used to detect the 2FA challenge. */
  isVisible(selector: string, timeoutMs: number): Promise<boolean>;
}

/**
 * A login in progress, held between the credential step and a 2FA challenge.
 *
 * Note what is absent: the password. Once it has been typed into the form it is not needed again,
 * so it does not survive into this object — which is the thing that lives in a module-level map for
 * up to ten minutes waiting for a human to read a text message.
 */
export interface PendingLogin {
  driver: BrowserDriver;
  ctx: BrowserContextLike;
  proxyUrl?: string;
  createdAt: number;
}

/** Selectors, isolated so a LinkedIn markup change is a one-line fix. */
const SEL = {
  email: "#username",
  password: "#password",
  submit: "button[type=submit]",
  challenge: "input[name=pin], #input__phone_verification_pin, [data-test-id=challenge]",
  challengeInput: "input[name=pin], #input__phone_verification_pin",
  challengeSubmit: "button[type=submit]",
};

/**
 * Remove a secret from a string before it becomes an error message.
 *
 * Belt and braces: nothing we know of echoes the value of a `fill()` back in an exception, but the
 * cost of being wrong once is a password in a log aggregator forever.
 */
export function scrub(text: string, ...secrets: Array<string | undefined>): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 4) out = out.split(s).join("[redacted]");
  }
  return out;
}

/** Read li_at + JSESSIONID out of a context's cookie jar into a session, or null if not logged in. */
export async function sessionFromCookies(ctx: BrowserContextLike): Promise<LinkedInSession | null> {
  const jar = await ctx.cookies();
  const li_at = jar.find((c) => c.name === "li_at")?.value;
  const jsessionid = jar.find((c) => c.name === "JSESSIONID")?.value;
  if (!li_at || !jsessionid) return null;
  return { li_at, jsessionid };
}

/** Lazily load Playwright (optional dep). Returns a BrowserDriver, or throws an install hint. */
async function launchBrowser(): Promise<BrowserDriver> {
  let chromium: any;
  try {
    // Non-literal specifier: optional, possibly-uninstalled dep — resolved only at runtime.
    const pkg = "playwright-core";
    ({ chromium } = await import(pkg));
  } catch {
    throw new Error(
      "playwright-core is not installed; run `npm i playwright-core` (Chromium is provided by the environment) to enable LinkedIn connect.",
    );
  }
  const browser = await chromium.launch({ headless: true });
  return {
    async newContext(opts) {
      const ctx = await browser.newContext({ proxy: opts.proxy });
      const page = await ctx.newPage();
      const pageLike: PageLike = {
        goto: (url, o) => page.goto(url, o),
        fill: (s, v) => page.fill(s, v),
        click: (s) => page.click(s),
        url: () => page.url(),
        waitForTimeout: (ms) => page.waitForTimeout(ms),
        isVisible: async (s, timeoutMs) => {
          try {
            await page.waitForSelector(s, { timeout: timeoutMs, state: "visible" });
            return true;
          } catch {
            return false;
          }
        },
      };
      return { page: pageLike, cookies: () => ctx.cookies(), close: () => ctx.close() };
    },
    close: () => browser.close(),
  };
}

/**
 * Drive the login. On success returns a captured session; if LinkedIn challenges, returns
 * `needs_2fa` plus a PendingLogin the caller holds to finish via `submitChallenge`. `driverFactory`
 * is injectable so the flow is unit-tested without a real browser.
 *
 * Refuses outright without a proxy (see proxy.ts) — a datacenter login is how accounts get locked.
 */
export async function startLogin(
  email: string,
  password: string,
  opts: { proxyUrl?: string; driverFactory?: (proxyUrl?: string) => Promise<BrowserDriver> } = {},
): Promise<{ outcome: LoginOutcome; pending?: PendingLogin }> {
  let proxyUrl: string | undefined;
  try {
    proxyUrl = requireProxy(opts.proxyUrl, "a LinkedIn login");
  } catch (e) {
    if (e instanceof ProxyRequiredError) return { outcome: { phase: "failed", error: e.message, code: e.code } };
    throw e;
  }

  const make = opts.driverFactory ?? launchBrowser;
  let driver: BrowserDriver;
  try {
    driver = await make(proxyUrl);
  } catch (e) {
    return { outcome: { phase: "failed", error: scrub(String((e as Error)?.message ?? e), password) } };
  }

  const ctx = await driver.newContext({ proxy: playwrightProxy(proxyUrl) });
  try {
    await ctx.page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await ctx.page.fill(SEL.email, email);
    await ctx.page.fill(SEL.password, password);
    await ctx.page.click(SEL.submit);
    await ctx.page.waitForTimeout(2500);

    // Logged straight in?
    let session = await sessionFromCookies(ctx);
    if (session && ctx.page.url().includes("/feed")) {
      await ctx.close();
      await driver.close();
      return { outcome: { phase: "connected", session } };
    }

    // Challenge?
    if (await ctx.page.isVisible(SEL.challenge, 4000)) {
      return {
        outcome: { phase: "needs_2fa" },
        pending: { driver, ctx, proxyUrl, createdAt: Date.now() },
      };
    }

    // Some accounts land on the feed only after a beat — one more look.
    session = await sessionFromCookies(ctx);
    if (session) {
      await ctx.close();
      await driver.close();
      return { outcome: { phase: "connected", session } };
    }

    await ctx.close();
    await driver.close();
    return {
      outcome: {
        phase: "failed",
        error: "login did not produce a session (wrong credentials or an unrecognized challenge)",
      },
    };
  } catch (e) {
    await ctx.close().catch(() => {});
    await driver.close().catch(() => {});
    return { outcome: { phase: "failed", error: scrub(String((e as Error)?.message ?? e), password) } };
  }
}

/** Finish a challenged login by submitting the verification code. Tears the browser down either way. */
export async function submitChallenge(pending: PendingLogin, code: string): Promise<LoginOutcome> {
  const { ctx, driver } = pending;
  try {
    await ctx.page.fill(SEL.challengeInput, code);
    await ctx.page.click(SEL.challengeSubmit);
    await ctx.page.waitForTimeout(2500);
    const session = await sessionFromCookies(ctx);
    if (session) return { phase: "connected", session };
    return { phase: "failed", error: "the verification code was not accepted" };
  } catch (e) {
    return { phase: "failed", error: scrub(String((e as Error)?.message ?? e), code) };
  } finally {
    await ctx.close().catch(() => {});
    await driver.close().catch(() => {});
  }
}

export { FEED_URL };
