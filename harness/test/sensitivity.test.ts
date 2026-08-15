// Knowledge sensitivity, and the cross-client leak it closes.
//
// THE BUG THESE TESTS EXIST FOR: `recordAnswer` filed a founder's intake answer as a KnowledgeItem
// with `metadata: { intake: true, ... }` and no client attribution. `retrieveFiles` read an ABSENT
// `metadata.client_id` as "this applies to everyone", and separately scored `intake === true` at
// +15 — so an answer about ONE client (a bank statement, a negotiated rate, a live dispute) was
// mounted into EVERY other client's run, ranked near the top of the index the agent reads first.
//
// The fix is an inversion, not a patch: attribution is now required to be retrievable at all.
// Every test below names the specific failure it prevents.
import { test } from "node:test";
import assert from "node:assert/strict";
import { api, makeApp } from "./helpers";
import { getDomainStore, initDomainStore, type DomainStore } from "../src/domain";
import { recordAnswer, intakeFileName } from "../src/intake";
import { mayMount, retrieveFiles, sensitivityOf, scopeMeta, type GroundingFile } from "../src/knowledge";
import type { KnowledgeItem } from "../src/contract";

const WEDGE = "books-keeper";
const PROJECT = "p-sens";

const ctx = (client_id?: string) => ({ project_id: PROJECT, wedge: WEDGE, task_type: "chase", client_id });

/** Knowledge items as the runtime hands them to retrieval (runtime.ts builds exactly this shape). */
const asFiles = (items: KnowledgeItem[]): GroundingFile[] =>
  items.map((k) => ({
    name: k.name,
    content: k.content,
    kind: k.kind,
    source: k.source,
    created_at: k.created_at,
    metadata: k.metadata,
  }));

test("leak: an intake answer about client A is never mounted into client B's run", async () => {
  // The exact reported disclosure. Two clients of the same bookkeeper; one of them is in a dispute.
  await initDomainStore();
  const domain: DomainStore = getDomainStore();

  const forA = await recordAnswer(domain, {
    projectId: PROJECT,
    wedge: WEDGE,
    questionId: "gap:why-is-this-invoice-disputed",
    ask: "Why is invoice 118 disputed?",
    answer: "Northwind are withholding $4,200 pending the FCA complaint. Do not chase until it clears.",
    sensitivity: "client",
    clientId: "northwind",
  });
  assert.equal(forA.metadata.sensitivity, "client");
  assert.equal(forA.metadata.client_id, "northwind");

  const files = asFiles(await domain.listKnowledge(WEDGE, PROJECT));

  const forNorthwind = retrieveFiles(files, ctx("northwind")).mounted.map((f) => f.name);
  assert.ok(forNorthwind.includes(forA.name), "the client it is about still gets its own answer");

  const forAcme = retrieveFiles(files, ctx("acme")).mounted.map((f) => f.name);
  assert.ok(!forAcme.includes(forA.name), "another client's run must never see it");

  // And not to a run with no client either. "No client named" is not a licence to read everything;
  // it is the one context in which a client-scoped fact is least defensible.
  const unattributedRun = retrieveFiles(files, ctx(undefined)).mounted.map((f) => f.name);
  assert.ok(!unattributedRun.includes(forA.name), "an unclienting run does not get a client's fact");
});

test("leak: a fact with no attribution at all is retrieved for nobody", async () => {
  // The pre-fix default. A row like this — live, unlabelled, no client_id — was treated as
  // house-wide and mounted into every run on the wedge. It is now invisible until something says
  // whose it is. Too little knowledge is a worse answer; too much is a disclosure, and only one of
  // those is recoverable.
  const orphan: GroundingFile = {
    name: "unlabelled.md",
    content: "the rate we agreed is $38/hr",
    created_at: "2026-01-01T00:00:00.000Z",
  };
  assert.equal(sensitivityOf(orphan), "client", "unlabelled live knowledge defaults CLOSED");

  for (const who of ["northwind", "acme", undefined]) {
    assert.equal(mayMount(orphan, who), false, `no client may read it (${who})`);
    assert.equal(retrieveFiles([orphan], ctx(who)).mounted.length, 0);
  }

  // The migration decision, asserted rather than left to a comment: every legacy KnowledgeItem row
  // predates the field, so every one of them is `client` with no owner — invisible, not house-wide.
  assert.equal(sensitivityOf({ metadata: {}, created_at: "2024-06-01T00:00:00.000Z" }), "client");
  // The one exception, and the only safe one: the wedge's OWN on-disk knowledge has no created_at
  // because it is product content, authored by someone who has never seen this tenant.
  assert.equal(sensitivityOf({ name: "playbook.md", content: "" } as GroundingFile), "house");
});

test("leak: a house fact reaches every client, and a label only ever narrows", async () => {
  // The other half of correctness — a fix that mounts nothing is not a fix. "Our late fee is $45"
  // is the founder's own operating knowledge and must still reach every run.
  const house: GroundingFile = {
    name: "late-fee.md",
    content: "our late fee is $45",
    created_at: "2026-01-02T00:00:00.000Z",
    metadata: scopeMeta(undefined),
  };
  assert.equal(house.metadata!.sensitivity, "house");
  for (const who of ["northwind", "acme", undefined]) {
    assert.equal(mayMount(house, who), true, `house knowledge reaches ${who}`);
  }

  // A house-labelled row that ALSO names a client narrows to that client. A label may restrict and
  // may never widen — otherwise "house" becomes a way to launder an attributed fact into every run.
  const narrowed = { ...house, metadata: { sensitivity: "house", client_id: "northwind" } };
  assert.equal(mayMount(narrowed, "northwind"), true);
  assert.equal(mayMount(narrowed, "acme"), false);
  assert.equal(mayMount(narrowed, undefined), false);
});

test("leak: the +15 intake bonus can no longer promote another client's answer", async () => {
  // Ranking made the original bug worse rather than causing it: `intake === true` scored +15, so
  // the leaked rows were not merely present, they were preferentially mounted ahead of the notes
  // that actually governed the job. Eligibility now runs before scoring, so the bonus can only ever
  // reorder files this run was already allowed to see.
  const budget = { max_files: 1, max_bytes: 1_000_000 };
  const mine: GroundingFile = {
    name: "mine.md",
    content: "acme pay on the 30th",
    created_at: "2026-01-01T00:00:00.000Z",
    metadata: { sensitivity: "client", client_id: "acme" },
  };
  const theirs: GroundingFile = {
    name: "theirs.md",
    content: "northwind are disputing invoice 118",
    // Newer AND carrying the intake bonus: under the old scorer it won the single slot outright.
    created_at: "2026-06-01T00:00:00.000Z",
    metadata: { intake: true, sensitivity: "client", client_id: "northwind" },
  };
  const { mounted } = retrieveFiles([mine, theirs], ctx("acme"), budget);
  assert.deepEqual(mounted.map((f) => f.name), ["mine.md"], "the higher score is not a permission");
});

test("leak: GET /v1/records with a limit cannot return another project's rows", async () => {
  // THE POST-FILTER BUG, constructed deliberately. This route queried the store with NO tenant
  // filter and removed foreign rows from the RESULT. `?limit=1` therefore asked for one row across
  // every tenant on the box, newest first — so a neighbour's row consumed the window and was then
  // discarded, and the founder's own record came back as an empty page. The same query without the
  // discard step is a straight cross-tenant read; the post-filter is the only thing that was
  // standing between this route and disclosure, and a filter that runs after truncation is not a
  // tenant boundary. `RecordQuery.project_id` is required now, so this shape cannot be rebuilt.
  await initDomainStore();
  const { app } = makeApp();
  const domain = getDomainStore();

  // Mine, written through the API so it is stamped with whatever project this key resolves to.
  const mine = (
    await api(app, "records", {
      method: "POST",
      body: JSON.stringify({ wedge: WEDGE, collection: "ledger", key: "mine", data: { amount: 1 } }),
    })
  ).json;
  assert.ok(mine.project_id, "stamped with a tenant");

  // A neighbour's row, written directly to the store and NEWER, so it sorts first and would take
  // the whole window on an unscoped query.
  const theirs = await domain.upsertRecord({
    project_id: "p-somebody-else",
    wedge: WEDGE,
    collection: "ledger",
    key: "theirs",
    data: { amount: 999_999 },
  });

  const res = await api(app, `records?wedge=${WEDGE}&collection=ledger&limit=1`);
  assert.equal(res.status, 200);
  const ids = res.json.map((r: { id: string }) => r.id);
  assert.ok(!ids.includes(theirs.id), "another project's row is never in the response");
  assert.deepEqual(ids, [mine.id], "and the limit spends the window on MY rows, not on theirs");
});

test("leak: GET /v1/cases pushes the tenant into the query, not onto the result", async () => {
  // Same pattern, same argument, and a worse blast radius: a case carries a client's entire
  // engagement history. Nothing else in this file would catch it, because `listCases` has no limit
  // to truncate — which is exactly why it survived: the post-filter looked correct until it didn't.
  await initDomainStore();
  const { app } = makeApp();
  const domain = getDomainStore();
  await domain.createCase({
    project_id: "p-somebody-else",
    wedge: WEDGE,
    title: "a rival's engagement",
    stage: "open",
    status: "open",
    data: {},
  });
  const mine = (await api(app, "cases", { method: "POST", body: JSON.stringify({ wedge: WEDGE, title: "mine" }) })).json;

  const listed = await api(app, `cases?wedge=${WEDGE}`);
  assert.deepEqual(listed.json.map((k: { id: string }) => k.id), [mine.id]);
  assert.ok(
    !listed.json.some((k: { title: string }) => k.title === "a rival's engagement"),
    "no unscoped read happened at all — the rival's row was never fetched",
  );
});

test("leak: an answer to a gap raised on a client's task inherits that client", async () => {
  // The whole route, end to end, because the bug lived in the wiring rather than in either half:
  // `distillFromAnswer` has accepted a client_id all along and `recordGapAnswer` passed it through
  // — the intake route simply never supplied one, so both the markdown file AND the distilled rule
  // (the form that gets INLINED into the prompt) came out house-wide.
  await initDomainStore();
  const { app } = makeApp();
  const domain = getDomainStore();

  const client = (
    await api(app, "clients", { method: "POST", body: JSON.stringify({ name: "Northwind", handle: "northwind" }) })
  ).json;
  const kase = (
    await api(app, "cases", { method: "POST", body: JSON.stringify({ wedge: WEDGE, title: "Northwind", client_id: client.id }) })
  ).json;
  const task = (await api(app, `cases/${kase.id}/tasks`, { method: "POST", body: JSON.stringify({ task_type: "chase_receipts" }) })).json;

  const question = "Why is invoice 118 disputed?";
  const gap = await domain.recordGap({
    id: "gap:why-is-invoice-118-disputed",
    project_id: task.project_id,
    wedge: WEDGE,
    question,
    task_id: task.id,
  });

  const posted = await api(app, `wedges/${WEDGE}/intake/${encodeURIComponent(gap.id)}`, {
    method: "POST",
    body: JSON.stringify({ answer: "They are withholding pending the FCA complaint." }),
  });
  assert.equal(posted.status, 201);
  assert.equal(posted.json.client_id, client.id, "the gap's task named a client; the answer inherits it");

  const item = await domain.getKnowledge(posted.json.knowledge_id);
  assert.equal(item?.metadata.sensitivity, "client");
  assert.equal(item?.metadata.client_id, client.id);
  assert.equal(item?.name, intakeFileName(gap.id, client.id), "and it is filed under that client");

  // The distilled rule too, not only the file. A rule is what retrieval ranks and inlines, so a
  // house-wide rule is the louder half of the same disclosure.
  const rules = (await api(app, `wedges/${WEDGE}/rules`)).json;
  const rule = rules.find((r: { subject: string }) => r.subject === gap.id);
  assert.equal(rule?.client_id, client.id, "the rule carries the same scope as the file");

  // And a run for a different client cannot reach either of them.
  const files = asFiles(await domain.listKnowledge(WEDGE, task.project_id));
  const other = retrieveFiles(files, { project_id: task.project_id, wedge: WEDGE, task_type: "chase_receipts", client_id: "someone-else" });
  assert.ok(!other.mounted.some((f) => f.metadata?.question_id === gap.id));
});

test("intake: a declared question is house knowledge, and coverage still sees client answers", async () => {
  // The counterweight to the inversion. A wedge-declared question ("what is your late fee?") is
  // asked of the BUSINESS, before any client exists, so it is labelled `house` explicitly — not by
  // default; the default is `client` and lives in the reader.
  //
  // The second assertion prevents a regression the file-naming change could have caused: answers
  // now live under `intake/<client>/<question>.md` when scoped, and coverage used to look up the
  // literal house path. A question the founder HAD answered would have kept being asked forever,
  // which is the exact counter the gap loop exists to retire.
  await initDomainStore();
  const domain = getDomainStore();
  const houseAnswer = await recordAnswer(domain, {
    projectId: "p-cov",
    wedge: WEDGE,
    questionId: "late_fee",
    ask: "What is your late fee?",
    answer: "$45",
    sensitivity: "house",
  });
  assert.equal(houseAnswer.metadata.sensitivity, "house");
  assert.equal(houseAnswer.name, "intake/late_fee.md");
  assert.equal(mayMount({ metadata: houseAnswer.metadata, created_at: houseAnswer.created_at }, "anyone"), true);

  const { buildCoverage } = await import("../src/intake");
  const clientAnswer = await recordAnswer(domain, {
    projectId: "p-cov",
    wedge: WEDGE,
    questionId: "gap:agreed-rate",
    ask: "What rate did we agree?",
    answer: "$38/hr",
    sensitivity: "client",
    clientId: "northwind",
  });
  const coverage = buildCoverage(
    WEDGE,
    [],
    [{ id: "gap:agreed-rate", project_id: "p-cov", wedge: WEDGE, question: "What rate did we agree?", hits: 3, task_ids: [], status: "open" as const, first_seen: "", last_seen: "" }],
    [clientAnswer],
  );
  assert.equal(coverage.questions[0]?.answered, true, "a client-scoped answer still answers the question");
});
