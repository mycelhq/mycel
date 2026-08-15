// Derived per-project credentials, and the bug they were written for.
//
// THE BUG: `hostLookup` in `business-template/lib/kernel.ts` read `MYCEL_API_KEY`, and nothing ever
// set it on a hosted tenant — neither `deploy.ts` nor `infra/buildspec.tenant.yml` wrote one into the
// Lambda's environment. So in production the lookup returned null on every request, `businessBrand()`
// fell through to `SOLO_BRAND`, and every hosted site rendered the hardcoded "Your business" and the
// default green. A founder's BrandKit — which the kernel computes and serves on this exact route —
// reached development and self-hosted installs only.
//
// The tempting fix was to put the product key in the buildspec. That key starts tasks and reads every
// client in the estate, and the runtime it would sit in is public-facing and was written by a model.
// So the fix is a credential whose whole authority is "the public face of ONE project", and the tests
// below are about the two things that make that sentence true rather than aspirational: a key cannot
// be repurposed, and it cannot answer for a project other than its own.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { api, makeApp, KEY } from "./helpers";
import { getIdentityStore } from "../src/identity";
import { brandKeyFor, projectForBrandKey } from "../src/scopedkeys";
import { ingestKeyFor, projectForIngestKey } from "../src/insight/keys";

const PW = "a-long-enough-password";

test("a brand key resolves its own project, and nothing else does", () => {
  const project = randomUUID();
  const other = randomUUID();

  // Deterministic: there is nothing stored, so minting twice is the same key and a cold replica can
  // verify one with no database.
  assert.equal(brandKeyFor(project), brandKeyFor(project));
  assert.equal(projectForBrandKey(brandKeyFor(project)), project);
  assert.notEqual(brandKeyFor(project), brandKeyFor(other));

  // THE BUG THIS PREVENTS: a key that is valid for a purpose it was never minted for. An ingest key
  // is deliberately cheap to obtain — `GET /v1/insight/key` hands it out to any founder, and it gets
  // pasted into hosting dashboards — so if it also verified as a branding key, the "entire authority
  // is append events to one project" promise in insight/keys.ts would quietly have become false. The
  // separation is in the SIGNED material (a per-purpose label), not merely in the prefix.
  assert.equal(projectForBrandKey(ingestKeyFor(project)), undefined, "an ingest key must not read branding");
  assert.equal(projectForIngestKey(brandKeyFor(project)), undefined, "a brand key must not write events");

  // Forgery, truncation, and a swapped body. The project id comes out of the SIGNATURE or the key is
  // refused; there is no branch anywhere that reads a project id the caller supplied.
  const good = brandKeyFor(project);
  assert.equal(projectForBrandKey(undefined), undefined);
  assert.equal(projectForBrandKey(""), undefined);
  assert.equal(projectForBrandKey(good.slice(0, -1)), undefined);
  assert.equal(projectForBrandKey(`mbk_${Buffer.from(other).toString("base64url")}_${good.split("_").pop()}`), undefined);
  assert.equal(projectForBrandKey(KEY), undefined, "the product key is not a brand key");
});

test("a brand key cannot read another tenant's branding, and cannot tell it exists", async () => {
  // THE BUG: shipping a credential that is a shared host-token with extra steps. Without the
  // host-versus-key cross-check in `GET /v1/host/:host`, a compromised tenant Lambda could walk
  // `acme.mycelai.dev`, `globex.mycelai.dev`, … and read every founder's brand — which is exactly
  // the cross-tenant reach `infra/portal.tf` refused to publish this route for.
  const { app } = makeApp();
  const id = getIdentityStore();
  const { org } = id.createOrgWithOwner("brand-co", `brand-${Date.now()}@example.com`, PW);
  const mine = id.createProject(org.id, `Mine ${Date.now()}`).project;
  const theirs = id.createProject(org.id, `Theirs ${Date.now()}`).project;

  const myKey = brandKeyFor(mine.id);

  // My own host, my own key: answered, and it carries the brand kit rather than the env fallback the
  // production path was silently using.
  const ok = await api(app, `host/${mine.slug}.mycelai.dev`, {}, myKey);
  assert.equal(ok.status, 200, "a tenant must be able to read its own branding");
  assert.equal(ok.json.slug, mine.slug);
  assert.ok(ok.json.brand_kit, "the BrandKit is what this whole path exists to deliver");
  // And the project id is NOT in the response. A per-tenant runtime has no use for it, and handing
  // one to a public-facing surface invites somebody to try using it.
  assert.ok(!JSON.stringify(ok.json).includes(mine.id));

  // Their host, my key: 404 — and 404 rather than 403 on purpose, so a probe cannot distinguish
  // "that belongs to someone else" from "that does not exist".
  const cross = await api(app, `host/${theirs.slug}.mycelai.dev`, {}, myKey);
  assert.equal(cross.status, 404);
  assert.ok(!JSON.stringify(cross.json).includes(theirs.slug), "the refusal must reveal nothing");

  // A host nobody serves gets the identical answer, which is the property that makes the one above
  // worth anything.
  const nowhere = await api(app, `host/not-a-tenant-at-all.mycelai.dev`, {}, myKey);
  assert.equal(nowhere.status, 404);
  assert.deepEqual(cross.json, nowhere.json);

  // An ingest key for the SAME project is still refused: purpose separation survives the route. It
  // is refused by the product-key MIDDLEWARE with a 401 rather than by the handler with a 403,
  // because the middleware's bypass is conditional on a brand key actually verifying — which is the
  // stricter of the two orderings and the one worth pinning.
  const wrongPurpose = await api(app, `host/${mine.slug}.mycelai.dev`, {}, ingestKeyFor(mine.id));
  assert.equal(wrongPurpose.status, 401);
  assert.ok(!JSON.stringify(wrongPurpose.json ?? {}).includes(mine.slug));
});

const here = (p: string) => new URL(p, import.meta.url);

// `infra/` and `business-template/` are monorepo siblings that are deliberately NOT published:
// `scripts/publish-oss.sh` ships `kernel`, `portal` and `create-mycel-app` and nothing else, and
// `infra/` in particular names our AWS estate and must never go public. So the half of this check
// that reads them can only run in the monorepo. It SKIPS in a published checkout rather than
// failing, because a red suite in the repo a stranger clones is the most expensive possible failure
// and "I could not see the deployment files" is a different fact from "the wiring is wrong".
//
// The kernel's OWN half is split out below and always runs, in both trees — that is the assertion
// with the security content (the product key must never travel the deploy path), and it would have
// been silently lost in the public tree had the whole test been gated on files it does not need.
const CROSS_REPO = ["../../../infra/buildspec.tenant.yml", "../../../infra/portal.tf", "../../../business-template/lib/kernel.ts"];
const monorepoOnly = {
  skip: CROSS_REPO.every((p) => existsSync(here(p)))
    ? false
    : "infra/ and business-template/ are not in this tree (published kernel) — monorepo-only deployment-wiring check",
};

test("the deploy path mints the scoped key and never carries the product key", async () => {
  // THE BUG, AS IT ACTUALLY SHIPPED: the credential existing in the kernel and never reaching the
  // runtime that needs it. That is what happened for `MYCEL_API_KEY` — the code read it, no
  // deployment path ever wrote it, and nothing failed loudly enough for anyone to notice for weeks.
  const { readFile } = await import("node:fs/promises");

  const deploy = await readFile(here("../src/deploy.ts"), "utf8");
  assert.match(deploy, /MYCEL_BRAND_KEY: brandKeyFor\(req\.projectId\)/, "deploy.ts must mint it");
  // From the kernel's own row and nothing else. A key derived from anything the tarball could
  // influence would let one tenant's build read another tenant's brand.
  // As an ENV KEY, not as a word: the file discusses `MYCEL_API_KEY` at length in the comment that
  // explains why it is not here, and a bare word match would fail on the explanation.
  assert.doesNotMatch(deploy, /MYCEL_API_KEY\s*:/, "the product key must never travel the deploy path");
});

test("the tenant Lambda is actually given the key, and it is not the product key", monorepoOnly, async () => {
  // The other end of the same wire: the deployment files that carry what `deploy.ts` mints.
  const { readFile } = await import("node:fs/promises");

  const buildspec = await readFile(here("../../../infra/buildspec.tenant.yml"), "utf8");
  assert.match(buildspec, /MYCEL_BRAND_KEY: process\.env\.MYCEL_BRAND_KEY/, "the buildspec must write it into the Lambda env");
  assert.doesNotMatch(buildspec, /NEXT_PUBLIC_MYCEL_BRAND_KEY/, "a key in the client bundle is a key every visitor has");

  const template = await readFile(here("../../../business-template/lib/kernel.ts"), "utf8");
  // Preferred over both broader credentials, so a runtime that happens to hold one still uses the
  // narrow one.
  assert.match(
    template,
    /MYCEL_BRAND_KEY \|\| process\.env\.MYCEL_HOST_TOKEN \|\| process\.env\.MYCEL_API_KEY/,
    "hostLookup must prefer the scoped key",
  );

  // And the route the Lambda calls is reachable: `infra/portal.tf` default-denies everything on
  // portal.<domain> that no rule names, and this route was deliberately unpublished for years.
  const portal = await readFile(here("../../../infra/portal.tf"), "utf8");
  assert.match(portal, /"\/v1\/host\/\*"/, "publishing the route is half the fix; without it the key is dead");
});
