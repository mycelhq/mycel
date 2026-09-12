// THE BUG CLASS THIS PREVENTS, which has now shipped twice.
//
// `initBillingStore()` existed, was reachable from the test suite and from nowhere else, and a
// deployment with a database configured still kept every invoice in a Map — money, discovered weeks
// later. It was fixed by adding one line to index.ts.
//
// Then `initBatchStore` did the same thing with a worse loss. `batches.ts` said "Postgres backing
// can swap this later the same way DomainStore does" and `setBatchStore` was never called from
// anywhere, so the in-memory map WAS the production store. The first real fan-out spawned twelve
// children, sixteen runs succeeded, and the parent sat in `awaiting_batch` for two hours because
// the batch died with the process that made it. Nothing errored. Nothing logged.
//
// Both were one missing line in one file, invisible to every other test, and found only by running
// the product in production. So the test is not about batches or billing — it is about the SHAPE:
// a store that can be durable, whose init nothing calls, silently keeps its in-memory fallback.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SRC = new URL("../src/", import.meta.url).pathname;

/** Init functions that are not boot-time store setup, with the reason each is exempt. */
const NOT_A_STORE: Record<string, string> = {
  initBatchSchema: "called by PgBatchStore.connect, not at boot",
  initiateConnection: "an OAuth flow, not a store",
  initQueue: "called at boot, but from the server section rather than the store block",
};

test("every durable store's init is actually called at boot", () => {
  const index = readFileSync(join(SRC, "index.ts"), "utf8");

  const declared = new Set<string>();
  for (const file of readdirSync(SRC)) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
    const src = readFileSync(join(SRC, file), "utf8");
    for (const m of src.matchAll(/export async function (init[A-Za-z]+)\s*\(/g)) {
      declared.add(m[1]!);
    }
  }

  assert.ok(declared.size > 5, "the scan found almost nothing — the regex has drifted from the code");

  const missing = [...declared].filter((name) => !NOT_A_STORE[name] && !index.includes(name));
  assert.deepEqual(
    missing,
    [],
    `these init functions exist but nothing calls them at boot, so their in-memory fallback IS the ` +
      `production store: ${missing.join(", ")}. Add the call to index.ts, or list it in NOT_A_STORE ` +
      `with the reason it is exempt.`,
  );
});

test("no store is left as a bare in-memory default with no way to make it durable", () => {
  // The other half of the shape: a module that ships an InMemoryXStore and a module-level `let`,
  // but no `init` at all, cannot be made durable without someone noticing this file.
  const offenders: string[] = [];
  for (const file of readdirSync(SRC)) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts") || file.endsWith(".pg.ts")) continue;
    const src = readFileSync(join(SRC, file), "utf8");
    const hasInMemoryDefault = /^let \w+(: \w+)? = new InMemory/m.test(src);
    if (!hasInMemoryDefault) continue;
    if (!/export async function init[A-Za-z]+\s*\(/.test(src)) offenders.push(file);
  }
  assert.deepEqual(
    offenders,
    [],
    `these modules default to an in-memory store and expose no init, so they can never be durable: ` +
      `${offenders.join(", ")}`,
  );
});

// THE SAME BUG CLASS, ONE LEVEL UP: a background loop nothing starts.
//
// The test above catches a durable store whose `init` boot forgot. It could not catch
// `starvation.ts`, which shipped complete — a documented, tested watchdog for a queue that stops
// draining while the health check stays green — and was never started by anything. So the mechanism
// written to catch a silent failure was itself silently absent, and the file's mere presence read as
// evidence the case was covered.
//
// That is worse than the store bugs, because the whole point of a watchdog is that nothing else is
// watching. Nobody would have noticed until a founder watched "queued" for a day.
//
// The discriminator is `setInterval`, not the `start` prefix. `startChase`, `startNudge`,
// `startReceipt` and `startJoin` are per-entity actions a route calls and must NOT be at boot; a
// function that arms a repeating timer and hands back a `stop()` is a daemon, and a daemon nothing
// starts is dead code wearing a safety mechanism's name.
test("every background loop is actually started at boot", () => {
  const index = readFileSync(join(SRC, "index.ts"), "utf8");

  /**
   * A function's region: from its declaration to the next top-level `export`, or end of file.
   *
   * NOT brace matching from the first `{`. A multi-line signature returning an object type —
   * `): { stop(): void; tick(): Promise<X> } {` — has its return type as the first brace, so a
   * matcher that trusted it read the TYPE as the body, found no `setInterval` in it, and quietly
   * concluded there was one daemon in the codebase. Under-reporting is the one failure mode this
   * test cannot afford: it would pass while covering nothing.
   */
  const regionOf = (src: string, from: number): string => {
    const next = src.slice(from).search(/^export /m);
    return next < 0 ? src.slice(from) : src.slice(from, from + next);
  };

  const daemons: string[] = [];
  for (const file of readdirSync(SRC)) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
    const src = readFileSync(join(SRC, file), "utf8");
    for (const m of src.matchAll(/^export (?:async )?function (start[A-Za-z]+)\s*\(/gm)) {
      const body = regionOf(src, m.index! + m[0].length);
      // Arms a repeating timer AND hands back a way to stop it. Both, because a one-shot
      // `setTimeout` helper is not a daemon and a handle with no timer is not a loop.
      if (/\bsetInterval\s*\(/.test(body) && /\bstop\s*[(:]/.test(body)) daemons.push(m[1]!);
    }
  }

  assert.ok(daemons.length >= 3, `the scan found ${daemons.length} daemons — the matcher has drifted`);

  /**
   * IMPORTS STRIPPED, AND A CALL REQUIRED.
   *
   * The first version of this asked `index.includes(name)`, which the `import { startStarvationSweep }`
   * line satisfies on its own — so deleting the actual call left the test green. A check that an
   * unwired daemon passes is worse than no check, because it is the reason nobody looks again.
   * Verified by deleting the call and watching this fail before it was allowed to pass.
   */
  const calls = index
    .split("\n")
    .filter((l) => !/^\s*import\b/.test(l))
    .join("\n");
  const missing = daemons.filter((name) => !new RegExp(`\\b${name}\\s*\\(`).test(calls));
  assert.deepEqual(
    missing,
    [],
    `these arm a setInterval and return a stop() handle, and index.ts never calls them — ` +
      `a background loop nothing starts is dead code wearing a safety mechanism's name: ${missing.join(", ")}`,
  );

  // Started is half of it. A daemon that is never stopped keeps a timer alive across shutdown and
  // turns a clean deploy into a hung process — `scheduler.stop()` and `deployReconciler.stop()` are
  // in the shutdown path precisely because of that, and a new one must join them.
  const shutdown = index.slice(index.indexOf("async function shutdown"));
  const unstopped = daemons.filter((name) => {
    const decl = new RegExp(`const (\\w+)\\s*=\\s*${name}\\(`).exec(calls);
    return decl ? !new RegExp(`\\b${decl[1]}\\.stop\\(`).test(shutdown) : false;
  });
  assert.deepEqual(unstopped, [], `started at boot and never stopped on shutdown: ${unstopped.join(", ")}`);
});
