/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * A DIRECTORY THE KERNEL READS AT RUNTIME AND THE IMAGE DOES NOT CARRY
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The Dockerfile has SIX comments, each written after the same bug reached production and each found
 * the same way — by running the built image rather than by building it:
 *
 *   · `wedges` / `blueprints` — the container was healthy and answered "unknown wedge" to every task
 *   · `workflows` / `service-skills` — a `lib` workflow 404ed and the skill library seeded EMPTY
 *   · `design-systems` — every deliverable degraded silently to no house style
 *   · `craft` — every client-facing run produced without the rules it is supposed to be held to
 *   · `packs` — 4,442 `workflow:*` calls in production and ZERO `pack:*`, ever, while four shipped
 *     wedges declare packs in their manifests
 *
 * Every one of these fails SOFT. The resolver returns `[]`, the container passes its health check,
 * and the product is quietly worse in a way no error surface mentions. That is why it happened six
 * times: nothing ever failed.
 *
 * So this is the general guard instead of a seventh comment. It reads the resolvers out of the source
 * and checks the Dockerfile carries what they name.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const DOCKERFILE = readFileSync(join(ROOT, "Dockerfile"), "utf8");

/** Directories the Dockerfile copies into the image, as bare names. */
const copied = new Set(
  [...DOCKERFILE.matchAll(/^COPY\s+([A-Za-z0-9._-]+)\s+\.\/([A-Za-z0-9._-]+)\s*$/gm)].map((m) => m[2]!),
);

/**
 * Every `join(process.cwd(), "<name>")` in the kernel — the exact shape every one of the six bugs
 * had. Read from the source rather than listed here, so a seventh resolver is covered the day it is
 * written and not the day it breaks.
 */
function resolvedFromCwd(): Set<string> {
  const out = new Set<string>();
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== "node_modules" && e.name !== "graphify-out") walk(p);
      } else if (p.endsWith(".ts") && !p.endsWith(".d.ts") && !p.includes("/test/")) {
        const src = readFileSync(p, "utf8");
        for (const m of src.matchAll(/join\(\s*process\.cwd\(\)\s*,\s*"([A-Za-z0-9._-]+)"/g)) out.add(m[1]!);
        /*
          `libraryPath("x")` is the second spelling, and the reason it exists. Seven of these used to
          be seven separate `join(process.cwd(), ...)` calls with seven separate COPY lines; they now
          resolve under `library/`, which one COPY carries. This scan has to understand both, or
          moving them would have silently emptied its own population — a guard that passes because it
          stopped looking is worse than the bug it was written for.
        */
        for (const m of src.matchAll(/libraryPath\(\s*"([A-Za-z0-9._-]+)"/g)) out.add(`library/${m[1]!}`);
      }
    }
  };
  walk(join(ROOT, "harness", "src"));
  return out;
}

test("EVERY RUNTIME DIRECTORY THE KERNEL RESOLVES IS IN THE IMAGE", () => {
  // `.` and `..` are relative steps, not directory names — `join(process.cwd(), "..")` appears in
  // the source and is not a thing an image can carry.
  const needed = [...resolvedFromCwd()].filter((d) => d !== "." && d !== ".." && existsSync(join(ROOT, d)));
  assert.ok(needed.length >= 4, `the resolver scan found only ${needed.length} directories — it stopped working`);
  /*
    `library/craft` is carried by `COPY library ./library`. Checking the parent rather than demanding
    a line per entry is the whole point of the grouping — the alternative is this guard forcing back
    the exact seven-line shape that forgot six of them.
  */
  const missing = needed.filter((d) => !copied.has(d) && !copied.has(d.split("/")[0]!));
  assert.deepEqual(
    missing,
    [],
    `these are read from disk at runtime and are NOT copied into the image:\n` +
      missing.map((m) => `  ${m}`).join("\n") +
      `\nThe container will be healthy and the feature will be silently absent — six times so far.`,
  );
});

test("packs specifically, because four shipped wedges declare one", () => {
  /*
    Named as well as scanned. `listPacks()` returning [] is indistinguishable from "this deployment
    has no packs", so the only signal was a production query showing zero `pack:*` calls against
    4,442 `workflow:*` ones.
  */
  assert.ok(copied.has("library"), "library/ is not in the image — every declared pack is unreachable");
  const declaring = readdirSync(join(ROOT, "wedges"))
    .filter((w) => {
      const f = join(ROOT, "wedges", w, "wedge.json");
      return existsSync(f) && readFileSync(f, "utf8").includes('"packs"');
    });
  assert.ok(declaring.length > 0, "no wedge declares a pack any more — this guard is measuring nothing");
  for (const w of declaring) {
    const manifest = JSON.parse(readFileSync(join(ROOT, "wedges", w, "wedge.json"), "utf8")) as { packs?: string[] };
    for (const ref of manifest.packs ?? []) {
      const name = /^([a-z0-9_-]+)/i.exec(ref)?.[1];
      assert.ok(
        name && existsSync(join(ROOT, "library", "packs", name)),
        `${w} declares pack "${ref}" and packs/${name} does not exist`,
      );
    }
  }
});
