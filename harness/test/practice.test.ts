import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { practiceSkills, PRACTICE_COLLECTION } from "../src/practice.ts";
import type { DomainStore } from "../src/domain.ts";

const ROW = {
  deliverable: "Quarterly covenant review",
  answers: "Are we still inside our lending covenants, and what breaks first if we are not.",
  cadence: "quarterly, within 10 working days of quarter end",
  needs: ["the signed facility agreement", "management accounts for the quarter"],
  checks: ["Every ratio quoted is recomputed from the management accounts, not carried forward"],
  practice: "Opens on the headroom number. Never leads with methodology.",
};

function store(rows: unknown[]): DomainStore {
  return { queryRecords: async () => rows } as unknown as DomainStore;
}

test("mounts nothing without a project", async () => {
  assert.deepEqual(await practiceSkills(store([{ data: ROW }]), "business-shaper", undefined), []);
});

test("mounts nothing when no practice has been derived", async () => {
  assert.deepEqual(await practiceSkills(store([]), "business-shaper", "p1"), []);
});

test("mounts nothing when the shaping role is unfilled", async () => {
  assert.deepEqual(await practiceSkills(store([{ data: ROW }]), undefined, "p1"), []);
});

test("a stored row with no prose body mounts nothing", async () => {
  // The schema requires `practice`, so an empty one means the run failed its own contract. Mounting
  // a heading with no method under it would read as authoritative emptiness.
  const rows = [{ data: { ...ROW, practice: "   " } }];
  assert.deepEqual(await practiceSkills(store(rows), "business-shaper", "p1"), []);
});

test("carries the deliverable, the question, the needs and the checks", async () => {
  const [skill] = await practiceSkills(store([{ data: ROW }]), "business-shaper", "p1");
  assert.ok(skill);
  assert.match(skill.name, /Quarterly covenant review/);
  for (const s of [ROW.answers, ROW.needs[0]!, ROW.checks[0]!, ROW.practice, ROW.cadence]) {
    assert.ok(skill.content.includes(s), `missing: ${s}`);
  }
});

test("an unknown cadence is omitted rather than asserted", async () => {
  const rows = [{ data: { ...ROW, cadence: "unknown" } }];
  const [skill] = await practiceSkills(store(rows), "business-shaper", "p1");
  assert.ok(!/\*\*Cadence/.test(skill!.content));
});

test("checks are framed as refusal conditions, not aspirations", async () => {
  const [skill] = await practiceSkills(store([{ data: ROW }]), "business-shaper", "p1");
  assert.match(skill!.content, /refusal conditions/);
  assert.match(skill!.content, /held with the reason/);
});

test("says the exemplar outranks it", async () => {
  // The ordering argument in practice.ts only holds if the mounted text states it: this is a
  // model's reading of an artefact, and the artefact is the primary source.
  const [skill] = await practiceSkills(store([{ data: ROW }]), "business-shaper", "p1");
  assert.match(skill!.content, /the exemplar wins/);
});

test("a long practice is clipped rather than mounted whole", async () => {
  const rows = [{ data: { ...ROW, practice: "x".repeat(40_000) } }];
  const [skill] = await practiceSkills(store(rows), "business-shaper", "p1");
  assert.ok(skill!.content.length < 12_000);
  assert.match(skill!.content, /clipped/);
});

test("runtime mounts the practice below the exemplar and only for deliver shapes", () => {
  // The whole point is the order of authority. A mount that lands above `founderExemplars` makes an
  // inference outrank its own evidence, and one that runs on every shape spends the read on jobs
  // that are not producing a client deliverable.
  const src = readFileSync(new URL("../src/runtime.ts", import.meta.url), "utf8");
  const exemplar = src.indexOf("...founderExemplars,");
  const method = src.indexOf("...method,");
  assert.ok(exemplar > 0 && method > exemplar, "practice must mount after the exemplar");
  assert.match(src, /profile\.shape === "deliver" && task\.project_id\s*\n?\s*\? await practiceSkills/);
});

test("the collection name matches what the shaping wedge writes", () => {
  assert.equal(PRACTICE_COLLECTION, "practice");
});

test("an unconfirmed practice is mounted as a prior, not as instruction", () => {
  // A reading of one artefact that nobody has checked must not be defended against the founder's
  // actual preference. The distinction is mounted, not merely stored.
  return practiceSkills(store([{ data: ROW }]), "business-shaper", "p1").then(([skill]) => {
    assert.match(skill!.content, /NOT YET CONFIRMED/);
    assert.match(skill!.content, /strong prior rather than as instruction/);
  });
});

test("a confirmed practice is mounted as house rule", () => {
  const rows = [{ data: { ...ROW, confirmed_at: "2026-09-05T00:00:00Z" } }];
  return practiceSkills(store(rows), "business-shaper", "p1").then(([skill]) => {
    assert.match(skill!.content, /confirmed it/);
    assert.match(skill!.content, /house rule/);
    assert.ok(!/NOT YET CONFIRMED/.test(skill!.content));
  });
});
