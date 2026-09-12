// What the post-signup flow leans on: per-member preferences that outlive a browser, and a wedge
// catalogue honest enough to tell a founder "no".
//
// Both are new surface added for onboarding, and both have a failure mode that is invisible until
// it matters — prefs that silently don't persist look exactly like prefs that do until someone
// opens a second device, and a catalogue that over-reports looks fine until a founder clicks
// "set this up" on a wedge that isn't there.
import { test } from "node:test";
import assert from "node:assert/strict";
import { api, makeApp } from "./helpers";

const PW = "a-long-enough-password";

/** Sign a fresh founder up and return a helper that calls the API as them. */
async function founder(app: ReturnType<typeof makeApp>["app"], email: string) {
  const r = await api(app, "auth/signup", {
    method: "POST",
    body: JSON.stringify({ email, password: PW }),
  });
  assert.equal(r.status, 201, r.text);
  const session = r.json.token as string;
  return {
    session,
    call: (path: string, opts: RequestInit = {}) => api(app, path, opts, session),
  };
}

test("prefs: a member's own UI state is stored, merged, and read back from /v1/me", async () => {
  const { app } = makeApp();
  const email = `prefs-${Date.now()}@example.com`;
  const me = await founder(app, email);

  // A brand-new member has no prefs at all — which is precisely what makes onboarding show its
  // first screen. `{}` and `undefined` must both read as "we've never asked".
  const before = await me.call("me");
  assert.equal(before.json.member.prefs ?? undefined, undefined, "nothing is assumed about a new member");

  const named = await me.call("me/prefs", { method: "PATCH", body: JSON.stringify({ name: "Ada" }) });
  assert.equal(named.status, 200, named.text);
  assert.equal(named.json.prefs.name, "Ada");

  // THE MERGE IS THE POINT. Onboarding writes `name` on one screen and `onboarded` on another, and
  // the product tour writes `tour_done` from a third place entirely. If a PATCH replaced the object
  // the last writer would silently erase the others — and the symptom would be onboarding
  // reappearing for someone who finished it, which is the exact promise this exists to keep.
  const done = await me.call("me/prefs", {
    method: "PATCH",
    body: JSON.stringify({ onboarded: true }),
  });
  assert.equal(done.status, 200, done.text);
  assert.equal(done.json.prefs.name, "Ada", "the earlier field survives a later write");
  assert.equal(done.json.prefs.onboarded, true);

  const after = await me.call("me");
  assert.equal(after.json.member.prefs.name, "Ada");
  assert.equal(after.json.member.prefs.onboarded, true);

  // It is on the MEMBER, not on the session — so a fresh sign-in, which is what a second device or
  // a cleared cache looks like from here, sees it too. This is the whole reason it isn't a cookie:
  // "we won't ask you that again" has to survive changing browsers.
  const second = await api(app, "auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password: PW }),
  });
  assert.equal(second.status, 200, second.text);
  const elsewhere = await api(app, "me", {}, second.json.token as string);
  assert.equal(elsewhere.json.member.prefs.onboarded, true, "a new session sees the same person's state");

  // `null` deletes, which is the only way to remove a key under a merge.
  const cleared = await me.call("me/prefs", { method: "PATCH", body: JSON.stringify({ name: null }) });
  assert.equal(cleared.status, 200, cleared.text);
  assert.equal("name" in cleared.json.prefs, false, "null removes the key rather than storing null");
  assert.equal(cleared.json.prefs.onboarded, true, "and touches nothing else");
});

test("prefs: an avatar is stored beside the rest of a person's UI state, and is never validated here", async () => {
  const { app } = makeApp();
  const me = await founder(app, `avatar-${Date.now()}@example.com`);

  const set = await me.call("me/prefs", {
    method: "PATCH",
    body: JSON.stringify({
      name: "Ada",
      avatar_url: "https://lh3.googleusercontent.com/a/abc123=s96-c",
    }),
  });
  assert.equal(set.status, 200, set.text);
  assert.equal(set.json.prefs.avatar_url, "https://lh3.googleusercontent.com/a/abc123=s96-c");

  // Written on every sign-in, so it has to overwrite rather than accumulate — people change their
  // picture, and a face three employers out of date is worse than no face.
  const again = await me.call("me/prefs", {
    method: "PATCH",
    body: JSON.stringify({ avatar_url: "https://avatars.githubusercontent.com/u/42?v=4" }),
  });
  assert.equal(again.json.prefs.avatar_url, "https://avatars.githubusercontent.com/u/42?v=4");
  assert.equal(again.json.prefs.name, "Ada", "and does not disturb the rest of the person");

  // THE POINT OF THIS ASSERTION. The kernel accepts this string happily — `prefs` is free-form and
  // written by whoever holds the session, so nothing here can tell a provider CDN from a tracking
  // pixel. That means the value is a CLAIM, and the host allowlist deciding whether a browser is
  // ever asked to fetch it lives in the product (`cloud/lib/oauth.ts`, `safeAvatarUrl`). If this
  // ever starts returning a 400, someone has moved that boundary and the product's check is now the
  // second line of defence rather than the only one.
  const hostile = await me.call("me/prefs", {
    method: "PATCH",
    body: JSON.stringify({ avatar_url: "http://tracker.example.com/pixel.gif" }),
  });
  assert.equal(hostile.status, 200, "the kernel has no opinion here — the renderer must");
  assert.equal(hostile.json.prefs.avatar_url, "http://tracker.example.com/pixel.gif");

  const read = await me.call("me");
  assert.equal(read.json.member.prefs.avatar_url, "http://tracker.example.com/pixel.gif");
});

test("prefs: bounded, and never writable by something with no person behind it", async () => {
  const { app } = makeApp();
  const me = await founder(app, `bounds-${Date.now()}@example.com`);

  // A product API key is a machine. There is no person whose preferences these would be, and
  // writing them onto whichever member happened to be handy would attribute a machine's state to a
  // human.
  const asKey = await api(app, "me/prefs", { method: "PATCH", body: JSON.stringify({ name: "nope" }) });
  assert.equal(asKey.status, 403, "a key has no preferences to set");

  // Not an unbounded self-service key-value store attached to auth. Refused whole rather than
  // truncated: a pref that came back different from what was sent is worse than one that visibly
  // failed, because the product would render the truncation believing it stored the real thing.
  const tooMany: Record<string, string> = {};
  for (let i = 0; i < 40; i++) tooMany[`k${i}`] = "x";
  const many = await me.call("me/prefs", { method: "PATCH", body: JSON.stringify(tooMany) });
  assert.equal(many.status, 413, many.text);

  const huge = await me.call("me/prefs", {
    method: "PATCH",
    body: JSON.stringify({ note: "x".repeat(9000) }),
  });
  assert.equal(huge.status, 413, huge.text);

  // A refused write leaves nothing behind.
  const still = await me.call("me");
  assert.equal(still.json.member.prefs ?? undefined, undefined, "a rejected patch stores nothing");

  // A body that isn't an object of keys is a 400, not a silent no-op.
  const bad = await me.call("me/prefs", { method: "PATCH", body: JSON.stringify(["name"]) });
  assert.equal(bad.status, 400);
});

test("wedges: the catalogue reports what can actually be run, with the jobs that say what it does", async () => {
  const { app } = makeApp();
  const me = await founder(app, `cat-${Date.now()}@example.com`);

  const r = await me.call("wedges");
  assert.equal(r.status, 200, r.text);
  assert.ok(Array.isArray(r.json), "a list, even when the wedges dir is missing");

  // Nothing is asserted about WHICH wedges are installed — that is a deployment's business, and a
  // test that pins it breaks every time someone adds one. What matters is the shape, because the
  // onboarding flow reconciles the shaping agent's capability claim against exactly these fields:
  // a wedge absent from this list is downgraded to "we can't run this".
  for (const w of r.json) {
    assert.equal(typeof w.wedge, "string");
    assert.ok(w.wedge.length > 0);
    assert.equal(typeof w.title, "string");
    assert.ok(Array.isArray(w.jobs), "jobs is what a founder's description gets matched against");
    for (const j of w.jobs) {
      assert.equal(typeof j.task_type, "string");
      assert.equal(typeof j.description, "string");
    }
    assert.ok(Array.isArray(w.connections));
    // `blueprint` is present only when one exists. Onboarding puts a one-click "set this up" button
    // in front of it, so a fabricated slug here would be a button in front of a 404.
    if (w.blueprint !== undefined) assert.equal(typeof w.blueprint, "string");
  }

  // Every slug the catalogue reports must be loadable, or the claim is empty.
  for (const w of r.json.slice(0, 3)) {
    const one = await me.call(`wedges/${w.wedge}`);
    assert.equal(one.status, 200, `${w.wedge} is listed, so it must load`);
  }
});
