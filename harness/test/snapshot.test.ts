import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  buildImage,
  ensureSnapshot,
  resetSnapshotCache,
  sandboxImageSpec,
  snapshotName,
  specDigest,
  type SnapshotClientLike,
} from "../src/sandbox.snapshot";

// A stand-in for the SDK's Image builder: same fluent surface, records what it was asked to do.
// Nothing here touches the network — a test that builds a real snapshot would take minutes and
// need an API key, which is precisely the cost `ensureSnapshot` exists to pay only once.
class FakeImage {
  dockerfile = "";
  static base(image: string): FakeImage {
    const i = new FakeImage();
    i.dockerfile = `FROM ${image}\n`;
    return i;
  }
  env(vars: Record<string, string>): FakeImage {
    for (const [k, v] of Object.entries(vars)) this.dockerfile += `ENV ${k}=${v}\n`;
    return this;
  }
  runCommands(...cmds: string[]): FakeImage {
    for (const c of cmds) this.dockerfile += `RUN ${c}\n`;
    return this;
  }
  workdir(dir: string): FakeImage {
    this.dockerfile += `WORKDIR ${dir}\n`;
    return this;
  }
}

interface FakeCall {
  op: "get" | "create" | "activate";
  name: string;
}

function fakeClient(opts: {
  /** Snapshot states the successive `get` calls should report; undefined = not found (throws). */
  states?: (string | undefined)[];
  createState?: string;
}): SnapshotClientLike & { calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  let getN = 0;
  const states = opts.states ?? [undefined];
  return {
    calls,
    snapshot: {
      async get(name: string) {
        calls.push({ op: "get", name });
        const state = states[Math.min(getN++, states.length - 1)];
        if (state === undefined) throw new Error("404 snapshot not found");
        return { id: `id-${name}`, name, state };
      },
      async create(params: any) {
        calls.push({ op: "create", name: params.name });
        return { id: `id-${params.name}`, name: params.name, state: opts.createState ?? "active" };
      },
      async activate(snap: any) {
        calls.push({ op: "activate", name: snap.name });
        return { ...snap, state: "active" };
      },
    },
  };
}

beforeEach(() => resetSnapshotCache());

test("snapshot: the name carries a content hash of the image definition", () => {
  // The whole point of hashing: two different definitions must never share a name, or a bumped
  // opencode version would silently keep serving the old snapshot forever. A name like
  // "mycel-sandbox" would have done exactly that.
  const spec = sandboxImageSpec();
  assert.equal(snapshotName(spec), `mycel-sandbox-${specDigest(spec)}`);
  assert.match(snapshotName(spec), /^mycel-sandbox-[0-9a-f]{12}$/);

  // Deterministic across calls — otherwise every boot would build a new snapshot.
  assert.equal(snapshotName(), snapshotName());

  const bumped = { ...spec, opencodeVersion: "9.9.9" };
  assert.notEqual(specDigest(bumped), specDigest(spec));
  assert.notEqual(snapshotName(bumped), snapshotName(spec));

  // And a change anywhere in the definition, not just the version, moves the name.
  assert.notEqual(specDigest({ ...spec, base: "node:24-bookworm-slim" }), specDigest(spec));
  assert.notEqual(specDigest({ ...spec, commands: [...spec.commands, "RUN true"] }), specDigest(spec));
});

test("snapshot: the image definition contains what a run actually needs", () => {
  // Each of these is a thing a task dies on at runtime with no way to recover on a Daytona runner.
  const df = buildImage(FakeImage).dockerfile as string;
  assert.match(df, /^FROM node:22/m, "a Node runtime");
  assert.match(df, /curl/, "the agent is taught to curl MYCEL_ACTIONS_URL etc.");
  assert.match(df, /\bbash\b/);
  assert.match(df, /opencode-linux-x64/, "the opencode binary is fetched, not assumed");
  assert.match(df, /\/usr\/local\/bin\/opencode/, "…and lands on PATH");
  assert.match(df, /opencode --version/, "…and is verified at build time, not at task time");
  assert.match(df, /WORKDIR \/root/, "HOME is where the harness writes opencode.json");
});

test("snapshot: ensureSnapshot reuses an active snapshot without building", async () => {
  const client = fakeClient({ states: ["active"] });
  const name = await ensureSnapshot({ client, ImageCtor: FakeImage });

  assert.equal(name, snapshotName());
  assert.deepEqual(
    client.calls.map((c) => c.op),
    ["get"],
    "a boot against an already-built snapshot is one cheap GET, no build",
  );
});

test("snapshot: ensureSnapshot builds exactly once, even under concurrent callers", async () => {
  // Preflight and the first task can race, and several tasks can arrive together. A build is
  // minutes long; starting three of them would be three times the wait and three snapshots.
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

  // And a later call is served from cache — no second look at the API at all.
  const before = client.calls.length;
  assert.equal(await ensureSnapshot({ client, ImageCtor: FakeImage }), a);
  assert.equal(client.calls.length, before, "memoised: repeat calls are free");
});

test("snapshot: a snapshot Daytona has deactivated is reactivated, not rebuilt", async () => {
  // Daytona deactivates unused snapshots. The content is identical by construction — the name IS
  // its hash — so rebuilding would be minutes spent to arrive at the same bytes.
  const client = fakeClient({ states: ["inactive"] });
  await ensureSnapshot({ client, ImageCtor: FakeImage });

  assert.deepEqual(
    client.calls.map((c) => c.op),
    ["get", "activate"],
  );
});

test("snapshot: a failed build is not cached as a permanent verdict", async () => {
  // A transient blip at boot must not poison the process for its entire life; the next caller
  // (or the next deploy's retry) has to be able to try again.
  const boom: SnapshotClientLike = {
    snapshot: {
      async get() {
        throw new Error("404");
      },
      async create() {
        throw new Error("registry timeout");
      },
      async activate(s: any) {
        return s;
      },
    },
  };
  await assert.rejects(() => ensureSnapshot({ client: boom, ImageCtor: FakeImage }), /registry timeout/);

  const good = fakeClient({ states: ["active"] });
  assert.equal(await ensureSnapshot({ client: good, ImageCtor: FakeImage }), snapshotName());
});
