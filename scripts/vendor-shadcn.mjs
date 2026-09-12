#!/usr/bin/env node
/**
 * Vendor ALL shadcn/ui primitives into business-template, once.
 *
 * The founder-site builder should never spend a turn running `npx shadcn add <thing>` — the
 * primitives are commodity and the ceremony is cognitive load. This copies every harvested shadcn
 * item (kernel/component-library/shadcn, from harvest-components.mjs) into
 * business-template/components/ui and merges their npm dependencies into package.json.
 *
 * EXISTING FILES ARE NEVER OVERWRITTEN: button.tsx (and anything else already customised for the
 * template's brand system) stays exactly as it is. Re-run after a re-harvest to pick up new
 * primitives; it prints what it added and what it skipped.
 */
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = join(HERE, "..", "component-library", "shadcn");
const TEMPLATE = join(HERE, "..", "..", "business-template");

const pkgPath = join(TEMPLATE, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
pkg.dependencies ??= {};

/** Not vendored, on purpose. `pagination` imports ButtonProps off the template's own custom button
 *  (which deliberately doesn't export it) and fights its size prop; `resizable` targets an older
 *  react-resizable-panels API. Neither belongs on a marketing site; add back deliberately if a
 *  build ever truly needs one. */
const EXCLUDE = new Set([
  "pagination", "resizable",
  // App-shell machinery, not marketing vocabulary — and both depend on registry hooks
  // (use-mobile / use-toast) we don't vendor. The template already ships sonner for toasts.
  "sidebar", "toaster",
]);

let wrote = 0, skipped = 0;
const newDeps = new Map();

for (const f of readdirSync(LIB).filter((x) => x.endsWith(".json"))) {
  const item = JSON.parse(readFileSync(join(LIB, f), "utf8"));
  // Only UI primitives — the registry also ships blocks/examples we don't want in the template.
  if (item.type !== "registry:ui") continue;
  if (EXCLUDE.has(item.name)) continue;
  for (const file of item.files ?? []) {
    if (!file.content || file.type !== "registry:ui") continue;
    // `toaster.tsx` ships inside the `toast` ITEM, so the item-level exclude misses it — and it
    // imports a registry hook we don't vendor. Sonner is the template's toast surface.
    if (basename(file.path) === "toaster.tsx") continue;
    const target = join(TEMPLATE, "components", "ui", basename(file.path));
    if (existsSync(target)) {
      skipped++;
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    // The registry ships its own internal import shape; the shadcn CLI rewrites it per
    // components.json aliases, and so do we — otherwise every cross-primitive import 2307s.
    const content = file.content
      .replaceAll("@/registry/new-york/ui/", "@/components/ui/")
      .replaceAll("@/registry/new-york/lib/", "@/lib/")
      .replaceAll("@/registry/new-york/hooks/", "@/hooks/");
    writeFileSync(target, content);
    wrote++;
  }
  for (const dep of item.dependencies ?? []) {
    // "pkg@^1.2" or bare. Never touch a dep the template already pins.
    const at = dep.lastIndexOf("@");
    const name = at > 0 ? dep.slice(0, at) : dep;
    const ver = at > 0 ? dep.slice(at + 1) : "latest";
    if (!pkg.dependencies[name]) newDeps.set(name, ver);
  }
}

for (const [name, ver] of newDeps) pkg.dependencies[name] = ver === "latest" ? "*" : ver;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
console.log(`vendored ${wrote} files (${skipped} already present, untouched)`);
console.log(`new deps (${newDeps.size}): ${[...newDeps.keys()].join(", ") || "none"}`);
console.log("now: cd business-template && npm install && npx tsc --noEmit");
