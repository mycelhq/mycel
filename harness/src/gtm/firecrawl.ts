// Public-page enrichment hop — crawl a company site, keep only emails that are ON the page.
//
// Firecrawl is already keyed (`mycel/firecrawl-api-key`). FullEnrich is the paid waterfall. This
// hop is the one that can run when that key is empty, and the one that must never invent an
// address: we scrape markdown and regex the literals. An LLM extract that "guesses" a role@domain
// is how a sending domain gets burned.
//
// Cost is Firecrawl credits, recorded when the API reports them. We never write cost_usd: 0.

import { fetchWithDeadline } from "../http";
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

/**
 * A plain GET of a public page, tag-stripped. No renderer, no credit, no third party.
 *
 * Deliberately minimal and deliberately silent: this is an OPTIMISATION in front of `scrape`, so
 * every failure mode — a timeout, a 404, a bot wall, an SSRF refusal — has the same correct
 * answer, which is "" and let the paid hop decide. It must never throw and never be the reason a
 * crawl fails.
 */
async function plainRead(url: string): Promise<string> {
  const safe = publicHttpsUrl(url);
  if (!safe) return "";
  try {
    const r = await fetchWithDeadline(
      safe,
      { headers: { "user-agent": "MycelBot/1.0 (+https://mycelai.dev)", accept: "text/html" } },
      { deadlineMs: 12_000 },
    );
    if (!r.ok || r.status === 0) return "";
    const html = r.text ?? "";
    if (!/<\/?[a-z]/i.test(html) && html.length < 200) return "";
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .slice(0, 200_000);
  } catch {
    return "";
  }
}

async function scrape(url: string): Promise<{ markdown: string; credits: number; detail?: string }> {
  const key = (process.env[FIRECRAWL_KEY_ENV] ?? "").trim();
  const base = (process.env.FIRECRAWL_BASE_URL ?? "https://api.firecrawl.dev/v1").replace(/\/$/, "");
  try {
    /**
     * DEADLINED, and this call needed it most of the three: Firecrawl fetches ARBITRARY PROSPECT
     * WEBSITES on our behalf, so its response time is a function of a stranger's server. That is
     * the exact population that killed the founder's own outbound engine for a day — see http.ts.
     *
     * Longer than the default, because a scrape legitimately takes tens of seconds: the provider
     * has to load and render somebody else's page before it can answer at all.
     */
    const r = await fetchWithDeadline(
      `${base}/scrape`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true }),
      },
      { deadlineMs: 60_000, redact: (m) => (key ? m.split(key).join("«FIRECRAWL_API_KEY»") : m) },
    );
    if (r.status === 0) return { markdown: "", credits: 0, detail: `firecrawl ${r.detail ?? "unreachable"}` };
    const res = { ok: r.ok, status: r.status };
    const text = r.text;
    const json: unknown = r.json;
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
    /**
     * THE FREE READ FIRST, AND ONLY PAY WHERE IT CANNOT SEE.
     *
     * This crawled every URL through Firecrawl unconditionally — two credits per person, on pages
     * that are overwhelmingly WordPress and readable by a plain GET for nothing. On 2 September the
     * account burned 70% → 95% of its allowance in 83 minutes, and the reason a fix on the growth
     * scraper did not stop it is that this repo has THREE Firecrawl clients: growth's, landing's,
     * and this one. All three now ask the cheap question first.
     *
     * What we are hunting for here is an email address in the page text, so the test is simply
     * whether the free read produced any. If it did, the renderer has nothing to add.
     */
    const free = await plainRead(url);
    if (free.trim() && emailsInText(free).length > 0) {
      pages += 1;
      for (const e of emailsInText(free)) {
        if (!found.includes(e)) found.push(e);
      }
      phone = phone ?? phonesInText(free);
      if (found.length) break;
      continue;
    }

    console.log(JSON.stringify({ evt: "firecrawl.escalated", app: "kernel", url }));
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
