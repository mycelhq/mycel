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
