import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { getIdentityStore } from "../src/identity";
import { initSecretStore } from "../src/secrets";
import { keyForOrg, litellmEnabled, spendForOrg } from "../src/litellm";

/** A stand-in LiteLLM. Records what we asked it for and returns the shapes its API documents. */
interface Call {
  path: string;
  auth?: string;
  body: Record<string, unknown>;
}
async function fakeLitellm(calls: Call[], opts: { fail?: boolean } = {}) {
  let n = 0;
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      calls.push({
        path: (req.url ?? "").split("?")[0],
        auth: req.headers.authorization as string | undefined,
        body: raw ? JSON.parse(raw) : {},
      });
      const send = (code: number, b: unknown) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(b));
      };
      if (opts.fail) return send(500, { error: "boom" });
      if ((req.url ?? "").startsWith("/key/generate")) return send(200, { key: `sk-tenant-${++n}` });
      if ((req.url ?? "").startsWith("/key/info")) return send(200, { info: { spend: 4.25, max_budget: 30 } });
      send(404, {});
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

function withProxy(url: string) {
  const before = { ...process.env };
  process.env.MYCEL_LITELLM_URL = url;
  process.env.MYCEL_LITELLM_MASTER_KEY = "sk-master";
  return () => {
    if (before.MYCEL_LITELLM_URL === undefined) delete process.env.MYCEL_LITELLM_URL;
    if (before.MYCEL_LITELLM_MASTER_KEY === undefined) delete process.env.MYCEL_LITELLM_MASTER_KEY;
  };
}

test("litellm: off unless both the url and the master key are set", () => {
  delete process.env.MYCEL_LITELLM_URL;
  delete process.env.MYCEL_LITELLM_MASTER_KEY;
  assert.equal(litellmEnabled(), false);
  process.env.MYCEL_LITELLM_URL = "http://x";
  assert.equal(litellmEnabled(), false, "half-configured is off, not half-on");
  delete process.env.MYCEL_LITELLM_URL;
});

test("litellm: each org gets a key carrying its plan's budget and model allowlist", async () => {
  await initSecretStore();
  const calls: Call[] = [];
  const lt = await fakeLitellm(calls);
  const restore = withProxy(lt.url);
  try {
    const id = getIdentityStore();
    const { org } = id.createOrgWithOwner("budget-co", `b-${Date.now()}@example.com`, "a-long-password");
    id.setPlan(org.id, { plan: "starter" });

    const key = await keyForOrg(org.id);
    assert.match(key ?? "", /^sk-tenant-/);

    const mint = calls[0];
    assert.equal(mint.path, "/key/generate");
    assert.equal(mint.auth, "Bearer sk-master");
    // The ceiling the kernel checks at task creation, now also enforced per REQUEST by the proxy —
    // which is the only thing that can stop a single runaway task mid-flight.
    assert.equal(mint.body.max_budget, 30, "starter's monthly model spend");
    assert.equal(mint.body.budget_duration, "30d");
    assert.equal((mint.body.metadata as { mycel_org_id: string }).mycel_org_id, org.id);

    // The plan's tier ceiling, expressed as something the proxy enforces rather than something we
    // merely resolve on our side.
    const models = mint.body.models as string[];
    assert.ok(models.some((m) => m.includes("nano")), "fast tier");
    assert.ok(models.some((m) => m.includes("luna")), "standard tier");
    assert.ok(!models.some((m) => m.includes("terra")), "starter cannot reach the deep tier");

    // Minted once and remembered — a key per run would be a key per run to clean up.
    assert.equal(await keyForOrg(org.id), key);
    assert.equal(calls.filter((c) => c.path === "/key/generate").length, 1);

    // Upgrading re-issues, because the budget and allowlist are baked in at creation. A customer who
    // has paid to remove a ceiling must not still be holding a key that enforces it.
    id.setPlan(org.id, { plan: "growth" });
    const upgraded = await keyForOrg(org.id);
    assert.notEqual(upgraded, key);
    const second = calls.filter((c) => c.path === "/key/generate")[1];
    assert.equal(second.body.max_budget, 90);
    assert.ok((second.body.models as string[]).some((m) => m.includes("terra")), "growth reaches deep");
  } finally {
    restore();
    await lt.close();
  }
});

test("litellm: a self-hosted org is unmetered rather than capped at zero", async () => {
  // `null` means unmetered. Sending `max_budget: null` — or worse, 0 — would cap an operator's own
  // key at nothing on their own hardware.
  await initSecretStore();
  const calls: Call[] = [];
  const lt = await fakeLitellm(calls);
  const restore = withProxy(lt.url);
  try {
    const id = getIdentityStore();
    const { org } = id.createOrgWithOwner("solo-co", `s-${Date.now()}@example.com`, "a-long-password");
    await keyForOrg(org.id);
    assert.equal("max_budget" in calls[0].body, false, "no budget field at all, not a zero");
    assert.equal("budget_duration" in calls[0].body, false);
  } finally {
    restore();
    await lt.close();
  }
});

test("litellm: an unreachable proxy degrades instead of failing the run", async () => {
  // A budget broker being down must not stop a customer's business. The kernel's own ceiling still
  // applies at task creation, so this falls back to the previous behaviour rather than to no limit.
  await initSecretStore();
  const calls: Call[] = [];
  const lt = await fakeLitellm(calls, { fail: true });
  const restore = withProxy(lt.url);
  try {
    const id = getIdentityStore();
    const { org } = id.createOrgWithOwner("down-co", `d-${Date.now()}@example.com`, "a-long-password");
    assert.equal(await keyForOrg(org.id), undefined, "reports failure rather than throwing");
  } finally {
    restore();
    await lt.close();
  }

  const restore2 = withProxy("http://127.0.0.1:1");
  try {
    const id = getIdentityStore();
    const { org } = id.createOrgWithOwner("gone-co", `g-${Date.now()}@example.com`, "a-long-password");
    assert.equal(await keyForOrg(org.id), undefined);
  } finally {
    restore2();
  }
});

test("litellm: spend is readable from the proxy, which is the authority on it", async () => {
  await initSecretStore();
  const calls: Call[] = [];
  const lt = await fakeLitellm(calls);
  const restore = withProxy(lt.url);
  try {
    const id = getIdentityStore();
    const { org } = id.createOrgWithOwner("spend-co", `sp-${Date.now()}@example.com`, "a-long-password");
    id.setPlan(org.id, { plan: "starter" });
    await keyForOrg(org.id);

    const out = await spendForOrg(org.id);
    assert.deepEqual(out, { spend: 4.25, budget: 30 });

    // An org that has never made a call has no key and therefore no spend to report — undefined,
    // not a fabricated zero.
    const { org: fresh } = id.createOrgWithOwner("fresh-co", `f-${Date.now()}@example.com`, "a-long-password");
    assert.equal(await spendForOrg(fresh.id), undefined);
  } finally {
    restore();
    await lt.close();
  }
});
