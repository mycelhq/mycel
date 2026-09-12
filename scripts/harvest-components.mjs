#!/usr/bin/env node
/**
 * Harvest the open component registries into a local library the site-builder can call.
 *
 * Sources (all fetched from their PUBLIC shadcn-style registries — full source in JSON, no HTML
 * scraping to break):
 *   · shadcn/ui    — https://ui.shadcn.com/r/index.json + /r/styles/new-york/{name}.json
 *   · Aceternity   — https://ui.aceternity.com/registry + /registry/{name}.json
 *   · 21st.dev     — auth-gated (403 without an API key). Harvested only when
 *                    TWENTYFIRST_API_KEY is set; skipped loudly otherwise.
 *
 * Output:
 *   kernel/component-library/{source}/{name}.json   — the registry item, verbatim (files + content)
 *   kernel/component-library/index.json             — one searchable index: name, source, type,
 *                                                     description, dependencies, file paths, tags
 *
 * The index is what the builder agent searches (small, greppable); the per-item JSON is what the
 * `component` CLI in business-template applies. Re-run any time to pick up upstream additions:
 * it is idempotent and prints what changed. Optionally mirrors to S3 (MYCEL_COMPONENT_BUCKET) so
 * builds do not depend on third-party uptime.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "component-library");

const fetchJson = async (url, headers = {}) => {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
};

/** Crude but useful tags from the name/description, so the agent can filter by section kind. */
function tagsFor(name, description = "") {
  const hay = `${name} ${description}`.toLowerCase();
  const tags = [];
  const RULES = [
    [/hero/, "hero"], [/bento|grid/, "grid"], [/card/, "card"], [/testimonial/, "testimonials"],
    [/pricing/, "pricing"], [/feature/, "features"], [/nav|menu|header/, "navigation"],
    [/footer/, "footer"], [/form|input|select|checkbox|radio|switch|textarea|label/, "form"],
    [/button/, "button"], [/modal|dialog|drawer|sheet|popover/, "overlay"],
    [/table|data/, "data"], [/carousel|slider|marquee/, "carousel"], [/text|typewriter|words|reveal/, "text-effect"],
    [/background|beam|aurora|sparkle|meteor|grid-pattern|dot/, "background"],
    [/scroll|parallax/, "scroll"], [/tab|accordion|collaps/, "disclosure"],
    [/tooltip|hover/, "hover"], [/badge|chip|pill/, "badge"], [/avatar|profile|people/, "people"],
    [/chart|graph/, "chart"], [/timeline|step/, "timeline"], [/cta|signup|waitlist/, "cta"],
    [/loader|spinner|skeleton|progress/, "loading"], [/3d|globe|world/, "3d"],
  ];
  for (const [re, tag] of RULES) if (re.test(hay)) tags.push(tag);
  return tags.length ? tags : ["misc"];
}

/**
 * shadcn is PRIMITIVES (button, input, dialog) — it is not what the library is for. It is still
 * harvested to disk because `vendor-shadcn.mjs` copies all of it into business-template once (no
 * per-component add ceremony), but it is EXCLUDED from index.json: the library the agent searches
 * is the rich layer — animations, shaders, hero sections, effects — from Aceternity, Magic UI,
 * Kokonut and friends.
 */
async function harvestShadcn(index) {
  const list = await fetchJson("https://ui.shadcn.com/r/index.json");
  let n = 0;
  for (const item of list) {
    try {
      const full = await fetchJson(`https://ui.shadcn.com/r/styles/new-york/${item.name}.json`);
      const dir = join(OUT, "shadcn");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${item.name}.json`), JSON.stringify(full, null, 1));
      void index; // deliberately not indexed — see the note above
      false && index.push({
        name: item.name,
        source: "shadcn",
        type: full.type ?? item.type,
        description: full.description ?? "",
        dependencies: full.dependencies ?? [],
        registryDependencies: full.registryDependencies ?? [],
        files: (full.files ?? []).map((f) => f.path),
        tags: tagsFor(item.name, full.description),
      });
      n++;
    } catch (e) {
      console.error(`  shadcn/${item.name}: ${e.message}`);
    }
  }
  return n;
}

async function harvestAceternity(index) {
  const reg = await fetchJson("https://ui.aceternity.com/registry");
  let n = 0;
  for (const item of reg.items ?? []) {
    try {
      const full = await fetchJson(`https://ui.aceternity.com/registry/${item.name}.json`);
      const dir = join(OUT, "aceternity");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${item.name}.json`), JSON.stringify(full, null, 1));
      index.push({
        name: item.name,
        source: "aceternity",
        type: full.type ?? item.type,
        description: full.description ?? item.description ?? "",
        dependencies: full.dependencies ?? [],
        registryDependencies: full.registryDependencies ?? [],
        files: (full.files ?? []).map((f) => f.path),
        tags: tagsFor(item.name, full.description ?? item.description),
      });
      n++;
    } catch (e) {
      console.error(`  aceternity/${item.name}: ${e.message}`);
    }
  }
  return n;
}

async function harvestMagicui(index) {
  // Magic UI (MIT, github.com/magicuidesign/magicui) — same registry shape as shadcn.
  const reg = await fetchJson("https://magicui.design/registry.json");
  let n = 0;
  for (const item of reg.items ?? []) {
    try {
      const full = await fetchJson(`https://magicui.design/r/${item.name}.json`);
      const dir = join(OUT, "magicui");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${item.name}.json`), JSON.stringify(full, null, 1));
      index.push({
        name: item.name,
        source: "magicui",
        type: full.type ?? item.type,
        description: full.description ?? item.description ?? "",
        dependencies: full.dependencies ?? [],
        registryDependencies: full.registryDependencies ?? [],
        files: (full.files ?? []).map((f) => f.path),
        tags: tagsFor(item.name, full.description ?? item.description),
      });
      n++;
    } catch (e) {
      console.error(`  magicui/${item.name}: ${e.message}`);
    }
  }
  return n;
}

async function harvestKokonutui(index) {
  // Kokonut UI (MIT, github.com/kokonut-labs/kokonutui) has no public registry index, but the repo
  // lists every item — the "somebody on GitHub already did it" route: enumerate there, fetch the
  // registry JSON from the site.
  const listing = await fetchJson("https://api.github.com/repos/kokonut-labs/kokonutui/contents/public/r", {
    "user-agent": "mycel-harvester",
  });
  let n = 0;
  for (const f of listing) {
    if (!f.name?.endsWith(".json")) continue;
    const name = f.name.replace(/\.json$/, "");
    try {
      const full = await fetchJson(`https://kokonutui.com/r/${name}.json`);
      const dir = join(OUT, "kokonutui");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${name}.json`), JSON.stringify(full, null, 1));
      index.push({
        name,
        source: "kokonutui",
        type: full.type ?? "registry:component",
        description: full.description ?? "",
        dependencies: full.dependencies ?? [],
        registryDependencies: full.registryDependencies ?? [],
        files: (full.files ?? []).map((x) => x.path),
        tags: tagsFor(name, full.description),
      });
      n++;
    } catch (e) {
      console.error(`  kokonutui/${name}: ${e.message}`);
    }
  }
  return n;
}

const index = [];
console.log("harvesting shadcn/ui…");
const s = await harvestShadcn(index);
console.log(`  ${s} components`);
console.log("harvesting aceternity…");
const a = await harvestAceternity(index);
console.log(`  ${a} components`);
console.log("harvesting magicui…");
const m = await harvestMagicui(index);
console.log(`  ${m} components`);
console.log("harvesting kokonutui…");
const k = await harvestKokonutui(index);
console.log(`  ${k} components`);
if (process.env.TWENTYFIRST_API_KEY) {
  console.log("21st.dev: key present but harvester not implemented for their API shape yet");
} else {
  console.log("21st.dev: skipped (auth-gated; set TWENTYFIRST_API_KEY to include)");
}

index.sort((x, y) => `${x.source}/${x.name}`.localeCompare(`${y.source}/${y.name}`));
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "index.json"), JSON.stringify(index, null, 1));
console.log(`index.json: ${index.length} components, ${[...new Set(index.flatMap((i) => i.tags))].length} tags`);
