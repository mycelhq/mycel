import { test } from "node:test";
import assert from "node:assert/strict";
import { reachableFromOtherHosts } from "../src/config";
import { sandboxReachability } from "../src/sandbox";

/**
 * The boot assertion that turns "the fleet is green and no task can complete" into a failed deploy.
 *
 * Production ran for weeks with MYCEL_SANDBOX=daytona and MYCEL_PUBLIC_URL unset, so the runtime
 * handed every sandbox `http://127.0.0.1:4000` as the address of the harness. Inside a microVM that
 * is the microVM. The kernel booted, answered /health, accepted work, and every task died at its
 * first callback. Nothing on the boot path had an opinion about it, so nothing said so.
 */

test("reachability: loopback and the wildcard address are not addresses a sandbox can dial", () => {
  for (const u of [
    "http://127.0.0.1:4000",
    "http://127.0.0.2:4000", // the whole 127/8 block, not just .1
    "https://localhost/v1",
    "http://api.localhost:4000",
    "http://[::1]:4000",
    "http://0.0.0.0:4000",
    "http://[::]:4000",
  ]) {
    assert.equal(reachableFromOtherHosts(u), false, u);
  }
});

test("reachability: blank and malformed values count as unreachable, not as 'probably fine'", () => {
  // A secret store handing back an empty string is a normal way to deploy a half-configured stack,
  // and "" sails past the `??` default in loadConfig — the callback URLs become bare paths.
  for (const u of ["", "   ", "sandbox.mycelai.dev", "not a url"]) {
    assert.equal(reachableFromOtherHosts(u), false, JSON.stringify(u));
  }
});

test("reachability: a real hostname, a private one, and a tunnel all pass", () => {
  // Deliberately permissive. A self-hosted install may point the sandbox at internal DNS, a
  // Tailscale name, or an ngrok tunnel; a whitelist of "public https hostnames" would refuse every
  // legitimate one of those and teach people to unset the check.
  for (const u of [
    "https://sandbox.mycelai.dev",
    "http://host.docker.internal:4000",
    "https://kernel.internal.example:4000/",
    "https://abc123.ngrok.app",
    "http://10.0.3.11:4000",
  ]) {
    assert.equal(reachableFromOtherHosts(u), true, u);
  }
});

test("boot assertion: daytona + a loopback public URL refuses to start, and says why", () => {
  const problem = sandboxReachability("daytona", "http://127.0.0.1:4000");
  assert.ok(problem, "daytona with a loopback callback URL must be fatal");
  // The message has to name the variable and the fix, because the person reading it is looking at
  // a crash-looping task and a health check that used to be green.
  assert.match(problem!, /MYCEL_PUBLIC_URL/);
  assert.match(problem!, /127\.0\.0\.1/);
  assert.match(problem!, /sandbox\.<domain>/);
});

test("boot assertion: daytona + an unset public URL refuses to start", () => {
  assert.ok(sandboxReachability("daytona", ""));
  assert.match(sandboxReachability("daytona", "")!, /<unset>/);
});

test("boot assertion: daytona + a reachable hostname starts", () => {
  assert.equal(sandboxReachability("daytona", "https://sandbox.mycelai.dev"), null);
});

test("boot assertion: local and docker keep the loopback default", () => {
  // On a laptop 127.0.0.1 IS the right answer — the local backend shares the loopback interface and
  // the docker backend publishes the sandbox port onto it. Making this fatal everywhere would break
  // every dev machine to fix a cloud-only bug.
  assert.equal(sandboxReachability("local", "http://127.0.0.1:4000"), null);
  assert.equal(sandboxReachability("docker", "http://127.0.0.1:4000"), null);
});
