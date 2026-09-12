// How good is the site the builder just made?
//
// ── WHY `require_substantive_change` WAS NOT ENOUGH ────────────────────────────────────────────
//
// substantive.ts answers "did the agent do any work" — three files, two thousand bytes, one file
// the template does not ship, cosmetic paths excluded. That was the right gate for the failure it
// was built for (a run that reskins globals.css and stops), and it is an EFFORT gate. Effort is not
// quality. A run can change four files, add a component, clear every threshold, and still hand back
// the template with different words in it.
//
// This file answers the other question, and it is the one the founder actually asked: is the result
// a site this business would be proud to send a client? That cannot be fully measured, so nothing
// here pretends to score taste. What it measures is the four things that reliably separate "we
// designed a site" from "we filled in a template", each of which is a fact about the bytes:
//
//   1. TEMPLATE RESIDUE. Stock seed copy still on the page. This is the single strongest negative
//      signal available and it is not a proxy — a deployed site carrying "Sunset Provisions" or
//      "Operations, run for you" is literally the template, in public, under the founder's domain.
//      A site can score well on everything else and still be a failure if this is non-zero.
//
//   2. AUTHORED SURFACE. Components the agent wrote, excluding `components/ui/**` (shadcn's own
//      output — `npx shadcn add card` writes files nobody authored) and excluding files the seed
//      already shipped. Sections are where design lives; recolouring is not.
//
//   3. TOKEN DISCIPLINE. Hardcoded hex in TSX means the theme is a lie: the value cannot respond to
//      dark mode and cannot follow the brand kit. It is also the most common way a generated page
//      looks fine in one theme and broken in the other, which nobody catches because nobody toggles.
//
//   4. SIGNATURE MOTIF. `design-the-front-page.md` calls the motif "the single most important
//      instruction on this page" and asks for it "once as a system". A motif used once is a
//      decoration; used three or more times it is a system. Repetition is measurable where beauty
//      is not, so repetition is what is measured.
//
// ── IT IS A SCORE, AND THE SCORE IS ADVISORY BY DEFAULT ────────────────────────────────────────
//
// Every number here is reported on the run whether or not it gates. That ordering is deliberate: a
// quality bar that fails builds before anyone has seen what it scores in practice would block real
// work on a threshold nobody has calibrated. Report first, gate once the distribution is known —
// and `minScore` exists so gating is a manifest change rather than a code change.
//
// TEMPLATE RESIDUE IS THE EXCEPTION and fails independently of the score. Shipping the seed's own
// customer testimonial under a real business's domain is not a low score, it is a wrong answer.

/** One file of the exported workspace. Paths are workspace-relative, POSIX. */
export interface SiteFile {
  path: string;
  text: string;
}

export interface SiteQuality {
  /** 0-100. Advisory unless the manifest sets a minimum. */
  score: number;
  /** Seed copy still present. Any hit is a failure on its own. */
  residue: string[];
  /** Components authored by the agent, excluding shadcn output and seed files. */
  authored: number;
  /** Hardcoded hex colours found in TSX. Should be zero. */
  hardcodedColors: number;
  /** The most-repeated bespoke class signature, and how often it appears. */
  motif: { token: string; uses: number } | null;
  /** One line per dimension, in the operator's words. */
  notes: string[];
  /**
   * A stable signature of the DESIGN DECISIONS this build made.
   *
   * ── WHY SAMENESS NEEDS ITS OWN MEASURE ───────────────────────────────────────────────────────
   *
   * Everything above measures one site against the TEMPLATE. Two builds can each score 95 against
   * the template and be identical to each other — same motif, same sections, same component picks,
   * different words. That is the founder's complaint restated at a different altitude: "do not build
   * the same thing every time." Divergence from the seed does not detect it, because both builds
   * genuinely diverged.
   *
   * So this is the comparison across builds. It is deliberately made of CHOICES rather than content:
   * the motif token, the section filenames, and which library components were pulled. Copy differs
   * between two businesses no matter what, so including it would make every fingerprint unique and
   * the check useless. If two businesses get the same motif and the same six sections, the
   * fingerprints match and the builder is repeating itself — which is exactly what we want to know.
   */
  fingerprint: string;
}

/**
 * Stock strings from `business-template`'s own marketing copy.
 *
 * Chosen because they are DISTINCTIVE — a fictional customer, a fictional company, and two headlines
 * no real agency would independently write. Generic words the seed also contains ("Get started",
 * "Contact us") are deliberately absent: they would fire on legitimate copy and train whoever reads
 * this to ignore it.
 */
export const SEED_RESIDUE = [
  "Sunset Provisions",
  // The full attribution, not just the name: a real agency could genuinely have a client called
  // Daniel Osei, and a false positive here blocks a legitimate build with an accusation.
  "Daniel Osei, Operations lead",
  "Email from Ana",
  "Operations, run for you",
  "Stop chasing the work that never gets done.",
  "Clients sign in here. Everything in flight, in one place.",
];

/** shadcn's output and other generated trees. Authored surface excludes these. */
const NOT_AUTHORED = [/^components\/ui\//, /^node_modules\//, /^\.next\//, /^public\//];

const isTsx = (p: string) => p.endsWith(".tsx");

/** `#fff`, `#ffffff`, `#ffffffff`. Not matched inside an obvious comment. */
const HEX = /#[0-9a-fA-F]{3,8}\b/g;

/**
 * A bespoke class signature: a Tailwind arbitrary value, which is what a designed motif looks like
 * in this codebase (`border-l-[3px]`, `bg-[oklch(...)]`, `grid-cols-[16rem_1fr]`). Utility classes
 * from the default scale are excluded because every template uses them; the arbitrary ones are
 * choices somebody made.
 */
const ARBITRARY = /\b[a-z-]+-\[[^\]\s]{2,40}\]/g;

export function scoreSite(files: SiteFile[], seedPaths: Set<string> = new Set()): SiteQuality {
  const notes: string[] = [];

  // 1. Residue.
  const residue: string[] = [];
  for (const f of files) {
    if (!isTsx(f.path) && !f.path.endsWith(".ts")) continue;
    for (const s of SEED_RESIDUE) {
      if (f.text.includes(s) && !residue.includes(s)) residue.push(s);
    }
  }

  // 2. Authored surface.
  const authored = files.filter(
    (f) =>
      isTsx(f.path) &&
      !NOT_AUTHORED.some((re) => re.test(f.path)) &&
      !seedPaths.has(f.path),
  ).length;

  // 3. Token discipline.
  let hardcodedColors = 0;
  for (const f of files) {
    if (!isTsx(f.path) || NOT_AUTHORED.some((re) => re.test(f.path))) continue;
    hardcodedColors += (f.text.match(HEX) ?? []).length;
  }

  // 4. Motif: the most-repeated arbitrary class across authored TSX.
  const uses = new Map<string, number>();
  for (const f of files) {
    if (!isTsx(f.path) || NOT_AUTHORED.some((re) => re.test(f.path))) continue;
    for (const m of f.text.match(ARBITRARY) ?? []) uses.set(m, (uses.get(m) ?? 0) + 1);
  }
  const best = [...uses.entries()].sort((a, b) => b[1] - a[1])[0];
  // Three is the line between a decoration and a system — see the header.
  const motif = best && best[1] >= 3 ? { token: best[0], uses: best[1] } : null;

  // ── The score. Weighted toward the two things that actually distinguish the output. ──────────
  let score = 0;

  // Authored surface, 40. Five bespoke components is a designed page; one is a tweak.
  const authoredPoints = Math.min(40, authored * 8);
  score += authoredPoints;
  notes.push(
    authored === 0
      ? "No component was authored outside the template and shadcn's own output."
      : `${authored} authored component${authored === 1 ? "" : "s"} beyond the seed.`,
  );

  // Motif, 30. The instruction the design skill calls the most important one on the page.
  if (motif) {
    score += 30;
    notes.push(`Signature motif "${motif.token}" used ${motif.uses} times — repeated as a system.`);
  } else {
    notes.push("No repeated signature motif. The page reads as assembled rather than designed.");
  }

  // Token discipline, 30, and it is all-or-nothing on purpose: one hardcoded colour is one place
  // the dark theme is already broken, and "mostly themed" is not a state worth part-crediting.
  if (hardcodedColors === 0) {
    score += 30;
    notes.push("No hardcoded colours — every value comes from a token.");
  } else {
    notes.push(
      `${hardcodedColors} hardcoded colour${hardcodedColors === 1 ? "" : "s"} in TSX. These cannot follow the theme or the brand kit.`,
    );
  }

  if (residue.length > 0) {
    notes.push(
      `TEMPLATE COPY STILL ON THE PAGE: ${residue.join(", ")}. This is the seed, deployed under the founder's domain.`,
    );
  }

  // Sorted, so file order in the export cannot change the signature. Names only — the point is
  // WHICH decisions were made, not what was written inside them.
  const sectionNames = files
    .filter((x) => isTsx(x.path) && !NOT_AUTHORED.some((re) => re.test(x.path)) && !seedPaths.has(x.path))
    .map((x) => x.path.split("/").pop()!.replace(/\.tsx$/, ""))
    .sort();
  const libraryPicks = files
    .filter((x) => /^components\/ui\//.test(x.path) && !seedPaths.has(x.path))
    .map((x) => x.path.split("/").pop()!.replace(/\.tsx$/, ""))
    .sort();
  const fingerprint = [motif?.token ?? "no-motif", sectionNames.join(","), libraryPicks.join(",")].join("|");

  return { score, residue, authored, hardcodedColors, motif, notes, fingerprint };
}

/**
 * The verdict a workspace check can act on.
 *
 * Residue fails regardless of score, and says so first — it is the only finding here that is a
 * wrong answer rather than a weak one.
 */
/**
 * Has the builder made this exact site before?
 *
 * Compared against the fingerprints of previous builds. A repeat is not a hard failure — two
 * genuinely similar businesses can legitimately want a similar shape, and refusing that would be
 * worse than allowing it — so this returns a WARNING the run reports and a human can read. What it
 * prevents is the silent version: fifty founders, fifty sites, one design.
 */
export function repeatWarning(fingerprint: string, previous: readonly string[]): string | undefined {
  if (!previous.includes(fingerprint)) return undefined;
  return (
    "this build has the same motif, sections and component picks as an earlier one. " +
    "Two businesses received the same design; vary the section plan and the signature motif."
  );
}

export function siteQualityFault(q: SiteQuality, minScore?: number): string | undefined {
  if (q.residue.length > 0) {
    return (
      `the deployed site still carries the template's own copy (${q.residue.join(", ")}). ` +
      `Replace every stock string with this business's own words before shipping.`
    );
  }
  if (minScore != null && q.score < minScore) {
    return `site quality ${q.score}/100, below the ${minScore} this wedge requires. ${q.notes.join(" ")}`;
  }
  return undefined;
}
