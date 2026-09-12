// Every callback the runtime hands a sandbox must be reachable from one.
//
// ═══ THE FAILURE THIS EXISTS FOR ═══
//
// `runtime.ts` injects `MYCEL_GATE_URL = <publicUrl>/v1/internal/gate` into every sandbox, and
// `plugin.ts` writes a plugin that POSTs there before any gated tool call. The path was on no list
// in `infra/sandbox.tf`, so in production every one of those POSTs hit the catch-all deny and 404'd.
//
// Nothing executed unapproved — the plugin fails closed, and a fetch that throws becomes
// `gate_unreachable` and refuses the tool. What broke was availability, in the shape hardest to
// notice: the agent was told `action "…" was not approved (gate_unreachable)`, which reads exactly
// like a founder declining it.
//
// This test is why that cannot recur. The env vars the runtime injects and the paths the ALB admits
// are two lists in two languages that must agree, and nothing made them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/**
 * ═══ THESE ASSERT OUR TERRAFORM, WHICH THE OPEN-SOURCE REPO DOES NOT CONTAIN ═══
 *
 * `infra/` is deliberately not published — it is our deployment, not the kernel. So in a clone these
 * tests were reading a file that is not there and FAILING, and the README's first instruction is
 * `npm test` with the promise "green. no keys" and the line "if it is red, the clone is broken —
 * not your machine". Six red tests told every newcomer exactly the wrong thing about their clone.
 *
 * Skipped, not deleted: they are load-bearing HERE, where the ALB rules they check really do decide
 * whether a sandbox can reach the kernel.
 */
const HAS_INFRA = existsSync(join(ROOT, "infra"));

test("every /v1/internal URL the runtime injects is admitted by the sandbox ALB", { skip: HAS_INFRA ? false : "infra/ is not part of the open-source distribution" }, () => {
  const runtime = read("kernel/harness/src/runtime.ts");
  const tf = read("infra/sandbox.tf");

  // What the runtime tells a sandbox it may call. Template literals of the form
  // `${cfg.publicUrl}/v1/internal/...`, which is how every one of these is written.
  const injected = [...runtime.matchAll(/\$\{cfg\.publicUrl\}(\/v1\/internal\/[a-z/]+)/g)].map((m) => m[1]!);
  assert.ok(injected.length >= 8, `expected the runtime to inject several callbacks, found ${injected.length}`);

  // What the ALB admits, including prefix rules like `/v1/internal/actions/*`.
  const admitted = [...tf.matchAll(/"(\/v1\/internal\/[a-z/*]+)"/g)].map((m) => m[1]!);
  /**
   * A `/*` RULE COVERS ITS OWN BASE, and that is not a technicality here.
   *
   * Several of these are injected as BASES the agent appends to — `$MYCEL_ACTIONS_URL/composio/…`,
   * `$MYCEL_READS_URL/brandwatch_mentions`, `$MYCEL_CASE_URL/update`. The bare path is never
   * requested, so treating `/v1/internal/actions/*` as failing to cover `/v1/internal/actions`
   * would fail this test on four callbacks that work perfectly.
   *
   * `/v1/internal/case` is the exception that proves it is worth being careful: that one IS called
   * bare, and the ALB lists it explicitly for exactly that reason.
   */
  const allows = (url: string) =>
    admitted.some(
      (p) =>
        p === url ||
        // `/v1/internal/actions/*` covers `/v1/internal/actions` and everything under it.
        (p.endsWith("/*") && (url === p.slice(0, -2) || url.startsWith(p.slice(0, -1)))) ||
        // And an explicitly-listed CHILD covers its base, for the same reason: `/records/upsert` and
        // `/records/query` are both listed, and `$MYCEL_RECORDS_URL` is only ever appended to.
        p.startsWith(`${url}/`),
    );

  const unreachable = [...new Set(injected)].filter((u) => !allows(u));
  assert.deepEqual(
    unreachable,
    [],
    `these are handed to every sandbox and cannot be reached from one:\n  ${unreachable.join("\n  ")}`,
  );
});

test("a sandbox allow sits below the deny, or it never matches", { skip: HAS_INFRA ? false : "infra/ is not part of the open-source distribution" }, () => {
  // ALB evaluates ascending. `sandbox_deny` catches everything on this host, so an allow numerically
  // after it is dead on arrival — and it looks completely correct in the diff.
  const tf = read("infra/sandbox.tf");
  const deny = Number(/resource "aws_lb_listener_rule" "sandbox_deny"[\s\S]*?priority\s*=\s*(\d+)/.exec(tf)?.[1] ?? NaN);
  assert.ok(Number.isFinite(deny), "the deny rule has to have a priority");

  const rules = [...tf.matchAll(/resource "aws_lb_listener_rule" "(sandbox_\w+)"[\s\S]{0,200}?priority\s*=\s*(\d+)/g)];
  const late = rules.filter(([, name, p]) => name !== "sandbox_deny" && Number(p) > deny).map(([, n]) => n);
  assert.deepEqual(late, [], `these allows are evaluated after the deny and can never match: ${late.join(", ")}`);
});

test("no ALB rule carries more than four path patterns", { skip: HAS_INFRA ? false : "infra/ is not part of the open-source distribution" }, () => {
  /**
   * A fifth is SILENTLY DROPPED rather than rejected, once the host condition has spent a match
   * evaluation — the note on `/v1/internal/wait` records finding that out. A dropped path looks
   * present in the file and absent in production, which is the worst combination available.
   */
  const tf = read("infra/sandbox.tf");
  for (const [, name, body] of tf.matchAll(/(sandbox_paths_\w+)\s*=\s*\[([\s\S]*?)\n\s*\]/g)) {
    const n = [...body.matchAll(/"\/v1\//g)].length;
    assert.ok(n <= 4, `${name} has ${n} paths; the fifth would be dropped without an error`);
  }
});
