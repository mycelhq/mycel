import { test } from "node:test";
import assert from "node:assert/strict";
import {
  emailsInText,
  firecrawlConfigured,
  firecrawlPerson,
  publicHttpsUrl,
  urlsToCrawl,
  FIRECRAWL_KEY_ENV,
} from "../src/gtm/firecrawl";

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

test("an empty Firecrawl hop is a miss, not a successful enrich", async () => {
  const prev = process.env[FIRECRAWL_KEY_ENV];
  delete process.env[FIRECRAWL_KEY_ENV];
  try {
    assert.equal(firecrawlConfigured(), false);
    const r = await firecrawlPerson({ company_domain: "acme.com" });
    assert.equal(r.ok, false);
    assert.match(r.reason!, /FIRECRAWL_API_KEY/);
  } finally {
    if (prev === undefined) delete process.env[FIRECRAWL_KEY_ENV];
    else process.env[FIRECRAWL_KEY_ENV] = prev;
  }
});
