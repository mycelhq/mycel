// The fulfilment loop, end to end and at each boundary. Read deliverables.ts first — the state
// machine and the authority argument are there.
//
// Every test below names the bug it prevents. The three that matter most are the tenant boundary
// (a client reading another project's work), the founder's gate (a client seeing work before it was
// released) and the version history (a revision that overwrites the thing the client argued with),
// because those are the three that are silent when they break.
import { test } from "node:test";
import assert from "node:assert/strict";
import { api, makeApp } from "./helpers";
import { getDomainStore } from "../src/domain";
import { _resetPortal } from "../src/portal";
import { _resetBilling, getBillingStore } from "../src/billing";
import {
  _resetDeliverables,
  DELIVERABLE_STATES,
  deliverableKindFault,
  getDeliverableStore,
  payloadFault,
  visibleVersions,
} from "../src/deliverables";
import { moveAuthorityForProject, proposeMoves } from "../src/moves";
import { getRequestStore } from "../src/requests";
import { evaluateWait } from "../src/waits";

const OWNER_EMAIL = process.env.MYCEL_OWNER_EMAIL || "owner@test.co";
const OWNER_PW = process.env.MYCEL_OWNER_PASSWORD || "secret";

const CASE_WEDGE = "books-keeper";

/**
 * A project with two clients, each with a live portal session, and a case per client.
 *
 * Built through the HTTP surface wherever a route exists, because the routes are what the bugs live
 * in — a test that writes deliverables straight into the store proves the store works and proves
 * nothing about the plane that is supposed to be guarding it.
 */
async function world() {
  _resetPortal();
  _resetBilling();
  _resetDeliverables();
  const { app, store } = makeApp();
  const projectId = (await api(app, "me")).json.projects[0].id as string;
  const domain = getDomainStore();

  const mk = async (name: string) => {
    const client = await domain.createClient({
      project_id: projectId,
      display_name: name,
      handles: [`${name}@d.test`],
      metadata: {},
    });
    const kase = await domain.createCase({
      project_id: projectId,
      wedge: CASE_WEDGE,
      title: `${name} engagement`,
      client_id: client.id,
      stage: "open",
      status: "open",
      data: {},
    });
    const link = await api(app, `clients/${client.id}/portal-link`, { method: "POST" });
    const token = (
      await api(app, "portal/session", { method: "POST", body: JSON.stringify({ token: link.json.token }) })
    ).json.token as string;
    return { client, kase, h: { authorization: `Bearer ${token}` } };
  };

  const login = await app.request("/v1/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PW }),
  });
  const memberToken = (await login.json()).token as string;

  return { app, store, projectId, domain, memberToken, a: await mk("acme"), b: await mk("beta") };
}

/** A task attributed to a client and its case — what an agent run looks like from the store's side. */
async function taskFor(app: any, projectId: string, clientId: string, caseId: string): Promise<string> {
  const t = await api(app, "tasks", {
    method: "POST",
    headers: { "x-mycel-project": projectId },
    body: JSON.stringify({
      wedge: CASE_WEDGE,
      task_type: "monthly_close",
      input: {},
      client_id: clientId,
      case_id: caseId,
      actor: { kind: "user", id: clientId },
    }),
  });
  assert.equal(t.status, 201, t.text);
  return t.json.id as string;
}

/** An artifact on that task — the payload a deliverable actually carries. */
async function artifactOn(store: any, taskId: string, name: string): Promise<string> {
  const a = await store.addArtifact({
    task_id: taskId,
    name,
    content_type: "text/plain",
    content: `contents of ${name}`,
  });
  return a.id as string;
}

/** Create a deliverable and submit v1, exactly as an agent run does — via the action grant plane. */
async function agentSubmit(
  app: any,
  store: any,
  taskId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: any; text: string }> {
  // A real action grant, exactly as `runTask` mints one. The agent plane has no other identity, so
  // a test that bypassed it would prove nothing about the boundary the grant is there to draw.
  const { registerActionGrant } = await import("../src/actiongrants");
  const token = await registerActionGrant({ task_id: taskId, connectionIds: [] });
  const res = await app.request("/v1/internal/deliverables", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-json */
  }
  return { status: res.status, json, text };
}

// ── the vocabulary ───────────────────────────────────────────────────────────────────────────────

test("deliverables: an unknown kind is refused by name, not silently rendered as nothing", () => {
  // THE BUG: an open string set means `kind: "docuemnt"` produces a deliverable that exists, shows
  // in the founder's list and reads as delivered, while every renderer falls through to nothing.
  // Worse than the refusal, because the work looks done.
  assert.equal(deliverableKindFault("document"), undefined);
  assert.match(deliverableKindFault("docuemnt")!, /did you mean "document"/);
  assert.match(deliverableKindFault("website")!, /known kinds: document, file_set, link/);
});

test("deliverables: a kind's payload requirement is enforced, so no card points at nothing", () => {
  // THE BUG this repo names in every header: something failing while reporting success. A `link`
  // deliverable released with no URL is a button in a client's portal that does nothing, and every
  // surface upstream says the work was delivered.
  assert.match(payloadFault("link", { artifact_ids: [] })!, /needs a url/);
  assert.match(payloadFault("link", { url: "http://insecure.test" })!, /must be https/);
  assert.equal(payloadFault("link", { url: "https://site.test" }), undefined);
  assert.match(payloadFault("document", { artifact_ids: ["a", "b"] })!, /exactly one file/);
  assert.match(payloadFault("file_set", { artifact_ids: [] })!, /at least one file/);
  assert.equal(payloadFault("document", { artifact_ids: ["a"] }), undefined);
});

test("deliverables: no state a client may not see has a client sentence", () => {
  // THE BUG: "your architect has finished something and is not showing it to you" is worse than
  // silence. `client_sees: null` is the fact, written once, next to the state — this pins it so a
  // later edit that gives `in_review` a friendly label fails here rather than in a customer's inbox.
  assert.equal(DELIVERABLE_STATES.drafting.client_sees, null);
  assert.equal(DELIVERABLE_STATES.in_review.client_sees, null);
  assert.ok(DELIVERABLE_STATES.with_client.client_sees);
  assert.ok(DELIVERABLE_STATES.accepted.client_sees);
});

// ── the founder's gate ───────────────────────────────────────────────────────────────────────────

test("deliverables: the founder's approval cannot be bypassed — an unreleased version is invisible and unreachable", async () => {
  // THE BUG, and the one this whole design is arranged around: work reaching a client before the
  // founder released it. Checked at THREE surfaces, because a filter applied to the list and
  // forgotten on the by-id route is exactly how this repo has leaked before.
  const { app, store, projectId, a } = await world();
  const taskId = await taskFor(app, projectId, a.client.id, a.kase.id);
  const artifact = await artifactOn(store, taskId, "draft.txt");

  const made = await agentSubmit(app, store, taskId, {
    title: "Q1 accounts",
    kind: "document",
    summary: "first pass",
    artifact_ids: [artifact],
  });
  assert.equal(made.status, 201, made.text);
  const id = made.json.deliverable.id as string;
  assert.equal(made.json.deliverable.status, "in_review", "an agent submits for review, it does not release");

  // 1. The list does not mention it.
  const list = await api(app, "portal/deliverables", { headers: a.h });
  assert.equal(list.status, 200);
  assert.equal(list.json.deliverables.length, 0, "an unreleased deliverable is not an empty card, it is nothing");

  // 2. The by-id route does not serve it, even to the client who owns it.
  const byId = await api(app, `portal/deliverables/${id}`, { headers: a.h });
  assert.equal(byId.status, 404, "guessing the id must not route around the gate");

  // 3. Its bytes are not downloadable.
  const file = await api(app, `portal/deliverables/${id}/files/${artifact}`, { headers: a.h });
  assert.equal(file.status, 404);

  // 4. And there is NO client-plane route that could release it. The client cannot accept either.
  const accept = await api(app, `portal/deliverables/${id}/accept`, { method: "POST", headers: a.h, body: "{}" });
  assert.equal(accept.status, 404, "a client cannot act on work they are not allowed to see");

  // The founder releases. Now, and only now, all three surfaces open.
  const rel = await api(app, `deliverables/${id}/release`, {
    method: "POST",
    headers: { "x-mycel-project": projectId },
    body: "{}",
  });
  assert.equal(rel.status, 200, rel.text);
  assert.equal(rel.json.deliverable.status, "with_client");

  const list2 = await api(app, "portal/deliverables", { headers: a.h });
  assert.equal(list2.json.deliverables.length, 1);
  assert.equal(list2.json.deliverables[0].can_act, true);
  const file2 = await api(app, `portal/deliverables/${id}/files/${artifact}`, { headers: a.h });
  assert.equal(file2.status, 200);
  assert.match(file2.text, /contents of draft.txt/);
});

test("deliverables: a rejected version stays unreleased, and the next release does not resurrect it", async () => {
  // THE BUG: "release" stamping the deliverable rather than the version, so sending v2 would make
  // the v1 the founder had rejected downloadable too.
  const { app, store, projectId, a } = await world();
  const taskId = await taskFor(app, projectId, a.client.id, a.kase.id);
  const bad = await artifactOn(store, taskId, "bad.txt");
  const good = await artifactOn(store, taskId, "good.txt");

  const made = await agentSubmit(app, store, taskId, { title: "Report", kind: "document", summary: "v1", artifact_ids: [bad] });
  const id = made.json.deliverable.id as string;
  const hdr = { "x-mycel-project": projectId };

  const rejected = await api(app, `deliverables/${id}/reject`, { method: "POST", headers: hdr, body: JSON.stringify({ note: "wrong period" }) });
  assert.equal(rejected.status, 200, rejected.text);
  assert.equal(rejected.json.deliverable.status, "drafting");

  await agentSubmit(app, store, taskId, { deliverable_id: id, summary: "v2", artifact_ids: [good] });
  await api(app, `deliverables/${id}/release`, { method: "POST", headers: hdr, body: "{}" });

  const seen = await api(app, `portal/deliverables/${id}`, { headers: a.h });
  assert.equal(seen.status, 200, seen.text);
  assert.deepEqual(
    seen.json.versions.map((v: any) => v.version),
    [2],
    "only the released version crosses; the rejected v1 stays on the founder's side",
  );
  const denied = await api(app, `portal/deliverables/${id}/files/${bad}`, { headers: a.h });
  assert.equal(denied.status, 404, "the rejected draft's bytes are still unreachable");
});

// ── the tenant boundary ──────────────────────────────────────────────────────────────────────────

test("deliverables: a client cannot read or act on another project's deliverable", async () => {
  // THE BUG, and the exact shape of both cross-tenant leaks this repo has shipped: an id from a URL
  // resolved without the caller's project pushed into the read. A SECOND REAL PROJECT in the same
  // process, not a second server — the harder and truer case, because both tenants share every
  // singleton and nothing about the id says which one it belongs to.
  const { app, store, projectId, domain, memberToken, a, b } = await world();

  const other = (await api(app, "projects", { method: "POST", body: JSON.stringify({ name: "other-co" }) }, memberToken)).json;
  const otherProject = other.project.id as string;
  const otherClient = await domain.createClient({
    project_id: otherProject,
    display_name: "outsider",
    handles: ["outsider@d.test"],
    metadata: {},
  });
  const otherLink = await api(app, `clients/${otherClient.id}/portal-link`, {
    method: "POST",
    headers: { "x-mycel-project": otherProject },
  }, other.api_key);
  assert.equal(otherLink.status, 201, otherLink.text);
  const otherSession = await api(app, "portal/session", { method: "POST", body: JSON.stringify({ token: otherLink.json.token }) });
  assert.equal(otherSession.status, 200, otherSession.text);
  const otherToken = otherSession.json.token as string;
  const outsider = { authorization: `Bearer ${otherToken}` };

  const taskId = await taskFor(app, projectId, a.client.id, a.kase.id);
  const artifact = await artifactOn(store, taskId, "theirs.txt");
  const made = await agentSubmit(app, store, taskId, {
    title: "Their accounts",
    kind: "document",
    summary: "v1",
    artifact_ids: [artifact],
  });
  const id = made.json.deliverable.id as string;
  await api(app, `deliverables/${id}/release`, { method: "POST", headers: { "x-mycel-project": projectId }, body: "{}" });

  // The owning client can see it — the control, so the 404s below mean something.
  assert.equal((await api(app, `portal/deliverables/${id}`, { headers: a.h })).status, 200);

  const verbs = [
    [`portal/deliverables/${id}`, {}],
    [`portal/deliverables/${id}/files/${artifact}`, {}],
    [`portal/deliverables/${id}/accept`, { method: "POST", body: "{}" }],
    [`portal/deliverables/${id}/request-changes`, { method: "POST", body: JSON.stringify({ request: "change it" }) }],
  ] as const;

  // ACROSS THE TENANT BOUNDARY: a valid session in another project, a real id from this one.
  for (const [path, init] of verbs) {
    const res = await api(app, path, { ...init, headers: outsider } as any);
    assert.equal(res.status, 404, `${path} must be 404 across a tenant boundary, not 403 and not 200`);
  }

  // ACROSS THE CLIENT BOUNDARY INSIDE ONE PROJECT: the second axis, and the easier one to get wrong,
  // because the project filter alone would let this through.
  for (const [path, init] of verbs) {
    const res = await api(app, path, { ...init, headers: b.h } as any);
    assert.equal(res.status, 404, `${path} leaks to the neighbouring client`);
  }

  // The outsider's own list is empty rather than filtered-after-the-fact.
  assert.deepEqual((await api(app, "portal/deliverables", { headers: outsider })).json.deliverables, []);

  // And the FOUNDER plane holds the same line: another project's key cannot read or release it.
  assert.equal((await api(app, `deliverables/${id}`, { headers: { "x-mycel-project": otherProject } }, other.api_key)).status, 404);
  assert.equal(
    (await api(app, `deliverables/${id}/release`, { method: "POST", headers: { "x-mycel-project": otherProject }, body: "{}" }, other.api_key)).status,
    404,
  );
});

test("deliverables: a version cannot carry an artifact from outside its project", async () => {
  // THE BUG: the download route asks "is this artifact listed on a released version this client
  // owns", so an artifact id copied in from another tenant at SUBMIT time would satisfy it and be
  // served. The tenant boundary therefore has to hold where the list is written.
  const one = await world();
  const two = await world();
  const foreignTask = await taskFor(two.app, two.projectId, two.a.client.id, two.a.kase.id);
  const foreign = await artifactOn(two.store, foreignTask, "someone-elses.txt");

  const taskId = await taskFor(one.app, one.projectId, one.a.client.id, one.a.kase.id);
  const res = await agentSubmit(one.app, one.store, taskId, {
    title: "Sneaky",
    kind: "document",
    summary: "v1",
    artifact_ids: [foreign],
  });
  assert.equal(res.status, 400, res.text);
  assert.match(res.json.error, /no file with id/, "and it says 'no such file' rather than confirming one exists elsewhere");
});

// ── versions ─────────────────────────────────────────────────────────────────────────────────────

test("deliverables: a revision preserves the previous version and the request that caused it", async () => {
  // THE BUG this loop exists for: revision as overwrite. "What did you change?" is the one question
  // a client asks on receiving a revision, and with the output modelled as a file it was
  // unanswerable — v2 replaced v1 and the ask that caused it was a thread message forty lines up.
  const { app, store, projectId, a } = await world();
  const taskId = await taskFor(app, projectId, a.client.id, a.kase.id);
  const v1art = await artifactOn(store, taskId, "v1.txt");
  const v2art = await artifactOn(store, taskId, "v2.txt");
  const hdr = { "x-mycel-project": projectId };

  const made = await agentSubmit(app, store, taskId, { title: "Statement of work", kind: "document", summary: "first draft", artifact_ids: [v1art] });
  const id = made.json.deliverable.id as string;
  await api(app, `deliverables/${id}/release`, { method: "POST", headers: hdr, body: "{}" });

  const asked = await api(app, `portal/deliverables/${id}/request-changes`, {
    method: "POST",
    headers: a.h,
    body: JSON.stringify({ request: "make the payment terms 30 days, not 14" }),
  });
  assert.equal(asked.status, 200, asked.text);

  const second = await agentSubmit(app, store, taskId, { deliverable_id: id, summary: "terms updated to 30 days", artifact_ids: [v2art] });
  assert.equal(second.status, 201, second.text);
  assert.equal(second.json.version.version, 2);
  await api(app, `deliverables/${id}/release`, { method: "POST", headers: hdr, body: "{}" });

  const seen = await api(app, `portal/deliverables/${id}`, { headers: a.h });
  assert.equal(seen.json.versions.length, 2, "the previous version is still there — this is the whole requirement");

  const [one, two] = seen.json.versions;
  assert.equal(one.version, 1);
  assert.equal(
    one.change_request,
    "make the payment terms 30 days, not 14",
    "the ask is attached to the version it was made AGAINST, so round three cannot overwrite round two's ask",
  );
  assert.ok(one.superseded_at, "v1 is marked superseded rather than deleted");
  assert.equal(two.version, 2);
  assert.equal(two.summary, "terms updated to 30 days");
  assert.equal(two.change_request, undefined, "the new version carries no ask of its own yet");

  // Both versions' bytes stay downloadable: "show me what changed" needs the old one too.
  assert.equal((await api(app, `portal/deliverables/${id}/files/${v1art}`, { headers: a.h })).status, 200);
  assert.equal((await api(app, `portal/deliverables/${id}/files/${v2art}`, { headers: a.h })).status, 200);
});

test("deliverables: a run cannot replace a version the client is currently looking at", async () => {
  // THE BUG: the client leaves a verdict on something that changed underneath them, and their change
  // request ends up attached to a version they never saw.
  const { app, store, projectId, a } = await world();
  const taskId = await taskFor(app, projectId, a.client.id, a.kase.id);
  const art = await artifactOn(store, taskId, "v1.txt");
  const made = await agentSubmit(app, store, taskId, { title: "Plan", kind: "document", summary: "v1", artifact_ids: [art] });
  const id = made.json.deliverable.id as string;
  await api(app, `deliverables/${id}/release`, { method: "POST", headers: { "x-mycel-project": projectId }, body: "{}" });

  const again = await agentSubmit(app, store, taskId, { deliverable_id: id, summary: "sneaky v2", artifact_ids: [art] });
  assert.equal(again.status, 409, again.text);
  assert.match(again.json.error, /with_client/);
});

// ── the client's verdict ─────────────────────────────────────────────────────────────────────────

test("deliverables: acceptance is idempotent, and a second contradictory click cannot undo it", async () => {
  // THE BUG: a double-clicked button, or a retry on a flaky connection. Last-write-wins here means
  // "accept" followed 200ms later by "request changes" leaves the work accepted AND reopened — the
  // shape that gets somebody paid for work that was not finished.
  const { app, store, projectId, a } = await world();
  const taskId = await taskFor(app, projectId, a.client.id, a.kase.id);
  const art = await artifactOn(store, taskId, "final.txt");
  const made = await agentSubmit(app, store, taskId, { title: "Accounts", kind: "document", summary: "final", artifact_ids: [art] });
  const id = made.json.deliverable.id as string;
  await api(app, `deliverables/${id}/release`, { method: "POST", headers: { "x-mycel-project": projectId }, body: "{}" });

  const first = await api(app, `portal/deliverables/${id}/accept`, { method: "POST", headers: a.h, body: JSON.stringify({ note: "perfect" }) });
  assert.equal(first.status, 200, first.text);
  assert.ok(first.json.deliverable.accepted_at);
  assert.equal(first.json.already, undefined);

  const second = await api(app, `portal/deliverables/${id}/accept`, { method: "POST", headers: a.h, body: "{}" });
  assert.equal(second.status, 200, "a retry of a request that already succeeded is not an error");
  assert.equal(second.json.already, true);
  assert.equal(
    second.json.deliverable.accepted_at,
    first.json.deliverable.accepted_at,
    "and it does not move the timestamp — an invoice may already rest on that date",
  );
  assert.equal(second.json.deliverable.versions[0].accepted_note, "perfect", "nor overwrite the note with the retry's empty one");

  const contradiction = await api(app, `portal/deliverables/${id}/request-changes`, {
    method: "POST",
    headers: a.h,
    body: JSON.stringify({ request: "actually, change it" }),
  });
  assert.equal(contradiction.status, 409, "accepted is terminal — the client cannot un-accept from the portal");

  // And the business cannot un-accept it either, which is what makes `accepted_at` worth billing on.
  const withdrawn = await api(app, `deliverables/${id}/withdraw`, {
    method: "POST",
    headers: { "x-mycel-project": projectId },
    body: JSON.stringify({ reason: "changed my mind" }),
  });
  assert.equal(withdrawn.status, 404, "work a client accepted cannot be erased from the operator plane");
});

test("deliverables: a change request must say what to change", async () => {
  // THE BUG: an empty "request changes" is a deliverable bounced back to an agent with no
  // instruction, which produces an identical v2 and a client who has to ask twice.
  const { app, store, projectId, a } = await world();
  const taskId = await taskFor(app, projectId, a.client.id, a.kase.id);
  const art = await artifactOn(store, taskId, "x.txt");
  const made = await agentSubmit(app, store, taskId, { title: "Thing", kind: "document", summary: "v1", artifact_ids: [art] });
  const id = made.json.deliverable.id as string;
  await api(app, `deliverables/${id}/release`, { method: "POST", headers: { "x-mycel-project": projectId }, body: "{}" });

  const empty = await api(app, `portal/deliverables/${id}/request-changes`, { method: "POST", headers: a.h, body: JSON.stringify({ request: "   " }) });
  assert.equal(empty.status, 400);
  assert.match(empty.json.error, /what you would like changed/);
});

// ── the client who goes quiet ────────────────────────────────────────────────────────────────────

test("deliverables: releasing parks the engagement on the client's answer, so silence is chased not forgotten", async () => {
  // THE BUG, and the most common real-world stall: a client who never comes back. Nothing here
  // invents a timer — `waits.ts` already owns "blocked on the customer", including the escalating
  // nudge ladder, the timeline notes and the ninety-day cap.
  const { app, store, projectId, domain, a } = await world();
  const taskId = await taskFor(app, projectId, a.client.id, a.kase.id);
  const art = await artifactOn(store, taskId, "sow.txt");
  const made = await agentSubmit(app, store, taskId, { title: "Scope", kind: "document", summary: "v1", artifact_ids: [art] });
  const id = made.json.deliverable.id as string;

  const rel = await api(app, `deliverables/${id}/release`, { method: "POST", headers: { "x-mycel-project": projectId }, body: "{}" });
  assert.equal(rel.status, 200, rel.text);
  assert.match(rel.json.parked, /chase them if they go quiet/);

  const waits = await domain.listWaits({ project_id: projectId, case_id: a.kase.id, status: "waiting" });
  assert.equal(waits.length, 1, "the engagement is parked");
  const wait = waits[0]!;
  assert.deepEqual(wait.conditions[0]!.kind, "deliverable_settled");
  assert.ok(wait.nudge_at, "and it will be nudged — the ladder is armed, not merely recorded");
  assert.ok(wait.expires_at, "and it gives up rather than waiting forever");

  // Still silent: pending, not satisfied, and not quietly broken either.
  assert.equal((await evaluateWait(domain, wait)).state, "pending");

  // The client answers. THE SAME WAIT now resolves — both verdicts count as an answer.
  await api(app, `portal/deliverables/${id}/accept`, { method: "POST", headers: a.h, body: "{}" });
  const verdict = await evaluateWait(domain, wait);
  assert.equal(verdict.state, "satisfied");
  assert.match((verdict as any).by, /^deliverable:.*:accepted$/);

  // The engagement's timeline says all of it, in order, in a founder's words.
  const kase = await domain.getCase(a.kase.id);
  const notes = (kase!.history ?? []).map((h) => h.note ?? "").join("\n");
  assert.match(notes, /ready for your review/i);
  assert.match(notes, /sent "Scope" v1 to your client/);
  assert.match(notes, /accepted "Scope" v1 — this can be invoiced/);
});

test("deliverables: a withdrawn deliverable breaks its wait loudly rather than parking the case for ninety days", async () => {
  // THE BUG: an engagement silently parked on a verdict that is never coming. `unresolvable` is a
  // separate verdict from `pending` for exactly this reason — see the WaitVerdict doc.
  const { app, store, projectId, domain, a } = await world();
  const taskId = await taskFor(app, projectId, a.client.id, a.kase.id);
  const art = await artifactOn(store, taskId, "x.txt");
  const made = await agentSubmit(app, store, taskId, { title: "Pulled", kind: "document", summary: "v1", artifact_ids: [art] });
  const id = made.json.deliverable.id as string;
  const hdr = { "x-mycel-project": projectId };
  await api(app, `deliverables/${id}/release`, { method: "POST", headers: hdr, body: "{}" });
  await api(app, `deliverables/${id}/withdraw`, { method: "POST", headers: hdr, body: JSON.stringify({ reason: "client changed scope" }) });

  const wait = (await domain.listWaits({ project_id: projectId, case_id: a.kase.id, status: "waiting" }))[0]!;
  const v = await evaluateWait(domain, wait);
  assert.equal(v.state, "unresolvable");
  assert.match((v as any).reason, /withdrawn/);
});

test("deliverables: releasing when nothing can pick the answer up says so instead of pretending", async () => {
  // THE BUG this repo keeps paying for: something failing while reporting success. A case whose
  // wedge declares no `deliverable_verdict` still gets the whole loop — but the founder is told, on
  // the timeline, that nobody is watching for the answer.
  const { app, store, projectId, domain, a } = await world();
  // `invoice-chaser` is installed but declares no verdict task type. Resolved from the CASE's wedge,
  // never from a name in src/ — which is what makes this a configuration fact and not a hardcode.
  const kase = await domain.createCase({
    project_id: projectId,
    wedge: "invoice-chaser",
    title: "no verdict carrier",
    client_id: a.client.id,
    stage: "open",
    status: "open",
    data: {},
  });
  const taskId = await taskFor(app, projectId, a.client.id, kase.id);
  const art = await artifactOn(store, taskId, "x.txt");
  const made = await agentSubmit(app, store, taskId, { title: "Orphan", kind: "document", summary: "v1", artifact_ids: [art] });
  const id = made.json.deliverable.id as string;

  const rel = await api(app, `deliverables/${id}/release`, { method: "POST", headers: { "x-mycel-project": projectId }, body: "{}" });
  assert.equal(rel.status, 200, rel.text);
  assert.match(rel.json.parked, /does not declare a "deliverable_verdict" task type/);
  const fresh = await domain.getCase(kase.id);
  assert.match((fresh!.history ?? []).map((h) => h.note ?? "").join("\n"), /does not declare/);
});

// ── money on the floor ───────────────────────────────────────────────────────────────────────────

test("deliverables: accepted work nobody invoiced is a ranked move, and it disappears when invoiced", async () => {
  // THE BUG: a small firm's most expensive habit — finishing work and forgetting to bill for it.
  // Until `accepted_at` existed there was nothing to join an invoice against, so "done and unbilled"
  // and "never started" were the same absence of a row.
  const { app, store, projectId, domain, a } = await world();
  const taskId = await taskFor(app, projectId, a.client.id, a.kase.id);
  const art = await artifactOn(store, taskId, "done.txt");
  const made = await agentSubmit(app, store, taskId, { title: "March close", kind: "document", summary: "v1", artifact_ids: [art] });
  const id = made.json.deliverable.id as string;
  await api(app, `deliverables/${id}/release`, { method: "POST", headers: { "x-mycel-project": projectId }, body: "{}" });

  const stores = {
    domain,
    billing: getBillingStore(),
    requests: getRequestStore(),
    deliverables: getDeliverableStore(),
  };
  const auth = await moveAuthorityForProject(domain, projectId);

  const before = await proposeMoves(stores, auth, {});
  assert.equal(
    before.moves.filter((m) => m.kind === "invoice_accepted_work").length,
    0,
    "work still out with the client is not billable and must not be proposed",
  );

  await api(app, `portal/deliverables/${id}/accept`, { method: "POST", headers: a.h, body: "{}" });

  const after = await proposeMoves(stores, auth, {});
  const move = after.moves.find((m) => m.kind === "invoice_accepted_work");
  assert.ok(move, "accepted-but-uninvoiced work is money on the floor and has to be visible");
  assert.equal(move!.entity.kind, "deliverable");
  assert.equal(move!.entity.id, id);
  assert.equal(move!.client_id, a.client.id);
  assert.match(move!.why, /accepted "March close"/);
  assert.equal(move!.takeable, false, "nothing here will price the work for you");
  assert.match(move!.unavailable_reason!, /raise the invoice|money plan/i);
  assert.ok(
    move!.score_terms.some((t) => t.term === "earned"),
    "and the ranking says why: the work is finished and signed off",
  );

  // Invoice it, on the same engagement, and the prompt goes away — the edge is DERIVED from
  // `Invoice.case_id`, not stored on the deliverable, so nothing has to be kept in sync.
  const inv = await api(app, "invoices", {
    method: "POST",
    headers: { "x-mycel-project": projectId },
    body: JSON.stringify({
      client_id: a.client.id,
      case_id: a.kase.id,
      currency: "GBP",
      lines: [{ description: "March close", kind: "fixed", unit_amount: 45000 }],
    }),
  });
  assert.equal(inv.status, 201, inv.text);

  const settled = await proposeMoves(stores, auth, {});
  assert.equal(settled.moves.filter((m) => m.kind === "invoice_accepted_work").length, 0);

  // A VOIDED invoice does not count as billed: the work is finished, accepted and once again
  // unbilled, which is exactly when the prompt is most worth showing.
  await api(app, `invoices/${inv.json.id}/status`, {
    method: "POST",
    headers: { "x-mycel-project": projectId },
    body: JSON.stringify({ to: "void" }),
  });
  const reopened = await proposeMoves(stores, auth, {});
  assert.equal(reopened.moves.filter((m) => m.kind === "invoice_accepted_work").length, 1);
});

test("deliverables: certain overdue money still out-ranks accepted-but-unbilled work", async () => {
  // THE BUG a new scoring term always threatens: a flat "this is worth doing" bonus that quietly
  // out-ranks a named client owing a named amount on a date that has passed. That ordering is the
  // one promise the ranked list makes.
  const { app, store, projectId, domain, a, b } = await world();
  const taskId = await taskFor(app, projectId, a.client.id, a.kase.id);
  const art = await artifactOn(store, taskId, "d.txt");
  const made = await agentSubmit(app, store, taskId, { title: "Signed off", kind: "document", summary: "v1", artifact_ids: [art] });
  const id = made.json.deliverable.id as string;
  await api(app, `deliverables/${id}/release`, { method: "POST", headers: { "x-mycel-project": projectId }, body: "{}" });
  await api(app, `portal/deliverables/${id}/accept`, { method: "POST", headers: a.h, body: "{}" });

  // A big, badly overdue invoice for the OTHER client, so the two moves are about different rows.
  const past = new Date(Date.now() - 40 * 86_400_000).toISOString().slice(0, 10);
  const inv = await api(app, "invoices", {
    method: "POST",
    headers: { "x-mycel-project": projectId },
    body: JSON.stringify({
      client_id: b.client.id,
      case_id: b.kase.id,
      currency: "GBP",
      due_date: past,
      issue_date: past,
      lines: [{ description: "big", kind: "fixed", unit_amount: 900000 }],
    }),
  });
  await api(app, `invoices/${inv.json.id}/status`, {
    method: "POST",
    headers: { "x-mycel-project": projectId },
    body: JSON.stringify({ to: "sent" }),
  });

  const proposal = await proposeMoves(
    { domain, billing: getBillingStore(), requests: getRequestStore(), deliverables: getDeliverableStore() },
    await moveAuthorityForProject(domain, projectId),
    {},
  );
  const chase = proposal.moves.find((m) => m.kind === "chase_invoice");
  const bill = proposal.moves.find((m) => m.kind === "invoice_accepted_work");
  assert.ok(chase && bill, "both are proposed");
  assert.ok(chase!.score > bill!.score, `certain overdue money must win: ${chase!.score} vs ${bill!.score}`);
});

// ── the projection ───────────────────────────────────────────────────────────────────────────────

test("deliverables: the client projection drops the operator's machinery", async () => {
  // THE BUG `toPortal` exists for everywhere else in this codebase: forwarding the row verbatim
  // ships every field a future edit adds. `task_id` is the one that matters — a client did not hire
  // a task runner, and a run id is a handle onto the operator plane.
  const { app, store, projectId, a } = await world();
  const taskId = await taskFor(app, projectId, a.client.id, a.kase.id);
  const art = await artifactOn(store, taskId, "x.txt");
  const made = await agentSubmit(app, store, taskId, { title: "Thing", kind: "document", summary: "v1", artifact_ids: [art] });
  const id = made.json.deliverable.id as string;
  await api(app, `deliverables/${id}/release`, { method: "POST", headers: { "x-mycel-project": projectId }, body: "{}" });

  const seen = (await api(app, `portal/deliverables/${id}`, { headers: a.h })).json;
  assert.equal(seen.project_id, undefined);
  assert.equal(seen.case_id, undefined);
  assert.equal(seen.status, undefined, "the raw status never crosses — `state` is the client's sentence");
  assert.equal(seen.state, DELIVERABLE_STATES.with_client.client_sees);
  assert.equal(seen.versions[0].task_id, undefined);

  // The founder's own view keeps all of it — that plane is allowed to see the machinery.
  const operator = (await api(app, `deliverables/${id}`, { headers: { "x-mycel-project": projectId } })).json;
  assert.equal(operator.versions[0].task_id, taskId);
  assert.equal(operator.released_versions, 1);
  assert.equal(operator.state_note, DELIVERABLE_STATES.with_client.founder_sees);
});

test("deliverables: visibleVersions is the only gate, and it filters on release", () => {
  // A unit pin on the one function every portal read goes through. If this ever passes an unreleased
  // version, four routes leak at once — which is why they all call this rather than each filtering.
  const base = { id: "v", project_id: "p", deliverable_id: "d", summary: "", artifact_ids: [], created_at: "2026-01-01T00:00:00Z" };
  const out = visibleVersions([
    { ...base, version: 1, released_at: "2026-01-02T00:00:00Z" },
    { ...base, version: 2 },
  ]);
  assert.deepEqual(out.map((v) => v.version), [1]);
});

// ── the founder delivering by hand ───────────────────────────────────────────────────────────────

test("deliverables: a founder can deliver work with no run behind it, through the same gate", async () => {
  // THE BUG a parallel creation path would introduce, and the reason this shares `founderSubmit`
  // with nothing duplicated: a second submit route with its own validation is how one of them ends
  // up missing the tenant check on `artifact_ids`, or landing in `with_client` instead of
  // `in_review` and skipping the gate entirely.
  const { app, projectId, a } = await world();
  const hdr = { "x-mycel-project": projectId };

  const made = await api(app, "deliverables", {
    method: "POST",
    headers: hdr,
    body: JSON.stringify({ case_id: a.kase.id, title: "Signed contract", kind: "link", url: "https://sign.test/abc", summary: "ready to sign" }),
  });
  assert.equal(made.status, 201, made.text);
  assert.equal(made.json.deliverable.status, "in_review", "a founder's own work still waits for a founder to send it");
  const id = made.json.deliverable.id as string;

  // Not visible until released — the gate does not care who made it.
  assert.equal((await api(app, "portal/deliverables", { headers: a.h })).json.deliverables.length, 0);
  await api(app, `deliverables/${id}/release`, { method: "POST", headers: hdr, body: "{}" });
  const seen = (await api(app, "portal/deliverables", { headers: a.h })).json.deliverables[0];
  assert.equal(seen.kind, "link");
  assert.equal(seen.versions[0].url, "https://sign.test/abc");

  // The same payload rules apply — a `link` with no url is refused here exactly as on the agent plane.
  const empty = await api(app, "deliverables", {
    method: "POST",
    headers: hdr,
    body: JSON.stringify({ case_id: a.kase.id, title: "Broken", kind: "link" }),
  });
  assert.equal(empty.status, 400);
  assert.match(empty.json.error, /needs a url/);
});

test("deliverables: a founder cannot attach work to an engagement outside their business", async () => {
  // THE BUG: `case_id` is the one field the agent route gets for free from its own task and the one
  // a founder can get wrong. Getting it wrong means work — and later an invoice — attached to
  // another business's engagement.
  const { app, projectId, domain, memberToken, a } = await world();
  const other = (await api(app, "projects", { method: "POST", body: JSON.stringify({ name: "elsewhere" }) }, memberToken)).json;
  const theirCase = await domain.createCase({
    project_id: other.project.id,
    wedge: CASE_WEDGE,
    title: "not ours",
    client_id: a.client.id,
    stage: "open",
    status: "open",
    data: {},
  });

  const res = await api(app, "deliverables", {
    method: "POST",
    headers: { "x-mycel-project": projectId },
    body: JSON.stringify({ case_id: theirCase.id, title: "Sneaky", kind: "link", url: "https://x.test/a" }),
  });
  assert.equal(res.status, 400, res.text);
  assert.match(res.json.error, /not in this business/);
});

// ── the revision loop actually runs ──────────────────────────────────────────────────────────────

test("deliverables: asking for changes resumes the wait immediately, not on the next sweep", async () => {
  // THE BUG: the client sent comments and nothing happened for five minutes — or forever, if the
  // sweep was not armed. The wait is the spawn path; firing it at the verdict is what makes the
  // loop feel like a service business.
  const { app, store, projectId, domain, a } = await world();
  const taskId = await taskFor(app, projectId, a.client.id, a.kase.id);
  const art = await artifactOn(store, taskId, "draft.txt");
  const made = await agentSubmit(app, store, taskId, { title: "Draft", kind: "document", summary: "v1", artifact_ids: [art] });
  const id = made.json.deliverable.id as string;
  await api(app, `deliverables/${id}/release`, { method: "POST", headers: { "x-mycel-project": projectId }, body: "{}" });

  const asked = await api(app, `portal/deliverables/${id}/request-changes`, {
    method: "POST",
    headers: a.h,
    body: JSON.stringify({
      request: "make the logo bigger",
      comments: [{ file: "draft.txt", note: "the mark is lost on the cover" }],
    }),
  });
  assert.equal(asked.status, 200, asked.text);
  assert.equal(asked.json.deliverable.can_act, false);

  const versions = await getDeliverableStore().listVersions(projectId, id);
  assert.match(versions[0]!.change_request ?? "", /On draft\.txt: the mark is lost on the cover/);
  assert.match(versions[0]!.change_request ?? "", /make the logo bigger/);

  const waits = await domain.listWaits({ project_id: projectId, case_id: a.kase.id });
  assert.equal(waits.filter((w) => w.status === "waiting").length, 0, "the wait is no longer parked");
  const resumed = waits.find((w) => w.status === "resumed" || w.status === "resuming");
  assert.ok(resumed, "the wait was claimed");
  assert.ok(asked.json.task_id || resumed?.resumed_task_id, "a revision run started");

  const row = await getDeliverableStore().getDeliverable(projectId, id);
  assert.equal(row?.status, "changes_requested");
  assert.equal(row?.accepted_at, undefined, "a revision is not an acceptance");
});

test("deliverables: a revision cannot be drafted into an invoice from the money plan", async () => {
  // THE BUG: treating "they came back" as "they accepted", and billing a round that is still open.
  const { app, store, projectId, a } = await world();
  const taskId = await taskFor(app, projectId, a.client.id, a.kase.id);
  const art = await artifactOn(store, taskId, "x.txt");
  const made = await agentSubmit(app, store, taskId, { title: "Pack", kind: "document", summary: "v1", artifact_ids: [art] });
  const id = made.json.deliverable.id as string;
  const hdr = { "x-mycel-project": projectId };
  await api(app, `deliverables/${id}/release`, { method: "POST", headers: hdr, body: "{}" });
  await api(app, `portal/deliverables/${id}/request-changes`, {
    method: "POST",
    headers: a.h,
    body: JSON.stringify({ request: "try again" }),
  });

  const draft = await api(app, `deliverables/${id}/draft-invoice`, { method: "POST", headers: hdr, body: "{}" });
  assert.equal(draft.status, 409, draft.text);
  assert.match(draft.json.error, /only accepted work/i);
});

test("deliverables: founder preview serves HTML as JSON and CSV as a grid", async () => {
  const { app, store, projectId, a } = await world();
  const taskId = await taskFor(app, projectId, a.client.id, a.kase.id);
  const html = await store.addArtifact({
    task_id: taskId,
    name: "site.html",
    content_type: "text/html",
    content: "<h1>Hello client</h1>",
  });
  const csv = await store.addArtifact({
    task_id: taskId,
    name: "numbers.csv",
    content_type: "text/csv",
    content: "a,b\n1,2",
  });
  const made = await agentSubmit(app, store, taskId, {
    title: "Pack",
    kind: "file_set",
    summary: "v1",
    artifact_ids: [html.id, csv.id],
  });
  const id = made.json.deliverable.id as string;
  const hdr = { "x-mycel-project": projectId };

  const htmlPrev = await api(app, `deliverables/${id}/files/${html.id}/preview`, { headers: hdr });
  assert.equal(htmlPrev.status, 200, htmlPrev.text);
  assert.equal(htmlPrev.json.html.includes("Hello client"), true);
  assert.match(htmlPrev.json.html, /Content-Security-Policy/);

  const csvPrev = await api(app, `deliverables/${id}/files/${csv.id}/preview`, { headers: hdr });
  assert.equal(csvPrev.status, 200, csvPrev.text);
  assert.deepEqual(csvPrev.json.sheets[0].rows[0], ["a", "b"]);
});

test("wrapFulfillmentDeliverable turns a successful books-keeper run into a deliverable", async () => {
  const { wrapFulfillmentDeliverable } = await import("../src/deliverables.wrap");
  const { app, store, projectId, a } = await world();
  const taskId = await taskFor(app, projectId, a.client.id, a.kase.id);
  const artifactId = await artifactOn(store, taskId, "result.txt");
  const task = await store.getTask(taskId);
  assert.ok(task);
  const first = await wrapFulfillmentDeliverable({
    task,
    artifactId,
    summary: "August close pack.",
  });
  assert.ok(first);
  assert.equal(first.case_id, a.kase.id);
  assert.equal(first.client_id, a.client.id);
  assert.equal(first.kind, "document");
  const versions = await getDeliverableStore().listVersions(projectId, first.id);
  assert.equal(versions.length, 1);
  assert.equal(versions[0]!.task_id, taskId);
  assert.deepEqual(versions[0]!.artifact_ids, [artifactId]);

  const again = await wrapFulfillmentDeliverable({
    task,
    artifactId,
    summary: "August close pack.",
  });
  assert.equal(again?.id, first.id);
  assert.equal((await getDeliverableStore().listVersions(projectId, first.id)).length, 1, "same run does not double-submit");
});

test("wrapFulfillmentDeliverable renders a document deliverable into a branded PDF, not raw text", async () => {
  const { wrapFulfillmentDeliverable } = await import("../src/deliverables.wrap");
  const { render } = await import("../src/render");
  const { blocksFromMarkdown } = await import("../src/render/report");
  const { resolveBrandKit } = await import("../src/brandkit");
  const { app, store, projectId, a } = await world();
  const taskId = await taskFor(app, projectId, a.client.id, a.kase.id);
  const textId = await artifactOn(store, taskId, "result.txt");
  const task = await store.getTask(taskId);
  assert.ok(task);
  const kit = resolveBrandKit({ display_name: "Hartley Bookkeeping", accent: "#0f766e" }, "Hartley");
  let renderedId: string | undefined;
  const d = await wrapFulfillmentDeliverable({
    task,
    artifactId: textId,
    summary: "August close pack.",
    content: "# August Close\n\nReconciled the month and chased two open items.\n\n- Bank matched to the penny\n- 2 receipts still open\n\nNet profit: £12,480\nCash in bank: £48,200",
    renderDocument: async ({ content, title }) => {
      const doc = render("report", { title, blocks: blocksFromMarkdown(content) }, kit);
      const pdf = await store.addArtifact({
        task_id: taskId,
        name: doc.name,
        content_type: doc.content_type,
        content: doc.content,
        encoding: doc.encoding,
        size_bytes: doc.size_bytes,
      });
      renderedId = pdf.id;
      return pdf.id;
    },
  });
  assert.ok(d);
  assert.equal(d.kind, "document");
  const versions = await getDeliverableStore().listVersions(projectId, d.id);
  assert.deepEqual(versions[0]!.artifact_ids, [renderedId], "the version carries the rendered PDF");
  assert.notEqual(versions[0]!.artifact_ids[0], textId, "the plain-text result.txt was replaced");
  const pdfArt = await store.getArtifact(renderedId!);
  assert.equal(pdfArt?.content_type, "application/pdf");
  assert.equal(Buffer.from(pdfArt!.content, "base64").slice(0, 5).toString("latin1"), "%PDF-");
});

test("wrapFulfillmentDeliverable keeps the text artifact when the render fails — never blocked on a renderer", async () => {
  const { wrapFulfillmentDeliverable } = await import("../src/deliverables.wrap");
  const { app, store, projectId, a } = await world();
  const taskId = await taskFor(app, projectId, a.client.id, a.kase.id);
  const textId = await artifactOn(store, taskId, "result.txt");
  const task = await store.getTask(taskId);
  assert.ok(task);
  const d = await wrapFulfillmentDeliverable({
    task,
    artifactId: textId,
    summary: "August close pack.",
    content: "# August Close\n\nAll good.",
    renderDocument: async () => undefined, // e.g. no brand kit resolved
  });
  assert.ok(d);
  const versions = await getDeliverableStore().listVersions(projectId, d.id);
  assert.deepEqual(versions[0]!.artifact_ids, [textId], "falls back to the text artifact");
});

test("wrapFulfillmentDeliverable does not turn a chase into something the client must accept", async () => {
  const { wrapFulfillmentDeliverable } = await import("../src/deliverables.wrap");
  const { app, store, projectId, a } = await world();
  const t = await api(app, "tasks", {
    method: "POST",
    headers: { "x-mycel-project": projectId },
    body: JSON.stringify({
      wedge: CASE_WEDGE,
      task_type: "chase_receipts",
      input: {},
      client_id: a.client.id,
      case_id: a.kase.id,
      actor: { kind: "user", id: a.client.id },
    }),
  });
  assert.equal(t.status, 201, t.text);
  const artifactId = await artifactOn(store, t.json.id, "chase.txt");
  const task = await store.getTask(t.json.id);
  assert.ok(task);
  const wrapped = await wrapFulfillmentDeliverable({
    task,
    artifactId,
    summary: "Still missing four receipts.",
  });
  assert.equal(wrapped, undefined);
  assert.equal((await getDeliverableStore().listDeliverables({ project_id: projectId, case_id: a.kase.id })).length, 0);
});

test("wrapFulfillmentDeliverable turns a successful authored run into a deliverable", async () => {
  // THE BUG: fulfillmentOf used loadWedge, which refuses drafted: slugs, so an authored job went
  // green and Deliverables stayed empty — the client had nothing to accept.
  const { wrapFulfillmentDeliverable } = await import("../src/deliverables.wrap");
  const { _resetAuthored, getAuthoredStore } = await import("../src/authored");
  const { authoredSlug } = await import("../src/wedge");
  _resetAuthored();
  const { app, store, projectId, domain, a } = await world();
  const slug = authoredSlug("proposals-and-signoff");
  await getAuthoredStore().createDraft({
    project_id: projectId,
    slug,
    title: "Proposals and sign-off",
    manifest: {
      wedge: slug,
      title: "Proposals and sign-off",
      task_types: {
        draft_scope: {
          description: "Turn the brief into a scope.",
          output_schema: {
            type: "object",
            properties: { deliverables: { type: "array", items: { type: "string" } } },
            required: ["deliverables"],
          },
        },
      },
    },
    skills: [],
    knowledge: [],
    described_as: "I run a design studio",
  });
  await getAuthoredStore().decide(projectId, slug, "promoted", "founder");
  const kase = await domain.createCase({
    project_id: projectId,
    wedge: slug,
    title: "Studio engagement",
    client_id: a.client.id,
    stage: "scoping",
    status: "open",
    data: {},
  });
  const t = await api(app, "tasks", {
    method: "POST",
    headers: { "x-mycel-project": projectId },
    body: JSON.stringify({
      wedge: slug,
      task_type: "draft_scope",
      input: {},
      client_id: a.client.id,
      case_id: kase.id,
      actor: { kind: "user", id: a.client.id },
    }),
  });
  assert.equal(t.status, 201, t.text);
  const artifactId = await artifactOn(store, t.json.id, "result.txt");
  const task = await store.getTask(t.json.id);
  assert.ok(task);
  const wrapped = await wrapFulfillmentDeliverable({
    task,
    artifactId,
    summary: "First scope from the brief.",
  });
  assert.ok(wrapped);
  assert.equal(wrapped.kind, "document");
  assert.equal(wrapped.case_id, kase.id);
  assert.equal(wrapped.client_id, a.client.id);
});

test("retention loop: wrap → release → accept → draft invoice from the money plan", async () => {
  // THE LOOP A FOUNDER RENEWS FOR. Work becomes a Deliverable, the client signs it off, money is
  // drafted. A succeeded task with no invoice at the end is a chat log they will cancel over.
  const { writeMoneyPlan, moneyPlanFromTemplate } = await import("../src/money-plan");
  const { wrapFulfillmentDeliverable } = await import("../src/deliverables.wrap");
  const { app, store, projectId, domain, a } = await world();

  await domain.updateCase(a.kase.id, {
    data: writeMoneyPlan(
      a.kase.data ?? {},
      moneyPlanFromTemplate("USD", [{ label: "August close", amount_minor: 150_000, kind: "milestone" }]),
    ),
  });

  const taskId = await taskFor(app, projectId, a.client.id, a.kase.id);
  const artifactId = await artifactOn(store, taskId, "result.txt");
  const task = await store.getTask(taskId);
  assert.ok(task);
  const d = await wrapFulfillmentDeliverable({ task, artifactId, summary: "August close pack." });
  assert.ok(d);

  const rel = await api(app, `deliverables/${d.id}/release`, {
    method: "POST",
    headers: { "x-mycel-project": projectId },
    body: "{}",
  });
  assert.equal(rel.status, 200, rel.text);
  assert.equal(rel.json.deliverable.status, "with_client");

  const acc = await api(app, `portal/deliverables/${d.id}/accept`, { method: "POST", headers: a.h, body: "{}" });
  assert.equal(acc.status, 200, acc.text);
  assert.ok(acc.json.deliverable.accepted_at, acc.text);

  const drafted = await api(app, `deliverables/${d.id}/draft-invoice`, {
    method: "POST",
    headers: { "x-mycel-project": projectId },
    body: "{}",
  });
  assert.equal(drafted.status, 200, drafted.text);
  assert.ok(drafted.json.invoice);
  assert.equal(drafted.json.invoice.client_id, a.client.id);
  assert.equal(drafted.json.invoice.case_id, a.kase.id);
  const line = drafted.json.invoice.lines?.[0];
  assert.ok(line);
  assert.equal(line.unit_amount, 150_000);
});
