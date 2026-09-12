// Component-library MCPs for a build run — the tests that pin the opt-in, dormant-by-default contract.
// A credential in the sandbox is the one boundary this bends, so "off unless a key is set, and only
// on a build" is a property, not a hope.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildComponentMcpConfig } from "../src/opencode";

test("component-mcp: nothing mounts for a non-build shape, even with a key set", () => {
  assert.equal(buildComponentMcpConfig("decide", { MYCEL_MAGIC_API_KEY: "k" }), undefined);
  assert.equal(buildComponentMcpConfig("classify", { MYCEL_MAGIC_API_KEY: "k" }), undefined);
});

test("component-mcp: a build with no key mounts nothing — the default touches no credential", () => {
  assert.equal(buildComponentMcpConfig("build", {}), undefined);
  assert.equal(buildComponentMcpConfig("build", { MYCEL_MAGIC_API_KEY: "  " }), undefined, "blank is not a key");
});

test("component-mcp: a build with a key mounts Magic as a local stdio server carrying the key", () => {
  const cfg = buildComponentMcpConfig("build", { MYCEL_MAGIC_API_KEY: "secret-key" });
  assert.ok(cfg, "configured");
  const magic = cfg.servers.magic as { type: string; command: string[]; environment: Record<string, string>; enabled: boolean };
  assert.equal(magic.type, "local");
  assert.deepEqual(magic.command, ["npx", "-y", "@21st-dev/magic@latest"]);
  assert.equal(magic.environment.API_KEY, "secret-key");
  assert.equal(magic.enabled, true);
});
