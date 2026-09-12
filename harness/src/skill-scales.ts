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
import type { TrialArm } from "./skill-trial";

const VOTE_COLLECTION = "skill_vote";
/**
 * ONE ROW PER DELIVERABLE PER VERDICT, WHICH IS THE DENOMINATOR THE SKILL VOTES CANNOT GIVE.
 *
 * `skill_vote` is per (deliverable × skill), because that is what a scale about a SKILL needs. A
 * trial about anything else — a model, a runtime setting, a prompt — needs the deliverable itself,
 * once, and summing the skill votes to get there overcounts every deliverable by however many
 * skills it happened to mount. A verdict that is confidently wrong about its own sample size is
 * worse than no verdict, because it will be believed.
 *
 * Keyed `(task, verdict)` rather than `(task)`: a deliverable is released and then, weeks later,
 * paid. Keying on the task alone would have the second event overwrite the first, silently deleting
 * the founder-stage decision the whole first-pass rate is drawn from.
 */
const TRIAL_COLLECTION = "trial_deliverable";
const MAX_VOTE_ROWS = 5000;

/**
 * What somebody decided about a deliverable, and therefore about the skills that produced it.
 *
 * TWO STAGES, DELIBERATELY NOT AVERAGED TOGETHER. A deliverable passes a founder before it passes a
 * client, and the two verdicts answer different questions:
 *
 *   · the FOUNDER stage asks "was this good enough to send" — the first-pass rate. It arrives within
 *     minutes, on every deliverable, and it is the only signal a business generates before it has
 *     any clients at all. It is also the harsher judge, which makes it the more useful one.
 *   · the CLIENT stage asks "was this right" — the acceptance rate. Slower, rarer, and the one that
 *     is actually about the work rather than about the house style.
 *
 * Rolling them into one number would let a founder's tidy-up cancel out a client's rejection, and
 * the resulting figure would describe nothing that happens in the world.
 */
export type SkillVerdict =
  /** The client signed it off. */
  | "accepted"
  /** The client sent it back. */
  | "changes_requested"
  /** The founder sent it to the client untouched — the agent's work went out as written. */
  | "released"
  /** The founder rewrote it first. The skill got close; it did not get there. */
  | "edited"
  /** The founder refused it outright and sent it back to drafting. */
  | "sent_back"
  /**
   * A client paid an invoice raised against this work. The end of the loop.
   *
   * A THIRD STAGE, and unlike the other two it has NO RATE — only a count. That is deliberate and it
   * is the part most likely to be "fixed" by somebody later, so: the absence of a payment is not
   * evidence that a deliverable was bad. It is evidence about the client's cash, about whether the
   * founder chased, about how long ago the invoice went out, and about whether there was a money
   * plan on the engagement at all. A `paid_rate` would put all of that in a number labelled "did
   * this procedure work" and the number would be mostly about something else.
   *
   * So payment counts UP and never down. It is the strongest confirmation available that the work
   * was worth what somebody charged for it, and it is silent about everything it did not observe.
   */
  | "paid";

/** Counts up, never down, and feeds no rate. See the note on `"paid"`. */
const MONEY_VERDICTS = new Set<SkillVerdict>(["paid"]);
/** The client-stage verdicts, which are the only ones the acceptance rate is drawn from. */
const CLIENT_VERDICTS = new Set<SkillVerdict>(["accepted", "changes_requested"]);
/** The founder-stage verdicts, which are the only ones the first-pass rate is drawn from. */
const FOUNDER_VERDICTS = new Set<SkillVerdict>(["released", "edited", "sent_back"]);

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
  /**
   * How many runs MOUNTED this skill, opened or not. The denominator of attention.
   *
   * Counted from the vote rows rather than the use rows, because the global scoreboard never sees a
   * use row — uses are tenant-scoped and carry a task id. Every settled deliverable contributes one
   * mounted tick per skill it mounted, which is the same population the acceptance rate is drawn
   * from, so the two numbers are about the same runs.
   */
  mounted: number;
  /** How many of those runs actually opened the file. */
  read: number;
  /** The founder sent it out untouched. */
  released: number;
  /** The founder rewrote it before sending. */
  edited: number;
  /** The founder refused it. */
  sent_back: number;
  /** released + edited + sent_back — how many founder decisions this rate rests on. */
  founder_total: number;
  /**
   * How many invoices were settled against work this skill helped produce.
   *
   * The only number here that somebody was willing to pay for, and the only one with no denominator
   * — see the note on the `"paid"` verdict for why a rate would be dishonest.
   */
  paid: number;
  /**
   * released / founder_total. Did the work go out as written.
   *
   * The number that moves first and moves most. A client verdict needs a client, arrives days later
   * and may never arrive at all; a founder decides on every deliverable within minutes of it
   * existing. For a library still finding its footing this is nearly all of the signal there is.
   */
  first_pass_rate: number;
  /**
   * read / mounted. The library's most actionable number and the one it never had.
   *
   * A skill mounted five hundred times and opened twice is a real problem that an acceptance rate
   * cannot show — with no votes it sits at zero beside everything else with no votes. Low attention
   * means the index line does not earn the click, or the skill is mounted into jobs it has nothing to
   * do with. Neither of those is "the procedure is bad", and both are fixable.
   */
  attention_rate: number;
}

/**
 * Record which skills a run mounted, so a later verdict on its deliverable can be attributed. Tenant
 * scoped, keyed by `(task, skill)` and upserted — a retried task rewrites its own rows rather than
 * doubling them. Fail-soft is the CALLER's job (a run must not fail because attribution could not be
 * written); this throws nothing a caller should swallow beyond a store outage.
 */
export async function recordSkillUses(
  domain: DomainStore,
  args: {
    project_id: string;
    task_id: string;
    wedge: string;
    /**
     * `read` says the agent actually opened the file. Optional, and absent means "not known" rather
     * than "no" — rows written before `skill-attention.ts` existed have no flag, and treating those
     * as unread would retroactively strip the evidence from every skill in the history.
     */
    skills: readonly { name: string; read?: boolean }[];
    /**
     * Which side of a trial this run was on. Absent on every run that is not in one, which is almost
     * all of them — `skillScales({ arm })` reads that absence as "not in a trial" rather than as a
     * third arm, so the ordinary case costs nothing and stores nothing.
     */
    arm?: "incumbent" | "challenger";
  },
): Promise<void> {
  if (!args.project_id || !args.task_id || !args.skills.length) return;
  const at = new Date().toISOString();
  for (const s of args.skills) {
    await domain.upsertRecord({
      project_id: args.project_id,
      wedge: SKILLS_WEDGE,
      collection: USE_COLLECTION,
      key: `${args.task_id}:${s.name}`,
      // Upsert by (task, skill), so the same row is rewritten when the run ends with what it learned
      // about attention. That is why this is safe to call twice for one run.
      data: {
        task_id: args.task_id,
        wedge: args.wedge,
        skill: s.name,
        at,
        ...(s.read === undefined ? {} : { read: s.read }),
        ...(args.arm ? { arm: args.arm } : {}),
      },
    });
  }
}

/**
 * A client settled a version — cast one vote per skill the producing run ACTUALLY READ, to the
 * tenant ledger AND the global scoreboard.
 *
 * Every mounted skill still gets a row (that is the denominator of attention); only a skill the agent
 * opened carries a verdict. Returns the number of VOTES, which is therefore not the number of rows —
 * 0 when the run mounted nothing, opened nothing, or the task is unknown to this project.
 *
 * The tenant comes from the argument and is pushed into the lookup, never post-filtered — a verdict
 * must never train another project's scale.
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
    /**
     * THE ATTRIBUTION RULE, AND IT IS THE WHOLE POINT OF THE `read` FLAG.
     *
     * A skill the agent never opened cannot have influenced the deliverable, whatever the client
     * then decided about it. Crediting it is not weak evidence, it is noise — and since a wedge
     * mounts roughly the same dozen skills every time, that noise is what made every skill in a
     * wedge converge on the wedge's own score.
     *
     * So a row always records that the skill was MOUNTED, and only a row that was READ carries a
     * verdict. `skillScales` counts them separately, which is what lets one number say "does this
     * procedure work" and the other say "is anyone opening it".
     *
     * `read === undefined` — a run from before attention was tracked — keeps its vote. Those rows
     * are the honest historical record under the old rule, and silently voiding them would delete
     * the library's entire history to make a new field look tidy.
     */
    const known = u.data?.read;
    const counted = known === undefined || known === true;
    const vote = {
      wedge,
      skill,
      at,
      mounted: true,
      ...(u.data?.arm === "challenger" || u.data?.arm === "incumbent" ? { arm: u.data.arm } : {}),
      ...(known === undefined ? {} : { read: known === true }),
      ...(counted ? { verdict: args.verdict } : {}),
    };

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
    // VOTES, not rows. A mounted-but-unread skill gets a row — that is how attention is counted —
    // and it is not a vote, because nothing was decided about it. Conflating the two made the return
    // value read as "two skills influenced this deliverable" when one of them was never opened.
    if (counted) cast += 1;
  }

  /**
   * ═══ THE DELIVERABLE-LEVEL LEDGER, WRITTEN ONLY WHEN A TRIAL IS ACTUALLY RUNNING ═══
   *
   * The arm is a property of the run, so every use row for one task carries the same one; reading
   * the first is not a shortcut. Absent means no trial was running when the work was produced, and
   * in that case nothing is written at all — an experiment mechanism that leaves rows behind when
   * no experiment exists is a mechanism whose cost is paid by everybody and whose benefit is paid
   * to nobody.
   *
   * Both scopes, for the same reason the votes use both: the tenant ledger is what an agency sees
   * about its own work, and the global one carries counts with no client content in them, which is
   * the only scope in which a question like "is this model as good" has enough evidence to answer.
   */
  const arm = uses.map((u) => u.data?.arm).find((a) => a === "incumbent" || a === "challenger");
  if (arm) {
    const row = { task_id: args.task_id, arm, verdict: args.verdict, at };
    await domain.upsertRecord({
      project_id: args.project_id,
      wedge: SKILLS_WEDGE,
      collection: TRIAL_COLLECTION,
      key: `${args.task_id}:${args.verdict}`,
      data: row,
    });
    await domain.upsertRecord({
      project_id: GLOBAL_SKILL_SCOPE,
      wedge: SKILLS_WEDGE,
      collection: TRIAL_COLLECTION,
      key: `${args.task_id}:${args.verdict}`,
      data: row,
    });
  }
  return cast;
}

/**
 * Both arms of a running trial, counted in DELIVERABLES.
 *
 * Feeds `judgeTrial` unchanged — same thresholds, same floor, same sentence a founder reads — so a
 * model trial is scored by exactly the rule a skill trial is: the share that went out without an
 * edit. That is deliberate. It is the number the console's learning curve plots and the number the
 * landing page promises to report, and a product that measures its own quality three different ways
 * has not measured it at all.
 */
export async function trialArms(
  domain: DomainStore,
  opts: { project_id?: string } = {},
): Promise<{ incumbent: TrialArm; challenger: TrialArm }> {
  const rows = await domain.queryRecords({
    project_id: opts.project_id ?? GLOBAL_SKILL_SCOPE,
    wedge: SKILLS_WEDGE,
    collection: TRIAL_COLLECTION,
    limit: MAX_VOTE_ROWS,
  });
  const arms = {
    incumbent: { decisions: 0, released: 0, paid: 0 },
    challenger: { decisions: 0, released: 0, paid: 0 },
  };
  for (const r of rows) {
    const arm = r.data?.arm;
    if (arm !== "incumbent" && arm !== "challenger") continue;
    const verdict = r.data?.verdict as SkillVerdict | undefined;
    if (!verdict) continue;
    if (MONEY_VERDICTS.has(verdict)) arms[arm].paid += 1;
    if (FOUNDER_VERDICTS.has(verdict)) {
      arms[arm].decisions += 1;
      if (verdict === "released") arms[arm].released += 1;
    }
  }
  return arms;
}

/**
 * The scales. With a `project_id`, an agency's own view; without one, the cross-tenant scoreboard.
 * Aggregated on read from the append-only votes — the same shape `outcomeStats` uses for moves, and
 * for the same reason: the ledger outlives any one enum and a read that recomputes cannot drift from
 * a materialised counter nobody updated.
 */
export async function skillScales(
  domain: DomainStore,
  /**
   * `arm` narrows to one side of a trial. Omit it for everything, which is what every existing
   * caller wants: a scoreboard should describe all the work, not one arm of an experiment that most
   * skills are not in.
   */
  opts: { project_id?: string; arm?: "incumbent" | "challenger" } = {},
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
    if (opts.arm) {
      // A row with no arm is a run that was not in a trial — not a third arm, and not a member of
      // either. Counting it into the incumbent side would let years of pre-trial history swamp the
      // eight deliverables the trial is actually deciding on.
      if (r.data?.arm !== opts.arm) continue;
    }
    const k = `${wedge}::${skill}`;
    const s =
      byKey.get(k) ??
      {
        wedge,
        skill,
        accepted: 0,
        revised: 0,
        total: 0,
        acceptance_rate: 0,
        released: 0,
        edited: 0,
        sent_back: 0,
        founder_total: 0,
        paid: 0,
        first_pass_rate: 0,
        mounted: 0,
        read: 0,
        attention_rate: 0,
      };
    byKey.set(k, s);

    // Every vote row is a run that mounted this skill. Rows written before `mounted` existed are
    // still such a run — the field was implied, not absent.
    s.mounted += 1;
    // `read` absent means the run predates attention tracking. Not counted as read (it is not known
    // to have been) and not counted against attention either — see the guard on `attention_rate`.
    if (r.data?.read === true) s.read += 1;

    // Skipped, never coerced: the ledger outlives any one enum, and a verdict this build does not
    // recognise is a row a later build may. Coercing it to the nearest known value would invent data.
    if (MONEY_VERDICTS.has(verdict as SkillVerdict)) {
      s.paid += 1;
      continue;
    }
    if (FOUNDER_VERDICTS.has(verdict as SkillVerdict)) {
      if (verdict === "released") s.released += 1;
      else if (verdict === "edited") s.edited += 1;
      else s.sent_back += 1;
      s.founder_total += 1;
      continue;
    }
    if (!CLIENT_VERDICTS.has(verdict as SkillVerdict)) continue;
    if (verdict === "accepted") s.accepted += 1;
    else s.revised += 1;
    s.total += 1;
  }

  const out = [...byKey.values()];
  for (const s of out) {
    s.acceptance_rate = s.total ? s.accepted / s.total : 0;
    s.first_pass_rate = s.founder_total ? s.released / s.founder_total : 0;
    s.attention_rate = s.mounted ? s.read / s.mounted : 0;
  }
  // Most-weighed first, then by how well it lands — a scoreboard reads top-down.
  // Most-weighed first, counting BOTH stages — a skill with forty founder decisions and no client
  // verdicts yet is better evidenced than one with a single acceptance, and sorting on client votes
  // alone would bury it.
  out.sort(
    (a, b) =>
      b.total + b.founder_total - (a.total + a.founder_total) ||
      b.paid - a.paid ||
      b.acceptance_rate - a.acceptance_rate ||
      b.first_pass_rate - a.first_pass_rate,
  );
  return out;
}
