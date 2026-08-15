// The distillation loop, end to end: capture a human correction, reconcile it against what is
// already known, retrieve it under a budget on the next run, and count whether it was read.
//
// These assert the PROPERTIES the commercial claim rests on ("every correction you make sharpens
// it"), not the wording of any rule. Each one corresponds to a way the loop can be quietly broken
// while still looking like it works: knowledge that is written but never retrieved, retrieved but
// never counted, counted but leaking across tenants, or accumulated until two rules contradict each
// other and the agent picks one at random.
import { test } from "node:test";
import assert from "node:assert/strict";
import { api, makeApp, freshProjectId } from "./helpers";
import { awaitApproval } from "../src/approvals";
import {
  DEFAULT_RULE_BUDGET,
  applyDistilled,
  detectRecurrence,
  distillFromApprovalEdit,
  groundRun,
  materialize,
  retrieveRules,
  type NewRule,
  type RetrievalContext,
  type Rule,
} from "../src/knowledge";
import { InMemoryKnowledgeStore, resetKnowledgeStore } from "../src/knowledge.store";

/** A fresh singleton per test — the store is process-wide, and these tests count rows. */
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

function ruleOf(over: Partial<Rule> = {}): Rule {
  const base: NewRule = {
    project_id: "p1",
    wedge: "books-keeper",
    task_types: ["chase"],
    subject: "send_email.body",
    text: "say it the founder's way",
    kind: "prefer",
    // Explicit, because an absent label now means "nobody may read this". The fixture stands in for
    // a rule distilled from work with no client attached, which `scopeMeta` labels `house`. A test
    // that wants a client-scoped rule overrides both fields, exactly as a write site would.
    sensitivity: "house",
    provenance: { source: "approval_edit", at: "2025-12-01T00:00:00.000Z" },
  };
  return { ...materialize(base, "2025-12-01T00:00:00.000Z"), ...over };
}

test("distillation: an approve-with-edit becomes a scoped rule with the founder's own words as evidence", async () => {
  // The highest-signal event in the system, and it was being thrown away. A human looked at exactly
  // what the agent was about to send, on a real job, and rewrote it. The delta IS the house style.
  const knowledge = freshStore();
  const { app, store } = makeApp();
  const projectId = (await api(app, "me")).json.projects[0].id;
  const now = new Date().toISOString();
  const taskId = `distil-${Date.now()}`;
  await store.createTask({
    id: taskId, project_id: projectId, wedge: "books-keeper", task_type: "daily_sync",
    actor: { kind: "system", id: "test" }, input: { client_id: "northwind" }, constraints: {}, tools: [],
    status: "awaiting_approval", cost_usd: 0, created_at: now, updated_at: now,
  } as never);

  const waiting = awaitApproval(store, taskId, {
    action: "send_email",
    risk: "medium",
    preview: { subject: "Yo", body: "u owe us money", cc: "everyone@acme.co" },
  });
  const pending = (await api(app, "approvals?status=pending")).json as { approval_id: string }[];
  const approvalId = pending[0]!.approval_id;

  await api(app, `approvals/${approvalId}/approve`, {
    method: "POST",
    body: JSON.stringify({
      edited: { subject: "July invoice", body: "Hi — the July invoice is now overdue.", bcc: "books@acme.co" },
    }),
  });
  await waiting;

  const rules = await knowledge.listRules(projectId, { wedge: "books-keeper" });
  const bySubject = new Map(rules.map((r) => [r.subject, r]));

  // One rule per field the human actually changed — subjects derived structurally, so a later
  // correction on the same field can contradict this one rather than pile up next to it.
  const body = bySubject.get("send_email.body");
  assert.ok(body, `body rule exists (got ${[...bySubject.keys()].join(", ")})`);
  assert.equal(body!.kind, "prefer", "a rewrite is a style preference, not a prohibition");
  // Verbatim, both sides. "Here is what good looks like" teaches far less than the contrast.
  assert.equal(body!.provenance.before, "u owe us money");
  assert.equal(body!.provenance.after, "Hi — the July invoice is now overdue.");
  assert.equal(body!.provenance.approval_id, approvalId, "the founder can open the job it was learned on");
  assert.equal(body!.provenance.task_id, taskId);

  // A field the founder DELETED is a prohibition — the expensive kind of lesson, because nobody
  // notices a field that shouldn't be there until a client does.
  assert.equal(bySubject.get("send_email.cc")?.kind, "never");
  // A field the founder had to ADD is a standing requirement.
  assert.equal(bySubject.get("send_email.bcc")?.kind, "always");

  // Scoped to the job it was learned on: this client, this task type. A correction made for
  // Northwind is not a house rule, and applying it to everyone is how a "learning" system makes a
  // business worse.
  assert.equal(body!.client_id, "northwind");
  assert.deepEqual(body!.task_types, ["daily_sync"]);
  assert.equal(body!.project_id, projectId, "and to the tenant it belongs to");

  // The measurement half: the edit is an observation too, or a quality metric would only ever be
  // reconstructable from the rules table, which holds successes.
  const obs = await knowledge.listObservations(projectId, { wedge: "books-keeper" });
  assert.ok(obs.some((o) => o.kind === "approval_edited"), "the correction is measurable");
});

test("distillation: a clean approval teaches nothing but is still measured; the model's own claims never count", async () => {
  // A knowledge base that fills with "the agent was right" is noise. But a quality metric built only
  // from failures is a complaint log — so the clean approval is recorded as an observation and as
  // nothing else.
  const knowledge = freshStore();
  const { app, store } = makeApp();
  const projectId = (await api(app, "me")).json.projects[0].id;
  const now = new Date().toISOString();
  const taskId = `clean-${Date.now()}`;
  await store.createTask({
    id: taskId, project_id: projectId, wedge: "books-keeper", task_type: "daily_sync",
    actor: { kind: "system", id: "test" }, input: {}, constraints: {}, tools: [],
    status: "awaiting_approval", cost_usd: 0, created_at: now, updated_at: now,
  } as never);

  const waiting = awaitApproval(store, taskId, {
    action: "send_email", risk: "medium", preview: { subject: "July invoice", body: "It's due." },
  });
  const approvalId = ((await api(app, "approvals?status=pending")).json as { approval_id: string }[])[0]!.approval_id;
  await api(app, `approvals/${approvalId}/approve`, { method: "POST", body: JSON.stringify({}) });
  await waiting;

  assert.equal((await knowledge.listRules(projectId)).length, 0, "no rule from being right");
  const obs = await knowledge.listObservations(projectId);
  assert.equal(obs.length, 1);
  assert.equal(obs[0].kind, "approval_clean");
});

test("distillation: an echoed payload is not a correction", async () => {
  // Some approval UIs post the whole payload back whether or not anything changed. Treating that as
  // an edit would manufacture rules nobody wrote and, worse, increment `corrections_since` against
  // rules that were working — poisoning the one honest per-rule metric there is.
  const knowledge = freshStore();
  const { app, store } = makeApp();
  const projectId = (await api(app, "me")).json.projects[0].id;
  const now = new Date().toISOString();
  const taskId = `echo-${Date.now()}`;
  await store.createTask({
    id: taskId, project_id: projectId, wedge: "books-keeper", task_type: "daily_sync",
    actor: { kind: "system", id: "test" }, input: {}, constraints: {}, tools: [],
    status: "awaiting_approval", cost_usd: 0, created_at: now, updated_at: now,
  } as never);
  const preview = { subject: "July invoice", body: "It's due." };
  const waiting = awaitApproval(store, taskId, { action: "send_email", risk: "medium", preview });
  const approvalId = ((await api(app, "approvals?status=pending")).json as { approval_id: string }[])[0]!.approval_id;
  await api(app, `approvals/${approvalId}/approve`, {
    method: "POST",
    body: JSON.stringify({ edited: { ...preview } }),
  });
  await waiting;

  assert.equal((await knowledge.listRules(projectId)).length, 0, "an unchanged payload taught nothing");
  assert.equal((await knowledge.listObservations(projectId))[0]?.kind, "approval_clean");
});

test("distillation: the same correction twice corroborates; a different one supersedes", async () => {
  // The distinction the whole module turns on. Storing an identical correction twice costs double
  // the budget and teaches nothing extra. Storing a CONTRADICTORY one twice is worse than having
  // neither: the agent picks one at random and the founder cannot tell which.
  const store = freshStore();
  const edit = (after: string): NewRule[] =>
    distillFromApprovalEdit({
      project_id: "p1", wedge: "books-keeper", task_type: "chase", action: "send_email",
      proposed: { body: "u owe us money" }, edited: { body: after },
    });

  const first = await applyDistilled(store, edit("Hi — the July invoice is now overdue."));
  assert.equal(first[0].outcome, "created");

  const again = await applyDistilled(store, edit("Hi — the July invoice is now overdue."));
  assert.equal(again[0].outcome, "corroborated");
  assert.equal(again[0].rule.id, first[0].rule.id, "the same rule got stronger, it did not clone");
  assert.equal(again[0].rule.corroborations, 2);
  assert.equal((await store.listRules("p1")).length, 1, "one subject, one rule");

  const changed = await applyDistilled(store, edit("Your July invoice is past due — can you settle this week?"));
  assert.equal(changed[0].outcome, "superseded");
  const rows = await store.listRules("p1", { subject: "send_email.body" });
  const active = rows.filter((r) => r.status === "active");
  assert.equal(active.length, 1, "exactly one rule is active on a subject — never two contradicting");
  assert.equal(active[0].id, changed[0].rule.id, "the newer correction wins: it describes the business today");
  const old = rows.find((r) => r.status === "superseded")!;
  assert.equal(old.superseded_by, active[0].id, "the displaced rule is kept and points at its replacement");
  // Kept, not deleted: a founder asking "why did it start doing that?" must be able to reconstruct it.
  assert.equal(old.id, first[0].rule.id);

  // And retrieval only ever sees the live one.
  const got = retrieveRules(rows, ctxFor());
  assert.equal(got.selected.length, 1);
  assert.equal(got.selected[0].id, active[0].id);
});

test("distillation: a correction on a covered subject counts against the rule that already claimed it", async () => {
  // The failure mode nobody instruments: "rules learned" goes up and the agent is exactly as wrong
  // as it was. `corrections_since` is the honest per-rule measurement, and it has to be attributed
  // to the OLD rule — attributing it to the rule the correction just created would flatter every
  // rule in the table.
  const store = freshStore();
  const edit = (after: string) =>
    distillFromApprovalEdit({
      project_id: "p1", wedge: "books-keeper", task_type: "chase", action: "send_email",
      proposed: { body: "draft" }, edited: { body: after },
    });
  const [created] = await applyDistilled(store, edit("v1"));
  await applyDistilled(store, edit("v2"));

  const superseded = (await store.listRules("p1")).find((r) => r.id === created.rule.id)!;
  assert.equal(superseded.corrections_since, 1, "the rule that was in force when it went wrong wears it");
  const replacement = (await store.listRules("p1")).find((r) => r.status === "active")!;
  assert.equal(replacement.corrections_since, 0, "a brand-new rule has not failed at anything yet");
});

test("retrieval: the budget is hard, and a prohibition is never dropped for a style note", async () => {
  // runtime.ts says the prompt is a cost decision. A budget that is a suggestion is not a budget —
  // and what it drops has to be principled, or a tone note can silently evict "never email this
  // client after 6pm".
  const prefers = Array.from({ length: 40 }, (_, i) =>
    ruleOf({ id: `pref-${i}`, kind: "prefer", subject: `send_email.f${i}`, text: "x".repeat(300) }),
  );
  const prohibition = ruleOf({
    id: "never-1",
    kind: "never",
    subject: "send_email.after_hours",
    text: "Never email this client after 6pm.",
    // Deliberately the OLDEST and least corroborated rule in the set: on relevance alone it loses.
    updated_at: "2020-01-01T00:00:00.000Z",
    created_at: "2020-01-01T00:00:00.000Z",
  });

  const budget = { ...DEFAULT_RULE_BUDGET, max_chars: 2000 };
  const got = retrieveRules([...prefers, prohibition], ctxFor(), budget);

  assert.ok(got.chars <= budget.max_chars, `budget respected (${got.chars} <= ${budget.max_chars})`);
  assert.ok(got.selected.length < 41, "it did not take everything");
  assert.ok(got.dropped > 0, "and it says how much it left behind rather than truncating silently");
  assert.equal(got.considered, 41);
  assert.ok(
    got.selected.some((r) => r.id === "never-1"),
    "the prohibition survives a budget that evicts most of the preferences",
  );
  // Rendering order is relevance-first: what the model reads at the top should be what matters most.
  assert.ok(got.markdown.startsWith("- **"), "rendered as a list the agent can read");

  // The count cap is real too, independently of characters.
  const capped = retrieveRules([...prefers, prohibition], ctxFor(), { ...DEFAULT_RULE_BUDGET, max_rules: 5 });
  assert.equal(capped.selected.length, 5);
});

test("retrieval: a rule reaches the prompt only for the tenant, client and task type it was learned on", async () => {
  // Four exclusions, each one a correctness boundary rather than a ranking preference. The first is
  // the one that already burned this system: `listKnowledge` gained a required projectId after the
  // old version leaked every tenant's knowledge into every sandbox.
  const mine = ruleOf({ id: "mine" });
  const otherTenant = ruleOf({ id: "other-tenant", project_id: "p2" });
  const otherWedge = ruleOf({ id: "other-wedge", wedge: "recruiter" });
  const otherClient = ruleOf({ id: "other-client", client_id: "northwind" });
  const otherTaskType = ruleOf({ id: "other-task", task_types: ["monthly_summary"] });
  const houseWide = ruleOf({ id: "house", task_types: [] });
  const dead = ruleOf({ id: "dead", status: "superseded" });
  const all = [mine, otherTenant, otherWedge, otherClient, otherTaskType, houseWide, dead];

  const got = retrieveRules(all, ctxFor());
  assert.deepEqual(got.selected.map((r) => r.id).sort(), ["house", "mine"]);

  // On Northwind's own work the exception applies — and outranks the house rule, because the
  // exception is the expertise.
  const forClient = retrieveRules(all, ctxFor({ client_id: "northwind" }));
  assert.deepEqual(forClient.selected.map((r) => r.id).sort(), ["house", "mine", "other-client"]);
  assert.equal(forClient.selected[0].id, "other-client", "the client-specific rule leads");

  // Fail closed: no project named, nothing retrieved. Never "it had no owner, so anyone can have it".
  assert.equal(retrieveRules(all, ctxFor({ project_id: "" })).selected.length, 0);
});

test("retrieval: a rule distilled for one client is never inlined into another client's run", async () => {
  // THE BUG: `ruleApplies` excluded a rule only when it NAMED a different client, so a rule whose
  // attribution was missing applied to everybody — and a rule is worse than a knowledge file here,
  // because a file is offered and a rule is inlined into the prompt as a standing instruction that
  // quotes the founder's own words about one client.
  const forA = ruleOf({
    id: "for-a",
    ...({ sensitivity: "client", client_id: "northwind" } as const),
    text: "Northwind settle at 60 days and asked us not to chase before then.",
  });
  const unattributed = ruleOf({ id: "unattributed", sensitivity: "client" });

  const atB = retrieveRules([forA, unattributed], ctxFor({ client_id: "acme" }));
  assert.deepEqual(atB.selected.map((r) => r.id), [], "client A's lesson does not reach client B");
  assert.ok(!atB.markdown.includes("Northwind"), "and its text is nowhere in what B's prompt would say");

  const atA = retrieveRules([forA, unattributed], ctxFor({ client_id: "northwind" }));
  assert.deepEqual(atA.selected.map((r) => r.id), ["for-a"], "on A's own work it applies, and the unowned one still does not");

  // No client on the run at all — a house-wide job — must not be a way to read everything either.
  assert.deepEqual(retrieveRules([forA, unattributed], ctxFor()).selected.map((r) => r.id), []);
});

test("retrieval: an unlabelled legacy rule reaches nobody until something says whose lesson it was", async () => {
  // The migration decision already made for knowledge files, applied to rules: unlabelled legacy
  // goes dark, not public. A house rule that goes dark costs one worse draft; a client rule that
  // goes public is a disclosure, and nothing recovers that. `sensitivity` is deleted here rather
  // than set, because that is exactly the shape of a row written before the field existed.
  const legacy = ruleOf({ id: "legacy" });
  delete (legacy as { sensitivity?: string }).sensitivity;

  assert.deepEqual(retrieveRules([legacy], ctxFor()).selected.map((r) => r.id), []);
  assert.deepEqual(retrieveRules([legacy], ctxFor({ client_id: "northwind" })).selected.map((r) => r.id), []);
  assert.equal(retrieveRules([legacy], ctxFor()).considered, 0, "not merely budgeted out — never eligible");

  // Relabelled by hand, it comes back. Going dark has to be recoverable or it is data loss.
  assert.deepEqual(
    retrieveRules([{ ...legacy, sensitivity: "house" as const }], ctxFor()).selected.map((r) => r.id),
    ["legacy"],
  );
});

test("distillation: every write site labels the rule, so a new row is never the unlabelled shape", async () => {
  // The leak had two halves. `ruleApplies` was one; the other is a write site that records a
  // client's lesson without saying it is a client's lesson. If a distiller ever stops calling
  // `scopeMeta`, its rows land in the legacy shape and go dark — this fails loudly instead.
  const forClient = distillFromApprovalEdit({
    project_id: "p1", wedge: "books-keeper", task_type: "chase", client_id: "northwind",
    action: "send_email", proposed: { body: "u owe us" }, edited: { body: "The July invoice is overdue." },
  });
  assert.ok(forClient.length > 0);
  for (const r of forClient) {
    assert.equal(r.sensitivity, "client", "work for a named client teaches a client-scoped lesson");
    assert.equal(r.client_id, "northwind");
  }

  const houseWide = distillFromApprovalEdit({
    project_id: "p1", wedge: "books-keeper", task_type: "chase",
    action: "send_email", proposed: { body: "u owe us" }, edited: { body: "The July invoice is overdue." },
  });
  for (const r of houseWide) assert.equal(r.sensitivity, "house", "no client on the work, so it is about the business");

  // And the label survives the round trip through a store, which is where a dropped column shows up.
  const store = freshStore();
  const [rec] = await applyDistilled(store, forClient.slice(0, 1));
  const stored = (await store.listRules("p1")).find((r) => r.id === rec.rule.id)!;
  assert.equal(stored.sensitivity, "client");
  assert.deepEqual(retrieveRules([stored], ctxFor({ client_id: "acme" })).selected, [], "and it is unreadable at another client");
});

test("uses: counted for the rules that reached the prompt, and only those", async () => {
  // Without this you cannot tell "the rule was wrong" from "the rule was never read" — a knowledge
  // bug from a retrieval bug — and those need opposite fixes.
  const store = freshStore();
  const fits = ruleOf({ id: "fits", kind: "never", text: "short" });
  const alsoFits = ruleOf({ id: "also", kind: "always", text: "short too" });
  const tooBig = ruleOf({ id: "big", kind: "prefer", text: "x".repeat(5000) });
  const otherTenant = ruleOf({ id: "theirs", project_id: "p2" });
  for (const r of [fits, alsoFits, tooBig, otherTenant]) await store.putRule(r);

  const g = await groundRun(store, {
    ctx: ctxFor(),
    files: [],
    ruleBudget: { ...DEFAULT_RULE_BUDGET, max_chars: 300 },
  });
  assert.deepEqual(g.rules.selected.map((r) => r.id).sort(), ["also", "fits"]);

  const after = new Map((await store.listRules("p1")).map((r) => [r.id, r.uses]));
  assert.equal(after.get("fits"), 1);
  assert.equal(after.get("also"), 1);
  assert.equal(after.get("big"), 0, "budgeted out — so it was never read, and must not look read");
  // The other tenant's rule was never even a candidate, and its counter proves the read was scoped.
  assert.equal((await store.listRules("p2"))[0].uses, 0);

  // Second run, second use. A counter that only ever reaches 1 cannot distinguish a rule that fires
  // on every job from one that fired once in March.
  await groundRun(store, { ctx: ctxFor(), files: [], ruleBudget: { ...DEFAULT_RULE_BUDGET, max_chars: 300 } });
  assert.equal((await store.listRules("p1")).find((r) => r.id === "fits")!.uses, 2);
});

test("retrieval: knowledge files are ranked and capped, not mounted wholesale", async () => {
  // The O(business history) mount this replaces: every file this tenant ever accumulated, on every
  // run, forever — with no notion of relevance, so the one note that governs this job arrives buried.
  const store = freshStore();
  const files = [
    // No created_at → the wedge's own on-disk knowledge. Pinned: it is part of the product, not
    // runtime data, and a wedge that behaves differently depending on how much a customer has used
    // it is not a wedge.
    { name: "playbook.md", content: "# how we chase" },
    ...Array.from({ length: 30 }, (_, i) => ({
      name: `old-${i}.md`,
      content: `note ${i}`,
      created_at: "2024-01-01T00:00:00.000Z",
      kind: "document",
      source: "uploaded",
      // Explicitly `house`: these are notes about the business. They have to say so now — an
      // unlabelled live row is retrievable by nobody, which the sensitivity tests below assert.
      metadata: { sensitivity: "house" },
    })),
    {
      name: "this-client.md",
      content: "northwind wants friday summaries",
      created_at: "2025-12-20T00:00:00.000Z",
      kind: "correction",
      source: "feedback",
      metadata: { sensitivity: "client", client_id: "northwind", task_type: "chase" },
    },
    {
      name: "someone-elses-client.md",
      content: "acme pays on the 30th",
      created_at: "2025-12-28T00:00:00.000Z",
      metadata: { sensitivity: "client", client_id: "acme" },
    },
  ];

  const g = await groundRun(store, {
    ctx: ctxFor({ client_id: "northwind" }),
    files,
    fileBudget: { max_files: 5, max_bytes: 1_000_000 },
  });
  const names = g.files.map((f) => f.name);
  assert.equal(names.length, 5, "the cap is real");
  assert.ok(g.omitted_files > 0, "and what it left out is counted, not hidden");
  assert.ok(names.includes("playbook.md"), "the wedge's own knowledge is never dropped");
  assert.ok(names.includes("this-client.md"), "this client's correction outranks 30 stale notes");
  assert.ok(
    !names.includes("someone-elses-client.md"),
    "another client's file is excluded outright, at any budget",
  );
});

test("recurrence: the same gap three times is a missing rule; answering it retires the question", async () => {
  // Every one of those hits was a real job completed on a stated assumption instead of on fact.
  const store = freshStore();
  const gaps = [
    { id: "gap:late-payment-fee", question: "What is the late-payment fee?", hits: 3, task_ids: ["t1", "t2", "t3"], status: "open" },
    { id: "gap:asked-once", question: "Which bank?", hits: 1, task_ids: ["t4"], status: "open" },
    { id: "gap:dismissed", question: "irrelevant", hits: 9, task_ids: [], status: "dismissed" },
  ];
  const before = detectRecurrence(gaps, []);
  assert.deepEqual(before.map((s) => s.subject), ["gap:late-payment-fee"]);
  assert.equal(before[0].kind, "unanswered_gap");
  assert.equal(before[0].occurrences, 3);
  assert.deepEqual(before[0].task_ids, ["t1", "t2", "t3"], "the jobs it cost, so the founder sees what it bought");

  // Answering it writes a rule whose SUBJECT IS THE GAP ID — that identity is the only reason the
  // loop can ever close. Before it existed, an answer wrote a markdown file and the counter climbed
  // forever.
  const { recordGapAnswer } = await import("../src/knowledge");
  const { rule } = await recordGapAnswer(store, {
    project_id: "p1",
    wedge: "books-keeper",
    question_id: "gap:late-payment-fee",
    question: "What is the late-payment fee?",
    answer: "$45 after 14 days.",
  });
  assert.ok(rule, "the answer became a rule");
  assert.equal(rule!.subject, "gap:late-payment-fee");
  assert.equal(rule!.kind, "fact", "an answer is a fact about the business, not an instruction");
  // The onboarding flag defaults OFF. A gap answered from the Knowledge page after a real run is
  // observed evidence, and the arrival of a weaker sibling source must not have demoted it.
  assert.equal(rule!.provenance.source, "gap_answer");

  const after = detectRecurrence(gaps, await store.listRules("p1"));
  assert.equal(after.length, 0, "answered once, and it stops being asked");
});

test("recurrence: a rule that exists and is still being corrected is escalated, not accumulated", async () => {
  // "Rules learned" going up while the agent stays exactly as wrong is the metric everybody has and
  // nobody instruments. A rule with corrections against it is badly worded or never retrieved, and
  // both need a human rather than another row.
  const failing = ruleOf({ id: "failing", corrections_since: 4, uses: 12 });
  const [signal, ...rest] = detectRecurrence([], [failing]);
  assert.equal(rest.length, 0);
  assert.equal(signal.kind, "ineffective_rule");
  assert.equal(signal.rule_id, "failing");
  assert.equal(signal.occurrences, 4);
  // `uses` is what makes the diagnosis possible: 12 uses and 4 corrections is a wrong rule; 0 uses
  // and 4 corrections would be a retrieval bug wearing the same face.
  assert.ok(signal.previous_answers.length, "with what was said last time, so answering can retire it");
});

test("api: the rules a project has learned are readable, and scoped to that project", async () => {
  const store = freshStore();
  const { app } = makeApp();
  const projectId = (await api(app, "me")).json.projects[0].id;
  const other = freshProjectId("other");
  await store.putRule(ruleOf({ id: "ours", project_id: projectId }));
  await store.putRule(ruleOf({ id: "theirs", project_id: other }));

  const res = await api(app, "wedges/books-keeper/rules");
  assert.equal(res.status, 200);
  const ids = (res.json as Rule[]).map((r) => r.id);
  assert.deepEqual(ids, ["ours"], "another tenant's judgement is not readable here");
});
