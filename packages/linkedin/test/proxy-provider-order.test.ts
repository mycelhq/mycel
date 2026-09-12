// BRIGHT DATA IS THE DEFAULT, BECAUSE DECODO CANNOT SERVE SELF-SERVE.
//
// Decodo sells dedicated ISP by the COUNTRY, from a dashboard, with no purchase API — so the set of
// countries we can egress from is whatever somebody bought in advance and typed into
// MYCEL_DECODO_COUNTRIES. A self-serve user's country is not known until they connect, and nobody
// pre-buys 195 countries. The only options there are a hard refusal or a foreign IP, and a foreign
// IP is what LinkedIn scores hardest against.
//
// It is also no longer the cheaper one. Checked 7 September 2026: Bright Data ISP from $1.30/IP;
// Decodo $3.33/IP at three, $2.90 at ten. The comment this replaces recorded Decodo at ~$1.20–1.60
// and called it "the cost default".

import { test } from "node:test";
import assert from "node:assert/strict";

import { activeProxyProvider } from "../src/proxy-pool";

const KEYS = [
  "MYCEL_LINKEDIN_PROXY_PROVIDER", "MYCEL_LINKEDIN_PROXY_POOL",
  "MYCEL_DECODO_USERNAME", "MYCEL_DECODO_PASSWORD", "MYCEL_DECODO_COUNTRIES",
  "MYCEL_BRIGHTDATA_CUSTOMER", "MYCEL_BRIGHTDATA_ZONE", "MYCEL_BRIGHTDATA_PASSWORD",
];
function withEnv(env: Record<string, string>, run: () => void) {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, env);
  try { run(); } finally {
    for (const k of KEYS) delete process.env[k];
    for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
  }
}

const DECODO = { MYCEL_DECODO_USERNAME: "u", MYCEL_DECODO_PASSWORD: "p" };
const BRIGHT = { MYCEL_BRIGHTDATA_CUSTOMER: "c", MYCEL_BRIGHTDATA_ZONE: "z", MYCEL_BRIGHTDATA_PASSWORD: "p" };

test("provider: with both configured, Bright Data wins", () => {
  withEnv({ ...DECODO, ...BRIGHT }, () => {
    assert.equal(activeProxyProvider(), "brightdata");
  });
});

test("provider: Decodo still works when it is the only one configured", () => {
  // Retained, not removed. The founder seat runs on a Decodo IP its session was born on, and moving
  // a warm account to a new IP is the change LinkedIn punishes most.
  withEnv(DECODO, () => {
    assert.equal(activeProxyProvider(), "decodo");
  });
});

test("provider: an explicit choice still overrides the order", () => {
  withEnv({ ...DECODO, ...BRIGHT, MYCEL_LINKEDIN_PROXY_PROVIDER: "decodo" }, () => {
    assert.equal(activeProxyProvider(), "decodo");
  });
  withEnv({ ...DECODO, ...BRIGHT, MYCEL_LINKEDIN_PROXY_PROVIDER: "brightdata" }, () => {
    assert.equal(activeProxyProvider(), "brightdata");
  });
});

test("provider: nothing configured is 'none', never a bare connection", () => {
  // A missing pool must refuse rather than egress from the container's own IP.
  withEnv({}, () => assert.equal(activeProxyProvider(), "none"));
});
