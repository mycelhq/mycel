import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as httpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { api, makeFreshApp } from "./helpers";
import { getDomainStore } from "../src/domain";
import { registerActionGrant } from "../src/actiongrants";
import {
  ComposioError,
  composioUserId,
  connConfig as composioConnConfig,
  isMissingManagedAuth,
  isReadTool,
  planConnect,
  slugToolkit,
} from "../src/composio";
import { getSecret } from "../src/secrets";
import { actionPreview } from "../src/actions";
import type { Connection } from "../src/contract";

// A stand-in for Composio's API. The point is not to test Composio — it's to capture exactly what
// the harness sends, because the security properties are all about what does and doesn't leave here.

interface Seen {
  path: string;
  apiKey?: string;
  body: Record<string, unknown>;
}

/**
 * Toolkit auth fixtures, shaped like `GET /api/v3/toolkits/{slug}`.
 *
 * Three cases, and the reason the fake grew a detail endpoint at all:
 *
 *   · managed OAuth        — Composio's own app. One click. Roughly 120 of the catalogue.
 *   · own-credentials only — the founder registers an OAuth app and pastes client id + secret.
 *   · not OAuth at all     — an API key, handed over directly, connected without a redirect.
 *
 * Mycel used to send all three down the managed-OAuth path, so the last two failed with a sentence
 * about auth configs that no bookkeeper could act on.
 */
const TOOLKIT_AUTH: Record<string, Record<string, unknown>> = {
  xero: {
    slug: "xero",
    name: "Xero",
    auth_schemes: ["OAUTH2"],
    composio_managed_auth_schemes: ["OAUTH2"],
    auth_config_details: [{ mode: "OAUTH2", name: "OAuth 2.0", fields: {} }],
  },
  hubspot: {
    slug: "hubspot",
    name: "HubSpot",
    auth_schemes: ["OAUTH2"],
    composio_managed_auth_schemes: ["OAUTH2"],
    auth_config_details: [{ mode: "OAUTH2", name: "OAuth 2.0", fields: {} }],
  },
  quickbooks: {
    slug: "quickbooks",
    name: "QuickBooks",
    auth_schemes: ["OAUTH2"],
    composio_managed_auth_schemes: ["OAUTH2"],
    auth_config_details: [{ mode: "OAUTH2", name: "OAuth 2.0", fields: {} }],
  },
  // Real Notion: both schemes, and Composio does hold managed credentials. Managed must win — a
  // founder should never be asked for a key when a click would do.
  notion: {
    slug: "notion",
    name: "Notion",
    auth_schemes: ["OAUTH2", "API_KEY"],
    composio_managed_auth_schemes: ["OAUTH2"],
    auth_config_details: [
      { mode: "OAUTH2", name: "OAuth 2.0", fields: {} },
      {
        mode: "API_KEY",
        name: "API Key",
        auth_hint_url: "https://www.notion.so/my-integrations",
        fields: {
          connected_account_initiation: {
            required: [
              { name: "generic_api_key", displayName: "API key", type: "string", required: true, is_secret: true },
            ],
          },
        },
      },
    ],
  },
  // No managed credentials, no OAuth. The founder pastes a key and it connects immediately.
  pinecone: {
    slug: "pinecone",
    name: "Pinecone",
    auth_schemes: ["API_KEY"],
    composio_managed_auth_schemes: [],
    auth_config_details: [
      {
        mode: "API_KEY",
        name: "API Key",
        auth_hint_url: "https://app.pinecone.io/keys",
        fields: {
          connected_account_initiation: {
            required: [
              { name: "generic_api_key", displayName: "API key", type: "string", required: true, is_secret: true },
            ],
            optional: [
              { name: "environment", displayName: "Environment", type: "string", required: false, is_secret: false },
            ],
          },
        },
      },
    ],
  },
  // No managed credentials, OAuth only: the founder registers their own app first.
  shopify: {
    slug: "shopify",
    name: "Shopify",
    auth_schemes: ["OAUTH2"],
    composio_managed_auth_schemes: [],
    auth_config_details: [
      {
        mode: "OAUTH2",
        name: "OAuth 2.0",
        auth_hint_url: "https://shopify.dev/apps",
        fields: {
          auth_config_creation: {
            required: [
              { name: "client_id", displayName: "Client ID", type: "string", required: true, is_secret: false },
              { name: "client_secret", displayName: "Client secret", type: "string", required: true, is_secret: true },
            ],
          },
        },
      },
    ],
  },
  /**
   * The toolkit that LIES, and the only fixture whose detail changes under you.
   *
   * `composio_managed_auth_schemes` says OAuth is managed; `POST /auth_configs` says otherwise. That
   * divergence is real — the catalogue is cached (ten minutes here, longer at Composio) and a
   * toolkit can lose its shared credentials between the read and the click. `stale_managed` is a
   * marker for this fake only: the auth-config endpoint refuses managed auth once and then corrects
   * the detail, which is exactly what a re-read after the refusal is supposed to discover.
   */
  airtable: {
    slug: "airtable",
    name: "Airtable",
    auth_schemes: ["OAUTH2", "API_KEY"],
    composio_managed_auth_schemes: ["OAUTH2"],
    stale_managed: true,
    auth_config_details: [
      {
        mode: "OAUTH2",
        name: "OAuth 2.0",
        fields: {
          auth_config_creation: {
            required: [
              { name: "client_id", displayName: "Client ID", type: "string", required: true, is_secret: false },
              { name: "client_secret", displayName: "Client secret", type: "string", required: true, is_secret: true },
            ],
          },
        },
      },
      {
        mode: "API_KEY",
        name: "API Key",
        auth_hint_url: "https://airtable.com/create/tokens",
        fields: {
          connected_account_initiation: {
            required: [
              { name: "generic_api_key", displayName: "API key", type: "string", required: true, is_secret: true },
            ],
          },
        },
      },
    ],
  },
};

/** Composio's real refusal when you ask for managed auth on a toolkit it has no credentials for:
 *  400, code 306, slug `Auth_Config_DefaultAuthConfigNotFound`. Reproduced verbatim because the
 *  whole fix hinges on recognising it. */
function refuseManagedAuth(res: ServerResponse, toolkit: string): void {
  res.statusCode = 400;
  res.end(
    JSON.stringify({
      error: {
        message: `Default auth config not found for toolkit "${toolkit}". Composio does not have managed credentials for this toolkit.`,
        code: 306,
        slug: "Auth_Config_DefaultAuthConfigNotFound",
        status: 400,
      },
    }),
  );
}

async function fakeComposio(): Promise<{ url: string; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = [];
  // Per-instance, because `airtable` MUTATES its fixture mid-test. A shared object would carry the
  // correction into the next test in the file, which is the same class of bug as the shared domain
  // store that made a later connect succeed on an earlier test's credentials.
  const toolkits: Record<string, Record<string, unknown>> = structuredClone(TOOLKIT_AUTH);
  const srv = httpServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      seen.push({ path: req.url ?? "", apiKey: req.headers["x-api-key"] as string | undefined, body });
      res.setHeader("content-type", "application/json");
      if (req.url?.includes("/connected_accounts") && req.method === "POST") {
        // The branch under test: a credential in `connection.state` means there is nothing to
        // authorise in a browser, so the account comes back live and with no redirect URL.
        const state = (body.connection as { state?: { authScheme?: string; val?: Record<string, unknown> } })?.state;
        if (state?.val && Object.keys(state.val).some((k) => k !== "status")) {
          res.end(
            JSON.stringify({
              id: "ca_direct_1",
              connectionData: { authScheme: state.authScheme, val: { status: "ACTIVE" } },
            }),
          );
          return;
        }
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
        const slug = String((body.toolkit as { slug?: string })?.slug ?? "");
        const managed = (body.auth_config as { type?: string })?.type === "use_composio_managed_auth";
        const fixture = toolkits[slug];
        const stale = !!fixture?.stale_managed;
        if (managed && fixture && (stale || ((fixture.composio_managed_auth_schemes as string[]) ?? []).length === 0)) {
          // The refusal is also the moment the catalogue stops lying: a caller that re-reads the
          // toolkit now sees what it actually supports.
          if (stale) {
            fixture.composio_managed_auth_schemes = [];
            delete fixture.stale_managed;
          }
          refuseManagedAuth(res, slug);
          return;
        }
        res.end(JSON.stringify({ auth_config: { id: managed ? "ac_managed_1" : "ac_custom_1" } }));
        return;
      }
      // Toolkit DETAIL — matched ahead of the list, and ahead of `/toolkits/categories`.
      const detail = /^\/api\/v3\/toolkits\/([a-z0-9_-]+)$/.exec((req.url ?? "").split("?")[0] ?? "");
      if (detail && detail[1] !== "categories") {
        const fixture = toolkits[detail[1]];
        if (!fixture) {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: { message: "Toolkit not found", slug: "Toolkit_NotFound", status: 404 } }));
          return;
        }
        res.end(JSON.stringify(fixture));
        return;
      }
      if (req.url?.startsWith("/api/v3/toolkits")) {
        res.end(
          JSON.stringify({
            items: [
              { slug: "xero", name: "Xero", auth_schemes: ["OAUTH2"], composio_managed_auth_schemes: ["OAUTH2"], meta: { logo: "https://logos.test/xero", description: "Accounting", tools_count: 40, categories: [{ id: "accounting", name: "Accounting" }] } },
              // No managed credentials and no OAuth: the catalogue has to say so before the click.
              { slug: "pinecone", name: "Pinecone", auth_schemes: ["api_key"], composio_managed_auth_schemes: [], meta: { categories: [{ id: "dev-tools", name: "Developer Tools" }] } },
              { slug: "gone", name: "Gone", deprecated: true },
              // The live API sends this shape for EVERY toolkit — a legacy id, not a flag. Reading
              // it as a boolean hid the entire catalogue.
              { slug: "live", name: "Live", meta: { categories: [{ id: "crm", name: "CRM" }] }, deprecated: { toolkitId: "abc-123" } },
            ],
            next_cursor: null,
            total_items: 4,
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
    const { app } = await makeFreshApp();
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
    const { app, store } = await makeFreshApp();
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
      wedge: "books-keeper",
      task_type: "daily_sync",
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
    const { app } = await makeFreshApp();
    const list = (await api(app, "composio/toolkits")).json as {
      items: { slug: string; composio_managed: boolean; logo?: string; tools_count?: number; categories: { slug: string; name: string }[] }[];
    };
    assert.deepEqual(
      list.items.map((t) => t.slug),
      ["xero", "pinecone", "live"],
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
    const { app } = await makeFreshApp();
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
    const { app } = await makeFreshApp();
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

// ─────────────────────────────────────────────────────────────────────────────
// Auth schemes — the founder report
//
// "Some connections don't work via OAuth. They have a special flag — needs your own credentials —
// but it triggers OAuth and errors: default auth config not found for toolkit."
//
// Accurate error, unreachable app. Composio provides managed OAuth credentials for a subset of its
// catalogue; the rest need the founder's own OAuth client, or don't use OAuth at all. These tests
// pin each branch, because the failure they replaced was silent for ~880 toolkits.
// ─────────────────────────────────────────────────────────────────────────────

test("composio: scheme choice prefers one click, then a pasted secret, then an OAuth app", () => {
  // Managed wins outright wherever it exists — that is the whole product.
  assert.deepEqual(planConnect({ auth_schemes: ["OAUTH2", "API_KEY"], managed_schemes: ["OAUTH2"], no_auth: false }), {
    scheme: "OAUTH2",
    managed: true,
    requirement: "one_click",
  });
  // No managed credentials but a pasteable key: thirty seconds, not an afternoon.
  assert.deepEqual(planConnect({ auth_schemes: ["OAUTH2", "API_KEY"], managed_schemes: [], no_auth: false }), {
    scheme: "API_KEY",
    managed: false,
    requirement: "secret",
  });
  // OAuth and nothing else, unmanaged: the founder has to register an app with the provider.
  assert.deepEqual(planConnect({ auth_schemes: ["OAUTH2"], managed_schemes: [], no_auth: false }), {
    scheme: "OAUTH2",
    managed: false,
    requirement: "own_oauth_app",
  });
  // Told nothing: say so rather than guess OAuth. Guessing OAuth is the bug.
  assert.equal(planConnect({ auth_schemes: [], managed_schemes: [], no_auth: false }).requirement, "unknown");
});

test("composio: a no-auth toolkit never offers a Connect button, because that click cannot succeed", () => {
  /**
   * THE BUG THIS NAMES. The founder opened `/apps` in production and clicked Composio, Code
   * Interpreter and Composio Search — Composio's own meta-toolkits, which require no
   * authentication — and each returned the broker's own sentence as a red toast:
   *
   *   "cannot create an auth config for Toolkit Composio because it does not require
   *   authentication."
   *
   * `no_auth` used to collapse into `one_click`, on the reasonable-sounding grounds that both are
   * "click and it works". It is not the same thing: `POST /auth_configs` for a no-auth toolkit is
   * an error BY CONSTRUCTION at the broker, so that click was unsatisfiable — no credential, no
   * retry and no amount of founder effort could ever have completed it. `one_click` is a promise
   * about what happens after the click, and here the promise was false.
   *
   * `none` is what the card reads to decide it offers no button at all and says "available,
   * nothing to connect" instead. Shown rather than hidden: the tools genuinely are reachable, so
   * dropping them would swap a broken button for a quieter untruth.
   */
  assert.deepEqual(planConnect({ auth_schemes: [], managed_schemes: [], no_auth: true }), {
    scheme: "NO_AUTH",
    managed: false,
    requirement: "none",
  });

  // Declared only as a scheme rather than as the flag. Same toolkit, same dead button.
  assert.equal(
    planConnect({ auth_schemes: ["NO_AUTH"], managed_schemes: [], no_auth: false }).requirement,
    "none",
  );

  /**
   * ORDER IS THE WHOLE FIX, AND THIS IS THE REGRESSION THAT WOULD UNDO IT.
   *
   * `no_auth` is checked BEFORE the managed-scheme branch. A meta-toolkit carrying a stray managed
   * scheme alongside `no_auth: true` used to take the managed branch, plan an OAuth connect, and
   * walk the founder straight back into the auth-config call the broker refuses. `no_auth` is a
   * statement about the TOOLKIT; a managed scheme is a statement about credentials it has no use
   * for. The toolkit's own statement wins.
   */
  assert.equal(
    planConnect({ auth_schemes: ["OAUTH2"], managed_schemes: ["OAUTH2"], no_auth: true }).requirement,
    "none",
  );
});

test("composio: the missing-managed-credentials refusal is matched on its slug, not its prose", () => {
  assert.ok(
    isMissingManagedAuth(
      new ComposioError(400, "Default auth config not found for toolkit \"pinecone\".", "Auth_Config_DefaultAuthConfigNotFound", 306),
    ),
  );
  // Same failure, reworded upstream, no slug — the prose fallback still catches it.
  assert.ok(isMissingManagedAuth(new ComposioError(400, "default auth config not found for toolkit x")));
  // And a genuine transport failure is NOT this, or we would send the founder to a form that
  // cannot help them.
  assert.ok(!isMissingManagedAuth(new ComposioError(502, "bad gateway")));
  assert.ok(!isMissingManagedAuth(new Error("boom")));
});

test("composio: the catalogue says what connecting costs BEFORE the click", async () => {
  const fake = await fakeComposio();
  process.env.COMPOSIO_API_KEY = API_KEY;
  process.env.COMPOSIO_BASE_URL = fake.url;
  try {
    const { app } = await makeFreshApp();
    const list = (await api(app, "composio/toolkits")).json as {
      items: { slug: string; auth_schemes: string[]; managed_schemes: string[]; connect: { scheme: string; managed: boolean; requirement: string } }[];
    };
    const xero = list.items.find((t) => t.slug === "xero")!;
    assert.deepEqual(xero.connect, { scheme: "OAUTH2", managed: true, requirement: "one_click" });

    const pinecone = list.items.find((t) => t.slug === "pinecone")!;
    // Composio's list examples are lowercase and everything else is uppercase; normalise, don't trust.
    assert.deepEqual(pinecone.auth_schemes, ["API_KEY"]);
    assert.deepEqual(pinecone.managed_schemes, []);
    assert.deepEqual(pinecone.connect, { scheme: "API_KEY", managed: false, requirement: "secret" });
  } finally {
    delete process.env.COMPOSIO_API_KEY;
    delete process.env.COMPOSIO_BASE_URL;
    await fake.close();
  }
});

test("composio: a toolkit with no managed credentials asks for the key instead of failing", async () => {
  const fake = await fakeComposio();
  process.env.COMPOSIO_API_KEY = API_KEY;
  process.env.COMPOSIO_BASE_URL = fake.url;
  try {
    const { app } = await makeFreshApp();
    const domain = getDomainStore();

    // What the dialog asks first: which fields does this actually need?
    const detail = (await api(app, "composio/toolkits/pinecone/auth")).json as {
      name: string;
      connect: { scheme: string; requirement: string };
      schemes: { scheme: string; managed: boolean; redirect: boolean; connect_fields: { name: string; required: boolean; is_secret: boolean }[]; hint_url?: string }[];
    };
    assert.equal(detail.connect.requirement, "secret");
    const apiKeyScheme = detail.schemes.find((s) => s.scheme === "API_KEY")!;
    assert.equal(apiKeyScheme.managed, false);
    assert.equal(apiKeyScheme.redirect, false, "nothing to authorise in a browser");
    assert.equal(apiKeyScheme.hint_url, "https://app.pinecone.io/keys", "where to go and get one");
    assert.deepEqual(
      apiKeyScheme.connect_fields.map((f) => [f.name, f.required, f.is_secret]),
      [["generic_api_key", true, true], ["environment", false, false]],
    );

    // Clicking Connect with nothing to offer must NOT be a 502 with Composio's prose on it.
    const refused = await api(app, "composio/toolkits/pinecone/connect", { method: "POST" });
    assert.equal(refused.status, 400, refused.text);
    assert.match(refused.json.error, /Pinecone needs an API key/);
    assert.ok(
      !/auth config/i.test(refused.json.error),
      "a bookkeeper reads about API keys, not about auth configs",
    );
    assert.equal(refused.json.auth_scheme, "API_KEY");
    assert.deepEqual(
      (refused.json.fields as { name: string }[]).map((f) => f.name),
      ["generic_api_key", "environment"],
      "and the refusal carries exactly the fields to render",
    );

    // Refused is not connected. The row may exist; the badge must not.
    const pendingRow = (await domain.listConnections()).find((x) => composioConnConfig(x).toolkit === "pinecone");
    assert.ok(!pendingRow?.config.verified_at, "an unfinished connect claims nothing");

    // Now with the key. No redirect, connected in the same request — and only because Composio
    // reported ACTIVE, not because a row exists.
    const done = await api(app, "composio/toolkits/pinecone/connect", {
      method: "POST",
      body: JSON.stringify({ fields: { generic_api_key: "pc-secret-key", environment: "us-east-1" } }),
    });
    assert.equal(done.status, 201, done.text);
    assert.equal(done.json.redirect_url, undefined, "an API key needs no browser round trip");
    assert.equal(done.json.connected, true);
    assert.equal(done.json.auth_scheme, "API_KEY");
    assert.equal(done.json.composio_managed, false);

    // The auth config was created with the founder's scheme, NOT with managed auth.
    const cfgReq = fake.seen.filter((s) => s.path.startsWith("/api/v3/auth_configs")).pop()!;
    assert.equal((cfgReq.body.auth_config as { type: string }).type, "use_custom_auth");
    assert.equal((cfgReq.body.auth_config as { authScheme: string }).authScheme, "API_KEY");

    // The key travels in `connection.state` — the current field, not the deprecated `data` — with
    // an explicit ACTIVE status, which is how Composio distinguishes "here is a credential" from
    // "run a redirect flow".
    const initiate = fake.seen.filter((s) => s.path === "/api/v3/connected_accounts").pop()!;
    const state = (initiate.body.connection as { state: { authScheme: string; val: Record<string, string> } }).state;
    assert.equal(state.authScheme, "API_KEY");
    assert.equal(state.val.status, "ACTIVE");
    assert.equal(state.val.generic_api_key, "pc-secret-key");
    assert.equal((initiate.body.connection as { data?: unknown }).data, undefined);

    // THE thing that must never regress: the pasted key is sealed in the vault, and nowhere near
    // the connection's config — which is returned by the API and rendered in the UI.
    const stored = (await api(app, "connections")).json as { config: Record<string, unknown> }[];
    const row = stored.find((x) => x.config.toolkit === "pinecone")!;
    assert.ok(!JSON.stringify(row).includes("pc-secret-key"), "no secret on the connection");
    assert.ok(row.config.verified_at, "ACTIVE is what earns the badge");
    assert.equal(row.config.auth_scheme, "API_KEY");
    assert.equal(await getSecret(`composio:${(row as unknown as { id: string }).id}`) !== undefined, true);

    // Reconnect without re-pasting: the vault remembers what the founder already supplied.
    const again = await api(app, "composio/toolkits/pinecone/connect", { method: "POST" });
    assert.equal(again.status, 201, again.text);
    assert.equal(again.json.connected, true);
  } finally {
    delete process.env.COMPOSIO_API_KEY;
    delete process.env.COMPOSIO_BASE_URL;
    await fake.close();
  }
});

test("composio: an own-OAuth-app toolkit asks for the client id and secret first", async () => {
  const fake = await fakeComposio();
  process.env.COMPOSIO_API_KEY = API_KEY;
  process.env.COMPOSIO_BASE_URL = fake.url;
  try {
    const { app } = await makeFreshApp();

    const refused = await api(app, "composio/toolkits/shopify/connect", { method: "POST" });
    assert.equal(refused.status, 400, refused.text);
    assert.match(refused.json.error, /Shopify needs your own OAuth app/);
    assert.deepEqual(
      (refused.json.credentials as { name: string; is_secret: boolean }[]).map((f) => [f.name, f.is_secret]),
      [["client_id", false], ["client_secret", true]],
    );

    const done = await api(app, "composio/toolkits/shopify/connect", {
      method: "POST",
      body: JSON.stringify({ credentials: { client_id: "shp_id", client_secret: "shp_secret" } }),
    });
    assert.equal(done.status, 201, done.text);
    // Own OAuth is still OAuth: there IS a browser step, and it is not connected until it finishes.
    assert.equal(done.json.redirect_url, "https://auth.xero.test/authorize?x=1");
    assert.equal(done.json.connected, false, "a redirect that nobody has followed connects nothing");

    const cfgReq = fake.seen.filter((s) => s.path.startsWith("/api/v3/auth_configs")).pop()!;
    const ac = cfgReq.body.auth_config as { type: string; authScheme: string; credentials: Record<string, string> };
    assert.equal(ac.type, "use_custom_auth");
    assert.equal(ac.authScheme, "OAUTH2");
    assert.deepEqual(ac.credentials, { client_id: "shp_id", client_secret: "shp_secret" });

    // The client secret goes to Composio and to the vault. Never to `config`, and never to the
    // audit trail — a linked-connection entry is read by anyone with audit access.
    const rows = (await api(app, "connections")).json as { config: Record<string, unknown> }[];
    const row = rows.find((x) => x.config.toolkit === "shopify")!;
    assert.ok(!JSON.stringify(row).includes("shp_secret"));
    const chain = (await api(app, "audit")).json as { action: string; detail: Record<string, unknown> }[];
    assert.ok(!JSON.stringify(chain).includes("shp_secret"));
    const linked = chain.filter((e) => e.action === "connection.linked").pop()!;
    assert.equal(linked.detail.composio_managed, false, "the audit says which path was taken");
  } finally {
    delete process.env.COMPOSIO_API_KEY;
    delete process.env.COMPOSIO_BASE_URL;
    await fake.close();
  }
});

test("composio: asking for OAuth on a toolkit with no shared credentials is a requirement, not a 502", async () => {
  // The request Mycel used to make for all thousand toolkits. Shopify supports OAuth and Composio
  // holds no credentials for it, so the honest answer is the requirement — before a single call to
  // the broker, and in words a bookkeeper can act on.
  const fake = await fakeComposio();
  process.env.COMPOSIO_API_KEY = API_KEY;
  process.env.COMPOSIO_BASE_URL = fake.url;
  try {
    const { app } = await makeFreshApp();
    // `auth_scheme: "OAUTH2"` on a toolkit whose only managed scheme is none: the request Mycel used
    // to make for every toolkit in the catalogue.
    const r = await api(app, "composio/toolkits/shopify/connect", {
      method: "POST",
      body: JSON.stringify({ auth_scheme: "OAUTH2" }),
    });
    assert.equal(r.status, 400, r.text);
    assert.match(r.json.error, /Shopify needs/);
    assert.ok(!/Composio does not have managed credentials/.test(r.json.error), "not the raw broker error");
    assert.ok(
      !fake.seen.some((s) => s.path.startsWith("/api/v3/auth_configs")),
      "and it costs nothing upstream — the toolkit already said so",
    );
  } finally {
    delete process.env.COMPOSIO_API_KEY;
    delete process.env.COMPOSIO_BASE_URL;
    await fake.close();
  }
});

test("composio: a stale 'managed' belief becomes a requirement, not a 502", async () => {
  // The harder half of the same story. Here the catalogue SAYS managed OAuth and the broker refuses
  // — a toolkit that lost its shared credentials between the read and the click. The only way out is
  // to recognise that specific 400, drop the cached belief, re-read the toolkit, and come back with
  // what it actually needs. Handing the founder a gateway error is what used to happen.
  const fake = await fakeComposio();
  process.env.COMPOSIO_API_KEY = API_KEY;
  process.env.COMPOSIO_BASE_URL = fake.url;
  try {
    const { app } = await makeFreshApp();
    const r = await api(app, "composio/toolkits/airtable/connect", { method: "POST" });

    assert.equal(r.status, 400, r.text);
    // Not OAuth, and not the OAuth requirement either: the re-read found an API key is the cheaper
    // path, so that is what the founder is asked for.
    assert.match(r.json.error, /Airtable needs an API key/);
    assert.ok(!/auth config/i.test(r.json.error), "never the broker's prose");
    assert.equal(r.json.auth_scheme, "API_KEY");
    assert.deepEqual((r.json.fields as { name: string }[]).map((f) => f.name), ["generic_api_key"]);

    // The evidence that this is the retry path and not a lucky first guess: managed auth WAS
    // attempted, and the toolkit was read a second time after the refusal.
    const managedAttempts = fake.seen.filter(
      (s) =>
        s.path.startsWith("/api/v3/auth_configs") &&
        (s.body.auth_config as { type?: string })?.type === "use_composio_managed_auth",
    );
    assert.equal(managedAttempts.length, 1, "the one-click path was tried first, as it should be");
    assert.equal(
      fake.seen.filter((s) => s.path === "/api/v3/toolkits/airtable").length,
      2,
      "the stale belief was dropped and the toolkit re-read",
    );
  } finally {
    delete process.env.COMPOSIO_API_KEY;
    delete process.env.COMPOSIO_BASE_URL;
    await fake.close();
  }
});

test("composio: a stale 'managed' belief connects on the credentials already in hand", async () => {
  // Same refusal, but the founder supplied the key up front — because the catalogue told them to, or
  // because the vault remembered it. Re-planning must USE it rather than ask again: a second prompt
  // for something already given is how a connect flow loses someone.
  const fake = await fakeComposio();
  process.env.COMPOSIO_API_KEY = API_KEY;
  process.env.COMPOSIO_BASE_URL = fake.url;
  try {
    const { app } = await makeFreshApp();
    const r = await api(app, "composio/toolkits/airtable/connect", {
      method: "POST",
      body: JSON.stringify({ fields: { generic_api_key: "key_airtable_1" } }),
    });

    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.auth_scheme, "API_KEY");
    assert.equal(r.json.composio_managed, false);
    assert.equal(r.json.connected, true, "an API key connects in the same request");
    assert.equal(r.json.redirect_url, undefined);

    // The auth config that survived is the custom one, built for the scheme the re-read found.
    const created = fake.seen.filter((s) => s.path.startsWith("/api/v3/auth_configs")).pop()!;
    const ac = created.body.auth_config as { type: string; authScheme: string };
    assert.equal(ac.type, "use_custom_auth");
    assert.equal(ac.authScheme, "API_KEY");

    // And the key is in the vault and out of the connection.
    const rows = (await api(app, "connections")).json as { config: Record<string, unknown> }[];
    const row = rows.find((x) => x.config.toolkit === "airtable")!;
    assert.ok(!JSON.stringify(row).includes("key_airtable_1"), "no secret on the connection");
    assert.equal(row.config.auth_scheme, "API_KEY");
    assert.ok(row.config.verified_at, "ACTIVE is what earns the badge");
  } finally {
    delete process.env.COMPOSIO_API_KEY;
    delete process.env.COMPOSIO_BASE_URL;
    await fake.close();
  }
});

test("composio: an unsupported scheme is refused rather than forwarded", async () => {
  const fake = await fakeComposio();
  process.env.COMPOSIO_API_KEY = API_KEY;
  process.env.COMPOSIO_BASE_URL = fake.url;
  try {
    const { app } = await makeFreshApp();
    const bogus = await api(app, "composio/toolkits/pinecone/connect", {
      method: "POST",
      body: JSON.stringify({ auth_scheme: "NOT_A_SCHEME" }),
    });
    assert.equal(bogus.status, 400);
    assert.match(bogus.json.error, /unknown auth scheme/);

    // A real scheme the toolkit doesn't offer is equally refused — Composio would take the request
    // and produce an account that can never activate.
    const wrong = await api(app, "composio/toolkits/pinecone/connect", {
      method: "POST",
      body: JSON.stringify({ auth_scheme: "OAUTH2" }),
    });
    assert.equal(wrong.status, 400);
    assert.match(wrong.json.error, /does not support OAUTH2/);
  } finally {
    delete process.env.COMPOSIO_API_KEY;
    delete process.env.COMPOSIO_BASE_URL;
    await fake.close();
  }
});
