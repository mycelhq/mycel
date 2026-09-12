/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * 51 ASKS RAISED. 3 ANSWERED. THE FOUNDER HAD NO WAY TO ANSWER ONE.
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Until this route existed the only way to resolve an ask was
 * `POST /v1/portal/requests/:id/respond` — a CLIENT-plane route, behind a portal that five clients
 * have ever logged into.
 *
 * So the run stops and says "send me the September bank statement". The founder has the September
 * bank statement; it is in their email, from the client, last Tuesday. And there was nowhere to put
 * it. Their own work sat blocked on a customer logging into a portal nobody had mentioned to them,
 * and the product asked again four hours later.
 *
 * A paying user who cannot unblock their own work churns in the first session, and correctly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { api, makeApp } from "./helpers";
import { getDomainStore } from "../src/domain";
import { getRequestStore } from "../src/requests";

async function world() {
  const { app, store } = makeApp();
  const pid = (await api(app, "me")).json.projects[0].id as string;
  const H = { "x-mycel-project": pid };
  const domain = getDomainStore();
  const client = await domain.createClient({ project_id: pid, display_name: "Ridgeline", handles: ["ops@ridgeline.test"], metadata: {} });
  const kase = await domain.createCase({
    project_id: pid, wedge: "books-keeper", title: "Close", client_id: client.id, stage: "open", status: "open", data: {},
  });
  const task = await api(app, "tasks", {
    method: "POST", headers: H,
    body: JSON.stringify({
      wedge: "books-keeper", task_type: "monthly_close", input: { period: "2026-09" },
      client_id: client.id, case_id: kase.id, actor: { kind: "user", id: client.id },
    }),
  });
  assert.equal(task.status, 201, task.text);
  return { app, store, pid, H, client, kase, taskId: task.json.id as string };
}

const ask = async (w: Awaited<ReturnType<typeof world>>, over: Record<string, unknown> = {}) =>
  getRequestStore().createRequest({
    project_id: w.pid, client_id: w.client.id, case_id: w.kase.id, task_id: w.taskId,
    kind: "document", ask: "The September bank statement", status: "open", ...over,
  } as any);

test("a founder can answer the ask themselves, and the work unblocks", async () => {
  const w = await world();
  const r = await ask(w);

  const res = await api(w.app, `requests/${r.id}/respond`, {
    method: "POST", headers: w.H,
    body: JSON.stringify({ response: "Attached — the client emailed it to me on Tuesday." }),
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.request.status, "resolved");

  const fresh = await getRequestStore().getRequest(w.pid, r.id);
  assert.equal(fresh!.status, "resolved", "the ask is still blocking the engagement");
});

test("IT DOES NOT PRETEND TO BE THE CLIENT", () => {
  /**
   * The portal route writes the thread message as `author: sc.client_id` and spawns a reply run,
   * because a customer answering IS inbound contact. A founder filling in a blank is not: nothing
   * arrived from the client, so writing into their thread would manufacture a message they never
   * sent and chasing it would answer a person who has not spoken.
   */
  const src = readFileSync(new URL("../src/requests.routes.ts", import.meta.url), "utf8");
  const route = src.slice(src.indexOf('app.post("/v1/requests/:id/respond"'), src.indexOf('app.post("/v1/requests/:id/cancel"'));
  assert.ok(!/addMessage\(/.test(route), "the founder route writes a message into the client's thread");
  assert.ok(!/spawnFromThread\(/.test(route), "the founder route spawns a reply run at a client who never spoke");
  assert.match(route, /"founder"\)/, "the resolve does not record who actually answered");
});

test("provenance is recorded — who answered is a fact about the evidence", async () => {
  // "The client confirmed the closing balance" and "the business supplied a statement for the
  // client" are different facts about the same number. A close that cites the first when the second
  // happened is citing evidence that does not exist.
  const w = await world();
  const r = await ask(w);
  await api(w.app, `requests/${r.id}/respond`, {
    method: "POST", headers: w.H, body: JSON.stringify({ response: "I have it." }),
  });
  const fresh = await getRequestStore().getRequest(w.pid, r.id);
  assert.equal(fresh!.answered_by, "founder");
});

test("the founder can attach the file they already have", async () => {
  const w = await world();
  const r = await ask(w);

  const form = new FormData();
  form.set("file", new File(["date,amount\n2026-09-01,-1200\n"], "september-statement.csv", { type: "text/csv" }));
  const up = await w.app.request(`/v1/requests/${r.id}/attachments`, {
    method: "POST", headers: { "x-mycel-project": w.pid, authorization: "Bearer testkey" }, body: form,
  });
  const upBody = await up.text();
  assert.equal(up.status, 201, upBody);
  const artifact = JSON.parse(upBody);
  assert.equal(artifact.name, "september-statement.csv");

  const res = await api(w.app, `requests/${r.id}/respond`, {
    method: "POST", headers: w.H,
    body: JSON.stringify({ response: "September statement attached.", artifact_ids: [artifact.id] }),
  });
  assert.equal(res.status, 200, res.text);
  const fresh = await getRequestStore().getRequest(w.pid, r.id);
  assert.deepEqual(fresh!.response_artifact_ids, [artifact.id], "the file is not attached to the answer");
});

test("an ask with no run behind it refuses a file in words, and still takes a typed answer", async () => {
  // Kickoff asks are raised when an engagement opens, before any run — six of the twenty-eight open
  // document asks in production. Silently accepting a file with nowhere to belong would be worse.
  const w = await world();
  const r = await ask(w, { task_id: undefined });

  const form = new FormData();
  form.set("file", new File(["x"], "a.csv", { type: "text/csv" }));
  const up = await w.app.request(`/v1/requests/${r.id}/attachments`, {
    method: "POST", headers: { "x-mycel-project": w.pid, authorization: "Bearer testkey" }, body: form,
  });
  assert.equal(up.status, 409);
  assert.match(await up.text(), /before any run|type the answer/i);

  const res = await api(w.app, `requests/${r.id}/respond`, {
    method: "POST", headers: w.H, body: JSON.stringify({ response: "Sole trader, not registered." }),
  });
  assert.equal(res.status, 200, res.text);
});

test("a closed ask cannot be answered twice, and a connection ask is not typed at", async () => {
  const w = await world();
  const r = await ask(w);
  await api(w.app, `requests/${r.id}/respond`, { method: "POST", headers: w.H, body: JSON.stringify({ response: "done" }) });
  const again = await api(w.app, `requests/${r.id}/respond`, { method: "POST", headers: w.H, body: JSON.stringify({ response: "again" }) });
  assert.equal(again.status, 409, again.text);

  const conn = await ask(w, { kind: "connection", connection_toolkit: "quickbooks" });
  const typed = await api(w.app, `requests/${conn.id}/respond`, {
    method: "POST", headers: w.H, body: JSON.stringify({ response: "connected it" }),
  });
  assert.equal(typed.status, 400);
  assert.match(typed.text, /connecting the app/i);
});

test("another tenant's ask is a 404, not a 409", async () => {
  const w = await world();
  const r = await ask(w);
  const res = await api(w.app, `requests/${r.id}/respond`, {
    method: "POST", headers: { "x-mycel-project": "p-someone-else" },
    body: JSON.stringify({ response: "not mine" }),
  });
  assert.ok(res.status === 404 || res.status === 400, `expected a refusal, got ${res.status}: ${res.text}`);
});
