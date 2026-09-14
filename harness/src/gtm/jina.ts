// Jina Reader — the other way to turn a company page into text.
//
// ═══ WHY A SECOND CRAWL PROVIDER ═══
//
// `firecrawl.ts` describes the hop: read a company's public pages and keep only email addresses
// that are literally ON them. That hop is the one that runs when the paid waterfall is unfunded, so
// it is the free half of enrichment — and it was reachable only through a Firecrawl account. For
// anybody cloning this repo, "the free half" needed a signup and a credit card on file.
//
// Jina Reader is a GET. `https://r.jina.ai/<url>` returns the page as markdown. There is no job to
// submit, no credits ledger, and a free key is issued on the spot with 10M tokens on it.
//
// ═══ IT IS DELIBERATELY NOT ON BY DEFAULT ═══
//
// Reader answers WITHOUT a key at 20 requests/minute, so this could have been the one capability
// that works on a fresh clone with no configuration at all. It is key-gated anyway. Crawling sends
// a prospect's URL to a third party, and a default that does that silently picks a vendor on the
// operator's behalf and starts a data flow they never agreed to. `providers.ts` exists to make that
// choice explicit and one variable wide; making an exception here would undo it.
//
// ═══ TOKENS, NOT CREDITS — SO THE COST IS ABSENT, NOT ZERO ═══
//
// Jina bills tokens and does not report a per-request cost. `enrich.ts` argues this at length: a
// `cost_usd: 0` for an unpriced plan under-reports real money and destroys the meaning of Voyager's
// zero, which is the one genuine free in this product. So this returns no credit count at all and
// the provenance hop omits the field.

import { fetchWithDeadline } from "../http";
import { publicHttpsUrl } from "./firecrawl";

export const JINA_KEY_ENV = "JINA_API_KEY";

// There is deliberately no `JINA_RESOLVER` constant. The name that reaches a provenance hop is the
// provider `id` in `providers.ts`, and a second declaration of the same literal is a second place
// for it to drift. `FIRECRAWL_RESOLVER` still exists only because hops written before this carry it.

const base = (): string => (process.env.JINA_BASE_URL ?? "https://r.jina.ai").replace(/\/$/, "");

const redact = (s: string, key: string): string => (key ? s.split(key).join("«JINA_API_KEY»") : s);

/**
 * One page, as markdown.
 *
 * Returns the same shape Firecrawl's `scrape` does so the caller does not branch, except that
 * `credits` is absent rather than 0 — see the header.
 *
 * `Accept: application/json` rather than the plain-text default, because the text form gives no way
 * to tell a page that genuinely said nothing from an error rendered as prose. The JSON carries the
 * content under `data.content`, and anything else is a refusal we can name.
 */
export async function jinaScrape(url: string): Promise<{ markdown: string; credits?: number; detail?: string }> {
  // The same SSRF shapes the free read enforces. A crawl provider is a request-forwarder, so
  // handing it a URL we would not fetch ourselves just moves the fetch one hop away.
  const safe = publicHttpsUrl(url);
  if (!safe) return { markdown: "", detail: "not a public https page" };

  const key = (process.env[JINA_KEY_ENV] ?? "").trim();
  try {
    /**
     * Deadlined for the reason firecrawl.ts gives: the response time is a function of a STRANGER'S
     * server, because the provider has to load somebody else's page before it can answer. Same 60s.
     */
    const r = await fetchWithDeadline(
      `${base()}/${safe}`,
      {
        headers: {
          accept: "application/json",
          ...(key ? { authorization: `Bearer ${key}` } : {}),
          // Ask for the article and not the chrome. We are hunting for a literal address in the
          // page text, and a nav bar repeated on every page is noise in every one of them.
          "x-retain-images": "none",
        },
      },
      { deadlineMs: 60_000, redact: (m) => redact(m, key) },
    );
    if (r.status === 0) return { markdown: "", detail: `jina ${r.detail ?? "unreachable"}` };

    const body = (r.json ?? {}) as { data?: { content?: unknown }; message?: unknown; code?: unknown };
    if (!r.ok) {
      const said = typeof body.message === "string" ? body.message : `jina ${r.status}`;
      return { markdown: "", detail: redact(said, key) };
    }
    const content = typeof body.data?.content === "string" ? body.data.content : "";
    return { markdown: content };
  } catch (e) {
    return { markdown: "", detail: redact((e as Error).message ?? "jina failed", key) };
  }
}
