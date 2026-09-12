import { test } from "node:test";
import assert from "node:assert/strict";
import { api, makeApp, jsonBody } from "./helpers";
import { getIdentityStore } from "../src/identity";

const pw = "correct-horse-battery";
const signup = (app: ReturnType<typeof makeApp>["app"], body: Record<string, unknown>) =>
  api(app, "auth/signup", { method: "POST", body: JSON.stringify(body) });

// Read at call time in identity.ts, so a test can flip it per block. Every test that sets either
// variable clears it again — this file shares one process with every other test in it.
function withEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  return fn().finally(() => {
    for (const k of Object.keys(env)) delete process.env[k];
  });
}

test("signup access: the flag unset means open signup — the self-host default", async () => {
  const { app } = makeApp();
  const r = await signup(app, { email: `open-${Date.now()}@example.test`, password: pw });
  assert.equal(r.status, 201);
});

test("signup access: flag on refuses a stranger with the stable code, and lets a super-admin through", async () => {
  const { app } = makeApp();
  await withEnv(
    { MYCEL_SIGNUP_INVITE_ONLY: "1", MYCEL_SUPERADMIN_EMAILS: "root@mycel.test" },
    async () => {
      const stranger = await signup(app, { email: `stranger-${Date.now()}@example.test`, password: pw });
      assert.equal(stranger.status, 403);
      assert.equal(stranger.json.code, "invite_only");

      const root = await signup(app, { email: "root@mycel.test", password: pw });
      assert.equal(root.status, 201, "the allowlist that ships in the environment is the first door");
    },
  );
});

test("signup access: an allowlisted email passes, and revoking the entry closes the door again", async () => {
  const { app } = makeApp();
  const store = getIdentityStore();
  const email = `ally-${Date.now()}@example.test`;
  const { entry } = store.createSignupAccess({ email, invitedBy: "test" });
  assert.equal(entry.status, "allowlisted");

  await withEnv({ MYCEL_SIGNUP_INVITE_ONLY: "true" }, async () => {
    // Revoke first, prove the refusal, then re-grant — the same email cannot sign up twice, so the
    // order is the only one that tests both directions on one address.
    assert.equal(store.deleteSignupAccess(entry.id), true);
    const refused = await signup(app, { email, password: pw });
    assert.equal(refused.status, 403);
    assert.equal(refused.json.code, "invite_only");

    store.createSignupAccess({ email, invitedBy: "test" });
    const ok = await signup(app, { email, password: pw });
    assert.equal(ok.status, 201);
  });
});

test("signup access: a link works once, and the second use is refused", async () => {
  const { app } = makeApp();
  const store = getIdentityStore();
  const { entry, token } = store.createSignupAccess({ invitedBy: "test", note: "warm intro" });
  assert.ok(token, "a link entry returns the raw token exactly once");
  assert.equal(entry.status, "link-pending");

  await withEnv({ MYCEL_SIGNUP_INVITE_ONLY: "1" }, async () => {
    // The public peek — no credential beyond the token itself.
    const peek = await app.request(`/v1/signup-invites/${token}`);
    assert.equal(peek.status, 200);
    assert.equal(((await jsonBody(peek)) as { valid: boolean }).valid, true);

    const first = await signup(app, {
      email: `link-a-${Date.now()}@example.test`,
      password: pw,
      invite_token: token,
    });
    assert.equal(first.status, 201);

    const second = await signup(app, {
      email: `link-b-${Date.now()}@example.test`,
      password: pw,
      invite_token: token,
    });
    assert.equal(second.status, 403, "a spent link admits nobody else");
    assert.equal(second.json.code, "invite_only");

    const spent = await app.request(`/v1/signup-invites/${token}`);
    assert.equal(((await jsonBody(spent)) as { valid: boolean }).valid, false);
  });
});

test("signup access: an expired link is refused, and a pinned link only admits its address", async () => {
  const { app } = makeApp();
  const store = getIdentityStore();
  const expired = store.createSignupAccess({ invitedBy: "test", ttlMs: -1 });

  await withEnv({ MYCEL_SIGNUP_INVITE_ONLY: "1" }, async () => {
    const r = await signup(app, {
      email: `late-${Date.now()}@example.test`,
      password: pw,
      invite_token: expired.token,
    });
    assert.equal(r.status, 403);
    assert.equal(r.json.code, "invite_only");

    const pinnedEmail = `pinned-${Date.now()}@example.test`;
    const withPin = store.createSignupAccess({ email: pinnedEmail, link: true, invitedBy: "test" });
    assert.equal(withPin.entry.kind, "link");
    const wrong = await signup(app, {
      email: `impostor-${Date.now()}@example.test`,
      password: pw,
      invite_token: withPin.token,
    });
    assert.equal(wrong.status, 403);
    const right = await signup(app, { email: pinnedEmail, password: pw, invite_token: withPin.token });
    assert.equal(right.status, 201);
  });
});

test("signup access: federated sign-UP is gated the same way, federated sign-IN is not", async () => {
  const { app } = makeApp();
  const existing = `fed-existing-${Date.now()}@example.test`;
  await api(app, "auth/federated", { method: "POST", body: JSON.stringify({ email: existing, provider: "google" }) });

  await withEnv({ MYCEL_SIGNUP_INVITE_ONLY: "1" }, async () => {
    const stranger = await api(app, "auth/federated", {
      method: "POST",
      body: JSON.stringify({ email: `fed-new-${Date.now()}@example.test`, provider: "google" }),
    });
    assert.equal(stranger.status, 403);
    assert.equal(stranger.json.code, "invite_only");

    const back = await api(app, "auth/federated", {
      method: "POST",
      body: JSON.stringify({ email: existing, provider: "github" }),
    });
    assert.equal(back.status, 200, "an existing member signing in is not a sign-up");
  });
});

test("signup access: the ops surface is super-admin only, and works end to end for one", async () => {
  const { app } = makeApp();
  await withEnv({ MYCEL_SUPERADMIN_EMAILS: "hq@mycel.test" }, async () => {
    const hq = await signup(app, { email: "hq@mycel.test", password: pw });
    assert.equal(hq.status, 201);
    const founder = await signup(app, { email: `founder-${Date.now()}@example.test`, password: pw });
    assert.equal(founder.status, 201);

    // A plain founder session — and the bare product key — both land on 404, not 403: the surface's
    // existence is not confirmable from outside the allowlist.
    for (const cred of [founder.json.token as string, undefined]) {
      const list = await api(app, "ops/signup-access", {}, cred);
      assert.equal(list.status, 404);
      const add = await api(app, "ops/signup-access", { method: "POST", body: JSON.stringify({}) }, cred);
      assert.equal(add.status, 404);
      const del = await api(app, "ops/signup-access/whatever", { method: "DELETE" }, cred);
      assert.equal(del.status, 404);
    }

    const made = await api(
      app,
      "ops/signup-access",
      { method: "POST", body: JSON.stringify({ note: "for the demo" }) },
      hq.json.token,
    );
    assert.equal(made.status, 201);
    assert.ok(made.json.token, "a link grant returns the raw token once");
    assert.ok(!JSON.stringify(made.json).includes("token_hash"), "and never the hash");

    const listed = await api(app, "ops/signup-access", {}, hq.json.token);
    assert.equal(listed.status, 200);
    const row = listed.json.entries.find((e: any) => e.id === made.json.entry.id);
    assert.equal(row.status, "link-pending");
    assert.ok(Array.isArray(listed.json.requests), "asks sit on the same payload as grants");

    const gone = await api(app, `ops/signup-access/${made.json.entry.id}`, { method: "DELETE" }, hq.json.token);
    assert.equal(gone.status, 200);
  });
});

test("signup request: an ask is listed until the address is allowlisted", async () => {
  const { app } = makeApp();
  const store = getIdentityStore();
  const email = `ask-${Date.now()}@agency.test`;

  const first = store.recordSignupRequest({ email, source: "landing", about: "hero" });
  assert.ok(!("error" in first));
  assert.equal(store.listSignupRequests().some((r) => r.email === email), true);

  store.recordSignupRequest({ email, source: "landing", about: "capacity" });
  const listed = store.listSignupRequests().filter((r) => r.email === email);
  assert.equal(listed.length, 1, "the same address is one row");
  assert.equal(listed[0]?.about, "capacity");

  store.createSignupAccess({ email, invitedBy: "test" });
  assert.equal(store.listSignupRequests().some((r) => r.email === email), false);
});

test("signup request: ops POST is super-admin/control only, GET rides signup-access", async () => {
  const { app } = makeApp();
  await withEnv({ MYCEL_SUPERADMIN_EMAILS: "asks@mycel.test", MYCEL_CONTROL_TOKEN: "ctl" }, async () => {
    const hq = await signup(app, { email: "asks@mycel.test", password: pw });
    assert.equal(hq.status, 201);
    const email = `wait-${Date.now()}@agency.test`;

    const refused = await api(app, "ops/signup-requests", {
      method: "POST",
      body: JSON.stringify({ email, source: "landing" }),
    });
    assert.equal(refused.status, 404, "the product key alone cannot write the waitlist");

    const wrote = await api(
      app,
      "ops/signup-requests",
      {
        method: "POST",
        headers: { "x-mycel-control": "ctl" },
        body: JSON.stringify({ email, source: "landing", about: "hero" }),
      },
    );
    assert.equal(wrote.status, 201);
    assert.equal(wrote.json.request.email, email);

    const listed = await api(app, "ops/signup-access", {}, hq.json.token);
    assert.equal(listed.status, 200);
    assert.ok(listed.json.requests.some((r: { email: string }) => r.email === email));

    const granted = await api(
      app,
      "ops/signup-access",
      { method: "POST", body: JSON.stringify({ email, note: "Asked for access" }) },
      hq.json.token,
    );
    assert.equal(granted.status, 201);
    const after = await api(app, "ops/signup-access", {}, hq.json.token);
    assert.equal(after.json.requests.some((r: { email: string }) => r.email === email), false);
  });
});
