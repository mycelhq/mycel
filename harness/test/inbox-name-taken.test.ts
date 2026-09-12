/**
 * ═══ THE PROVIDER TOLD US HOW TO FIX IT ═══
 *
 * A real response, captured provisioning the first mailbox this system has ever had (6 September):
 * asking AgentMail for `hello` returned HTTP 403 with a body naming three usernames that were
 * actually free. The route turned that into a 502 carrying 300 characters of escaped JSON.
 *
 * Both halves were wrong. 502 says "our server broke" about a founder typing a name somebody else
 * has — a form cannot render that as a field error. And the suggestions, which ARE the answer,
 * arrived unreadable.
 *
 * One AgentMail account serves every tenant here, so "taken" is not an edge case: it is what
 * happens the second time anyone asks for `hello` or `billing`, which are the first two names a
 * founder tries.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { inboxNameTaken } from "../src/agentmail";

/** Verbatim from production, truncated at 300 chars the way `call()` truncates it. */
const REAL = `AgentMail HTTP 403: {"name":"IsTakenError","code":"resource_taken","message":"Inbox is taken","fix":"The requested inbox is already in use. Retry with a different value — these usernames are currently available: hello7096, hello2689, hello8578.","suggestions":["hello7096","hello2689","hello8578"],"docs":"https://docs.a`;

test("a taken username is recognised, and its suggestions survive", () => {
  const r = inboxNameTaken(REAL);
  assert.equal(r.taken, true, "the real 403 was not recognised as a taken name");
  assert.deepEqual(r.suggestions, ["hello7096", "hello2689", "hello8578"]);
});

test("a truncated body still names the problem, even with no suggestions left", () => {
  // `call()` slices at 300 characters and the real body is 320, so the array is often cut. At 260
  // the cut lands exactly on `"suggestions":` — there is genuinely nothing to recover, and the
  // honest behaviour is to still say the name is taken. My first version of this asserted a
  // suggestion survived; that was the test being wrong, not the parser, and bending the parser to
  // satisfy it would have invented data.
  const r = inboxNameTaken(REAL.slice(0, 260));
  assert.equal(r.taken, true, "truncation lost the error identity — the founder gets a 502 instead of a field error");
  assert.deepEqual(r.suggestions, [], "a suggestion appeared out of a body that does not contain one");

  // Cut later, after the first value, and it comes back.
  const partial = inboxNameTaken(REAL.slice(0, 285));
  assert.equal(partial.taken, true);
  assert.ok(partial.suggestions.length >= 1, "a body carrying a whole suggestion still yielded none");
  for (const s of partial.suggestions) assert.match(s, /^[a-z0-9._-]{1,64}$/, `"${s}" is not a username`);
});

test("an unrelated failure is not reported as a taken name", () => {
  // The dangerous direction: a real outage rendered to the founder as "pick another name" sends
  // them typing variations at a service that is down.
  for (const other of [
    "AgentMail HTTP 500: {\"message\":\"internal error\"}",
    "could not reach AgentMail: timeout after 15000ms",
    "AgentMail HTTP 401: {\"name\":\"UnauthorizedError\",\"message\":\"bad key\"}",
    "",
  ]) {
    assert.equal(inboxNameTaken(other).taken, false, `misread as a taken name: ${other.slice(0, 40)}`);
  }
});

test("the route answers 409 with the suggestions, not 502 with a blob", () => {
  // Read as source: the branch runs only against a live AgentMail 403, and the thing worth holding
  // is that the status is a client error and the suggestions reach the body.
  const src = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8")
    .split("\n").filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//")).join("\n");
  const i = src.indexOf("inboxNameTaken(res.detail)");
  assert.ok(i > -1, "the route no longer consults inboxNameTaken");
  const branch = src.slice(i, i + 700);
  assert.match(branch, /409/, "a taken username still answers with something other than 409");
  assert.match(branch, /suggestions/, "the suggestions do not reach the response body");
  assert.match(branch, /agentmail\.username_taken/, "no stable code for a form to switch on");
});
