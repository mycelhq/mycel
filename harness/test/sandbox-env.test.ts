/**
 * Sandbox environment leakage audit.
 *
 * Requirement: `printenv` inside an OpenCode/Daytona sandbox must not reveal
 * SUPABASE_DB_URL, LITELLM_MASTER_KEY, STRIPE_SECRET_KEY (or the other harness secrets).
 *
 * LocalSandbox is the DEV backend and shares the host kernel, but it still builds the agent
 * process env through `minimalSandboxEnv` — the same allowlist Daytona gets via an empty
 * `envVars` default (never `process.env`). This test plants the forbidden names on the harness
 * process and asserts `printenv` inside a LocalSandbox does not echo any of them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LocalSandbox,
  SANDBOX_FORBIDDEN_ENV,
  minimalSandboxEnv,
} from "../src/sandbox";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

test("minimalSandboxEnv is an allowlist, not a copy of process.env", () => {
  const planted: Record<string, string | undefined> = {};
  for (const k of SANDBOX_FORBIDDEN_ENV) {
    planted[k] = process.env[k];
    process.env[k] = `LEAK-${k}-SECRET`;
  }
  try {
    const env = minimalSandboxEnv("/tmp/mycel-sbx-test");
    assert.equal(env.HOME, "/tmp/mycel-sbx-test");
    for (const k of SANDBOX_FORBIDDEN_ENV) {
      assert.equal(env[k], undefined, `${k} leaked into the sandbox env object`);
    }
    // And nothing else from the harness sneaks in via a spread.
    assert.equal(env.MYCEL_DATABASE_URL, undefined);
    assert.equal(Object.keys(env).every((k) =>
      ["HOME", "PATH", "LANG", "LC_ALL", "TERM", "TMPDIR", "SHELL", "TZ"].includes(k),
    ), true, `unexpected keys: ${Object.keys(env).join(",")}`);
  } finally {
    for (const k of SANDBOX_FORBIDDEN_ENV) {
      if (planted[k] === undefined) delete process.env[k];
      else process.env[k] = planted[k];
    }
  }
});

test("printenv inside LocalSandbox does not reveal harness secrets", async () => {
  const planted: Record<string, string | undefined> = {};
  for (const k of ["SUPABASE_DB_URL", "LITELLM_MASTER_KEY", "STRIPE_SECRET_KEY"] as const) {
    planted[k] = process.env[k];
    process.env[k] = `PRINTENV-LEAK-${k}`;
  }
  // Also plant the Mycel-prefixed spellings the kernel actually uses.
  planted.MYCEL_LITELLM_MASTER_KEY = process.env.MYCEL_LITELLM_MASTER_KEY;
  process.env.MYCEL_LITELLM_MASTER_KEY = "PRINTENV-LEAK-MYCEL_LITELLM_MASTER_KEY";
  planted.MYCEL_DATABASE_URL = process.env.MYCEL_DATABASE_URL;
  process.env.MYCEL_DATABASE_URL = "postgres://leak:leak@localhost/leak";

  const sbx = new LocalSandbox();
  try {
    const r = await sbx.exec("printenv");
    assert.equal(r.code, 0, r.stderr);
    const out = `${r.stdout}\n${r.stderr}`;
    for (const secret of [
      "SUPABASE_DB_URL",
      "LITELLM_MASTER_KEY",
      "STRIPE_SECRET_KEY",
      "MYCEL_LITELLM_MASTER_KEY",
      "MYCEL_DATABASE_URL",
      "PRINTENV-LEAK",
      "postgres://leak",
    ]) {
      assert.ok(!out.includes(secret), `printenv leaked ${secret}`);
    }
  } finally {
    await sbx.destroy();
    for (const [k, v] of Object.entries(planted)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("Daytona acquire defaults to empty envVars — never spreads process.env", () => {
  // Daytona is not runnable in CI without an API key; the source is the contract.
  const src = readFileSync(join(ROOT, "sandbox.ts"), "utf8");
  assert.match(src, /envVars:\s*opts\.envVars\s*\?\?\s*\{\}/);
  assert.doesNotMatch(
    src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, ""),
    /envVars:\s*\{[^}]*\.\.\.process\.env/,
    "Daytona must not inherit the harness process environment",
  );
  assert.match(src, /export function minimalSandboxEnv/);
  assert.match(src, /SANDBOX_FORBIDDEN_ENV/);
});

/**
 * ═══ AND NOT IN THE PROCESS TABLE EITHER ═══
 *
 * The allowlist above keeps harness secrets out of the sandbox's ENVIRONMENT. It says nothing
 * about the ones we deliberately hand the agent — the provider key, the gate token, the server
 * password — and those were interpolated straight into the `spawn` command string. Seen in plain
 * `ps aux` on the host during a real run:
 *
 *     bash -lc OPENAI_API_KEY='sk-proj-…' OPENCODE_SERVER_PASSWORD='966c…' opencode serve …
 *
 * `ps` is world-readable, so this was the provider key published to every process on the box. The
 * fix hands them over in a 0600 file that is sourced and deleted before opencode is exec'd; this
 * asserts the launch line never carries a value again.
 */
test("the opencode launch line sources its secrets and never spells them", () => {
  const runtime = readFileSync(join(ROOT, "runtime.ts"), "utf8");

  // The spawn argument itself.
  const spawn = runtime.match(/sandbox\.spawn\(\s*`([^`]*)`/);
  assert.ok(spawn, "could not find the opencode spawn call");
  const line = spawn[1];
  assert.ok(/\$\{envInline\}/.test(line), "the launch line no longer interpolates envInline");
  assert.ok(!/API_KEY|TOKEN|PASSWORD/i.test(line), `a credential name is in the launch line: ${line}`);

  // And what `envInline` now is: a source-and-delete, not a list of assignments.
  // The template literal's CONTENTS, not the statement — otherwise the `;` that ends the
  // TypeScript line reads as a shell separator and the check below fires on itself.
  const inline = runtime.match(/const envInline = `([^`]*)`/);
  assert.ok(inline, "envInline is gone — if it was renamed, update this test rather than deleting it");
  assert.match(inline[1], /set -a && \. \$\{envFile\}/, "envInline stopped sourcing a file");
  assert.match(inline[1], /rm -f \$\{envFile\}/, "the env file is no longer deleted after sourcing");

  /**
   * `&&`, not `;`. The first version of this used `;`, so when the source failed — it did, because
   * `Sandbox.abs()` strips a leading `/` and the file was written under the sandbox home while the
   * shell read an absolute path — the chain carried on and started opencode with NO environment:
   * "Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured." Loading credentials must
   * abort the launch when it fails, never fall through to a server running without them.
   */
  assert.ok(!/;/.test(inline[1]), `a ';' lets a failed source fall through to an unsecured server: ${inline[1]}`);

  /**
   * And the path must start `~/`, which is the ONLY spelling the three backends agree on:
   * LocalSandbox strips it and joins the sandbox home, Daytona joins `$HOME`, and Docker rewrites
   * it to `root/`. A leading `/` silently relocates the file under the home on Local; a bare
   * relative path lands at filesystem root on Docker. Either way `writeFile` and the shell would be
   * naming different files, which is the bug this test exists for.
   */
  const written = runtime.match(/const envFile = `([^`]*)`/);
  assert.ok(written, "envFile is gone — if renamed, update this test rather than deleting it");
  assert.ok(written[1].startsWith("~/"), `envFile must start "~/" to resolve on all backends, got "${written[1]}"`);
  assert.ok(
    !/Object\.entries\(env\)/.test(inline[1]),
    "envInline is building assignments again — those land in `ps`",
  );
});
