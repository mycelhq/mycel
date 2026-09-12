// Custom-domain serving: the state machine that turns a verified name into a live one.
//
// Every test names either a way the machine could waste a founder's DNS change (a certificate
// requested twice, a record that vanishes on reload, a "live" that never arrives), or a way it
// could serve a name nobody proved they own — because those are the two failure modes the whole
// feature history is about (see NO_CUSTOM_DOMAINS in server.ts).
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  advanceCustomDomain,
  certIdempotencyToken,
  setDomainAwsClient,
  type DomainAwsClient,
  type DomainIdentity,
  type DomainProvisioning,
} from "../src/domains.aws";

const CFG = { appsDomain: "apps.mycelai.dev" };

afterEach(() => setDomainAwsClient(null));

/** An identity store that is a Map, plus a project mid-flow. */
function store(overrides: Partial<Parameters<DomainIdentity["setDomainProvisioning"]>[1] & {
  slug?: string; custom_domain?: string; custom_domain_verified_at?: string; domain_provisioning?: DomainProvisioning;
}> = {}) {
  const project = {
    id: "p1",
    slug: "acme",
    custom_domain: "clients.acme.com",
    custom_domain_verified_at: "2026-08-01T00:00:00.000Z",
    domain_provisioning: undefined as DomainProvisioning | undefined,
    ...overrides,
  };
  const writes: DomainProvisioning[] = [];
  const identity: DomainIdentity = {
    getProject: (id) => (id === project.id ? project : undefined),
    setDomainProvisioning: (_id, prov) => {
      project.domain_provisioning = prov;
      writes.push(prov);
    },
  };
  return { identity, project, writes };
}

/** An AWS that records what it was asked and never touches a network. */
function fakeAws(opts: {
  certStatus?: string;
  validation?: { name: string; value: string };
  failureReason?: string;
  distribution?: { id: string; domainName: string } | null;
  requestFails?: boolean;
  attachFails?: boolean;
} = {}) {
  const calls = { requests: [] as { domain: string; sans: string[]; token: string }[], attaches: [] as { id: string; domain: string; arn: string }[], describes: 0 };
  const client: DomainAwsClient = {
    async requestCertificate(domain, sans, token) {
      if (opts.requestFails) throw new Error("acm said no");
      calls.requests.push({ domain, sans, token });
      return "arn:aws:acm:us-east-1:1:certificate/abc";
    },
    async describeCertificate() {
      calls.describes++;
      return {
        status: opts.certStatus ?? "PENDING_VALIDATION",
        validationRecord: opts.validation ?? { name: "_x.clients.acme.com", value: "_y.acm-validations.aws" },
        failureReason: opts.failureReason,
      };
    },
    async findDistributionByAlias() {
      return opts.distribution === undefined ? { id: "E123", domainName: "d123.cloudfront.net" } : opts.distribution;
    },
    async attachDomain(id, domain, arn) {
      if (opts.attachFails) throw new Error("etag conflict");
      calls.attaches.push({ id, domain, arn });
    },
  };
  setDomainAwsClient(client);
  return calls;
}

// ── Ownership is the gate ────────────────────────────────────────────────────

test("an unverified claim never reaches AWS — no cert may exist for a name nobody proved they own", async () => {
  const { identity, project } = store({ custom_domain_verified_at: undefined });
  const calls = fakeAws();
  const prov = await advanceCustomDomain(identity, "p1", CFG);
  assert.equal(prov.state, "claimed");
  assert.equal(calls.requests.length, 0);
  assert.equal(project.domain_provisioning?.state, "claimed");
});

test("no claimed domain at all is a failure with a sentence, not a crash", async () => {
  const { identity } = store({ custom_domain: undefined });
  fakeAws();
  const prov = await advanceCustomDomain(identity, "p1", CFG);
  assert.equal(prov.state, "failed");
  assert.match(prov.error ?? "", /no domain claimed/i);
});

// ── The happy path, one press at a time ──────────────────────────────────────

test("first advance after verify: finds the distribution, requests the cert, records both, and waits", async () => {
  const { identity, project } = store();
  const calls = fakeAws({ certStatus: "PENDING_VALIDATION" });
  const prov = await advanceCustomDomain(identity, "p1", CFG);

  assert.equal(prov.state, "cert_requested");
  // The distribution is pinned BEFORE the certificate, so the founder gets the traffic CNAME in
  // the same checklist as the ACM one — one visit to the registrar, not three.
  assert.equal(prov.distribution_id, "E123");
  assert.equal(prov.distribution_domain, "d123.cloudfront.net");
  assert.equal(prov.cert_arn, "arn:aws:acm:us-east-1:1:certificate/abc");
  assert.equal(prov.acm_record_name, "_x.clients.acme.com");
  // The wildcard SAN is load-bearing: one cert per distribution is a hard CloudFront quota, and
  // without `*.apps` on the new cert, going live would break TLS on the tenant's mycel address.
  assert.deepEqual(calls.requests[0]?.sans, ["*.apps.mycelai.dev"]);
  assert.equal(project.domain_provisioning?.state, "cert_requested");
});

test("a second press while the founder's CNAME is still propagating requests NOTHING new", async () => {
  const { identity } = store();
  const calls = fakeAws({ certStatus: "PENDING_VALIDATION" });
  await advanceCustomDomain(identity, "p1", CFG);
  await advanceCustomDomain(identity, "p1", CFG);
  await advanceCustomDomain(identity, "p1", CFG);
  // One RequestCertificate ever; every later pass is a Describe against the stored ARN. A machine
  // that re-requested on each click would strand the founder's published CNAME against cert #1.
  assert.equal(calls.requests.length, 1);
  assert.equal(calls.describes, 3);
});

test("issued cert: the alias is attached to the tenant's own distribution and the state is live", async () => {
  const { identity } = store();
  const calls = fakeAws({ certStatus: "ISSUED" });
  const prov = await advanceCustomDomain(identity, "p1", CFG);
  assert.equal(prov.state, "live");
  assert.equal(prov.error, undefined);
  assert.deepEqual(calls.attaches, [
    { id: "E123", domain: "clients.acme.com", arn: "arn:aws:acm:us-east-1:1:certificate/abc" },
  ]);
});

test("pressing Check status on a live domain converges instead of erroring", async () => {
  const { identity } = store();
  fakeAws({ certStatus: "ISSUED" });
  await advanceCustomDomain(identity, "p1", CFG);
  const again = await advanceCustomDomain(identity, "p1", CFG);
  assert.equal(again.state, "live");
});

// ── Failure states carry sentences and stay resumable ────────────────────────

test("a timed-out certificate drops the dead ARN so the retry mints a fresh one", async () => {
  const { identity, project } = store();
  fakeAws({ certStatus: "VALIDATION_TIMED_OUT" });
  const prov = await advanceCustomDomain(identity, "p1", CFG);
  assert.equal(prov.state, "failed");
  assert.equal(prov.cert_arn, undefined);
  assert.match(prov.error ?? "", /not issued/);
  // The retry starts a fresh certificate rather than describing the corpse.
  const calls = fakeAws({ certStatus: "PENDING_VALIDATION" });
  const retry = await advanceCustomDomain(identity, "p1", CFG);
  assert.equal(retry.state, "cert_requested");
  assert.equal(calls.requests.length, 1);
  // The distribution discovered on the first pass survived the failure — done stays done.
  assert.equal(project.domain_provisioning?.distribution_id, "E123");
});

test("no deployed site yet is an honest failure naming the remedy, and no certificate is requested", async () => {
  const { identity } = store();
  const calls = fakeAws({ distribution: null });
  const prov = await advanceCustomDomain(identity, "p1", CFG);
  assert.equal(prov.state, "failed");
  assert.match(prov.error ?? "", /hasn't been published/);
  assert.equal(calls.requests.length, 0);
});

test("a hosting-less deployment fails with a sentence, not a hunt for a distribution", async () => {
  const { identity } = store();
  const calls = fakeAws();
  const prov = await advanceCustomDomain(identity, "p1", null);
  assert.equal(prov.state, "failed");
  assert.match(prov.error ?? "", /doesn't host tenant sites/);
  assert.equal(calls.requests.length, 0);
});

test("an ACM refusal becomes failed-with-reason and the next press retries from the same spot", async () => {
  const { identity } = store();
  fakeAws({ requestFails: true });
  const prov = await advanceCustomDomain(identity, "p1", CFG);
  assert.equal(prov.state, "failed");
  assert.match(prov.error ?? "", /acm said no/);
  const calls = fakeAws({ certStatus: "PENDING_VALIDATION" });
  const retry = await advanceCustomDomain(identity, "p1", CFG);
  assert.equal(retry.state, "cert_requested");
  assert.equal(calls.requests.length, 1);
});

test("an attach failure after issuance keeps the cert and retries only the attach", async () => {
  const { identity } = store();
  fakeAws({ certStatus: "ISSUED", attachFails: true });
  const prov = await advanceCustomDomain(identity, "p1", CFG);
  assert.equal(prov.state, "failed");
  assert.match(prov.error ?? "", /everything up to here is done/);
  assert.equal(prov.cert_arn, "arn:aws:acm:us-east-1:1:certificate/abc");
  const calls = fakeAws({ certStatus: "ISSUED" });
  const retry = await advanceCustomDomain(identity, "p1", CFG);
  assert.equal(retry.state, "live");
  assert.equal(calls.requests.length, 0); // the certificate was never re-requested
});

// ── The idempotency token ────────────────────────────────────────────────────

test("the ACM idempotency token is stable per project+domain and ACM-legal", () => {
  const t = certIdempotencyToken("p1", "clients.acme.com");
  assert.equal(t, certIdempotencyToken("p1", "clients.acme.com"));
  // Changing EITHER input must change the token, or a founder who moves domains would get the old
  // domain's certificate back from ACM with a straight face.
  assert.notEqual(t, certIdempotencyToken("p2", "clients.acme.com"));
  assert.notEqual(t, certIdempotencyToken("p1", "portal.acme.com"));
  assert.match(t, /^[A-Za-z0-9_-]{1,32}$/);
});
