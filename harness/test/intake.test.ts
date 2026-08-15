import { test } from "node:test";
import assert from "node:assert/strict";
import { api, makeApp } from "./helpers";
import { getDomainStore } from "../src/domain";
import { registerActionGrant } from "../src/actiongrants";
import { buildCoverage, gapId, intakeFileName, routeGap } from "../src/intake";
import { getRequestStore } from "../src/requests";

const WEDGE = "books-keeper";

test("intake: coverage merges the wedge's questions with what the founder has answered", () => {
  const declared = [
    { id: "pricing", ask: "What do you charge?", weight: 9 },
    { id: "escalate", ask: "When should I stop and ask?", weight: 10 },
  ];
  const knowledge = [
    { id: "k1", wedge: WEDGE, name: intakeFileName("pricing"), content: "# What do you charge?\n\n$450/mo\n", kind: "fact", source: "authored", metadata: {}, created_at: "", updated_at: "" },
  ] as never[];

  const cov = buildCoverage(WEDGE, declared, [], knowledge);
  assert.equal(cov.total, 2);
  assert.equal(cov.answered, 1);
  assert.equal(cov.percent, 50);
  // Unanswered first — the queue is a to-do list, not an archive.
  assert.equal(cov.questions[0].id, "escalate");
  assert.equal(cov.questions[0].answered, false);
  assert.equal(cov.questions[1].answered, true);
  assert.match(String(cov.questions[1].answer), /\$450/);
  // The weight is not only a sort key — it travels on the question, so a product can tell the
  // founder which of five identical-looking rows is the one that decides the output.
  assert.equal(cov.questions[0].weight, 10);
  assert.equal(cov.questions[1].weight, 9);
});

test("intake: no questions is 0% covered, not 100%", () => {
  /**
   * REGRESSION, OBSERVED IN PRODUCTION. `percent` was `questions.length ? … : 100` — vacuously
   * true, since every question that existed had indeed been answered. But every consumer reads this
   * field as "how much of this business has been taught", and under that reading it is invented.
   *
   * With business shaping failing on every fresh signup, no wedge intake and no discovered gaps
   * ever existed, so `/setup` rendered "0 of 0 questions answered — 100% covered" and ticked the
   * step Done for an account that had taught it nothing and could not have. The Work page's own
   * copy promises "a failed one says why it failed rather than reporting a hollow success"; this
   * was the product doing the opposite on the last screen of the funnel.
   *
   * An empty denominator is the absence of evidence, not evidence of coverage.
   */
  const cov = buildCoverage(WEDGE, [], [], []);
  assert.equal(cov.total, 0);
  assert.equal(cov.answered, 0);
  assert.equal(cov.percent, 0, "nothing has been asked, so nothing is known");

  // Still 100 when it has actually been earned — this is not a blanket clamp.
  const declared = [{ id: "pricing", ask: "What do you charge?", weight: 9 }];
  const knowledge = [
    { id: "k1", wedge: WEDGE, name: intakeFileName("pricing"), content: "$450/mo", kind: "fact", source: "authored", metadata: {}, created_at: "", updated_at: "" },
  ] as never[];
  assert.equal(buildCoverage(WEDGE, declared, [], knowledge).percent, 100);
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
  // A discovered gap has no author, so it has no weight. Reporting one would be inventing a
  // judgement nobody made; `hits` is the honest signal here and it already outranked the 10.
  assert.equal(cov.questions[0].weight, undefined);
  assert.equal(cov.questions[1].weight, 10);
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
  // And over HTTP, not just out of buildCoverage(): the weight is what lets the cloud UI rank the
  // queue for the founder instead of showing five rows that all look equally optional.
  assert.ok(
    before.json.questions.every((q: { weight?: number }) => typeof q.weight === "number"),
    "the wedge's declared weights survive serialisation",
  );

  const answer = await api(app, `wedges/${WEDGE}/intake/pricing`, {
    method: "POST",
    body: JSON.stringify({ answer: "$450/month up to 300 transactions." }),
  });
  assert.equal(answer.status, 201);

  const after = await api(app, `wedges/${WEDGE}/intake`);
  assert.equal(after.json.answered, 1);
  const priced = after.json.questions.find((q: { id: string }) => q.id === "pricing");
  assert.equal(priced.answered, true);
  // The question is stored with the answer — "$450/month" alone is unreadable six months later,
  // and the agent reads this file as prose.
  assert.match(priced.answer, /What do you charge/);
  assert.match(priced.answer, /\$450/);

  // Correcting an answer must REPLACE it. Two contradictory versions of your pricing in the
  // grounding set is worse than none.
  await api(app, `wedges/${WEDGE}/intake/pricing`, {
    method: "POST",
    body: JSON.stringify({ answer: "$500/month, I put the price up." }),
  });
  const knowledge = (await api(app, `wedges/${WEDGE}/knowledge`)).json as { name: string; content: string }[];
  const files = knowledge.filter((k) => k.name === intakeFileName("pricing"));
  assert.equal(files.length, 1, "one file per question, not one per answer");
  assert.match(files[0].content, /\$500/);
  assert.ok(!files[0].content.includes("$450"), "the old price is gone, not appended");

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
  const nonce = await registerActionGrant({ task_id: "intake-task-1", connectionIds: [] });

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
  const nonce = await registerActionGrant({ task_id: "intake-task-2", connectionIds: [] });
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

test("contract-desk: the second wedge proves intake and workflows aren't bookkeeping-shaped", async () => {
  // The catalogue used to be two blueprints, both financial. If the primitives only fit accounting
  // they are not primitives — so this loads a wedge from a completely different trade (contract
  // staffing: timesheets, overtime multipliers, weekly pay runs) and checks the same machinery holds.
  //
  // It used to load `geo-monitor` for the same reason, and that wedge has been deleted: its headline
  // task declared no workflow, no skill and no connection, so it was a sketch shipped as a product —
  // the same mistake as the "five ready-made services" copy we had to retract. Repointed rather than
  // removed, because the property is still worth pinning and `contract-desk` is a real answer to it.
  const { app } = makeApp();

  const cov = await api(app, "wedges/contract-desk/intake");
  assert.equal(cov.status, 200, "the wedge loads and declares what it needs to know");
  assert.equal(cov.json.total, 6);
  assert.ok(
    cov.json.questions.every((q: { example?: string }) => q.example),
    "every question carries a real example — the thing that makes founders answer well",
  );

  const first = cov.json.questions[0].id;
  const answered = await api(app, `wedges/contract-desk/intake/${first}`, {
    method: "POST",
    body: JSON.stringify({ answer: "Timesheets are due Monday 10:00, signed off by the hiring manager." }),
  });
  assert.equal(answered.status, 201);
  assert.equal((await api(app, "wedges/contract-desk/intake")).json.answered, 1);

  // And the deterministic half runs. Every number that reaches a client is computed here rather than
  // narrated, because a contract invoice a penny out is not a rounding difference — it is a disputed
  // week where the client holds the invoice and the desk still pays the contractor on Friday.
  const { default: billLines } = await import("../../wedges/contract-desk/workflows/bill_lines.mjs");
  const bill = billLines({
    currency: "USD",
    tax_rate_bp: 2000,
    lines: [{ assignment_id: "a1", minutes: 90, charge_rate_minor_per_hour: 6250 }],
  });
  // 90 minutes at 62.50/h is exactly 93.75 — the case that separates integer arithmetic from a float
  // and a toFixed. 60 is the only divisor in that file and this is why.
  assert.equal(bill.subtotal_minor, 9375);
  assert.equal(bill.tax_minor, 1875);
  assert.equal(bill.total_minor, 11250);
  assert.equal(Number.isInteger(bill.total_minor), true, "money never leaves as a float");
});

test("intake: a question only the client can answer becomes a client request, not a founder gap", async () => {
  // THE BUG: `POST /v1/internal/knowledge/gap` was the agent's ONLY way to say "I don't know", so
  // "where is your receipt for the 14 March payment?" landed in the founder's intake queue — where
  // it is unanswerable, because the founder does not have the receipt. It then accrued `hits`
  // forever while the run guessed; and had the founder ever answered it by pasting in what the
  // customer eventually emailed, `recordAnswer` would have filed that customer's document as
  // wedge-scoped grounding mounted into EVERY other customer's run.
  const { app, store } = makeApp();
  const projectId = (await api(app, "me")).json.projects[0].id;
  const now = new Date().toISOString();
  await store.createTask({
    id: "seam-task-1",
    project_id: projectId,
    client_id: "northwind",
    case_id: "case-1",
    wedge: WEDGE,
    task_type: "reconcile",
    actor: { kind: "system", id: "scheduler" },
    input: {},
    constraints: {},
    tools: [],
    status: "running",
    cost_usd: 0,
    created_at: now,
    updated_at: now,
  } as never);
  const nonce = await registerActionGrant({ task_id: "seam-task-1", connectionIds: [] });

  const QUESTION = "Where is the receipt for the 14 March payment of $2,400?";
  const r0 = (
    await api(app, "internal/knowledge/gap", {
      method: "POST",
      headers: { authorization: `Bearer ${nonce}` },
      body: JSON.stringify({
        question: QUESTION,
        ask_client: true,
        kind: "document",
        detail: "A PDF or a photo is fine.",
        fallback: "assumed it was the Q1 retainer",
      }),
    })
  ).json;
  assert.equal(r0.ok, true);
  assert.equal(r0.asked, "client");
  assert.ok(r0.request_id, "it raised a request");

  // It is a blocking request against THIS client, on this case — not a knowledge file.
  //
  // Found by id rather than by asserting a length. The domain and request stores are process-wide
  // singletons, so isolation is per FILE and every earlier test in this one has already written
  // rows under the same project (see the comment on `makeFreshApp` in helpers.ts). A count over a
  // shared collection is a test that passes until someone adds a test above it.
  const requests = await getRequestStore().listRequests({ project_id: projectId });
  const raised = requests.find((r) => r.id === r0.request_id);
  assert.ok(raised, "the request is readable back under this project");
  assert.equal(raised.client_id, "northwind");
  assert.equal(raised.case_id, "case-1");
  assert.equal(raised.kind, "document");
  assert.equal(raised.status, "open");
  assert.ok(!raised.response);

  // What the agent GUESSED is founder-plane. A business does not tell a customer what it assumed
  // about their affairs in the same breath as asking them for the truth.
  assert.ok(!JSON.stringify(raised).includes("Q1 retainer"), "the fallback does not reach the client");

  // And it is nowhere in the founder's intake queue, which is the half that would have leaked.
  // Asserted on THIS question's id, not on "no discovered questions at all" — other tests in this
  // file legitimately leave founder gaps in the same shared store, and a blanket assertion would be
  // failing for a reason that has nothing to do with the leak it is meant to guard.
  const cov = (await api(app, `wedges/${WEDGE}/intake`)).json;
  assert.ok(
    !cov.questions.some((q: { id: string }) => q.id === gapId(QUESTION)),
    "an unanswerable question does not sit in the founder's queue",
  );

  // The timeline distinguishes "waiting on the customer" from "waiting on you".
  const events = await store.eventsAfter("seam-task-1", 0);
  assert.ok(
    events.some((e) => e.type === "progress" && String((e.data as { note?: string }).note).startsWith("Asked the client")),
    "the founder can see who was asked",
  );
});

test("intake: ask_client on a run with no client degrades to a founder gap rather than being dropped", async () => {
  // `createRequest` rejects a row with no `client_id` — correctly, it is a row every tenant's portal
  // would have to defend itself against on read. So the alternative to degrading here is a 400 at
  // the one endpoint that must never punish an agent for admitting ignorance: an agent that gets an
  // error for saying "I don't know" guesses instead, silently, which is the failure the whole gap
  // loop exists to remove.
  const { app, store } = makeApp();
  const projectId = (await api(app, "me")).json.projects[0].id;
  const now = new Date().toISOString();
  await store.createTask({
    id: "seam-task-2",
    project_id: projectId,
    wedge: WEDGE,
    task_type: "reconcile",
    actor: { kind: "system", id: "scheduler" },
    input: {},
    constraints: {},
    tools: [],
    status: "running",
    cost_usd: 0,
    created_at: now,
    updated_at: now,
  } as never);
  const nonce = await registerActionGrant({ task_id: "seam-task-2", connectionIds: [] });

  const QUESTION = "Which account did this come from?";
  const r = await api(app, "internal/knowledge/gap", {
    method: "POST",
    headers: { authorization: `Bearer ${nonce}` },
    body: JSON.stringify({ question: QUESTION, ask_client: true }),
  });
  assert.equal(r.json.ok, true);
  assert.equal(r.json.asked, "founder");
  assert.ok(r.json.recorded, "the report survives");
  // The reason is returned rather than swallowed: "my agent wanted to ask a customer on a run with
  // no customer attached" is itself a bug report worth a founder reading.
  assert.match(r.json.because, /no client attached/);
  // No request was raised for THIS question. Not `length === 0`: the request store is a process-wide
  // singleton and the test above this one deliberately leaves a row in it, so a count here asserts
  // the state of its neighbour rather than anything about degradation.
  const raised = await getRequestStore().listRequests({ project_id: projectId });
  assert.ok(!raised.some((x) => x.ask === QUESTION), "nothing was sent to a customer");
  // And it did land in the founder's queue, which is the half that must not be silently dropped.
  const cov = (await api(app, `wedges/${WEDGE}/intake`)).json;
  assert.ok(
    cov.questions.some((q: { id: string }) => q.id === r.json.recorded),
    "the founder can see the question their agent could not ask",
  );
});

test("intake: routing is the agent's declaration, never a guess from the question's wording", async () => {
  // A regex over English deciding whether a customer gets emailed looks fine in review and then
  // asks nine customers for their bank statements because a chase template contains the word
  // "your". Default is the founder queue: at worst noise, versus an email that cannot be unsent.
  const ctx = { project_id: "p1", wedge: WEDGE, task_id: "t1", client_id: "northwind" };
  const sounds = routeGap({ question: "Where is your receipt for this transaction?" }, ctx);
  assert.equal(sounds.to, "founder", "wording alone never routes to a customer");

  const declared = routeGap({ question: "Where is your receipt for this transaction?", ask_client: true }, ctx);
  assert.equal(declared.to, "client");
  if (declared.to === "client") assert.equal(declared.request.kind, "answer", "kind defaults, it is not required");
});
