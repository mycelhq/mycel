// Public-page enrichment hop — crawl a company site, keep only emails that are ON the page.
//
// Firecrawl is already keyed (`mycel/firecrawl-api-key`). FullEnrich is the paid waterfall. This
// hop is the one that can run when that key is empty, and the one that must never invent an
// address: we scrape markdown and regex the literals. An LLM extract that "guesses" a role@domain
// is how a sending domain gets burned.
//
// Cost is Firecrawl credits, recorded when the API reports them. We never write cost_usd: 0.

import { normalisedHost, parsePublicHttps } from "../public-url";

export const FIRECRAWL_KEY_ENV = "FIRECRAWL_API_KEY";
export const FIRECRAWL_RESOLVER = "firecrawl";

const EMAIL = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
/** Local-part prefixes that are never a person. `privacy@` stays — it is often the real contact. */
const JUNK_LOCAL = /^(?:noreply|no-reply|donotreply|do-not-reply|mailer-daemon|notifications?|bounce|postmaster)\b/i;
const JUNK_DOMAIN = /@(?:example\.com|domain\.com|email\.com|sentry\.io|wixpress\.com|yourdomain|placeholder)$/i;

export function firecrawlConfigured(): boolean {
  return !!(process.env[FIRECRAWL_KEY_ENV] ?? "").trim();
}

/** Public https host we are willing to fetch. Same SSRF shapes as meeting join URLs. */
export function publicHttpsUrl(raw: string): string | undefined {
  const u = parsePublicHttps(raw);
  if (!u) return undefined;
  const host = normalisedHost(u.hostname);
  if (host === "linkedin.com" || host.endsWith(".linkedin.com")) return undefined;
  return u.toString();
}

/** Company homepage + /contact. LinkedIn URLs are skipped — they authwall and waste credits. */
export function urlsToCrawl(input: { company_domain?: string; company?: string }): string[] {
  const raw = (input.company_domain ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const host = raw.replace(/^www\./, "");
  if (!host || host.includes("linkedin.com") || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) return [];
  const home = publicHttpsUrl(`https://${host}`);
  const contact = publicHttpsUrl(`https://${host}/contact`);
  return [home, contact].filter((u): u is string => !!u);
}

export function emailsInText(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.match(EMAIL) ?? []) {
    const email = m.toLowerCase();
    if (JUNK_LOCAL.test(email) || JUNK_DOMAIN.test(email) || seen.has(email)) continue;
    seen.add(email);
    out.push(email);
  }
  return out.slice(0, 8);
}

function phonesInText(text: string): string | undefined {
  const m = text.match(/(?:\+|00)?\d[\d\s().-]{8,16}\d/);
  return m ? m[0].replace(/\s+/g, " ").trim() : undefined;
}

function redact(s: string, key: string): string {
  return key ? s.split(key).join("«FIRECRAWL_API_KEY»") : s;
}

export interface FirecrawlHop {
  ok: boolean;
  email?: string;
  phone?: string;
  credits: number;
  pages: number;
  reason?: string;
}

async function scrape(url: string): Promise<{ markdown: string; credits: number; detail?: string }> {
  const key = (process.env[FIRECRAWL_KEY_ENV] ?? "").trim();
  const base = (process.env.FIRECRAWL_BASE_URL ?? "https://api.firecrawl.dev/v1").replace(/\/$/, "");
  try {
    const res = await fetch(`${base}/scrape`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true }),
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    const body = (json ?? {}) as {
      success?: boolean;
      data?: { markdown?: string; metadata?: { creditsUsed?: number } };
      creditsUsed?: number;
      error?: string;
    };
    const markdown = typeof body.data?.markdown === "string" ? body.data.markdown : "";
    const credits = Number(body.data?.metadata?.creditsUsed ?? body.creditsUsed ?? (res.ok ? 1 : 0)) || 0;
    if (!res.ok) {
      return { markdown: "", credits, detail: redact(body.error ?? `firecrawl ${res.status}`, key) };
    }
    return { markdown, credits };
  } catch (e) {
    return { markdown: "", credits: 0, detail: redact((e as Error).message ?? "firecrawl failed", key) };
  }
}

/**
 * Crawl public company pages for this person. Empty pages or no domain → ok: false.
 * Never invents an address that was not a literal on the page.
 */
export async function firecrawlPerson(input: {
  company_domain?: string;
  company?: string;
}): Promise<FirecrawlHop> {
  if (!firecrawlConfigured()) {
    return { ok: false, credits: 0, pages: 0, reason: `set ${FIRECRAWL_KEY_ENV} to crawl public pages` };
  }
  const urls = urlsToCrawl(input);
  if (!urls.length) {
    return { ok: false, credits: 0, pages: 0, reason: "no public company site to crawl" };
  }
  let credits = 0;
  let pages = 0;
  let lastDetail: string | undefined;
  const found: string[] = [];
  let phone: string | undefined;
  for (const url of urls) {
    const got = await scrape(url);
    credits += got.credits;
    pages += 1;
    if (got.detail) lastDetail = got.detail;
    if (!got.markdown.trim()) continue;
    for (const e of emailsInText(got.markdown)) {
      if (!found.includes(e)) found.push(e);
    }
    phone = phone ?? phonesInText(got.markdown);
    if (found.length) break;
  }
  if (!found.length) {
    return { ok: false, credits, pages, phone, reason: lastDetail ?? "crawled public pages, no address on them" };
  }
  return { ok: true, email: found[0], phone, credits, pages };
}
