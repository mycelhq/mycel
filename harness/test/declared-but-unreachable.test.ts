/**
 * ═══ THE BUG CLASS THIS REPO KEEPS SHIPPING ═══
 *
 * In one night of driving the loop end to end, SIX load-bearing features turned out to be written,
 * correct, unit-tested — and unreachable. Not six unrelated bugs. One shape, six times:
 *
 *   1. `signs: true` on `draft_engagement` — the only such declaration in the product, and the code
 *      reading it sat behind `if (wrapped && …)`, a condition a proposal can never satisfy.
 *   2. The prospect `signal` — accepted by the enrol route, dropped because no type between the
 *      route and the case had a field for it, so the copy never saw the reason to write.
 *   3. `research_service` — browser harness, own skill, sourced output schema, three modules reading
 *      its result, a test asserting its spec. No code path ever created one.
 *   4. `onExecuted` — declared in `SigningRouteDeps` and called at both signature sites. No caller
 *      ever passed one, so a fully executed contract fired nothing.
 *   5. `openProposalEnvelope`'s counterparty gate — required a `client_id` on a document written for
 *      somebody who is by definition not a client yet.
 *   6. `ensureImprovementSchedules` — defined, argued over in its own comment, never called. The
 *      three daily self-review jobs have never run for any project in the product's history.
 *
 * Every one was invisible to the tests because every test covers a PIECE and none crossed a SEAM.
 * They were found by a scenario that walks the whole path, which is expensive, slow, needs a model,
 * and cannot run in CI.
 *
 * ═══ WHAT THIS FILE DOES INSTEAD ═══
 *
 * It reads the source and asks one question of each declaration: does anything reach it?
 *
 * That is a weaker check than "does it work" and a much cheaper one, and it is the check that would
 * have caught all six in milliseconds. A declaration nothing reaches is not a subtle failure — it is
 * a feature that has never executed, and no amount of unit testing around it will say so.
 *
 * ── IT ASSERTS AGAINST A KNOWN LIST, NOT A HEURISTIC ──
 *
 * A general "find all dead code" pass would drown in false positives: exports for tests, exports for
 * future callers, re-exports. This names the specific declarations that MEAN something is wired, and
 * fails when one of them has no reacher. Adding a new one is a deliberate act, which is the point —
 * the list is the record of what this product promises is connected.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dirname, "..", "src");
const WEDGES = join(import.meta.dirname, "..", "..", "wedges");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

const FILES = walk(SRC).filter((f) => !f.includes("graphify-out"));
const SOURCE = FILES.map((f) => ({ path: f, text: readFileSync(f, "utf8") }));

/** Every mention outside the file that declares it, ignoring comments. */
function reachersOf(symbol: string, declaredIn: string): string[] {
  const re = new RegExp(`\\b${symbol}\\b`);
  return SOURCE.filter(({ path, text }) => {
    if (path.endsWith(declaredIn)) return false;
    // Comments explain a thing; they do not call it. Six features were "mentioned" in a dozen
    // comments each and invoked by nothing, which is exactly the state this file exists to catch.
    const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    return re.test(code);
  }).map(({ path }) => path);
}

/**
 * Functions that MEAN "this feature is connected". Each one, when uncalled, is a whole capability
 * that has never executed — not a helper somebody might use later.
 */
const MUST_BE_CALLED: Array<{ fn: string; file: string; because: string }> = [
  {
    fn: "openEngagementFromSignature",
    file: "engagement-open.ts",
    because: "a signed contract would open no engagement and raise no invoice",
  },
  {
    fn: "spawnDraftAfterResearch",
    file: "skill-arsenal.ts",
    because: "the meta-agent would research a trade and never write the service",
  },
  {
    fn: "openProposalEnvelope",
    file: "proposal-envelope.ts",
    because: "a gated proposal would never become something a client can sign",
  },
  {
    fn: "spawnLearningResearch",
    file: "skill-arsenal.ts",
    because:
      "the product would go back to learning what a business offers only for the one founder in " +
      "production whose trade nothing covered — one research record, ever",
  },
  {
    fn: "draftServiceInput",
    file: "offering.ts",
    because: "the deliverables a founder confirmed would never reach the run that writes their service",
  },
  {
    fn: "researchedDeliverables",
    file: "offering.ts",
    because: "the eight things the research found would stay unreadable, which is where they started",
  },
  {
    fn: "keepServiceResearch",
    file: "skill-arsenal.ts",
    because: "what the research found would be thrown away before the draft could read it",
  },
  {
    fn: "sweepFulfillmentIgnition",
    file: "fulfillment-ignite.ts",
    because: "no engagement would ever start producing the work it was signed for",
  },
  {
    fn: "runKickoffPlaybook",
    file: "kickoff.ts",
    because: "a new engagement would raise no intake asks and draft no first invoice",
  },
];

for (const { fn, file, because } of MUST_BE_CALLED) {
  test(`${fn} is reached by something — else ${because}`, () => {
    const reachers = reachersOf(fn, file);
    assert.ok(
      reachers.length > 0,
      `\`${fn}\` is declared in ${file} and nothing outside it calls it.\n` +
        `Consequence: ${because}.\n` +
        `This is the "declared but unreachable" class — see the header of this file for the six that shipped.`,
    );
  });
}

/**
 * Optional hooks on a deps interface are the sneakiest version: the call site exists, the type
 * permits absence, and TypeScript is satisfied forever. `onExecuted` sat like this from the day it
 * was written to the night a contract executed and did nothing.
 */
const OPTIONAL_HOOKS: Array<{ hook: string; file: string; because: string }> = [
  { hook: "onExecuted", file: "signing.routes.ts", because: "a completed signature would fire nothing" },
];

for (const { hook, file, because } of OPTIONAL_HOOKS) {
  test(`the optional hook ${hook} is actually supplied — else ${because}`, () => {
    const suppliers = SOURCE.filter(({ path, text }) => {
      if (path.endsWith(file)) return false;
      const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      // Being PASSED, not merely named: `onExecuted:` in an object literal is a supplier.
      return new RegExp(`\\b${hook}\\s*:`).test(code);
    });
    assert.ok(
      suppliers.length > 0,
      `\`${hook}\` is declared optional in ${file} and no caller supplies one.\n` +
        `Consequence: ${because}.`,
    );
  });
}

/*
 * ═══ A THIRD CHECK WAS TRIED HERE AND REMOVED, WHICH IS WORTH RECORDING ═══
 *
 * It asserted that every declared task type has something that creates one. It flagged twenty-three,
 * then eleven after mirroring the manifest's own selection rules, and every one of the eleven was a
 * FALSE POSITIVE — because `RunWork` on the client page enumerates a wedge's task types at RUNTIME
 * and offers all of them. Reachability there comes from the manifest being read, not from any string
 * a static pass can find, so no amount of tightening makes the check sound.
 *
 * It is deleted rather than skipped or loosened. This repo's own comments name the failure mode: a
 * check people learn to ignore is worse than no check, because it trains them to skim the output of
 * the two above, which are exact and have already caught six things that shipped.
 *
 * The real lesson is narrower and it is in the two checks that remain: what static analysis CAN see
 * is a named function nobody calls and an optional hook nobody supplies. `research_service` was
 * genuinely unreachable and would still be missed here — it took a scenario walking the whole path
 * to find it, and that is the instrument for that class.
 */
