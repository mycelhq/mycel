// The build plane: `next build` as a TOOL the agent calls, not as a post-mortem the kernel runs.
//
// Every test here names the production failure it prevents. They descend from two of them:
//
//   · a `product-builder` run whose sandbox was killed by `npm run build` — a memory ceiling that
//     read from outside as "opencode ended before completing"
//   · every run in which the build verdict arrived AFTER the agent had stopped, so a one-line
//     compile error became a whole new task with a fresh sandbox and none of the context
//
// The seams under test are the ones that cannot be exercised by driving a real sandbox: the cap,
// the refusal, the log tail, and — the one that actually makes the guarantee — the assertion in
// `handOffWorkspace` that a run which never proved the app builds cannot hand anything back.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { InMemoryStore } from "../src/store";
import { assertRemoteBuildSucceeded } from "../src/orchestrator";
import {
  BUILD_TOOL_PATH,
  buildToolScript,
  LOG_TAIL_BYTES,
  MAX_BUILDS_PER_RUN,
  MAX_SOURCE_BYTES,
  pollBuild,
  remoteBuildConfig,
  remoteBuildToolDoc,
  setRemoteBuildClient,
  startRemoteBuild,
  verifySourceKey,
  type RemoteBuildClient,
  type RemoteBuildState,
} from "../src/remotebuild";
import { getBuildGrant, registerBuildGrant, revokeBuildGrant } from "../src/buildgrants";
import { getActionGrant, registerActionGrant } from "../src/actiongrants";

const CFG = { bucket: "builds", project: "mycel-tenant-verify", region: "eu-west-2" };

/** A scripted CodeBuild. Records what it was asked to do so the test can assert on the request. */
function fakeClient(over: Partial<RemoteBuildClient> = {}) {
  const calls = {
    put: [] as { bucket: string; key: string; bytes: number }[],
    start: [] as { project: string; env: Record<string, string> }[],
    logs: [] as { group: string; stream: string }[],
  };
  const client: RemoteBuildClient = {
    async putObject(bucket, key, body) {
      calls.put.push({ bucket, key, bytes: body.byteLength });
    },
    async startBuild(project, env) {
      calls.start.push({ project, env });
      return "build:1";
    },
    async buildState() {
      return { status: "succeeded" } as RemoteBuildState;
    },
    async logTail(group, stream) {
      calls.logs.push({ group, stream });
      return "";
    },
    ...over,
  };
  setRemoteBuildClient(client);
  return calls;
}

// ── Configuration degrades, it does not fail ──────────────────────────────────────────────────

test("no build plane configured means no build plane — not a crash and not a default", () => {
  // Prevents: a kernel that cannot start on a developer machine because a feature most installs
  // never use demands an AWS project. `deployConfig()` made exactly this promise; this keeps it.
  const bucket = process.env.MYCEL_DEPLOY_BUCKET;
  const project = process.env.MYCEL_VERIFY_PROJECT;
  delete process.env.MYCEL_DEPLOY_BUCKET;
  delete process.env.MYCEL_VERIFY_PROJECT;
  try {
    assert.equal(remoteBuildConfig(), null);
    // A PARTIAL configuration is the dangerous state: it fails at the end of a build run rather
    // than before one. Both or neither.
    process.env.MYCEL_DEPLOY_BUCKET = "builds";
    assert.equal(remoteBuildConfig(), null, "bucket without project must not enable the tool");
    delete process.env.MYCEL_DEPLOY_BUCKET;
    process.env.MYCEL_VERIFY_PROJECT = "p";
    assert.equal(remoteBuildConfig(), null, "project without bucket must not enable the tool");
  } finally {
    if (bucket === undefined) delete process.env.MYCEL_DEPLOY_BUCKET;
    else process.env.MYCEL_DEPLOY_BUCKET = bucket;
    if (project === undefined) delete process.env.MYCEL_VERIFY_PROJECT;
    else process.env.MYCEL_VERIFY_PROJECT = project;
  }
});

// ── The build nonce is its own capability ─────────────────────────────────────────────────────

test("a build nonce does not resolve as an action grant, and vice versa", async () => {
  // Prevents: authenticating the build tool with the action nonce. A `build` run has
  // `grants_actions: false` precisely so it holds no credential that reaches the outside world;
  // reusing that token here would have handed every build run /records, /knowledge/gap and /case.
  // `GrantKind` namespaces the nonce space and this is the assertion that it really does.
  const buildNonce = await registerBuildGrant({ task_id: "t1", project_id: "p1" });
  const actionNonce = await registerActionGrant({ task_id: "t1", connectionIds: [] });

  assert.equal((await getBuildGrant(buildNonce))?.project_id, "p1");
  assert.equal(await getActionGrant(buildNonce), undefined, "a build nonce must not open the action proxy");
  assert.equal(await getBuildGrant(actionNonce), undefined, "an action nonce must not start a build");

  await revokeBuildGrant(buildNonce);
  assert.equal(await getBuildGrant(buildNonce), undefined, "revocation at end of run must take effect");
});

test("an empty nonce is refused without touching the store", async () => {
  // Prevents: a missing authorization header being normalised to "" and matching a "" key.
  assert.equal(await getBuildGrant(""), undefined);
});

// ── The project id comes from the kernel, never from the sandbox ──────────────────────────────

test("the S3 key is derived from the grant, and the tarball cannot influence it", async () => {
  // Prevents: the failure deploy.ts is written around — build input deciding where build output
  // goes. Here the object key is the only thing the source could have addressed, and it is built
  // from the grant's project id (read from the kernel's database at mint time) plus the task id.
  const calls = fakeClient();
  try {
    const started = await startRemoteBuild(CFG, {
      projectId: "proj-a",
      taskId: "task-9",
      attempt: 2,
      source: Buffer.from("not-really-a-tarball"),
    });
    assert.equal(started.key, verifySourceKey("proj-a", "task-9", 2));
    assert.match(started.key, /^proj-a\/verify\/task-9\/2\.tar\.gz$/);
    assert.equal(calls.put[0].bucket, "builds");
    // The buildspec re-checks that SOURCE_KEY sits under `<PROJECT_ID>/verify/`, which is only a
    // second lock if the kernel actually sends a matching pair.
    assert.equal(calls.start[0].env.PROJECT_ID, "proj-a");
    assert.equal(calls.start[0].env.SOURCE_KEY, started.key);
    assert.equal(calls.start[0].project, CFG.project);
  } finally {
    setRemoteBuildClient(null);
  }
});

test("the attempt number is in the key, so a retry cannot overwrite a running build's input", () => {
  // Prevents: attempt 2 uploading over the object attempt 1 is still reading, which produces a
  // verdict about source nobody has seen.
  assert.notEqual(verifySourceKey("p", "t", 1), verifySourceKey("p", "t", 2));
});

test("an oversized or empty archive is refused before a byte reaches S3", async () => {
  // Prevents: paying to upload (and then to build) a workspace that has node_modules or a .next
  // cache in it, and prevents a zero-byte upload becoming a build that fails for a reason the
  // agent cannot read.
  const calls = fakeClient();
  try {
    await assert.rejects(
      () => startRemoteBuild(CFG, { projectId: "p", taskId: "t", attempt: 1, source: Buffer.alloc(0) }),
      /empty/,
    );
    await assert.rejects(
      () =>
        startRemoteBuild(CFG, {
          projectId: "p",
          taskId: "t",
          attempt: 1,
          source: Buffer.alloc(MAX_SOURCE_BYTES + 1),
        }),
      /node_modules/,
    );
    assert.equal(calls.put.length, 0, "nothing may be uploaded when the archive is refused");
    assert.equal(calls.start.length, 0, "no build may be started when the archive is refused");
  } finally {
    setRemoteBuildClient(null);
  }
});

// ── The tail of the log is the product ────────────────────────────────────────────────────────

test("a failed build comes back with the tail of the real log", async () => {
  // THE POINT OF THE WHOLE FEATURE. "The build failed" teaches the agent nothing and it will guess;
  // the compiler's own last words are a fix. Prevents a regression to a bare boolean.
  const tail = "Type error: Property 'x' does not exist on type 'Props'.\n";
  fakeClient({
    async buildState() {
      return { status: "failed", logGroup: "/aws/codebuild/verify", logStream: "abc" };
    },
    async logTail() {
      return tail;
    },
  });
  try {
    const v = await pollBuild(CFG, "build:1", 0);
    assert.equal(v.status, "failed");
    assert.equal(v.tail, tail);
  } finally {
    setRemoteBuildClient(null);
  }
});

test("a log we cannot read still produces a correct verdict", async () => {
  // Prevents: a CloudWatch permission problem turning "your build failed" into an exception, which
  // would surface to the agent as a broken tool rather than as a failed build.
  fakeClient({
    async buildState() {
      return { status: "failed", logGroup: "g", logStream: "s" };
    },
    async logTail() {
      throw new Error("AccessDenied");
    },
  });
  try {
    const v = await pollBuild(CFG, "build:1", 0);
    assert.equal(v.status, "failed");
    assert.equal(v.tail, "");
  } finally {
    setRemoteBuildClient(null);
  }
});

test("polling returns `building` rather than blocking past its budget", async () => {
  // Prevents: a handler that holds an HTTP request for the five minutes a build takes. The load
  // balancer in front of the sandbox host has AWS's default 60-second idle timeout, so such a
  // request is dropped mid-build — and an agent that sees a network error retries, spending one of
  // three attempts on a build that was already running.
  fakeClient({
    async buildState() {
      return { status: null };
    },
  });
  try {
    const v = await pollBuild(CFG, "build:1", 30, async () => undefined);
    assert.equal(v.status, null);
    assert.equal(v.buildId, "build:1");
  } finally {
    setRemoteBuildClient(null);
  }
});

// ── What the agent is told ────────────────────────────────────────────────────────────────────

test("the tool description states the cap and names the last attempt", () => {
  // Prevents: an agent rebuilding after every small edit because nothing told it what a build
  // costs. An agent that does not know it is on its last attempt cannot spend it deliberately.
  const doc = remoteBuildToolDoc("app").join("\n");
  assert.match(doc, new RegExp(`${MAX_BUILDS_PER_RUN} builds for this whole task`));
  assert.match(doc, /last attempt/);
  assert.match(doc, /refuses/, "the doc must say the cap is a refusal, not a silent no-op");
  // The cheap checks are kept and taught, because they cost seconds and catch most failures before
  // a build is spent.
  assert.match(doc, /tsc --noEmit/);
  assert.match(doc, /npm run dev/);
  assert.match(doc, /200/);
  assert.match(doc, /~\/app/);
});

test("the wrapper script excludes what must never be uploaded, and polls", () => {
  // Prevents: shipping node_modules (700MB over the wire to reinstall it at the far end), shipping
  // .next (the very artifact being verified), or shipping a .env (a key, into a build log's blast
  // radius). And prevents a script that fires and forgets: the blocking is what makes the tool feel
  // synchronous to the agent.
  const s = buildToolScript();
  for (const excluded of ["node_modules", ".next", ".git", ".env"]) {
    assert.match(s, new RegExp(`--exclude=${excluded.replace(".", "\\.")}`), `must exclude ${excluded}`);
  }
  assert.match(s, /MYCEL_BUILD_URL\/status/, "the script must poll for a verdict");
  assert.match(s, /sleep 10/, "polling must not be a busy loop");
  assert.match(s, /log_tail/, "the script must print the build log tail on failure");
  assert.equal(BUILD_TOOL_PATH.startsWith("/"), true, "the tool must be installed at an absolute path");
});

test("the wrapper script is syntactically valid bash", () => {
  // Prevents the most embarrassing possible version of this feature: the tool is installed, the
  // prompt tells the agent to run it, and it dies on a quoting error the moment it is invoked —
  // costing the run its turns and, because the failure looks like the tool is broken, its trust in
  // every other instruction in AGENTS.md. The script is assembled from a TypeScript array of
  // strings with nested quotes and escapes; nothing else would catch a mistake in it.
  const r = spawnSync("bash", ["-n"], { input: buildToolScript(), encoding: "utf8" });
  assert.equal(r.status, 0, `bash -n rejected the script: ${r.stderr}`);
});

// ── THE GUARANTEE: a run that never proved it builds cannot hand anything back ────────────────

const emitNothing = async () => undefined;

test("require_remote_build fails a run that never called the build tool", async () => {
  // THE GUARANTEE. Prevents the failure `verifyWorkspace` was written for, in its new form: an
  // agent's final message saying "the app builds" is not evidence, and with the build no longer
  // running in the sandbox, the only honest check is that the KERNEL watched one succeed.
  const store = new InMemoryStore();
  const task = await freshTask(store);
  process.env.MYCEL_DEPLOY_BUCKET = "builds";
  process.env.MYCEL_VERIFY_PROJECT = "verify";
  try {
    await assert.rejects(
      () =>
        assertRemoteBuildSucceeded({
          store,
          taskId: task,
          ws: { requireRemoteBuild: true, dir: "app" },
          emit: emitNothing,
        }),
      /never proved the app builds/,
    );
  } finally {
    delete process.env.MYCEL_DEPLOY_BUCKET;
    delete process.env.MYCEL_VERIFY_PROJECT;
  }
});

test("require_remote_build fails a run whose every build attempt failed", async () => {
  // Prevents the subtler version: the agent DID try, three times, and shipped anyway. An app that
  // does not compile is not a partial deliverable.
  const store = new InMemoryStore();
  const task = await freshTask(store);
  await store.appendEvent(task, "tool.called", { tool: "codebuild" });
  await store.appendEvent(task, "tool.result", { tool: "codebuild", ok: false });
  process.env.MYCEL_DEPLOY_BUCKET = "builds";
  process.env.MYCEL_VERIFY_PROJECT = "verify";
  try {
    await assert.rejects(
      () =>
        assertRemoteBuildSucceeded({
          store,
          taskId: task,
          ws: { requireRemoteBuild: true, dir: "app" },
          emit: emitNothing,
        }),
      /none succeeded/,
    );
  } finally {
    delete process.env.MYCEL_DEPLOY_BUCKET;
    delete process.env.MYCEL_VERIFY_PROJECT;
  }
});

test("one successful build is enough, even after failures", async () => {
  // The normal path the whole design exists to produce: build, fail, read the log, fix, build again.
  const store = new InMemoryStore();
  const task = await freshTask(store);
  await store.appendEvent(task, "tool.called", { tool: "codebuild" });
  await store.appendEvent(task, "tool.result", { tool: "codebuild", ok: false });
  await store.appendEvent(task, "tool.called", { tool: "codebuild" });
  await store.appendEvent(task, "tool.result", { tool: "codebuild", ok: true });
  process.env.MYCEL_DEPLOY_BUCKET = "builds";
  process.env.MYCEL_VERIFY_PROJECT = "verify";
  try {
    await assertRemoteBuildSucceeded({
      store,
      taskId: task,
      ws: { requireRemoteBuild: true, dir: "app" },
      emit: emitNothing,
    });
  } finally {
    delete process.env.MYCEL_DEPLOY_BUCKET;
    delete process.env.MYCEL_VERIFY_PROJECT;
  }
});

test("a kernel with no build plane does not enforce a tool it never offered", async () => {
  // Prevents: `product-builder` becoming unrunnable without an AWS account. The same mistake
  // `assertExportableBackend` nearly made, with the same resolution — the tool was never installed
  // and never documented, so its absence is not the agent's fault.
  const store = new InMemoryStore();
  const task = await freshTask(store);
  const notes: string[] = [];
  delete process.env.MYCEL_DEPLOY_BUCKET;
  delete process.env.MYCEL_VERIFY_PROJECT;
  await assertRemoteBuildSucceeded({
    store,
    taskId: task,
    ws: { requireRemoteBuild: true, dir: "app" },
    emit: async (_t, d) => void notes.push(String(d?.note ?? "")),
  });
  // Degraded, but SAID OUT LOUD. A weaker guarantee nobody is told about is worse than none.
  assert.match(notes.join("\n"), /no build plane is configured/);
});

test("a workspace that does not ask for a remote build is untouched", async () => {
  // Additive by construction: every other wedge in the repo declares nothing here and behaves
  // exactly as it did.
  const store = new InMemoryStore();
  const task = await freshTask(store);
  await assertRemoteBuildSucceeded({
    store,
    taskId: task,
    ws: { requireRemoteBuild: false, dir: "app" },
    emit: async () => assert.fail("a workspace with no remote-build requirement must emit nothing"),
  });
});

// ── The cap is a real number, stated once ─────────────────────────────────────────────────────

test("the cap and the log tail are bounded", () => {
  // Prevents a future edit quietly turning the cap off, or the tail into the whole log (megabytes
  // of `npm install` progress into a model's context window).
  assert.equal(MAX_BUILDS_PER_RUN >= 1 && MAX_BUILDS_PER_RUN <= 5, true);
  assert.equal(LOG_TAIL_BYTES > 0 && LOG_TAIL_BYTES <= 32_000, true);
});

async function freshTask(store: InMemoryStore): Promise<string> {
  const now = new Date().toISOString();
  const t = await store.createTask({
    id: `task-${Math.random().toString(36).slice(2)}`,
    project_id: "p1",
    wedge: "product-builder",
    task_type: "build_feature",
    actor: { kind: "system", id: "test" },
    input: {},
    constraints: { max_cost_usd: 5, max_runtime_s: 3600, max_tokens: 8192 },
    tools: [],
    status: "running",
    cost_usd: 0,
    created_at: now,
    updated_at: now,
  });
  return t.id;
}
