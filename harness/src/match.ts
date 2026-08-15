// Two-pass one-to-one matching: reference first, then (amount, date). One implementation.
//
// WHY THIS FILE EXISTS
// --------------------
// `wedges/books-keeper/workflows/reconcile.mjs` has done exactly this since it was written, and it
// is right: match on a reference where one exists, fall back to an exact amount-and-date pair, and
// carry a used-set so a single ledger row can never satisfy two bank rows. Payment detection
// (payments.ts) needs precisely the same algorithm to decide which Stripe charge settles which
// invoice, and the obvious move — writing it again next to the Stripe code — is how two matchers end
// up disagreeing about a duplicate reference eighteen months from now. On money. Silently.
//
// So the algorithm lives here, once, as a pure generic function, and `test/match.test.ts` pins it
// against reconcile.mjs on shared fixtures: if either side ever drifts, that test fails and names the
// input they disagreed on. The wedge workflow keeps its own copy of the CODE because it executes in
// the sandbox with no access to the harness's module graph — what is shared is the BEHAVIOUR, and
// the test is what makes that sharing real rather than aspirational.
//
// WHAT IT DELIBERATELY DOES NOT DO
// --------------------------------
// It never guesses. There is no fuzzy reference matching, no amount tolerance, no date window. A
// candidate either satisfies an exact rule or it goes in `unmatched` for a human. The motivating
// failure is specific: an amount-only match with a ±3 day window will, on a business that invoices a
// retainer of the same amount every month, cheerfully settle February's invoice with March's
// payment — and then chase February's client for money they paid, while March's invoice quietly
// looks settled. Both halves of that are unrecoverable reputational damage, and neither is visible
// in any log. An unmatched payment sitting in a summary that says "1 payment I could not place" is
// an inconvenience. That asymmetry is the entire design.

/**
 * One side of a match. `key` is what the caller uses to identify the item afterwards; everything
 * else is what the two passes compare.
 *
 * `amount` is an integer of minor units and `date` is a `YYYY-MM-DD` string, compared with `===`.
 * Both are the caller's problem to normalise, and both are checked here rather than trusted, because
 * a float amount arriving from a provider's JSON is the exact input that turns an exact-match
 * algorithm into a probabilistic one.
 */
export interface Matchable<K> {
  key: K;
  /** The reference a human quoted: an invoice number, a payment memo. Absent when there is none. */
  reference?: string;
  /** Integer minor units. Never a float — see `assertInteger`. */
  amount: number;
  /** `YYYY-MM-DD`. Compared exactly; no window. */
  date?: string;
}

export type MatchBasis = "reference" | "amount_and_date";

export interface Match<L, R> {
  left: L;
  right: R;
  /**
   * WHICH RULE FIRED, and it is carried out of here rather than discarded because the two are not
   * equally trustworthy. A reference match is the client telling us what they were paying for. An
   * amount-and-date match is us inferring it. Callers surface the difference (payments.ts puts it in
   * the reconciliation summary) so a founder auditing a settled invoice can see whether a human ever
   * said so.
   */
  basis: MatchBasis;
}

export interface MatchResult<L, R> {
  matched: Match<L, R>[];
  /** Left-hand items nothing satisfied. */
  unmatched_left: L[];
  /** Right-hand items nothing consumed. */
  unmatched_right: R[];
  /**
   * References that appear more than once on the right, and were therefore NOT used for reference
   * matching at all.
   *
   * reconcile.mjs builds its lookup with `new Map(entries.map(e => [ref, e]))`, which is last-write-
   * wins: with two ledger rows quoting "INV-0007" the first becomes unreachable by reference and can
   * only ever be matched by amount+date. That is a silent, order-dependent outcome. Here the
   * ambiguity is refused outright — an ambiguous reference matches NOTHING and is named — because on
   * the payments side "two charges quote invoice INV-0007" is a real and important event (a client
   * paid twice, or two clients typed the same memo) and picking one at random is how an invoice gets
   * marked paid by somebody else's money.
   */
  ambiguous_references: string[];
}

function assertInteger(n: unknown, what: string): number {
  if (typeof n !== "number" || !Number.isFinite(n) || !Number.isInteger(n)) {
    throw new Error(`${what} must be a whole number of minor units, got ${JSON.stringify(n)}`);
  }
  return n;
}

/** Normalised for comparison only. Case and surrounding space are noise; nothing else is touched. */
function refKey(reference: string | undefined): string | undefined {
  const s = String(reference ?? "").trim().toUpperCase();
  return s.length ? s : undefined;
}

/**
 * Match `left` against `right`, one-to-one, reference first then amount+date.
 *
 * The used-set is keyed on ARRAY INDEX rather than on object identity (reconcile.mjs uses identity,
 * which is correct there because it never copies the array). Index is the safer primitive for a
 * shared helper: a caller that maps or clones its input between building it and reading the result
 * would silently lose one-to-one-ness with identity, and losing one-to-one-ness here means one
 * payment settling two invoices.
 */
export function matchTwoPass<L extends Matchable<any>, R extends Matchable<any>>(
  left: readonly L[],
  right: readonly R[],
): MatchResult<L, R> {
  left.forEach((l, i) => assertInteger(l.amount, `left[${i}].amount`));
  right.forEach((r, i) => assertInteger(r.amount, `right[${i}].amount`));

  // Ambiguous references are found BEFORE any matching, so the answer does not depend on iteration
  // order. See `ambiguous_references`.
  const refCounts = new Map<string, number>();
  for (const r of right) {
    const k = refKey(r.reference);
    if (k) refCounts.set(k, (refCounts.get(k) ?? 0) + 1);
  }
  const ambiguous = new Set([...refCounts].filter(([, n]) => n > 1).map(([k]) => k));
  const byRef = new Map<string, number>();
  right.forEach((r, i) => {
    const k = refKey(r.reference);
    if (k && !ambiguous.has(k)) byRef.set(k, i);
  });

  const used = new Set<number>();
  const matched: Match<L, R>[] = [];
  const unmatchedLeft: L[] = [];

  for (const l of left) {
    // PASS 1 — reference. The client told us what this is for; believe them over arithmetic.
    const lk = refKey(l.reference);
    const refIdx = lk ? byRef.get(lk) : undefined;
    if (refIdx !== undefined && !used.has(refIdx)) {
      used.add(refIdx);
      matched.push({ left: l, right: right[refIdx], basis: "reference" });
      continue;
    }

    // PASS 2 — exact amount AND exact date. Falling through to here when a reference match was
    // already consumed is deliberate and matches reconcile.mjs: two payments quoting the same
    // invoice means the second one still needs somewhere to go, and amount+date is a stricter test
    // than the one it just failed, not a looser one.
    //
    // A left item with no date can never reach pass 2. That is not an oversight: matching on amount
    // alone is the retainer bug described at the top of this file.
    const amtIdx =
      l.date === undefined
        ? -1
        : right.findIndex((r, i) => !used.has(i) && r.amount === l.amount && r.date === l.date);
    if (amtIdx >= 0) {
      used.add(amtIdx);
      matched.push({ left: l, right: right[amtIdx], basis: "amount_and_date" });
      continue;
    }

    unmatchedLeft.push(l);
  }

  return {
    matched,
    unmatched_left: unmatchedLeft,
    unmatched_right: right.filter((_, i) => !used.has(i)),
    ambiguous_references: [...ambiguous].sort(),
  };
}
