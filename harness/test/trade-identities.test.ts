// The relations a trade's own deliverable has to satisfy, learned rather than hard-coded.
//
// `infer-checks.ts` recovers gates from the SHAPE of a schema — a list of figures beside a matching
// total is `sums_to`, which is a join rather than a judgement. What it cannot recover is anything the
// schema does not already imply, and the most valuable relations live in the TRADE:
//
//   presented + rejected + shortlisted = screened
//   hours × rate, less the deposit, is the balance
//   share of voice is mentions over queries
//
// None is derivable from property names. All are the first thing a practitioner would tell you.
import { test } from "node:test";
import assert from "node:assert/strict";
import { identitiesAsSkill, identitiesToChecks, type TradeIdentity } from "../src/trade-identities";

const schema = {
  type: "object",
  properties: {
    lines: { type: "array", items: { type: "object", properties: { charge_minor: { type: "integer" } } } },
    total_minor: { type: "integer" },
    deposit_minor: { type: "integer" },
    balance_minor: { type: "integer" },
    screened: { type: "integer" },
    shortlisted: { type: "integer" },
    hit_rate_pct: { type: "number" },
    unpriced: { type: "boolean" },
  },
};

const id = (over: Partial<TradeIdentity>): TradeIdentity =>
  ({ says: "s", shape: "sum_of_list", fields: {}, source: "https://x.test", ...over }) as TradeIdentity;

test("each shape maps to the check that enforces it, and the model never names a kind", () => {
  /**
   * The research reports a SHAPE — "a total of a list", "one figure less another" — and the mapping
   * to `kind` is in code. `ship_checks` is a closed vocabulary parsed by `readShipChecks`, so a
   * model inventing `kind: "looks_right"` produces a check silently dropped at load: a gate that
   * reports as present and does nothing, which is worse than no gate because somebody stops looking.
   */
  const checks = identitiesToChecks(
    [
      id({ shape: "sum_of_list", fields: { items: "lines", each: "charge_minor", total: "total_minor" } }),
      id({ shape: "difference", fields: { minuend: "total_minor", subtrahend: "deposit_minor", total: "balance_minor" } }),
      id({ shape: "ratio", fields: { numerator: "shortlisted", denominator: "screened", pct: "hit_rate_pct" } }),
      id({ shape: "count_of_list", fields: { items: "lines", total: "x", field: "screened" } }),
      id({ shape: "unknowable", fields: { field: "total_minor", unknown_when: "unpriced" } }),
    ],
    schema,
  );
  assert.deepEqual(checks, [
    { kind: "sums_to", items: "lines", each: "charge_minor", total: "total_minor" },
    { kind: "nets_to", minuend: "total_minor", subtrahend: "deposit_minor", total: "balance_minor" },
    { kind: "ratio_of", numerator: "shortlisted", denominator: "screened", pct: "hit_rate_pct" },
    { kind: "counts", items: "lines", field: "screened" },
    { kind: "not_when", field: "total_minor", unknown_when: "unpriced" },
  ]);
});

test("a field the schema does not declare drops the whole identity", () => {
  /**
   * THE SAFETY OF THE WHOLE THING.
   *
   * The research learned the trade; it did NOT write the output schema, so it is guessing at names.
   * A `sums_to` pointing at `line_items` when the schema says `lines` never fires — silently, for
   * ever — and the service ships believing it is gated. Better four checks that certainly fire than
   * eleven that mostly do.
   */
  assert.deepEqual(
    identitiesToChecks(
      [id({ shape: "sum_of_list", fields: { items: "line_items", each: "charge_minor", total: "total_minor" } })],
      schema,
    ),
    [],
  );
  // Partially resolvable is still dropped: two of three fields is not two-thirds of a gate.
  assert.deepEqual(
    identitiesToChecks([id({ shape: "difference", fields: { minuend: "total_minor", total: "balance_minor" } })], schema),
    [],
  );
});

test("a field on the entries of a list resolves, because that is where `each` lives", () => {
  // `sums_to.each` names a field on the ENTRIES — `lines[].charge_minor` is written `charge_minor`.
  // Without walking one level into `items.properties`, the most valuable check in the vocabulary
  // could never map, and every learned sum would be dropped.
  const checks = identitiesToChecks(
    [id({ shape: "sum_of_list", fields: { items: "lines", each: "charge_minor", total: "total_minor" } })],
    schema,
  );
  assert.equal(checks.length, 1);
});

test("the same relation learned twice is one gate", () => {
  // Research reads several sources and two will state the same identity in different words. Two
  // identical checks fail a deliverable once and report it twice, which reads to a founder like two
  // separate problems with their work.
  const one = { shape: "sum_of_list" as const, fields: { items: "lines", each: "charge_minor", total: "total_minor" } };
  assert.equal(identitiesToChecks([id({ ...one, says: "a" }), id({ ...one, says: "b" })], schema).length, 1);
});

test("an unknown shape is dropped in silence, like a malformed check", () => {
  assert.deepEqual(identitiesToChecks([id({ shape: "vibes" as never, fields: { total: "total_minor" } })], schema), []);
  assert.deepEqual(identitiesToChecks([null as never, undefined as never], schema), []);
  assert.deepEqual(identitiesToChecks([id({})], undefined), []);
});

test("an identity that cannot be enforced still reaches the run as instruction", () => {
  /**
   * A relation naming a field the schema does not have is still TRUE about the trade — it just
   * cannot be gated. Dropping it entirely throws away the most valuable thing the research found, so
   * it goes where a practitioner would put it: in what the run reads before it starts.
   */
  const skill = identitiesAsSkill([
    id({ says: "Presented plus rejected plus shortlisted equals screened." }),
    id({ says: "The balance is hours times rate, less the deposit." }),
  ])!;
  assert.match(skill, /Presented plus rejected/);
  assert.match(skill, /less the deposit/);
  assert.match(skill, /reported as reconciled/);
  assert.equal(identitiesAsSkill([]), undefined);
  assert.equal(identitiesAsSkill([id({ says: "   " })]), undefined);
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// THE CHAIN, END TO END
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//
// Three of the bugs found this week were the same shape: a thing declared and nothing wiring it.
// Input contracts nothing read. Two browser options with no supplier. A skill named by a task type
// that never mounted. So this asserts the whole path rather than each end of it — research
// identities in, `ship_checks` out of `authorWedgeFromOutput`.

test("a learned identity becomes a gate on the generated service", async () => {
  const { authorWedgeFromOutput } = await import("../src/wedgeauthor");
  const out = authorWedgeFromOutput(
    {
      manifest: {
        title: "Recruiting longlists",
        task_types: {
          screen_longlist: {
            description: "Screen a longlist against the brief and hand back who is worth a call.",
            output_schema: {
              type: "object",
              required: ["screened", "shortlisted", "hit_rate_pct"],
              properties: {
                screened: { type: "integer" },
                shortlisted: { type: "integer" },
                hit_rate_pct: { type: "number" },
              },
            },
          },
        },
        capabilities: ["send_email"],
        cases: { stages: ["briefed", "screened", "presented"], initial: "briefed" },
      },
      skills: [],
    },
    {
      slugBase: "Recruiting longlists",
      identities: [
        {
          says: "The hit rate is the shortlist over everyone screened.",
          shape: "ratio",
          fields: { numerator: "shortlisted", denominator: "screened", pct: "hit_rate_pct" },
          source: "https://example.test/recruiting",
        },
        // Names a field this schema does not declare. Must not reach the manifest.
        {
          says: "Fees are the placement salary times the percentage agreed.",
          shape: "sum_of_list",
          fields: { items: "placements", each: "fee_minor", total: "invoice_total_minor" },
          source: "https://example.test/fees",
        },
      ],
    },
  );

  assert.deepEqual(out.faults, [], out.faults.map((f) => f.message).join("; "));
  const checks = out.draft!.manifest.task_types!.screen_longlist!.ship_checks as { kind: string }[];
  assert.ok(
    checks.some((c) => c.kind === "ratio_of"),
    `no learned gate reached the manifest: ${JSON.stringify(checks)}`,
  );
  // And the unresolvable one did not, silently or otherwise.
  assert.ok(!checks.some((c) => c.kind === "sums_to"), JSON.stringify(checks));
});

test("with no research, a generated service is exactly what it was before", async () => {
  // Identities are additive. A founder who onboards before `research_service` has run — or whose
  // research came back `reached: false` — must get the same service the inference alone produces,
  // not a worse one.
  const { authorWedgeFromOutput } = await import("../src/wedgeauthor");
  const manifest = {
    title: "Studio invoices",
    task_types: {
      prepare_invoice: {
        description: "Turn the month's work into an invoice the client can pay.",
        output_schema: {
          type: "object",
          required: ["lines", "total_minor"],
          properties: {
            lines: { type: "array", items: { type: "object", properties: { charge_minor: { type: "integer" } } } },
            total_minor: { type: "integer" },
          },
        },
      },
    },
    capabilities: ["send_email"],
    cases: { stages: ["open", "sent"], initial: "open" },
  };
  const withNone = authorWedgeFromOutput({ manifest, skills: [] }, { slugBase: "Studio invoices" });
  const withEmpty = authorWedgeFromOutput({ manifest, skills: [] }, { slugBase: "Studio invoices", identities: [] });
  assert.deepEqual(
    withNone.draft!.manifest.task_types!.prepare_invoice!.ship_checks,
    withEmpty.draft!.manifest.task_types!.prepare_invoice!.ship_checks,
  );
  // And inference is still doing its own job — the shape alone implies a total against its lines.
  const inferred = withNone.draft!.manifest.task_types!.prepare_invoice!.ship_checks as { kind: string }[];
  assert.ok(inferred.some((c) => c.kind === "sums_to"), JSON.stringify(inferred));
});

test("what the research learned reaches the run as pages, not just as gates", async () => {
  /**
   * THE FIFTH INSTANCE OF THIS WEEK'S FAVOURITE BUG, AND THE FIRST THAT WAS MINE.
   *
   * `identitiesAsSkill` and `mechanics` were both written, both tested, and read by nothing. A thing
   * that exists, passes its tests, and reaches no run is the failure this codebase produces most —
   * and it is worse here than usual, because what it drops is the only part of the research that
   * could not be turned into a gate.
   *
   * An identity naming a field the schema does not have is still true about the trade. Mechanics
   * were never gateable at all. Both belong where a practitioner would put them: in what the agent
   * reads before it starts.
   */
  const { authorWedgeFromOutput } = await import("../src/wedgeauthor");
  const out = authorWedgeFromOutput(
    {
      manifest: {
        title: "Surveying schedules",
        task_types: {
          price_the_works: {
            description: "Turn a measured schedule into a priced one the client can tender against.",
            output_schema: { type: "object", required: ["total_minor"], properties: { total_minor: { type: "integer" } } },
          },
        },
        capabilities: ["send_email"],
        cases: { stages: ["measured", "priced"], initial: "measured" },
      },
      skills: [],
    },
    {
      slugBase: "Surveying schedules",
      identities: [
        // Deliberately unresolvable: `quantities` is not in the schema, so it cannot become a gate.
        {
          says: "Measured quantities times unit rates is the total.",
          shape: "sum_of_list",
          fields: { items: "quantities", each: "rate_minor", total: "total_minor" },
          source: "https://example.test/nrm",
        },
      ],
      mechanics: [
        { rule: "A rate build-up separates labour, plant and materials.", why: "A single blended rate cannot be negotiated line by line.", source: "https://example.test/nrm2" },
      ],
    },
  );

  assert.deepEqual(out.faults, [], out.faults.map((f) => f.message).join("; "));
  const names = out.draft!.manifest.skills!;
  assert.ok(names.includes("what-has-to-add-up.md"), names.join(", "));
  assert.ok(names.includes("how-this-trade-is-judged.md"), names.join(", "));

  const pages = out.draft!.skills;
  const adds = pages.find((p) => p.name === "what-has-to-add-up.md")!;
  assert.match(adds.content, /Measured quantities times unit rates/);
  // Front matter, or `parseSkillDoc` cannot read it — and a page nothing parses is the same silent
  // nothing this whole block exists to avoid.
  assert.match(adds.content, /^---\nname: what-has-to-add-up\n/);

  const judged = pages.find((p) => p.name === "how-this-trade-is-judged.md")!;
  assert.match(judged.content, /separates labour, plant and materials/);
  assert.match(judged.content, /cannot be negotiated line by line/, "the why is what makes a rule stick");
});

test("a service with no research gets no invented pages", async () => {
  const { authorWedgeFromOutput } = await import("../src/wedgeauthor");
  const out = authorWedgeFromOutput(
    {
      manifest: {
        title: "Plain desk",
        task_types: { do_it: { description: "Do the thing the client asked for.", output_schema: { type: "object", required: ["summary"], properties: { summary: { type: "string" } } } } },
        capabilities: ["send_email"],
        cases: { stages: ["open"], initial: "open" },
      },
      skills: [],
    },
    { slugBase: "Plain desk" },
  );
  assert.ok(!out.draft!.manifest.skills!.some((n) => n.startsWith("what-has-to-add-up")));
  assert.ok(!out.draft!.manifest.skills!.some((n) => n.startsWith("how-this-trade-is-judged")));
});
