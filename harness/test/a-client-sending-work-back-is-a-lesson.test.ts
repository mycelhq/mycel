/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * THE BEST SIGNAL THIS PRODUCT GETS, AND IT WAS BEING THROWN AWAY
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Everything else in `knowledge.ts` learns from a FOUNDER — an edit before a send, a rejection in
 * the approval queue. All of it is a proxy for what the customer wants. A client sending a
 * deliverable back is not a proxy: it is the person paying for the work, looking at the finished
 * article, saying in their own words what is wrong with it.
 *
 * `POST /v1/portal/deliverables/:id/changes` wrote that brief to the version verdict, to the
 * timeline, and into the redraft's input. All three are about THAT deliverable. Nothing carried it
 * forward, so the next one of the same kind for the same client started from nothing and the same
 * complaint could arrive every month while the product called it a feedback loop.
 *
 * Third time the capture has followed the mechanism instead of the decision. See
 * `every-door-learns.test.ts` for the first two.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { distillFromChangeRequest } from "../src/knowledge";

const base = {
  project_id: "p1",
  wedge: "books-keeper",
  task_type: "",
  client_id: "c1",
  deliverable_kind: "report",
};

test("A CLIENT'S OWN WORDS BECOME THE RULE, UNSUMMARISED", () => {
  const r = distillFromChangeRequest({ ...base, request: "Cite the invoice numbers in the summary." })!;
  assert.ok(r, "a change request with a client and a brief produced no lesson");
  assert.match(r.text, /Cite the invoice numbers in the summary\./, "their words were paraphrased away");
  assert.equal(r.wedge, "books-keeper");
  assert.equal(r.client_id, "c1");
});

test("SCOPED TO THE CLIENT WHO ASKED — never a house rule", () => {
  /*
    "Brightline wants Friday summaries" is not a house rule, and applying it to every other customer
    of this business is how a system that learns makes a business worse. `scopeMeta` puts the client
    on the rule; this asserts the caller cannot lose it.
  */
  const r = distillFromChangeRequest({ ...base, request: "Send it on Fridays." })!;
  assert.equal(r.client_id, "c1");
});

test("NO CLIENT, NO LESSON", () => {
  // A rule learned from one customer's taste and stored unscoped reaches all of them.
  assert.equal(distillFromChangeRequest({ ...base, client_id: undefined, request: "Shorter." }), undefined);
  assert.equal(distillFromChangeRequest({ ...base, request: "   " }), undefined);
});

test("A SECOND, DIFFERENT COMPLAINT DOES NOT ERASE THE FIRST", () => {
  /**
   * The failure the subject key exists to prevent, and the one that would have been invisible.
   *
   * `subject` is what makes two rules comparable — same subject and scope means same question, so a
   * later answer supersedes an earlier one. Keying on the deliverable kind alone would mean a client
   * who asks for invoice numbers in March and a shorter summary in April keeps only April: the
   * product forgets a correction the moment it receives a second one, and every symptom of that
   * looks like the model being forgetful rather than like us deleting the evidence.
   */
  const march = distillFromChangeRequest({ ...base, request: "Cite the invoice numbers." })!;
  const april = distillFromChangeRequest({ ...base, request: "Make the summary shorter." })!;
  assert.notEqual(march.subject, april.subject, "two unrelated complaints share a subject — one supersedes the other");
});

test("THE SAME COMPLAINT TWICE IS THE SAME SUBJECT, so it corroborates", () => {
  /*
    The other half, and the reason the key is a slug of their words rather than a counter. A client
    asking for the same thing a second time is the honest measurement of "a rule already covers this
    and the agent is still getting it wrong" — `corrections_since`. Two rules would hide it as two
    unrelated one-offs.

    Stopwords are dropped so politeness does not fork the key, which is the commonest way one
    complaint becomes two rules.
  */
  const a = distillFromChangeRequest({ ...base, request: "Cite the invoice numbers." })!;
  const b = distillFromChangeRequest({ ...base, request: "Please could you cite the invoice numbers?" })!;
  assert.equal(a.subject, b.subject, `"${a.subject}" vs "${b.subject}"`);
});

test("different kinds of work do not share a subject", () => {
  const report = distillFromChangeRequest({ ...base, deliverable_kind: "report", request: "Too long." })!;
  const invoice = distillFromChangeRequest({ ...base, deliverable_kind: "invoice", request: "Too long." })!;
  assert.notEqual(report.subject, invoice.subject);
});

test("the subject is readable, because a human asks why the agent did something", () => {
  // A hash turns "why did it do that" into a database query. This answers it on sight.
  const r = distillFromChangeRequest({ ...base, request: "Cite the invoice numbers in the summary." })!;
  assert.match(r.subject, /^deliverable\.report\.cite-invoice-numbers/);
  assert.ok(r.subject.length <= 90, `subject is ${r.subject.length} characters`);
});

test("it outranks a stylistic preference when the prompt budget is tight", () => {
  /*
    `STRENGTH` decides what survives selection. Dropping the paying customer's own correction to keep
    a founder's stylistic preference is the wrong trade every time, so this is `never` — the same
    strength `distillFromRejection` gives a founder refusing a draft, which this is at least as
    strong as.
  */
  const r = distillFromChangeRequest({ ...base, request: "Cite the invoice numbers." })!;
  assert.equal(r.kind, "never");
});

test("prose that is only punctuation still produces a usable key", () => {
  // `slugOf` filters to letters and digits; a request of "???" leaves nothing, and a subject ending
  // in a bare dot would collide with every other empty one across all kinds.
  const r = distillFromChangeRequest({ ...base, request: "???" })!;
  assert.ok(r, "a short request produced no lesson at all");
  assert.doesNotMatch(r.subject, /\.$/, `subject ends in a dot: "${r.subject}"`);
});
