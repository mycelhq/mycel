// Where an `operate` run's browser appears to be, when it needs to appear to be somewhere real.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// THE MEASUREMENT DOES NOT WORK FROM A DATACENTRE, AND THAT IS NOT A BUG TO FIX IN THE PAGE
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// Probed all four answer engines from production on 30 August 2026: ChatGPT and Google AI Mode
// served a captcha, Perplexity and Claude served a Cloudflare Turnstile challenge. The agent handled
// every one correctly and measured nothing, four times.
//
// Turnstile in its usual mode is not a puzzle. There is nothing to solve — it scores the browser and
// the NETWORK and then silently passes or blocks, and the ASN is the heaviest term in that score. So
// no amount of work inside the page moves it: not a stealth patch, not a solver service (there is no
// puzzle for one to solve), not a retry. The request has to come from somewhere a customer could
// plausibly be sitting.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// AND IT IS A BETTER MEASUREMENT, NOT A WORKAROUND
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// This is the part that makes it worth doing properly rather than grudgingly. Answer engines
// personalise by geography. "Best bookkeeping service for creative agencies" returns a different
// answer in London than in Austin, and the client selling to London agencies is buying knowledge of
// the London answer. Probing from `eu-west-2` was never neutral — it was one arbitrary location that
// happened to be ours, and it was being reported as though it were everyone's.
//
// So the country is part of the measurement, and it belongs in the record beside the citation list.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// THE IDLE LINKEDIN LINES MAY BE BORROWED. THE OCCUPIED ONES MAY NOT.
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// There is already a Decodo account here with dedicated ISP IPs in fr, es and gb. One is leased to a
// LinkedIn member; two are sitting idle and paid for. Borrowing an idle one costs nothing and is the
// fastest way to find out whether residential egress clears these walls at all.
//
// So the rule is NOT "never touch those lines". It is: never touch a line somebody's account is
// sitting on. `proxyPoolStatus().free_by_country` already knows which is which — a seat with `0`
// free is leased — and `ispEgress` reads it on every run, because a customer connecting a UK
// LinkedIn account tomorrow silently turns a safe line into an unsafe one.
//
// What the refusal is protecting: an answer engine that flags an address for automation gives it a
// reputation hit, LinkedIn scores IP reputation too, and that member's session lives on that address
// FOREVER. A LinkedIn account nobody can get back, spent on a page load worth $0.0014.
//
// And borrowing is a TEST, not the destination. These are single static addresses. One of them
// making hundreds of probes a week across four engines is a conspicuous pattern where a rotating
// residential pool spreads the same traffic over thousands of consumer connections. Expect the ISP
// lines to work now and degrade.

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// AND A COUNTRY IS NEVER SUBSTITUTED, WHICH IS THE WHOLE REASON THIS FILE IS CAREFUL
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// The tempting shortcut, once you have a Spanish line idle and a UK line busy, is to probe the UK
// query through Spain. It would clear the captcha — Cloudflare does not care which country — and it
// would produce a WRONG NUMBER.
//
// Answer engines personalise by geography. "Best bookkeeping service for UK creative agencies" asked
// from Madrid returns Spanish providers, euros and Spanish-language signals: an answer no UK
// customer will ever see, recorded as a UK measurement and invoiced as one.
//
// That is strictly worse than the block it works around. A blocked probe says `reached: false` and
// everybody knows. A substituted one is indistinguishable from a real measurement.
//
// So there is no fallback in this file. Asked for a country we cannot serve, it returns `undefined`,
// the probe goes out directly, and it comes back honestly blocked.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// OFF UNTIL SOMEBODY TURNS IT ON
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// Residential egress is metered per gigabyte. Nothing here starts spending because a module was
// deployed: with no configuration this returns `undefined` and every probe goes out exactly as it
// does today, blocked and honest about it. Turning it on is a deliberate act with a bill attached,
// and that is the right shape for a decision somebody else has to make.

/**
 * The rotating residential gateway. Not `isp.decodo.com`, which is the sticky LinkedIn product.
 *
 * ═══ THIS WAS `residential.decodo.io`, A HOSTNAME THAT DOES NOT EXIST ═══
 *
 * Checked with DNS, on 13 September, against the vendor's live names:
 *
 *     residential.decodo.io    NO DNS
 *     isp.decodo.com           185.111.111.44   (= isp.smartproxy.com, the rebrand)
 *     gate.decodo.com          136.243.201.65   (= gate.smartproxy.com)
 *
 * A `.io` sitting next to a `.com` that works, in the same file, two lines apart. The cost of the
 * typo was hidden by the feature being OFF: flipping `MYCEL_OPERATE_EGRESS` to `residential` — the
 * exact step the infra comment tells the next person to take — would have failed to connect at all,
 * and the symptom (a probe that returns nothing) is indistinguishable from the blocking this module
 * exists to get past. We would have bought a residential plan and measured no improvement.
 *
 * WHAT IS VERIFIED HERE AND WHAT IS NOT. The hostname resolves and is the same gateway IP as
 * Smartproxy's documented residential gate. The PORT is not verified, because the production
 * credentials are an ISP plan — `isp.smartproxy.com:10000` answers with them and every residential
 * gateway refuses — so there is no residential seat to test a port against. Anyone turning this on
 * should expect to confirm the port against whatever plan they buy; `MYCEL_OPERATE_PROXY_PORT`
 * overrides it without a deploy.
 */
export const RESIDENTIAL_HOST_DEFAULT = "gate.decodo.com";
export const RESIDENTIAL_PORT_DEFAULT = "10000";

/** The sticky dedicated-ISP host — the LinkedIn product, borrowable only where no seat is leased. */
export const ISP_HOST = "isp.decodo.com";

export type EgressMode = "off" | "residential" | "isp";

export interface EgressEnv {
  /**
   * `residential` — the rotating pool, the destination. `isp` — borrow an IDLE dedicated line, for
   * finding out whether this works at all. Anything else, including unset, is direct egress: exactly
   * what every probe does today, blocked and honest about it.
   */
  MYCEL_OPERATE_EGRESS?: string;
  MYCEL_OPERATE_PROXY_USERNAME?: string;
  MYCEL_OPERATE_PROXY_PASSWORD?: string;
  MYCEL_OPERATE_PROXY_HOST?: string;
  MYCEL_OPERATE_PROXY_PORT?: string;
  /** ISO 3166-1 alpha-2, lowercase, comma separated. A country not on this list is refused. */
  MYCEL_OPERATE_PROXY_COUNTRIES?: string;
}

/**
 * ═══ THREE FIELDS, NOT ONE URL, AND THE DIFFERENCE IS NOT COSMETIC ═══
 *
 * The obvious shape is `http://user:pass@host:port`. It does not work, and it fails in the way that
 * costs the most to diagnose.
 *
 * Verified against the pinned wheel rather than assumed. `browser_use/config.py` maps
 * `BROWSER_USE_PROXY_URL` to `ProxySettings.server`, and `browser/profile.py:935` puts that straight
 * into `--proxy-server=`. Chromium DROPS credentials embedded in that flag. Auth is done separately,
 * over CDP: `browser/session.py` registers `Fetch.authRequired` and answers proxy challenges with
 * the `username` and `password` fields, which arrive from their own two env vars.
 *
 * So a single URL with credentials in it produces a 407 on every request — and a 407 reaching the
 * agent looks exactly like the captcha wall it was deployed to get past. We would have shipped
 * residential egress, kept paying for it, and measured nothing, with the symptom unchanged.
 */
export interface EgressChoice {
  /** Credential-free, for `--proxy-server`. e.g. `http://residential.decodo.io:10000`. */
  server: string;
  /** Answered over CDP on `Fetch.authRequired`. Carries the country, Decodo's convention. */
  username: string;
  password: string;
  /**
   * Where the run will appear to be — ALWAYS the country that was asked for, never a substitute.
   * Goes in the measurement record, because two answers collected from different countries are not
   * the same measurement.
   */
  country: string;
  /** Which line this came from. `isp` is a borrowed seat and belongs in the trace. */
  via: "residential" | "isp";
}

/** How the LinkedIn pool reports itself. One free slot per bought country; `0` means leased. */
export interface PoolView {
  free_by_country?: Record<string, number>;
  countries?: string[];
}

const clean = (v: string | undefined): string => (v ?? "").trim();
const cc = (v: string | undefined): string => clean(v).toLowerCase();

/**
 * A LINE WITH SOMEBODY'S LINKEDIN SESSION ON IT IS NOT AVAILABLE.
 *
 * Read per run, not cached. A customer connecting a UK LinkedIn account tomorrow turns a borrowable
 * line into one that must not be touched, and nothing would tell this module about it.
 *
 * `undefined` free count means "not a Decodo pool" — refused, because an unknown lease state is not
 * an idle one, and the thing being risked is an account nobody can get back.
 */
export function ispSeatIsFree(pool: PoolView, country: string): boolean {
  return pool.free_by_country?.[cc(country)] === 1;
}

/**
 * The proxy for one `operate` run, or `undefined` to go out directly as today.
 *
 * `country` is what the CLIENT is selling into, not where we are. It is a required part of the
 * measurement rather than an optimisation, and it is never substituted — see the header. Asked for a
 * country this cannot serve, the answer is `undefined` and the probe goes out to be honestly blocked.
 */
export function operateEgress(
  env: EgressEnv,
  args: { country?: string; pool?: PoolView },
): EgressChoice | undefined {
  const mode = cc(env.MYCEL_OPERATE_EGRESS) as EgressMode;
  if (mode !== "residential" && mode !== "isp") return undefined;

  const user = clean(env.MYCEL_OPERATE_PROXY_USERNAME);
  const pass = clean(env.MYCEL_OPERATE_PROXY_PASSWORD);
  // NO CREDENTIAL, NO PROXY — and no error either. Half-configured egress means somebody is
  // part-way through setting this up, and taking every probe down mid-change would be worse than
  // continuing to go out directly, which is the behaviour they already have.
  if (!user || !pass) return undefined;

  const want = cc(args.country);
  if (!want) return undefined; // no country asked, nothing to measure from

  const allowed = cc(env.MYCEL_OPERATE_PROXY_COUNTRIES)
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
  /**
   * AN UNBOUGHT COUNTRY IS NOT QUIETLY ANOTHER ONE.
   *
   * The LinkedIn doc already states this in bold for its own path: a US connect fails with "no
   * residential line in this country yet" rather than silently using France. Same rule, and here it
   * matters more, because the output of this path is a number on an invoice.
   */
  if (allowed.length && !allowed.includes(want)) return undefined;

  const username = proxyUsername(user, want);

  if (mode === "isp") {
    // Borrowing a seat somebody's LinkedIn session lives on would risk an account that cannot be
    // recovered, for a page load worth a fraction of a cent. No pool view means no evidence it is
    // free, which is not the same as evidence it is free.
    if (!args.pool || !ispSeatIsFree(args.pool, want)) return undefined;
    return { server: `http://${ISP_HOST}:${ispPort(env, want)}`, username, password: pass, country: want, via: "isp" };
  }

  const host = clean(env.MYCEL_OPERATE_PROXY_HOST) || RESIDENTIAL_HOST_DEFAULT;
  const port = clean(env.MYCEL_OPERATE_PROXY_PORT) || RESIDENTIAL_PORT_DEFAULT;
  return { server: `http://${host}:${port}`, username, password: pass, country: want, via: "residential" };
}

/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * THE COUNTRY GOES IN THE USERNAME, AND EVERY PROVIDER SPELLS THE USERNAME DIFFERENTLY
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * This was `user-${user.replace(/^user-/, "")}-country-${want}`, which is Decodo's convention
 * hardcoded — and the rest of this module is deliberately provider-agnostic (host, port, username,
 * password, four plain fields). The one line that was not agnostic is the one that decides whether
 * any other provider works at all.
 *
 * Bright Data's residential username is `brd-customer-<id>-zone-<zone>`. Forcing Decodo's prefix
 * onto it produces `user-brd-customer-…-zone-…-country-fr`, which authenticates as nobody: a 407 on
 * every request, and a 407 reaching the agent looks EXACTLY like the captcha wall this whole module
 * exists to get past. We would have configured residential egress, paid for it, and measured
 * nothing, with the symptom unchanged — which is the failure the header of this file already warns
 * about for credentials-in-the-URL.
 *
 * So: a username that already carries a provider's own prefix is left alone, and only a bare Decodo
 * name gets `user-`. The country suffix is appended for both, because both providers take it there.
 * A username that already names a country is left completely alone — somebody has been explicit and
 * second-guessing them would silently probe from the wrong place.
 */
export function proxyUsername(user: string, country: string): string {
  const name = user.trim();
  if (/-country-[a-z]{2}(?=-|$)/i.test(name)) return name;
  // Bright Data (`brd-customer-…`), Oxylabs (`customer-…`), or anything already prefixed `user-`.
  const carriesItsOwnPrefix = /^(brd-|customer-|user-)/i.test(name);
  return `${carriesItsOwnPrefix ? name : `user-${name}`}-country-${country}`;
}

/**
 * The sticky port for a bought country, matching the LinkedIn pool's own arithmetic.
 *
 * Deliberately recomputed here rather than imported from `@mycel/linkedin`: this module must not
 * depend on the package whose lines it is borrowing, or the separation the header argues for stops
 * being visible in the imports. `proxy-pool.ts` is the source of truth and this must agree with it —
 * `operate-egress.test.ts` pins the numbers the doc states (FR 10001, ES 10002, GB 10003).
 */
function ispPort(env: EgressEnv, country: string): number {
  const list = cc(env.MYCEL_OPERATE_PROXY_COUNTRIES).split(",").map((c) => c.trim()).filter(Boolean);
  const idx = list.indexOf(country);
  return 10001 + Math.max(0, idx);
}

/** What may be said about an egress choice in a log, a trace or an event. Never the password. */
export function redactProxy(e: EgressChoice): string {
  return `${e.via} ${e.username}@${e.server}`;
}
