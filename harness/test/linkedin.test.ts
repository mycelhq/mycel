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
  linkedinChallenge,
  fetchSelf,
  _resetDecoration,
} from "../src/linkedin/voyager";
import {
  ProxyRequiredError,
  playwrightProxy,
  redactProxy,
  requireProxy,
  describeNetworkError,
  isAuthRedirect,
  isEmptyBlendedSearch,
  isEmptyVoyagerApi,
  isVoyagerApiUrl,
  isPeopleSearchUrl,
  isEmptyPeopleSearch,
  safeRedirectLocation,
  linkedinRedirectKind,
  MAX_LINKEDIN_REDIRECTS,
  _setFetch,
  _setDispatcherFor,
  proxiedFetch,
} from "../src/linkedin/proxy";
import {
  adoptStickyKey,
  allocateProxy,
  brightDataProxyUrl,
  decodoProxyUrl,
  proxyPoolStatus,
  releaseProxy,
  stickyKeyForLiAt,
  _resetProxyPoolForTests,
} from "../src/linkedin/proxy-pool";
import { allUsage, usageFor, _resetUsage } from "../src/linkedin/meter";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  searchLinkedInPeople,
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
  assert.match(h["user-agent"], /Mozilla\/5\.0/);
  assert.equal(h.referer, "https://www.linkedin.com/");
  assert.equal(h.origin, "https://www.linkedin.com");
});

test("linkedinChallenge stops the account on checkpoint, not on 429", () => {
  assert.equal(linkedinChallenge(401, {}), true);
  assert.equal(linkedinChallenge(403, {}), true);
  assert.equal(linkedinChallenge(999, {}), true);
  assert.equal(linkedinChallenge(200, {}, "https://www.linkedin.com/checkpoint/challenge"), true);
  assert.equal(linkedinChallenge(302, {}, "", "https://www.linkedin.com/checkpoint/challenge/abc"), true);
  assert.equal(linkedinChallenge(302, {}, "", "https://www.linkedin.com/uas/login"), false);
  assert.equal(linkedinChallenge(429, {}), false);
  assert.equal(linkedinChallenge(500, { message: "unavailable" }), false);
  assert.equal(linkedinChallenge(200, {}, '{"recaptchaV3Config":{"recaptchaV3SiteKey":"x"}}'), false);
  assert.equal(linkedinChallenge(200, {}, "please complete the captcha"), true);
});

test("a challenged session cannot search — Find does not spray Voyager", async () => {
  const conn = await connected();
  await getDomainStore().updateConnection(conn.id, {
    config: { ...conn.config, linkedin_challenge: { at: "2026-08-13T00:00:00Z", status: 999 } },
  });
  let called = false;
  _setFetch(async () => {
    called = true;
    return jsonResponse({});
  });
  try {
    const fresh = (await getDomainStore().getConnection(conn.id))!;
    const r = await searchLinkedInPeople(fresh, { query: "founders" });
    assert.equal(r.ok, false);
    assert.equal(r.code, "challenged");
    assert.match(r.detail ?? "", /reconnect/i);
    assert.equal(called, false, "no Voyager call after 401/403/999/captcha");
  } finally {
    _setFetch(null);
    await disconnectLinkedIn(conn.id);
  }
});

test("search_people GETs the people SRP once, not GraphQL or /search/blended, and folds France into keywords", async () => {
  const urls: string[] = [];
  const methods: string[] = [];
  const bodies: string[] = [];
  const headersSeen: Record<string, string>[] = [];
  _setFetch(async (url, init) => {
    urls.push(url);
    methods.push(String(init?.method ?? "GET").toUpperCase());
    bodies.push(String(init?.body ?? ""));
    headersSeen.push((init?.headers ?? {}) as Record<string, string>);
    return htmlResponse(ADA_SRP_HTML);
  });
  const conn = await connected();
  try {
    const r = await searchLinkedInPeople(conn, { query: "founder SaaS", location: "France", limit: 5 });
    assert.equal(r.ok, true, r.detail);
    assert.equal(urls.length, 1);
    assert.equal(methods[0], "GET");
    assert.match(urls[0], /\/search\/results\/people\/\?/);
    assert.match(urls[0], /keywords=founder(\+|%20)SaaS(\+|%20)France/);
    assert.doesNotMatch(urls[0], /origin=/);
    assert.doesNotMatch(urls[0], /\/voyager\/api\//);
    assert.doesNotMatch(urls[0], /geoUrn/i);
    assert.doesNotMatch(urls[0], /\/search\/blended/);
    assert.doesNotMatch(urls[0], /voyagerSearchDashClusters/);
    assert.equal(bodies[0], "");
    assert.match(headersSeen[0].accept ?? "", /text\/html/);
    assert.doesNotMatch(headersSeen[0].accept ?? "", /vnd\.linkedin\.normalized\+json/);
    assert.equal(headersSeen[0]["x-restli-protocol-version"], undefined);
    assert.equal(headersSeen[0]["csrf-token"], undefined);
    assert.equal(headersSeen[0].origin, undefined);
    assert.match(headersSeen[0].cookie ?? "", /li_at=/);
    assert.match(headersSeen[0].cookie ?? "", /JSESSIONID=/);
    assert.match(headersSeen[0].referer ?? "", /linkedin\.com/);
    assert.match(headersSeen[0]["user-agent"] ?? "", /Mozilla/);
    assert.equal(headersSeen[0]["sec-fetch-mode"], "navigate");
    assert.match(r.detail ?? "", /found 1 person/);
    assert.match(r.detail ?? "", /via page/);
  } finally {
    _setFetch(null);
    await disconnectLinkedIn(conn.id);
  }
});

test("search_people surfaces the undici cause, not empty fetch failed", async () => {
  const cause = Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" });
  _setFetch(async () => {
    throw new TypeError("fetch failed", { cause });
  });
  const conn = await connected();
  try {
    const r = await searchLinkedInPeople(conn, { query: "founder SaaS", location: "France" });
    assert.equal(r.ok, false);
    assert.match(r.detail ?? "", /UND_ERR_SOCKET|other side closed/);
    assert.notEqual(r.detail, "fetch failed");
  } finally {
    _setFetch(null);
    await disconnectLinkedIn(conn.id);
  }
});

test("search_people retries a stale CONNECT tunnel once, then succeeds", async () => {
  let n = 0;
  _setFetch(async () => {
    n += 1;
    if (n === 1) {
      const cause = Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" });
      throw new TypeError("fetch failed", { cause });
    }
    return jsonResponse({ data: { elements: [] } });
  });
  const conn = await connected();
  try {
    const r = await searchLinkedInPeople(conn, { query: "founder SaaS" });
    assert.equal(r.ok, true, r.detail);
    assert.equal(n, 2, "one retry on UND_ERR_SOCKET, not a spray");
  } finally {
    _setFetch(null);
    await disconnectLinkedIn(conn.id);
  }
});

function redirectResponse(status: number, location: string): Response {
  return {
    ok: false,
    status,
    headers: {
      get: (h: string) => (h.toLowerCase() === "location" ? location : null),
    },
    text: async () => "",
  } as unknown as Response;
}

test("a login Location is auth, a Voyager Location is api, and logs never include the query", () => {
  assert.equal(isAuthRedirect("https://www.linkedin.com/uas/login?session_redirect=%2Fvoyager"), true);
  assert.equal(isAuthRedirect("https://www.linkedin.com/checkpoint/challenge/abc"), true);
  assert.equal(isVoyagerApiUrl("https://www.linkedin.com/voyager/api/search/blended"), true);
  assert.equal(isVoyagerApiUrl("https://www.linkedin.com/search/results/people/"), false);
  assert.equal(isPeopleSearchUrl("https://www.linkedin.com/search/results/people/?keywords=founder"), true);
  assert.equal(isPeopleSearchUrl("https://www.linkedin.com/search/results/people/"), true);
  assert.equal(isEmptyPeopleSearch("https://www.linkedin.com/search/results/people/"), true);
  assert.equal(isEmptyPeopleSearch("https://www.linkedin.com/search/results/people/?keywords=founder"), false);
  assert.equal(linkedinRedirectKind(302, "https://www.linkedin.com/search/results/people/?keywords=x"), "page");
  assert.equal(linkedinRedirectKind(302, "https://www.linkedin.com/search/results/people/"), "page");
  assert.equal(isVoyagerApiUrl("https://evil.example/voyager/api/search/blended"), false);
  assert.equal(isEmptyBlendedSearch("https://www.linkedin.com/voyager/api/search/blended"), true);
  assert.equal(isEmptyBlendedSearch("https://www.linkedin.com/voyager/api/search/blended?q=all"), false);
  assert.equal(isEmptyVoyagerApi("https://www.linkedin.com/voyager/api/graphql"), true);
  assert.equal(isEmptyVoyagerApi("https://www.linkedin.com/voyager/api/graphql?queryId=x"), false);
  assert.equal(linkedinRedirectKind(302, "https://www.linkedin.com/uas/login"), "auth");
  assert.equal(linkedinRedirectKind(302, "http://www.linkedin.com/voyager/api/search/blended"), "api");
  assert.equal(linkedinRedirectKind(302, "https://evil.example/voyager/api/search/blended"), "other");
  assert.equal(safeRedirectLocation("https://www.linkedin.com/uas/login?session_redirect=/voyager/api/search"), "https://www.linkedin.com/uas/login");
  assert.equal(MAX_LINKEDIN_REDIRECTS, 5);
});

test("search_people does not follow a login redirect as success", async () => {
  const urls: string[] = [];
  const redirects: unknown[] = [];
  _setFetch(async (url, init) => {
    urls.push(url);
    redirects.push(init?.redirect);
    return redirectResponse(
      302,
      "https://www.linkedin.com/uas/login?session_redirect=https%3A%2F%2Fwww.linkedin.com%2Fvoyager%2Fapi%2Fsearch%2Fblended",
    );
  });
  const conn = await connected();
  try {
    const r = await searchLinkedInPeople(conn, { query: "founder SaaS", location: "France" });
    assert.equal(r.ok, false);
    assert.equal(urls.length, 1, "must not chase login → search → login");
    assert.deepEqual(redirects, ["manual"]);
    assert.match(r.detail ?? "", /302/);
    assert.match(r.detail ?? "", /\/uas\/login/);
    assert.match(r.detail ?? "", /session/);
    assert.doesNotMatch(r.detail ?? "", /redirect count exceeded/);
    assert.doesNotMatch(r.detail ?? "", /session_redirect/);
    assert.notEqual(r.code, "challenged", "a login bounce is a 302, not a persisted reconnect");
  } finally {
    _setFetch(null);
    await disconnectLinkedIn(conn.id);
  }
});

test("search_people does not bounce http↔https through the proxy", async () => {
  let n = 0;
  const methods: string[] = [];
  _setFetch(async (url, init) => {
    n += 1;
    methods.push(String(init?.method ?? "GET").toUpperCase());
    const loc = url.startsWith("https://")
      ? url.replace("https://", "http://")
      : url.replace("http://", "https://");
    return redirectResponse(302, loc);
  });
  const conn = await connected();
  try {
    const r = await searchLinkedInPeople(conn, { query: "founder SaaS" });
    assert.equal(r.ok, false);
    assert.equal(n, 1, "scheme bounce is not followed; one GET, stop");
    assert.equal(methods[0], "GET");
    assert.match(r.detail ?? "", /302/);
    assert.doesNotMatch(r.detail ?? "", /redirect count exceeded/);
  } finally {
    _setFetch(null);
    await disconnectLinkedIn(conn.id);
  }
});

test("search_people follows a 302 onto the people SRP when keywords are still on the URL", async () => {
  const urls: string[] = [];
  _setFetch(async (url) => {
    urls.push(url);
    if (urls.length === 1) {
      return redirectResponse(
        302,
        "https://www.linkedin.com/search/results/people/?keywords=founder%20SaaS%20France",
      );
    }
    return htmlResponse(ADA_SRP_HTML);
  });
  const conn = await connected();
  try {
    const r = await searchLinkedInPeople(conn, { query: "founder SaaS", location: "France" });
    assert.equal(r.ok, true, r.detail);
    assert.equal(urls.length, 2);
    assert.match(urls[0], /\/search\/results\/people\/\?/);
    assert.match(urls[1], /\/search\/results\/people\/\?/);
    assert.match(urls[1], /keywords=/);
    assert.match(r.detail ?? "", /found 1 person/);
  } finally {
    _setFetch(null);
    await disconnectLinkedIn(conn.id);
  }
});

const ADA_BPR_HTML = `<code id="bpr-guid-3498" style="display:none"><!--{"included":[{"title":{"text":"Ada Lovelace"},"publicIdentifier":"ada-lovelace","navigationUrl":"https://www.linkedin.com/in/ada-lovelace","entityUrn":"urn:li:fsd_profile:ACoAAA"}]}--></code>`;
const ADA_BPR_ENCODED_HTML = `<code id="bpr-guid-1">{&quot;included&quot;:[{&quot;title&quot;:{&quot;text&quot;:&quot;Ada Lovelace&quot;},&quot;publicIdentifier&quot;:&quot;ada-lovelace&quot;,&quot;navigationUrl&quot;:&quot;https://www.linkedin.com/in/ada-lovelace&quot;,&quot;entityUrn&quot;:&quot;urn:li:fsd_profile:ACoAAA&quot;}]}</code>`;
const LOGIN_SRP_HTML = `<html><body><form action="/uas/login"><input name="session_key" /><input type="password" name="session_password" /></form></body></html>`;
const GRAPHQL_SHELL_HTML = `<html><body><script>fetch("https://www.linkedin.com/voyager/api/graphql?queryId=voyagerSearchDashClusters.abc123def456&variables=(start:0)")</script></body></html>`;

test("search_people follows a 302 onto path-only /search/results/people/ and parses bpr-guid HTML", async () => {
  const urls: string[] = [];
  const headersSeen: Record<string, string>[] = [];
  _setFetch(async (url, init) => {
    urls.push(url);
    headersSeen.push((init?.headers ?? {}) as Record<string, string>);
    if (urls.length === 1) {
      return redirectResponse(302, "https://www.linkedin.com/search/results/people/");
    }
    assert.match(url, /\/search\/results\/people\/?$/);
    assert.doesNotMatch(url, /keywords=/);
    return htmlResponse(ADA_BPR_HTML);
  });
  const conn = await connected();
  try {
    const r = await searchLinkedInPeople(conn, { query: "founder SaaS", location: "France" });
    assert.equal(r.ok, true, r.detail);
    assert.equal(urls.length, 2, "one keywords GET, one document hop onto the HTML SRP");
    assert.match(urls[0], /\/search\/results\/people\/\?/);
    assert.match(urls[1], /\/search\/results\/people\/?$/);
    assert.match(headersSeen[1].accept ?? "", /text\/html/);
    assert.equal(headersSeen[1]["x-restli-protocol-version"], undefined);
    assert.equal(headersSeen[1]["csrf-token"], undefined);
    assert.equal(headersSeen[1].origin, undefined);
    assert.match(r.detail ?? "", /found 1 person/);
    assert.doesNotMatch(r.detail ?? "", /302/);
  } finally {
    _setFetch(null);
    await disconnectLinkedIn(conn.id);
  }
});

test("search_people parses people from a 302 HTML body when the Location is the people SRP itself", async () => {
  const urls: string[] = [];
  _setFetch(async (url) => {
    urls.push(url);
    return {
      ok: false,
      status: 302,
      headers: { get: (h: string) => (h.toLowerCase() === "location" ? url : null) },
      text: async () => ADA_BPR_ENCODED_HTML,
    } as unknown as Response;
  });
  const conn = await connected();
  try {
    const r = await searchLinkedInPeople(conn, { query: "founder SaaS", location: "France" });
    assert.equal(r.ok, true, r.detail);
    assert.equal(urls.length, 1, "self-redirect is not chased; the 302 body is the HTML SRP");
    assert.match(r.detail ?? "", /found 1 person/);
  } finally {
    _setFetch(null);
    await disconnectLinkedIn(conn.id);
  }
});

test("search_people does not fire GraphQL even when the HTML names a clusters URL", async () => {
  const urls: string[] = [];
  _setFetch(async (url) => {
    urls.push(url);
    if (urls.length === 1) {
      return redirectResponse(302, "https://www.linkedin.com/search/results/people/");
    }
    return htmlResponse(GRAPHQL_SHELL_HTML);
  });
  const conn = await connected();
  try {
    const r = await searchLinkedInPeople(conn, { query: "founder SaaS", location: "France" });
    assert.equal(r.ok, true, r.detail);
    assert.equal(urls.length, 2, "document GET + SRP hop only — no GraphQL");
    assert.match(urls[0], /\/search\/results\/people\/\?/);
    assert.match(urls[1], /\/search\/results\/people\/?$/);
    assert.equal(urls.filter((u) => u.includes("/voyager/api/graphql")).length, 0);
    assert.equal(urls.filter((u) => u.includes("/search/blended")).length, 0);
    assert.match(r.detail ?? "", /found 0 people/);
    assert.match(r.detail ?? "", /via page/);
  } finally {
    _setFetch(null);
    await disconnectLinkedIn(conn.id);
  }
});

test("search_people treats a people-SRP login form as a session error, not empty results", async () => {
  const urls: string[] = [];
  _setFetch(async (url) => {
    urls.push(url);
    if (urls.length === 1) return redirectResponse(302, "https://www.linkedin.com/search/results/people/");
    return htmlResponse(LOGIN_SRP_HTML);
  });
  const conn = await connected();
  try {
    const r = await searchLinkedInPeople(conn, { query: "founder SaaS", location: "France" });
    assert.equal(r.ok, false, r.detail);
    assert.match(r.detail ?? "", /session/);
    assert.equal(urls.filter((u) => u.includes("/voyager/api/graphql")).length, 0);
    assert.notEqual(r.code, "challenged");
  } finally {
    _setFetch(null);
    await disconnectLinkedIn(conn.id);
  }
});

test("search_people does not follow a 302 onto path-only /graphql, and does not spray a second request", async () => {
  const calls: { url: string; method: string }[] = [];
  _setFetch(async (url, init) => {
    calls.push({ url, method: String(init?.method ?? "GET").toUpperCase() });
    assert.equal(init?.redirect, "manual");
    return redirectResponse(302, "https://www.linkedin.com/voyager/api/graphql");
  });
  const conn = await connected();
  try {
    const r = await searchLinkedInPeople(conn, { query: "founder SaaS" });
    assert.equal(r.ok, false, r.detail);
    assert.equal(calls.length, 1, "one Find is one GET — no typeahead/REST spray");
    assert.equal(calls[0].method, "GET");
    assert.match(calls[0].url, /\/search\/results\/people\//);
    assert.match(r.detail ?? "", /302/);
    assert.match(r.detail ?? "", /\/voyager\/api\/graphql/);
  } finally {
    _setFetch(null);
    await disconnectLinkedIn(conn.id);
  }
});

const LIVE_BLENDED_LOCATION = "https://www.linkedin.com/voyager/api/search/blended";

const ADA_SRP_HTML = `<div role="listitem"><a href="https://www.linkedin.com/in/ada-lovelace/">Ada Lovelace</a><p><span>Mathematician</span></p><p><span>London</span></p><div id="SearchResultsACoAAAAda"></div></div>`;

function htmlResponse(html: string): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: (h: string) => (h === "content-length" ? String(html.length) : null) },
    text: async () => html,
  } as unknown as Response;
}

test("search_people parses people from the SSR page, never GET /search/blended", async () => {
  const urls: string[] = [];
  const methods: string[] = [];
  _setFetch(async (url, init) => {
    urls.push(url);
    methods.push(String(init?.method ?? "GET").toUpperCase());
    assert.equal(init?.redirect, "manual");
    return htmlResponse(ADA_SRP_HTML);
  });
  const conn = await connected();
  try {
    const r = await searchLinkedInPeople(conn, { query: "founder SaaS", location: "France" });
    assert.equal(r.ok, true, r.detail);
    assert.equal(urls.length, 1);
    assert.equal(methods[0], "GET");
    assert.match(urls[0], /\/search\/results\/people\//);
    assert.doesNotMatch(urls[0], /\/search\/blended/);
    assert.doesNotMatch(urls[0], /\/voyager\/api\/graphql/);
    assert.match(r.detail ?? "", /found 1 person/);
    assert.match(r.detail ?? "", /via page/);
  } finally {
    _setFetch(null);
    await disconnectLinkedIn(conn.id);
  }
});

test("a 302 onto path-only /search/blended is not the search and is not retried", async () => {
  const calls: { url: string; method: string }[] = [];
  _setFetch(async (url, init) => {
    calls.push({ url, method: String(init?.method ?? "GET").toUpperCase() });
    assert.equal(init?.redirect, "manual");
    return redirectResponse(302, LIVE_BLENDED_LOCATION);
  });
  const conn = await connected();
  try {
    const r = await searchLinkedInPeople(conn, { query: "founder SaaS", location: "France" });
    assert.equal(r.ok, false, r.detail);
    assert.equal(calls.length, 1);
    assert.equal(calls.filter((c) => c.url.includes("/search/blended")).length, 0);
    assert.match(r.detail ?? "", /302/);
  } finally {
    _setFetch(null);
    await disconnectLinkedIn(conn.id);
  }
});

test("a 302 onto path-only /voyager/api/graphql is not followed as GET of that path", async () => {
  const calls: { url: string; method: string }[] = [];
  _setFetch(async (url, init) => {
    calls.push({ url, method: String(init?.method ?? "GET").toUpperCase() });
    assert.equal(init?.redirect, "manual");
    return redirectResponse(302, "https://www.linkedin.com/voyager/api/graphql");
  });
  const conn = await connected();
  try {
    const r = await searchLinkedInPeople(conn, { query: "founder SaaS", location: "France" });
    assert.equal(r.ok, false, r.detail);
    assert.equal(calls.length, 1);
    assert.equal(calls.filter((c) => c.url.includes("/voyager/api/graphql")).length, 0);
    assert.match(r.detail ?? "", /302/);
  } finally {
    _setFetch(null);
    await disconnectLinkedIn(conn.id);
  }
});

test("when the people SRP 302s, Find stops — no typeahead or REST spray", async () => {
  const urls: string[] = [];
  const methods: string[] = [];
  _setFetch(async (url, init) => {
    urls.push(url);
    methods.push(String(init?.method ?? "GET").toUpperCase());
    return redirectResponse(302, "https://www.linkedin.com/voyager/api/graphql");
  });
  const conn = await connected();
  try {
    const r = await searchLinkedInPeople(conn, { query: "founder SaaS", location: "France" });
    assert.equal(r.ok, false, r.detail);
    assert.equal(urls.length, 1);
    assert.equal(methods[0], "GET");
    assert.equal(urls.filter((u) => u.includes("voyagerSearchDashReusableTypeahead")).length, 0);
    assert.equal(urls.filter((u) => u.includes("/search/blended")).length, 0);
    assert.match(r.detail ?? "", /302/);
  } finally {
    _setFetch(null);
    await disconnectLinkedIn(conn.id);
  }
});

test("proxiedFetch does not follow a GraphQL POST 302 as GET, even when Location has a query", async () => {
  let n = 0;
  const methods: string[] = [];
  _setFetch(async (_url, init) => {
    n += 1;
    methods.push(String(init?.method ?? "GET").toUpperCase());
    return redirectResponse(
      302,
      "https://www.linkedin.com/voyager/api/graphql?queryId=voyagerSearchDashClusters.x",
    );
  });
  try {
    const res = await proxiedFetch(
      "https://www.linkedin.com/voyager/api/graphql",
      { method: "POST", body: '{"queryId":"x"}', headers: { cookie: "li_at=x; JSESSIONID=y" } },
      PROXY,
      "voyager search",
    );
    assert.equal(res.status, 302);
    assert.equal(n, 1, "GraphQL POST 302 must not become a GET follow");
    assert.deepEqual(methods, ["POST"]);
  } finally {
    _setFetch(null);
  }
});

test("proxiedFetch does not follow a path-only /voyager/api/graphql Location on GET", async () => {
  let n = 0;
  _setFetch(async () => {
    n += 1;
    return redirectResponse(302, "https://www.linkedin.com/voyager/api/graphql");
  });
  try {
    const res = await proxiedFetch(
      "https://www.linkedin.com/voyager/api/graphql?queryId=voyagerSearchDashClusters.x",
      { method: "GET", headers: { cookie: "li_at=x; JSESSIONID=y" } },
      PROXY,
      "voyager search",
    );
    assert.equal(res.status, 302);
    assert.equal(n, 1, "path-only graphql is a dead hop — do not follow it");
  } finally {
    _setFetch(null);
  }
});

test("proxiedFetch does not follow a path-only /search/blended Location", async () => {
  let n = 0;
  _setFetch(async () => {
    n += 1;
    return redirectResponse(302, LIVE_BLENDED_LOCATION);
  });
  try {
    const res = await proxiedFetch(
      "https://www.linkedin.com/voyager/api/graphql?queryId=voyagerSearchDashClusters.x",
      { method: "GET", headers: { cookie: "li_at=x; JSESSIONID=y" } },
      PROXY,
      "voyager search",
    );
    assert.equal(res.status, 302);
    assert.equal(n, 1, "path-only blended is a dead search endpoint — do not hop onto it");
  } finally {
    _setFetch(null);
  }
});

test("a 302 onto blended turns POST into GET and keeps cookies on the dispatcher", async () => {
  const loc = "https://www.linkedin.com/voyager/api/search/blended?q=all";
  const calls: { url: string; method: string; cookie: boolean; body: boolean }[] = [];
  _setFetch(async (url, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url,
      method: String(init?.method ?? "GET").toUpperCase(),
      cookie: Boolean(headers.cookie || headers.Cookie),
      body: init?.body != null,
    });
    if (String(init?.method ?? "GET").toUpperCase() === "POST") return redirectResponse(302, loc);
    return jsonResponse({ ok: true });
  });
  try {
    const res = await proxiedFetch(
      "https://www.linkedin.com/voyager/api/search/blended?q=all",
      { method: "POST", body: "{}", headers: { cookie: "li_at=x; JSESSIONID=y" } },
      PROXY,
      "voyager search",
    );
    assert.equal(res.status, 200);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[1].method, "GET");
    assert.equal(calls[1].body, false);
    assert.equal(calls[1].url, loc);
    assert.equal(calls[1].cookie, true);
  } finally {
    _setFetch(null);
  }
});

test("a checkpoint Location stops search as a challenge, not a redirect loop", async () => {
  let n = 0;
  _setFetch(async () => {
    n += 1;
    return redirectResponse(302, "https://www.linkedin.com/checkpoint/challenge/abc");
  });
  const conn = await connected();
  try {
    const r = await searchLinkedInPeople(conn, { query: "founder SaaS" });
    assert.equal(r.ok, false);
    assert.equal(r.code, "challenged");
    assert.equal(n, 1);
    await new Promise((ok) => setTimeout(ok, 50));
    const fresh = (await getDomainStore().getConnection(conn.id))!;
    assert.ok(fresh.config?.linkedin_challenge, "checkpoint is persisted so Find does not spray");
  } finally {
    _setFetch(null);
    await disconnectLinkedIn(conn.id);
  }
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
    assert.match(r.error ?? "", /rejected those cookies/);
    assert.equal(await getLinkedInSession(r.connection_id), null);
    assert.equal(await getDomainStore().getConnection(r.connection_id), undefined);
  } finally {
    _setVerifier(async () => ({
      self_urn: "urn:li:fs_miniProfile:ME",
      mailbox_urn: "urn:li:fsd_profile:ME",
      name: "Founder Name",
    }));
  }
});

test("401 from LinkedIn /me is cookie rejection", async () => {
  _setVerifier(fetchSelf);
  _setFetch(async () =>
    ({
      ok: false,
      status: 401,
      headers: { get: () => null },
      text: async () => "",
    }) as unknown as Response,
  );
  try {
    const r = await connectWithSession({ li_at: "stale", jsessionid: '"ajax:0"', proxyUrl: PROXY, project_id: "p1" });
    assert.equal(r.phase, "failed");
    assert.match(r.error ?? "", /rejected those cookies/);
    assert.doesNotMatch(r.error ?? "", /undici|dispatcher|proxy/i);
  } finally {
    _setFetch(null);
    _setVerifier(async () => ({
      self_urn: "urn:li:fs_miniProfile:ME",
      mailbox_urn: "urn:li:fsd_profile:ME",
      name: "Founder Name",
    }));
  }
});

test("a missing undici / dispatcher throw is not mapped to cookie rejection", async () => {
  _setVerifier(fetchSelf);
  _setDispatcherFor(async () => {
    throw new ProxyRequiredError(
      "the `undici` package is required to route LinkedIn traffic through a proxy " +
        "(`npm i undici`). Refusing to fall back to a direct connection.",
    );
  });
  try {
    const r = await connectWithSession({
      li_at: "AQEDx",
      jsessionid: '"ajax:1"',
      proxyUrl: PROXY,
      project_id: "p1",
    });
    assert.equal(r.phase, "failed");
    assert.match(r.error ?? "", /undici/i);
    assert.doesNotMatch(r.error ?? "", /rejected those cookies/);
    assert.equal(r.code, "linkedin_proxy_required");
    assert.equal(await getLinkedInSession(r.connection_id), null);
  } finally {
    _setDispatcherFor(null);
    _setVerifier(async () => ({
      self_urn: "urn:li:fs_miniProfile:ME",
      mailbox_urn: "urn:li:fsd_profile:ME",
      name: "Founder Name",
    }));
  }
});

test("a generic dispatcher throw is not mapped to cookie rejection", async () => {
  _setVerifier(fetchSelf);
  _setDispatcherFor(async () => {
    throw new Error("undici required");
  });
  try {
    const r = await connectWithSession({
      li_at: "AQEDx",
      jsessionid: '"ajax:1"',
      proxyUrl: PROXY,
      project_id: "p1",
    });
    assert.equal(r.phase, "failed");
    assert.match(r.error ?? "", /undici required/);
    assert.doesNotMatch(r.error ?? "", /rejected those cookies/);
  } finally {
    _setDispatcherFor(null);
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
  let url = "";
  _setFetch(async (u, init) => {
    url = String(u);
    body = String((init as any)?.body ?? "");
    return jsonResponse({ value: { eventUrn: "urn:li:fs_event:2", entityUrn: "urn:li:fs_conversation:2-abc==" } });
  });
  try {
    const conn = await connected();
    const missing = await executeAction(conn, "send_message", { body: "hi" });
    assert.equal(missing.ok, false);
    assert.match(missing.detail ?? "", /thread|profile_id/);

    const res = await executeAction(conn, "send_message", {
      thread: "urn:li:fs_conversation:2-abc==",
      body: "would love to chat",
    });
    assert.equal(res.ok, true);
    assert.match(body, /would love to chat/);
    assert.match(url, /events\?action=create/, "an existing thread posts an event into it");

    // The other door. After an accept there is usually no conversation at all, so `profile_id`
    // opens one — a different Voyager endpoint, a different body shape, and the urn it mints comes
    // back so the sequencer can keep it.
    // A cold open — no thread — so LinkedIn's `cold_initiate_requires_approval` applies and the
    // caller must say a human signed off. See the guard block in `executeAction`.
    const unapproved = await executeAction(conn, "send_message", {
      profile_id: "dana-okafor",
      body: "hi Dana — quick question",
    });
    assert.equal(unapproved.ok, false, "an unattended cold open is refused, not sent");
    assert.equal(unapproved.code, "approval_required");

    const first = await executeAction(
      conn,
      "send_message",
      { profile_id: "dana-okafor", body: "hi Dana — quick question" },
      { approved: "the founder approved this campaign" },
    );
    assert.equal(first.ok, true);
    assert.equal((first.data as { thread?: string })?.thread, "urn:li:fs_conversation:2-abc==");
    assert.match(url, /messaging\/conversations$/);
    assert.match(body, /dana-okafor/);
    assert.match(body, /hi Dana/);
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

// ── ISP proxy pool (Decodo / Bright Data / static) ──
// GTM connects without a hand-pasted proxy_url when the host has a pool. One sticky identity per
// LinkedIn connection; release on disconnect so static IPs recycle. Geo must match the member.

function withPoolEnv(env: Record<string, string | undefined>, fn: () => void | Promise<void>) {
  const keys = Object.keys(env);
  const prev: Record<string, string | undefined> = {};
  for (const k of keys) {
    prev[k] = process.env[k];
    const v = env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return Promise.resolve(fn()).finally(() => {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  });
}

test("Decodo URL is pinned to the bought country, not hashed across members", () => {
  withPoolEnv(
    {
      MYCEL_DECODO_USERNAME: "mycel_gtm",
      MYCEL_DECODO_PASSWORD: "s3cret",
      MYCEL_DECODO_HOST: "isp.decodo.com",
      MYCEL_DECODO_PORT_BASE: "10001",
      MYCEL_DECODO_COUNTRIES: "fr,es,gb",
    },
    () => {
      const islam = decodoProxyUrl("li:at:islam", "fr");
      const rania = decodoProxyUrl("li:at:rania", "es");
      const uk = decodoProxyUrl("li:at:spare", "gb");
      assert.match(islam, /^http:\/\//);
      assert.match(islam, /user-mycel_gtm-country-fr/);
      assert.match(islam, /isp\.decodo\.com:10001/);
      assert.match(rania, /user-mycel_gtm-country-es/);
      assert.match(rania, /isp\.decodo\.com:10002/);
      assert.match(uk, /user-mycel_gtm-country-gb/);
      assert.match(uk, /isp\.decodo\.com:10003/);
      // One IP per country: any member in FR builds the same endpoint. The lease layer refuses a second seat.
      assert.equal(decodoProxyUrl("li:at:other-member", "fr"), islam);
      process.env.MYCEL_DECODO_USERNAME = "user-mycel_gtm";
      assert.match(decodoProxyUrl("li:at:islam", "fr"), /user-mycel_gtm-country-fr/);
      assert.doesNotMatch(decodoProxyUrl("li:at:islam", "fr"), /user-user-/);
    },
  );
});

test("Bright Data URL is sticky to the member key and geo", () => {
  withPoolEnv(
    {
      MYCEL_BRIGHTDATA_CUSTOMER: "c123",
      MYCEL_BRIGHTDATA_ZONE: "isp_linkedin",
      MYCEL_BRIGHTDATA_PASSWORD: "s3cret",
      MYCEL_BRIGHTDATA_HOST: "brd.superproxy.io",
      MYCEL_BRIGHTDATA_PORT: "33335",
    },
    () => {
      const id = "li:at:a1b2c3d4e5f67890abcd1234567890ab";
      const url = brightDataProxyUrl(id, "us");
      assert.match(url, /^http:\/\//);
      assert.match(url, /brd-customer-c123-zone-isp_linkedin-country-us-session-liata1b2c3d4e5f67890abcd12345678/);
      assert.match(url, /brd\.superproxy\.io:33335/);
      // Same member → same sticky session token.
      assert.equal(brightDataProxyUrl(id, "us"), url);
      assert.notEqual(brightDataProxyUrl("li:at:other-member", "us"), url);
    },
  );
});

test("Decodo pool auto-leases on connect and prefers member country", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mycel-proxy-"));
  const ledger = join(dir, "leases.json");
  await withPoolEnv(
    {
      MYCEL_LINKEDIN_PROXY_PROVIDER: "decodo",
      MYCEL_DECODO_USERNAME: "mycel_gtm",
      MYCEL_DECODO_PASSWORD: "s3cret",
      MYCEL_DECODO_COUNTRIES: "fr,es,gb",
      MYCEL_LINKEDIN_PROXY_LEDGER: ledger,
      MYCEL_LINKEDIN_PROXY_POOL: undefined,
      MYCEL_BRIGHTDATA_CUSTOMER: undefined,
      MYCEL_BRIGHTDATA_ZONE: undefined,
      MYCEL_BRIGHTDATA_PASSWORD: undefined,
    },
    async () => {
      _resetProxyPoolForTests(ledger);
      assert.equal(proxyPoolStatus().provider, "decodo");
      assert.equal(proxyPoolStatus().total, 3);
      assert.equal(proxyPoolStatus().free, 3);
      const lease = allocateProxy({ connectionId: "conn-fr", stickyKey: "li:at:islam", country: "FR" });
      assert.equal(lease.provider, "decodo");
      assert.equal(lease.country, "fr");
      assert.match(lease.proxyUrl, /country-fr/);
      assert.equal(
        allocateProxy({ connectionId: "conn-fr", stickyKey: "li:at:islam", country: "fr" }).proxyUrl,
        lease.proxyUrl,
      );
      assert.equal(proxyPoolStatus().free, 2);
      assert.equal(proxyPoolStatus().free_by_country?.fr, 0);
      assert.equal(proxyPoolStatus().free_by_country?.gb, 1);
    },
  );
});

test("static pool leases one URL per connection and frees it on release", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mycel-proxy-"));
  const ledger = join(dir, "leases.json");
  const a = "http://u:p@isp-a.example:8000";
  const b = "http://u:p@isp-b.example:8000";
  await withPoolEnv(
    {
      MYCEL_LINKEDIN_PROXY_PROVIDER: "static",
      MYCEL_LINKEDIN_PROXY_POOL: `${a},${b}`,
      MYCEL_LINKEDIN_PROXY_LEDGER: ledger,
      MYCEL_BRIGHTDATA_CUSTOMER: undefined,
      MYCEL_BRIGHTDATA_ZONE: undefined,
      MYCEL_BRIGHTDATA_PASSWORD: undefined,
    },
    async () => {
      _resetProxyPoolForTests(ledger);
      const s0 = proxyPoolStatus();
      assert.equal(s0.provider, "static");
      assert.equal(s0.free, 2);

      const l1 = allocateProxy({ connectionId: "conn-1", country: "us" });
      assert.equal(l1.provider, "static");
      assert.ok([a, b].includes(l1.proxyUrl));
      assert.equal(proxyPoolStatus().free, 1);

      const l2 = allocateProxy({ connectionId: "conn-2" });
      assert.notEqual(l2.proxyUrl, l1.proxyUrl);
      assert.equal(proxyPoolStatus().free, 0);

      assert.throws(() => allocateProxy({ connectionId: "conn-3" }), /exhausted/i);

      // Idempotent: same connection keeps its lease.
      assert.equal(allocateProxy({ connectionId: "conn-1" }).proxyUrl, l1.proxyUrl);

      releaseProxy("conn-1");
      assert.equal(proxyPoolStatus().free, 1);
      const l3 = allocateProxy({ connectionId: "conn-3" });
      assert.equal(l3.proxyUrl, l1.proxyUrl);
    },
  );
});

test("static pool prefers an IP in the member's country and refuses a foreign-only pool", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mycel-proxy-"));
  const ledger = join(dir, "leases.json");
  const us = "http://u:p@us-isp.example:8000";
  const gb = "http://u:p@gb-isp.example:8000";
  await withPoolEnv(
    {
      MYCEL_LINKEDIN_PROXY_PROVIDER: "static",
      MYCEL_LINKEDIN_PROXY_POOL: `us|${us},gb|${gb}`,
      MYCEL_LINKEDIN_PROXY_LEDGER: ledger,
      MYCEL_LINKEDIN_DEFAULT_COUNTRY: undefined,
      MYCEL_BRIGHTDATA_CUSTOMER: undefined,
      MYCEL_BRIGHTDATA_ZONE: undefined,
      MYCEL_BRIGHTDATA_PASSWORD: undefined,
    },
    async () => {
      _resetProxyPoolForTests(ledger);
      const lease = allocateProxy({ connectionId: "c-us", country: "US" });
      assert.equal(lease.proxyUrl, us);
      assert.equal(lease.country, "us");
      assert.equal(proxyPoolStatus().free_by_country?.gb, 1);

      assert.throws(
        () => allocateProxy({ connectionId: "c-de", country: "de" }),
        /no free ISP proxy in country "de"/i,
      );
    },
  );
});

test("same LinkedIn member across two orgs shares one ISP lease", async () => {
  // THE BUG THIS PREVENTS: org A and org B both connect the founder's LinkedIn and each mint a
  // Decodo port — LinkedIn sees the same member from two IPs and restricts the account. Sticky key
  // is the member (`li_at` hash), not the Mycel connection id.
  const dir = mkdtempSync(join(tmpdir(), "mycel-proxy-"));
  const ledger = join(dir, "leases.json");
  const member = stickyKeyForLiAt("AQEAATxyz_shared_session_cookie_value");
  await withPoolEnv(
    {
      MYCEL_LINKEDIN_PROXY_PROVIDER: "decodo",
      MYCEL_DECODO_USERNAME: "mycel_gtm",
      MYCEL_DECODO_PASSWORD: "s3cret",
      MYCEL_DECODO_COUNTRIES: "fr,es,gb",
      MYCEL_LINKEDIN_PROXY_LEDGER: ledger,
      MYCEL_LINKEDIN_PROXY_POOL: undefined,
      MYCEL_BRIGHTDATA_CUSTOMER: undefined,
      MYCEL_BRIGHTDATA_ZONE: undefined,
      MYCEL_BRIGHTDATA_PASSWORD: undefined,
    },
    async () => {
      _resetProxyPoolForTests(ledger);
      const orgA = allocateProxy({ connectionId: "conn-org-a", stickyKey: member, country: "fr" });
      const orgB = allocateProxy({ connectionId: "conn-org-b", stickyKey: member, country: "fr" });
      assert.equal(orgA.proxyUrl, orgB.proxyUrl, "both orgs must egress from the same ISP identity");
      // Disconnecting org A must not yank the IP while org B is still live.
      releaseProxy("conn-org-a");
      assert.equal(
        allocateProxy({ connectionId: "conn-org-b", stickyKey: member, country: "fr" }).proxyUrl,
        orgA.proxyUrl,
      );
      releaseProxy("conn-org-b");
    },
  );
});

test("adoptStickyKey moves a password-login lease onto the member without minting a second IP", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mycel-proxy-"));
  const ledger = join(dir, "leases.json");
  await withPoolEnv(
    {
      MYCEL_LINKEDIN_PROXY_PROVIDER: "decodo",
      MYCEL_DECODO_USERNAME: "mycel_gtm",
      MYCEL_DECODO_PASSWORD: "s3cret",
      MYCEL_DECODO_COUNTRIES: "fr,es,gb",
      MYCEL_LINKEDIN_PROXY_LEDGER: ledger,
    },
    async () => {
      _resetProxyPoolForTests(ledger);
      // Password path: allocate under connection id before cookies exist.
      const first = allocateProxy({ connectionId: "conn-pw", country: "gb" });
      const member = stickyKeyForLiAt("AQEAATafter_login_cookie");
      const adopted = adoptStickyKey("conn-pw", member);
      assert.equal(adopted.proxyUrl, first.proxyUrl);
      assert.equal(adopted.changed, false);
      // Second org with the same cookies joins that lease.
      const second = allocateProxy({ connectionId: "conn-org-2", stickyKey: member, country: "gb" });
      assert.equal(second.proxyUrl, first.proxyUrl);
    },
  );
});

test("Decodo lease is sticky to the member and refuses a country with no line", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mycel-proxy-"));
  const ledger = join(dir, "leases.json");
  await withPoolEnv(
    {
      MYCEL_LINKEDIN_PROXY_PROVIDER: "decodo",
      MYCEL_DECODO_USERNAME: "mycel_gtm",
      MYCEL_DECODO_PASSWORD: "s3cret",
      MYCEL_DECODO_COUNTRIES: "fr,es,gb",
      MYCEL_DECODO_COUNTRY: "fr",
      MYCEL_LINKEDIN_DEFAULT_COUNTRY: "fr",
      MYCEL_LINKEDIN_PROXY_LEDGER: ledger,
      MYCEL_LINKEDIN_PROXY_POOL: undefined,
    },
    async () => {
      _resetProxyPoolForTests(ledger);
      const islam = allocateProxy({ connectionId: "islam", stickyKey: "li:at:islam", country: "fr" });
      assert.match(islam.proxyUrl, /country-fr/);
      // Reconnect (even with a different country pick) must not rotate the IP.
      const again = allocateProxy({ connectionId: "islam-2", stickyKey: "li:at:islam", country: "es" });
      assert.equal(again.proxyUrl, islam.proxyUrl);
      assert.equal(again.country, "fr");

      const rania = allocateProxy({ connectionId: "rania", stickyKey: "li:at:rania", country: "es" });
      assert.match(rania.proxyUrl, /country-es/);
      assert.notEqual(rania.proxyUrl, islam.proxyUrl);
      assert.equal(proxyPoolStatus().free_by_country?.gb, 1, "UK spare stays unused");

      const usErr = () => allocateProxy({ connectionId: "us-founder", stickyKey: "li:at:us", country: "us" });
      assert.throws(usErr, /couldn't open a line in this country/i);
      assert.throws(usErr, /"us"/);

      assert.throws(
        () => allocateProxy({ connectionId: "second-fr", stickyKey: "li:at:other-fr", country: "fr" }),
        /couldn't open a line in this country/i,
      );
      // Missing country must not inherit MYCEL_DECODO_COUNTRY=fr.
      assert.throws(
        () => allocateProxy({ connectionId: "no-country", stickyKey: "li:at:nobody" }),
        /couldn't open a line in this country/i,
      );
    },
  );
});

test("connect without proxy_url auto-leases from the static pool", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mycel-proxy-"));
  const ledger = join(dir, "leases.json");
  const pooled = "http://pool:pw@isp.example:9000";
  await withPoolEnv(
    {
      MYCEL_LINKEDIN_PROXY_PROVIDER: "static",
      MYCEL_LINKEDIN_PROXY_POOL: pooled,
      MYCEL_LINKEDIN_PROXY_LEDGER: ledger,
      MYCEL_BRIGHTDATA_CUSTOMER: undefined,
      MYCEL_BRIGHTDATA_ZONE: undefined,
      MYCEL_BRIGHTDATA_PASSWORD: undefined,
    },
    async () => {
      _resetProxyPoolForTests(ledger);
      _setVerifier(async () => ({ name: "Pooled", self_urn: "urn:li:fs_miniProfile:1" }));
      try {
        const r = await connectWithSession({
          li_at: "AQEDx",
          jsessionid: '"ajax:9"',
          project_id: "p-pool",
          // no proxyUrl — pool must supply it
        });
        assert.equal(r.phase, "connected");
        assert.equal(await getSecret(`${r.connection_id}:proxy`), pooled);
        const conn = await getDomainStore().getConnection(r.connection_id);
        assert.equal(conn?.config.proxy_provider, "static");
        assert.match(String(conn?.config.proxy), /isp\.example/);

        await disconnectLinkedIn(r.connection_id);
        assert.equal(proxyPoolStatus().free, 1, "disconnect returns the IP to the pool");
      } finally {
        _setVerifier(async () => ({
          self_urn: "urn:li:fs_miniProfile:ME",
          mailbox_urn: "urn:li:fsd_profile:ME",
          name: "Founder Name",
        }));
      }
    },
  );
});
