// The transport that issues Voyager calls from inside a real page.
//
// ═══ WHY THESE EXIST ═══
//
// This file had NO tests, and shipped a defect that failed every single call: it invoked
// `page.evaluate(fnAsString, arg)` and relied on the driver noticing the string evaluated to a
// function and calling it with `arg`. Against a real Chromium that returned `undefined`, so
// `out.body` threw before any request was made.
//
// The fake page below is therefore deliberately STRICT — it accepts one expression string and
// nothing else, which is the contract the real driver turned out to enforce. A permissive fake
// would have passed against the broken code, which is exactly how this got to production.

import { test } from "node:test";
import assert from "node:assert/strict";

import { BrowserTransport, toCookieHeader, toPlaywrightCookies } from "../src/browser-transport";
import type { BrowserLike, ContextLike, PageLike } from "../src/browser-transport";

interface Ck { name: string; value: string; domain: string; path: string }

/** A page that only understands a single self-invoking expression, like the real driver. */
function strictPage(respond: (url: string, init: Record<string, unknown>) => { status: number; headers?: Record<string, string>; body: string }) {
  const seen: { url: string; init: Record<string, unknown> }[] = [];
  const page: PageLike = {
    goto: async () => undefined,
    evaluate: async <T,>(fn: string, arg?: unknown): Promise<T> => {
      assert.equal(arg, undefined, "the argument must be inlined, not passed alongside");
      assert.ok(fn.trim().startsWith("("), "must be a self-invoking expression");
      // Recover what the page would have received, the same way the browser would: by evaluating.
      const payload = JSON.parse(fn.slice(fn.indexOf(")(") + 2, fn.lastIndexOf(")")));
      seen.push(payload);
      const r = respond(payload.url, payload.init ?? {});
      return { status: r.status, headers: r.headers ?? {}, body: r.body } as T;
    },
  };
  return { page, seen };
}

function harness(respond: Parameters<typeof strictPage>[0], cookies: Ck[] = []) {
  const { page, seen } = strictPage(respond);
  const jar = [...cookies];
  const context: ContextLike = {
    addCookies: async (cs) => { jar.push(...(cs as Ck[])); },
    cookies: async () => jar,
    newPage: async () => page,
  };
  let closed = 0;
  const browser: BrowserLike = { newContext: async () => context, close: async () => { closed++; } };
  return { browser, seen, jar, closed: () => closed };
}

test("a Voyager call returns the page's response, not undefined", async () => {
  const h = harness(() => ({ status: 200, body: '{"firstName":"Ada"}' }));
  const t = new BrowserTransport({ proxyUrl: "http://p", cookies: "li_at=AQEDx", launcher: async () => h.browser });
  const res = await t.fetch("https://www.linkedin.com/voyager/api/me", {});
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '{"firstName":"Ada"}');
  await t.close();
});

test("a driver that returns nothing fails loudly, not as a null-property crash", async () => {
  const page: PageLike = { goto: async () => undefined, evaluate: async () => undefined as never };
  const context: ContextLike = { addCookies: async () => {}, cookies: async () => [], newPage: async () => page };
  const browser: BrowserLike = { newContext: async () => context, close: async () => {} };
  const t = new BrowserTransport({ proxyUrl: "http://p", cookies: "li_at=x", launcher: async () => browser });
  await assert.rejects(() => t.fetch("https://www.linkedin.com/voyager/api/me", {}), /returned no response/);
  await t.close();
});

test("our own cookie header is stripped, because the browser owns the jar", async () => {
  const h = harness(() => ({ status: 200, body: "{}" }));
  const t = new BrowserTransport({ proxyUrl: "http://p", cookies: "li_at=AQEDx", launcher: async () => h.browser });
  await t.fetch("https://www.linkedin.com/voyager/api/me", {
    headers: { cookie: "li_at=stale", Cookie: "li_at=stale", "csrf-token": "ajax:1" },
  });
  const sent = h.seen[0].init.headers as Record<string, string>;
  assert.equal(sent.cookie, undefined, "sending our own cookies would overwrite a rotation");
  assert.equal(sent.Cookie, undefined);
  // Everything else must survive: csrf-token is required and a missing one is a 403.
  assert.equal(sent["csrf-token"], "ajax:1");
  await t.close();
});

test("a 302 stays a 302, because upstream reads a 3xx as the auth wall", async () => {
  const h = harness(() => ({ status: 302, headers: { location: "/login" }, body: "" }));
  const t = new BrowserTransport({ proxyUrl: "http://p", cookies: "li_at=x", launcher: async () => h.browser });
  const res = await t.fetch("https://www.linkedin.com/voyager/api/me", {});
  assert.equal(res.status, 302);
  await t.close();
});

test("the session's own user-agent is used when one is stored", async () => {
  let ua: string | undefined;
  const { page } = strictPage(() => ({ status: 200, body: "{}" }));
  const context: ContextLike = { addCookies: async () => {}, cookies: async () => [], newPage: async () => page };
  const browser: BrowserLike = {
    newContext: async (o) => { ua = (o as { userAgent?: string })?.userAgent; return context; },
    close: async () => {},
  };
  const t = new BrowserTransport({
    proxyUrl: "http://p", cookies: "li_at=x", userAgent: "Chrome/151-from-login", launcher: async () => browser,
  });
  await t.fetch("https://www.linkedin.com/voyager/api/me", {});
  assert.equal(ua, "Chrome/151-from-login", "presenting a different UA is the mismatch that gets a session killed");
  await t.close();
});

test("a rotation the browser made is handed back to the host", async () => {
  const h = harness(() => ({ status: 200, body: "{}" }), [
    { name: "li_at", value: "AQEDx", domain: ".linkedin.com", path: "/" },
    { name: "lidc", value: "rotated", domain: ".linkedin.com", path: "/" },
  ]);
  let got = "";
  const t = new BrowserTransport({
    proxyUrl: "http://p", cookies: "li_at=AQEDx", onCookies: (c) => { got = c; }, launcher: async () => h.browser,
  });
  await t.fetch("https://www.linkedin.com/voyager/api/me", {});
  assert.match(got, /lidc=rotated/);
  await t.close();
});

test("cookie header round-trips", () => {
  const cs = toPlaywrightCookies('li_at=AQEDx; JSESSIONID="ajax:99"');
  assert.equal(cs.length, 2);
  assert.equal(cs[0].domain, ".linkedin.com");
  assert.equal(toCookieHeader(cs), 'li_at=AQEDx; JSESSIONID="ajax:99"');
  // A malformed fragment is dropped rather than becoming a nameless cookie.
  assert.equal(toPlaywrightCookies("li_at=x; ; =orphan").length, 1);
});
