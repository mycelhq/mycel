// Where an `operate` run's browser appears to be.
//
// All four answer engines block a datacenter IP (measured in production, 30 August 2026). Turnstile
// is not a puzzle — it scores the browser and the network, and the ASN is the heaviest term — so
// nothing inside the page moves it. The request has to come from somewhere a customer could sit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { operateEgress, proxyUsername, redactProxy, ispSeatIsFree, ISP_HOST, RESIDENTIAL_HOST_DEFAULT } from "../src/operate-egress";

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
  assert.equal(e.server, "http://gate.decodo.com:10000");
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

/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * EVERY PROVIDER SPELLS THE USERNAME DIFFERENTLY, AND GETTING IT WRONG IS INVISIBLE
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The country travels in the USERNAME for every residential provider, and the format is theirs:
 *
 *   Decodo       user-<name>-country-fr
 *   Bright Data  brd-customer-<id>-zone-<zone>-country-fr
 *   Oxylabs      customer-<id>-cc-fr
 *
 * `operateEgress` hardcoded Decodo's, so pointing it at Bright Data would have produced
 * `user-brd-customer-…-country-fr` — a username that authenticates as nobody. The result is a 407
 * on every request, and a 407 reaching the agent is indistinguishable from the captcha wall this
 * module was deployed to get past. Residential egress configured, billed per gigabyte, measuring
 * nothing, with the symptom completely unchanged.
 *
 * That is the same failure mode the file's header already documents for credentials-in-the-URL,
 * which is why it is worth a test rather than a careful moment.
 */
test("a Decodo name still gets Decodo's prefix", () => {
  assert.equal(proxyUsername("spqx1a2b3c", "fr"), "user-spqx1a2b3c-country-fr");
  // Idempotent: a name already carrying the prefix must not get a second one.
  assert.equal(proxyUsername("user-spqx1a2b3c", "fr"), "user-spqx1a2b3c-country-fr");
});

test("A BRIGHT DATA USERNAME IS LEFT ALONE", () => {
  assert.equal(
    proxyUsername("brd-customer-hl_9f2a-zone-residential", "gb"),
    "brd-customer-hl_9f2a-zone-residential-country-gb",
    "Decodo's prefix is being forced onto a Bright Data username",
  );
});

test("and so is an Oxylabs one", () => {
  assert.equal(proxyUsername("customer-acme", "es"), "customer-acme-country-es");
});

test("A USERNAME THAT ALREADY NAMES A COUNTRY IS NOT SECOND-GUESSED", () => {
  /**
   * Somebody has been explicit. Appending a second country would either be rejected outright or —
   * far worse — honoured, and the probe would go out from somewhere other than the country on the
   * measurement. The header's rule: a country is never substituted, because a substituted
   * measurement is indistinguishable from a real one.
   */
  assert.equal(proxyUsername("user-spqx-country-gb", "fr"), "user-spqx-country-gb");
  assert.equal(proxyUsername("brd-customer-x-zone-res-country-us", "fr"), "brd-customer-x-zone-res-country-us");
});

test("whitespace around a pasted credential does not become part of it", () => {
  // These arrive by copy-paste from a provider's dashboard, which is where trailing spaces live.
  assert.equal(proxyUsername("  spqx1a2b3c  ", "fr"), "user-spqx1a2b3c-country-fr");
});

// ── the vendor's own domain ───────────────────────────────────────────────────────────────────────

test("BOTH HOSTS ARE THE SAME VENDOR, SPELLED THE SAME WAY", () => {
  /**
   * `RESIDENTIAL_HOST_DEFAULT` was `residential.decodo.io` — a hostname with NO DNS record — while
   * `ISP_HOST` two lines below it was `isp.decodo.com`, which resolves. A `.io` next to a `.com`,
   * same vendor, same file.
   *
   * It survived because the feature is off. Flipping `MYCEL_OPERATE_EGRESS` to `residential`, the
   * exact step the infra comment tells the next person to take, would have failed to connect — and
   * a probe that returns nothing is indistinguishable from the blocking this module exists to get
   * past. The plan would have been bought and the symptom unchanged.
   *
   * A DNS lookup would be the direct test and would make this suite depend on the network. The
   * property that actually catches the typo is offline: two hosts for one vendor must share a
   * registrable domain.
   */
  const domain = (h: string) => h.split(".").slice(-2).join(".");
  assert.equal(
    domain(RESIDENTIAL_HOST_DEFAULT),
    domain(ISP_HOST),
    `two hosts for one vendor disagree about its domain: ${RESIDENTIAL_HOST_DEFAULT} vs ${ISP_HOST}`,
  );
  // And neither is the dead one, named so a revert is loud rather than quiet.
  assert.notEqual(RESIDENTIAL_HOST_DEFAULT, "residential.decodo.io", "the host with no DNS record is back");
});
