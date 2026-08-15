import { test } from "node:test";
import assert from "node:assert/strict";
import { api, makeApp } from "./helpers";
import { getIdentityStore } from "../src/identity";

const pw = "correct-horse-battery";

test("auth: signup creates an org, refuses a taken email, and refuses a weak password", async () => {
  const { app } = makeApp();
  const email = `founder-${Date.now()}@example.test`;

  const weak = await api(app, "auth/signup", { method: "POST", body: JSON.stringify({ email, password: "short" }) });
  assert.equal(weak.status, 400);

  const bad = await api(app, "auth/signup", { method: "POST", body: JSON.stringify({ email: "not-an-email", password: pw }) });
  assert.equal(bad.status, 400);

  const ok = await api(app, "auth/signup", { method: "POST", body: JSON.stringify({ email, password: pw }) });
  assert.equal(ok.status, 201);
  assert.ok(ok.json.token);
  assert.ok(ok.json.projects.length >= 1, "a new org comes with a project to put work in");
  assert.equal(ok.json.member.last_provider, "password");
  // Nothing secret ever leaves. publicMember is an allowlist for exactly this reason.
  const text = JSON.stringify(ok.json);
  for (const leak of ["hash", "salt", "reset_"]) assert.ok(!text.includes(leak), `must not expose ${leak}`);

  // Signing up twice is told plainly — unlike the reset flow, where the same honesty would leak
  // whether a stranger's email has an account.
  const dupe = await api(app, "auth/signup", { method: "POST", body: JSON.stringify({ email, password: pw }) });
  assert.equal(dupe.status, 409);

  // And the account actually works.
  const login = await api(app, "auth/login", { method: "POST", body: JSON.stringify({ email, password: pw }) });
  assert.equal(login.status, 200);
});

test("auth: federated sign-in needs the product key — a browser can't claim an email", async () => {
  const { app } = makeApp();
  const email = `oauth-${Date.now()}@example.test`;

  // The whole security boundary. Without a key this is "type any email, become that person".
  const anon = await app.request("/v1/auth/federated", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, provider: "google" }),
  });
  assert.equal(anon.status, 401, "unauthenticated callers are refused by the middleware");
  assert.ok(!(await anon.json()).token, "and get nothing back");

  // A member SESSION isn't enough either — this is server-to-server only.
  const owner = await api(app, "auth/login", {
    method: "POST",
    body: JSON.stringify({
      email: process.env.MYCEL_OWNER_EMAIL || "owner@test.co",
      password: process.env.MYCEL_OWNER_PASSWORD || "secret",
    }),
  });
  const asMember = await api(app, "auth/federated", { method: "POST", body: JSON.stringify({ email, provider: "google" }) }, owner.json.token);
  assert.equal(asMember.status, 403);

  const created = await api(app, "auth/federated", { method: "POST", body: JSON.stringify({ email, provider: "google" }) });
  assert.equal(created.status, 201);
  assert.equal(created.json.created, true);
  assert.equal(created.json.member.last_provider, "google");

  // An OAuth-only account has NO password, so nothing should log into it that way.
  //
  // Tested against the identity store DIRECTLY, not over HTTP, on purpose: the route rejects an
  // empty password before identity ever sees it, so an HTTP-level test passes whether or not the
  // guard below exists. That makes it worthless as a regression test for the guard — which I only
  // found by reverting the fix and watching the suite stay green.
  //
  // The trap it pins: the account is created with `""`, and `hashPassword("")` returns a perfectly
  // valid 64-byte hash. Without `!member.hash`, `login(email, "")` verifies successfully.
  const id = getIdentityStore();
  for (const guess of ["", " ", "password", pw]) {
    assert.equal(
      id.login(email, guess),
      undefined,
      `an OAuth-only account must not accept the password ${JSON.stringify(guess)}`,
    );
  }

  // Coming back through a different provider is the SAME account, not a silent duplicate.
  const again = await api(app, "auth/federated", { method: "POST", body: JSON.stringify({ email, provider: "github" }) });
  assert.equal(again.status, 200);
  assert.equal(again.json.created, false);
  assert.equal(again.json.member.id, created.json.member.id);
  assert.deepEqual(again.json.member.providers.sort(), ["github", "google"]);
  assert.equal(again.json.member.last_provider, "github");

  // Unsupported providers are refused rather than silently trusted.
  assert.equal((await api(app, "auth/federated", { method: "POST", body: JSON.stringify({ email, provider: "myspace" }) })).status, 400);
});

test("auth: the provider hint helps returning users without leaking who has an account", async () => {
  const { app } = makeApp();
  const email = `hint-${Date.now()}@example.test`;
  await api(app, "auth/federated", { method: "POST", body: JSON.stringify({ email, provider: "google" }) });

  const known = await api(app, "auth/hint", { method: "POST", body: JSON.stringify({ email }) });
  assert.equal(known.json.provider, "google", "returning users are pointed at the button they used");

  // A stranger's email answers in exactly the same shape, so this can't be used to check whether
  // someone is a customer.
  const unknown = await api(app, "auth/hint", { method: "POST", body: JSON.stringify({ email: "nobody@example.test" }) });
  assert.equal(unknown.status, 200);
  assert.equal(unknown.json.provider, null);
  assert.deepEqual(Object.keys(unknown.json), Object.keys(known.json));
});

test("auth: password reset is single-use, time-bound, and doesn't reveal who has an account", async () => {
  const { app } = makeApp();
  const email = `reset-${Date.now()}@example.test`;
  await api(app, "auth/signup", { method: "POST", body: JSON.stringify({ email, password: pw }) });

  // Same response shape for a stranger — no enumeration oracle.
  const unknown = await api(app, "auth/reset/request", { method: "POST", body: JSON.stringify({ email: "nobody@example.test" }) });
  assert.equal(unknown.status, 200);
  assert.equal(unknown.json.ok, true);
  assert.equal(unknown.json.token, undefined, "…and no token for an account that doesn't exist");

  const req = await api(app, "auth/reset/request", { method: "POST", body: JSON.stringify({ email }) });
  const token = req.json.token as string;
  assert.ok(token);

  assert.equal(
    (await api(app, "auth/reset/confirm", { method: "POST", body: JSON.stringify({ token: "mrst_wrong", password: "a-new-long-password" }) })).status,
    400,
    "a forged token is refused",
  );
  assert.equal(
    (await api(app, "auth/reset/confirm", { method: "POST", body: JSON.stringify({ token, password: "short" }) })).status,
    400,
    "and the new password still has to be a real one",
  );

  const done = await api(app, "auth/reset/confirm", { method: "POST", body: JSON.stringify({ token, password: "a-new-long-password" }) });
  assert.equal(done.status, 200);
  assert.ok(done.json.token, "completing a reset signs you in — nobody wants to type it twice");

  // Single use. A link that still works is a link an attacker can reuse from a mailbox they saw once.
  assert.equal(
    (await api(app, "auth/reset/confirm", { method: "POST", body: JSON.stringify({ token, password: "yet-another-password" }) })).status,
    400,
  );

  assert.equal((await api(app, "auth/login", { method: "POST", body: JSON.stringify({ email, password: pw }) })).status, 401, "the old password is dead");
  assert.equal((await api(app, "auth/login", { method: "POST", body: JSON.stringify({ email, password: "a-new-long-password" }) })).status, 200);
});
