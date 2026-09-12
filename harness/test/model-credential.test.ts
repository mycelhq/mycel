// THE BUG THIS FILE EXISTS FOR, OBSERVED IN PRODUCTION ON app.mycelai.dev
//
// A founder signed up, described his business, and the shaping run failed with OpenAI's own words:
// "You didn't provide an API key … You can obtain an API key from
// https://platform.openai.com/account/api-keys." He was being told to go and buy a key for a hosted
// product that brokers keys on his behalf.
//
// Two independent faults, one visible symptom:
//
//   1. The WORKER process runs every task off the queue, and its identity cache is filled once at
//      boot. The org had been created by the API container minutes earlier, so the worker's
//      `getProject(task.project_id)` was undefined → no org id → `keyForOrg` never called → no
//      LiteLLM virtual key. Evidence: worker task up 18:41:12Z, project 3866e5f5 created 18:43:41Z,
//      its draft_shape failed 18:44:51Z at $0.00, and LiteLLM's log group had only health checks.
//   2. With no tenant key the runtime fell back to OpenAI direct with `api_key: ""`, started a
//      sandbox, and let the provider produce the error. A missing credential of ours was reported as
//      a missing credential of his.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { getIdentityStore } from "../src/identity";
import { initSecretStore } from "../src/secrets";
import { keyForOrg } from "../src/litellm";
import { resolveUpstream } from "../src/runtime";
import { PRESUB_MAX_SPEND_USD, PRESUB_PLAN } from "../src/presubscription";

interface Mint {
  body: Record<string, unknown>;
}
async function fakeLitellm(mints: Mint[]) {
  let n = 0;
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      mints.push({ body: raw ? JSON.parse(raw) : {} });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ key: `sk-tenant-${++n}` }));
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

function envSandbox() {
  const before = { ...process.env };
  return () => {
    for (const k of ["MYCEL_LITELLM_URL", "MYCEL_LITELLM_MASTER_KEY", "MYCEL_LLM_UPSTREAM", "OPENAI_API_KEY"]) {
      if (before[k] === undefined) delete process.env[k];
      else process.env[k] = before[k];
    }
  };
}

test("credential: a run refuses at start when there is no usable model credential", () => {
  // The bug: it used to send `api_key: ""` to OpenAI and surface OpenAI's 401 to the founder.
  const restore = envSandbox();
  try {
    delete process.env.MYCEL_LITELLM_URL;
    delete process.env.MYCEL_LITELLM_MASTER_KEY;
    delete process.env.MYCEL_LLM_UPSTREAM;
    delete process.env.OPENAI_API_KEY;

    assert.throws(
      () => resolveUpstream("openai", undefined),
      (e: Error) => {
        assert.match(e.message, /No model credential/);
        // Names both of the things that would fix it, rather than a provider status code.
        assert.match(e.message, /MYCEL_LITELLM_MASTER_KEY/);
        assert.match(e.message, /OPENAI_API_KEY/);
        assert.match(e.message, /nothing was charged/i);
        // And never repeats the sentence that started this.
        assert.ok(!/platform\.openai\.com/.test(e.message));
        return true;
      },
    );

    // Hosted: the deployment MEANT to broker keys, so the refusal blames the broker and says whose
    // problem it is. A founder must never be asked for a key he does not supply.
    process.env.MYCEL_LITELLM_URL = "http://litellm.internal:4000";
    process.env.MYCEL_LITELLM_MASTER_KEY = "sk-master";
    assert.throws(
      () => resolveUpstream("openai", undefined, "org-123"),
      (e: Error) => {
        assert.match(e.message, /brokers model access through LiteLLM/);
        assert.match(e.message, /org-123/);
        assert.match(e.message, /ours to fix, not yours/);
        return true;
      },
    );
  } finally {
    restore();
  }
});

test("credential: a real direct-key deployment still runs — the genuine degrade is kept", () => {
  // The self-hosted operator with their own key, and the hosted deployment whose broker is down for
  // a minute. Neither may be stopped by the refusal above; a budget broker outage must not stop a
  // customer's business.
  const restore = envSandbox();
  try {
    delete process.env.MYCEL_LITELLM_URL;
    delete process.env.MYCEL_LITELLM_MASTER_KEY;
    delete process.env.MYCEL_LLM_UPSTREAM;
    process.env.OPENAI_API_KEY = "sk-operators-own";

    const out = resolveUpstream("openai", undefined);
    assert.equal(out.key, "sk-operators-own");
    assert.match(out.base, /openai\.com/);
  } finally {
    restore();
  }
});

test("credential: a tenant key routes to the proxy and is preferred over any direct key", () => {
  const restore = envSandbox();
  try {
    process.env.MYCEL_LITELLM_URL = "http://litellm.internal:4000/";
    process.env.MYCEL_LITELLM_MASTER_KEY = "sk-master";
    process.env.OPENAI_API_KEY = "sk-shared-and-unmetered";

    const out = resolveUpstream("openai", "sk-tenant-1", "org-123");
    // The shared key must never win: it is the one path with no per-org budget on it.
    assert.equal(out.key, "sk-tenant-1");
    assert.equal(out.base, "http://litellm.internal:4000/v1");
  } finally {
    restore();
  }
});

test("credential: an org created after the worker booted still gets its own budgeted key", async () => {
  // THE ROOT CAUSE. The worker's identity cache is filled at boot and never refreshed, so a signup
  // that happened since the last deploy was invisible to the process that runs the work.
  await initSecretStore();
  const restore = envSandbox();
  const mints: Mint[] = [];
  const lt = await fakeLitellm(mints);
  process.env.MYCEL_LITELLM_URL = lt.url;
  process.env.MYCEL_LITELLM_MASTER_KEY = "sk-master";
  try {
    const id = getIdentityStore();
    const orgId = "org-signed-up-after-boot";
    const projectId = "proj-signed-up-after-boot";

    // Nothing in the cache: exactly the worker's view of an org created ten minutes ago.
    assert.equal(id.getProject(projectId), undefined);

    // A durable store that does know, standing in for Postgres.
    const fakePg = {
      loadAll: async () => ({ orgs: [], projects: [], members: [], apiKeys: new Map(), invites: [] }),
      loadProjectScope: async (wanted: string) =>
        wanted === projectId
          ? {
              project: { id: projectId, org_id: orgId, name: "Finch & Pine", wedges: [], created_at: new Date().toISOString() },
              // A brand-new cloud org: the plan names what they are about to buy, the status grants
              // nothing yet.
              org: { id: orgId, name: "Finch & Pine", created_at: new Date().toISOString(), plan: "growth", plan_status: "none" },
              members: [
                {
                  id: "m1", org_id: orgId, email: "founder@finchandpine.test", role: "owner",
                  created_at: new Date().toISOString(), salt: "s", hash: "h", providers: [],
                },
              ],
            }
          : { members: [] },
      upsertOrg: async () => {},
      upsertProject: async () => {},
      upsertMember: async () => {},
      upsertApiKey: async () => {},
    };
    await id.attach(fakePg as never);

    const resolved = await id.orgIdForProject(projectId);
    assert.equal(resolved, orgId, "read through to the database rather than answering undefined");

    const key = await keyForOrg(resolved!);
    assert.match(key ?? "", /^sk-tenant-/, "a fresh unpaid org gets a key");

    const mint = mints.at(-1)!.body;
    // Not a $0 budget, and not an unmetered one either. Without hydrating the ORG alongside the
    // project, `limitsFor` would have fallen through to PLAN_LIMITS.self_hosted — unmetered — and a
    // stranger's signup would hold an uncapped key.
    assert.equal(mint.max_budget, PRESUB_MAX_SPEND_USD, "the pre-subscription allowance");
    assert.notEqual(mint.max_budget, 0);
    assert.equal(mint.budget_duration, "30d");
    assert.equal((mint.metadata as { plan: string }).plan, PRESUB_PLAN);
    assert.ok(
      !(mint.models as string[]).some((m) => m.includes("terra")),
      "an unpaid org cannot reach a tier it has never paid for",
    );

    // And the run can now start, on that key rather than on the shared one.
    assert.equal(resolveUpstream("openai", key, resolved).key, key);
  } finally {
    restore();
    await lt.close();
  }
});

test("credential: a virtual key belongs to one org and is never shared", async () => {
  await initSecretStore();
  const restore = envSandbox();
  const mints: Mint[] = [];
  const lt = await fakeLitellm(mints);
  process.env.MYCEL_LITELLM_URL = lt.url;
  process.env.MYCEL_LITELLM_MASTER_KEY = "sk-master";
  try {
    const id = getIdentityStore();
    const a = id.createOrgWithOwner("tenant-a", `a-${Date.now()}@example.com`, "a-long-password");
    const b = id.createOrgWithOwner("tenant-b", `b-${Date.now()}@example.com`, "a-long-password");
    id.setPlan(a.org.id, { plan: "starter", status: "active" });
    id.setPlan(b.org.id, { plan: "starter", status: "active" });

    const keyA = await keyForOrg(a.org.id);
    const keyB = await keyForOrg(b.org.id);
    assert.ok(keyA && keyB);
    assert.notEqual(keyA, keyB, "one key per org — a shared key is a shared budget and a shared bill");

    // Each mint is attributed to its own org, so spend cannot be booked against the wrong tenant.
    const [mintA, mintB] = mints.slice(-2).map((m) => m.body);
    assert.equal((mintA.metadata as { mycel_org_id: string }).mycel_org_id, a.org.id);
    assert.equal((mintB.metadata as { mycel_org_id: string }).mycel_org_id, b.org.id);
    assert.equal(mintA.user_id, a.org.id);
    assert.equal(mintB.user_id, b.org.id);

    // Re-reading org A returns A's key and not whatever was minted last.
    assert.equal(await keyForOrg(a.org.id), keyA);
  } finally {
    restore();
    await lt.close();
  }
});
