// Unit tests for typed artifact preview — no HTTP, no store.
import { test } from "node:test";
import assert from "node:assert/strict";
import { artifactFileMeta, buildArtifactPreview, csvGrid, previewMode, sandboxHtmlDocument } from "../src/artifact-preview";
import { formatChangeBrief, qualitySignals, revisionLabel } from "../src/deliverables";
import { contentBelongsInline, INLINE_CONTENT_MAX_BYTES } from "../src/artifacts";
import type { Artifact, Deliverable, DeliverableVersion } from "../src/contract";

test("previewMode allowlists pdf/image/text/sheet/html/markdown and refuses svg", () => {
  assert.equal(previewMode("application/pdf", "a.pdf"), "inline");
  assert.equal(previewMode("image/png", "a.png"), "inline");
  assert.equal(previewMode("text/plain", "notes.txt"), "text");
  assert.equal(previewMode("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "a.xlsx"), "sheet");
  assert.equal(previewMode("text/csv", "books.csv"), "sheet");
  assert.equal(previewMode("text/html", "page.html"), "html");
  assert.equal(previewMode("text/markdown", "brief.md"), "markdown");
  assert.equal(previewMode("text/x-python", "model.py"), "text");
  assert.equal(previewMode("application/javascript", "app.ts"), "text");
  assert.equal(previewMode("image/svg+xml", "x.svg"), "none");
});

test("buildArtifactPreview returns sandboxed HTML as JSON, never as text/html bytes", () => {
  const a: Artifact = {
    id: "a1",
    task_id: "t1",
    name: "page.html",
    content_type: "text/html",
    content: "<script>alert(1)</script><h1>Hello</h1>",
    encoding: "utf8",
    created_at: new Date().toISOString(),
  };
  const out = buildArtifactPreview(a);
  assert.equal(out.ok, true);
  if (out.ok) {
    assert.equal(out.kind, "html");
    if (out.kind === "html") {
      assert.match(out.body.html, /Hello/);
      assert.doesNotMatch(out.body.html, /<script/i);
      assert.match(out.body.html, /Content-Security-Policy/);
    }
  }
});

test("sandboxHtmlDocument strips scripts and injects CSP", () => {
  const html = sandboxHtmlDocument(`<html><head></head><body onload="x()"><script>alert(1)</script><p>ok</p></body></html>`);
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /onload=/);
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /<p>ok<\/p>/);
});

test("buildArtifactPreview returns inline Response for PDF bytes", () => {
  const a: Artifact = {
    id: "a2",
    task_id: "t1",
    name: "stmt.pdf",
    content_type: "application/pdf",
    content: Buffer.from("%PDF-1.4 fake").toString("base64"),
    encoding: "base64",
    size_bytes: 12,
    created_at: new Date().toISOString(),
  };
  const out = buildArtifactPreview(a);
  assert.equal(out.ok, true);
  if (out.ok && out.kind === "bytes") {
    assert.match(out.response.headers.get("content-disposition") ?? "", /^inline/);
    assert.equal(out.response.headers.get("content-type"), "application/pdf");
  }
});

test("csvGrid parses quoted fields and reports a sheet", () => {
  const grid = csvGrid(`name,amount\n"Acme, Inc",12\nBeta,3`);
  assert.equal(grid.sheets.length, 1);
  assert.deepEqual(grid.sheets[0]!.rows[0], ["name", "amount"]);
  assert.deepEqual(grid.sheets[0]!.rows[1], ["Acme, Inc", "12"]);
});

test("buildArtifactPreview turns a CSV into a sheet grid", () => {
  const a: Artifact = {
    id: "a3",
    task_id: "t1",
    name: "books.csv",
    content_type: "text/csv",
    content: "a,b\n1,2\n3,4",
    encoding: "utf8",
    created_at: new Date().toISOString(),
  };
  const out = buildArtifactPreview(a);
  assert.equal(out.ok, true);
  if (out.ok && out.kind === "sheet") {
    assert.equal(out.body.sheets[0]!.rows.length, 3);
    assert.deepEqual(out.body.sheets[0]!.rows[0], ["a", "b"]);
  }
});

test("buildArtifactPreview returns markdown as markdown, not a dump", () => {
  const a: Artifact = {
    id: "a4",
    task_id: "t1",
    name: "notes.md",
    content_type: "text/markdown",
    content: "# Title\n\nHello **world**.",
    encoding: "utf8",
    created_at: new Date().toISOString(),
  };
  const out = buildArtifactPreview(a);
  assert.equal(out.ok, true);
  if (out.ok) assert.equal(out.kind, "markdown");
});

test("artifactFileMeta exposes preview mode for the inspector", () => {
  const meta = artifactFileMeta({
    id: "a",
    name: "books.xlsx",
    content_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    size_bytes: 100,
    encoding: "base64",
  });
  assert.equal(meta.preview, "sheet");
  assert.equal(meta.name, "books.xlsx");
});

test("qualitySignals count revisions and change requests", () => {
  const d: Deliverable = {
    id: "d1",
    project_id: "p",
    case_id: "c",
    client_id: "cl",
    title: "March close",
    kind: "document",
    status: "accepted",
    current_version: 2,
    accepted_at: "2026-08-12T12:00:00.000Z",
    created_at: "2026-08-10T12:00:00.000Z",
    updated_at: "2026-08-12T12:00:00.000Z",
  };
  const versions: DeliverableVersion[] = [
    {
      id: "v1",
      project_id: "p",
      deliverable_id: "d1",
      version: 1,
      summary: "first",
      artifact_ids: [],
      released_at: "2026-08-11T12:00:00.000Z",
      change_request: "fix logo",
      change_requested_at: "2026-08-11T14:00:00.000Z",
      created_at: "2026-08-11T10:00:00.000Z",
    },
    {
      id: "v2",
      project_id: "p",
      deliverable_id: "d1",
      version: 2,
      summary: "fixed",
      artifact_ids: [],
      released_at: "2026-08-12T10:00:00.000Z",
      accepted_at: "2026-08-12T12:00:00.000Z",
      created_at: "2026-08-12T09:00:00.000Z",
    },
  ];
  const q = qualitySignals(d, versions);
  assert.equal(q.revision_count, 2);
  assert.equal(q.revision_cap, 5);
  assert.equal(q.change_request_count, 1);
  assert.equal(q.hours_to_first_release, 24);
  assert.equal(q.hours_to_accept, 48);
});

test("revisionLabel names the round a founder can read", () => {
  assert.equal(revisionLabel(1), "First version");
  assert.equal(revisionLabel(3), "Revision 3");
});

test("formatChangeBrief puts file comments above the overall ask", () => {
  const brief = formatChangeBrief("make it premium", [
    { file: "cover.png", note: "wrong colour" },
    { file: "sow.pdf", note: "logo too small" },
  ]);
  assert.match(brief, /^On cover\.png: wrong colour/);
  assert.match(brief, /On sow\.pdf: logo too small/);
  assert.match(brief, /make it premium$/);
});

test("large artifacts do not belong inline", () => {
  assert.equal(contentBelongsInline(100), true);
  assert.equal(contentBelongsInline(INLINE_CONTENT_MAX_BYTES), true);
  assert.equal(contentBelongsInline(INLINE_CONTENT_MAX_BYTES + 1), false);
});
