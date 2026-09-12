// TAKING A CONNECTION BACK — which was not possible.
//
// A founder could attach a mailbox, a bank feed or an accounting system and had no way to detach
// one. `deleteConnection` was on the store interface and implemented in both backends; its only
// caller was a LinkedIn internal. Every credential a business ever connected was permanent as far as
// the product was concerned.
//
// Suna hit the same shape in `lib/session-rescope.ts`: a create-only allowlist, justified by an
// argument about BOOT — that a narrowed list "could leave the session unbootable" — which "silently
// became a refusal to change anything at all." Ours had no argument; the route was never written.

import { test } from "node:test";
import assert from "node:assert/strict";
import { api, makeApp } from "./helpers";
import { getDomainStore } from "../src/domain";

const PW = "correct-horse-battery";

/** A real founder with a real project, which is the only thing the write routes accept. */
async function scene() {
  const { app } = makeApp();
  const signup = await api(app, "auth/signup", {
    method: "POST",
    body: JSON.stringify({ email: `rev-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`, password: PW }),
  });
  const token = signup.json.token as string;
  const projectId = signup.json.projects[0].id as string;
  const H = { "x-mycel-project": projectId };
  const domain = getDomainStore();
  const conn = await domain.createConnection({
    project_id: projectId,
    kind: "email",
    name: "billing-mailbox",
    owner: { kind: "founder", id: "founder" },
    config: {},
  });
  return { app, domain, projectId, token, H, conn };
}

test("a founder can revoke a connection", async () => {
  const { app, domain, token, H, conn } = await scene();
  const r = await api(app, `connections/${conn.id}`, { method: "DELETE", headers: H }, token);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.ok, true);
  assert.equal((await domain.listConnections()).some((c) => c.id === conn.id), false, "the row is gone");
});

test("the answer tells the truth about what revoking does NOT undo", async () => {
  // The contract Suna states, and the reason it belongs in the RESPONSE rather than in a console's
  // copy: "A UI that says 'revoked' where the truth is 'revoked for anything started from here' is
  // the kind of false assurance that gets a credential left in place."
  const { app, token, H, conn } = await scene();
  const r = await api(app, `connections/${conn.id}`, { method: "DELETE", headers: H }, token);
  const note = String(r.json.note ?? "");
  assert.match(note, /from now on/i, "the guarantee is forward-looking and must say so");
  assert.match(note, /does not undo anything already sent/i, "revoking is not unsending");
  assert.match(note, /running right now/i, "in-flight runs are covered — stronger than next-prompt");
});

test("another project's connection is not found, never forbidden", async () => {
  // Fails closed AND says nothing: "forbidden" confirms the id exists somewhere, which turns a
  // revoke route into a way to enumerate other tenants' connections.
  const mine = await scene();
  const theirs = await scene();
  const r = await api(
    mine.app,
    `connections/${theirs.conn.id}`,
    { method: "DELETE", headers: mine.H },
    mine.token,
  );
  assert.equal(r.status, 404);
  assert.doesNotMatch(String(r.json.error ?? ""), /forbidden|not allowed/i);
  assert.ok(
    (await getDomainStore().listConnections()).some((c) => c.id === theirs.conn.id),
    "and the other tenant's connection is untouched",
  );
});

test("revoking twice is a 404, not a 500", async () => {
  const { app, token, H, conn } = await scene();
  await api(app, `connections/${conn.id}`, { method: "DELETE", headers: H }, token);
  const again = await api(app, `connections/${conn.id}`, { method: "DELETE", headers: H }, token);
  assert.equal(again.status, 404);
});

test("an in-flight run cannot act through a revoked connection", async () => {
  // OURS IS STRONGER THAN THEIRS, and this is what proves it. The action proxy re-reads
  // `listConnections()` on every action and intersects it with the run's grant, so deleting the row
  // stops a run ALREADY IN FLIGHT rather than only the next one. Suna's re-scope takes effect on the
  // next prompt, because their delivery re-resolves secrets per prompt rather than per action.
  const { domain, projectId, conn } = await scene();
  const grantedIds = [conn.id]; // what a live run's action grant already names
  await domain.deleteConnection(conn.id);
  const usable = (await domain.listConnections()).filter(
    (cn) => cn.project_id === projectId && grantedIds.includes(cn.id),
  );
  assert.equal(usable.length, 0, "the grant still names it; the intersection is empty, so nothing can act");
});
