// A BUILT SITE WAITS FOR A PERSON.
//
// Every other thing this product produces is held for a human signature before anybody outside the
// business sees it. The founder's own homepage was the exception: a finished `build_feature` run
// called `startDeploy` on its way out, CloudFront invalidated, and a stranger was reading a new
// version of somebody's front door — no step between a model deciding it was done and the public.
//
// `takeability` in `moves.ts` refuses to offer a "build my site" button BECAUSE of that, in as many
// words: such a button "would not be 'start work', it would be 'publish a new homepage', and it
// would look identical to the button next to it that only drafts an email". It names the fix as an
// approval gate on the deploy. These tests are that gate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryDomainStore } from "../src/domain";
import {
  discardDeploy,
  proposeDeploy,
  publishDeploy,
  setDeployClient,
  sourceKey,
  type DeployClient,
  type DeployConfig,
} from "../src/deploy";

const CFG: DeployConfig = {
  bucket: "mycel-tenant-builds",
  project: "mycel-tenant-deploy",
  appsDomain: "apps.mycelai.dev",
  region: "eu-west-2",
};

function fakeClient(opts: { failPut?: boolean } = {}) {
  const calls = {
    puts: [] as { bucket: string; key: string; bytes: number }[],
    builds: [] as { project: string; env: Record<string, string> }[],
  };
  const client: DeployClient = {
    async putObject(bucket, key, body) {
      if (opts.failPut) throw new Error("s3 exploded");
      calls.puts.push({ bucket, key, bytes: body.length });
    },
    async startBuild(project, env) {
      calls.builds.push({ project, env });
      return "build-123";
    },
    async buildStatus() {
      return null;
    },
  };
  setDeployClient(client);
  return calls;
}

const REQ = { projectId: "proj-1", slug: "acme", taskId: "task-9", base64: "" };

test("a proposed deploy asks CodeBuild for nothing at all", async () => {
  // The whole gate in one assertion. A build finishing must not start a deploy.
  const calls = fakeClient();
  const d = new InMemoryDomainStore();

  const dep = await proposeDeploy(d, REQ, CFG);

  assert.equal(dep.status, "awaiting_review");
  assert.equal(calls.builds.length, 0, "no build may be started before a person answers");
  setDeployClient(null);
});

test("the bytes are stored while the run still holds them", async () => {
  /**
   * The upload happens at PROPOSE time, not at publish time, and it has to: the sandbox that built
   * these files is destroyed minutes after the run ends, so they cannot be fetched later. A gate that
   * waited until approval to collect the bytes would be a gate that could never publish anything.
   */
  const calls = fakeClient();
  const d = new InMemoryDomainStore();

  const dep = await proposeDeploy(d, REQ, CFG);

  assert.equal(calls.puts.length, 1, "the tarball must be in S3 before anybody is asked");
  assert.equal(calls.puts[0].bucket, CFG.bucket);
  assert.equal(calls.puts[0].key, sourceKey("proj-1", dep.id));
  // And recorded, or publish has no idea what to build.
  assert.equal(dep.source_key, sourceKey("proj-1", dep.id));
  setDeployClient(null);
});

test("publishing builds exactly the bytes the reviewer was shown", async () => {
  const calls = fakeClient();
  const d = new InMemoryDomainStore();

  const proposed = await proposeDeploy(d, REQ, CFG);
  const published = await publishDeploy(d, proposed.id, "proj-1", CFG);

  assert.equal(published?.status, "building");
  assert.equal(published?.build_id, "build-123");
  assert.equal(calls.builds.length, 1);
  // The key uploaded and the key handed to the build are the same one. A mismatch means the build
  // silently publishes whatever happened to be at that path.
  assert.equal(calls.builds[0].env.SOURCE_KEY, calls.puts[0].key);
  setDeployClient(null);
});

test("nothing the build is told comes from the approving request", async () => {
  /**
   * The cross-tenant property, restated for the new shape. `publishDeploy` takes only a deployment id
   * and a project, and reads the project, the site and the slug back off the ROW — so there is no
   * parameter a caller could use to aim one tenant's tarball at another tenant's address. This is
   * why it is not a `DeployRequest`.
   */
  const calls = fakeClient();
  const d = new InMemoryDomainStore();

  const proposed = await proposeDeploy(d, REQ, CFG);
  await publishDeploy(d, proposed.id, "proj-1", CFG);

  const env = calls.builds[0].env;
  assert.equal(env.PROJECT_ID, "proj-1");
  assert.equal(env.TENANT_SLUG, "acme");
  assert.equal(env.DEPLOYMENT_ID, proposed.id);
  setDeployClient(null);
});

test("a discard builds nothing and is not recorded as a failure", async () => {
  const calls = fakeClient();
  const d = new InMemoryDomainStore();

  const proposed = await proposeDeploy(d, REQ, CFG);
  const discarded = await discardDeploy(d, proposed.id, "proj-1", "the headline is wrong");

  assert.equal(discarded?.status, "discarded");
  assert.equal(calls.builds.length, 0, "a refusal must not spend CodeBuild minutes");
  // `discarded`, never `failed`. Nothing broke. A founder's refusal appearing in the record as an
  // engineering fault would make the failure rate a measure of their taste.
  assert.notEqual(discarded?.status, "failed");
  assert.match(discarded?.error ?? "", /headline/);
  setDeployClient(null);
});

test("a second answer cannot overturn the first", async () => {
  // Two tabs, or a double click. The second must find a row that has moved on.
  fakeClient();
  const d = new InMemoryDomainStore();

  const proposed = await proposeDeploy(d, REQ, CFG);
  await publishDeploy(d, proposed.id, "proj-1", CFG);

  assert.equal(await publishDeploy(d, proposed.id, "proj-1", CFG), undefined, "no second build");
  assert.equal(await discardDeploy(d, proposed.id, "proj-1"), undefined, "a live site cannot be discarded");
  setDeployClient(null);
});

test("a discarded deploy cannot be published afterwards", async () => {
  const calls = fakeClient();
  const d = new InMemoryDomainStore();

  const proposed = await proposeDeploy(d, REQ, CFG);
  await discardDeploy(d, proposed.id, "proj-1");

  assert.equal(await publishDeploy(d, proposed.id, "proj-1", CFG), undefined);
  assert.equal(calls.builds.length, 0, "a refusal must not be overturned by a stale click");
  setDeployClient(null);
});

test("another tenant cannot publish this deploy", async () => {
  /**
   * The project is an ARGUMENT to the fetch, not a check on what came back. Fetch-then-compare is
   * one forgotten `if` away from letting whoever guessed a uuid publish over somebody else's domain,
   * and this is the one action in the product that makes a page public.
   */
  const calls = fakeClient();
  const d = new InMemoryDomainStore();

  const proposed = await proposeDeploy(d, REQ, CFG);

  assert.equal(await publishDeploy(d, proposed.id, "proj-2", CFG), undefined);
  assert.equal(await discardDeploy(d, proposed.id, "proj-2"), undefined);
  assert.equal(calls.builds.length, 0);
  // And it is still there for its real owner.
  assert.equal((await d.getDeployment(proposed.id, "proj-1"))?.status, "awaiting_review");
  setDeployClient(null);
});

test("a deploy waiting for a person is not in flight, so no poller touches it", async () => {
  /**
   * `listInFlightDeployments` drives the reconciler, which asks CodeBuild what happened to a build.
   * An `awaiting_review` row has no build and no build id; polling it would either do nothing forever
   * or, worse, mark it failed for not being a build that was never started.
   */
  fakeClient();
  const d = new InMemoryDomainStore();
  await proposeDeploy(d, REQ, CFG);

  assert.deepEqual(await d.listInFlightDeployments(), []);
  setDeployClient(null);
});

test("the source key cannot be repointed once it is set", async () => {
  /**
   * The guarantee the write-once column buys: a person reviews one tarball, and the publish that
   * follows builds THAT tarball. If the key could be patched, a later write could swap the bytes
   * between the screenshot somebody approved and the build that goes live.
   */
  fakeClient();
  const d = new InMemoryDomainStore();
  const proposed = await proposeDeploy(d, REQ, CFG);
  const original = proposed.source_key;
  assert.ok(original);

  const after = await d.updateDeployment(proposed.id, "proj-1", {
    source_key: "proj-1/somebody-elses/workspace.tar.gz",
  });
  assert.equal(after?.source_key, original, "source_key is write-once");
  setDeployClient(null);
});

test("a proposal whose upload failed is a failure, not a refusal", async () => {
  fakeClient({ failPut: true });
  const d = new InMemoryDomainStore();

  await assert.rejects(() => proposeDeploy(d, REQ, CFG), /could not store the build/);

  const rows = await d.listDeployments({ project_id: "proj-1" });
  assert.equal(rows.length, 1, "the attempt is recorded even though it failed");
  assert.equal(rows[0].status, "failed");
  assert.match(rows[0].error ?? "", /s3 exploded/);
  setDeployClient(null);
});

test("publishing a row with no stored source says so instead of building nothing", async () => {
  // `proposeDeploy` dying between the insert and the key patch. There are no bytes to build, and
  // starting a build that cannot succeed would report a CodeBuild failure for a kernel bug.
  const calls = fakeClient();
  const d = new InMemoryDomainStore();
  const orphan = await d.createDeployment({
    project_id: "proj-1",
    slug: "acme",
    url: "https://acme.apps.mycelai.dev",
    status: "awaiting_review",
  });

  const out = await publishDeploy(d, orphan.id, "proj-1", CFG);

  assert.equal(out?.status, "failed");
  assert.match(out?.error ?? "", /never stored/);
  assert.equal(calls.builds.length, 0);
  setDeployClient(null);
});

test("the orchestrator proposes and does not publish", async () => {
  /**
   * A source check, and the one assertion here that is about wiring rather than behaviour. The gate
   * is worth nothing if the one caller that matters still reaches the publishing path — and that
   * caller is a few hundred lines inside a run's completion handler, where no unit test reaches it.
   *
   * This is the repo's dominant defect class (a mechanism built and connected to nothing), so it is
   * checked rather than assumed.
   */
  const { readFileSync } = await import("node:fs");
  const orchestrator = readFileSync(new URL("../src/orchestrator.ts", import.meta.url).pathname, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  assert.match(orchestrator, /await proposeDeploy\(/, "a finished build must propose");
  assert.doesNotMatch(orchestrator, /\bstartDeploy\b/, "nothing may publish without a person");
  assert.match(orchestrator, /emit\("deploy\.proposed"/, "the feed must say what actually happened");
});
