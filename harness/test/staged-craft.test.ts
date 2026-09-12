// The rest of the shelf, reachable.
//
// `arsenalSkillsForBrief` mounts four whole skills, and the limit that says four explains itself
// well: truncating craft leaves a run that can DESCRIBE good design and cannot execute it. Both
// halves of that are right. What it left unsaid is what happens to the fifth-best match on a shelf
// of 221 — it did not exist as far as the run was concerned.
//
// open-design solved the same problem the other way: body in the prompt, references ON DISK, and a
// preamble saying where, "so the agent can read them when needed". This applies that to the shelf.

import { test } from "node:test";
import assert from "node:assert/strict";

import { arsenalSkillsForBrief, stagedArsenalForBrief } from "../src/skill-arsenal";

const BRIEF = {
  wedge: "content-desk",
  task_type: "write_report",
  input: { brief: "A quarterly SEO performance report for a client, with charts and a summary deck." },
};

test("what is mounted is never also staged — we do not pay twice", () => {
  const mounted = arsenalSkillsForBrief(BRIEF).map((s) => s.name.replace(/^arsenal\//, ""));
  const staged = stagedArsenalForBrief(BRIEF).files.map((f) => f.path.replace(/^craft\//, "").replace(/\.md$/, ""));
  for (const m of mounted) {
    assert.ok(!staged.includes(m), `${m} is in the prompt AND on disk — the double payment this exists to stop`);
  }
});

test("the staged set reaches past the four that fit in the prompt", () => {
  const { files } = stagedArsenalForBrief(BRIEF);
  assert.ok(files.length > 0, "nothing staged — the fifth-best match is still unreachable");
  // Every staged file carries a real body, not a stub. A file with nothing in it is worse than no
  // file: the agent spends a read to learn we had nothing to say.
  for (const f of files) {
    assert.ok(f.content.trim().length > 200, `${f.path} is too thin to be worth opening`);
    assert.match(f.path, /^craft\/[a-z0-9-]+\/[^/]+\.md$/, `${f.path} is not a readable path`);
  }
});

test("an index exists, because a directory nobody was told about is not read", () => {
  const { index, files } = stagedArsenalForBrief(BRIEF);
  assert.ok(index.includes("craft/"), "the index names no paths");
  // Every staged file must be listed. One that is written and not indexed is invisible.
  for (const f of files) {
    assert.ok(index.includes(f.path), `${f.path} was staged and never listed`);
  }
  // And it must say these are NOT already in context, or the agent assumes it has read them.
  assert.match(index, /NOT in your context/i, "the index does not say the files are unread");
});

test("a brief with nothing to match stages nothing rather than everything", () => {
  const empty = stagedArsenalForBrief({ wedge: "", task_type: "", input: {} });
  assert.deepEqual(empty.files, []);
  assert.equal(empty.index, "", "an index with no files is a prompt cost for nothing");
});

test("it is bounded — a run does not wait on 200 writes it will not open", () => {
  // Staging is cheap, not free: each file is a round trip into the sandbox before the agent starts.
  const wide = stagedArsenalForBrief({
    wedge: "content-desk",
    task_type: "write_report",
    input: { brief: "design report deck landing page email brand content marketing seo social copy" },
  });
  assert.ok(wide.files.length <= 20, `staged ${wide.files.length} files — the cap is gone`);
});
