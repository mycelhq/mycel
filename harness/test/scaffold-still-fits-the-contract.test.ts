// `npx create-mycel-app` is a published consumer of /v1, and nothing checked it.
//
// The README sends people to it — "scaffold a product on the contract" — and it generates a Next
// app whose four API routes proxy straight through to this kernel. It ships on npm, so a route
// removed here breaks an app somebody scaffolded last month, and the first they hear of it is a 404
// in their own code.
//
// `harness/test/docs-do-not-lie.test.ts` holds the DOCS to the registered routes. This holds the
// scaffolder to them, which is the same rule applied to the other published artefact.
//
// Skips outside the monorepo: `create-mycel-app/` is its own npm package and is not part of the
// kernel distribution — same convention as every other test here that names a private sibling.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCAFFOLD = fileURLToPath(new URL("../../../create-mycel-app/create.mjs", import.meta.url));
const skip = existsSync(SCAFFOLD)
  ? false
  : "create-mycel-app is its own npm package and is not part of the kernel distribution";

/** Every `app.get("/v1/…")` the harness registers, as verb + segments. */
function registered(): Array<{ verb: string; segments: string[] }> {
  const out: Array<{ verb: string; segments: string[] }> = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) {
        if (e.name !== "graphify-out" && e.name !== "node_modules") walk(p);
      } else if (e.name.endsWith(".ts")) {
        for (const m of readFileSync(p, "utf8").matchAll(/\b(get|post|patch|put|del|delete)\("(\/v1\/[^"]+)"/g)) {
          const verb = m[1]!.toUpperCase() === "DEL" ? "DELETE" : m[1]!.toUpperCase();
          out.push({ verb, segments: m[2]!.replace(/\/$/, "").split("/").filter(Boolean) });
        }
      }
    }
  };
  walk(fileURLToPath(new URL("../src", import.meta.url)));
  return out;
}

test("scaffold: every kernel route it proxies is one the kernel registers", { skip }, () => {
  const routes = registered();
  assert.ok(routes.length > 100, `only ${routes.length} routes found — the scan stopped resolving`);

  /**
   * RUN IT, rather than parsing the generator.
   *
   * The first version grepped `create.mjs` for `"/v1/…"` and found nothing: inside a generator the
   * paths live in escaped strings (`\"/v1/tasks\"`) that build the output file. It examined zero
   * paths and only the floor turned that into a failure. Scaffolding into a temp directory checks
   * the artefact a user actually gets — the same reason the publish tests run the rewrite instead
   * of reading the script that performs it.
   */
  const dir = mkdtempSync(join(tmpdir(), "mycel-scaffold-"));
  execFileSync(process.execPath, [SCAFFOLD, "probe"], { cwd: dir, stdio: "pipe" });

  const generated: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".ts") || e.name.endsWith(".tsx")) generated.push(readFileSync(p, "utf8"));
    }
  };
  walk(join(dir, "probe", "app"));
  assert.ok(generated.length > 0, "the scaffolder produced no TypeScript — the scan stopped resolving");

  /**
   * The scaffold builds URLs by concatenation:
   *
   *     KERNEL + "/v1/tasks/" + params.id + "/events"
   *
   * so the path is spread across string literals with interpolations between them. Each `+ expr +`
   * is one path segment, whatever it holds, which is exactly what a `:param` in a route means.
   */
  const calls = [...generated.join("\n").matchAll(/KERNEL \+ ((?:"[^"]*"|\s*\+\s*|[A-Za-z0-9_.]+)+)/g)]
    .map((m) =>
      m[1]!
        .replace(/"\s*\+\s*[A-Za-z0-9_.]+\s*\+\s*"/g, ":x")
        .replace(/"\s*\+\s*[A-Za-z0-9_.]+/g, ":x")
        .replace(/"/g, "")
        .trim(),
    )
    .filter((p) => p.startsWith("/v1/"));

  assert.ok(calls.length >= 3, `only ${calls.length} kernel calls found in the generated app — the scan stopped resolving`);

  for (const call of [...new Set(calls)]) {
    const want = call.replace(/\/$/, "").split("/").filter(Boolean);
    const matched = routes.some(
      (r) =>
        r.segments.length === want.length &&
        want.every((seg, i) => seg === ":x" || r.segments[i] === seg || r.segments[i]?.startsWith(":")),
    );
    assert.ok(matched, `the scaffolded app calls ${call}, which the kernel does not register`);
  }
});

test("scaffold: it points newcomers at the command that shows something", { skip }, () => {
  // It said `npm run dev`, which boots an EMPTY kernel — so somebody scaffolded a product, wired it
  // to a business with nothing in it, and saw an empty screen. Same dead end the seed and setup.sh
  // had, in the third place it could occur.
  const src = readFileSync(SCAFFOLD, "utf8");
  assert.match(src, /npm run demo/, "the scaffolder no longer points at the seeded kernel");
});
