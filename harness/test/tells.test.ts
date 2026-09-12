// The tells that mark a sentence as machine-written.
//
// `forbids` catches the easy half. A model told not to say "leverage" says "utilise" and produces
// the same empty sentence — the register is unchanged and the reader still knows. What actually
// gives machine writing away is SHAPE: sentences all the same length, three parallel items, "not
// only X but also Y", a summary of something too short to need one, two hedges in a row, a closing
// question that asks for nothing answerable. None of those is a word, so none can be forbidden.
//
// The two tests that matter most are the last two: it must pass writing that is genuinely good, and
// it must not fire on an ordinary sentence. A linter that flags real work gets turned off.
import test from "node:test";
import assert from "node:assert/strict";
import { lintTells, sentencesOf } from "../src/tells";
import { readShipChecks, shipFaults } from "../src/ship-checks";

const rules = (t: { rule: string }[]): string[] => [...new Set(t.map((x) => x.rule))].sort();

const SLOP = `I'm excited to share something we've been working on.

Here's the thing: most bakeries are losing orders.

Not because of their product.

Because of their website.

We recently helped a client unlock significant growth by leveraging a robust, modern, and scalable solution. In short, it was transformative.

Thoughts? 👇 🚀 ✨`;

/** From the content-desk exemplar. Real shape, real numbers, lopsided sentences. */
const GOOD = `A bakery we rebuilt last month was losing about 80% of its online orders on mobile.

Not to a competitor. To a button.

Their order page looked fine on a laptop. On a phone the "Order now" button sat below three product shots and a paragraph about their sourdough starter. You had to scroll past all of it to buy anything, and 4 out of 5 people didn't.

We moved the button above the fold on mobile and left almost everything else alone. Online orders went from 12 a week to 60.

If you sell anything online and you have never opened your own checkout on a phone, do that today. It is free and it takes ninety seconds.`;

test("it catches the shape of a generated post, not just the words", () => {
  const found = rules(lintTells(SLOP, { social: true }));
  for (const r of [
    "opening-formula",
    "corporate-register",
    "structural-symmetry",
    "self-summary",
    "vague-cta",
    "broetry",
    "emoji-furniture",
  ]) {
    assert.ok(found.includes(r), `expected ${r}, got ${found.join(", ")}`);
  }
});

test("it passes writing that is actually good", () => {
  // The test this whole file lives or dies on. A linter that flags real work is a linter somebody
  // turns off, and then nothing is checked at all.
  assert.deepEqual(lintTells(GOOD, { social: true }), []);
});

test("an ordinary sentence is not a tell", () => {
  assert.deepEqual(lintTells("Your July close is attached. Two payments need your answer before I can finish the VAT return."), []);
  assert.deepEqual(lintTells("We moved the button and orders went up. That was the whole change."), []);
  // One hedge is human.
  assert.deepEqual(lintTells("It is just the one thing I could not place in your August ledger."), []);
});

test("uniform sentence length is the clearest structural tell there is", () => {
  // Human writing is lopsided. Every sentence landing within two words of the others is generated.
  const flat = "We build websites for cafes. They convert visitors into orders. The work takes four weeks.";
  assert.ok(rules(lintTells(flat)).includes("uniform-sentences"));

  // And a short fragment after a long sentence is a human fingerprint — exempt by construction
  // rather than by exception, because the minimum-length clause excludes it.
  const lopsided = "We build websites for independent cafes and bakeries, usually in about four weeks. It works.";
  assert.equal(rules(lintTells(lopsided)).includes("uniform-sentences"), false);
});

test("a list of three is a tell in a DM and not in an essay", () => {
  const short = "We do brand, websites, and packaging.";
  assert.ok(rules(lintTells(short)).includes("structural-symmetry"));

  // The same list inside real writing is just a list.
  const long = `${"We have worked with independent food businesses across the south west for six years now. ".repeat(6)}We do brand, websites, and packaging.`;
  assert.equal(rules(lintTells(long)).includes("structural-symmetry"), false);
});

test("`social` changes which rules apply, rather than being a formatting flag", () => {
  const article = `${"This is a long piece about how independent bakeries lose online orders on mobile devices. ".repeat(12)}In summary, check your checkout on a phone.`;
  // An article may legitimately summarise itself.
  assert.equal(rules(lintTells(article, { social: true })).includes("self-summary"), false);
  // A direct message may not.
  assert.ok(rules(lintTells("Your site loses mobile orders. In short, check the button.")).includes("self-summary"));

  // Broetry and emoji only exist in a feed, so they are not checked outside one.
  const broetry = "One.\n\nTwo.\n\nThree.\n\nFour.\n\nFive.";
  assert.ok(rules(lintTells(broetry, { social: true })).includes("broetry"));
  assert.equal(rules(lintTells(broetry)).includes("broetry"), false);
});

test("every violation says what to do instead", () => {
  // A gate that only says "no" teaches nothing, and the same draft returns with the same shape
  // wearing different words.
  for (const t of lintTells(SLOP, { social: true })) {
    assert.ok(t.detail.length > 20, `${t.rule} has no guidance`);
    assert.ok(t.rule && !/\s/.test(t.rule), "rule ids are stable and machine-readable");
  }
});

test("it runs as a ship check, and reports every tell at once", () => {
  // Handed back for repair: fixing a shape one tell at a time across three rounds is how a repair
  // loop burns its budget without finishing.
  const checks = readShipChecks([{ kind: "no_tells", field: "body", social: true }]);
  assert.equal(checks.length, 1);
  const faults = shipFaults({ body: SLOP }, checks);
  assert.equal(faults.length, 1, "one fault carrying every tell, not one fault per tell");
  assert.match(faults[0]!.message, /reads as machine-written/);
  assert.match(faults[0]!.message, /excited/);
  assert.match(faults[0]!.message, /one-line paragraphs/);

  assert.deepEqual(shipFaults({ body: GOOD }, checks), []);
  // Nothing to check is not a failure.
  assert.deepEqual(shipFaults({ body: "" }, checks), []);
  assert.deepEqual(shipFaults({}, checks), []);
});

test("sentence splitting is rough on purpose and does not throw", () => {
  assert.deepEqual(sentencesOf("One. Two! Three?"), ["One.", "Two!", "Three?"]);
  assert.deepEqual(sentencesOf(""), []);
  assert.deepEqual(lintTells(""), []);
  assert.deepEqual(lintTells("   "), []);
});
