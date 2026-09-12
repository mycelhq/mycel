/**
 * TWO WAYS TO REFUSE A PREFERENCE WRITE, AND THEY ARE NOT THE SAME PROBLEM.
 *
 * `setMemberPrefs` returned a bare `undefined` for both "no such member" and "over a ceiling", and
 * `/v1/me/prefs` asserted in a comment that it could only mean the ceiling. So it answered 413
 * "preferences are too large" for both.
 *
 * Found by walking a fresh signup through onboarding. A kernel restart landed mid-flow, the member
 * was in Postgres but not yet in this process's in-memory Map, and onboarding told a brand new
 * account — whose `prefs` column was literally `null` — that its preferences were too large. The
 * page did not advance and the only trace was in a `role="alert"` region. An hour went into
 * checking an 8,000 character limit that was never involved.
 *
 * A wrong error is worse than a generic one. "Too large" names a cause, and a named cause that is
 * false sends every future reader to the same wrong place.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { getIdentityStore } from "../src/identity";
import { api, makeFreshApp, jsonBody } from "./helpers";

const OWNER_EMAIL = process.env.MYCEL_OWNER_EMAIL || "owner@test.co";
const OWNER_PW = process.env.MYCEL_OWNER_PASSWORD || "secret";

/**
 * A MEMBER session, not the product key. `/v1/me/prefs` is member-only by design — a product key
 * has no person behind it, so there is nobody whose preferences these would be. The first version
 * of this file used `api()` (which sends the product key) and got a correct 403 back.
 */
async function member(app: Awaited<ReturnType<typeof makeFreshApp>>["app"]) {
  const res = await app.request("/v1/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PW }),
  });
  const body = (await jsonBody(res)) as { token?: string; member?: { id?: string } };
  return { token: body.token!, id: body.member?.id };
}

test("a member this process has never loaded refuses as no_such_member, not as too large", async () => {
  await makeFreshApp();
  const out = getIdentityStore().setMemberPrefsResult("member-that-does-not-exist", { theme: "dark" });
  assert.equal(out.member, undefined);
  assert.equal(out.reason, "no_such_member", "a missing member still reports as an oversized write");
});

test("a genuine ceiling still refuses as too_large", async () => {
  const { app } = await makeFreshApp();
  const { token } = await member(app);
  const id = ((await api(app, "me", {}, token)).json as { member?: { id?: string } }).member?.id;
  assert.ok(id, "no member on the session — fixture is wrong, not the code");

  // Comfortably past PREFS_MAX_JSON_CHARS (8,000).
  const out = getIdentityStore().setMemberPrefsResult(id!, { note: "x".repeat(9_000) });
  assert.equal(out.member, undefined);
  assert.equal(out.reason, "too_large", "a real ceiling stopped being reported as one");
});

test("an ordinary write still succeeds and returns the member", async () => {
  // The refactor must not have made the happy path a refusal.
  const { app } = await makeFreshApp();
  const { token } = await member(app);
  const id = ((await api(app, "me", {}, token)).json as { member?: { id?: string } }).member?.id;
  const out = getIdentityStore().setMemberPrefsResult(id!, { theme: "dark" });
  assert.ok(out.member, "an ordinary preference write was refused");
  assert.equal(out.reason, undefined);
  assert.equal((out.member!.prefs as Record<string, unknown>).theme, "dark");
});

test("the route still answers 200 and 413 for the two cases a test can reach", async () => {
  /**
   * NOT the 404 branch, and the name says so.
   *
   * An earlier version of this was called "answers 404 for a missing member" and never exercised
   * that path — collapsing both refusals back into one message left it green. A test that names a
   * behaviour it does not check is worse than no test, because the name is what the next person
   * trusts.
   *
   * The 404 needs a live session whose member is gone from the Map. `removeMember` deletes the
   * member's sessions in the same call, so the token stops authenticating and you get 403 rather
   * than reaching the branch. There is no public seam that separates the two, which is correct
   * design and does make this branch defensive-only. `setMemberPrefsResult` is where the
   * distinction is actually asserted, in the first test in this file.
   *
   * The status code is the half a caller acts on: 413 tells them to send less, which is useless
   * advice when the account simply is not loaded.
   */
  const { app } = await makeFreshApp();
  const { token } = await member(app);
  const ok = await api(app, "me/prefs", { method: "PATCH", body: JSON.stringify({ theme: "dark" }) }, token);
  assert.equal(ok.status, 200, "an ordinary write no longer succeeds through the route");

  const big = await api(app, "me/prefs", {
    method: "PATCH",
    body: JSON.stringify({ note: "x".repeat(9_000) }),
  }, token);
  assert.equal(big.status, 413, "a genuine ceiling should still be 413");
  assert.match(big.json.error, /too large/i);
});
