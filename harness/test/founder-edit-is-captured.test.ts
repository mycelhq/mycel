/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * THE BUG THIS EXISTS FOR: A FIELD THAT TYPECHECKS AND GOES NOWHERE
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The console asked the founder "what was wrong with it?", the route trimmed and capped the answer,
 * and passed it to the distiller as:
 *
 *     ...(whyChanged ? { reason: whyChanged } : {})
 *
 * `distillFromApprovalEdit` had no `reason` parameter. TypeScript does not excess-property-check a
 * SPREAD, so this compiled clean, every existing test stayed green, and the one input to the whole
 * learning system that cannot be inferred from anything else was dropped on the floor at the point
 * of capture — while the UI told the founder it teaches the next draft.
 *
 * That is the "built but never invoked" shape at its most expensive: not a dead function, but a
 * live path with a hole in the middle of it. The guard is to assert on the OUTPUT — the founder's
 * literal sentence must appear in the rule — because only that is immune to the argument being
 * accepted and ignored.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { distillFromApprovalEdit } from "../src/knowledge";
import { parseBlocks, applyBlockEdits } from "../src/doc-blocks";

const SENTENCE = "too formal for this client";

const distil = (extra: Record<string, unknown> = {}) =>
  distillFromApprovalEdit({
    project_id: "p", wedge: "w", task_type: "deliverable_verdict", action: "deliverable",
    proposed: { client_summary: "We would like to possibly suggest a review at your convenience." },
    edited: { client_summary: "Review this." },
    ...extra,
  });

test("the founder's own sentence reaches the rule the agent will read", () => {
  const [rule] = distil({ reason: SENTENCE });
  assert.ok(rule, "no rule was distilled at all");
  // The TEXT, not just provenance. The text is what gets inlined into the next prompt; a reason
  // parked in a metadata field nothing renders is the same bug wearing a different hat.
  assert.ok(rule.text.includes(SENTENCE), `the reason is not in the rule text:\n  ${rule.text}`);
  assert.equal(rule.provenance.reason, SENTENCE);
});

test("no reason given stays empty rather than becoming a guess", () => {
  const [rule] = distil();
  assert.equal(rule!.provenance.reason, undefined);
  assert.ok(!/They said/.test(rule!.text), "invented an explanation the founder never gave");
});

test("the before and after are kept verbatim — the contrast is the lesson", () => {
  const [rule] = distil({ reason: SENTENCE });
  assert.equal(rule!.provenance.before, "We would like to possibly suggest a review at your convenience.");
  assert.equal(rule!.provenance.after, "Review this.");
});

test("the rule reads as English — `action` is a noun and must not be templated as a verb", () => {
  // "When you deliverable, write ..." shipped for months. It is inlined into the agent's prompt and
  // shown to the founder, and it is the kind of sentence that makes everything near it look broken.
  for (const rule of distil({ reason: SENTENCE })) {
    assert.ok(!/when you deliverable/i.test(rule.text), `ungrammatical rule text:\n  ${rule.text}`);
  }
});

/**
 * The same hole, one layer up: the routes can call the block editor and drop the note, or never call
 * it at all. These assert the CALL SITES in the route file — the functions being defined proves
 * nothing, which `reapSandboxFor` already taught us once.
 */
test("the deliverable routes actually invoke the block editor and pass the founder's note", () => {
  const src = readFileSync(new URL("../src/deliverables.routes.ts", import.meta.url), "utf8");

  assert.ok(/app\.get\("\/v1\/deliverables\/:id\/files\/:artifact\/blocks"/.test(src), "no route serves the blocks");
  assert.ok(/app\.post\("\/v1\/deliverables\/:id\/files\/:artifact\/blocks"/.test(src), "no route saves block edits");

  // Called, not merely imported.
  assert.ok(/=\s*applyBlockEdits\(source, blocks, edits, format\)/.test(src), "applyBlockEdits is imported but never applied");
  assert.ok(/parseBlocks\(source, format\)/.test(src), "parseBlocks is never called on the artifact");

  // The note has to reach the distiller from the block route too, or this whole file's bug returns
  // in the surface that produces the most edits.
  const blockRoute = src.slice(src.indexOf('app.post("/v1/deliverables/:id/files/:artifact/blocks"'));
  assert.ok(/whyChanged\s*\?\s*\{\s*reason:\s*whyChanged\s*\}/.test(blockRoute), "the block route drops the founder's note");
  assert.ok(/author:\s*"founder"/.test(blockRoute), "a founder's rewrite must be attributed to the founder");
  assert.ok(/edits:\s*versionEdits/.test(blockRoute), "the per-block audit trail is never stored on the version");
});

test("an edited document is a NEW artifact — the agent's original bytes are never overwritten", () => {
  const src = readFileSync(new URL("../src/deliverables.routes.ts", import.meta.url), "utf8");
  const blockRoute = src.slice(src.indexOf('app.post("/v1/deliverables/:id/files/:artifact/blocks"'));
  assert.ok(/store\.addArtifact\(/.test(blockRoute), "no new artifact is written");
  // The swap, not a wholesale replacement: a version carrying three files must keep the other two.
  // Two ids can move now — the edited source, and the PDF re-rendered from it — and every other
  // file on the version must still come through untouched.
  assert.ok(/artifact_ids:\s*current\.artifact_ids\.map\(/.test(blockRoute), "the version's file list is not mapped over");
  assert.ok(/id === artifactId \? written\.id/.test(blockRoute), "the edited file is not swapped in place");
  assert.ok(/id === replacedPdfId && rerenderedId \? rerenderedId/.test(blockRoute), "the re-rendered PDF is not swapped in");
  assert.ok(/: id,?\s*\)/.test(blockRoute), "files the founder did not touch are not passed through");
});

test("several corrections of one kind collapse into one lesson, not one per sentence", () => {
  // A founder fixing six table cells has learned us ONE thing about table cells. Six rules keyed to
  // "Row 4, column 2" would be six positions that mean something different next month.
  const src = "| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n";
  const blocks = parseBlocks(src, "markdown");
  const cells = blocks.filter((b) => b.kind === "table_row");
  const { changes } = applyBlockEdits(src, blocks, cells.map((b, i) => ({ id: b.id, text: `v${i}` })), "markdown");
  assert.equal(changes.length, 6, "fixture did not change every cell");

  const before: Record<string, string> = {};
  const after: Record<string, string> = {};
  for (const ch of changes) {
    before[ch.kind] = before[ch.kind] ? `${before[ch.kind]}\n${ch.before}` : ch.before;
    after[ch.kind] = after[ch.kind] ? `${after[ch.kind]}\n${ch.after}` : ch.after;
  }
  const rules = distillFromApprovalEdit({
    project_id: "p", wedge: "w", task_type: "deliverable_verdict", action: "deliverable",
    proposed: before, edited: after, reason: SENTENCE,
  });
  assert.equal(rules.length, 1, `six cell corrections produced ${rules.length} rules`);
  assert.ok(rules[0]!.provenance.before!.includes("\n"), "the individual examples were lost in the grouping");
});
