/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * THE GRADE IS READ BY A FOUNDER, SO IT HAS TO BE WRITTEN IN THEIR WORDS
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `gradeDeliverables` produces the only sentence a founder ever reads about a service written for
 * their business. On 14 September it was reaching them looking like this:
 *
 *     [weak] "generate_monthly_invoices" puts numbers in front of a client and nothing checks them
 *            against each other.
 *     fix  : Add `sums_to` for a total against its lines, `ratio_of` for a percentage against the
 *            two counts it comes from, `nets_to` ... or `minor_units` ...
 *
 * Two different failures in four lines, and only one of them is cosmetic.
 *
 * THE NAME. `generate_monthly_invoices` is a task-type slug — our key for a row, quoted back to a
 * dental practice as though it were the name of their own work. The founder never chose it and it
 * is not what they call the thing.
 *
 * THE FIX. It is correct, and it is written for us. `sums_to` is a `ship_checks` operator; the
 * remedy is an edit to a manifest the founder has no editor for and no reason to know exists.
 * Putting it on their screen is the product describing its own repair in its own vocabulary and
 * calling that transparency — which is UX rule 1, the product handing its job to the person paying
 * for it. The finding itself still belongs there: they are being asked to accept a service that
 * cannot check its own numbers and they are entitled to know. The instruction is not theirs.
 *
 * So `Finding.audience` marks the ones a founder can actually act on, and the card renders `fix`
 * only for those. This test guards both halves: that the always-rendered field never carries
 * machine vocabulary, and that a fix which does is never labelled founder-facing.
 *
 * ═══ WHY THIS IS A PROPERTY OVER REAL MANIFESTS, NOT A STRING TEST ═══
 *
 * Every `says` is a template. The machine vocabulary does not arrive as a literal in the source —
 * it arrives interpolated, from a slug in the manifest being graded. Asserting on the source of
 * `deliverable-grade.ts` would read clean while the rendered sentence said `line_items`. So this
 * grades everything we actually ship and inspects what came out.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gradeDeliverables, type Finding } from "../src/deliverable-grade";

const WEDGES = join(import.meta.dirname, "..", "..", "wedges");
const manifests = readdirSync(WEDGES)
  .filter((d) => !d.startsWith("."))
  .flatMap((slug) => {
    try {
      return [[slug, JSON.parse(readFileSync(join(WEDGES, slug, "wedge.json"), "utf8"))] as const];
    } catch {
      return [];
    }
  });

/**
 * A manifest built to trip every rule at once, because the catalogue is healthy by design and a
 * property over healthy input proves very little. Ten services shipping clean is the goal; it also
 * means the catalogue alone exercises almost none of these sentences.
 */
const SICK = {
  wedge: "drafted:test-clinic",
  title: "Test clinic",
  task_types: {
    generate_monthly_invoices: {
      title: "Monthly invoices",
      client_facing: true,
      deliverable_kind: "document",
      output_schema: {
        type: "object",
        required: ["line_items", "total_amount"],
        properties: {
          // Items carry their own properties because `claims-without-evidence` only fires on a list
          // that COULD name a source: an array of strings has no field for `each_has` to point at,
          // and 24 of the 30 lists in production were exactly that.
          line_items: {
            type: "array",
            items: {
              type: "object",
              properties: { amount_minor: { type: "integer" }, description: { type: "string" } },
            },
          },
          total_amount: { type: "number" },
        },
      },
    },
    write_treatment_summary: {
      client_facing: true,
      deliverable_kind: "document",
      output_schema: {
        type: "object",
        required: ["findings_list"],
        properties: {
          findings_list: {
            type: "array",
            items: { type: "object", properties: { finding: { type: "string" }, severity: { type: "string" } } },
          },
        },
      },
    },
    chase_unpaid_balances: { client_facing: true, deliverable_kind: "document" },
  },
  fulfillment: {
    client_connections: [{ toolkit: "dentally_practice_manager", capability: "read_invoices" }],
  },
} as unknown as Parameters<typeof gradeDeliverables>[0];

/** Graded the way the review screen grades it: no exemplar uploaded, catalogue readable. */
const sick = () =>
  gradeDeliverables(SICK, { exemplars: 0, knownToolkits: new Set(["gmail", "stripe", "xero"]) });

const findingsEverywhere = (): Finding[] => [
  ...manifests.flatMap(([, m]) => gradeDeliverables(m).findings),
  ...sick().findings,
];

/**
 * What "machine vocabulary" is, concretely, rather than by feel.
 *
 *   · a backtick — in this codebase it is only ever used to quote an identifier
 *   · snake_case — `line_items`, `ship_requires`, `client_facing`. Two words joined by an
 *     underscore is never something a person says out loud.
 *   · our own nouns for our own parts, which read as English and are not
 *
 * `deliverable` is deliberately absent: a founder does say "deliverable", and it is the word on the
 * screen everywhere else.
 */
const BACKTICK = /`/;
const SNAKE = /\b[a-z][a-z0-9]*_[a-z0-9_]+\b/;
const OUR_NOUNS = /\b(manifest|task type|wedge|schema|operator|toolkit slug|json)\b/i;

const offends = (s: string): string | null => {
  if (BACKTICK.test(s)) return "quotes an identifier in backticks";
  const snake = SNAKE.exec(s);
  if (snake) return `carries the slug "${snake[0]}"`;
  const noun = OUR_NOUNS.exec(s);
  if (noun) return `uses our word "${noun[0]}"`;
  return null;
};

test("THE SENTENCE A FOUNDER ALWAYS SEES IS IN A FOUNDER'S WORDS", () => {
  // `says` renders unconditionally, for every finding, at every severity. It has no audience to
  // hide behind.
  const bad: string[] = [];
  for (const f of findingsEverywhere()) {
    const why = offends(f.says);
    if (why) bad.push(`${f.rule} ${why}:\n      ${f.says}`);
  }
  assert.deepEqual(bad, [], `machine vocabulary reached the founder:\n    ${bad.join("\n    ")}`);
});

test("A FIX WRITTEN FOR US IS NEVER LABELLED AS THEIRS", () => {
  /*
    The failure this prevents is not a bad sentence — it is a bad LABEL. Marking a finding
    `audience: "founder"` is what puts its fix on the screen, so a fix that says "add `sums_to`"
    with that label is worse than one without it: the card would render it and be right to.
  */
  const bad: string[] = [];
  for (const f of findingsEverywhere()) {
    if (f.audience !== "founder") continue;
    const why = offends(f.fix);
    if (why) bad.push(`${f.rule} is founder-facing and its fix ${why}:\n      ${f.fix}`);
  }
  assert.deepEqual(bad, [], `an engineer's instruction is addressed to a founder:\n    ${bad.join("\n    ")}`);
});

test("the founder-facing fixes are each something a founder can do today", () => {
  /**
   * The positive half. A rule with no `audience` is silent on the card, which is the safe default
   * and also a place to hide: mark nothing and this file is green forever. So the three that ARE
   * theirs are named, and dropping one is a failure.
   *
   * Each is an action available on a screen they are already on: a price, a connection or intake
   * question, an upload.
   */
  const theirs = new Set(
    sick().findings.filter((f) => f.audience === "founder").map((f) => f.rule),
  );
  for (const rule of ["no-money-plan", "needs-nothing", "no-exemplar"]) {
    assert.ok(theirs.has(rule), `${rule} stopped being addressed to the founder`);
  }
});

test("the sick manifest is sick, or the two guards above proved nothing", () => {
  // A property test over input that trips no rules passes by vacancy. This is the assertion that
  // the fixture still produces the sentences the other tests inspect.
  const g = sick();
  assert.ok(g.findings.length >= 6, `the fixture stopped tripping rules: ${g.findings.length} findings`);
  const rules = new Set(g.findings.map((f) => f.rule));
  for (const r of ["numbers-unchecked", "claims-without-evidence", "unknown-toolkit"]) {
    assert.ok(rules.has(r), `${r} no longer fires on the fixture, so its sentence is unchecked`);
  }
});
