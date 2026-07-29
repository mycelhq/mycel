import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as httpServer } from "node:http";
import { seal, open_, setSecret, getSecret, initSecretStore, _resetKeyCache } from "../src/secrets";
import { canonical, entryHash, verifyChain, initAuditStore, auditList, auditVerify, GENESIS, type AuditEntry } from "../src/audit";
import { InMemoryStore } from "../src/store";
import { createServer } from "../src/server";
import { getDomainStore } from "../src/domain";
import { registerActionGrant } from "../src/actiongrants";
import { resolveApproval } from "../src/approvals";

// ── vault: encryption at rest ──

test("vault: a secret is encrypted at rest and never stored in the clear", async () => {
  process.env.MYCEL_SECRET_KEY = Buffer.alloc(32, 7).toString("base64");
  _resetKeyCache();
  const sealed = seal("sk-live-SUPERSECRET");
  assert.ok(!JSON.stringify(sealed).includes("SUPERSECRET"), "the envelope contains no plaintext");
  assert.equal(sealed.v, 1);
  assert.ok(sealed.iv && sealed.tag && sealed.ct);
  assert.equal(open_(sealed), "sk-live-SUPERSECRET", "round-trips");
});

test("vault: tampering with the ciphertext is DETECTED, not silently accepted", () => {
  process.env.MYCEL_SECRET_KEY = Buffer.alloc(32, 7).toString("base64");
  _resetKeyCache();
  const sealed = seal("transfer-to-me");
  // flip a byte of ciphertext — GCM's auth tag must catch it
  const bytes = Buffer.from(sealed.ct, "base64");
  bytes[0] ^= 0xff;
  assert.equal(open_({ ...sealed, ct: bytes.toString("base64") }), undefined, "tampered ciphertext yields nothing");
  // and a swapped auth tag fails too
  assert.equal(open_({ ...sealed, tag: Buffer.alloc(16, 1).toString("base64") }), undefined);
});

test("vault: a secret sealed with a different key cannot be read", () => {
  process.env.MYCEL_SECRET_KEY = Buffer.alloc(32, 1).toString("base64");
  _resetKeyCache();
  const sealed = seal("client-oauth-token");
  process.env.MYCEL_SECRET_KEY = Buffer.alloc(32, 2).toString("base64"); // rotated/stolen dump
  _resetKeyCache();
  assert.equal(open_(sealed), undefined, "a database dump is useless without the right key");
});

test("vault: a malformed key is rejected loudly rather than silently weakening crypto", () => {
  process.env.MYCEL_SECRET_KEY = "too-short";
  _resetKeyCache();
  assert.throws(() => seal("x"), /32 bytes/);
  process.env.MYCEL_SECRET_KEY = Buffer.alloc(32, 7).toString("base64");
  _resetKeyCache();
});

test("vault: store round-trip through the public API", async () => {
  process.env.MYCEL_SECRET_KEY = Buffer.alloc(32, 9).toString("base64");
  _resetKeyCache();
  await initSecretStore();
  await setSecret("conn-1", "postmark-key");
  assert.equal(await getSecret("conn-1"), "postmark-key");
  assert.equal(await getSecret("missing"), undefined);
});

// ── audit: tamper-evident chain ──

test("audit: the chain verifies, and any edit/delete/reorder is caught", async () => {
  await initAuditStore();
  const { audit } = await import("../src/audit");
  for (let i = 0; i < 5; i++) {
    await audit({ project_id: "p1", actor: "member", action: "approval.granted", entity: "task", entity_id: `t${i}`, detail: { i } });
  }
  const entries = await auditList("p1");
  assert.equal(entries.length, 5);
  assert.equal(entries[0].prev_hash, GENESIS, "the chain starts at genesis");
  assert.equal(entries[1].prev_hash, entries[0].hash, "each entry links to the previous");
  assert.equal((await auditVerify("p1")).ok, true, "an untouched chain verifies");

  // EDIT a field — the recomputed hash must not match
  const edited = entries.map((e) => ({ ...e }));
  edited[2].detail = { i: "tampered" };
  const v1 = verifyChain(edited);
  assert.equal(v1.ok, false);
  assert.equal(v1.broken_at, 3);
  assert.match(v1.reason!, /does not match its contents/);

  // DELETE an entry — the sequence gap must be caught
  const deleted = entries.filter((e) => e.seq !== 3);
  const v2 = verifyChain(deleted);
  assert.equal(v2.ok, false);
  assert.match(v2.reason!, /sequence gap/);

  // REORDER — prev_hash no longer matches
  const reordered = [entries[0], entries[2], entries[1], entries[3], entries[4]].map((e, i) => ({ ...e, seq: i + 1 }));
  assert.equal(verifyChain(reordered as AuditEntry[]).ok, false);
});

test("audit: the hash is independent of object key ORDER (jsonb round-trip)", () => {
  // Postgres jsonb does not preserve key order, so {a,b} can return as {b,a}. Hashing raw
  // JSON.stringify made every persisted chain verify as tampered — an alarm that always fires.
  assert.equal(canonical({ a: 1, b: 2 }), canonical({ b: 2, a: 1 }));
  assert.equal(canonical({ x: { p: 1, q: 2 }, y: [1, { m: 1, n: 2 }] }), canonical({ y: [1, { n: 2, m: 1 }], x: { q: 2, p: 1 } }));
  // …but a different VALUE must still change it
  assert.notEqual(canonical({ a: 1 }), canonical({ a: 2 }));
  const base = { seq: 1, project_id: "p", at: "2026-01-01T00:00:00.000Z", actor: "a", action: "approval.granted" as const, entity: "task", entity_id: "t", prev_hash: GENESIS };
  assert.equal(
    entryHash({ ...base, detail: { connection: "x", kind: "email", n: 1 } }),
    entryHash({ ...base, detail: { n: 1, kind: "email", connection: "x" } }),
    "the same detail in any key order hashes identically",
  );
});

test("audit: entryHash is deterministic and sensitive to every field", () => {
  const base = { seq: 1, project_id: "p", at: "2026-01-01T00:00:00.000Z", actor: "a", action: "approval.granted" as const, entity: "task", entity_id: "t", detail: {}, prev_hash: GENESIS };
  const h = entryHash(base);
  assert.equal(entryHash(base), h, "deterministic");
  assert.notEqual(entryHash({ ...base, actor: "b" }), h);
  assert.notEqual(entryHash({ ...base, entity_id: "t2" }), h);
  assert.notEqual(entryHash({ ...base, detail: { x: 1 } }), h);
  assert.notEqual(entryHash({ ...base, prev_hash: "x".repeat(64) }), h);
});

test("audit: a real approval + executed action land in the chain, with no secret material", async () => {
  process.env.MYCEL_SECRET_KEY = Buffer.alloc(32, 3).toString("base64");
  _resetKeyCache();
  await initSecretStore();
  await initAuditStore();

  let hits = 0;
  const srv = httpServer((_q, res) => { hits++; res.end("ok"); });
  await new Promise<void>((r) => srv.listen(0, r));
  const port = (srv.address() as { port: number }).port;

  const store = new InMemoryStore();
  const app = createServer(store);
  const domain = getDomainStore();
  const now = new Date().toISOString();
  await store.createTask({
    id: "at1", project_id: "audit-proj", wedge: "invoice-chaser", task_type: "chase_invoice",
    actor: { kind: "system", id: "s" }, input: {},
    constraints: { max_runtime_s: 300, max_cost_usd: 1, approval_required: false },
    tools: [], status: "running", cost_usd: 0, created_at: now, updated_at: now,
  } as never);
  const conn = await domain.createConnection({
    project_id: "audit-proj", kind: "webhook", name: "sink", owner: { kind: "founder", id: "founder" },
    config: { url: `http://127.0.0.1:${port}/` },
  });
  await setSecret(conn.id, "SUPERSECRET-TOKEN");

  const nonce = registerActionGrant({ task_id: "at1", connectionIds: [conn.id] });
  const H = { authorization: `Bearer ${nonce}`, "content-type": "application/json" };
  const callP = app.request("/v1/internal/actions/send_thing", {
    method: "POST", headers: H, body: JSON.stringify({ connection_id: conn.id, to: "x@y.z", body: "hi" }),
  });

  let approvalId: string | undefined;
  for (let i = 0; i < 100 && !approvalId; i++) {
    await new Promise((r) => setTimeout(r, 15));
    const req = (await store.eventsAfter("at1", 0)).find((e) => e.type === "approval.requested");
    if (req) approvalId = (req.data as { approval_id: string }).approval_id;
  }
  resolveApproval(approvalId!, "approved");
  const out = await (await callP).json();
  assert.equal(out.ok, true);
  assert.equal(hits, 1);

  const chain = await auditList("audit-proj");
  const actions = chain.map((e) => e.action);
  assert.ok(actions.includes("approval.granted"), `approval recorded (${actions.join(", ")})`);
  assert.ok(actions.includes("action.executed"), "the executed action recorded");
  assert.equal((await auditVerify("audit-proj")).ok, true, "chain still verifies");
  // the crux: an audit log is worthless if it leaks what it audits
  assert.ok(!JSON.stringify(chain).includes("SUPERSECRET"), "no secret material anywhere in the chain");

  srv.close();
});
