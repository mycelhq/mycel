/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * EDITING THE DOCUMENT, DRIVEN THROUGH THE REAL ROUTES
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `doc-blocks.test.ts` proves the splice is correct on 399 real production documents. That is the
 * hard part and it is not the part that breaks in production: what breaks is the wiring around it —
 * the artifact that never gets written, the version that keeps the OLD file id, the note that
 * typechecks its way into nowhere.
 *
 * So this drives HTTP. Create a deliverable with a real markdown artifact, fetch its blocks the way
 * the console does, post an edit the way the console does, and then assert on what a CLIENT would
 * receive — because every intermediate assertion can pass while the client still gets the old file.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { api, makeApp } from "./helpers";
import { getDomainStore } from "../src/domain";
import { _resetDeliverables } from "../src/deliverables";
import { _resetPortal } from "../src/portal";

const REPORT = `# Ridgeline — April visibility

We would like to possibly suggest that a review might be worthwhile at your earliest convenience.

## What we found

- Impressions fell
- Clicks held

| Metric | April |
| --- | --- |
| Impressions | 12,004 |
`;

/**
 * A deliverable carrying a real markdown file, created the way the delivery path creates one:
 * client, then case, then a task, then an artifact on that task. Short-cutting any of those hits a
 * tenancy check and returns a 400 that a fixture would be tempted to skip on — and a suite that
 * skips is a suite that proves nothing while reporting green.
 */
async function seeded() {
  _resetPortal();
  _resetDeliverables();
  const { app, store } = makeApp();
  const pid = (await api(app, "me")).json.projects[0].id as string;
  const H = { "x-mycel-project": pid };
  const domain = getDomainStore();

  const client = await domain.createClient({
    project_id: pid, display_name: "Ridgeline", handles: ["ops@ridgeline.test"], metadata: {},
  });
  const kase = await domain.createCase({
    project_id: pid, wedge: "books-keeper", title: "Ridgeline engagement",
    client_id: client.id, stage: "open", status: "open", data: {},
  });
  const task = await api(app, "tasks", {
    method: "POST", headers: H,
    body: JSON.stringify({
      wedge: "books-keeper", task_type: "monthly_close", input: { period: "2026-04" },
      client_id: client.id, case_id: kase.id, actor: { kind: "user", id: client.id },
    }),
  });
  assert.equal(task.status, 201, task.text);

  const art = await store.addArtifact({
    task_id: task.json.id, name: "ridgeline-april.md", content_type: "text/markdown", content: REPORT,
  });

  /**
   * Submitted through the AGENT plane, with a real action grant, exactly as `runTask` mints one.
   *
   * This matters for more than realism: the founder path does not set `task_id` on the version, and
   * `task_id` is how a lesson learned from a correction finds the job that produced the work. A
   * fixture that submitted as a founder would have every rule filed under `[]` and would quietly
   * stop testing the thing these tests exist for.
   */
  const { registerActionGrant } = await import("../src/actiongrants");
  const token = await registerActionGrant({ task_id: task.json.id, connectionIds: [] });
  const res = await app.request("/v1/internal/deliverables", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      case_id: kase.id, client_id: client.id, title: "April visibility", kind: "document",
      summary: "April's numbers, with the two that moved.", artifact_ids: [art.id],
    }),
  });
  const text = await res.text();
  assert.equal(res.status, 201, text);
  const made = JSON.parse(text);
  const id = (made.deliverable?.id ?? made.id) as string;
  return { app, store, pid, H, id, clientId: client.id as string, artifactId: art.id as string };
}

const blocksOf = async (app: any, H: any, id: string, artifactId: string) => {
  const got = await api(app, `deliverables/${id}/files/${artifactId}/blocks`, { headers: H });
  assert.equal(got.status, 200, got.text);
  return got.json;
};


test("the console can fetch a document as editable blocks", async () => {
  const { app, H, id, artifactId } = await seeded();
  const doc = await blocksOf(app, H, id, artifactId);

  assert.equal(doc.editable, true);
  assert.equal(doc.format, "markdown");

  const kinds = doc.blocks.map((b: any) => b.kind);
  for (const k of ["heading", "paragraph", "list_item", "table_row"]) {
    assert.ok(kinds.includes(k), `no ${k} block in ${kinds.join(",")}`);
  }

  // The console rebuilds a real table from these. Parsing them back out of `label` would make a
  // display string load-bearing and break the layout the first time anybody rewords it.
  const cell = doc.blocks.find((b: any) => b.kind === "table_row");
  assert.equal(typeof cell.row, "number");
  assert.equal(typeof cell.col, "number");
  // Offsets are the kernel's business — sending them invites a console that splices for itself.
  assert.equal(cell.start, undefined);
  assert.equal(cell.end, undefined);
});

test("editing one paragraph rewrites that paragraph and nothing else in the file", async () => {
  const { app, store, H, id, artifactId } = await seeded();
  const doc = await blocksOf(app, H, id, artifactId);
  const wordy = doc.blocks.find((b: any) => b.text.startsWith("We would like"));
  assert.ok(wordy, "fixture paragraph missing");

  const saved = await api(app, `deliverables/${id}/files/${artifactId}/blocks`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ edits: [{ id: wordy.id, text: "Review this." }], note: "too formal for this client", release: false }),
  });
  assert.equal(saved.status, 200, saved.text);
  assert.equal(saved.json.changed, true);

  const newIds: string[] = saved.json.version.artifact_ids;
  assert.equal(newIds.length, 1);
  assert.notEqual(newIds[0], artifactId, "the version still points at the agent's original file");
  assert.equal(saved.json.version.author, "founder");

  // THE AGENT'S ORIGINAL SURVIVES. The difference between these two files is the most valuable
  // thing this product makes; overwriting it to save a row destroys it.
  const original = await store.getArtifact(artifactId);
  assert.ok(original!.content.includes("We would like to possibly suggest"), "the original bytes were overwritten");

  const next = await store.getArtifact(newIds[0]!);
  const bytes = next!.content;
  assert.ok(bytes.includes("Review this."), "the edit is not in the new file");
  assert.ok(!bytes.includes("We would like to possibly suggest"), "the old sentence survived");
  assert.ok(bytes.includes("# Ridgeline — April visibility"), "the heading was lost");
  assert.ok(bytes.includes("| Impressions | 12,004 |"), "the table was mangled");
  assert.ok(bytes.includes("- Impressions fell"), "the list was lost");
  assert.equal(next!.size_bytes, Buffer.byteLength(bytes, "utf8"), "size_bytes disagrees with the bytes");
});

test("what the founder changed is recorded on the version, block by block", async () => {
  const { app, H, id, artifactId } = await seeded();
  const doc = await blocksOf(app, H, id, artifactId);
  const h1 = doc.blocks.find((b: any) => b.kind === "heading");
  const bullet = doc.blocks.find((b: any) => b.kind === "list_item");

  const saved = await api(app, `deliverables/${id}/files/${artifactId}/blocks`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({
      // Submitted out of document order on purpose.
      edits: [
        { id: bullet.id, text: "Impressions fell 24%" },
        { id: h1.id, text: "Ridgeline — April search visibility" },
      ],
      note: "always give the number",
      release: false,
    }),
  });
  assert.equal(saved.status, 200, saved.text);

  const edits = saved.json.version.edits;
  assert.ok(Array.isArray(edits), "the version carries no record of what changed");
  assert.equal(edits.length, 2);
  assert.equal(edits[0].kind, "heading", "changes are not reported in document order");
  assert.equal(edits[1].kind, "list_item");
  assert.equal(edits[0].before, "Ridgeline — April visibility");
  assert.equal(edits[0].after, "Ridgeline — April search visibility");
  assert.equal(edits[0].artifact_name, "ridgeline-april.md");
  assert.equal(edits[1].label, "Bullet 1");
});

test("the founder's sentence becomes a rule the next run will read", async () => {
  const { app, H, id, artifactId } = await seeded();
  const doc = await blocksOf(app, H, id, artifactId);
  const wordy = doc.blocks.find((b: any) => b.text.startsWith("We would like"));

  await api(app, `deliverables/${id}/files/${artifactId}/blocks`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ edits: [{ id: wordy.id, text: "Review this." }], note: "too formal for this client", release: false }),
  });

  const { getKnowledgeStore } = await import("../src/knowledge.store");
  const pid = (await api(app, "me")).json.projects[0].id as string;
  const rules = await getKnowledgeStore().listRules(pid);
  const learned = rules.find((r: any) => r.provenance?.source === "approval_edit");
  assert.ok(learned, "editing the document taught the system nothing");
  assert.ok(
    learned!.text.includes("too formal for this client"),
    `the founder's own sentence is missing from the rule:\n  ${learned!.text}`,
  );
  assert.equal(learned!.provenance.before, "We would like to possibly suggest that a review might be worthwhile at your earliest convenience.");
  assert.equal(learned!.provenance.after, "Review this.");
});

test("saving the same text twice does not write a second version", async () => {
  const { app, H, id, artifactId } = await seeded();
  const doc = await blocksOf(app, H, id, artifactId);
  const h1 = doc.blocks.find((b: any) => b.kind === "heading");

  const noop = await api(app, `deliverables/${id}/files/${artifactId}/blocks`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ edits: [{ id: h1.id, text: h1.text }], release: false }),
  });
  assert.equal(noop.status, 200, noop.text);
  assert.equal(noop.json.changed, false, "an unchanged save wrote a version");

  const after = await api(app, `deliverables/${id}`, { headers: H });
  assert.equal(after.json.versions.length, 1, "pressing save twice created a version");
});

test("sending the edit releases it, and the client receives the edited file", async () => {
  // Every assertion above can pass while the client still receives the OLD bytes. This is the one
  // that says the founder's correction actually left the building.
  const { app, H, id, artifactId } = await seeded();
  const doc = await blocksOf(app, H, id, artifactId);
  const wordy = doc.blocks.find((b: any) => b.text.startsWith("We would like"));

  const sent = await api(app, `deliverables/${id}/files/${artifactId}/blocks`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ edits: [{ id: wordy.id, text: "Review this." }] }),
  });
  assert.equal(sent.status, 200, sent.text);
  assert.equal(sent.json.released, true, "the default is send — a founder who just retyped a line is ready");
  assert.equal(sent.json.deliverable.status, "with_client");

  const after = await api(app, `deliverables/${id}`, { headers: H });
  const released = after.json.versions.filter((v: any) => v.released_at);
  const newest = released[released.length - 1];
  assert.ok(!newest.artifact_ids.includes(artifactId), "the client was released the agent's original file");
});

test("a file that is not on the version waiting for you cannot be edited", async () => {
  const { app, H, id } = await seeded();
  const res = await api(app, `deliverables/${id}/files/not-a-real-artifact/blocks`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ edits: [{ id: "b0", text: "x" }] }),
  });
  assert.equal(res.status, 404, res.text);
});

test("a deliverable already with the client cannot be edited behind their back", async () => {
  const { app, H, id, artifactId } = await seeded();
  const doc = await blocksOf(app, H, id, artifactId);
  const h1 = doc.blocks.find((b: any) => b.kind === "heading");

  await api(app, `deliverables/${id}/files/${artifactId}/blocks`, {
    method: "POST", headers: H,
    body: JSON.stringify({ edits: [{ id: h1.id, text: "Sent version" }] }),
  });

  const again = await api(app, `deliverables/${id}/files/${artifactId}/blocks`, {
    method: "POST", headers: H,
    body: JSON.stringify({ edits: [{ id: h1.id, text: "Silently different" }] }),
  });
  assert.equal(again.status, 409, again.text);
});

/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * THE PDF — THE DELIVERABLE A FOUNDER COULD NOT TOUCH
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Five of the ten deliverable versions in production carry a PDF and nothing else, and
 * `editableFormat` refuses a PDF — correctly, because it is positioned glyphs and we cannot reflow
 * a document whose source we do not hold.
 *
 * We held it. `renderDocument` calls `blocksFromMarkdown(content)` and then discarded `content`. So
 * the source is now stored beside the PDF with `renders_to` pointing at it, the founder edits the
 * markdown, and the PDF is rebuilt from their version.
 */
async function seededPdf() {
  _resetPortal();
  _resetDeliverables();
  const { app, store } = makeApp();
  const pid = (await api(app, "me")).json.projects[0].id as string;
  const H = { "x-mycel-project": pid };
  const domain = getDomainStore();

  const client = await domain.createClient({ project_id: pid, display_name: "Ridgeline", handles: ["ops@ridgeline.test"], metadata: {} });
  const kase = await domain.createCase({ project_id: pid, wedge: "books-keeper", title: "k", client_id: client.id, stage: "open", status: "open", data: {} });
  const task = await api(app, "tasks", {
    method: "POST", headers: H,
    body: JSON.stringify({ wedge: "books-keeper", task_type: "monthly_close", input: { period: "2026-04" }, client_id: client.id, case_id: kase.id, actor: { kind: "user", id: client.id } }),
  });
  assert.equal(task.status, 201, task.text);

  // A PDF, and the markdown it was rendered from — exactly the pair the orchestrator now writes.
  const pdf = await store.addArtifact({
    task_id: task.json.id, name: "report-April.pdf", content_type: "application/pdf",
    content: Buffer.from("%PDF-1.4 original").toString("base64"), encoding: "base64", size_bytes: 17,
  });
  const src = await store.addArtifact({
    task_id: task.json.id, name: "report-April.md", content_type: "text/markdown",
    content: REPORT, encoding: "utf8", size_bytes: Buffer.byteLength(REPORT), renders_to: pdf.id,
  });

  // Through the agent plane, so the version carries the run that produced it — same reason as
  // `seeded()`: without `task_id` every lesson is filed under `[]` and test 14 stops meaning
  // anything.
  const { registerActionGrant } = await import("../src/actiongrants");
  const token = await registerActionGrant({ task_id: task.json.id, connectionIds: [] });
  const res = await app.request("/v1/internal/deliverables", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    // ONLY the PDF. A `document` deliverable is exactly one file, and the client should receive a
    // report rather than a report plus its own source — so the markdown lives on the RUN.
    body: JSON.stringify({ case_id: kase.id, client_id: client.id, title: "April visibility", kind: "document", summary: "s", artifact_ids: [pdf.id] }),
  });
  const text = await res.text();
  assert.equal(res.status, 201, text);
  const made = JSON.parse(text);
  return { app, store, H, id: (made.deliverable?.id ?? made.id) as string, pdfId: pdf.id, srcId: src.id };
}

test("clicking the PDF opens the text it was built from — the founder never meets the source file", async () => {
  const { app, H, id, pdfId } = await seededPdf();
  const got = await api(app, `deliverables/${id}/files/${pdfId}/blocks`, { headers: H });
  assert.equal(got.status, 200, got.text);
  assert.equal(got.json.editable, true, "a PDF with a stored source is editable through it");
  assert.equal(got.json.format, "markdown");
  assert.equal(got.json.rebuilds, true, "the console is not told the client's copy gets rebuilt");
  // The name they CLICKED, not the internal source filename — the console must not start talking
  // about a file they have never seen.
  assert.equal(got.json.name, "report-April.pdf");
  assert.ok(got.json.blocks.some((b: any) => b.kind === "heading"));
});

test("a PDF with NO stored source still refuses, and says why in words", async () => {
  // Every PDF written before the source was kept looks like this, including the five sitting in
  // production right now. The refusal has to name what DOES work rather than dead-ending.
  _resetPortal();
  _resetDeliverables();
  const { app, store } = makeApp();
  const pid = (await api(app, "me")).json.projects[0].id as string;
  const H = { "x-mycel-project": pid };
  const domain = getDomainStore();
  const client = await domain.createClient({ project_id: pid, display_name: "Legacy", handles: ["a@b.test"], metadata: {} });
  const kase = await domain.createCase({ project_id: pid, wedge: "books-keeper", title: "k", client_id: client.id, stage: "open", status: "open", data: {} });
  const task = await api(app, "tasks", {
    method: "POST", headers: H,
    body: JSON.stringify({ wedge: "books-keeper", task_type: "monthly_close", input: { period: "2026-04" }, client_id: client.id, case_id: kase.id, actor: { kind: "user", id: client.id } }),
  });
  assert.equal(task.status, 201, task.text);
  // A PDF and nothing else on the run — no artifact points at it with `renders_to`.
  const lonely = await store.addArtifact({
    task_id: task.json.id, name: "report-legacy.pdf", content_type: "application/pdf",
    content: Buffer.from("%PDF old").toString("base64"), encoding: "base64", size_bytes: 8,
  });
  const made = await api(app, "deliverables", {
    method: "POST", headers: H,
    body: JSON.stringify({ case_id: kase.id, client_id: client.id, title: "Legacy report", kind: "document", summary: "s", artifact_ids: [lonely.id] }),
  });
  assert.equal(made.status, 201, made.text);
  const id = (made.json.deliverable?.id ?? made.json.id) as string;

  const got = await api(app, `deliverables/${id}/files/${lonely.id}/blocks`, { headers: H });
  assert.equal(got.status, 200, got.text);
  assert.equal(got.json.editable, false, "a PDF with no source must not claim to be editable");
  assert.match(got.json.reason, /rendering/i, got.json.reason);
  assert.match(got.json.reason, /note your client reads|send it back/i, got.json.reason);

  // And a write against it is refused rather than silently doing nothing.
  const wrote = await api(app, `deliverables/${id}/files/${lonely.id}/blocks`, {
    method: "POST", headers: H, body: JSON.stringify({ edits: [{ id: "b0", text: "x" }] }),
  });
  assert.equal(wrote.status, 415, wrote.text);
});

test("editing the PDF rebuilds it from the founder's text and swaps it into the version", async () => {
  const { app, store, H, id, pdfId, srcId } = await seededPdf();

  // Posted against the PDF — the file the founder clicked. The route resolves the source.
  const blocks = (await api(app, `deliverables/${id}/files/${pdfId}/blocks`, { headers: H })).json.blocks;
  const wordy = blocks.find((b: any) => b.text.startsWith("We would like"));
  assert.ok(wordy, "fixture paragraph missing");

  const saved = await api(app, `deliverables/${id}/files/${pdfId}/blocks`, {
    method: "POST", headers: H,
    body: JSON.stringify({ edits: [{ id: wordy.id, text: "Review this." }], release: false }),
  });
  assert.equal(saved.status, 200, saved.text);

  const ids: string[] = saved.json.version.artifact_ids;
  assert.equal(ids.length, 1, "a document deliverable must stay exactly one file");
  assert.ok(!ids.includes(pdfId), "THE CLIENT WOULD STILL GET THE OLD PDF");

  // The new PDF keeps the client-facing filename — a document that renames itself because a
  // heading was reworded looks to the client like a different document.
  const files = await Promise.all(ids.map((i) => store.getArtifact(i)));
  assert.deepEqual(files.map((f) => f!.name), ["report-April.pdf"]);

  const rebuilt = files[0]!;
  assert.notEqual(rebuilt.id, pdfId);
  assert.notEqual(rebuilt.content, Buffer.from("%PDF-1.4 original").toString("base64"), "the PDF was carried over, not rebuilt");
  assert.ok(rebuilt.size_bytes! > 0);

  // And the original bytes of BOTH survive — the agent's version is the other half of every lesson.
  assert.ok((await store.getArtifact(pdfId))!.content.length > 0);
  assert.match((await store.getArtifact(srcId))!.content, /We would like to possibly suggest/);
});

test("a markdown file that renders to nothing is edited without inventing a PDF", async () => {
  const { app, H, id, artifactId } = await seeded();
  const blocks = (await api(app, `deliverables/${id}/files/${artifactId}/blocks`, { headers: H })).json.blocks;
  const h1 = blocks.find((b: any) => b.kind === "heading");
  const saved = await api(app, `deliverables/${id}/files/${artifactId}/blocks`, {
    method: "POST", headers: H,
    body: JSON.stringify({ edits: [{ id: h1.id, text: "Reworded" }], release: false }),
  });
  assert.equal(saved.json.version.artifact_ids.length, 1, "editing a plain markdown file produced a second file");
});

/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * THE LESSON HAS TO REACH THE RUN THAT WRITES THE NEXT ONE
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Both edit routes filed their lesson under `deliverable_verdict` — the spine job that handles a
 * CLIENT'S verdict on finished work, which has never written a report. `ruleApplies` refuses a rule
 * whose `task_types` does not contain the running task's type, so the correction machinery captured
 * the founder's judgment perfectly and filed it where the only run that could use it never looks.
 *
 * Measured before the fix: a `monthly_close` run retrieved 0 of them.
 *
 * This asserts on RETRIEVAL, not on the stored key. Asserting the key would have passed for the
 * whole time the bug existed — `task_types: ["deliverable_verdict"]` was exactly what the code
 * intended to write.
 */
test("a lesson from correcting a report is retrieved by the run that writes the next report", async () => {
  const { app, H, id, artifactId, clientId } = await seeded();
  const doc = await blocksOf(app, H, id, artifactId);
  const wordy = doc.blocks.find((b: any) => b.text.startsWith("We would like"));

  await api(app, `deliverables/${id}/files/${artifactId}/blocks`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ edits: [{ id: wordy.id, text: "Review this." }], note: "too formal for this client", release: false }),
  });

  const pid = (await api(app, "me")).json.projects[0].id as string;
  const { getKnowledgeStore } = await import("../src/knowledge.store");
  const { retrieveRules } = await import("../src/knowledge");
  const active = await getKnowledgeStore().listRules(pid, { wedge: "books-keeper", status: "active" });
  const learned = active.filter((r: any) => r.provenance?.source === "approval_edit");
  assert.ok(learned.length, "the edit taught nothing at all");

  // The fixture's deliverable was produced by a `monthly_close` run. That is the job that will
  // write next month's, and it is the job that has to see this.
  // `client_id` is part of the context because a rule learned on one client's work governs that
  // client — `ruleMayApply` enforces it, and a context without it retrieves nothing.
  const forTheWriter = retrieveRules(learned as any, {
    project_id: pid, wedge: "books-keeper", task_type: "monthly_close", client_id: clientId,
  } as any);
  assert.ok(
    forTheWriter.selected.length > 0,
    `the run that writes the next report retrieves none of the ${learned.length} lesson(s) it just taught us`,
  );
  assert.ok(forTheWriter.selected[0]!.text.includes("too formal for this client"));
});

test("a lesson is not handed to an unrelated job in the same trade", async () => {
  // The other failure mode: filing everything under "" so it matches everything. A correction to a
  // monthly close is not automatically advice about chasing an invoice.
  const { app, H, id, artifactId } = await seeded();
  const doc = await blocksOf(app, H, id, artifactId);
  const h = doc.blocks.find((b: any) => b.kind === "heading");
  await api(app, `deliverables/${id}/files/${artifactId}/blocks`, {
    method: "POST", headers: H,
    body: JSON.stringify({ edits: [{ id: h.id, text: "Reworded" }], release: false }),
  });

  const pid = (await api(app, "me")).json.projects[0].id as string;
  const { getKnowledgeStore } = await import("../src/knowledge.store");
  const active = await getKnowledgeStore().listRules(pid, { wedge: "books-keeper", status: "active" });
  const learned = active.filter((r: any) => r.provenance?.source === "approval_edit");
  assert.ok(learned.length, "nothing was learned");
  for (const r of learned) {
    assert.deepEqual(r.task_types, ["monthly_close"], `filed under ${JSON.stringify(r.task_types)} instead of the producing job`);
  }
});


test("a slide deck is rebuilt as a deck, not silently flattened into a report", async () => {
  // A deck and a report are different documents. Getting this wrong turns a client's slide deck
  // into an A4 page of 10pt text at the moment the founder is fixing one sentence in it — same
  // words, no warning. The run records HOW it rendered on the source's media type; the re-render
  // reads it back rather than guessing from the content.
  _resetPortal();
  _resetDeliverables();
  const { app, store } = makeApp();
  const pid = (await api(app, "me")).json.projects[0].id as string;
  const H = { "x-mycel-project": pid };
  const domain = getDomainStore();
  const client = await domain.createClient({ project_id: pid, display_name: "Deckco", handles: ["a@b.test"], metadata: {} });
  const kase = await domain.createCase({ project_id: pid, wedge: "books-keeper", title: "k", client_id: client.id, stage: "open", status: "open", data: {} });
  const task = await api(app, "tasks", {
    method: "POST", headers: H,
    body: JSON.stringify({ wedge: "books-keeper", task_type: "monthly_close", input: { period: "2026-04" }, client_id: client.id, case_id: kase.id, actor: { kind: "user", id: client.id } }),
  });
  assert.equal(task.status, 201, task.text);

  const pdf = await store.addArtifact({
    task_id: task.json.id, name: "deck-April.pdf", content_type: "application/pdf",
    content: Buffer.from("%PDF deck").toString("base64"), encoding: "base64", size_bytes: 9,
  });
  const src = await store.addArtifact({
    task_id: task.json.id, name: "deck-April.md",
    // What the run wrote down about how it rendered.
    content_type: "text/markdown; profile=deck",
    content: REPORT, encoding: "utf8", size_bytes: Buffer.byteLength(REPORT), renders_to: pdf.id,
  });
  assert.ok(src.id);

  const { registerActionGrant } = await import("../src/actiongrants");
  const token = await registerActionGrant({ task_id: task.json.id, connectionIds: [] });
  const res = await app.request("/v1/internal/deliverables", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ case_id: kase.id, client_id: client.id, title: "April deck", kind: "document", summary: "s", artifact_ids: [pdf.id] }),
  });
  const made = JSON.parse(await res.text());
  const id = (made.deliverable?.id ?? made.id) as string;

  // A `profile=deck` source is still editable — the parameter must not confuse the format check.
  const got = await api(app, `deliverables/${id}/files/${pdf.id}/blocks`, { headers: H });
  assert.equal(got.status, 200, got.text);
  assert.equal(got.json.editable, true, "a deck's source stopped being recognised as markdown");
  assert.equal(got.json.format, "markdown");

  const h = got.json.blocks.find((b: any) => b.kind === "heading");
  const saved = await api(app, `deliverables/${id}/files/${pdf.id}/blocks`, {
    method: "POST", headers: H,
    body: JSON.stringify({ edits: [{ id: h.id, text: "April, reworded" }], release: false }),
  });
  assert.equal(saved.status, 200, saved.text);
  const rebuilt = await store.getArtifact(saved.json.version.artifact_ids[0]!);
  assert.ok(rebuilt, "nothing was written");
  assert.notEqual(rebuilt!.content, Buffer.from("%PDF deck").toString("base64"), "the deck was not rebuilt");

  /**
   * The proof it came back as a DECK is the page geometry, which is the thing a client sees and the
   * one difference no amount of reworded prose can produce: slides are 1280x720 landscape, a report
   * is A4 portrait. Comparing bytes against a freshly rendered deck would be comparing against the
   * UNEDITED text and would fail for the wrong reason.
   */
  const pdfText = Buffer.from(rebuilt!.content, "base64").toString("latin1");
  assert.match(pdfText, /MediaBox \[0 0 1280 720\]/, "the deck was flattened into a portrait report");
  assert.ok(pdfText.includes("April, reworded"), "the founder's edit is not in the rebuilt deck");

  // And the flag is genuinely load-bearing — the two renderings differ.
  const { rerenderDocument } = await import("../src/rerender");
  const asDeck = rerenderDocument({ projectId: pid, markdown: REPORT, title: "April deck", deck: true });
  const asReport = rerenderDocument({ projectId: pid, markdown: REPORT, title: "April deck", deck: false });
  assert.ok(asDeck && asReport);
  assert.notEqual(asDeck!.content, asReport!.content, "deck and report render identically — the flag does nothing");
});

test("the console's own read carries the edit record, or nothing can render it", async () => {
  /**
   * `edits` is stored on the version and the console renders it as "You changed N things before
   * this went out". If the founder-plane READ strips it, the panel is dead on arrival and the only
   * symptom is that it never appears — which looks exactly like "the founder has not edited
   * anything yet", the state we are trying to measure our way out of.
   */
  const { app, H, id, artifactId } = await seeded();
  const doc = await blocksOf(app, H, id, artifactId);
  const h1 = doc.blocks.find((b: any) => b.kind === "heading");

  await api(app, `deliverables/${id}/files/${artifactId}/blocks`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ edits: [{ id: h1.id, text: "Reworded heading" }], release: false }),
  });

  const got = await api(app, `deliverables/${id}`, { headers: H });
  assert.equal(got.status, 200, got.text);
  const newest = got.json.versions[got.json.versions.length - 1];
  assert.equal(newest.author, "founder");
  assert.ok(Array.isArray(newest.edits) && newest.edits.length === 1, "the read stripped the edit record");
  assert.equal(newest.edits[0].label, "Heading");
  assert.equal(newest.edits[0].before, "Ridgeline — April visibility");
  assert.equal(newest.edits[0].after, "Reworded heading");
  assert.equal(newest.edits[0].artifact_name, "ridgeline-april.md");
});
