// WHICH SKILLS ARE ASKING TO BE REWRITTEN — read off the scale, before anybody writes anything.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// WHY SELECTION IS ITS OWN MODULE
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// This was written against the self-improvement system, which turned a reflection run into a
// proposal a founder could approve. What was missing sat before that: nothing ever asked WHICH
// skill was worth reflecting on, so the library improved wherever attention happened to fall
// rather than where it was weakest.
//
// That system was deleted in 59f1dd83 — 261 sandbox-hours, four proposals, nothing adopted — and
// the deletion makes ranking MORE useful rather than less. A human has far less attention to spend
// than a reflection loop did, so pointing it at the weakest skill is the whole game.
//
// This is the part that turns a scoreboard into a work list. It is pure and takes the scale as data,
// because the whole value of the thresholds below is that they can be argued with — in a test, by a
// person, before a model is asked to rewrite a procedure that a business depends on.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// TWO DIAGNOSES, AND THEY NEED OPPOSITE FIXES
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// The reason `skill-attention.ts` split reading from mounting was not tidiness. It makes a
// distinction the acceptance rate cannot express, and getting it backwards wastes the expensive half
// of the loop:
//
//   · THE PROCEDURE IS WRONG. The agent opens the skill, follows it, and the founder rewrites the
//     result anyway. High attention, low first-pass. The fix is to rewrite the BODY, and that is a
//     reflection run over the founder's own edits.
//
//   · NOBODY OPENS IT. The skill is mounted into run after run and never read. Low attention. The
//     body may be excellent — it is never consulted, so it cannot be the reason anything failed. The
//     fix is to rewrite the DESCRIPTION, the one line the agent sees before deciding to open the
//     file, or to stop mounting it into jobs it has nothing to do with.
//
// Rewriting the body of a skill nobody reads is the most expensive no-op available: it costs a
// reflection run, a trial, weeks of split traffic, and it cannot possibly change an outcome. Naming
// the two apart is most of what this module is for.
//
// A third state is worth naming because it looks like a problem and is not: a skill with plenty of
// attention and a high first-pass rate is WORKING. It should never be a candidate, and a selector
// that ranks purely by "lowest score" would keep proposing rewrites of the best procedures in the
// library once the bad ones ran out.
import type { SkillScale } from "./skill-scales";

/**
 * How much evidence before a skill may be judged at all.
 *
 * Below this, a low rate is one or two bad afternoons. Proposing a rewrite on that basis teaches the
 * library to chase noise, and every rewrite costs a trial that occupies a fifth of the traffic for
 * weeks — so a false positive here is expensive in a way a missed one is not.
 */
export const MIN_EVIDENCE = 6;

/** Below this first-pass rate, a well-read skill is not doing its job. */
export const POOR_FIRST_PASS = 0.6;

/** Below this attention rate, the skill is not being consulted and its body is not the problem. */
export const POOR_ATTENTION = 0.25;

/**
 * How many times it must have been MOUNTED before low attention means anything.
 *
 * Higher than `MIN_EVIDENCE`, because attention is cheap to observe — every run that mounts a skill
 * reports on it, settled or not — so there is no reason to draw a conclusion from a handful.
 */
export const MIN_MOUNTS = 20;

export type Diagnosis = "rewrite_body" | "rewrite_description" | "healthy";

export interface Candidate {
  wedge: string;
  skill: string;
  diagnosis: Exclude<Diagnosis, "healthy">;
  /** A sentence naming what the evidence says, for the person who has to approve the rewrite. */
  why: string;
  /**
   * How much this is worth fixing: roughly, how many deliverables a year go out worse because of it.
   * Used only to order the work list — it is a rough count, never presented as a measurement.
   */
  weight: number;
}

/**
 * Diagnose one skill.
 *
 * ATTENTION IS CHECKED FIRST, and the order is the point. A skill nobody opens will also tend to
 * have a poor first-pass rate — it was mounted into runs that went badly for reasons it had no part
 * in — and checking the rate first would diagnose "the procedure is wrong" for a procedure that was
 * never read. That mistake is self-reinforcing: the rewritten body is also never read, the rate does
 * not move, and the skill is proposed for rewriting again.
 */
export function diagnose(s: SkillScale): Diagnosis {
  if (s.mounted >= MIN_MOUNTS && s.attention_rate < POOR_ATTENTION) return "rewrite_description";
  if (s.founder_total >= MIN_EVIDENCE && s.first_pass_rate < POOR_FIRST_PASS) return "rewrite_body";
  return "healthy";
}

const pct = (n: number): string => `${Math.round(n * 100)}%`;

/**
 * The work list, worst first.
 *
 * Returns only what the evidence supports. An empty list is a real and common answer — a library
 * with nothing wrong with it should produce no proposals, and a selector that always returns
 * something is a selector that eventually proposes rewriting the best skill on the shelf.
 */
export function candidates(scales: readonly SkillScale[], limit = 10): Candidate[] {
  const out: Candidate[] = [];
  for (const s of scales) {
    const diagnosis = diagnose(s);
    if (diagnosis === "healthy") continue;

    if (diagnosis === "rewrite_description") {
      out.push({
        wedge: s.wedge,
        skill: s.skill,
        diagnosis,
        why:
          `mounted into ${s.mounted} runs and opened in ${s.read} of them (${pct(s.attention_rate)}). ` +
          `The agent is not consulting it, so its body cannot be why anything failed — the line that ` +
          `describes it, or the jobs it is mounted into, is what needs changing.`,
        // Every run that mounted it and did not read it is a run that got no value from it.
        weight: s.mounted - s.read,
      });
      continue;
    }

    out.push({
      wedge: s.wedge,
      skill: s.skill,
      diagnosis,
      why:
        `read and followed, and the founder still rewrote the result: ${s.released} of ` +
        `${s.founder_total} deliverables went out untouched (${pct(s.first_pass_rate)})` +
        (s.total ? `, and clients accepted ${pct(s.acceptance_rate)} of what reached them` : "") +
        `. The procedure itself is what is not working.`,
      // Deliverables the founder had to fix or refuse. The thing the rewrite would win back.
      weight: s.founder_total - s.released,
    });
  }
  // Heaviest first: the same rewrite costs the same trial whatever it is worth, so the only sensible
  // order is how much work it buys back.
  out.sort((a, b) => b.weight - a.weight || a.skill.localeCompare(b.skill));
  return out.slice(0, Math.max(0, limit));
}

/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * CROSSING INTO THE SHARED SHELF
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The prize, and the most dangerous write in the system. A tenant that improves its own overlay has
 * learned something real; if the same procedure is underperforming for everyone, that lesson belongs
 * on the shelf every new business inherits.
 *
 * It is also the one write that reaches every customer at once, and `playbooks.ts`'s restore only
 * helps the tenant who notices. So this function does not promote anything. It answers whether
 * something is WORTH A HUMAN LOOKING AT, and the caller's only power is to put it in front of one.
 *
 * Three conditions, all required, and each rules out a specific way of being wrong:
 *
 *   1. THE OVERLAY WON A TRIAL. Not "the tenant edited it" — a founder rewriting a procedure to suit
 *      their own house style is the common case and generalises to nobody. Only a version that beat
 *      its incumbent on real deliverables has shown anything.
 *   2. THE SHARED VERSION IS ACTUALLY WEAK, globally. If the shelf's version works everywhere else,
 *      one agency doing better with a different one is evidence about that agency.
 *   3. THE GLOBAL EVIDENCE IS REAL. A shelf skill with four data points behind it has not been shown
 *      to be weak, and replacing it would be trading a known quantity for a stranger's preference.
 */
export interface PromotionCandidate {
  wedge: string;
  skill: string;
  why: string;
  /** Never true from this module. Present so a caller cannot mistake a candidate for a decision. */
  promoted: false;
}

export function promotionCandidate(args: {
  wedge: string;
  skill: string;
  /** Did the tenant's version beat the tenant's incumbent, on its own trial. */
  wonTrial: boolean;
  /** The cross-tenant scale row for the shipped skill. */
  global: SkillScale | undefined;
}): PromotionCandidate | undefined {
  if (!args.wonTrial) return undefined;
  const g = args.global;
  if (!g || g.founder_total < MIN_EVIDENCE * 2) return undefined;
  if (g.first_pass_rate >= POOR_FIRST_PASS) return undefined;
  return {
    wedge: args.wedge,
    skill: args.skill,
    why:
      `one business rewrote this and their version beat the shipped one on their own deliverables, ` +
      `while the shipped one goes out unedited only ${pct(g.first_pass_rate)} of the time across ` +
      `${g.founder_total} decisions everywhere. Worth reading their version — it is not worth ` +
      `shipping on this evidence alone.`,
    promoted: false,
  };
}
