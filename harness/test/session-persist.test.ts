// Session resolution after the move to hashed, persisted, read-through sessions.
//
// The store now keys sessions by the token's SHA-256 hash (so a leaked DB/heap holds no usable
// token) and resolveSession/resolveAuth are async (a real session is a read-through against
// Postgres). These tests pin the observable contract that change must not break: a freshly minted
// token resolves to its member, the hash of a DIFFERENT token is a different key so a bogus token
// resolves to nothing, and the async resolveAuth still routes a prefixed member token to the session
// resolver while leaving API keys a synchronous lookup. The Postgres read-through itself is exercised
// live and by the identity.pg session methods; here the in-memory cache path is under test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { api, makeApp } from "./helpers";
import { getIdentityStore } from "../src/identity";
import { resolveAuth } from "../src/auth";

const OWNER = process.env.MYCEL_OWNER_EMAIL || "owner@test.co";
const OWNER_PW = process.env.MYCEL_OWNER_PASSWORD || "secret";

test("session: a minted token resolves to its member; a token never issued resolves to nothing", async () => {
  const { app } = makeApp();
  const login = await api(app, "auth/login", { method: "POST", body: JSON.stringify({ email: OWNER, password: OWNER_PW }) });
  assert.equal(login.status, 200, login.text);
  const token = login.json.token as string;
  assert.ok(token.startsWith("msess_"), "a member session token is prefixed");

  const id = getIdentityStore();
  const scope = await id.resolveSession(token);
  assert.equal(scope?.kind, "member", "the issued token resolves to its member");

  // The hash of a wrong token is a different key — so a bogus token is simply absent, never a
  // collision or a raw-token match.
  assert.equal(await id.resolveSession("msess_this-was-never-issued"), undefined);
  assert.equal(await id.resolveSession(token + "x"), undefined, "a tampered token does not resolve");
});

test("session: resolveAuth is async and routes a member token to the session resolver", async () => {
  const { app } = makeApp();
  const login = await api(app, "auth/login", { method: "POST", body: JSON.stringify({ email: OWNER, password: OWNER_PW }) });
  const token = login.json.token as string;

  const viaAuth = await resolveAuth(token);
  assert.equal(viaAuth?.kind, "member", "a prefixed member token resolves through resolveAuth");

  assert.equal(await resolveAuth(""), null, "an empty credential is refused");
  assert.equal(await resolveAuth("msess_bogus"), null, "an unknown session token is refused");
});

test("session: two logins are two independent sessions that both resolve, and resolving is idempotent", async () => {
  // Multi-device is the point of a persisted store: the same member signed in on a laptop and a
  // phone holds two distinct tokens, and both stay valid. In-memory-only, this worked by accident
  // on one process; now it is a property of the store.
  const { app } = makeApp();
  const a = await api(app, "auth/login", { method: "POST", body: JSON.stringify({ email: OWNER, password: OWNER_PW }) });
  const b = await api(app, "auth/login", { method: "POST", body: JSON.stringify({ email: OWNER, password: OWNER_PW }) });
  const ta = a.json.token as string;
  const tb = b.json.token as string;
  assert.notEqual(ta, tb, "each login mints a distinct token");

  const id = getIdentityStore();
  assert.equal((await id.resolveSession(ta))?.kind, "member");
  assert.equal((await id.resolveSession(tb))?.kind, "member");
  // Resolving the same token repeatedly (sliding runs on the hot path) keeps resolving.
  for (let i = 0; i < 3; i++) assert.equal((await id.resolveSession(ta))?.kind, "member");
});
