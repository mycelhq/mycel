import { test } from "node:test";
import assert from "node:assert/strict";
import { exemplarSkills } from "../src/exemplar";

/**
 * The founder's uploaded deliverable is collected by onboarding and spent HERE. These pin the two
 * properties that make it worth collecting at all: it reaches the run, and it is framed as a
 * standard rather than a template.
 */
const store = (rows: unknown[]) =>
  ({ queryRecords: async () => rows }) as unknown as Parameters<typeof exemplarSkills>[0];

/**
 * A fixture long enough to be a document. `exemplarSkills` refuses anything under MIN_CHARS,
 * because production holds a forty-five character "exemplar" — a scanned PDF whose text layer gave
 * back a filename — and the founder's exemplar REPLACES the wedge's own worked example rather than
 * sitting beside it. These tests are about framing, so the fixture just has to clear the floor.
 */
const REAL = [
  "# March visibility — Northgate Logistics",
  "",
  "Named in 6 of 9 buyer questions, up from 4 in February. The one to look at is",
  "\"third party logistics\", where a competitor takes the answer outright because their",
  "capability page answers the question in the first paragraph and ours does not.",
  "",
  "## What moved",
  "Two of the four misses last month are now hits. Both were fixed by the same change:",
  "putting the answer above the fold instead of after the case studies.",
  "",
  "## What to do next",
  "One page, rewritten to lead with the answer. Expect it to close two of the three",
  "remaining misses within a reporting cycle.",
].join("\n");

test("an uploaded deliverable is mounted as craft, framed as a bar and not a template", async () => {
  const skills = await exemplarSkills(
    store([{ data: { name: "March report.md", text: REAL } }]),
    "proj_1",
  );

  assert.equal(skills.length, 1);
  assert.match(skills[0]!.name, /^exemplar:/, "namespaced so it cannot collide with a wedge skill");
  assert.match(skills[0]!.content, /Named in 6 of 9 buyer questions/, "the actual document reaches the run");

  // The framing is the load-bearing part. "Here is a document" with no instruction produces a
  // pastiche of somebody else's engagement, which is worse than a thin report because it looks
  // finished — so the refusal to copy has to be explicit and adjacent to the text.
  assert.match(skills[0]!.content, /DO NOT COPY IT/);
  assert.match(skills[0]!.content, /Match the STANDARD/);
  assert.match(skills[0]!.content, /markedly shorter or thinner/, "the depth instruction is the point");
});

test("a long document is clipped AND says so", async () => {
  const long = "x".repeat(20_000);
  const skills = await exemplarSkills(store([{ data: { name: "big.md", text: long } }]), "proj_1");
  assert.ok(skills[0]!.content.length < 20_000, "clipped");
  assert.match(
    skills[0]!.content,
    /clipped/i,
    "silent truncation would have the model imitate an ending that is not the real one",
  );
});

test("it never costs a run: no project, no rows, empty text, or a failing store all yield nothing", async () => {
  assert.deepEqual(await exemplarSkills(store([]), undefined), []);
  assert.deepEqual(await exemplarSkills(store([]), "proj_1"), []);
  assert.deepEqual(await exemplarSkills(store([{ data: { name: "e.md", text: "   " } }]), "proj_1"), []);

  const broken = { queryRecords: async () => { throw new Error("db down"); } } as unknown as Parameters<
    typeof exemplarSkills
  >[0];
  assert.deepEqual(
    await exemplarSkills(broken, "proj_1"),
    [],
    "losing the exemplar costs depth on one run; throwing would cost the run",
  );
});


test("an upload that extracted to almost nothing does not become the standard", async () => {
  /**
   * The live case: `rapport-audience-2026-09-05.pdf`, 45 characters, a scanned PDF with no text
   * layer. Harmless if it sat ALONGSIDE the wedge's worked example — but `runtime.ts` picks one, on
   * the argument that two exemplars written to different standards is a style guide the model has
   * to arbitrate between, and the founder's own work wins outright. So those 45 characters replaced
   * a real reference, and the run was told they were "the standard their work is held to".
   */
  const stub = "rapport-audience-2026-09-05.pdf\n\n5 September 2026";
  assert.deepEqual(await exemplarSkills(store([{ data: { name: "r.pdf", text: stub } }]), "proj_1"), []);
});

test("the floor is about being a document, not about being good", async () => {
  // Nothing a professional actually sent a client is this short, and nothing that clears it is
  // rejected for being plain. A floor that started judging quality would be a different feature.
  const plain = "Invoice summary for August.\n\n".repeat(20);
  const skills = await exemplarSkills(store([{ data: { name: "plain.md", text: plain } }]), "proj_1");
  assert.equal(skills.length, 1, "a long but unremarkable document is still a standard");
});
