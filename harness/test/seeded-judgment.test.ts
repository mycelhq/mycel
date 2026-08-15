// Seeded judgment: what the founder TOLD us at signup, versus what the business was OBSERVED doing.
//
// Onboarding asks a handful of questions and files the answers as rules, which is the only way the
// agent's first week is better than nothing. The danger is entirely in the labelling. A stated
// answer that gets filed as observed evidence is unrecoverable — there is no migration back from a
// mislabelled provenance — and it would let a signup form silently repeal something the agent
// learned the expensive way, on a real job, with a human watching.
//
// Every test here names the specific way that poisoning could happen and asserts it does not.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EVIDENCE,
  applyDistilled,
  distillFromAnswer,
  distillFromOnboarding,
  distillFromRejection,
  isStated,
  materialize,
  reconcile,
  recordGapAnswer,
  retrieveRules,
  scoreRule,
  type NewRule,
  type RetrievalContext,
} from "../src/knowledge";
import { InMemoryKnowledgeStore, resetKnowledgeStore } from "../src/knowledge.store";

function freshStore(): InMemoryKnowledgeStore {
  const s = new InMemoryKnowledgeStore();
  resetKnowledgeStore(s);
  return s;
}

const ctxFor = (over: Partial<RetrievalContext> = {}): RetrievalContext => ({
  project_id: "p1",
  wedge: "books-keeper",
  task_type: "chase",
  now: "2026-01-01T00:00:00.000Z",
  ...over,
});

const seeded = (over: Partial<Parameters<typeof distillFromOnboarding>[0]> = {}): NewRule =>
  distillFromOnboarding({
    project_id: "p1",
    wedge: "books-keeper",
    question_id: "q:chase-tone",
    question: "How do you chase a late invoice?",
    answer: "Firmly, on day 30, and never before.",
    at: "2026-01-01T00:00:00.000Z",
    ...over,
  });

test("a seeded judgment is labelled as stated, not as an answer earned on a real job", () => {
  const rule = seeded();
  assert.equal(rule.provenance.source, "onboarding");
  assert.equal(EVIDENCE.onboarding, 0);
  assert.ok(isStated(materialize(rule)), "the label has to be readable by everything downstream");

  // The bug this prevents: routing onboarding through `distillFromAnswer` because the shape is
  // identical. It IS identical apart from the one field that decides every argument it will ever
  // lose, and after a week of signups the two are indistinguishable in the table forever.
  const observed = distillFromAnswer({
    project_id: "p1",
    wedge: "books-keeper",
    question_id: "q:chase-tone",
    question: "How do you chase a late invoice?",
    answer: "Firmly, on day 30, and never before.",
  });
  assert.equal(observed.provenance.source, "gap_answer");
  assert.notEqual(rule.provenance.source, observed.provenance.source);
  assert.equal(rule.subject, observed.subject, "same subject, so they genuinely compete");
});

test("a seeded judgment loses to a real observed correction, and is not written at all", async () => {
  const store = freshStore();
  const at = "2026-02-01T00:00:00.000Z";

  // The agent hit this on a real job and the founder told it the truth. Observed.
  await applyDistilled(
    store,
    [
      distillFromAnswer({
        project_id: "p1",
        wedge: "books-keeper",
        question_id: "q:chase-tone",
        question: "How do you chase a late invoice?",
        answer: "Gently, on day 7 — these are long-standing clients.",
      }),
    ],
    at,
  );

  // Later, the founder goes back and finishes the setup flow they skipped, and says the opposite.
  const [rec] = await applyDistilled(store, [seeded()], "2026-03-01T00:00:00.000Z");

  assert.equal(rec.outcome, "declined", "the stated claim must not displace the observed one");
  const active = (await store.listRules("p1", { wedge: "books-keeper", status: "active" }));
  assert.equal(active.length, 1, "exactly one rule is active — two contradicting rows is the whole failure");
  assert.equal(active[0].provenance.source, "gap_answer", "and it is the OBSERVED one that survived");
  assert.match(active[0].text, /Gently, on day 7/);

  // The bug this prevents specifically: emitting `created` instead. That leaves two active rules on
  // one subject, the agent inlines both, and nobody — not the founder, not us — can say which one
  // it followed on any given job.
  const all = await store.listRules("p1", { wedge: "books-keeper" });
  assert.equal(all.length, 1, "the declined candidate leaves no row behind, not even a superseded one");
});

test("a real correction supersedes a seeded judgment, and is not flagged for review for doing so", async () => {
  const store = freshStore();
  await applyDistilled(store, [seeded()], "2026-01-01T00:00:00.000Z");

  // An observed correction on the same subject and scope. Stronger in kind AND stronger in witness,
  // so it supersedes — which is the ordinary case and the one that must keep working.
  const [strong] = await applyDistilled(
    store,
    [
      {
        ...distillFromRejection({
          project_id: "p1",
          wedge: "books-keeper",
          task_type: "chase",
          action: "send",
          proposed: { body: "Pay up." },
          reason: "Far too blunt for this client.",
        }),
        // Forced onto the seeded rule's subject and scope: contradiction is only meaningful inside
        // one scope, and a rejection's own subject (`send.rejected`) would not compete with it.
        subject: "q:chase-tone",
        task_types: [],
      },
    ],
    "2026-02-01T00:00:00.000Z",
  );
  assert.equal(strong.outcome, "superseded");
  assert.equal(strong.superseded?.provenance.source, "onboarding", "it is the stated rule that was displaced");

  // Now the weaker direction, which is where `needs_review` used to fire. Reality contradicting a
  // signup-form claim is the system working, not a prohibition being quietly repealed, and putting
  // it in the review queue would fill that queue with the most predictable event in the product.
  const store2 = freshStore();
  await applyDistilled(
    store2,
    [{ ...seeded(), kind: "never" as const, text: "Never chase before day 30." }],
    "2026-01-01T00:00:00.000Z",
  );
  const [weak] = await applyDistilled(
    store2,
    [
      distillFromAnswer({
        project_id: "p1",
        wedge: "books-keeper",
        question_id: "q:chase-tone",
        question: "How do you chase a late invoice?",
        answer: "Actually we chase on day 7 now.",
      }),
    ],
    "2026-02-01T00:00:00.000Z",
  );
  assert.equal(weak.outcome, "superseded");
  assert.equal(weak.rule.provenance.source, "gap_answer");
  assert.equal(
    weak.rule.needs_review,
    false,
    "a `fact` replacing a stated `never` is expected, not suspicious — flagging it would train founders to ignore the flag",
  );

  // And in the other direction the flag still works, because that is the case it was built for.
  const store3 = freshStore();
  await applyDistilled(
    store3,
    [
      {
        ...distillFromRejection({
          project_id: "p1",
          wedge: "books-keeper",
          task_type: "chase",
          action: "send_email",
          proposed: { body: "x" },
          reason: "Never email this client at the weekend.",
        }),
      },
    ],
    "2026-01-01T00:00:00.000Z",
  );
  const [repeal] = await applyDistilled(
    store3,
    [
      distillFromAnswer({
        project_id: "p1",
        wedge: "books-keeper",
        task_types: ["chase"],
        question_id: "send_email.rejected",
        question: "When may we email?",
        answer: "Whenever.",
      }),
    ],
    "2026-02-01T00:00:00.000Z",
  );
  assert.equal(repeal.outcome, "superseded");
  assert.equal(repeal.rule.needs_review, true, "an observed prohibition repealed by an observed fact still needs a human");
});

test("a seeded judgment never counts as a correction against the rule it lost to", async () => {
  const store = freshStore();
  await applyDistilled(
    store,
    [
      distillFromAnswer({
        project_id: "p1",
        wedge: "books-keeper",
        question_id: "q:chase-tone",
        question: "How do you chase a late invoice?",
        answer: "Gently, on day 7.",
      }),
    ],
    "2026-01-01T00:00:00.000Z",
  );

  // Three onboarding answers on the same subject — a founder redoing the setup flow.
  for (const at of ["2026-02-01", "2026-02-02", "2026-02-03"]) {
    await applyDistilled(store, [seeded()], `${at}T00:00:00.000Z`);
  }

  const [survivor] = await store.listRules("p1", { wedge: "books-keeper", status: "active" });
  // `corrections_since` is the honest per-rule failure signal, and `detectRecurrence` escalates it
  // to a human at three. If a setup answer bumped it, finishing onboarding would manufacture
  // "this rule is not working" reports about rules that are working fine.
  assert.equal(survivor.corrections_since, 0);
});

test("under prompt-budget pressure a stated rule yields its slot to an observed one", () => {
  const at = "2026-01-01T00:00:00.000Z";
  // Identical on every other scoring term — same scope, same kind, same corroboration — so the only
  // thing left to decide it is recency against the stated penalty.
  const stated = materialize(seeded({ question_id: "q:a" }), at);
  const observed = materialize(
    distillFromAnswer({
      project_id: "p1",
      wedge: "books-keeper",
      question_id: "q:b",
      question: "What is the late fee?",
      answer: "$45.",
    }),
    // Deliberately OLDER. Recency is worth up to +20, and a signup answer written this morning
    // would otherwise outrank a correction earned two months ago on the strength of its date.
    "2025-11-01T00:00:00.000Z",
  );

  assert.ok(
    scoreRule(observed, ctxFor()) > scoreRule(stated, ctxFor()),
    "an older observed rule must still beat a fresher stated one",
  );

  const only = retrieveRules([stated, observed], ctxFor(), { max_chars: 6000, max_rules: 1, evidence_chars: 400 });
  assert.equal(only.selected.length, 1);
  assert.equal(only.selected[0].id, observed.id);
});

test("the setup flow's answers are project-scoped, and cannot be written into another tenant", async () => {
  const store = freshStore();

  await recordGapAnswer(store, {
    project_id: "p1",
    wedge: "books-keeper",
    question_id: "q:chase-tone",
    question: "How do you chase a late invoice?",
    answer: "p1 answer.",
    stated: true,
  });

  // The tenancy story for this table is that there are no unowned rows. A candidate with no project
  // is dropped rather than defaulted — a default would put one business's judgement somewhere it
  // could be retrieved by another, which is the leak that has shipped here twice.
  const orphan = await recordGapAnswer(store, {
    project_id: undefined,
    wedge: "books-keeper",
    question_id: "q:chase-tone",
    question: "How do you chase a late invoice?",
    answer: "nobody's answer.",
    stated: true,
  });
  assert.equal(orphan.rule, undefined);

  assert.equal((await store.listRules("p2", { wedge: "books-keeper" })).length, 0, "p2 sees nothing p1 wrote");
  const mine = await store.listRules("p1", { wedge: "books-keeper" });
  assert.equal(mine.length, 1);
  assert.equal(mine[0].project_id, "p1");
  assert.equal(mine[0].provenance.source, "onboarding");

  // Retrieval fails closed on the same axis: the rule exists, but not for p2's runs.
  assert.equal(retrieveRules(mine, ctxFor({ project_id: "p2" })).selected.length, 0);
});

test("saying the same thing at signup that a real job already taught does not demote the rule", () => {
  const at = "2026-01-01T00:00:00.000Z";
  const observed = materialize(
    distillFromAnswer({
      project_id: "p1",
      wedge: "books-keeper",
      question_id: "q:chase-tone",
      question: "How do you chase a late invoice?",
      answer: "Firmly, on day 30, and never before.",
    }),
    at,
  );

  const rec = reconcile([observed], seeded(), "2026-02-01T00:00:00.000Z");
  assert.equal(rec.outcome, "corroborated", "the same point, so it is agreement rather than conflict");
  assert.equal(rec.rule.corroborations, 2);
  // The bug this prevents: `reconcile` refreshes provenance to the newest instance so the rendered
  // example is the freshest one. Applied blindly, a founder repeating themselves at signup would
  // overwrite an earned `gap_answer` with `onboarding` and hand the rule `scoreRule`'s penalty for
  // the rest of its life — the rule would get quietly worse for being agreed with.
  assert.equal(rec.rule.provenance.source, "gap_answer");
});
