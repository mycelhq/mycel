// MEMORY IS RECALL, NOT AUTHORITY — and every test here is about one of the two consequences.
//
// Because it binds nothing, an agent may write it with no proposal and no approval, which is the
// thing our deleted self-improvement system could never do (59f1dd83: 261 sandbox-hours, four
// proposals, zero adopted). Because an agent writes it unsupervised, the PATH is assembled from
// model output — and a path is the one field where a loose parser turns a bad guess into a write
// outside its own drawer.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MEMORY_DRAWERS,
  memoryPath,
  wikiLinks,
  memoryTitle,
  timelineGrain,
  timelinePath,
  scoreMemory,
} from "../src/memory";

test("memory: a path is one drawer deep, and nothing else is accepted", () => {
  const ok = memoryPath("clients/acme");
  assert.equal(ok.ok && ok.path, "clients/acme.md");
  assert.equal(ok.ok && ok.drawer, "clients");
  // `.md` optional on input, always present on output — one stored form, so two writes to the same
  // document cannot become two documents.
  assert.equal((memoryPath("clients/acme.md") as { path: string }).path, "clients/acme.md");
  assert.equal((memoryPath("  Clients/ACME  ") as { path: string }).path, "clients/acme.md");
  assert.equal((memoryPath("/clients/acme") as { path: string }).path, "clients/acme.md");
});

test("memory: a path cannot traverse, nest, or land in a drawer that does not exist", () => {
  const bad = [
    "../../etc/passwd",
    "clients/../../secrets",
    "clients/sub/deep",
    "clients",
    "",
    "   ",
    "secrets/keys",
    "clients/Acme Corp",      // spaces are not a slug
    "clients/-leading",       // must start alphanumeric
    `clients/${"a".repeat(80)}`,
  ];
  for (const p of bad) {
    const r = memoryPath(p);
    assert.equal(r.ok, false, `accepted "${p}"`);
    assert.ok(!r.ok && r.reason.length > 0, `refused "${p}" without saying why`);
  }
});

test("memory: every declared drawer actually resolves", () => {
  // A drawer in the list that the validator rejects is a namespace nothing can ever be filed in.
  for (const d of MEMORY_DRAWERS) {
    const r = memoryPath(`${d}/thing`);
    assert.equal(r.ok, true, `drawer "${d}" is declared but unusable`);
  }
});

test("memory: wiki links are parsed, deduped, and keep aliases out of the target", () => {
  const body = "Spoke to [[acme]] about [[september-close]]. See [[acme]] again, and [[dana|Dana Reyes]].";
  assert.deepEqual(wikiLinks(body), ["acme", "september-close", "dana"]);
  // `[[target|label]]` — the link is the target; the label is for the reader.
  assert.deepEqual(wikiLinks("[[acme|Acme Corporation]]"), ["acme"]);
  assert.deepEqual(wikiLinks("no links here"), []);
  assert.deepEqual(wikiLinks(""), []);
});

test("memory: the title comes from the document, so it cannot drift from it", () => {
  assert.equal(memoryTitle("clients/acme.md", "# Acme Corp\n\nThey pay late."), "Acme Corp");
  // No heading: humanise the slug rather than showing a filename to a person.
  assert.equal(memoryTitle("clients/rivet-ledger.md", "no heading"), "Rivet Ledger");
});

test("memory: the timeline coarsens with age rather than on a schedule", () => {
  const now = new Date("2026-09-08T12:00:00Z");
  assert.equal(timelineGrain(new Date("2026-09-08T09:00:00Z"), now), "day");
  assert.equal(timelineGrain(new Date("2026-09-02T09:00:00Z"), now), "day");
  assert.equal(timelineGrain(new Date("2026-08-20T09:00:00Z"), now), "week");
  assert.equal(timelineGrain(new Date("2026-05-01T09:00:00Z"), now), "month");

  // The grain is a function of age, so nothing has to be scheduled to compact it.
  assert.equal(timelinePath(new Date("2026-09-08T09:00:00Z"), now), "timeline/2026-09-08.md");
  assert.equal(timelinePath(new Date("2026-05-01T09:00:00Z"), now), "timeline/2026-05.md");
});

test("memory: weekly buckets stay stable across a year boundary", () => {
  /**
   * ISO weeks, because a naive "week of the year" puts 30 December and 2 January in different
   * years and therefore different documents, splitting one week's history in half at exactly the
   * point somebody is looking back over it.
   */
  const now = new Date("2026-02-15T00:00:00Z");
  const dec30 = timelinePath(new Date("2025-12-30T00:00:00Z"), now);
  const jan01 = timelinePath(new Date("2026-01-01T00:00:00Z"), now);
  assert.equal(dec30, jan01, "the same ISO week landed in two documents");
  assert.match(dec30, /^timeline\/\d{4}-w\d{2}\.md$/);
});

test("memory: every timeline path the coarsener produces is a legal memory path", () => {
  // The two halves have to agree, or the timeline writes into a drawer the validator refuses.
  const now = new Date("2026-09-08T12:00:00Z");
  for (const at of ["2026-09-08", "2026-08-20", "2026-05-01", "2025-12-30"]) {
    const p = timelinePath(new Date(`${at}T00:00:00Z`), now);
    assert.equal(memoryPath(p).ok, true, `${p} is not a storable path`);
  }
});

test("memory: retrieval is deterministic, and knowing nothing scores nothing", () => {
  const doc = { title: "Acme Corp", path: "clients/acme.md", body: "Dana asks for the P&L split by region." };
  const other = { title: "Rivet Ledger", path: "clients/rivet-ledger.md", body: "Quarterly only." };

  // A title match outranks a body match — a document named for the subject is the one wanted.
  assert.ok(scoreMemory(doc, "acme") > scoreMemory(doc, "region"));
  assert.ok(scoreMemory(doc, "acme") > scoreMemory(other, "acme"));

  // No match scores zero, so an empty result reads as "we know nothing about this" rather than
  // returning the least-bad document in the drawer.
  assert.equal(scoreMemory(doc, "warehouse logistics"), 0);
  assert.equal(scoreMemory(doc, ""), 0);
  assert.equal(scoreMemory(doc, "a of"), 0, "stop-length terms should not match everything");

  // Same query, same score, every time.
  assert.equal(scoreMemory(doc, "dana region"), scoreMemory(doc, "dana region"));
});
