// The paid door was a sales form, so for a stranger it was not a door.
//
// `enrich.ts` makes the case for FullEnrich and it stands: it is a waterfall of fifteen vendors
// behind one call, which is what makes the provenance screen a real sequence of hops. It is also a
// quote-shaped onboarding, and it was the ONLY paid resolver here — so "find an email address"
// ended at a form for anybody cloning this repo. Hunter has a free tier and a key on the dashboard.
//
// What these pin: the vendor's verdict survives intact, a spent search that found nobody is not
// reported as an error, and a key that rides in the query string never reaches a log line.
import { test } from "node:test";
import assert from "node:assert/strict";
import { hunterFind, hunterName, HUNTER_KEY_ENV } from "../src/gtm/hunter";
import { enrichmentConfigured, paidVendor } from "../src/gtm/enrich";
import { PROVIDERS } from "../src/gtm/providers";

const ENRICH_ENVS = [...PROVIDERS.enrich, ...PROVIDERS.crawl].map((o) => o.env);

async function withEnv(set: Record<string, string>, fn: () => Promise<void> | void): Promise<void> {
  const keys = [...ENRICH_ENVS, "MYCEL_ENRICH_PROVIDER"];
  const prev = keys.map((e) => [e, process.env[e]] as const);
  for (const e of keys) delete process.env[e];
  Object.assign(process.env, set);
  try {
    await fn();
  } finally {
    for (const [e, was] of prev) {
      if (was === undefined) delete process.env[e];
      else process.env[e] = was;
    }
  }
}

async function withFetch(
  handler: (url: string) => { status: number; body: unknown },
  fn: (calls: string[]) => Promise<void>,
): Promise<void> {
  const real = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const { status, body } = handler(url);
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

test("hunter: a name splits into the first and last Hunter matches on", () => {
  assert.deepEqual(hunterName("Ada Lovelace"), { first_name: "Ada", last_name: "Lovelace" });
  assert.deepEqual(hunterName("Ada King Lovelace"), { first_name: "Ada", last_name: "Lovelace" });
  // One word is a company or a handle, not a person, and Hunter matches on a person.
  assert.deepEqual(hunterName("Ada"), {});
  assert.deepEqual(hunterName(undefined), {});
});

test("hunter: the verdict is the vendor's, kept verbatim", async () => {
  await withEnv({ [HUNTER_KEY_ENV]: "k" }, async () => {
    await withFetch(
      () => ({ status: 200, body: { data: { email: "Ada@Acme.com", score: 92, verification: { status: "accept_all" } } } }),
      async () => {
        const got = await hunterFind({ name: "Ada Lovelace", company_domain: "acme.com" });
        assert.equal(got.email, "ada@acme.com");
        assert.equal(got.score, 92);
        assert.equal(
          got.status,
          "ACCEPT_ALL",
          "an accept-all domain says yes to every address — flattening it to valid hands the sender a bounce it was warned about",
        );
      },
    );
  });
});

test("hunter: a 200 with no address is a spent search, not an error", async () => {
  await withEnv({ [HUNTER_KEY_ENV]: "k" }, async () => {
    await withFetch(
      () => ({ status: 200, body: { data: { email: null, score: null }, meta: {} } }),
      async () => {
        const got = await hunterFind({ name: "Ada Lovelace", company_domain: "acme.com" });
        assert.equal(got.email, undefined);
        assert.match(got.detail!, /no address on file/, "'not found' must never read as 'no such person'");
      },
    );
  });
});

test("hunter: a refusal carries Hunter's own sentence, and never the key", async () => {
  await withEnv({ [HUNTER_KEY_ENV]: "secret-key-value" }, async () => {
    await withFetch(
      () => ({
        status: 429,
        body: { errors: [{ id: "usage_exceeded", code: 429, details: "You have reached your usage limit. secret-key-value" }] },
      }),
      async () => {
        const got = await hunterFind({ name: "Ada Lovelace", company_domain: "acme.com" });
        assert.match(got.detail!, /usage limit/, "a 401 and a 429 are different problems with different fixes");
        assert.ok(!got.detail!.includes("secret-key-value"), "the key rides in the query string — redaction is not optional");
      },
    );
  });
});

test("hunter: the key is not in the message when the transport fails either", async () => {
  await withEnv({ [HUNTER_KEY_ENV]: "secret-key-value" }, async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async () => {
      // The URL carries the key, and this is the path that quotes a URL back.
      throw new Error("connect ECONNREFUSED https://api.hunter.io/v2/email-finder?api_key=secret-key-value");
    }) as typeof fetch;
    try {
      const got = await hunterFind({ name: "Ada Lovelace", company_domain: "acme.com" });
      assert.ok(!got.detail!.includes("secret-key-value"), got.detail);
      assert.match(got.detail!, /«HUNTER_API_KEY»/);
    } finally {
      globalThis.fetch = real;
    }
  });
});

test("hunter: nothing is spent when there is nothing to look up", async () => {
  await withEnv({ [HUNTER_KEY_ENV]: "k" }, async () => {
    await withFetch(
      () => {
        throw new Error("must not have been called");
      },
      async () => {
        assert.match((await hunterFind({ company_domain: "acme.com" })).detail!, /no full name/);
        assert.match((await hunterFind({ name: "Ada Lovelace" })).detail!, /no company domain or name/);
      },
    );
  });
});

test("hunter: with no key the call does not leave the building", async () => {
  await withEnv({}, async () => {
    await withFetch(
      () => {
        throw new Error("must not have been called");
      },
      async () => {
        const got = await hunterFind({ name: "Ada Lovelace", company_domain: "acme.com" });
        assert.match(got.detail!, /HUNTER_API_KEY/);
      },
    );
  });
});

// ── The paid hop is a capability, not a vendor ──────────────────────────────

test("either paid key turns the waterfall on, and the resolver says which ran", async () => {
  await withEnv({ HUNTER_API_KEY: "k" }, () => {
    assert.equal(paidVendor(), "hunter");
    assert.equal(enrichmentConfigured(), true, "paid enrichment exists without a FullEnrich account");
  });
  await withEnv({ FULLENRICH_API_KEY: "k" }, () => {
    assert.equal(paidVendor(), "fullenrich");
  });
  await withEnv({ FULLENRICH_API_KEY: "a", HUNTER_API_KEY: "b" }, () => {
    assert.equal(paidVendor(), "fullenrich", "first in list order, every time");
  });
  await withEnv({ FULLENRICH_API_KEY: "a", HUNTER_API_KEY: "b", MYCEL_ENRICH_PROVIDER: "hunter" }, () => {
    assert.equal(paidVendor(), "hunter", "an explicit choice beats list order");
  });
  await withEnv({}, () => {
    assert.equal(paidVendor(), undefined);
    assert.equal(enrichmentConfigured(), false, "no paid key and no crawl key is the only 'not configured'");
  });
});
