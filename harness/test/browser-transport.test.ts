// Measured on 1 September against this account, same cookie jar every time:
//
//   undici through the Decodo ISP proxy  ->  403       the session is rejected
//   undici direct from a home IP         ->  302 loop  to the same URL, forever
//   Brave, same cookies, same machine    ->  works
//
// Every cookie-shaped fix moved that by zero — the full 38-cookie jar including __cf_bm still
// failed. The cookies were never the problem. The CLIENT was.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BrowserTransport,
  toCookieHeader,
  toPlaywrightCookies,
  type BrowserLike,
  type ContextLike,
  type PageLike,
} from "../src/linkedin/browser-transport";

const JAR = 'li_at=AQED-real; JSESSIONID="ajax:1"; bcookie=v=2&abc';

/** A browser that records what it was asked, and can rotate its own jar like a real one. */
function fakeBrowser(opts: { rotateTo?: string; status?: number; body?: string } = {}) {
  const calls: { url: string; init: Record<string, unknown> }[] = [];
  let jar = toPlaywrightCookies(JAR);
  let closed = false;
  let navigated: string | null = null;
  const page: PageLike = {
    goto: async (url) => {
      navigated = url;
      return null;
    },
    /**
     * ═══ THE FAKE HAS TO READ THE SCRIPT THE WAY A REAL DRIVER DOES ═══
     *
     * This used to take the payload from `evaluate`'s SECOND ARGUMENT. The transport no longer
     * passes one: it inlines the argument into the script — `(${IN_PAGE})({"url":…})` — precisely
     * because the two-argument form returned `undefined` against real Chromium and every Voyager
     * call failed. `browser-transport.ts` says so at the point of the fix, and adds that "the unit
     * tests could not see it, because they inject a fake page whose evaluate honours the
     * two-argument form".
     *
     * That was still true afterwards, so this test has been red ever since — asserting on
     * `calls[0].init` where nothing was ever pushed. A fake that accepts a call shape the real
     * driver rejects is worse than no fake: it goes green on exactly the thing that breaks.
     *
     * So parse the payload out of the script, which is what a driver does.
     */
    evaluate: async <T,>(fn: string, arg?: unknown) => {
      const inlined = (() => {
        if (arg !== undefined) return arg;
        const open = fn.lastIndexOf(")(");
        if (open < 0) return undefined;
        try {
          return JSON.parse(fn.slice(open + 2, fn.lastIndexOf(")")));
        } catch {
          return undefined;
        }
      })();
      const a = inlined as { url: string; init: Record<string, unknown> };
      calls.push(a);
      if (opts.rotateTo) jar = toPlaywrightCookies(opts.rotateTo);
      return { status: opts.status ?? 200, headers: { "content-type": "application/json" }, body: opts.body ?? "{}" } as T;
    },
  };
  const context: ContextLike = {
    addCookies: async (c) => {
      jar = [...c];
    },
    cookies: async () => jar,
    newPage: async () => page,
  };
  const browser: BrowserLike = {
    newContext: async () => context,
    close: async () => {
      closed = true;
    },
  };
  return { browser, calls, get closed() { return closed; }, get navigated() { return navigated; } };
}

test("transport: navigates to LinkedIn once, then every call is same-origin fetch from the page", async () => {
  const f = fakeBrowser();
  const t = new BrowserTransport({ proxyUrl: "http://u:p@proxy:1", cookies: JAR, launcher: async () => f.browser });
  await t.fetch("https://www.linkedin.com/voyager/api/me");
  await t.fetch("https://www.linkedin.com/voyager/api/identity");
  assert.match(String(f.navigated), /linkedin\.com/, "one navigation establishes the origin");
  assert.equal(f.calls.length, 2, "both calls ran inside the page");
  await t.close();
});

test("transport: our cookie header is stripped — the BROWSER owns the jar", async () => {
  // Sending our own would overwrite what the browser has just rotated, which is the exact bug this
  // transport exists to make impossible.
  const f = fakeBrowser();
  const t = new BrowserTransport({ proxyUrl: "http://u:p@proxy:1", cookies: JAR, launcher: async () => f.browser });
  await t.fetch("https://www.linkedin.com/voyager/api/me", {
    headers: { cookie: "li_at=STALE", "csrf-token": "ajax:1" },
  });
  const sent = (f.calls[0]!.init as { headers: Record<string, string> }).headers;
  assert.equal(sent.cookie, undefined, "no cookie header may reach the page");
  assert.equal(sent["csrf-token"], "ajax:1", "every other header survives untouched");
  await t.close();
});

test("transport: a rotated jar is handed back to be persisted", async () => {
  const rotated = 'li_at=AQED-real; JSESSIONID="ajax:1"; bcookie=v=2&abc; lidc=b=FRESH';
  const f = fakeBrowser({ rotateTo: rotated });
  let saved: string | null = null;
  const t = new BrowserTransport({
    proxyUrl: "http://u:p@proxy:1",
    cookies: JAR,
    onCookies: (c) => (saved = c),
    launcher: async () => f.browser,
  });
  await t.fetch("https://www.linkedin.com/voyager/api/me");
  assert.ok(saved, "a changed jar must reach the host");
  assert.match(String(saved), /lidc=b=FRESH/);
  await t.close();
});

test("transport: an unchanged jar is not written back", async () => {
  // The host persists to a database. A write per request would be a write per Voyager call.
  const f = fakeBrowser();
  let writes = 0;
  const t = new BrowserTransport({
    proxyUrl: "http://u:p@proxy:1",
    cookies: JAR,
    onCookies: () => writes++,
    launcher: async () => f.browser,
  });
  await t.fetch("https://www.linkedin.com/voyager/api/me");
  await t.fetch("https://www.linkedin.com/voyager/api/me");
  assert.equal(writes, 0, "nothing changed, so nothing is written");
  await t.close();
});

test("transport: a 302 is still a 302 — the meaning of a status must not change with the transport", async () => {
  // Upstream reads a 3xx as the auth wall. `redirect: manual` is preserved inside the page so that
  // reading stays true.
  const f = fakeBrowser({ status: 302 });
  const t = new BrowserTransport({ proxyUrl: "http://u:p@proxy:1", cookies: JAR, launcher: async () => f.browser });
  const res = await t.fetch("https://www.linkedin.com/voyager/api/me");
  assert.equal(res.status, 302);
  await t.close();
});

test("transport: the body and status survive the bridge intact", async () => {
  const f = fakeBrowser({ body: '{"miniProfile":{"firstName":"Islam"}}' });
  const t = new BrowserTransport({ proxyUrl: "http://u:p@proxy:1", cookies: JAR, launcher: async () => f.browser });
  const res = await t.fetch("https://www.linkedin.com/voyager/api/me");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { miniProfile: { firstName: "Islam" } });
  await t.close();
});

test("transport: cookie header round-trips through Playwright's shape", () => {
  const round = toCookieHeader(toPlaywrightCookies(JAR));
  assert.equal(round, JAR);
  assert.deepEqual(toPlaywrightCookies(""), []);
  // A quoted value must survive: JSESSIONID is always quoted.
  assert.ok(toPlaywrightCookies(JAR).some((c) => c.name === "JSESSIONID" && c.value === '"ajax:1"'));
});

test("transport: the browser is closed, and closing twice is safe", async () => {
  const f = fakeBrowser();
  const t = new BrowserTransport({ proxyUrl: "http://u:p@proxy:1", cookies: JAR, launcher: async () => f.browser });
  await t.fetch("https://www.linkedin.com/voyager/api/me");
  await t.close();
  assert.equal(f.closed, true);
  await t.close();
});
