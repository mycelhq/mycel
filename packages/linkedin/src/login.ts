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
  | "needs_approval" // LinkedIn wants an in-app tap ("Yes, it's me") — poll via pollForApproval
  | "failed";

export interface LoginOutcome {
  phase: LoginPhase;
  session?: LinkedInSession;
  error?: string;
  /** Set when the failure was the proxy rule, so a caller can answer 400 rather than 502. */
  code?: string;
  /**
   * A sentence for the founder, set on `needs_approval`: there is no code to type, so the UI has to
   * explain that the next move happens on their phone and this screen will catch up on its own.
   */
  message?: string;
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
  /** Best-effort click that never throws (an interstitial that is not there is not a failure). */
  clickIfPresent(selector: string, timeoutMs: number): Promise<boolean>;
  /** The page's title, for saying what LinkedIn actually served when the form is absent. */
  title(): Promise<string>;
  /** Press a key while a selector is focused — the markup-proof way to submit. */
  press(selector: string, key: string): Promise<void>;
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
  // ═══ TYPE, NOT ID — LinkedIn randomizes both ═══
  // The login form used to expose #username / #password (and the authwall variant session_key /
  // session_password). LinkedIn rebuilt it: the real page now renders React inputs with RANDOMIZED
  // ids ("«Refvtkejj35655j6»") and NO name attribute at all, so every id/name selector we had
  // matched nothing — which is exactly why a connect that reached the login page still reported "no
  // form". `input[type=email]` / `input[type=password]` are what the markup cannot take away; the
  // driver targets the FIRST match because LinkedIn renders two form variants (a hidden twin).
  email: "input[type=email]:visible",
  password: "input[type=password]:visible",
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

/**
 * Read the browser's LinkedIn cookies into a session, or null if not logged in.
 *
 * TAKES THE WHOLE JAR, not just the two named cookies. `li_at` and `JSESSIONID` are what
 * AUTHENTICATE; `bcookie` and `bscookie` are what say WHICH BROWSER, and an auth token presented
 * without the device cookies it was issued alongside is the shape of a replayed cookie. See the
 * `cookies` field on LinkedInSession for the full argument and the behaviour that gave it away.
 *
 * Cookies for other hosts are dropped — a jar can hold anything the context has visited, and only
 * LinkedIn's own belong on a LinkedIn request.
 */
export async function sessionFromCookies(ctx: BrowserContextLike): Promise<LinkedInSession | null> {
  const jar = await ctx.cookies();
  const li_at = jar.find((c) => c.name === "li_at")?.value;
  const jsessionid = jar.find((c) => c.name === "JSESSIONID")?.value;
  if (!li_at || !jsessionid) return null;
  return { li_at, jsessionid, cookies: linkedInJar(jar) };
}

/** `[{name,value,domain}]` → one cookie header, LinkedIn's own hosts only. Exported for the vault. */
export function linkedInJar(jar: readonly { name: string; value: string; domain?: string }[]): string {
  return jar
    .filter((c) => !c.domain || /(^|\.)(linkedin\.com|licdn\.com)$/i.test(c.domain.replace(/^\./, "")))
    .filter((c) => c.name && c.value)
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
}

/** Lazily load Playwright (optional dep). Returns a BrowserDriver, or throws an install hint. */
async function launchBrowser(): Promise<BrowserDriver> {
  let chromium: any;
  try {
    // Non-literal specifier: optional, possibly-uninstalled dep — resolved only at runtime.
    const pkg = "playwright-core";
    const mod: any = await import(pkg);
    /**
     * `.default` FIRST, because playwright-core is CommonJS.
     *
     * A CJS module imported from an ESM graph puts its `module.exports` on the namespace's
     * `default`. Node also synthesises named exports where it can detect them, so
     * `{ chromium }` works some of the time and not others — it depends on the loader, and the
     * kernel runs under tsx while the tests run under plain node. A destructure that silently
     * yields `undefined` then fails later as "cannot read launch of undefined", nowhere near here.
     */
    chromium = mod?.chromium ?? mod?.default?.chromium;
    if (!chromium) throw new Error("playwright-core loaded but exported no `chromium`");
  } catch (e) {
    /**
     * ═══ THE REAL ERROR, NOT A GUESS — AND THE REAL CAUSE, WHICH TOOK THREE ROUNDS ═══
     *
     * The original version swallowed `e` and asserted the dependency was missing. Then this comment
     * said that assertion was usually WRONG, because `require.resolve` inside the running container
     * found playwright-core at /app/node_modules/playwright-core/index.js while the connect route
     * still answered "not installed". That reading sent a third person looking for a loader bug.
     *
     * Both were right about their evidence and both drew the wrong conclusion. The package really
     * was installed — in /app/node_modules, the KERNEL's tree — and this file is not in it. It sits
     * at /packages/linkedin/src/login.ts, and node resolves an import by walking UP from the
     * importer: /packages/linkedin/node_modules, /packages/node_modules, /node_modules. It never
     * reaches /app. `require.resolve` run from /app answers a different question than an import run
     * from here, and the two answers were being compared as if they were the same one.
     *
     * kernel/Dockerfile has documented this exact rule since undici hit it — "node cannot borrow the
     * kernel's dependencies" — and playwright-core was added to kernel/package.json anyway, which is
     * the one tree that cannot help. It is an `optionalDependencies` entry of THIS package now, so
     * the per-package `npm ci --omit=dev` the Dockerfile already runs installs it where the
     * import above actually looks.
     *
     * Optional and not required, because it genuinely is: everything in this package except
     * `captureSession` works without a browser, and a self-hoster who never connects LinkedIn should
     * not be made to download it.
     *
     * The hint stays — it is still the right advice on a fresh checkout — and the actual failure
     * travels with it, because a diagnostic that confidently names the wrong cause costs more than
     * no diagnostic at all. Three rounds of this is the proof.
     */
    const why = e instanceof Error ? e.message : String(e);
    throw new Error(
      `LinkedIn connect could not start a browser: ${why}. ` +
        "If playwright-core is genuinely missing, `npm i playwright-core` installs it — Chromium " +
        "itself comes from the environment (PLAYWRIGHT_CHROMIUM_EXECUTABLE).",
    );
  }
  // The image provides DISTRO chromium (kernel/Dockerfile installs it and sets this env) —
  // playwright-core deliberately ships no browsers, and its own download would bloat the image and
  // break on every base bump. An unset env falls back to playwright's resolution for dev machines
  // that ran `npx playwright install`.
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : {}),
  });
  return {
    async newContext(opts) {
      const ctx = await browser.newContext({
        proxy: opts.proxy,
        // Distro chromium's headless UA literally says "HeadlessChrome", which LinkedIn treats as
        // the confession it is — requests get bounced to the authwall before any form renders.
        // A current stable-Chrome UA is not stealth, it is just not a confession.
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
        viewport: { width: 1280, height: 860 },
        locale: "en-US",
      });
      const page = await ctx.newPage();
      const pageLike: PageLike = {
        goto: (url, o) => page.goto(url, o),
        // .first(): LinkedIn renders a twin form, so a bare page.fill trips strict mode.
        fill: (s, v) => page.locator(s).first().fill(v),
        click: (s) => page.click(s),
        url: () => page.url(),
        waitForTimeout: (ms) => page.waitForTimeout(ms),
        isVisible: async (s, timeoutMs) => {
          try {
            await page.locator(s).first().waitFor({ timeout: timeoutMs, state: "visible" });
            return true;
          } catch {
            return false;
          }
        },
        clickIfPresent: async (s, timeoutMs) => {
          try {
            await page.waitForSelector(s, { timeout: timeoutMs, state: "visible" });
            await page.click(s);
            return true;
          } catch {
            return false;
          }
        },
        title: () => page.title(),
        press: (sel, key) => page.locator(sel).first().press(key),
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

    // ═══ THE FORM IS USUALLY ALREADY THERE — LOOK FIRST, DISMISS ONLY IF NEEDED ═══
    //
    // Reaching LinkedIn over a country proxy serves the LOCALISED login page directly ("Inicio de
    // sesión en LinkedIn" on es, "Connexion LinkedIn" on fr) — the form is present, it is just
    // slower to paint over a residential hop. So the first move is a patient look for the field
    // itself (25s, not 15 — proxy latency is real), NOT a click. The old order clicked a consent
    // button and then an `a[href*=/login]` link BEFORE looking, and on the actual login page that
    // second click navigates AWAY from the form — manufacturing the very "no form" it was meant to
    // cure. The consent dismiss now fires only when the field did NOT appear, and never touches a
    // navigation link.
    let formReady = await ctx.page.isVisible(SEL.email, 25_000);
    if (!formReady) {
      // Only now, and only the GDPR overlay (a button, never a link) — then look once more.
      await ctx.page.clickIfPresent("button[action-type=ACCEPT], button[data-tracking-control-name*=gdpr]", 3000);
      formReady = await ctx.page.isVisible(SEL.email, 8_000);
    }

    // A missing login form is a DIAGNOSIS, not a timeout. page.fill would wait its full 30s and
    // throw a selector log the founder cannot act on; probing first lets the error say what
    // LinkedIn actually served — the authwall/checkpoint page — which is a rate/bot verdict on the
    // connection attempt, not a product fault, and retrying later or from the app is the fix.
    if (!formReady) {
      const where = ctx.page.url();
      // What LinkedIn actually served, named — so the next fix targets the real page instead of
      // guessing at selectors. "Security Verification" is the checkpoint; "Sign Up" is the join
      // splash; a login title with no form is the soft wall.
      const served = await ctx.page.title().catch(() => "");
      await ctx.close();
      await driver.close();
      return {
        outcome: {
          phase: "failed",
          error:
            `LinkedIn did not show its login form (it served "${served || "an unknown page"}" at ` +
            `${where.split("?")[0]}). That is LinkedIn declining the automated login, not a wrong ` +
            `password — connecting your account with cookies is the reliable way and takes a minute. ` +
            `Password login can also be retried later.`,
        },
      };
    }
    await ctx.page.fill(SEL.email, email);
    await ctx.page.fill(SEL.password, password);
    // Enter, not a submit-button click. LinkedIn's login page carries SEVERAL type=submit buttons
    // (the consent Accept/Reject, a Language button, Sign in) — a button[type=submit] selector hits
    // the wrong one, which is where the flow died after the fields finally filled. Pressing Enter
    // in the password field submits the form regardless of how the button is marked up.
    await ctx.page.press(SEL.password, "Enter");
    await ctx.page.waitForTimeout(2500);

    // Logged straight in?
    let session = await sessionFromCookies(ctx);
    if (session && ctx.page.url().includes("/feed")) {
      await ctx.close();
      await driver.close();
      return { outcome: { phase: "connected", session } };
    }

    // Challenge? Two shapes, and they are NOT interchangeable.
    //
    //   (A) a PIN/OTP code — a `pin` input is on the page. There is something to type, so the flow
    //       holds the browser and asks the founder for the code (`needs_2fa`, submitChallenge).
    //   (B) an APP-NOTIFICATION approval — LinkedIn pushed "We sent a notification to your LinkedIn
    //       app, approve it" and there is NO input at all; the member taps "Yes, it's me" in the
    //       mobile app and THIS browser session then advances to the feed on its own. Nothing comes
    //       back through our form — the browser gaining a session IS the signal — so this holds the
    //       browser exactly as (A) does but is finished by `pollForApproval`, not by a code.
    //
    // The pin input is the discriminator: probed FIRST, and only its absence (on a checkpoint page)
    // is read as the app-approval screen.
    if (await ctx.page.isVisible(SEL.challengeInput, 4000)) {
      return {
        outcome: { phase: "needs_2fa" },
        pending: { driver, ctx, proxyUrl, createdAt: Date.now() },
      };
    }
    // No pin, but LinkedIn parked us on a checkpoint → the app-approval screen. Hold the browser and
    // let the caller poll for the session the in-app tap will produce.
    if (ctx.page.url().includes("/checkpoint")) {
      return {
        outcome: {
          phase: "needs_approval",
          message:
            "We sent a notification to your LinkedIn app — open LinkedIn on your phone and tap " +
            "“Yes, it’s me”. This finishes on its own once you approve it.",
        },
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

/**
 * Finish an APP-NOTIFICATION login by waiting for the member to approve it in the mobile app.
 *
 * There is no code and nothing for the founder to send back: when they tap "Yes, it's me", LinkedIn
 * advances THIS held browser to the feed, and the cookies it now carries are the whole signal. So
 * this polls the held context's cookie jar every `intervalMs` until li_at + JSESSIONID appear (→
 * `connected`) or `timeoutMs` elapses (→ `failed`). The browser is torn down on BOTH paths — a
 * pending approval that is never tapped must not leak a Chromium process.
 */
export async function pollForApproval(
  pending: PendingLogin,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<LoginOutcome> {
  const { ctx, driver } = pending;
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const intervalMs = opts.intervalMs ?? 4000;
  const deadline = Date.now() + timeoutMs;
  try {
    // Look once before the first wait — the tap may already have landed by the time we get here.
    for (;;) {
      const session = await sessionFromCookies(ctx);
      if (session) return { phase: "connected", session };
      if (Date.now() >= deadline) {
        return { phase: "failed", error: "the approval wasn't confirmed in time — try connecting again" };
      }
      await ctx.page.waitForTimeout(intervalMs);
    }
  } catch (e) {
    return { phase: "failed", error: scrub(String((e as Error)?.message ?? e)) };
  } finally {
    await ctx.close().catch(() => {});
    await driver.close().catch(() => {});
  }
}

export { FEED_URL };
