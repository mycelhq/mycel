import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _resetProxyPoolForTests,
  dedicatedCountryAvailable,
  provisionDedicatedIp,
  releaseDedicatedIp,
  releaseProxy,
  resolveConnectProxy,
} from "../src/proxy-pool";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * ONE MEMBER, ONE ADDRESS — BOUGHT ON CONNECT, GIVEN BACK ON CANCEL
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The gateway path this replaces gave a member a sticky SESSION, which is a promise about a
 * conversation. LinkedIn scores account↔IP stability, so what it needs is an address somebody holds.
 *
 * Three things can go wrong here and each one is expensive in a different way: buying twice for the
 * same member (money), buying in the wrong country (their LinkedIn account), and forgetting to give
 * an address back (money, every month, silently). All three are pinned below.
 */

/** A scripted Bright Data account API. */
function script(steps: Array<{ status?: number; body?: unknown; text?: string }>) {
  const calls: { method: string; url: string; body?: unknown }[] = [];
  let i = 0;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const step = steps[i++] ?? { status: 500, text: "no script left" };
    calls.push({
      method: init?.method ?? "GET",
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const text = step.text ?? (step.body === undefined ? "" : JSON.stringify(step.body));
    return { status: step.status ?? 200, text: async () => text } as unknown as Response;
  }) as unknown as typeof fetch;
  return calls;
}

const realFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = realFetch;
  _resetProxyPoolForTests(join(mkdtempSync(join(tmpdir(), "lease-")), "ledger.json"));
  process.env.MYCEL_LINKEDIN_PROXY_PROVIDER = "brightdata";
  process.env.MYCEL_BRIGHTDATA_CUSTOMER = "hl_abc";
  process.env.MYCEL_BRIGHTDATA_ZONE = "mycel_isp";
  process.env.MYCEL_BRIGHTDATA_PASSWORD = "zonepw";
  process.env.MYCEL_BRIGHTDATA_API_KEY = "key_test";
  delete process.env.MYCEL_BRIGHTDATA_COUNTRY;
});

test("connecting buys one IP in the member's country and addresses it", async () => {
  const calls = script([
    { body: [] },                                        // zone before
    { body: { ok: true } },                              // POST /zone/ips
    { body: [{ ip: "203.0.113.7", country: "gb" }] },    // zone after
  ]);
  const lease = await provisionDedicatedIp({ connectionId: "conn_1", stickyKey: "li:at:abc", country: "gb" });

  assert.equal(lease?.provider, "brightdata");
  assert.equal(lease?.country, "gb");
  // The ADDRESS is in the username, not a session id. That is the whole point.
  assert.match(lease!.proxyUrl, /-ip-203\.0\.113\.7/);
  assert.equal(lease?.ref, "brightdata:ip:203.0.113.7");
  assert.equal((calls.find((c) => c.method === "POST")!.body as { country: string }).country, "gb");

  // And the ordinary connect path now finds that lease instead of minting a session URL.
  const resolved = resolveConnectProxy({ connectionId: "conn_1", stickyKey: "li:at:abc", country: "gb" });
  assert.equal(resolved.proxyUrl, lease!.proxyUrl);
});

test("the same member never buys twice", async () => {
  script([{ body: [] }, { body: { ok: true } }, { body: [{ ip: "203.0.113.7", country: "gb" }] }]);
  const first = await provisionDedicatedIp({ connectionId: "conn_1", stickyKey: "li:at:abc", country: "gb" });

  /*
    A reconnect, a second org connecting the same LinkedIn, a retry after a timeout. All of them land
    here. With no script left, any HTTP call would throw — so this passing IS the assertion that
    nothing was bought.
  */
  script([]);
  const again = await provisionDedicatedIp({ connectionId: "conn_2", stickyKey: "li:at:abc", country: "gb" });
  assert.equal(again?.proxyUrl, first?.proxyUrl);
});

test("no country, no purchase", async () => {
  /*
    Buying "somewhere" for a member whose country we do not know is the foreign-IP outcome the whole
    proxy pool exists to avoid — and it is the one LinkedIn scores hardest against. No script: any
    call would throw.
  */
  script([]);
  assert.equal(await provisionDedicatedIp({ connectionId: "conn_1", stickyKey: "li:at:abc" }), undefined);
});

test("with no API key the old sticky-session path is untouched", async () => {
  // Additive by construction: a deployment that has not opted in never spends, and connect still
  // works exactly as it did.
  delete process.env.MYCEL_BRIGHTDATA_API_KEY;
  script([]);
  assert.equal(await provisionDedicatedIp({ connectionId: "c", stickyKey: "li:at:x", country: "gb" }), undefined);
  const resolved = resolveConnectProxy({ connectionId: "c", stickyKey: "li:at:x", country: "gb" });
  assert.match(resolved.proxyUrl!, /-session-/, "the gateway URL is still available");
});

test("disconnecting gives the address back", async () => {
  script([{ body: [] }, { body: { ok: true } }, { body: [{ ip: "203.0.113.7", country: "gb" }] }]);
  await provisionDedicatedIp({ connectionId: "conn_1", stickyKey: "li:at:abc", country: "gb" });

  const calls = script([{ body: { ips: [] } }, { body: [] }]);
  const out = await releaseDedicatedIp("conn_1");
  assert.deepEqual(out, { released: true, ip: "203.0.113.7" });

  const del = calls[0];
  assert.equal(del.method, "DELETE");
  assert.match(del.url, /\/zone\/ips/);
  assert.deepEqual((del.body as { ips: string[] }).ips, ["203.0.113.7"]);
});

test("an address shared by two connections is not released while one remains", async () => {
  script([{ body: [] }, { body: { ok: true } }, { body: [{ ip: "203.0.113.7", country: "gb" }] }]);
  await provisionDedicatedIp({ connectionId: "conn_1", stickyKey: "li:at:abc", country: "gb" });
  script([]);
  await provisionDedicatedIp({ connectionId: "conn_2", stickyKey: "li:at:abc", country: "gb" });

  /*
    Two orgs, one LinkedIn member, one IP — that is the design (`stickyKey` is the member). Releasing
    when the first org disconnects would pull the address out from under the second one's live
    session, which is the change LinkedIn punishes most. No script: a release attempt would throw.
  */
  const calls = script([]);
  assert.deepEqual(await releaseDedicatedIp("conn_1"), { released: false, ip: "203.0.113.7" });
  /*
    ASSERTED ON THE ABSENCE OF THE CALL, not on the return value. With no script an attempted
    release throws inside the client and is caught, returning the same shape — so the first version
    of this test passed with the guard removed. The property is that Bright Data is never ASKED.
  */
  assert.deepEqual(calls, [], "an address still in use must not be handed back");
});

test("a release that the provider refused reports false rather than pretending", async () => {
  script([{ body: [] }, { body: { ok: true } }, { body: [{ ip: "203.0.113.7", country: "gb" }] }]);
  await provisionDedicatedIp({ connectionId: "conn_1", stickyKey: "li:at:abc", country: "gb" });

  // The IP is still in the zone afterwards: we are still paying for it, and a caller that logged
  // "released" would make a recurring charge invisible.
  script([{ body: { ok: true } }, { body: [{ ip: "203.0.113.7", country: "gb" }] }]);
  assert.deepEqual(await releaseDedicatedIp("conn_1"), { released: false, ip: "203.0.113.7" });
});

test("a session lease has no address to give back, and says so", async () => {
  delete process.env.MYCEL_BRIGHTDATA_API_KEY;
  resolveConnectProxy({ connectionId: "conn_s", stickyKey: "li:at:sess", country: "gb" });
  process.env.MYCEL_BRIGHTDATA_API_KEY = "key_test";
  script([]);
  assert.deepEqual(await releaseDedicatedIp("conn_s"), { released: false });
});

test("releasing an unknown connection is quiet", async () => {
  script([]);
  assert.deepEqual(await releaseDedicatedIp("never_existed"), { released: false });
  // And the sync path still works for the ledger side of it.
  assert.doesNotThrow(() => releaseProxy("never_existed"));
});

test("a country with no stock is not offered", async () => {
  script([{ body: { count: 0 } }]);
  assert.equal(await dedicatedCountryAvailable("gb"), false);
  script([{ body: { count: 12 } }]);
  assert.equal(await dedicatedCountryAvailable("gb"), true);
  /*
    A provider that will not answer is not a country we can promise. Refusing is the safe direction:
    the alternative is taking money for a line we cannot open.
  */
  script([{ status: 500, text: "boom" }, { status: 500, text: "boom" }]);
  assert.equal(await dedicatedCountryAvailable("gb"), false);
});
