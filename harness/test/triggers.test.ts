// Triggers: Composio rings the doorbell, Mycel starts a run.
//
// Every test here signs its own payloads against a known secret, the way cloud/test/webhook.test.ts
// does for Stripe — so the handler's real verification is exercised and nothing needs the network
// or a live Composio account.
//
// The assertions that matter are the negative ones. An unsigned delivery, a forged delivery and a
// replayed delivery must each leave the store exactly as they found it, because this is the one
// route in the kernel with no session behind it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer as httpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { api, makeApp } from "./helpers";
import { getDomainStore } from "../src/domain";
import { parseTriggerEvent, verifyWebhook } from "../src/composio";
import type { Store } from "../src/store";

const API_KEY = "comp_sk_must_never_leave_the_harness";
const WEBHOOK_SECRET = "wh_test_secret_for_local_verification";

interface Seen {
  path: string;
  method: string;
  body: Record<string, unknown>;
}

/**
 * A stand-in Composio. As in composio.test.ts, the point is to capture what the harness SENDS.
 *
 * Trigger ids are unique per registration, as Composio's are — the domain store is a process
 * singleton across this file, so a fake that returned a constant would let one test's delivery be
 * routed to another test's subscription. (Postgres forbids that outright with a unique index on
 * `trigger_id`; in memory it would just be silently confusing.)
 */
let nextTriggerId = 0;
async function fakeComposio(): Promise<{ url: string; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = [];
  const srv = httpServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      seen.push({ path: req.url ?? "", method: req.method ?? "", body: raw ? JSON.parse(raw) : {} });
      res.setHeader("content-type", "application/json");
      if (req.url?.includes("/trigger_instances/") && req.url.endsWith("/upsert")) {
        res.end(JSON.stringify({ trigger_id: `ti_test_${++nextTriggerId}` }));
        return;
      }
      res.end(JSON.stringify({ ok: true }));
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

/** Sign a body the way Composio does: HMAC-SHA256 over `id.timestamp.body`, base64, `v1,` prefixed. */
function sign(body: string, opts: { id?: string; ts?: number; secret?: string } = {}) {
  const id = opts.id ?? "msg_test_1";
  const ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
  const sig = createHmac("sha256", opts.secret ?? WEBHOOK_SECRET)
    .update(`${id}.${ts}.${body}`)
    .digest("base64");
  return {
    "webhook-id": id,
    "webhook-timestamp": ts,
    "webhook-signature": `v1,${sig}`,
    "content-type": "application/json",
  };
}

/** A V3 trigger envelope — the shape Composio delivers by default today. */
function delivery(over: { id?: string; triggerId?: string; connectedAccountId?: string } = {}) {
  return JSON.stringify({
    id: over.id ?? "msg_test_1",
    type: "composio.trigger.message",
    timestamp: new Date().toISOString(),
    metadata: {
      trigger_slug: "GMAIL_NEW_GMAIL_MESSAGE",
      trigger_id: over.triggerId ?? "ti_test_1",
      connected_account_id: over.connectedAccountId ?? "ca_test_123",
      auth_config_id: "ac_1",
    },
    data: { subject: "invoice attached", from: "billing@customer.test" },
  });
}

/**
 * Everything a webhook test needs: a subscribed connection and a fake Composio.
 *
 * The connected-account id is unique per fixture for the same reason the trigger id is — the domain
 * store outlives each test in this file, and a shared account id would let the (connection, slug)
 * fallback lookup find someone else's subscription.
 */
let nextAccount = 0;
async function subscribed(opts: { owner?: { kind: "founder" | "client"; id: string } } = {}) {
  const fake = await fakeComposio();
  process.env.COMPOSIO_API_KEY = API_KEY;
  process.env.COMPOSIO_BASE_URL = fake.url;
  process.env.COMPOSIO_WEBHOOK_SECRET = WEBHOOK_SECRET;

  const { app, store } = makeApp();
  const domain = getDomainStore();
  const projectId = (await api(app, "me")).json.projects[0].id as string;
  const caId = `ca_test_${++nextAccount}`;
  const conn = await domain.createConnection({
    project_id: projectId,
    kind: "composio",
    name: `gmail-${caId}`,
    owner: opts.owner ?? { kind: "client", id: "acme-ltd" },
    config: { toolkit: "gmail", auth_config_id: "ac_1", connected_account_id: caId },
  });
  const sub = await api(app, `connections/${conn.id}/triggers`, {
    method: "POST",
    body: JSON.stringify({
      trigger_slug: "gmail_new_gmail_message",
      wedge: "books-keeper",
      task_type: "daily_sync",
      config: { labels: ["INBOX"] },
    }),
  });
  const triggerId = sub.json?.trigger_id as string;

  const cleanup = async () => {
    delete process.env.COMPOSIO_API_KEY;
    delete process.env.COMPOSIO_BASE_URL;
    delete process.env.COMPOSIO_WEBHOOK_SECRET;
    await fake.close();
  };
  /** A delivery addressed to THIS fixture's trigger instance. */
  const mine = (over: { id?: string } = {}) =>
    delivery({ ...over, triggerId, connectedAccountId: caId });
  return { app, store, domain, projectId, caId, conn, sub, triggerId, fake, cleanup, delivery: mine };
}

/** The webhook route takes no credential, so tests must not send one either. */
const post = (app: ReturnType<typeof makeApp>["app"], body: string, headers: Record<string, string>) =>
  app.request("/v1/composio/webhook", { method: "POST", body, headers });

const taskCount = async (store: Store) => (await store.listTasks({ limit: 1000 })).length;

// ── verification, in isolation ───────────────────────────────────────────────

test("triggers: the signature is HMAC-SHA256 over id.timestamp.body, base64, with the secret as raw bytes", () => {
  const body = delivery();
  const h = sign(body);
  const args = {
    secret: WEBHOOK_SECRET,
    webhookId: h["webhook-id"],
    timestamp: h["webhook-timestamp"],
    rawBody: body,
    signature: h["webhook-signature"],
  };
  assert.deepEqual(verifyWebhook(args), { ok: true });

  // Every component is load-bearing: change any one and it must fail.
  assert.equal(verifyWebhook({ ...args, rawBody: body + " " }).ok, false, "body is covered");
  assert.equal(verifyWebhook({ ...args, webhookId: "msg_other" }).ok, false, "id is covered");
  assert.equal(verifyWebhook({ ...args, secret: "wrong" }).ok, false, "secret is covered");

  // A missing secret is a refusal, never a pass. This is what stops an unconfigured harness from
  // being an open endpoint.
  assert.deepEqual(verifyWebhook({ ...args, secret: "" }), { ok: false, reason: "no_secret" });

  // Replay: a genuinely-signed delivery from an hour ago is still refused.
  const old = Math.floor(Date.now() / 1000) - 3600;
  const stale = sign(body, { ts: old });
  assert.deepEqual(
    verifyWebhook({
      ...args,
      timestamp: stale["webhook-timestamp"],
      signature: stale["webhook-signature"],
    }),
    { ok: false, reason: "stale" },
  );
});

test("triggers: only trigger messages are events — lifecycle notices start nothing", () => {
  const v3 = parseTriggerEvent(JSON.parse(delivery()));
  assert.equal(v3?.trigger_slug, "GMAIL_NEW_GMAIL_MESSAGE");
  assert.equal(v3?.trigger_id, "ti_test_1");
  assert.equal(v3?.event_id, "msg_test_1");

  // A legacy V2 envelope still parses, with routing pulled out of the data blob.
  const v2 = parseTriggerEvent({
    type: "GMAIL_NEW_GMAIL_MESSAGE",
    data: { trigger_nano_id: "ti_2", connection_nano_id: "ca_2", user_id: "p:client:x", subject: "hi" },
  });
  assert.equal(v2?.trigger_id, "ti_2");
  assert.deepEqual(v2?.data, { subject: "hi" }, "routing fields don't leak into the agent's input");

  // A connection-expired notice comes down the same pipe and must NOT look like work to do.
  assert.equal(parseTriggerEvent({ id: "msg_9", type: "composio.connection.expired", data: {} }), undefined);
  assert.equal(parseTriggerEvent("nonsense"), undefined);
});

// ── the route ────────────────────────────────────────────────────────────────

test("triggers: subscribing registers with Composio under the owner's derived user_id", async () => {
  const t = await subscribed();
  try {
    assert.equal(t.sub.status, 201, t.sub.text);
    assert.ok(t.sub.json.trigger_id, "Composio's instance id is remembered — it is the webhook's only join key");
    assert.equal(t.sub.json.trigger_slug, "GMAIL_NEW_GMAIL_MESSAGE", "normalised to uppercase");
    assert.deepEqual(t.sub.json.owner, { kind: "client", id: "acme-ltd" });

    const upsert = t.fake.seen.find((s) => s.path.includes("/upsert"))!;
    assert.match(upsert.path, /\/trigger_instances\/GMAIL_NEW_GMAIL_MESSAGE\/upsert$/);
    assert.equal(
      upsert.body.user_id,
      `${t.projectId}:client:acme-ltd`,
      "derived from the connection's owner — a trigger pointed at another customer's mailbox is the worst hole here",
    );
    assert.equal(upsert.body.connected_account_id, t.caId);
    assert.deepEqual(upsert.body.trigger_config, { labels: ["INBOX"] });

    // Subscribing again is one subscription, not two runs per event.
    const again = await api(t.app, `connections/${t.conn.id}/triggers`, {
      method: "POST",
      body: JSON.stringify({ trigger_slug: "GMAIL_NEW_GMAIL_MESSAGE", wedge: "books-keeper", task_type: "daily_sync" }),
    });
    assert.equal(again.json.id, t.sub.json.id, "upserted, not duplicated");

    const list = (await api(t.app, `triggers?connection_id=${t.conn.id}`)).json as unknown[];
    assert.equal(list.length, 1);
  } finally {
    await t.cleanup();
  }
});

test("triggers: a verified delivery starts a run in the right project, for the right client", async () => {
  const t = await subscribed();
  try {
    const body = t.delivery();
    const res = await post(t.app, body, sign(body));
    assert.equal(res.status, 202, await res.clone().text());
    const out = (await res.json()) as { task_id: string; duplicate: boolean };
    assert.equal(out.duplicate, false);

    const task = (await t.store.getTask(out.task_id))!;
    assert.ok(task, "the doorbell produced a job");
    assert.equal(task.project_id, t.projectId);
    assert.equal(task.wedge, "books-keeper");
    assert.equal(task.task_type, "daily_sync");
    // The attribution that scopes which connections the run may use — same as an inbound portal
    // message. Without it a trigger run could reach every client's Gmail at once.
    assert.deepEqual(task.actor, { kind: "user", id: "acme-ltd" });
    assert.equal((task.input.trigger as { slug: string }).slug, "GMAIL_NEW_GMAIL_MESSAGE");
    assert.deepEqual(task.input.event, { subject: "invoice attached", from: "billing@customer.test" });

    // The subscription records that it fired, so a founder can tell a silent trigger from a broken one.
    const sub = await t.domain.getTriggerSub(t.sub.json.id);
    assert.equal(sub!.last_task_id, out.task_id);
    assert.ok(sub!.last_event_at);
  } finally {
    await t.cleanup();
  }
});

test("triggers: an unsigned or forged webhook creates nothing", async () => {
  const t = await subscribed();
  try {
    const body = t.delivery();
    const before = await taskCount(t.store);

    // No headers at all — the shape a curious stranger would send.
    const bare = await post(t.app, body, { "content-type": "application/json" });
    assert.equal(bare.status, 401);

    // Signed with a secret that isn't ours.
    const forged = await post(t.app, body, sign(body, { secret: "attacker-secret" }));
    assert.equal(forged.status, 401);

    // A real signature over a DIFFERENT body, replayed onto this one — the classic mistake of
    // verifying the parsed object instead of the bytes.
    const other = t.delivery({ id: "msg_other" });
    const stolen = await post(t.app, body, { ...sign(other), "webhook-id": "msg_test_1" });
    assert.equal(stolen.status, 401);

    // A genuinely-signed delivery from an hour ago: valid HMAC, refused anyway.
    const replayed = await post(t.app, body, sign(body, { ts: Math.floor(Date.now() / 1000) - 3600 }));
    assert.equal(replayed.status, 401);

    assert.equal(await taskCount(t.store), before, "four refusals, zero jobs");
  } finally {
    await t.cleanup();
  }
});

test("triggers: a duplicate delivery runs once", async () => {
  const t = await subscribed();
  try {
    const body = t.delivery();
    const headers = sign(body);
    const before = await taskCount(t.store);

    // Composio redelivers on any non-2xx and on its own retry timer, so this is the normal case,
    // not the exotic one.
    const first = await post(t.app, body, headers);
    const second = await post(t.app, body, headers);
    const third = await post(t.app, body, sign(body)); // re-signed: a fresh timestamp, same event id

    assert.equal(first.status, 202);
    assert.equal(second.status, 200);
    assert.equal(third.status, 200);

    const ids = await Promise.all(
      [first, second, third].map(async (r) => ((await r.json()) as { task_id: string }).task_id),
    );
    assert.equal(new Set(ids).size, 1, "the same delivery is the same task, however often it arrives");
    assert.equal(await taskCount(t.store), before + 1, "one job, three deliveries");
  } finally {
    await t.cleanup();
  }
});

test("triggers: a delivery nobody subscribed to is acknowledged, not retried forever", async () => {
  const t = await subscribed();
  try {
    const before = await taskCount(t.store);
    const body = delivery({ triggerId: "ti_nobody", connectedAccountId: "ca_nobody" });
    const res = await post(t.app, body, sign(body));
    // 200, deliberately: a 4xx would make Composio retry an event that will never have a home.
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { ignored: string }).ignored, "no subscription");
    assert.equal(await taskCount(t.store), before);
  } finally {
    await t.cleanup();
  }
});

test("triggers: a paused subscription starts nothing, even if Composio keeps delivering", async () => {
  const t = await subscribed();
  try {
    await api(t.app, `triggers/${t.sub.json.id}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: false }),
    });
    const before = await taskCount(t.store);
    const body = t.delivery({ id: "msg_after_pause" });
    const res = await post(t.app, body, sign(body, { id: "msg_after_pause" }));
    assert.equal(res.status, 200);
    assert.equal(await taskCount(t.store), before, "the local flag is what decides, not the sender");
  } finally {
    await t.cleanup();
  }
});

test("triggers: an unconfigured harness accepts no webhook at all", async () => {
  const t = await subscribed();
  try {
    // The secret is what makes this route safe. Without it the only correct behaviour is to refuse
    // everything — a route that fell back to "no verification" would be an open door to the queue.
    delete process.env.COMPOSIO_WEBHOOK_SECRET;
    const before = await taskCount(t.store);
    const body = t.delivery({ id: "msg_unconfigured" });
    const res = await post(t.app, body, sign(body, { id: "msg_unconfigured" }));
    assert.equal(res.status, 501);
    assert.equal(await taskCount(t.store), before);
  } finally {
    await t.cleanup();
  }
});

test("triggers: the plan's job ceiling applies to a doorbell exactly as it does to the API", async () => {
  const t = await subscribed();
  try {
    // Free plan: 100 jobs a month. Put the org on it and pretend they're used up, then ring the bell.
    const { getIdentityStore } = await import("../src/identity");
    const identity = getIdentityStore();
    const orgId = identity.getProject(t.projectId)!.org_id;
    identity.setPlan(orgId, { plan: "free", status: "active" });

    const store = t.store as Store & { countTasksSince: (p: string[], s: string) => Promise<number> };
    const real = store.countTasksSince.bind(store);
    store.countTasksSince = async () => 100;
    try {
      const before = await taskCount(t.store);
      const body = t.delivery({ id: "msg_over_limit" });
      const res = await post(t.app, body, sign(body, { id: "msg_over_limit" }));
      // 402, not 200: the founder is over their plan and a retry in ten minutes might well work.
      assert.equal(res.status, 402);
      assert.equal(
        await taskCount(t.store),
        before,
        "otherwise triggers are a hole straight through the metering",
      );
    } finally {
      store.countTasksSince = real;
      identity.setPlan(orgId, { plan: "self_hosted", status: "active" });
    }
  } finally {
    await t.cleanup();
  }
});

test("triggers: a valid signature cannot choose which tenant it lands in", async () => {
  // The heart of it. Composio issues ONE webhook URL and ONE signing secret per project, so a valid
  // signature proves "Composio sent this" and nothing whatsoever about whose run it should become.
  // Every founder's every customer arrives at the same endpoint with the same signature.
  //
  // So routing must come from the row we stored at registration — keyed on the trigger_id WE minted
  // — and never from anything the payload says. This asserts the payload cannot talk its way into
  // another tenant even when it is perfectly signed.
  const t = await subscribed();
  try {
    const forged = JSON.parse(t.delivery()) as {
      metadata: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    // Everything a payload could plausibly use to claim an identity.
    forged.metadata.connected_account_id = "somebody-elses-account";
    forged.metadata.auth_config_id = "somebody-elses-config";
    (forged.metadata as { project_id?: string }).project_id = "somebody-elses-project";
    forged.data.client_id = "somebody-elses-client";
    forged.data.project_id = "somebody-elses-project";

    const body = JSON.stringify(forged);
    const res = await post(t.app, body, sign(body));
    assert.equal(res.status, 202, await res.clone().text());
    const out = (await res.json()) as { task_id: string };

    const task = (await t.store.getTask(out.task_id))!;
    // Landed exactly where the SUBSCRIPTION says, not where the payload asked.
    assert.equal(task.project_id, t.projectId);
    assert.deepEqual(task.actor, { kind: "user", id: "acme-ltd" });
    assert.ok(!JSON.stringify(task.project_id).includes("somebody-elses"));
  } finally {
    await t.cleanup();
  }
});

test("triggers: a claimed user_id that isn't the connection's is refused, not obeyed", async () => {
  // The one field Composio does derive from the connected account. When it disagrees with the
  // subscription we hold, something is wrong — and the safe reading of "wrong" is refusal, because
  // the alternative is running a customer's job against a different customer's mailbox.
  const t = await subscribed();
  try {
    const forged = JSON.parse(t.delivery()) as { metadata: Record<string, unknown> };
    forged.metadata.user_id = "someone-elses-user-id";
    const body = JSON.stringify(forged);
    const res = await post(t.app, body, sign(body));

    assert.notEqual(res.status, 202, "a mismatch must not produce a run");
    const before = (await t.store.listTasks({ limit: 100 })).length;
    await post(t.app, body, sign(body, { id: "another-delivery" }));
    assert.equal((await t.store.listTasks({ limit: 100 })).length, before, "and not on retry either");
  } finally {
    await t.cleanup();
  }
});
