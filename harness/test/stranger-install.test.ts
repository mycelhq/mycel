// Regressions from a real stranger-install walkthrough: someone cloned the published kernel, read
// its own README, and followed it. Every test below names the thing that actually went wrong on
// that install. They are deliberately blunt — several assert on source text, because the bugs were
// not in the logic but in the WIRING: correct, documented, well-commented code that nothing called.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TIER_MODELS } from "../src/models";
import { runtimeAdvisories } from "../src/preflight";
import { KERNEL_VERSION } from "../src/version";
import type { MycelConfig } from "../src/config";

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const INDEX = read("../src/index.ts");
const SETUP = read("../../setup.sh");
const README = read("../../README.md");
const PKG = JSON.parse(read("../../package.json")) as { version: string; scripts: Record<string, string>; dependencies: Record<string, string> };
const SEED = read("../scripts/seed-demo.ts");

const cfg = (over: Partial<MycelConfig> = {}): MycelConfig =>
  ({ sandboxBackend: "local", model: "openai/gpt-5.6-luna", runtime: "opencode", proxyMode: false, ...over }) as MycelConfig;

test("B1 stranger-install: runtimeAdvisories is actually CALLED at boot, not just exported", () => {
  // The bug: preflight.ts existed, was documented in the README as something "the kernel says at
  // boot", and was referenced from nowhere. A dev boot printed no advisory; the first task then hung
  // 60s and died with `opencode failed to start (no log)`. A silent failure, which is a stated
  // non-negotiable for this project.
  assert.match(INDEX, /import \{ runtimeAdvisories \} from "\.\/preflight"/);
  assert.match(INDEX, /runtimeAdvisories\(cfg\)/, "index.ts must call runtimeAdvisories at boot");

  // And it must not exit the way sandboxPreflight does: `npm run demo` is the one README path that
  // deliberately needs no binary and no key.
  const call = INDEX.slice(INDEX.indexOf("runtimeAdvisories(cfg)"));
  assert.ok(
    !/process\.exit/.test(call.slice(0, 400)),
    "runtimeAdvisories must warn, never exit — a kernel with no agent runtime is still legitimate",
  );
});

test("B1 stranger-install: the advisory names the hang AND every way forward", () => {
  // The value is in what is said. A warning that stops naming a remedy has regressed even though it
  // still appears.
  const lines = runtimeAdvisories(cfg(), {} as NodeJS.ProcessEnv).join("\n");
  assert.match(lines, /opencode failed to start/);
  assert.match(lines, /OPENAI_API_KEY is not set/);
  assert.match(lines, /npm run demo/);
  assert.match(lines, /MYCEL_SANDBOX=docker/);

  // The other half of the trap: mock succeeds at everything and writes "[mock]".
  const mock = runtimeAdvisories(cfg({ runtime: "mock" }), {} as NodeJS.ProcessEnv).join("\n");
  assert.match(mock, /\[mock\]/);
  assert.match(mock, /SUCCEED/);

  // A healthy install stays quiet.
  assert.deepEqual(
    runtimeAdvisories(cfg({ sandboxBackend: "docker" }), { OPENAI_API_KEY: "sk-x" } as NodeJS.ProcessEnv),
    [],
  );
});

test("B2 stranger-install: npm run dev/start actually load the .env setup.sh writes", () => {
  // The bug: setup.sh wrote MYCEL_MODEL / the provider key / PORT into .env and nothing read it.
  // .env said MYCEL_MODEL=anthropic/claude-opus-4-8; the boot banner said openai/gpt-5.6-luna. Every
  // answer the installer collected, including the API key, was inert.
  for (const script of ["dev", "start"] as const) {
    assert.match(
      PKG.scripts[script],
      /--env-file-if-exists=\.env/,
      `npm run ${script} must load .env (and must not fail when it is absent)`,
    );
  }
  // No new dependency: Node 22 does this natively.
  assert.ok(!("dotenv" in PKG.dependencies), "dotenv must not be added — node's --env-file does this");
});

test("B3 stranger-install: setup.sh's default model exists in the kernel's own tiers", () => {
  // The bug: the default was `anthropic/claude-opus-4-8` — a model that does not exist, from a
  // vendor none of the tiers use. Accepting it sent someone to buy the wrong company's key.
  const fallback = /DEFAULT_MODEL_FALLBACK="([^"]+)"/.exec(SETUP)?.[1];
  assert.equal(fallback, TIER_MODELS.standard, "setup.sh's fallback default must be the standard tier");
  assert.ok(
    Object.values(TIER_MODELS).includes(fallback ?? ""),
    "setup.sh's default must be one of TIER_MODELS",
  );
  assert.ok(!SETUP.includes("claude-opus-4-8"), "the nonexistent model must not come back");

  // It is derived from models.ts at run time; the literal above is only the fallback. Prove the
  // extraction still finds the tier, so the two copies cannot drift silently.
  const models = read("../src/models.ts");
  const derived = /MYCEL_MODEL_STANDARD \?\? "([^"]+)"/.exec(models)?.[1];
  assert.equal(derived, TIER_MODELS.standard, "setup.sh's sed extraction must still match models.ts");
});

test("B4 stranger-install: setup.sh says so when it degrades to non-interactive", () => {
  // The bug: the DOCUMENTED install path is `curl … | bash`, i.e. a pipe, so the interactivity test
  // fails on exactly the path we tell people to use. Every prompt answered itself, an empty provider
  // key was written, and it still printed "Mycel is set up."
  const notice = /if \[ -n "\$NONINTERACTIVE" \]; then[\s\S]*?\nfi/.exec(SETUP)?.[0] ?? "";
  assert.match(notice, /non-interactively/i);
  assert.match(notice, /curl … \| bash|curl .* \| bash/);
  assert.match(notice, /no provider key is written/i);
  assert.match(notice, /setup\.sh/, "it must say how to re-run interactively");
  // And the empty key is called out at the moment .env is written.
  assert.match(SETUP, /\[ -n "\$PKEY" \] \|\| warn/);
});

test("B5 stranger-install: the boot banner reads its version from package.json", () => {
  // The bug: the banner hardcoded `v0.1` while package.json said 0.2.0 — and the banner is the
  // string a stranger pastes into a bug report.
  assert.equal(KERNEL_VERSION, PKG.version);
  assert.match(INDEX, /mycel-harness v\$\{KERNEL_VERSION\}/);
  assert.ok(!INDEX.includes("mycel-harness v0.1"), "the hardcoded version must not come back");
});

test("B6 stranger-install: the README's showcase curl uses a credential that can see the seed", () => {
  // The bug: the README said to GET /v1/moves with `mycel_demo_key`, which resolves to its own
  // key-derived project — a different tenant from the one demo:seed writes into. It returned
  // {"moves":[]}, and the README elsewhere pre-frames [] as "nothing seeded", so the only available
  // conclusion was that the seed had failed. Tenant isolation was right; the doc was wrong.
  const showcase = README.slice(README.indexOf("### A business to look at"), README.indexOf("## What Mycel provides"));
  assert.match(showcase, /founder@ridgeline\.example/);
  assert.match(showcase, /demo-ridgeline/);
  assert.match(showcase, /auth\/login/);
  assert.match(showcase, /x-mycel-project/i, "project scope is required and never defaulted");
  assert.ok(
    !/curl -s localhost:4000\/v1\/moves -H "authorization: Bearer mycel_demo_key"/.test(showcase),
    "the credential that returns [] must not be presented as the way to read the seed",
  );
  // And it must explain WHY the demo key returns [], so nobody reads isolation as a broken seed.
  assert.match(showcase, /different tenant/i);

  // The seed itself hands over the working call, so nothing has to be retyped.
  const report = SEED.slice(SEED.indexOf("✓ Seeded"));
  // Matched on the INTERPOLATION, not on a variable name. This asserted `${PROJECT}` and broke the
  // day the seed renamed its local to `s.project` — a test that fails when nothing a stranger sees
  // has changed is a test that trains people to edit tests. What matters is that the report prints
  // a project id at all, because the next line tells them to paste it into a header.
  assert.match(report, /\$\{[^}]*project[^}]*\}/i, "the seed must print the project id it wrote into");
  assert.match(report, /x-mycel-project/i);
  assert.match(report, /auth\/login/);
});

test("B7 stranger-install: PORT and MYCEL_URL are in the README's env table", () => {
  // Both were load-bearing and undocumented: MYCEL_URL is the only way to point demo:seed at a
  // kernel that is not on 4000, and it was discoverable only by reading seed-demo.ts.
  const table = README.slice(README.indexOf("## Configure (env)"), README.indexOf("## Running with no keys"));
  assert.match(table, /\| `PORT` \|/);
  assert.match(table, /\| `MYCEL_URL` \|/);
});
