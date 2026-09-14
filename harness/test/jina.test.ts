// The free half of enrichment stopped requiring a paid account.
//
// `firecrawl.ts` describes the hop: read a company's public pages, keep only addresses literally on
// them. It is the one that runs when the paid waterfall is unfunded — and until Jina Reader it was
// reachable only through a Firecrawl account, so "the free half" needed a signup and a card.
//
// These tests pin the two things that could quietly go wrong once there are two vendors: the wrong
// one running, and the provenance hop naming a vendor that did not.
import { test } from "node:test";
import assert from "node:assert/strict";
import { jinaScrape, JINA_KEY_ENV } from "../src/gtm/jina";
import { crawlConfigured, crawlKeyEnv, crawlVendor, firecrawlPerson } from "../src/gtm/firecrawl";
import { PROVIDERS } from "../src/gtm/providers";

const CRAWL_ENVS = PROVIDERS.crawl.map((o) => o.env);

/** Run `fn` with exactly these crawl keys set and every other one cleared. */
async function withCrawlEnv(set: Record<string, string>, fn: () => Promise<void> | void): Promise<void> {
  const prev = CRAWL_ENVS.map((e) => [e, process.env[e]] as const);
  const prevOverride = process.env.MYCEL_CRAWL_PROVIDER;
  for (const e of CRAWL_ENVS) delete process.env[e];
  delete process.env.MYCEL_CRAWL_PROVIDER;
  Object.assign(process.env, set);
  try {
    await fn();
  } finally {
    for (const [e, was] of prev) {
      if (was === undefined) delete process.env[e];
      else process.env[e] = was;
    }
    if (prevOverride === undefined) delete process.env.MYCEL_CRAWL_PROVIDER;
    else process.env.MYCEL_CRAWL_PROVIDER = prevOverride;
  }
}

/** Swap global fetch, recording what was asked for. */
async function withFetch(
  handler: (url: string, init?: RequestInit) => { status: number; body: unknown },
  fn: (calls: Array<{ url: string; init?: RequestInit }>) => Promise<void>,
): Promise<void> {
  const real = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const { status, body } = handler(url, init);
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = real;
  }
}

test("jina: the target URL is the path, and the key travels as a bearer", async () => {
  await withCrawlEnv({ [JINA_KEY_ENV]: "jina_secret" }, async () => {
    await withFetch(
      () => ({ status: 200, body: { code: 200, data: { url: "https://acme.com/", title: "Acme", content: "Write to hello@acme.com" } } }),
      async (calls) => {
        const got = await jinaScrape("https://acme.com/contact");
        assert.equal(got.markdown, "Write to hello@acme.com");
        assert.equal(got.credits, undefined, "Jina bills tokens — a 0 here would under-report real money");
        assert.equal(calls.length, 1);
        assert.equal(calls[0]!.url, "https://r.jina.ai/https://acme.com/contact");
        const headers = calls[0]!.init?.headers as Record<string, string>;
        assert.equal(headers.authorization, "Bearer jina_secret");
        assert.equal(headers.accept, "application/json", "the text form cannot tell a silent page from an error");
      },
    );
  });
});

test("jina: a refusal carries the provider's own sentence and never the key", async () => {
  await withCrawlEnv({ [JINA_KEY_ENV]: "jina_secret" }, async () => {
    await withFetch(
      () => ({ status: 451, body: { code: 451, status: 45101, message: "target URL is blocked: jina_secret" } }),
      async () => {
        const got = await jinaScrape("https://acme.com/");
        assert.equal(got.markdown, "");
        assert.match(got.detail!, /target URL is blocked/, "'jina 451' sends somebody hunting the wrong bug");
        assert.ok(!got.detail!.includes("jina_secret"), "a key must never reach a log line");
      },
    );
  });
});

test("jina: a page we would not fetch ourselves is not laundered through a provider", async () => {
  // A crawl vendor is a request-forwarder. Handing it an internal address just moves the fetch one
  // hop away from the SSRF check instead of past it.
  await withCrawlEnv({ [JINA_KEY_ENV]: "k" }, async () => {
    await withFetch(
      () => {
        throw new Error("must not have been reached");
      },
      async () => {
        assert.equal((await jinaScrape("https://169.254.169.254/latest")).markdown, "");
        assert.equal((await jinaScrape("http://acme.com")).markdown, "");
        assert.match((await jinaScrape("https://127.0.0.1/")).detail!, /not a public https page/);
      },
    );
  });
});

// ── The capability is the question, not the vendor ──────────────────────────

test("either key turns crawling on, and names the vendor in play", async () => {
  await withCrawlEnv({ JINA_API_KEY: "k" }, () => {
    assert.equal(crawlConfigured(), true);
    assert.equal(crawlVendor(), "jina");
    assert.equal(crawlKeyEnv(), "JINA_API_KEY", "a message about a live capability names the key in play");
  });
  await withCrawlEnv({ FIRECRAWL_API_KEY: "k" }, () => {
    assert.equal(crawlVendor(), "firecrawl");
    assert.equal(crawlKeyEnv(), "FIRECRAWL_API_KEY");
  });
  await withCrawlEnv({}, () => {
    assert.equal(crawlConfigured(), false);
    assert.equal(crawlVendor(), undefined);
    assert.equal(crawlKeyEnv(), "FIRECRAWL_API_KEY", "off names the shortest path to on");
  });
});

test("the crawl hop calls the provider that is keyed, not the one it is named after", async () => {
  await withCrawlEnv({ JINA_API_KEY: "k" }, async () => {
    await withFetch(
      (url) => {
        assert.ok(!url.includes("api.firecrawl.dev"), "Firecrawl is unkeyed here and must not be called");
        // The free plain GET runs first and finds nothing, so the rendered read escalates to Jina.
        if (url.startsWith("https://r.jina.ai/")) {
          return { status: 200, body: { data: { content: "reach us at owner@acme.com" } } };
        }
        return { status: 200, body: "<html><body>no address here at all</body></html>" };
      },
      async () => {
        const hop = await firecrawlPerson({ company_domain: "acme.com" });
        assert.equal(hop.ok, true);
        assert.equal(hop.email, "owner@acme.com");
        assert.equal(hop.by, "jina", "the provenance hop must name the vendor that actually ran");
        assert.equal(hop.credits, undefined, "an unmetered vendor reports no credits, not zero credits");
      },
    );
  });
});

test("a Firecrawl hop still reports its credits and still says firecrawl", async () => {
  await withCrawlEnv({ FIRECRAWL_API_KEY: "k" }, async () => {
    await withFetch(
      (url) => {
        if (url.includes("api.firecrawl.dev")) {
          return { status: 200, body: { success: true, data: { markdown: "mail owner@acme.com", metadata: { creditsUsed: 2 } } } };
        }
        return { status: 200, body: "<html><body>nothing</body></html>" };
      },
      async () => {
        const hop = await firecrawlPerson({ company_domain: "acme.com" });
        assert.equal(hop.by, "firecrawl");
        assert.equal(hop.credits, 2, "a vendor that reports cost must still have it recorded");
      },
    );
  });
});
