import { test } from "node:test";
import assert from "node:assert/strict";
import { validateOutput } from "../src/validate";

/**
 * ═══ THE PRODUCTION FAILURE THESE TESTS ARE FOR ═══
 *
 * Walking a real fresh signup on 2026-08-10, describing the business failed with
 * `output failed validation: expected object JSON, got non-JSON text`. Resubmitting the SAME text
 * succeeded. Flaky, not broken — which is worse, because it means a meaningful fraction of new
 * signups hit a hard failure on their very first interaction with the product, and there is no
 * retry at any layer.
 *
 * The cause was extraction, not the schema: `validateOutput` trimmed and looked for a fenced block,
 * so a model answer with an unfenced object and one line of prose around it ("Here's the result:")
 * failed outright. Structured output is deliberately not used (it hid the answer entirely, 0%
 * success over five signups), so prose around JSON is normal model behaviour and has to be
 * tolerated at the reader.
 *
 * These tests pin the extraction. Nothing here loosens the schema check — the last two cases exist
 * to prove it still fails closed.
 */

const SCHEMA = {
  type: "object",
  required: ["name", "sells"],
  properties: { name: { type: "string" }, sells: { type: "string" } },
};

const ok = (raw: string, expected: unknown, why: string) => {
  const r = validateOutput(raw, SCHEMA);
  assert.equal(r.ok, true, `${why} — errors: ${JSON.stringify(r.errors)}`);
  assert.deepEqual(r.value, expected, why);
};

test("a preamble before the object no longer kills a founder's first shaping attempt", () => {
  ok(
    'Here\'s the result:\n{"name":"Harborline","sells":"bookkeeping"}',
    { name: "Harborline", sells: "bookkeeping" },
    "leading prose",
  );
});

test("trailing commentary after the object is tolerated", () => {
  ok(
    '{"name":"Harborline","sells":"bookkeeping"}\n\nLet me know if you\'d like to adjust anything.',
    { name: "Harborline", sells: "bookkeeping" },
    "trailing prose",
  );
});

test("prose on both sides is tolerated", () => {
  ok(
    'Sure — based on what you told me:\n{"name":"Harborline","sells":"bookkeeping"}\nHappy to refine this.',
    { name: "Harborline", sells: "bookkeeping" },
    "prose both sides",
  );
});

test("a fenced block still wins, including when prose surrounds the fence", () => {
  ok(
    'Here you go:\n```json\n{"name":"Harborline","sells":"bookkeeping"}\n```\nAnything else?',
    { name: "Harborline", sells: "bookkeeping" },
    "fenced with prose",
  );
  ok('```\n{"name":"H","sells":"b"}\n```', { name: "H", sells: "b" }, "unlabelled fence");
});

test("nested objects survive — the matching close is found, not the last brace", () => {
  ok(
    'Result:\n{"name":"Harborline","sells":"bookkeeping","meta":{"tier":{"a":1},"tags":["x"]}}\nDone.',
    { name: "Harborline", sells: "bookkeeping", meta: { tier: { a: 1 }, tags: ["x"] } },
    "nested",
  );
});

test("braces inside string VALUES do not confuse the scan", () => {
  // A depth counter that ignores strings closes this object early, at the `}` inside the sentence.
  ok(
    'Here:\n{"name":"Harborline","sells":"we bill on {net 30} terms"} — hope that helps',
    { name: "Harborline", sells: "we bill on {net 30} terms" },
    "braces in a string value",
  );
});

test("escaped quotes inside strings do not end the string early", () => {
  ok(
    'Output: {"name":"Harborline","sells":"they say \\"chase it\\" }"} thanks',
    { name: "Harborline", sells: 'they say "chase it" }' },
    "escaped quotes",
  );
});

test("an object followed by a SECOND object takes the first, not a broken concatenation", () => {
  ok(
    'First draft:\n{"name":"Harborline","sells":"bookkeeping"}\nOr alternatively:\n{"name":"Other","sells":"tax"}',
    { name: "Harborline", sells: "bookkeeping" },
    "two objects",
  );
});

test("a leading fragment that is not the answer does not stop a later, valid one being found", () => {
  // The first `{` here opens something that satisfies nothing; the real answer is further down.
  ok(
    'Consider {this} for a moment.\n{"name":"Harborline","sells":"bookkeeping"}',
    { name: "Harborline", sells: "bookkeeping" },
    "false-start brace",
  );
});

test("an array schema slices from the first bracket", () => {
  const schema = { type: "array", items: { type: "object" } };
  const r = validateOutput('Here are the two:\n[{"a":1},{"b":2}]\nThat is all.', schema);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(r.value, [{ a: 1 }, { b: 2 }]);
});

test("genuinely no JSON still fails, with the same error shape as before", () => {
  const r = validateOutput("I couldn't work out what you sell — could you say more?", SCHEMA);
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors, ["expected object JSON, got non-JSON text"]);
});

test("JSON that parses but breaks the schema reports SCHEMA errors, not 'non-JSON text'", () => {
  // Extraction must never launder a real validation failure into a different complaint, and must
  // never accept a candidate just because it parsed.
  const r = validateOutput('Here:\n{"name":"Harborline"}\nDone.', SCHEMA);
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors, ["$.sells: required"]);
});

test("the first candidate that BOTH parses and validates wins, even if an earlier one only parses", () => {
  const raw = 'Draft one: {"name":"Harborline"}\nCorrected: {"name":"Harborline","sells":"bookkeeping"}';
  const r = validateOutput(raw, SCHEMA);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(r.value, { name: "Harborline", sells: "bookkeeping" });
});

test("a string schema is unchanged: prose is the answer, and an object in it is not extracted", () => {
  const r = validateOutput('The client said {"paid":true} last week.', { type: "string" });
  assert.equal(r.ok, true);
  assert.equal(r.value, 'The client said {"paid":true} last week.');
});

test("a truncated object does not hang or crash", () => {
  const r = validateOutput('Here: {"name":"Harborline","sells":', SCHEMA);
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors, ["expected object JSON, got non-JSON text"]);
});
