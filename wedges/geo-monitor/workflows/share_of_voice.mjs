/**
 * Share of voice, computed rather than estimated.
 *
 * This is the number on the invoice. A model asked to "summarise how we did" will round in the
 * direction of the story it's telling — not dishonestly, just helpfully — and a client who checks
 * the arithmetic once and finds it wrong never trusts the report again. So the agent decides what to
 * measure; this decides what the number is.
 */
export default async function shareOfVoice({ results, client }) {
  const name = String(client ?? "").trim().toLowerCase();
  if (!name) throw new Error("client name is required to count mentions");

  const queries = results.length;
  // Substring, case-insensitive: models write "Acme", "Acme Ltd" and "Acme's" for the same company,
  // and an exact match would report zero visibility for a client who is in fact being cited.
  const mentioned = (cited) => cited.some((c) => String(c).toLowerCase().includes(name));

  const mentions = results.filter((r) => mentioned(r.cited ?? [])).length;

  // Who is winning the queries we lose. The actionable half of the report.
  const rivals = new Map();
  for (const r of results) {
    if (mentioned(r.cited ?? [])) continue;
    for (const c of r.cited ?? []) {
      const key = String(c).trim();
      if (!key || key.toLowerCase().includes(name)) continue;
      rivals.set(key, (rivals.get(key) ?? 0) + 1);
    }
  }

  return {
    queries,
    mentions,
    // One decimal place. Two implies a precision that a sample of thirty queries does not have.
    share_of_voice_pct: queries === 0 ? 0 : Math.round((mentions / queries) * 1000) / 10,
    top_competitors: [...rivals.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, beat_us_on]) => ({ name, beat_us_on })),
  };
}
