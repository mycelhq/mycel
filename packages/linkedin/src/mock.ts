/**
 * A hermetic LinkedIn, for the product eval only (`MYCEL_LINKEDIN_MOCK=1`).
 *
 * Installs a transport override on the one door every LinkedIn call goes through (`_setFetch`, see
 * proxy.ts) that answers the Voyager endpoints with canned, well-shaped data. It exists so the GTM
 * journey evals can do the things a test can never do with a real account — connect, invite, message,
 * read replies — deterministically and offline, exercising the SAME parsers, pacing and state machine
 * the real path uses. Only the bytes on the wire are fake.
 *
 * NEVER installed in prod: `index.ts` calls this only when the flag is set, which only the eval stack
 * sets. Finding people does NOT go through here — that's `MYCEL_FULLENRICH_MOCK` on web discovery,
 * which is simpler and is the primary find path anyway. This covers connect + the outbound actions.
 */
import { _setFetch, type FetchLike } from "./proxy";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A stable fake identity for the connected eval account. */
const SELF = {
  miniProfile: {
    entityUrn: "urn:li:fs_miniProfile:mock-eval-self",
    firstName: "Eval",
    lastName: "Operator",
    publicIdentifier: "eval-operator",
  },
  plainId: "mock-eval-self",
};

const handler: FetchLike = async (url) => {
  const u = url.toLowerCase();
  // `/me` — the connect handshake. A 200 here is what turns pasted cookies into a live connection.
  if (u.includes("/voyager/api/me")) return json(SELF);
  // Sending an invitation — the quota-and-create endpoint. Success with an empty body is enough for
  // the caller, which keys off the HTTP status, not a returned id.
  if (u.includes("verifyquotaandcreate") || u.includes("norminvitations")) return json({ value: {} });
  // Sending / creating a message — the events endpoint returns the created event's urn.
  if (u.includes("/events?action=create") || u.includes("messaging/conversations/") ) {
    return json({ value: { eventUrn: "urn:li:messagingMessage:mock-1", createdAt: 0 } });
  }
  // Reading the inbox — empty is a valid, quiet inbox; a journey that wants a reply seeds one via the
  // API rather than depending on canned inbound here.
  if (u.includes("messaging/conversations")) return json({ elements: [] });
  // Connections / invitations lists — empty.
  if (u.includes("relationships/connections") || u.includes("relationships/invitations")) {
    return json({ elements: [] });
  }
  // Anything else: an innocuous empty 200, so an unforeseen call never throws a transport error mid
  // journey. New endpoints that need real shape get a branch above.
  return json({});
};

let installed = false;

/** Idempotent. Called from index.ts when MYCEL_LINKEDIN_MOCK=1. */
export function installLinkedInMock(): void {
  if (installed) return;
  installed = true;
  _setFetch(handler);
}

export function linkedInMockEnabled(): boolean {
  return process.env.MYCEL_LINKEDIN_MOCK === "1";
}
