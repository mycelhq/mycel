// PICK ONE PROVIDER AND IT WORKS.
//
// ═══ WHY THIS EXISTS ═══
//
// The GTM path reached four vendors by name, each hardcoded in the file that used it: Azure Maps
// for places, Serper for web search, Firecrawl for crawling, FullEnrich for contact data. Those are
// OUR choices and they are good ones for us — they are the cheapest way to run this at the volume
// we run it. They are a terrible first experience for anybody else.
//
// A stranger who clones this repo to try it has to open accounts with three vendors they have never
// heard of, in a specific combination, before the go-to-market half of the product does anything.
// None of that is written down in one place, because each key was read by whichever module happened
// to need it.
//
// ═══ THE RULE: WHICHEVER KEY YOU SET IS THE PROVIDER YOU GET ═══
//
// No provider variable to set, no matrix to read. Put `BRAVE_API_KEY` in `.env` and web search runs
// on Brave. Put `SERPER_API_KEY` in instead and it runs on Serper. Set both and the first in the
// list wins, which is a deterministic answer rather than a surprising one — and
// `MYCEL_<CAP>_PROVIDER` overrides it when somebody wants the other.
//
// That inversion is the whole point. Configuration that asks "which provider?" AND "what is its
// key?" makes you answer the same question twice, and gets the second answer wrong in a way that
// fails at runtime rather than at boot.
//
// ═══ AND NOTHING HERE IS REQUIRED ═══
//
// Every capability below degrades to `none`, and `none` is a real answer that the availability
// endpoint reports in plain words. Finding people, inviting them, messaging and spotting replies
// all run on a connected LinkedIn account and need no key at all. These providers make the top of
// the funnel wider; they are not the floor.

export type Capability = "search" | "places" | "crawl" | "enrich";

export interface ProviderOption {
  /** Stable id, used by `MYCEL_<CAP>_PROVIDER` and reported to the UI. */
  id: string;
  /** The one environment variable that turns it on. */
  env: string;
  label: string;
  /** Where to get the key, so the answer to "now what" is in the same place as the question. */
  signup: string;
  /**
   * IS THERE CODE BEHIND IT.
   *
   * The first version of this file listed nine providers and four had an implementation. A user who
   * read the availability endpoint, saw "set BRAVE_API_KEY to turn on search" and did it got a
   * capability that resolved to Brave and a code path that could only call Serper — a promise the
   * repo cannot keep, which is worse than the hardcoded vendor it replaced.
   *
   * So `resolveProvider` will not CHOOSE an unimplemented option, and the availability endpoint
   * lists it as planned rather than as a way to turn something on. Adding one here without an
   * implementation is the one change to this file that makes it lie.
   */
  implemented: boolean;
  /**
   * CAN A STRANGER HAVE THIS KEY IN TWO MINUTES, ALONE, FOR NOTHING.
   *
   * List order answers "which one wins when two keys are set", and it answers it with the better
   * product. It was ALSO being used to answer "which one do we tell a newcomer to get", and those
   * are different questions: a cold boot told people to go and sign up for FullEnrich — a sales
   * conversation — when Hunter issues a free key off its dashboard.
   *
   * True means self-serve, no sales call, no cloud subscription, no billing account, and a free
   * tier big enough to see it work. Google Places and Azure Maps are both FALSE: self-serve, but
   * behind a cloud project with billing attached, which is not two minutes.
   *
   * Only `shortestPath` reads this. It changes what is SUGGESTED and never what is CHOSEN.
   */
  instantKey: boolean;
}

/**
 * List order decides WHICH ONE WINS when more than one key is set. Nothing else.
 *
 * It is not the first-run recommendation — `instantKey` and `shortestPath` are, because the best
 * provider to fall back on and the easiest one to acquire are different questions and conflating
 * them sent newcomers to a contact form. Where the two agree, they agree: Google Places is listed
 * above Azure Maps even though we run Azure, because at equal quality the shorter setup should win
 * a tie, and our own cost optimisation is not a reason for anybody else's default.
 */
export const PROVIDERS: Record<Capability, ProviderOption[]> = {
  search: [
    { id: "serper", env: "SERPER_API_KEY", label: "Serper", signup: "https://serper.dev", implemented: true, instantKey: true },
    { id: "brave", env: "BRAVE_API_KEY", label: "Brave Search", signup: "https://brave.com/search/api", implemented: true, instantKey: true },
    { id: "tavily", env: "TAVILY_API_KEY", label: "Tavily", signup: "https://tavily.com", implemented: true, instantKey: true },
  ],
  places: [
    { id: "google", env: "GOOGLE_PLACES_API_KEY", label: "Google Places", signup: "https://developers.google.com/maps", implemented: true, instantKey: false },
    { id: "azure", env: "AZURE_MAPS_KEY", label: "Azure Maps", signup: "https://azure.microsoft.com/products/azure-maps", implemented: true, instantKey: false },
  ],
  crawl: [
    { id: "firecrawl", env: "FIRECRAWL_API_KEY", label: "Firecrawl", signup: "https://firecrawl.dev", implemented: true, instantKey: true },
    { id: "jina", env: "JINA_API_KEY", label: "Jina Reader", signup: "https://jina.ai/reader", implemented: true, instantKey: true },
  ],
  enrich: [
    { id: "fullenrich", env: "FULLENRICH_API_KEY", label: "FullEnrich", signup: "https://fullenrich.com", implemented: true, instantKey: false },
    { id: "hunter", env: "HUNTER_API_KEY", label: "Hunter", signup: "https://hunter.io", implemented: true, instantKey: true },
  ],
};

/** `MYCEL_SEARCH_PROVIDER`, `MYCEL_PLACES_PROVIDER`, and so on. */
export const overrideEnv = (cap: Capability): string => `MYCEL_${cap.toUpperCase()}_PROVIDER`;

export interface Resolved {
  capability: Capability;
  /** The provider in use, or null when no key for this capability is set. */
  chosen: ProviderOption | null;
  /** Every option, so a UI can list what would turn it on without hardcoding the list twice. */
  options: ProviderOption[];
  /** Set when `MYCEL_<CAP>_PROVIDER` names a provider whose key is missing. */
  problem: string | null;
}

const has = (env: Record<string, string | undefined>, name: string): boolean => Boolean((env[name] ?? "").trim());

/**
 * Which provider is actually in play for this capability.
 *
 * `env` is injected rather than read, because a resolver that reads `process.env` directly is one
 * no test can pin and one that answers differently inside a request than it did at boot.
 *
 * AN EXPLICIT OVERRIDE NAMING AN UNKEYED PROVIDER IS AN ERROR, NOT A FALLBACK. Silently using a
 * different vendor than the operator asked for is how a bill turns up from a company they thought
 * they had switched away from, so it resolves to nothing and says why.
 *
 * `registry` IS A TEST SEAM and production never passes it. The rules about unimplemented options
 * can only be exercised while an unimplemented option happens to exist, so as providers got built
 * those guards went quietly vacuous — a test that passes because it has nothing left to check is
 * the failure mode this repo keeps finding. A synthetic registry keeps them meaningful at zero.
 */
export function resolveProvider(
  cap: Capability,
  env: Record<string, string | undefined> = process.env,
  registry: Record<Capability, ProviderOption[]> = PROVIDERS,
): Resolved {
  const options = registry[cap];
  const want = (env[overrideEnv(cap)] ?? "").trim().toLowerCase();

  if (want) {
    const asked = options.find((o) => o.id === want);
    if (!asked) {
      return { capability: cap, chosen: null, options, problem: `${overrideEnv(cap)}=${want} is not one of: ${options.map((o) => o.id).join(", ")}` };
    }
    if (!asked.implemented) {
      return { capability: cap, chosen: null, options, problem: `${overrideEnv(cap)}=${want} is not implemented yet` };
    }
    if (!has(env, asked.env)) {
      return { capability: cap, chosen: null, options, problem: `${overrideEnv(cap)}=${want} but ${asked.env} is not set` };
    }
    return { capability: cap, chosen: asked, options, problem: null };
  }

  // No override: whichever key is present wins, first in list order so the answer is stable.
  // Only an option with code behind it can be chosen — see `implemented`.
  return { capability: cap, chosen: options.find((o) => o.implemented && has(env, o.env)) ?? null, options, problem: null };
}

/** Every capability at once, for the availability endpoint and for `setup.sh` to print. */
export function resolveAll(env: Record<string, string | undefined> = process.env): Resolved[] {
  return (Object.keys(PROVIDERS) as Capability[]).map((c) => resolveProvider(c, env));
}

/**
 * One line a human can act on.
 *
 * Names the shortest path rather than all of them: a stranger asking "why is this off" wants one
 * instruction, and a list of four vendors reads as four things to do.
 */
export function howToEnable(r: Resolved): string {
  if (r.chosen) return `On, using ${r.chosen.label}.`;
  if (r.problem) return r.problem;
  const live = r.options.filter((o) => o.implemented);
  const first = shortestPath(r.options)!;
  const others = live.filter((o) => o.id !== first.id).map((o) => o.label).join(" or ");
  return `Off. Set ${first.env} (${first.signup}) to turn it on${others ? `, or use ${others}` : ""}.`;
}

/**
 * The option to NAME when telling somebody how to turn a capability on.
 *
 * An instant-key provider if there is one, else the first with an implementation. This is the only
 * place the two jobs list order was doing come apart: resolution takes the first keyed option
 * because that is the better product, and a suggestion takes the one somebody can actually act on
 * before they lose interest. Told to get a FullEnrich key, a person evaluating this on a Sunday
 * finds a contact form.
 */
export function shortestPath(options: ProviderOption[]): ProviderOption | undefined {
  const live = options.filter((o) => o.implemented);
  return live.find((o) => o.instantKey) ?? live[0];
}
