// WHICH SITE A BUILD PUBLISHES — the question the deploy pipeline never asked.
//
// Everything downstream of a build was keyed by PROJECT: the Lambda name, the publish slug, and a
// unique index on `(project_id) WHERE status='live'`. A project is the AGENCY, so an agency with two
// clients could not host two sites — the second deploy overwrote the first one's Lambda, pointed the
// same hostname at it, and the database refused to record both as live.
//
// That was correct for the only build wedge that existed (`product-builder`, internal, one founder's
// own product) and fatal the moment web development became something an agency SELLS.

import { test } from "node:test";
import assert from "node:assert/strict";
import { isClientSite, siteFor } from "../src/site-identity";
import { assertDeployableSlug, functionName } from "../src/deploy";

const PROJECT = "b3f1c8a2-0000-4000-8000-000000000001";

test("no declaration means the founder's own product, at the agency's own address", () => {
  // The default that keeps every manifest written before sites existed publishing to exactly the
  // address it always has. If this changes, deployed apps move without anyone asking for it.
  for (const scope of [undefined, "project" as const]) {
    const s = siteFor({ scope, projectId: PROJECT, projectSlug: "ridgeline", caseId: "case-1" });
    assert.equal(s.site_id, PROJECT, "the site IS the project");
    assert.equal(s.slug, "ridgeline");
  }
});

test("a case-scoped wedge gets one address per engagement", () => {
  const a = siteFor({ scope: "case", projectId: PROJECT, projectSlug: "ridgeline", caseId: "case-a" });
  const b = siteFor({ scope: "case", projectId: PROJECT, projectSlug: "ridgeline", caseId: "case-b" });
  assert.notEqual(a.slug, b.slug, "two clients, two hostnames");
  assert.notEqual(a.site_id, b.site_id, "two clients, two Lambdas");
  assert.match(a.slug, /^ridgeline-[0-9a-f]{8}$/);
});

test("the site id is the case, never the slug", () => {
  // A slug is renameable and a resource key must not be. Renaming an agency would otherwise orphan
  // every Lambda it owns and silently create a second set alongside them.
  const s = siteFor({ scope: "case", projectId: PROJECT, projectSlug: "ridgeline", caseId: "case-a" });
  assert.equal(s.site_id, "case-a");
  const renamed = siteFor({ scope: "case", projectId: PROJECT, projectSlug: "ridgeline-studio", caseId: "case-a" });
  assert.equal(renamed.site_id, "case-a", "the resource key survives a rename");
  assert.notEqual(renamed.slug, s.slug, "only the address moves");
});

test("the same case always lands on the same address", () => {
  // Derived, not stored. A build that computed a different address on a retry would publish the
  // client's site to a second hostname and leave the one they were given serving an old version.
  const once = siteFor({ scope: "case", projectId: PROJECT, projectSlug: "ridgeline", caseId: "case-a" });
  const twice = siteFor({ scope: "case", projectId: PROJECT, projectSlug: "ridgeline", caseId: "case-a" });
  assert.deepEqual(once, twice);
});

test("a long agency name is truncated, and the hash never is", () => {
  // The hash is what makes an address unique; a shortened project slug is only less recognisable,
  // while a shortened hash starts colliding. Getting this backwards puts two clients on one site.
  const long = "a".repeat(200);
  const s = siteFor({ scope: "case", projectId: PROJECT, projectSlug: long, caseId: "case-a" });
  assert.ok(s.slug.length <= 63, `slug was ${s.slug.length}`);
  assert.match(s.slug, /-[0-9a-f]{8}$/, "the full hash survives");
  assert.doesNotThrow(() => assertDeployableSlug(s.slug), "and it is still a legal hostname label");
});

test("every generated address is a legal hostname, Lambda name and CloudFront alias", () => {
  // `assertDeployableSlug` is stricter than any one of those requires, because a slug becomes all
  // four — and a slug with a slash in it writes into another tenant's asset prefix.
  for (const caseId of ["case-a", "9f8e7d6c-1111-4222-8333-444455556666", "CASE_WITH_CAPS", "1"]) {
    const s = siteFor({ scope: "case", projectId: PROJECT, projectSlug: "ridgeline", caseId });
    assert.doesNotThrow(() => assertDeployableSlug(s.slug), `${caseId} → ${s.slug}`);
    assert.doesNotThrow(() => functionName(s.site_id), `${caseId} → function name`);
  }
});

test("a case-scoped run with no case falls back loudly rather than throwing", () => {
  // A build that already succeeded must not be failed by an addressing problem. Publishing to the
  // agency's main address is wrong, and it is VISIBLY wrong — somebody sees the wrong site at a
  // known URL — where throwing would refuse to publish work that exists.
  const s = siteFor({ scope: "case", projectId: PROJECT, projectSlug: "ridgeline", caseId: undefined });
  assert.equal(s.site_id, PROJECT);
  assert.equal(s.slug, "ridgeline");
});

test("isClientSite distinguishes the two, for the sentence a founder reads", () => {
  const own = siteFor({ scope: "project", projectId: PROJECT, projectSlug: "ridgeline" });
  const client = siteFor({ scope: "case", projectId: PROJECT, projectSlug: "ridgeline", caseId: "case-a" });
  assert.equal(isClientSite(own, PROJECT), false);
  assert.equal(isClientSite(client, PROJECT), true);
});

test("the function name still sits inside the IAM prefix, for a case-length id", () => {
  // `aws_iam_role_policy.tenant_deploy` scopes every Lambda action to `mycel-tenant-*`, so this
  // string is security-relevant rather than cosmetic. A UUID case id is 36 characters and the name
  // has 64 to work with.
  const uuid = "9f8e7d6c-1111-4222-8333-444455556666";
  const name = functionName(uuid);
  assert.ok(name.startsWith("mycel-tenant-"), name);
  assert.ok(name.length <= 64, `${name.length} characters`);
});

test("an id too long for a Lambda name is refused rather than truncated", () => {
  // Truncating would silently make two sites share one function, which is the exact bug this whole
  // change removes.
  assert.throws(() => functionName("x".repeat(60)), /over 64 characters/);
});

/**
 * The wedge that used all of it is gone.
 *
 * `site-builder` and `site-studio` were deleted on 6 September — zero runs between them, ever —
 * along with the onboarding steps that offered to design a visual identity and build the founder's
 * site. What remains here is the ADDRESSING: `functionName` and the per-case site identity, which
 * `product-builder` still uses and which is what stops one tenant's site overwriting another's.
 *
 * The test that lived here asserted `site-builder` declared `site: "case"` and shared
 * `product-builder`'s verify gates. It went with the wedge rather than being rewritten against the
 * survivor, because the thing it protected — two wedges' quality gates drifting apart — cannot
 * happen with one wedge.
 */
