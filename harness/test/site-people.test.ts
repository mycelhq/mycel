// Contacts read off a business's own website, instead of bought per lead.
//
// A service business publishes its address on its contact page because it wants to be contacted.
// For this ICP — local trades, small firms, agencies — a waterfall vendor is largely a wrapper
// around that same public HTML. Measured on a live sweep: six law firms in, four reachable contacts
// out, eight seconds, no credits.

import { test } from "node:test";
import assert from "node:assert/strict";
import { contactsForSite, writeSiteContacts } from "../src/gtm/site-people";

const html = (body: string) => ({ ok: true, status: 200, text: body });

test("a mailto on the homepage is enough — the contact page is never fetched", async () => {
  // Fetching every candidate page regardless would triple the request count for no extra contact on
  // the common case, against a shared egress IP.
  const seen: string[] = [];
  const g = globalThis as { fetch: unknown };
  const real = g.fetch;
  g.fetch = async (url: string) => {
    seen.push(String(url));
    return new Response('<a href="mailto:hello@acme.com">Email us</a>', {
      status: 200,
      headers: { "content-type": "text/html" },
    });
  };
  try {
    const got = await contactsForSite("acme.com", "Acme");
    assert.equal(got.length, 1);
    assert.equal(got[0]!.email, "hello@acme.com");
    assert.equal(seen.length, 1, `fetched ${seen.length} pages when the first one answered`);
  } finally {
    g.fetch = real;
  }
});

test("a business with only a phone is still filed — it is still a way in", async () => {
  const g = globalThis as { fetch: unknown };
  const real = g.fetch;
  g.fetch = async () =>
    new Response('<a href="tel:+13105551234">Call</a>', { status: 200, headers: { "content-type": "text/html" } });
  try {
    const got = await contactsForSite("acme.com", "Acme");
    assert.equal(got.length, 1);
    assert.equal(got[0]!.email, undefined);
    assert.ok(got[0]!.phone, "a phone-only business was dropped");
  } finally {
    g.fetch = real;
  }
});

test("a domain that is not a domain never becomes a request", async () => {
  for (const bad of ["", "   ", "localhost", "not a domain"]) {
    assert.deepEqual(await contactsForSite(bad, "X"), [], `${JSON.stringify(bad)} was fetched`);
  }
});

test("contacts are keyed so one business is one row, however often it is swept", async () => {
  const rows: Array<Record<string, unknown>> = [];
  const domain = { upsertRecord: async (r: Record<string, unknown>) => void rows.push(r) };
  const contacts = [
    { company: "Acme", company_domain: "acme.com", email: "Hello@Acme.com", source_url: "https://acme.com/" },
    { company: "Beta", company_domain: "beta.com", phone: "3105551234", source_url: "https://beta.com/" },
    {
      company: "Gamma",
      company_domain: "gamma.com",
      linkedin_url: "https://www.linkedin.com/in/jane-doe",
      source_url: "https://gamma.com/",
    },
  ];
  const n = await writeSiteContacts(domain, { project_id: "p1" }, "w", "people", contacts);
  assert.equal(n, 3);
  assert.deepEqual(rows.map((r) => r.key), ["email:hello@acme.com", "site:beta.com", "jane-doe"]);
  // The LinkedIn slug wins when the site published one, so a person found twice — once on their own
  // site and once on LinkedIn — is not two people in the founder's pipeline.
});

test("a site contact does not claim to have come from LinkedIn", async () => {
  // `personRecord` hardcodes `source: "linkedin"`. Filing these through it would label every one of
  // them a LinkedIn find and drop the address, which is the only thing that makes them contactable.
  const rows: Array<Record<string, unknown>> = [];
  const domain = { upsertRecord: async (r: Record<string, unknown>) => void rows.push(r) };
  await writeSiteContacts(
    domain,
    { project_id: "p1" },
    "w",
    "people",
    [{ company: "Acme", company_domain: "acme.com", email: "a@acme.com", source_url: "https://acme.com/contact" }],
  );
  const data = rows[0]!.data as Record<string, unknown>;
  assert.equal(data.source, "website");
  assert.equal(data.email, "a@acme.com", "the sequencer reads data.email — without it this person is unreachable");
  assert.equal(data.source_url, "https://acme.com/contact");
});

test("no project means no write — an unscoped row is invisible to every tenant", async () => {
  let called = 0;
  const domain = { upsertRecord: async () => void called++ };
  assert.equal(await writeSiteContacts(domain, {}, "w", "people", [
    { company: "A", company_domain: "a.com", email: "a@a.com", source_url: "https://a.com/" },
  ]), 0);
  assert.equal(called, 0);
});
