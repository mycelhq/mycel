// THE IMAGE SPEC HAS TO BE ABLE TO BUILD ITSELF.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// THE OUTAGE THIS EXISTS TO PREVENT
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// 2026-08-29. A browser-use layer added to this spec ran `python3 -m venv`. The base image
// `node:22-bookworm-slim` ships a python3 with no `ensurepip`, Debian splits that into
// `python3-venv`, and the apt line installed `python3` alone — which had always been enough, because
// nothing in the image had ever needed a venv before.
//
// The layer failed, so the WHOLE snapshot went to `error`. The kernel could not find a usable one at
// boot, tried to delete and rebuild, raced its own delete into "already exists for this
// organization", and a duplicate preflight answered that with `process.exit(1)`. Eighty-second crash
// loop, API down, `ECONNREFUSED` on every request to app.mycelai.dev.
//
// One missing apt package, in one optional capability, took the product down — and nothing in the
// test suite could have known, because the spec was only ever validated by building it against a
// provider.
//
// These are cheap structural checks over the spec itself. They cannot prove the image builds; they
// CAN prove that every tool a command invokes has something installing it, which is the class the
// outage came from.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sandboxImageSpec, snapshotName, specDigest } from "../src/sandbox.snapshot";

/** The whole shell of the build, as one string. */
const script = (): string => sandboxImageSpec().commands.join("\n");

/** The `apt-get install` lines, which are the only thing that puts a Debian package in the image. */
function aptPackages(): Set<string> {
  const out = new Set<string>();
  for (const m of script().matchAll(/apt-get install[^\n&|;]*/g)) {
    for (const word of m[0].split(/\s+/)) {
      if (!word || word.startsWith("-") || word === "apt-get" || word === "install") continue;
      out.add(word);
    }
  }
  return out;
}

test("every tool the build invokes is installed by the build", () => {
  /**
   * The mapping is deliberately explicit rather than inferred. A regex that guessed at "command →
   * package" would be wrong in both directions — `node` and `npm` come from the BASE IMAGE, not from
   * apt — and a check that is sometimes wrong is one somebody deletes the first time it fires
   * spuriously.
   *
   * `null` means "the base image provides this". Anything else must appear in an apt line.
   */
  const NEEDS: Record<string, string | null> = {
    "python3 -m venv": "python3-venv",
    curl: "curl",
    git: "git",
    rg: "ripgrep",
    node: null,
    npm: null,
    tar: null,
  };

  const s = script();
  const installed = aptPackages();
  for (const [invocation, pkg] of Object.entries(NEEDS)) {
    if (!s.includes(invocation)) continue; // not used by this spec — nothing to require
    if (pkg === null) continue; // base image
    assert.ok(
      installed.has(pkg),
      `the build runs \`${invocation}\` but nothing installs \`${pkg}\`. This is the exact shape of ` +
        `the 2026-08-29 outage: a layer that needs a package the apt line never had, which fails the ` +
        `WHOLE snapshot and leaves the kernel with no usable sandbox.`,
    );
  }
});

test("python3-venv specifically, because ensurepip is not in python3 on Debian", () => {
  // Named on its own as well as by the table above, so the reason survives a refactor of the table.
  const s = script();
  if (!s.includes("python3 -m venv")) return; // the layer was removed; nothing to hold
  assert.match(
    s,
    /apt-get install[^\n]*\bpython3-venv\b/,
    "`python3 -m venv` fails on node:22-bookworm-slim with 'ensurepip is not available' unless " +
      "python3-venv is installed. It is a separate Debian package and the error names it.",
  );
});

test("the build fails loudly rather than shipping a half-made image", () => {
  // Every multi-step command uses `set -eux`, so a 404 on a tarball or a failed pip fails the build
  // instead of leaving a binary that does not exist and an image that looks fine.
  for (const cmd of sandboxImageSpec().commands) {
    if (!cmd.includes(";")) continue; // single-statement lines cannot half-succeed
    assert.match(
      cmd,
      /set -eux?/,
      `a multi-step build command must "set -e" or a failing step leaves a broken image that ` +
        `reports success: ${cmd.slice(0, 90)}…`,
    );
  }
});

test("the snapshot name is derived from the spec, so a fix cannot collide with a broken build", () => {
  // The rebuild after the outage raced its own delete and came back "already exists for this
  // organization". A digest-named snapshot sidesteps that: changing the spec changes the name, so a
  // fixed image never contends with the errored one still in the provider's account.
  const digest = specDigest(sandboxImageSpec());
  assert.ok(snapshotName().includes(digest), "the name must carry the spec's digest");
  assert.match(snapshotName(), /^mycel-sandbox-[0-9a-f]{12}$/);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// ONE PREFLIGHT, ONE POLICY
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// The other half of the same outage. `index.ts` had TWO `sandboxPreflight` calls after `serve`, with
// opposite policies: one exited on any problem, the other logged, kept serving, and exited only
// behind `MYCEL_EXIT_ON_PREFLIGHT_FAILURE=1` — carrying the reasoning "so an external Daytona blip
// cannot take down the entire kernel fleet and campaigns."
//
// Both were true. Only the first ever ran, so the second was unreachable in exactly the case it was
// written for, and a provider-side snapshot state took the whole API down.
//
// Suna names the general form in `prompt-dedupe.ts` after being bitten by it: "Keep this as the ONE
// list" — two predicates answering one question means adding to one silently opts out of the other.

test("the boot path asks the sandbox question once, and answers it one way", () => {
  const src = readFileSync(join(process.cwd(), "harness/src/index.ts"), "utf8");
  const afterServe = src.slice(src.indexOf("const server = serve("));

  const calls = [...afterServe.matchAll(/await sandboxPreflight\(/g)].length;
  assert.equal(
    calls,
    1,
    `the boot path calls sandboxPreflight ${calls} times after the listener starts. Two calls means ` +
      `two policies for one question, and the one that runs is whichever is written first — which is ` +
      `how a Daytona snapshot in 'error' state took app.mycelai.dev down on 2026-08-29.`,
  );
});

test("a sandbox problem does not kill the listener unless somebody asks for that", () => {
  // The kernel serves the API as well as the worker. A snapshot that cannot build stops no HTTP
  // request, and exiting for one converts somebody else's degradation into our total failure. The
  // escape hatch stays, because a deployment that WANTS to fail closed should be able to.
  const src = readFileSync(join(process.cwd(), "harness/src/index.ts"), "utf8");
  const afterServe = src.slice(src.indexOf("const server = serve("));
  const block = afterServe.slice(afterServe.indexOf("await sandboxPreflight("));
  const exitWindow = block.slice(0, 900);
  if (/process\.exit\(1\)/.test(exitWindow)) {
    assert.match(
      exitWindow,
      /MYCEL_EXIT_ON_PREFLIGHT_FAILURE/,
      "an exit on a sandbox preflight failure must be opt-in — an unconditional one is the crash " +
        "loop that took the API down with a provider's snapshot.",
    );
  }
});

test("a backend that can never work still refuses to start", () => {
  // The original argument survives and is still right: with the SDK missing, the process "started,
  // reported healthy to the load balancer, accepted tasks and failed every one at sandbox creation.
  // The fleet was green and the product could do no work whatsoever." That is a DEPLOYMENT error and
  // it should roll back. `sandboxReachability` runs BEFORE the listener and still exits.
  const src = readFileSync(join(process.cwd(), "harness/src/index.ts"), "utf8");
  const beforeServe = src.slice(0, src.indexOf("const server = serve("));
  assert.match(beforeServe, /sandboxReachability\(/, "the config check runs before the listener");
  assert.match(beforeServe, /process\.exit\(1\)/, "and a misconfigured backend still refuses to boot");
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE DEMO'S CLIENTS MUST NOT BE REACHABLE
// ─────────────────────────────────────────────────────────────────────────────────────────────────
//
// `demo.mycelai.dev` hands any visitor a full owner session — its own route says so: "an ordinary
// session for an ordinary org, no demo mode inside the product, no branch in the app". The seeded
// clients carried REAL addresses at REAL registered domains: admin@fairmont.com, ops@ridgeline.com,
// hello@willow.co.
//
// It is inert today only because that org has no connections, so every send fails with "this
// business has no mailbox connected". That is an accident of setup, not a safeguard. Connect one
// mailbox to make the demo more convincing and a stranger clicking Approve mails a dental practice.

test("no seeded demo client has a routable address", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "scripts", "seed-tenant.ts"), "utf8");
  const handles = [...src.matchAll(/handle:\s*"([^"]+)"/g)].map((m) => m[1]!);
  assert.ok(handles.length >= 8, `expected the seeded roster, found ${handles.length} handles`);
  for (const h of handles) {
    const tld = h.split(".").pop()!;
    assert.ok(
      // RFC 2606 reserves these and guarantees they never resolve. `.example` is excluded on
      // purpose: ship-checks.ts lists it as forbidden PLACEHOLDER vocabulary, so a deliverable
      // quoting one would be held as unfinished.
      ["invalid", "test", "localhost"].includes(tld),
      `${h} is deliverable mail — a demo visitor with a connected mailbox could reach a real inbox`,
    );
  }
});

test("the logos still come from real domains", () => {
  // The reason the addresses were real in the first place: Clearbit renders actual company marks
  // against `domain`, and a roster of grey initials does not read as a business. Splitting the two
  // fields is what lets both be true, so this asserts the half that was worth keeping.
  const src = readFileSync(join(import.meta.dirname, "..", "scripts", "seed-tenant.ts"), "utf8");
  const domains = [...src.matchAll(/domain:\s*"([^"]+)"/g)].map((m) => m[1]!);
  assert.ok(domains.length >= 8, "the seeded roster lost its domains");
  for (const d of domains) {
    assert.ok(!d.endsWith(".invalid"), `${d} is unroutable — Clearbit will return nothing and the roster goes grey`);
  }
});
