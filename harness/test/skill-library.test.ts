// The shared skill library — the tests that make "a wedge inherits domain procedure" real, and hold
// the prose-only trust line at the import door. Ids are unique per test because the library, like the
// scales, lives under one cross-tenant scope by design.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeFreshApp } from "./helpers";
import { getDomainStore } from "../src/domain";
import type { WedgeManifest } from "../src/wedge";
import {
  parseSkillDoc,
  addLibrarySkill,
  listLibrarySkills,
  removeLibrarySkill,
  librarySkillsForWedge,
  reweightSkills,
  seedLibraryFromDisk,
  type LibrarySkill,
} from "../src/skill-library";
import type { SkillScale } from "../src/skill-scales";

const lib = (name: string): LibrarySkill => ({
  name: `${name}.md`,
  domains: ["x"],
  description: "",
  body: `# ${name}`,
  source: "authored",
  version: 1,
  at: "",
});
const scale = (name: string, accepted: number, total: number): SkillScale => ({
  wedge: "w",
  skill: `${name}.md`,
  accepted,
  revised: total - accepted,
  total,
  acceptance_rate: total ? accepted / total : 0,
});

async function scene() {
  await makeFreshApp();
  return { domain: getDomainStore(), tag: randomUUID().slice(0, 8) };
}

const manifest = (domains: string[]): WedgeManifest => ({ wedge: "x", domains } as unknown as WedgeManifest);

test("library: parseSkillDoc reads frontmatter name + description and enforces .md", () => {
  const s = parseSkillDoc("---\nname: multipage-site\ndescription: Build a real multi-page site.\n---\n# Sites\nDo the thing.", {
    domains: ["web-dev"],
  });
  assert.ok(s);
  assert.equal(s.name, "multipage-site.md");
  assert.equal(s.description, "Build a real multi-page site.");
  assert.deepEqual(s.domains, ["web-dev"]);
  assert.equal(s.source, "authored");
});

test("library: parseSkillDoc falls back to the first heading, and refuses the nameless", () => {
  const s = parseSkillDoc("# Reconcile A Month\nThe procedure.", { domains: ["bookkeeping"] });
  assert.equal(s?.name, "reconcile-a-month.md");
  assert.equal(parseSkillDoc("   ", { domains: ["x"] }), null, "empty is refused");
});

test("library: a source_url marks the skill imported", () => {
  const s = parseSkillDoc("---\nname: seo-basics\ndescription: x\n---\nbody", {
    domains: ["seo"],
    source_url: "https://example.test/seo.md",
  });
  assert.equal(s?.source, "imported");
  assert.equal(s?.source_url, "https://example.test/seo.md");
});

test("library: add then list returns it; re-adding bumps the version, never duplicates", async () => {
  const { domain, tag } = await scene();
  const dom = `web-dev-${tag}`;
  const first = await addLibrarySkill(domain, parseSkillDoc(`---\nname: hero-${tag}\ndescription: d\n---\nb`, { domains: [dom] })!);
  assert.equal(first.version, 1);

  const again = await addLibrarySkill(domain, parseSkillDoc(`---\nname: hero-${tag}\ndescription: d2\n---\nb2`, { domains: [dom] })!);
  assert.equal(again.version, 2, "same name upserts");

  const listed = await listLibrarySkills(domain, { domains: [dom] });
  assert.equal(listed.filter((s) => s.name === `hero-${tag}.md`).length, 1, "one row, not two");
  assert.equal(listed.find((s) => s.name === `hero-${tag}.md`)?.version, 2);
});

test("library: listing filters by domain", async () => {
  const { domain, tag } = await scene();
  const web = `web-${tag}`;
  const design = `design-${tag}`;
  await addLibrarySkill(domain, parseSkillDoc(`---\nname: w-${tag}\ndescription: d\n---\nb`, { domains: [web] })!);
  await addLibrarySkill(domain, parseSkillDoc(`---\nname: d-${tag}\ndescription: d\n---\nb`, { domains: [design] })!);

  const webOnly = await listLibrarySkills(domain, { domains: [web] });
  assert.ok(webOnly.some((s) => s.name === `w-${tag}.md`));
  assert.ok(!webOnly.some((s) => s.name === `d-${tag}.md`), "a design skill is not a web skill");
});

test("library: a wedge draws the library skills for its domains, as mountable files", async () => {
  const { domain, tag } = await scene();
  const dom = `web-dev-${tag}`;
  await addLibrarySkill(domain, parseSkillDoc(`---\nname: nav-${tag}\ndescription: nav\n---\nthe nav procedure`, { domains: [dom] })!);

  const forWedge = await librarySkillsForWedge(domain, manifest([dom]));
  const one = forWedge.find((f) => f.name === `nav-${tag}.md`);
  assert.ok(one, "the domain-matched skill is offered to the wedge");
  assert.match(one.content, /the nav procedure/, "the body is the mountable markdown");

  assert.equal((await librarySkillsForWedge(domain, manifest([]))).length, 0, "a wedge with no domains draws none");
  assert.equal((await librarySkillsForWedge(domain, manifest([`unrelated-${tag}`]))).length, 0, "no domain match, nothing");
});

test("reweight: a well-sampled loser is retired, a winner kept", () => {
  const { kept, retired } = reweightSkills(
    [lib("loser"), lib("winner")],
    [scale("loser", 2, 10), scale("winner", 9, 10)],
  );
  assert.ok(retired.some((r) => r.name === "loser.md"), "0.2 over 10 votes comes off the shelf");
  assert.ok(kept.some((s) => s.name === "winner.md"));
  assert.ok(!kept.some((s) => s.name === "loser.md"));
});

test("reweight: a low rate on too few votes is noise, not a verdict — kept", () => {
  const { kept, retired } = reweightSkills([lib("new")], [scale("new", 0, 3)]);
  assert.equal(retired.length, 0, "three votes decide nothing");
  assert.ok(kept.some((s) => s.name === "new.md"));
});

test("reweight: ranks winners first, unproven above proven losers", () => {
  const { kept } = reweightSkills(
    [lib("mid"), lib("top"), lib("fresh")],
    // 'mid' lands half the time (kept — above the 0.34 floor), 'top' nine in ten, 'fresh' has no votes.
    [scale("top", 9, 10), scale("mid", 5, 10)],
  );
  assert.deepEqual(
    kept.map((s) => s.name),
    ["top.md", "fresh.md", "mid.md"],
    "proven winner, then unproven, then the proven-but-weaker",
  );
});

test("seed: loads kernel/skills/<domain>/*.md and is idempotent", async () => {
  const { domain } = await scene();
  const tag = randomUUID().slice(0, 8);
  const dir = mkdtempSync(join(tmpdir(), "mycel-skills-"));
  const domainName = `web-dev-${tag}`;
  mkdirSync(join(dir, domainName));
  writeFileSync(
    join(dir, domainName, "nav.md"),
    `---\nname: nav-${tag}\ndescription: how to build nav\n---\n# Nav\nthe nav procedure`,
  );
  writeFileSync(join(dir, domainName, "not-a-skill.txt"), "ignored");

  const first = await seedLibraryFromDisk(domain, dir);
  assert.equal(first.seeded, 1, "one .md seeded, the .txt ignored");

  const listed = await listLibrarySkills(domain, { domains: [domainName] });
  const one = listed.find((s) => s.name === `nav-${tag}.md`);
  assert.ok(one, "the seeded skill is in the library");
  assert.deepEqual(one.domains, [domainName], "tagged with its directory name");

  const second = await seedLibraryFromDisk(domain, dir);
  assert.equal(second.seeded, 0, "unchanged seed is not re-written");
  assert.equal(second.skipped, 1, "it is skipped, not duplicated");
});

test("library: remove drops it from the shelf", async () => {
  const { domain, tag } = await scene();
  const dom = `x-${tag}`;
  await addLibrarySkill(domain, parseSkillDoc(`---\nname: gone-${tag}\ndescription: d\n---\nb`, { domains: [dom] })!);
  await removeLibrarySkill(domain, `gone-${tag}`);
  assert.equal((await listLibrarySkills(domain, { domains: [dom] })).length, 0);
});
