/**
 * WHOSE RULE IS THIS?
 *
 * `scopeMeta` files a rule against one client whenever a `client_id` is passed, and the deliverable
 * edit route always passed one. So EVERY correction a founder has ever made was silently scoped to
 * a single client: change "net margin" to "EBITDA" on one report and next month every other
 * client's report still says net margin.
 *
 * A product whose entire pitch is that corrections compound was compounding them into a
 * single-client corner. Client scope stays the DEFAULT — "Brightline wants Friday summaries" is not
 * a house rule — but the founder can now say which kind of correction they just made, because only
 * they know.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { scopeMeta } from "../src/knowledge.ts";

const src = readFileSync(new URL("../src/deliverables.routes.ts", import.meta.url), "utf8");

test("scopeMeta is what decides, and it turns on the client id alone", () => {
  assert.deepEqual(scopeMeta("cli_1"), { sensitivity: "client", client_id: "cli_1" });
  assert.deepEqual(scopeMeta(undefined), { sensitivity: "house" });
});

test("the edit route omits the client id for a house rule", () => {
  assert.match(src, /const houseRule = b\.scope === "house";/);
  assert.match(
    src,
    /\.\.\.\(houseRule \? \{\} : \{ client_id: d\.client_id \}\)/,
    "the edit is filed against one client again, whatever the founder chose",
  );
});

test("anything but an explicit house scope stays narrow", () => {
  // A typo in a request must not quietly widen a rule to the whole book, so this is an equality
  // test against one literal rather than a truthiness check on an unknown.
  assert.doesNotMatch(src, /b\.scope !== "client"/, "the fallback inverted — unknown now means house");
  assert.doesNotMatch(src, /Boolean\(b\.scope\)/);
});

test("the field is declared, so a typo is a type error rather than silence", () => {
  assert.match(src, /note\?: unknown; scope\?: unknown/);
});
