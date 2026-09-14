// ADDING A CLIENT OPENS THE DESK.
//
// ═══ THE PRODUCTION SEQUENCE ═══
//
// A four-person brand studio finished onboarding on 14 August 2026, agreed to the service the shaper
// wrote them, and put it on the clock. It ran `shape_brand_strategy` six times across five days with
// `client_id = NULL`, succeeded five times, produced zero deliverables — and the project had zero
// clients, zero cases and zero engagements the whole time. An engagement could only ever open from a
// SIGNED ENVELOPE, and a studio that already has its clients has no proposal to sign.
//
// So the commonest case in the market — "I have the client, start" — had no trigger at all. These
// pin the one that now exists, and the two things it must refuse.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { api, makeFreshApp } from "./helpers";
import { getDomainStore } from "../src/domain";

type Store = Awaited<ReturnType<typeof makeFreshApp>>["store"];

/** Every case this project holds, however it was opened. */
const casesFor = async (projectId: string) => getDomainStore().listCases({ project_id: projectId });

/**
 * The founder's own statement of their trade, stored the way onboarding stores it.
 *
 * `readBusinessShape` reads the newest succeeded `draft_shape` run's `result.txt`, not a record —
 * the first version of this test seeded a record and the engagement never opened, which is the same
 * mistake as asserting on the shape of a fixture instead of the shape of the product.
 */
async function shapeSaysTheTrade(store: Store, projectId: string, wedge: string): Promise<void> {
  const shaper = "business-shaper";
  const task = await store.createTask({
    id: randomUUID(),
    project_id: projectId,
    wedge: shaper,
    task_type: "draft_shape",
    status: "succeeded",
    input: {},
    constraints: { max_cost_usd: 1, max_runtime_s: 60 },
    created_at: new Date().toISOString(),
  } as never);
  await store.addArtifact({
    task_id: (task as { id: string }).id,
    name: "result.txt",
    content_type: "text/plain",
    content: JSON.stringify({ name: "A studio", sells: "brand work", runs_as: { wedge, fit: "direct" } }),
  } as never);
}

test("a client added to a business with one live service opens the engagement", async () => {
  const { app, store } = await makeFreshApp();

  /*
    `books-keeper` is the one producing trade named by the business's own shape, which is what
    `deliveryWedge` asks first — the founder's statement of their trade, made during onboarding,
    rather than an inference from the catalogue.
  */
  const me = await api(app, "me");
  await shapeSaysTheTrade(store, me.json.projects[0].id, "books-keeper");

  const created = await api(app, "clients", {
    method: "POST",
    body: JSON.stringify({ display_name: "Harborline Ceramics", handles: ["ops@harborline.example"] }),
  });
  assert.equal(created.status, 201);

  const opened = (await casesFor(created.json.project_id)).filter((k) => k.client_id === created.json.id);
  assert.equal(opened.length, 1, "adding a client did not open an engagement");
  assert.equal(opened[0]!.status, "open");
  // The client's name, not the service's: this is the engagement with THEM, and it is what a founder
  // scans a list of engagements looking for.
  assert.match(opened[0]!.title, /Harborline/);
  // It starts where the service says it starts, never at a stage this file invented.
  assert.ok(opened[0]!.stage, "the engagement opened with no stage");
});

test("a second client does not reopen the first one's work", async () => {
  const { app, store } = await makeFreshApp();
  const me = await api(app, "me");
  await shapeSaysTheTrade(store, me.json.projects[0].id, "books-keeper");
  const a = await api(app, "clients", { method: "POST", body: JSON.stringify({ display_name: "First" }) });
  const b = await api(app, "clients", { method: "POST", body: JSON.stringify({ display_name: "Second" }) });
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);

  const all = await casesFor(a.json.project_id);
  assert.equal(all.filter((k) => k.client_id === a.json.id).length, 1, "the first client gained a second engagement");
  assert.equal(all.filter((k) => k.client_id === b.json.id).length, 1, "the second client got none");
});

test("adding the same client twice opens one engagement", async () => {
  /**
   * A retried request, a double-clicked form, a replayed event. The idempotency is a read of the
   * client's own cases rather than a marker — one query, and it stays true if the engagement was
   * opened by the signature path instead.
   */
  const { app, store } = await makeFreshApp();
  const me = await api(app, "me");
  await shapeSaysTheTrade(store, me.json.projects[0].id, "books-keeper");
  const client = (await api(app, "clients", { method: "POST", body: JSON.stringify({ display_name: "Twice" }) })).json;

  // The same client id, through the same door the route uses — and the SAME store, or the shape is
  // invisible to the second call and it refuses for the wrong reason.
  const { openEngagementForNewClient } = await import("../src/engagement-open");
  const again = await openEngagementForNewClient(client.project_id, client, store);
  assert.equal(again, undefined, "a second call opened another engagement");
  assert.equal((await casesFor(client.project_id)).filter((k) => k.client_id === client.id).length, 1);
});

test("a business that has not said what it does is left alone", async () => {
  /**
   * THE REFUSAL THAT MATTERS. `deliveryWedge` will not pick a desk when the answer is ambiguous, and
   * the reason is in its own header: a bookkeeping client opened on the content desk is work drafted
   * against the wrong exemplars and a founder who has to notice and undo it. Nothing is worse here
   * than a wrong guess made silently.
   *
   * With no shape and no promoted service, there is no candidate at all — so the client is added and
   * nothing is opened, which is exactly right.
   */
  const { app } = await makeFreshApp();
  const client = (await api(app, "clients", { method: "POST", body: JSON.stringify({ display_name: "Unshaped" }) })).json;
  assert.equal(client.id ? (await casesFor(client.project_id)).length : -1, 0, "an engagement was guessed into existence");
});

test("the route still answers 201 when the engagement cannot open", async () => {
  // A client that was created is created. An engagement that failed to open is recoverable and
  // visible; failing the request would make adding a client look broken.
  const { app } = await makeFreshApp();
  const res = await api(app, "clients", { method: "POST", body: JSON.stringify({ display_name: "No shape here" }) });
  assert.equal(res.status, 201);
  assert.ok(res.json.id);
});
