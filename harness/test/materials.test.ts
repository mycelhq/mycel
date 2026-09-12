// The wire that was never connected: a client uploads their March statement against a request, and
// the bookkeeping run three hours later reports that no statement is available. Both doors existed;
// nothing wrote the second from the first.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  artifactBytes,
  extractedName,
  gatherMaterials,
  materialsForTask,
  materialsNote,
  safeName,
  MAX_MATERIALS,
} from "../src/materials";
import type { Artifact, ClientRequest } from "../src/contract";

const art = (over: Partial<Artifact>): Artifact => ({
  id: "a1",
  task_id: "t1",
  name: "statement.txt",
  content_type: "text/plain",
  content: "Opening balance 1200. Closing balance 3400.",
  created_at: "2026-03-01T00:00:00Z",
  ...over,
});

const req = (over: Partial<ClientRequest>): ClientRequest =>
  ({
    id: "r1",
    project_id: "p1",
    client_id: "c1",
    case_id: "case1",
    kind: "document",
    ask: "Your March bank statement",
    status: "resolved",
    created_at: "2026-03-01T00:00:00Z",
    ...over,
  }) as ClientRequest;

const store = (arts: Artifact[]) => async (id: string) => arts.find((a) => a.id === id);

test("filenames are attacker-influenced — a client picks this string", () => {
  assert.equal(safeName("../../etc/profile", 0), "profile");
  assert.equal(safeName("/absolute/path/statement.pdf", 0), "statement.pdf");
  assert.equal(safeName("...", 0), "document-1");
  assert.equal(safeName("", 2), "document-3");
  assert.equal(safeName("March 2026 statement.pdf", 0), "March_2026_statement.pdf");
});

test("artifactBytes decodes uploads and treats a missing encoding as utf8", () => {
  assert.equal(artifactBytes({ content: Buffer.from("hello").toString("base64"), encoding: "base64" })?.toString(), "hello");
  assert.equal(artifactBytes({ content: "hello", encoding: undefined })?.toString(), "hello");
  // Externally-stored artifact with no inline bytes.
  assert.equal(artifactBytes({ content: "", encoding: "base64" }), undefined);
});

test("a binary that has become text is not still called .pdf in ./inputs/", () => {
  assert.equal(extractedName("statement.pdf"), "statement.txt");
  assert.equal(extractedName("brief.docx"), "brief.txt");
  assert.equal(extractedName("notes.txt"), "notes.txt");
  assert.equal(extractedName("data.csv"), "data.csv");
});

test("THE LOOP: a resolved request's file reaches the run", async () => {
  const got = await gatherMaterials([req({ response_artifact_ids: ["a1"] })], store([art({})]));
  assert.equal(got.documents.length, 1);
  assert.equal(got.documents[0]!.name, "statement.txt");
  assert.match(got.documents[0]!.content, /Closing balance 3400/);
});

test("an open or cancelled request is not material — nothing was handed over", async () => {
  const open = await gatherMaterials([req({ status: "open", response_artifact_ids: ["a1"] })], store([art({})]));
  assert.equal(open.documents.length, 0);
  const cancelled = await gatherMaterials([req({ status: "cancelled", response_artifact_ids: ["a1"] })], store([art({})]));
  assert.equal(cancelled.documents.length, 0);
});

test("the ceiling drops the OLDEST material, never this period's", async () => {
  const arts = Array.from({ length: 7 }, (_, i) => art({ id: `a${i}`, name: `f${i}.txt`, content: `body ${i}` }));
  const reqs = arts.map((a, i) =>
    req({ id: `r${i}`, response_artifact_ids: [a.id], resolved_at: `2026-03-0${i + 1}T00:00:00Z` }),
  );
  const got = await gatherMaterials(reqs, store(arts));
  assert.equal(got.documents.length, MAX_MATERIALS);
  assert.equal(got.documents[0]!.name, "f6.txt");
  assert.ok(!got.documents.some((d) => d.name === "f0.txt"), "the oldest file is the one dropped");
  assert.equal(got.omitted, 1);
});

test("a file attached to two requests is mounted once", async () => {
  const reqs = [req({ id: "r1", response_artifact_ids: ["a1"] }), req({ id: "r2", response_artifact_ids: ["a1"] })];
  assert.equal((await gatherMaterials(reqs, store([art({})]))).documents.length, 1);
});

test("an unreadable file is reported by name, not dropped silently", async () => {
  const bad = art({ name: "scan.png", content_type: "image/png", content: "AAAA", encoding: "base64" });
  const got = await gatherMaterials([req({ response_artifact_ids: ["a1"] })], store([bad]));
  assert.equal(got.documents.length, 0);
  assert.deepEqual(got.unreadable, ["scan.png"]);
});

test("a vanished artifact or a backend that throws costs the run its material, never the run", async () => {
  assert.equal((await gatherMaterials([req({ response_artifact_ids: ["gone"] })], store([]))).documents.length, 0);
  const thrown = await gatherMaterials([req({ response_artifact_ids: ["a1"] })], async () => {
    throw new Error("s3 down");
  });
  assert.equal(thrown.documents.length, 0);
});

test("materialsForTask scopes to the CASE — one engagement's files never enter another's run", async () => {
  const seen: Record<string, unknown>[] = [];
  const requests = {
    listRequests: async (f: any) => {
      seen.push(f);
      return [req({ response_artifact_ids: ["a1"] })];
    },
  };
  const got = await materialsForTask({ project_id: "p1", case_id: "case1" }, requests, store([art({})]));
  assert.equal(got?.documents.length, 1);
  assert.equal(seen[0]!.case_id, "case1");
  assert.equal(seen[0]!.status, "resolved");

  // No case means no materials. Widening the query to fill the gap is how the isolation is lost.
  const noCase = await materialsForTask({ project_id: "p1" }, requests, store([art({})]));
  assert.equal(noCase, undefined);
});

test("the run is told what arrived AND what could not be read", () => {
  assert.equal(materialsNote({ documents: [], unreadable: [], omitted: 0 }), undefined);
  const note = materialsNote({
    documents: [{ name: "statement.txt", content: "x" }],
    unreadable: ["scan.png"],
    omitted: 2,
  });
  assert.match(note ?? "", /statement\.txt/);
  assert.match(note ?? "", /could not read: scan\.png/);
  assert.match(note ?? "", /2 older file\(s\)/);
});

// `file_set` was wrong in both directions at once: it attached the run's own `result.txt` — the
// machine output a client must never see — and none of the files the run actually authored. It
// never fired only because every wedge declaring it also declares `document` first.
test("RUN_OUTPUT matches the run's own result file and nothing a client would want", async () => {
  const { RUN_OUTPUT } = await import("../src/deliverables.wrap");
  assert.equal(RUN_OUTPUT.test("result.txt"), true);
  assert.equal(RUN_OUTPUT.test("result.json"), true);
  assert.equal(RUN_OUTPUT.test("RESULT.TXT"), true);
  // Real deliverable files are never excluded.
  assert.equal(RUN_OUTPUT.test("onboarding-pack.pdf"), false);
  assert.equal(RUN_OUTPUT.test("results-summary.docx"), false);
  assert.equal(RUN_OUTPUT.test("q3-results.xlsx"), false);
});

// A client who answered a question in the portal had their answer stored on the request and read by
// nobody. The next run reported the month was still not available — which from their side is the
// business asking twice for something they already sent.
test("THE CLIENT'S TYPED ANSWER REACHES THE RUN, not just their uploads", async () => {
  const { answersDocument } = await import("../src/materials");
  const doc = answersDocument([
    req({ ask: "The month you want us to close", status: "resolved", response: "July 2026", resolved_at: "2026-08-01T00:00:00Z" }),
    req({ id: "r2", ask: "Your sales-tax rate", status: "resolved", response: "20% standard", resolved_at: "2026-08-02T00:00:00Z" }),
  ]);
  assert.ok(doc);
  assert.equal(doc!.name, "client-answers.md");
  // Question AND answer: "July 2026" is unreadable without the question it settles.
  assert.match(doc!.content, /## The month you want us to close/);
  assert.match(doc!.content, /July 2026/);
  assert.match(doc!.content, /do not ask for them again/);
});

test("unanswered and unresolved requests contribute nothing", async () => {
  const { answersDocument } = await import("../src/materials");
  assert.equal(answersDocument([req({ status: "open", response: "July" })]), undefined);
  assert.equal(answersDocument([req({ status: "resolved", response: "   " })]), undefined);
  assert.equal(answersDocument([]), undefined);
});

test("typed answers are mounted FIRST — they are usually what unblocks the work", async () => {
  const r = req({ response_artifact_ids: ["a1"], response: "July 2026", status: "resolved" });
  const got = await gatherMaterials([r], store([art({})]));
  assert.equal(got.documents[0]!.name, "client-answers.md");
  assert.equal(got.documents[1]!.name, "statement.txt");
});
