// Wedge roles: the kernel finds a wedge by what it DECLARES, never by its directory name.
//
// Seven places in the kernel used to name a wedge as a string literal — `DUNNING_WEDGE =
// "invoice-chaser"`, `wedge: "harness-operator"`, and so on. Each one meant the harness was only
// general in the manifest and specific in the code, and each had its own failure: rename a
// directory and the invoice sweep spawns a chase for a wedge that is not there; ship a second
// dunning wedge and one of them is silently ignored.
//
// These tests pin the three properties that make the replacement safe rather than merely different:
// a config error fails LOUDLY, an absent role degrades HONESTLY, and a typo is REFUSED rather than
// ignored. The last is the one worth dwelling on — a `provides: ["dunnign"]` that is silently
// dropped is strictly worse than the hardcode it replaced, because the hardcode was at least
// visible to a grep.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ESM: no __dirname. The suite runs under tsx, which keeps `import.meta.url`.
const HERE = dirname(fileURLToPath(import.meta.url));
import {
  ALL_WEDGE_ROLES,
  WEDGE_ROLES,
  buildWedgeRoleIndex,
  manifestFaults,
  declaredRoles,
  isWedgeRole,
} from "../src/roles";
import type { WedgeManifest } from "../src/wedge";
import { api, makeApp } from "./helpers";

/** A manifest that satisfies whatever task types the role demands, so only the tested field varies. */
function manifestFor(role: keyof typeof WEDGE_ROLES, extra: Record<string, unknown> = {}) {
  const task_types = Object.fromEntries(WEDGE_ROLES[role].task_types.map((t) => [t, { description: t }]));
  return { wedge: "x", title: "X", provides: [role], task_types, ...extra };
}

function fixture(wedges: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "mycel-roles-"));
  for (const [slug, manifest] of Object.entries(wedges)) {
    mkdirSync(join(dir, slug), { recursive: true });
    writeFileSync(join(dir, slug, "wedge.json"), JSON.stringify({ ...(manifest as object), wedge: slug }));
  }
  return dir;
}

test("two wedges claiming one singleton role refuse to resolve, naming both", () => {
  // The bug: picking one arbitrarily. `nudgeWedgeFor` shipped as `scope.wedges[0] ?? DUNNING_WEDGE`
  // once, which would have chased a client for a bank statement in the invoice-chaser's voice.
  // Whichever this picked would be correct on the developer's machine and wrong in production,
  // because directory order is not a decision anybody made.
  const dir = fixture({ "chaser-a": manifestFor("dunning"), "chaser-b": manifestFor("dunning") });
  try {
    assert.throws(
      () => buildWedgeRoleIndex(dir),
      (e: Error) => {
        assert.match(e.message, /dunning/);
        // BOTH claimants named: being told there is a clash without being told where is a bug report
        // the founder has to do the work of, on a kernel that will not start.
        assert.match(e.message, /chaser-a/);
        assert.match(e.message, /chaser-b/);
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a role nothing claims is a legitimate install, not an error, and has a sentence to print", () => {
  // A bookkeeping-only install ships no dunning wedge. That must not throw, must not crash the
  // invoice sweep, and must not spawn a task for a wedge that is not on disk.
  const dir = fixture({ "books-only": { wedge: "books-only", title: "Books", task_types: {} } });
  try {
    const idx = buildWedgeRoleIndex(dir);
    assert.equal(idx.byRole.get("dunning"), undefined, "nothing claims dunning");
    assert.deepEqual(idx.scanned, ["books-only"], "and we can say what was looked at");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // Every role can explain its own absence, so no caller has to invent the wording.
  for (const role of ALL_WEDGE_ROLES) {
    assert.ok(WEDGE_ROLES[role].absent.length > 20, `${role} needs a real sentence, not a slug`);
  }
});

test("a mistyped role is refused, not silently dropped", () => {
  // THE failure this module exists to avoid. Silently ignoring `dunnign` gives an install where the
  // founder believes dunning is configured, the manifest says so, and nothing ever chases anything —
  // with no error anywhere. That is this repo's recurring bug: failing while reporting success.
  const faults = manifestFaults("typo", { wedge: "typo", title: "T", provides: ["dunnign"], task_types: {} });
  assert.equal(faults.length > 0, true, "a typo must be reported");
  assert.match(faults.map((f) => f.message).join(" "), /dunnign/);
});

test("claiming a role without the task types that prove it is refused", () => {
  // `provides` is a promise the kernel will act on: it spawns `WEDGE_ROLES[role].task_types` against
  // whoever claims it. A wedge that claims `dunning` but declares no `chase_invoice` produces a run
  // with no output schema and no policy envelope — an agent handed a verb nobody taught it.
  const faults = manifestFaults("hollow", { wedge: "hollow", title: "H", provides: ["dunning"], task_types: {} });
  assert.equal(faults.length > 0, true);
  assert.match(faults.map((f) => f.message).join(" "), /chase_invoice/);
});

test("the shipped wedges declare the roles the kernel actually initiates work for", () => {
  // The migration's own regression test. Every role the kernel spawns work for must have exactly one
  // holder in `wedges/`, or a code path that used to be a string literal now resolves to nothing and
  // the feature quietly stops existing.
  const idx = buildWedgeRoleIndex();
  for (const role of ALL_WEDGE_ROLES) {
    assert.ok(idx.byRole.get(role), `no shipped wedge provides "${role}"`);
  }
});

test("no kernel source file names a wedge directory as a string literal", () => {
  // A contract-surface test, in the shape this repo already uses elsewhere: the point of the roles
  // index is defeated the moment someone adds one more `wedge: "gtm-operator"`, and that addition
  // looks entirely reasonable in review. This is the thing that objects.
  //
  // `roles.ts` is exempt because the failure it documents IS the list of slugs, and the wedge
  // manifests are exempt because a manifest naming itself is the declaration, not a hardcode.
  const SLUGS = readdirSync(join(HERE, "..", "..", "wedges"));
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) {
        walk(p);
        continue;
      }
      if (!p.endsWith(".ts") || p.endsWith("roles.ts")) continue;
      readFileSync(p, "utf8")
        .split("\n")
        .forEach((line, i) => {
          // Comments are where the history is written down, and this repo wants it written down.
          const code = line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "");
          for (const slug of SLUGS) {
            if (code.includes(`"${slug}"`)) offenders.push(`${p}:${i + 1} ${line.trim()}`);
          }
        });
    }
  };
  walk(join(HERE, "..", "src"));
  assert.deepEqual(offenders, [], `use wedgeForRole()/wedgeHasRole() instead:\n${offenders.join("\n")}`);
});

test("declaredRoles narrows to known roles so a stale manifest cannot widen the type", () => {
  const m = { provides: ["dunning", "not_a_role"] } as unknown as WedgeManifest;
  assert.deepEqual(declaredRoles(m), ["dunning"]);
  assert.equal(isWedgeRole("not_a_role"), false);
});

test("GET /v1/wedge-roles answers, because the cloud has been calling it all along", async () => {
  // THE BUG: a route that two comments in roles.ts describe, that `wedgeRoleMap` was written for,
  // and that was never registered. The cloud's "Write me one" path resolves the shaping agent
  // through it — by ROLE, exactly as roles.ts demands, rather than by directory name — so every
  // call 404'd and the escape hatch for a business no installed service fits told every founder
  // "Couldn't reach the engine. Try again in a moment." Found while walking the funnel for other
  // instances of the pre-payment deadlock, and it is the same class: a step nobody can complete,
  // reported as something transient.
  const { app } = makeApp();
  const res = await api(app, "wedge-roles");
  assert.equal(res.status, 200, "the route the cloud fetches must exist");
  for (const role of ALL_WEDGE_ROLES) {
    assert.ok(role in res.json, `every role is reported, present or absent: ${role}`);
  }
  // The one the funnel depends on. A null here would be a legitimate install with no shaper — but
  // this install has one, and the cloud must be able to find it without naming a directory.
  assert.equal(typeof res.json.business_shaping, "string");
});
