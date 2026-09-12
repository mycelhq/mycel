// More of the clients you already won — scored on what actually won, never on what looks similar.
//
// ═══ WHY THIS IS ARITHMETIC AND NOT A MODEL ═══
//
// "Find me more companies like my best clients" is the most natural thing a founder asks and the
// easiest question in the product to answer badly. Hand it to a language model with a list of won
// accounts and it will produce a confident description of an ideal customer — assembled from what
// those accounts have in COMMON, which at n=3 is everything: they are all companies, all have
// websites, all are in the same country you sell in.
//
// Commonality is not evidence. `win-patterns.mjs` already does the hard half: it measures which
// attributes actually convert, refuses to report a segment under `min_sample`, refuses to call a
// no-win segment bad rather than unproven, and measures lift against the base rate rather than
// against the worst thing tried. This ranks candidates against THAT, and against nothing else.
//
// ═══ THE RULE THAT DOES THE WORK: ONLY PROVEN PATTERNS SCORE ═══
//
// `win_patterns` hands back two lists. `patterns` are the segments that cleared the bar. `unproven`
// are segments that exist and cannot yet be judged — four bakeries and one win.
//
// Only the first list is allowed to move a candidate up. Letting `unproven` contribute would launder
// the exact noise win-patterns went to the trouble of quarantining, and it would do it invisibly:
// the founder sees a ranked list, not the evidence behind each row, unless we put the evidence in
// the row. Which is why every result below carries the numbers that put it there.
//
// ═══ AND WHY MATCHES DO NOT COMPOUND ═══
//
// A candidate matching two proven patterns is NOT ranked as 2.1 × 1.7. Those lifts are measured over
// overlapping populations — "London" and "under 20 staff" are the same accounts twice — so
// multiplying them claims a compounding effect the data cannot support, and the number it produces
// is the most confident-looking thing on the page.
//
// So: rank by the STRONGEST pattern a candidate matches, using the confidence floor rather than the
// raw rate, and use the number of matches only to break ties. A founder can check that claim against
// one segment. They cannot check a product of three.
//
// Founder code. Pure: no I/O, no clock, no randomness.

const norm = (v) => String(v ?? "").trim().toLowerCase();

/** A candidate cannot be judged on an attribute it does not carry. Absence is not a failure. */
const attributeOf = (candidate, key) => {
  const direct = candidate?.[key];
  if (direct !== undefined && direct !== null && String(direct).trim()) return norm(direct);
  const nested = candidate?.attributes?.[key];
  return nested !== undefined && nested !== null && String(nested).trim() ? norm(nested) : undefined;
};

export default function lookalike(args) {
  const patterns = Array.isArray(args?.patterns) ? args.patterns : [];
  const candidates = Array.isArray(args?.candidates) ? args.candidates : [];
  if (!candidates.length) throw new Error("candidates must not be empty — there is nothing to rank");

  /**
   * NO PROVEN PATTERNS IS A REFUSAL, AND IT IS THE COMMON CASE EARLY ON.
   *
   * A founder six weeks in has no patterns, and `win_patterns` says so. Ranking anyway would mean
   * ranking on nothing and presenting it in the same shape as a real answer — which is how the
   * fourth thing a tool tells you stops being believed.
   */
  const proven = patterns.filter((p) => p && p.value && p.attribute && Number.isFinite(p.confidence_floor));
  if (!proven.length) {
    return {
      ready: false,
      ranked: [],
      why_not:
        "Nothing has been proven to convert yet, so there is no pattern to match against. This needs more closed deals, not more leads — ranking on a guess would look exactly like ranking on evidence.",
    };
  }

  /** Strongest first, by the floor rather than the rate — a 100% on three leads is not a pattern. */
  const byStrength = [...proven].sort((a, b) => b.confidence_floor - a.confidence_floor);

  // Already in the book. Ranking somebody you are mid-conversation with as a fresh prospect is how a
  // founder ends up opening a second thread with the same person.
  const known = new Set((Array.isArray(args?.exclude) ? args.exclude : []).map(norm).filter(Boolean));

  const ranked = [];
  const skipped = [];
  for (const candidate of candidates) {
    const name = String(candidate?.name ?? "").trim();
    if (!name) continue;
    if (known.has(norm(name)) || (candidate.domain && known.has(norm(candidate.domain)))) {
      skipped.push({ name, why: "already in your pipeline" });
      continue;
    }

    const matched = byStrength.filter((p) => attributeOf(candidate, p.attribute) === norm(p.value));
    if (!matched.length) continue; // Not a lookalike. Silence, rather than a row scored zero.

    const best = matched[0];
    ranked.push({
      name,
      ...(candidate.domain ? { domain: String(candidate.domain) } : {}),
      /** The floor of the strongest pattern matched. Never a product of several — see the header. */
      score: best.confidence_floor,
      matched: matched.map((p) => ({ attribute: p.attribute, value: p.value, win_rate: p.win_rate, n: p.n, lift: p.lift })),
      /**
       * The evidence, in the founder's words, on the row. A ranked list without it is a ranked list
       * nobody can argue with, and a founder who cannot argue with a ranking does not act on it.
       */
      why:
        matched.length === 1
          ? `${best.value} (${best.attribute}) has won ${best.win_rate} across ${best.n} leads.`
          : `${best.value} (${best.attribute}) has won ${best.win_rate} across ${best.n} leads, and it matches ${matched.length - 1} other proven pattern${matched.length === 2 ? "" : "s"}.`,
    });
  }

  // Strongest pattern first; more matches breaks a tie; name last so the order is stable and a test
  // can assert it.
  ranked.sort((a, b) => b.score - a.score || b.matched.length - a.matched.length || a.name.localeCompare(b.name));

  const limit = Math.max(1, Math.min(200, Math.floor(Number(args?.limit ?? 25))));
  const shown = ranked.slice(0, limit);
  const rest = ranked.length - shown.length;

  return {
    ready: true,
    ranked: shown,
    /** Named, never silently dropped — see the note in `chartBlock` about truncation reading as coverage. */
    ...(rest > 0 ? { not_shown: rest } : {}),
    ...(skipped.length ? { skipped } : {}),
    /** What the ranking is actually built on, so a founder can disagree with the criteria. */
    matched_on: byStrength.slice(0, 5).map((p) => `${p.value} (${p.attribute}) — ${p.win_rate} of ${p.n}`),
    headline: shown.length
      ? `${ranked.length} of ${candidates.length} look like the clients you have actually won. The strongest match is ${shown[0].name}: ${shown[0].why}`
      : `None of these ${candidates.length} match a pattern that has been proven to convert. That is a real answer — a list of near-misses would be worse than an empty one.`,
  };
}
