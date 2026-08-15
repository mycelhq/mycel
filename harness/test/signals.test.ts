// Signal ingest and lookalike expansion. Neither one sends anything, and both write into exactly
// one tenant's graph — which is what these tests are for.
import { test } from "node:test";
import assert from "node:assert/strict";
import { getDomainStore } from "../src/domain";
import { PEOPLE_COLLECTION } from "../src/linkedin/graph";
import { detectSignals, ingestSignals } from "../src/gtm/signals";
import { gtmWedge } from "../src/gtm/stages";

const domain = () => getDomainStore();

test("detectSignals reads hiring, job change and open-to-work — and stays silent otherwise", () => {
  assert.equal(detectSignals("We're hiring a head of finance")?.signal, "hiring_mention");
  assert.equal(detectSignals("Excited to announce I joined Northwind")?.signal, "job_change");
  assert.equal(detectSignals("Open to work after a tough quarter")?.signal, "open_to_work");
  assert.equal(detectSignals("Thoughts on month-end close"), null);
  assert.equal(detectSignals("   "), null);

  // The worst message in outbound is congratulating someone on losing their job. "Excited to
  // announce I'm open to work" matches both patterns, and it must land on `open_to_work`.
  assert.equal(detectSignals("Excited to announce I'm open to work")?.signal, "open_to_work");
});

test("ingestSignals merges onto an existing person rather than flattening what enrichment paid for", async () => {
  const project = "p-signal-merge";
  await domain().upsertRecord({
    project_id: project,
    wedge: gtmWedge(),
    collection: PEOPLE_COLLECTION,
    key: "dana-okafor",
    data: { profile_id: "dana-okafor", name: "Dana Okafor", email: "dana@acme.com", source: "search" },
  });

  const r = await ingestSignals(domain(), project, [
    { profile_id: "dana-okafor", signal: "hiring_mention", evidence: "we're hiring a controller" },
  ]);
  assert.equal(r.written, 1);

  const row = (await domain().queryRecords({ project_id: project, wedge: gtmWedge(), collection: PEOPLE_COLLECTION }))
    .find((x) => x.key === "dana-okafor")!.data as Record<string, unknown>;
  // The enriched address cost real money. A signal must not be able to erase it.
  assert.equal(row.email, "dana@acme.com");
  assert.equal(row.name, "Dana Okafor");
  assert.equal(row.source, "search");
  assert.equal(row.signal, "hiring_mention");
  assert.equal(row.signal_evidence, "we're hiring a controller");
});

test("ingestSignals refuses to write without a project, and writes into no other one", async () => {
  await assert.rejects(() => ingestSignals(domain(), "", [{ profile_id: "x", signal: "job_change", evidence: "e" }]));

  await ingestSignals(domain(), "p-signal-mine", [
    { profile_id: "rui-silva", signal: "job_change", evidence: "joined Brightlane" },
  ]);
  const theirs = await domain().queryRecords({
    project_id: "p-signal-theirs",
    wedge: gtmWedge(),
    collection: PEOPLE_COLLECTION,
  });
  assert.equal(theirs.length, 0);
});
