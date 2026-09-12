/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * 51 ASKS RAISED. 0 EVER ANSWERED. THE ASK NEVER LEFT THE BUILDING.
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The obvious reading of those numbers is that clients ignore us. The measured truth is worse: of
 * the four `nudge_client_request` runs that have EVER succeeded in production, all four
 *
 *   · booted a Daytona sandbox,
 *   · called `todowrite`, `glob` and `read`,
 *   · produced a validated reminder in `message`,
 *   · called `send_email` zero times,
 *   · and reported success.
 *
 * Not one of them has an approval row, which is the proof — nothing outbound happens in this kernel
 * without one. The job was a message generator with no outbox.
 *
 * The tests here assert on the SEND, never on the output. An assertion that a message was composed
 * would have passed on every one of those four runs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { deliverRunMessage } from "../src/deliver-message";
import { getDomainStore } from "../src/domain";
import { SPINE_TASK_TYPES } from "../src/spine";

const P = "p1";

function fakeTask(over: Record<string, unknown> = {}): any {
  const now = new Date().toISOString();
  return {
    id: "t-nudge", project_id: P, wedge: "books-keeper", task_type: "nudge_client_request",
    actor: { kind: "user", id: "u" }, input: {}, constraints: { max_runtime_s: 300, max_cost_usd: 1, approval_required: true },
    tools: [], status: "running", cost_usd: 0, created_at: now, updated_at: now, ...over,
  };
}

/** Records what would have gone over the wire instead of standing up a server. */
function recorder() {
  const calls: { url: string; body: any; auth?: string }[] = [];
  return {
    calls,
    post: async (url: string, init: RequestInit) => {
      calls.push({
        url,
        body: JSON.parse(String(init.body ?? "{}")),
        auth: (init.headers as Record<string, string>)?.authorization,
      });
      return { ok: true, status: 200, body: JSON.stringify({ ok: true }) };
    },
  };
}

async function withClient(handles: string[]) {
  const domain = getDomainStore();
  const client = await domain.createClient({ project_id: P, display_name: "Ridgeline", handles, metadata: {} });
  await domain.createConnection({
    project_id: P, kind: "email", name: "mailbox", owner: { kind: "founder", id: "f" },
    config: { address: "hello@practice.test" }, secret_ref: "env:X",
  });
  return client;
}

test("the reminder is actually sent, through the action proxy, with a grant", async () => {
  const client = await withClient(["ops@ridgeline.test"]);
  const rec = recorder();
  const out = await deliverRunMessage({
    task: fakeTask({ client_id: client.id }),
    parsed: { step: "reminder", channel: "email", subject: "The April bank statement", message: "Hi — still need April's statement." },
    post: rec.post,
  });

  assert.equal(out.sent, true, out.reason);
  assert.equal(rec.calls.length, 1, "nothing was sent");
  const call = rec.calls[0]!;
  // The same route the sandbox uses, so the approval gate, the guard and the audit row all apply.
  assert.match(call.url, /\/v1\/internal\/actions\/send_email$/);
  assert.match(call.auth ?? "", /^Bearer .+/, "sent without an action grant");
  assert.deepEqual(call.body.to, ["ops@ridgeline.test"]);
  assert.equal(call.body.subject, "The April bank statement");
  // Both spellings, because the kernel's own transports read `text` and brokered ones read `body`.
  assert.equal(call.body.text, "Hi — still need April's statement.");
  assert.equal(call.body.body, "Hi — still need April's statement.");
});

test("`hold` is a decision and is honoured, not overridden", async () => {
  const client = await withClient(["ops@ridgeline.test"]);
  const rec = recorder();
  const out = await deliverRunMessage({
    task: fakeTask({ client_id: client.id }),
    parsed: { step: "hold", channel: "email", subject: "s", message: "would have chased" },
    post: rec.post,
  });
  assert.equal(out.sent, false);
  assert.equal(rec.calls.length, 0, "a held nudge was sent anyway");
  assert.match(out.reason ?? "", /hold/i);
});

test("`channel: none` sends nothing", async () => {
  const client = await withClient(["ops@ridgeline.test"]);
  const rec = recorder();
  const out = await deliverRunMessage({
    task: fakeTask({ client_id: client.id }),
    parsed: { step: "reminder", channel: "none", subject: "s", message: "m" },
    post: rec.post,
  });
  assert.equal(out.sent, false);
  assert.equal(rec.calls.length, 0);
});

test("a client with no email gets a refusal that names the fix", async () => {
  // The commonest real refusal. "Could not send" tells a founder nothing they can act on; this is
  // ten seconds of work once they know.
  const client = await withClient(["+447700900000"]);
  const rec = recorder();
  const out = await deliverRunMessage({
    task: fakeTask({ client_id: client.id }),
    parsed: { step: "reminder", channel: "email", subject: "s", message: "m" },
    post: rec.post,
  });
  assert.equal(out.sent, false);
  assert.equal(rec.calls.length, 0);
  assert.match(out.reason ?? "", /no email address on file/i);
  assert.match(out.reason ?? "", /Ridgeline/, "the refusal does not say WHICH client");
});

test("a refusal from the proxy is reported in the proxy's own words", async () => {
  const client = await withClient(["ops@ridgeline.test"]);
  const out = await deliverRunMessage({
    task: fakeTask({ client_id: client.id }),
    parsed: { step: "reminder", channel: "email", subject: "s", message: "m" },
    post: async () => ({ ok: true, status: 200, body: JSON.stringify({ ok: false, error: "two mailboxes are connected — name one" }) }),
  });
  assert.equal(out.sent, false);
  assert.equal(out.reason, "two mailboxes are connected — name one");
});

test("a send that throws never fails the run", async () => {
  // The ladder tries again tomorrow. Failing here would lose the drafted message AND burn one of
  // the client's reminders on nothing.
  const client = await withClient(["ops@ridgeline.test"]);
  const out = await deliverRunMessage({
    task: fakeTask({ client_id: client.id }),
    parsed: { step: "reminder", channel: "email", subject: "s", message: "m" },
    post: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  assert.equal(out.sent, false);
  assert.match(out.reason ?? "", /ECONNREFUSED/);
});

test("no client, no output, no message — each refuses with a sentence rather than throwing", async () => {
  for (const [parsed, task, expect] of [
    [null, fakeTask({ client_id: "c" }), /no structured output/i],
    [{ step: "reminder", channel: "email", message: "" }, fakeTask({ client_id: "c" }), /no message/i],
    [{ step: "reminder", channel: "email", message: "m" }, fakeTask({}), /names no client/i],
  ] as const) {
    const out = await deliverRunMessage({ task, parsed: parsed as any, post: async () => ({ ok: true, status: 200, body: "{}" }) });
    assert.equal(out.sent, false);
    assert.match(out.reason ?? "", expect);
  }
});

/**
 * The wiring. A deliverer nobody calls is the bug this file exists for, one layer up — so these
 * assert the CALL SITE and the DECLARATION, not that the functions exist.
 */
test("the nudge declares that the kernel sends it, and asks the model for a subject", () => {
  const nudge = SPINE_TASK_TYPES.nudge_client_request as any;
  assert.equal(nudge.sends, true, "the spine's nudge does not declare `sends`");
  const required: string[] = nudge.output_schema.required;
  assert.ok(required.includes("message"), "a nudge with no message cannot be sent");
  assert.ok(required.includes("subject"), "an email with no subject reads as spam and is filed as one");
});

test("the orchestrator actually calls the deliverer", () => {
  const src = readFileSync(new URL("../src/orchestrator.ts", import.meta.url), "utf8");
  assert.match(src, /if \(loadedSpec\?\.sends\)/, "nothing reads the `sends` declaration");
  assert.match(src, /await deliverRunMessage\(\{ task, parsed: parsedOut \}\)/, "the deliverer is imported but never called");
  // The refusal has to reach the founder. For the whole time this was broken it was invisible.
  assert.match(src, /Not sent — \$\{delivery\.reason/, "a refusal is swallowed instead of shown");
});

test("the sandbox is released BEFORE the send, or a founder at lunch holds a Daytona box", () => {
  // `/v1/internal/actions/send_email` blocks on the human gate for up to thirty minutes, and the
  // sandbox is otherwise destroyed in `finally` — i.e. after. 94% of the sandbox-hours we paid for
  // last fortnight were dead runs waiting out a timer; putting that back on the most frequent job
  // in the product would undo the whole fix.
  const src = readFileSync(new URL("../src/orchestrator.ts", import.meta.url), "utf8");
  const branch = src.slice(src.indexOf("if (loadedSpec?.sends)"), src.indexOf("await deliverRunMessage"));
  assert.match(branch, /await sandbox\.destroy\(\)/, "the sandbox is still held while the founder decides");
  assert.match(branch, /sandbox = undefined/, "the sandbox is destroyed twice — `finally` will do it again");
});
