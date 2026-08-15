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
export const OPENCODE_VERSION = process.env.MYCEL_OPENCODE_VERSION ?? "1.17.6";

/** Base image. Node because opencode is a Node-ecosystem distribution and wedge tooling assumes it. */
const BASE_IMAGE = "node:22-bookworm-slim";

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
      "apt-get update && apt-get install -y --no-install-recommends " +
        "bash curl ca-certificates git python3 ripgrep && rm -rf /var/lib/apt/lists/*",
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
export function snapshotName(spec: SandboxImageSpec = sandboxImageSpec()): string {
  return `mycel-sandbox-${specDigest(spec)}`;
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

/** Test seam. Nothing in production should need to forget a snapshot it just built. */
export function resetSnapshotCache(): void {
  inflight.clear();
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
      return waitActive(client, name, log);
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
}

/** Poll until a snapshot another process is building reaches a terminal state. */
async function waitActive(
  client: SnapshotClientLike,
  name: string,
  log: (chunk: string) => void,
  timeoutMs = 15 * 60_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
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
