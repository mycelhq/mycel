/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * £3,400 ARRIVED AND NOTHING COULD SAY WHICH SERVICE EARNED IT
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Measured in production, 12 September: 31 of 35 invoices carry no `case_id`. All 21 deliverables
 * carry one, so the chain work → engagement holds and breaks at exactly one hop — the console's
 * invoice form(), where the field was optional, last, and defaulted to "No case".
 *
 * The cost is the product's central claim. A real customer has collected £3,400 and no surface can
 * attribute a penny of it: the per-service impact panel reads zero, "which of my services makes me
 * money" has no answer, and the money plan cannot tell a delivered engagement from an unbilled one.
 *
 * ═══ THE DEFAULT NEEDS A FLOOR, AND THIS IS IT ═══
 *
 * The fix in the console is a DEFAULT, not a requirement: deposits, expenses and late fees are real
 * invoices that bill no engagement, and forcing the link would make somebody attach a real invoice
 * to the wrong job to get past a form.
 *
 * Which is precisely why the kernel now checks the pairing. Before today `case_id` was passed
 * through with only the CLIENT validated, so an invoice could be filed against another customer's
 * job in the same business. That was survivable while the field was almost never set. It is not
 * survivable now that the product fills it in by itself — and the failure is silent, because a
 * misattributed invoice looks exactly like a correct one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { inMonorepo, ONLY_IN_MONOREPO } from "./_monorepo";

const routes = readFileSync(new URL("../src/invoices.routes.ts", import.meta.url), "utf8");
/*
  LAZY, because `skip` cannot save a module-level read.

  This was a top-level `readFileSync` of a file in `cloud/`, which the published kernel does not
  ship. Marking the tests that use it `{ skip: ... }` did nothing: node:test evaluates the module
  before it reads a test's options, so the ENOENT threw first and the whole FILE failed — reported as
  `# skipped 0`, which is the tell. A stranger's `npm test` went red two lines under the README's
  "green. no keys, no Docker, no Postgres."
*/
const form = () => readFileSync(new URL("../../../cloud/app/(app)/invoices/new-invoice.tsx", import.meta.url), "utf8");
const strip = (s: string) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/^\s*\/\/.*$/gm, "");

test("AN INVOICE CANNOT BE FILED AGAINST ANOTHER CLIENT'S JOB", () => {
  const src = strip(routes);
  assert.match(src, /const caseId = typeof b\.case_id === "string" && b\.case_id \? b\.case_id : undefined;/);
  // All three halves: the case exists, it is in this tenant, and it belongs to the client being billed.
  assert.match(src, /kase\.project_id !== projectId/, "an invoice can name a case in another business");
  assert.match(src, /kase\.client_id !== clientId/, "an invoice can name another customer's job");
  assert.match(src, /!kase \|\|/, "a case id that does not exist is accepted");
  assert.match(src, /code: "case\.mismatch"/, "the refusal has no code for the console to read");
});

test("the check runs BEFORE the invoice is created", () => {
  /**
   * A validation after the write leaves the bad row behind and returns an error, which is the worst
   * of both: the founder sees a failure and the misattributed invoice exists anyway.
   */
  const src = strip(routes);
  const check = src.indexOf("code: \"case.mismatch\"");
  const create = src.indexOf("await billing().createInvoice({");
  assert.ok(check > 0 && create > 0, "one of the two anchors moved");
  assert.ok(check < create, "the pairing is checked after the invoice has already been written");
});

test("THE FORM FILLS IT IN, BECAUSE NOBODY EVER DID", { skip: inMonorepo() ? false : ONLY_IN_MONOREPO }, () => {
  const src = strip(form());
  assert.match(src, /setCaseId\(openCases\[0\]\?\.id \?\? ""\)/, "the engagement is not defaulted at all");
  // Most recently active first — with several open, that is the one they were just working in.
  assert.match(src, /\.sort\(\(a, b\) => \(b\.updated_at \?\? ""\)\.localeCompare\(a\.updated_at \?\? ""\)\)/);
});

test("changing the client CLEARS the engagement", { skip: inMonorepo() ? false : ONLY_IN_MONOREPO }, () => {
  /**
   * The dangerous half of a default. Without the clear, switching client leaves the previous
   * client's engagement id in state and the kernel — before today — would have accepted it. Two
   * defects lining up to produce a silent cross-client misattribution.
   */
  const src = strip(form());
  const effect = src.slice(src.indexOf("useEffect(() => {"));
  const body = effect.slice(0, effect.indexOf("}, [clientId])"));
  assert.match(body, /if \(!clientId\) \{[\s\S]*?setCaseId\(""\);[\s\S]*?return;/, "no client still preselects a job");
  assert.match(effect, /\}, \[clientId\]\)/, "the default does not re-run when the client changes");
});

test("and it stays optional, in the founder's words", { skip: inMonorepo() ? false : ONLY_IN_MONOREPO }, () => {
  /**
   * Deposits, expenses and late fees bill no engagement. Forcing the link would make somebody file a
   * real invoice against the wrong job to get past a form(), and a wrong attribution is worse than a
   * missing one — same number, silently misfiled.
   */
  const src = strip(form());
  assert.match(src, /Not tied to a job/, "the escape hatch is gone or is named after our schema");
  assert.ok(!/label="Case"/.test(src), 'the field is still labelled with our word, "Case"');
  assert.match(src, /label="What this bills"/, "the field does not say what it is for");
});
