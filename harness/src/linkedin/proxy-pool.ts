// Per-account LinkedIn egress — the IP pool.
//
// ═══ PROVIDER STRATEGY ═══
//
// Product: sticky **ISP** (static residential ASN), one identity per LinkedIn **member**.
// Multiple Mycel orgs / projects that connect the SAME LinkedIn account MUST share that IP —
// LinkedIn scores account↔IP stability, and a second Decodo port for "org B" is a ban risk.
// Leases are keyed by `stickyKey` (`li:at:{hash(li_at)}`); connection ids only bind to it.
//
// Rotating residential $/GB is wrong — after syncToken we use ~34 MB/account/month. We buy IPs
// near the member, not gigabytes.
//
// Cost ladder (ISP $/IP/mo, public list ~2026 — verify before buy):
//   **Decodo** (ex-Smartproxy) ~$1.20–1.60 · Proxy-Seller ~$1.50 · IPRoyal ~$1.50–1.80 ·
//   Rayobyte ~$1.35 (annual) · Bright Data shared ISP ~$1.30–1.80 but often higher mins
//
// Default ops path: **Decodo dedicated ISP** bought pool (not API-provisioned).
//   `MYCEL_LINKEDIN_PROXY_PROVIDER=decodo` + `MYCEL_DECODO_USERNAME` / `PASSWORD` +
//   `MYCEL_DECODO_COUNTRIES=fr,es,gb`. Self-serve picks a country; kernel builds
//   `user-{name}-country-{cc}` @ a sticky port pinned to that country. One member per
//   country IP. A country we have not bought fails clearly — never a foreign IP.
//   Decodo has no dedicated-ISP purchase API; a 4th country is a dashboard buy, then
//   add the code to MYCEL_DECODO_COUNTRIES.
//
// Alternate: **static pool** of dedicated ISP URLs from Decodo / Proxy-Seller / IPRoyal
// (`MYCEL_LINKEDIN_PROXY_POOL`, tag `us|http://…` / JSON `{url,country}`).
//
// Bright Data remains optional elastic (`MYCEL_LINKEDIN_PROXY_PROVIDER=brightdata`) — not the
// cost default. Ads stay out of this loop (later channel). Composio = agent toolkit broker only.
//
// BYO `proxy_url` on connect still wins.
//
// GTM = first-party Voyager only (search / warm / invite / DM / sync).
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { ProxyRequiredError, redactProxy, requireProxy } from "./proxy";

export type ProxyProviderId = "byo" | "static" | "decodo" | "brightdata";

export interface ProxyAllocateInput {
  /** Mycel connection id — vault binding only; NOT the sticky egress identity. */
  connectionId: string;
  /**
   * LinkedIn-account sticky identity. Same member across orgs MUST share this so GTM keeps one IP.
   * Prefer `stickyKeyForLiAt(li_at)` (session connect) or `stickyKeyForMemberUrn(self_urn)`.
   * Defaults to `connectionId` only when the member is not yet known (password login, mid-flight).
   */
  stickyKey?: string;
  /** ISO 3166-1 alpha-2, lowercased (e.g. `us`, `gb`). Geo should match the member. */
  country?: string;
}

export interface ProxyLease {
  proxyUrl: string;
  provider: ProxyProviderId;
  country?: string;
  /** Opaque id for the ledger (static slot index, or session key). */
  ref: string;
}

export interface ProxyPoolStatus {
  provider: ProxyProviderId | "none";
  enabled: boolean;
  /** Static pool only — how many URLs are free. Decodo / Bright Data report null (elastic). */
  free: number | null;
  total: number | null;
  /** Free slots grouped by country tag (`*` = untagged). */
  free_by_country?: Record<string, number>;
  /** Decodo dedicated pool — ISO countries we have actually bought. */
  countries?: string[];
}

interface PoolSlot {
  url: string;
  /** Lowercase ISO country, or undefined = usable for any geo. */
  country?: string;
}

interface LeaseRow {
  proxyUrl: string;
  provider: ProxyProviderId;
  ref: string;
  country?: string;
}

interface LedgerFile {
  /**
   * stickyKey → lease. Sticky key is the LinkedIn MEMBER, not the Mycel connection — so org A and
   * org B sharing one LinkedIn account keep one ISP identity. Credentials included (file mode 0600).
   */
  leases: Record<string, LeaseRow>;
  /** connectionId → stickyKey. Many connections may bind to one sticky key. */
  bindings: Record<string, string>;
}

const POOL_HELP =
  "LinkedIn GTM needs a per-account sticky ISP proxy near the member. Self-serve: pass `country` " +
  "and Mycel leases a bought Decodo line (MYCEL_DECODO_USERNAME / PASSWORD / COUNTRIES). BYO: pass " +
  "`proxy_url`. Or MYCEL_LINKEDIN_PROXY_POOL / brightdata. For local dev only, MYCEL_LINKEDIN_ALLOW_DIRECT=1.";

/** Exact founder-facing refusal when that country has no spare dedicated IP. */
export const NO_RESIDENTIAL_LINE = "couldn't open a line in this country";

function dataDir(): string {
  return (process.env.MYCEL_DATA_DIR ?? process.env.MYCEL_LOG_DIR ?? ".mycel").replace(/\/$/, "");
}

function ledgerPath(): string {
  return process.env.MYCEL_LINKEDIN_PROXY_LEDGER?.trim() || join(dataDir(), "linkedin-proxy-leases.json");
}

function readLedger(): LedgerFile {
  const p = ledgerPath();
  if (!existsSync(p)) return { leases: {}, bindings: {} };
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<LedgerFile> & {
      /** Pre-sticky ledgers keyed leases by connectionId only. */
      leases?: Record<string, LeaseRow>;
    };
    const leases = raw.leases ?? {};
    const bindings = { ...(raw.bindings ?? {}) };
    // Migrate: a lease whose key has no binding and looks like a bare connection id is its own sticky.
    for (const key of Object.keys(leases)) {
      const bound = Object.values(bindings).includes(key);
      const isConnKey = !key.startsWith("li:");
      if (isConnKey && !bound && !bindings[key]) bindings[key] = key;
    }
    return { leases, bindings };
  } catch {
    return { leases: {}, bindings: {} };
  }
}

/**
 * Stable sticky id for a live LinkedIn session cookie.
 * Same `li_at` across orgs → same key → same ISP port/session.
 */
export function stickyKeyForLiAt(li_at: string): string {
  const h = createHash("sha256").update(li_at.trim()).digest("hex").slice(0, 32);
  return `li:at:${h}`;
}

/** Stable sticky id once Voyager has told us who the member is. */
export function stickyKeyForMemberUrn(urn: string): string {
  const n = urn.trim().toLowerCase();
  const h = createHash("sha256").update(n).digest("hex").slice(0, 32);
  return `li:urn:${h}`;
}

function stickyOf(input: ProxyAllocateInput): string {
  const s = (input.stickyKey ?? "").trim();
  return s || input.connectionId;
}

function writeLedger(ledger: LedgerFile): void {
  const p = ledgerPath();
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(ledger, null, 2), { mode: 0o600 });
  renameSync(tmp, p);
}

/** Normalise a country code; empty → undefined. */
export function normaliseCountry(raw?: string): string | undefined {
  const c = (raw ?? "").trim().toLowerCase();
  if (!c || c.length !== 2 || !/^[a-z]{2}$/.test(c)) return undefined;
  return c;
}

/**
 * Where the LinkedIn member "is" for egress.
 * Precedence: explicit connect `country` → MYCEL_LINKEDIN_DEFAULT_COUNTRY → Bright Data default.
 *
 * Decodo dedicated leasing does NOT use this — a missing country or a country we have not bought
 * must fail, never silently inherit FR (or any other line) for a US LinkedIn.
 */
export function resolveMemberCountry(explicit?: string): string | undefined {
  return (
    normaliseCountry(explicit) ??
    normaliseCountry(process.env.MYCEL_LINKEDIN_DEFAULT_COUNTRY) ??
    normaliseCountry(process.env.MYCEL_BRIGHTDATA_COUNTRY)
  );
}

/**
 * Dedicated ISP countries actually purchased on this Decodo account.
 * Default is the dogfood pool: France, Spain, UK spare. A 4th country is a dashboard buy, then
 * this list — Decodo has no dedicated-ISP provision API.
 */
export function decodoCountries(): string[] {
  const raw = (process.env.MYCEL_DECODO_COUNTRIES ?? "fr,es,gb").trim();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[,|\s]+/)) {
    const cc = normaliseCountry(part);
    if (cc && !seen.has(cc)) {
      seen.add(cc);
      out.push(cc);
    }
  }
  return out;
}

function noResidentialLine(want?: string): ProxyRequiredError {
  const where = want ? ` ("${want}")` : "";
  return new ProxyRequiredError(
    `${NO_RESIDENTIAL_LINE}${where}.`,
    "linkedin_proxy_no_capacity",
  );
}

function parsePoolSlots(): PoolSlot[] {
  const raw = (process.env.MYCEL_LINKEDIN_PROXY_POOL ?? "").trim();
  if (!raw) return [];
  if (raw.startsWith("[")) {
    try {
      const arr = JSON.parse(raw) as unknown;
      if (!Array.isArray(arr)) return [];
      return arr
        .map((item): PoolSlot | null => {
          if (typeof item === "string") return parseSlotLine(item);
          if (item && typeof item === "object" && "url" in item) {
            const url = String((item as { url: unknown }).url).trim();
            if (!url) return null;
            const country = normaliseCountry(String((item as { country?: unknown }).country ?? ""));
            return { url, country };
          }
          return null;
        })
        .filter((s): s is PoolSlot => s !== null);
    } catch {
      /* fall through */
    }
  }
  return raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map(parseSlotLine)
    .filter((s): s is PoolSlot => s !== null);
}

/** `http://…` or `us|http://…` or `gb|socks5://…`. */
function parseSlotLine(line: string): PoolSlot | null {
  const pipe = line.indexOf("|");
  if (pipe > 0 && pipe <= 3) {
    const country = normaliseCountry(line.slice(0, pipe));
    const url = line.slice(pipe + 1).trim();
    if (!url) return null;
    return { url, country };
  }
  if (!line.includes("://")) return null;
  return { url: line };
}

function parsePoolUrls(): string[] {
  return parsePoolSlots().map((s) => s.url);
}

function brightDataConfigured(): boolean {
  return Boolean(
    process.env.MYCEL_BRIGHTDATA_CUSTOMER?.trim() &&
      process.env.MYCEL_BRIGHTDATA_ZONE?.trim() &&
      process.env.MYCEL_BRIGHTDATA_PASSWORD?.trim(),
  );
}

function decodoConfigured(): boolean {
  return Boolean(
    process.env.MYCEL_DECODO_USERNAME?.trim() && process.env.MYCEL_DECODO_PASSWORD?.trim(),
  );
}

/**
 * Which pool is active. Explicit PROVIDER wins; otherwise prefer static list → Decodo (cheapest
 * elastic ISP with country) → Bright Data.
 */
export function activeProxyProvider(): ProxyProviderId | "none" {
  const forced = (process.env.MYCEL_LINKEDIN_PROXY_PROVIDER ?? "").trim().toLowerCase();
  if (forced === "decodo" || forced === "smartproxy") {
    return decodoConfigured() ? "decodo" : "none";
  }
  if (forced === "brightdata" || forced === "bright_data" || forced === "bright-data") {
    return brightDataConfigured() ? "brightdata" : "none";
  }
  if (forced === "static") return parsePoolSlots().length ? "static" : "none";
  if (forced === "none" || forced === "off") return "none";
  if (parsePoolSlots().length) return "static";
  if (decodoConfigured()) return "decodo";
  if (brightDataConfigured()) return "brightdata";
  return "none";
}

export function proxyPoolEnabled(): boolean {
  return activeProxyProvider() !== "none";
}

export function proxyPoolStatus(): ProxyPoolStatus {
  const provider = activeProxyProvider();
  if (provider === "none") return { provider: "none", enabled: false, free: null, total: null };
  if (provider === "brightdata") {
    return { provider, enabled: true, free: null, total: null };
  }
  if (provider === "decodo") {
    const countries = decodoCountries();
    const ledger = readLedger();
    const taken = new Set(
      Object.values(ledger.leases)
        .filter((l) => l.provider === "decodo" && l.country)
        .map((l) => l.country as string),
    );
    const free_by_country: Record<string, number> = {};
    for (const cc of countries) free_by_country[cc] = taken.has(cc) ? 0 : 1;
    const free = countries.filter((cc) => !taken.has(cc)).length;
    return {
      provider: "decodo",
      enabled: true,
      free,
      total: countries.length,
      free_by_country,
      countries,
    };
  }
  const slots = parsePoolSlots();
  const ledger = readLedger();
  const taken = new Set(Object.values(ledger.leases).map((l) => l.proxyUrl));
  const freeSlots = slots.filter((s) => !taken.has(s.url));
  const free_by_country: Record<string, number> = {};
  for (const s of freeSlots) {
    const key = s.country ?? "*";
    free_by_country[key] = (free_by_country[key] ?? 0) + 1;
  }
  return {
    provider: "static",
    enabled: true,
    free: freeSlots.length,
    total: slots.length,
    free_by_country,
  };
}

/** Build a Bright Data superproxy URL sticky to this LinkedIn member (not Mycel connection). */
export function brightDataProxyUrl(stickyKey: string, country?: string): string {
  const customer = process.env.MYCEL_BRIGHTDATA_CUSTOMER!.trim();
  const zone = process.env.MYCEL_BRIGHTDATA_ZONE!.trim();
  const password = process.env.MYCEL_BRIGHTDATA_PASSWORD!.trim();
  const host = (process.env.MYCEL_BRIGHTDATA_HOST ?? "brd.superproxy.io").trim();
  // ISP zones commonly use 33335; residential 22225. Override if your zone card says otherwise.
  const port = (process.env.MYCEL_BRIGHTDATA_PORT ?? "33335").trim();
  // Session id must be alphanumeric-ish; sticky keys and UUIDs are fine stripped of punctuation.
  const session = stickyKey.replace(/[^a-zA-Z0-9]/g, "").slice(0, 32) || "mycel";
  const cc = resolveMemberCountry(country);
  let user = `brd-customer-${customer}-zone-${zone}`;
  if (cc) user += `-country-${cc}`;
  user += `-session-${session}`;
  return `http://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}`;
}

/**
 * Sticky port for a bought country. FR/ES/GB map to 10001/10001+1/10001+2 so the UK spare is
 * unused until a UK member. Not a hash ring — hashing two seats used to collide members onto
 * one port and could attach France to a US pick.
 */
export function decodoStickyPort(country: string): number {
  const portBase = Math.max(10001, Number(process.env.MYCEL_DECODO_PORT_BASE ?? 10001) || 10001);
  const cc = normaliseCountry(country);
  const idx = cc ? decodoCountries().indexOf(cc) : -1;
  return portBase + Math.max(0, idx);
}

/**
 * Decodo dedicated-ISP URL for a bought country.
 *
 * Docs: `isp.decodo.com`, username always `user-{name}…`, country via `-country-xx`, sticky via a
 * dedicated port in 10001–63000 (rotating is 10000 — we never use that for LinkedIn).
 * The IP is selected by country (one purchased IP per country on this host). `stickyKey` is the
 * lease identity (same LinkedIn member → same URL via the ledger), not a port hash.
 */
export function decodoProxyUrl(stickyKey: string, country?: string): string {
  void stickyKey;
  const rawUser = process.env.MYCEL_DECODO_USERNAME!.trim();
  const password = process.env.MYCEL_DECODO_PASSWORD!.trim();
  const host = (process.env.MYCEL_DECODO_HOST ?? "isp.decodo.com").trim();
  const cc = normaliseCountry(country);
  const port = cc ? decodoStickyPort(cc) : Math.max(10001, Number(process.env.MYCEL_DECODO_PORT_BASE ?? 10001) || 10001);
  // Decodo requires the `user-` prefix; founders often paste the bare dashboard username.
  let user = rawUser.startsWith("user-") ? rawUser : `user-${rawUser}`;
  // Strip a trailing -country-xx if the founder already baked one in — we re-append from member geo.
  user = user.replace(/-country-[a-z]{2}(?=-|$)/i, "");
  if (cc) user += `-country-${cc}`;
  return `http://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}`;
}

function bind(ledger: LedgerFile, connectionId: string, stickyKey: string): void {
  ledger.bindings[connectionId] = stickyKey;
}

function leaseFor(ledger: LedgerFile, stickyKey: string): LeaseRow | undefined {
  return ledger.leases[stickyKey];
}

function allocateStatic(connectionId: string, stickyKey: string, country?: string): ProxyLease {
  const slots = parsePoolSlots();
  if (!slots.length) {
    throw new ProxyRequiredError(`static proxy pool is empty. ${POOL_HELP}`);
  }
  const want = resolveMemberCountry(country);
  const ledger = readLedger();
  // Same LinkedIn member (or same connection) keeps its lease — across orgs.
  const existing = leaseFor(ledger, stickyKey);
  if (existing) {
    bind(ledger, connectionId, stickyKey);
    writeLedger(ledger);
    return {
      proxyUrl: existing.proxyUrl,
      provider: "static",
      ref: existing.ref,
      country: existing.country ?? want,
    };
  }
  const taken = new Set(Object.values(ledger.leases).map((l) => l.proxyUrl));
  const free = slots
    .map((s, i) => ({ ...s, index: i }))
    .filter((s) => !taken.has(s.url));

  // Prefer: exact country match → untagged (any) → refuse rather than wrong-country.
  const pick =
    (want ? free.find((s) => s.country === want) : undefined) ??
    free.find((s) => !s.country) ??
    (!want ? free[0] : undefined);

  if (!pick) {
    if (want && free.length) {
      const have = [...new Set(free.map((s) => s.country ?? "*"))].join(", ");
      throw new ProxyRequiredError(
        `no free ISP proxy in country "${want}" (free geos: ${have}). ` +
          `Add ${want}|http://… entries to MYCEL_LINKEDIN_PROXY_POOL — leasing a foreign IP is a ban risk. ` +
          POOL_HELP,
      );
    }
    throw new ProxyRequiredError(
      `static proxy pool exhausted (${slots.length} IPs, all leased). Add ISP endpoints to ` +
        `MYCEL_LINKEDIN_PROXY_POOL or free a disconnected account. ${POOL_HELP}`,
    );
  }

  const proxyUrl = requireProxy(pick.url, "leasing a pool proxy");
  if (!proxyUrl) throw new ProxyRequiredError(`pool URL refused. ${POOL_HELP}`);
  const ref = `static:${pick.index}`;
  const leaseCountry = pick.country ?? want;
  ledger.leases[stickyKey] = { proxyUrl, provider: "static", ref, country: leaseCountry };
  bind(ledger, connectionId, stickyKey);
  writeLedger(ledger);
  return { proxyUrl, provider: "static", ref, country: leaseCountry };
}

function allocateBrightData(connectionId: string, stickyKey: string, country?: string): ProxyLease {
  if (!brightDataConfigured()) {
    throw new ProxyRequiredError(
      "Bright Data ISP is selected but MYCEL_BRIGHTDATA_CUSTOMER / ZONE / PASSWORD are incomplete. " +
        POOL_HELP,
    );
  }
  const cc = resolveMemberCountry(country);
  const ledger = readLedger();
  const existing = leaseFor(ledger, stickyKey);
  if (existing?.provider === "brightdata") {
    bind(ledger, connectionId, stickyKey);
    writeLedger(ledger);
    return {
      proxyUrl: existing.proxyUrl,
      provider: "brightdata",
      ref: existing.ref,
      country: existing.country ?? cc,
    };
  }
  const proxyUrl = requireProxy(brightDataProxyUrl(stickyKey, cc), "Bright Data ISP allocate");
  if (!proxyUrl) throw new ProxyRequiredError(`Bright Data URL refused. ${POOL_HELP}`);
  const ref = `brightdata:session:${stickyKey}`;
  ledger.leases[stickyKey] = { proxyUrl, provider: "brightdata", ref, country: cc };
  bind(ledger, connectionId, stickyKey);
  writeLedger(ledger);
  return { proxyUrl, provider: "brightdata", ref, country: cc };
}

function allocateDecodo(connectionId: string, stickyKey: string, country?: string): ProxyLease {
  if (!decodoConfigured()) {
    throw new ProxyRequiredError(
      "Decodo ISP is selected but MYCEL_DECODO_USERNAME / PASSWORD are incomplete. " + POOL_HELP,
    );
  }
  // Explicit country only. Env defaults would silently put a US LinkedIn on France.
  const cc = normaliseCountry(country);
  const ledger = readLedger();
  // Same LinkedIn member forever: reconnect / second org keeps the original IP, even if they
  // pick a different country this time.
  const existing = leaseFor(ledger, stickyKey);
  if (existing?.provider === "decodo") {
    bind(ledger, connectionId, stickyKey);
    writeLedger(ledger);
    return {
      proxyUrl: existing.proxyUrl,
      provider: "decodo",
      ref: existing.ref,
      country: existing.country ?? cc,
    };
  }
  if (!cc) throw noResidentialLine();
  const bought = decodoCountries();
  if (!bought.includes(cc)) throw noResidentialLine(cc);
  const taken = Object.entries(ledger.leases).find(
    ([key, row]) => row.provider === "decodo" && row.country === cc && key !== stickyKey,
  );
  if (taken) throw noResidentialLine(cc);

  const proxyUrl = requireProxy(decodoProxyUrl(stickyKey, cc), "Decodo ISP allocate");
  if (!proxyUrl) throw new ProxyRequiredError(`Decodo URL refused. ${POOL_HELP}`);
  const ref = `decodo:${cc}:${decodoStickyPort(cc)}`;
  ledger.leases[stickyKey] = { proxyUrl, provider: "decodo", ref, country: cc };
  bind(ledger, connectionId, stickyKey);
  writeLedger(ledger);
  return { proxyUrl, provider: "decodo", ref, country: cc };
}

/**
 * Lease a sticky proxy for this LinkedIn connection.
 * Throws ProxyRequiredError when the pool cannot serve (misconfigured or exhausted).
 *
 * Pass `stickyKey` derived from the LinkedIn member (`stickyKeyForLiAt` / `stickyKeyForMemberUrn`)
 * so multiple orgs sharing one LinkedIn account share one ISP identity.
 */
export function allocateProxy(input: ProxyAllocateInput): ProxyLease {
  const provider = activeProxyProvider();
  const stickyKey = stickyOf(input);
  if (provider === "static") {
    return allocateStatic(input.connectionId, stickyKey, resolveMemberCountry(input.country));
  }
  if (provider === "decodo") return allocateDecodo(input.connectionId, stickyKey, input.country);
  if (provider === "brightdata") {
    return allocateBrightData(input.connectionId, stickyKey, resolveMemberCountry(input.country));
  }
  throw new ProxyRequiredError(`no LinkedIn proxy pool configured. ${POOL_HELP}`);
}

/**
 * Move a connection onto a LinkedIn-member sticky key after the member is known.
 *
 * Password login allocates under `connectionId` before cookies exist; once we have `li_at` we call
 * this so a second org connecting the same LinkedIn joins the first org's IP instead of minting
 * another. Returns the proxy URL the connection should vault (may change if an older lease wins).
 */
export function adoptStickyKey(
  connectionId: string,
  stickyKey: string,
): { proxyUrl?: string; changed: boolean } {
  const key = stickyKey.trim();
  if (!key) return { changed: false };
  const ledger = readLedger();
  const prevKey = ledger.bindings[connectionId] ?? connectionId;
  const prev = leaseFor(ledger, prevKey);
  const target = leaseFor(ledger, key);

  if (target) {
    // Another org (or an earlier connect) already holds this LinkedIn member's IP — join it.
    bind(ledger, connectionId, key);
    if (prev && prevKey !== key) {
      const stillUsed = Object.entries(ledger.bindings).some(
        ([id, k]) => id !== connectionId && k === prevKey,
      );
      if (!stillUsed) delete ledger.leases[prevKey];
    }
    writeLedger(ledger);
    return { proxyUrl: target.proxyUrl, changed: prev?.proxyUrl !== target.proxyUrl };
  }

  if (prev && prevKey !== key) {
    // Rename this connection's lease onto the member key — same URL, new identity.
    ledger.leases[key] = prev;
    delete ledger.leases[prevKey];
    bind(ledger, connectionId, key);
    writeLedger(ledger);
    return { proxyUrl: prev.proxyUrl, changed: false };
  }

  bind(ledger, connectionId, key);
  writeLedger(ledger);
  return { proxyUrl: prev?.proxyUrl, changed: false };
}

/**
 * Free this connection's binding. The ISP lease is only released when NO other org/connection
 * still shares that LinkedIn member's sticky key — otherwise org B would lose egress when org A
 * disconnects.
 */
export function releaseProxy(connectionId: string): void {
  const ledger = readLedger();
  const stickyKey = ledger.bindings[connectionId];
  if (!stickyKey && !ledger.leases[connectionId]) return;
  delete ledger.bindings[connectionId];
  const key = stickyKey ?? connectionId;
  const stillBound = Object.values(ledger.bindings).includes(key);
  if (!stillBound) delete ledger.leases[key];
  writeLedger(ledger);
}

/**
 * Resolve the proxy for a new LinkedIn connect.
 *
 * Precedence: explicit `proxy_url` (BYO) → pool allocate → direct (dev only) → refuse.
 * When allocating from the pool, pass `stickyKey` from the LinkedIn member whenever known.
 */
export function resolveConnectProxy(opts: {
  connectionId: string;
  stickyKey?: string;
  proxyUrl?: string;
  country?: string;
}): { proxyUrl?: string; provider: ProxyProviderId; lease?: ProxyLease } {
  const byo = (opts.proxyUrl ?? "").trim();
  if (byo) {
    const proxyUrl = requireProxy(byo, "connecting a LinkedIn account");
    return { proxyUrl, provider: "byo" };
  }
  if (proxyPoolEnabled()) {
    const lease = allocateProxy({
      connectionId: opts.connectionId,
      stickyKey: opts.stickyKey,
      country: opts.country,
    });
    return { proxyUrl: lease.proxyUrl, provider: lease.provider, lease };
  }
  // No BYO, no pool — same hard refuse as before (unless local direct waiver).
  const proxyUrl = requireProxy(undefined, "connecting a LinkedIn account");
  return { proxyUrl, provider: "byo" };
}

/** Test helper: wipe ledger file + remember nothing. */
export function _resetProxyPoolForTests(tmpLedger?: string): void {
  if (tmpLedger) process.env.MYCEL_LINKEDIN_PROXY_LEDGER = tmpLedger;
  writeLedger({ leases: {}, bindings: {} });
}

export { POOL_HELP, redactProxy };
