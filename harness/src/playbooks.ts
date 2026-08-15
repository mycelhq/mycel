// Playbooks are the skills a service mounts, edited by the founder as versioned overlays.
//
// Disk skills stay the shipped default. A live knowledge row named `playbooks/<skill.md>` replaces
// that file on the next run — same overlay rule knowledge already uses for documents, applied to
// procedures. Each save appends `{ at, reason }` so "why it got better" is a record, not a guess.
//
// The founder never sees this prefix, a directory, or a slug path. Cloud maps filenames to
// sentences ("How we open"). This module is the kernel half: names, overlay, list, save.

import type { KnowledgeItem } from "./contract";
import type { WedgeFile } from "./wedge";

export const PLAYBOOK_PREFIX = "playbooks/";

export interface PlaybookVersion {
  at: string;
  reason: string;
}

export interface PlaybookRow {
  name: string;
  content: string;
  enabled: boolean;
  source: "shipped" | "yours";
  versions: PlaybookVersion[];
  updated_at?: string;
  /** Empty = every job this service runs. Named types = only those jobs mount it. */
  task_types: string[];
}

const skillFile = (name: string): string => (name.endsWith(".md") ? name : `${name}.md`);

/** Knowledge name that overlays a skill file. */
export function playbookKnowledgeName(skill: string): string {
  return `${PLAYBOOK_PREFIX}${skillFile(skill)}`;
}

/** Inverse: `playbooks/run-a-campaign.md` → `run-a-campaign.md`. */
export function skillNameFromPlaybook(knowledgeName: string): string | undefined {
  if (!knowledgeName.startsWith(PLAYBOOK_PREFIX)) return undefined;
  const rest = knowledgeName.slice(PLAYBOOK_PREFIX.length).trim();
  if (!rest || rest.includes("/") || rest.includes("..")) return undefined;
  return skillFile(rest);
}

export function isPlaybookKnowledge(name: string): boolean {
  return name.startsWith(PLAYBOOK_PREFIX);
}

function versionsOf(meta: Record<string, unknown> | undefined): PlaybookVersion[] {
  const raw = meta?.versions;
  if (!Array.isArray(raw)) return [];
  const out: PlaybookVersion[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const v = item as Record<string, unknown>;
    if (typeof v.at !== "string" || typeof v.reason !== "string") continue;
    out.push({ at: v.at, reason: v.reason });
  }
  return out;
}

function taskTypesOf(meta: Record<string, unknown> | undefined): string[] {
  const raw = meta?.task_types;
  if (!Array.isArray(raw)) return [];
  return raw.filter((t): t is string => typeof t === "string" && /^[a-z][a-z0-9_]{0,62}$/.test(t)).slice(0, 24);
}

/** `task_types` in a skill's YAML frontmatter — the shipped default for which jobs mount it. */
export function skillFrontmatterTaskTypes(content: string): string[] {
  if (!content.startsWith("---")) return [];
  const end = content.indexOf("\n---", 3);
  if (end < 0) return [];
  const block = content.slice(4, end);
  const bracket = /(?:^|\n)task_types:\s*\[([^\]]*)\]/.exec(block);
  if (bracket) {
    return bracket[1]!
      .split(",")
      .map((s) => s.trim().replace(/^["']|["']$/g, ""))
      .filter((t) => /^[a-z][a-z0-9_]{0,62}$/.test(t))
      .slice(0, 24);
  }
  const list: string[] = [];
  let inList = false;
  for (const line of block.split("\n")) {
    if (/^task_types:\s*$/.test(line)) {
      inList = true;
      continue;
    }
    if (inList) {
      const item = /^\s+-\s+(\S+)/.exec(line);
      if (item) list.push(item[1]!.replace(/^["']|["']$/g, ""));
      else if (line.trim() && !/^\s/.test(line)) inList = false;
    }
  }
  return list.filter((t) => /^[a-z][a-z0-9_]{0,62}$/.test(t)).slice(0, 24);
}

/** A playbook with no task_types list runs on every job. One with a list runs only on those jobs. */
export function playbookApplies(meta: Record<string, unknown> | undefined, taskType?: string): boolean {
  const types = taskTypesOf(meta);
  if (!types.length || !taskType) return true;
  return types.includes(taskType);
}

function overlayMap(
  live: Array<{ name: string; content: string; updated_at?: string; metadata?: Record<string, unknown> }>,
): Map<string, { content: string; enabled: boolean; at: string; versions: PlaybookVersion[]; metadata: Record<string, unknown> }> {
  const overlays = new Map<
    string,
    { content: string; enabled: boolean; at: string; versions: PlaybookVersion[]; metadata: Record<string, unknown> }
  >();
  for (const k of live) {
    const skill = skillNameFromPlaybook(k.name);
    if (!skill) continue;
    const at = k.updated_at ?? "";
    const prev = overlays.get(skill);
    if (prev && prev.at > at) continue;
    overlays.set(skill, {
      content: k.content,
      enabled: k.metadata?.enabled !== false,
      at,
      versions: versionsOf(k.metadata),
      metadata: k.metadata ?? {},
    });
  }
  return overlays;
}

/**
 * Disk skills, with live playbook overlays applied.
 *
 * A row with `enabled: false` drops the skill entirely — that is "this playbook is off", not
 * "fall back to the shipped file", because falling back would silently undo the founder's choice.
 * An overlay for a name that was never on disk is how they ADD a playbook.
 */
export function overlayPlaybooks(
  disk: WedgeFile[],
  live: Array<{ name: string; content: string; updated_at?: string; metadata?: Record<string, unknown> }>,
  taskType?: string,
): WedgeFile[] {
  const overlays = overlayMap(live);
  const out: WedgeFile[] = [];
  const seen = new Set<string>();
  const diskApplies = (content: string): boolean =>
    playbookApplies({ task_types: skillFrontmatterTaskTypes(content) }, taskType);
  for (const s of disk) {
    const name = skillFile(s.name);
    seen.add(name);
    const o = overlays.get(name);
    if (o && !o.enabled) continue;
    if (o && !playbookApplies(o.metadata, taskType)) {
      if (!diskApplies(s.content)) continue;
      out.push({ name, content: s.content });
      continue;
    }
    if (!o && !diskApplies(s.content)) continue;
    out.push(o ? { name, content: o.content } : { name, content: s.content });
  }
  for (const [name, o] of overlays) {
    if (seen.has(name) || !o.enabled) continue;
    if (!playbookApplies(o.metadata, taskType)) continue;
    out.push({ name, content: o.content });
  }
  return out;
}

/** What the founder-facing list needs: shipped files plus any overlay, with version history. */
export function listPlaybooks(
  disk: WedgeFile[],
  live: Array<{ name: string; content: string; updated_at?: string; metadata?: Record<string, unknown> }>,
): PlaybookRow[] {
  const overlays = overlayMap(live);
  const names: string[] = [];
  const diskBy = new Map<string, WedgeFile>();
  for (const s of disk) {
    const name = skillFile(s.name);
    diskBy.set(name, { name, content: s.content });
    names.push(name);
  }
  for (const name of overlays.keys()) {
    if (!diskBy.has(name)) names.push(name);
  }
  return names.map((name) => {
    const o = overlays.get(name);
    const shipped = diskBy.get(name);
    return {
      name,
      content: o?.content ?? shipped?.content ?? "",
      enabled: o ? o.enabled : true,
      source: o ? "yours" : "shipped",
      versions: o?.versions ?? [],
      updated_at: o?.at || undefined,
      task_types: o ? taskTypesOf(o.metadata) : skillFrontmatterTaskTypes(shipped?.content ?? ""),
    };
  });
}

export function playbookSaveMeta(
  existing: KnowledgeItem | undefined,
  args: { reason: string; enabled: boolean; now: string; task_types?: string[] },
): Record<string, unknown> {
  const versions = versionsOf(existing?.metadata);
  versions.push({ at: args.now, reason: args.reason });
  const task_types = args.task_types !== undefined ? args.task_types : taskTypesOf(existing?.metadata);
  return {
    ...(existing?.metadata ?? {}),
    playbook: true,
    enabled: args.enabled,
    versions,
    sensitivity: "house",
    ...(task_types.length ? { task_types } : { task_types: [] }),
  };
}

/** Title → skill filename. Refuses the same path fragments `safePlaybookName` does. */
export function playbookNameFromTitle(title: string): string | undefined {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return safePlaybookName(slug);
}

/** A founder-typed name becomes a skill filename. Path fragments are refused, not sanitised into a cousin. */
export function safePlaybookName(raw: string): string | undefined {
  const trimmed = raw.trim().toLowerCase().replace(/\.md$/i, "");
  if (!/^[a-z][a-z0-9_-]{0,62}$/.test(trimmed)) return undefined;
  return `${trimmed}.md`;
}
