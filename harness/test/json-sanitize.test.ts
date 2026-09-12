import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeStringForDb, sanitizeForDb, stringifyForDb } from "../src/json-sanitize";

const NUL = "\u0000";

// The bug behind this: books-keeper monthly_close died on `unsupported Unicode escape sequence` when
// gpt-4o emitted a NUL in its close notes and the JSONB write threw. These lock the sanitize boundary.

test("strips NUL bytes that Postgres jsonb/text reject", () => {
  assert.equal(sanitizeStringForDb(`bal${NUL}ance`), "balance");
  assert.equal(sanitizeStringForDb(NUL), "");
  // The exact failure shape: a JSON string carrying a NUL must serialize without the \\u0000 escape.
  assert.ok(!stringifyForDb({ note: `reconciled${NUL} to the cent` }).includes("\\u0000"));
});

test("replaces lone surrogates but preserves valid pairs (real emoji)", () => {
  assert.equal(sanitizeStringForDb("a\uD800b"), "a�b"); // lone high
  assert.equal(sanitizeStringForDb("a\uDC00b"), "a�b"); // lone low
  const money = "\u{1F4B0}"; // 💰, a valid surrogate pair
  assert.equal(sanitizeStringForDb(`cash ${money}`), `cash ${money}`);
});

test("leaves well-formed content byte-for-byte identical", () => {
  const clean = "Harborline's July books are reconciled and closed — one receipt outstanding.";
  assert.equal(sanitizeStringForDb(clean), clean);
});

test("deep-sanitizes nested objects, arrays, and keys", () => {
  const dirty = {
    client_summary: `closed${NUL} cleanly`,
    anomalies: [`one${NUL}charge`, "fine"],
    nested: { [`bad${NUL}key`]: "ok" },
    n: 42,
    b: true,
    z: null,
  };
  const out = sanitizeForDb(dirty) as Record<string, unknown>;
  assert.equal(out.client_summary, "closed cleanly");
  assert.deepEqual(out.anomalies, ["onecharge", "fine"]);
  assert.deepEqual(out.nested, { badkey: "ok" });
  assert.equal(out.n, 42);
  assert.equal(out.b, true);
  assert.equal(out.z, null);
  assert.doesNotThrow(() => JSON.parse(stringifyForDb(dirty)));
});
