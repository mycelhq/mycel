// DOES THE OUTPUT AGREE WITH ITSELF — the gate above `ship_requires`.
//
// Everything before this passes on work that is confidently wrong. `output_schema` proves the shape,
// `missingSubstance` proves the fields are non-empty, and neither notices a monthly close that
// reports `reconciled: true` beside `difference_cents: 4200` — a bookkeeper telling a client the
// books balance while holding a hole — or an invoice whose total disagrees with its own lines.
//
// Every case below is taken from a real task type's own schema in this repo, not invented, and the
// two arithmetic ones are the whole argument: correctness is usually judgement, and in these places
// it is not, so it can be checked with no model and the same answer every time.

import { test } from "node:test";
import assert from "node:assert/strict";
import { describeShipContract, readShipChecks, shipFaults, type ShipCheck } from "../src/ship-checks";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const CLOSE: ShipCheck[] = [
  { kind: "agrees", flag: "reconciled", zero_when_true: "difference_cents" },
  { kind: "min_words", field: "client_summary", n: 25 },
];
const INVOICE: ShipCheck[] = [
  { kind: "sums_to", items: "lines", each: "charge_minor", total: "total_minor" },
  { kind: "min_items", field: "lines", n: 1 },
];

const LONG = Array.from({ length: 30 }, (_, i) => `word${i}`).join(" ");

test("a close that balances while carrying a difference does not ship", () => {
  // books-keeper's own field description: "A close that balances because something was forced is
  // worse than an open one — it is the failure that makes them stop trusting the months before it."
  const faults = shipFaults({ reconciled: true, difference_cents: 4200, client_summary: LONG }, CLOSE);
  assert.equal(faults.length, 1);
  assert.match(faults[0]!.message, /cannot both/);
  assert.match(faults[0]!.message, /4200/, "the number is in the sentence — a founder has to check it");
});

test("and neither does the quieter mistake in the other direction", () => {
  // Nothing outstanding, reported as unfinished. It understates the work and asks the client a
  // question that has already been answered.
  const faults = shipFaults({ reconciled: false, difference_cents: 0, client_summary: LONG }, CLOSE);
  assert.equal(faults.length, 1);
  assert.match(faults[0]!.message, /unfinished/);
});

test("a close that agrees with itself ships", () => {
  assert.deepEqual(shipFaults({ reconciled: true, difference_cents: 0, client_summary: LONG }, CLOSE), []);
  assert.deepEqual(shipFaults({ reconciled: false, difference_cents: 4200, client_summary: LONG }, CLOSE), []);
});

test("an invoice whose total disagrees with its lines does not ship", () => {
  // The highest-stakes arithmetic error the product can make: a wrong figure, in the firm's name,
  // in a document the client pays from.
  const faults = shipFaults(
    { lines: [{ charge_minor: 12_000 }, { charge_minor: 8_000 }], total_minor: 21_000 },
    INVOICE,
  );
  assert.equal(faults.length, 1);
  assert.match(faults[0]!.message, /21000/);
  assert.match(faults[0]!.message, /20000/);
  assert.match(faults[0]!.message, /pays from that number/);
});

test("exact integer arithmetic — no tolerance to argue about", () => {
  assert.deepEqual(
    shipFaults({ lines: [{ charge_minor: 12_000 }, { charge_minor: 8_000 }], total_minor: 20_000 }, INVOICE),
    [],
  );
  // One penny out is still out. Minor units exist precisely so this comparison can be `!==`.
  assert.equal(
    shipFaults({ lines: [{ charge_minor: 1 }], total_minor: 2 }, INVOICE).length,
    1,
  );
});

test("a line with no amount is the SCHEMA's problem, not this one", () => {
  // Summing a partial list would report a mismatch that is really a missing field, and a fault that
  // points at the wrong thing is worse than no fault — the founder goes looking at the arithmetic.
  const faults = shipFaults({ lines: [{ charge_minor: 100 }, { contractor: "Dana" }], total_minor: 100 }, INVOICE);
  assert.deepEqual(faults, []);
});

test("an empty list is caught, and an absent one is not", () => {
  assert.equal(shipFaults({ lines: [], total_minor: 0 }, INVOICE).length, 1);
  // Absent is `output_schema`'s question and `ship_requires`'s question, both of which run first.
  // This gate is only ever about fields that are PRESENT disagreeing.
  assert.deepEqual(shipFaults({ total_minor: 0 }, INVOICE), []);
});

test("a summary that is a note rather than the delivery does not ship", () => {
  // `client_summary` is the ONLY field the client-facing deliverable shows, so a one-liner is the
  // whole delivery being a sentence. This is the "refusal wearing a deliverable's clothes" that
  // STANDARD.md §2 gives a target of zero.
  const faults = shipFaults(
    { reconciled: true, difference_cents: 0, client_summary: "We analysed your visibility." },
    CLOSE,
  );
  assert.equal(faults.length, 1);
  assert.match(faults[0]!.message, /4 words? long/);
});

test("nothing declared, nothing checked", () => {
  assert.deepEqual(shipFaults({ anything: true }, []), []);
  assert.deepEqual(shipFaults({ anything: true }, undefined), []);
  assert.deepEqual(shipFaults(null, CLOSE), []);
});

test("a malformed check never breaks the path to the founder's screen", () => {
  // This sits between a finished run and a screen. An exception here would turn "the number is
  // wrong" into "the run crashed", which is worse and much more confusing.
  const nonsense = [{ kind: "sums_to", items: "lines", each: "x", total: "t" }] as ShipCheck[];
  assert.doesNotThrow(() => shipFaults({ lines: "not an array", t: 5 }, nonsense));
  assert.deepEqual(shipFaults({ lines: "not an array", t: 5 }, nonsense), []);
});

test("an unknown check kind is dropped, never guessed at", () => {
  // A manifest written against a newer kernel must not have its intent invented by an older one.
  // Silently dropping is the gated direction: the work still stops at review.
  const parsed = readShipChecks([
    { kind: "agrees", flag: "a", zero_when_true: "b" },
    { kind: "invents_a_number", field: "x" },
    { kind: "sums_to", items: "l" },        // incomplete — no `each`, no `total`
    { kind: "min_items", field: "r", n: 3 },
    "not an object",
  ]);
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed.map((c) => c.kind), ["agrees", "min_items"]);
});

test("every declaration in the shipped wedges parses to a real check", async () => {
  // The manifests are data, and a typo in one would silently disable the gate it was written for —
  // exactly the "a check that never runs" failure this branch has been finding all week.
  const { readdirSync, readFileSync, existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  const root = join(import.meta.dirname, "..", "..", "wedges");
  let declared = 0;
  for (const slug of readdirSync(root)) {
    const file = join(root, slug, "wedge.json");
    if (!existsSync(file)) continue;
    const m = JSON.parse(readFileSync(file, "utf8")) as {
      task_types?: Record<string, { ship_checks?: unknown }>;
    };
    for (const [job, spec] of Object.entries(m.task_types ?? {})) {
      const raw = spec.ship_checks;
      if (raw === undefined) continue;
      assert.ok(Array.isArray(raw), `${slug}/${job}: ship_checks must be an array`);
      const parsed = readShipChecks(raw);
      assert.equal(
        parsed.length,
        (raw as unknown[]).length,
        `${slug}/${job}: ${(raw as unknown[]).length - parsed.length} check(s) did not parse — a typo here silently disables the gate`,
      );
      declared += parsed.length;
    }
  }
  assert.ok(declared >= 6, `only ${declared} checks declared across every wedge`);
});

// ── Craft, not just arithmetic ───────────────────────────────────────────────────────────────────
//
// The four checks above ask whether the numbers agree. These ask whether the WORK IS ANY GOOD, which
// is the harder half and the one that decides whether a client renews.
//
// The taste already existed in this repo three times and nowhere a customer's deliverable could
// reach it: `growth/lib/copy-gate.ts` (forty phrases, well tuned, protects OUR outreach),
// `growth/lib/copy/tells.ts`, and a `BAN=` regex inside product-builder's shell verify. So the craft
// that stops us sending a machine-written DM has never stopped a customer's report being one.
//
// The risk with every check here is the FALSE POSITIVE. A gate that holds good work is a gate
// somebody deletes, and then the bad work ships too. Each test below pins the case where it must
// stay quiet as hard as the case where it must fire.

test("recommendations that are all one size do not ship", () => {
  // STANDARD.md §6: "one Small (hours), one Medium (a day or two), one Large (weeks). Lead with the
  // Small." Three Larges is a quarter of work nobody starts on Friday — and it satisfies `min_items`.
  const all_large = [
    { what: "Original research", why: "earns citations", effort: "large" },
    { what: "Data study", why: "earns citations", effort: "large" },
    { what: "Benchmark report", why: "earns citations", effort: "large" },
  ];
  const faults = shipFaults({ recommendations: all_large }, [
    { kind: "spread", items: "recommendations", field: "effort", distinct: 2 },
  ]);
  assert.equal(faults.length, 1);
  assert.match(faults[0]!.message, /all one size/);

  // A genuine spread is silent.
  assert.deepEqual(
    shipFaults(
      { recommendations: [{ effort: "small" }, { effort: "large" }] },
      [{ kind: "spread", items: "recommendations", field: "effort", distinct: 2 }],
    ),
    [],
  );
});

test("a list where only the first entry is filled in reads as three things and is one", () => {
  // The shape a model reliably produces under pressure: one good entry, then two that satisfy the
  // schema. `missingSubstance` accepts it, because SOME entry has substance.
  const faults = shipFaults(
    { recommendations: [{ what: "Rewrite the pricing page", why: "it is not retrievable" }, { what: "" }, {}] },
    [{ kind: "each_has", items: "recommendations", field: "what" }],
  );
  assert.equal(faults.length, 1);
  assert.match(faults[0]!.message, /2 of 3/);
  assert.match(faults[0]!.message, /is 1\./, "it says how many are actually there");
});

test("the sentence fits the count — a one-item list is not 'three things'", () => {
  // The single-message version said "1 of 1 entry in redirects have no to. A list where only the
  // first one is filled in reads as three things and is one", which is ungrammatical AND about a
  // different problem. A reader stops trusting a gate that describes their situation wrongly,
  // however right the verdict is.
  const faults = shipFaults({ redirects: [{ from: "/old" }] }, [
    { kind: "each_has", items: "redirects", field: "to" },
  ]);
  assert.equal(faults.length, 1);
  assert.match(faults[0]!.message, /The single entry/);
  assert.doesNotMatch(faults[0]!.message, /three things/);
});

test("a check that cannot fail is not allowed to look like protection", () => {
  // `spread` with distinct 1 passes for every non-empty list — it reads as a gate on a screen and is
  // furniture. One was written into site-studio's launch checklist and removed; this pins the shape
  // so the next one is noticed.
  const cannotFail = shipFaults({ xs: [{ k: "a" }, { k: "a" }] }, [
    { kind: "spread", items: "xs", field: "k", distinct: 1 },
  ]);
  assert.deepEqual(cannotFail, [], "distinct:1 is a no-op by construction");
});

test("marketing language where the work should be does not ship", () => {
  const faults = shipFaults(
    { client_summary: "We leveraged a holistic approach to elevate your world-class presence." },
    [{ kind: "forbids", field: "client_summary", vocabulary: "brand_poetry" }],
  );
  assert.equal(faults.length, 1);
  assert.match(faults[0]!.message, /reads as marketing/);
  assert.match(faults[0]!.message, /Say what was done/);
});

test("a trade can add its own words without forking the shared list", () => {
  // geo-monitor's schema says the `why` must be the MECHANISM and "never 'improves authority'". That
  // is a rule about ONE trade's craft, and it belongs beside that trade rather than in a vocabulary
  // every other wedge inherits.
  const check: ShipCheck = {
    kind: "forbids",
    field: "client_summary",
    vocabulary: "brand_poetry",
    extra: ["improves authority"],
  };
  assert.equal(shipFaults({ client_summary: "This improves authority across the site." }, [check]).length, 1);
  assert.deepEqual(shipFaults({ client_summary: "This adds a comparison table the model can quote." }, [check]), []);
});

test("a draft that reached a client is a different failure from bad writing", () => {
  // Placeholders are not a style problem. A `.example` domain resolves nowhere, so every link built
  // on one is dead on the live site — product-builder's verify learned that one in production.
  const faults = shipFaults(
    { covering_note: "Please remit to acme.example — TBD on the PO reference." },
    [{ kind: "forbids", field: "covering_note", vocabulary: "placeholder" }],
  );
  assert.equal(faults.length, 1);
  assert.match(faults[0]!.message, /a draft, not a deliverable/);
});

test("the vocabularies do not fire on ordinary professional prose", () => {
  // THE FALSE POSITIVE IS THE REAL RISK. A gate that holds good work gets deleted, and then the bad
  // work ships too. These are sentences a real bookkeeper, a real recruiter and a real agency would
  // write, and every one of them has to pass in silence.
  const honest = [
    "October is closed. Net is up 5.6% on September, driven by retail; two items are unreconciled.",
    "ChatGPT named you in 4 of 12 buyer questions, up from 2. The pricing page is the gap.",
    "Three contractors have not submitted timesheets for the week ending 31 Oct.",
    "We rewrote the comparison table so the model can quote a row instead of a paragraph.",
    "Your VAT return is due on the 7th. I have the figures and need the bank statement to file it.",
  ];
  for (const v of ["brand_poetry", "placeholder"] as const) {
    for (const text of honest) {
      assert.deepEqual(
        shipFaults({ s: text }, [{ kind: "forbids", field: "s", vocabulary: v }]),
        [],
        `${v} fired on: ${text}`,
      );
    }
  }
});

test("a summary nobody will read is held at the other end", () => {
  const long = Array.from({ length: 500 }, (_, i) => `word${i}`).join(" ");
  const faults = shipFaults({ client_summary: long }, [{ kind: "max_words", field: "client_summary", n: 320 }]);
  assert.equal(faults.length, 1);
  assert.match(faults[0]!.message, /500 words/);
  assert.match(faults[0]!.message, /nobody does/);
});

test("a manifest cannot invent a vocabulary", () => {
  // The named set is the mechanism: it hands a trade author the accumulated taste instead of letting
  // them reinvent it badly. An unknown name is dropped, never guessed at.
  const parsed = readShipChecks([
    { kind: "forbids", field: "a", vocabulary: "brand_poetry" },
    { kind: "forbids", field: "b", vocabulary: "whatever_i_like" },
    { kind: "forbids", field: "c" },
  ]);
  assert.equal(parsed.length, 1);
  assert.equal((parsed[0] as { vocabulary: string }).vocabulary, "brand_poetry");
});

test("a non-string in `extra` cannot break the gate at run time", () => {
  // `.includes` on an object throws, and this runs between a finished run and a founder's screen.
  const parsed = readShipChecks([
    { kind: "forbids", field: "a", vocabulary: "brand_poetry", extra: ["real", 42, null, { x: 1 }, "  "] },
  ]);
  assert.deepEqual((parsed[0] as { extra?: string[] }).extra, ["real"]);
  assert.doesNotThrow(() => shipFaults({ a: "a real problem" }, parsed));
});

// ── The contract the agent is graded against, written out for the agent ──────────────────────────
//
// Every check in this file ran on the way OUT and nothing told the agent on the way in. So the
// kernel graded each run against rules the run had never seen: a close with a fourteen-word summary
// satisfied its schema, satisfied `ship_requires`, reported success, and was held for a bar nobody
// had shown it. The founder got a hold with a good reason; the agent got nothing and would produce
// the same output again.
//
// A contract you are graded against and not shown is not a contract, it is a trap.

test("every check kind produces an instruction with its number in it", () => {
  // "Be thorough" changes nothing; "at least 25 words" changes the output. Any kind that renders
  // without its threshold is a rule the agent cannot act on.
  const lines = describeShipContract(["client_summary"], [
    { kind: "agrees", flag: "reconciled", zero_when_true: "difference_cents" },
    { kind: "sums_to", items: "lines", each: "charge_minor", total: "total_minor" },
    { kind: "min_items", field: "recommendations", n: 3 },
    { kind: "each_has", items: "recommendations", field: "why" },
    { kind: "spread", items: "recommendations", field: "effort", distinct: 2 },
    { kind: "min_words", field: "client_summary", n: 25 },
    { kind: "max_words", field: "client_summary", n: 320 },
    { kind: "forbids", field: "client_summary", vocabulary: "brand_poetry" },
  ]);

  assert.equal(lines.length, 9, "one for the ship_requires field and one per check");
  const all = lines.join("\n");
  for (const needed of ["25 words", "320 words", "at least 3", "2 different values"]) {
    assert.ok(all.includes(needed), `no threshold for: ${needed}`);
  }
  // The imperative, not the JSON. A prompt that reads as configuration gets skimmed.
  assert.doesNotMatch(all, /"kind"|min_words|each_has/, "it renders as instructions, not as the manifest");
});

test("the contract names the actual fields, so it can be acted on without guessing", () => {
  const lines = describeShipContract(undefined, [
    { kind: "sums_to", items: "lines", each: "charge_minor", total: "total_minor" },
    { kind: "each_has", items: "accounts", field: "owner" },
  ]);
  assert.match(lines[0]!, /lines\[\]\.charge_minor/);
  assert.match(lines[0]!, /total_minor/);
  assert.match(lines[1]!, /EVERY entry/, "the emphasis is the whole point of that rule");
  assert.match(lines[1]!, /accounts/);
  assert.match(lines[1]!, /owner/);
});

test("a forbidden vocabulary is quoted, not described", () => {
  // "Avoid marketing language" is advice. A list of the actual words is a rule.
  const [line] = describeShipContract(undefined, [
    { kind: "forbids", field: "client_summary", vocabulary: "brand_poetry", extra: ["improves authority"] },
  ]);
  assert.match(line!, /"seamless"|"inevitable"/);
  assert.match(line!, /improves authority/, "a trade's own additions reach the agent too");
});

test("nothing declared, nothing said", () => {
  // A wedge with no bar must not get an empty "check it against these" heading, which reads as a
  // contract with no terms and invites the agent to invent some.
  assert.deepEqual(describeShipContract(undefined, undefined), []);
  assert.deepEqual(describeShipContract([], []), []);
});

test("what the shipped wedges tell their agents is readable", () => {
  // The end-to-end property: every declaration in every manifest renders to a sentence. A check kind
  // added without a case in `describeShipContract` would silently vanish from the prompt while still
  // being graded — the exact trap this whole pass exists to close.
  const root = join(import.meta.dirname, "..", "..", "wedges");
  let seen = 0;
  for (const slug of readdirSync(root)) {
    const file = join(root, slug, "wedge.json");
    if (!existsSync(file)) continue;
    const m = JSON.parse(readFileSync(file, "utf8")) as {
      task_types?: Record<string, { ship_checks?: unknown; ship_requires?: unknown }>;
    };
    for (const [job, spec] of Object.entries(m.task_types ?? {})) {
      const checks = readShipChecks(spec.ship_checks);
      if (!checks.length) continue;
      const lines = describeShipContract(
        Array.isArray(spec.ship_requires) ? (spec.ship_requires as string[]) : undefined,
        checks,
      );
      const fromChecks = lines.length - (Array.isArray(spec.ship_requires) ? spec.ship_requires.length : 0);
      assert.equal(fromChecks, checks.length, `${slug}/${job}: a check rendered to nothing`);
      for (const l of lines) assert.ok(l.trim().length > 20, `${slug}/${job}: "${l}" is not an instruction`);
      seen += checks.length;
    }
  }
  assert.ok(seen >= 20, `only ${seen} checks rendered across every wedge`);
});

test("a figure is never stated beside a claim that it cannot be established", () => {
  // The client's first complaint on the August close, and the only one that could cost them money:
  // "They simultaneously show £1,640.00 as net due in the sales-tax summary and say the net VAT due
  // is not established in their own VAT working paper. Those positions cannot both be used to tell
  // me what I owe."
  const checks = readShipChecks([
    { kind: "not_when", field: "sales_tax.net_due_minor", unknown_when: "sales_tax.input_tax_unquantified" },
  ]);
  assert.equal(checks.length, 1);

  const contradictory = shipFaults(
    { sales_tax: { output_tax_minor: 164000, net_due_minor: 164000, input_tax_unquantified: true } },
    checks,
  );
  assert.equal(contradictory.length, 1);
  assert.match(contradictory[0]!.message, /cannot be established/);

  // Establish the input tax and the figure is welcome.
  assert.deepEqual(
    shipFaults({ sales_tax: { net_due_minor: 121000, input_tax_unquantified: false } }, checks),
    [],
  );
  // Unquantified and honest about it — no figure, no fault.
  assert.deepEqual(
    shipFaults({ sales_tax: { output_tax_minor: 164000, input_tax_unquantified: true } }, checks),
    [],
  );
  // Zero is a stated figure, not an absent one: "you owe nothing" is a claim.
  assert.equal(
    shipFaults({ sales_tax: { net_due_minor: 0, input_tax_unquantified: true } }, checks).length,
    1,
  );
});

test("a stated count must equal the list it counts", () => {
  // "The work calls for confirmation of four review items, but the ledger contains five lines marked
  // owner confirmation required" — a client, reading a close, having counted. The four they can see
  // is not what it costs. It costs every other number in the document, because now they are auditing
  // rather than reading.
  const checks = readShipChecks([
    { kind: "counts", items: "questions", field: "profit_and_loss.held_pending_decision.item_count" },
  ]);
  assert.equal(checks.length, 1);

  const q = (n: number) => Array.from({ length: n }, (_, i) => ({ about: `item ${i}` }));

  const wrong = shipFaults(
    { questions: q(5), profit_and_loss: { held_pending_decision: { item_count: 4 } } },
    checks,
  );
  assert.equal(wrong.length, 1);
  assert.match(wrong[0]!.message, /says 4 but .* has 5/);

  // Absent is the same failure with the discrepancy hidden.
  const missing = shipFaults({ questions: q(5), profit_and_loss: {} }, checks);
  assert.equal(missing.length, 1);
  assert.match(missing[0]!.message, /is missing/);

  assert.deepEqual(
    shipFaults({ questions: q(5), profit_and_loss: { held_pending_decision: { item_count: 5 } } }, checks),
    [],
  );
  // Nothing to count, nothing to state.
  assert.deepEqual(shipFaults({ questions: [], profit_and_loss: {} }, checks), []);
  assert.deepEqual(shipFaults({ profit_and_loss: {} }, checks), []);
});

test("a sums_to fault names the fields and the fix, not just the disagreement", () => {
  // A close reported a held total of 97290 against five lines adding to -97290. The fault said only
  // "the total says 97290 and the 5 lines add up to -97290", the repair round returned the identical
  // answer, and it was right to: a reader of that sentence concludes the total is correct and the
  // lines merely carry minus signs. A fault that does not say which side to move makes the repair a
  // re-roll.
  const checks = readShipChecks([
    { kind: "sums_to", items: "questions", each: "amount_minor", total: "held.amount_minor" },
  ]);
  const faults = shipFaults(
    {
      questions: [{ amount_minor: -21600 }, { amount_minor: -34000 }, { amount_minor: -41690 }],
      held: { amount_minor: 97290 },
    },
    checks,
  );
  assert.equal(faults.length, 1);
  const m = faults[0]!.message;
  assert.match(m, /`held\.amount_minor`/, "names the total's own path");
  assert.match(m, /`questions\[\]\.amount_minor`/, "names the lines' own path");
  assert.match(m, /Set `held\.amount_minor` to -97290/, "says which side to move, and to what");
  assert.match(m, /opposite sign/, "and names the shape of this particular disagreement");
});

test("profit must equal revenue minus expenses — the identity nothing was checking", () => {
  // A close reported revenue 8,200.00, expenses 4,129.39 and net 3,730.61. The first two imply
  // 4,070.61, and the run then quoted 4,070.61 in the covering note and 3,730.61 in the attached
  // P&L. The client found it: "I should not have to identify and resolve a £340.00 contradiction in
  // a paid month-end close, or choose between two different profits."
  //
  // `sums_to` checks a total against a LIST. The most consequential arithmetic in a close is three
  // declared fields, and nothing compared them.
  const checks = readShipChecks([
    {
      kind: "nets_to",
      minuend: "profit_and_loss.revenue_minor",
      subtrahend: "profit_and_loss.expenses_minor",
      total: "profit_and_loss.net_minor",
    },
  ]);
  assert.equal(checks.length, 1);

  const wrong = shipFaults(
    { profit_and_loss: { revenue_minor: 820000, expenses_minor: 412939, net_minor: 373061 } },
    checks,
  );
  assert.equal(wrong.length, 1);
  assert.match(wrong[0]!.message, /820000 - 412939 = 407061/);
  assert.match(wrong[0]!.message, /Set `profit_and_loss\.net_minor` to 407061/);

  assert.deepEqual(
    shipFaults({ profit_and_loss: { revenue_minor: 820000, expenses_minor: 412939, net_minor: 407061 } }, checks),
    [],
  );
  // A loss is not a fault.
  assert.deepEqual(
    shipFaults({ profit_and_loss: { revenue_minor: 100, expenses_minor: 500, net_minor: -400 } }, checks),
    [],
  );
  // Nothing to compare, nothing to say — a missing field is `ship_requires`' job, not this one.
  assert.deepEqual(shipFaults({ profit_and_loss: { revenue_minor: 820000 } }, checks), []);
});

test("a figure printed straight out of minor units is caught", () => {
  // "Total payments of £4,469.39 include £34,000.00 in suspense." The suspense item is -34000 minor
  // units, which is £340.00. The client did the only arithmetic available: "£34,000.00 already
  // exceeds the stated total by £29,530.61. A £33,660.00 mistake in a short client summary damages
  // confidence in the rest of the work."
  const checks = readShipChecks([{ kind: "minor_units", field: "client_summary" }]);
  assert.equal(checks.length, 1);

  const parsed = {
    client_summary: "Total payments of £4,469.39 include £34,000.00 held in suspense.",
    reconciliation: { out_minor: 446939 },
    questions: [{ amount_minor: -34000 }],
  };
  const faults = shipFaults(parsed, checks);
  assert.equal(faults.length, 1);
  assert.match(faults[0]!.message, /£34,000\.00/);
  assert.match(faults[0]!.message, /which is 340\.00/);

  // The same note written correctly. £340.00 → 34000 is held, so it converted.
  assert.deepEqual(
    shipFaults({ ...parsed, client_summary: "Total payments of £4,469.39 include £340.00 held in suspense." }, checks),
    [],
  );

  // A figure the output never held at all is not this check's business — it says nothing rather than
  // guessing, which is what keeps it from being deleted.
  assert.deepEqual(
    shipFaults({ ...parsed, client_summary: "Your rent is £1,280.00 a month." }, checks),
    [],
  );

  // Pence rule out a copied minor-unit integer, so a real amount that happens to collide is safe.
  assert.deepEqual(
    shipFaults({ client_summary: "We saw £34,000.55 today.", x: { a: 34000 } }, checks),
    [],
  );

  // Years, counts and percentages are not currency and are left alone.
  assert.deepEqual(
    shipFaults({ client_summary: "In 2026 we reviewed 16 transactions, up 20.00%.", n: { a: 2026, b: 16 } }, checks),
    [],
  );

  // Negatives in the output match too — money out is stored signed.
  assert.equal(
    shipFaults({ client_summary: "£19,500.00 went out.", p: { a: -19500 } }, checks).length,
    1,
  );
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// ratio_of — THE THIRD SHAPE OF THE SAME BETRAYAL
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//
// `sums_to` catches a total that disagrees with its lines. `nets_to` catches a bottom line that
// disagrees with the two figures above it. Neither catches the most common number in a service
// business report — a RATE: share of voice, conversion, utilisation, margin, on-time delivery.
// Every one is a percentage printed beside the two counts it came from.

test("ship_checks: a percentage must equal the two counts it comes from", () => {
  /**
   * geo-monitor's `weekly_report` is the live example, and it is the flagship deliverable. It states
   * `share_of_voice_pct`, `mentions` and `queries`, all three carried by hand out of a pack that
   * computed them together. Nothing compared them.
   *
   * "Share of voice 60%" beside "mentioned in 2 of 8" satisfies the schema, satisfies
   * `ship_requires`, and is 25% — and the client can do that division in their head faster than they
   * can read the sentence around it.
   */
  const checks = readShipChecks([
    { kind: "ratio_of", numerator: "mentions", denominator: "queries", pct: "share_of_voice_pct" },
  ]);
  assert.equal(checks.length, 1);

  const wrong = shipFaults({ mentions: 2, queries: 8, share_of_voice_pct: 60 }, checks);
  assert.equal(wrong.length, 1);
  assert.match(wrong[0]!.message, /2 of 8, which is 25%/);
  assert.match(wrong[0]!.message, /Set `share_of_voice_pct` to 25/);

  assert.deepEqual(shipFaults({ mentions: 2, queries: 8, share_of_voice_pct: 25 }, checks), []);
});

test("ship_checks: rounding is honest, invention is not", () => {
  /**
   * A tenth of a point of tolerance, and it exists only here.
   *
   * `sums_to` is exact because money is integer minor units. A percentage is not: 2/3 is 66.7 to one
   * decimal and 66.67 to two, and both are truthful answers a careful run might give. Wide enough
   * that rounding never fails, far too narrow for a number somebody made up.
   */
  const checks = readShipChecks([
    { kind: "ratio_of", numerator: "won", denominator: "pitched", pct: "win_rate_pct" },
  ]);
  assert.deepEqual(shipFaults({ won: 2, pitched: 3, win_rate_pct: 66.7 }, checks), []);
  assert.deepEqual(shipFaults({ won: 2, pitched: 3, win_rate_pct: 66.67 }, checks), []);
  // Half a point out is not rounding.
  assert.equal(shipFaults({ won: 2, pitched: 3, win_rate_pct: 67.2 }, checks).length, 1);
});

test("ship_checks: nought out of nought is not this check's argument", () => {
  /**
   * A zero denominator means the run measured nothing, and a percentage over an empty sample is not
   * a number. Saying so is `not_when`'s job — see geo-monitor's `no_surface_reached`, where every
   * probe was blocked. A `ratio_of` that also complained here would be arguing with a run that
   * correctly has nothing to report, and two checks fighting over one field is how a gate gets
   * switched off.
   */
  const checks = readShipChecks([
    { kind: "ratio_of", numerator: "mentions", denominator: "queries", pct: "share_of_voice_pct" },
  ]);
  assert.deepEqual(shipFaults({ mentions: 0, queries: 0, share_of_voice_pct: 0 }, checks), []);
  // And a missing count is not a violation either — there is nothing to compare against.
  assert.deepEqual(shipFaults({ share_of_voice_pct: 40 }, checks), []);
});

test("ship_checks: a malformed ratio_of is dropped, not half-applied", () => {
  // Same rule as every other kind: a check missing a field cannot be evaluated, and a half-parsed
  // one that silently compared the wrong pair would be worse than no check at all.
  assert.deepEqual(readShipChecks([{ kind: "ratio_of", numerator: "a", pct: "c" }]), []);
  assert.deepEqual(readShipChecks([{ kind: "ratio_of", numerator: "a", denominator: "b" }]), []);
});

// ── required_when ─────────────────────────────────────────────────────────────────────────────────
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// "WE CANNOT RUN YOUR BUSINESS, AND HERE IS NOTHING TO DO ABOUT IT" WAS A LEGAL ANSWER
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// `draft_shape` answers `runs_as.fit: none` — nothing we ship is the work this business sells — and
// `runs_as.to_author` is the list of services to write for them. Nothing required the second when
// the first was true, and `runs_as.required` was `["fit"]` alone.
//
// Measured across every shaping run in production: TWELVE answered `none`, and NINE of those
// proposed nothing. "Texas Payroll and Contractor Compliance" was shaped three separate times and
// proposed nothing on all three. Those nine are precisely the businesses the written-service path
// exists to serve, and it is precisely the businesses it never fired for — the whole "works for any
// service business" claim died in an unrequired array.
//
// The inverse of `not_when`, and conditional rather than a plain `min_items` because when the
// catalogue DOES cover the delivery an empty list is correct and demanding an entry invents work.

test("REQUIRED_WHEN: fit=none with nothing to author is a fault", () => {
  const checks = [{ kind: "required_when", field: "runs_as.to_author", when: "runs_as.fit", equals: "none", n: 1 }] as never;
  const faults = shipFaults({ runs_as: { fit: "none", to_author: [] } }, checks);
  assert.equal(faults.length, 1, "a business we cannot serve, with nothing proposed, passed");
  assert.match(faults[0]!.message, /at least 1 entr/);
  // The sentence has to carry the reasoning, because it is fed back to the model as the retry.
  assert.match(faults[0]!.message, /all of it is something to write/);

  // Absent entirely is the same fault as empty — that is how nine of the twelve actually answered.
  assert.equal(shipFaults({ runs_as: { fit: "none" } }, checks).length, 1);
});

test("it is silent when the catalogue covers the work", () => {
  const checks = [{ kind: "required_when", field: "runs_as.to_author", when: "runs_as.fit", equals: "none", n: 1 }] as never;
  /*
    `direct` and `adjacent` mean we already run this. Demanding a service to write there would invent
    work and put a draft in front of a founder who needs none — which is why this is conditional and
    not `min_items`.
  */
  assert.deepEqual(shipFaults({ runs_as: { fit: "direct", wedge: "books-keeper" } }, checks), []);
  assert.deepEqual(shipFaults({ runs_as: { fit: "adjacent", to_author: [] } }, checks), []);
  // And satisfied when the answer is what it should have been all along.
  assert.deepEqual(
    shipFaults({ runs_as: { fit: "none", to_author: [{ title: "Payroll and contractor compliance" }] } }, checks),
    [],
  );
});

test("a non-array, a string and a missing trigger are all handled without throwing", () => {
  const checks = [{ kind: "required_when", field: "runs_as.to_author", when: "runs_as.fit", equals: "none", n: 1 }] as never;
  // A model that answers the array as prose has produced zero entries, not one.
  assert.equal(shipFaults({ runs_as: { fit: "none", to_author: "payroll" } }, checks).length, 1);
  // No `fit` at all: this check has nothing to say. The schema's own `required` covers that.
  assert.deepEqual(shipFaults({ runs_as: {} }, checks), []);
  assert.deepEqual(shipFaults({}, checks), []);
});


