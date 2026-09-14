// A fact about a client belongs to the business, not to the wedge that happened to learn it.
//
// Retrieval used to end at `r.wedge !== ctx.wedge → false`, which made three silos out of one
// company. A service business runs go-to-market, fulfilment and the back office on the SAME
// customers; the kernel modelled them as strangers, so the business asked Dana in finance the same
// question three times and looked to its client like three suppliers who do not talk.
//
// The line is `kind`, which is structural rather than a reading of the prose: a `fact` came from a
// human answering "what VAT scheme are they on?" and is true whoever is asking. `never` / `always`
// / `prefer` are craft — how to word a chase is not how to word a close.
//
// Every test here names a specific way the crossing could go wrong and asserts it does not.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  distillFromAnswer,
  materialize,
  retrieveRules,
  ruleApplies,
  scoreRule,
  type RetrievalContext,
  type Rule,
  type RuleKind,
} from "../src/knowledge";

const AT = "2026-01-01T00:00:00.000Z";

/** The real path a crossing fact arrives by: an agent hit a gap and a human answered it. */
const factLearnedIn = (wedge: string, client_id?: string, task_types: string[] = []): Rule =>
  materialize(
    distillFromAnswer({
      project_id: "p1",
      wedge,
      client_id,
      task_types,
      question_id: "gap:vat-scheme",
      question: "What VAT scheme are they on?",
      answer: "Flat rate, 14.5%",
      at: AT,
    }),
    AT,
  );

const craftLearnedIn = (wedge: string, kind: RuleKind, client_id?: string): Rule => ({
  ...factLearnedIn(wedge, client_id),
  kind,
  subject: "send_email.subject",
  text: "Never email this client after 6pm",
});

const inChase = (over: Partial<RetrievalContext> = {}): RetrievalContext => ({
  project_id: "p1",
  wedge: "invoice-chaser",
  task_type: "chase",
  client_id: "brightline",
  now: AT,
  ...over,
});

test("a fact learned about a client in another wedge reaches this one", () => {
  assert.ok(ruleApplies(factLearnedIn("books-keeper", "brightline"), inChase()));
});

test("craft does not cross — how to word a chase is not how to word a close", () => {
  for (const kind of ["never", "always", "prefer"] as const) {
    assert.equal(
      ruleApplies(craftLearnedIn("books-keeper", kind, "brightline"), inChase()),
      false,
      `${kind} must stay in the wedge that learned it`,
    );
  }
});

test("a house-wide fact does not cross, because nobody made that generalisation", () => {
  // True of the job it came from. Carrying it into outreach is the leak `ruleMayApply` exists to
  // prevent, one level up.
  assert.equal(ruleApplies(factLearnedIn("books-keeper", undefined), inChase({ client_id: undefined })), false);
  assert.equal(ruleApplies(factLearnedIn("books-keeper", undefined), inChase()), false);
});

test("crossing wedges does not cross TENANTS", () => {
  const other = { ...factLearnedIn("books-keeper", "brightline"), project_id: "p2" };
  assert.equal(ruleApplies(other, inChase()), false);
});

test("a superseded fact does not come back by crossing", () => {
  const dead: Rule = { ...factLearnedIn("books-keeper", "brightline"), status: "superseded" };
  assert.equal(ruleApplies(dead, inChase()), false);
});

test("a crossing fact is still one client's — it never reaches another", () => {
  // `ruleMayApply` runs AFTER the wedge check and is the thing that would have to fail for one
  // customer's VAT scheme to turn up in a letter to a different customer.
  const f = factLearnedIn("books-keeper", "brightline");
  assert.equal(ruleApplies(f, inChase({ client_id: "northgate" })), false);
  assert.equal(ruleApplies(f, inChase({ client_id: undefined })), false);
});

test("a task-type filter still applies to a fact that crossed", () => {
  const f = factLearnedIn("books-keeper", "brightline", ["month_end"]);
  assert.equal(ruleApplies(f, inChase({ task_type: "chase" })), false);
  assert.equal(ruleApplies(f, inChase({ task_type: "month_end" })), true);
});

// ── What a borrowed fact is worth once it is in the room ────────────────────

test("a borrowed fact yields to a same-wedge rule it would otherwise outrank", () => {
  // The exact tie −30 is sized for: the borrowed one is scoped to this task type (+25) and the
  // local one is not (+8). The local one must still win, or a fact from bookkeeping takes the last
  // slot from something the chaser learned on a chase.
  const borrowed = factLearnedIn("books-keeper", "brightline", ["chase"]);
  const local = { ...factLearnedIn("invoice-chaser", "brightline"), subject: "gap:po-number" };
  assert.ok(scoreRule(local, inChase()) > scoreRule(borrowed, inChase()));
});

test("a borrowed fact about this client still beats a local fact about nobody", () => {
  const borrowed = factLearnedIn("books-keeper", "brightline");
  const generic = { ...factLearnedIn("invoice-chaser", undefined), subject: "gap:po-number" };
  assert.ok(scoreRule(borrowed, inChase()) > scoreRule(generic, inChase()));
});

test("a borrowed fact does not outrank a local prohibition", () => {
  const borrowed = factLearnedIn("books-keeper", "brightline");
  const prohibition = craftLearnedIn("invoice-chaser", "never", "brightline");
  assert.ok(scoreRule(prohibition, inChase()) > scoreRule(borrowed, inChase()));
});

test("end to end: the chaser's prompt contains what bookkeeping learned", () => {
  const got = retrieveRules(
    [factLearnedIn("books-keeper", "brightline"), craftLearnedIn("books-keeper", "prefer", "brightline")],
    inChase(),
  );
  assert.equal(got.considered, 1, "the fact crossed, the preference did not");
  assert.match(got.markdown, /Flat rate, 14\.5%/);
});
