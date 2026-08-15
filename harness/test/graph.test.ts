// The ontology graph and grounded answering.
//
// Two modules, one test file, because they share one fixture and one threat model. graph.ts walks
// every noun in the business and ask.ts turns a free-text question into an answer over all of them —
// which makes this the widest read surface in the product and therefore the one where a scoping bug
// is not a leaked table but a leaked business.
//
// Every test below names the bug it prevents. The shape is the shape brain.test.ts and moves.test.ts
// use, deliberately: two tenants exist, and the assertions are about what the SECOND one's rows do
// to the first one's answers. A traversal test seeded with one tenant proves nothing, because each
// expansion block applies the authority itself and that repetition is exactly what drifts.
import { getDeliverableStore } from "../src/deliverables";
import { writeMoneyPlan } from "../src/money-plan";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getDomainStore } from "../src/domain";
import { getBillingStore } from "../src/billing";
import { getRequestStore } from "../src/requests";
import { getKnowledgeStore } from "../src/knowledge.store";
import { InMemoryStore } from "../src/store";
import { deriveAuthority, founderAuthority } from "../src/brain";
import { founderMoveAuthority, deriveMoveAuthority } from "../src/moves";
import {
  MAX_DEPTH,
  MAX_FANOUT,
  MAX_NODES,
  graphAuthorityFromBrain,
  graphAuthorityFromMove,
  neighbourhood,
  nodeOf,
  type GraphStores,
} from "../src/graph";
import { ask, questionTerms, validateComposed, MAX_FACTS, type AskStores, type Fact } from "../src/ask";
// The write path that seeds a verdict, so the arm wire convention is exercised rather than restated.
import { storeBatch } from "../src/insight/store";
import type { Task } from "../src/contract";

const WEDGE = "books-keeper";

const taskStore = new InMemoryStore();

const graphStores = (): GraphStores => ({
  domain: getDomainStore(),
  billing: getBillingStore(),
  requests: getRequestStore(),
  deliverables: getDeliverableStore(),
  tasks: taskStore,
});

const askStores = (): AskStores => ({
  domain: getDomainStore(),
  billing: getBillingStore(),
  requests: getRequestStore(),
  deliverables: getDeliverableStore(),
  knowledge: getKnowledgeStore(),
  tasks: taskStore,
});

function taskOf(p: Partial<Task>): Task {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    wedge: WEDGE,
    task_type: "chase_invoice",
    actor: { kind: "system", id: "harness" },
    input: {},
    constraints: { max_runtime_s: 300, max_cost_usd: 1, approval_required: false },
    tools: [],
    status: "succeeded",
    cost_usd: 0,
    created_at: now,
    updated_at: now,
    ...p,
  } as Task;
}

/**
 * One tenant with one of everything the graph can walk, wired the way the product wires it:
 * client → case → {thread → message, invoice → chase, request, task → artifact}.
 *
 * Every relationship here is a real foreign key. Nothing in the fixture writes an edge, because
 * nothing in the product does — that IS the property under test.
 */
async function seed(projectId: string, label: string) {
  const domain = getDomainStore();
  const billing = getBillingStore();
  const requests = getRequestStore();
  const knowledge = getKnowledgeStore();

  const client = await domain.createClient({
    project_id: projectId,
    display_name: `${label} Ltd`,
    handles: [`${label}-${randomUUID().slice(0, 8)}@example.com`],
    metadata: {},
  } as never);

  const kase = await domain.createCase({
    project_id: projectId,
    wedge: WEDGE,
    title: `${label} October close`,
    client_id: client.id,
    stage: "open",
    status: "open",
    // A money PROMISE on the case: a paid deposit plus an active monthly retainer. The graph should
    // surface this on the case node, derived from case.data — never as a separate stored edge.
    data: writeMoneyPlan(
      {},
      {
        currency: "USD",
        lines: [
          { id: "l1", label: "Deposit", amount_minor: 50000, kind: "deposit", status: "paid" },
          {
            id: "l2",
            label: "Monthly retainer",
            amount_minor: 120000,
            kind: "retainer",
            status: "planned",
            recurrence: { every: "month", interval: 1, anchor: "2026-01-01", state: "active" },
          },
        ],
      },
    ),
  });

  const invoice = await billing.createInvoice({
    project_id: projectId,
    client_id: client.id,
    case_id: kase.id,
    currency: "USD",
    status: "sent",
    due_date: "2000-01-01", // long past ⇒ effectiveStatus says overdue
    // `quantity_milli`, not `quantity`: thousandths of a unit (billing.ts). A line with the wrong
    // key totals to zero, which silently makes every money assertion in this file vacuous.
    lines: [{ description: `${label} bookkeeping`, kind: "fixed", quantity_milli: 1000, unit_amount: 125000 }],
  } as never);

  const thread = await domain.findOrCreateThread(client.id, "ch", projectId, `${label} kickoff`, kase.id);
  const message = await domain.addMessage({
    thread_id: thread.id,
    direction: "inbound",
    author: client.id,
    body: `${label} secret sentence about the ledger`,
  } as never);

  const request = await requests.createRequest({
    project_id: projectId,
    client_id: client.id,
    case_id: kase.id,
    kind: "document",
    ask: `${label} March bank statement`,
  } as never);

  // A chase run: `Task.input.invoice_id` is the key `chaseTaskInput` writes, and it is the only
  // thing joining a chase to the invoice it chased.
  const chase = await taskStore.createTask(
    taskOf({
      project_id: projectId,
      client_id: client.id,
      case_id: kase.id,
      input: { invoice_id: invoice.id },
    }),
  );
  const artifact = await taskStore.addArtifact({
    task_id: chase.id,
    name: `${label}-chase.pdf`,
    content_type: "application/pdf",
    content: "x",
  } as never);

  // The outbound half: a document deliverable this case shipped. Its only tie to the case is
  // `Deliverable.case_id` — the FK the `case.deliverables` edge is derived from.
  const deliverable = await getDeliverableStore().createDeliverable({
    project_id: projectId,
    case_id: kase.id,
    client_id: client.id,
    title: `${label} October close pack`,
    kind: "document",
  });

  await knowledge.putRule({
    project_id: projectId,
    wedge: WEDGE,
    task_types: [],
    subject: "send_email.subject",
    text: `${label} rule: keep chase subjects short`,
    kind: "preference",
    sensitivity: "house",
    provenance: {},
  } as never);

  return { client, kase, invoice, thread, message, request, chase, artifact, deliverable };
}

/** The founder's own authorities over one project — exactly what `POST /v1/ask` builds. */
async function founderAuths(projectId: string) {
  const domain = getDomainStore();
  const clients = (await domain.listClients()).filter((c) => c.project_id === projectId);
  const cases = await domain.listCases({ project_id: projectId });
  return {
    brain: founderAuthority({
      project_id: projectId,
      wedge: WEDGE,
      client_ids: clients.map((c) => c.id),
      case_ids: cases.map((k) => k.id),
    }),
    moves: founderMoveAuthority({
      project_id: projectId,
      wedges: [...new Set(cases.map((k) => k.wedge))],
      client_ids: clients.map((c) => c.id),
      case_ids: cases.map((k) => k.id),
    }),
  };
}

// ── the authority ─────────────────────────────────────────────────────────────

/**
 * PREVENTS: a fourth "just pass the project id" scope constructor.
 *
 * graph.ts exports no function that takes a project id. If one is ever added, this test still passes
 * — but the assertion below is the documentation of the rule, and the module has no other entry.
 */
test("GraphAuthority can only be minted from an already-derived authority", () => {
  const brain = deriveAuthority(taskOf({ project_id: "p", client_id: "c1", case_id: "k1" }))!;
  const g = graphAuthorityFromBrain(brain);
  assert.equal(g.project_id, "p");
  // ONE wedge on the run plane, because the source authority has one. Widening here would be
  // inventing a scope the source never granted.
  assert.deepEqual([...g.wedges], [WEDGE]);
  assert.deepEqual([...g.client_ids], ["c1"]);

  const move = deriveMoveAuthority(taskOf({ project_id: "p", client_id: "c1" }))!;
  assert.deepEqual([...graphAuthorityFromMove(move).client_ids], ["c1"]);
});

/**
 * PREVENTS: the "empty means all" family, arriving in a third module.
 *
 * A house-wide run (no client) must read NO client-owned row, not every one of them.
 */
test("a house-wide authority reads no client-owned node", async () => {
  const pid = randomUUID();
  const { client, kase } = await seed(pid, "house");
  const house = graphAuthorityFromBrain(deriveAuthority(taskOf({ project_id: pid }))!);

  assert.equal(await nodeOf(graphStores(), house, { kind: "client", id: client.id }), undefined);
  assert.equal(await nodeOf(graphStores(), house, { kind: "case", id: kase.id }), undefined);
});

// ── traversal ─────────────────────────────────────────────────────────────────

/**
 * PREVENTS: the six-queries-and-a-human-join problem. This is the feature.
 */
test("one read returns the situation: client → cases → threads → messages, and → invoices → chases", async () => {
  const pid = randomUUID();
  const s = await seed(pid, "acme");
  const auths = await founderAuths(pid);
  const g = graphAuthorityFromMove(auths.moves);

  const hood = (await neighbourhood(graphStores(), g, { kind: "client", id: s.client.id }))!;
  assert.ok(hood, "the client is reachable");
  const ids = new Set(hood.nodes.map((n) => `${n.kind}:${n.id}`));

  assert.ok(ids.has(`case:${s.kase.id}`), "the engagement");
  assert.ok(ids.has(`thread:${s.thread.id}`), "the conversation about it");
  assert.ok(ids.has(`message:${s.message.id}`), "what was said");
  assert.ok(ids.has(`invoice:${s.invoice.id}`), "what it billed");
  assert.ok(ids.has(`request:${s.request.id}`), "what we are waiting on from them");
  assert.ok(ids.has(`task:${s.chase.id}`), "the chase that ran");
  assert.ok(ids.has(`deliverable:${s.deliverable.id}`), "the WORK it shipped — the fulfilment half");

  // The edges exist and every one of them names a real relationship.
  const rels = new Set(hood.edges.map((e) => e.rel));
  for (const rel of ["client.cases", "case.threads", "thread.messages", "case.invoices", "case.requests", "case.deliverables"]) {
    assert.ok(rels.has(rel as never), `edge ${rel} was derived`);
  }

  // The allowlist holds: a deliverable node carries state, never its version list or artifact ids.
  const del = hood.nodes.find((n) => n.kind === "deliverable")!;
  assert.equal(del.facts.status, "drafting");
  assert.equal(del.facts.kind, "document");
  assert.ok(!("artifact_ids" in del.facts) && !("versions" in del.facts), "no plane-crossing fields leak into the graph");

  // The money PROMISE is now visible on the case node, derived from case.data.money_plan.
  const caseN = hood.nodes.find((n) => n.kind === "case")!;
  assert.equal(caseN.facts.plan_total_minor, 170000, "deposit + retainer");
  assert.equal(caseN.facts.plan_paid_minor, 50000, "the deposit is paid");
  assert.equal(caseN.facts.plan_outstanding_minor, 120000, "the retainer is still owed");
  assert.equal(caseN.facts.retainer, "active", "the retainer state is on the case");
});

/**
 * PREVENTS: an edge table that disagrees with the rows.
 *
 * Re-pointing the FK must change the graph immediately, with no write to any edge store — because
 * there is no edge store. `updateCase` re-points `client_id` when a prospect converts, and nothing
 * in the product tells a graph about it.
 */
test("edges are derived: changing the foreign key changes the graph with no edge write", async () => {
  const pid = randomUUID();
  const s = await seed(pid, "derive");
  const other = await getDomainStore().createClient({
    project_id: pid,
    display_name: "Converted Ltd",
    handles: [`conv-${randomUUID().slice(0, 8)}@example.com`],
    metadata: {},
  } as never);

  let auths = await founderAuths(pid);
  let g = graphAuthorityFromMove(auths.moves);
  let hood = (await neighbourhood(graphStores(), g, { kind: "client", id: s.client.id }))!;
  assert.ok(hood.nodes.some((n) => n.kind === "case" && n.id === s.kase.id));

  await getDomainStore().updateCase(s.kase.id, { client_id: other.id });

  auths = await founderAuths(pid);
  g = graphAuthorityFromMove(auths.moves);
  hood = (await neighbourhood(graphStores(), g, { kind: "client", id: s.client.id }))!;
  assert.ok(!hood.nodes.some((n) => n.kind === "case" && n.id === s.kase.id), "the old owner lost it");

  const moved = (await neighbourhood(graphStores(), g, { kind: "client", id: other.id }))!;
  assert.ok(moved.nodes.some((n) => n.kind === "case" && n.id === s.kase.id), "the new owner has it");
});

/**
 * PREVENTS: an unbounded traversal on a busy client becoming an unbounded response — a browser
 * hang, and a model context bill, from one HTTP request.
 */
test("traversal is bounded by depth, node count AND fan-out, all at once", async () => {
  const pid = randomUUID();
  const s = await seed(pid, "busy");
  // A thread with far more messages than the fan-out allows.
  for (let i = 0; i < MAX_FANOUT * 4; i++) {
    await getDomainStore().addMessage({
      thread_id: s.thread.id,
      direction: "inbound",
      author: s.client.id,
      body: `noise ${i}`,
    } as never);
  }
  const auths = await founderAuths(pid);
  const g = graphAuthorityFromMove(auths.moves);

  const hood = (await neighbourhood(graphStores(), g, { kind: "client", id: s.client.id }))!;
  assert.ok(hood.nodes.length <= MAX_NODES, "node cap holds");
  assert.ok(hood.depth <= MAX_DEPTH, "depth cap holds");
  const messages = hood.nodes.filter((n) => n.kind === "message");
  assert.ok(messages.length <= MAX_FANOUT, `fan-out cap holds (${messages.length})`);
  assert.equal(hood.truncated, true, "and it SAYS it is a slice");

  // Asking for more than the ceiling does not get more than the ceiling.
  const greedy = (await neighbourhood(graphStores(), g, { kind: "client", id: s.client.id }, {
    depth: 99,
    maxNodes: 100_000,
  }))!;
  assert.ok(greedy.nodes.length <= MAX_NODES);
  assert.ok(greedy.depth <= MAX_DEPTH);
});

/**
 * PREVENTS: the leak this whole file exists for. Another tenant's client must be indistinguishable
 * from a client that does not exist.
 */
test("another tenant's entities are unreachable and read exactly like a non-existent id", async () => {
  const mine = randomUUID();
  const theirs = randomUUID();
  await seed(mine, "mine");
  const t = await seed(theirs, "theirs");

  const auths = await founderAuths(mine);
  const g = graphAuthorityFromMove(auths.moves);

  for (const ref of [
    { kind: "client", id: t.client.id },
    { kind: "case", id: t.kase.id },
    { kind: "invoice", id: t.invoice.id },
    { kind: "request", id: t.request.id },
    { kind: "thread", id: t.thread.id },
    { kind: "task", id: t.chase.id },
  ] as const) {
    assert.equal(await nodeOf(graphStores(), g, ref), undefined, `${ref.kind} is invisible`);
    assert.equal(await neighbourhood(graphStores(), g, ref), undefined, `${ref.kind} has no neighbourhood`);
    // The same answer as a uuid nobody ever created — the refusal itself discloses nothing.
    assert.equal(await neighbourhood(graphStores(), g, { kind: ref.kind, id: randomUUID() }), undefined);
  }
});

/**
 * PREVENTS: a traversal returning the row.
 *
 * `Invoice.internal_note` never crosses a client plane and `ClientRequest.task_id` is founder-plane
 * only. A node is an allowlist of scalars; if someone widens it to spread the row, this fails.
 */
test("a node carries an allowlist of facts, never the row", async () => {
  const pid = randomUUID();
  const s = await seed(pid, "allow");
  await getBillingStore().updateInvoice(s.invoice.id, { internal_note: "DO-NOT-DISCLOSE" } as never);
  const auths = await founderAuths(pid);
  const g = graphAuthorityFromMove(auths.moves);

  const node = (await nodeOf(graphStores(), g, { kind: "invoice", id: s.invoice.id }))!;
  const serialised = JSON.stringify(node);
  assert.ok(!serialised.includes("DO-NOT-DISCLOSE"), "the operator's private note is not in the graph");
  assert.ok(serialised.includes("outstanding_minor"), "but the money fact a founder asked for is");
});

// ── grounded answering ────────────────────────────────────────────────────────

/**
 * PREVENTS: an answer with neither citations nor an honest refusal — the failure mode vision.md
 * names explicitly. Every path through `ask` must produce one or the other.
 */
test("an answer always carries citations, or says it cannot answer", async () => {
  const pid = randomUUID();
  const s = await seed(pid, "cite");
  const auths = await founderAuths(pid);

  const answered = await ask(askStores(), auths, "what is going on with cite ltd");
  assert.ok(answered.cited.length > 0, "it cited what it read");
  assert.equal(answered.insufficient, undefined);
  assert.ok(answered.answer.length > 0);
  // Every citation is a real id the UI can link to, not a plausible-looking string.
  const real = new Set([s.client.id, s.kase.id, s.invoice.id, s.thread.id, s.message.id, s.request.id, s.chase.id]);
  assert.ok(answered.cited.some((c) => real.has(c.id)), "at least one citation names a seeded row");

  const empty = await ask(askStores(), auths, "");
  assert.equal(empty.answer, "");
  assert.ok(empty.insufficient, "an empty question refuses rather than improvising");
});

/**
 * PREVENTS: THE leak. A question about another tenant's client must return nothing, and must be
 * indistinguishable from a question about a client that does not exist.
 *
 * This is the highest-risk assertion in the file: the question is free text, so nothing stops a
 * founder typing a rival's company name — and the answer must not confirm they exist, that we work
 * for them, or what they owe.
 */
test("a question about another tenant's client returns nothing about them", async () => {
  const mine = randomUUID();
  const theirs = randomUUID();
  await seed(mine, "aaa");
  const t = await seed(theirs, "zzz-victim");
  const auths = await founderAuths(mine);

  const named = await ask(askStores(), auths, "what is going on with zzz-victim ltd and their invoice");
  const blob = JSON.stringify(named);
  assert.ok(!blob.includes(t.client.id), "no id of theirs");
  assert.ok(!blob.includes(t.invoice.id), "no invoice of theirs");
  assert.ok(!blob.includes(t.kase.id), "no engagement of theirs");
  assert.ok(!blob.toLowerCase().includes("zzz-victim ltd"), "not even their name back at them");
  assert.ok(!blob.includes("zzz-victim secret sentence"), "and nothing they said");

  // And a client that never existed reads the SAME WAY. If naming a real-but-forbidden client
  // produced a different shape of response than naming a fictional one — a different refusal, a
  // different `unseen` — the response itself would be an existence oracle: type company names until
  // the answer changes.
  const fictional = await ask(askStores(), auths, "what is going on with qqq-nobody ltd and their invoice");
  assert.equal(!!named.insufficient, !!fictional.insufficient, "same refusal or non-refusal");
  assert.equal(named.unseen, fictional.unseen, "same withheld count");
  assert.ok(!JSON.stringify(fictional).includes(t.client.id));
});

/**
 * PREVENTS: `unseen` becoming a disclosure channel.
 *
 * It exists so an answer can say "there are 3 more you cannot see". The moment it carries an id, a
 * name or a title, it says WHICH three — which is the leak it was invented to avoid.
 */
test("unseen is a count only and leaks no identifier", async () => {
  const pid = randomUUID();
  const s = await seed(pid, "unseen");
  // A house-wide RUN authority: it may read no client-owned row, so everything is excluded.
  const auths = {
    brain: deriveAuthority(taskOf({ project_id: pid }))!,
    moves: deriveMoveAuthority(taskOf({ project_id: pid }))!,
  };
  const res = await ask(askStores(), auths, "which clients owe me money");

  assert.equal(typeof res.unseen, "number");
  assert.ok(res.unseen > 0, "it knows it was kept from things");
  const blob = JSON.stringify(res);
  assert.ok(!blob.includes(s.client.id));
  assert.ok(!blob.includes(s.invoice.id));
  assert.ok(!blob.toLowerCase().includes("unseen ltd"));
});

/**
 * PREVENTS: a client-scoped fact surfacing in a house-wide answer.
 *
 * A run with no client is the tightest scope, not the widest. This is the same property
 * brain.test.ts asserts for retrieval, re-asserted through the answering surface, because ask.ts
 * joins three authorities and a regression in any one of them shows up here first.
 */
test("a client-scoped fact does not surface in a house-wide answer", async () => {
  const pid = randomUUID();
  await seed(pid, "scoped");
  const house = {
    brain: deriveAuthority(taskOf({ project_id: pid }))!,
    moves: deriveMoveAuthority(taskOf({ project_id: pid }))!,
  };
  const res = await ask(askStores(), house, "scoped secret sentence about the ledger");
  const blob = JSON.stringify(res);
  assert.ok(!blob.includes("secret sentence"), "the client's message stayed inside the client scope");
  assert.ok(!blob.toLowerCase().includes("scoped ltd"));
});

/**
 * PREVENTS: the model asserting past what was retrieved.
 *
 * A fabricated citation marker fails the WHOLE answer closed to the deterministic composer, rather
 * than dropping the bad marker and leaving the fabricated sentence standing with no citation at all
 * — reading exactly like every other sentence.
 */
test("a fabricated citation discards the entire model answer", () => {
  const facts: Fact[] = [
    { n: 1, text: "invoice INV-1 is overdue", cite: { source: "invoices", id: "i1", label: "INV-1" } },
  ];
  assert.equal(validateComposed("Acme owes you $900 [F1].", facts)?.cited.length, 1);
  // F9 was never retrieved. The sentence attached to it is the invented one.
  assert.equal(validateComposed("Acme owes you $900 [F1] and Globex owes $2,000 [F9].", facts), undefined);
  // No markers at all is also a refusal: an uncited paragraph is prose, not an answer.
  assert.equal(validateComposed("Everything looks fine.", facts), undefined);
  // The marker is stripped from what the founder reads — internal indexing is not their UI.
  assert.ok(!validateComposed("Acme owes you $900 [F1].", facts)!.answer.includes("[F1]"));
});

/**
 * PREVENTS: a feature that goes dark exactly when the founder needs it.
 *
 * If LiteLLM is unconfigured, over budget, slow, or throws, there must still be a grounded answer.
 */
test("composition degrades to deterministic when the model is unavailable, and still cites", async () => {
  const pid = randomUUID();
  await seed(pid, "degrade");
  const auths = await founderAuths(pid);

  const broken = await ask(askStores(), auths, "what is going on with degrade ltd", {
    compose: async () => {
      throw new Error("litellm down");
    },
  });
  assert.ok(broken.cited.length > 0);
  assert.equal(broken.insufficient, undefined);
});

/**
 * PREVENTS: the model being handed the whole business.
 *
 * The fact list is the context bound and therefore the bill bound. It is also the disclosure bound:
 * everything the model can possibly repeat is in this list.
 */
test("the fact list handed to the model is bounded and every fact carries a citation", async () => {
  const pid = randomUUID();
  await seed(pid, "bound");
  for (let i = 0; i < 40; i++) {
    await getDomainStore().upsertRecord({
      project_id: pid,
      wedge: WEDGE,
      collection: "ledger",
      key: `entry-${i}`,
      data: { note: `bound ledger row ${i}` },
    } as never);
  }
  const auths = await founderAuths(pid);
  let seenUser = "";
  await ask(askStores(), auths, "show me the bound ledger", {
    compose: async ({ user }) => {
      seenUser = user;
      return undefined;
    },
  });
  const markers = [...seenUser.matchAll(/^\[F(\d+)\]/gm)];
  assert.ok(markers.length > 0, "facts were supplied");
  assert.ok(markers.length <= MAX_FACTS, `fact list is capped (${markers.length})`);
});

/**
 * PREVENTS: an ANDed query answering a human sentence with nothing.
 *
 * `brain.ask` ANDs its terms, which is right for an agent and wrong for "which clients owe me
 * money" — ANDed, that matches no row in any business, and an empty answer to an answerable
 * question is the worst outcome this module has.
 */
test("question terms are content words, OR-ed, so a plain sentence still retrieves", async () => {
  assert.deepEqual(questionTerms("What is going on with Acme?").includes("acme"), true);
  assert.ok(!questionTerms("what is going on with acme").includes("with"), "stopwords dropped");

  const pid = randomUUID();
  await seed(pid, "orquery");
  const auths = await founderAuths(pid);
  const res = await ask(askStores(), auths, "which clients owe me money on an overdue invoice");
  assert.ok(res.cited.length > 0, "a natural sentence retrieved something");
});

/**
 * PREVENTS: an answer disconnected from action. "Who owes me money" should carry the chase.
 */
test("relevant moves ride along with the answer", async () => {
  const pid = randomUUID();
  const s = await seed(pid, "moves");
  const auths = await founderAuths(pid);
  const res = await ask(askStores(), auths, "who owes me money");
  assert.ok(
    res.moves.some((m) => m.entity.id === s.invoice.id),
    "the overdue invoice's chase is proposed alongside the answer",
  );
  // And it is still bounded — an answer is not a backlog dump.
  assert.ok(res.moves.length <= 5);
});

/**
 * PREVENTS: the one finding that names a file to edit being the one thing `/v1/ask` cannot mention.
 *
 * A `rewrite_losing_arm` move has no client and no entity id that retrieval will ever surface — the
 * marketing page is a property of the project, not a noun with an edge — so it falls through every
 * clause of the relevance filter in ask.ts. Before `isSiteQuestion` existed, asking "how is my site
 * doing" over a business with a DECIDED experiment returned an answer about invoices and dropped the
 * verdict silently.
 */
test("a decided experiment reaches an answer about the site, and carries its citation", async () => {
  const pid = randomUUID();
  // Seeded through `storeBatch` so the arm wire convention is exercised, not restated.
  const events: Array<{ name: string }> = [];
  for (let i = 0; i < 3_000; i++) events.push({ name: "$exposure:hero-a" });
  for (let i = 0; i < 150; i++) events.push({ name: "$convert:hero-a" });
  for (let i = 0; i < 3_000; i++) events.push({ name: "$exposure:hero-b" });
  for (let i = 0; i < 300; i++) events.push({ name: "$convert:hero-b" });
  await storeBatch(getDomainStore(), pid, { events });
  // A client with an overdue invoice too, so this proves the SITE question selects the site move
  // rather than that the list happened to contain one thing.
  await seed(pid, "site-question");

  const auths = await founderAuths(pid);
  const res = await ask(askStores(), auths, "how is my website doing, is the landing page converting");

  const site = res.moves.find((m) => m.kind === "rewrite_losing_arm");
  assert.ok(site, "the decided experiment did not ride along with a question about the site");
  assert.equal(site.entity.id, "hero-a");
  // Grounded: the verdict is a numbered FACT, so a paragraph that mentions it can only do so by
  // pointing at something that was actually read. Driven through an injected composer that cites
  // every fact it is given, because the deterministic fallback only ever cites its first six — a
  // real property of `composeDeterministic`, and not the one this test is about.
  const cited = await ask(askStores(), auths, "how is my website doing, is the landing page converting", {
    compose: async ({ user }) => [...user.matchAll(/\[F(\d+)\]/g)].map((m) => `fact [F${m[1]}]`).join(" "),
  });
  assert.ok(
    cited.cited.some((c) => c.source === "move" && c.id === site.id),
    "the verdict was never offered to the composer as a citable fact",
  );

  // And a question with nothing to do with the site does NOT drag it in — an answer with an
  // unrelated to-do stapled to it is how a useful field becomes noise a founder learns to skip.
  const unrelated = await ask(askStores(), auths, "when did we last speak to that client");
  assert.ok(!unrelated.moves.some((m) => m.kind === "rewrite_losing_arm"));
});

/**
 * PREVENTS: the header chat answering "how many clients do I have" with a fake permission miss.
 *
 * Clients were not a brain source, and the founder chat pinned the first schedule's wedge (often
 * internal machinery). The retrieval matched nothing, counted one unreadable row, and the UI said
 * "Not enough to answer" plus "1 more you don't have access to". Zero clients is an answer. A
 * greeting is an orientation. Neither is a failed search.
 */
test("how many clients is a count, even when the pinned wedge is machinery that holds nothing", async () => {
  const pid = randomUUID();
  const domain = getDomainStore();
  const a = await domain.createClient({
    project_id: pid, display_name: "Northwind", handles: ["north@example.test"], metadata: {},
  });
  const b = await domain.createClient({
    project_id: pid, display_name: "Contoso", handles: ["con@example.test"], metadata: {},
  });
  const auths = {
    brain: founderAuthority({
      project_id: pid,
      wedge: "harness-operator",
      client_ids: [a.id, b.id],
      case_ids: [],
    }),
    moves: founderMoveAuthority({
      project_id: pid, wedges: ["harness-operator"], client_ids: [a.id, b.id], case_ids: [],
    }),
  };
  const res = await ask(askStores(), auths, "How many clients do I have right now?");
  assert.equal(res.insufficient, undefined, "a roster question is never a failed search");
  const blob = `${res.answer} ${res.cited.map((c) => c.label).join(" ")}`.toLowerCase();
  assert.match(blob, /northwind|contoso|2 client/);
});

test("hi is an orientation, not 'not enough to answer'", async () => {
  const pid = randomUUID();
  const domain = getDomainStore();
  const c = await domain.createClient({
    project_id: pid, display_name: "Acme", handles: ["acme@example.test"], metadata: {},
  });
  const auths = {
    brain: founderAuthority({
      project_id: pid, wedge: "", client_ids: [c.id], case_ids: [],
    }),
    moves: founderMoveAuthority({
      project_id: pid, wedges: [], client_ids: [c.id], case_ids: [],
    }),
  };
  const res = await ask(askStores(), auths, "hi");
  assert.equal(res.insufficient, undefined);
  assert.ok(res.cited.length > 0, "a greeting still stands on the roster");
  assert.match(`${res.answer} ${res.cited.map((x) => x.label).join(" ")}`.toLowerCase(), /acme|client/);
});
