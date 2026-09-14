import { test } from "node:test";
import assert from "node:assert/strict";
import {
  crawlConfigured,
  emailsInText,
  firecrawlPerson,
  publicHttpsUrl,
  urlsToCrawl,
} from "../src/gtm/firecrawl";
import { PROVIDERS } from "../src/gtm/providers";

test("Firecrawl never treats an internal URL as a public company page", () => {
  assert.equal(publicHttpsUrl("https://169.254.169.254/latest"), undefined);
  assert.equal(publicHttpsUrl("https://127.0.0.1/"), undefined);
  assert.equal(publicHttpsUrl("http://acme.com"), undefined);
  assert.equal(publicHttpsUrl("https://user:pass@acme.com/"), undefined);
  assert.equal(publicHttpsUrl("https://linkedin.com/in/x"), undefined);
  assert.equal(publicHttpsUrl("https://2130706433/"), undefined);
  assert.equal(publicHttpsUrl("https://0x7f000001/"), undefined);
  assert.ok(publicHttpsUrl("https://acme.com/contact"));
  assert.ok(publicHttpsUrl("https://acme.com./contact"));
});

test("crawl targets are the company site, not LinkedIn", () => {
  assert.deepEqual(urlsToCrawl({ company_domain: "acme.com" }), ["https://acme.com/", "https://acme.com/contact"]);
  assert.deepEqual(urlsToCrawl({ company_domain: "https://www.linkedin.com/company/acme" }), []);
  assert.deepEqual(urlsToCrawl({}), []);
});

test("emails are literals on the page — never invented at a domain", () => {
  const text = "Write to hello@acme.com or privacy@acme.com. Ignore noreply@acme.com.";
  assert.deepEqual(emailsInText(text), ["hello@acme.com", "privacy@acme.com"]);
  assert.deepEqual(emailsInText("No address here, but acme.com is the domain."), []);
});

test("with no crawl provider at all, the hop is a miss and says which key turns it on", async () => {
  // Every crawl key, not just Firecrawl's: the capability is off when NO vendor is keyed, and a
  // test that cleared one of two would pass or fail depending on the machine it ran on.
  const prev = PROVIDERS.crawl.map((o) => [o.env, process.env[o.env]] as const);
  for (const [env] of prev) delete process.env[env];
  try {
    assert.equal(crawlConfigured(), false);
    const r = await firecrawlPerson({ company_domain: "acme.com" });
    assert.equal(r.ok, false);
    assert.match(r.reason!, /FIRECRAWL_API_KEY/, "names the shortest path from off to on");
    assert.equal(r.by, undefined, "nothing ran, so no vendor may be named as having run");
  } finally {
    for (const [env, was] of prev) {
      if (was === undefined) delete process.env[env];
      else process.env[env] = was;
    }
  }
});
