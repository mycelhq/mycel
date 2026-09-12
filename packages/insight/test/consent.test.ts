// The consent gate, and the client's behaviour on either side of it.
//
// These are the tests that would fail if someone "simplified" the package into one that tracks by
// default. Unanswered is a refusal; nothing is written before a yes; a withdrawal takes back both
// the storage and the queue.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { clearDom, installDom, snapshot } from "./dom";

// Imported lazily inside each test: these modules read `window` at call time, but importing them
// before the stub exists would still be a trap worth avoiding, and doing it per-test keeps the
// module graph honest about what it depends on.
async function mods() {
  return {
    consent: await import("../src/consent"),
    client: await import("../src/client"),
  };
}

test("an unanswered visitor leaves no trace at all", async () => {
  const win = installDom("/pricing");
  try {
    const { consent, client } = await mods();
    assert.equal(consent.readConsent(), null, "no record is not consent");

    const sent: string[] = [];
    const insight = client.createInsight({ endpoint: "/api/insight", transport: (_u, b) => (sent.push(b), true) });
    insight.track("viewed_pricing");
    insight.pageview();
    await insight.flush();

    assert.equal(sent.length, 0, "nothing sent");
    // The stronger claim: no anonymous id was minted. It is created lazily INSIDE the grant check,
    // so an unconsented visitor is not merely un-sent, they are unidentified.
    assert.deepEqual(snapshot(win.localStorage), {});
    assert.deepEqual(snapshot(win.sessionStorage), {});
    insight.shutdown();
  } finally {
    clearDom();
  }
});

test("granting starts collection; withdrawing takes back the storage and the queue", async () => {
  const win = installDom("/book");
  try {
    const { consent, client } = await mods();
    const sent: string[] = [];
    const insight = client.createInsight({ endpoint: "/api/insight", transport: (_u, b) => (sent.push(b), true) });

    consent.setConsent("granted");
    insight.pageview();
    await insight.flush();
    assert.equal(sent.length, 1);
    const batch = JSON.parse(sent[0]!);
    assert.ok(batch.aid, "an anonymous id exists once it is allowed to");
    assert.ok(Object.keys(snapshot(win.localStorage)).some((k) => k.endsWith("_aid")));

    // Queue something, then withdraw before it flushes. The queued events must not survive the
    // withdrawal — sending a batch collected under a consent that has since been taken back would
    // make the withdrawal a formality.
    insight.track("started_booking");
    consent.setConsent("denied");
    await insight.flush();
    assert.equal(sent.length, 1, "nothing sent after withdrawal");

    const left = snapshot(win.localStorage);
    assert.deepEqual(Object.keys(left), ["mycel_insight_consent"], "only the answer itself survives");
    assert.equal(left.mycel_insight_consent, "denied");
    assert.deepEqual(snapshot(win.sessionStorage), {});

    // Re-granting mints a NEW id rather than resurrecting the old one. The sweep removed it, and
    // the marketing site's version of this function exists because an SDK's `reset()` rotated the
    // identity instead of removing it — the id came back, with a fresh year-long cookie attached.
    consent.setConsent("granted");
    insight.track("started_booking");
    await insight.flush();
    assert.equal(sent.length, 2);
    assert.notEqual(JSON.parse(sent[1]!).aid, batch.aid);
    insight.shutdown();
  } finally {
    clearDom();
  }
});

test("unconfigured is inert — a cloned template sends nothing, with nothing to switch off", async () => {
  installDom();
  try {
    const { consent, client } = await mods();
    consent.setConsent("granted");
    const sent: string[] = [];
    const off = client.createInsight({ enabled: false, transport: (_u, b) => (sent.push(b), true) });
    assert.equal(off.configured, false);
    off.track("anything");
    await off.flush();
    assert.equal(sent.length, 0);

    const noEndpoint = client.createInsight({ endpoint: "", transport: (_u, b) => (sent.push(b), true) });
    assert.equal(noEndpoint.configured, false);
    noEndpoint.pageview();
    await noEndpoint.flush();
    assert.equal(sent.length, 0);

    // And the ambient `track` is a no-op until something initialises it, which is the safe
    // direction: a component calling `track()` in a product that never wired this up does nothing.
    assert.doesNotThrow(() => client.track("orphan"));
  } finally {
    clearDom();
  }
});

test("what leaves the browser is already redacted, and carries no project id", async () => {
  installDom("/orders/98765");
  try {
    const { consent, client } = await mods();
    consent.setConsent("granted");
    const sent: string[] = [];
    const insight = client.createInsight({
      endpoint: "/api/insight",
      funnel: { name: "intake", steps: ["viewed", "started", "paid"] },
      transport: (_u, b) => (sent.push(b), true),
    });
    insight.track("started", { email: "jo@example.com", service: "deep_clean" });
    await insight.flush();

    const batch = JSON.parse(sent[0]!);
    const event = batch.events[0];
    assert.equal(event.n, "started");
    assert.equal(event.p, "/orders/:id", "the path is masked before it is queued");
    assert.equal(event.s, "started", "the step is tagged at the edge from the product's declaration");
    assert.deepEqual(event.props, { service: "deep_clean" });
    assert.equal(batch.f, "intake");
    assert.deepEqual(batch.fs, ["viewed", "started", "paid"], "the declaration rides on the first batch");
    assert.equal("project_id" in batch, false, "the project is the server's business, never the client's");

    // ...and only the first batch. This payload competes with unload.
    insight.track("paid");
    await insight.flush();
    assert.equal(JSON.parse(sent[1]!).fs, undefined);
    insight.shutdown();
  } finally {
    clearDom();
  }
});

test("a failed send is requeued, and the queue has a ceiling", async () => {
  installDom();
  try {
    const { consent, client } = await mods();
    consent.setConsent("granted");
    let accept = false;
    const sent: string[] = [];
    const insight = client.createInsight({
      endpoint: "/api/insight",
      transport: (_u, b) => {
        if (!accept) return false;
        sent.push(b);
        return true;
      },
    });
    insight.track("a");
    await insight.flush();
    assert.equal(sent.length, 0, "refused");
    accept = true;
    await insight.flush();
    assert.equal(JSON.parse(sent[0]!).events[0].n, "a", "and retried rather than lost");

    // A single-page app that never navigates must not accumulate forever. Beyond the ceiling the
    // OLDEST events go: the newest describe where the customer is now.
    accept = false;
    for (let i = 0; i < 500; i++) insight.track(`e${i}`);
    await insight.flush();
    accept = true;
    const before = sent.length;
    for (let i = 0; i < 20; i++) await insight.flush();
    const carried = sent.slice(before).flatMap((b) => JSON.parse(b).events.length as number);
    assert.ok(carried.reduce((a, b) => a + b, 0) <= 200, "the ceiling held");
    insight.shutdown();
  } finally {
    clearDom();
  }
});
