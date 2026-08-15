import { test } from "node:test";
import assert from "node:assert/strict";
import { api, makeFreshApp } from "./helpers";
import { getDomainStore } from "../src/domain";
import { draftCreative, setAdsExecute } from "../src/paid-ads";

test("draft creative is three angles from the offer, not a blank connect tile", () => {
  const angles = draftCreative({
    name: "Northwind close",
    sells: "month-end close",
    sells_to: "founders who still do the books on Sunday",
  });
  assert.equal(angles.length, 3);
  assert.ok(angles.every((a) => a.headline && a.primary && a.cta));
  assert.ok(angles.some((a) => /month-end close/.test(a.primary)));
  assert.ok(angles.some((a) => /founders/.test(`${a.headline} ${a.primary}`)));
});

test("Pipeline ads: draft, refuse place without confirm, place on click, pause", async () => {
  let created = 0;
  let paused = 0;
  setAdsExecute(async (args) => {
    if (args.slug.includes("CREATE")) {
      created += 1;
      return { successful: true, data: { id: "camp_1" } };
    }
    if (args.slug.includes("UPDATE")) {
      paused += 1;
      return { successful: true, data: { id: "camp_1" } };
    }
    return { successful: false, error: `unexpected ${args.slug}` };
  });
  try {
    const { app } = await makeFreshApp();
    const project = (await api(app, "me")).json.projects[0].id as string;
    const domain = getDomainStore();
    const conn = await domain.createConnection({
      project_id: project,
      kind: "composio",
      name: "Meta Ads",
      owner: { kind: "founder", id: "founder" },
      config: { toolkit: "metaads", connected_account_id: "ca_test" },
    });

    const drafted = await api(app, "ads", {
      method: "POST",
      body: JSON.stringify({
        sells: "month-end close",
        sells_to: "agency founders",
        geo: "United Kingdom",
        daily_budget_major: 25,
        connection_id: conn.id,
      }),
    });
    assert.equal(drafted.status, 201, drafted.text);
    assert.equal(drafted.json.ad.status, "draft");
    assert.equal(drafted.json.ad.angles.length, 3);
    const id = drafted.json.ad.id as string;

    const sneak = await api(app, `ads/${id}/place`, {
      method: "POST",
      body: JSON.stringify({ confirm: false }),
    });
    assert.equal(sneak.status, 400);
    assert.equal(created, 0);

    const placed = await api(app, `ads/${id}/place`, {
      method: "POST",
      body: JSON.stringify({ confirm: true, connection_id: conn.id }),
    });
    assert.equal(placed.status, 200, placed.text);
    assert.equal(placed.json.ad.status, "live");
    assert.equal(created, 1);

    const stopped = await api(app, `ads/${id}/pause`, { method: "POST", body: "{}" });
    assert.equal(stopped.status, 200, stopped.text);
    assert.equal(stopped.json.ad.status, "paused");
    assert.equal(paused, 1);
  } finally {
    setAdsExecute(undefined);
  }
});

test("place without a working ads account is an error on the draft, not a silent charge", async () => {
  setAdsExecute(async () => ({
    successful: false,
    error: "this ads account has no billing method",
  }));
  try {
    const { app } = await makeFreshApp();
    const project = (await api(app, "me")).json.projects[0].id as string;
    const domain = getDomainStore();
    const conn = await domain.createConnection({
      project_id: project,
      kind: "composio",
      name: "Google Ads",
      owner: { kind: "founder", id: "founder" },
      config: { toolkit: "googleads", connected_account_id: "ca_empty" },
    });
    const drafted = await api(app, "ads", {
      method: "POST",
      body: JSON.stringify({
        sells: "close",
        sells_to: "founders",
        daily_budget_major: 10,
        connection_id: conn.id,
      }),
    });
    const id = drafted.json.ad.id as string;
    const placed = await api(app, `ads/${id}/place`, {
      method: "POST",
      body: JSON.stringify({ confirm: true }),
    });
    assert.equal(placed.status, 502);
    assert.equal(placed.json.ad.status, "error");
    assert.match(String(placed.json.error), /billing|account/i);
  } finally {
    setAdsExecute(undefined);
  }
});
