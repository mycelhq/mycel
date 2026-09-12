import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicaliseKeys, validateOutput } from "../src/validate";

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

test("a hyphen does not cost a client their monthly close", () => {
  // Verbatim from the run. Sixteen transactions reconciled to the penny, a complete P&L — revenue,
  // expenses, net, nine categories — written under `profit-and-loss`. The schema declares
  // `profit_and_loss`. Nothing rejected it (not required, no additionalProperties), so validation
  // passed and the ship bar then withheld the whole close saying the P&L was delivered empty.
  const schema = {
    type: "object",
    properties: {
      client_summary: { type: "string" },
      profit_and_loss: {
        type: "object",
        properties: { revenue_minor: { type: "integer" }, by_category: { type: "array" } },
      },
    },
  };
  const out = canonicaliseKeys(
    { client_summary: "August reconciles.", "profit-and-loss": { revenue_minor: 820000, "by-category": [] } },
    schema,
  ) as Record<string, Record<string, unknown>>;
  assert.equal(out.profit_and_loss?.revenue_minor, 820000);
  assert.equal("profit-and-loss" in out, false);
  // Nested too — the schema describes that object, so its keys get the same treatment.
  assert.equal(Array.isArray(out.profit_and_loss?.by_category), true);

  // Case and camel are the same field to any reader.
  const camel = canonicaliseKeys({ ProfitAndLoss: { revenue_minor: 1 } }, schema) as Record<string, unknown>;
  assert.equal("profit_and_loss" in camel, true);
});

test("canonicalising never guesses: ambiguity and real fields are left alone", () => {
  const schema = { type: "object", properties: { profit_and_loss: { type: "object" }, notes: { type: "string" } } };

  // Two candidates for one declared field. Renaming either would be a coin flip on a client's books.
  const ambiguous = canonicaliseKeys(
    { "profit-and-loss": { a: 1 }, profitAndLoss: { b: 2 } },
    schema,
  ) as Record<string, unknown>;
  assert.equal("profit_and_loss" in ambiguous, false);
  assert.equal("profit-and-loss" in ambiguous, true);

  // The declared field is already there — a near-miss key beside it is the model's own extra, and
  // overwriting the real one with it would be strictly worse than the problem being solved.
  const present = canonicaliseKeys(
    { profit_and_loss: { real: true }, "profit-and-loss": { stray: true } },
    schema,
  ) as Record<string, Record<string, unknown>>;
  assert.equal(present.profit_and_loss?.real, true);

  // A genuinely different key is not a near miss and stays untouched.
  const other = canonicaliseKeys({ profits: { a: 1 } }, schema) as Record<string, unknown>;
  assert.equal("profit_and_loss" in other, false);
  assert.equal("profits" in other, true);
});
