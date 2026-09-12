// The gates a generated service gets, and the ones it must not get.
//
// ═══ THE PROBLEM THIS SOLVES ═══
//
// books-keeper's `monthly_close` carries eleven `ship_checks`, every one written after a paying
// client read a deliverable and objected. Thirty-two runs of hardening, on ONE service. A founder
// describing their business at onboarding gets a service generated on the fly with `ship_checks`
// none and `ship_requires` none — not weaker gates, no gates — so the first client of every service
// Mycel invents receives work held to nothing.
//
// The proof that inference works is not that it produces checks. It is that it produces the SAME
// checks a human arrived at the expensive way, from the schema alone, without seeing a single run.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inferChart, inferChecks } from "../src/infer-checks";
import { plainChecks, readShipChecks, shipFaults } from "../src/ship-checks";
import { wedgesDir } from "../src/wedge";

/** The shape a generated service almost always has: a list of lines and a total. */
const INVOICE = {
  type: "object",
  properties: {
    covering_note: { type: "string" },
    lines: { type: "array", items: { type: "object", properties: { what: { type: "string" }, charge_minor: { type: "integer" } } } },
    total_minor: { type: "integer" },
    artifacts: { type: "array", items: { type: "object", properties: { name: { type: "string" } } } },
    needs: { type: "array", items: { type: "object", properties: { about: { type: "string" }, recommendation: { type: "string" } } } },
  },
};

const kinds = (checks: readonly { kind: string }[]): string[] => checks.map((c) => c.kind);

test("it rediscovers the checks a human paid thirty-two client-judged runs to learn", () => {
  // The whole argument, measured. Not "inference produces gates" — inference produces THESE gates,
  // from the schema alone, having seen no runs and no complaints.
  const manifest = JSON.parse(readFileSync(join(wedgesDir(), "books-keeper", "wedge.json"), "utf8"));
  const spec = manifest.task_types.monthly_close;
  const got = inferChecks(spec.output_schema);
  const found = new Set(got.ship_checks.map((c) => JSON.stringify(c)));
  const has = (c: unknown): boolean => found.has(JSON.stringify(c));

  // The prose rules: a covering note that says nothing, runs forever, ships a placeholder, or prints
  // 34000 where £340.00 belongs.
  assert.ok(has({ kind: "min_words", field: "client_summary", n: 25 }));
  assert.ok(has({ kind: "max_words", field: "client_summary", n: 400 }));
  assert.ok(has({ kind: "forbids", field: "client_summary", vocabulary: "placeholder" }));
  assert.ok(has({ kind: "minor_units", field: "client_summary" }), "prose beside minor-unit figures");

  // The arithmetic identity at the bottom of every P&L, found two levels down.
  assert.ok(
    has({
      kind: "nets_to",
      minuend: "profit_and_loss.revenue_minor",
      subtrahend: "profit_and_loss.expenses_minor",
      total: "profit_and_loss.net_minor",
    }),
  );

  // "The books balance" beside a difference that says they do not.
  assert.ok(has({ kind: "agrees", flag: "reconciled", zero_when_true: "difference_cents" }));

  // The complaint that came first every time: a figure stated beside a flag saying it cannot be known.
  assert.ok(has({ kind: "not_when", field: "sales_tax.net_due_minor", unknown_when: "sales_tax.input_tax_unquantified" }));

  // Every question carries a recommendation — `delivering-work.md` rule 7, enforced without being told.
  assert.ok(has({ kind: "each_has", items: "questions", field: "recommendation" }));
  assert.ok(has({ kind: "each_has", items: "artifacts", field: "name" }));

  // And the ship bar: the prose, the structured sections, and the files.
  for (const f of ["client_summary", "profit_and_loss", "reconciliation", "artifacts"]) {
    assert.ok(got.ship_requires.includes(f), `ship_requires should include ${f}`);
  }
  // Never the asks. `ship_requires: ["needs"]` would hold every finished job that had nothing to ask,
  // turning the best possible outcome into a failure.
  for (const f of ["needs", "questions", "anomalies"]) {
    assert.equal(got.ship_requires.includes(f), false, `${f} is an ask, not the work`);
  }
});

test("it infers the totals check on the shape a generated service actually has", () => {
  const got = inferChecks(INVOICE);
  assert.deepEqual(
    got.ship_checks.find((c) => c.kind === "sums_to"),
    { kind: "sums_to", items: "lines", each: "charge_minor", total: "total_minor" },
  );
  assert.deepEqual(got.ship_requires, ["covering_note", "artifacts"]);
  // An empty list is a legitimate answer — nothing owed, nothing anomalous — and `missingSubstance`
  // holds an empty one, so requiring every array turns the best outcome into a failure. Files are the
  // exception: a deliverable with no artifact is not a deliverable.
  assert.equal(got.ship_requires.includes("lines"), false);
  assert.equal(got.ship_requires.includes("needs"), false);
});

test("it stays SILENT where the pairing is ambiguous, rather than guessing", () => {
  // books-keeper's schema is the argument for restraint: five lists carry `amount_minor` and
  // `profit_and_loss` alone holds three totalish scalars. Nothing in the names says which sums to
  // which, and a `sums_to` pointed at the wrong total holds every correct deliverable. Guessing there
  // is a coin flip on somebody's books.
  const manifest = JSON.parse(readFileSync(join(wedgesDir(), "books-keeper", "wedge.json"), "utf8"));
  const got = inferChecks(manifest.task_types.monthly_close.output_schema);
  /**
   * NARROWED, because the code got better and this assertion encoded the old limitation.
   *
   * It used to read "no `sums_to` at all — ambiguous, so hand-declared". One of them is no longer
   * ambiguous: the author wrote "the SIGNED sum of every question's `amount_minor`" in the schema,
   * and reading that sentence is evidence rather than a guess. What is still ambiguous is
   * `by_category` → `expenses_minor`, where BOTH fields have no description, and that one must stay
   * uninferred — five lists carry `amount_minor` and picking is a coin flip on somebody's books.
   */
  assert.equal(
    got.ship_checks.some((c) => c.kind === "sums_to" && (c as { total?: string }).total === "profit_and_loss.expenses_minor"),
    false,
    "nothing in the schema states this pairing, so nothing may claim it",
  );

  // Two numeric columns on the items: which one is the total of?
  const twoCols = inferChecks({
    type: "object",
    properties: {
      lines: { type: "array", items: { type: "object", properties: { hours: { type: "number" }, charge_minor: { type: "integer" } } } },
      total_minor: { type: "integer" },
    },
  });
  assert.equal(kinds(twoCols.ship_checks).includes("sums_to"), false);
});

test("it does not fire on the NORMAL case, which is how a check gets deleted", () => {
  // `estimated` and `provisional` were in the not_when family and they are a different claim: a
  // provisional profit is a real figure that may move, and `provisional` is true on almost every
  // close. Requiring the figure absent whenever it is true would have held every close this product
  // produces.
  const got = inferChecks({
    type: "object",
    properties: {
      profit_and_loss: {
        type: "object",
        properties: { net_minor: { type: "integer" }, provisional: { type: "boolean" } },
      },
    },
  });
  assert.equal(kinds(got.ship_checks).includes("not_when"), false);

  // A generic `item_count` bound to every list in the schema — nine identical checks off one field.
  // A count that could be counting any of nine things is a check nobody can predict.
  const generic = inferChecks({
    type: "object",
    properties: {
      questions: { type: "array", items: { type: "object", properties: { about: { type: "string" } } } },
      anomalies: { type: "array", items: { type: "object", properties: { about: { type: "string" } } } },
      item_count: { type: "integer" },
    },
  });
  assert.equal(kinds(generic.ship_checks).includes("counts"), false);

  // Named for its own list, it fires.
  const named = inferChecks({
    type: "object",
    properties: {
      candidates: { type: "array", items: { type: "object", properties: { name: { type: "string" } } } },
      candidates_reviewed: { type: "integer" },
    },
  });
  assert.deepEqual(
    named.ship_checks.find((c) => c.kind === "counts"),
    { kind: "counts", items: "candidates", field: "candidates_reviewed" },
  );
});

test("an internal task type gets no client-facing gates at all", () => {
  // The prose rules and the ship bar are about work somebody PAYS for. Applying them to a routing
  // decision is how a gate earns a reputation for getting in the way.
  const got = inferChecks(INVOICE, { clientFacing: false });
  assert.deepEqual(got.ship_checks, []);
  assert.deepEqual(got.ship_requires, []);
});

test("everything it emits survives the parser and runs", () => {
  // `ship_checks` is a CLOSED vocabulary: `readShipChecks` silently drops a kind it does not know, so
  // an inferred check with a typo would be a gate that reports as present and does nothing. Round-trip
  // every one through the real parser and the real evaluator.
  const got = inferChecks(INVOICE);
  const parsed = readShipChecks(got.ship_checks);
  assert.equal(parsed.length, got.ship_checks.length, "no inferred check is dropped at load");

  // And they actually catch the thing they exist for.
  const faults = shipFaults(
    { covering_note: "Short.", lines: [{ what: "Design", charge_minor: 50_000 }], total_minor: 99_999 },
    parsed,
  );
  assert.ok(faults.some((f) => f.kind === "sums_to"), "a total that disagrees with its lines");
  assert.ok(faults.some((f) => f.kind === "min_words"), "a covering note that says nothing");

  // A correct one passes clean — a generator whose gates hold good work is worse than no generator.
  assert.deepEqual(
    shipFaults(
      {
        covering_note:
          "July is invoiced. Two days of design at the agreed rate, plus the workshop travel we " +
          "discussed. Payment terms are fourteen days and the bank details are on the attached PDF.",
        lines: [{ what: "Design", charge_minor: 50_000 }],
        total_minor: 50_000,
        artifacts: [{ name: "invoice.pdf" }],
      },
      parsed,
    ),
    [],
  );

  assert.equal(got.why.length, got.ship_checks.length, "every gate says why it is there");
});

test("a service authored at onboarding leaves with gates, and a declared bar is never overruled", async () => {
  // The whole point. Before this, `authorWedgeFromOutput` produced `ship_checks: none` and
  // `ship_requires: none` — not weaker gates, no gates — so the first client of every service Mycel
  // invents received work held to nothing.
  const { authorWedgeFromOutput } = await import("../src/wedgeauthor");

  const out = {
    wedge: "studio-billing",
    title: "Studio billing",
    task_types: {
      prepare_invoice: {
        description: "Turn the month's tracked hours into an invoice the client pays from.",
        output_schema: INVOICE,
      },
      classify_inbound: {
        internal: true,
        description: "Route an inbound message.",
        output_schema: { type: "object", properties: { covering_note: { type: "string" } } },
      },
    },
  };
  const res = authorWedgeFromOutput(out, { slugBase: "studio-billing" });
  assert.deepEqual(res.faults, []);
  const tt = res.draft!.manifest.task_types!.prepare_invoice as { ship_requires?: string[]; ship_checks?: { kind: string }[] };
  assert.ok(tt.ship_checks?.length, "a generated service ships with gates");
  assert.ok(tt.ship_checks!.some((c) => c.kind === "sums_to"), "including the one a client pays from");
  assert.deepEqual(tt.ship_requires, ["covering_note", "artifacts"]);

  // An internal task type gets none: the prose rules are about work somebody pays for, and applying
  // them to a routing decision is how a gate earns a reputation for getting in the way.
  const internal = res.draft!.manifest.task_types!.classify_inbound as { ship_checks?: unknown[] };
  assert.equal(internal.ship_checks?.length ?? 0, 0);

  // DECLARED WINS. This fills a hole; it does not overrule a decision an author made.
  const declared = authorWedgeFromOutput(
    {
      ...out,
      task_types: {
        prepare_invoice: { description: "x", output_schema: INVOICE, ship_requires: ["lines"], ship_checks: [{ kind: "min_words", field: "covering_note", n: 5 }] },
      },
    },
    { slugBase: "studio-billing" },
  );
  const kept = declared.draft!.manifest.task_types!.prepare_invoice as { ship_requires?: string[]; ship_checks?: { kind: string; n?: number }[] };
  assert.deepEqual(kept.ship_requires, ["lines"]);
  assert.equal(kept.ship_checks!.length, 1);
  assert.equal(kept.ship_checks![0]!.n, 5);
});

test("the founder reads sentences, not schema paths", () => {
  // The first version of the review card rendered `describeShipContract`, which is written to
  // instruct a MODEL: "`reconciled` and `difference_cents` must agree: reconciled is true ONLY when
  // difference_cents is 0." The founder this product is for runs an agency. The only thing that
  // sentence teaches them is that the software is for somebody else.
  //
  // Grouped by KIND rather than per field, too: nobody wants twenty-four rules, they want to know
  // what is guaranteed. Same guarantees either way.
  const inferred = inferChecks(INVOICE);
  const plain = plainChecks(inferred.ship_requires, readShipChecks(inferred.ship_checks));

  assert.ok(plain.length > 0);
  const joined = plain.join(" ");
  // No field name, no path, no backtick, no snake_case — the vocabulary is ours, not theirs.
  assert.equal(/`/.test(joined), false, "no backticked identifiers");
  assert.equal(/[a-z]_[a-z]/.test(joined), false, "no snake_case field names");
  for (const ours of ["artifacts", "client_summary", "ship_requires", "schema", "field"]) {
    assert.equal(joined.includes(ours), false, `"${ours}" is our word, not the founder's`);
  }
  // And it still says the thing that matters most about an invoice.
  assert.ok(plain.some((p) => /total is added up from its own lines/.test(p)));
  // `artifacts` reaches them as "the files".
  assert.ok(plain.some((p) => /the files/.test(p)), "our nouns are translated, not printed");

  // A service with no gates says nothing rather than inventing reassurance.
  assert.deepEqual(plainChecks([], []), []);
});

// ── And the picture, from the same schema ────────────────────────────────────────────────────────
//
// The checks above are about the work being RIGHT. These are about it being READ. A close pack
// shipped as a wall of correct figures and every client asked where their money was going; the
// answer was in the numbers and took four minutes to assemble, so most never did.

test("it rediscovers both charts a human wrote, from the schema alone", () => {
  // Same argument as the checks, measured the same way: not "inference produces a chart" but
  // inference produces THESE charts, the ones somebody declared after clients complained.
  const books = JSON.parse(readFileSync(join(wedgesDir(), "books-keeper", "wedge.json"), "utf8"));
  const close = books.task_types.monthly_close;
  const got = inferChart(close.output_schema)!;
  assert.ok(got);
  assert.equal(got.series, close.chart.series);
  assert.equal(got.label, close.chart.label);
  assert.equal(got.value, close.chart.value);
  // And it finds where the run states its money, which is the whole reason `currency_at` is a path.
  assert.equal(got.currency_at, "currency");

  const geo = JSON.parse(readFileSync(join(wedgesDir(), "geo-monitor", "wedge.json"), "utf8"));
  const weekly = geo.task_types.weekly_report;
  const chart = inferChart(weekly.output_schema)!;
  assert.equal(chart.series, weekly.chart.series);
  assert.equal(chart.value, weekly.chart.value);
  // No currency here, and none invented: a count of citations is not money.
  assert.equal(chart.currency_at, undefined);
});

test("a list of exceptions is not a chart, however chartable it looks", () => {
  // THE ONE THE SWEEP CAUGHT. The first version took the only qualifying array, and `read_signals`
  // got a bar chart of `stale` by `age_days` — a picture of the EXCEPTION LIST, sorted by how old the
  // exceptions are, which is not a question anybody asked. A held deliverable is a delay somebody
  // investigates; a confident picture of a false thing on page one is worse.
  const exceptions = {
    type: "object",
    properties: {
      stale: { type: "array", items: { type: "object", properties: { type: { type: "string" }, age_days: { type: "integer" } } } },
      client_summary: { type: "string" },
    },
  };
  assert.equal(inferChart(exceptions), undefined);

  // A schema author names a distribution when they have one. That name is the whole signal.
  const named = {
    type: "object",
    properties: {
      by_channel: { type: "array", items: { type: "object", properties: { channel: { type: "string" }, spend_minor: { type: "integer" } } } },
      currency: { type: "string" },
    },
  };
  assert.deepEqual(inferChart(named), {
    series: "by_channel",
    label: "channel",
    value: "spend_minor",
    title: "By channel",
    currency_at: "currency",
    limit: 10,
  });
});

test("two numbers on a row, or two breakdowns, means silence", () => {
  // Hours or charge? Mentions or citations? The picture would be a guess about which one the reader
  // wants, and a guess is the thing this refuses to make.
  const ambiguousColumns = {
    type: "object",
    properties: {
      by_client: { type: "array", items: { type: "object", properties: { client: { type: "string" }, hours: { type: "number" }, charge_minor: { type: "integer" } } } },
    },
  };
  assert.equal(inferChart(ambiguousColumns), undefined);

  const twoBreakdowns = {
    type: "object",
    properties: {
      by_client: { type: "array", items: { type: "object", properties: { client: { type: "string" }, charge_minor: { type: "integer" } } } },
      by_category: { type: "array", items: { type: "object", properties: { category: { type: "string" }, amount_minor: { type: "integer" } } } },
    },
  };
  assert.equal(inferChart(twoBreakdowns), undefined);

  // An internal tick gets nothing at all: a routing decision has no client and no page one.
  assert.equal(inferChart(twoBreakdowns, { clientFacing: false }), undefined);
});

test("the author's own words become the title when they read like one", () => {
  const described = {
    type: "object",
    properties: {
      by_category: {
        type: "array",
        description: "Where the money went, largest first. Costs only.",
        items: { type: "object", properties: { category: { type: "string" }, amount_minor: { type: "integer" } } },
      },
    },
  };
  assert.equal(inferChart(described)!.title, "Where the money went, largest first");
});

// ── The pairing the author already wrote down ───────────────────────────────────────────────────

test("it reads the relationship out of the description when names cannot say it", () => {
  // ═══ WHERE NAME-BASED INFERENCE RUNS OUT ═══
  //
  // books-keeper has FIVE lists carrying `amount_minor` and three totalish scalars in one object.
  // No rule over identifiers can say which sums to which, and the restraint above is right.
  //
  // But two of those pairings are not ambiguous at all, because the author STATED them:
  //
  //   held_pending_decision.amount_minor — "The SIGNED sum of every question's `amount_minor`"
  //   held_pending_decision.item_count   — "Must equal the number of open questions"
  //
  // That is evidence, not a guess — and it is the register schema authors write in without being
  // asked, because there is no other way to say what a total is.
  const manifest = JSON.parse(readFileSync(join(wedgesDir(), "books-keeper", "wedge.json"), "utf8"));
  const spec = manifest.task_types.monthly_close;
  const got = inferChecks(spec.output_schema);
  const found = new Set(got.ship_checks.map((c) => JSON.stringify(c)));

  assert.ok(found.has(JSON.stringify({ kind: "counts", items: "questions", field: "profit_and_loss.held_pending_decision.item_count" })));
  assert.ok(
    found.has(
      JSON.stringify({ kind: "sums_to", items: "questions", each: "amount_minor", total: "profit_and_loss.held_pending_decision.amount_minor" }),
    ),
  );

  // ELEVEN OF TWELVE, from the schema alone, having seen no runs and no complaints.
  const hit = spec.ship_checks.filter((c: unknown) => found.has(JSON.stringify(c))).length;
  assert.ok(hit >= 11, `rediscovered ${hit}/12`);
});

test("the twelfth is not inferred, and that is the correct answer", () => {
  // `profit_and_loss.by_category[].amount_minor` sums to `profit_and_loss.expenses_minor`, and
  // BOTH FIELDS HAVE NO DESCRIPTION AT ALL. Nothing in that schema states the relationship, so
  // nothing here may claim it — five lists carry `amount_minor` and guessing is a coin flip on
  // somebody's books. A generator that recovered 12/12 by guessing the last one would be worse than
  // one that recovers 11 and says so.
  const manifest = JSON.parse(readFileSync(join(wedgesDir(), "books-keeper", "wedge.json"), "utf8"));
  const got = inferChecks(manifest.task_types.monthly_close.output_schema);
  assert.equal(
    got.ship_checks.some(
      (c) => c.kind === "sums_to" && (c as { total?: string }).total === "profit_and_loss.expenses_minor",
    ),
    false,
  );
});

test("a description that mentions a list it cannot resolve infers nothing", () => {
  // The sentence has to name something that EXISTS. A total described as "the sum of all charges"
  // in a schema with no `charges` array is prose, not a pairing, and claiming one would point a
  // gate at a field nobody has.
  const dangling = {
    type: "object",
    properties: {
      client_summary: { type: "string" },
      total_minor: { type: "integer", description: "The sum of every charge's amount." },
    },
  };
  assert.equal(inferChecks(dangling).ship_checks.some((c) => c.kind === "sums_to"), false);

  // And when it does resolve, with the item field named, it fires.
  const stated = {
    type: "object",
    properties: {
      client_summary: { type: "string" },
      sessions: { type: "array", items: { type: "object", properties: { who: { type: "string" }, minutes: { type: "integer" }, fee_minor: { type: "integer" } } } },
      billed_minor: { type: "integer", description: "The sum of every session's `fee_minor` for the period." },
    },
  };
  assert.deepEqual(
    inferChecks(stated).ship_checks.find((c) => c.kind === "sums_to"),
    { kind: "sums_to", items: "sessions", each: "fee_minor", total: "billed_minor" },
  );

  // Two numeric columns and NO named field is still a refusal — the same two-columns test the
  // name-based rule applies, for the same reason: which one is the total of?
  const ambiguous = JSON.parse(JSON.stringify(stated));
  ambiguous.properties.billed_minor.description = "The sum of every session for the period.";
  assert.equal(inferChecks(ambiguous).ship_checks.some((c) => c.kind === "sums_to"), false);
});

test("a money field that merely mentions counting is not a count check", () => {
  // "counts five in the ledger" appears in a description about money. A `counts` check pointed at a
  // minor-units field would compare a list length to a currency amount and hold every correct run.
  const schema = {
    type: "object",
    properties: {
      client_summary: { type: "string" },
      items: { type: "array", items: { type: "object", properties: { what: { type: "string" }, amount_minor: { type: "integer" } } } },
      held_minor: { type: "integer", description: "What is held. A client who counts the number of items and reads a different figure stops trusting both." },
      item_count: { type: "integer", description: "Must equal the number of items." },
    },
  };
  const got = inferChecks(schema).ship_checks.filter((c) => c.kind === "counts");
  assert.deepEqual(got, [{ kind: "counts", items: "items", field: "item_count" }]);
});
