// Serper's free plan answers 400 to any advanced query syntax — quoted phrases, OR groups,
// -exclusions — with "Query pattern not allowed for free accounts." Every dork `dorksFor` builds is
// made of exactly that syntax, so GTM discovery returned nothing every time and reported it as
// "nobody matched on web search", which reads as an empty market.
//
// Measured against the live key: the allowance is not fixed. The same quoted query answered 200 and
// then 400 once some grace was spent — so this breaks intermittently first and permanently later.

import { test } from "node:test";
import assert from "node:assert/strict";
import { cheapDiscover, dorksFor, isFreeTierPatternRefusal, withoutOperators } from "../src/gtm/discover-cheap";

const REFUSAL = JSON.stringify({ message: "Query pattern not allowed for free accounts.", statusCode: 400 });

test("the provider's refusal is recognised for what it is", () => {
  assert.ok(isFreeTierPatternRefusal(400, REFUSAL));
  assert.ok(!isFreeTierPatternRefusal(400, JSON.stringify({ message: "Not enough credits" })));
  assert.ok(!isFreeTierPatternRefusal(500, REFUSAL));
});

test("stripping operators leaves a query the free plan accepts", () => {
  const dork = '"digital marketing agency" "Boston" ("about us" OR "our story") -jobs -careers -hiring';
  const plain = withoutOperators(dork);
  assert.ok(!/["()]/.test(plain), `quotes or parens survived: ${plain}`);
  assert.ok(!/\bOR\b/.test(plain), `OR survived: ${plain}`);
  assert.ok(!/-\w/.test(plain), `an exclusion survived: ${plain}`);
  assert.match(plain, /digital marketing agency/);
  assert.match(plain, /Boston/);
});

test("a refused dork is retried plain, so a search degrades instead of returning an empty market", async () => {
  const asked: string[] = [];
  const res = await cheapDiscover({
    industries: ["digital marketing agency"],
    location: "Boston",
    apiKey: "test",
    limit: 5,
    fetchImpl: (async (_url: string, init: { body: string }) => {
      const q = (JSON.parse(init.body) as { q: string }).q;
      asked.push(q);
      if (/["()]|\bOR\b|-\w/.test(q)) return { ok: false, status: 400, text: async () => REFUSAL };
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ organic: [{ title: "Acme Marketing", link: "https://acme.example", snippet: "we do marketing" }] }),
      };
    }) as unknown as typeof fetch,
  });

  assert.ok(res.businesses.length > 0, `degrade did not recover: ${res.detail}`);
  assert.ok(asked.some((q) => /["()]/.test(q)), "never tried the precise dork first");
  assert.ok(asked.some((q) => !/["()]/.test(q)), "never retried without operators");
  assert.match(String(res.detail), /broader/, "the founder is not told the match is broader");
});

test("a real failure is reported with the provider's own sentence, not just a status code", async () => {
  const res = await cheapDiscover({
    industries: ["accountants"],
    apiKey: "test",
    fetchImpl: (async () => ({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ message: "Not enough credits" }),
    })) as unknown as typeof fetch,
  });
  assert.equal(res.businesses.length, 0);
  assert.match(String(res.detail), /Not enough credits/, `lost the reason: ${res.detail}`);
});

test("dorksFor still builds precise queries — the degrade is a fallback, not the new default", () => {
  const d = dorksFor({ industries: ["law firm"], location: "Los Angeles" });
  assert.ok(d.length > 0);
  assert.ok(d.some((q) => q.includes('"law firm"')), "precision was thrown away rather than kept as the first try");
});
