/**
 * Share of voice, computed rather than estimated.
 * Billing-grade number — the agent decides what to measure; this decides what the number is.
 */
export default async function shareOfVoice({ results, client }) {
  const name = String(client ?? "").trim().toLowerCase();
  if (!name) throw new Error("client name is required to count mentions");

  const queries = Array.isArray(results) ? results.length : 0;
  const mentioned = (cited) =>
    (cited ?? []).some((c) => String(c).toLowerCase().includes(name));

  const mentions = (results ?? []).filter((r) => mentioned(r.cited)).length;

  const rivals = new Map();
  for (const r of results ?? []) {
    if (mentioned(r.cited)) continue;
    for (const c of r.cited ?? []) {
      const key = String(c).trim();
      if (!key || key.toLowerCase().includes(name)) continue;
      rivals.set(key, (rivals.get(key) ?? 0) + 1);
    }
  }

  return {
    queries,
    mentions,
    share_of_voice_pct: queries === 0 ? 0 : Math.round((mentions / queries) * 1000) / 10,
    top_competitors: [...rivals.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([n, beat_us_on]) => ({ name: n, beat_us_on })),
  };
}
