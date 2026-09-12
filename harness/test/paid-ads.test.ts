import { test } from "node:test";
import assert from "node:assert/strict";
import { api, makeFreshApp } from "./helpers";
import { getDomainStore } from "../src/domain";
import { draftCreative, setAdsExecute } from "../src/paid-ads";

test("draft creative is three angles from the offer, not a blank connect tile", () => {
  const angles = draftCreative({
    name: "Brightline close",
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

test("place refuses a daily budget above the ceiling — a typo is not a charge", async () => {
  let created = 0;
  setAdsExecute(async () => {
    created += 1;
    return { successful: true, data: { id: "camp_cap" } };
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
      body: JSON.stringify({ sells: "close", sells_to: "founders", daily_budget_major: 100000, connection_id: conn.id }),
    });
    const id = drafted.json.ad.id as string;
    const placed = await api(app, `ads/${id}/place`, { method: "POST", body: JSON.stringify({ confirm: true, connection_id: conn.id }) });
    assert.equal(placed.status, 400, placed.text);
    assert.equal(created, 0, "nothing may reach the ad platform when the budget is refused");
    assert.match(String(placed.json.error), /ceiling|Ads Manager/i);
  } finally {
    setAdsExecute(undefined);
  }
});

test("a placed ad with no campaign id is loud, and cannot be silently unpausable", async () => {
  // The provider says "created" but returns a shape with no id — the money-leak case. The ad must
  // go live (it is spending), carry a warning, and pausing must refuse with an instruction rather
  // than firing a pause at an undefined id and failing opaquely while the spend continues.
  let pauseCalledWith: unknown = "never";
  setAdsExecute(async (args) => {
    if (args.slug.includes("CREATE")) return { successful: true, data: { weird: "no id here" } };
    if (args.slug.includes("UPDATE")) { pauseCalledWith = args.arguments; return { successful: true, data: {} }; }
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
      body: JSON.stringify({ sells: "close", sells_to: "founders", daily_budget_major: 20, connection_id: conn.id }),
    });
    const id = drafted.json.ad.id as string;
    const placed = await api(app, `ads/${id}/place`, { method: "POST", body: JSON.stringify({ confirm: true, connection_id: conn.id }) });
    assert.equal(placed.status, 200, placed.text);
    assert.equal(placed.json.ad.status, "live");
    assert.ok(placed.json.ad.error, "a live ad with no pause handle must carry a warning");
    assert.match(String(placed.json.ad.error), /Ads Manager|campaign id/i);

    const paused = await api(app, `ads/${id}/pause`, { method: "POST", body: "{}" });
    assert.equal(paused.status, 409, paused.text);
    assert.equal(pauseCalledWith, "never", "pause must NOT fire at the provider with an undefined id");
    assert.match(String(paused.json.error), /Ads Manager|campaign id/i);
  } finally {
    setAdsExecute(undefined);
  }
});

test("provider ids are read from nested response shapes (data.data.id, result.id)", async () => {
  setAdsExecute(async (args) => {
    if (args.slug.includes("CREATE")) return { successful: true, data: { data: { id: "camp_nested" } } };
    if (args.slug.includes("UPDATE")) return { successful: true, data: {} };
    return { successful: false, error: "x" };
  });
  try {
    const { app } = await makeFreshApp();
    const project = (await api(app, "me")).json.projects[0].id as string;
    const domain = getDomainStore();
    const conn = await domain.createConnection({
      project_id: project,
      kind: "composio",
      name: "LinkedIn Ads",
      owner: { kind: "founder", id: "founder" },
      config: { toolkit: "linkedinads", connected_account_id: "ca_test" },
    });
    const drafted = await api(app, "ads", {
      method: "POST",
      body: JSON.stringify({ sells: "close", sells_to: "founders", daily_budget_major: 15, connection_id: conn.id }),
    });
    const id = drafted.json.ad.id as string;
    const placed = await api(app, `ads/${id}/place`, { method: "POST", body: JSON.stringify({ confirm: true, connection_id: conn.id }) });
    assert.equal(placed.status, 200, placed.text);
    assert.equal(placed.json.ad.provider_campaign_id, "camp_nested", "nested id must be resolved");
    assert.ok(!placed.json.ad.error, "a resolved id means no warning");
  } finally {
    setAdsExecute(undefined);
  }
});
