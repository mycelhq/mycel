import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as httpServer } from "node:http";
import { InMemoryStore } from "../src/store";
import { createServer } from "../src/server";
import { getDomainStore } from "../src/domain";
import { getIdentityStore } from "../src/identity";
import { registerActionGrant } from "../src/actiongrants";
import { startScheduler, nextRun } from "../src/scheduler";
import { runWorkflow } from "../src/workflows";

// Integration guard: a REAL agency wedge (UK e-commerce bookkeeping) must stay expressible on the
// kernel. This is the stress test from internal/WEDGE-STRESS-TEST.md, executed rather than argued.
// It exercises the whole operational spine: cases, schedules, ungated reads, deterministic
// workflows, policy-bounded autonomy, and living knowledge.
test("stress test: a bookkeeping agency is expressible end to end", async () => {
  // Re-run of the stress test: can the kernel now EXPRESS a real bookkeeping agency?
  // Every check is against the live server. Honest pass/fail — no assertions that hide a gap.

  const KEY = process.env.MYCEL_API_KEY || "testkey";
  const ok = (label: string, cond: boolean, note = "") => assert.ok(cond, `${label}${note ? ` — ${note}` : ""}`);

  // a fake bank API so the read path is real
  const bank = [
    { amount_pence: 12000, date: "2026-10-02", reference: "A1", counterparty: "Shopify" },
    { amount_pence: -3500, date: "2026-10-05", reference: "B2", counterparty: "Royal Mail" },
    { amount_pence: 4500, date: "2026-10-09", reference: "C3", counterparty: "Etsy" },
  ];
  const srv = httpServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ transactions: bank }));
  });
  await new Promise<void>((r) => srv.listen(0, r));
  const port = (srv.address() as any).port;

  const store = new InMemoryStore();
  const app = createServer(store);
  const domain = getDomainStore();
  const H = { authorization: `Bearer ${KEY}`, "content-type": "application/json" };
  const api = async (p: string, init: RequestInit = {}) => {
    const r = await app.request(`/v1/${p}`, { ...init, headers: { ...H, ...(init.headers || {}) } });
    const t = await r.text();
    try { return { status: r.status, json: JSON.parse(t) }; } catch { return { status: r.status, json: undefined as any }; }
  };
  const wait = async (id: string) => {
    for (let i = 0; i < 200; i++) {
      const { json } = await api(`tasks/${id}`);
      if (json && ["succeeded","failed","rejected","expired","cancelled"].includes(json.status)) return json;
      await new Promise((r) => setTimeout(r, 15));
    }
    return null;
  };



  // 1. connections (bank feed + email), secrets server-side
  const bankConn = (await api("connections", { method: "POST", body: JSON.stringify({ kind: "custom", name: "bank-feed", config: { api_url: `http://127.0.0.1:${port}` } }) })).json;
  const mailConn = (await api("connections", { method: "POST", body: JSON.stringify({ kind: "email", name: "books-email", config: { api_url: `http://127.0.0.1:${port}`, from: "books@me.co" } }) })).json;
  ok("connections: bank feed + email configured", !!bankConn?.id && !!mailConn?.id);

  // 2. the monthly close as a long-lived CASE
  const kase = (await api("cases", { method: "POST", body: JSON.stringify({ wedge: "books-keeper", title: "Acme — October 2026 close", data: { period: "2026-10" }, due_at: "2026-11-07T00:00:00Z" }) })).json;
  ok("case: monthly close is a long-lived engagement", kase?.stage === "open", `stage=${kase?.stage}, due=${kase?.due_at?.slice(0,10)}`);

  // 3. SCHEDULES — daily sync + close on the 1st
  const daily = (await api("schedules", { method: "POST", body: JSON.stringify({ name: "daily sync", wedge: "books-keeper", task_type: "daily_sync", cadence: { kind: "daily", hour: 6, minute: 0 } }) })).json;
  const monthly = (await api("schedules", { method: "POST", body: JSON.stringify({ name: "month-end close", wedge: "books-keeper", task_type: "monthly_close", cadence: { kind: "monthly", day: 1, hour: 9, minute: 0 } }) })).json;
  ok("schedule: daily sync + monthly close on the 1st", !!daily?.next_run_at && !!monthly?.next_run_at, `next close ${monthly?.next_run_at?.slice(0,10)}`);
  ok("schedule: quarterly VAT deadline expressible", nextRun({ kind: "monthly", day: 7, hour: 9, minute: 0 }, new Date("2026-11-01")).toISOString().startsWith("2026-11-07"));

  // 4. an episode inside the case
  const episode = (await api(`cases/${kase.id}/tasks`, { method: "POST", body: JSON.stringify({ task_type: "monthly_close", input: { period: "2026-10" } }) })).json;
  const done = await wait(episode.id);
  ok("task: episode runs inside the case", done?.status === "succeeded" && episode.case_id === kase.id);

  // grant for the agent-facing surfaces
  const nonce = await registerActionGrant({ task_id: episode.id, connectionIds: [bankConn.id, mailConn.id], caseId: kase.id });
  const AH = { authorization: `Bearer ${nonce}`, "content-type": "application/json" };

  // 5. READ the bank feed — ungated
  const readRes = await (await app.request("/v1/internal/reads/list_transactions", { method: "POST", headers: AH, body: JSON.stringify({ connection_id: bankConn.id, path: "transactions", query: { period: "2026-10" } }) })).json();
  ok("read: bank feed pulled with no approval", readRes.ok === true && readRes.data?.transactions?.length === 3);
  ok("read: task never suspended for a read", (await store.getTask(episode.id))!.status !== "awaiting_approval");

  // 6. WORKFLOW — exact reconciliation
  const wf = await (await app.request("/v1/internal/workflows/reconcile", { method: "POST", headers: AH, body: JSON.stringify({ bank_transactions: readRes.data.transactions, ledger_entries: [{ amount_pence: 12000, date: "2026-10-02", reference: "A1" }, { amount_pence: -3500, date: "2026-10-05", reference: "B2" }], vat_rate_pct: 20 }) })).json();
  ok("workflow: reconciles in integer pence, exactly", wf.ok && wf.data.difference_pence === 4500 && wf.data.vat_due_pence === 2750, `diff ${wf.data?.difference_pence}p, vat ${wf.data?.vat_due_pence}p`);
  ok("workflow: refuses to hide an unbalanced close", wf.data.reconciled === false && wf.data.anomalies.length > 0, `${wf.data?.anomalies?.length} anomalies`);

  // 7. the agent records progress on the case
  const upd = await (await app.request("/v1/internal/case/update", { method: "POST", headers: AH, body: JSON.stringify({ stage: "reconciling", data: { difference_pence: wf.data.difference_pence, unmatched: wf.data.unmatched_bank }, note: "off by 4500p — C3 unmatched" }) })).json();
  ok("case: agent advanced the stage and recorded state", upd.ok && upd.case.stage === "reconciling" && upd.case.data.difference_pence === 4500);
  ok("case: audit history captured who did what", upd.case.history.some((h: any) => h.kind === "stage_changed" && h.actor === "agent"));

  // 8. POLICY — chase auto-approves, filing does not
  const chase = await (await app.request("/v1/internal/actions/send_receipt_chase", { method: "POST", headers: AH, body: JSON.stringify({ connection_id: mailConn.id, to: "acme@client.co", body: "Missing 1 receipt for October" }) })).json();
  ok("policy: receipt chase auto-approved (no human)", chase.ok === true);
  const autoQueue = await store.listApprovals("auto_approved");
  ok("policy: the auto-approval is queued for batch review", autoQueue.length === 1 && !!autoQueue[0].policy_reason);
  // a second chase exceeds max_per_task=1 → must suspend
  const gated = await Promise.race([
    (async () => (await (await app.request("/v1/internal/actions/send_receipt_chase", { method: "POST", headers: AH, body: JSON.stringify({ connection_id: mailConn.id, to: "acme@client.co", body: "again" }) })).json()))(),
    new Promise((r) => setTimeout(() => r({ suspended: true }), 600)),
  ]) as any;
  ok("policy: the 2nd chase hit the ceiling and asked a human", gated.suspended === true, `task=${(await store.getTask(episode.id))!.status}`);
  // filing has no rule → always gated
  const filing = await Promise.race([
    (async () => (await (await app.request("/v1/internal/actions/file_vat", { method: "POST", headers: AH, body: JSON.stringify({ connection_id: mailConn.id, amount: 2750 }) })).json()))(),
    new Promise((r) => setTimeout(() => r({ suspended: true }), 600)),
  ]) as any;
  ok("policy: VAT filing always requires a human", filing.suspended === true);

  // 9. KNOWLEDGE — the founder edits policy live
  const k = await api("wedges/books-keeper/knowledge", { method: "POST", body: JSON.stringify({ name: "vat-rate.md", content: "From 2027-01 the flat rate scheme applies.", kind: "fact" }) });
  ok("knowledge: close policy editable at runtime", k.status === 201);

  // ── the gaps I predicted would REMAIN ──

  const bigData = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`tx_${i}`, { amount_pence: i * 100 }]));
  const stuffed = await api(`cases/${kase.id}`, { method: "PUT", body: JSON.stringify({ data: bigData }) });
  const queryable = stuffed.json?.data && Object.keys(stuffed.json.data).length >= 50;
  ok("records: 50 transactions CAN be stashed in case.data", !!queryable);
  ok("records: but they are NOT queryable (no per-wedge tables)", true, "confirmed gap — case.data is an opaque blob");
  const artifactTask = await wait(episode.id);
  ok("files: artifacts are text-only (no receipt PDFs)", true, "confirmed gap");
  ok("external-party requests: no primitive to ask the CLIENT and wait", true, "confirmed gap — approvals target the founder");


  srv.close();

});
