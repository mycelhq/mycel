// Everything a DEPLOYED TENANT APP asks of the kernel must be reachable from one.
//
// ═══ THE THREE FAILURES THIS EXISTS FOR, ALL FOUND IN ONE SITTING ═══
//
// A founder asked why the analytics page on their own website showed nothing. The answer turned out
// to be three separate holes between code that was written and infrastructure that was not, and all
// three were invisible because every surface involved is designed to degrade quietly.
//
//  1. `/v1/insight/events` — the path `business-template/lib/insight.ts` posts every pageview to —
//     was on no ALB rule. `portal_deny` answered it 404, from `awselb/2.0`, so no kernel log existed
//     and the template swallows send failures on purpose ("this must never be why a page fails").
//
//  2. `portal.tf` enumerated four portal routes and a template that calls twenty-nine. Invoices,
//     requests, approvals, deliverables, file downloads and the whole e-signature flow 404'd in
//     production. A founder's client could read their threads and nothing else about their account.
//
//  3. `MYCEL_PORTAL_URL` was set on the worker service and not the api service — and the api service
//     is the one that serves `POST /v1/deployments/:id/publish`, which is what actually starts the
//     build. So `PORTAL_URL` never reached CodeBuild, `buildspec.tenant.yml` deleted
//     `MYCEL_KERNEL_URL`, and every published site was built not knowing where its kernel is.
//
// Two lists in two languages that must agree, and nothing made them. Same shape as
// `sandbox-paths.test.ts`, which exists because `/v1/internal/gate` was missed the same way.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** `infra/` is our deployment, not the kernel, and is not in the open-source distribution. */
const HAS_INFRA = existsSync(join(ROOT, "infra"));
const skip = HAS_INFRA ? false : "infra/ is not part of the open-source distribution";

/** Does an ALB `path_pattern` value match this URL? `*` is the only wildcard ALB supports. */
function matches(pattern: string, url: string): boolean {
  const rx = new RegExp(`^${pattern.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
  return rx.test(url);
}

/** Every path the portal host admits, from every rule in portal.tf that forwards. */
function admittedOnPortal(): string[] {
  const tf = read("infra/portal.tf");
  const out: string[] = [];
  // Resource bodies only — the file's prose names paths it does NOT publish, and counting those
  // would make this test pass on a comment.
  for (const [, body] of tf.matchAll(/resource "aws_lb_listener_rule" "\w+" \{([\s\S]*?)\n\}/g)) {
    if (!/type\s*=\s*"forward"/.test(body)) continue;
    const cond = /path_pattern \{ values = \[([^\]]*)\] \}/.exec(body);
    if (cond) out.push(...[...cond[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!));
  }
  return out;
}

/**
 * Every kernel URL the generated app requests, with `${…}` collapsed to a literal segment.
 *
 * Read out of the template as TEXT rather than imported: `lib/kernel.ts` is a Next.js server module
 * (`next/headers`), so importing it here would need a request scope it cannot have.
 */
function templateRequests(): string[] {
  const urls = new Set<string>();
  const kernel = read("business-template/lib/kernel.ts");
  // `call<T>("invoices")`, `call("deliverables/${id}/accept")`, `proxy("artifacts/${id}")` — the
  // first string literal is the path under /v1/portal/, by the convention that file documents.
  for (const [, lit] of kernel.matchAll(/\b(?:call|proxy)(?:<[^>(]*>)?\(\s*(`[^`]*`|"[^"]*")/g)) {
    urls.add(`/v1/portal/${lit.slice(1, -1)}`);
  }
  // And anything built against the base directly, in any file of the template.
  for (const file of ["lib/kernel.ts", "lib/insight.ts", "lib/brandkit.ts"]) {
    const src = read(`business-template/${file}`);
    for (const [, path] of src.matchAll(/\$\{(?:KERNEL|base[^}]*)\}(\/v1\/[^`"]*)/g)) urls.add(path);
  }
  // `${encodeURIComponent(id)}` → one opaque segment; a query string is not part of the path ALB
  // matches on.
  return [...urls].map((u) => u.replace(/\$\{[^}]*\}/g, "x").replace(/\?.*$/, ""));
}

test("every kernel URL the deployed tenant app requests is admitted by the portal ALB", { skip }, () => {
  const requested = templateRequests();
  // The template is the authority on what a deployed site needs; if this ever reads near-zero the
  // extraction above has drifted and the test is measuring nothing.
  assert.ok(requested.length >= 20, `expected the template to request many kernel URLs, found ${requested.length}`);

  const admitted = admittedOnPortal();
  const unreachable = requested.filter((u) => !admitted.some((p) => matches(p, u))).sort();
  assert.deepEqual(
    unreachable,
    [],
    `the generated app requests these and the load balancer answers 404:\n  ${unreachable.join("\n  ")}`,
  );
});

test("the portal host publishes the client-session namespace and not the founder plane", { skip }, () => {
  /**
   * The wildcard at priority 93 is only as safe as what is NOT beside it. These are reachable by
   * every tenant Lambda on the public internet, so the list is the whole security argument: a client
   * session resolves on `/v1/portal/*` and NOWHERE else in the kernel, `/v1/host/*` takes a key
   * scoped to one project, and `/v1/insight/events` is append-only with a per-project ingest key.
   */
  assert.deepEqual(admittedOnPortal().sort(), ["/v1/host/*", "/v1/insight/events", "/v1/portal/*"]);

  // Named separately because these two are the reason `/v1/insight/*` must never be the pattern:
  // `summary` reads a project's whole analytics and `key` hands out the ingest credential.
  const admitted = admittedOnPortal();
  for (const founderPlane of ["/v1/insight/summary", "/v1/insight/key", "/v1/tasks", "/v1/org/plan", "/v1/approvals"]) {
    assert.ok(
      !admitted.some((p) => matches(p, founderPlane)),
      `${founderPlane} is founder-plane and must not be reachable from a tenant Lambda`,
    );
  }
});

test("one gate covers /v1/portal/*, with one exemption, and nothing is registered ahead of it", { skip }, () => {
  /**
   * THIS IS WHAT LETS portal.tf BE A WILDCARD. The ALB no longer reviews routes one at a time, so
   * the review has to be here: every route under the prefix inherits `resolveClientSession` because
   * a single `app.use` sits in front of all of them. A route registered BEFORE that middleware does
   * not inherit it — Hono composes per route in registration order — and would be publicly
   * reachable on portal.<domain> with no session at all.
   */
  const src = read("kernel/harness/src/server.ts");
  const gate = src.indexOf('app.use("/v1/portal/*"');
  assert.ok(gate > 0, "the /v1/portal/* middleware is what makes the wildcard rule safe");

  const body = src.slice(gate, gate + 400);
  assert.match(body, /resolveClientSession\(bearer\(c\)\)/, "the gate must resolve a client session");
  assert.match(body, /return c\.json\(\{ error: "unauthorized" \}, 401\)/, "no session must be a 401, not a pass");

  // The ONE documented exemption: the link exchange is the authentication.
  const exempt = [...body.matchAll(/c\.req\.path === "(\/v1\/portal\/[^"]*)"/g)].map((m) => m[1]!);
  assert.deepEqual(exempt, ["/v1/portal/session"], "an exemption is an unauthenticated public route");

  // Routes in server.ts itself, ahead of the gate.
  const early = [...src.slice(0, gate).matchAll(/app\.(?:get|post|put|patch|delete)\("(\/v1\/portal\/[^"]*)"/g)].map(
    (m) => m[1]!,
  );
  assert.deepEqual(early, ["/v1/portal/session"], "these skip the session gate entirely");

  // And the mounts: invoices, deliverables, signing, requests and approvals all register portal
  // routes from other files, and every one of those calls must come after the gate.
  const mounts = ["mountInvoices", "mountDeliverables", "mountSigningRoutes", "mountRequests", "mountPortalApprovals", "mountPortalThreads"];
  for (const name of mounts) {
    const at = src.indexOf(`${name}(app`);
    if (at < 0) continue; // renamed or gone; the route-level checks above still hold
    assert.ok(at > gate, `${name} registers /v1/portal routes before the session gate, so they are open`);
  }
});

test("no two ALB listener rules claim the same priority", { skip }, () => {
  /**
   * `CreateRule` fails with `PriorityInUse: Priority '97' is currently in use` — naming a number and
   * not the resource holding it — and it fails the WHOLE apply, so the rule simply never exists.
   * `sandbox_memory` was written as 97 after `portal.tf` had taken it, and lived that way long
   * enough for "the memory loop records nothing" to be investigated as a product bug twice. The band
   * map comments in sandbox.tf were both maintained and neither was ever checked against the other.
   *
   * Across all of infra/*.tf because the collision was BETWEEN FILES; within one file it is obvious.
   */
  const seen = new Map<number, string>();
  for (const file of readdirSync(join(ROOT, "infra")).filter((f) => f.endsWith(".tf"))) {
    const tf = read(`infra/${file}`);
    for (const [, name, body] of tf.matchAll(/resource "aws_lb_listener_rule" "(\w+)" \{([\s\S]*?)\n\}/g)) {
      const p = Number(/^\s*priority\s*=\s*(\d+)/m.exec(body)?.[1] ?? NaN);
      assert.ok(Number.isFinite(p), `${name} has no priority`);
      const held = seen.get(p);
      assert.equal(held, undefined, `priority ${p} is claimed by both ${held} and ${name}; the apply fails`);
      seen.set(p, `${file}:${name}`);
    }
  }
  assert.ok(seen.size >= 10, `expected to find the listener rules, found ${seen.size}`);
});

test("both ECS tiers carry every variable the deploy path reads", { skip }, () => {
  /**
   * "The worker is the tier that deploys" was the wrong thing to reason about, and reasoning about it
   * cost every published site its kernel URL. Both services run the same binary; either can be asked
   * to do anything the binary does, and `POST /v1/deployments/:id/publish` — the click that starts
   * the CodeBuild — is served by the api tier, not the worker.
   *
   * So the rule is a shape, not a judgement: what `deployConfig()` reads, both task definitions set.
   */
  const deploy = read("kernel/harness/src/deploy.ts");
  const fn = /export function deployConfig\(\)[\s\S]*?\n\}/.exec(deploy)?.[0];
  assert.ok(fn, "deployConfig is what every deploy path reads its environment through");

  const needed = [...new Set([...fn!.matchAll(/process\.env\.(MYCEL_\w+)/g)].map((m) => m[1]!))];
  assert.ok(needed.length >= 4, `expected deployConfig to read several variables, found ${needed.length}`);

  const tf = read("infra/services.tf");
  for (const tier of ["kernel", "worker"]) {
    // Slice header-to-next-top-level-resource. A brace-counting regex over jsonencode() with heredocs
    // inside it is its own bug; the next `resource "` at column zero is unambiguous.
    const at = tf.indexOf(`resource "aws_ecs_task_definition" "${tier}" {`);
    assert.ok(at >= 0, `${tier}'s task definition`);
    const next = tf.indexOf('\nresource "', at + 1);
    const block = tf.slice(at, next < 0 ? tf.length : next);
    // The `environment` list only. A name that appears in this file's prose is not a setting.
    const env = new Set([...block!.matchAll(/\{ name = "(\w+)", value =/g)].map((m) => m[1]!));
    const missing = needed.filter((n) => !env.has(n));
    assert.deepEqual(missing, [], `the ${tier} tier is missing ${missing.join(", ")}; this fails silently`);
  }
});
