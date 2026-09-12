// Will this service produce work a client would actually pay for?
//
// `authoredFaults` refuses a manifest that cannot run. `loop-coverage` says whether the business can
// find, win, do, bill and keep. Both are structural, and a service can pass both and hand a client a
// document with a contradiction in it.
//
// That gap matters most for a service a model wrote twenty seconds ago from one paragraph a founder
// typed. Nobody has read it, the founder is about to point it at a real client, and "it validated"
// is not what they are asking.
import { test } from "node:test";
import assert from "node:assert/strict";
import { repairAuthoredManifest } from "../src/wedgeauthor";
import { gradeDeliverables } from "../src/deliverable-grade";
import { loadWedge } from "../src/wedge";
import type { WedgeManifest } from "../src/wedge";

const wedge = (over: Partial<WedgeManifest> = {}): WedgeManifest =>
  ({
    wedge: "test-desk",
    fulfillment: { deliverable_shapes: ["document"] },
    capabilities: ["read_bank_transactions"],
    task_types: {
      do_the_work: {
        output_schema: { required: ["client_summary"], properties: { client_summary: { type: "string" } } },
        input_schema: { properties: { period: { type: "string" } } },
        ship_requires: ["client_summary"],
        ship_checks: [{ kind: "not_when", field: "total_minor", unknown_when: "incomplete" }],
      },
    },
    ...over,
  }) as unknown as WedgeManifest;

test("machinery is not a failed trade", () => {
  /**
   * gtm-operator finds clients, invoice-chaser chases money, business-shaper reads a description.
   * None hands a client a deliverable and all are working correctly. The first version graded them
   * "Not ready for a client" — wrong, and the loudest thing on the screen.
   *
   * A role is the manifest's own statement that it is machinery. Real wedges, not fixtures, because
   * the false positive was on real wedges.
   */
  for (const slug of ["gtm-operator", "invoice-chaser", "business-shaper"]) {
    const w = loadWedge(slug);
    assert.ok(w, slug);
    const g = gradeDeliverables(w!.manifest, { exemplars: w!.exemplars.length });
    assert.equal(g.blocking, 0, `${slug}: ${g.findings.map((f) => f.rule).join(", ")}`);
    assert.match(g.verdict, /machinery rather than a trade/);
  }
});

test("a wedge that neither delivers nor runs machinery is blocking", () => {
  // The real finding the machinery exemption must not swallow: it is neither.
  const g = gradeDeliverables({
    wedge: "nothing-desk",
    task_types: { think_about_it: { output_schema: { required: ["a"] } } },
  } as unknown as WedgeManifest);
  assert.equal(g.blocking, 1);
  assert.equal(g.findings[0]!.rule, "delivers-nothing");
});

test("`client_summary` is not a number, and the first version thought it was", () => {
  /**
   * `NUMERIC_NAME` was a bare substring match and `sum` fired on `client_summary` — which is on
   * nearly every deliverable in the product — so almost every job in every wedge was reported as
   * having unchecked numbers. A tool that cries wolf on ninety per cent of its subjects teaches
   * people to skip it, which costs the ten per cent.
   */
  const g = gradeDeliverables(wedge());
  assert.ok(!g.findings.some((f) => f.rule === "numbers-unchecked"), g.findings.map((f) => f.rule).join(", "));

  // A field that IS a number still fires.
  const withMoney = gradeDeliverables(
    wedge({
      task_types: {
        do_the_work: {
          output_schema: { required: ["total_minor"], properties: { total_minor: { type: "integer" } } },
          input_schema: { properties: { period: {} } },
          ship_requires: ["total_minor"],
          ship_checks: [{ kind: "max_words", field: "note", n: 50 }],
        },
      },
    } as unknown as Partial<WedgeManifest>),
  );
  assert.ok(withMoney.findings.some((f) => f.rule === "numbers-unchecked"));
});

test("a percentage counts as arithmetic, so ratio_of closes the gap it was added for", () => {
  // geo-monitor's weekly_report stated share_of_voice_pct, mentions and queries with nothing
  // comparing them. The grader is what found it, and `ratio_of` is what answers it.
  const g = gradeDeliverables(
    wedge({
      task_types: {
        report: {
          output_schema: {
            required: ["share_of_voice_pct"],
            properties: { share_of_voice_pct: { type: "number" }, mentions: { type: "integer" }, queries: { type: "integer" } },
          },
          input_schema: { properties: { client: {} } },
          ship_requires: ["share_of_voice_pct"],
          ship_checks: [
            { kind: "ratio_of", numerator: "mentions", denominator: "queries", pct: "share_of_voice_pct" },
            { kind: "not_when", field: "share_of_voice_pct", unknown_when: "nothing_measured" },
          ],
        },
      },
    } as unknown as Partial<WedgeManifest>),
  );
  assert.ok(!g.findings.some((f) => f.rule === "numbers-unchecked"), g.findings.map((f) => f.rule).join(", "));
});

test("an output nothing requires is blocking, because an empty one validates", () => {
  const g = gradeDeliverables(
    wedge({ task_types: { do_the_work: { output_schema: { properties: {} } } } } as unknown as Partial<WedgeManifest>),
  );
  const f = g.findings.find((x) => x.rule === "no-output-contract")!;
  assert.equal(f.severity, "blocking");
  assert.match(f.because!, /the client gets a blank/);
  assert.match(g.verdict, /Not ready for a client/);
});

test("every finding carries the failure that made it a rule", () => {
  /**
   * A quality bar nobody can trace the reason for is one that gets argued away the first time it is
   * inconvenient. And a founder reading "nothing checks the numbers" deserves to know the
   * alternative is a client finding a £340 contradiction in a paid month-end close.
   */
  const g = gradeDeliverables(
    wedge({ task_types: { do_the_work: { output_schema: { required: ["x"], properties: { x: {} } } } } } as unknown as Partial<WedgeManifest>),
  );
  assert.ok(g.findings.length > 0);
  for (const f of g.findings) {
    assert.ok(f.because?.trim(), `${f.rule} has no incident behind it`);
    assert.ok(f.fix.trim(), `${f.rule} is a complaint, not a finding`);
    assert.ok(!/^[a-z_]+$/.test(f.says), `${f.rule} says a field name rather than a sentence`);
  }
});

test("the missing exemplar is the founder's action, not a defect in the service", () => {
  /**
   * The first wording read "nothing here shows how good the work has to be", which sounds like
   * something wrong with what was just written for them. It is not.
   *
   * `exemplarSkills` mounts an example the founder uploaded at onboarding, keyed to the PROJECT
   * rather than the wedge, so it reaches every trade they run including this one — and runtime.ts
   * says the quiet part in its own comment: most accounts never reach that screen, so the path
   * mounts nothing and the run is back to prose rules with no demonstration.
   *
   * So the finding names a thirty-second action with the highest signal available to them, and the
   * count passed in is the PROJECT's rather than a listing of this wedge's own directory — which
   * would send a founder who has already uploaded one to go and do it again.
   */
  const g = gradeDeliverables(wedge(), { exemplars: 0 });
  const f = g.findings.find((x) => x.rule === "no-exemplar")!;
  assert.equal(f.severity, "note");
  assert.match(f.fix, /Upload one deliverable you have already sent a client/);
  assert.match(f.fix, /not just this service/, "it is the bar for every trade they run");
  // A generated example would be the model grading itself against its own idea of good.
  assert.match(f.because!, /model grading itself/);
  assert.ok(!gradeDeliverables(wedge(), { exemplars: 1 }).findings.some((x) => x.rule === "no-exemplar"));
});

test("a clean service says so plainly", () => {
  const g = gradeDeliverables(
    wedge({
      task_types: {
        do_the_work: {
          output_schema: {
            required: ["client_summary", "lines"],
            properties: { client_summary: { type: "string" }, lines: { type: "array" }, total_minor: { type: "integer" } },
          },
          input_schema: { properties: { period: {} } },
          ship_requires: ["client_summary"],
          ship_checks: [
            { kind: "sums_to", items: "lines", each: "charge_minor", total: "total_minor" },
            { kind: "each_has", items: "lines", field: "said" },
            { kind: "not_when", field: "total_minor", unknown_when: "incomplete" },
          ],
        },
      },
    } as unknown as Partial<WedgeManifest>),
    { exemplars: 1 },
  );
  assert.equal(g.blocking, 0);
  assert.equal(g.weak, 0, g.findings.map((f) => f.rule).join(", "));
  assert.match(g.verdict, /checked before a client sees it/);
});

test("an authored service hands over a document even when it never says so", () => {
  /**
   * `kickoff.ts`'s `fulfillmentOf` defaults an authored wedge with no `fulfillment` block to
   * `["document"]`, with a comment saying exactly why: "otherwise the run goes green and
   * Deliverables stay empty." Nothing in the authoring path writes that block — `wedgeauthor.ts`
   * never mentions `fulfillment`, and the authoring contract skill never mentions
   * `deliverable_kind` — so every generated service relies on that default.
   *
   * Without mirroring it, this grader would tell a founder their new service delivers nothing, at
   * the exact moment they are deciding whether to trust it, about the one thing it definitely does.
   */
  const authored = {
    wedge: "drafted:studio",
    task_types: {
      draft_scope: {
        output_schema: { required: ["scope"], properties: { scope: { type: "string" } } },
        ship_requires: ["scope"],
        ship_checks: [{ kind: "not_when", field: "price_minor", unknown_when: "unpriced" }],
        input_schema: { properties: { ask: {} } },
      },
    },
    capabilities: ["send_email"],
  } as unknown as WedgeManifest;
  const g = gradeDeliverables(authored, { exemplars: 0 });
  assert.ok(!g.findings.some((f) => f.rule === "delivers-nothing"), g.findings.map((f) => f.rule).join(", "));

  // A HAND-WRITTEN wedge gets no such default — `fulfillmentOf` returns undefined for it, so a
  // missing block there really does mean nothing reaches the client.
  const handWritten = { ...authored, wedge: "studio" } as unknown as WedgeManifest;
  assert.ok(gradeDeliverables(handWritten).findings.some((f) => f.rule === "delivers-nothing"));
});

test("blocking is `nothing stops a blank`, and needs BOTH gates missing", () => {
  /**
   * The first version fired on a missing `output_schema.required` alone, which is stricter than the
   * machinery: `isObjectSchema` demands `properties` and not `required`, and
   * `repairAuthoredManifest` infers `ship_requires` from the schema. A draft with inferred requires
   * and no `required` is protected, and blocking it would have refused most of what the generator
   * legitimately produces.
   */
  const base = {
    wedge: "drafted:x",
    task_types: { job: { output_schema: { properties: { a: { type: "string" } } } } },
    capabilities: ["send_email"],
  } as unknown as WedgeManifest;

  /**
   * BY RULE, NOT BY COUNT. This asserted `blocking === 1`, which made it a test of how many blocking
   * rules exist rather than of the one it is about — it broke the day `cannot-transact` was added,
   * having found nothing wrong. A count is the wrong assertion for a rule-specific test.
   */
  assert.ok(
    gradeDeliverables(base).findings.some((f) => f.rule === "no-output-contract"),
    "neither gate: an empty object validates and ships",
  );

  const withRequires = {
    ...base,
    task_types: { job: { output_schema: { properties: { a: {} } }, ship_requires: ["a"] } },
  } as unknown as WedgeManifest;
  assert.ok(
    !gradeDeliverables(withRequires).findings.some((f) => f.rule === "no-output-contract"),
    "ship_requires alone is a real gate",
  );
  assert.ok(gradeDeliverables(withRequires).findings.some((f) => f.rule === "unchecked-output"));
});

test("a written service lands on the shape built for client work, not the one nobody thought about", async () => {
  /**
   * ═══ EVERY GENERATED TRADE RAN ON THE WORST-CONSIDERED HARNESS IN THE SYSTEM ═══
   *
   * `repairAuthoredManifest` strips a top-level `harness`, and most generated task types declare
   * none of their own — so every trade the kernel wrote fell through to `general`: ten minutes, two
   * dollars, and the shape its own comment in harness.ts calls "the shape that nobody has thought
   * about".
   *
   * `deliver` exists for exactly this: "THE WORK A CLIENT PAYS FOR", thirty minutes,
   * `strict_output`, budgets sized for a document somebody is invoiced for. Hand-written wedges were
   * moved onto it and the generated ones were left behind — backwards, because the hand-written ones
   * have an author who would notice.
   *
   * Not a widening: `general` grants actions and so does `deliver`. What limits a written service is
   * `sanitiseAuthoredPolicy`, untouched.
   */
  const { resolveHarnessProfile } = await import("../src/harness");
  const shapeFor = (wedge: string) =>
    resolveHarnessProfile({
      task: { task_type: "do_the_work", wedge },
      wedge: { manifest: { wedge, task_types: { do_the_work: {} } } },
      ceilings: { maxRuntimeS: 3600, maxCostUsd: 50 },
    } as never).shape;

  assert.equal(shapeFor("drafted:studio"), "deliver", "a written service gets the deliverable shape");
  assert.equal(shapeFor("books-keeper"), "general", "a hand-written wedge is unchanged — it has an author");
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * A SERVICE THAT CAN THINK AND CANNOT TRADE
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * FOUND IN PRODUCTION. `drafted:brand-and-website-projects` was authored from a founder's own
 * description of their design studio, promoted on 14 August, and ran five times. Four task types
 * with real input and output schemas, a `waits_for` correctly gating visual work behind a client
 * review, eight intake questions — genuinely good output from the generator.
 *
 * And NO `fulfillment` BLOCK AT ALL, so: kickoff raised no asks, no money plan existed to invoice,
 * ignition found no `production_task_type` and never started production. Five runs, no deliverable,
 * $0.23. It graded clean at the time.
 *
 * The root cause was upstream — `draft_service`'s output schema did not list `fulfillment` among a
 * manifest's properties, so the model was never asked for it. Fixed there. This is the gate that
 * stops one reaching a client anyway, because schemas change and drafts written before they did
 * still exist.
 */
test("the structural half of fulfillment is derived, not demanded", () => {
  /**
   * The first version of this made a missing `fulfillment` BLOCKING, and that was a gate with no
   * door: there is no route that edits a draft, only promote and reject. A founder reading "add a
   * fulfillment block" had no way to add one.
   *
   * `repairAuthoredManifest` derives the half that is derivable — `production_task_type` and
   * `deliverable_shapes` are facts about the task types already present. What is left is the half
   * nobody can derive, and that is a weak finding rather than a refusal.
   */
  const repaired: Record<string, unknown> = {
    wedge: "drafted:brand-and-website-projects",
    title: "Brand and website projects",
    task_types: {
      shape_brand_strategy: {
        description: "Turn positioning into a brand strategy.",
        output_schema: { type: "object", properties: { strategy: { type: "string" } }, required: ["strategy"] },
      },
    },
  };
  repairAuthoredManifest(repaired);
  const f = repaired.fulfillment as Record<string, unknown> | undefined;
  assert.ok(f, "the repair pass left the manifest unable to transact");
  assert.equal(f.production_task_type, "shape_brand_strategy", "nothing will ever start production");
  assert.deepEqual(f.deliverable_shapes, ["document"]);

  const g = gradeDeliverables(repaired as unknown as WedgeManifest, { exemplars: 0 });
  assert.equal(g.blocking, 0, "a service that can now transact is still being refused");
});

test("what cannot be derived is named, and never invented", () => {
  /**
   * `money_plan` is the founder's pricing and `intake_asks` is trade knowledge. A plausible invented
   * number on an invoice is the one nobody thinks to check, so neither is guessed — they are left
   * blank and the grade says so.
   */
  const repaired: Record<string, unknown> = {
    wedge: "drafted:x",
    title: "X",
    task_types: { job: { output_schema: { properties: { a: {} }, required: ["a"] } } },
  };
  repairAuthoredManifest(repaired);
  const f = repaired.fulfillment as Record<string, unknown>;
  assert.equal(f.money_plan, undefined, "a price was invented for somebody's business");
  assert.deepEqual(f.intake_asks, [], "asks were invented and put in a client's mouth");

  const g = gradeDeliverables(repaired as unknown as WedgeManifest, { exemplars: 0 });
  const money = g.findings.find((x) => x.rule === "no-money-plan");
  assert.ok(money, "nothing tells the founder no invoice will ever be drafted");
  assert.equal(money.severity, "weak", "a missing price must not stop the work reaching the client");
});

test("a declared money plan clears the finding", () => {
  const trader = {
    wedge: "drafted:brand-and-website-projects",
    title: "Brand and website projects",
    task_types: {
      shape_brand_strategy: {
        description: "Turn positioning into a brand strategy.",
        output_schema: { type: "object", properties: { strategy: { type: "string" } }, required: ["strategy"] },
      },
    },
    fulfillment: {
      intake_asks: [{ kind: "answer", ask: "Who are you selling to?" }],
      money_plan: { currency: "USD", lines: [{ label: "Monthly", amount_minor: 90000, kind: "retainer" }] },
      deliverable_shapes: ["document"],
      production_task_type: "shape_brand_strategy",
    },
  } as unknown as WedgeManifest;

  assert.ok(!gradeDeliverables(trader).findings.some((x) => x.rule === "no-money-plan"));
});

test("a HAND-WRITTEN wedge is not held to the money-plan rule", () => {
  /**
   * The thirteen shipped wedges are read from disk and reviewed by us; several are machinery that
   * hands a client nothing on purpose. This rule is about the generator's output, where nobody has
   * read the manifest before it goes live.
   */
  const shipped = {
    wedge: "invoice-chaser",
    title: "Invoice chaser",
    task_types: { chase: { output_schema: { properties: { sent: {} }, required: ["sent"] } } },
  } as unknown as WedgeManifest;
  assert.ok(!gradeDeliverables(shipped).findings.some((x) => x.rule === "no-money-plan"));
});
