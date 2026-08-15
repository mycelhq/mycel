// THE SCALES — which skills actually land the work, weighed across every business that runs them.
//
// ═══ WHAT THIS CLOSES ═══
//
// A skill is a procedure the agent reads before it does a piece of work. The kernel already mounts
// them, indexes them, learns new ones and overlays them per tenant — but it never knew which ones
// WORK. The set of skills a run mounted was computed in `runtime.ts` and thrown away, and a
// deliverable's acceptance (or the client sending it back) was recorded against the version and
// nowhere else. So "this web-dev skill lands nine times in ten, that one gets revised half the time"
// was unanswerable, and a growing library had no way to tell its good procedures from its noise.
//
// This module is the join. Two writes and one read:
//
//   1. `recordSkillUses` — at run time, one row per mounted skill, keyed by the task. Cheap, tenant
//      scoped, upsert (a retried task overwrites rather than double-counts).
//   2. `recordDeliverableVerdict` — when a client accepts a version or asks for changes, look up the
//      skills its producing run used and cast one VOTE per skill. Accepted is a win, changes a loss.
//   3. `skillScales` — aggregate the votes into an acceptance rate per skill.
//
// ═══ WHY THERE IS A GLOBAL LEDGER, AND WHY IT IS SAFE ═══
//
// A skill's identity — its `name` under a `wedge` — is not tenant-specific: the bookkeeping wedge's
// `monthly-close-review` skill is the same procedure in every agency that runs bookkeeping. So the
// signal that makes a shared library self-refine is the CROSS-TENANT one: promote the skill that
// lands everywhere, flag the one that gets sent back everywhere. `queryRecords` is fail-closed on
// `project_id` by design (there is deliberately no operator-wide read), so the global scale cannot be
// a scan across tenants. Instead every vote is ALSO written under a reserved global scope carrying
// ONLY `{ wedge, skill, verdict }` — no project, no client, no case, no content. The global ledger is
// a scoreboard of counts and nothing a tenant would not want counted; the per-tenant ledger, written
// under the real project, is what an agency sees about its own work.
import { randomUUID } from "node:crypto";
import type { DomainStore } from "./domain";

/** The ledger's wedge tag — the same role `MOVES_WEDGE` plays for the move-outcome ledger. */
export const SKILLS_WEDGE = "skills";

/**
 * The reserved scope the cross-tenant scoreboard lives under. Not a real project (real ids are
 * UUIDs), so it can never collide with a tenant, and `queryRecords` stays mechanically fail-closed —
 * reading the global scale is still a scoped read, the scope is just the scoreboard itself.
 */
export const GLOBAL_SKILL_SCOPE = "__mycel_global__";

const USE_COLLECTION = "skill_use";
const VOTE_COLLECTION = "skill_vote";
const MAX_VOTE_ROWS = 5000;

export type SkillVerdict = "accepted" | "changes_requested";

export interface SkillScale {
  wedge: string;
  skill: string;
  /** Versions accepted by a client, produced by a run that mounted this skill. */
  accepted: number;
  /** Versions sent back for changes. */
  revised: number;
  /** accepted + revised — the number of votes this rate rests on. */
  total: number;
  /** accepted / total, 0 when there are no votes yet. The scale. */
  acceptance_rate: number;
}

/**
 * Record which skills a run mounted, so a later verdict on its deliverable can be attributed. Tenant
 * scoped, keyed by `(task, skill)` and upserted — a retried task rewrites its own rows rather than
 * doubling them. Fail-soft is the CALLER's job (a run must not fail because attribution could not be
 * written); this throws nothing a caller should swallow beyond a store outage.
 */
export async function recordSkillUses(
  domain: DomainStore,
  args: { project_id: string; task_id: string; wedge: string; skills: readonly { name: string }[] },
): Promise<void> {
  if (!args.project_id || !args.task_id || !args.skills.length) return;
  const at = new Date().toISOString();
  for (const s of args.skills) {
    await domain.upsertRecord({
      project_id: args.project_id,
      wedge: SKILLS_WEDGE,
      collection: USE_COLLECTION,
      key: `${args.task_id}:${s.name}`,
      data: { task_id: args.task_id, wedge: args.wedge, skill: s.name, at },
    });
  }
}

/**
 * A client settled a version — cast one vote per skill the producing run used, to the tenant ledger
 * AND the global scoreboard. Returns how many votes were cast (0 when the run mounted no skills, or
 * the task is unknown to this project). The tenant comes from the argument and is pushed into the
 * lookup, never post-filtered — a verdict must never train another project's scale.
 */
export async function recordDeliverableVerdict(
  domain: DomainStore,
  args: { project_id: string; task_id?: string; verdict: SkillVerdict; at?: string },
): Promise<number> {
  if (!args.project_id || !args.task_id) return 0;
  const at = args.at ?? new Date().toISOString();
  const uses = await domain.queryRecords({
    project_id: args.project_id,
    wedge: SKILLS_WEDGE,
    collection: USE_COLLECTION,
    where: { task_id: args.task_id },
    limit: 200,
  });

  let cast = 0;
  for (const u of uses) {
    const skill = String(u.data?.skill ?? "");
    const wedge = String(u.data?.wedge ?? "");
    if (!skill || !wedge) continue;
    const vote = { wedge, skill, verdict: args.verdict, at };

    // Tenant ledger — what this agency sees about its own work.
    await domain.upsertRecord({
      project_id: args.project_id,
      wedge: SKILLS_WEDGE,
      collection: VOTE_COLLECTION,
      key: `${skill}:${randomUUID()}`,
      data: vote,
    });
    // Global scoreboard — counts only, no project/client/content. This is the scale a shared library
    // self-refines on.
    await domain.upsertRecord({
      project_id: GLOBAL_SKILL_SCOPE,
      wedge: SKILLS_WEDGE,
      collection: VOTE_COLLECTION,
      key: `${wedge}:${skill}:${randomUUID()}`,
      data: vote,
    });
    cast += 1;
  }
  return cast;
}

/**
 * The scales. With a `project_id`, an agency's own view; without one, the cross-tenant scoreboard.
 * Aggregated on read from the append-only votes — the same shape `outcomeStats` uses for moves, and
 * for the same reason: the ledger outlives any one enum and a read that recomputes cannot drift from
 * a materialised counter nobody updated.
 */
export async function skillScales(
  domain: DomainStore,
  opts: { project_id?: string } = {},
): Promise<SkillScale[]> {
  const scope = opts.project_id ?? GLOBAL_SKILL_SCOPE;
  const rows = await domain.queryRecords({
    project_id: scope,
    wedge: SKILLS_WEDGE,
    collection: VOTE_COLLECTION,
    limit: MAX_VOTE_ROWS,
  });

  const byKey = new Map<string, SkillScale>();
  for (const r of rows) {
    const wedge = String(r.data?.wedge ?? "");
    const skill = String(r.data?.skill ?? "");
    const verdict = r.data?.verdict;
    if (!wedge || !skill) continue;
    if (verdict !== "accepted" && verdict !== "changes_requested") continue; // outlives the enum: skip, never coerce
    const k = `${wedge}::${skill}`;
    const s = byKey.get(k) ?? { wedge, skill, accepted: 0, revised: 0, total: 0, acceptance_rate: 0 };
    if (verdict === "accepted") s.accepted += 1;
    else s.revised += 1;
    s.total += 1;
    byKey.set(k, s);
  }

  const out = [...byKey.values()];
  for (const s of out) s.acceptance_rate = s.total ? s.accepted / s.total : 0;
  // Most-weighed first, then by how well it lands — a scoreboard reads top-down.
  out.sort((a, b) => b.total - a.total || b.acceptance_rate - a.acceptance_rate);
  return out;
}
