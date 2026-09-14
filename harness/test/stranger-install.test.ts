// Regressions from a real stranger-install walkthrough: someone cloned the published kernel, read
// its own README, and followed it. Every test below names the thing that actually went wrong on
// that install. They are deliberately blunt — several assert on source text, because the bugs were
// not in the logic but in the WIRING: correct, documented, well-commented code that nothing called.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TIER_MODELS } from "../src/models";
import { providerAdvisories, runtimeAdvisories } from "../src/preflight";
import { PROVIDERS, shortestPath } from "../src/gtm/providers";
import { between } from "./helpers/anchor";
import { KERNEL_VERSION } from "../src/version";
import type { MycelConfig } from "../src/config";

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const INDEX = read("../src/index.ts");
const SETUP = read("../../setup.sh");
const README = read("../../README.md");
const AGENTS = read("../../AGENTS.md");
const PKG = JSON.parse(read("../../package.json")) as { version: string; scripts: Record<string, string>; dependencies: Record<string, string> };
const SEED = read("../scripts/seed-demo.ts");

const cfg = (over: Partial<MycelConfig> = {}): MycelConfig =>
  ({ sandboxBackend: "local", model: "openai/gpt-5.6-luna", runtime: "opencode", proxyMode: false, ...over }) as MycelConfig;

test("B1 stranger-install: runtimeAdvisories is actually CALLED at boot, not just exported", () => {
  // The bug: preflight.ts existed, was documented in the README as something "the kernel says at
  // boot", and was referenced from nowhere. A dev boot printed no advisory; the first task then hung
  // 60s and died with `opencode failed to start (no log)`. A silent failure, which is a stated
  // non-negotiable for this project.
  // Matched on the SYMBOL rather than the whole import line: adding a second export from preflight
  // broke this assertion while the thing it guards was still perfectly wired.
  assert.match(INDEX, /import \{[^}]*\bruntimeAdvisories\b[^}]*\} from "\.\/preflight"/);
  assert.match(INDEX, /runtimeAdvisories\(cfg\)/, "index.ts must call runtimeAdvisories at boot");

  // And it must not exit the way sandboxPreflight does: `npm run demo` is the one README path that
  // deliberately needs no binary and no key.
  const call = between(INDEX, "runtimeAdvisories(cfg)");
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
  /**
   * ANCHORED ON THE CODE, NOT ON THE HEADING.
   *
   * This sliced from the literal "### A business to look at", so renaming that heading made the
   * slice start at -1 and the whole assertion silently move to a different part of the file. A
   * test pinned to prose fails when the prose is edited and says nothing about the thing it guards.
   * The login call is what this test is actually about, so the window is built around that.
   */
  const anchor = README.indexOf("/v1/auth/login");
  assert.ok(anchor > 0, "the README no longer shows a login call — that IS the thing this guards");
  const showcase = README.slice(README.lastIndexOf("\n## ", anchor), README.indexOf("## What Mycel provides"));

  /**
   * DERIVED FROM THE SEED, because this test pinned the credential rather than checking it.
   *
   * It asserted the literals `founder@ridgeline.example` and `demo-ridgeline`, which is a test that
   * only ever fails when the README changes — never when the SEED does. The seed was renamed from a
   * British bookkeeper to Sightline Research, the README kept the old login, and this guard stayed
   * green over a documented command that answers `{"error":"invalid credentials"}`. Found by
   * running it: it is the first interactive thing in the README.
   */
  const seedEmail = /MYCEL_OWNER_EMAIL=(\S+)/.exec(PKG.scripts["demo:seed"])?.[1];
  const seedPassword = /MYCEL_OWNER_PASSWORD=(\S+)/.exec(PKG.scripts["demo:seed"])?.[1];
  const seedBusiness = /const BUSINESS_NAME = "([^"]+)"/.exec(SEED)?.[1];
  assert.ok(seedEmail && seedPassword && seedBusiness, "could not read the seed's own identity");
  assert.ok(showcase.includes(seedEmail!), `the README logs in as somebody the seed does not create (${seedEmail})`);
  assert.ok(showcase.includes(seedPassword!), "the README's password is not the one the seed is booted with");
  assert.ok(showcase.includes(seedBusiness!), `the README selects a project the seed does not build (${seedBusiness})`);
  assert.ok(!/ridgeline/i.test(README), "the old seed's names must not come back anywhere in the README");
  assert.match(showcase, /auth\/login/);
  assert.match(showcase, /x-mycel-project/i, "project scope is required and never defaulted");
  assert.ok(
    !/curl -s localhost:4000\/v1\/moves -H "authorization: Bearer mycel_demo_key"/.test(showcase),
    "the credential that returns [] must not be presented as the way to read the seed",
  );
  // And it must explain WHY the demo key returns [], so nobody reads isolation as a broken seed.
  assert.match(showcase, /different tenant/i);

  // The seed itself hands over the working call, so nothing has to be retyped.
  const report = between(SEED, "✓ Seeded");
  // Matched on the INTERPOLATION, not on a variable name. This asserted `${PROJECT}` and broke the
  // day the seed renamed its local to `s.project` — a test that fails when nothing a stranger sees
  // has changed is a test that trains people to edit tests. What matters is that the report prints
  // a project id at all, because the next line tells them to paste it into a header.
  assert.match(report, /\$\{[^}]*project[^}]*\}/i, "the seed must print the project id it wrote into");
  assert.match(report, /x-mycel-project/i);
  assert.match(report, /auth\/login/);
});

test("B7 stranger-install: PORT and MYCEL_URL are documented, and reachable from the README", () => {
  // Both were load-bearing and undocumented: MYCEL_URL is the only way to point demo:seed at a
  // kernel that is not on 4000, and it was discoverable only by reading seed-demo.ts.
  //
  // The table moved to AGENTS.md when the README was cut back to what a human reads first. That is
  // a move, not a deletion, so this asserts what it always meant — DISCOVERABLE — rather than the
  // heading it used to sit under. Both halves are load-bearing: documented somewhere nobody is
  // pointed to is the same as undocumented.
  const table = between(AGENTS, "## Environment", "## Layout");
  assert.match(table, /\| `PORT` \|/);
  assert.match(table, /\| `MYCEL_URL` \|/);
  assert.match(README, /\(\.\/AGENTS\.md\)/, "the README must link to it, or it is not discoverable");
});


test("B1 stranger-install: the provider slots are said at boot, not only at an endpoint", () => {
  /**
   * The same shape of bug as the one above, found the same way — by cloning the published tree and
   * booting it. `GET /v1/gtm/availability` answers "what is on, and what turns the rest on"
   * completely, and it sits behind a bearer token at a path nobody guesses, in a product whose
   * first five minutes are in a terminal. Boot said nothing about it existing.
   */
  assert.match(INDEX, /import \{[^}]*\bproviderAdvisories\b[^}]*\} from "\.\/preflight"/);
  assert.match(INDEX, /providerAdvisories\(\)/, "index.ts must call providerAdvisories at boot");

  // And it is NOT a warning. Every ⚠ on this screen is something that will go wrong; a capability
  // that is off is not, because the whole GTM path runs on a LinkedIn session with no key at all.
  // Marking it would teach a new user that a correct install is broken.
  //
  // Asserted on the OUTPUT, not on a slice of the source. The first version of this took 300
  // characters after the call site, which ran straight into the next block's ⚠ and failed on a file
  // that was entirely correct — the same brittle-window mistake this repo has made before.
  const said = providerAdvisories({}).join("\n");
  assert.ok(said.length > 0, "with no keys at all there is something to say");
  assert.ok(!said.includes("⚠"), "an optional capability being off is not a warning");
  assert.match(said, /need no key at all/, "the reassurance is the point, not the list");
  assert.match(said, /\/v1\/gtm\/availability/, "and it points at the place with the full answer");
});

test("B1 stranger-install: a fully configured boot says nothing about providers", () => {
  // An operator who has set their keys does not need them recited on every restart, and a banner
  // that prints the same paragraph forever is one people stop reading — which would cost the
  // advisories above their audience too.
  const allOn = Object.fromEntries(
    Object.values(PROVIDERS).map((opts) => [shortestPath(opts)!.env, "k"]),
  );
  assert.deepEqual(providerAdvisories(allOn), []);
});


test("B7 stranger-install: the seed does not promise a UI this repo does not contain", () => {
  /**
   * "There is **no UI in this repository** — Mycel is headless" is in the README, and `demo:seed`
   * closed by printing seven links into `http://localhost:3000` plus "Sign in at
   * http://localhost:3000". On a fresh clone every one of those refuses the connection, and the
   * available conclusion is that the seed failed.
   *
   * Same shape as the `mycel_demo_key` bug this file already guards, in a new place: the seed
   * worked and its own closing report was the thing saying otherwise.
   */
  assert.match(SEED, /async function consoleIsUp\(\)/, "the seed must ask before it links");
  assert.match(SEED, /await consoleIsUp\(\)/, "and the report must actually branch on the answer");

  const report = between(SEED, "✓ Seeded");
  assert.ok(
    !/Sign in at http:\/\/localhost:3000/.test(report),
    "a hardcoded console URL in the report is the unconditional promise this guards against",
  );
  assert.match(report, /THERE IS NO UI IN THIS REPO/, "the no-console branch has to say so plainly");
  assert.match(report, /github\.com\/mycelhq\/console/, "and point at where the console actually is");

  // The probe must not be able to take the seed down after the work is committed.
  // Bounded on the function that follows it, not on a character count — see `after` in the helper.
  const probe = between(SEED, "async function consoleIsUp()", "\n/**");
  assert.match(probe, /try \{/, "a diagnostic must not throw");
  assert.match(probe, /AbortSignal\.timeout/, "and must not hang waiting for a port nobody is on");
});
