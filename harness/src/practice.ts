// ═══════════════════════════════════════════════════════════════════════════════════════════════
// HOW THIS FIRM PRACTISES ITS TRADE
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//
// Every delivery run mounts three things about standard and, until now, nothing about METHOD.
// `exemplarSkills` mounts the founder's own past work as the bar. `continuitySkills` mounts what
// this client was sent last month. `sharedCraft` mounts craft nobody's trade owns. All of them
// answer "how good does this have to be" or "what did we already say". None answers "how is this
// work actually done here".
//
// That question was answered by the WEDGE, and the wedge is ours. Thirteen trades, their task
// types, their workflows, their idea of what a job is - all written by us, before we had met a
// single customer. A firm that did not fit one got the nearest neighbour, and the nearest
// neighbour is a different business. Their uploaded exemplar could override our VOICE and never
// our METHOD, because method lived in a manifest they had no part in writing.
//
// So the method comes from their work now. `business-shaper`'s `draft_practice` reads the artefact
// they actually shipped and derives the practice: what the deliverable is, its spine, what it needs
// each cycle, what makes one correct. This mounts that into every subsequent delivery run.
//
// ═══ THE CATALOGUE IS NOT DELETED, IT IS DEMOTED ═══
//
// The wedges are still here and still carry real value: knowledge, skills, procedures, checks
// somebody had to learn the hard way. What they no longer do is decide what a customer is allowed
// to be. They are reference the model can read, not a menu the customer picks from.
//
// ═══ WHY IT OUTRANKS THE WEDGE AND NOT THE EXEMPLAR ═══
//
// Order of authority in a delivery run, highest first:
//
//   1. `continuitySkills` - what this client actually holds. Facts, not preferences.
//   2. `exemplarSkills`   - the founder's own shipped work. The bar, in their voice.
//   3. THIS               - the derived practice. Method, inferred from 2.
//   4. the wedge          - our reference. The floor, when they have shown us nothing.
//
// Below the exemplar deliberately: this is a MODEL'S READING of their work and the work itself is
// the primary source. Where the two disagree the artefact wins, because one of them is evidence
// and the other is an inference from it. Above the wedge for the same reason in reverse - an
// inference from their actual output beats a manifest written before we met them.
//
// ═══ FAIL-SOFT, LIKE EVERY OTHER MOUNT ON THIS PATH ═══
//
// No practice derived yet means no practice mounted, and the run proceeds on the wedge as it always
// did. A tenant who has never uploaded anything is not broken, they are just being served by the
// floor. That is also what makes this safe to ship before every account has one.

import type { DomainStore } from "./domain";
import type { MountedSkill } from "./compile";

/** Stored under the shaping wedge, alongside the exemplar it was derived from. */
export const PRACTICE_COLLECTION = "practice";

/**
 * Long enough to carry a spine and its exceptions, short enough that it cannot crowd out the
 * exemplar it was derived from. The exemplar is the evidence; this is the reading of it, and a
 * reading that takes more room than its source is a reading that has started inventing.
 */
const MAX_CHARS = 9_000;

export interface DerivedPractice {
  /**
   * Set when a human has read this back and said it is right, or corrected it until it was.
   *
   * The distinction is mounted, not just stored. A practice nobody has checked is a model's reading
   * of one artefact, and an agent that treats it as house rule will defend an inference the founder
   * has never seen against their actual preference. Saying which it is costs two lines and is the
   * difference between a system that is confidently wrong and one that is correctable.
   */
  confirmed_at?: string;
  deliverable?: string;
  answers?: string;
  cadence?: string;
  needs?: string[];
  checks?: string[];
  practice?: string;
}

function lines(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x ?? "").trim()).filter(Boolean).slice(0, 24);
}

/**
 * The practice, as a mounted skill, for one project.
 *
 * `wedgeForRole("business_shaping")` rather than a directory name, for the reason `exemplar.ts`
 * records: a hardcoded wedge string here is the same defect as every other hardcoded vocabulary in
 * this repo, one layer down, and there is a test that fails on it.
 */
export async function practiceSkills(
  domain: DomainStore,
  shaperWedge: string | undefined,
  projectId?: string,
): Promise<MountedSkill[]> {
  if (!projectId || !shaperWedge) return [];

  const rows = await domain
    .queryRecords({ project_id: projectId, wedge: shaperWedge, collection: PRACTICE_COLLECTION, limit: 1 })
    .catch(() => []);
  const row = rows[0];
  if (!row) return [];

  const d = (row.data ?? {}) as DerivedPractice;
  const body = String(d.practice ?? "").trim();
  if (!body) return [];

  const needs = lines(d.needs);
  const checks = lines(d.checks);
  const name = String(d.deliverable ?? "").trim() || "this deliverable";

  const confirmed = Boolean(String(d.confirmed_at ?? "").trim());

  const out = [
    `# How this firm produces ${name}`,
    "",
    confirmed
      ? "The founder has read this back and confirmed it. Treat it as house rule: where a general\nconvention disagrees with it, this wins."
      : "Derived by reading work this firm has already sent a paying client, and NOT YET CONFIRMED by\nthem. Treat it as a strong prior rather than as instruction. Where it disagrees with the exemplar\nmounted alongside it the exemplar wins, because that is the actual artefact and this is a reading\nof it. If following it would produce something you think the founder would reject, say so in the\ndraft rather than complying silently.",
    "",
    "It describes THIS firm's method, not a category's.",
    "",
  ];

  if (d.answers) out.push(`**The question the client is buying an answer to.** ${d.answers}`, "");
  if (d.cadence && d.cadence.toLowerCase() !== "unknown") out.push(`**Cadence.** ${d.cadence}`, "");

  if (needs.length) {
    out.push(
      "**What this needs before it can be written.** If something here is missing, say so in the",
      "draft rather than writing around the hole - a gap that is named is a question the founder can",
      "answer in a minute, and a gap that is papered over is a claim resting on nothing.",
      "",
      ...needs.map((n) => `- ${n}`),
      "",
    );
  }

  if (checks.length) {
    out.push(
      "**What has to be true for this to be correct.** These are refusal conditions, not aspirations.",
      "A draft that fails one is held with the reason, not sent and apologised for.",
      "",
      ...checks.map((c) => `- ${c}`),
      "",
    );
  }

  out.push("---", "", body.length > MAX_CHARS ? `${body.slice(0, MAX_CHARS)}\n\n[…clipped]` : body);

  return [{ name: `practice:${name}`, content: out.join("\n") }];
}
