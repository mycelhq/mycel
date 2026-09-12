// THE SHELF'S PAPERWORK — what may be on it, and on whose authority.
//
// `service-skills/` used to be entirely hand-written here, so provenance was not a question anybody
// had to ask. `scripts/skill-harvest.mjs` changed that: the shelf now carries other people's work,
// mounted into runs for paying agencies and reaching their clients. That is redistribution, and the
// two ways to get it wrong are both quiet — an unlicensed file that nobody notices, and a harvested
// file edited in place that the next harvest silently reverts.
//
// These are the checks that make either one loud.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { SKILL_SEARCH_SOURCES } from "../src/skill-arsenal";
import { skillsSeedDir } from "../src/skill-library";

/** Licences we may redistribute under. Adding one is a decision, which is why it is a list. */
const PERMISSIVE = new Set(["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "CC0-1.0"]);

function shelf(): Array<{ path: string; domain: string; file: string; text: string }> {
  const dir = skillsSeedDir();
  const out: Array<{ path: string; domain: string; file: string; text: string }> = [];
  for (const domain of readdirSync(dir)) {
    const d = join(dir, domain);
    let isDir = false;
    try {
      isDir = statSync(d).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    for (const file of readdirSync(d)) {
      if (!file.endsWith(".md")) continue;
      out.push({ path: join(d, file), domain, file, text: readFileSync(join(d, file), "utf8") });
    }
  }
  return out;
}

const field = (text: string, key: string): string | undefined => {
  const end = text.startsWith("---") ? text.indexOf("\n---", 3) : -1;
  if (end < 0) return undefined;
  const m = text.slice(3, end).match(new RegExp(`^\\s*${key}\\s*:\\s*(.+)$`, "m"));
  return m ? m[1].trim() : undefined;
};

test("the shelf is not empty, which would make every check below pass vacuously", () => {
  assert.ok(shelf().length > 50, "expected a real shelf");
});

test("anything that came from somewhere else says where, and under what licence", () => {
  // The check that stops the quiet failure: somebody pastes a good skill they found, it has no
  // frontmatter saying so, and a year later nobody can tell which files we may actually ship.
  for (const s of shelf()) {
    const source = field(s.text, "source");
    if (!source) continue; // written here — the repo's own licence covers it
    const license = field(s.text, "license");
    assert.ok(license, `${s.domain}/${s.file} names a source but no licence`);
    assert.ok(
      PERMISSIVE.has(license!),
      `${s.domain}/${s.file} is under "${license}", which is not on the redistributable list`,
    );
    assert.ok(field(s.text, "attribution"), `${s.domain}/${s.file} carries no attribution line`);
    assert.match(source!, /^https:\/\//, `${s.domain}/${s.file} should point at a fetchable URL`);
  }
});

test("a harvested file says it is harvested, where the person editing it will see it", () => {
  // Edits here are reverted by the next `npm run skills:harvest` without a word. The banner is the
  // only warning anybody gets, so its absence is a bug rather than a style question.
  for (const s of shelf()) {
    if (!field(s.text, "source")) continue;
    assert.match(
      s.text,
      /HARVESTED, NOT WRITTEN HERE/,
      `${s.domain}/${s.file} is harvested but does not say so`,
    );
  }
});

test("nothing on the shelf points at a file that is not on the shelf", () => {
  // Hazard 2 in the harvester's header. Prose an agent cannot follow is not a harmless no-op: it
  // spends a run's budget looking for a file that was never brought.
  const anchorOf = (heading: string) =>
    heading.toLowerCase().replace(/[^a-z0-9 -]/g, "").trim().replace(/ /g, "-");
  for (const s of shelf()) {
    const ids = new Set<string>();
    for (const m of s.text.matchAll(/<a id="([^"]+)"/g)) ids.add(m[1]!);
    for (const m of s.text.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)) ids.add(anchorOf(m[1]!));
    for (const m of s.text.matchAll(/\]\(\s*(?!https?:|mailto:)([^)\s]+)\)/g)) {
      const target = m[1]!;
      assert.ok(
        target.startsWith("#"),
        `${s.domain}/${s.file} links to "${target}" — a path, in a document that has no directory`,
      );
      assert.ok(
        ids.has(target.slice(1)),
        `${s.domain}/${s.file} links to "${target}", which is not a heading or anchor in it`,
      );
    }
  }
});

test("every shelf the shaper may fetch from names a permissive licence", () => {
  assert.ok(SKILL_SEARCH_SOURCES.length > 0);
  for (const s of SKILL_SEARCH_SOURCES) {
    assert.ok(PERMISSIVE.has(s.license), `${s.name} is offered under "${s.license}"`);
    assert.match(s.url, /^https:\/\//, `${s.name} must be https`);
  }
});

test("the shaper is not pointed at anthropics/skills, however good it is", () => {
  // It was, and this is the regression test for putting it back. Public is not open: every SKILL.md
  // there declares `license: Proprietary`, and the LICENSE.txt beside it forbids retaining copies
  // outside Anthropic's services, reproducing them, and creating derivative works — which is
  // precisely what fetching one into our cross-tenant library would be.
  for (const s of SKILL_SEARCH_SOURCES) {
    assert.doesNotMatch(s.url, /anthropics\/skills/i, `${s.name} points at proprietary material`);
  }
  for (const s of shelf()) {
    const source = field(s.text, "source") ?? "";
    assert.doesNotMatch(source, /anthropics\/skills/i, `${s.domain}/${s.file} was taken from it`);
  }
});
