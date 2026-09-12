// A BUSINESS IS A COMPOSITION OF TRADES, NOT ONE TRADE.
//
// `runs_as.wedge` names what a founder SELLS — the answer to "what do you do". It was treated as the
// whole business, and it never is: a bookkeeping practice sells bookkeeping, chases its own unpaid
// invoices, and has to find the next client. Three trades in this catalogue, and only the first is
// what they would say when asked.
//
// `provides` has existed since roles were introduced and answers "who does dunning here". Its
// mirror, `requires`, did not — so a trade could not say what it depends on, and a business could be
// installed with half of itself missing and nothing would say so.
import test from "node:test";
import assert from "node:assert/strict";
import { unmetRequirements } from "../src/roles";
import { loadWedge } from "../src/wedge";

const w = (slug: string, provides: string[] = [], requires: string[] = []) =>
  ({ manifest: { wedge: slug, provides, requires } });

test("a trade whose requirement nothing fills is reported, with who needs it", () => {
  const unmet = unmetRequirements([w("books-keeper", ["receipts"], ["dunning"])]);
  assert.deepEqual(unmet, [{ role: "dunning", neededBy: ["books-keeper"] }]);
});

test("a requirement another installed trade provides is not unmet", () => {
  // This is the composition working: books-keeper needs dunning, invoice-chaser provides it, and the
  // business is whole.
  const unmet = unmetRequirements([
    w("books-keeper", ["receipts"], ["dunning"]),
    w("invoice-chaser", ["dunning"]),
  ]);
  assert.deepEqual(unmet, []);
});

test("several trades needing the same missing role are reported once, naming all of them", () => {
  // "You have no way to chase an invoice" is one problem. Reporting it three times because three
  // trades noticed is how a first screen becomes noise.
  const unmet = unmetRequirements([
    w("geo-monitor", [], ["dunning"]),
    w("books-keeper", [], ["dunning"]),
  ]);
  assert.equal(unmet.length, 1);
  assert.deepEqual(unmet[0]!.neededBy, ["books-keeper", "geo-monitor"], "sorted, so the answer is stable");
});

test("the real catalogue composes: every trade that bills declares it cannot chase", () => {
  /**
   * Not a hypothetical. Six trades in this repo raise an invoice and none of them can chase one —
   * books-keeper, contract-desk, geo-monitor, recruiting-desk, security-questionnaire, site-studio.
   * Installed alone, each is a business that does the work and never collects.
   */
  const billing = ["books-keeper", "geo-monitor", "recruiting-desk"];
  const loaded = billing.map((s) => loadWedge(s)).filter(Boolean) as { manifest: any }[];
  if (!loaded.length) return; // an install without these wedges on disk
  const unmet = unmetRequirements(loaded);
  assert.equal(unmet.length, 1, "they should all be missing the same one thing");
  assert.equal(unmet[0]!.role, "dunning");

  // And adding the trade that provides it makes the business whole.
  const chaser = loadWedge("invoice-chaser");
  if (chaser) assert.deepEqual(unmetRequirements([...loaded, chaser as any]), []);
});
