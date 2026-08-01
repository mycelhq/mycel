// Grants across replicas.
//
// The bug these cover: `infra/main.tf` runs api_count = 2 and worker_count = 2, the queue hands a
// task to whichever worker claims it, and the worker service is not in the ALB target group at all.
// A nonce minted in a worker is therefore ALWAYS presented to a process that did not mint it. While
// grants were a process-local `Map` that was not a degradation, it was a hard 401 on the action
// proxy, the read proxy, the case/gap/records APIs, workflows and the LLM proxy.
//
// The cross-replica assertions need a real shared backend, so they are skipped unless
// MYCEL_TEST_DATABASE_URL points at a throwaway Postgres — the same convention as
// multi-instance.test.ts. Everything that can be shown without one is asserted unconditionally.
import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryGrantStore, grantTtlMs } from "../src/store";
import { getActionGrant, registerActionGrant, revokeActionGrant } from "../src/actiongrants";
import { getGrant, registerGrant, revokeGrant } from "../src/proxygrants";

const URL = process.env.MYCEL_TEST_DATABASE_URL;
const skip = URL ? false : "set MYCEL_TEST_DATABASE_URL to run";

test("an action grant round-trips: mint, resolve, revoke", async () => {
  const nonce = await registerActionGrant({
    task_id: "t-round",
    connectionIds: ["c1", "c2"],
    threadId: "th1",
    caseId: "case1",
  });
  const g = await getActionGrant(nonce);
  assert.deepEqual(g, { task_id: "t-round", connectionIds: ["c1", "c2"], threadId: "th1", caseId: "case1" });

  await revokeActionGrant(nonce);
  assert.equal(await getActionGrant(nonce), undefined, "a revoked nonce must stop authorising immediately");
});

test("a proxy grant hands back the real key, and only to the right nonce", async () => {
  const nonce = await registerGrant({
    base_url: "https://upstream.example/v1",
    api_key: "sk-real-key",
    model: "gpt-4o-mini",
    task_id: "t-proxy",
  });
  const g = await getGrant(nonce);
  assert.equal(g?.api_key, "sk-real-key");
  assert.equal(g?.base_url, "https://upstream.example/v1");

  // The two grant kinds share a nonce space in one table; a proxy nonce must never resolve as an
  // action grant, or a compromised LLM token would become a licence to send email.
  assert.equal(await getActionGrant(nonce), undefined, "kinds are namespaced");
  assert.equal(await getGrant("not-a-nonce"), undefined);
  assert.equal(await getGrant(""), undefined, "an empty Authorization header is not a grant");

  await revokeGrant(nonce);
  assert.equal(await getGrant(nonce), undefined);
});

test("the TTL is a backstop, not the mechanism: it outlives the runtime ceiling", () => {
  // Revocation at the end of a run is the normal path. The TTL only has to cover the run that died
  // with the process holding it — so it must be longer than any run is allowed to be.
  const ceilingMs = Number(process.env.MYCEL_MAX_RUNTIME_S ?? 1800) * 1000;
  assert.ok(grantTtlMs() > ceilingMs, `grant TTL ${grantTtlMs()}ms must exceed the runtime ceiling ${ceilingMs}ms`);
});

test("an expired grant is refused on lookup, not left for a sweeper", async () => {
  const store = new InMemoryGrantStore();
  await store.put("action", "expired", { task_id: "t" }, new Date(Date.now() - 1));
  await store.put("action", "live", { task_id: "t" }, new Date(Date.now() + 60_000));

  // No sweep has run and none is going to. Expiry is decided by the read itself, because a grant
  // that outlives its task because a timer was late is exactly the bug this design prevents.
  assert.equal(await store.get("action", "expired"), undefined);
  assert.deepEqual(await store.get("action", "live"), { task_id: "t" });
});

test("the in-memory store evicts — it does not grow for the lifetime of the process", async () => {
  const store = new InMemoryGrantStore();
  const past = new Date(Date.now() - 1);
  const future = new Date(Date.now() + 60_000);
  for (let i = 0; i < 200; i++) await store.put("action", `dead-${i}`, { task_id: `t${i}` }, past);
  await store.put("action", "alive", { task_id: "keep" }, future);

  const remaining = store.sweepNow();
  assert.equal(remaining, 1, `expected only the live grant to survive, ${remaining} rows remain`);
  assert.deepEqual(await store.get("action", "alive"), { task_id: "keep" }, "the sweep must not take live grants");

  // And a read of an expired grant drops it too, so a store that is never written to still shrinks.
  const s2 = new InMemoryGrantStore();
  await s2.put("action", "dead", { task_id: "t" }, past);
  await s2.get("action", "dead");
  assert.equal(s2.sweepNow(), 0);
});

// ── The real thing: two store instances, one database ──────────────────────────

test("cross-replica: a grant minted on one instance validates on another", { skip }, async () => {
  const { PostgresGrantStore } = await import("../src/store.pg");
  const minter = await PostgresGrantStore.connect(URL!); // "the worker"
  const validator = await PostgresGrantStore.connect(URL!); // "the API replica"

  const nonce = `x-${Date.now()}`;
  await minter.put("action", nonce, { task_id: "t", connectionIds: ["c1"] }, new Date(Date.now() + 60_000));

  const seen = await validator.get("action", nonce);
  assert.deepEqual(seen, { task_id: "t", connectionIds: ["c1"] }, "the replica that never minted it must still see it");

  await minter.del("action", nonce);
  assert.equal(await validator.get("action", nonce), undefined, "and a revoke on one is a revoke on all");
  await minter.close();
  await validator.close();
});

test("cross-replica: expiry is enforced by the QUERY, with the row still present", { skip }, async () => {
  const { PostgresGrantStore } = await import("../src/store.pg");
  const { getPool } = await import("../src/pool");
  const store = await PostgresGrantStore.connect(URL!);

  const nonce = `exp-${Date.now()}`;
  await store.put("action", nonce, { task_id: "t" }, new Date(Date.now() - 60_000));

  assert.equal(await store.get("action", nonce), undefined, "an expired grant must not authorise");

  // The distinction that matters: the row is still there. Nothing swept it. The `expires_at > now()`
  // predicate in the lookup is what refused it, so a late sweeper can never widen the window.
  const raw = await getPool(URL!).query(`SELECT count(*)::int AS n FROM grants WHERE nonce=$1`, [nonce]);
  assert.equal(raw.rows[0].n, 1, "the row is present and unswept — the query is what refused it");

  await store.del("action", nonce);
  await store.close();
});
