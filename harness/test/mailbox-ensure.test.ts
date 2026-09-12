// EVERY ENGAGEMENT GETS AN ADDRESS, AND NOTHING ABOUT THAT MAY BREAK THE ENGAGEMENT.
//
// Measured before this existed: twenty-one projects, ONE channel — the QA walkthrough, made by
// hand. Seven real projects, a hundred and forty-three engagements between them, and not one
// address. The onboarding step was good and its completion rate across real projects was zero.
//
// That absence is upstream of the whole client loop: no channel means kickoff makes no thread,
// no thread means every ask it raises carries `thread_id: null`, and an ask with no thread cannot
// be emailed. Fifty-one asks written, three answered.
//
// So it is automatic now. Which makes the second property the important one: this runs inside
// `startWork`, on the path a signed contract takes to become an engagement, and a signed contract
// opening is worth more than an address. It must degrade, never throw.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp, api, freshProjectId } from "./helpers";
import { getDomainStore } from "../src/domain";
import { ensureProjectMailbox, mailboxUsername } from "../src/mailbox-ensure";

test("mailbox: a project that already has one is left exactly as it is", async () => {
  const { app } = makeApp();
  const projectId = (await api(app, "me")).json.projects[0].id as string;
  const domain = getDomainStore();
  const conn = await domain.createConnection({
    project_id: projectId, kind: "email", name: "theirs", owner: { kind: "business" }, config: {},
  });
  await domain.createChannel({
    project_id: projectId, connection_id: conn.id, kind: "email",
    address: "already@theirs.test", wedge: "books-keeper", task_type: "daily_sync",
  });

  const before = (await channelsFor(projectId)).length;
  const out = await ensureProjectMailbox({
    project_id: projectId, wedge: "books-keeper", task_type: "daily_sync", project_name: "Theirs",
  });

  assert.equal(out.ok, true);
  assert.equal(out.ok && out.created, false, "it minted a second inbox for a project that had one");
  assert.equal(out.ok && out.address, "already@theirs.test", "it reported an address that is not theirs");
  assert.equal((await channelsFor(projectId)).length, before, "the channel list changed");
});

/**
 * Channels for ONE project. `getDomainStore` is a process-wide singleton by design, so
 * `listChannels()` is a shared collection and helpers.ts is explicit that asserting a count over one
 * is the mistake — it says so having cost three debugging detours already. This made a fourth.
 */
const channelsFor = async (projectId: string) =>
  (await getDomainStore().listChannels()).filter((ch) => ch.project_id === projectId);

test("mailbox: idempotent by the CHANNEL, so calling it twice costs one inbox", async () => {
  /**
   * Kickoff looks for a channel and nothing else, so the channel is the only thing whose presence
   * can be trusted to mean "this project can send". A flag on the project would be a second source
   * of truth, free to disagree with the first.
   */
  makeApp();
  const projectId = freshProjectId("mbox");
  const domain = getDomainStore();
  const conn = await domain.createConnection({
    project_id: projectId, kind: "agentmail", name: "m", owner: { kind: "founder", id: "founder" }, config: {},
  });
  await domain.createChannel({
    project_id: projectId, connection_id: conn.id, kind: "agentmail",
    address: "hello@x.test", wedge: "books-keeper", task_type: "daily_sync",
  });

  for (let i = 0; i < 3; i++) {
    const out = await ensureProjectMailbox({
      project_id: projectId, wedge: "books-keeper", task_type: "daily_sync",
    });
    assert.equal(out.ok && out.created, false, `call ${i + 1} created another inbox`);
  }
  assert.equal((await channelsFor(projectId)).length, 1, "repeated calls accumulated channels");
});

test("mailbox: an unconfigured deployment gets a reason, not an exception", async () => {
  // The engagement is on the other side of this call. A deployment with no AgentMail key must open
  // engagements exactly as before, and say why the address is missing.
  makeApp();
  const projectId = freshProjectId("nokey");
  const key = process.env.AGENTMAIL_API_KEY;
  delete process.env.AGENTMAIL_API_KEY;
  try {
    const out = await ensureProjectMailbox({
      project_id: projectId, wedge: "books-keeper", task_type: "daily_sync",
    });
    assert.equal(out.ok, false);
    assert.match(!out.ok ? out.reason : "", /AGENTMAIL_API_KEY/, "the reason does not name what is missing");
  } finally {
    if (key !== undefined) process.env.AGENTMAIL_API_KEY = key;
  }
});

test("mailbox: an inbox nothing runs on is refused", async () => {
  // Same refusal the manual route makes. A mailbox with no wedge behind it accepts replies and
  // drops them, which is worse than having no mailbox — the client thinks they answered.
  const { app } = makeApp();
  const projectId = (await api(app, "me")).json.projects[0].id as string;
  for (const bad of [
    { project_id: projectId, wedge: "", task_type: "daily_sync" },
    { project_id: projectId, wedge: "books-keeper", task_type: "" },
    { project_id: "", wedge: "books-keeper", task_type: "daily_sync" },
  ]) {
    const out = await ensureProjectMailbox(bad);
    assert.equal(out.ok, false, `accepted ${JSON.stringify(bad)}`);
  }
});

test("mailbox: the address reads like a business, not like a database row", () => {
  assert.equal(mailboxUsername("Northgate Studio"), "northgate-studio");
  assert.equal(mailboxUsername("Rivet & Ledger Bookkeeping"), "rivet-ledger-bookkeeping");
  // Nothing usable falls back to `hello`, which is what onboarding offered. A client reading
  // `hello@…` sees a business; one reading `project-7@…` sees the software behind it.
  assert.equal(mailboxUsername(""), "hello");
  assert.equal(mailboxUsername(undefined), "hello");
  assert.equal(mailboxUsername("   !!!   "), "hello");
  // AgentMail accepts [a-z0-9._-]{1,64}; anything we send outside that is a round trip wasted.
  for (const name of ["Northgate Studio", "Rivet & Ledger", "ÜBER Ltd", "a".repeat(90)]) {
    assert.match(mailboxUsername(name), /^[a-z0-9._-]{1,64}$/, `"${name}" produced an invalid username`);
  }
});
