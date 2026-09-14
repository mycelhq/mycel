// Finding businesses for about a twentieth of a penny each, before anything expensive runs.
//
// ═══ WHY THIS EXISTS: THE ONLY DOOR WAS THE COSTLY ONE ═══
//
// GTM discovery ran on FullEnrich alone. FullEnrich is an email waterfall — it is very good at
// turning a known person into a reachable one, and it charges credits per contact for the privilege.
// Using it to FIND people is paying waterfall prices for a search, and it shaped the product around
// what it can see: LinkedIn-shaped individuals at companies large enough to have LinkedIn-shaped
// individuals.
//
// The founder-side system in `growth/` never worked that way. It sweeps Google's organic index with
// dorks at $0.0005 a query, keeps what looks like a real business, and only then spends anything on
// reaching a person. That is the right order and it was not in the product.
//
// ═══ WHAT THIS FINDS THAT THE OTHER DOOR CANNOT ═══
//
// COMPANIES, not just people. The studio this was built for sells to independent cafes and bakeries.
// The owner of a Bristol bakery is very often not on LinkedIn at all, and a discovery step that can
// only return LinkedIn profiles reports that market as empty — which is not the same as it being
// empty, and is a far worse answer.
//
// A company with a website is reachable: the sequence already supports a cross-channel `send_email`
// step (see sequence.ts), so a lead with a domain and no LinkedIn is actionable today.
//
// ═══ THE WATERFALL, AND WHY THE ORDER IS THE WHOLE POINT ═══
//
//   1. HERE. Dork the index. Cheap, wide, returns businesses. Spend: a fraction of a penny.
//   2. LinkedIn lookup, when a name is wanted for a company worth pursuing. Still cheap.
//   3. FullEnrich, LAST, and only for a contact somebody has decided to reach.
//
// Azure Maps (the hop that carries a free phone) is `@mycel/sourcing` — the same client growth
// harvests with. The kernel join is `discover-maps.ts`. Do not copy harvest into the kernel.
//
// Reversing that — enriching first to see who is out there — is how a discovery budget disappears
// into people nobody was ever going to message.
//
// Response shape mirrors `growth/lib/sourcing/serper.ts` rather than being re-derived from the docs:
// that code is in production against this API, and re-deriving a shape somebody has already proven
// is how `XERO_GET_INVOICES` got into the capability table.

import { resolveProvider } from "./providers";

/** Serper's organic block. Only the fields we read — the payload carries a great deal more. */
interface SerperOrganic {
  title?: string;
  link?: string;
  snippet?: string;
}

/**
 * One provider's answer, in the one shape the rest of this file reads.
 *
 * Brave nests under `web.results` and calls the fields `url` and `description`; Tavily returns a
 * flat `results` with `url` and `content`; Serper returns a flat `organic` with `link` and
 * `snippet`. Normalising here rather than at the twenty call sites below is what keeps adding a
 * provider to a single function.
 */
export function parseOrganic(provider: string, text: string): SerperOrganic[] {
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    if (provider === "brave") {
      const results = ((j.web as { results?: unknown[] } | undefined)?.results ?? []) as Array<Record<string, unknown>>;
      return results.map((r) => ({
        title: typeof r.title === "string" ? r.title : undefined,
        link: typeof r.url === "string" ? r.url : undefined,
        snippet: typeof r.description === "string" ? r.description : undefined,
      }));
    }
    if (provider === "tavily") {
      const results = (j.results ?? []) as Array<Record<string, unknown>>;
      return results.map((r) => ({
        title: typeof r.title === "string" ? r.title : undefined,
        link: typeof r.url === "string" ? r.url : undefined,
        snippet: typeof r.content === "string" ? r.content : undefined,
      }));
    }
    return (j.organic as SerperOrganic[] | undefined) ?? [];
  } catch {
    // A body that is not JSON is not a result set. The caller already counts and reports failures.
    return [];
  }
}

/** A business found by sweeping the index. Not yet a person, and often never one. */
export interface FoundBusiness {
  /** Company name, cleaned of the SEO tail Google shows in a title. */
  name: string;
  /** Bare host, no `www.`. The dedupe key and, later, the thing an email is guessed against. */
  domain: string;
  url: string;
  /** Google's snippet. The only free evidence of what they actually do — kept for the opener. */
  about?: string;
  /** Which dork found them, so a founder can see why this business is on their list. */
  via?: string;
}

/**
 * Aggregators, directories and marketplaces.
 *
 * A dork for "independent bakery Bristol" returns TripAdvisor before it returns a bakery, and every
 * one of those is a business that cannot be sold to. `growth/`'s list plus the local-search
 * directories its dorks never hit, because this one runs on trade queries rather than agency ones.
 */
const DIRECTORIES =
  /(^|\.)(clutch\.co|upwork\.com|fiverr\.com|linkedin\.com|yelp\.com|glassdoor\.com|indeed\.com|g2\.com|tripadvisor\.[a-z.]+|facebook\.com|instagram\.com|twitter\.com|x\.com|youtube\.com|pinterest\.[a-z.]+|reddit\.com|wikipedia\.org|yell\.com|thomsonlocal\.com|checkatrade\.com|trustpilot\.com|opentable\.[a-z.]+|deliveroo\.[a-z.]+|ubereats\.com|justeat\.[a-z.]+|booking\.com|eventbrite\.[a-z.]+|medium\.com|substack\.com|blogspot\.com|wordpress\.com|amazon\.[a-z.]+|ebay\.[a-z.]+|gov\.uk|companieshouse\.gov\.uk|quora\.com|justanswer\.com|stackexchange\.com|stackoverflow\.com|answers\.com|nextdoor\.com|lawinfo\.com|avvo\.com|justia\.com|findlaw\.com|nolo\.com|lawyers\.com|martindale\.com|superlawyers\.com|expertise\.com|thumbtack\.com|angi\.com|angieslist\.com|homeadvisor\.com|bark\.com|houzz\.[a-z.]+|bbb\.org|manta\.com|crunchbase\.com|zocdoc\.com|healthgrades\.com|realtor\.com|zillow\.com|trulia\.com|apartments\.com|goodfirms\.co|designrush\.com|sortlist\.[a-z.]+|semrush\.com|similarweb\.com|producthunt\.com|glassdoor\.[a-z.]+|ziprecruiter\.com|monster\.com|simplyhired\.com)$/i;

const host = (url: string): string | null => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
};

/**
 * A page title, reduced to what a person would call the business.
 *
 * Google shows "Hart's Bakery | Artisan Sourdough in Bristol | Order Online" and the business is
 * called Hart's Bakery. Splitting on the separator and taking the first part is right nearly always,
 * and the exception — a name that genuinely contains a dash — loses nothing a human cannot read past.
 * A title with no separator is used whole rather than cut at a guessed length.
 */
export function businessName(title: string): string {
  const first = title.split(/\s+[|·—–]\s+|\s+-\s+/)[0]!.trim();
  return (first.length >= 3 ? first : title.trim()).slice(0, 120);
}

/**
 * The dorks for one audience.
 *
 * Built from what the founder already told us — the industries and the place — rather than from a
 * fixed catalogue, because `growth/`'s dorks hunt agencies and this has to hunt whatever trade the
 * founder actually sells to.
 *
 * `-jobs -careers -hiring` on every one: a recruiter's page for a bakery is not a bakery, and those
 * three words remove most of what a trade query otherwise drags in. The quoted industry keeps it on
 * businesses that describe themselves that way rather than pages that merely mention them.
 */
export function dorksFor(a: { industries?: readonly string[]; location?: string; keywords?: string }): string[] {
  const industries = (a.industries ?? []).map((s) => s.trim()).filter(Boolean).slice(0, 4);
  const where = (a.location ?? "").trim();
  const extra = (a.keywords ?? "").trim();
  if (!industries.length && !extra) return [];

  const terms = industries.length ? industries : [extra];
  const out: string[] = [];
  for (const t of terms) {
    const place = where ? ` "${where}"` : "";
    // Their own site, described in their own words.
    out.push(`"${t}"${place} ("about us" OR "our story") -jobs -careers -hiring`);
    // The page that means they are a going concern rather than a parked domain.
    out.push(`"${t}"${place} ("contact us" OR "get in touch") -jobs -careers -hiring`);
  }
  return out.slice(0, 8);
}

/** True when the cheap index sweep can run. Absent key is a named skip, not an empty market. */
/**
 * ═══ THE OPERATORS THE FREE TIER SILENTLY STOPPED ACCEPTING ═══
 *
 * Serper's free plan rejects advanced query syntax — quoted phrases, `OR` groups, `-exclusions` —
 * with HTTP 400 and `{"message":"Query pattern not allowed for free accounts."}`. Every dork this
 * file builds is made of exactly that syntax, so discovery returned nothing, every time, and the
 * founder read "nobody matched on web search".
 *
 * WHAT MADE IT HARD TO SEE: the allowance is not fixed. Measured against the live key, the same
 * quoted query answered 200 and then 400 minutes later, once some grace was used up. So this fails
 * INTERMITTENTLY at first and permanently later, and the status code alone reads like a bad request
 * we sent — which is why the original handler filed it under "not enough credits".
 *
 * The degrade: strip the operators and search again. A plain query returns ten real results where
 * the dork returned zero. It is a broader, noisier search, and a broader search is worth far more
 * than an empty one — the caller can still filter. What must never happen is silence.
 */
export function withoutOperators(q: string): string {
  return q
    .replace(/-\w+/g, " ")            // -jobs -careers -hiring
    .replace(/\bOR\b/g, " ")          // OR groups
    .replace(/[()"]/g, " ")           // quotes and grouping
    .replace(/\s+/g, " ")
    .trim();
}

/** The provider saying our syntax is above our plan, rather than anything about our request. */
export function isFreeTierPatternRefusal(status: number, body: string): boolean {
  return status === 400 && /pattern not allowed|free account/i.test(body);
}

export function serperConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  // Named for Serper by history; it answers "is web search configured at all", whichever provider.
  return resolveProvider("search", env as Record<string, string | undefined>).chosen !== null;
}

export interface CheapDiscoverInput {
  industries?: readonly string[];
  location?: string;
  keywords?: string;
  /** Stop once this many distinct businesses are found. Each dork is one paid query. */
  limit?: number;
  apiKey?: string;
  /** Injected in tests. Defaults to the real endpoint. */
  fetchImpl?: typeof fetch;
}

export interface CheapDiscoverResult {
  ok: boolean;
  businesses: FoundBusiness[];
  /** Queries actually issued — what this cost, in the unit the vendor bills. */
  queries: number;
  /** Said plainly when nothing ran, so "no key" never reads as "nobody out there". */
  detail?: string;
}

/**
 * Sweep the index for businesses matching an audience.
 *
 * NEVER THROWS, and an empty result always carries a `detail`. A discovery step that returns zero
 * businesses and says nothing is indistinguishable from a market with nobody in it — and a founder
 * who reads that once stops running the loop. The two states this must keep apart are "we searched
 * and found nobody" and "we could not search".
 */
export async function cheapDiscover(input: CheapDiscoverInput): Promise<CheapDiscoverResult> {
  /**
   * WHICHEVER SEARCH KEY IS SET. See ./providers.ts.
   *
   * This read `SERPER_API_KEY` directly, which made our own cost-optimised pick the only way a
   * stranger could run discovery at all. `input.apiKey` still wins so callers and tests can pass one
   * explicitly, and it is treated as Serper because that is what every existing caller meant.
   */
  const picked = input.apiKey ? null : resolveProvider("search");
  const key = (input.apiKey ?? (picked?.chosen ? process.env[picked.chosen.env] : "") ?? "").trim();
  const provider = input.apiKey ? "serper" : (picked?.chosen?.id ?? "");
  if (!key) {
    return { ok: false, businesses: [], queries: 0, detail: "no search key is configured, so nothing was searched" };
  }
  const dorks = dorksFor(input);
  if (!dorks.length) {
    return {
      ok: false,
      businesses: [],
      queries: 0,
      detail: "this audience names no industry or keywords, so there was nothing to search for",
    };
  }

  const doFetch = input.fetchImpl ?? fetch;
  const limit = Math.max(1, Math.min(input.limit ?? 25, 100));
  const seen = new Set<string>();
  const businesses: FoundBusiness[] = [];
  let queries = 0;
  const failures: string[] = [];
  /**
   * Why the sweep was broader than the audience asked for, if it was. Reported, never hidden.
   *
   * Two different causes, and they need different sentences. A plan refusal is something the
   * founder can fix by upgrading; a semantic provider is a property of the vendor they chose. Told
   * "your plan does not accept exclusions" when they are on Tavily, they would go looking for a
   * billing page that would not have changed anything.
   */
  let degradedWhy: "plan" | "semantic" | null = null;

  for (const q of dorks) {
    if (businesses.length >= limit) break;
    queries += 1;
    let organic: SerperOrganic[] = [];
    try {
      const ask = async (query: string) => {
        // Two shapes, one normalised result. Brave is a GET with a token header; Serper is a POST
        // with a JSON body. Everything downstream — the operator-stripping retry, the directory
        // filter, the dedupe — is provider-agnostic and stays untouched.
        const r =
          provider === "brave"
            ? await doFetch(
                `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=20`,
                { headers: { "X-Subscription-Token": key, Accept: "application/json" } },
              )
            : provider === "tavily"
              ? await doFetch("https://api.tavily.com/search", {
                  method: "POST",
                  headers: { authorization: `Bearer ${key}`, "Content-Type": "application/json" },
                  body: JSON.stringify({ query, max_results: 20, search_depth: "basic" }),
                })
              : await doFetch("https://google.serper.dev/search", {
                  method: "POST",
                  headers: { "X-API-KEY": key, "Content-Type": "application/json" },
                  body: JSON.stringify({ q: query, num: 20 }),
                });
        return { ok: r.ok, status: r.status, text: await r.text() };
      };

      /**
       * TAVILY DOES NOT SPEAK DORK, AND WOULD NOT HAVE SAID SO.
       *
       * Serper and Brave read Google syntax: `site:`, quoted phrases, `-jobs` all narrow the result
       * set. Tavily is a semantic search API — it takes the query as meaning, so an operator is not
       * refused, it is absorbed as ordinary words. `"bakery" Bristol -jobs -careers` becomes a
       * request for pages about bakeries in Bristol AND about jobs and careers: the exact opposite
       * of what the dork asked for, returned at 200 with a full result set and nothing to warn on.
       *
       * So the operators come off BEFORE the request rather than after a refusal, and `degraded` is
       * set for the same reason the retry path sets it — the founder is getting a broader sweep than
       * the audience described, and this codebase's rule is that a widened search says so.
       */
      const askable = provider === "tavily" ? withoutOperators(q) : q;
      if (askable !== q) degradedWhy = "semantic";
      let res = await ask(askable);

      /**
       * The plan refuses our syntax, not our request. Search again without it rather than returning
       * an empty market — see `withoutOperators`. Counted as a second query because it IS one: the
       * vendor bills for it and `queries` is what this cost.
       */
      if (!res.ok && isFreeTierPatternRefusal(res.status, res.text)) {
        const plain = withoutOperators(askable);
        if (plain && plain !== askable) {
          degradedWhy = "plan";
          queries += 1;
          res = await ask(plain);
        }
      }

      if (!res.ok) {
        // Carry the provider's OWN sentence. "answered 400" sent a founder looking for a bug in the
        // query we sent, when the answer was one line in the body saying the plan does not allow it.
        let why = `the search provider answered ${res.status}`;
        try {
          const m = (JSON.parse(res.text) as { message?: string }).message;
          if (m) why = `the search provider refused: ${m}`;
        } catch {
          /* not JSON — the status is all we have */
        }
        failures.push(why);
        continue;
      }
      organic = parseOrganic(provider, res.text);
    } catch (e) {
      failures.push(String((e as Error)?.message ?? e));
      continue;
    }

    for (const item of organic) {
      if (businesses.length >= limit) break;
      const link = item.link ?? "";
      const domain = link ? host(link) : null;
      if (!domain || seen.has(domain) || DIRECTORIES.test(domain)) continue;
      const name = businessName(item.title ?? domain);
      if (!name) continue;
      seen.add(domain);
      businesses.push({ name, domain, url: link, about: item.snippet?.trim() || undefined, via: q });
    }
  }

  /**
   * A broadened search that FOUND people is still a success, and the founder still has to be told:
   * a name from a widened sweep is a weaker match than the same name from an exact one. Saying so
   * is what makes the next question ("why is this plumber in my law-firm list?") answerable without
   * reading the code — and it is said on the EMPTY result too, where it explains the most.
   */
  const degradedNote =
    degradedWhy === "plan"
      ? "the search plan does not accept quoted phrases or exclusions, so the audience was searched as plain keywords — these matches are broader than the audience describes"
      : degradedWhy === "semantic"
        ? "this provider searches by meaning rather than by operators, so the audience was sent as plain keywords without the exclusions — these matches are broader than the audience describes"
        : null;

  if (!businesses.length) {
    return {
      ok: failures.length === 0,
      businesses,
      queries,
      detail: failures.length
        ? `the search could not run: ${failures[0]}`
        : [
            `searched ${queries} ${queries === 1 ? "query" : "queries"} and found no businesses that were not directories`,
            ...(degradedNote ? [degradedNote] : []),
          ].join("; "),
    };
  }
  const notes = [
    ...(degradedNote ? [degradedNote] : []),
    ...(failures.length ? [`${failures.length} of ${queries} queries failed: ${failures[0]}`] : []),
  ];
  return { ok: true, businesses, queries, ...(notes.length ? { detail: notes.join("; ") } : {}) };
}
