// Telling a founder their LinkedIn stopped — once, and only when it is worth telling.
//
// The breaker (linkedin-health.test.ts) proves the system stops making noise. These tests prove the
// opposite half: that ONE person hears about it. Every assertion here describes something that was
// silent before — a dead session that a founder discovers weeks later is a churn event, and for our
// own account it is a launch that does not happen.
//
// Four claims, and they are the four ways this can be got wrong:
//   · a permanent failure notifies EXACTLY ONCE across hundreds of calls AND across a restart;
//   · a transient failure notifies NEVER, so the alert keeps meaning something;
//   · a dead session and a retired endpoint are told apart, because "reconnect" is a lie for one;
//   · a reconnect clears the stamp AND the marker, so the NEXT stop is heard.
import { test } from "node:test";
import assert from "node:assert/strict";
import { initSecretStore } from "../src/secrets";
import {
  clearLinkedInUnhealthy,
  connectWithSession,
  disconnectLinkedIn,
  searchLinkedInPeople,
  _setPacing,
  _setVerifier,
} from "../src/linkedin/connect";
import { _setFetch } from "../src/linkedin/proxy";
import { _resetLinkedInHealth, describeLinkedInStop, stopCauseOf } from "../src/linkedin/health";
import { listLinkedInStopAlerts, markLinkedInStopNotified } from "../src/linkedin-alerts";
import { getDomainStore } from "../src/domain";
import { getIdentityStore } from "../src/identity";

await initSecretStore();
_setVerifier(async () => ({ self_urn: "urn:li:fs_miniProfile:ME", name: "Founder Name" }));
_setPacing(null);

const PROXY = "http://user:pw@resi.example:8080";

/** An org with an owner who can be emailed, and the project a connection will hang off. */
function tenant(email: string): string {
  const { project } = getIdentityStore().createOrgWithOwner("Acme", email, "correct horse battery");
  return project.id;
}

async function account(projectId: string) {
  const r = await connectWithSession({
    li_at: "AQEDx",
    jsessionid: '"ajax:1"',
    proxyUrl: PROXY,
    project_id: projectId,
    name: "Founder LinkedIn",
  });
  return (await getDomainStore().getConnection(r.connection_id))!;
}

/** A Voyager response. `status` alone decides how the breaker reads it. */
function response(status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => "{}",
  } as unknown as Response;
}

/**
 * Hammer the account the way a sequencer tick does: many calls, one dead session.
 *
 * `calls` is what LinkedIn actually saw — the breaker should make that far smaller than `attempts`,
 * and the notification count smaller still.
 */
async function hammer(conn: Awaited<ReturnType<typeof account>>, status: number, attempts: number) {
  let calls = 0;
  _setFetch(async () => {
    calls++;
    return response(status);
  });
  try {
    for (let i = 0; i < attempts; i++) {
      const fresh = (await getDomainStore().getConnection(conn.id))!;
      await searchLinkedInPeople(fresh, { query: `founders ${i}` });
    }
  } finally {
    _setFetch(null);
  }
  // The stamp is written fire-and-forget on purpose (`void persistLinkedInUnhealthy` — a failed
  // bookkeeping write must never turn into a second, differently-broken failure at the call site),
  // so a test that reads the row immediately is racing it. Let the microtasks land.
  await new Promise((r) => setTimeout(r, 20));
  return calls;
}

test("a dead session notifies the founder ONCE — across 50 calls and across a restart", async () => {
  const project = tenant("owner@acme.test");
  const conn = await account(project);
  try {
    // 401 is the plain shape of a session that simply stopped being accepted. No checkpoint, no
    // captcha — the thing that happens when somebody changes their LinkedIn password.
    const calls = await hammer(conn, 401, 50);
    assert.ok(calls <= 1, `the breaker refused the rest before a byte went out (LinkedIn saw ${calls})`);

    const due = await listLinkedInStopAlerts();
    const mine = due.filter((d) => d.connection_id === conn.id);
    assert.equal(mine.length, 1, "fifty failed calls, one thing to tell them");
    assert.deepEqual(mine[0].to, ["owner@acme.test"]);
    assert.equal(mine[0].cause, "session");
    assert.equal(mine[0].reconnect, true, "this one IS fixed by reconnecting");
    assert.match(mine[0].fix, /reconnect/i);
    assert.match(mine[0].what, /paused/i);

    // The product sent the mail and said so.
    assert.equal(await markLinkedInStopNotified(conn.id), true);
    assert.equal(
      (await listLinkedInStopAlerts()).filter((d) => d.connection_id === conn.id).length,
      0,
      "told once is told",
    );

    // ── THE RESTART ────────────────────────────────────────────────────────────────────────────
    // This is the case an in-process `announced` flag cannot survive and the reason the marker is
    // persisted on the row: a worker reboots, rediscovers the same dead session, and must NOT send
    // a second copy. A crash-looping worker would otherwise mail once per boot.
    _resetLinkedInHealth();
    await hammer(conn, 401, 20);
    assert.equal(
      (await listLinkedInStopAlerts()).filter((d) => d.connection_id === conn.id).length,
      0,
      "a restart re-discovers the stop and must stay quiet about it",
    );
    // And a duplicate report from a retrying cron cannot un-mark it either.
    assert.equal(await markLinkedInStopNotified(conn.id), false);
  } finally {
    _resetLinkedInHealth();
    await disconnectLinkedIn(conn.id);
  }
});

test("a rate limit notifies NOBODY — the alert has to keep meaning something", async () => {
  const project = tenant("owner2@acme.test");
  const conn = await account(project);
  try {
    await hammer(conn, 429, 10);
    const fresh = (await getDomainStore().getConnection(conn.id))!;
    assert.equal(
      fresh.config?.linkedin_unhealthy,
      undefined,
      "a 429 is a rate limiter, not a fact about the account — it must never stamp the row",
    );
    assert.equal((await listLinkedInStopAlerts()).filter((d) => d.connection_id === conn.id).length, 0);

    // Same for LinkedIn having a bad hour. An email every time a 5xx lands is an email a founder
    // filters, and then the one that matters arrives in a folder nobody opens.
    _resetLinkedInHealth();
    await hammer(conn, 503, 10);
    const again = (await getDomainStore().getConnection(conn.id))!;
    assert.equal(again.config?.linkedin_unhealthy, undefined);
    assert.equal((await listLinkedInStopAlerts()).filter((d) => d.connection_id === conn.id).length, 0);
  } finally {
    _resetLinkedInHealth();
    await disconnectLinkedIn(conn.id);
  }
});

test("a retired endpoint is told apart from a dead session — because 'reconnect' would be a lie", async () => {
  const project = tenant("owner3@acme.test");
  const conn = await account(project);
  try {
    await hammer(conn, 410, 5);
    const [alert] = (await listLinkedInStopAlerts()).filter((d) => d.connection_id === conn.id);
    assert.ok(alert, "a 410 still stops the account, and the founder is still told");
    assert.equal(alert.cause, "endpoint");
    assert.equal(alert.reconnect, false);
    assert.doesNotMatch(alert.fix, /reconnect (the|here|in)/i);
    assert.match(alert.fix, /nothing on your side/i);
    assert.match(alert.headline, /ours to fix/i);
  } finally {
    _resetLinkedInHealth();
    await disconnectLinkedIn(conn.id);
  }
});

test("a verified reconnect clears BOTH the stamp and the marker, so the next stop is heard", async () => {
  const project = tenant("owner4@acme.test");
  const conn = await account(project);
  try {
    await hammer(conn, 401, 5);
    assert.equal(await markLinkedInStopNotified(conn.id), true);
    const stamped = (await getDomainStore().getConnection(conn.id))!;
    assert.ok((stamped.config?.linkedin_unhealthy as { notified_at?: string })?.notified_at);

    // The reconnect, at the exact seam the product reaches it by: `persistSession` calls
    // `clearLinkedInUnhealthy` the moment LinkedIn answers `/me` on the new cookies, because a
    // VERIFIED session is the only evidence that exists for "whatever was broken is not broken any
    // more". Called directly here so the assertion is about the clearing and not about a mocked
    // browser handshake.
    await clearLinkedInUnhealthy(conn.id);
    const cleared = (await getDomainStore().getConnection(conn.id))!;
    assert.equal(cleared.config?.linkedin_unhealthy, undefined, "the stamp and its marker go together");
    // And the OTHER stamp, written by the same 401. Clearing one and not the other left a
    // reconnected account refused forever by `open()`'s challenge pre-flight, with nothing anywhere
    // that could remove it — a founder who did exactly what they were told and watched it not work.
    assert.equal(cleared.config?.linkedin_challenge, undefined, "both refusals lift, or neither does");

    // …and the NEXT death is a new event, not a silenced one. This is the failure mode of a marker
    // that outlives its stamp: the account dies again and nobody is ever told again.
    _resetLinkedInHealth();
    await hammer(cleared, 401, 5);
    assert.equal((await listLinkedInStopAlerts()).filter((d) => d.connection_id === conn.id).length, 1);
  } finally {
    _resetLinkedInHealth();
    await disconnectLinkedIn(conn.id);
  }
});

test("the copy a founder reads names the remedy, and the two remedies are opposites", () => {
  const session = describeLinkedInStop("linkedin_session_dead", "Founder LinkedIn");
  const gone = describeLinkedInStop("linkedin_endpoint_gone", "Founder LinkedIn");
  assert.equal(session.reconnect, true);
  assert.equal(gone.reconnect, false);
  // Both must say what STOPPED, not just what failed — a status code is not news a founder can use.
  for (const n of [session, gone]) {
    assert.match(n.what, /invitation/i);
    assert.match(n.headline, /Founder LinkedIn/);
  }
  // The surface supplies the "where", because "reconnect the account" is not an instruction if the
  // reader has nowhere to click. growth's answer is a command, cloud's is a screen.
  assert.match(describeLinkedInStop(undefined, "acct", "cloud, then re-run the vault script").fix, /vault script/);

  // An unrecognised code is treated as a session stop: it is the branch where the founder can act,
  // and the cheaper of the two mistakes.
  assert.equal(stopCauseOf(undefined), "session");
  assert.equal(stopCauseOf("linkedin_profile_endpoint_unknown"), "endpoint");
});
