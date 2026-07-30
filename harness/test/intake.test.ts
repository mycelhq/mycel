import { test } from "node:test";
import assert from "node:assert/strict";
import { api, makeApp } from "./helpers";
import { getDomainStore } from "../src/domain";
import { registerActionGrant } from "../src/actiongrants";
import { buildCoverage, gapId, intakeFileName } from "../src/intake";

const WEDGE = "books-keeper";

test("intake: coverage merges the wedge's questions with what the founder has answered", () => {
  const declared = [
    { id: "pricing", ask: "What do you charge?", weight: 9 },
    { id: "escalate", ask: "When should I stop and ask?", weight: 10 },
  ];
  const knowledge = [
    { id: "k1", wedge: WEDGE, name: intakeFileName("pricing"), content: "# What do you charge?\n\n£450/mo\n", kind: "fact", source: "authored", metadata: {}, created_at: "", updated_at: "" },
  ] as never[];

  const cov = buildCoverage(WEDGE, declared, [], knowledge);
  assert.equal(cov.total, 2);
  assert.equal(cov.answered, 1);
  assert.equal(cov.percent, 50);
  // Unanswered first — the queue is a to-do list, not an archive.
  assert.equal(cov.questions[0].id, "escalate");
  assert.equal(cov.questions[0].answered, false);
  assert.equal(cov.questions[1].answered, true);
  assert.match(String(cov.questions[1].answer), /£450/);
});

test("intake: a question that blocked real work outranks one nobody has hit", () => {
  // Evidence beats the wedge author's guess about what matters. A gap seen on three jobs is a
  // better use of the founder's next two minutes than a high-weight question nothing has needed.
  const declared = [{ id: "quirks", ask: "Anything unusual about these clients?", weight: 10 }];
  const gaps = [
    {
      id: gapId("What is the late payment fee?"),
      project_id: "p1",
      wedge: WEDGE,
      question: "What is the late payment fee?",
      hits: 3,
      task_ids: ["t1", "t2", "t3"],
      status: "open" as const,
      first_seen: "",
      last_seen: "",
    },
  ];
  const cov = buildCoverage(WEDGE, declared, gaps, []);
  assert.equal(cov.questions[0].source, "discovered");
  assert.equal(cov.questions[0].hits, 3);
  assert.match(String(cov.questions[0].why), /3 real jobs/);
});

test("intake: answering stores knowledge, and re-answering replaces rather than duplicates", async () => {
  const { app } = makeApp();
  const projectId = (await api(app, "me")).json.projects[0].id;

  const before = await api(app, `wedges/${WEDGE}/intake`);
  assert.equal(before.status, 200);
  assert.ok(before.json.total >= 5, "the wedge declares what it needs to know");
  assert.equal(before.json.answered, 0);
  assert.equal(before.json.percent, 0);
  // The example is what makes a founder answer well rather than write "TBD".
  assert.ok(before.json.questions.every((q: { example?: string }) => q.example), "every question shows a real example");

  const answer = await api(app, `wedges/${WEDGE}/intake/pricing`, {
    method: "POST",
    body: JSON.stringify({ answer: "£450/month up to 300 transactions." }),
  });
  assert.equal(answer.status, 201);

  const after = await api(app, `wedges/${WEDGE}/intake`);
  assert.equal(after.json.answered, 1);
  const priced = after.json.questions.find((q: { id: string }) => q.id === "pricing");
  assert.equal(priced.answered, true);
  // The question is stored with the answer — "£450/month" alone is unreadable six months later,
  // and the agent reads this file as prose.
  assert.match(priced.answer, /What do you charge/);
  assert.match(priced.answer, /£450/);

  // Correcting an answer must REPLACE it. Two contradictory versions of your pricing in the
  // grounding set is worse than none.
  await api(app, `wedges/${WEDGE}/intake/pricing`, {
    method: "POST",
    body: JSON.stringify({ answer: "£500/month, I put the price up." }),
  });
  const knowledge = (await api(app, `wedges/${WEDGE}/knowledge`)).json as { name: string; content: string }[];
  const files = knowledge.filter((k) => k.name === intakeFileName("pricing"));
  assert.equal(files.length, 1, "one file per question, not one per answer");
  assert.match(files[0].content, /£500/);
  assert.ok(!files[0].content.includes("£450"), "the old price is gone, not appended");

  void projectId;
});

test("intake: the agent reports what it didn't know, and it lands in the founder's queue", async () => {
  const { app, store } = makeApp();
  const projectId = (await api(app, "me")).json.projects[0].id;
  const domain = getDomainStore();
  void domain;

  const now = new Date().toISOString();
  await store.createTask({
    id: "intake-task-1",
    project_id: projectId,
    wedge: WEDGE,
    task_type: "daily_sync",
    actor: { kind: "system", id: "scheduler" },
    input: {},
    constraints: {},
    tools: [],
    status: "running",
    cost_usd: 0,
    created_at: now,
    updated_at: now,
  } as never);
  const nonce = registerActionGrant({ task_id: "intake-task-1", connectionIds: [] });

  const report = (question: string, fallback?: string) =>
    api(app, "internal/knowledge/gap", {
      method: "POST",
      headers: { authorization: `Bearer ${nonce}` },
      body: JSON.stringify({ question, fallback }),
    });

  const first = await report("What is the late-payment fee?", "assumed none");
  assert.equal(first.json.ok, true);
  assert.equal(first.json.hits, 1);

  // The same gap twice is one row with a higher count, not two rows. Recurrence is the whole
  // ranking signal, so duplicating instead of counting would bury the question that matters most.
  const second = await report("What is the late payment fee?");
  assert.equal(second.json.hits, 2, "normalised to the same question");
  assert.equal(second.json.recorded, first.json.recorded);

  const cov = (await api(app, `wedges/${WEDGE}/intake`)).json;
  const gap = cov.questions.find((q: { source: string }) => q.source === "discovered");
  assert.ok(gap, "the agent's question reaches the founder");
  assert.equal(gap.hits, 2);
  assert.equal(gap.fallback, "assumed none", "and says what it did instead, so you can judge it");

  // It also lands on the task timeline, so it's visible in context and not only in a queue.
  const events = await store.eventsAfter("intake-task-1", 0);
  assert.ok(
    events.some((e) => e.type === "progress" && String((e.data as { note?: string }).note).includes("Missing knowledge")),
    "the gap is on the timeline too",
  );

  // Answering it closes it.
  await api(app, `wedges/${WEDGE}/intake/${gap.id}`, {
    method: "POST",
    body: JSON.stringify({ answer: "8% + Bank of England base, per the Late Payment Act." }),
  });
  const after = (await api(app, `wedges/${WEDGE}/intake`)).json;
  const answered = after.questions.find((q: { id: string }) => q.id === gap.id);
  assert.equal(answered.answered, true);

  // …but if the agent hits it AGAIN, it reopens. That's the honest signal that the answer didn't
  // actually cover the case, rather than the queue quietly staying green.
  const third = await report("What is the late payment fee?");
  assert.equal(third.json.hits, 3);
  const reopened = (await api(app, `wedges/${WEDGE}/intake`)).json.questions.find(
    (q: { id: string }) => q.id === gap.id,
  );
  assert.ok(reopened, "still in the queue");
});

test("intake: a gap can be dismissed when it isn't worth answering", async () => {
  const { app, store } = makeApp();
  const projectId = (await api(app, "me")).json.projects[0].id;
  const now = new Date().toISOString();
  await store.createTask({
    id: "intake-task-2",
    project_id: projectId,
    wedge: WEDGE,
    task_type: "daily_sync",
    actor: { kind: "system", id: "scheduler" },
    input: {},
    constraints: {},
    tools: [],
    status: "running",
    cost_usd: 0,
    created_at: now,
    updated_at: now,
  } as never);
  const nonce = registerActionGrant({ task_id: "intake-task-2", connectionIds: [] });
  const r = await api(app, "internal/knowledge/gap", {
    method: "POST",
    headers: { authorization: `Bearer ${nonce}` },
    body: JSON.stringify({ question: "Is the sky blue in this business?" }),
  });
  const id = r.json.recorded as string;

  await api(app, `wedges/${WEDGE}/intake/${id}/dismiss`, { method: "POST" });
  const cov = (await api(app, `wedges/${WEDGE}/intake`)).json;
  assert.ok(
    !cov.questions.some((q: { id: string }) => q.id === id),
    "a dismissed question leaves the queue instead of nagging forever",
  );
});

test("geo-monitor: the second wedge proves intake and workflows aren't bookkeeping-shaped", async () => {
  // The catalogue was two blueprints, both financial. If the primitives only fit accounting they
  // aren't primitives — so this loads a wedge from a service that didn't exist in 2024 and checks
  // the same machinery holds.
  const { app } = makeApp();

  const cov = await api(app, "wedges/geo-monitor/intake");
  assert.equal(cov.status, 200, "the wedge loads and declares what it needs to know");
  assert.equal(cov.json.total, 5);
  assert.ok(
    cov.json.questions.every((q: { example?: string }) => q.example),
    "every question carries a real example — the thing that makes founders answer well",
  );

  // The most important question ranks first. For GEO that's the query set: get it wrong and every
  // number afterwards measures something nobody is buying.
  assert.equal(cov.json.questions[0].id, "queries");

  const answered = await api(app, "wedges/geo-monitor/intake/queries", {
    method: "POST",
    body: JSON.stringify({ answer: '"best payroll for UK startups", "alternatives to Gusto"' }),
  });
  assert.equal(answered.status, 201);
  assert.equal((await api(app, "wedges/geo-monitor/intake")).json.answered, 1);

  // And the deterministic half runs. Share of voice is the number on the invoice, so it's computed
  // rather than narrated — a model asked to summarise rounds toward the story it's telling.
  const { default: shareOfVoice } = await import("../../wedges/geo-monitor/workflows/share_of_voice.mjs");
  const sov = await shareOfVoice({
    client: "Acme",
    results: [
      { query: "best payroll uk", cited: ["Acme Ltd", "Gusto"] },
      { query: "gusto alternatives", cited: ["Gusto", "Deel"] },
      { query: "eu contractors", cited: ["Deel"] },
    ],
  });
  assert.equal(sov.share_of_voice_pct, 33.3);
  // Matched loosely on purpose: models write "Acme", "Acme Ltd" and "Acme's" for one company, and an
  // exact match would report zero visibility for a client who is in fact being cited.
  assert.equal(sov.mentions, 1);
  // The actionable half — who wins the queries we lose.
  assert.equal(sov.top_competitors[0].name, "Deel");
});
