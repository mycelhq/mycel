/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * "EVERY MESSAGE, IN FULL" — AND EVERY MESSAGE WAS THE SAME MESSAGE
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Read out of production, 13 September. A real `propose_campaign` artifact, 7,386 bytes, headed
 * "Every message, in full", with a `### Name` section for each of thirteen prospects. Under every
 * name, byte-identical:
 *
 *   "Hi {first_name}, I work with SaaS teams on finding the right co-marketing partners and shaping
 *    joint campaigns. Since you work with founders in France, I thought there may be useful overlap
 *    in the companies and audiences we each see."
 *
 * Twenty-six times. `{first_name}` not even interpolated.
 *
 * It cleared every gate we had, and it was always going to, because every gate we had asks about ONE
 * entry: `each_has` says the field is filled in, `min_words` says it is long enough, `forbids` says
 * it avoids the tells. Nothing asked whether entry two said anything entry one did not. `spread`
 * comes closest and counts distinct ENUM values — small/medium/large — not distinct prose.
 *
 * This is the most visible form of slop a service business can send. A heading per person is a
 * promise that what follows is about that person; thirteen copies of one paragraph breaks it more
 * completely than a short answer would, because a client who spots it stops believing the other
 * twelve were read either.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { shipFaults, trigramOverlap, type ShipCheck } from "../src/ship-checks";

const CHECK: ShipCheck = { kind: "distinct_prose", items: "messages", field: "body" };
const faults = (messages: unknown[], check: ShipCheck = CHECK) =>
  shipFaults({ messages }, [check]).filter((f) => f.kind === "distinct_prose");

/** The production document that motivated this, in miniature. */
const THE_SAME = "Hi {first_name}, I work with SaaS teams on finding the right co-marketing partners.";

test("THIRTEEN COPIES OF ONE PARAGRAPH IS A FAULT", () => {
  const out = faults(Array.from({ length: 13 }, (_, i) => ({ name: `Person ${i}`, body: THE_SAME })));
  assert.equal(out.length, 1, "the repeated campaign still ships");
  assert.match(out[0]!.message, /13 entries and only 1 distinct/);
  // ONE fault, not seventy-eight. Counting pairs would bury the sentence that matters.
  assert.match(out[0]!.message, /13 say the same thing/);
});

test("AND SO IS THE SAME PARAGRAPH WITH THE NAME SWAPPED IN", () => {
  /**
   * The next version of the same failure, and the reason this is similarity rather than equality.
   * Byte-equality would pass this, and it is worth exactly as much to the client.
   */
  const out = faults([
    { body: "Hi Sarah, I work with SaaS teams on finding the right co-marketing partners." },
    { body: "Hi Marcus, I work with SaaS teams on finding the right co-marketing partners." },
    { body: "Hi Priya, I work with SaaS teams on finding the right co-marketing partners." },
  ]);
  assert.equal(out.length, 1, "a template with a name swapped in reads as three different messages");
});

test("GENUINELY DIFFERENT ENTRIES PASS", () => {
  /**
   * The direction that matters more. A gate that fires on real work gets switched off, and then the
   * thirteen-copy case comes back with it.
   */
  const out = faults([
    { body: "Saw the Kestrel launch — the pricing page reads like it was written for procurement." },
    { body: "You mentioned hiring two more bookkeepers. Is the month-end close the reason?" },
    { body: "Your case study on the Halston migration is the only one I found with real numbers in it." },
  ]);
  assert.deepEqual(out, []);
});

test("a list of one, or an empty list, is not a repetition", () => {
  assert.deepEqual(faults([{ body: THE_SAME }]), [], "one entry cannot repeat itself");
  assert.deepEqual(faults([]), []);
  assert.deepEqual(faults([{ body: "" }, { body: "" }]), [], "blank fields are `each_has`'s problem, not this one");
});

test("`distinct` is a FLOOR, so two near-copies in twenty are allowed", () => {
  /**
   * Mirrors `spread`. Three recommendations where two are near-copies is a fault; two similar
   * entries in a long list is how real writing works, and demanding twenty unique paragraphs would
   * make this the gate people disable.
   */
  /*
    Fixtures that are actually distinct. My first attempt varied one digit — "…thought number 18…"
    against "…thought number 19…" — which scores 0.92 and is a near-copy by any honest reading. The
    test failed and the implementation was right, which is the second time today a fixture of mine
    has been the wrong half of the argument.
  */
  const SUBJECTS = [
    "their pricing page reads like it was written for procurement",
    "the Halston case study is the only one with real numbers in it",
    "two more bookkeepers hired and the close still slips",
    "the careers page has three openings and no salary bands",
    "their onboarding email arrives four days after signup",
    "the status page has not been updated since March",
    "support hours are listed in a timezone they do not operate in",
    "the integration docs reference an API version they retired",
    "their changelog stopped in the middle of a migration",
    "the demo booking form asks for company size before a name",
    "shipping estimates are missing from every product page",
    "the trust badges link to a certificate that expired",
    "their blog has not mentioned the new product line once",
    "refund terms appear in the footer and nowhere in checkout",
    "the mobile nav hides the only contact route they offer",
    "testimonials carry first names and no companies",
    "the roadmap page promises a feature shipped last year",
    "search returns nothing for the term on their own homepage",
    "their newsletter archive stops two rebrands ago",
  ];
  /*
    NINETEEN DISTINCT SUBJECTS AND ONE DUPLICATE — which is what the test claims. My second attempt
    cycled ten subjects across twenty slots, so it held ten distinct entries and failed a floor of
    fifteen, correctly. A fixture that does not match the sentence describing it is a test arguing
    with itself.
  */
  const twenty = [...SUBJECTS, SUBJECTS[18]!].map((body) => ({ body }));
  assert.deepEqual(faults(twenty, { ...CHECK, distinct: 15 }), [], "a long list with one duplicate pair failed");
  assert.equal(faults(twenty.map(() => ({ body: THE_SAME })), { ...CHECK, distinct: 15 }).length, 1);
});

test("THE MEASURE ITSELF", () => {
  /**
   * Trigram overlap, because it is already the number this repo reports with — the finding that a
   * work-sample artifact mirrored the prospect's homepage was recorded as "14% median trigram
   * overlap". A second measure would mean two numbers disagreeing about one question.
   */
  assert.equal(trigramOverlap("the same words here", "the same words here"), 1);
  assert.ok(trigramOverlap("Hi Sarah, we do bookkeeping", "Hi Marcus, we do bookkeeping") > 0.5);
  // Measured: 0.000 here, 0.072 for two real sentences from the same trade. The separation from a
  // near-copy at 0.92 is what makes a single threshold safe.
  assert.ok(trigramOverlap("a note about their pricing page", "an unrelated sentence entirely") < 0.2);
  // Punctuation and case must not make two identical sentences look different.
  assert.equal(trigramOverlap("Hello, world!", "hello world"), 1);
});
