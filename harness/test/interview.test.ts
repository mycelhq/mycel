import { test } from "node:test";
import assert from "node:assert/strict";
import { api, makeApp } from "./helpers";
import {
  INTERVIEW_BUDGET,
  buildInterview,
  gapId,
  intakeFileName,
  type DraftedQuestion,
  type KnowledgeGap,
} from "../src/intake";

const WEDGE = "books-keeper";
const PROJECT = "p1";

/** A drafted question that passes the "name what it changes" bar, so tests can vary one thing. */
const drafted = (over: Partial<DraftedQuestion> & { id: string }): DraftedQuestion => ({
  ask: `Question ${over.id}?`,
  decides: `how it handles ${over.id}`,
  ...over,
});

const gap = (question: string, hits: number): KnowledgeGap => ({
  id: gapId(question),
  project_id: PROJECT,
  wedge: WEDGE,
  question,
  hits,
  task_ids: [],
  status: "open",
  first_seen: "",
  last_seen: "",
});

const answered = (questionId: string) =>
  [
    {
      id: `k-${questionId}`,
      project_id: PROJECT,
      wedge: WEDGE,
      name: intakeFileName(questionId),
      content: `# asked\n\nthe answer\n`,
      kind: "fact",
      source: "authored",
      metadata: {},
      created_at: "",
      updated_at: "",
    },
  ] as never[];

test("interview: a question that can't say what it changes never reaches the founder", () => {
  // The bug this prevents: a generic interview. Asked for questions, a model will happily produce
  // "what are your business hours?" — plausible, cheap to answer, and it changes nothing about the
  // work. Filler in the grounding set is worse than an empty one, because the agent reads it and
  // acts as if it learned something. `decides` is the filter, and it has to bite.
  const iv = buildInterview({
    wedge: WEDGE,
    drafted: [
      { id: "hours", ask: "What are your business hours?" },
      drafted({ id: "pricing", ask: "What do you charge for a monthly close?" }),
    ],
    declared: [],
    gaps: [],
    knowledge: [],
  });

  assert.deepEqual(
    iv.questions.map((q) => q.id),
    ["pricing"],
  );
  const cut = iv.dropped.find((d) => d.id === "hours");
  assert.ok(cut, "the dropped question is reported, not silently vanished");
  assert.match(cut!.reason, /what answering it would change/i);
});

test("interview: every question carries the reason it was chosen", () => {
  // Question selection IS the feature, so it has to be inspectable. A UI that cannot say why it is
  // asking cannot be audited by the founder answering, and the reason is what stops us shipping a
  // question whose only justification would embarrass us on screen.
  const iv = buildInterview({
    wedge: WEDGE,
    drafted: [drafted({ id: "pricing", decides: "the price it quotes without asking you" })],
    declared: [{ id: "escalate", ask: "When should it stop and ask you?", weight: 9 }],
    gaps: [gap("What is the late payment fee?", 2)],
    knowledge: [],
  });

  for (const q of iv.questions) {
    assert.ok(q.selected_because.trim().length > 10, `${q.id} has no stated reason`);
  }
  assert.match(iv.questions[0].selected_because, /2 real jobs/);
  assert.match(
    iv.questions.find((q) => q.id === "pricing")!.selected_because,
    /the price it quotes without asking you/,
  );
});

test("interview: evidence from a real job outranks anything anyone imagined", () => {
  // Same rule buildCoverage sorts by, and it must survive the new drafted tier. A gap that has
  // already made the agent guess on this founder's work is better evidence than a weight-10
  // question a wedge author wrote before meeting anyone.
  const iv = buildInterview({
    wedge: WEDGE,
    drafted: [drafted({ id: "tone", weight: 10 })],
    declared: [{ id: "quirks", ask: "Anything unusual about these clients?", weight: 10 }],
    gaps: [gap("What is the late payment fee?", 1)],
    knowledge: [],
  });

  assert.equal(iv.questions[0].source, "discovered");
  // …and specific-to-this-founder still beats the wedge author's generic question.
  assert.deepEqual(
    iv.questions.slice(1).map((q) => q.source),
    ["drafted", "declared"],
  );
});

test("interview: a drafted duplicate of a declared question collapses onto the declared id", () => {
  // The bug this prevents: two knowledge files answering the same question under different names.
  // The agent is grounded on `intake/<id>.md`, and a drafted id the working wedge has never heard
  // of leaves the founder's answer sitting in a file nothing reads — while the declared question it
  // duplicated goes on being unanswered forever.
  const iv = buildInterview({
    wedge: WEDGE,
    drafted: [drafted({ id: "what-you-charge", ask: "What do you charge?" })],
    declared: [{ id: "pricing", ask: "What do you charge?", weight: 8 }],
    gaps: [],
    knowledge: [],
  });

  assert.deepEqual(
    iv.questions.map((q) => q.id),
    ["pricing"],
  );
  assert.match(iv.dropped[0].reason, /pricing/);
});

test("interview: the budget is hard, and what it cut says so", () => {
  // Conversion is the metric. Every question past the point of diminishing patience does not merely
  // fail to help — it costs the answers already given, because a founder who abandons at question
  // seven leaves six answers we never distilled and an impression of paperwork.
  const iv = buildInterview({
    wedge: WEDGE,
    drafted: Array.from({ length: 9 }, (_, i) => drafted({ id: `q${i}`, weight: 9 - i })),
    declared: [],
    gaps: [],
    knowledge: [],
  });

  assert.equal(iv.questions.length, INTERVIEW_BUDGET);
  assert.equal(iv.budget, INTERVIEW_BUDGET);
  // Highest weight first, and the overflow is reported with a reason rather than truncated away.
  assert.deepEqual(
    iv.questions.map((q) => q.id),
    ["q0", "q1", "q2", "q3", "q4"],
  );
  assert.equal(iv.dropped.length, 4);
  assert.ok(iv.dropped.every((d) => /already full/.test(d.reason)));
});

test("interview: an answered question is shown as answered, never asked twice", () => {
  // A founder who comes back to a half-finished conversation must be remembered, not restarted.
  // Re-asking something they already answered is the product admitting it wasn't listening, which
  // is exactly the impression this whole flow is built to avoid.
  const iv = buildInterview({
    wedge: WEDGE,
    drafted: [drafted({ id: "pricing" }), drafted({ id: "escalate" })],
    declared: [],
    gaps: [],
    knowledge: answered("pricing"),
  });

  assert.equal(iv.answered, 1);
  const pricing = iv.questions.find((q) => q.id === "pricing")!;
  assert.equal(pricing.answered, true);
  assert.match(String(pricing.answer), /the answer/);
  assert.equal(iv.questions.find((q) => q.id === "escalate")!.answered, false);
});

test("interview: no drafted questions still produces a real interview", () => {
  // The shaper run can fail, be cancelled, or hit a spend ceiling. The founder must still get the
  // wedge's own questions rather than an empty screen that implies there is nothing to say.
  const iv = buildInterview({
    wedge: WEDGE,
    drafted: [],
    declared: [
      { id: "pricing", ask: "What do you charge?", weight: 9 },
      { id: "escalate", ask: "When should it stop and ask you?", weight: 10 },
    ],
    gaps: [],
    knowledge: [],
  });

  assert.deepEqual(
    iv.questions.map((q) => q.id),
    ["escalate", "pricing"],
  );
});

test("interview: a dismissed gap stays dismissed", () => {
  // "Not worth answering" is a decision the founder already made. Resurrecting it in onboarding
  // would spend a slot in a five-question budget on a question they have explicitly refused.
  const dismissed = { ...gap("What is the late payment fee?", 4), status: "dismissed" as const };
  const iv = buildInterview({
    wedge: WEDGE,
    drafted: [drafted({ id: "pricing" })],
    declared: [],
    gaps: [dismissed],
    knowledge: [],
  });

  assert.deepEqual(
    iv.questions.map((q) => q.id),
    ["pricing"],
  );
});

// ---------------------------------------------------------------------------------------------
// Over HTTP, where the isolation actually has to hold
// ---------------------------------------------------------------------------------------------

test("interview: questions drafted for one project are invisible to another", async () => {
  // THE BUG THIS PREVENTS HAS ALREADY HAPPENED HERE ONCE, in a different route: knowledge read
  // without a project filter and leaked across tenants. The interview is the same hazard wearing
  // different clothes — the drafted questions are read out of a task artifact, and a read of "the
  // newest draft_questions run" that forgot whose it was would show one founder the questions we
  // wrote about another founder's business, which quotes that business back at them.
  const { app, store } = makeApp();

  const login = await app.request("/v1/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: process.env.MYCEL_OWNER_EMAIL || "owner@test.co",
      password: process.env.MYCEL_OWNER_PASSWORD || "secret",
    }),
  });
  const tok = (await login.json()).token as string;
  const projectA = (await api(app, "me", {}, tok)).json.projects[0].id;
  const pb = await api(app, "projects", { method: "POST", body: JSON.stringify({ name: "project-b" }) }, tok);
  assert.equal(pb.status, 201);
  const keyB = pb.json.api_key as string;

  // A finished drafting run in project A, with the questions it produced.
  const now = new Date().toISOString();
  await store.createTask({
    id: "iv-task-a",
    project_id: projectA,
    wedge: "business-shaper",
    task_type: "draft_questions",
    actor: { kind: "system", id: "onboarding" },
    input: {},
    constraints: {},
    tools: [],
    status: "succeeded",
    cost_usd: 0,
    created_at: now,
    updated_at: now,
  } as never);
  await store.addArtifact({
    task_id: "iv-task-a",
    name: "result.txt",
    content_type: "application/json",
    content: JSON.stringify({
      questions: [
        {
          id: "northwind-terms",
          ask: "What did you agree with Northwind about Friday summaries?",
          decides: "whether it sends them a weekly digest",
          weight: 9,
        },
      ],
    }),
  } as never);

  const forA = await api(app, "wedges/books-keeper/interview", { headers: { "x-mycel-project": projectA } }, tok);
  assert.equal(forA.status, 200);
  assert.ok(
    forA.json.questions.some((q: { id: string }) => q.id === "northwind-terms"),
    "the project that drafted them gets them",
  );

  const forB = await api(app, "wedges/books-keeper/interview", {}, keyB);
  assert.equal(forB.status, 200);
  assert.ok(
    !forB.json.questions.some((q: { id: string }) => q.id === "northwind-terms"),
    "another project never sees a question drafted from someone else's business",
  );
  assert.ok(
    !JSON.stringify(forB.json).includes("Northwind"),
    "not in the dropped list either — a leak in a debug field is still a leak",
  );
});

test("interview: a member with more than one project must say which one", async () => {
  // Not optional-with-a-default, on purpose. A route that guessed the project would write the
  // founder's answer about how they price into whichever tenant happened to sort first, and the
  // failure would be silent on both sides.
  const { app } = makeApp();
  const login = await app.request("/v1/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: process.env.MYCEL_OWNER_EMAIL || "owner@test.co",
      password: process.env.MYCEL_OWNER_PASSWORD || "secret",
    }),
  });
  const tok = (await login.json()).token as string;
  await api(app, "projects", { method: "POST", body: JSON.stringify({ name: "project-c" }) }, tok);

  const ambiguous = await api(app, "wedges/books-keeper/interview", {}, tok);
  assert.equal(ambiguous.status, 400);
  assert.match(ambiguous.json.error, /specify a project/i);
});

test("interview: the two lines under a drafted question say two different things", () => {
  // ═══ THE BUG ═══
  //
  // The onboarding interview renders "Why we're asking: <selected_because>" above "What it changes:
  // <decides>". `selected_because` was DERIVED from `decides`, so every drafted question printed
  // the same sentence twice, word for word:
  //
  //   Why we're asking: Your answer decides which overdue invoices it can continue chasing …
  //   What it changes:  which overdue invoices it can continue chasing …
  //
  // and the independent reason the drafter actually wrote — `why`, carried onto the question and
  // rendered nowhere — was thrown away. Two lines that agree carry one line's information.
  const iv = buildInterview({
    wedge: WEDGE,
    drafted: [
      {
        id: "dunning-limit",
        ask: "How hard should we chase a late invoice?",
        why: "You mentioned two clients you never want chased automatically.",
        decides: "which overdue invoices it can continue chasing automatically",
      },
    ],
    declared: [],
    gaps: [],
    knowledge: [],
  });

  const q = iv.questions.find((x) => x.id === "dunning-limit");
  assert.ok(q, "the drafted question was selected");
  assert.equal(q!.selected_because, "You mentioned two clients you never want chased automatically.");
  assert.notEqual(
    q!.selected_because.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(),
    (q!.decides ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(),
    "the two rendered lines must not be the same sentence",
  );
  assert.ok(!q!.selected_because.includes(q!.decides!), "`because` must not restate `decides`");
});

test("interview: a drafted question with no independent reason still explains itself", () => {
  // `why` is preferred, not required. With only `decides` to go on, the derived sentence is still
  // the right thing to print — it is the ONLY thing we know, and a blank reason would be worse.
  const iv = buildInterview({
    wedge: WEDGE,
    drafted: [{ id: "terms", ask: "What are your payment terms?", decides: "when a chase starts." }],
    declared: [],
    gaps: [],
    knowledge: [],
  });
  const q = iv.questions.find((x) => x.id === "terms");
  assert.ok(q);
  assert.equal(q!.selected_because, "Your answer decides when a chase starts.");
});
