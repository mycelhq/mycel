// `@mycel/insight` ingest, scoping and the agent-facing summary.
//
// The write path here is, in effect, public: anything that can load a founder's homepage can reach
// it. So most of this file is about the two properties that make that acceptable — the project a
// batch lands in comes out of a SIGNATURE and never out of the request, and nothing identifying
// survives arrival — plus the maths of the summary an agent will act on.
//
// Note the shape of the isolation. The domain store is a process singleton, so tests that assert
// exact totals mint a FRESH project id per test rather than sharing the default one; `freshProjectId`
// exists in helpers.ts for exactly this reason, and ignoring it has already cost this repo three
// debugging detours. An ingest key is derived from a project id with no identity lookup, which means
// a synthetic id is a perfectly good tenant for everything except the routes that read.
import { test } from "node:test";
import assert from "node:assert/strict";
import { api, freshProjectId, makeApp, KEY } from "./helpers";
import { getDomainStore } from "../src/domain";
import { ingestKeyFor, projectForIngestKey } from "../src/insight/keys";
import { normaliseBatch } from "../src/insight/schema";
import { analyseFunnel } from "../src/insight/funnel";
import { countBatch, topCounts } from "../src/insight/store";
import { buildSummary } from "../src/insight/summary";

const OWNER_EMAIL = process.env.MYCEL_OWNER_EMAIL || "owner@test.co";
const OWNER_PW = process.env.MYCEL_OWNER_PASSWORD || "secret";

const batch = (events: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ v: 1, aid: "anon-1", sid: "sess-1", events, ...extra });

const post = (app: any, body: string, key: string) =>
  app.request("/v1/insight/events", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body,
  });

/** A tenant nothing else in this process writes to, and the key that can append to it. */
function tenant(): { projectId: string; ingest: string } {
  const projectId = freshProjectId("insight");
  return { projectId, ingest: ingestKeyFor(projectId) };
}

const summaryFor = (projectId: string, days = 7) => buildSummary(getDomainStore(), projectId, { days });

// ── the credential ────────────────────────────────────────────────────────────────────────────────

test("an ingest key authorises exactly one project, and nothing else authorises at all", async () => {
  const { app } = makeApp();
  const { projectId, ingest } = tenant();

  assert.equal(projectForIngestKey(ingest), projectId);
  assert.equal(ingestKeyFor(projectId), ingest, "derived, so minting twice yields the same key");
  assert.notEqual(projectForIngestKey(ingestKeyFor("someone-else")), projectId);

  // Every way of not holding a valid key gets the same answer: 401, no body. Distinguishing them
  // would tell someone probing which part they got right.
  for (const bad of [
    "",
    "mik_",
    ingest.slice(0, -1),
    `${ingest}a`,
    ingest.replace(/_[0-9a-f]+$/, `_${"0".repeat(32)}`),
    // The founder's product key. It can start tasks, read every client and change the plan, and it
    // must be useless here — a near-public endpoint is not a place to present the key that owns the
    // business.
    KEY,
  ]) {
    const res = await post(app, batch([{ n: "x", t: Date.now() }]), bad);
    assert.equal(res.status, 401, `key ${JSON.stringify(bad)} must not authorise ingest`);
  }
});

test("the project comes from the signature, never from the body", async () => {
  const { app } = makeApp();
  const mine = tenant();
  const victim = tenant();

  // A batch naming someone else's project every way a body could. All of it is ignored: the
  // normaliser has no branch that reads a project from the payload and the route has no parameter
  // for one. This is the exact shape of the cross-tenant bugs this codebase keeps finding.
  const res = await post(
    app,
    batch([{ n: "poisoned", t: Date.now() }], {
      project_id: victim.projectId,
      projectId: victim.projectId,
      p: victim.projectId,
    }),
    mine.ingest,
  );
  assert.equal(res.status, 204);

  assert.equal((await summaryFor(mine.projectId)).totals.events, 1, "it landed in the signer's project");
  assert.equal((await summaryFor(victim.projectId)).totals.events, 0, "and nowhere near the named one");
});

test("one project's events never appear in another project's summary", async () => {
  const { app } = makeApp();
  const login = await app.request("/v1/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PW }),
  });
  const tok = (await login.json()).token as string;

  // Two projects created for this test, so the assertions are exact even though the default project
  // is shared with every other test in this process.
  const mk = async (name: string) => {
    const r = await api(app, "projects", { method: "POST", body: JSON.stringify({ name }) }, tok);
    assert.equal(r.status, 201);
    return { id: r.json.project.id as string, key: r.json.api_key as string };
  };
  const a = await mk(`insight-a-${Date.now()}`);
  const b = await mk(`insight-b-${Date.now()}`);

  const keyA = (await api(app, "insight/key", {}, a.key)).json;
  const keyB = (await api(app, "insight/key", {}, b.key)).json;
  assert.equal(keyA.project_id, a.id);
  assert.notEqual(keyA.ingest_key, keyB.ingest_key);

  await post(app, batch([{ n: "a_only", t: 1 }, { n: "a_only", t: 1 }]), keyA.ingest_key);
  await post(app, batch([{ n: "b_only", t: 1 }]), keyB.ingest_key);

  const sa = await api(app, "insight/summary", {}, a.key);
  const sb = await api(app, "insight/summary", {}, b.key);
  assert.equal(sa.json.totals.events, 2);
  assert.equal(sb.json.totals.events, 1);
  assert.deepEqual(sa.json.top_events.map((e: any) => e.name), ["a_only"]);
  assert.deepEqual(sb.json.top_events.map((e: any) => e.name), ["b_only"]);

  // A member can see every project in the org, so the summary refuses to guess — an average over
  // two products describes neither. Naming one narrows it; naming one outside scope fails closed.
  assert.equal((await api(app, "insight/summary", {}, tok)).status, 400);
  const named = await api(app, "insight/summary", { headers: { "x-mycel-project": b.id } }, tok);
  assert.equal(named.json.project_id, b.id);
  assert.equal(named.json.totals.events, 1);
  assert.equal((await api(app, "insight/summary", { headers: { "x-mycel-project": "not-mine" } }, tok)).status, 403);
  // A project key that names another project gets nothing, never the other project.
  const crossed = await api(app, "insight/summary", { headers: { "x-mycel-project": b.id } }, a.key);
  assert.equal(crossed.status, 403);
  const crossedKey = await api(app, "insight/key", { headers: { "x-mycel-project": b.id } }, a.key);
  assert.equal(crossedKey.status, 403, "and cannot mint an ingest key for it either");
});

// ── what survives arrival ─────────────────────────────────────────────────────────────────────────

test("the identifying fields are dropped at the boundary, not stored and filtered later", () => {
  const r = normaliseBatch({
    v: 1,
    aid: "visitor-42",
    sid: "session-42",
    events: [{ n: "viewed", t: 1, p: "/x", props: { service: "clean" } }],
  });
  assert.ok(r.ok);
  const json = JSON.stringify(r.batch);
  assert.ok(!json.includes("visitor-42"), "the anonymous id never reaches storage");
  assert.ok(!json.includes("session-42"));
  assert.ok(!json.includes('"t"'), "per-event client timestamps go too; the kernel buckets by its own clock");
  // No passthrough. A field the schema does not name does not exist on the other side of this.
  const sneaky = normaliseBatch({ v: 1, events: [{ n: "x", ip: "1.2.3.4", ua: "Mozilla", extra: { a: 1 } }] });
  assert.ok(sneaky.ok);
  assert.deepEqual(sneaky.batch.events[0], { name: "x" });
});

test("redaction runs again on arrival, because the client is code an attacker controls", async () => {
  const { app } = makeApp();
  const { projectId, ingest } = tenant();
  // A batch the SDK would never produce: a full URL with a magic sign-in token in the query, an
  // email in the path, a customer's typed message and an API key in the props.
  const res = await post(
    app,
    batch([
      { n: "$pageview", t: 1, p: "https://app.test/auth/callback?token=live-secret-abc123&email=jo@example.com" },
      { n: "$pageview", t: 1, p: "/u/jo%40example.com/orders/9182" },
      { n: "submitted", t: 1, props: { message: "my back hurts", api_key: "sk-live-1", service: "physio" } },
    ]),
    ingest,
  );
  assert.equal(res.status, 204);

  const s = await summaryFor(projectId);
  const body = JSON.stringify(s);
  for (const leak of ["live-secret-abc123", "jo@example.com", "my back hurts", "sk-live-1", "token="]) {
    assert.ok(!body.includes(leak), `"${leak}" must not survive ingest`);
  }
  assert.deepEqual(s.top_paths.map((p) => p.path).sort(), ["/auth/callback", "/u/:email/orders/:id"]);
});

test("ingest is bounded and fails closed", async () => {
  const { app } = makeApp();
  const { projectId, ingest } = tenant();
  const one = { n: "x", t: 1 };

  assert.equal((await post(app, "not json", ingest)).status, 400);
  assert.equal((await post(app, JSON.stringify([1, 2, 3]), ingest)).status, 400);
  assert.equal((await post(app, JSON.stringify({ v: 99, events: [one] }), ingest)).status, 400, "unknown version");
  assert.equal((await post(app, batch([]), ingest)).status, 400, "empty batch");
  assert.equal((await post(app, batch([{ n: "" }, { n: 5 }]), ingest)).status, 400, "nothing usable");
  assert.equal((await post(app, batch(Array.from({ length: 51 }, () => one)), ingest)).status, 413);
  assert.equal((await post(app, batch([{ n: "x", t: 1, props: { note: "y".repeat(200_000) } }]), ingest)).status, 413);

  // One malformed event does NOT discard the good ones batched alongside it: a single bad `track()`
  // call in a founder's product would otherwise silently cost them the twenty real events sharing
  // the batch, and they would never find out.
  assert.equal((await post(app, batch([{ n: "" }, one, { nope: true }]), ingest)).status, 204);
  assert.equal((await summaryFor(projectId)).totals.events, 1, "nothing that was refused was stored");
});

// ── the summary ───────────────────────────────────────────────────────────────────────────────────

test("counting a batch keeps totals and drops timelines", () => {
  const row = countBatch(
    {
      funnel: "intake",
      events: [
        { name: "$session" },
        { name: "$pageview", path: "/" },
        { name: "$pageview", path: "/" },
        { name: "started", step: "started", path: "/book" },
      ],
    },
    new Date("2026-08-01T12:00:00.000Z"),
  );
  assert.equal(row.day, "2026-08-01");
  assert.equal(row.events, 4);
  assert.equal(row.sessions, 1);
  assert.equal(row.pageviews, 2);
  assert.deepEqual(row.paths, { "/": 2 }, "paths count pageviews only — otherwise 'top pages' ranks where track() is called");
  assert.deepEqual(row.steps, { started: 1 });
});

test("high-cardinality event names collapse instead of filling a context window", () => {
  const counts: Record<string, number> = { real_event: 500 };
  for (let i = 0; i < 1_000; i++) counts[`gen_${i}`] = 1;
  const top = topCounts(counts, 5);
  assert.equal(top.length, 6, "five, plus the bucket");
  assert.equal(top[0]?.key, "real_event");
  assert.equal(top[5]?.key, "__other");
  assert.equal(top[5]?.count, 996, "the tail is still counted, just not enumerated");
});

test("the funnel maths matches the SDK's copy, step for step", () => {
  const r = analyseFunnel("intake", ["viewed", "started", "submitted", "paid"], {
    viewed: 100,
    started: 60,
    submitted: 50,
    paid: 10,
  });
  assert.equal(r.completion_rate, 0.1);
  assert.deepEqual(r.biggest_drop_off, { from: "viewed", to: "started", lost: 40, loss_rate: 0.4 });
  // The clamp: a customer who submits twice must not produce a rate above 1, because an agent
  // reading "conversion improved to 120%" will cheerfully write a task celebrating it.
  const doubled = analyseFunnel("intake", ["a", "b"], { a: 10, b: 25 });
  assert.equal(doubled.steps[1]?.count, 25);
  assert.equal(doubled.completion_rate, 1);
});

test("the summary is a conclusion an agent can act on, not a chart", async () => {
  const { app } = makeApp();
  const { projectId, ingest } = tenant();

  const step = (n: string) => ({ n, t: 1, s: n, p: "/book" });
  await post(app, batch([step("viewed")], { f: "intake", fs: ["viewed", "started", "paid"] }), ingest);
  // Enough sessions to clear the volume floor — below it the summary declines to conclude anything,
  // which is the subject of the next test rather than this one.
  for (let i = 0; i < 12; i++) {
    const events = [...Array.from({ length: 8 }, () => step("viewed")), step("started"), { n: "$session", t: 1 }];
    assert.equal((await post(app, batch(events, { f: "intake" }), ingest)).status, 204);
  }
  await post(app, batch([step("started"), step("paid")], { f: "intake" }), ingest);

  const s = await summaryFor(projectId);
  assert.equal(s.funnel?.name, "intake");
  assert.equal(s.funnel?.declared_steps, 3);
  assert.equal(s.funnel?.entered, 97, "1 + 12×8");
  assert.equal(s.funnel?.completed, 1);
  assert.equal(s.funnel?.biggest_drop_off?.from, "viewed");
  assert.equal(s.funnel?.biggest_drop_off?.to, "started");
  assert.equal(s.totals.sessions, 12);
  // The point of the whole feature: a step NAME a task can be written against, decided by
  // arithmetic rather than by whoever happens to be reading the numbers today.
  assert.match(s.attention ?? "", /viewed.*started/);
  assert.match(s.headline, /Funnel "intake"/);
  assert.equal(s.thin, false);
  assert.equal(s.truncated, false);
  assert.deepEqual(s.previous_totals, { events: 0, sessions: 0, pageviews: 0, batches: 0 });
  assert.equal(s.previous.to, s.window.from, "the comparison window abuts this one");
});

test("thin data does not get an opinion", async () => {
  const { app } = makeApp();
  const { projectId, ingest } = tenant();

  const empty = await summaryFor(projectId);
  assert.equal(empty.funnel, null);
  assert.equal(empty.attention, null);
  assert.equal(empty.thin, true);
  assert.match(empty.headline, /No events received/);
  assert.deepEqual(empty.changes, []);

  await post(app, batch([{ n: "clicked", t: 1 }]), ingest);
  const barely = await summaryFor(projectId);
  assert.equal(barely.thin, true, "one event is not evidence");
  assert.equal(barely.attention, null, "a summary that always has an opinion has none worth reading");
  assert.deepEqual(barely.changes, [], "a delta below the volume floor is noise, and noise costs a task");
});

test("a funnel declaration is remembered, bounded, and never inferred", async () => {
  const { app } = makeApp();
  const { projectId, ingest } = tenant();

  // Fewer than two steps is not a funnel: there is no transition, so nothing it could report.
  const short = normaliseBatch({ v: 1, f: "x", fs: ["only"], events: [{ n: "e" }] });
  assert.ok(short.ok);
  assert.equal(short.batch.funnelSteps, undefined);
  // A step list with no funnel name has nothing to be the order OF.
  const orphan = normaliseBatch({ v: 1, fs: ["a", "b"], events: [{ n: "e" }] });
  assert.ok(orphan.ok);
  assert.equal(orphan.batch.funnelSteps, undefined);
  // Bounded and de-duplicated — a repeated step would make the maths compare a step with itself.
  const many = normaliseBatch({
    v: 1,
    f: "big",
    fs: [...Array.from({ length: 50 }, (_, i) => `s${i}`), "s0"],
    events: [{ n: "e" }],
  });
  assert.ok(many.ok);
  assert.equal(many.batch.funnelSteps?.length, 20);

  // The declaration outlives the batch that carried it, which is why the client sends it once.
  await post(app, batch([{ n: "a", t: 1, s: "a" }], { f: "intake", fs: ["a", "b"] }), ingest);
  await post(app, batch([{ n: "b", t: 1, s: "b" }], { f: "intake" }), ingest);
  const s = await summaryFor(projectId);
  assert.deepEqual(s.funnel?.steps.map((x) => x.step), ["a", "b"]);
  assert.equal(s.funnel?.entered, 1);
  assert.equal(s.funnel?.completed, 1);
});
