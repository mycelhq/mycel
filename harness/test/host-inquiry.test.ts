// The one PUBLIC WRITE the tenant face has: a stranger on a generated marketing site messaging the
// agency. It is authed by the same brand-key / host-token credential as `GET /v1/host/:host`, and it
// captures the message as an open `ClientRequest` the founder reads — without creating a client,
// opening a thread, or starting a run.
//
// These tests pin the security envelope: the credential is enforced in the handler, a brand key for
// another project is a 404 (never a 403, so a probe can't enumerate), the honeypot is silent, bad
// input is refused, and the per-IP window closes after five.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp } from "./helpers";
import { getIdentityStore } from "../src/identity";
import { getRequestStore } from "../src/requests";
import { brandKeyFor } from "../src/scopedkeys";

const PW = "a-long-enough-password";

function tenant() {
  const id = getIdentityStore();
  const { project } = id.createOrgWithOwner(
    "inquiry-co",
    `inquiry-${Date.now()}-${Math.random()}@example.com`,
    PW,
  );
  return { project, host: `${project.slug}.mycelai.dev` };
}

async function inquire(
  app: ReturnType<typeof makeApp>["app"],
  host: string,
  key: string,
  body: Record<string, unknown>,
  ip = "203.0.113.7",
) {
  const res = await app.request(`/v1/host/${host}/inquiry`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      "x-forwarded-for": ip,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-json */
  }
  return { status: res.status, json };
}

const GOOD = { name: "Jane Prospect", email: "jane@acme.example", message: "We'd like a quote for bookkeeping.", company: "Acme" };

test("inquiry: a valid message from the site's brand key becomes an open request", async () => {
  const { app } = makeApp();
  const { project, host } = tenant();
  const before = (await getRequestStore().listRequests({ project_id: project.id })).length;

  const r = await inquire(app, host, brandKeyFor(project.id), GOOD, "203.0.113.10");
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true });

  const rows = await getRequestStore().listRequests({ project_id: project.id });
  assert.equal(rows.length, before + 1);
  const row = rows[0];
  assert.equal(row.status, "open");
  assert.match(row.ask, /Jane Prospect/);
  assert.equal(row.party_email, "jane@acme.example");
  assert.match(row.detail ?? "", /quote for bookkeeping/);
  assert.match(row.detail ?? "", /Acme/);
  // Filed under the reserved bucket, never a real client — so no customer session can ever read it.
  assert.equal(row.client_id, "website-inquiry");
});

test("inquiry: the honeypot is answered with a fake 200 and writes nothing", async () => {
  const { app } = makeApp();
  const { project, host } = tenant();
  const before = (await getRequestStore().listRequests({ project_id: project.id })).length;

  const r = await inquire(app, host, brandKeyFor(project.id), { ...GOOD, _hp: "i-am-a-bot" }, "203.0.113.11");
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true });

  const after = (await getRequestStore().listRequests({ project_id: project.id })).length;
  assert.equal(after, before, "honeypot submission must not create a request");
});

test("inquiry: a malformed email is refused", async () => {
  const { app } = makeApp();
  const { project, host } = tenant();
  const before = (await getRequestStore().listRequests({ project_id: project.id })).length;

  const r = await inquire(app, host, brandKeyFor(project.id), { ...GOOD, email: "not-an-email" }, "203.0.113.12");
  assert.equal(r.status, 400);
  const after = (await getRequestStore().listRequests({ project_id: project.id })).length;
  assert.equal(after, before);
});

test("inquiry: a brand key for another project 404s on this host (never 403)", async () => {
  const { app } = makeApp();
  const { host } = tenant();
  const other = tenant();
  // A valid credential — just not for the host in the path. The middleware lets it through (it is a
  // real brand key); the handler's least-authority line refuses it, as a 404 so the two are
  // indistinguishable from "no such host".
  const r = await inquire(app, host, brandKeyFor(other.project.id), GOOD, "203.0.113.13");
  assert.equal(r.status, 404);
});

test("inquiry: with no credential at all it is refused, not accepted", async () => {
  const { app } = makeApp();
  const { host } = tenant();
  // No brand key and no host token → the public bypass never engages and the product-key middleware
  // answers 401 before the handler runs.
  const res = await app.request(`/v1/host/${host}/inquiry`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.14" },
    body: JSON.stringify(GOOD),
  });
  assert.equal(res.status, 401);
});

test("inquiry: the per-IP window closes after five in ten minutes", async () => {
  const { app } = makeApp();
  const { project, host } = tenant();
  const key = brandKeyFor(project.id);
  const ip = "198.51.100.5"; // unique to this test so no other test's traffic counts against it

  for (let i = 0; i < 5; i++) {
    const r = await inquire(app, host, key, GOOD, ip);
    assert.equal(r.status, 200, `submission ${i + 1} should be accepted`);
  }
  const sixth = await inquire(app, host, key, GOOD, ip);
  assert.equal(sixth.status, 429);
});
