// Per-tenant hosting: the deployment record, its tenant scoping, and the handoff to CodeBuild.
//
// Every test here names a specific way one tenant's application could have reached another tenant —
// or a way a deploy could have silently done nothing — because those are the two failure modes that
// matter for a feature whose whole job is to put a customer's app on a public URL.
import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryDomainStore } from "../src/domain";
import {
  assertDeployableSlug,
  deployUrl,
  functionName,
  reconcileDeployment,
  setDeployClient,
  sourceKey,
  startDeploy,
  startDeploymentReconciler,
  type DeployClient,
  type DeployConfig,
} from "../src/deploy";

const CFG: DeployConfig = {
  bucket: "mycel-tenant-builds",
  project: "mycel-tenant-deploy",
  appsDomain: "apps.mycelai.dev",
  region: "eu-west-2",
};

/** A DeployClient that records what it was asked to do and never touches a network. */
function fakeClient(opts: { status?: "succeeded" | "failed" | null; failPut?: boolean } = {}) {
  const calls = {
    puts: [] as { bucket: string; key: string; bytes: number }[],
    builds: [] as { project: string; env: Record<string, string> }[],
  };
  const client: DeployClient = {
    async putObject(bucket, key, body) {
      if (opts.failPut) throw new Error("s3 exploded");
      calls.puts.push({ bucket, key, bytes: body.byteLength });
    },
    async startBuild(project, env) {
      calls.builds.push({ project, env });
      return "build-123";
    },
    async buildStatus() {
      return opts.status ?? null;
    },
  };
  setDeployClient(client);
  return calls;
}

// ── Names ────────────────────────────────────────────────────────────────────

test("a slug with a slash cannot become a deploy target — it would address another tenant's assets", () => {
  // The slug ends up in an S3 key prefix. `a/../b` or `a/b` would write the app into a path the
  // pipeline reserved for a different project, which is a cross-tenant overwrite of a live site.
  assert.throws(() => assertDeployableSlug("acme/evil"), /not a valid hostname label/);
  assert.throws(() => assertDeployableSlug("../etc"), /not a valid hostname label/);
  assert.throws(() => assertDeployableSlug("a b"), /not a valid hostname label/);
});

test("a slug with a dot is refused — the wildcard certificate does not cover a second label", () => {
  // `*.apps.mycelai.dev` matches exactly one label, so `a.b.apps.mycelai.dev` fails as a TLS error
  // rather than a 404 — the least diagnosable possible failure for a customer's brand-new site.
  assert.throws(() => assertDeployableSlug("a.b"), /not a valid hostname label/);
});

test("slugs are normalised to lower case, because DNS is case-insensitive and S3 keys are not", () => {
  // A mixed-case slug resolves fine in DNS and then misses the asset prefix the pipeline wrote,
  // producing a site that renders with no CSS and no obvious cause.
  assert.equal(assertDeployableSlug("Acme"), "acme");
  assert.equal(assertDeployableSlug("  ACME  "), "acme");
});

test("hostname labels cannot lead or trail with a hyphen, and cannot exceed 63 characters", () => {
  assert.throws(() => assertDeployableSlug("-acme"), /not a valid hostname label/);
  assert.throws(() => assertDeployableSlug("acme-"), /not a valid hostname label/);
  assert.throws(() => assertDeployableSlug("a".repeat(64)), /longer than a DNS label/);
  assert.equal(assertDeployableSlug("a".repeat(63)).length, 63);
});

test("reserved names cannot be claimed by a tenant app", () => {
  // `api.apps.mycelai.dev` handed to a customer is a name the platform can never take back.
  for (const s of ["www", "api", "admin", "kernel", "sandbox"]) {
    assert.throws(() => assertDeployableSlug(s), /reserved/, `"${s}" must be reserved`);
  }
});

test("an empty slug is a refusal, not a deploy to the apex", () => {
  // The failure this prevents: `"" + "." + appsDomain` → `.apps.mycelai.dev`, or worse, a tenant
  // app answering on the namespace apex.
  assert.throws(() => assertDeployableSlug(""), /no slug/);
  assert.throws(() => assertDeployableSlug("   "), /no slug/);
});

test("the source key is addressed by project and deployment, never by the renameable slug", () => {
  // A build input addressed by a mutable name is a build that can be pointed at the wrong source by
  // renaming something. Two deploys of one project must also never share a key.
  assert.equal(sourceKey("proj-1", "dep-a"), "proj-1/dep-a/workspace.tar.gz");
  assert.notEqual(sourceKey("proj-1", "dep-a"), sourceKey("proj-1", "dep-b"));
});

test("the Lambda name keeps the prefix that IAM scopes on", () => {
  // `aws_iam_role_policy.tenant_deploy` scopes every Lambda action to `mycel-tenant-*`. If this
  // ever stopped emitting that prefix the deploy role would lose access — but a rename in the other
  // direction (dropping the prefix from the policy) would silently widen it to the kernel's own
  // functions, so the string is asserted here rather than trusted.
  assert.equal(functionName("proj-1"), "mycel-tenant-proj-1");
  assert.throws(() => functionName("p".repeat(80)), /over 64 characters/);
});

test("the URL is https and sits under the apps namespace, not the portal wildcard", () => {
  // `*.mycelai.dev` already points at the ALB for the shared business portal. A tenant app URL that
  // landed there would serve the wrong application entirely.
  assert.equal(deployUrl("acme", "apps.mycelai.dev"), "https://acme.apps.mycelai.dev");
});

// ── The handoff ──────────────────────────────────────────────────────────────

test("startDeploy refuses a task with no project rather than deploying it somewhere", async () => {
  // An unattributed task must deploy nowhere. The alternative — picking a default project — is how
  // one tenant's build reaches another's hostname.
  const d = new InMemoryDomainStore();
  await assert.rejects(
    () => startDeploy(d, { projectId: "", slug: "acme", base64: "" }, CFG),
    /no project/,
  );
});

test("nothing the pipeline is told about a tenant comes from the tarball", async () => {
  // THE cross-tenant bug this whole design is arranged to prevent: if PROJECT_ID or TENANT_SLUG
  // could be influenced by the archive an agent wrote, one tenant's run could publish over another
  // tenant's site. Every value handed to CodeBuild must come from the kernel's own database.
  const calls = fakeClient();
  const d = new InMemoryDomainStore();
  const dep = await startDeploy(d, { projectId: "proj-1", slug: "acme", taskId: "task-9", base64: "" }, CFG);

  assert.equal(calls.builds.length, 1);
  const env = calls.builds[0].env;
  assert.equal(env.PROJECT_ID, "proj-1");
  assert.equal(env.TENANT_SLUG, "acme");
  assert.equal(env.DEPLOYMENT_ID, dep.id);
  assert.equal(env.SOURCE_KEY, sourceKey("proj-1", dep.id));
  // The key it uploaded and the key it told the build to read must be the same one; a mismatch
  // means the build silently rebuilds whatever was at that path before.
  assert.equal(calls.puts[0].key, env.SOURCE_KEY);
  assert.equal(calls.puts[0].bucket, CFG.bucket);
  setDeployClient(null);
});

test("a deployment row exists BEFORE the upload, so a crash mid-deploy leaves evidence", async () => {
  // The failure: the upload or StartBuild throws, no row was ever written, and the customer asks
  // why nothing happened with nobody able to answer. The row must survive the failure, marked.
  fakeClient({ failPut: true });
  const d = new InMemoryDomainStore();
  await assert.rejects(
    () => startDeploy(d, { projectId: "proj-1", slug: "acme", base64: "" }, CFG),
    /could not start the build/,
  );
  const rows = await d.listDeployments({ project_id: "proj-1" });
  assert.equal(rows.length, 1, "the attempt must be recorded even though it failed");
  assert.equal(rows[0].status, "failed");
  assert.match(rows[0].error ?? "", /s3 exploded/, "the reason must survive, not just the status");
  setDeployClient(null);
});

test("a successful handoff records the build id — the only handle that leads to the log", async () => {
  fakeClient();
  const d = new InMemoryDomainStore();
  const dep = await startDeploy(d, { projectId: "proj-1", slug: "acme", base64: "" }, CFG);
  assert.equal(dep.status, "building");
  assert.equal(dep.build_id, "build-123");
  assert.equal(dep.url, "https://acme.apps.mycelai.dev");
  setDeployClient(null);
});

test("listInFlightDeployments returns building/queued across projects and never live ones", async () => {
  const d = new InMemoryDomainStore();
  await d.createDeployment({ project_id: "a", slug: "a", url: "u", status: "building", build_id: "b1" });
  await d.createDeployment({ project_id: "b", slug: "b", url: "u", status: "queued", build_id: "b2" });
  await d.createDeployment({ project_id: "a", slug: "a", url: "u", status: "live" });
  await d.createDeployment({ project_id: "c", slug: "c", url: "u", status: "failed", error: "x" });
  const inflight = await d.listInFlightDeployments();
  assert.equal(inflight.length, 2);
  assert.ok(inflight.every((x) => x.status === "building" || x.status === "queued"));
  assert.ok(!inflight.some((x) => x.status === "live" || x.status === "failed"));
});

test("the reconciler tick marks a succeeded build live — the missing production call", async () => {
  // `reconcileDeployment` was unit-tested and never called from a loop. This is the loop.
  fakeClient({ status: "succeeded" });
  const d = new InMemoryDomainStore();
  const dep = await startDeploy(d, { projectId: "proj-1", slug: "acme", base64: "" }, CFG);
  assert.equal(dep.status, "building");

  // Force deployConfig by setting env the reconciler reads.
  const prev = {
    bucket: process.env.MYCEL_DEPLOY_BUCKET,
    project: process.env.MYCEL_DEPLOY_PROJECT,
    domain: process.env.MYCEL_APPS_DOMAIN,
  };
  process.env.MYCEL_DEPLOY_BUCKET = CFG.bucket;
  process.env.MYCEL_DEPLOY_PROJECT = CFG.project;
  process.env.MYCEL_APPS_DOMAIN = CFG.appsDomain;

  const r = startDeploymentReconciler(d, 60_000);
  try {
    const n = await r.tick();
    assert.equal(n, 1);
    assert.equal((await d.getDeployment(dep.id, "proj-1"))?.status, "live");
  } finally {
    r.stop();
    if (prev.bucket === undefined) delete process.env.MYCEL_DEPLOY_BUCKET;
    else process.env.MYCEL_DEPLOY_BUCKET = prev.bucket;
    if (prev.project === undefined) delete process.env.MYCEL_DEPLOY_PROJECT;
    else process.env.MYCEL_DEPLOY_PROJECT = prev.project;
    if (prev.domain === undefined) delete process.env.MYCEL_APPS_DOMAIN;
    else process.env.MYCEL_APPS_DOMAIN = prev.domain;
    setDeployClient(null);
  }
});

// ── Reconciliation ───────────────────────────────────────────────────────────

test("a project never has two live deployments — going live supersedes the previous one", async () => {
  // "What is my URL" having several answers is how a customer gets shown a URL a later deploy
  // replaced. The supersede must also run BEFORE the new row is marked live, because the Postgres
  // partial unique index rejects the other order.
  const d = new InMemoryDomainStore();
  fakeClient({ status: "succeeded" });

  const first = await startDeploy(d, { projectId: "proj-1", slug: "acme", base64: "" }, CFG);
  await reconcileDeployment(d, first, CFG);
  const second = await startDeploy(d, { projectId: "proj-1", slug: "acme", base64: "" }, CFG);
  await reconcileDeployment(d, second, CFG);

  const live = await d.listDeployments({ project_id: "proj-1", status: "live" });
  assert.equal(live.length, 1, "exactly one live deployment per project");
  assert.equal(live[0].id, second.id, "the newest one wins");
  assert.equal((await d.getDeployment(first.id, "proj-1"))?.status, "superseded");
  setDeployClient(null);
});

test("superseding never rewrites a failed deployment — that would erase the evidence", async () => {
  // A `failed` row is the record that a deploy broke. Marking it `superseded` when a later one
  // succeeds destroys the only trace that anything went wrong.
  const d = new InMemoryDomainStore();
  const failed = await d.createDeployment({
    project_id: "proj-1", slug: "acme", url: "u", status: "failed", error: "boom",
  });
  const live = await d.createDeployment({ project_id: "proj-1", slug: "acme", url: "u", status: "live" });
  await d.supersedeDeployments("proj-1", live.id);
  assert.equal((await d.getDeployment(failed.id, "proj-1"))?.status, "failed");
  assert.equal((await d.getDeployment(failed.id, "proj-1"))?.error, "boom");
});

test("a still-running build leaves the row alone rather than guessing", async () => {
  fakeClient({ status: null });
  const d = new InMemoryDomainStore();
  const dep = await startDeploy(d, { projectId: "proj-1", slug: "acme", base64: "" }, CFG);
  const after = await reconcileDeployment(d, dep, CFG);
  assert.equal(after.status, "building", "an unfinished build must not be reported as live or failed");
  setDeployClient(null);
});

test("a failed build marks the row failed and does not supersede what is already live", async () => {
  // A broken deploy must not take down the working site by demoting it.
  const d = new InMemoryDomainStore();
  const good = await d.createDeployment({ project_id: "proj-1", slug: "acme", url: "u", status: "live" });
  fakeClient({ status: "failed" });
  const bad = await startDeploy(d, { projectId: "proj-1", slug: "acme", base64: "" }, CFG);
  await reconcileDeployment(d, bad, CFG);
  assert.equal((await d.getDeployment(bad.id, "proj-1"))?.status, "failed");
  assert.equal((await d.getDeployment(good.id, "proj-1"))?.status, "live", "the working site stays live");
  setDeployClient(null);
});

// ── Tenant scoping on the store ──────────────────────────────────────────────

async function twoTenants() {
  const d = new InMemoryDomainStore();
  const a = await d.createDeployment({ project_id: "A", slug: "a-co", url: "https://a-co.apps.x", status: "live" });
  const b = await d.createDeployment({ project_id: "B", slug: "b-co", url: "https://b-co.apps.x", status: "live" });
  return { d, a, b };
}

test("getDeployment takes the project as an ARGUMENT — a guessed uuid from another tenant is a miss", async () => {
  // Fetch-then-compare is one forgotten `if` away from disclosing another tenant's URL, build id
  // and build error. The project is in the lookup, not in a check afterwards.
  const { d, a } = await twoTenants();
  assert.ok(await d.getDeployment(a.id, "A"));
  assert.equal(await d.getDeployment(a.id, "B"), undefined, "B must not read A's deployment");
  assert.equal(await d.getDeployment(a.id, ""), undefined, "an empty project reads nothing");
});

test("listDeployments with an empty project returns nothing, not everything", async () => {
  // The classic shape of this codebase's past cross-tenant leak: an unset filter meaning "no
  // filter". Here it must mean "no rows".
  const { d } = await twoTenants();
  assert.equal((await d.listDeployments({ project_id: "" })).length, 0);
  assert.equal((await d.listDeployments({ project_id: "A" })).length, 1);
  assert.equal((await d.listDeployments({ project_id: "C" })).length, 0);
});

test("updateDeployment cannot be aimed at another tenant's row", async () => {
  // Without the project in the WHERE clause, any caller could mark any tenant's app failed.
  const { d, a } = await twoTenants();
  assert.equal(await d.updateDeployment(a.id, "B", { status: "failed" }), undefined);
  assert.equal((await d.getDeployment(a.id, "A"))?.status, "live", "A's deployment is untouched");
});

test("a patch that omits a field leaves it alone instead of erasing it", async () => {
  // The bug `defined()` exists for, in a new place: a reconciler that reports a status without a
  // build id would otherwise wipe the only handle that leads to the log explaining the failure it
  // just recorded. The Postgres store uses COALESCE for the same reason; the two must agree.
  const { d, a } = await twoTenants();
  await d.updateDeployment(a.id, "A", { build_id: "b-1" });
  await d.updateDeployment(a.id, "A", { status: "failed" });
  const row = await d.getDeployment(a.id, "A");
  assert.equal(row?.status, "failed");
  assert.equal(row?.build_id, "b-1", "the build id must survive a status-only patch");
});

test("a deployment cannot be created without a project", async () => {
  // A live URL with no owner is one nobody can be shown and nobody can revoke.
  const d = new InMemoryDomainStore();
  await assert.rejects(
    () => d.createDeployment({ project_id: "", slug: "x", url: "u", status: "queued" }),
    /requires a project_id/,
  );
});

// ── The read routes ──────────────────────────────────────────────────────────

test("the deployment routes never serve one tenant's URL to another tenant's key", async () => {
  // The route-level half of the scoping above. A product key is fixed to one project, so this is
  // the exact shape a compromised or curious founder would try: read a deployment id belonging to
  // someone else. It must be indistinguishable from a row that does not exist.
  const { app } = await import("./helpers").then((h) => h.makeApp());
  const { api, KEY } = await import("./helpers");
  const { getDomainStore } = await import("../src/domain");

  const login = await app.request("/v1/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: process.env.MYCEL_OWNER_EMAIL || "owner@test.co",
      password: process.env.MYCEL_OWNER_PASSWORD || "secret",
    }),
  });
  const tok = (await login.json()).token as string;
  const me = await api(app, "me", {}, tok);
  const projectA = me.json.projects[0].id;

  const pb = await api(app, "projects", { method: "POST", body: JSON.stringify({ name: "deploy-b" }) }, tok);
  const keyB = pb.json.api_key as string;
  const projectB = pb.json.project.id as string;

  const domain = getDomainStore();
  const depA = await domain.createDeployment({ project_id: projectA, slug: "a-co", url: "https://a-co.apps.x", status: "live" });
  const depB = await domain.createDeployment({ project_id: projectB, slug: "b-co", url: "https://b-co.apps.x", status: "live" });

  // Key A (the default KEY) is fixed to project A.
  assert.deepEqual((await api(app, "deployments", {}, KEY)).json.map((d: any) => d.id), [depA.id]);
  assert.deepEqual((await api(app, "deployments", {}, keyB)).json.map((d: any) => d.id), [depB.id]);

  // Cross-access by id is a 404, not a 403 — an unauthorised reader learns nothing about whether
  // the row exists at all.
  assert.equal((await api(app, `deployments/${depB.id}`, {}, KEY)).status, 404);
  assert.equal((await api(app, `deployments/${depA.id}`, {}, keyB)).status, 404);

  // `current` is the route a console calls on every page load, so it gets its own check.
  assert.equal((await api(app, "deployments/current", {}, KEY)).json.id, depA.id);
  assert.equal((await api(app, "deployments/current", {}, keyB)).json.id, depB.id);
});

test("deployments/current is a 404 when nothing is live, not an empty object", async () => {
  // "Not deployed yet" and "deployed, but I cannot tell you where" must not look the same.
  //
  // Scoped to a project created here rather than to the default key: the domain store is a
  // process-wide singleton (see the note on `makeFreshApp` in helpers.ts), so the rows the previous
  // test wrote are still visible to `KEY`. Asserting "nothing is live" against shared state is the
  // order-dependent test this file would otherwise have shipped.
  const { makeApp, api } = await import("./helpers");
  const { app } = makeApp();
  const login = await app.request("/v1/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: process.env.MYCEL_OWNER_EMAIL || "owner@test.co",
      password: process.env.MYCEL_OWNER_PASSWORD || "secret",
    }),
  });
  const tok = (await login.json()).token as string;
  const fresh = await api(app, "projects", { method: "POST", body: JSON.stringify({ name: "never-deployed" }) }, tok);
  const freshKey = fresh.json.api_key as string;

  assert.equal((await api(app, "deployments/current", {}, freshKey)).status, 404);
  assert.deepEqual((await api(app, "deployments", {}, freshKey)).json, []);
});

// ── The pre-flight check must not become a dependency on S3 ──────────────────

test("a wedge that declares a workspace still runs in mock mode without an object store", async () => {
  // `product-builder` is the wedge whose deliverable is a directory, so it is the one that declares
  // `workspace` in wedge.json — and the one the pre-flight `assertExportableBackend` check refuses
  // when MYCEL_ARTIFACTS is unset. Gating that check on `!useMock` is what keeps it honest: a mock
  // run has no sandbox and produces no tarball, so requiring an object store from it made every
  // product-builder task fail on a developer's machine and across this whole suite. That is not
  // hypothetical — it is what the first draft of the check did.
  const { makeApp, api, waitTask } = await import("./helpers");
  const { app } = makeApp();
  const r = await api(app, "tasks", {
    method: "POST",
    body: JSON.stringify({ wedge: "product-builder", task_type: "build_feature", input: { goal: "a landing page" } }),
  });
  assert.equal(r.status, 201);
  const t = await waitTask(app, r.json.id);
  assert.equal(t.status, "succeeded", `product-builder must still run in mock: ${t.error ?? ""}`);
});
