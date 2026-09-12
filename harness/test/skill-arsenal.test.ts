import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TRADE_BUNDLES,
  listArsenalIndex,
  matchingBundles,
  pickArsenalBodies,
  skillHasNever,
  withDraftServiceArsenal,
} from "../src/skill-arsenal";

test("arsenal: the shelf is on disk and tagged by desk, not by vertical", () => {
  const index = listArsenalIndex();
  assert.ok(index.length >= 40, `expected a real shelf, got ${index.length}`);
  assert.ok(index.some((s) => s.domain === "bookkeeping" && s.name.includes("monthly-close")));
  assert.ok(index.every((s) => s.domain && !/jewel|florist|dental/i.test(s.domain)));
  assert.ok(TRADE_BUNDLES.every((b) => b.domains.length > 0));
});

test("arsenal: a books brief picks close procedure, not a GEO page", () => {
  const picked = pickArsenalBodies("I keep the books for SMBs and run a month-end close");
  assert.ok(picked.length > 0, "a books sentence must hit the shelf");
  assert.ok(
    picked.some((s) => /close|reconcil|book/i.test(`${s.name} ${s.domain}`)),
    `picked ${picked.map((s) => s.name).join(", ")}`,
  );
});

test("arsenal: draft_service input is filled when the cloud only sent a description", () => {
  const filled = withDraftServiceArsenal({ description: "I run a design studio — scope, proposals, sign-off" });
  assert.ok(Array.isArray(filled.catalogue) && (filled.catalogue as unknown[]).length > 0);
  assert.ok(Array.isArray(filled.capabilities) && (filled.capabilities as unknown[]).length > 0);
  assert.ok(Array.isArray(filled.arsenal) && (filled.arsenal as unknown[]).length > 0);
  assert.ok(Array.isArray(filled.bundles));
  assert.ok(Array.isArray(filled.picked));
  assert.ok(Array.isArray(filled.skill_sources));
  for (const p of filled.picked as Array<Record<string, unknown>>) {
    assert.equal(p.body, undefined, "bodies are mounted as skills, not stuffed into the task JSON");
    assert.ok(typeof p.name === "string" && p.name);
  }
});

test("arsenal: a books brief gets the books desk, not every bundle", () => {
  const picked = pickArsenalBodies("I keep the books for SMBs and run a month-end close");
  const desks = matchingBundles(picked);
  assert.ok(desks.some((b) => b.id === "books"), "books brief must hit the books desk");
  assert.ok(!desks.some((b) => b.id === "geo"), "and must not drag GEO along");
  assert.ok(desks.length < TRADE_BUNDLES.length, "the whole table is not the prompt");
});

test("arsenal: Never is a heading or a list rule, not a footnote somewhere", () => {
  assert.equal(skillHasNever("# Scope\n\nDo the work."), false);
  assert.equal(skillHasNever("# Scope\n\n## Never\n\n- Never invent a client.\n"), true);
  assert.equal(skillHasNever("# Scope\n\n- Never send without approval.\n"), true);
});
