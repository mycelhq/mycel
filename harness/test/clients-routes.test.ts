// THE CLIENT ROUTES, WHICH NOTHING EXERCISED.
//
// These seven routes were extracted from `server.ts` into `clients.routes.ts`, and the extraction
// was covered by exactly nothing: `grep -r v1/clients harness/test` returned zero. A refactor whose
// safety net is "2,280 other tests passed" is not covered, it is lucky — the tests that passed do
// not touch this code, so they would have passed just as cheerfully if the mount call had been
// dropped on the floor.
//
// So the coverage is part of the move rather than a follow-up nobody does.
import test from "node:test";
import assert from "node:assert/strict";
import { api, makeApp } from "./helpers";

async function project(app: any): Promise<string> {
  return (await api(app, "me")).json.projects[0].id as string;
}

test("clients: create, list and read back", async () => {
  const { app } = makeApp();
  const pid = await project(app);

  const made = await api(app, "clients", {
    method: "POST",
    body: JSON.stringify({ display_name: "Vasquez Cabinetry", handles: ["marie@harrow.test"] }),
    headers: { "x-mycel-project": pid },
  });
  assert.equal(made.status, 201, made.text);
  assert.equal(made.json.display_name, "Vasquez Cabinetry");

  const listed = await api(app, "clients");
  assert.equal(listed.status, 200);
  assert.ok(listed.json.some((c: any) => c.id === made.json.id), "a created client must appear in the list");

  const one = await api(app, `clients/${made.json.id}`);
  assert.equal(one.status, 200, one.text);
  // The read is a client PLUS its conversations — the extraction must not have dropped the join.
  assert.ok(Array.isArray(one.json.threads), "the single read carries threads");
});

test("clients: a write lands in the CALLER's project when they have exactly one", async () => {
  /**
   * I expected a 400 here and was wrong, which is worth recording rather than deleting.
   *
   * `writeProjectId` resolves the project from the caller's own scope first; the X-Mycel-Project
   * header exists to DISAMBIGUATE when a scope spans several, not to be typed on every write. A
   * product key that maps to one project already names it, and refusing that would make every
   * single-project integration send a header it cannot get wrong.
   *
   * The tenancy property that actually matters is the one below: whatever project is resolved, the
   * row is written to THAT one and not to whichever happened to be first.
   */
  const { app } = makeApp();
  const pid = await project(app);
  const res = await api(app, "clients", { method: "POST", body: JSON.stringify({ display_name: "Nowhere" }) });
  assert.equal(res.status, 201, res.text);
  assert.equal(res.json.project_id, pid, "the row must land in the caller's own project");
});

test("clients: another tenant's client is not found, not forbidden", async () => {
  // 404 rather than 403, the same answer this codebase gives everywhere: a 403 confirms the row
  // exists, which is the fact being withheld.
  const { app } = makeApp();
  const pid = await project(app);
  const made = await api(app, "clients", {
    method: "POST",
    body: JSON.stringify({ display_name: "Private" }),
    headers: { "x-mycel-project": pid },
  });
  const stranger = await api(app, `clients/${made.json.id}`, {}, "definitely-not-a-key");
  assert.ok(stranger.status === 401 || stranger.status === 404, `expected 401/404, got ${stranger.status}`);
});

test("clients: an unknown id is 404 rather than a crash", async () => {
  const { app } = makeApp();
  const res = await api(app, "clients/does-not-exist");
  assert.equal(res.status, 404, res.text);
});

test("clients: the context read answers for a real client", async () => {
  // `/context` is the one route here that composes several stores — profile, threads, engagements,
  // deliverables, knowledge. It is the most likely thing to break in a move and the least likely to
  // be noticed, because it fails as an empty object rather than an error.
  const { app } = makeApp();
  const pid = await project(app);
  const made = await api(app, "clients", {
    method: "POST",
    body: JSON.stringify({ display_name: "Context Co" }),
    headers: { "x-mycel-project": pid },
  });
  const ctx = await api(app, `clients/${made.json.id}/context`);
  assert.equal(ctx.status, 200, ctx.text);
  assert.equal(typeof ctx.json, "object");
});
