// Inbox sync: GraphQL is optional, Rest.li is the path that decides whether the session is dead.
//
// The worker started polling this on 1 September. GraphQL 403'd, `call()` stamped the account-wide
// breaker, and every subsequent Voyager call was refused. The fallback this module claimed to have
// never ran. These tests are the contract that a 403/410 from messaging GraphQL is "use Rest.li",
// not "reconnect LinkedIn".

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  inboundMessages,
  LinkedInChallengeError,
  syncConversations,
  _resetDecoration,
  type LinkedInSession,
  type VoyagerCtx,
} from "../src/voyager";
import { _setFetch } from "../src/proxy";
import { linkedinBlocked, _resetLinkedInHealth } from "../src/health";

const SESSION: LinkedInSession = {
  li_at: "AQEDx",
  jsessionid: '"ajax:1"',
  self_urn: "urn:li:fs_miniProfile:ME",
  mailbox_urn: "urn:li:fsd_profile:ME",
};
const CTX: VoyagerCtx = { connectionId: "founder-linkedin", proxyUrl: "http://user:pw@resi.example:8080" };

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
              miniProfile: {
                entityUrn: "urn:li:fs_miniProfile:LEAD",
                publicIdentifier: "amina-k",
                firstName: "Amina",
                lastName: "K",
              },
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
  ],
};

function jsonResponse(body: unknown, status = 200): Response {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h: string) => (h === "content-length" ? String(Math.round(text.length / 4)) : null) },
    text: async () => text,
  } as unknown as Response;
}

function statusResponse(status: number, body = ""): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => body,
  } as unknown as Response;
}

test("inboundMessages keys the sender on the vanity id growth stores as people.key", () => {
  const evs = inboundMessages(legacyPayload, "urn:li:fs_miniProfile:ME");
  assert.equal(evs.length, 1);
  assert.equal(evs[0].from.id, "amina-k");
  assert.equal(evs[0].from.name, "Amina K");
});

test("sync: GraphQL 403 falls back to Rest.li and does not stamp the connection as challenged", async () => {
  _resetDecoration();
  _resetLinkedInHealth();
  const urls: string[] = [];
  _setFetch(async (url) => {
    urls.push(String(url));
    if (String(url).includes("voyagerMessagingGraphQL")) return statusResponse(403, "forbidden");
    return jsonResponse(legacyPayload);
  });
  try {
    const r = await syncConversations(SESSION, CTX);
    assert.equal(r.via, "legacy");
    assert.match(urls[0], /voyagerMessagingGraphQL/);
    assert.match(urls[1], /messaging\/conversations/);
    assert.ok(r.inbound.some((m) => /demo/.test(m.text)));
    assert.equal(linkedinBlocked(CTX.connectionId), null);
  } finally {
    _setFetch(null);
    _resetLinkedInHealth();
  }
});

test("sync: GraphQL 410 falls back to Rest.li and does not stamp the endpoint as gone", async () => {
  _resetDecoration();
  _resetLinkedInHealth();
  const urls: string[] = [];
  _setFetch(async (url) => {
    urls.push(String(url));
    if (String(url).includes("voyagerMessagingGraphQL")) return statusResponse(410);
    return jsonResponse(legacyPayload);
  });
  try {
    const r = await syncConversations(SESSION, CTX);
    assert.equal(r.via, "legacy");
    assert.equal(linkedinBlocked(CTX.connectionId), null, "a retired GraphQL query id must not stop the account");
  } finally {
    _setFetch(null);
    _resetLinkedInHealth();
  }
});

test("sync: a GraphQL checkpoint still throws, and Rest.li is not asked the same question", async () => {
  _resetDecoration();
  _resetLinkedInHealth();
  const urls: string[] = [];
  _setFetch(async (url) => {
    urls.push(String(url));
    return statusResponse(403, "<html>/checkpoint/challenge_id=abc</html>");
  });
  try {
    await assert.rejects(() => syncConversations(SESSION, CTX), LinkedInChallengeError);
    assert.equal(urls.length, 1, "a real checkpoint must not fall through to a second request");
    assert.match(urls[0], /voyagerMessagingGraphQL/);
    assert.ok(linkedinBlocked(CTX.connectionId), "a real checkpoint still stops the account");
  } finally {
    _setFetch(null);
    _resetLinkedInHealth();
  }
});
