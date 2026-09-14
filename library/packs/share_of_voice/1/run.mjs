/**
 * Share of voice, computed rather than estimated.
 * Billing-grade number — the agent decides what to measure; this decides what the number is.
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * A PROBE THAT NEVER GOT AN ANSWER IS NOT A QUERY WHERE THE CLIENT WAS ABSENT
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * This divided by `results.length`, which counted every probe — including the ones that came back
 * `reached: false` because the surface showed a captcha, a login wall or a consent gate.
 *
 * `probe_surface` returns `cited: []` on those runs, correctly and deliberately: it refuses to
 * invent an answer it could not see. But an empty citation list is indistinguishable from "the
 * assistant answered and did not mention you" once it reaches this function, so a blocked probe was
 * counted as evidence of absence.
 *
 * The arithmetic: ten queries, six captcha'd, the brand named in three of the four that actually
 * returned an answer. The truth is 75%. This function said 30%.
 *
 * And it fails in the worst available direction. The harder a surface blocks automation, the lower
 * the client's reported visibility — so the number moves with OUR access and is read as a change in
 * THEIR market. A client would be shown a collapsing share of voice, told to buy more work to fix
 * it, and invoiced on the strength of it. This is not a hypothetical: a production probe of
 * chatgpt.com on 30 August 2026 came back `reached: false, blocked_by: "captcha"`.
 *
 * So: reached probes are the denominator, unreached ones are reported separately, and a period where
 * nothing was reached returns `null` rather than `0`. Zero per cent is a finding. No measurement is
 * not a finding, and the difference is the whole product.
 */
export default async function shareOfVoice({ results, client }) {
  const name = String(client ?? "").trim().toLowerCase();
  if (!name) throw new Error("client name is required to count mentions");

  const all = Array.isArray(results) ? results : [];

  /**
   * MISSING MEANS REACHED, and that is a deliberate reading rather than an oversight.
   *
   * Rows written before `reached` existed carry real citation lists gathered from real answers.
   * Defaulting them to unreached would erase every historical measurement and drop the client's
   * whole trend line the moment this shipped.
   *
   * Only an EXPLICIT `reached: false` — which is exactly what a blocked probe writes — is excluded.
   */
  const reached = all.filter((r) => r?.reached !== false);
  const unreached = all.length - reached.length;

  const mentioned = (cited) => (cited ?? []).some((c) => String(c).toLowerCase().includes(name));
  const mentions = reached.filter((r) => mentioned(r.cited)).length;

  const rivals = new Map();
  for (const r of reached) {
    if (mentioned(r.cited)) continue;
    for (const c of r.cited ?? []) {
      const key = String(c).trim();
      if (!key || key.toLowerCase().includes(name)) continue;
      rivals.set(key, (rivals.get(key) ?? 0) + 1);
    }
  }

  /** Which surfaces refused, and why. A client is owed the reason their number has a hole in it. */
  const blocked = new Map();
  for (const r of all) {
    if (r?.reached !== false) continue;
    const key = `${r.surface ?? "unknown"}: ${r.blocked_by ?? "not stated"}`;
    blocked.set(key, (blocked.get(key) ?? 0) + 1);
  }

  return {
    /** Probes that returned an answer. The denominator, and the sample the client should be quoted. */
    queries: reached.length,
    mentions,
    /** Probes that never got an answer. Never folded into the percentage, always reported. */
    unreached,
    /** `null`, not `0`, when nothing was reached. A percentage over an empty sample is not a number. */
    share_of_voice_pct: reached.length === 0 ? null : Math.round((mentions / reached.length) * 1000) / 10,
    ...(blocked.size ? { blocked_by: [...blocked.entries()].map(([reason, n]) => ({ reason, n })) } : {}),
    top_competitors: [...rivals.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([n, beat_us_on]) => ({ name: n, beat_us_on })),
  };
}
