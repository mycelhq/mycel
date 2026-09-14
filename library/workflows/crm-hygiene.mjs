// Duplicates, rot, and the people you already have who went quiet.
//
// ═══ THREE JOBS, ONE PASS, BECAUSE THEY ARE ONE READ ═══
//
// A CRM cleaner, a duplicate killer and a dormant reviver were asked for separately and they all
// begin by walking the same list and asking "what is this record, and is it the same as that one".
// Splitting them into three passes means three walks, three ideas of what "the same" means, and the
// day they disagree a founder gets a revival email sent to a duplicate.
//
// ═══ WHY IT PROPOSES AND NEVER WRITES ═══
//
// Nothing here mutates anything. It returns merges to make, fields to fix and people worth waking,
// and a human or a gated action applies them.
//
// A dedupe that acts on its own is the highest-regret automation in a CRM: merging two records that
// were genuinely two people destroys history that cannot be reconstructed, and it does it silently
// and in bulk. The asymmetry is total — an unmerged duplicate costs one awkward email, a wrong merge
// costs the relationship and the record of it. So it proposes, with the evidence, and the confident
// cases are marked so a human can wave them through in one click without reading forty rows.
//
// Founder code. Pure: no I/O, no clock, no randomness. `now` is passed in, never read.

const norm = (v) => String(v ?? "").trim().toLowerCase();

/** `www.` and a trailing dot removed; the bare host is the identity of a business. */
const domainOf = (v) => {
  const s = norm(v).replace(/^https?:\/\//, "").split("/")[0] ?? "";
  return s.replace(/^www\./, "").replace(/\.$/, "");
};

/**
 * A person's name reduced for comparison.
 *
 * Accents folded, punctuation dropped, order kept. "José García" and "Jose Garcia" are one person;
 * "Garcia Jose" is left alone, because reordering names to match is how a Hungarian record merges
 * with a Spanish one.
 */
const nameKey = (v) =>
  norm(v)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Free mailboxes: a shared domain is not evidence two people are the same company. */
const FREE_MAIL =
  /^(gmail|googlemail|outlook|hotmail|live|yahoo|ymail|icloud|me|aol|proton|protonmail|gmx|mail|zoho|fastmail)\./;

const EMAIL_RE = /^[^@\s]+@[^@\s.]+\.[^@\s]+$/;

/**
 * Everything wrong with one record, as things a person can act on.
 *
 * Deliberately not a score. "Data quality: 62" tells a founder nothing they can do; "no email, and
 * the phone is four digits" tells them exactly what to fix or drop.
 */
function faultsOf(r) {
  const out = [];
  const email = norm(r.email);
  if (!email && !r.linkedin_url && !r.phone) out.push("no way to reach them at all");
  if (email && !EMAIL_RE.test(email)) out.push(`"${r.email}" is not a valid email address`);
  if (email && /^(info|hello|contact|enquiries|admin|office|sales|support|team|mail)@/.test(email)) {
    // Not a fault exactly — a shared inbox is often the ONLY way into a small business — but it
    // changes how you write to it, and a sequence that opens "Hi Sarah" to info@ is the tell.
    out.push("a shared inbox rather than a person");
  }
  const phone = String(r.phone ?? "").replace(/\D/g, "");
  if (r.phone && phone.length < 7) out.push(`"${r.phone}" is too short to be a phone number`);
  if (!norm(r.name) && !norm(r.company)) out.push("neither a person nor a company name");
  if (r.company && domainOf(r.company_domain) && FREE_MAIL.test(`${domainOf(r.company_domain)}.`)) {
    out.push("the company domain is a free mailbox provider");
  }
  return out;
}

/**
 * The identity keys for one record, strongest first.
 *
 * An exact match on ANY of these is a duplicate worth proposing. They are ordered by how much a
 * match is worth, and that order is what separates "merge this" from "a human should look".
 */
function keysOf(r) {
  const out = [];
  const email = norm(r.email);
  if (email && EMAIL_RE.test(email)) out.push({ kind: "email", key: email, strong: true });
  const li = norm(r.linkedin_url).replace(/\/+$/, "").replace(/^https?:\/\/(www\.)?linkedin\.com\//, "");
  if (li) out.push({ kind: "linkedin", key: li, strong: true });
  const phone = String(r.phone ?? "").replace(/\D/g, "");
  if (phone.length >= 9) out.push({ kind: "phone", key: phone.slice(-9), strong: true });

  const domain = domainOf(r.company_domain);
  const person = nameKey(r.name);
  // Name AND company domain together. Either alone is not identity: two people share a domain, and
  // two businesses share a founder's name.
  if (person && domain && !FREE_MAIL.test(`${domain}.`)) {
    out.push({ kind: "name+domain", key: `${person}@${domain}`, strong: false });
  }
  // A company record with no person: the domain IS the identity.
  if (!person && domain && !FREE_MAIL.test(`${domain}.`)) {
    out.push({ kind: "domain", key: domain, strong: false });
  }
  return out;
}

/** Days between two ISO dates, or undefined when either is missing or unparseable. */
function daysBetween(a, b) {
  const x = Date.parse(a ?? "");
  const y = Date.parse(b ?? "");
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  return Math.floor((y - x) / 86_400_000);
}

/** Stages where a human already owns the lead — never "revive" one of these behind their back. */
const HUMAN_OWNED = new Set(["replied", "booked", "met", "won", "lost"]);

export default function crmHygiene(args) {
  const records = Array.isArray(args.records) ? args.records : [];
  if (!records.length) throw new Error("records is required and must not be empty");
  /** Passed in, never read from a clock — see the purity note in the header. */
  const now = String(args.now ?? "").trim();
  const dormantAfterDays = Number(args.dormant_after_days ?? 90);

  const rows = records.map((r, i) => ({ ...r, _i: i, _id: r.id ?? `row-${i}` }));

  // ── DUPLICATES ────────────────────────────────────────────────────────────────────────────────
  const byKey = new Map();
  for (const r of rows) {
    for (const k of keysOf(r)) {
      const id = `${k.kind}:${k.key}`;
      const hit = byKey.get(id) ?? { kind: k.kind, key: k.key, strong: k.strong, rows: [] };
      hit.rows.push(r);
      byKey.set(id, hit);
    }
  }
  const merges = [];
  const alreadyPaired = new Set();
  for (const g of [...byKey.values()].sort((a, b) => Number(b.strong) - Number(a.strong))) {
    if (g.rows.length < 2) continue;
    const ids = g.rows.map((r) => r._id).sort();
    const pairKey = ids.join("|");
    if (alreadyPaired.has(pairKey)) continue;
    alreadyPaired.add(pairKey);
    /**
     * Which record survives: the one with the most to lose.
     *
     * Not the oldest and not the newest. A merge keeps one row's history, and the row that has been
     * further down the pipeline and has more fields filled is the one whose loss would actually cost
     * something. Ties break on `_i` so the same input always produces the same proposal.
     */
    const scored = g.rows
      .map((r) => ({
        r,
        score:
          (HUMAN_OWNED.has(norm(r.stage)) ? 100 : 0) +
          Object.values(r).filter((v) => v !== null && v !== undefined && String(v).trim() !== "").length,
      }))
      .sort((a, b) => b.score - a.score || a.r._i - b.r._i);
    merges.push({
      keep: scored[0].r._id,
      merge: scored.slice(1).map((s) => s.r._id),
      matched_on: g.kind,
      evidence: g.key,
      /**
       * `strong` means an exact match on something only one person has — an email, a LinkedIn URL, a
       * phone. Those are safe to wave through in bulk. `name+domain` and `domain` are good guesses
       * and a human reads them, because two Sarah Kellys at one company is rare and not impossible.
       */
      confident: g.strong,
    });
  }

  // ── ROT ───────────────────────────────────────────────────────────────────────────────────────
  const fixes = [];
  for (const r of rows) {
    const faults = faultsOf(r);
    if (faults.length) fixes.push({ id: r._id, name: r.name || r.company || "(unnamed)", faults });
  }

  // ── DORMANT ───────────────────────────────────────────────────────────────────────────────────
  //
  // People already on file who went quiet. The cheapest pipeline in any CRM, and the one nobody
  // works, because nothing surfaces them.
  const dormant = [];
  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════════════
   * A PASS THAT READS NOTHING MUST NOT REPORT "NONE"
   * ═══════════════════════════════════════════════════════════════════════════════════════════════
   *
   * Counted so an empty `dormant` can be told apart from a dormant pass that never had a date to
   * work with. This is the same failure as the reachability warning further down, in the same file,
   * one pass over: the dormant check reads `last_touched_at` or `updated_at`, a caller supplied
   * `last_touch`, every row scored `undefined`, and the workflow returned `dormant: []`.
   *
   * The run then reported "no dormant prospects" about a list where somebody had been quiet for 203
   * days. Nothing errored, the agent was faithful to what the tool returned, and the hole was
   * invisible to everything upstream.
   *
   * That is the shape of the whole bug class: a silent empty section reads as a measured zero.
   */
  let datedRows = 0;
  if (now) {
    for (const r of rows) {
      const stage = norm(r.stage);
      // Never a lead a human is holding. Waking someone mid-negotiation over the top of the founder
      // is worse than not waking them at all.
      if (HUMAN_OWNED.has(stage)) continue;
      const since = daysBetween(r.last_touched_at ?? r.updated_at, now);
      if (since !== undefined) datedRows++;
      if (since === undefined || since < dormantAfterDays) continue;
      dormant.push({
        id: r._id,
        name: r.name || r.company || "(unnamed)",
        company: r.company ?? undefined,
        stage: stage || "unknown",
        days_quiet: since,
        /** Why they are worth a second try, in the words a founder would use. */
        why: stage === "connected" || stage === "dm1" || stage === "dm2"
          ? "they accepted and then the thread died — the hardest part already happened"
          : "no answer to the first run, and long enough ago that it is a fresh approach rather than a nag",
      });
    }
    dormant.sort((a, b) => b.days_quiet - a.days_quiet);
  }

  return {
    total: rows.length,
    /** Safe to apply in bulk: an exact match on something only one person has. */
    confident_merges: merges.filter((m) => m.confident),
    /** Good guesses that a human reads. Two Sarah Kellys at one company is rare, not impossible. */
    review_merges: merges.filter((m) => !m.confident),
    fixes,
    dormant,
    counts: {
      duplicates: merges.reduce((s, m) => s + m.merge.length, 0),
      needing_fixes: fixes.length,
      dormant: dormant.length,
    },
    /**
     * Said plainly when the dormant pass could not run, so an empty list never reads as "none".
     *
     * Two ways it cannot run, and they need different sentences: no `now` at all, or a `now` and not
     * one record carrying a date this reads. The second was silent and is the one that shipped a
     * confident "no dormant prospects" about a 203-day-quiet list.
     */
    detail: !now
      ? "no date was supplied, so nothing could be judged dormant"
      : rows.length > 0 && datedRows === 0
        ? `not one of the ${rows.length} records carries a date this can read, so nothing could be judged dormant — it reads \`last_touched_at\` or \`updated_at\``
        : undefined,
    /**
     * ═══════════════════════════════════════════════════════════════════════════════════════════
     * A UNIFORM VERDICT ACROSS EVERY ROW IS USUALLY A WRONG FIELD NAME
     * ═══════════════════════════════════════════════════════════════════════════════════════════
     *
     * Found by running this on a realistic eight-record list where every row carried an obvious
     * email — under the key `contact`. This reads `email`, `linkedin_url` and `phone`, so it
     * reported all eight as "no way to reach them at all", found ZERO merges (the confident path is
     * an exact email match, and there were no emails to match), and returned that with complete
     * confidence.
     *
     * The founder-visible result was a hygiene report that missed two real duplicate pairs and
     * declared a healthy list unreachable. Nothing errored. Nothing looked wrong.
     *
     * ── WHY A WARNING AND NOT A REFUSAL ──
     *
     * A list where genuinely nobody is contactable is a real and important state — it is exactly
     * what a founder who has imported names without emails should be told. Refusing would withhold
     * the true answer for the common case to protect the rare one.
     *
     * So it still answers, and names the likelier cause beside it. The threshold is ALL of them and
     * at least three: two-out-of-two is a coincidence, eight-out-of-eight is a schema mismatch.
     */
    warning:
      rows.length >= 3 && fixes.length === rows.length &&
      fixes.every((f) => f.faults.includes("no way to reach them at all"))
        ? `every one of the ${rows.length} records has no email, linkedin_url or phone. That is possible, but it is more often a field-name mismatch — this reads \`email\`, \`linkedin_url\` and \`phone\`, and nothing else counts as a way to reach someone.`
        : undefined,
  };
}
