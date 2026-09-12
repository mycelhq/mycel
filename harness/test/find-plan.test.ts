import { test } from "node:test";
import assert from "node:assert/strict";
import { api, makeApp } from "./helpers";
import {
  getIdentityStore,
  PLAN_FULFILLMENT,
  PLAN_INVOICING,
  PLAN_LIMITS,
  LINKEDIN_SESSION_LIMIT,
} from "../src/identity";
import { getDomainStore } from "../src/domain";

const PW = "a-long-enough-password";

async function findOrg() {
  const { app } = makeApp();
  const signup = await api(app, "auth/signup", {
    method: "POST",
    body: JSON.stringify({ email: `find-${Date.now()}@example.com`, password: PW }),
  });
  const session = signup.json.token as string;
  const orgId = signup.json.member.org_id as string;
  const projectId = signup.json.projects[0].id as string;
  getIdentityStore().setPlan(orgId, { plan: "find", status: "active" });
  const as = (path: string, opts: RequestInit = {}) =>
    api(
      app,
      path,
      {
        ...opts,
        headers: { "x-mycel-project": projectId, ...(opts.headers as Record<string, string> | undefined) },
      },
      session,
    );
  return { app, session, orgId, projectId, as };
}

test("find: the $49 aisle is pipeline-only — full OS limits stay on starter", () => {
  assert.equal(PLAN_LIMITS.find.fulfillment, false);
  assert.equal(PLAN_LIMITS.find.invoicing, false);
  assert.equal(PLAN_LIMITS.find.meeting_joins_per_month, 0);
  assert.equal(PLAN_LIMITS.find.linkedin_sessions, 1);
  assert.equal(PLAN_LIMITS.starter.fulfillment, true);
  assert.equal(PLAN_LIMITS.starter.invoicing, true);
  assert.equal(PLAN_LIMITS.starter.meeting_joins_per_month, 20);
  assert.equal(PLAN_LIMITS.growth.meeting_joins_per_month, 80);
});

test("find: a delivery case is 402, an outreach case is not", async () => {
  const { as } = await findOrg();
  const delivery = await as("cases", {
    method: "POST",
    body: JSON.stringify({ wedge: "books-keeper", title: "First job" }),
  });
  assert.equal(delivery.status, 402, delivery.text);
  assert.equal(delivery.json.code, PLAN_FULFILLMENT);
  assert.match(delivery.json.error, /Upgrade to Starter/i);

  const outreach = await as("cases", {
    method: "POST",
    body: JSON.stringify({ wedge: "gtm-operator", title: "Ada Lovelace" }),
  });
  assert.equal(outreach.status, 201, outreach.text);
});

test("find: kickoff and invoicing 402 with an upgrade sentence", async () => {
  const { as, orgId, projectId } = await findOrg();
  const domain = getDomainStore();
  const client = await domain.createClient({
    project_id: projectId,
    display_name: "Won lead",
    handles: ["won@find.test"],
    metadata: {},
  });

  getIdentityStore().setPlan(orgId, { plan: "starter", status: "active" });
  const opened = await as("cases", {
    method: "POST",
    body: JSON.stringify({ wedge: "books-keeper", title: "Engagement", client_id: client.id }),
  });
  assert.equal(opened.status, 201, opened.text);
  getIdentityStore().setPlan(orgId, { plan: "find", status: "active" });

  const kickoff = await as(`cases/${opened.json.id}/kickoff`, {
    method: "POST",
    body: JSON.stringify({ intake_only: true }),
  });
  assert.equal(kickoff.status, 402, kickoff.text);
  assert.equal(kickoff.json.code, PLAN_FULFILLMENT);

  const invoice = await as("invoices", {
    method: "POST",
    body: JSON.stringify({
      client_id: client.id,
      currency: "USD",
      lines: [{ description: "Month", kind: "fixed", unit_amount: 10_000 }],
    }),
  });
  assert.equal(invoice.status, 402, invoice.text);
  assert.equal(invoice.json.code, PLAN_INVOICING);
});

test("find: a second LinkedIn member session is refused", async () => {
  const { as, projectId } = await findOrg();
  const first = await as("connections", {
    method: "POST",
    body: JSON.stringify({ kind: "linkedin", name: "Founder" }),
  });
  assert.equal(first.status, 201, first.text);
  assert.equal(first.json.project_id, projectId);

  const second = await as("linkedin/connect", {
    method: "POST",
    body: JSON.stringify({
      li_at: "AQED_test",
      jsessionid: "ajax:test",
      proxy_url: "http://user:pass@127.0.0.1:8080",
    }),
  });
  assert.equal(second.status, 402, second.text);
  assert.equal(second.json.code, LINKEDIN_SESSION_LIMIT);
});

test("find: disconnect frees the LinkedIn session slot", async () => {
  const { as } = await findOrg();
  const first = await as("connections", {
    method: "POST",
    body: JSON.stringify({ kind: "linkedin", name: "Founder" }),
  });
  assert.equal(first.status, 201, first.text);

  const blocked = await as("linkedin/connect", {
    method: "POST",
    body: JSON.stringify({
      li_at: "AQED_test",
      jsessionid: "ajax:test",
      proxy_url: "http://user:pass@127.0.0.1:8080",
    }),
  });
  assert.equal(blocked.status, 402, blocked.text);
  assert.equal(blocked.json.code, LINKEDIN_SESSION_LIMIT);

  const gone = await as(`linkedin/connect/${first.json.id}`, { method: "DELETE" });
  assert.equal(gone.status, 200, gone.text);
  assert.equal(await getDomainStore().getConnection(first.json.id), undefined);

  const again = await as("linkedin/connect", {
    method: "POST",
    body: JSON.stringify({
      li_at: "AQED_test",
      jsessionid: "ajax:test",
      proxy_url: "http://user:pass@127.0.0.1:8080",
    }),
  });
  assert.notEqual(again.status, 402, again.text);
  assert.notEqual(again.json.code, LINKEDIN_SESSION_LIMIT);
});

test("find: Mycel notes join is 402 with the upgrade sentence, not a zero-count", async () => {
  const { as } = await findOrg();
  const kase = await as("cases", {
    method: "POST",
    body: JSON.stringify({ wedge: "gtm-operator", title: "Booked" }),
  });
  assert.equal(kase.status, 201, kase.text);
  const join = await as("meetings/join", {
    method: "POST",
    body: JSON.stringify({
      case_id: kase.json.id,
      meeting_url: "https://meet.google.com/aaa-bbbb-ccc",
      consent: true,
    }),
  });
  assert.equal(join.status, 402, join.text);
  assert.equal(join.json.code, "meeting_limit");
  assert.match(join.json.error, /Upgrade to Starter/i);
  assert.doesNotMatch(join.json.error, /0 call joins/);
});

test("find: starter still opens a delivery case", async () => {
  const { as, orgId } = await findOrg();
  getIdentityStore().setPlan(orgId, { plan: "starter", status: "active" });
  const delivery = await as("cases", {
    method: "POST",
    body: JSON.stringify({ wedge: "books-keeper", title: "First job" }),
  });
  assert.equal(delivery.status, 201, delivery.text);
});
