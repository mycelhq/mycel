import assert from "node:assert/strict";
import test from "node:test";
import { parseName, patternGuess } from "../src/gtm/pattern";
import { emailProvenance, FULLENRICH_RESOLVER } from "../src/gtm/enrich";
import { PATTERN_RESOLVER } from "../src/gtm/pattern";
import { VOYAGER_RESOLVER } from "../src/linkedin/graph";

test("Ada Lovelace is first.last at the company domain", () => {
  assert.deepEqual(parseName("Dr Ada Lovelace PhD"), { first: "ada", last: "lovelace" });
  assert.equal(patternGuess("Ada Lovelace", "acme.com"), "ada.lovelace@acme.com");
  assert.equal(patternGuess("Prince", "acme.com"), "prince@acme.com");
  assert.equal(patternGuess("Ada", "not a domain"), null);
});

test("the find waterfall records pattern before FullEnrich, and skips the paid hop when unpaid", () => {
  const paid = emailProvenance("2026-01-01T00:00:00.000Z", true, 2).email as Record<string, unknown>;
  const paidAttempts = paid.attempts as Array<Record<string, unknown>>;
  assert.equal(paidAttempts[0].by, VOYAGER_RESOLVER);
  assert.equal(paidAttempts[1].by, FULLENRICH_RESOLVER);

  const free = emailProvenance(
    "2026-01-01T00:00:00.000Z",
    false,
    undefined,
    undefined,
    { ok: true, guess: "ada.lovelace@acme.com", note: "guessed" },
    { paid: false },
  ).email as Record<string, unknown>;
  const hops = free.attempts as Array<Record<string, unknown>>;
  assert.equal(hops[0].by, VOYAGER_RESOLVER);
  assert.equal(hops[1].by, PATTERN_RESOLVER);
  assert.equal(hops.some((h) => h.by === FULLENRICH_RESOLVER), false);
});
