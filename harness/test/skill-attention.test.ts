// ATTENTION — the difference between a skill that was available and one that was used.
//
// The bug this fixes is subtle enough to be worth restating: a run mounts a dozen skills, a wedge
// mounts roughly the same dozen every time, and the old scale gave all twelve the same vote. So every
// skill in a wedge converged on the wedge's own acceptance rate and the scoreboard could not tell any
// two of them apart — which is the only comparison it existed to make.

import { test } from "node:test";
import assert from "node:assert/strict";
import { SkillAttention } from "../src/skill-attention";

const MOUNTED = [
  { name: "nobody-remembers-the-redirects.md" },
  { name: "a-round-is-a-batch.md" },
  { name: "scope-before-anything-is-built.md" },
];

test("a `read` of a skill counts as opening it", () => {
  const a = new SkillAttention(MOUNTED);
  a.observe({ filePath: "skills/nobody-remembers-the-redirects.md" });
  assert.deepEqual(a.read, ["nobody-remembers-the-redirects.md"]);
});

test("so does `bash cat`, `grep` and a script — because the tool name is not the evidence", () => {
  // The reason this matches on the path rather than on the tool. A matcher over tool names would
  // miss every one of these SILENTLY: the skill looks unread, loses its vote, and a procedure that
  // works gets marked as dead weight.
  for (const args of [
    { command: "cat skills/a-round-is-a-batch.md", description: "read the batching rule" },
    { command: "grep -n 'scope' skills/scope-before-anything-is-built.md" },
  ]) {
    const a = new SkillAttention(MOUNTED);
    a.observe(args);
    assert.ok(a.read.length > 0, JSON.stringify(args));
  }
});

test("a sweep of the directory is evidence about no skill in particular, and says so", () => {
  // `cat skills/*.md` read everything and named nothing. Counting them all as READ is the original
  // bug in a new hat. Counting them as UNREAD is worse: it drives the attention rate of a procedure
  // the agent demonstrably relied on toward zero, and the library gets pruned on the strength of it.
  for (const args of [
    { command: "for f in skills/*.md; do head -40 $f; done" },
    { pattern: "skills/**/*.md" },
    { command: "ls skills/" },
  ]) {
    const a = new SkillAttention(MOUNTED);
    a.observe(args);
    assert.equal(a.indeterminate, true, JSON.stringify(args));
    const uses = a.uses();
    assert.equal(uses.length, 3);
    // "not known" — neither side of the ratio. The same shape a row from before attention tracking
    // has, which `skillScales` already knows not to count.
    assert.ok(uses.every((u) => u.read === undefined), JSON.stringify(uses));
  }
});

test("a sweep does not erase a skill that was also opened by name", () => {
  const a = new SkillAttention(MOUNTED);
  a.observe({ command: "ls skills/" });
  a.observe({ filePath: "skills/a-round-is-a-batch.md" });
  const uses = a.uses();
  assert.equal(uses.find((u) => u.name === "a-round-is-a-batch.md")?.read, true);
  assert.equal(uses.find((u) => u.name === "nobody-remembers-the-redirects.md")?.read, undefined);
});

test("mentioning a filename without the skills directory is not opening it", () => {
  // The false positive that would make the whole thing noise: a deliverable ABOUT the client's own
  // pricing page must not mark a skill called `pricing.md` as read.
  const a = new SkillAttention([{ name: "pricing.md" }, ...MOUNTED]);
  a.observe({ command: "curl -s https://client.example/pricing.md" });
  a.observe({ content: "Their pricing.md is out of date and the redirects are missing." });
  assert.deepEqual(a.read, []);
});

test("mounted is everything, read is only what was opened", () => {
  const a = new SkillAttention(MOUNTED);
  a.observe({ filePath: "skills/a-round-is-a-batch.md" });
  assert.equal(a.mounted.length, 3);
  assert.equal(a.read.length, 1);
  const uses = a.uses();
  assert.equal(uses.length, 3, "a mounted-and-ignored skill still gets a row");
  assert.equal(uses.filter((u) => u.read).length, 1);
  // The row that answers "is anyone using this" — dropping it would make the question unanswerable
  // in exactly the case where the answer is interesting.
  assert.ok(uses.some((u) => u.name === "scope-before-anything-is-built.md" && !u.read));
});

test("a skill is counted once however many times it is opened", () => {
  const a = new SkillAttention(MOUNTED);
  for (let i = 0; i < 5; i++) a.observe({ filePath: "skills/a-round-is-a-batch.md" });
  assert.equal(a.read.length, 1);
});

test("a name too short to be distinctive is not watched at all", () => {
  // `os.md` would match almost any argument containing the letters. One skill with no attention data
  // beats every skill credited on every call.
  const a = new SkillAttention([{ name: "os.md" }]);
  a.observe({ command: "ls skills/ && echo done" });
  assert.deepEqual(a.read, []);
});

test("unserialisable or empty arguments are not evidence of anything", () => {
  const a = new SkillAttention(MOUNTED);
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  a.observe(circular);
  a.observe(undefined);
  a.observe(null);
  a.observe("");
  assert.deepEqual(a.read, []);
});

test("a giant tool result cannot make the scan unbounded", () => {
  // This runs on every emission in the stream. A tool result can carry a whole file.
  const a = new SkillAttention(MOUNTED);
  const huge = "x".repeat(500_000) + "skills/a-round-is-a-batch.md";
  const started = Date.now();
  a.observe({ output: huge });
  assert.ok(Date.now() - started < 500, "the scan must stay bounded");
  // And the bound is honest about what it costs: content past the cap is genuinely not seen.
  assert.deepEqual(a.read, [], "the match was past the 20k cap and is not claimed");
});
