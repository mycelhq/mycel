// Post-reply gated DMs — outside the campaign envelope.
//
// The interesting assertions here are not "it sends": they are what the record says when it does
// not. A transport failure used to be written down as a rejection by the founder, which is a lie
// about a human decision sitting in an audit trail.
import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryStore } from "../src/store";
import { getDomainStore } from "../src/domain";
import { decideReply, proposeReply, ReplyError, ReplySendError } from "../src/gtm/reply";

const domain = () => getDomainStore();

async function account(projectId: string) {
  return domain().createConnection({
    project_id: projectId,
    kind: "linkedin",
    name: "LI",
    owner: { kind: "founder", id: "f" },
    config: {},
  });
}

async function prospect(projectId: string, connId: string, stage: string) {
  return domain().createCase({
    project_id: projectId,
    wedge: "gtm-operator",
    title: "Dana",
    stage,
    status: "open",
    data: { connection_id: connId, profile_id: "dana", thread: "urn:li:thread:1", has_reply: true },
  });
}

test("proposeReply refuses while the sequence is still running", async () => {
  const store = new InMemoryStore();
  const conn = await account("p-reply-gate");
  const kase = await prospect("p-reply-gate", conn.id, "dm1");
  await assert.rejects(
    () => proposeReply(store, domain(), { project_id: "p-reply-gate", kase, connection: conn, body: "hi" }),
    ReplyError,
  );
});

test("proposeReply refuses a case and an account from different projects", async () => {
  const store = new InMemoryStore();
  const mine = await account("p-reply-a");
  const theirs = await account("p-reply-b");
  const kase = await prospect("p-reply-a", mine.id, "replied");
  // The leak this prevents: a connection id from another tenant, posted at a case id from this one,
  // sending a message out of somebody else's LinkedIn account.
  await assert.rejects(
    () => proposeReply(store, domain(), { project_id: "p-reply-a", kase, connection: theirs, body: "hi" }),
    ReplyError,
  );
  // And the mirror: this project's account pointed at another project's case.
  const other = await prospect("p-reply-b", theirs.id, "replied");
  await assert.rejects(
    () => proposeReply(store, domain(), { project_id: "p-reply-a", kase: other, connection: mine, body: "hi" }),
    ReplyError,
  );
});

test("proposeReply queues one pending approval and sends nothing; reject settles it", async () => {
  const store = new InMemoryStore();
  const conn = await account("p-reply-ok");
  const kase = await prospect("p-reply-ok", conn.id, "replied");

  const { approval_id, task_id } = await proposeReply(store, domain(), {
    project_id: "p-reply-ok",
    kase,
    connection: conn,
    body: "Would Thursday at 2 work?",
  });
  const pending = await store.getApproval(approval_id);
  assert.equal(pending?.status, "pending");
  assert.equal(pending?.action, "linkedin:send_message");
  assert.equal((pending?.preview as { gtm_reply?: boolean })?.gtm_reply, true);
  assert.equal((await store.getTask(task_id))?.status, "awaiting_approval");

  await decideReply(store, domain(), {
    project_id: "p-reply-ok",
    approval_id,
    decision: "rejected",
    getConnection: async (id) => (id === conn.id ? conn : undefined),
  });
  assert.equal((await store.getApproval(approval_id))?.status, "rejected");
  assert.equal((await store.getTask(task_id))?.status, "rejected");
});

test("decideReply cannot be settled from another project", async () => {
  const store = new InMemoryStore();
  const conn = await account("p-reply-tenant");
  const kase = await prospect("p-reply-tenant", conn.id, "replied");
  const { approval_id } = await proposeReply(store, domain(), {
    project_id: "p-reply-tenant",
    kase,
    connection: conn,
    body: "hi",
  });
  await assert.rejects(
    () =>
      decideReply(store, domain(), {
        project_id: "p-someone-else",
        approval_id,
        decision: "approved",
        getConnection: async () => conn,
      }),
    ReplyError,
  );
  assert.equal((await store.getApproval(approval_id))?.status, "pending");
});

test("a LinkedIn failure after approve is recorded as approved-but-not-sent, never as a rejection", async () => {
  const store = new InMemoryStore();
  // No stored session on this connection, so `executeAction` fails the way a real outage does.
  const conn = await account("p-reply-fail");
  const kase = await prospect("p-reply-fail", conn.id, "replied");
  const { approval_id, task_id } = await proposeReply(store, domain(), {
    project_id: "p-reply-fail",
    kase,
    connection: conn,
    body: "Would Thursday at 2 work?",
  });

  await assert.rejects(
    () =>
      decideReply(store, domain(), {
        project_id: "p-reply-fail",
        approval_id,
        decision: "approved",
        getConnection: async (id) => (id === conn.id ? conn : undefined),
      }),
    ReplySendError,
  );

  // THE POINT: the founder approved, so the approval says approved. The send failed, so the task
  // says failed and carries the reason. Writing "rejected" here would put words in their mouth.
  assert.equal((await store.getApproval(approval_id))?.status, "approved");
  const task = await store.getTask(task_id);
  assert.equal(task?.status, "failed");
  assert.ok((task?.error ?? "").length > 0);
});
