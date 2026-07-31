// LinkedIn connect + messaging. Every test here is hermetic: no browser, no network, no account.
//
// Three things are worth testing and all three are testable without LinkedIn: the pure mappers
// (against fixtures of both response shapes), the proxy rule (a policy, so it is a pure decision),
// and the cheap-sync behaviour (a mocked transport shows exactly which URL was called and how many
// bytes came back). What cannot be tested here — that LinkedIn accepts our cookies — is the live
// checklist in docs/VERIFY-LINKEDIN.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { initSecretStore, getSecret } from "../src/secrets";
import {
  conversationId,
  conversationSummaries,
  csrfFrom,
  deletedUrnsFrom,
  inboundMessages,
  mailboxUrn,
  messageText,
  restliArgs,
  syncConversations,
  syncTokenFrom,
  voyagerHeaders,
  _resetDecoration,
} from "../src/linkedin/voyager";
import {
  ProxyRequiredError,
  playwrightProxy,
  redactProxy,
  requireProxy,
  _setFetch,
} from "../src/linkedin/proxy";
import { allUsage, usageFor, _resetUsage } from "../src/linkedin/meter";
import {
  scrub,
  sessionFromCookies,
  startLogin,
  submitChallenge,
  type BrowserContextLike,
  type BrowserDriver,
  type PageLike,
} from "../src/linkedin/login";
import {
  connectWithSession,
  disconnectLinkedIn,
  getLinkedInSession,
  linkedInUsage,
  sendLinkedInMessage,
  startConnect,
  syncLinkedInInbox,
  verifyConnect,
  _resetPending,
  _setPacing,
  _setVerifier,
} from "../src/linkedin/connect";
import { executeAction } from "../src/actions";
import { getDomainStore } from "../src/domain";

await initSecretStore();
_setVerifier(async () => ({
  self_urn: "urn:li:fs_miniProfile:ME",
  mailbox_urn: "urn:li:fsd_profile:ME",
  name: "Founder Name",
}));
_setPacing(null); // pacing is exercised explicitly below; default off here

const PROXY = "http://user:pw@resi.example:8080";

// ── A configurable mock browser: connected | challenge | fail. ──
function mockDriver(scenario: "connected" | "challenge" | "fail"): BrowserDriver {
  let filledPin = "";
  const cookies =
    scenario === "fail"
      ? []
      : [
          { name: "li_at", value: "AQEDile_at_token" },
          { name: "JSESSIONID", value: '"ajax:123456"' },
        ];
  const page: PageLike = {
    async goto() {},
    async fill(sel, v) {
      if (sel.includes("pin")) filledPin = v;
    },
    async click() {},
    url: () =>
      scenario === "connected" ? "https://www.linkedin.com/feed/" : "https://www.linkedin.com/checkpoint",
    async waitForTimeout() {},
    async isVisible() {
      return scenario === "challenge";
    },
  };
  const ctx: BrowserContextLike = {
    page,
    async cookies() {
      // For the challenge scenario, cookies only become valid after the pin is submitted.
      if (scenario === "challenge" && !filledPin) return [];
      return cookies;
    },
    async close() {},
  };
  return {
    async newContext() {
      return ctx;
    },
    async close() {},
  };
}

// ── Fixtures: the two response shapes LinkedIn serves for the same inbox. ──

const legacyPayload = {
  elements: [
    {
      entityUrn: "urn:li:fs_conversation:2-abc==",
      events: [
        {
          entityUrn: "urn:li:fs_event:(2-abc==,1)",
          createdAt: 1_700_000_000_000,
          from: {
            "com.linkedin.voyager.messaging.MessagingMember": {
              miniProfile: { entityUrn: "urn:li:fs_miniProfile:LEAD", firstName: "Amina", lastName: "K" },
            },
          },
          eventContent: {
            "com.linkedin.voyager.messaging.event.MessageEvent": {
              attributedBody: { text: "interested in a demo" },
            },
          },
        },
      ],
    },
    {
      entityUrn: "urn:li:fs_conversation:2-self==",
      events: [
        {
          createdAt: 1_700_000_100_000,
          from: {
            "com.linkedin.voyager.messaging.MessagingMember": {
              miniProfile: { entityUrn: "urn:li:fs_miniProfile:ME", firstName: "Me" },
            },
          },
          eventContent: {
            "com.linkedin.voyager.messaging.event.MessageEvent": {
              attributedBody: { text: "our own outgoing" },
            },
          },
        },
      ],
    },
  ],
};

/** The messaging GraphQL / dash shape, including the cursor metadata the sync path depends on. */
const dashPayload = {
  data: {
    messengerConversationsBySyncToken: {
      elements: [
        {
          conversationUrn: "urn:li:msg_conversation:(urn:li:fsd_profile:ME,2-xyz==)",
          messages: {
            elements: [
              {
                entityUrn: "urn:li:msg_message:(urn:li:fsd_profile:ME,2-msg==)",
                deliveredAt: 1_700_000_200_000,
                body: { text: "can you send pricing?" },
                sender: {
                  hostIdentityUrn: "urn:li:fsd_profile:LEAD",
                  participantType: {
                    member: { firstName: { text: "Amina" }, lastName: { text: "K" } },
                  },
                },
              },
              {
                deliveredAt: 1_700_000_300_000,
                body: { text: "our own outgoing" },
                sender: { hostIdentityUrn: "urn:li:fsd_profile:ME" },
              },
            ],
          },
        },
      ],
      metadata: {
        newSyncToken: "TOKEN-2",
        deletedUrns: ["urn:li:msg_conversation:(urn:li:fsd_profile:ME,2-gone==)"],
      },
    },
  },
};

// ── Pure Voyager mappers ──

test("inboundMessages maps the legacy shape and skips our own outgoing", () => {
  const evs = inboundMessages(legacyPayload, "urn:li:fs_miniProfile:ME");
  assert.equal(evs.length, 1);
  assert.equal(evs[0].thread_id, "urn:li:fs_conversation:2-abc==");
  assert.equal(evs[0].from.name, "Amina K");
  assert.match(evs[0].text, /demo/);
});

test("inboundMessages maps the GraphQL/dash shape too, matching self across urn namespaces", () => {
  // The member is fs_miniProfile:ME in the session and fsd_profile:ME on the wire — the same person.
  const evs = inboundMessages(dashPayload, "urn:li:fs_miniProfile:ME");
  assert.equal(evs.length, 1, "our own outgoing message must be skipped despite the urn prefix differing");
  assert.match(evs[0].text, /pricing/);
  assert.equal(evs[0].from.name, "Amina K");
  assert.equal(evs[0].sent_at, new Date(1_700_000_200_000).toISOString());
});

test("conversationSummaries + messageText + conversationId + csrfFrom", () => {
  assert.equal(conversationSummaries(legacyPayload).length, 2);
  assert.equal(conversationSummaries(dashPayload).length, 1);
  assert.equal(messageText({ eventContent: { body: "hi" } }), "hi");
  assert.equal(messageText({ body: { text: "hi there" } }), "hi there");
  assert.equal(conversationId("urn:li:fs_conversation:2-abc=="), "2-abc==");
  assert.equal(csrfFrom('"ajax:123456"'), "ajax:123456");
});

test("the cursor and the tombstones survive the mapper", () => {
  assert.equal(syncTokenFrom(dashPayload), "TOKEN-2");
  assert.equal(deletedUrnsFrom(dashPayload).length, 1);
  assert.equal(syncTokenFrom(legacyPayload), undefined);
});

test("mailboxUrn is derived from the member urn, and restliArgs encodes urns", () => {
  assert.equal(mailboxUrn({ li_at: "x", jsessionid: "y", self_urn: "urn:li:fs_miniProfile:ABC" }), "urn:li:fsd_profile:ABC");
  assert.equal(mailboxUrn({ li_at: "x", jsessionid: "y" }), undefined);
  assert.match(restliArgs({ mailboxUrn: "urn:li:fsd_profile:ABC" }), /^\(mailboxUrn:urn%3Ali%3Afsd_profile%3AABC\)$/);
});

test("every Voyager call asks for gzip — the cheapest 3-4x available", () => {
  const h = voyagerHeaders({ li_at: "a", jsessionid: '"ajax:1"' });
  assert.match(h["accept-encoding"], /gzip/);
  assert.equal(h["csrf-token"], "ajax:1");
  assert.equal(h["x-restli-protocol-version"], "2.0.0");
});

// ── The proxy rule ──
// LinkedIn flags datacenter logins harder than anything else, so "no proxy" is a refusal, not a
// slower path. These tests are the enforcement.

test("requireProxy refuses a missing, malformed or unsupported proxy", () => {
  assert.throws(() => requireProxy(undefined), ProxyRequiredError);
  assert.throws(() => requireProxy("   "), ProxyRequiredError);
  assert.throws(() => requireProxy("not a url"), ProxyRequiredError);
  assert.throws(() => requireProxy("ftp://host:21"), ProxyRequiredError);
  assert.equal(requireProxy(PROXY), PROXY);
  assert.equal(requireProxy("socks5://h:1080"), "socks5://h:1080");
});

test("the refusal is waivable only by an env var, never by a request", () => {
  const prev = process.env.MYCEL_LINKEDIN_ALLOW_DIRECT;
  try {
    process.env.MYCEL_LINKEDIN_ALLOW_DIRECT = "1";
    assert.equal(requireProxy(undefined), undefined, "local development may egress directly");
  } finally {
    if (prev === undefined) delete process.env.MYCEL_LINKEDIN_ALLOW_DIRECT;
    else process.env.MYCEL_LINKEDIN_ALLOW_DIRECT = prev;
  }
  assert.throws(() => requireProxy(undefined), ProxyRequiredError, "and only while the var is set");
});

test("proxy credentials are parsed into fields and redacted for display", () => {
  assert.deepEqual(playwrightProxy(PROXY), {
    server: "http://resi.example:8080",
    username: "user",
    password: "pw",
  });
  const shown = redactProxy(PROXY);
  assert.equal(shown, "http://***@resi.example:8080");
  assert.ok(!shown.includes("pw"));
});

test("a login without a proxy is refused before a browser is ever launched", async () => {
  let launched = false;
  const { outcome } = await startLogin("me@co.co", "pw", {
    driverFactory: async () => {
      launched = true;
      return mockDriver("connected");
    },
  });
  assert.equal(outcome.phase, "failed");
  assert.equal(outcome.code, "linkedin_proxy_required");
  assert.equal(launched, false, "no browser, no login attempt, no flagged IP");
});

test("connecting an account without a proxy creates no connection at all", async () => {
  const before = (await getDomainStore().listConnections()).length;
  const r = await startConnect({ email: "me@co.co", password: "pw", project_id: "p1" });
  assert.equal(r.phase, "failed");
  assert.equal(r.code, "linkedin_proxy_required");
  assert.equal((await getDomainStore().listConnections()).length, before, "no half-made account left behind");
});

// ── The headless-login flow (mock browser) ──

test("login: a clean login captures the session (connected)", async () => {
  const { outcome } = await startLogin("me@co.co", "pw", {
    proxyUrl: PROXY,
    driverFactory: async () => mockDriver("connected"),
  });
  assert.equal(outcome.phase, "connected");
  assert.equal(outcome.session?.li_at, "AQEDile_at_token");
});

test("login: a challenge returns needs_2fa, then the code completes it", async () => {
  const { outcome, pending } = await startLogin("me@co.co", "pw", {
    proxyUrl: PROXY,
    driverFactory: async () => mockDriver("challenge"),
  });
  assert.equal(outcome.phase, "needs_2fa");
  assert.ok(pending);
  // What is held between the two steps is a browser, not a credential.
  assert.ok(!JSON.stringify(Object.keys(pending!)).includes("password"));
  const done = await submitChallenge(pending!, "000000");
  assert.equal(done.phase, "connected");
  assert.equal(done.session?.li_at, "AQEDile_at_token");
});

test("login: wrong credentials fail without a session", async () => {
  const { outcome } = await startLogin("me@co.co", "bad", {
    proxyUrl: PROXY,
    driverFactory: async () => mockDriver("fail"),
  });
  assert.equal(outcome.phase, "failed");
});

test("a password is scrubbed out of anything on its way to an error message", () => {
  const leaked = 'page.fill: value "hunter2000" rejected';
  assert.equal(scrub(leaked, "hunter2000"), 'page.fill: value "[redacted]" rejected');
  assert.equal(scrub(leaked, undefined), leaked);
});

test("sessionFromCookies needs both li_at and JSESSIONID", async () => {
  const only = {
    async cookies() {
      return [{ name: "li_at", value: "x" }];
    },
  } as unknown as BrowserContextLike;
  assert.equal(await sessionFromCookies(only), null);
});

// ── Connect orchestration (creates a Connection, vaults the session AND the proxy) ──

test("startConnect: clean login → connected, Connection created, session vaulted", async () => {
  _resetPending();
  const r = await startConnect({
    email: "me@co.co",
    password: "pw",
    proxyUrl: PROXY,
    project_id: "p1",
    driverFactory: async () => mockDriver("connected"),
  });
  assert.equal(r.phase, "connected");
  const conn = await getDomainStore().getConnection(r.connection_id);
  assert.ok(conn && conn.kind === "linkedin");
  const session = await getLinkedInSession(r.connection_id);
  assert.ok(session && session.li_at === "AQEDile_at_token");
  assert.equal(session!.self_urn, "urn:li:fs_miniProfile:ME"); // from the injected verifier
  assert.equal(session!.mailbox_urn, "urn:li:fsd_profile:ME"); // and the cheap sync path has a mailbox
});

test("the password is nowhere afterwards, and the proxy password is not in the returned config", async () => {
  _resetPending();
  const r = await startConnect({
    email: "me@co.co",
    password: "sup3rs3cret",
    proxyUrl: PROXY,
    project_id: "p1",
    driverFactory: async () => mockDriver("connected"),
  });
  const conn = (await getDomainStore().getConnection(r.connection_id))!;
  // `config` is returned by the connections API. Neither credential may be in it.
  const cfg = JSON.stringify(conn.config);
  assert.ok(!cfg.includes("sup3rs3cret"), "the LinkedIn password is not on the connection");
  assert.ok(!cfg.includes("pw@"), "the proxy password is not on the connection");
  assert.match(String(conn.config.proxy), /resi\.example/);
  // Nor in the vault: the only secrets keyed to this connection are the session and the proxy url.
  assert.ok(!(await getSecret(r.connection_id))!.includes("sup3rs3cret"));
  assert.equal(await getSecret(`${r.connection_id}:proxy`), PROXY);
});

test("startConnect: challenge → needs_2fa, verifyConnect finishes and vaults", async () => {
  _resetPending();
  const r = await startConnect({
    email: "me@co.co",
    password: "pw",
    proxyUrl: PROXY,
    project_id: "p1",
    driverFactory: async () => mockDriver("challenge"),
  });
  assert.equal(r.phase, "needs_2fa");
  assert.equal(await getLinkedInSession(r.connection_id), null); // nothing vaulted until verified
  const v = await verifyConnect(r.connection_id, "000000");
  assert.equal(v.phase, "connected");
  assert.ok(await getLinkedInSession(r.connection_id));
});

test("connectWithSession: the preferred path needs no password and no browser", async () => {
  const r = await connectWithSession({
    li_at: "AQEDhandoff",
    jsessionid: '"ajax:99"',
    proxyUrl: PROXY,
    project_id: "p1",
  });
  assert.equal(r.phase, "connected");
  assert.equal((await getLinkedInSession(r.connection_id))!.li_at, "AQEDhandoff");
  await disconnectLinkedIn(r.connection_id);
});

test("connectWithSession refuses cookies LinkedIn does not accept, and vaults nothing", async () => {
  _setVerifier(async () => null); // /me rejected the session
  try {
    const r = await connectWithSession({ li_at: "stale", jsessionid: '"ajax:0"', proxyUrl: PROXY, project_id: "p1" });
    assert.equal(r.phase, "failed");
    assert.equal(await getLinkedInSession(r.connection_id), null);
  } finally {
    _setVerifier(async () => ({
      self_urn: "urn:li:fs_miniProfile:ME",
      mailbox_urn: "urn:li:fsd_profile:ME",
      name: "Founder Name",
    }));
  }
});

// ── The cheap sync path ──
// Voyager has no ETag/304 (see voyager.ts), so the cursor is the whole optimisation. These tests
// assert the shape of the traffic: which endpoint, which cursor, and how many bytes.

async function connected(): Promise<import("../src/contract").Connection> {
  const r = await connectWithSession({
    li_at: "AQEDx",
    jsessionid: '"ajax:1"',
    proxyUrl: PROXY,
    project_id: "p1",
  });
  return (await getDomainStore().getConnection(r.connection_id))!;
}

function jsonResponse(body: unknown): Response {
  const text = JSON.stringify(body);
  return {
    ok: true,
    status: 200,
    headers: { get: (h: string) => (h === "content-length" ? String(Math.round(text.length / 4)) : null) },
    text: async () => text,
  } as unknown as Response;
}

test("sync: cold start pages and decorates, then every later sync rides the cursor", async () => {
  _resetUsage();
  _resetDecoration();
  const urls: string[] = [];
  _setFetch(async (url) => {
    urls.push(url);
    return jsonResponse(dashPayload);
  });
  try {
    const conn = await connected();
    const first = await syncLinkedInInbox(conn);
    assert.equal(first.via, "graphql");
    assert.match(urls[0], /voyagerMessagingGraphQL/);
    assert.match(urls[0], /count%3A20|count:20/, "a cold start is page-capped, not an unbounded inbox listing");
    assert.equal(first.syncToken, "TOKEN-2");

    // The cursor was persisted on the connection, so it survives a restart — losing it would put
    // the bandwidth bill straight back to full listings.
    const reloaded = (await getDomainStore().getConnection(conn.id))!;
    assert.equal(reloaded.config.sync_token, "TOKEN-2");

    const second = await syncLinkedInInbox(reloaded);
    assert.equal(second.via, "sync-token");
    assert.match(urls[1], /syncToken:TOKEN-2/);
    assert.ok(urls[1] !== urls[0], "the second poll is a delta, not a repeat of the first request");
  } finally {
    _setFetch(null);
  }
});

test("sync: an unchanged inbox is an empty delta, and the meter proves how few bytes it cost", async () => {
  _resetUsage();
  const empty = { data: { messengerConversationsBySyncToken: { elements: [], metadata: { newSyncToken: "TOKEN-3" } } } };
  _setFetch(async () => jsonResponse(empty));
  try {
    const conn = await connected();
    const full = await syncLinkedInInbox(conn); // cold start, establishes the cursor
    const reloaded = (await getDomainStore().getConnection(conn.id))!;
    const delta = await syncLinkedInInbox(reloaded);
    assert.equal(delta.empty, true);
    assert.equal(delta.inbound.length, 0);
    assert.ok(delta.bytes < 400, `an unchanged poll should be tiny, was ${delta.bytes}B`);
    assert.ok(full.bytes >= delta.bytes);

    const usage = linkedInUsage(conn.id)!;
    assert.equal(usage.by_op.sync.requests, 2);
    assert.equal(usage.by_op.sync.empty_deltas, 2, "both polls returned nothing to download");
    assert.ok(usage.wire_bytes > 0 && usage.wire_bytes < usage.decoded_bytes, "gzip ratio is recorded");
    assert.ok(usage.projected_monthly_wire_bytes > 0, "the number the bill is made of is computed");
    assert.ok(allUsage().some((u) => u.connection_id === conn.id));
  } finally {
    _setFetch(null);
  }
});

test("a Voyager call without a proxy is refused even with a mocked transport", async () => {
  _setFetch(async () => jsonResponse(dashPayload));
  try {
    const conn = await connected();
    // Forget the proxy the way a botched migration would, then try to sync.
    const { deleteSecret } = await import("../src/secrets");
    await deleteSecret(`${conn.id}:proxy`);
    await assert.rejects(() => syncLinkedInInbox(conn), /proxy/i);
  } finally {
    _setFetch(null);
  }
});

// ── Outbound: the approval gate, pacing, and what a send never says ──

test("sendLinkedInMessage refuses when no session is stored (reconnect needed)", async () => {
  const conn = await getDomainStore().createConnection({
    project_id: "p1",
    kind: "linkedin",
    name: "LI",
    owner: { kind: "founder", id: "founder" },
    config: {},
  });
  const res = await sendLinkedInMessage(conn, "urn:li:fs_conversation:2-x==", "hi");
  assert.equal(res.ok, false);
  assert.match(res.detail ?? "", /session not found|reconnect/);
});

test("pacing is consulted before every outbound message, and a refusal is not a crash", async () => {
  const seen: Array<[string, string]> = [];
  let sent = false;
  _setFetch(async () => {
    sent = true;
    return jsonResponse({ value: { eventUrn: "urn:li:fs_event:1" } });
  });
  const allow = { allowed: true, remaining: 10, budget: 20, nextAfterMs: 60_000 };
  try {
    const conn = await connected();

    _setPacing(async (_domain, id, kind) => {
      seen.push([id, kind]);
      return { ...allow, allowed: false, reason: "this account's message allowance for the window is used (78/80)" };
    });
    const blocked = await sendLinkedInMessage(conn, "urn:li:fs_conversation:2-x==", "hello there");
    assert.equal(blocked.ok, false);
    assert.match(blocked.detail ?? "", /paced: this account's message allowance/);
    assert.equal(sent, false, "a paced send never reaches the wire");
    assert.deepEqual(seen, [[conn.id, "message"]]);

    _setPacing(async () => allow);
    const ok = await sendLinkedInMessage(conn, "urn:li:fs_conversation:2-x==", "hello there");
    assert.equal(ok.ok, true);
    assert.equal(ok.message_id, "urn:li:fs_event:1");
    // The send path is metered too, so its (small) share of the bill is visible next to sync.
    assert.equal(usageFor(conn.id)!.by_op.send.requests, 1);
  } finally {
    _setPacing(null);
    _setFetch(null);
  }
});

test("a linkedin connection sends through executeAction — the same gated door as every other kind", async () => {
  let body = "";
  _setFetch(async (_url, init) => {
    body = String((init as any)?.body ?? "");
    return jsonResponse({ value: { eventUrn: "urn:li:fs_event:2" } });
  });
  try {
    const conn = await connected();
    const missing = await executeAction(conn, "send_message", { body: "hi" });
    assert.equal(missing.ok, false);
    assert.match(missing.detail ?? "", /thread/);

    const res = await executeAction(conn, "send_message", {
      thread: "urn:li:fs_conversation:2-abc==",
      body: "would love to chat",
    });
    assert.equal(res.ok, true);
    assert.match(body, /would love to chat/);
  } finally {
    _setFetch(null);
  }
});

test("disconnect forgets the session, the proxy and the meter", async () => {
  const conn = await connected();
  await disconnectLinkedIn(conn.id);
  assert.equal(await getLinkedInSession(conn.id), null);
  assert.equal(await getSecret(`${conn.id}:proxy`), undefined);
  assert.equal(linkedInUsage(conn.id), undefined);
});
