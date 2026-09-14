/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * BRIGHT DATA'S ACCOUNT MANAGEMENT API — ALLOCATING A REAL IP FOR A REAL MEMBER
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Until now this repo used Bright Data as a GATEWAY: one shared zone, a sticky session id in the
 * username, and whatever IP the pool handed out for that session. That is fine for scraping and
 * wrong for LinkedIn, for the reason `proxy-pool.ts` already states — LinkedIn scores account↔IP
 * stability, and a sticky SESSION is a promise about a conversation, not about an address. Bright
 * Data may re-home a sticky session; a dedicated IP is a thing you hold.
 *
 * So: when a founder connects LinkedIn and names their country, we BUY them an IP in it, address it
 * explicitly, and give it back when they stop paying.
 *
 * ═══ WHAT THE DOCS ACTUALLY SAY, READ 2026-09-12 ═══
 *
 * Every call below was read off `docs.brightdata.com`, not inferred:
 *
 *   POST   /zone/ips                 { customer, zone, count, country }   → allocate
 *   DELETE /zone/ips                 { zone, ips: [...] }                 → release, returns remaining
 *   GET    /zone/route_ips           ?zone&country&list_countries=true    → what this zone holds
 *   GET    /zone/count_available_ips ?plan={"country","ips_type"}         → can we serve that country
 *
 * Auth is `Authorization: Bearer <API key>`, and the key needs the **Admin or Ops** role — the docs
 * warn on every mutating page that these calls "can modify your account settings, damage your
 * operations or incur charges". They are not wrong: `POST /zone/ips` spends money per IP per month.
 *
 * ═══ THE THREE TRAPS THE DOCS CALL OUT BY NAME ═══
 *
 *   1. COUNTRY CODES MUST BE LOWERCASE. An uppercase code returns "no IPs available" — a misleading
 *      error that reads as "we do not cover Great Britain" when it means "you typed GB".
 *   2. `DELETE /zone` WITH NO `zone` FIELD DELETES EVERY ZONE ON THE ACCOUNT. The docs say so in one
 *      line: *"can be skipped to affect all your zones"*. Nothing in this file calls that endpoint,
 *      at all, and the reason is written here so nobody adds it for tidiness later. Releasing an IP
 *      is `DELETE /zone/ips` with an explicit list.
 *   3. A DEDICATED ISP ZONE IS NOT `type: "ISP"` ALONE. It also needs `plan.pool_ip_type:
 *      "static_res"`, or Bright Data silently creates a DATACENTER zone — the one product LinkedIn
 *      scores hardest against. Zone creation is not done here (see `ZONE_CREATE_PAYLOAD`), but the
 *      payload is recorded so whoever creates the zone does not get a datacentre pool by accident.
 *
 * ═══ AND ONE THE DOCS CONTRADICT THEMSELVES ON ═══
 *
 * `count_available_ips` is documented as `GET /zone/count_available_ips` in the OpenAPI block and as
 * `GET /count_available_ips` in every curl example on the same page. Somebody ran the curl; nobody
 * necessarily ran the OpenAPI. So this tries the documented path and falls back to the other on a
 * 404 rather than picking a side — the cost of being wrong is a capacity check that always fails,
 * which would refuse every country.
 *
 * ═══ NOTHING HERE SPENDS UNLESS IT IS CONFIGURED ═══
 *
 * No API key, no client. Every caller treats `undefined` as "this deployment does not buy IPs", and
 * falls back to the gateway behaviour that exists today. That is the same shape `operate-egress.ts`
 * uses for the same reason: a module that starts spending because it was deployed is a module that
 * bills somebody for a decision they did not make.
 */

/** ISO 3166-1 alpha-2, lowercase. The one formatting rule Bright Data punishes with a wrong error. */
export type CountryCode = string;

export interface BrightDataConfig {
  /** Account id — the `brd-customer-<id>` half of the proxy username. */
  customer: string;
  /** The dedicated-ISP zone these IPs live in. */
  zone: string;
  /** An API key with the Admin or Ops role. */
  apiKey: string;
  /** Swappable for tests. Never called with a relative URL. */
  fetch?: typeof fetch;
  base?: string;
}

export interface AllocatedIp {
  ip: string;
  country: CountryCode;
}

/**
 * The payload that creates a DEDICATED ISP zone, recorded rather than called.
 *
 * Creating zones from the product would let a bug create a hundred of them, each with a monthly
 * minimum. A deployment has ONE, made once, by a person who meant to. This exists so that person
 * does not have to re-read the docs to find the two fields that decide whether they get ISP or
 * datacentre — and so a test can assert we still know what they are.
 */
export const ZONE_CREATE_PAYLOAD = (name: string, country: CountryCode, ips: number) => ({
  zone: { name, type: "ISP" },
  plan: {
    type: "static",
    // WITHOUT THIS, `type: "ISP"` SILENTLY CREATES A DATACENTER ZONE.
    pool_ip_type: "static_res",
    ips_type: "dedicated",
    bandwidth: "unlimited",
    // `bandwidth: unlimited` alone does not activate unlimited billing; the docs are explicit.
    unl_bw_tiers: "std",
    country: lower(country),
    ips,
  },
});

const DEFAULT_BASE = "https://api.brightdata.com";

function lower(cc: string): string {
  return (cc ?? "").trim().toLowerCase();
}

/** Read from the environment, or `undefined` when this deployment does not provision IPs. */
export function brightDataApiConfig(env: NodeJS.ProcessEnv = process.env): BrightDataConfig | undefined {
  const customer = env.MYCEL_BRIGHTDATA_CUSTOMER?.trim();
  const zone = env.MYCEL_BRIGHTDATA_ZONE?.trim();
  const apiKey = env.MYCEL_BRIGHTDATA_API_KEY?.trim();
  if (!customer || !zone || !apiKey) return undefined;
  return { customer, zone, apiKey, ...(env.MYCEL_BRIGHTDATA_API_BASE?.trim() ? { base: env.MYCEL_BRIGHTDATA_API_BASE.trim() } : {}) };
}

export class BrightDataError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** The provider's own body, truncated. Kept because their errors name the field that was wrong. */
    readonly detail?: string,
  ) {
    super(message);
    this.name = "BrightDataError";
  }
}

async function call(
  cfg: BrightDataConfig,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
): Promise<{ status: number; text: string; json: unknown }> {
  const f = cfg.fetch ?? fetch;
  const res = await f(`${cfg.base ?? DEFAULT_BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${cfg.apiKey}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text().catch(() => "");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    /* plain text is a documented response for route_ips */
  }
  return { status: res.status, text, json };
}

/**
 * How many dedicated IPs Bright Data could sell us in this country RIGHT NOW.
 *
 * Asked BEFORE a founder is told their country is available, because the alternative is finding out
 * at allocation time — after they have chosen, after they have paid, and with nothing to say except
 * that it did not work.
 */
export async function countAvailable(cfg: BrightDataConfig, country: CountryCode): Promise<number> {
  const plan = encodeURIComponent(JSON.stringify({ country: lower(country), ips_type: "dedicated" }));
  // The documented path first; the curl-example path second. See the header — the docs disagree, and
  // picking one blind turns a capacity check into a permanent refusal.
  for (const path of [`/zone/count_available_ips?plan=${plan}`, `/count_available_ips?plan=${plan}`]) {
    const r = await call(cfg, "GET", path);
    if (r.status === 404) continue;
    if (r.status >= 400) {
      throw new BrightDataError(`could not check availability in ${lower(country)}`, r.status, r.text.slice(0, 400));
    }
    return readCount(r.json, r.text);
  }
  throw new BrightDataError("the availability endpoint answered 404 on both documented paths", 404);
}

/** Their count comes back as a bare number, a `{count}` or a `{available}` depending on the path. */
function readCount(json: unknown, text: string): number {
  if (typeof json === "number") return json;
  if (json && typeof json === "object") {
    for (const key of ["count", "available", "ips", "amount"]) {
      const v = (json as Record<string, unknown>)[key];
      if (typeof v === "number") return v;
    }
  }
  const n = Number(text.trim());
  return Number.isFinite(n) ? n : 0;
}

/**
 * Buy `count` dedicated IPs in a country and return the ones that are new.
 *
 * DIFFED AGAINST WHAT THE ZONE HELD A MOMENT AGO, rather than trusting the response shape. Bright
 * Data's add-IPs response is documented as "zone or account configuration data as JSON" — which is
 * not a contract — and the difference between "these are your new IPs" and "here is your whole zone"
 * decides whether a founder gets their own address or somebody else's. The listing endpoint IS
 * specified (`[{ip, country}]`), so the diff is built from the thing with a schema.
 */
export async function allocateIps(
  cfg: BrightDataConfig,
  country: CountryCode,
  count = 1,
): Promise<AllocatedIp[]> {
  const cc = lower(country);
  if (!cc || !/^[a-z]{2}$/.test(cc)) {
    // Refused here rather than sent: an uppercase or malformed code comes back as "no IPs
    // available", which reads as a country we do not cover.
    throw new BrightDataError(`"${country}" is not a two-letter country code`, 400);
  }
  const before = new Set((await listIps(cfg)).map((x) => x.ip));

  const r = await call(cfg, "POST", "/zone/ips", {
    customer: cfg.customer,
    zone: cfg.zone,
    count,
    country: cc,
  });
  if (r.status >= 400) {
    throw new BrightDataError(`could not allocate an IP in ${cc}`, r.status, r.text.slice(0, 400));
  }

  const after = await listIps(cfg);
  const fresh = after.filter((x) => !before.has(x.ip));
  // An empty diff is a FAILURE, not a success with no rows: the call reported 200 and the zone did
  // not grow, which is the shape a quota or a billing hold takes.
  if (fresh.length === 0) {
    throw new BrightDataError(`Bright Data accepted the request but the zone gained no IP in ${cc}`, 200, r.text.slice(0, 400));
  }
  return fresh.slice(0, count);
}

/** Every IP in the zone, with its country. The one endpoint with a documented response shape. */
export async function listIps(cfg: BrightDataConfig, country?: CountryCode): Promise<AllocatedIp[]> {
  const q = new URLSearchParams({ zone: cfg.zone, list_countries: "true" });
  if (country) q.set("country", lower(country));
  const r = await call(cfg, "GET", `/zone/route_ips?${q}`);
  if (r.status >= 400) throw new BrightDataError("could not read the zone's IPs", r.status, r.text.slice(0, 400));

  if (Array.isArray(r.json)) {
    return (r.json as { ip?: unknown; country?: unknown }[])
      .filter((x) => typeof x?.ip === "string")
      .map((x) => ({ ip: String(x.ip), country: lower(String(x.country ?? country ?? "")) }));
  }
  // `list_countries` unsupported or ignored: the documented fallback is a plain newline list, and a
  // country we asked for is the country they are in.
  return r.text
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((ip) => ({ ip, country: lower(country ?? "") }));
}

/**
 * Give an IP back.
 *
 * EXPLICIT LIST, ALWAYS. `DELETE /zone/ips` takes the addresses to remove; the neighbouring
 * `DELETE /zone` removes a whole zone and, with no `zone` field, EVERY zone on the account. This
 * function exists partly so that nobody reaches for that one.
 *
 * Returns true when the IP is no longer in the zone — including when it was already gone, because
 * "release an address we do not hold" is the ordinary outcome of a retry, not an error to escalate.
 */
export async function releaseIps(cfg: BrightDataConfig, ips: string[]): Promise<boolean> {
  const wanted = ips.map((s) => s.trim()).filter(Boolean);
  if (wanted.length === 0) return true;

  const r = await call(cfg, "DELETE", "/zone/ips", { zone: cfg.zone, ips: wanted });
  if (r.status >= 400 && r.status !== 404) {
    throw new BrightDataError("could not release the address", r.status, r.text.slice(0, 400));
  }
  const remaining = new Set((await listIps(cfg)).map((x) => x.ip));
  return wanted.every((ip) => !remaining.has(ip));
}

/**
 * The proxy URL that addresses ONE allocated IP.
 *
 * `-ip-<address>` is the targeting flag for the Datacenter/ISP products. The error catalog documents
 * what happens when it names an address the zone no longer holds — HTTP 400 — which is the signal a
 * caller should treat as "re-provision", not as "the network is down". See `IP_GONE`.
 */
export function ipProxyUrl(cfg: BrightDataConfig, password: string, ip: string, host = "brd.superproxy.io", port = "33335"): string {
  const user = `brd-customer-${cfg.customer}-zone-${cfg.zone}-ip-${ip}`;
  return `http://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}`;
}

/**
 * The status Bright Data returns when the `-ip-` flag names an address that has been refreshed,
 * removed or changed under us. Exported so the caller can branch on it rather than string-matching.
 */
export const IP_GONE = 400;
