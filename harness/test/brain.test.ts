// The company brain's authority tests.
//
// brain.ts is a retrieval surface that can reach invoices, client messages and learned rules across
// six stores. Its entire safety argument is that `BrainAuthority` is derived from a task and only
// ever narrowed — so these tests are not "does search work", they are "can a run see a row it must
// not". Every one of them is written from the attacker's side: the request tries to widen, name
// someone else's client, or redeem a ref it was never given.
//
// The shape of each test is the same as the shape of the module: two projects exist, and the
// assertions are about what the SECOND one's rows do to the first one's answers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { InMemoryStore } from "../src/store";
import { createServer } from "../src/server";
import { getDomainStore } from "../src/domain";
import { getBillingStore } from "../src/billing";
import { getKnowledgeStore } from "../src/knowledge.store";
import { registerActionGrant } from "../src/actiongrants";
import { ask, deriveAuthority, digestFor, get, narrow, textMatches, type BrainStores } from "../src/brain";
import type { Task } from "../src/contract";

const WEDGE = "books-keeper";

const stores = (): BrainStores => ({
  domain: getDomainStore(),
  billing: getBillingStore(),
  knowledge: getKnowledgeStore(),
});

/** A task shaped exactly as the store returns one. Only the five fields the authority reads matter. */
function taskOf(p: Partial<Task>): Task {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    wedge: WEDGE,
    task_type: "daily_sync",
    actor: { kind: "user", id: "founder" },
    input: {},
    constraints: { max_runtime_s: 300, max_cost_usd: 1, approval_required: false },
    tools: [],
    status: "running",
    cost_usd: 0,
    created_at: now,
    updated_at: now,
    ...p,
  } as Task;
}

/**
 * One tenant with one of everything the brain can read.
 *
 * Deliberately populates all six sources for every fixture: a leak test that only writes invoices
 * proves nothing about the threads block, and the blocks do NOT share a filter — each one applies
 * the authority itself, which is exactly the kind of repetition that drifts.
 */
async function seed(projectId: string, label: string) {
  const domain = getDomainStore();
  const billing = getBillingStore();
  const knowledge = getKnowledgeStore();

  const client = await domain.createClient({
    project_id: projectId,
    name: `${label} Client`,
    handle: `${label}-handle-${randomUUID().slice(0, 8)}`,
    status: "active",
  } as never);

  const kase = await domain.createCase({
    project_id: projectId,
    wedge: WEDGE,
    title: `${label} October close`,
    client_id: client.id,
    stage: "open",
    status: "open",
    data: {},
  });

  const invoice = await billing.createInvoice({
    project_id: projectId,
    client_id: client.id,
    currency: "USD",
    status: "sent",
    due_date: "2000-01-01", // long past, so `effectiveStatus` says overdue
    lines: [{ description: `${label} bookkeeping`, quantity: 1, unit_amount: 125000 }],
  } as never);

  const thread = await domain.createThread({
    project_id: projectId,
    client_id: client.id,
    channel_id: "ch",
    subject: `${label} kickoff`,
    status: "open",
  });
  await domain.addMessage({
    thread_id: thread.id,
    direction: "inbound",
    author: client.id,
    body: `${label} secret sentence about the books`,
  });

  const item = await domain.createKnowledge({
    project_id: projectId,
    wedge: WEDGE,
    name: `${label}-note.md`,
    content: `${label} house note`,
    kind: "note",
    source: "founder",
    metadata: { sensitivity: "house" },
  } as never);

  const rule = await knowledge.putRule({
    project_id: projectId,
    wedge: WEDGE,
    task_types: [],
    subject: "send_email.subject",
    text: `${label} rule: keep subjects short`,
    kind: "preference",
    sensitivity: "house",
    provenance: {},
  } as never);

  const record = await domain.upsertRecord({
    project_id: projectId,
    wedge: WEDGE,
    case_id: kase.id,
    collection: "ledger",
    key: `${label}-entry`,
    data: { note: `${label} record body` },
  } as never);

  return { client, kase, invoice, thread, item, rule, record };
}

// ── The constructor ───────────────────────────────────────────────────────────

test("deriveAuthority refuses a task with no project: an unattributed run reads nothing", () => {
  assert.equal(deriveAuthority(undefined), undefined);
  assert.equal(deriveAuthority(taskOf({ project_id: undefined })), undefined);
});

test("deriveAuthority: empty client set is the TIGHTEST scope, and sensitivity follows it", () => {
  const house = deriveAuthority(taskOf({ project_id: "p" }))!;
  assert.deepEqual([...house.client_ids], []);
  assert.equal(house.max_sensitivity, "house");

  const forClient = deriveAuthority(taskOf({ project_id: "p", client_id: "c1" }))!;
  assert.deepEqual([...forClient.client_ids], ["c1"]);
  assert.equal(forClient.max_sensitivity, "client");
});

test("deriveAuthority takes the case from the GRANT, and de-duplicates it", () => {
  const a = deriveAuthority(taskOf({ project_id: "p", case_id: "k1" }), { caseId: "k2" })!;
  assert.deepEqual([...a.case_ids].sort(), ["k1", "k2"]);
  const b = deriveAuthority(taskOf({ project_id: "p", case_id: "k1" }), { caseId: "k1" })!;
  assert.deepEqual([...b.case_ids], ["k1"]);
});

// ── narrow() may only ever subtract ───────────────────────────────────────────

test("narrow: a request cannot widen the project, the wedge, or the client set", () => {
  const auth = deriveAuthority(taskOf({ project_id: "p", wedge: WEDGE, client_id: "mine" }))!;
  // Fields the request has no way to express are simply not read; the ones it can express intersect.
  const scope = narrow(auth, { client_id: "someone-else", case_id: "not-mine", limit: 9999 });
  assert.equal(scope.project_id, "p");
  assert.equal(scope.wedge, WEDGE);
  // Asking for another client yields the EMPTY set — not an error, and NOT the authority's own set.
  assert.deepEqual(scope.client_ids, []);
  assert.deepEqual(scope.case_ids, []);
  assert.equal(scope.limit, 100, "limit is clamped to MAX_LIMIT");
});

test("narrow: naming your OWN client keeps it; an unknown source is dropped, not honoured", () => {
  const auth = deriveAuthority(taskOf({ project_id: "p", client_id: "mine" }))!;
  assert.deepEqual(narrow(auth, { client_id: "mine" }).client_ids, ["mine"]);
  // A junk source must not fall through to "all sources" in a way the caller chose — it is filtered
  // out, and an empty result falls back to the module's own full list, never to caller input.
  const scope = narrow(auth, { sources: ["invoices", "secrets" as never] });
  assert.deepEqual(scope.sources, ["invoices"]);
});

test("textMatches ANDs its terms and is case-insensitive; no terms matches everything", () => {
  assert.equal(textMatches("Northwind March invoice", ["north", "march"]), true);
  assert.equal(textMatches("Northwind March invoice", ["north", "april"]), false);
  assert.equal(textMatches("anything", []), true);
});

// ── The leak tests ────────────────────────────────────────────────────────────

test("BRAIN IS TENANT-SEALED: another project's rows are invisible in every source", async () => {
  const mine = `p-${randomUUID()}`;
  const theirs = `p-${randomUUID()}`;
  const a = await seed(mine, "Alpha");
  const b = await seed(theirs, "Bravo");

  const auth = deriveAuthority(taskOf({ project_id: mine, client_id: a.client.id, case_id: a.kase.id }))!;
  const answer = await ask(stores(), auth, { limit: 100 });

  const blob = JSON.stringify(answer);
  assert.ok(!blob.includes("Bravo"), "no other tenant's text appears anywhere in the response");
  assert.ok(!blob.includes(b.client.id), "no other tenant's client id appears");
  assert.ok(!blob.includes(b.invoice.id), "no other tenant's invoice id appears");
  for (const hit of answer.hits) {
    assert.ok(!hit.source_ref.includes(b.invoice.id));
    assert.ok(hit.client_id === undefined || hit.client_id === a.client.id);
  }
  // And the seal is not "we returned nothing": this run really can see its own sources.
  const sources = new Set(answer.hits.map((h) => h.source));
  for (const s of ["rules", "knowledge", "records", "cases", "invoices", "threads", "clients"]) {
    assert.ok(sources.has(s as never), `this run can read its own ${s}`);
  }
});

test("a query term cannot ADMIT a row — text matching runs last, after the authority", async () => {
  const mine = `p-${randomUUID()}`;
  const theirs = `p-${randomUUID()}`;
  const a = await seed(mine, "Alpha");
  await seed(theirs, "Bravo");

  const auth = deriveAuthority(taskOf({ project_id: mine, client_id: a.client.id, case_id: a.kase.id }))!;
  // Search for the other tenant's exact secret sentence. The most targeted query possible.
  const answer = await ask(stores(), auth, { q: "bravo secret sentence", limit: 100 });
  assert.equal(answer.returned, 0);
  assert.equal(answer.matched, 0);
  assert.ok(!JSON.stringify(answer).includes("Bravo"));
});

test("a HOUSE-WIDE run reads no client-owned row, and says how many it withheld — as a COUNT ONLY", async () => {
  const projectId = `p-${randomUUID()}`;
  const seeded = await seed(projectId, "Alpha");

  // Same tenant, but this run is not about a client. The empty client set is the tightest scope.
  const auth = deriveAuthority(taskOf({ project_id: projectId }))!;
  const answer = await ask(stores(), auth, { limit: 100 });

  const owned = answer.hits.filter((h) => h.client_id === seeded.client.id);
  assert.deepEqual(owned, [], "a house-wide run reads none of the client's rows");
  assert.ok(answer.authority_excluded > 0, "and it is told that rows were withheld");

  // The count discloses nothing else. Not an id, not a client name, not a title.
  const blob = JSON.stringify(answer);
  assert.ok(!blob.includes(seeded.client.id), "the withheld client's id does not appear");
  assert.ok(!blob.includes(seeded.invoice.id), "the withheld invoice's id does not appear");
  assert.ok(!blob.includes(seeded.record.id), "the withheld record's id does not appear");
  assert.ok(!blob.includes("Alpha Client"), "the withheld client's name does not appear");
  assert.equal(typeof answer.authority_excluded, "number");
});

test("a HOUSE-WIDE run cannot see a record tied to a client case — empty case_ids is tightest, not widest", async () => {
  const projectId = `p-${randomUUID()}`;
  const seeded = await seed(projectId, "Alpha");
  const auth = deriveAuthority(taskOf({ project_id: projectId }))!;
  const answer = await ask(stores(), auth, { sources: ["records"], limit: 100 });
  assert.equal(
    answer.hits.find((h) => h.id === seeded.record.id),
    undefined,
    "client-case record must not appear on a house-wide ask",
  );
  assert.ok(answer.authority_excluded >= 1);
});

test("naming a client you do not have returns nothing, and is not an oracle for their existence", async () => {
  const mine = `p-${randomUUID()}`;
  const theirs = `p-${randomUUID()}`;
  const a = await seed(mine, "Alpha");
  const b = await seed(theirs, "Bravo");

  const auth = deriveAuthority(taskOf({ project_id: mine, client_id: a.client.id, case_id: a.kase.id }))!;

  const real = await ask(stores(), auth, { client_id: b.client.id, limit: 100 });
  const fictional = await ask(stores(), auth, { client_id: `nobody-${randomUUID()}`, limit: 100 });

  // A client that exists elsewhere and a client that does not exist at all are INDISTINGUISHABLE —
  // byte for byte, counts included. That is the whole property: the refusal cannot be used to test
  // whether a name is a real client, or whether we work for them.
  assert.deepEqual(real, fictional);

  // Naming a foreign client collapses the client set to empty, which is the HOUSE-WIDE scope, not
  // an error — so the answer is not empty, it is the run's own house rows. What it must never
  // contain is a row owned by anybody, least of all by the client that was named.
  for (const hit of real.hits) {
    assert.equal(hit.client_id, undefined, `${hit.source_ref} is house-wide, owned by nobody`);
  }
  assert.ok(!JSON.stringify(real).includes("Bravo"), "and nothing of the other tenant's leaks in");
  assert.ok(!JSON.stringify(real).includes(b.client.id));
});

// ── get() re-authorises, so a ref is never a capability ───────────────────────

test("get: a ref for another tenant's row is 'not found', identically to a ref that never existed", async () => {
  const mine = `p-${randomUUID()}`;
  const theirs = `p-${randomUUID()}`;
  const a = await seed(mine, "Alpha");
  const b = await seed(theirs, "Bravo");

  const auth = deriveAuthority(taskOf({ project_id: mine, client_id: a.client.id, case_id: a.kase.id }))!;

  // A ref the attacker constructed by hand, in exactly the format `ask` hands out.
  assert.equal(await get(stores(), auth, `invoices:${b.invoice.id}`), undefined);
  assert.equal(await get(stores(), auth, `cases:${b.kase.id}`), undefined);
  assert.equal(await get(stores(), auth, `knowledge:${b.item.id}`), undefined);
  assert.equal(await get(stores(), auth, `rules:${b.rule.id}`), undefined);
  assert.equal(await get(stores(), auth, `records:${b.record.id}`), undefined);
  assert.equal(await get(stores(), auth, `threads:${b.thread.id}:whatever`), undefined);
  // The same answer as a ref for nothing at all, and as a source that does not exist.
  assert.equal(await get(stores(), auth, `invoices:${randomUUID()}`), undefined);
  assert.equal(await get(stores(), auth, `secrets:${b.invoice.id}`), undefined);
  assert.equal(await get(stores(), auth, ""), undefined);
});

test("get: a ref for a row this run MAY read returns the untruncated body", async () => {
  const projectId = `p-${randomUUID()}`;
  const a = await seed(projectId, "Alpha");
  const auth = deriveAuthority(taskOf({ project_id: projectId, client_id: a.client.id, case_id: a.kase.id }))!;

  const doc = await get(stores(), auth, `invoices:${a.invoice.id}`);
  assert.ok(doc, "the run can fetch its own invoice");
  assert.equal(doc.source, "invoices");
  assert.equal(doc.id, a.invoice.id);
  assert.ok(doc.content.includes("125000"), "money stays in integer minor units, undivided");
  assert.ok(!doc.content.includes("1250.00"), "nothing has divided by 100 on the way out");
});

test("a house-wide run cannot redeem a ref for its own tenant's client-owned invoice", async () => {
  const projectId = `p-${randomUUID()}`;
  const a = await seed(projectId, "Alpha");
  // Same tenant. Different authority. The row is theirs; this run is simply not about that client.
  const houseAuth = deriveAuthority(taskOf({ project_id: projectId }))!;
  assert.equal(await get(stores(), houseAuth, `invoices:${a.invoice.id}`), undefined);
});

// ── The digest is an index, not an answer ────────────────────────────────────

test("digestFor states COUNTS and nothing else — no client, no amount, no sentence", async () => {
  const projectId = `p-${randomUUID()}`;
  const a = await seed(projectId, "Alpha");
  const auth = deriveAuthority(taskOf({ project_id: projectId, client_id: a.client.id, case_id: a.kase.id }))!;

  const digest = await digestFor(stores(), auth);
  assert.ok(digest.length <= 401, "it stays small enough to sit on the prompt path");
  assert.ok(!digest.includes("Alpha Client"), "no client name");
  assert.ok(!digest.includes("125000"), "no amount");
  assert.ok(!digest.includes("secret sentence"), "no message body");
  assert.ok(/invoice/.test(digest), "but it does say what is there");
});

test("digestFor for a tenant with nothing says so, rather than describing someone else's", async () => {
  const auth = deriveAuthority(taskOf({ project_id: `p-${randomUUID()}` }))!;
  assert.match(await digestFor(stores(), auth), /holds nothing readable/);
});

// ── The HTTP surface: the nonce chain, the 403, and the trace ────────────────

test("POST /v1/internal/brain/ask: no nonce is 401, and a task with no project is 403", async () => {
  const store = new InMemoryStore();
  const app = createServer(store);
  const now = new Date().toISOString();

  const bad = await app.request("/v1/internal/brain/ask", {
    method: "POST",
    headers: { authorization: "Bearer nope", "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(bad.status, 401);

  // A task with no project_id: the same refusal `/v1/internal/records/query` had to grow.
  await store.createTask({
    id: "t-noproject", wedge: WEDGE, task_type: "daily_sync", actor: { kind: "user", id: "a" },
    input: {}, constraints: { max_runtime_s: 300, max_cost_usd: 1, approval_required: false },
    tools: [], status: "running", cost_usd: 0, created_at: now, updated_at: now,
  } as never);
  const nonce = await registerActionGrant({ task_id: "t-noproject", connectionIds: [] } as never);
  const res = await app.request("/v1/internal/brain/ask", {
    method: "POST",
    headers: { authorization: `Bearer ${nonce}`, "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(res.status, 403);
});

test("brain reads are TRACED onto the task timeline, call and result", async () => {
  const store = new InMemoryStore();
  const app = createServer(store);
  const projectId = `p-${randomUUID()}`;
  const a = await seed(projectId, "Alpha");
  const now = new Date().toISOString();

  await store.createTask({
    id: "t-brain", project_id: projectId, wedge: WEDGE, task_type: "daily_sync",
    actor: { kind: "user", id: "a" }, client_id: a.client.id, case_id: a.kase.id,
    input: {}, constraints: { max_runtime_s: 300, max_cost_usd: 1, approval_required: false },
    tools: [], status: "running", cost_usd: 0, created_at: now, updated_at: now,
  } as never);
  const nonce = await registerActionGrant({ task_id: "t-brain", connectionIds: [] } as never);

  const res = await app.request("/v1/internal/brain/ask", {
    method: "POST",
    headers: { authorization: `Bearer ${nonce}`, "content-type": "application/json" },
    // The body tries to name another project. It is not read at all — the authority is derived.
    body: JSON.stringify({ q: "bookkeeping", project_id: "somebody-else", sources: ["invoices"] }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.ok, true);
  assert.equal(typeof body.authority_excluded, "number");
  assert.ok(Array.isArray(body.hits));

  const events = await store.eventsAfter("t-brain", 0);
  const called = events.find((e) => e.type === "tool.called" && (e.data as never as { tool: string }).tool === "brain:ask");
  const result = events.find((e) => e.type === "tool.result" && (e.data as never as { tool: string }).tool === "brain:ask");
  assert.ok(called, "the founder can see that the brain was asked");
  assert.ok(result, "and what it returned");
  // The trace records the SHAPE of the answer, not its contents.
  const data = result!.data as never as { returned: number; authority_excluded: number };
  assert.equal(typeof data.returned, "number");
  assert.equal(typeof data.authority_excluded, "number");
});

test("POST /v1/internal/brain/get requires a source_ref, and 404s for one it may not read", async () => {
  const store = new InMemoryStore();
  const app = createServer(store);
  const mine = `p-${randomUUID()}`;
  const theirs = `p-${randomUUID()}`;
  const a = await seed(mine, "Alpha");
  const b = await seed(theirs, "Bravo");
  const now = new Date().toISOString();

  await store.createTask({
    id: "t-get", project_id: mine, wedge: WEDGE, task_type: "daily_sync",
    actor: { kind: "user", id: "a" }, client_id: a.client.id,
    input: {}, constraints: { max_runtime_s: 300, max_cost_usd: 1, approval_required: false },
    tools: [], status: "running", cost_usd: 0, created_at: now, updated_at: now,
  } as never);
  const nonce = await registerActionGrant({ task_id: "t-get", connectionIds: [] } as never);
  const call = (body: unknown) =>
    app.request("/v1/internal/brain/get", {
      method: "POST",
      headers: { authorization: `Bearer ${nonce}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  assert.equal((await call({})).status, 400);
  assert.equal((await call({ source_ref: `invoices:${b.invoice.id}` })).status, 404);
  assert.equal((await call({ source_ref: `invoices:${a.invoice.id}` })).status, 200);
});
