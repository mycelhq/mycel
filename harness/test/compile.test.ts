// The compiler's own test, from the note that asked for it: "if we have to write an `if (geo)`
// branch to make the work real, we do not have a compiler yet." Nothing in compile.ts knows what a
// share-of-voice percentage, a bank statement or a staging URL is. It knows what a JOB needs in
// order to be worth running.
import { test } from "node:test";
import assert from "node:assert/strict";
import { compile, describe as describeCompile, statesACeiling, type CompileInput } from "../src/compile";

const CRAFT = { name: "monthly-close.md", content: "# Close\n\n## Never\n\n- Never plug a difference." };

const job = (over: Partial<CompileInput> = {}): CompileInput => ({
  task: { task_type: "monthly_close", wedge: "books-keeper", project_id: "p1", case_id: "k1", client_id: "c1" },
  profile: { shape: "decide", strict_output: true, max_runtime_s: 600, max_cost_usd: 1, grants_actions: true },
  outputSchema: { required: ["client_summary", "reconciled"] },
  shipRequires: ["questions"],
  deliverableShapes: ["document"],
  skills: [CRAFT],
  ...over,
});

test("a fully equipped job compiles, and the spec says what it was equipped with", () => {
  const r = compile(job());
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.spec.shape, "decide");
  assert.deepEqual(r.spec.skills, ["monthly-close.md"]);
  assert.deepEqual(r.spec.schemaRequired, ["client_summary", "reconciled"]);
  assert.equal(r.spec.hasHumanCeiling, true);
  assert.equal(r.spec.clientFacing, true);
  assert.match(describeCompile(r), /^compiled: decide job, 1 procedure/);
});

test("NO DEFINITION OF DONE — a strict job that names nothing required", () => {
  // "A run with no definition of done stops when the model stops, which is not the same as
  // finished." Only for strict jobs: a general research run answers in prose and demanding a
  // schema of it would be the compiler inventing policy nobody declared.
  const r = compile(job({ outputSchema: {} }));
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.refusals[0]!.code, "no_definition_of_done");

  const loose = compile(job({ outputSchema: {}, profile: { ...job().profile, strict_output: false } }));
  assert.equal(loose.ok, true, "a non-strict job is not held to a schema it never claimed");
});

test("NO CRAFT — client-facing work with no procedure improvises", () => {
  const r = compile(job({ skills: [] }));
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.refusals[0]!.code, "no_craft");
  assert.match(r.refusals[0]!.message, /reads fine and is wrong/);
});

test("an internal job with no craft WARNS rather than refuses — a tick is not a deliverable", () => {
  const r = compile(job({ skills: [], deliverableShapes: [] }));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.match(r.warnings.join(" "), /fine for an internal tick/);
});

test("NO HUMAN CEILING — enforced for SHIPPED wedges, not just authored ones", () => {
  // wedgeauthor already refuses an authored skill with no Never. The shipped wedges running real
  // engagements were never held to the same bar, which is exactly backwards — those have customers.
  const r = compile(job({ skills: [{ name: "close.md", content: "# Close\n\nDo the ten steps." }] }));
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.refusals[0]!.code, "no_human_ceiling");
  assert.match(r.refusals[0]!.message, /invent a number, send something, or decide for the client/);
});

test("MISSING ACCESS — a declared capability with nothing behind it", () => {
  // Otherwise the run discovers halfway through that it cannot finish, having spent the budget.
  const r = compile(job({ capabilityGaps: ["read_ledger"] }));
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.refusals[0]!.code, "missing_access");
  assert.match(r.refusals[0]!.message, /read_ledger/);
});

test("refusals are COLLECTED, not short-circuited — a founder fixing a wedge wants the whole list", () => {
  const r = compile(job({ skills: [], outputSchema: {}, capabilityGaps: ["read_ledger"] }));
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.deepEqual(
    [...r.refusals.map((x) => x.code)].sort(),
    ["missing_access", "no_craft", "no_definition_of_done"],
  );
});

test("shipping with no bar REFUSES — the warning was never read by anything", () => {
  // This test used to assert the opposite, and the reasoning was sound at the time: refusing would
  // make ship_requires mandatory boilerplate, "which is how a real guard becomes a field everyone
  // fills in with whatever passes".
  //
  // What changed is the population, not the appetite for boilerplate. `clientFacing` was read off
  // the WEDGE, so measurement probes and sync steps counted as shipping and the only way to quiet
  // them was a meaningless bar. `WedgeTaskType.internal` now lets a step declare itself machinery,
  // and with that fixed every client-facing job in the kernel carries a bar derived from its own
  // schema. Meanwhile the warning went nowhere: it was pushed onto `warnings` and the run proceeded,
  // so a job shipping with no bar looked exactly like a job shipping with one.
  const r = compile(job({ shipRequires: [] }));
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.deepEqual(r.refusals.map((x) => x.code), ["ships_without_a_bar"]);
  assert.match(r.refusals[0]!.message, /declares no ship_requires/);
});

test("machinery is not held to a ship bar — nothing it produces is delivered", () => {
  // The other half of the flip. A probe that measures whether a brand was cited is read by the
  // report writer, never by a client; refusing it for lacking a ship bar would stop work that was
  // never at risk, which is exactly why the check could not be a refusal before.
  const r = compile(job({ shipRequires: [], internalTaskType: true }));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(
    r.warnings.some((w) => /ship_requires/.test(w)),
    false,
    "an internal step must not be nagged about a bar it cannot have",
  );
});

test("a single-field output is still exempt — one honest piece of prose has nothing to cross-check", () => {
  const one = job({ shipRequires: [] });
  const r = compile({
    ...one,
    outputSchema: { type: "object", properties: { note: { type: "string" } }, required: ["note"] },
  });
  assert.equal(r.ok, true);
});

test("a ceiling is recognised in all three spellings the shelf actually uses", () => {
  assert.equal(statesACeiling("## Never\n\n- Never plug."), true);
  assert.equal(statesACeiling("**Never** send without the founder."), true);
  assert.equal(statesACeiling("Never invent a citation."), true);
  assert.equal(statesACeiling("- Never chase an unhappy client."), true);
  // The fourth spelling, added after the checker reported a real ceiling as missing:
  // security-questionnaire/answer-one.md ends "...what is missing. Never invent a control."
  assert.equal(statesACeiling("If it is not in knowledge, say so. Never invent a control."), true);
  // A checker that only knows one spelling reports healthy craft as missing, and gets deleted.
  assert.equal(statesACeiling("Do the ten steps carefully."), false);
  assert.equal(statesACeiling("This has never been easy."), false, "prose 'never' is not a ceiling");
});

test("NOTHING IN HERE KNOWS A TRADE — the same input compiles identically under any wedge name", () => {
  const geo = compile(job({ task: { ...job().task, wedge: "geo-monitor", task_type: "weekly_report" } }));
  const web = compile(job({ task: { ...job().task, wedge: "product-builder", task_type: "build_feature" } }));
  assert.equal(geo.ok, web.ok);
  if (!geo.ok || !web.ok) return;
  assert.deepEqual(geo.spec.schemaRequired, web.spec.schemaRequired);
  assert.deepEqual(geo.spec.skills, web.spec.skills);
});

test("a refusal describes itself for the timeline — never a silent absence", () => {
  const r = compile(job({ skills: [] }));
  assert.match(describeCompile(r), /^not equipped to run —/);
});
