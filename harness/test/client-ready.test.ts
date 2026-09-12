// Every deliverable in production on the day this was written was a refusal, rendered as a branded
// PDF and put in front of a client to "review and accept". The four strings below are verbatim from
// those rows. They are the regression suite: if any scores `deliver` again, a customer is reading
// our implementation notes in their portal.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  asksToOpen,
  decideFate,
  declaredNeeds,
  internalTerms,
  looksMachine,
  missingSubstance,
  weekBody,
  clipToBoundary,
  readsAsMissingInput,
  MAX_OPEN_ASKS,
} from "../src/client-ready";

const REAL_JSON = `{"query":"AI that runs the back office for a small agency","surface":"unavailable","cited":[],"raw_excerpt":"Probe unavailable"}`;
const REAL_OPERATOR =
  "Monitoring is not live yet because the measurement service could not start the required probes or compute share of voice. Retry the weekly run after the probe and measurement endpoints are available.";
const REAL_RECRUITING = `{"role":"Northwing","candidates":[],"summary":"No candidates were sourced. The case does not contain a role brief or connected candidate-source ID."}`;
const REAL_BOOKS =
  "The monthly close for Brightline Dental could not be completed because the close period, latest bank statement, start confirmation, and registered sales-tax rate are not yet available.";

test("looksMachine catches serialised output, including a blob that lost its opening brace", () => {
  assert.equal(looksMachine(REAL_JSON), true);
  assert.equal(looksMachine("[]"), true);
  assert.equal(looksMachine(""), true);
  assert.equal(looksMachine(`"surface":"unavailable","cited":[]}`), true);
  assert.equal(looksMachine("Your March books are closed. Profit was £4,200, up from £3,900."), false);
});

test("internalTerms finds our vocabulary but does not fire on ordinary business prose", () => {
  const hits = internalTerms(REAL_OPERATOR);
  assert.ok(hits.includes("probes"), "should catch 'probes'");
  assert.ok(hits.includes("retry the weekly"), "should catch 'retry the weekly'");

  // "capital", "rapidly", "annulled", "casework" — substring matching turns every one of these into
  // a false positive, and a guard that holds real work gets switched off within a week.
  assert.deepEqual(
    internalTerms("Capital expenditure rose rapidly. The annulled charge was refunded, and casework is on track."),
    [],
  );
  // The client's own nouns are never banned.
  assert.deepEqual(internalTerms("Your invoice and bank statement are attached in this report."), []);
});

test("the words that are ALSO the client's words are not banned", () => {
  // Each of these was in the first draft of the list and each would hold real, correct work.
  // A security-questionnaire customer talks about endpoints for a living.
  assert.deepEqual(
    internalTerms("We answered 41 questions on your API and endpoint security, and returned the completed pack."),
    [],
  );
  assert.deepEqual(
    internalTerms("Your sales pipeline and customer database are now reconciled, and the onboarding workflow is documented."),
    [],
  );
  // And the whole sentence still delivers, not just the vocabulary check.
  const body = "We answered 41 questions on your API and endpoint security. Nothing needs you.";
  assert.equal(decideFate({ text: body, clientSummary: body }).fate, "deliver");
});

test("readsAsMissingInput separates a refusal from finished work", () => {
  assert.equal(readsAsMissingInput(REAL_BOOKS), true);
  assert.equal(readsAsMissingInput(REAL_RECRUITING), true);
  assert.equal(readsAsMissingInput("March is closed and reconciled to the penny."), false);
});

test("declaredNeeds reads structure, including books-keeper's {question, best_guess} objects", () => {
  assert.deepEqual(declaredNeeds({ needs: ["Your March bank statement", "The signed engagement letter"] }), [
    "Your March bank statement",
    "The signed engagement letter",
  ]);
  assert.deepEqual(
    declaredNeeds({
      questions: [{ question: "Acme Supplies appears monthly — is that always office supplies?", best_guess: "office" }],
    }),
    ["Acme Supplies appears monthly — is that always office supplies?"],
  );
  assert.deepEqual(declaredNeeds({ needs: ["A"], missing: ["A", "B"], blocked_on: "not an array" }), ["A", "B"]);
  assert.deepEqual(declaredNeeds({ summary: "could not proceed" }), []);
  assert.deepEqual(declaredNeeds(null), []);
});

test("THE FOUR THAT SHIPPED: none of them reaches a client again", () => {
  assert.equal(decideFate({ text: REAL_JSON, parsed: JSON.parse(REAL_JSON) }).fate, "hold");

  // The one that matters most: the wedge PUT this in `client_summary`, so trusting the field name
  // was enough to ship it. The label is intent, not evidence.
  const operator = decideFate({ text: REAL_OPERATOR, clientSummary: REAL_OPERATOR, parsed: {} });
  assert.equal(operator.fate, "hold");
  assert.match(operator.reason, /operator/);

  // A refusal that never named what would unblock it is not an answerable question either.
  assert.equal(decideFate({ text: REAL_BOOKS, clientSummary: REAL_BOOKS, parsed: {} }).fate, "hold");
});

test("the SAME refusal becomes an answerable ASK once the wedge names its needs", () => {
  const v = decideFate({
    text: REAL_BOOKS,
    clientSummary: REAL_BOOKS,
    parsed: { needs: ["Your March bank statement", "Your registered sales-tax rate"] },
  });
  assert.equal(v.fate, "ask");
  assert.deepEqual(v.needs, ["Your March bank statement", "Your registered sales-tax rate"]);

  const r = decideFate({
    text: REAL_RECRUITING,
    parsed: { ...JSON.parse(REAL_RECRUITING), needs: ["The role brief for Northwing"] },
  });
  assert.equal(r.fate, "ask");
  assert.deepEqual(r.needs, ["The role brief for Northwing"]);
});

test("real work still reaches the client", () => {
  const close =
    "March is closed. You made £4,210 — about the same as February. One thing to look at: the Adobe subscription doubled to £99. Nothing else needs you.";
  const a = decideFate({ text: close, clientSummary: close, parsed: { reconciled: true } });
  assert.equal(a.fate, "deliver");
  assert.equal(a.body, close);

  const report =
    "You appear in 3 of 12 buyer questions this week, up from 1. The pricing page is doing the work. Fastest win: move the answer on your services page above the fold — about an hour.";
  assert.equal(decideFate({ text: report, clientSummary: report }).fate, "deliver");

  // client_summary is preferred over raw run text, which is the behaviour that already worked.
  const b = decideFate({ text: REAL_JSON, clientSummary: "Your report is ready — you gained two mentions." });
  assert.equal(b.fate, "deliver");
  assert.match(b.body ?? "", /two mentions/);
});

test("an empty run holds; an empty run WITH structured needs asks", () => {
  assert.equal(decideFate({ text: "" }).fate, "hold");
  const v = decideFate({ text: "", parsed: { needs: ["Your bank statement"] } });
  assert.equal(v.fate, "ask");
  assert.deepEqual(v.needs, ["Your bank statement"]);
});

// The first real case accumulated EIGHT open requests, several of them paraphrases of each other,
// because the ignition sweep re-runs every five minutes and a model that refuses twice does not
// phrase the ask identically twice.
test("the same question, asked again, does not become a second request", () => {
  const open = ["Your March bank statement"];
  assert.deepEqual(asksToOpen(["Your March bank statement"], open), []);
  // Case and surrounding whitespace are not a different question.
  assert.deepEqual(asksToOpen(["  your march BANK statement "], open), []);
});

test("a client is never given more than three open questions on one engagement", () => {
  const many = ["A", "B", "C", "D", "E"];
  assert.deepEqual(asksToOpen(many, []), ["A", "B", "C"]);
  assert.equal(asksToOpen(many, []).length, MAX_OPEN_ASKS);

  // Already at the ceiling: nothing new, whatever the run just discovered.
  assert.deepEqual(asksToOpen(many, ["X", "Y", "Z"]), []);
  // Room for exactly one more.
  assert.deepEqual(asksToOpen(many, ["X", "Y"]), ["A"]);
});

test("duplicates WITHIN one run's needs collapse to one question", () => {
  assert.deepEqual(asksToOpen(["Your bank statement", "Your bank statement", "The close period"], []), [
    "Your bank statement",
    "The close period",
  ]);
});

test("an empty or blank need is never put to a client", () => {
  assert.deepEqual(asksToOpen(["", "   ", "A real ask"], []), ["A real ask"]);
});

// VERBATIM from a books-keeper run that scored `deliver` in production one hour after the guard
// shipped. It names no internal noun and trips no refusal phrase ("were provided", not "were NOT
// provided") — so a client was invited to review and accept the news that their books are not done.
const REAL_WELL_WRITTEN_REFUSAL =
  "Brightline Dental's books are not closed: no month or source records were provided, so I could not verify that the books balance or prepare reliable money-in, money-out, or what's-left figures. Please provide the requested bank statement, confirm the month to close, and provide the registered sales-tax jurisdiction and rate.";

test("a WELL-WRITTEN refusal is still a refusal — declared needs settle it alone", () => {
  // The prose passes every other check, which is exactly why structure has to win.
  assert.deepEqual(internalTerms(REAL_WELL_WRITTEN_REFUSAL), []);
  assert.equal(readsAsMissingInput(REAL_WELL_WRITTEN_REFUSAL), false);

  const v = decideFate({
    text: REAL_WELL_WRITTEN_REFUSAL,
    clientSummary: REAL_WELL_WRITTEN_REFUSAL,
    parsed: { needs: ["The month you want us to close", "Your March bank statement"] },
  });
  assert.equal(v.fate, "ask", "declared needs mean the run did not finish, however well it wrote");
  assert.deepEqual(v.needs, ["The month you want us to close", "Your March bank statement"]);
});

test("without declared needs, that same prose still delivers — the guard is structure, not tone", () => {
  // No `needs` means the run is claiming it finished. We take it at its word; the founder gate is
  // the backstop. Guessing from prose alone is what the phrase list did badly.
  assert.equal(decideFate({ text: REAL_WELL_WRITTEN_REFUSAL, clientSummary: REAL_WELL_WRITTEN_REFUSAL }).fate, "deliver");
});

// One production run used BOTH doors — its own `ask_client` tool and the refusal path — and the
// Brightline case finished with three distinct questions asked three times each, in three phrasings.
test("mayAskClient governs the agent's own door with the same ceiling", async () => {
  const { mayAskClient } = await import("../src/client-ready");

  assert.equal(mayAskClient([], "Your March bank statement"), true);
  assert.equal(mayAskClient(["A", "B"], "Your March bank statement"), true);
  // At the ceiling: refused, so the run is told rather than parking on a wait nothing satisfies.
  assert.equal(mayAskClient(["A", "B", "C"], "Your March bank statement"), false);
  // Already asked, in any casing: not a second question.
  assert.equal(mayAskClient(["Your March bank statement"], "your march bank statement"), false);
});

test("a measured GEO week with no work is held, not a screenshot in the portal", () => {
  // UPDATED when the rule became declared rather than sniffed: decideFate no longer recognises
  // `status: "reported"` as GEO — the wedge's manifest carries `ship_requires: ["recommendations"]`
  // and the orchestrator hands it in. This test now models that caller. The end-to-end behaviour
  // is identical; what moved is WHERE the knowledge lives.
  const summary = "You were named in 2 of 8 answers this week. Two local rivals took the rest.";
  assert.equal(
    decideFate({
      text: summary,
      clientSummary: summary,
      parsed: { status: "reported", share_of_voice_pct: 25, client: "Harborline" },
      shipRequires: ["recommendations"],
    }).fate,
    "hold",
  );
  const ok = decideFate({
    text: summary,
    clientSummary: summary,
    parsed: {
      status: "reported",
      share_of_voice_pct: 25,
      client: "Harborline",
      recommendations: [
        { what: "Rewrite the opening of /pricing so the three-day turnaround is in the first two sentences", why: "the answer is buried", effort: "small" },
      ],
      happens_next: "We send you a draft of that page this week.",
    },
  });
  assert.equal(ok.fate, "deliver");
  assert.ok(ok.body?.includes("This week:"));
  assert.ok(ok.body?.includes("Hours:"));
  assert.ok(ok.body?.includes("What happens next:"));
});

// ═══ THE DECLARED SHIP BAR ═══
//
// This rule used to be an `if (geo)` in all but name: decideFate sniffed `status === "reported"`
// and the shape of `recommendations` — one wedge's schema spelled into the trade-blind function.
// The compiler note's test is exact: "if we have to write an `if (geo)` branch to make the work
// real, we do not have a compiler yet." Now the wedge declares `ship_requires` and the kernel
// checks substance generically.
test("a measured week that names no work holds — because geo DECLARED it, not because the kernel knows GEO", async () => {
  const { missingSubstance } = await import("../src/client-ready");
  const body = "You appear in 3 of 12 buyer questions this week.";
  const reported = { status: "reported", share_of_voice_pct: 25, recommendations: [] };

  const held = decideFate({ text: body, clientSummary: body, parsed: reported, shipRequires: ["recommendations"] });
  assert.equal(held.fate, "hold");
  assert.match(held.reason, /`recommendations`.*delivered it empty/);

  // The same output with NO declaration delivers: the bar belongs to the wedge, not the kernel.
  assert.equal(decideFate({ text: body, clientSummary: body, parsed: reported }).fate, "deliver");

  // And with real work named, the declared bar passes.
  const withWork = { ...reported, recommendations: [{ what: "move the pricing answer above the fold", effort: "small" }] };
  assert.equal(decideFate({ text: body, clientSummary: body, parsed: withWork, shipRequires: ["recommendations"] }).fate, "deliver");
  void missingSubstance;
});

test("substance means a client could READ something — an array of empty objects is not work", async () => {
  const { missingSubstance } = await import("../src/client-ready");
  // The model dressing an empty answer in the schema's clothes: [{}] passes a length check and
  // must not pass this one.
  assert.deepEqual(missingSubstance({ recommendations: [{}] }, ["recommendations"]), ["recommendations"]);
  assert.deepEqual(missingSubstance({ recommendations: [{ what: "  " }] }, ["recommendations"]), ["recommendations"]);
  assert.deepEqual(missingSubstance({ recommendations: [{ what: "fix the title" }] }, ["recommendations"]), []);

  // Strings, numbers, absence.
  assert.deepEqual(missingSubstance({ summary: "   " }, ["summary"]), ["summary"]);
  assert.deepEqual(missingSubstance({ summary: "done" }, ["summary"]), []);
  assert.deepEqual(missingSubstance({ pct: 0 }, ["pct"]), [], "zero is a measurement, not an absence");
  assert.deepEqual(missingSubstance(null, ["anything"]), ["anything"]);
  assert.deepEqual(missingSubstance({}, []), [], "no declaration, no bar");
});

test("the hold names the FIRST missing field — the wedge listed them by importance", async () => {
  const { missingSubstance } = await import("../src/client-ready");
  assert.deepEqual(missingSubstance({ b: "here" }, ["a", "b", "c"]), ["a", "c"]);
  const v = decideFate({ text: "fine work", clientSummary: "fine work", parsed: { b: "x" }, shipRequires: ["a", "b"] });
  assert.equal(v.fate, "hold");
  assert.match(v.reason, /`a`/);
});

test("the ship bar never overrides an ask — a run that needs the client is already not shipping", () => {
  const v = decideFate({
    text: "could not finish",
    clientSummary: "could not finish",
    parsed: { needs: ["Your query list"], recommendations: [] },
    shipRequires: ["recommendations"],
  });
  assert.equal(v.fate, "ask", "needs win: the client unblocks this, not a rerun");
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// A RUN THAT COULD NOT DO PART OF THE JOB DOES NOT GO STRAIGHT TO A CLIENT
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//
// The runtime tells the agent what it cannot do this run and asks it to say so in the result. That
// instruction is right and it is checked by nothing — it is a request to a model, guarding against
// precisely the failure a model under pressure produces: work that reads as finished having done
// three fifths of the job. The platform knows the answer without asking, so it decides.

const DONE = "We answered 41 questions on your API and endpoint security. Nothing needs you.";

test("a run short a capability is held for the founder, not delivered", () => {
  const clean = decideFate({ text: DONE, clientSummary: DONE });
  assert.equal(clean.fate, "deliver", "control: this exact body delivers when nothing was missing");

  const gapped = decideFate({
    text: DONE,
    clientSummary: DONE,
    capabilityGaps: ["send email as the business"],
  });
  assert.equal(gapped.fate, "hold", "the same finished-looking answer must not reach a client");
  // The reason has to name the missing thing, because the fix is a founder connecting an account
  // and a hold that does not say which one is a dead end.
  assert.match(gapped.reason, /send email as the business/);
});

test("a capability hold is NOT repairable — no faults, so no repair round", () => {
  const gapped = decideFate({
    text: DONE,
    clientSummary: DONE,
    capabilityGaps: ["read payments"],
  });
  assert.equal(gapped.fate, "hold");
  // `faults` is what marks a hold repairable (the MAX_SHIP_REPAIR loop in orchestrator.ts reads
  // exactly this). Nothing the agent writes next turn conjures a Stripe connection, so a repair
  // round would spend model time to arrive at the same hold.
  assert.equal(gapped.faults, undefined, "an agent cannot write its way to a connected account");
});

test("more than one gap is counted, not listed to death", () => {
  const gapped = decideFate({
    text: DONE,
    clientSummary: DONE,
    capabilityGaps: ["read payments", "send email as the business", "read the calendar"],
  });
  assert.match(gapped.reason, /read payments/);
  assert.match(gapped.reason, /2 more/);
});

test("an empty gap list is not a gap", () => {
  // The runtime passes `[]` for a fully-connected project on every single run, so the falsy case is
  // the hot path and getting it wrong would hold every task in the system.
  assert.equal(decideFate({ text: DONE, clientSummary: DONE, capabilityGaps: [] }).fate, "deliver");
  assert.equal(decideFate({ text: DONE, clientSummary: DONE, capabilityGaps: undefined }).fate, "deliver");
});

// A PROMISED FILE THAT DOES NOT EXIST.
//
// The `artifacts` contract asks a deliverable to carry the work. The first run under it named a
// ledger CSV and a sales-tax return, wrote NEITHER, and passed every gate — because naming a file
// satisfies a schema exactly as well as writing one does. That is the failure a schema cannot close
// and a model cannot be trusted to close, so runtime.ts checks the paths against the sandbox.

test("a deliverable naming files it never wrote is held, and the hold is repairable", () => {
  const v = decideFate({
    text: DONE,
    clientSummary: DONE,
    missingArtifacts: ["september-ledger.csv", "vat-return.json"],
  });
  assert.equal(v.fate, "hold");
  assert.match(v.reason, /never written/);
  assert.match(v.reason, /september-ledger\.csv/);
  // WITH faults, unlike a capability gap: the agent has the data and simply did not write the file,
  // so one repair round is cheaper than a founder finding out after release.
  assert.ok(v.faults?.length, "this one the agent can actually fix");
});

test("a phantom artifact outranks a capability gap", () => {
  // A named-but-missing file is a straight falsehood in the deliverable; a gap is a limit on what
  // could be done. The first is worse and is reported first.
  const v = decideFate({
    text: DONE,
    clientSummary: DONE,
    missingArtifacts: ["ledger.csv"],
    capabilityGaps: ["read payments"],
  });
  assert.match(v.reason, /never written/);
});

test("an empty or absent list ships as before", () => {
  assert.equal(decideFate({ text: DONE, clientSummary: DONE, missingArtifacts: [] }).fate, "deliver");
  assert.equal(decideFate({ text: DONE, clientSummary: DONE }).fate, "deliver");
});

test("a phantom file is caught even when the run is also asking the client something", () => {
  /**
   * The ordering bug this pins, found by running a real close.
   *
   * A monthly close ALWAYS carries questions — it is designed to ask rather than guess — so it
   * always resolved to `ask`, and a phantom-artifact check placed after that branch never ran once
   * in practice. Every other verdict here is about whether the work is FINISHED; this one is about
   * whether it is TRUE, and no state of the work makes a named-but-missing file acceptable.
   */
  const v = decideFate({
    text: JSON.stringify({ needs: ["the September bank statement"] }),
    parsed: { needs: ["the September bank statement"] },
    missingArtifacts: ["september-ledger.csv"],
  });
  assert.equal(v.fate, "hold", "truth is checked before completeness");
  assert.match(v.reason, /never written/);
});

// FINISHED WORK WITH AN ATTACHED ASK IS STILL FINISHED WORK.
//
// `declaredNeeds` folded `questions` in with `needs`, `blocked_on`, `missing` and
// `required_from_client`. Those four mean the run COULD NOT FINISH. `questions` does not: books-
// keeper's own schema defines it as "what could NOT be decided alone" — the close balanced, the
// ledger is written, and three transactions need the owner to say whether a payment was equipment.
//
// So every monthly close returned `ask`, no deliverable was ever created, the client never saw the
// work, and the founder could not invoice it. The loop could not complete because the bookkeeper
// asked three sensible questions.

const CLOSE = "August is closed and it balances. Three payments need you to say what they were.";

test("a close that balances and has questions DELIVERS, with the questions attached", () => {
  const v = decideFate({
    text: CLOSE,
    clientSummary: CLOSE,
    parsed: {
      client_summary: CLOSE,
      reconciled: true,
      questions: [{ about: "Apex Computing £1,899", recommendation: "treat as equipment" }],
    },
  });
  assert.equal(v.fate, "deliver", "finished work with an ask is finished work");
  // And the ask travels WITH it — otherwise the split would swap "client never sees the work" for
  // "client sees the work and is never told three things are unclassified".
  assert.equal(v.needs?.length, 1);
  assert.match(v.reason, /1 question for the client/);
});

test("a run that says it is BLOCKED still asks, and delivers nothing", () => {
  // The production refusal this protection exists for: well-written prose naming no internal noun,
  // which scored `deliver` until `needs` became sufficient on its own. Unchanged by the split.
  const v = decideFate({
    text: "The books are not closed.",
    clientSummary: "The books are not closed.",
    parsed: { needs: ["the August bank statement"] },
  });
  assert.equal(v.fate, "ask");
  assert.deepEqual(v.needs, ["the August bank statement"]);
});

test("blocked AND asking is still blocked", () => {
  // A run that could not finish does not get to deliver because it also had a question.
  const v = decideFate({
    text: CLOSE,
    clientSummary: CLOSE,
    parsed: { needs: ["the bank statement"], questions: [{ about: "a payment" }] },
  });
  assert.equal(v.fate, "ask");
});

test("questions with NO client-facing prose are as blocking as a need", () => {
  // There is nothing to send alongside them, so they cannot ride along with anything.
  const v = decideFate({
    text: '{"questions":[{"about":"a payment"}]}',
    parsed: { questions: [{ about: "a payment" }] },
  });
  assert.equal(v.fate, "ask");
});

test("a close that reconciles and has open items delivers the close, not just the questions", () => {
  // The run that stopped the loop. Sixteen transactions for a Bristol design studio, reconciled to
  // the statement to the penny, with a ledger and a VAT worksheet written to ./output/ — and four
  // items in `needs`, two of which appeared in `questions` as well, worded almost identically.
  //
  // The client received four questions and no books. That is the platform being precious with a
  // good month's bookkeeping: a bookkeeper sends you the close AND asks about the two payments they
  // could not place.
  const parsed = {
    client_summary:
      "August 2026 bank activity reconciles exactly to the statement. Net sales were £8,200.00, " +
      "cash costs were £4,469.39, and the provisional surplus was £3,730.61.",
    reconciled: true,
    difference_cents: 0,
    reconciliation: { opening_minor: 812400, closing_minor: 1349461, difference_minor: 0 },
    profit_and_loss: { income_minor: 984000, expenses_minor: 446939 },
    artifacts: ["august-2026-ledger.json", "august-2026-vat-worksheet.json"],
    needs: [
      "Confirmation of Harlow & Finch's VAT scheme",
      "The business purpose and counterparty for the £340.00 card payment",
    ],
    questions: [
      { about: "The £340.00 card payment on 20 August", best_guess: "Owner draw", why_asking: "No counterparty." },
    ],
  };
  const shipRequires = ["artifacts", "client_summary", "profit_and_loss", "reconciliation"];
  const verdict = decideFate({
    text: JSON.stringify(parsed),
    clientSummary: parsed.client_summary,
    parsed,
    shipRequires,
  });
  assert.equal(verdict.fate, "deliver");
  // Both asks ride along, deduplicated — the client is not asked twice about the same £340.
  assert.equal(verdict.needs?.length, 3);
  assert.equal(new Set(verdict.needs).size, 3);
});

test("but a run that declares needs AND misses the ship bar still asks", () => {
  // The production failure the blocking branch was written for, and it must keep working. This one
  // wrote well and did nothing: no reconciliation, no P&L, no artifacts. Prose alone shipped it as
  // work once, and a client was invited to accept the news that their books were not done.
  const parsed = {
    client_summary:
      "Brightline Dental's books are not closed: no month or source records were provided, so I " +
      "could not verify that the books balance.",
    needs: ["Your August bank statement"],
  };
  const verdict = decideFate({
    text: JSON.stringify(parsed),
    clientSummary: parsed.client_summary,
    parsed,
    shipRequires: ["artifacts", "client_summary", "profit_and_loss", "reconciliation"],
  });
  assert.equal(verdict.fate, "ask");
  assert.deepEqual(verdict.needs, ["Your August bank statement"]);
});

test("figures are substance — an all-numeric object is not an empty one", () => {
  // Why every monthly close held. `missingSubstance` asked for a non-blank STRING among an object's
  // values, so a correct P&L — `{income_minor: 984000, expenses_minor: 446939}` — read as empty, and
  // books-keeper declares `ship_requires: ["profit_and_loss", "reconciliation"]`. The close was held
  // for delivering an empty P&L with the P&L sitting in the output. Same hole for an invoice total,
  // a tax box, a measured week: every trade that reports figures rather than prose.
  assert.deepEqual(
    missingSubstance(
      {
        profit_and_loss: { income_minor: 984000, expenses_minor: 446939 },
        reconciliation: { opening_minor: 812400, closing_minor: 1349461, difference_minor: 0 },
      },
      ["profit_and_loss", "reconciliation"],
    ),
    [],
  );

  // And the case the string rule was written for still holds: schema-shaped emptiness.
  assert.deepEqual(missingSubstance({ recommendations: [{}] }, ["recommendations"]), ["recommendations"]);
  assert.deepEqual(missingSubstance({ a: { what: "" } }, ["a"]), ["a"]);
  assert.deepEqual(missingSubstance({ a: { b: { c: null } } }, ["a"]), ["a"]);
  // Booleans remain out of scope on purpose — "must be true to ship" is a different rule.
  assert.deepEqual(missingSubstance({ a: { reconciled: true } }, ["a"]), ["a"]);
  // Zero is a figure. A month that nets to nothing still reported a number.
  assert.deepEqual(missingSubstance({ a: { difference_minor: 0 } }, ["a"]), []);
});

test("the client's document carries the questions and what we recommend", () => {
  // The largest gap found by running the loop. `delivering-work.md` rule 7 is "every question carries
  // a recommendation" and books-keeper enforces it with `each_has questions[].recommendation` — so a
  // close that asks without advising is held. The close then wrote four careful objects and this
  // function rendered summary, recommendations and happens_next, dropping every one.
  //
  // The client's document said "four items need confirmation" and never said which four. They asked
  // for the same thing two runs running: "what is your recommended treatment for each review item,
  // rather than simply asking me to decide?"
  const body = weekBody("July reconciles to the penny.", {
    questions: [
      {
        about: "The £340.00 card payment on 20 July",
        why_asking: "No counterparty on the transaction.",
        recommendation: "I'd hold it outside expenses as an owner draw until it is identified.",
      },
      { about: "The £147.50 lunch at The Ox", best_guess: "Client entertaining, so not VAT-recoverable." },
    ],
    happens_next: "Send the two answers and I will finalise the return.",
  });
  assert.match(body, /2 things I need from you/);
  assert.match(body, /£340\.00 card payment/);
  assert.match(body, /hold it outside expenses/);
  assert.match(body, /Asking because no counterparty/, "folded into the sentence, not a labelled line");
  assert.equal(/\n {2}Why/.test(body), false, "never an indented label the report parser reads as a stat row");
  // `best_guess` is advice too when there is no explicit recommendation.
  assert.match(body, /Client entertaining/);
  assert.match(body, /What happens next/);

  // Singular reads like a person wrote it.
  assert.match(weekBody("x", { questions: [{ about: "One thing" }] }), /One thing I need from you/);

  // A trade outside bookkeeping words it differently, and a body that rendered nothing for them
  // would be this same bug wearing another trade.
  assert.match(weekBody("x", { questions: [{ question: "Which logo?", recommendation: "The serif." }] }), /Which logo\? — The serif\./);
  assert.match(weekBody("x", { questions: ["Plain string ask"] }), /- Plain string ask/);

  // Nothing to ask, nothing added.
  assert.equal(weekBody("Just the summary.", { questions: [] }), "Just the summary.");
  assert.equal(weekBody("Just the summary.", null), "Just the summary.");
});

test("a client's document never ends mid-sentence", () => {
  // What reached a client, character 2,000 exactly: "…if personal, book it to drawings, and if
  // business". They said "the covering note appears incomplete, ending mid-sentence", and a document
  // that stops mid-word undoes every careful thing above it — the reader stops trusting the figures
  // too, and they are right to.
  const para = (n: number) => `Paragraph ${n}. ${"word ".repeat(30)}`.trim();
  const long = [para(1), para(2), para(3), para(4), para(5)].join("\n\n");

  const clipped = clipToBoundary(long, 400);
  assert.equal(clipped.length <= 400, true, "inside the budget, marker included");
  assert.match(clipped, /\[…\]$/, "and says it was abridged");
  assert.equal(/\bword$/.test(clipped.replace(/\n\n\[…\]$/, "")), false, "never a dangling word");

  // Short enough is untouched, with no marker.
  assert.equal(clipToBoundary("Short note.", 400), "Short note.");
  assert.equal(clipToBoundary("  padded  ", 400), "padded");

  // A sentence boundary when one is in reach.
  const sentences = "One sentence here. Two sentence here. Three sentence here. Four sentence here.";
  const s2 = clipToBoundary(sentences, 48);
  assert.match(s2, /\.\n\n\[…\]$/);
  assert.equal(s2.length <= 48, true);

  // And when none is, still a WORD boundary — never mid-word, which was the whole complaint.
  const s2b = clipToBoundary(sentences, 60);
  assert.equal(s2b.length <= 60, true);
  assert.match(s2b.replace(/\n\n\[…\]$/, ""), /\bsentence$|\bhere\.$|\bThree$/);

  // Text with no break at all in reach still gets cut and marked rather than silently truncated.
  const solid = "x".repeat(500);
  const s3 = clipToBoundary(solid, 100);
  assert.equal(s3.length <= 100, true);
  assert.match(s3, /\[…\]$/);
});

test("a delivered CSV that does not parse is held, and the fault says why", async () => {
  // The ledger shipped with `Studio rent, July` unquoted — CSV's one rule. Every column after it
  // shifts right, so a spreadsheet shows the counterparty under `description` for the rest of the
  // file. The client opened it: "multiple descriptions contain commas but are not quoted, so it is
  // not reliably machine-readable."
  //
  // Everything else the gate owns reads the model's JSON. The FILES are the work, and nothing had
  // ever looked at one.
  const { malformedCsv } = await import("../src/runtime");

  const broken =
    "date,amount,description,counterparty\n" +
    "2026-07-03,4800.00,Invoice INV-2026-071,Kestrel Coffee Ltd\n" +
    "2026-07-04,-1280.00,Studio rent, July,Marlowe Property\n";
  const fault = malformedCsv("july-ledger.csv", broken);
  assert.ok(fault);
  assert.match(fault!, /line 3 has 5 fields where the header has 4/);
  assert.match(fault!, /must be in double quotes/);

  // Quoted properly, it parses — including a quote escaped inside a quoted field.
  assert.equal(
    malformedCsv("ok.csv", 'a,b\n1,"Studio rent, July"\n2,"He said ""no"", twice"\n'),
    undefined,
  );
  // A header alone, or an empty file, is not a parse failure.
  assert.equal(malformedCsv("h.csv", "a,b,c\n"), undefined);
  assert.equal(malformedCsv("e.csv", ""), undefined);

  // And the verdict holds it, repairably — the agent has the data and wrote the file wrong.
  const v = decideFate({
    text: "{}",
    clientSummary: "July reconciles.",
    parsed: { client_summary: "July reconciles." },
    brokenArtifacts: [fault!],
  });
  assert.equal(v.fate, "hold");
  assert.deepEqual(v.faults, [fault!]);
});

test("a harness tick is not judged as a deliverable", async () => {
  // `gtm_autonomous` ran and the founder's timeline said: "not delivered — the run's output is
  // machine text with no client-facing summary — held from the portal." It is a five-minute outreach
  // tick. There is no client, no portal and nothing to deliver, and its own description says
  // "harness work, not agent work".
  //
  // Four GTM task types run on timers, and NONE of them was marked `internal` — so a founder's
  // timeline filled with failure reports about work that had succeeded.
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { wedgesDir } = await import("../src/wedge");
  const m = JSON.parse(readFileSync(join(wedgesDir(), "gtm-operator", "wedge.json"), "utf8"));

  for (const tick of ["advance_sequences", "gtm_autonomous", "outreach_touch", "ops_distribution_tick"]) {
    assert.equal(m.task_types[tick].internal, true, `${tick} is machinery and must say so`);
  }
  // And the two that a person genuinely reads are NOT internal — over-marking would hide the ship
  // bar from the work that needs it most.
  assert.notEqual(m.task_types.propose_campaign.internal, true);
  assert.notEqual(m.task_types.find_prospects.internal, true);
});

test("a job the harness dispatches cannot be created by hand", async () => {
  // Four GTM task types say it in their own descriptions — "Harness work, not agent work: no model
  // is invoked. Spawned by the sequencer's own schedule — do not create these by hand." That
  // sentence is read by a model and enforced by nothing, which is this repo's oldest shape: an
  // instruction standing in for a rule.
  //
  // Posting `gtm_autonomous` to the task route did exactly what the description forbids. It took the
  // ordinary agent path: provisioned a sandbox, invoked a model, charged for two turns, spent the
  // run blocked on file reads it was not permitted to make, discovered nobody, and reported SUCCESS.
  // The real work — `runAutonomousGtm`, called from the scheduler — never ran. Money spent, nothing
  // done, green tick.
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { wedgesDir } = await import("../src/wedge");
  const m = JSON.parse(readFileSync(join(wedgesDir(), "gtm-operator", "wedge.json"), "utf8"));

  for (const tick of ["advance_sequences", "gtm_autonomous", "outreach_touch", "ops_distribution_tick"]) {
    assert.equal(m.task_types[tick].harness_dispatched, true, `${tick} is scheduler-run and must say so`);
    // Every description that CLAIMS this must carry the flag that enforces it — the two drifting
    // apart is how the sentence ended up alone in the first place.
    if (/do not create these by hand/i.test(m.task_types[tick].description ?? "")) {
      assert.equal(m.task_types[tick].harness_dispatched, true);
    }
  }
  // The two a founder genuinely starts stay creatable. Over-marking would lock them out of their
  // own outreach, which is a worse failure than the one being fixed.
  assert.notEqual(m.task_types.find_prospects.harness_dispatched, true);
  assert.notEqual(m.task_types.propose_campaign.harness_dispatched, true);
});
