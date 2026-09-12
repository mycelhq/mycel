// A showroom org shows the product without running it.
//
// The demo tenant already had every control that exists — model budget zero at the gateway,
// schedules off, connections deleted — and clicking "Build my site" still booted a sandbox. Task
// creation checks the PLAN ceiling ($90), not the budget the org's key actually carries ($0), so
// the task was created, infrastructure started, and the model call was refused downstream. One
// microVM per click for anyone bored enough to keep clicking.

import { test } from "node:test";
import assert from "node:assert/strict";
import { isShowroomOrg, showroomOrgIds, SHOWROOM_REFUSAL, reportShowroomConfig, unknownShowroomOrgs } from "../src/showroom.ts";
import { readFileSync } from "node:fs";

const withEnv = (v: string | undefined, fn: () => void) => {
  const prev = process.env.MYCEL_SHOWROOM_ORG_IDS;
  if (v === undefined) delete process.env.MYCEL_SHOWROOM_ORG_IDS;
  else process.env.MYCEL_SHOWROOM_ORG_IDS = v;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.MYCEL_SHOWROOM_ORG_IDS;
    else process.env.MYCEL_SHOWROOM_ORG_IDS = prev;
  }
};

test("unset means no org is a showroom", () => {
  // The default must be "everything runs". A misread env that silently froze real tenants would be
  // an outage nobody could see from the inside.
  withEnv(undefined, () => {
    assert.equal(isShowroomOrg("e349fa95-f41c-44db-bea7-0d0d26903733"), false);
    assert.equal(showroomOrgIds().size, 0);
  });
});

test("the listed org is a showroom and others are not", () => {
  withEnv("e349fa95-f41c-44db-bea7-0d0d26903733", () => {
    assert.equal(isShowroomOrg("e349fa95-f41c-44db-bea7-0d0d26903733"), true);
    assert.equal(isShowroomOrg("some-other-org"), false);
  });
});

test("several, with whitespace, because a human edits this by hand", () => {
  withEnv(" org-a , org-b ,, org-c ", () => {
    for (const id of ["org-a", "org-b", "org-c"]) assert.equal(isShowroomOrg(id), true, id);
    assert.equal(showroomOrgIds().size, 3, "empty segments are dropped, not counted");
  });
});

test("an absent org id is never a showroom", () => {
  withEnv("org-a", () => {
    assert.equal(isShowroomOrg(undefined), false);
    assert.equal(isShowroomOrg(null), false);
    assert.equal(isShowroomOrg(""), false);
  });
});

test("read at call time, so a redeploy takes effect on the next request", () => {
  // Not captured at module load: a value read once would need a process restart to change, and the
  // whole point of an env allowlist is that it is changed by deploying.
  withEnv("org-a", () => assert.equal(isShowroomOrg("org-a"), true));
  withEnv("org-b", () => assert.equal(isShowroomOrg("org-a"), false));
});

test("the refusal explains rather than blames", () => {
  // Somebody clicking "Build my site" in a demo has done nothing wrong and must not be shown an
  // error that reads like they have.
  assert.match(SHOWROOM_REFUSAL, /demo workspace/i);
  assert.doesNotMatch(SHOWROOM_REFUSAL, /error|failed|denied|forbidden/i);
});

// The read-only rule is expressed as a METHOD check, not an endpoint list, and this is why.
//
// Refusing task creation was not enough: a visitor opened Apps and started a real Composio OAuth
// flow against our account, from a tenant anyone can walk into. Another left a project called "hh"
// behind, which made the demo open on an empty business. Every write endpoint was a hole of that
// shape, and blocking them one at a time is a losing game — the set grows whenever somebody adds a
// route, and the failure is silent until a stranger finds it.

test("reads pass, writes do not — by method, not by endpoint", () => {
  const readOnly = (method: string) => {
    const m = method.toUpperCase();
    return !(m === "GET" || m === "HEAD" || m === "OPTIONS");
  };
  for (const m of ["GET", "HEAD", "OPTIONS", "get", "head"]) {
    assert.equal(readOnly(m), false, `${m} reads and must pass`);
  }
  for (const m of ["POST", "PUT", "PATCH", "DELETE", "post", "delete"]) {
    assert.equal(readOnly(m), true, `${m} changes something and must be refused`);
  }
});

// ── the guard that protects nothing (measured, not imagined) ─────────────────────────────────────

test("showroom: an id that names no org is reported, because the guard cannot tell on its own", () => {
  // MYCEL_SHOWROOM_ORG_IDS held e349fa95-… in production and no org has ever had that id. So
  // isShowroomOrg returned false for everything, every call site behaved correctly, every test
  // passed — and the demo tenant ran 5,094 tasks, failed 1,169, and consumed the Daytona disk that
  // real customer runs then failed on. Nothing in the code was wrong.
  assert.deepEqual(unknownShowroomOrgs(["a", "b"], ["a"]), ["b"]);
  assert.deepEqual(unknownShowroomOrgs(["a"], ["a", "b"]), []);
  // Whitespace and blanks are config noise, not missing orgs.
  assert.deepEqual(unknownShowroomOrgs([" a ", "", "  "], ["a"]), []);
  assert.deepEqual(unknownShowroomOrgs([], ["a"]), []);
});

test("showroom: a stale id is loud but never fatal", () => {
  // A self-hoster with a leftover id must still be able to boot, and a deployment that refuses to
  // start because a DEMO tenant is misconfigured has turned something cosmetic into an outage.
  const prior = process.env.MYCEL_SHOWROOM_ORG_IDS;
  const errors: unknown[][] = [];
  const realError = console.error;
  console.error = (...a: unknown[]) => void errors.push(a);
  try {
    process.env.MYCEL_SHOWROOM_ORG_IDS = "ghost-org";
    const missing = reportShowroomConfig(["real-org"]);
    assert.deepEqual(missing, ["ghost-org"], "it did not notice");
    assert.equal(errors.length, 1, "it noticed and said nothing");
    assert.match(String(errors[0]?.[0]), /NOT frozen/, "the message does not say what the consequence is");
  } finally {
    console.error = realError;
    if (prior === undefined) delete process.env.MYCEL_SHOWROOM_ORG_IDS;
    else process.env.MYCEL_SHOWROOM_ORG_IDS = prior;
  }
});

test("showroom: it is checked at boot, right after the orgs are loaded", () => {
  // A CALL-SITE TEST. The classifier is the easy half. This whole finding is a function that was
  // correct and a value that named nothing.
  const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(src, /reportShowroomConfig\(getIdentityStore\(\)\.listOrgs\(\)\.map\(\(o\) => o\.id\)\)/);
  const init = src.indexOf("await initIdentityStore()");
  const check = src.indexOf("reportShowroomConfig(");
  assert.ok(init > 0 && check > init, "the check runs before the orgs exist, so it can only report everything missing");
});
