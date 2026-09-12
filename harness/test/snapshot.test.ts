import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  buildImage,
  ensureSnapshot,
  resetSnapshotCache,
  sandboxImageSpec,
  snapshotName,
  specDigest,
  verifySnapshot,
  type SnapshotClientLike,
} from "../src/sandbox.snapshot";

// A stand-in for the SDK Image builder: same fluent surface, records what it was asked to do.
// Nothing here touches the network.
class FakeImage {
  dockerfile = "";
  static base(image: string): FakeImage {
    const i = new FakeImage();
    i.dockerfile = `FROM ${image}
`;
    return i;
  }
  env(vars: Record<string, string>): FakeImage {
    for (const [k, v] of Object.entries(vars)) this.dockerfile += `ENV ${k}=${v}
`;
    return this;
  }
  runCommands(...cmds: string[]): FakeImage {
    for (const c of cmds) this.dockerfile += `RUN ${c}
`;
    return this;
  }
  workdir(dir: string): FakeImage {
    this.dockerfile += `WORKDIR ${dir}
`;
    return this;
  }
}

interface FakeCall {
  op: "get" | "create" | "activate" | "delete";
  name: string;
}

function fakeClient(opts: {
  states?: (string | undefined)[];
  createState?: string;
  createFirstError?: Error;
  /**
   * How many `get` calls after a delete still find the record.
   *
   * ZERO IS NOT THE REALISTIC DEFAULT, and that is the point of this knob. Daytona's delete returns
   * before the name is released, which is what broke the recovery path in production — the code
   * deleted a failed snapshot and the create on the very next line failed with "already exists"
   * anyway. See the note in `resolveSnapshot`.
   */
  lingerAfterDelete?: number;
}): SnapshotClientLike & { calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  let getN = 0;
  let createN = 0;
  let deleted = false;
  let linger = opts.lingerAfterDelete ?? 0;
  const states = opts.states ?? [undefined];
  return {
    calls,
    snapshot: {
      async get(name: string) {
        calls.push({ op: "get", name });
        // A DELETED SNAPSHOT IS GONE. The fake used to no-op its delete and keep answering with the
        // record forever, which made "delete then wait for the name" untestable — and untested is
        // how the real one shipped unable to work at all.
        if (deleted) {
          if (linger > 0) {
            linger--;
            return { id: `id-${name}`, name, state: "error" };
          }
          throw new Error("404 snapshot not found");
        }
        const state = states[Math.min(getN++, states.length - 1)];
        if (state === undefined) throw new Error("404 snapshot not found");
        return { id: `id-${name}`, name, state };
      },
      async create(params: any) {
        calls.push({ op: "create", name: params.name });
        if (opts.createFirstError && createN === 0) { createN++; throw opts.createFirstError; }
        createN++;
        return { id: `id-${params.name}`, name: params.name, state: opts.createState ?? "active" };
      },
      async activate(snap: any) {
        calls.push({ op: "activate", name: snap.name });
        return { ...snap, state: "active" };
      },
      async delete(snap: any) {
        calls.push({ op: "delete", name: snap.name });
        deleted = true;
      },
    },
  };
}

beforeEach(() => resetSnapshotCache());

test("snapshot: the name carries a content hash of the image definition", () => {
  const spec = sandboxImageSpec();
  assert.equal(snapshotName(spec), `mycel-sandbox-${specDigest(spec)}`);
  assert.match(snapshotName(spec), /^mycel-sandbox-[0-9a-f]{12}$/);
  assert.equal(snapshotName(), snapshotName());
  const bumped = { ...spec, opencodeVersion: "9.9.9" };
  assert.notEqual(specDigest(bumped), specDigest(spec));
  assert.notEqual(snapshotName(bumped), snapshotName(spec));
  assert.notEqual(specDigest({ ...spec, base: "node:24-bookworm-slim" }), specDigest(spec));
  assert.notEqual(specDigest({ ...spec, commands: [...spec.commands, "RUN true"] }), specDigest(spec));
});

test("snapshot: the image definition contains what a run actually needs", () => {
  const df = buildImage(FakeImage).dockerfile as string;
  assert.match(df, /^FROM node:22/m, "a Node runtime");
  assert.match(df, /curl/, "the agent is taught to curl MYCEL_ACTIONS_URL etc.");
  assert.match(df, /\bbash\b/);
  assert.match(df, /opencode-linux-x64/, "the opencode binary is fetched, not assumed");
  assert.match(df, /\/usr\/local\/bin\/opencode/, "...and lands on PATH");
  assert.match(df, /opencode --version/, "...and is verified at build time, not at task time");
  assert.match(df, /WORKDIR \/root/, "HOME is where the harness writes opencode.json");
});

test("snapshot: ensureSnapshot reuses an active snapshot without building", async () => {
  const client = fakeClient({ states: ["active"] });
  const name = await ensureSnapshot({ client, ImageCtor: FakeImage });
  assert.equal(name, snapshotName());
  assert.deepEqual(client.calls.map((c) => c.op), ["get"], "a boot against an already-built snapshot is one cheap GET, no build");
});

test("snapshot: ensureSnapshot builds exactly once, even under concurrent callers", async () => {
  const client = fakeClient({ states: [undefined] });
  const [a, b, c] = await Promise.all([
    ensureSnapshot({ client, ImageCtor: FakeImage }),
    ensureSnapshot({ client, ImageCtor: FakeImage }),
    ensureSnapshot({ client, ImageCtor: FakeImage }),
  ]);
  assert.equal(a, snapshotName());
  assert.equal(b, a);
  assert.equal(c, a);
  assert.equal(client.calls.filter((x) => x.op === "create").length, 1);
  const before = client.calls.length;
  assert.equal(await ensureSnapshot({ client, ImageCtor: FakeImage }), a);
  assert.equal(client.calls.length, before, "memoised: repeat calls are free");
});

test("snapshot: a snapshot Daytona has deactivated is reactivated, not rebuilt", async () => {
  const client = fakeClient({ states: ["inactive"] });
  await ensureSnapshot({ client, ImageCtor: FakeImage });
  assert.deepEqual(client.calls.map((c) => c.op), ["get", "activate"]);
});

test("snapshot: a failed build is not cached as a permanent verdict", async () => {
  const boom: SnapshotClientLike = {
    snapshot: {
      async get() { throw new Error("404"); },
      async create() { throw new Error("registry timeout"); },
      async activate(s: any) { return s; },
      async delete() {},
    },
  };
  await assert.rejects(() => ensureSnapshot({ client: boom, ImageCtor: FakeImage }), /registry timeout/);
  const good = fakeClient({ states: ["active"] });
  assert.equal(await ensureSnapshot({ client: good, ImageCtor: FakeImage }), snapshotName());
});

test("snapshot: create() already-exists on error-state record => delete + retry", async () => {
  // The crash-loop scenario: snapshot in error state, create() throws "already exists",
  // fix deletes the broken record and retries. Kernel boots instead of exiting.
  const client = fakeClient({
    states: ["error", "error"],
    createFirstError: new Error("Snapshot with name already exists for this organization"),
  });
  const name = await ensureSnapshot({ client, ImageCtor: FakeImage });
  assert.equal(name, snapshotName());
  // The extra `get` after the delete is the fix: confirm the name is actually free before creating.
  assert.deepEqual(client.calls.map((c) => c.op), ["get", "create", "get", "delete", "get", "create"]);
});

test("snapshot: the delete is asynchronous, and the retry waits for the name", async () => {
  /**
   * ═══ THE RECOVERY PATH COULD NEVER SUCCEED, AND IT TOOK `operate` DOWN WITH IT ═══
   *
   * Found by trying to build the browser image for real. `mycel-sandbox-9164b48de109` — the one with
   * browser-use in it, which every `operate` job needs — sat in `error` state. The code detected
   * that, logged "deleting it and rebuilding", deleted it successfully, and then failed on the very
   * next line with "already exists".
   *
   * The delete HAD worked; the snapshot was gone from the organisation listing when checked directly.
   * Daytona simply does not release the name synchronously, so the immediate create raced it and
   * lost. Every time. Which means the mechanism written precisely so that a failed build is not
   * permanent could not once do its job — and because that name is the browser shape's image, one
   * bad build left every browser job in the product unable to start, with no remedy but deleting a
   * snapshot by hand in somebody else's console.
   *
   * Nothing caught it because the fake's `delete` was a no-op, so this scenario could not be written.
   */
  const client = fakeClient({
    states: ["error", "error"],
    createFirstError: new Error("Snapshot with name already exists for this organization"),
    lingerAfterDelete: 3,
  });
  assert.equal(await ensureSnapshot({ client, ImageCtor: FakeImage }), snapshotName());
  const gets = client.calls.filter((c) => c.op === "get").length;
  assert.ok(gets >= 5, `polled until the name was free, got ${gets} gets`);
  assert.equal(client.calls.at(-1)?.op, "create", "and then it built");
});

test("snapshot: a name that never frees raises the original error, not a hang", async () => {
  // Bounded. A name still held after the timeout is a provider-side problem, and the honest thing to
  // raise is the error that names the snapshot somebody has to go and look at — rather than blocking
  // the boot path of every browser job forever.
  const client = fakeClient({
    states: ["error", "error"],
    createFirstError: new Error("Snapshot with name already exists for this organization"),
    lingerAfterDelete: Number.MAX_SAFE_INTEGER,
  });
  await assert.rejects(
    () => ensureSnapshot({ client, ImageCtor: FakeImage, freeNameTimeoutMs: 40, freeNamePollMs: 10 }),
    /already exists/,
  );
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// RE-ASKING THE PROVIDER, AND THE DIFFERENCE BETWEEN "BROKEN" AND "COULDN'T CHECK"
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//
// `ensureSnapshot` memoises SUCCESS for the life of the process, which is right for cost and is how
// the 2026-08-29 outage stayed invisible: the snapshot entered `error` hours after a boot that had
// verified it, the memo kept answering "fine", every task failed at sandbox creation, and the health
// check stayed green because HTTP was never affected. Nothing was asking.
//
// `kortix-ai/suna` names the class in `projects/reaping/parked-runtime-verification.ts` — 16,243
// parked rows never re-verified, 16 already dead, the truth surfacing only when a human tripped over
// it 30 hours later.

test("verifySnapshot: a healthy snapshot is reported healthy and nothing is rebuilt", async () => {
  const c = fakeClient({ states: ["active"] });
  const health = await verifySnapshot({ client: c, ImageCtor: FakeImage });
  assert.equal(health.ok, true);
  assert.equal(c.calls.filter((x) => x.op === "create").length, 0, "the happy path must not build — this runs every 20 minutes");
});

test("verifySnapshot: an errored snapshot is rebuilt and says so", async () => {
  // `error` first, then `active` for the rebuild's own lookup.
  const c = fakeClient({ states: ["error", "active"] });
  const health = await verifySnapshot({ client: c, ImageCtor: FakeImage });
  assert.equal(health.ok, true, JSON.stringify(health));
  assert.equal((health as any).rebuilt, true, "the caller logs loudly — tasks failed in the meantime");
  assert.equal((health as any).state, "error", "and it names the state it was found in");
});

test("verifySnapshot: a DELETED snapshot is an answer, and gets rebuilt", async () => {
  // The fake throws `404 snapshot not found` for an undefined state, which is what the SDK does.
  // A 404 is the provider ANSWERING; treating it as "could not check" would mean the sweep never
  // repairs the one case it most needs to.
  const c = fakeClient({ states: [undefined, "active"] });
  const health = await verifySnapshot({ client: c, ImageCtor: FakeImage });
  assert.equal(health.ok, true, JSON.stringify(health));
  assert.equal((health as any).rebuilt, true);
  assert.equal((health as any).state, "missing");
});

test("verifySnapshot: a provider that will not answer is INCONCLUSIVE, not broken", async () => {
  const c: SnapshotClientLike & { calls: FakeCall[] } = {
    calls: [],
    snapshot: {
      async get() {
        throw new Error("ECONNRESET");
      },
      async create(p: any) {
        c.calls.push({ op: "create", name: p.name });
        return { name: p.name, state: "active" };
      },
      async activate(s: any) {
        return s;
      },
      async delete() {},
    },
  };
  const health = await verifySnapshot({ client: c, ImageCtor: FakeImage });
  // The distinction that stops a network wobble becoming a rebuild storm.
  assert.equal(health.ok, false);
  assert.equal((health as any).inconclusive, true);
  assert.equal(c.calls.length, 0, "a failed READ must never start a multi-minute rebuild");
});

test("verifySnapshot: a rebuild that also fails reports the real reason, not silence", async () => {
  const c = fakeClient({ states: ["build_failed"], createFirstError: new Error("quota exceeded") });
  const health = await verifySnapshot({ client: c, ImageCtor: FakeImage });
  assert.equal(health.ok, false, JSON.stringify(health));
  assert.equal((health as any).inconclusive, undefined, "this IS news about the snapshot");
  assert.match((health as any).detail, /quota exceeded/);
});

/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * TWO REPLICAS, ONE DETERMINISTIC NAME — 26% OF EVERY FAILURE IN THE PRODUCT
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Measured on 30 days of production: 220 runs failed on "already exists" and 225 on a failed
 * snapshot build, out of 1,722 failures total. Two numbers that close are not two problems — they
 * are one race counted from both ends.
 *
 * `resolveSnapshot` opens with a `get`. Nothing there means build it. Between that `get` and the
 * `create`, another replica can create the identical name — it is a hash of the definition, so every
 * replica computes the same one and on a deploy they all boot together. The loser's `create` threw
 * "already exists", and the recovery path asserted the record must therefore be broken, DELETED IT,
 * and rebuilt. It was deleting the winner's in-progress build. Both runs then died.
 *
 * The recovery path itself is right and stays: a genuinely failed snapshot must be deletable, or one
 * bad build permanently poisons a name that every browser job in the product needs.
 */
function racingClient(...states: string[]): SnapshotClientLike & { calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  let looked = 0;
  return {
    calls,
    snapshot: {
      async get(name: string) {
        calls.push({ op: "get", name });
        // FIRST look: nothing there, which is what sends us down the build path. The other replica
        // creates in the window immediately after. Every look after that walks `states`, so a caller
        // can model "still building, still building, active" — the winner finishing its work.
        if (looked === 0) {
          looked++;
          throw new Error("404 snapshot not found");
        }
        const state = states[Math.min(looked++ - 1, states.length - 1)]!;
        return { id: `id-${name}`, name, state };
      },
      async create(params: any) {
        calls.push({ op: "create", name: params.name });
        throw new Error("Snapshot with name \"" + params.name + "\" already exists for this organization");
      },
      async activate(snap: any) {
        calls.push({ op: "activate", name: snap.name });
        return { ...snap, state: "active" };
      },
      async delete(snap: any) {
        calls.push({ op: "delete", name: snap.name });
      },
    },
  };
}

test("snapshot: losing the create race waits for the winner instead of deleting its build", async () => {
  const client = racingClient("building", "building", "active");
  const name = await ensureSnapshot({ client, ImageCtor: FakeImage as any, waitPollMs: 1 });

  assert.equal(name, snapshotName());
  assert.equal(
    client.calls.some((c) => c.op === "delete"),
    false,
    "the loser deleted the snapshot the winner was still building — this is the production race",
  );
});

test("snapshot: a race lost to an ALREADY ACTIVE snapshot is just a hit", async () => {
  // The tightest version of the window: the other replica finished between our get and our create.
  // Deleting a perfectly good active snapshot and rebuilding it is the same bug at a different tick.
  const client = racingClient("active");
  assert.equal(await ensureSnapshot({ client, ImageCtor: FakeImage as any }), snapshotName());
  assert.equal(client.calls.some((c) => c.op === "delete"), false, "an ACTIVE snapshot was deleted");
});

test("snapshot: a genuinely failed record is still deleted and rebuilt", async () => {
  /*
    THE OTHER HALF, and it must not regress. A snapshot left in `error` by a transient registry
    failure has to be recoverable, or one bad build permanently poisons a name — and that name is the
    `operate` shape's image, so every browser job in the product would be unable to start with no fix
    but deleting a snapshot by hand in somebody else's console.
  */
  const client = fakeClient({ states: ["error"], createFirstError: new Error("already exists"), createState: "active" });
  assert.equal(await ensureSnapshot({ client, ImageCtor: FakeImage as any, freeNamePollMs: 1 }), snapshotName());
  assert.ok(client.calls.some((c) => c.op === "delete"), "a failed snapshot is no longer recoverable");
});
