// THE SHARED SKILL LIBRARY — procedure a generated service inherits instead of reinventing.
//
// ═══ WHAT THIS IS ═══
//
// A wedge ships its own skills, and a tenant can edit them (playbooks.ts). But the same procedure —
// "how to structure a multi-page marketing site", "how to reconcile a month" — is written once and
// wanted by every agency doing that kind of work. This is the kernel-owned, cross-tenant library of
// those procedures, the exact analogue of the shared WORKFLOW library (SHARED_WORKFLOWS) but for
// prose the agent READS rather than code it calls. A wedge declares `domains` (web-dev, design,
// bookkeeping); a library skill is tagged with domains; at run time the skills whose tags intersect
// the wedge's domains are mounted alongside its own, and flow through the same overlay/index path.
//
// ═══ THE TRUST BOUNDARY, STATED ONCE ═══
//
// A skill is DATA — markdown the agent reads. That is why an authored wedge may carry skills but not
// `workflows`: code has no provenance or sandbox story, prose has neither to worry about. This module
// holds that line at the import door. `parseSkillDoc` ingests the MARKDOWN of a `SKILL.md` and
// nothing else — a skill package that bundles `.py`/`.sh` scripts alongside its prose has those
// scripts DROPPED on the floor, never fetched, stored or made runnable. What lands in the library is
// text an agent may read, exactly like a skill a founder typed. Anything that would execute is not a
// skill under this definition and does not come in.
//
// ═══ WHERE IT LIVES ═══
//
// The generic record store, under the same reserved global scope as the scales (`GLOBAL_SKILL_SCOPE`)
// so it is genuinely cross-tenant, keyed by skill name and upserted (re-importing a skill bumps its
// version rather than duplicating it). `queryRecords` stays fail-closed on project_id; the "tenant"
// here is the library itself.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { DomainStore } from "./domain";
import type { WedgeFile, WedgeManifest } from "./wedge";
import { GLOBAL_SKILL_SCOPE, SKILLS_WEDGE, skillScales, type SkillScale } from "./skill-scales";

const LIBRARY_COLLECTION = "library_skill";
const MAX_LIBRARY_ROWS = 2000;

export interface LibrarySkill {
  /** The skill file name, always ending `.md`. The stable identity the scales key on across tenants. */
  name: string;
  /** Which wedge domains this reaches. A skill with no domains reaches nothing — it must be findable. */
  domains: string[];
  /** The one-line menu entry the agent sees before deciding to open the file. */
  description: string;
  /** The full markdown mounted as `skills/<name>` — frontmatter and prose, exactly like a disk skill. */
  body: string;
  /** Where it came from. `imported` carries a `source_url`; `authored` was written or seeded here. */
  source: "authored" | "imported";
  source_url?: string;
  /** Bumped on every re-import of the same name. */
  version: number;
  at: string;
}

/** The domains a wedge draws library skills from. Absent/empty ⇒ its own skills only. */
export function wedgeDomains(manifest?: WedgeManifest | null): string[] {
  const d = manifest?.domains;
  return Array.isArray(d) ? d.filter((x): x is string => typeof x === "string" && !!x.trim()) : [];
}

function skillFile(name: string): string {
  return name.endsWith(".md") ? name : `${name}.md`;
}

/**
 * Parse the markdown of a `SKILL.md` into a library skill. PROSE ONLY — the caller passes the text of
 * the skill file; any bundled scripts are the caller's to have already dropped, and this stores the
 * markdown verbatim as the body. Returns null when there is no usable name, because a skill nothing
 * can name is a skill nothing can mount, overlay or weigh.
 */
export function parseSkillDoc(
  text: string,
  opts: { domains?: readonly string[]; source?: LibrarySkill["source"]; source_url?: string } = {},
): LibrarySkill | null {
  const body = String(text ?? "").trim();
  if (!body) return null;

  const fm = body.startsWith("---") ? body.slice(3, body.indexOf("\n---", 3)) : "";
  const field = (key: string): string | undefined => {
    const m = fm.match(new RegExp(`^\\s*${key}\\s*:\\s*(.+)$`, "m"));
    return m ? m[1].trim().replace(/^["']|["']$/g, "") : undefined;
  };

  let name = field("name");
  if (!name) {
    // Fall back to the first heading, slugified. A skill with neither a name nor a heading is unnamed
    // and refused rather than given a random id nobody can reference.
    const heading = body.match(/^#\s+(.+)$/m)?.[1];
    if (heading) name = heading.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  }
  if (!name) return null;

  const description =
    field("description") ??
    body
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith("#") && !l.startsWith("---")) ??
    name;

  return {
    name: skillFile(name),
    domains: [...new Set((opts.domains ?? []).map((d) => d.trim()).filter(Boolean))],
    description: description.slice(0, 200),
    body,
    source: opts.source ?? (opts.source_url ? "imported" : "authored"),
    ...(opts.source_url ? { source_url: opts.source_url } : {}),
    version: 1,
    at: new Date().toISOString(),
  };
}

/** Add or update a library skill. Re-adding the same name bumps its version rather than duplicating. */
export async function addLibrarySkill(domain: DomainStore, skill: LibrarySkill): Promise<LibrarySkill> {
  const existing = (await listLibrarySkills(domain)).find((s) => s.name === skill.name);
  const version = existing ? existing.version + 1 : 1;
  const row: LibrarySkill = { ...skill, name: skillFile(skill.name), version, at: new Date().toISOString() };
  await domain.upsertRecord({
    project_id: GLOBAL_SKILL_SCOPE,
    wedge: SKILLS_WEDGE,
    collection: LIBRARY_COLLECTION,
    key: row.name,
    data: row as unknown as Record<string, unknown>,
  });
  return row;
}

/** List library skills, optionally only those reaching one of `domains`. */
export async function listLibrarySkills(
  domain: DomainStore,
  opts: { domains?: readonly string[] } = {},
): Promise<LibrarySkill[]> {
  const rows = await domain.queryRecords({
    project_id: GLOBAL_SKILL_SCOPE,
    wedge: SKILLS_WEDGE,
    collection: LIBRARY_COLLECTION,
    limit: MAX_LIBRARY_ROWS,
  });
  const wanted = opts.domains?.length ? new Set(opts.domains) : undefined;
  const out: LibrarySkill[] = [];
  for (const r of rows) {
    const s = r.data as unknown as LibrarySkill | undefined;
    if (!s || !s.name) continue;
    if (wanted && !(s.domains ?? []).some((d) => wanted.has(d))) continue;
    out.push(s);
  }
  out.sort((a, b) => (a.name < b.name ? -1 : 1));
  return out;
}

/**
 * Where the curated service-business seed lives — `kernel/service-skills/<domain>/*.md`, the sibling
 * of `kernel/wedges` and `kernel/workflows`. Deliberately NOT `kernel/skills/`, which already holds
 * build-time agent skills (frontend, wedge-builder) of a different shape and purpose. Same
 * `cwd`-relative resolution as `wedgesDir`. NOTE for deploy: publish-oss must ship
 * `kernel/service-skills/` like it ships `kernel/workflows/`, or the library is empty in production.
 */
export function skillsSeedDir(): string {
  return process.env.MYCEL_SERVICE_SKILLS_DIR ?? join(process.cwd(), "service-skills");
}

/**
 * Load the curated seed into the library on boot. Each subdirectory is a DOMAIN; each `.md` inside is
 * a skill tagged with that domain. Idempotent: a skill already present with the same body and domains
 * is skipped, so this runs on every boot without churning versions — only genuinely new or changed
 * curated skills are written. Fail-soft per file; a malformed seed file is skipped, never a boot.
 */
export async function seedLibraryFromDisk(
  domain: DomainStore,
  dir = skillsSeedDir(),
): Promise<{ seeded: number; skipped: number }> {
  let seeded = 0;
  let skipped = 0;
  if (!existsSync(dir)) return { seeded, skipped };

  const existing = new Map((await listLibrarySkills(domain)).map((s) => [s.name, s]));
  const sameDomains = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

  for (const domainName of readdirSync(dir)) {
    const domainDir = join(dir, domainName);
    let isDir = false;
    try {
      isDir = statSync(domainDir).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;

    for (const file of readdirSync(domainDir)) {
      if (!file.endsWith(".md")) continue;
      let content = "";
      try {
        content = readFileSync(join(domainDir, file), "utf8");
      } catch {
        continue;
      }
      const parsed = parseSkillDoc(content, { domains: [domainName], source: "authored" });
      if (!parsed) continue;
      const prev = existing.get(parsed.name);
      if (prev && prev.body === parsed.body && sameDomains(prev.domains, parsed.domains)) {
        skipped += 1;
        continue;
      }
      await addLibrarySkill(domain, parsed);
      seeded += 1;
    }
  }
  return { seeded, skipped };
}

/** Remove a library skill by name. */
export async function removeLibrarySkill(domain: DomainStore, name: string): Promise<void> {
  const rows = await domain.queryRecords({
    project_id: GLOBAL_SKILL_SCOPE,
    wedge: SKILLS_WEDGE,
    collection: LIBRARY_COLLECTION,
    limit: MAX_LIBRARY_ROWS,
  });
  const row = rows.find((r) => (r.data as { name?: string })?.name === skillFile(name));
  if (row) await domain.deleteRecord(row.id);
}

/**
 * How the library self-refines. `minVotes` keeps a verdict off noise — a skill with three votes has
 * told us nothing. `retireBelow` is the floor: a WELL-SAMPLED skill landing under a third of the time
 * is making the work worse, and mounting it is a net negative, so it comes off the shelf. Conservative
 * on purpose — the point is to drop the clear losers, not to chase a rate up and down on small samples.
 */
export interface SkillReweightPolicy {
  minVotes: number;
  retireBelow: number;
}
export const DEFAULT_REWEIGHT: SkillReweightPolicy = { minVotes: 5, retireBelow: 0.34 };

/** An unproven skill sits here — above a proven loser, below a proven winner — so new skills get a run. */
const NEUTRAL_RATE = 0.6;

export interface ReweightResult {
  /** Ranked best-landing first, clear losers removed. What a run should mount. */
  kept: LibrarySkill[];
  /** What was dropped and why — never silent, so a retirement is auditable. */
  retired: Array<{ name: string; rate: number; votes: number }>;
}

/**
 * Rank by acceptance and retire well-sampled losers. Pure — takes the scales rather than reading them
 * — so the policy is testable without a store. A skill's record is summed across every wedge that ran
 * it (its identity is its name), because a library skill is one procedure wherever it is used.
 */
export function reweightSkills(
  skills: LibrarySkill[],
  scales: SkillScale[],
  policy: SkillReweightPolicy = DEFAULT_REWEIGHT,
): ReweightResult {
  const score = (name: string): { rate: number; votes: number } | null => {
    const rows = scales.filter((s) => s.skill === name);
    const votes = rows.reduce((n, r) => n + r.total, 0);
    const accepted = rows.reduce((n, r) => n + r.accepted, 0);
    return votes ? { rate: accepted / votes, votes } : null;
  };

  const kept: LibrarySkill[] = [];
  const retired: ReweightResult["retired"] = [];
  for (const s of skills) {
    const sc = score(s.name);
    if (sc && sc.votes >= policy.minVotes && sc.rate < policy.retireBelow) {
      retired.push({ name: s.name, rate: sc.rate, votes: sc.votes });
      continue;
    }
    kept.push(s);
  }
  kept.sort((a, b) => (score(b.name)?.rate ?? NEUTRAL_RATE) - (score(a.name)?.rate ?? NEUTRAL_RATE));
  return { kept, retired };
}

/**
 * The library skills a wedge should mount, as `WedgeFile`s ready to merge with its own. Matched by
 * domain intersection; a wedge with no domains gets none. Ranked and pruned by the GLOBAL scales
 * (`reweightSkills`) so proven procedure surfaces first and clear losers come off — the loop that
 * makes the library get better as more work is judged. The body is mounted verbatim, so these flow
 * through `overlayPlaybooks` and the `## Procedures` index exactly like disk skills, and a tenant can
 * still disable one with a same-named overlay.
 */
export async function librarySkillsForWedge(
  domain: DomainStore,
  manifest?: WedgeManifest | null,
): Promise<WedgeFile[]> {
  const domains = wedgeDomains(manifest);
  if (!domains.length) return [];
  const skills = await listLibrarySkills(domain, { domains });
  const scales = await skillScales(domain).catch(() => [] as SkillScale[]); // global scoreboard
  const { kept } = reweightSkills(skills, scales);
  return kept.map((s) => ({ name: s.name, content: s.body }));
}
