import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ZONE_CREATE_PAYLOAD,
  allocateIps,
  brightDataApiConfig,
  countAvailable,
  ipProxyUrl,
  listIps,
  releaseIps,
  type BrightDataConfig,
} from "../src/brightdata-api";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * BUYING A REAL IP FOR A REAL MEMBER
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Every call in `brightdata-api.ts` was read off the docs on 2026-09-12. These tests pin the three
 * traps the docs name, the one place the docs contradict themselves, and the two failure modes that
 * cost money or cost somebody their LinkedIn account.
 *
 * The fetch is a fake, deliberately. This provisions paid infrastructure — a test that hits the real
 * API allocates real IPs and bills for them, which is a test nobody runs twice.
 */

/** A scripted Bright Data. Each entry answers one request and records what it was asked. */
function fakeBrightData(script: Array<{ status?: number; body?: unknown; text?: string }>) {
  const calls: { method: string; url: string; body?: unknown }[] = [];
  let i = 0;
  const f = (async (url: string, init?: RequestInit) => {
    const step = script[i++] ?? { status: 500, text: "no script left" };
    calls.push({
      method: init?.method ?? "GET",
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const text = step.text ?? (step.body === undefined ? "" : JSON.stringify(step.body));
    return {
      status: step.status ?? 200,
      text: async () => text,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetch: f, calls };
}

const cfg = (fetchImpl: typeof fetch): BrightDataConfig => ({
  customer: "hl_abc123",
  zone: "mycel_isp",
  apiKey: "key_test",
  fetch: fetchImpl,
});

test("a country code is lowercased, and a malformed one never reaches them", async () => {
  /*
    The docs are explicit: "Country codes must be lowercase (e.g. us, gb). Uppercase codes return a
    misleading 'no IPs available' error." That error reads as "we do not cover Great Britain" when it
    means "you typed GB" — so the case is fixed here and the malformed input is refused here.
  */
  const bd = fakeBrightData([
    { body: [] },
    { body: { ok: true } },
    { body: [{ ip: "1.2.3.4", country: "gb" }] },
  ]);
  await allocateIps(cfg(bd.fetch), "GB");
  const post = bd.calls.find((c) => c.method === "POST")!;
  assert.equal((post.body as { country: string }).country, "gb");

  for (const bad of ["", "GBR", "u", "united kingdom"]) {
    await assert.rejects(() => allocateIps(cfg(fakeBrightData([]).fetch), bad), /two-letter country code/);
  }
});

test("the new address is the DIFFERENCE, not whatever the response happened to contain", async () => {
  /*
    `POST /zone/ips` is documented as returning "zone or account configuration data as JSON", which
    is not a contract. Handing a founder the first IP out of that blob is how one member ends up on
    another member's address — and on LinkedIn, an address is an identity. The listing endpoint IS
    specified, so the new IP is computed from the thing with a schema.
  */
  const bd = fakeBrightData([
    { body: [{ ip: "5.5.5.5", country: "gb" }] },                                   // before
    { body: { ips: ["5.5.5.5", "9.9.9.9"], note: "whole zone, unhelpfully" } },     // the add
    { body: [{ ip: "5.5.5.5", country: "gb" }, { ip: "9.9.9.9", country: "gb" }] }, // after
  ]);
  const got = await allocateIps(cfg(bd.fetch), "gb");
  assert.deepEqual(got, [{ ip: "9.9.9.9", country: "gb" }]);
});

test("200 with no new IP is a failure, because that is what a billing hold looks like", async () => {
  const bd = fakeBrightData([
    { body: [{ ip: "5.5.5.5", country: "gb" }] },
    { status: 200, body: { ok: true } },
    { body: [{ ip: "5.5.5.5", country: "gb" }] },
  ]);
  await assert.rejects(() => allocateIps(cfg(bd.fetch), "gb"), /gained no IP/);
});

test("availability survives the docs disagreeing with themselves", async () => {
  /*
    `count_available_ips` is `GET /zone/count_available_ips` in the OpenAPI block and
    `GET /count_available_ips` in every curl example ON THE SAME PAGE. Picking one blind turns the
    capacity check into a permanent refusal — every country unavailable, for everyone.
  */
  const bd = fakeBrightData([{ status: 404, text: "not found" }, { body: { count: 42 } }]);
  assert.equal(await countAvailable(cfg(bd.fetch), "gb"), 42);
  assert.match(bd.calls[0].url, /\/zone\/count_available_ips/);
  assert.match(bd.calls[1].url, /api\.brightdata\.com\/count_available_ips/);

  // A bare number is also a documented shape.
  assert.equal(await countAvailable(cfg(fakeBrightData([{ text: "7" }]).fetch), "us"), 7);
});

test("releasing names the addresses, and never the zone", async () => {
  /*
    THE FOOTGUN THIS GUARDS. `DELETE /zone` removes a zone, and the docs say the `zone` field "can be
    skipped to affect all your zones" — one missing field between a cancelled customer and every
    customer's egress. Nothing in this module may call it.
  */
  const bd = fakeBrightData([{ body: { ips: [] } }, { body: [] }]);
  assert.equal(await releaseIps(cfg(bd.fetch), ["9.9.9.9"]), true);

  const del = bd.calls[0];
  assert.equal(del.method, "DELETE");
  assert.match(del.url, /\/zone\/ips/);
  assert.ok(!/\/zone$/.test(new URL(del.url).pathname), "released through the zone endpoint");
  assert.deepEqual((del.body as { ips: string[] }).ips, ["9.9.9.9"]);
  assert.equal((del.body as { zone: string }).zone, "mycel_isp");
});

test("releasing an address we no longer hold is success, not an error to escalate", async () => {
  // The ordinary outcome of a retry, and of a cancellation processed twice.
  const bd = fakeBrightData([{ status: 404, text: "no such ip" }, { body: [] }]);
  assert.equal(await releaseIps(cfg(bd.fetch), ["9.9.9.9"]), true);
  // And releasing nothing costs no request at all.
  const empty = fakeBrightData([]);
  assert.equal(await releaseIps(cfg(empty.fetch), []), true);
  assert.equal(empty.calls.length, 0);
});

test("a release that did not take is reported as false, not swallowed", async () => {
  // The IP is still in the zone afterwards: we are still paying for it, and the caller must not
  // record the lease as returned.
  const bd = fakeBrightData([{ body: { ok: true } }, { body: [{ ip: "9.9.9.9", country: "gb" }] }]);
  assert.equal(await releaseIps(cfg(bd.fetch), ["9.9.9.9"]), false);
});

test("the zone listing falls back to the plain list the docs describe", async () => {
  const bd = fakeBrightData([{ text: "1.1.1.1\n2.2.2.2\n" }]);
  assert.deepEqual(await listIps(cfg(bd.fetch), "fr"), [
    { ip: "1.1.1.1", country: "fr" },
    { ip: "2.2.2.2", country: "fr" },
  ]);
});

test("the zone payload keeps the two fields that decide ISP versus datacentre", () => {
  /*
    "Setting zone.type to ISP alone will create a Datacenter zone, not an ISP zone. You must also set
    plan.pool_ip_type to static_res." A datacentre pool is the one product LinkedIn scores hardest
    against, so getting this wrong does not fail loudly — it bans accounts slowly.
  */
  const p = ZONE_CREATE_PAYLOAD("mycel_isp", "GB", 10);
  assert.equal(p.zone.type, "ISP");
  assert.equal(p.plan.pool_ip_type, "static_res");
  assert.equal(p.plan.ips_type, "dedicated");
  assert.equal(p.plan.country, "gb", "the country is lowercased here too");
  // `bandwidth: unlimited` alone does not activate unlimited billing.
  assert.equal(p.plan.bandwidth, "unlimited");
  assert.equal(p.plan.unl_bw_tiers, "std");
});

test("the proxy url addresses the IP itself", () => {
  const url = ipProxyUrl(cfg(fakeBrightData([]).fetch), "pw", "9.9.9.9");
  assert.match(url, /brd-customer-hl_abc123-zone-mycel_isp-ip-9\.9\.9\.9/);
  assert.match(url, /@brd\.superproxy\.io:33335$/);
});

test("no API key, no client — a deployment does not start buying because it was deployed", () => {
  assert.equal(brightDataApiConfig({} as NodeJS.ProcessEnv), undefined);
  assert.equal(
    brightDataApiConfig({ MYCEL_BRIGHTDATA_CUSTOMER: "c", MYCEL_BRIGHTDATA_ZONE: "z" } as NodeJS.ProcessEnv),
    undefined,
    "customer and zone alone are the gateway credentials, not permission to spend",
  );
  const ok = brightDataApiConfig({
    MYCEL_BRIGHTDATA_CUSTOMER: "c",
    MYCEL_BRIGHTDATA_ZONE: "z",
    MYCEL_BRIGHTDATA_API_KEY: "k",
  } as NodeJS.ProcessEnv);
  assert.deepEqual(ok, { customer: "c", zone: "z", apiKey: "k" });
});
