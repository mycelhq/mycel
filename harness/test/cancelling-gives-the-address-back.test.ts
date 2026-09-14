import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDomainStore } from "../src/domain";
import { getIdentityStore } from "../src/identity";
import { releaseOrgProxies } from "../src/proxy-decommission";
import { _resetProxyPoolForTests, provisionDedicatedIp } from "../src/linkedin/proxy-pool";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * A CANCELLED PLAN STOPS COSTING US MONEY
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * A LinkedIn connection leases a dedicated ISP address in the member's country. It bills monthly and
 * nothing gave it back — so a founder could cancel, have their work stop the same minute, and leave
 * us paying a proxy vendor for an address nobody will ever connect through again. A cost that only
 * ever goes up, one cancelled customer at a time.
 *
 * The two things that must both be true: a cancelled org's address is RETURNED, and an address
 * shared with somebody still paying is NOT.
 */

/** A scripted Bright Data account API. Returns the calls it received. */
function script(steps: Array<{ status?: number; body?: unknown; text?: string }>) {
  const calls: { method: string; url: string; body?: unknown }[] = [];
  let i = 0;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const step = steps[i++] ?? { status: 500, text: "no script left" };
    calls.push({
      method: init?.method ?? "GET",
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const text = step.text ?? (step.body === undefined ? "" : JSON.stringify(step.body));
    return { status: step.status ?? 200, text: async () => text } as unknown as Response;
  }) as unknown as typeof fetch;
  return calls;
}

function brightDataEnv() {
  process.env.MYCEL_LINKEDIN_PROXY_PROVIDER = "brightdata";
  process.env.MYCEL_BRIGHTDATA_CUSTOMER = "hl_abc";
  process.env.MYCEL_BRIGHTDATA_ZONE = "mycel_isp";
  process.env.MYCEL_BRIGHTDATA_PASSWORD = "zonepw";
  process.env.MYCEL_BRIGHTDATA_API_KEY = "key_test";
  _resetProxyPoolForTests(join(mkdtempSync(join(tmpdir(), "decom-")), "ledger.json"));
}

async function orgWithConnectedLinkedIn(ip: string, sticky = `li:at:${randomUUID().slice(0, 8)}`) {
  const identity = getIdentityStore();
  const { org, project } = identity.createOrgWithOwner(
    `acme-${randomUUID().slice(0, 6)}`,
    `owner-${randomUUID().slice(0, 8)}@example.test`,
    "correct-horse-battery",
  );
  const conn = await getDomainStore().createConnection({
    project_id: project.id,
    kind: "linkedin",
    name: "LinkedIn",
    owner: { kind: "founder", id: "founder" },
    config: {},
  });
  script([{ body: [] }, { body: { ok: true } }, { body: [{ ip, country: "gb" }] }]);
  await provisionDedicatedIp({ connectionId: conn.id, stickyKey: sticky, country: "gb" });
  return { org, project, conn, sticky };
}

test("cancelling hands the address back to the provider", async () => {
  brightDataEnv();
  const { org, conn } = await orgWithConnectedLinkedIn("203.0.113.9");

  const calls = script([{ body: { ips: [] } }, { body: [] }]);
  const out = await releaseOrgProxies(org.id);

  assert.equal(out.considered, 1);
  assert.equal(out.released, 1);
  assert.deepEqual(out.kept, []);

  const del = calls.find((c) => c.method === "DELETE")!;
  assert.match(del.url, /\/zone\/ips/);
  assert.deepEqual((del.body as { ips: string[] }).ips, ["203.0.113.9"]);
  // The CONNECTION ROW SURVIVES. Nothing here deletes a record — see `workBlockedBy`, which makes
  // the same promise about tasks and artifacts.
  assert.ok(await getDomainStore().getConnection(conn.id), "the connection row was deleted");
});

test("an address shared with a paying org is not taken away", async () => {
  brightDataEnv();
  const sticky = "li:at:shared";
  const a = await orgWithConnectedLinkedIn("203.0.113.10", sticky);

  // A second org connects the SAME LinkedIn member. By design they share one address — a second IP
  // for "org B" is the exact instability LinkedIn scores against.
  const identity = getIdentityStore();
  const { org: orgB, project: projectB } = identity.createOrgWithOwner(
    "beta",
    `beta-${randomUUID().slice(0, 8)}@example.test`,
    "correct-horse-battery",
  );
  const connB = await getDomainStore().createConnection({
    project_id: projectB.id,
    kind: "linkedin",
    name: "LinkedIn",
    owner: { kind: "founder", id: "founder" },
    config: {},
  });
  script([]);
  await provisionDedicatedIp({ connectionId: connB.id, stickyKey: sticky, country: "gb" });

  /*
    Org A cancels. Org B is still paying and its session is live on that address — pulling it would
    be the change LinkedIn punishes most. No script: any release attempt would be a call, and the
    assertion is that none is made.
  */
  const calls = script([]);
  const out = await releaseOrgProxies(a.org.id);
  assert.equal(out.released, 0);
  assert.deepEqual(out.kept, ["203.0.113.10"], "still billing, and it says so");
  assert.deepEqual(calls, [], "the provider was never asked to release a shared address");
  assert.ok(orgB.id);
});

test("an org with no LinkedIn costs nothing and asks nothing", async () => {
  brightDataEnv();
  const identity = getIdentityStore();
  const { org } = identity.createOrgWithOwner("empty", `empty-${randomUUID().slice(0, 8)}@example.test`, "correct-horse-battery");
  const calls = script([]);
  assert.deepEqual(await releaseOrgProxies(org.id), { considered: 0, released: 0, kept: [] });
  assert.deepEqual(calls, []);
});

test("a provider that refuses leaves the cost visible rather than swallowed", async () => {
  brightDataEnv();
  const { org } = await orgWithConnectedLinkedIn("203.0.113.11");

  // The release is attempted and the address is still in the zone afterwards: we are still paying.
  const calls = script([{ body: { ok: true } }, { body: [{ ip: "203.0.113.11", country: "gb" }] }]);
  const out = await releaseOrgProxies(org.id);
  assert.equal(out.released, 0);
  assert.deepEqual(out.kept, ["203.0.113.11"]);
  assert.ok(calls.length > 0, "it did try");
});
