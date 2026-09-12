// The gate that a real eval walked straight through.
//
// `collections-chase` scored 0.75 — below its 0.75 floor — on a real-key run, and the judge's one
// fix was "the placeholders for amount, due date, invoice number, and payment link need to be
// replaced with actual data before sending." The `placeholder` vocabulary was a substring list
// holding `"[insert"`, and `[amount]` contains none of it, so the message passed every check and
// would have reached a client.
//
// The prose was fine. That is the point: this is a DATA-BINDING failure wearing good writing, and
// the only thing that catches it is the shape of the hole rather than a list of known holes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { unresolvedSlots } from "../src/ship-checks";

test("the message that actually got through", () => {
  const real =
    "Hi there,\n\nOur records show invoice [invoice number] for [amount] became due on " +
    "[due date] and remains unpaid. You can settle it here: [payment link].\n\nBest regards";
  const hits = unresolvedSlots(real);
  for (const slot of ["[invoice number]", "[amount]", "[due date]", "[payment link]"]) {
    assert.ok(hits.includes(slot), `missed ${slot} — this is the exact string that shipped`);
  }
});

test("the mail-merge syntaxes a model reaches for instead", () => {
  for (const s of ["{{amount}}", "{client_name}", "<invoice_no>", "%DUE_DATE%", "${total}", "Paid: ____"]) {
    assert.equal(unresolvedSlots(`Owing ${s} today`).length > 0, true, `missed ${s}`);
  }
});

test("brackets a person meant to type are left alone", () => {
  // If this check fires on honest prose it gets switched off, and then it protects nothing. Every
  // case here is a real thing that appears in client-facing writing.
  const safe = [
    "As noted in the guidance [1] and the follow-up [12].",
    "They wrote that it was 'reconsiled' [sic] in the original.",
    "The client [Acme Ltd] confirmed the figure on Tuesday.",
    "The balance [which we discussed at length on the call last week] is now settled.",
    "Quoted [emphasis added] from their own terms.",
  ];
  for (const s of safe) assert.deepEqual(unresolvedSlots(s), [], `false positive on: ${s}`);
});

test("a resolved message is clean — the check has to be passable", () => {
  const good =
    "Hi Sam,\n\nInvoice INV-2043 for £1,240.00 became due on 14 August and is now 21 days " +
    "overdue. You can pay it here: https://pay.mycelai.dev/inv/2043.\n\nBest, Hannah";
  assert.deepEqual(unresolvedSlots(good), []);
});
