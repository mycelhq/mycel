/**
 * `next build`, as a TOOL the agent calls — not as a post-mortem the kernel performs.
 *
 * ── What was wrong with running the build inside the sandbox ──────────────────────────────────
 *
 * `product-builder`'s workspace declared `verify: "npm install && npm run build"`, and
 * `verifyWorkspace` ran it inside the Daytona microVM AFTER the agent had stopped. That is wrong
 * twice over, and both failures were observed:
 *
 *   1. IT DOES NOT FIT. A Next.js production build is the heaviest thing in the run by a wide
 *      margin, and it OOM'd a sandbox — the run read as "opencode ended before completing", which
 *      sounds like a protocol fault and was a memory ceiling. See the resources note in
 *      sandbox.snapshot.ts.
 *   2. THE ANSWER ARRIVES TOO LATE. The agent has stopped. A compile error found here cannot be
 *      fixed here; it has to be resurrected into a follow-up task, with a fresh sandbox, a fresh
 *      seed, and none of the context that would have made the fix obvious.
 *
 * ── What this is instead ──────────────────────────────────────────────────────────────────────
 *
 * The loop closes INSIDE the run: build → fail → read the real log → fix → build again → done. The
 * agent tars its workspace and posts it to the kernel; the kernel puts it in S3 and starts a
 * CodeBuild project that compiles it with the exact OpenNext toolchain the deploy uses; the agent
 * gets back a verdict and, on failure, THE TAIL OF THE BUILD LOG. A real error, not a guess.
 *
 * That also buys a guarantee that could not be made before: the task completes only when the
 * application actually builds — see `require_remote_build` in workspace.ts and the assertion in
 * `handOffWorkspace`.
 *
 * ── THE SANDBOX NEVER HOLDS AWS CREDENTIALS ───────────────────────────────────────────────────
 *
 * Exactly as in deploy.ts, and for exactly the same reason. It would be simpler to hand the sandbox
 * `codebuild:StartBuild` and let it drive its own builds. It would also mean an environment running
 * model-authored code — whose entire security model is that it holds ONE opaque per-task nonce and
 * nothing else (infra/sandbox.tf) — holding a credential in the build plane. A prompt injection in
 * a customer's requirements document would be the whole distance from "an agent read a document" to
 * "attacker code compiled and published under our build role".
 *
 * So the bytes travel as DATA. The sandbox posts a tarball to one enumerated kernel path
 * authenticated by its per-run nonce (buildgrants.ts); the KERNEL calls StartBuild with its own
 * role. Nothing about the tarball may influence which project is built or where output goes — the
 * verify project writes nowhere at all, which is the difference between it and `tenant-deploy`.
 *
 * ── EVERYTHING HERE DEGRADES TO A NO-OP when unconfigured ─────────────────────────────────────
 *
 * `remoteBuildConfig()` returning null is the state of every developer machine and every test run.
 * The tool is then not offered to the agent, no grant is minted, and `require_remote_build` is not
 * enforced — a build run still runs, still verifies cheaply in-sandbox, and still hands back a
 * downloadable app. A kernel that refused to start without a CodeBuild project would be a worse
 * kernel.
 */

// ---------------------------------------------------------------------------------------------
// The cap
// ---------------------------------------------------------------------------------------------

/**
 * HOW MANY REMOTE BUILDS ONE RUN MAY SPEND. Three.
 *
 * A build is roughly $0.05 of CodeBuild and several minutes of wall clock, and it is the only thing
 * in the run the agent can do that costs real money outside the model budget. An agent in a retry
 * loop — change one line, rebuild, change it back, rebuild — burns both, and the run's cost ceiling
 * (`max_cost_usd`) does not see CodeBuild spend at all, so nothing else would stop it.
 *
 * Three rather than two or five, and the reasoning is about what each attempt is FOR:
 *
 *   1. the first honest attempt, after the cheap in-sandbox checks have already passed
 *   2. the fix for whatever only a real production build finds (and there is always a class of
 *      those: a type that only fails under `next build`'s stricter pass, a client/server boundary
 *      violation, a missing dependency that `next dev` tolerates)
 *   3. one more, because a first fix is sometimes wrong
 *
 * A fourth attempt is not usually a fourth idea; it is the same idea again. Two would be too few —
 * it makes the first attempt precious enough that a careful agent hoards it, which is the opposite
 * of the behaviour this tool exists to create.
 *
 * The number is stated in the tool's own description (see `remoteBuildToolDoc`) so the agent knows
 * when it is on its last attempt and can spend it deliberately. Exceeding it is an HONEST REFUSAL —
 * a 429 that says how many were used — never a silent no-op that returns success.
 */
export const MAX_BUILDS_PER_RUN = Number(process.env.MYCEL_MAX_BUILDS_PER_RUN ?? 3);

/** How much of the build log comes back on failure. The interesting part is always at the bottom. */
export const LOG_TAIL_BYTES = 6000;

/**
 * The largest source archive the kernel will accept from a sandbox, decoded.
 *
 * Deliberately the same order as `maxExportBytes` — this is the same tree that will be exported at
 * the end of the run, minus nothing. A tarball larger than this is a workspace with a build cache
 * or a `node_modules` in it, which is a mistake worth naming rather than paying to upload.
 */
export const MAX_SOURCE_BYTES = 20 * 1024 * 1024;

// ---------------------------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------------------------

export interface RemoteBuildConfig {
  /** S3 bucket the source is staged in. The SAME bucket as deploys — `aws_s3_bucket.tenant_builds`. */
  bucket: string;
  /** CodeBuild project that compiles it and publishes NOTHING. `aws_codebuild_project.tenant_verify`. */
  project: string;
  region: string;
}

/**
 * Read the environment, or null when this kernel cannot run remote builds.
 *
 * Both or neither, for the reason `deployConfig` gives: a partial configuration fails at the worst
 * possible moment. The bucket is shared with the deploy path on purpose — one bucket, one lifecycle
 * policy, one IAM statement to review.
 */
export function remoteBuildConfig(): RemoteBuildConfig | null {
  const bucket = process.env.MYCEL_DEPLOY_BUCKET?.trim();
  const project = process.env.MYCEL_VERIFY_PROJECT?.trim();
  if (!bucket || !project) return null;
  return { bucket, project, region: process.env.AWS_REGION?.trim() || "eu-west-2" };
}

// ---------------------------------------------------------------------------------------------
// The AWS surface, behind an interface
// ---------------------------------------------------------------------------------------------

export interface RemoteBuildState {
  /** Terminal verdict, or null while it is still running. */
  status: "succeeded" | "failed" | null;
  /** Where CloudWatch put the log, once CodeBuild has decided. Absent very early in a build. */
  logGroup?: string;
  logStream?: string;
}

/**
 * The three calls this needs, so everything above and below is testable without an AWS account.
 * Mirrors `DeployClient` in deploy.ts, including the dynamic-import trick — the kernel must not
 * take a hard dependency on `@aws-sdk/*` for a feature most installs never use.
 */
export interface RemoteBuildClient {
  putObject(bucket: string, key: string, body: Buffer): Promise<void>;
  startBuild(project: string, env: Record<string, string>): Promise<string>;
  buildState(buildId: string): Promise<RemoteBuildState>;
  /** Last `maxBytes` of the build's CloudWatch stream. "" when it cannot be read. */
  logTail(group: string, stream: string, maxBytes: number): Promise<string>;
}

let clientOverride: RemoteBuildClient | null = null;
/** Test seam. Production never calls this; `remotebuild.test.ts` does. */
export function setRemoteBuildClient(c: RemoteBuildClient | null): void {
  clientOverride = c;
}

async function awsClient(cfg: RemoteBuildConfig): Promise<RemoteBuildClient> {
  if (clientOverride) return clientOverride;
  const s3pkg = "@aws-sdk/client-s3";
  const cbpkg = "@aws-sdk/client-codebuild";
  const logpkg = "@aws-sdk/client-cloudwatch-logs";
  const s3mod: any = await import(s3pkg);
  const cbmod: any = await import(cbpkg);
  const s3 = new s3mod.S3Client({ region: cfg.region });
  const cb = new cbmod.CodeBuildClient({ region: cfg.region });
  return {
    async putObject(bucket, key, body) {
      await s3.send(new s3mod.PutObjectCommand({ Bucket: bucket, Key: key, Body: body }));
    },
    async startBuild(project, env) {
      const res = await cb.send(
        new cbmod.StartBuildCommand({
          projectName: project,
          environmentVariablesOverride: Object.entries(env).map(([name, value]) => ({
            name,
            value,
            type: "PLAINTEXT",
          })),
        }),
      );
      const id = res?.build?.id;
      if (!id) throw new Error("remote build: CodeBuild accepted the request but returned no build id");
      return id;
    },
    async buildState(buildId) {
      const res = await cb.send(new cbmod.BatchGetBuildsCommand({ ids: [buildId] }));
      const b = res?.builds?.[0];
      const s = b?.buildStatus;
      return {
        status: !s || s === "IN_PROGRESS" ? null : s === "SUCCEEDED" ? "succeeded" : "failed",
        logGroup: b?.logs?.groupName,
        logStream: b?.logs?.streamName,
      };
    },
    async logTail(group, stream, maxBytes) {
      // Dynamically imported HERE rather than at the top of the function so a kernel that never has
      // a failing build never loads the package at all.
      const logmod: any = await import(logpkg);
      const logs = new logmod.CloudWatchLogsClient({ region: cfg.region });
      // `startFromHead: false` is the whole point — CloudWatch returns the LAST page of events, and
      // the last page is where a compiler puts its diagnosis. Reading from the head would return a
      // thousand lines of `npm install` progress and none of the error.
      const res = await logs.send(
        new logmod.GetLogEventsCommand({
          logGroupName: group,
          logStreamName: stream,
          startFromHead: false,
          limit: 400,
        }),
      );
      const text = (res?.events ?? []).map((e: any) => String(e?.message ?? "")).join("");
      return text.slice(-maxBytes);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Starting, and waiting
// ---------------------------------------------------------------------------------------------

/**
 * Where a run's source is staged.
 *
 * Keyed by project AND task AND attempt. The attempt is in the key so a retry cannot overwrite the
 * input of a build that is still reading it, and so the S3 lifecycle rule on this bucket ages every
 * attempt out on the same schedule rather than leaving one mutable object per task forever.
 */
export function verifySourceKey(projectId: string, taskId: string, attempt: number): string {
  return `${projectId}/verify/${taskId}/${attempt}.tar.gz`;
}

export interface StartedBuild {
  buildId: string;
  key: string;
}

/** Stage the source and start the build. Does NOT wait — see `pollBuild`. */
export async function startRemoteBuild(
  cfg: RemoteBuildConfig,
  req: { projectId: string; taskId: string; attempt: number; source: Buffer },
): Promise<StartedBuild> {
  if (req.source.byteLength <= 0) throw new Error("remote build: the uploaded archive is empty");
  if (req.source.byteLength > MAX_SOURCE_BYTES) {
    throw new Error(
      `remote build: the source archive is ${(req.source.byteLength / 1024 / 1024).toFixed(1)}MB, over the ` +
        `${(MAX_SOURCE_BYTES / 1024 / 1024).toFixed(0)}MB ceiling. Exclude node_modules and .next — the build ` +
        `installs dependencies itself.`,
    );
  }
  const client = await awsClient(cfg);
  const key = verifySourceKey(req.projectId, req.taskId, req.attempt);
  await client.putObject(cfg.bucket, key, req.source);
  // Every value here comes from the kernel. NOTHING is read out of the tarball, for the reason
  // deploy.ts states at length: build input must never decide where build output goes. This project
  // writes no output at all, which makes the property easy to hold rather than merely intended.
  const buildId = await client.startBuild(cfg.project, {
    SOURCE_KEY: key,
    PROJECT_ID: req.projectId,
    TASK_ID: req.taskId,
  });
  return { buildId, key };
}

export interface BuildVerdict {
  /** null while still running — the caller returns `status: "building"` and is called again. */
  status: "succeeded" | "failed" | null;
  buildId: string;
  /** Present only on failure. The last few KB of the build log, which is where the error is. */
  tail?: string;
}

/**
 * Wait for a verdict, for AT MOST `waitMs`.
 *
 * BOUNDED SHORT ON PURPOSE, and this is the least obvious decision in the file. The load balancer
 * in front of the sandbox callback host has AWS's default 60-second idle timeout (infra/sandbox.tf
 * declares no `idle_timeout`), so a handler that blocks for the five minutes a real build takes
 * would have its connection dropped at 60s — the build would carry on, the agent would see a
 * network error, and the natural response to a network error is to retry, which spends another one
 * of three attempts on a build that already succeeded.
 *
 * So the kernel waits under the timeout and answers `status: "building"` with the build id. The
 * BLOCKING is done by the wrapper script in the sandbox (`remoteBuildToolDoc`), which loops until a
 * terminal answer — so from the agent's point of view the tool blocks and returns a verdict, which
 * is what the design asks for, without holding a minutes-long HTTP request across the internet.
 */
export async function pollBuild(
  cfg: RemoteBuildConfig,
  buildId: string,
  waitMs: number,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<BuildVerdict> {
  const client = await awsClient(cfg);
  const deadline = Date.now() + Math.max(0, waitMs);
  let state = await client.buildState(buildId);
  while (state.status === null && Date.now() < deadline) {
    await sleep(Math.min(5000, Math.max(0, deadline - Date.now())));
    state = await client.buildState(buildId);
  }
  if (state.status === null) return { status: null, buildId };
  if (state.status === "succeeded") return { status: "succeeded", buildId };

  // THE POINT OF THE WHOLE FEATURE. A failure that says "the build failed" teaches the agent
  // nothing and it will guess; a failure carrying the compiler's own last words is a fix.
  let tail = "";
  if (state.logGroup && state.logStream) {
    tail = await client
      .logTail(state.logGroup, state.logStream, LOG_TAIL_BYTES)
      // A log we cannot read must not turn a legitimate "your build failed" into an exception. The
      // verdict is still correct and still useful without it.
      .catch(() => "");
  }
  return { status: "failed", buildId, tail };
}

// ---------------------------------------------------------------------------------------------
// What the agent is told
// ---------------------------------------------------------------------------------------------

/** Where the wrapper script lives in the sandbox, and what the agent is told to run. */
export const BUILD_TOOL_PATH = "/usr/local/bin/mycel-build";

/**
 * The tool, as a shell script, because the tool an agent has is `bash`.
 *
 * Teaching the agent to tar, curl, parse JSON and poll in prose is three paragraphs of AGENTS.md
 * that it will get subtly wrong once per run. A script is one line to invoke and one place to fix.
 *
 * It POLLS — that is the blocking half of `pollBuild`'s split. Each iteration is one short request
 * that comfortably fits inside the load balancer's idle timeout; the loop is what makes the tool
 * feel synchronous.
 *
 * `set -u` is deliberately absent: this runs under `bash -lc` from a tool call and an unset optional
 * variable must not abort the script before it can print a useful message.
 */
export function buildToolScript(): string {
  return [
    "#!/usr/bin/env bash",
    "# mycel-build — compile this workspace on Mycel's build plane and report the result.",
    "# Written by the kernel (remotebuild.ts). Do not edit; it is overwritten every run.",
    "set -o pipefail",
    'if [ -z "$MYCEL_BUILD_URL" ] || [ -z "$MYCEL_BUILD_TOKEN" ]; then',
    '  echo "mycel-build: this run has no build plane configured." >&2; exit 3',
    "fi",
    'DIR="${1:-$MYCEL_WORKSPACE_DIR}"',
    'cd "$HOME/$DIR" 2>/dev/null || { echo "mycel-build: no such workspace ~/$DIR" >&2; exit 3; }',
    '[ -f package.json ] || { echo "mycel-build: ~/$DIR has no package.json" >&2; exit 3; }',
    'TAR="$(mktemp /tmp/mycel-src-XXXXXX.tgz)"',
    // The same exclusions the export uses. Shipping node_modules would be ~700MB over the wire to
    // reinstall it at the other end; shipping .next would ship the very artifact being verified.
    'tar -czf "$TAR" --exclude=node_modules --exclude=.next --exclude=.git --exclude=.turbo \\',
    "  --exclude=.env --exclude='.env.*' --exclude='*.log' --exclude=tsconfig.tsbuildinfo .",
    'echo "mycel-build: uploading $(du -h "$TAR" | cut -f1) and starting the build..."',
    'RES="$(curl -sS -X POST "$MYCEL_BUILD_URL" \\',
    '  -H "authorization: Bearer $MYCEL_BUILD_TOKEN" \\',
    '  -H "content-type: application/gzip" --data-binary "@$TAR")"',
    'rm -f "$TAR"',
    'BUILD_ID="$(printf %s "$RES" | grep -o \'"build_id":"[^"]*"\' | head -1 | cut -d\'"\' -f4)"',
    'if [ -z "$BUILD_ID" ]; then printf %s\\\\n "$RES"; exit 1; fi',
    'echo "mycel-build: build $BUILD_ID started; waiting (a build takes several minutes)..."',
    "while :; do",
    '  RES="$(curl -sS -X POST "$MYCEL_BUILD_URL/status" \\',
    '    -H "authorization: Bearer $MYCEL_BUILD_TOKEN" -H "content-type: application/json" \\',
    '    -d "{\\"build_id\\":\\"$BUILD_ID\\"}")"',
    '  case "$RES" in',
    '    *\'"status":"succeeded"\'*) echo "mycel-build: SUCCEEDED — the application builds."; exit 0 ;;',
    '    *\'"status":"failed"\'*)',
    '      echo "mycel-build: FAILED. Build log tail:"',
    // node is in the image (the sandbox is node:22-bookworm-slim), so the log tail is unescaped
    // properly rather than printed as a JSON string with \n in it, which is unreadable.
    '      printf %s "$RES" | node -e \'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write((j.log_tail||j.error||s)+"\\n")}catch{process.stdout.write(s)}})\'',
    "      exit 1 ;;",
    '    *\'"status":"building"\'*) sleep 10 ;;',
    '    *) printf %s\\\\n "$RES"; exit 1 ;;',
    "  esac",
    "done",
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------
// The evidence tool
// ---------------------------------------------------------------------------------------------

/**
 * `mycel-insight` — what the LAST version of this product did to real visitors.
 *
 * ── Why this exists at all ──
 *
 * Everything else in this file is about proving the app COMPILES. This is about whether it WORKS,
 * and it is the harder half. A build agent that can read its own source and nothing about what
 * happened when a customer met it is guessing, and "AI-native" then means "an AI typed it once".
 * The kernel already rolls up per-project evidence and already decides which A/B arm won
 * (`insight/experiment.ts`); the only thing missing was a way for the agent to ask.
 *
 * ── Why it rides on the BUILD nonce ──
 *
 * No new credential enters the sandbox. The build grant already resolves, kernel-side, to exactly
 * one task and exactly one project, and that is precisely the scoping this read needs — the summary
 * is for THIS project, and there is nowhere in the request to name another. Minting a second token
 * would mean a second grant table, a second expiry, a second thing to get wrong, and a second
 * credential sitting in an environment that runs model-authored code.
 *
 * The consequence, stated plainly: on a kernel with no build plane there is no grant, so there is no
 * evidence tool either. That is the same rule the rest of this file follows — a tool that was never
 * offered must not fail the run that could not use it — and it is why the skill that reads this
 * says "if the tool is not here, say so and change nothing" rather than assuming it is.
 *
 * ── Why it is a read and not a write ──
 *
 * It cannot start a task, cannot post an event, cannot reach another project, and is not counted
 * against the build cap. The worst an agent can do with it is call it too often.
 */
export const INSIGHT_TOOL_PATH = "/usr/local/bin/mycel-insight";

export function insightToolScript(): string {
  return [
    "#!/usr/bin/env bash",
    "# mycel-insight — what real visitors did to the last version of this product.",
    "# Written by the kernel (remotebuild.ts). Do not edit; it is overwritten every run.",
    "set -o pipefail",
    'if [ -z "$MYCEL_BUILD_URL" ] || [ -z "$MYCEL_BUILD_TOKEN" ]; then',
    '  echo "mycel-insight: this run has no evidence plane configured." >&2; exit 3',
    "fi",
    // The window is the only knob, and it is clamped to 1..90 kernel-side.
    'DAYS="${1:-14}"',
    'curl -sS -X POST "$MYCEL_BUILD_URL/insight" \\',
    '  -H "authorization: Bearer $MYCEL_BUILD_TOKEN" -H "content-type: application/json" \\',
    '  -d "{\\"days\\":$DAYS}" | node -e \'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.stringify(JSON.parse(s),null,2)+"\\n")}catch{process.stdout.write(s)}})\'',
  ].join("\n");
}

/**
 * What the agent is told about `mycel-insight`.
 *
 * It leads with the REFUSAL rule rather than with the capability, because the expensive mistake here
 * is not ignoring the evidence — it is acting on evidence that is not there. An agent that rewrites
 * a client's homepage because three visitors split 2:1 will rewrite it back next week and thrash
 * their front door forever, and every iteration will look justified.
 */
export function insightToolDoc(): string[] {
  return [
    "",
    "## What real visitors did — `mycel-insight`",
    "",
    "Run `mycel-insight [days]` (default 14). It returns this project's own summary: totals, the " +
      "declared funnel and its biggest drop-off, and — when the product runs an A/B test — an " +
      "`experiment` block with each arm's conversion rate and a `verdict`.",
    "",
    "**Read `experiment.winner` before you touch the marketing page, and obey it literally.**",
    "",
    "- `winner` is a string → rewrite the arm named in `loser`, in `content/marketing.ts`. Write a " +
      "new attempt to beat the winner; do NOT delete the losing arm and do NOT copy the winner into " +
      "it, or there is no experiment left to run.",
    "- `winner` is `null` → **change nothing about the hero copy.** `verdict` says why, and the two " +
      "reasons want opposite responses: too little traffic means WAIT, while a gap within noise " +
      "means the hypothesis was too timid — try a bolder difference, not a reshuffle.",
    "- No `experiment` block, or `thin: true` → there is no evidence. Say so in your final message " +
      "and make only the changes you were actually asked for.",
    "",
    "Do not compute your own winner from `arms`. The rates are there so the numbers are auditable, " +
      "not so they can be eyeballed — the threshold that produced `verdict` accounts for sample " +
      "size, for how few outcomes each arm has, and for the fact that this summary is read " +
      "repeatedly rather than once. A rate that looks better is not a rate that is better.",
    "",
    "If the tool is not installed, this run has no evidence plane. Say so; do not guess.",
  ];
}

/**
 * The build tool's description, for AGENTS.md.
 *
 * STATES THE CAP, because an agent that does not know it is on its last attempt cannot spend it
 * deliberately — and the observed failure mode of a build agent is not caution, it is a rebuild
 * after every small edit.
 */
export function remoteBuildToolDoc(workspaceDir: string): string[] {
  return [
    "",
    "## Proving the app builds — `mycel-build`",
    "",
    `Run \`mycel-build\` from anywhere. It packages \`~/${workspaceDir}\`, compiles it on Mycel's ` +
      `build plane with the EXACT toolchain that deploys it, and blocks until there is a verdict ` +
      `(several minutes). Exit 0 means the application builds. On failure it prints the TAIL OF ` +
      `THE REAL BUILD LOG — read it, fix the actual error, and run it again.`,
    "",
    `**You get ${MAX_BUILDS_PER_RUN} builds for this whole task, and no more.** Each one costs real ` +
      `money and several minutes. The tool tells you how many remain; when it says one remains, ` +
      `that is your last attempt. After that it refuses — it does not quietly succeed.`,
    "",
    `So do the cheap checks FIRST, every time, because they cost seconds and catch most of it:`,
    "",
    "```bash",
    `cd ~/${workspaceDir}`,
    "npm install --no-audit --no-fund",
    "npx tsc --noEmit                 # types",
    "npm run dev >/tmp/dev.log 2>&1 & # boot it",
    "sleep 12 && curl -sS -o /dev/null -w '%{http_code}\\n' http://localhost:3000/   # expect 200",
    "kill %1",
    "```",
    "",
    `**This task is not finished until \`mycel-build\` has succeeded.** A run that ends without a ` +
      `successful build is failed by the kernel, whatever your summary says — so leave yourself the ` +
      `time for it, and do not start a large refactor with one attempt left.`,
  ];
}
