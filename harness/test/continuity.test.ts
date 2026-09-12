import { test } from "node:test";
import assert from "node:assert/strict";
import { continuitySkills, type DeliverableReader } from "../src/continuity";
import type { Deliverable, DeliverableVersion } from "../src/contract";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * THE RUN KNEW THE STANDARD AND NOT THE HISTORY
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Every other mount on the deliverable path answers "how good does this have to be" — the founder's
 * own past work, the craft, the procedures, the labelled research. None answered "what did we
 * already tell these people", and that is the question a retainer is judged on: a client reading
 * their sixth report compares it to their fifth.
 *
 * It is also the clearest line between this product and a chat window. A stateless agent cannot
 * mount last month's approved report because it has never seen it.
 */

const d = (over: Partial<Deliverable> = {}): Deliverable =>
  ({
    id: "d1",
    project_id: "p1",
    case_id: "c1",
    client_id: "cl1",
    title: "November visibility report",
    kind: "document",
    status: "with_client",
    current_version: 1,
    created_at: "2026-11-01T00:00:00.000Z",
    updated_at: "2026-11-01T00:00:00.000Z",
    ...over,
  }) as Deliverable;

const v = (over: Partial<DeliverableVersion> = {}): DeliverableVersion =>
  ({
    id: "v1",
    project_id: "p1",
    deliverable_id: "d1",
    version: 1,
    summary: "Share of voice reached 28.6%. Two items still open.",
    artifact_ids: [],
    ...over,
  }) as DeliverableVersion;

const reader = (rows: Deliverable[], versions: Record<string, DeliverableVersion[]>): DeliverableReader => ({
  async listDeliverables(f) {
    return rows.filter((r) => (f.client_id ? r.client_id === f.client_id : true));
  },
  async listVersions(_p, id) {
    return versions[id] ?? [];
  },
});

test("nothing is mounted without a project and a client", async () => {
  const r = reader([d()], { d1: [v({ released_at: "2026-11-05T00:00:00.000Z" })] });
  assert.deepEqual(await continuitySkills(r, { projectId: "p1" }), []);
  assert.deepEqual(await continuitySkills(r, { clientId: "cl1" }), []);
});

/**
 * A draft sitting in review is not continuity. The client has not seen it, it may be rewritten
 * before they do, and writing this month's report against it would follow on from something that
 * never happened.
 */
test("an unreleased draft is not what the client holds, so it is not mounted", async () => {
  const r = reader([d()], { d1: [v()] }); // no released_at
  assert.deepEqual(await continuitySkills(r, { projectId: "p1", clientId: "cl1" }), []);
});

test("the released version is mounted, with what it said", async () => {
  const r = reader([d()], { d1: [v({ released_at: "2026-11-05T00:00:00.000Z" })] });
  const [skill] = await continuitySkills(r, { projectId: "p1", clientId: "cl1" });
  assert.ok(skill, "nothing mounted");
  assert.equal(skill.name, "last-time.md");
  assert.match(skill.content, /November visibility report/);
  assert.match(skill.content, /28\.6%/, "the substance of last month is missing");
});

/** Newest RELEASED wins — not newest touched. A row can be updated long after it was sent. */
test("the most recently released deliverable wins, across deliverables", async () => {
  const rows = [
    d({ id: "old", title: "September report", updated_at: "2026-12-01T00:00:00.000Z" }),
    d({ id: "new", title: "October report", updated_at: "2026-10-02T00:00:00.000Z" }),
  ];
  const r = reader(rows, {
    old: [v({ deliverable_id: "old", summary: "September", released_at: "2026-09-30T00:00:00.000Z" })],
    new: [v({ deliverable_id: "new", summary: "October", released_at: "2026-10-31T00:00:00.000Z" })],
  });
  const [skill] = await continuitySkills(r, { projectId: "p1", clientId: "cl1" });
  assert.match(skill!.content, /October report/, "a later `updated_at` beat a later release");
});

test("a change request the client made is carried, because it is the thing to answer", async () => {
  const r = reader([d()], {
    d1: [v({ released_at: "2026-11-05T00:00:00.000Z", change_request: "Add the competitor table back." })],
  });
  const [skill] = await continuitySkills(r, { projectId: "p1", clientId: "cl1" });
  assert.match(skill!.content, /Add the competitor table back/);
});

/**
 * The instruction matters as much as the text. Told merely to "be consistent", a model reproduces
 * last month's headings whether or not it has anything to put under them — which is how a retainer
 * report becomes a template with the numbers swapped, the exact thing a client cancels over.
 */
test("it asks for continuity of the STORY, and explicitly not of the structure", async () => {
  const r = reader([d()], { d1: [v({ released_at: "2026-11-05T00:00:00.000Z" })] });
  const [skill] = await continuitySkills(r, { projectId: "p1", clientId: "cl1" });
  assert.match(skill!.content, /open item/i, "nothing about carrying open items forward");
  assert.match(skill!.content, /moved/i, "nothing about naming movement in a figure");
  assert.match(skill!.content, /Do NOT copy the structure/i, "it will pad to match last month's headings");
});

test("a store that throws costs the run nothing", async () => {
  const broken: DeliverableReader = {
    async listDeliverables() { throw new Error("store down"); },
    async listVersions() { return []; },
  };
  assert.deepEqual(await continuitySkills(broken, { projectId: "p1", clientId: "cl1" }), []);
});

test("an empty summary is not worth a mount", async () => {
  const r = reader([d()], { d1: [v({ released_at: "2026-11-05T00:00:00.000Z", summary: "   " })] });
  assert.deepEqual(await continuitySkills(r, { projectId: "p1", clientId: "cl1" }), []);
});
