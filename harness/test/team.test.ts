import { test } from "node:test";
import assert from "node:assert/strict";
import { api, makeApp } from "./helpers";
import { getIdentityStore } from "../src/identity";

const PW = "a-long-enough-password";

/** Sign a fresh founder up and return a helper that calls the API as them. */
async function founder(app: ReturnType<typeof makeApp>["app"], email: string) {
  const r = await api(app, "auth/signup", { method: "POST", body: JSON.stringify({ email, password: PW }) });
  assert.equal(r.status, 201, r.text);
  const session = r.json.token as string;
  return {
    session,
    call: (path: string, opts: RequestInit = {}) => api(app, path, opts, session),
  };
}

test("team: an invite creates an account in the inviting org, once", async () => {
  const { app } = makeApp();
  const boss = await founder(app, `boss-${Date.now()}@example.com`);

  const invited = await boss.call("team/invites", {
    method: "POST",
    body: JSON.stringify({ email: "Bookkeeper@Example.com", role: "operator" }),
  });
  assert.equal(invited.status, 201, invited.text);
  const token = invited.json.token as string;
  assert.match(token, /^minv_/);
  assert.equal(invited.json.invite.email, "bookkeeper@example.com", "normalised, so a re-invite matches");
  // The raw token must never be readable afterwards — it is a credential, and the product's email
  // is the only copy.
  assert.ok(!JSON.stringify(invited.json.invite).includes(token), "the invite row carries no raw token");

  // Anyone holding the link sees who it's from before committing to anything, with no session.
  const peek = await api(app, `invites/${token}`, {}, "no-such-key");
  assert.equal(peek.status, 200, "the invite page needs no credential but the token");
  assert.equal(peek.json.email, "bookkeeper@example.com");
  assert.equal(peek.json.role, "operator");

  const accepted = await api(app, `invites/${token}/accept`, {
    method: "POST",
    body: JSON.stringify({ password: PW }),
  }, "no-such-key");
  assert.equal(accepted.status, 201, accepted.text);
  assert.equal(accepted.json.member.role, "operator");
  assert.equal(accepted.json.member.org_id, invited.json.invite.org_id, "they land in the inviting org");

  // Single use. A link that works twice is a link an attacker can reuse from a mailbox they saw.
  const replay = await api(app, `invites/${token}/accept`, {
    method: "POST",
    body: JSON.stringify({ password: PW }),
  }, "no-such-key");
  assert.equal(replay.status, 404);

  // And they can now sign in and see the same org's projects.
  const login = await api(app, "auth/login", {
    method: "POST",
    body: JSON.stringify({ email: "bookkeeper@example.com", password: PW }),
  });
  assert.equal(login.status, 200);
  assert.deepEqual(
    login.json.projects.map((p: { id: string }) => p.id),
    (await boss.call("projects")).json.map((p: { id: string }) => p.id),
    "the same projects, because it is the same org",
  );
});

test("team: an operator cannot change who else is in the team", async () => {
  const { app } = makeApp();
  const boss = await founder(app, `boss2-${Date.now()}@example.com`);
  const inv = await boss.call("team/invites", {
    method: "POST",
    body: JSON.stringify({ email: `staff-${Date.now()}@example.com`, role: "operator" }),
  });
  const staff = await api(app, `invites/${inv.json.token}/accept`, {
    method: "POST",
    body: JSON.stringify({ password: PW }),
  }, "nokey");
  const staffSession = staff.json.token as string;

  // This is the actual privilege boundary: an operator can run the business, not staff it.
  const attempt = await api(app, "team/invites", {
    method: "POST",
    body: JSON.stringify({ email: "outsider@example.com", role: "admin" }),
  }, staffSession);
  assert.equal(attempt.status, 403, attempt.text);

  const kick = await api(app, `team/members/${staff.json.member.id}`, { method: "DELETE" }, staffSession);
  assert.equal(kick.status, 403);

  // They can still see the roster — knowing who might approve your work is not privileged.
  const team = await api(app, "team", {}, staffSession);
  assert.equal(team.status, 200);
  assert.equal(team.json.can_manage, false);
  assert.equal(team.json.members.length, 2);
  assert.equal(team.json.invites.length, 0, "pending invitations are the manager's business only");
});

test("team: a product API key cannot staff the org", async () => {
  // A key lives in an environment variable on some box. One leaking should cost you the machine
  // surface, not a permanent human login with an approval right.
  const { app } = makeApp();
  const r = await api(app, "team/invites", {
    method: "POST",
    body: JSON.stringify({ email: "attacker@example.com", role: "admin" }),
  });
  assert.equal(r.status, 403);
  assert.match(r.json.error, /member session/);
});

test("team: the owner is not demotable, removable, or grantable by invitation", async () => {
  const { app } = makeApp();
  const email = `boss3-${Date.now()}@example.com`;
  const boss = await founder(app, email);
  const me = (await boss.call("me")).json.member;

  const demote = await boss.call(`team/members/${me.id}`, { method: "PATCH", body: JSON.stringify({ role: "viewer" }) });
  assert.equal(demote.status, 400);
  assert.match(demote.json.error, /owner/);

  const remove = await boss.call(`team/members/${me.id}`, { method: "DELETE" });
  assert.equal(remove.status, 400, "removing yourself would strand the org");

  // Asking for a second owner is refused at the boundary rather than quietly downgraded, so the
  // caller finds out that "admin" is the thing they actually want.
  const inv = await boss.call("team/invites", {
    method: "POST",
    body: JSON.stringify({ email: `second-${Date.now()}@example.com`, role: "owner" }),
  });
  assert.equal(inv.status, 400);
  assert.match(inv.json.error, /one owner/);

  // And the store demotes anyway if something reaches it directly — the HTTP check is the message,
  // not the guarantee.
  const id = getIdentityStore();
  const direct = id.invite({ orgId: me.org_id, email: `third-${Date.now()}@example.com`, role: "owner", invitedBy: me.id });
  assert.ok(!("error" in direct));
  assert.equal((direct as { invite: { role: string } }).invite.role, "admin");
});

test("team: removing a member kills their session immediately", async () => {
  const { app } = makeApp();
  const boss = await founder(app, `boss4-${Date.now()}@example.com`);
  const inv = await boss.call("team/invites", {
    method: "POST",
    body: JSON.stringify({ email: `temp-${Date.now()}@example.com`, role: "viewer" }),
  });
  const joined = await api(app, `invites/${inv.json.token}/accept`, {
    method: "POST",
    body: JSON.stringify({ password: PW }),
  }, "nokey");
  const theirSession = joined.json.token as string;
  assert.equal((await api(app, "me", {}, theirSession)).json.member.email, joined.json.member.email);

  const removed = await boss.call(`team/members/${joined.json.member.id}`, { method: "DELETE" });
  assert.equal(removed.status, 200, removed.text);

  // Revoking access has to take effect now, not in twelve hours when the session TTL runs out.
  assert.equal((await api(app, "me", {}, theirSession)).status, 401, "the session dies with the member");
});

test("team: re-inviting replaces the outstanding link rather than piling them up", async () => {
  const { app } = makeApp();
  const boss = await founder(app, `boss5-${Date.now()}@example.com`);
  const email = `again-${Date.now()}@example.com`;
  const first = await boss.call("team/invites", { method: "POST", body: JSON.stringify({ email }) });
  const second = await boss.call("team/invites", { method: "POST", body: JSON.stringify({ email }) });

  assert.equal((await boss.call("team")).json.invites.length, 1, "one row per invited address");
  // The superseded link must stop working — otherwise every resend leaves another live credential
  // in another mailbox.
  assert.equal((await api(app, `invites/${first.json.token}`, {}, "nokey")).status, 404);
  assert.equal((await api(app, `invites/${second.json.token}`, {}, "nokey")).status, 200);

  const revoked = await boss.call(`team/invites/${second.json.invite.id}`, { method: "DELETE" });
  assert.equal(revoked.status, 200);
  assert.equal((await api(app, `invites/${second.json.token}`, {}, "nokey")).status, 404);
});

test("team: an invite from another org cannot be revoked with its id", async () => {
  const { app } = makeApp();
  const a = await founder(app, `orga-${Date.now()}@example.com`);
  const b = await founder(app, `orgb-${Date.now()}@example.com`);
  const inv = await a.call("team/invites", {
    method: "POST",
    body: JSON.stringify({ email: `x-${Date.now()}@example.com` }),
  });

  const cross = await b.call(`team/invites/${inv.json.invite.id}`, { method: "DELETE" });
  assert.equal(cross.status, 404, "another tenant's id must miss, not delete");
  assert.equal((await api(app, `invites/${inv.json.token}`, {}, "nokey")).status, 200, "still live");
  assert.equal((await b.call("team")).json.invites.length, 0, "and invisible to them");
});

test("team: an expired invite is shown in the queue but does not work", () => {
  const id = getIdentityStore();
  const { org } = id.createOrgWithOwner("expiry-co", `exp-${Date.now()}@example.com`, PW);
  const out = id.invite({
    orgId: org.id,
    email: `late-${Date.now()}@example.com`,
    role: "viewer",
    invitedBy: "someone",
    ttlMs: -1,
  });
  assert.ok(!("error" in out));
  const { token, invite } = out as { token: string; invite: { id: string } };

  assert.equal(id.peekInvite(token), undefined, "expired means expired");
  assert.equal(id.acceptInvite(token, PW), undefined);
  // Still listed, deliberately: hiding it makes "I never got the email" impossible to diagnose,
  // and the fix is to resend rather than to wonder.
  const listed = id.listInvites(org.id).find((i) => i.id === invite.id);
  assert.ok(listed, "still in the queue");
  assert.equal(listed!.expired, true);
});
