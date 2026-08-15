// Stranger DMs must become prospects. Dropping them is the trial-cancel for GTM.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getDomainStore } from "../src/domain";
import {
  captureUnsolicitedInbound,
  INBOUND_CAMPAIGN_NAME,
  inboundCampaignKey,
  profileIdOf,
} from "../src/gtm/inbound";
import { noteInboundReplies } from "../src/gtm/replies";
import { gtmWedge } from "../src/gtm/stages";

const domain = () => getDomainStore();

test("profileIdOf takes the urn tail and refuses unknown", () => {
  assert.equal(profileIdOf("urn:li:fsd_profile:ACoAAAxyz"), "ACoAAAxyz");
  assert.equal(profileIdOf("dana"), "dana");
  assert.equal(profileIdOf("unknown"), undefined);
  assert.equal(profileIdOf(""), undefined);
  assert.equal(profileIdOf(undefined), undefined);
});

test("a stranger DM opens a replied case in the inbound bucket, not a sending sequence", async () => {
  const project = `p-inb-${randomUUID().slice(0, 8)}`;
  const conn = { id: `conn-${randomUUID().slice(0, 8)}`, project_id: project };

  const n = await captureUnsolicitedInbound(domain(), conn, [
    {
      thread_id: "urn:li:thread:new",
      from: { id: "urn:li:fsd_profile:ACoAAAstranger", name: "Priya" },
      text: "Saw your post — can you take on our books?",
      sent_at: new Date().toISOString(),
    },
  ]);
  assert.equal(n, 1);

  const cases = await domain().listCases({ project_id: project, wedge: gtmWedge() });
  assert.equal(cases.length, 1);
  assert.equal(cases[0]!.stage, "replied");
  assert.equal(cases[0]!.status, "open");
  const data = cases[0]!.data as Record<string, unknown>;
  assert.equal(data.inbound_unsolicited, true);
  assert.equal(data.profile_id, "ACoAAAstranger");
  assert.equal(data.thread, "urn:li:thread:new");
  assert.equal(data.connection_id, conn.id);
  assert.ok(typeof data.campaign_id === "string" && data.campaign_id);

  const campaigns = await domain().queryRecords({
    project_id: project,
    wedge: gtmWedge(),
    collection: "campaign",
    where: { inbound: true, connection_id: conn.id },
    limit: 5,
  });
  assert.equal(campaigns.length, 1);
  assert.equal(campaigns[0]!.key, inboundCampaignKey(conn.id));
  assert.equal((campaigns[0]!.data as Record<string, unknown>).name, INBOUND_CAMPAIGN_NAME);
  assert.deepEqual((campaigns[0]!.data as Record<string, unknown>).steps, []);
  assert.equal((campaigns[0]!.data as Record<string, unknown>).id, data.campaign_id);
});

test("the same stranger is not opened twice, and a sequenced prospect is not recaptured", async () => {
  const project = `p-dedupe-${randomUUID().slice(0, 8)}`;
  const conn = { id: `conn-${randomUUID().slice(0, 8)}`, project_id: project };
  const inbound = [
    {
      thread_id: "urn:li:thread:dup",
      from: { id: "priya", name: "Priya" },
      text: "hello",
    },
  ];

  assert.equal(await captureUnsolicitedInbound(domain(), conn, inbound), 1);
  assert.equal(await captureUnsolicitedInbound(domain(), conn, inbound), 0, "second poll must not duplicate");

  await domain().createCase({
    project_id: project,
    wedge: gtmWedge(),
    title: "Dana",
    stage: "dm1",
    status: "open",
    data: { connection_id: conn.id, profile_id: "dana", thread: "urn:li:thread:seq", name: "Dana" },
  });
  assert.equal(
    await captureUnsolicitedInbound(domain(), conn, [
      { thread_id: "urn:li:thread:seq", from: { id: "dana", name: "Dana" }, text: "thanks" },
    ]),
    0,
    "a person already in a sequence is a reply, not a new inbound case",
  );
});

test("unsolicited inbound is not counted as a sequenced reply", async () => {
  // Pacing must not earn budget from people we never contacted. `noteInboundReplies` is the
  // numerator; this test pins that a stranger does not increment it.
  const project = `p-pace-${randomUUID().slice(0, 8)}`;
  const conn = { id: `conn-${randomUUID().slice(0, 8)}`, project_id: project };
  const inbound = [{ thread_id: "urn:li:thread:cold", from: { id: "cold", name: "Cold" }, text: "hi" }];

  const flipped = await noteInboundReplies(domain(), conn, inbound);
  assert.equal(flipped, 0, "a stranger is not a sequenced reply");
  assert.equal(await captureUnsolicitedInbound(domain(), conn, inbound), 1);
});

test("captureUnsolicitedInbound refuses an unscoped read", async () => {
  await assert.rejects(
    () => captureUnsolicitedInbound(domain(), { id: "conn-x", project_id: "" }, [
      { thread_id: "t", from: { id: "someone" } },
    ]),
    /project/,
  );
});
