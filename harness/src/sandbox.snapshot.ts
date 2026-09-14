/**
 * The Daytona snapshot the agent actually runs inside.
 *
 * Background, because the default here used to be a lie: `MYCEL_SANDBOX_IMAGE` defaulted to
 * `mycel/sandbox:latest`, an image that exists in no registry anywhere. `DaytonaSandbox.acquire`
 * handed that string to `client.create({ image })`, so with MYCEL_SANDBOX=daytona the kernel booted,
 * reported healthy, accepted work, and failed every single task at sandbox creation. Same failure
 * shape as the missing SDK before it: green fleet, zero output.
 *
 * The fix is a Daytona *snapshot* built from an image definition that lives in this file, rather
 * than an image we publish somewhere. Why a snapshot:
 *
 *   · No registry credential to store, inject or rotate. Daytona cannot pull from our private ECR
 *     without one, and a long-lived registry secret sitting in the kernel's env is a liability we
 *     get to simply not have.
 *   · No publishing our agent runtime — prompts, wedge tooling, the whole shape of the product — to
 *     a public registry so that Daytona can read it.
 *   · Daytona pre-pulls its own snapshots onto runners. Every task pays sandbox cold start, so this
 *     is not a cosmetic difference; it is on the critical path of every unit of work we sell.
 *
 * The snapshot name embeds a hash of the definition below. Change a line here and the next boot
 * builds and uses a *new* snapshot instead of silently serving the stale one that a name like
 * "mycel-sandbox" would have pinned us to.
 */
import { createHash } from "node:crypto";

/**
 * The OpenCode build baked into the sandbox.
 *
 * Pinned, not `latest`: the runtime speaks to `opencode serve`'s HTTP API (see OpenCodeClient), and
 * an agent runtime that silently changes underneath a running fleet is how you get a Tuesday where
 * every task fails at session creation for no reason anyone changed. Bump deliberately; the hash in
 * the snapshot name means a bump builds a new snapshot rather than mutating the one in use.
 */
export const OPENCODE_VERSION = process.env.MYCEL_OPENCODE_VERSION ?? "1.18.30";

/*
  BUMPED 1.17.6 → 1.18.30 on 2026-09-12, and here is what was checked rather than assumed, because
  "bump the agent runtime" is how a fleet loses a Tuesday:

    · EVERY ENDPOINT THIS KERNEL CALLS STILL EXISTS — `/session`, `/session/:id/prompt_async`,
      `/session/:id/message`, `/session/:id/abort`, `/event`, `/agent`. Read out of 1.18.30's
      generated `sdk.gen.js`, not out of a changelog.
    · THE PROMPT BODY IS UNCHANGED. `{ parts: [{type:"text"}], model: {providerID, modelID} }`
      matches `SessionPromptAsyncData` exactly.
    · THE SHAPES THE MAPPER READS ARE UNCHANGED. `ToolPart` is still
      `{tool, callID, state:{status, input, output, title, time}}`, usage is still
      `tokens:{input, output, reasoning, cache:{read, write}}`, and a streamed delta still rides on
      `message.part.updated` as a sibling field rather than as an event of its own.
    · THE NEW EVENTS ARE ADDITIVE — `todo.updated`, `pty.*`, `command.executed`, `vcs.branch.updated`
      — and the mapper already ignores what it does not recognise, with a bounded log.

  The one rename found: `installation.update.available` → `installation.update-available`. It is on
  the ignore list either way, so it costs nothing; both spellings are listed there now rather than
  quietly dropping the old one, because a self-hoster pinning the previous version still emits it.

  AND THEN THE BINARY WAS RUN, because generated types are the thing this file already warns are
  stale. Against 1.18.30 on a laptop, with the exact `opencode.json` this kernel writes:

    · `permission: { "*": "allow", bash: {pattern map}, <an MCP tool name>: "deny" }` — ACCEPTED and
      echoed back by `debug config`. None of those keys appear in the generated `Config` type, which
      is precisely why reading the types alone would have been a guess.
    · `tools: {write: true}` on an agent still normalises into `permission.edit: "allow"`, the same
      folding the 1.17.6 note in `harness.ts` documents.
    · `POST /session` → a session id. `GET /agent` → the agent list with `mode` and `permission`.
      `POST /session/:id/abort` → 200. `POST /session/:id/prompt_async` → 204, immediately, exactly
      as this kernel's header says. `GET /event` → SSE opening with `server.connected`.
*/

/** Base image. Node because opencode is a Node-ecosystem distribution and wedge tooling assumes it. */
const BASE_IMAGE = "node:22-bookworm-slim";

/**
 * Pinned, for the same reason `OPENCODE_VERSION` is: this is a tool the agent's whole `operate`
 * capability rests on, and a floating version means the day a release changes a tool name is the day
 * every customer's browser work stops, with nothing in our history to point at.
 */
export const BROWSER_USE_VERSION = process.env.MYCEL_BROWSER_USE_VERSION ?? "0.13.8";

/**
 * A declarative description of the sandbox filesystem.
 *
 * Kept as plain data — not as a live `Image` instance — for two reasons. First, we can hash it
 * without importing `@daytona/sdk`, which stays a dynamic import so a self-hosted install on another
 * backend need not carry it. Second, a test can assert on the definition without a network or an
 * SDK present.
 */
export interface SandboxImageSpec {
  base: string;
  opencodeVersion: string;
  commands: string[];
  workdir: string;
  env: Record<string, string>;
  /**
   * What every sandbox from this snapshot gets. Part of the spec, so it is part of the HASH — a
   * resource change produces a new snapshot name rather than silently reusing one built small.
   */
  resources: { cpu: number; memory: number; disk: number };
}

/**
 * Everything a run needs, and deliberately little else.
 *
 * · bash + curl + ca-certificates — the agent is *taught* to curl its own control plane. See
 *   `buildAgentsMd` in runtime.ts: MYCEL_ACTIONS_URL, MYCEL_READS_URL, MYCEL_CASE_URL and friends
 *   are all reached with curl from inside the sandbox. Without curl the agent can read its
 *   instructions and cannot follow any of them.
 * · git, python3, ripgrep — what a coding agent reaches for unprompted. Cheap to bake, and each one
 *   missing is a task that dies mid-run on a runner with no way to install it.
 * · the opencode binary on PATH — runtime.ts spawns `opencode serve --port ...` directly.
 *
 * The opencode install mirrors docker/sandbox/Dockerfile exactly: fetch the platform tarball from
 * the npm registry and drop the binary in /usr/local/bin. `npm i -g opencode-ai` (what setup.sh
 * offers on a laptop) relies on a postinstall step that downloads the platform binary, and that step
 * is unreliable in an image build — no TTY, and a failure there produces an image that looks built
 * and has no `opencode` in it. Fetching the platform package directly makes the failure happen at
 * build time, loudly, where it belongs.
 */
export function sandboxImageSpec(): SandboxImageSpec {
  return {
    base: BASE_IMAGE,
    opencodeVersion: OPENCODE_VERSION,
    commands: [
      // `python3-venv` is NOT optional, and leaving it out took production down.
      //
      // `node:22-bookworm-slim` ships a python3 with no `ensurepip`, so `python3 -m venv` — the
      // first line of the browser-use layer below — fails with "ensurepip is not available".
      // Debian splits it into its own package and the error names it; nothing in this image needed
      // a venv until browser-use did, so `python3` alone had always been enough.
      //
      // What that cost on 2026-08-29: the layer failed, the WHOLE snapshot went to `error`, the
      // kernel's boot preflight could not find a usable one, and a duplicate preflight (see
      // index.ts) turned that into `process.exit(1)` and an eighty-second crash loop which took the
      // API down with it. One missing apt package, in one optional capability, total outage.
      "apt-get update && apt-get install -y --no-install-recommends " +
        "bash curl ca-certificates git python3 python3-venv ripgrep && rm -rf /var/lib/apt/lists/*",
      // `set -eux` so a 404 on the tarball fails the build instead of leaving an empty binary.
      "set -eux; " +
        'tmp="$(mktemp -d)"; ' +
        `curl -sSL "https://registry.npmjs.org/opencode-linux-x64/-/opencode-linux-x64-${OPENCODE_VERSION}.tgz" -o "$tmp/oc.tgz"; ` +
        'tar -xzf "$tmp/oc.tgz" -C "$tmp"; ' +
        'cp "$tmp/package/bin/opencode" /usr/local/bin/opencode; ' +
        "chmod +x /usr/local/bin/opencode; " +
        'rm -rf "$tmp"; ' +
        // Not `|| true`. A binary that cannot execute is exactly the failure this whole file exists
        // to stop shipping, and the build is the only place it is cheap to notice.
        "opencode --version",

      /**
       * A REAL BROWSER, because most knowledge work happens in one.
       *
       * The `operate` shape exists so a run can work inside the customer's own software — pull a
       * statement out of an accounting package, move a candidate through an applicant tracker, file
       * a form in a portal that has no API and never will. Every one of those is a browser, and a
       * wedge that can only emit a document is producing a report ABOUT the work rather than the
       * work.
       *
       * ═══ WHY IT IS BAKED AND NOT INSTALLED PER RUN ═══
       *
       * Chromium plus its system libraries is a few hundred megabytes and several minutes. Doing it
       * at run time means every `operate` task pays that before it starts, on the customer's clock,
       * with a network fetch that can fail — and a run that dies during setup is indistinguishable
       * from one that failed at the job. Baking it makes the cost a build-time fact.
       *
       * The image is bigger for every shape, including the three that will never open a browser.
       * That is the trade, taken deliberately: one snapshot that can do everything beats a matrix of
       * snapshots whose differences somebody has to remember.
       *
       * ═══ WHY PLAYWRIGHT AND NOT A HOSTED BROWSER API ═══
       *
       * A hosted browser means the customer's authenticated session lives in a third party we do not
       * control, on a machine we cannot attest. The sandbox is already disposable, already isolated,
       * already the thing we hand credentials to. Adding a second place that holds a live login is a
       * second place to lose one.
       *
       * `--with-deps` rather than a hand-written apt list: the dependency set drifts with every
       * Chromium release, and a missing shared library shows up as a browser that launches and dies
       * with no useful message.
       */
      "apt-get update && apt-get install -y --no-install-recommends nodejs npm && rm -rf /var/lib/apt/lists/*",
      "set -eux; " +
        // `npm install` (local, into /root/node_modules) rather than `npm i -g` (global prefix).
        // The validation step below uses `require('playwright')`, which Node resolves from the
        // working directory's node_modules — not the global prefix — so a global install passes
        // `playwright install` but always fails the require check, crashing sandboxPreflight and
        // preventing the kernel from booting at all.
        "npm install --prefix /root playwright@1.62.1; " +
        "npx --prefix /root playwright install --with-deps chromium; " +
        // Same argument as `opencode --version` above: a browser that cannot launch is exactly the
        // failure this file exists to stop shipping, and the build is the cheap place to find it.
        "node -e \"const{chromium}=require('/root/node_modules/playwright');chromium.launch().then(b=>b.close()).then(()=>console.log('chromium ok'))\"",

      /**
       * ═══ browser-use, ON TOP OF THAT CHROMIUM ═══
       *
       * Raw Playwright is a driver, not a way of working. An agent handed `page.click(selector)` has
       * to invent a selector from a screenshot or from raw HTML, and it is wrong often enough that
       * every `operate` run becomes a retry loop against somebody else's markup. That is the whole
       * reason the shape was slow and expensive in the estimate: not page loads, re-tries.
       *
       * `browser-use` is the layer that removes that. It serialises the page into an INDEXED list of
       * interactive elements and the agent clicks index 14 — no selector, no guessing, no brittle
       * XPath that breaks when the vendor ships a class rename. It also carries the accumulated
       * work on stealth, iframes, shadow DOM, file uploads, downloads and multi-tab state that we
       * would otherwise write ourselves, badly, one incident at a time.
       *
       * ═══ WHY IT REUSES THE CHROMIUM ABOVE, AND WHY IT NO LONGER ASKS FOR ITS OWN ═══
       *
       * This step used to run `/opt/browseruse/bin/python -m playwright install chromium`, on the
       * reasoning that Python Playwright and Node Playwright share `~/.cache/ms-playwright` so the
       * call would find the browser the step above already downloaded and do nothing.
       *
       * That reasoning was correct and its premise stopped being true. browser-use 0.13.8 DOES NOT
       * DEPEND ON PLAYWRIGHT — it drives Chrome over CDP directly (`cdp-use`, `browser-harness` in
       * its dependency tree). So the venv has no `playwright` module, and the line failed:
       *
       *     + /opt/browseruse/bin/python -m playwright install chromium
       *     /opt/browseruse/bin/python: No module named playwright
       *
       * Under `set -eux` that failed the whole layer, which failed the image, which meant the
       * snapshot every `operate` job needs did not exist — so the browser shape had never once run.
       * The pip install above it succeeded every time; the failure was one line later, in the last
       * three lines of a seven-thousand-line build log nobody had read.
       *
       * The Node step above still installs chromium `--with-deps`, which is what puts both the
       * browser and its system libraries in the image. That is what browser-use drives.
       *
       * ═══ WHY A VENV ═══
       *
       * Debian 12 marks its system Python externally-managed (PEP 668), so `pip install` into it
       * fails with an error about `--break-system-packages` that reads like a suggestion. Taking the
       * suggestion is how you end up with an image whose apt and pip disagree about `requests`. A
       * venv at a fixed path costs nothing and the symlink keeps the command on PATH where the MCP
       * config expects it.
       *
       * ═══ AND IT IS PROVEN AT BUILD TIME ═══
       *
       * Same rule as `opencode --version` and the chromium launch above: an import that fails at run
       * time is a customer's `operate` task dying during setup, which is indistinguishable from
       * failing at the job.
       */
      "apt-get update && apt-get install -y --no-install-recommends python3-venv && rm -rf /var/lib/apt/lists/*",
      "set -eux; " +
        "python3 -m venv /opt/browseruse; " +
        "/opt/browseruse/bin/pip install --no-cache-dir --upgrade pip; " +
        `/opt/browseruse/bin/pip install --no-cache-dir 'browser-use[cli]==${BROWSER_USE_VERSION}'; ` +
        "ln -sf /opt/browseruse/bin/browser-use /usr/local/bin/browser-use; " +
        // Proven at build time, same rule as `opencode --version` and the chromium launch above: an
        // import that fails at run time is a customer's `operate` task dying during setup, which is
        // indistinguishable from failing at the job.
        "browser-use --version",
    ],
    // The harness writes ~/.config/opencode/opencode.json and runs from HOME.
    workdir: "/root",
    env: { HOME: "/root", DEBIAN_FRONTEND: "noninteractive" },
    /**
     * SIZED FOR `next dev`, which is now the heaviest thing that runs in here.
     *
     * History, because both halves of it are load-bearing. Originally nothing requested resources
     * at all, so every sandbox took Daytona's default, and a `product-builder` run reached the
     * finish line of the interesting part — read the app, wrote the page, ran `npm install` — then
     * ran `npm run build` and OpenCode died fifteen seconds later. From outside that read as
     * "opencode ended before completing", which sounds like a protocol fault and was a memory
     * ceiling. The answer then was 4 CPU / 8 GB, sized for a Next.js production build.
     *
     * The production build has left the building. It is a TOOL now (remotebuild.ts): the agent
     * posts its source to the kernel and CodeBuild compiles it on a MEDIUM instance built for
     * exactly that. What remains in the sandbox is editing, `npm install`, `tsc --noEmit`, and a
     * `next dev` server the agent boots and curls — the cheap checks that catch most failures
     * before a build is spent.
     *
     * 2 CPU / 4 GB. NOT smaller, and that is the part worth being careful about: `next dev`
     * under Turbopack is not free — it compiles routes on demand and holds a module graph — and
     * halving the memory to "save" on a machine billed by the minute would buy a different OOM, in
     * a shape that looks like the app is broken rather than like the box is small. 4 GB is roughly
     * double what a dev server plus a typecheck plus the opencode process needs.
     *
     * DISK IS 10 GB BECAUSE THAT IS DAYTONA'S CEILING, not because 10 is the number we wanted.
     * Asking for 20 does not degrade — the snapshot build is REFUSED outright:
     *
     *   Disk request 20GB exceeds maximum allowed per sandbox (10GB).
     *
     * and `sandboxPreflight` then does the right thing and stops the worker from booting at all
     * ("Refusing to start: every task would fail at sandbox creation"). That guard is why this was
     * a stalled rollout rather than an outage: ECS could not stabilise the new task, kept the old
     * one serving, and the fleet went on working on the previous image. Which is also the trap —
     * runs kept succeeding, on code that did not contain the change being deployed.
     *
     * 10 GB holds `node_modules` for this template plus the opencode install plus a dev-mode `.next`
     * cache, with less headroom than before. If a future template pushes past it, the ceiling is not
     * ours to raise and the answer is a smaller dependency tree or a word with Daytona — not a
     * larger number here, which simply will not build.
     *
     * This is hashed into the snapshot name (`specDigest`), so changing it does not mutate the
     * machine a running fleet is using — it builds a new snapshot on first use and the old one ages
     * out. That is why the numbers live on the spec rather than on each `create()` call.
     */
    resources: { cpu: 2, memory: 4, disk: 10 },
  };
}

/**
 * Content hash of the definition. Short (12 hex) because it goes in a name a human will read in the
 * Daytona dashboard, and 48 bits is far more than enough to distinguish the handful of revisions
 * this file will ever have live at once.
 */
export function specDigest(spec: SandboxImageSpec = sandboxImageSpec()): string {
  return createHash("sha256").update(JSON.stringify(spec)).digest("hex").slice(0, 12);
}

/** Deterministic, definition-derived snapshot name. Same definition ⇒ same name ⇒ reuse. */
/**
 * Every snapshot this kernel builds starts with this. Exported because `reapStoppedSandboxes` uses
 * it to tell OUR dead sandboxes from another project's on a shared Daytona organisation, and a
 * filter that hardcodes the string separately is a filter that silently stops matching the day this
 * name changes — at which point the sweep goes quiet and the quota fills.
 */
export const SNAPSHOT_PREFIX = "mycel-sandbox-";

export function snapshotName(spec: SandboxImageSpec = sandboxImageSpec()): string {
  return `${SNAPSHOT_PREFIX}${specDigest(spec)}`;
}

/**
 * Turn the spec into an SDK `Image`.
 *
 * Takes the `Image` class rather than importing it, so this stays callable from a test with a
 * two-line fake and from the real path with the dynamically-imported SDK.
 */
export function buildImage(ImageCtor: any, spec: SandboxImageSpec = sandboxImageSpec()): any {
  let img = ImageCtor.base(spec.base);
  img = img.env(spec.env);
  img = img.runCommands(...spec.commands);
  img = img.workdir(spec.workdir);
  return img;
}

// The SDK surface we use, narrowed to what we actually call. Untyped at the edges for the same
// reason DaytonaSandbox is: the concrete SDK shape belongs at the integration boundary.
export interface SnapshotClientLike {
  snapshot: {
    get(name: string): Promise<any>;
    create(params: any, options?: any): Promise<any>;
    activate(snapshot: any): Promise<any>;
    delete(snapshot: any): Promise<void>;
  };
}

export interface EnsureSnapshotOptions {
  /** Injected in tests; in production we build a real Daytona client. */
  client?: SnapshotClientLike;
  /** Injected in tests; in production the SDK's Image class. */
  ImageCtor?: any;
  /** Build log sink. Defaults to stderr — a 3-minute silent boot looks like a hang. */
  onLogs?: (chunk: string) => void;
  /** Seconds. 0 = no timeout, which is the SDK's own default. */
  timeoutS?: number;
  /**
   * How long to wait for a deleted snapshot's NAME to be released, and how often to check.
   *
   * Overridable for tests only. The real values are seconds and a test that actually waited them
   * would be a test nobody runs — the previous version of this file had no test for the wait at all,
   * which is how a recovery path that could never succeed shipped.
   */
  freeNameTimeoutMs?: number;
  freeNamePollMs?: number;
  /**
   * How often to re-check a snapshot ANOTHER replica is building. Test seam, same as the two above.
   *
   * Hardcoded at 3s, this path was untestable without a three-second sleep per case — and untestable
   * is how the race it exists for shipped: the loser of a create deleted the winner's in-progress
   * build, and no test could reach the branch cheaply enough for anyone to write one.
   */
  waitPollMs?: number;
}

// Snapshot state strings from @daytona/api-client's SnapshotState. Inlined rather than imported so
// this module has no static dependency on the SDK (see the dynamic-import note above).
const ACTIVE = "active";
const INACTIVE = "inactive";
const FAILED = new Set(["error", "build_failed"]);

/**
 * The name of a ready-to-use snapshot, building it first if it does not exist.
 *
 * Idempotent and memoised. Creating a snapshot means Daytona builds an image — minutes, not
 * milliseconds — so this must never run per task. It is called once from `sandboxPreflight` at boot;
 * the cached promise means concurrent callers (preflight racing the first task, or several tasks
 * arriving together) share a single build rather than starting several.
 *
 * The cache is keyed by name, so bumping OPENCODE_VERSION or editing the spec in a hot-reloaded dev
 * process correctly builds the new snapshot instead of returning the old cached name.
 */
const inflight = new Map<string, Promise<string>>();

export async function ensureSnapshot(opts: EnsureSnapshotOptions = {}): Promise<string> {
  const spec = sandboxImageSpec();
  const name = snapshotName(spec);
  const existing = inflight.get(name);
  if (existing) return existing;

  const p = resolveSnapshot(name, spec, opts).catch((e) => {
    // A failed build must not be cached as a permanent verdict — a transient registry blip at boot
    // would otherwise poison the process for its whole life. Drop it so the next call retries.
    inflight.delete(name);
    throw e;
  });
  inflight.set(name, p);
  return p;
}

/**
 * ═══ RE-ASK THE PROVIDER WHETHER THE SNAPSHOT IS STILL USABLE ═══
 *
 * `ensureSnapshot` memoises SUCCESS for the life of the process. That is right for cost — a build is
 * minutes and every task would otherwise pay a lookup — and it is exactly how the snapshot became an
 * outage nobody could see.
 *
 * On 2026-08-29 a snapshot entered `error` state hours after a boot that had verified it. The memo
 * still answered "fine", every task failed at sandbox creation with the provider's own opaque error,
 * and the health check stayed green because HTTP was never affected. The truth surfaced when a human
 * noticed. a comparable runtime has the same class written up in
 * `projects/reaping/parked-runtime-verification.ts`: nothing ever re-verified a stopped sandbox, so
 * "the truth only surfaced when a human opened the session 30 hours later" — and when they measured,
 * 16,243 rows had never been re-checked and 16 were already dead.
 *
 * Their sweep runs BOTH directions and so does this one, for the same reason: a provider that says
 * the thing is BACK has to be believed too, or a recovered fleet stays marked broken and someone has
 * to clear it by hand.
 *
 * This is a READ plus, when the answer is bad, a rebuild. It never runs on the task path.
 */
export type SnapshotHealth =
  | { ok: true; name: string; state: string; rebuilt?: true }
  /** The provider answered, and the answer was bad. Actionable — names the state. */
  | { ok: false; name: string; state: string; detail: string }
  /** We could not establish an answer. NOT the same as a bad one — see below. */
  | { ok: false; name: string; state: "unknown"; detail: string; inconclusive: true };

/**
 * Ask the provider about the current snapshot, and repair it if it has failed.
 *
 * "COULD NOT CHECK" IS NOT "IT IS BROKEN". A provider blip returns `inconclusive`, and the caller
 * treats that as no news rather than as a reason to drop a working memo and start a multi-minute
 * rebuild. That distinction is the same one `prompt-wire-id-repair.ts` makes — "repair only on
 * POSITIVE evidence... a failed read keeps the client's id: 'we could not check' is not 'it is
 * wrong'" — and getting it backwards here would turn every network hiccup into a rebuild storm.
 */
export async function verifySnapshot(opts: EnsureSnapshotOptions = {}): Promise<SnapshotHealth> {
  const spec = sandboxImageSpec();
  const name = snapshotName(spec);
  let client: any;
  try {
    client = opts.client ?? (await defaultClient());
  } catch (e) {
    return { ok: false, name, state: "unknown", detail: (e as Error).message, inconclusive: true };
  }

  let snap: any = null;
  try {
    snap = await client.snapshot.get(name);
  } catch (e) {
    /**
     * A 404 AND A BROKEN API ARE THE SAME THROW, AND THEY MEAN OPPOSITE THINGS.
     *
     * `resolveSnapshot` can afford to conflate them because its next move is `create()`, which
     * reports the truth either way. This function's next move is a VERDICT, so it cannot: turning an
     * unreachable provider into "your snapshot is gone" starts a multi-minute rebuild on every
     * network wobble, and turning a genuinely deleted snapshot into "could not check" means the
     * sweep never repairs the one case it most needs to.
     *
     * So the message is sniffed for a not-found, which is exactly the kind of text-classification
     * this codebase avoids elsewhere (see `mayRetry` in steer-queue.ts, where guessing wrong sends a
     * founder's message twice). It is acceptable HERE and the asymmetry is why: a wrong "missing"
     * costs one unnecessary rebuild of a content-addressed snapshot, and a wrong "inconclusive"
     * costs one delayed repair that the next sweep twenty minutes later picks up. Neither can
     * corrupt anything, which is not true of the steer path.
     */
    const msg = (e as Error)?.message ?? String(e);
    if (!/404|not.?found|no such/i.test(msg)) {
      return { ok: false, name, state: "unknown", detail: msg, inconclusive: true };
    }
    snap = null; // provider ANSWERED: there is no such snapshot. Fall through and rebuild it.
  }

  if (snap && snap.state === ACTIVE) return { ok: true, name, state: ACTIVE };
  if (snap && !FAILED.has(snap.state)) {
    // inactive / building / pulling — all recoverable and all handled by the ordinary path. Reported
    // as healthy so a mid-build window does not read as an incident.
    return { ok: true, name, state: String(snap.state) };
  }

  // Either gone or failed. Both are repaired the same way, and both must drop the memo first — the
  // cached promise is the thing that was lying.
  const state = snap ? String(snap.state) : "missing";
  inflight.delete(name);
  try {
    await ensureSnapshot(opts);
    return { ok: true, name, state, rebuilt: true };
  } catch (e) {
    return { ok: false, name, state, detail: (e as Error).message };
  }
}

/** Test seam. Nothing in production should need to forget a snapshot it just built. */
export function resetSnapshotCache(): void {
  inflight.clear();
}

/**
 * Daytona returns a plain HTTP-level error whose message contains "already exists" when you try
 * to create a snapshot whose name is taken, even if the existing record is in a failed state.
 * The SDK does not expose a typed error class for this, so we match on the message string.
 */
/**
 * How long to wait for a deleted snapshot's NAME to be released before giving up.
 *
 * Thirty seconds, polled every second. Deletion is fast when it works; a name still held after
 * thirty is a Daytona-side problem, and pretending otherwise would turn a clear error into a hang on
 * the boot path of every browser job.
 */
const FREE_NAME_TIMEOUT_MS = 30_000;
const FREE_NAME_POLL_MS = 1_000;


function isAlreadyExistsError(e: unknown): boolean {
  const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
  return msg.includes("already exists");
}

async function resolveSnapshot(
  name: string,
  spec: SandboxImageSpec,
  opts: EnsureSnapshotOptions,
): Promise<string> {
  const client = opts.client ?? (await defaultClient());
  const log = opts.onLogs ?? ((chunk: string) => console.log(`  [snapshot] ${chunk}`));

  // Look it up first. This is the common path in production: the snapshot was built by a previous
  // deploy of the same definition and every boot after the first is a single cheap GET.
  let snap: any = null;
  try {
    snap = await client.snapshot.get(name);
  } catch {
    // Not found, or not readable. Either way the answer is "build it" — and if the API is genuinely
    // broken, create() will say so with a better message than a swallowed 404 would.
    snap = null;
  }

  if (snap) {
    if (snap.state === ACTIVE) return name;
    if (snap.state === INACTIVE) {
      // Daytona deactivates snapshots that have gone unused. Reactivating is far cheaper than
      // rebuilding, and the content is by definition identical — the name is its hash.
      log(`reactivating ${name}`);
      await client.snapshot.activate(snap);
      return name;
    }
    if (!FAILED.has(snap.state)) {
      // building / pending / pulling / snapshotting — another replica is mid-build of the very same
      // definition. Wait it out rather than racing it with a duplicate create.
      log(`waiting for ${name} (${snap.state})`);
      return waitActive(client, name, log, undefined, opts.waitPollMs);
    }
    // A previously failed build under this exact name. Falling through to create() is deliberate:
    // the failure may have been transient (a registry timeout), and the alternative is a snapshot
    // name that is permanently poisoned with no way out but manual deletion.
    log(`${name} is in state ${snap.state}; rebuilding`);
  }

  const ImageCtor = opts.ImageCtor ?? (await defaultImageCtor());
  log(`building ${name} (opencode ${spec.opencodeVersion}) — this takes a few minutes on first use`);
  // SnapshotService.create already blocks until a terminal state and throws on error/build_failed,
  // so there is no polling to do here.
  try {
    const created = await client.snapshot.create(
      // `resources` travels with the snapshot rather than with each `create()` call, because Daytona
      // takes it on `CreateSnapshotParams` and a sandbox started from a snapshot inherits it. Putting
      // it here also means it is covered by the name hash, so a machine that was built small can
      // never be silently reused once we decide it needs to be bigger.
      { name, image: buildImage(ImageCtor, spec), resources: spec.resources },
      { onLogs: log, timeout: opts.timeoutS ?? 0 },
    );
    if (created?.state === INACTIVE) await client.snapshot.activate(created);
    return name;
  } catch (e) {
    // Daytona throws "already exists" when the snapshot record is still present from a previous
    // failed build (state=error) but create() refuses to overwrite it. The code above fell through
    // to here precisely because the snapshot was in a FAILED state, so the record is genuinely
    // broken. Delete it and retry once — the name is deterministic so a fresh create produces the
    // identical snapshot. If the retry also fails, that error propagates normally.
    if (isAlreadyExistsError(e)) {
      /**
       * ═══════════════════════════════════════════════════════════════════════════════════════════
       * RE-READ BEFORE DELETING. THE NAME EXISTING DOES NOT MEAN THE RECORD IS BROKEN.
       * ═══════════════════════════════════════════════════════════════════════════════════════════
       *
       * The comment below this used to assert "the code above fell through to here precisely because
       * the snapshot was in a FAILED state, so the record is genuinely broken". That is true for one
       * of the two ways to reach this catch and false for the other, and the false one is the common
       * one in production.
       *
       * `resolveSnapshot` opens with a `get`. When it returns nothing we fall through to `create`.
       * Between those two calls another replica can create the very same name — it is a hash of the
       * definition, so every replica computes the identical one, and on a deploy they all boot at
       * once. The loser's `create` throws "already exists", lands here, and deletes the snapshot the
       * WINNER is actively building. The winner's `create` then fails, and both runs die.
       *
       * Measured over 30 days of production: 220 runs failed on "already exists" and 225 on a failed
       * snapshot build. Two numbers that close together are not two problems, they are one race
       * counted from both ends — together 26% of every failure in the product.
       *
       * So: read the record. Only a genuinely FAILED one gets deleted. Anything mid-build is another
       * replica doing the work correctly, and the right response is the one the happy path already
       * takes — wait for it.
       */
      let current: unknown = null;
      try {
        current = await client.snapshot.get(name);
      } catch {
        /*
          Gone between the collision and this read — the other replica's build failed and something
          cleaned it up. Nothing to delete and nothing to wait for; fall through to the rebuild
          below, which is exactly what a not-found name deserves.
        */
        current = null;
      }

      const state = (current as { state?: string } | null)?.state;
      if (current && state && !FAILED.has(state)) {
        if (state === ACTIVE) return name;
        if (state === INACTIVE) {
          await client.snapshot.activate(current);
          return name;
        }
        log(`${name} is being built by another replica (${state}) — waiting rather than racing it`);
        return waitActive(client, name, log, undefined, opts.waitPollMs);
      }

      log(`${name} exists in a failed state — deleting it and rebuilding`);
      try {
        if (current) await client.snapshot.delete(current);
      } catch (delErr) {
        // If we cannot delete either, let the original error surface — it is more actionable.
        throw e;
      }
      /**
       * ═══ WAIT FOR THE NAME TO ACTUALLY BE FREE ═══
       *
       * `delete` returns before the name is released. Creating immediately after it gets
       * "already exists" again — so this recovery path, which exists precisely so a failed build is
       * not permanent, could never succeed. Observed on `mycel-sandbox-9164b48de109`: the delete
       * worked (the snapshot was gone from the org listing) and the create in the very next line
       * still failed on the name.
       *
       * That mattered more than a retry usually does. This name is the `operate` shape's image —
       * the one with browser-use in it — so a single failed build left every browser job in the
       * product permanently unable to start, with nothing to do about it but delete a snapshot by
       * hand in somebody else's console.
       *
       * Poll until `get` says it is gone. Bounded: if the name is still there after this, the
       * original error is the honest thing to raise, and it names the snapshot somebody has to go
       * and look at.
       */
      const freedBy = Date.now() + (opts.freeNameTimeoutMs ?? FREE_NAME_TIMEOUT_MS);
      for (;;) {
        try {
          await client.snapshot.get(name);
        } catch {
          break; // gone
        }
        if (Date.now() > freedBy) throw e;
        await new Promise((r) => setTimeout(r, opts.freeNamePollMs ?? FREE_NAME_POLL_MS));
      }
      const created = await client.snapshot.create(
        { name, image: buildImage(ImageCtor, spec), resources: spec.resources },
        { onLogs: log, timeout: opts.timeoutS ?? 0 },
      );
      if (created?.state === INACTIVE) await client.snapshot.activate(created);
      return name;
    }
    throw e;
  }

}

/** Poll until a snapshot another process is building reaches a terminal state. */
async function waitActive(
  client: SnapshotClientLike,
  name: string,
  log: (chunk: string) => void,
  timeoutMs = 15 * 60_000,
  pollMs = 3000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));
    const snap = await client.snapshot.get(name);
    if (snap.state === ACTIVE) return name;
    if (snap.state === INACTIVE) {
      await client.snapshot.activate(snap);
      return name;
    }
    if (FAILED.has(snap.state)) {
      throw new Error(`snapshot ${name} failed to build: ${snap.errorReason ?? snap.state}`);
    }
  }
  log(`gave up waiting for ${name}`);
  throw new Error(`snapshot ${name} did not become active within ${Math.round(timeoutMs / 60000)}m`);
}

const DAYTONA_PKG = "@daytona/sdk";

async function defaultClient(): Promise<SnapshotClientLike> {
  const mod: any = await import(DAYTONA_PKG);
  return new mod.Daytona({ apiKey: process.env.DAYTONA_API_KEY });
}

async function defaultImageCtor(): Promise<any> {
  const mod: any = await import(DAYTONA_PKG);
  return mod.Image;
}
