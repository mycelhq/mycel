import { test } from "node:test";
import assert from "node:assert/strict";
import { api, makeApp } from "./helpers";
import { getIdentityStore } from "../src/identity";

const PW = "a-long-enough-password";

test("domains: a slug is derived from the name, deduped, and never a reserved word", () => {
  const id = getIdentityStore();
  const { org } = id.createOrgWithOwner("slug-co", `slug-${Date.now()}@example.com`, PW);

  const first = id.createProject(org.id, "Hartley Bookkeeping").project;
  assert.equal(first.slug, "hartley-bookkeeping");

  // Two businesses can share a name; they cannot share a hostname.
  const second = id.createProject(org.id, "Hartley Bookkeeping").project;
  assert.equal(second.slug, "hartley-bookkeeping-2");

  // A founder claiming `app` would be handing themselves a phishing kit on our certificate.
  const reserved = id.createProject(org.id, "app").project;
  assert.notEqual(reserved.slug, "app");
  assert.match(reserved.slug!, /^app-/);

  // Names that slugify to nothing still get something hostname-safe.
  assert.match(id.createProject(org.id, "!!!").project.slug!, /^business/);
});

test("domains: a hostname resolves to exactly one business, and only one level deep", () => {
  const id = getIdentityStore();
  const { org } = id.createOrgWithOwner("host-co", `host-${Date.now()}@example.com`, PW);
  const p = id.createProject(org.id, `Acme ${Date.now()}`).project;

  assert.equal(id.projectForHost(`${p.slug}.mycelai.dev`, "mycelai.dev")?.id, p.id);
  // Port and trailing dot are part of a real Host header.
  assert.equal(id.projectForHost(`${p.slug}.mycelai.dev:443`, "mycelai.dev")?.id, p.id);
  assert.equal(id.projectForHost(`${p.slug}.MYCELAI.DEV.`, "mycelai.dev")?.id, p.id);

  // A wildcard certificate covers one label. Treating deeper names as a match would make the
  // boundary fuzzy exactly where it needs to be sharp.
  assert.equal(id.projectForHost(`evil.${p.slug}.mycelai.dev`, "mycelai.dev"), undefined);
  assert.equal(id.projectForHost("nobody.mycelai.dev", "mycelai.dev"), undefined);
  assert.equal(id.projectForHost(`${p.slug}.someone-elses-domain.com`, "mycelai.dev"), undefined);
  assert.equal(id.projectForHost("", "mycelai.dev"), undefined);

  // THE APPS-DOMAIN REGRESSION. Tenant sites are served at `<slug>.apps.mycelai.dev`, and with the
  // single "mycelai.dev" root the sub-label was `<slug>.apps` — a dot — so it resolved to nothing
  // and every generated site fell back to house defaults. With both roots it resolves, and the
  // longest-root-first ordering is what consumes the extra `.apps` label.
  const roots = ["apps.mycelai.dev", "mycelai.dev"];
  assert.equal(id.projectForHost(`${p.slug}.apps.mycelai.dev`, roots)?.id, p.id);
  assert.equal(id.projectForHost(`${p.slug}.apps.mycelai.dev:443`, roots)?.id, p.id);
  // The bare console root still resolves through the same call.
  assert.equal(id.projectForHost(`${p.slug}.mycelai.dev`, roots)?.id, p.id);
  // Still only one label under each root — three-label names stay refused.
  assert.equal(id.projectForHost(`evil.${p.slug}.apps.mycelai.dev`, roots), undefined);
  assert.equal(id.projectForHost("nobody.apps.mycelai.dev", roots), undefined);
});

test("domains: an unverified claim serves nothing, even if DNS already points here", () => {
  // The whole point of the check. Otherwise claiming a domain you don't own and waiting for its
  // real owner's DNS to break would let you serve a portal on it under our certificate.
  const id = getIdentityStore();
  const { org } = id.createOrgWithOwner("claim-co", `claim-${Date.now()}@example.com`, PW);
  const p = id.createProject(org.id, `Claimant ${Date.now()}`).project;

  const claimed = id.claimDomain(p.id, "  HTTPS://Books.Example.com/portal  ");
  assert.ok(!("error" in claimed));
  const { record } = claimed as { record: { name: string; value: string } };
  assert.equal(record.name, "_mycel.books.example.com", "normalised: scheme, path, case and trailing dot stripped");
  assert.match(record.value, /^mycel-verify=/);

  assert.equal(id.projectForHost("books.example.com", "mycelai.dev"), undefined, "not until it verifies");

  id.markDomainVerified(p.id);
  assert.equal(id.projectForHost("books.example.com", "mycelai.dev")?.id, p.id);
  // The subdomain keeps working, so a founder who moves to their own domain doesn't break the links
  // already sitting in their customers' inboxes.
  assert.equal(id.projectForHost(`${p.slug}.mycelai.dev`, "mycelai.dev")?.id, p.id);

  // And the proof is consumed — there is nothing left to leak or replay.
  assert.equal(id.getProject(p.id)?.domain_verify_token, undefined);
});

test("domains: two businesses cannot claim the same domain", () => {
  const id = getIdentityStore();
  const { org } = id.createOrgWithOwner("dupe-co", `dupe-${Date.now()}@example.com`, PW);
  const a = id.createProject(org.id, `A ${Date.now()}`).project;
  const b = id.createProject(org.id, `B ${Date.now()}`).project;
  const domain = `shared-${Date.now()}.example.com`;

  assert.ok(!("error" in id.claimDomain(a.id, domain)));
  const second = id.claimDomain(b.id, domain);
  assert.ok("error" in second);
  assert.match((second as { error: string }).error, /already claimed/);

  assert.ok("error" in id.claimDomain(a.id, "not a domain"));
});

test("domains: the host lookup is product-key only, and never returns the project id", async () => {
  const { app } = makeApp();
  const id = getIdentityStore();

  const me = (await api(app, "me")).json;
  const project = me.projects[0];
  id.setBranding(project.id, { display_name: "Hartley Bookkeeping", accent: "#123456" });

  const found = await api(app, `host/${project.slug ?? "default"}.mycelai.dev`);
  assert.equal(found.status, 200, found.text);
  assert.equal(found.json.branding.display_name, "Hartley Bookkeeping");
  assert.equal(found.json.branding.accent, "#123456");
  // The app never needs it: a client session already carries the project, and handing the id to
  // this surface only invites someone to try using it.
  assert.equal(found.json.project_id, undefined);
  assert.equal(found.json.id, undefined);

  assert.equal((await api(app, "host/nobody.mycelai.dev")).status, 404);

  // A member session is the wrong credential here — this is called by a service, on every request.
  const signup = await api(app, "auth/signup", {
    method: "POST",
    body: JSON.stringify({ email: `hostlookup-${Date.now()}@example.com`, password: PW }),
  });
  const asMember = await api(app, `host/${project.slug ?? "default"}.mycelai.dev`, {}, signup.json.token);
  assert.equal(asMember.status, 403);
});

test("domains: branding is the founder's, and an accent cannot inject CSS", async () => {
  // It goes into a style attribute on a page served to a founder's customers.
  const { app } = makeApp();
  const owner = await api(app, "auth/login", {
    method: "POST",
    body: JSON.stringify({ email: "owner@test.co", password: "secret" }),
  });
  const session = owner.json.token as string;
  const projectId = owner.json.projects[0].id as string;

  const bad = await api(app, `projects/${projectId}/branding`, {
    method: "PUT",
    body: JSON.stringify({ accent: "red; background: url(https://evil.example/x)" }),
  }, session);
  assert.equal(bad.status, 400);

  const ok = await api(app, `projects/${projectId}/branding`, {
    method: "PUT",
    body: JSON.stringify({ display_name: "Hartley", accent: "#16a34a" }),
  }, session);
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.branding.accent, "#16a34a");
});

/**
 * Stand up a kernel that CAN serve a founder's own domain.
 *
 * `MYCEL_CUSTOM_DOMAINS` is off by default, because the shipped infrastructure has no certificate
 * for a tenant's own name — see `CUSTOM_DOMAINS` in server.ts. The claim/verify mechanism is still
 * correct and still worth testing, so the tests that exercise it turn the switch on explicitly, and
 * the test below this pair asserts what a DEFAULT deployment does instead. Restored afterwards, or
 * the next file in the run inherits a capability its deployment does not have.
 */
function withCustomDomains<T>(fn: () => T): T {
  const prev = process.env.MYCEL_CUSTOM_DOMAINS;
  process.env.MYCEL_CUSTOM_DOMAINS = "1";
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.MYCEL_CUSTOM_DOMAINS;
    else process.env.MYCEL_CUSTOM_DOMAINS = prev;
  }
}

test("domains: a deployment that cannot serve your domain does not offer to", async () => {
  // ═══ THE BUG THIS IS ═══
  //
  // The flow was complete and it was a lie. A founder claimed a domain, published a TXT record, hit
  // verify, got `{ verified: true, portal_url: "https://books.hartley.com" }` — and then got a
  // certificate error, because nothing in `infra/` ever requests a certificate for that name, the
  // ALB listener carries only the `*.mycelai.dev` wildcard, and no host rule matches it.
  //
  // A product must not offer a domain it cannot serve. 501 says "not this deployment", which is the
  // truth, and the GET says the same thing in a sentence the console can render.
  const { app } = makeApp();
  const owner = await api(app, "auth/login", {
    method: "POST", body: JSON.stringify({ email: "owner@test.co", password: "secret" }),
  });
  const session = owner.json.token as string;
  const projectId = owner.json.projects[0].id as string;

  const shown = await api(app, `projects/${projectId}/domain`, {}, session);
  assert.equal(shown.status, 200);
  assert.equal(shown.json.custom_domain_supported, false);
  assert.match(shown.json.custom_domain_unsupported_reason, /can't serve a portal on your own domain/);
  assert.equal(shown.json.verify_record, null, "an instruction whose success means nothing is worse than none");
  assert.match(shown.json.portal_url, /^https:\/\/.+/, "the address that DOES work must still be offered");

  const claim = await api(app, `projects/${projectId}/domain`, {
    method: "POST", body: JSON.stringify({ domain: `nope-${Date.now()}.example.com` }),
  }, session);
  assert.equal(claim.status, 501, claim.text);

  const verify = await api(app, `projects/${projectId}/domain/verify`, { method: "POST" }, session);
  assert.equal(verify.status, 501, verify.text);

  // And no token was minted for a name nothing will serve.
  assert.equal(getIdentityStore().getProject(projectId)?.domain_verify_token, undefined);
});

test("domains: only an owner or admin can point a business somewhere else", async () => {
  // Where a business answers decides whose certificate serves whose customers. That is not an
  // operator-level decision.
  const { app } = withCustomDomains(() => makeApp());
  const boss = await api(app, "auth/signup", {
    method: "POST",
    body: JSON.stringify({ email: `dboss-${Date.now()}@example.com`, password: PW }),
  });
  const bossSession = boss.json.token as string;
  const projectId = boss.json.projects[0].id as string;

  const inv = await api(app, "team/invites", {
    method: "POST",
    body: JSON.stringify({ email: `dop-${Date.now()}@example.com`, role: "operator" }),
  }, bossSession);
  const staff = await api(app, `invites/${inv.json.token}/accept`, {
    method: "POST",
    body: JSON.stringify({ password: PW }),
  }, "nokey");

  const attempt = await api(app, `projects/${projectId}/domain`, {
    method: "POST",
    body: JSON.stringify({ domain: "operator-grab.example.com" }),
  }, staff.json.token);
  assert.equal(attempt.status, 403);

  const allowed = await api(app, `projects/${projectId}/domain`, {
    method: "POST",
    body: JSON.stringify({ domain: `boss-${Date.now()}.example.com` }),
  }, bossSession);
  assert.equal(allowed.status, 201, allowed.text);
  assert.equal(allowed.json.verify_record.type, "TXT");

  // And it survives a reload, so closing the tab doesn't mean starting the claim over.
  const shown = await api(app, `projects/${projectId}/domain`, {}, bossSession);
  assert.equal(shown.json.verified, false);
  assert.equal(shown.json.verify_record.value, allowed.json.verify_record.value);
  assert.match(shown.json.portal_url, /^https:\/\/.+/);
});

test("domains: verifying against DNS that doesn't say so is refused", async () => {
  // example.com has no _mycel TXT record and never will, so this exercises the real lookup rather
  // than a stub — the check is the entire security value of the feature.
  const { app } = withCustomDomains(() => makeApp());
  const owner = await api(app, "auth/login", {
    method: "POST",
    body: JSON.stringify({ email: "owner@test.co", password: "secret" }),
  });
  const session = owner.json.token as string;
  const projectId = owner.json.projects[0].id as string;

  await api(app, `projects/${projectId}/domain`, {
    method: "POST",
    body: JSON.stringify({ domain: "example.com" }),
  }, session);

  const verified = await api(app, `projects/${projectId}/domain/verify`, { method: "POST" }, session);
  assert.equal(verified.status, 409);
  assert.equal(verified.json.verified, false);
  assert.equal(getIdentityStore().getProject(projectId)?.custom_domain_verified_at, undefined);
});

test("domains: the host token can look up a host and nothing else", async () => {
  // The business app is customer-facing. Giving it a product key would mean a compromise there —
  // a dependency, an SSRF — hands over a credential that can read and create tasks for a whole
  // project. This one turns a hostname into a display name and a colour, and that is all.
  const previous = process.env.MYCEL_HOST_TOKEN;
  process.env.MYCEL_HOST_TOKEN = "host-token-abc";
  const { app } = makeApp();
  const project = (await api(app, "me")).json.projects[0];

  const ok = await api(app, `host/${project.slug ?? "default"}.mycelai.dev`, {}, "host-token-abc");
  assert.equal(ok.status, 200, ok.text);
  assert.ok(ok.json.branding);

  // The same token is worthless everywhere else — it is not a scope, it is a doorbell.
  for (const path of ["tasks", "clients", "connections", "me", "org", "audit"]) {
    const r = await api(app, path, {}, "host-token-abc");
    assert.equal(r.status, 401, `${path} must reject the host token, got ${r.status}`);
  }
  assert.equal(
    (await api(app, "tasks", { method: "POST", body: JSON.stringify({ wedge: "books-keeper", task_type: "daily_sync" }) }, "host-token-abc")).status,
    401,
    "and certainly cannot create work",
  );

  // A wrong token is refused rather than waved through.
  assert.equal((await api(app, `host/${project.slug ?? "default"}.mycelai.dev`, {}, "host-token-abd")).status, 403);

  if (previous === undefined) delete process.env.MYCEL_HOST_TOKEN;
  else process.env.MYCEL_HOST_TOKEN = previous;
});
