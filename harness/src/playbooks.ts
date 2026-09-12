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
  /**
   * THE TEXT THIS SAVE REPLACED — so a change can actually be undone.
   *
   * It was not stored, and calling the list `versions` without it was the most expensive kind of
   * wrong: `updateKnowledge` overwrites content in place, so every save destroyed the previous text
   * and left behind a row saying WHEN it was destroyed and WHY. A founder could see that their
   * procedure changed on Tuesday for a reason they no longer agreed with, and had no way to get
   * Tuesday back. That is a changelog, not a version history.
   *
   * It was argued from a machine rewriting this file: the self-improvement system turned a
   * reflection run into a proposal an approval applied. That system was deleted in 59f1dd83 — 261
   * sandbox-hours, four proposals, nothing adopted — and what is left is a founder editing their own
   * procedure, which needs an undo for the same reason and with the same consequences.
   *
   * Optional because rows written before this existed genuinely do not have it, and because content
   * is dropped from the oldest entries when the history gets long — see `MAX_KEPT_BODIES`. An entry
   * with no content is still a true statement about when and why, which is what it always was.
   */
  content?: string;
}

/**
 * How many past bodies to keep, and why there is a limit at all.
 *
 * This history lives in the knowledge row's `metadata` JSON, alongside the live content. A skill is a
 * few kilobytes and an agency may edit one weekly for years; keeping every body without a bound
 * makes one row grow without limit, and the row is read on every run that mounts the playbook.
 *
 * Ten is enough to undo a bad week. Beyond that the ENTRY survives and only its body is dropped, so
 * the changelog stays complete and only the ability to restore that far back is lost — which is the
 * right thing to lose first.
 */
export const MAX_KEPT_BODIES = 10;

/** A version body larger than this is not kept. A skill is prose; something this size is not. */
export const MAX_VERSION_BYTES = 64_000;

/**
 * One version as the FOUNDER-FACING LIST describes it: when, why, and whether it can be put back.
 *
 * Deliberately not `PlaybookVersion`. That type now carries the replaced body, and `listPlaybooks`
 * feeds a page that renders every playbook a business has — shipping ten bodies per playbook to a
 * browser to render ten dates would be a payload that grows with how much care an agency has taken.
 * The body is fetched by the restore route, which needs exactly one of them.
 */
export interface PlaybookVersionSummary {
  at: string;
  reason: string;
  /** Whether an earlier text is on file. False for versions saved before restore existed. */
  restorable: boolean;
}

export interface PlaybookRow {
  name: string;
  content: string;
  enabled: boolean;
  source: "shipped" | "yours";
  versions: PlaybookVersionSummary[];
  /**
   * Whether a proposed version is currently being tried against this one.
   *
   * On the list rather than behind its own fetch, because a founder looking at their procedures needs
   * to know that a fifth of their runs are reading something else. A trial nobody can see from the
   * page that owns the procedure is an experiment running on real client work in the dark.
   */
  on_trial: boolean;
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

/**
 * The saved history of a playbook, newest last. Exported because the restore route needs to offer a
 * founder the list before it changes anything — a restore that could not first say what it would put
 * back would be one more irreversible write.
 */
export function playbookVersions(meta: Record<string, unknown> | undefined): PlaybookVersion[] {
  return versionsOf(meta);
}

/**
 * The version ON TRIAL, if there is one.
 *
 * Kept in the same row's metadata as the live text rather than in a second knowledge row, and that
 * placement is the argument for it: a trial is a fact ABOUT a procedure, and separating them means
 * two rows that can disagree about which skill is being tested, be deleted independently, or be
 * restored out of step. Promotion is then `content = challenger`, which the existing save path
 * already turns into a version with the old text on file — so winning a trial is undoable by exactly
 * the mechanism every other change is.
 */
export function playbookChallenger(meta: Record<string, unknown> | undefined): string | undefined {
  const c = (meta as Record<string, unknown> | undefined)?.challenger;
  if (!c || typeof c !== "object" || Array.isArray(c)) return undefined;
  const body = (c as Record<string, unknown>).content;
  return typeof body === "string" && body.trim() ? body : undefined;
}

/** Whether the overlay is live. A restore must not silently switch a disabled playbook back on. */
export function playbookEnabled(meta: Record<string, unknown> | undefined): boolean {
  return meta?.enabled !== false;
}

function versionsOf(meta: Record<string, unknown> | undefined): PlaybookVersion[] {
  const raw = meta?.versions;
  if (!Array.isArray(raw)) return [];
  const out: PlaybookVersion[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const v = item as Record<string, unknown>;
    if (typeof v.at !== "string" || typeof v.reason !== "string") continue;
    out.push({ at: v.at, reason: v.reason, ...(typeof v.content === "string" ? { content: v.content } : {}) });
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
): Map<string, { content: string; enabled: boolean; at: string; versions: PlaybookVersionSummary[]; metadata: Record<string, unknown> }> {
  const overlays = new Map<
    string,
    { content: string; enabled: boolean; at: string; versions: PlaybookVersionSummary[]; metadata: Record<string, unknown> }
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
      versions: versionsOf(k.metadata).map((v) => ({
        at: v.at,
        reason: v.reason,
        restorable: typeof v.content === "string" && v.content.length > 0,
      })),
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
/**
 * `arm` decides which side of a trial this run is on.
 *
 * Defaults to `"incumbent"`, so every caller that does not know about trials — and every run before
 * one exists — gets the procedure that has evidence behind it. A default of "challenger" would put
 * every unaware caller in the experiment, which is the wrong direction for a mistake to fail in.
 */
export function overlayPlaybooks(
  disk: WedgeFile[],
  live: Array<{ name: string; content: string; updated_at?: string; metadata?: Record<string, unknown> }>,
  taskType?: string,
  arm: "incumbent" | "challenger" = "incumbent",
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
    out.push(o ? { name, content: bodyFor(o, arm) } : { name, content: s.content });
  }
  for (const [name, o] of overlays) {
    if (seen.has(name) || !o.enabled) continue;
    if (!playbookApplies(o.metadata, taskType)) continue;
    out.push({ name, content: bodyFor(o, arm) });
  }
  return out;
}

/**
 * Which text this arm reads.
 *
 * A challenger with no body — a trial that was set up and never written, or metadata that lost its
 * content — falls back to the live text rather than mounting nothing. An empty skill is worse than
 * the wrong one: the agent reads a blank file and has no way to know a procedure was meant to be
 * there, and the resulting failure would be attributed to a trial that never actually ran.
 */
function bodyFor(
  o: { content: string; metadata: Record<string, unknown> },
  arm: "incumbent" | "challenger",
): string {
  if (arm !== "challenger") return o.content;
  return playbookChallenger(o.metadata) ?? o.content;
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
      on_trial: !!playbookChallenger(o?.metadata),
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
  // The body being REPLACED, captured on the way past. This is the only moment it exists in the same
  // place as the row that is about to overwrite it.
  const replaced = existing?.content;
  versions.push({
    at: args.now,
    reason: args.reason,
    ...(typeof replaced === "string" && replaced.length > 0 && replaced.length <= MAX_VERSION_BYTES
      ? { content: replaced }
      : {}),
  });
  // Drop the OLDEST bodies once there are too many, keeping their entries. A history that silently
  // truncates itself would be the same mistake in a smaller size.
  let bodies = versions.filter((v) => v.content !== undefined).length;
  for (const v of versions) {
    if (bodies <= MAX_KEPT_BODIES) break;
    if (v.content === undefined) continue;
    delete v.content;
    bodies -= 1;
  }
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
