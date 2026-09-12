// Where an `operate` run's browser appears to be.
//
// All four answer engines block a datacenter IP (measured in production, 30 August 2026). Turnstile
// is not a puzzle — it scores the browser and the network, and the ASN is the heaviest term — so
// nothing inside the page moves it. The request has to come from somewhere a customer could sit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { operateEgress, redactProxy, ispSeatIsFree, ISP_HOST } from "../src/operate-egress";

const RESI = {
  MYCEL_OPERATE_EGRESS: "residential",
  MYCEL_OPERATE_PROXY_USERNAME: "mycel_geo",
  MYCEL_OPERATE_PROXY_PASSWORD: "s3cr3t",
  MYCEL_OPERATE_PROXY_COUNTRIES: "gb,fr,es",
};
const ISP = { ...RESI, MYCEL_OPERATE_EGRESS: "isp", MYCEL_OPERATE_PROXY_COUNTRIES: "fr,es,gb" };
/** France leased to a LinkedIn member; Spain and the UK bought and idle. */
const POOL = { free_by_country: { fr: 0, es: 1, gb: 1 }, countries: ["fr", "es", "gb"] };

test("with nothing configured, every probe goes out exactly as it does today", () => {
  // Residential egress is metered per gigabyte. A module reaching production must not start
  // spending somebody's money because it was deployed.
  assert.equal(operateEgress({}, { country: "gb" }), undefined);
  assert.equal(operateEgress({ MYCEL_OPERATE_EGRESS: "residential" }, { country: "gb" }), undefined);
});

test("half-configured is direct, not an error", () => {
  // Somebody is part-way through setting this up. Taking every probe down mid-change is worse than
  // continuing with the behaviour they already have.
  assert.equal(operateEgress({ ...RESI, MYCEL_OPERATE_PROXY_PASSWORD: "" }, { country: "gb" }), undefined);
});

test("the country rides in the username, Decodo's convention", () => {
  const e = operateEgress(RESI, { country: "gb" })!;
  assert.equal(e.country, "gb");
  assert.equal(e.username, "user-mycel_geo-country-gb");
  assert.equal(e.password, "s3cr3t");
  assert.equal(e.via, "residential");
});

test("the server URL carries NO credentials, because Chromium would drop them", () => {
  /**
   * Verified against the pinned browser-use wheel, not assumed. `config.py` maps
   * `BROWSER_USE_PROXY_URL` to `ProxySettings.server`; `profile.py` passes it as `--proxy-server=`;
   * Chromium ignores userinfo in that flag. Auth happens over CDP instead — `session.py` registers
   * `Fetch.authRequired` and answers with the separate username/password.
   *
   * A `user:pass@host` URL therefore 407s every request, and a 407 reaching the agent is
   * indistinguishable from the captcha wall this path exists to get past. We would have paid for
   * residential egress and measured exactly as much as before.
   */
  const e = operateEgress(RESI, { country: "gb" })!;
  assert.equal(e.server, "http://residential.decodo.io:10000");
  assert.ok(!e.server.includes("@"), "a credential here is silently dropped, then blamed on a captcha");
  assert.ok(!e.server.includes("s3cr3t"));
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// A COUNTRY IS NEVER SUBSTITUTED
// ═══════════════════════════════════════════════════════════════════════════════════════════════

test("a country we cannot serve is direct egress, never a different country", () => {
  /**
   * THE TRAP THIS EXISTS FOR.
   *
   * With a Spanish line idle and a UK line busy, probing the UK query through Spain would clear the
   * captcha — Cloudflare does not care which country — and produce a WRONG NUMBER. Answer engines
   * personalise by geography: "best bookkeeper for UK creative agencies" asked from Madrid returns
   * Spanish providers and euros, an answer no UK customer will ever see, recorded as a UK
   * measurement and invoiced as one.
   *
   * Strictly worse than the block it works around. A blocked probe says `reached: false` and
   * everybody knows; a substituted one is indistinguishable from a real measurement.
   */
  assert.equal(operateEgress(RESI, { country: "us" }), undefined, "unbought country: no substitute");
  assert.equal(operateEgress(RESI, {}), undefined, "no country asked is nothing to measure from");

  // And the same on the ISP path, where the temptation is strongest because the line is sitting idle.
  const gb = operateEgress(ISP, { country: "gb", pool: POOL })!;
  assert.equal(gb.country, "gb");
  assert.equal(operateEgress(ISP, { country: "us", pool: POOL }), undefined);
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// BORROWING AN IDLE LINKEDIN LINE
// ═══════════════════════════════════════════════════════════════════════════════════════════════

test("an idle seat may be borrowed; an occupied one may not", () => {
  /**
   * France is leased to a LinkedIn member, so their session lives on that address forever. An answer
   * engine flagging it for automation gives it a reputation hit, LinkedIn scores IP reputation too,
   * and the account cannot be recovered — spent on a page load worth $0.0014.
   *
   * Spain and the UK are bought and idle, so borrowing them costs nothing and is the fastest way to
   * find out whether residential egress clears these walls at all.
   */
  assert.ok(operateEgress(ISP, { country: "es", pool: POOL }), "idle Spanish line is borrowable");
  assert.equal(operateEgress(ISP, { country: "fr", pool: POOL }), undefined, "France has a member on it");
});

test("no pool view means no evidence the seat is free, which is not the same as free", () => {
  // Read per run and never cached: a customer connecting a UK LinkedIn account tomorrow turns a
  // borrowable line into one that must not be touched, and nothing would tell this module about it.
  assert.equal(operateEgress(ISP, { country: "gb" }), undefined);
  assert.equal(operateEgress(ISP, { country: "gb", pool: {} }), undefined);
  assert.ok(!ispSeatIsFree({}, "gb"));
  assert.ok(!ispSeatIsFree({ free_by_country: { gb: 0 } }, "gb"));
});

test("the borrowed line uses the sticky port the LinkedIn pool would give it", () => {
  // The doc states FR 10001, ES 10002, GB 10003. `proxy-pool.ts` is the source of truth and this
  // must agree with it — a port disagreement is a connection to nothing, which reads as a block.
  assert.equal(operateEgress(ISP, { country: "fr", pool: { free_by_country: { fr: 1 } } })!.server, `http://${ISP_HOST}:10001`);
  assert.equal(operateEgress(ISP, { country: "es", pool: POOL })!.server, `http://${ISP_HOST}:10002`);
  assert.equal(operateEgress(ISP, { country: "gb", pool: POOL })!.server, `http://${ISP_HOST}:10003`);
});

test("a username already carrying the decodo prefix is not double-prefixed", () => {
  // The dashboard shows some sub-users with the prefix and some without, and `user-user-x` is a
  // silent auth failure that reads like a blocked probe — the exact symptom this is meant to cure.
  const e = operateEgress({ ...RESI, MYCEL_OPERATE_PROXY_USERNAME: "user-mycel_geo" }, { country: "fr" })!;
  assert.equal(e.username, "user-mycel_geo-country-fr");
  assert.ok(!e.username.includes("user-user-"));
});

test("the password never appears in anything loggable, and the line is named", () => {
  const e = operateEgress(ISP, { country: "gb", pool: POOL })!;
  const safe = redactProxy(e);
  assert.ok(!safe.includes("s3cr3t"), "a proxy credential in a trace is a credential in a log file");
  // `isp` in the trace, because a borrowed seat is a temporary arrangement somebody has to unwind.
  assert.equal(safe, `isp user-mycel_geo-country-gb@http://${ISP_HOST}:10003`);
});
