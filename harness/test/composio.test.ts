import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as httpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { api, makeApp } from "./helpers";
import { getDomainStore } from "../src/domain";
import { registerActionGrant } from "../src/actiongrants";
import { composioUserId, isReadTool, slugToolkit } from "../src/composio";
import { actionPreview } from "../src/actions";
import type { Connection } from "../src/contract";

// A stand-in for Composio's API. The point is not to test Composio — it's to capture exactly what
// the harness sends, because the security properties are all about what does and doesn't leave here.

interface Seen {
  path: string;
  apiKey?: string;
  body: Record<string, unknown>;
}

async function fakeComposio(): Promise<{ url: string; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = [];
  const srv = httpServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      seen.push({ path: req.url ?? "", apiKey: req.headers["x-api-key"] as string | undefined, body });
      res.setHeader("content-type", "application/json");
      if (req.url?.includes("/connected_accounts") && req.method === "POST") {
        res.end(
          JSON.stringify({
            id: "ca_test_123",
            connectionData: { authScheme: "OAUTH2", val: { status: "INITIATED", redirectUrl: "https://auth.xero.test/authorize?x=1" } },
          }),
        );
        return;
      }
      if (req.url?.includes("/connected_accounts/") && req.method === "GET") {
        res.end(JSON.stringify({ status: "ACTIVE", toolkit: { slug: "xero" } }));
        return;
      }
      if (req.url?.includes("/tools/execute/")) {
        res.end(JSON.stringify({ successful: true, data: { invoice_id: "INV-1" }, error: "", log_id: "log_1" }));
        return;
      }
      if (req.url?.startsWith("/api/v3/auth_configs")) {
        res.end(JSON.stringify({ auth_config: { id: "ac_managed_1" } }));
        return;
      }
      if (req.url?.startsWith("/api/v3/toolkits")) {
        res.end(
          JSON.stringify({
            items: [
              { slug: "xero", name: "Xero", composio_managed_auth_schemes: ["OAUTH2"], meta: { logo: "https://logos.test/xero", description: "Accounting", tools_count: 40, categories: [{ id: "accounting", name: "Accounting" }] } },
              { slug: "gone", name: "Gone", deprecated: true },
              // The live API sends this shape for EVERY toolkit — a legacy id, not a flag. Reading
              // it as a boolean hid the entire catalogue.
              { slug: "live", name: "Live", meta: { categories: [{ id: "crm", name: "CRM" }] }, deprecated: { toolkitId: "abc-123" } },
            ],
            next_cursor: null,
            total_items: 3,
          }),
        );
        return;
      }
      res.end(JSON.stringify({ items: [{ slug: "XERO_GET_INVOICES", name: "Get invoices" }] }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise<void>((r) => srv.close(() => r())),
  };
}

const API_KEY = "comp_sk_must_never_leave_the_harness";

test("composio: user_id comes from the connection owner, never from the agent", () => {
  const base = { project_id: "p1", config: {} };
  assert.equal(composioUserId({ ...base, owner: { kind: "founder", id: "founder" } }), "p1:founder");
  assert.equal(composioUserId({ ...base, owner: { kind: "client", id: "acme" } }), "p1:client:acme");
  // Two clients of the same founder must never collapse onto one Composio account, and two projects
  // must never share one either — the id is namespaced by both.
  assert.notEqual(
    composioUserId({ ...base, owner: { kind: "client", id: "acme" } }),
    composioUserId({ project_id: "p2", config: {}, owner: { kind: "client", id: "acme" } }),
  );
});

test("composio: a tool slug resolves to its toolkit", () => {
  assert.equal(slugToolkit("XERO_CREATE_INVOICE"), "xero");
  assert.equal(slugToolkit("GMAIL_SEND_EMAIL"), "gmail");
  assert.equal(slugToolkit("nonsense"), undefined);
});

test("composio: the ungated read path only accepts declared read tools", () => {
  const conn = { config: { toolkit: "xero", read_tools: ["XERO_GET_INVOICES"] } };
  assert.ok(isReadTool(conn, "XERO_GET_INVOICES"));
  assert.ok(isReadTool(conn, "xero_get_invoices"), "case-insensitive");
  // The one that matters: a write must not sneak through the ungated path.
  assert.ok(!isReadTool(conn, "XERO_CREATE_INVOICE"));
  // And a connection that declares nothing is readable through nothing. Default deny.
  assert.ok(!isReadTool({ config: { toolkit: "xero" } }, "XERO_GET_INVOICES"));
});

test("composio: connecting returns the authorise URL and stores only a reference", async () => {
  const fake = await fakeComposio();
  process.env.COMPOSIO_API_KEY = API_KEY;
  process.env.COMPOSIO_BASE_URL = fake.url;
  try {
    const { app } = makeApp();
    const domain = getDomainStore();
    const me = (await api(app, "me")).json;
    const conn = await domain.createConnection({
      project_id: me.projects[0].id,
      kind: "composio",
      name: "xero",
      owner: { kind: "client", id: "acme-ltd" },
      config: { toolkit: "xero", auth_config_id: "ac_xero_1" },
    });

    // Before connecting, the UI must show this as outstanding.
    const before = ((await api(app, "connections")).json as { id: string; has_secret: boolean }[]).find(
      (x) => x.id === conn.id,
    )!;
    assert.equal(before.has_secret, false);

    const res = await api(app, `connections/${conn.id}/composio/connect`, { method: "POST" });
    assert.equal(res.status, 201);
    assert.equal(res.json.redirect_url, "https://auth.xero.test/authorize?x=1");

    // The user_id sent to Composio is derived from the connection's owner.
    const initiate = fake.seen.find((s) => s.path.includes("/connected_accounts"))!;
    assert.equal(initiate.apiKey, API_KEY, "the key is sent to Composio…");
    assert.equal((initiate.body.connection as { user_id: string }).user_id, `${me.projects[0].id}:client:acme-ltd`);

    // …and never comes back out. Not in the response, not on the stored connection.
    assert.ok(!JSON.stringify(res.json).includes(API_KEY));
    const after = ((await api(app, "connections")).json as { id: string; has_secret: boolean; config: Record<string, unknown> }[]).find(
      (x) => x.id === conn.id,
    )!;
    assert.equal(after.has_secret, true, "connected: nothing left for the founder to supply");
    assert.equal(after.config.connected_account_id, "ca_test_123");
    assert.ok(!JSON.stringify(after).includes(API_KEY));

    const status = await api(app, `connections/${conn.id}/composio/status`);
    assert.equal(status.json.status, "ACTIVE");
    assert.equal(status.json.active, true);

    // Linking is an auditable event, recorded without any token material.
    const chain = (await api(app, `audit?project_id=${me.projects[0].id}`)).json as {
      action: string;
      detail: Record<string, unknown>;
    }[];
    const entry = chain.find((e) => e.action === "connection.linked");
    assert.ok(entry, "linking an external account lands in the audit chain");
    assert.equal(entry!.detail.toolkit, "xero");
    assert.ok(!JSON.stringify(entry).includes(API_KEY));
  } finally {
    delete process.env.COMPOSIO_API_KEY;
    delete process.env.COMPOSIO_BASE_URL;
    await fake.close();
  }
});

test("composio: a write goes through the human gate, and the agent never sees the key", async () => {
  const fake = await fakeComposio();
  process.env.COMPOSIO_API_KEY = API_KEY;
  process.env.COMPOSIO_BASE_URL = fake.url;
  try {
    const { app, store } = makeApp();
    const domain = getDomainStore();
    const me = (await api(app, "me")).json;
    const conn = await domain.createConnection({
      project_id: me.projects[0].id,
      kind: "composio",
      name: "xero",
      owner: { kind: "founder", id: "founder" },
      config: { toolkit: "xero", auth_config_id: "ac_1", connected_account_id: "ca_test_123", read_tools: ["XERO_GET_INVOICES"] },
    });

    // A task that is RUNNING and stays that way. Going through POST /v1/tasks would let the mock
    // runtime finish it before the action call, and an approval on a finished task resolves
    // immediately — the gate would look like it never fired.
    const now = new Date().toISOString();
    await store.createTask({
      id: "composio-task-1",
      project_id: me.projects[0].id,
      wedge: "enrollment-operator",
      task_type: "reply_to_lead",
      actor: { kind: "user", id: "acme" },
      input: {},
      constraints: { max_runtime_s: 300, max_cost_usd: 1, approval_required: true },
      tools: [],
      status: "running",
      cost_usd: 0,
      created_at: now,
      updated_at: now,
    } as never);
    const task = { id: "composio-task-1" };

    const nonce = await registerActionGrant({ task_id: task.id, connectionIds: [conn.id] });
    const callTool = (slug: string, path: "actions" | "reads", body: Record<string, unknown> = {}) =>
      api(app, `internal/${path}/${slug}`, {
        method: "POST",
        headers: { authorization: `Bearer ${nonce}` },
        body: JSON.stringify(body),
      });

    // A write through the READ path is refused — the read/write asymmetry has to survive Composio.
    const sneak = await callTool("XERO_CREATE_INVOICE", "reads");
    assert.equal(sneak.status, 403);
    assert.match(sneak.json.error, /not a declared read/);

    // Through the action path it stops at a human first. Approve from the other side.
    const action = callTool("XERO_CREATE_INVOICE", "actions", { arguments: { amount: 100, contact: "Acme" } });
    let approvalId: string | undefined;
    for (let i = 0; i < 200 && !approvalId; i++) {
      const pending = (await api(app, "approvals?status=pending")).json as { approval_id: string; preview: Record<string, unknown> }[];
      const mine = pending.find((a) => a.preview?.tool === "XERO_CREATE_INVOICE");
      if (mine) {
        // The preview shows the toolkit, the tool and the arguments — enough to actually decide.
        assert.equal(mine.preview.toolkit, "xero");
        assert.deepEqual(mine.preview.arguments, { amount: 100, contact: "Acme" });
        assert.ok(!JSON.stringify(mine).includes(API_KEY), "no key on the approval card");
        approvalId = mine.approval_id;
      } else {
        await new Promise((r) => setTimeout(r, 10));
      }
    }
    assert.ok(approvalId, "the brokered write raised an approval");
    await api(app, `approvals/${approvalId}/approve`, { method: "POST" });

    const out = await action;
    assert.equal(out.json.ok, true);
    assert.deepEqual(out.json.data, { invoice_id: "INV-1" });
    // What the sandbox receives must not contain the key, on success or failure.
    assert.ok(!JSON.stringify(out.json).includes(API_KEY));

    const exec = fake.seen.find((s) => s.path.includes("/tools/execute/"))!;
    assert.match(exec.path, /XERO_CREATE_INVOICE/);
    assert.equal(exec.body.user_id, `${me.projects[0].id}:founder`);
    assert.equal(exec.body.connected_account_id, "ca_test_123");
    assert.deepEqual(exec.body.arguments, { amount: 100, contact: "Acme" });
  } finally {
    delete process.env.COMPOSIO_API_KEY;
    delete process.env.COMPOSIO_BASE_URL;
    await fake.close();
  }
});

test("composio: the approval preview carries no credential material", () => {
  const conn: Connection = {
    id: "c1",
    project_id: "p1",
    kind: "composio",
    name: "xero",
    owner: { kind: "founder", id: "founder" },
    config: { toolkit: "xero", connected_account_id: "ca_1" },
    created_at: new Date().toISOString(),
  };
  const p = actionPreview(conn, "XERO_CREATE_INVOICE", { arguments: { amount: 12 } });
  assert.equal(p.toolkit, "xero");
  assert.equal(p.tool, "XERO_CREATE_INVOICE");
  assert.deepEqual(p.arguments, { amount: 12 });
  const text = JSON.stringify(p);
  assert.ok(!text.includes("ca_1"), "not even the connected-account reference belongs on a card");
});

test("composio: the catalogue hides deprecated apps, and connecting is one call and idempotent", async () => {
  // The domain store is a process singleton, so earlier tests in this file may already have made a
  // xero connection. Assert order-independent invariants rather than absolute counts.
  const fake = await fakeComposio();
  process.env.COMPOSIO_API_KEY = API_KEY;
  process.env.COMPOSIO_BASE_URL = fake.url;
  try {
    const { app } = makeApp();
    const list = (await api(app, "composio/toolkits")).json as {
      items: { slug: string; composio_managed: boolean; logo?: string; tools_count?: number; categories: { slug: string; name: string }[] }[];
    };
    assert.deepEqual(
      list.items.map((t) => t.slug),
      ["xero", "live"],
      "a deprecated toolkit isn't offered — but `deprecated: { toolkitId }` is not a deprecation",
    );
    assert.equal(list.items[0].composio_managed, true, "one click is possible for this one");
    // The store needs an icon, a description and a category per app, all of which live under
    // `meta` and were previously either dropped or flattened to a bare string.
    assert.equal(list.items[0].logo, "https://logos.test/xero");
    assert.deepEqual(list.items[0].categories, [{ slug: "accounting", name: "Accounting" }]);
    assert.equal(list.items[0].tools_count, 40);
    assert.ok(!JSON.stringify(list).includes(API_KEY));

    // Connect in ONE call: no auth config to create by hand, no client id or secret to obtain.
    // A slug no other test in this file touches, so the process-singleton store can't hand us a
    // connection that already has an auth config and make the managed-auth path look untaken.
    const connect = await api(app, "composio/toolkits/hubspot/connect", { method: "POST" });
    assert.equal(connect.status, 201);
    assert.equal(connect.json.redirect_url, "https://auth.xero.test/authorize?x=1");
    const connectionId = connect.json.connection_id as string;
    assert.ok(connectionId);

    const created = fake.seen.find((s) => s.path.startsWith("/api/v3/auth_configs"))!;
    assert.equal(
      (created.body.auth_config as { type: string }).type,
      "use_composio_managed_auth",
      "managed auth is the default — asking a founder to register an OAuth app is not a product",
    );

    const stored = ((await api(app, "connections")).json as {
      id: string;
      config: { toolkit?: string; connected_account_id?: string };
    }[]).find((x) => x.config.toolkit === "hubspot")!;
    assert.equal(stored.id, connectionId);
    assert.equal(stored.config.connected_account_id, "ca_test_123", "the reference is stored, not a token");

    // Clicking Connect again reuses everything instead of piling up duplicates — which is exactly
    // what someone does when a tab gets closed mid-flow.
    const authConfigsBefore = fake.seen.filter((s) => s.path.startsWith("/api/v3/auth_configs")).length;
    const again = await api(app, "composio/toolkits/hubspot/connect", { method: "POST" });
    assert.equal(again.json.connection_id, connectionId, "same connection");
    assert.equal(
      fake.seen.filter((s) => s.path.startsWith("/api/v3/auth_configs")).length,
      authConfigsBefore,
      "and the auth config is reused, not recreated per click",
    );

    const founderHubspot = ((await api(app, "connections")).json as {
      kind: string;
      owner: { kind: string };
      config: { toolkit?: string };
    }[]).filter((x) => x.kind === "composio" && x.config.toolkit === "hubspot" && x.owner.kind === "founder");
    assert.equal(founderHubspot.length, 1, "one connection per toolkit, not one per click");
  } finally {
    delete process.env.COMPOSIO_API_KEY;
    delete process.env.COMPOSIO_BASE_URL;
    await fake.close();
  }
});

test("composio: connecting for a client gives that client their own account", async () => {
  const fake = await fakeComposio();
  process.env.COMPOSIO_API_KEY = API_KEY;
  process.env.COMPOSIO_BASE_URL = fake.url;
  try {
    const { app } = makeApp();
    const projectId = (await api(app, "me")).json.projects[0].id;
    await api(app, "composio/toolkits/quickbooks/connect", {
      method: "POST",
      body: JSON.stringify({ client_id: "acme-ltd", name: "acme-books" }),
    });
    const initiate = fake.seen.filter((s) => s.path === "/api/v3/connected_accounts").pop()!;
    assert.equal(
      (initiate.body.connection as { user_id: string }).user_id,
      `${projectId}:client:acme-ltd`,
      "each customer's Xero is a separate Composio account under the same key",
    );
    const conn = ((await api(app, "connections")).json as {
      owner: { kind: string; id: string };
      config: { toolkit?: string };
    }[]).find((x) => x.config.toolkit === "quickbooks")!;
    assert.deepEqual(conn.owner, { kind: "client", id: "acme-ltd" });
  } finally {
    delete process.env.COMPOSIO_API_KEY;
    delete process.env.COMPOSIO_BASE_URL;
    await fake.close();
  }
});

test("composio: a blueprint-provisioned connection can still be connected in one click", async () => {
  // Blueprints declare `{toolkit: "xero"}` and cannot carry an auth config id — those are
  // per-project. Without a managed fallback the Connect button on the setup flow returned 400, so a
  // connection that arrived via a blueprint was a dead end while the same app connected fine from
  // the catalogue. Two routes to one outcome, one of them broken.
  const fake = await fakeComposio();
  process.env.COMPOSIO_API_KEY = API_KEY;
  process.env.COMPOSIO_BASE_URL = fake.url;
  try {
    const { app } = makeApp();
    const domain = getDomainStore();
    const projectId = (await api(app, "me")).json.projects[0].id;
    const conn = await domain.createConnection({
      project_id: projectId,
      kind: "composio",
      name: "blueprint-xero",
      owner: { kind: "founder", id: "founder" },
      config: { toolkit: "notion" }, // no auth_config_id, exactly as a blueprint provisions it
    });

    const r = await api(app, `connections/${conn.id}/composio/connect`, { method: "POST" });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.redirect_url, "https://auth.xero.test/authorize?x=1");

    const stored = (await domain.getConnection(conn.id))!;
    assert.ok(stored.config.auth_config_id, "an auth config was created and remembered");
    assert.equal(stored.config.connected_account_id, "ca_test_123");
  } finally {
    delete process.env.COMPOSIO_API_KEY;
    delete process.env.COMPOSIO_BASE_URL;
    await fake.close();
  }
});
