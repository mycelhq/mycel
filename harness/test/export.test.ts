import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { exportProject, type ExportStores } from "../src/export.ts";

const stores = (over: Partial<Record<string, unknown>> = {}): ExportStores =>
  ({
    domain: {
      listClients: async () => [{ id: "c1", project_id: "p1" }, { id: "c2", project_id: "OTHER" }],
      listCases: async () => [{ id: "case1" }],
      queryRecords: async () => [{ id: "r1" }],
      listSchedules: async () => [{ id: "s1", project_id: "p1" }, { id: "s2", project_id: "OTHER" }],
      listKnowledge: async () => [{ id: "k1" }],
      ...(over.domain as object),
    },
    deliverables: {
      listDeliverables: async () => [{ id: "d1" }],
      listVersions: async () => [{ version: 1, author: "agent" }, { version: 2, author: "founder" }],
      ...(over.deliverables as object),
    },
    knowledge: { listRules: async () => [{ id: "rule1" }], listObservations: async () => [] },
    billing: { listInvoices: async () => [{ id: "inv1" }], ...(over.billing as object) },
    tasks: { listTasks: async () => [{ id: "t1" }] },
  }) as unknown as ExportStores;

test("carries everything a business would need to leave", async () => {
  const out = await exportProject(stores(), "p1", { wedges: ["w"] });
  assert.equal(out.clients.length, 1);
  assert.equal(out.cases.length, 1);
  assert.equal(out.invoices.length, 1, "invoices come from the BILLING store, not domain");
  assert.equal(out.records.length, 1);
  assert.equal(out.knowledge.length, 1);
  assert.equal(out.rules.length, 1);
  assert.equal(out.deliverables.length, 1);
});

test("another project's rows do not travel", async () => {
  const out = await exportProject(stores(), "p1", {});
  assert.deepEqual(out.clients.map((c) => (c as { id: string }).id), ["c1"]);
  assert.deepEqual(out.schedules.map((s) => (s as { id: string }).id), ["s1"]);
});

test("every deliverable version, not just the released ones", async () => {
  // The difference between what the agent wrote and what the founder sent IS their correction
  // record. Exporting only what the client saw hands back the least useful half.
  const out = await exportProject(stores(), "p1", {});
  const versions = out.deliverables[0]!.versions as { author: string }[];
  assert.equal(versions.length, 2);
  assert.ok(versions.some((v) => v.author === "agent"));
  assert.ok(versions.some((v) => v.author === "founder"));
});

test("run logs are out unless asked for", async () => {
  assert.equal((await exportProject(stores(), "p1", {})).tasks, undefined);
  assert.equal((await exportProject(stores(), "p1", { tasks: true })).tasks?.length, 1);
});

test("one unreadable table does not take the export down", async () => {
  // A partial export beats a 500. Somebody running this is often already leaving, or checking that
  // they could; failing the whole thing because one table is sulking is the worst moment for it.
  const broken = stores({ billing: { listInvoices: async () => { throw new Error("nope"); } } });
  const out = await exportProject(broken, "p1", {});
  assert.deepEqual(out.invoices, []);
  assert.equal(out.clients.length, 1, "the rest still came through");
});

test("the file explains itself", async () => {
  const out = await exportProject(stores(), "p1", {});
  assert.equal(out.format, "mycel.export.v1");
  assert.match(out.note, /corrections/);
  assert.ok(out.exported_at);
});

test("the route exists, and is scoped like a write", () => {
  // The privacy policy and the DPA both promise this endpoint. Before it existed the kernel served
  // 353 routes and exported nothing, so the promise is pinned here rather than in prose.
  const src = readFileSync(new URL("../src/project-reads.routes.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.match(src, /app\.get\("\/v1\/export"/);
  // `writeProjectId`, not the read set: this hands back a whole business, so a token with two must
  // still say which one.
  const route = src.slice(src.indexOf('app.get("/v1/export"'));
  assert.match(route.slice(0, 400), /writeProjectId\(c\)/);
  // Wide enough to contain the whole handler. 600 was a guess and the handler is longer.
  assert.match(route.slice(0, 2_000), /content-disposition/);
});
