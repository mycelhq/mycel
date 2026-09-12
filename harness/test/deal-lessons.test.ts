// What a business's own closed deals say about how it prices and negotiates.
//
// A founder sends a proposal. The client asks for six months instead of twelve. A second goes out.
// They ask for the setup fee to come out. A third is signed. That sequence is a complete, evidenced
// account of how this business loses a week and some margin — and it happens again next month with a
// different client and the same two asks.
//
// The founder feels it and cannot see it, because each deal is remembered on its own and the pattern
// only exists across them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chainsFrom, dealLessons, lessonsForPrompt, topicsIn, MIN_DEALS } from "../src/deal-lessons";
import type { Envelope } from "../src/signing";

let n = 0;
const env = (over: Partial<Envelope> = {}): Envelope =>
  ({
    id: `e${++n}`,
    project_id: "p",
    title: "Engagement",
    revision: 1,
    status: "executed",
    signers: [],
    document: { artifact_id: "a", filename: "f.pdf", sha256: "", size_bytes: 1 },
    created_at: "2026-01-01T00:00:00Z",
    expires_at: "2026-02-01T00:00:00Z",
    ...over,
  }) as Envelope;

/** A whole negotiation: N papers, the last one signed, with what was asked in between. */
function deal(asks: string[], terms: { first: number; last: number; firstTerm?: number; lastTerm?: number }): Envelope[] {
  const out: Envelope[] = [];
  const total = asks.length + 1;
  for (let i = 0; i < total; i++) {
    const last = i === total - 1;
    out.push(
      env({
        revision: i + 1,
        status: last ? "executed" : "changes_requested",
        ...(last ? {} : { change_requested: { by: "c@x.test", asked: asks[i]!, at: "2026-01-02T00:00:00Z" } }),
        terms: {
          price_minor: last ? terms.last : terms.first,
          currency: "GBP",
          ...(last ? (terms.lastTerm ? { term_months: terms.lastTerm } : {}) : terms.firstTerm ? { term_months: terms.firstTerm } : {}),
        },
      }),
    );
  }
  for (let i = 1; i < out.length; i++) {
    out[i]!.supersedes = out[i - 1]!.id;
    out[i - 1]!.superseded_by = out[i]!.id;
  }
  return out;
}

test("a chain is walked by the link, not by the client", () => {
  // One client can have three unrelated agreements and a single agreement can outlive the case it
  // started on. The supersedes link is the only thing that says "this paper replaced that one".
  const a = deal(["can we do six months?"], { first: 120_000, last: 95_000 });
  const b = deal([], { first: 50_000, last: 50_000 });
  const chains = chainsFrom([...a.slice().reverse(), ...b]);
  assert.equal(chains.length, 2, "two heads, whatever order they arrive in");
  assert.deepEqual(chains.map((c) => c.envelopes.length).sort(), [1, 2]);
  // Walked oldest first, so `[0]` is what was proposed and the last is what happened.
  const two = chains.find((c) => c.envelopes.length === 2)!;
  assert.equal(two.envelopes[0]!.revision, 1);
  assert.equal(two.envelopes[1]!.revision, 2);
});

test("what they ASKED is not what it COST, and the two are never merged", () => {
  /**
   * THE DISTINCTION THE WHOLE MODULE TURNS ON.
   *
   * A client asks about the term in every deal and the founder holds firm in every one — that is a
   * good outcome and a terrible lesson to draw. Reporting the ask as if it were a concession would
   * tell a founder to pre-emptively discount against an objection they usually win, which is the
   * single most expensive advice this file could give.
   */
  const held = [
    ...deal(["is twelve months negotiable?"], { first: 100_000, last: 100_000, firstTerm: 12, lastTerm: 12 }),
    ...deal(["can the commitment be shorter?"], { first: 100_000, last: 100_000, firstTerm: 12, lastTerm: 12 }),
    ...deal(["twelve months feels long"], { first: 100_000, last: 100_000, firstTerm: 12, lastTerm: 12 }),
  ];
  const s = dealLessons(held);
  const term = s.lessons.find((l) => l.topic === "term")!;
  assert.equal(term.asked, 3);
  assert.equal(term.conceded, 0, "nothing moved, so nothing was conceded");
  assert.match(term.says, /held every time/);

  // And when it does move, it says so — with both numbers.
  const moved = [
    ...deal(["can we do six months?"], { first: 100_000, last: 100_000, firstTerm: 12, lastTerm: 6 }),
    ...deal(["shorter term please"], { first: 100_000, last: 100_000, firstTerm: 12, lastTerm: 6 }),
    ...deal(["twelve is too long a commitment"], { first: 100_000, last: 100_000, firstTerm: 12, lastTerm: 6 }),
  ];
  const m = dealLessons(moved).lessons.find((l) => l.topic === "term")!;
  assert.equal(m.conceded, 3);
  assert.match(m.says, /asked about the term in 3 of your last 3 deals, and it moved in 3/);
});

test("two clients saying the same thing is a coincidence, not a pattern", () => {
  // "Clients often ask about the term" is a horoscope. "In 3 of your last 4" is actionable, and the
  // difference is entirely the sample.
  const two = [
    ...deal(["can we do six months?"], { first: 100_000, last: 90_000 }),
    ...deal(["shorter term?"], { first: 100_000, last: 90_000 }),
  ];
  assert.deepEqual(dealLessons(two).lessons, []);
  assert.equal(MIN_DEALS, 3);

  const three = [...two, ...deal(["twelve months is long"], { first: 100_000, last: 90_000 })];
  assert.ok(dealLessons(three).lessons.length > 0);
  // Every finding carries its sample, always.
  for (const l of dealLessons(three).lessons) {
    assert.ok(l.of >= l.asked);
    assert.match(l.says, new RegExp(`of your last ${l.of} deals`));
  }
});

test("a price that cannot be seen to have moved is not reported as flat", () => {
  /**
   * Chains that predate `Envelope.terms` are EXCLUDED rather than assumed unchanged. "It did not
   * move" and "we cannot see whether it moved" are different facts, and only one of them is good
   * news — reporting the second as the first would tell a founder they never discount.
   */
  const blind = deal(["cheaper please"], { first: 0, last: 0 }).map((e) => ({ ...e, terms: undefined }) as Envelope);
  const s = dealLessons(blind);
  assert.equal(s.price_moves_seen, 0);
  assert.equal(s.median_price_move_pct, null);

  const seen = dealLessons([
    ...deal(["cheaper please"], { first: 100_000, last: 80_000 }),
    ...deal(["can you do better on price?"], { first: 100_000, last: 90_000 }),
  ]);
  assert.equal(seen.price_moves_seen, 2);
  // Median of −20% and −10%. Negative is a discount, and it is reported as a signed number rather
  // than as "10% off", because a price that went UP has to be expressible too.
  assert.equal(seen.median_price_move_pct, -15);
});

test("the headline numbers are about closing, not about activity", () => {
  const deals = [
    ...deal([], { first: 100_000, last: 100_000 }),
    ...deal([], { first: 50_000, last: 50_000 }),
    ...deal(["cheaper", "and shorter"], { first: 100_000, last: 70_000 }),
  ];
  const s = dealLessons(deals);
  assert.equal(s.closed, 3);
  assert.equal(s.signed, 3);
  // The number a founder actually wants to move: signed with no revision at all.
  assert.equal(s.signed_first_time, 2);
  assert.equal(s.median_rounds, 0);

  // An OPEN negotiation is not evidence yet, and does not dilute the sample either.
  const withOpen = dealLessons([...deals, ...deal([], { first: 1, last: 1 }).map((e) => ({ ...e, status: "sent" }) as Envelope)]);
  assert.equal(withOpen.closed, 3);
});

test("a topic is matched on words, so every finding can be checked against the deals", () => {
  // Deliberately not a model call. A founder reading "you conceded on term in 4 of 5" can go and
  // look at those five; a clustering model would produce better topics and nothing anybody could
  // verify — and an unverifiable finding about somebody's pricing is worse than none.
  assert.deepEqual(topicsIn("can we do six months instead of twelve?"), ["term"]);
  assert.deepEqual(topicsIn("that price is too expensive"), ["price"]);
  // More than one is normal, and both are counted.
  assert.deepEqual(topicsIn("cheaper and a shorter commitment").sort(), ["price", "term"]);
  // Unmatched is reported as unmatched rather than forced into a bucket.
  assert.deepEqual(topicsIn("my dog ate the contract"), ["other"]);
});

test("a client who raises the same thing twice has raised it once", () => {
  // Counted per chain, not per envelope. Otherwise a persistent client looks like a pattern across
  // the book, and the founder is told to change their pricing because of one negotiation.
  const persistent = deal(["price is high", "still too expensive", "any discount at all?"], { first: 100_000, last: 90_000 });
  const s = dealLessons([...persistent, ...deal(["cheaper?"], { first: 1000, last: 900 }), ...deal(["price?"], { first: 1000, last: 900 })]);
  const price = s.lessons.find((l) => l.topic === "price")!;
  assert.equal(price.asked, 3, "three deals, not five envelopes");
  assert.equal(price.of, 3);
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// THE PROMPT PAYLOAD
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//
// These assert the shape a model actually reads. The module can be perfectly right about the deals
// and still lose the founder money if the payload lets "they asked" be read as "you conceded".

/** N deals, every client pushing on the same thing, priced first → last. */
const pushedOnPrice = (n: number, first: number, last: number): Envelope[] =>
  Array.from({ length: n }, () => deal(["that price is too expensive"], { first, last })).flat();

test("a topic asked about and never conceded reads as HOLD, not as a discount signal", () => {
  const payload = lessonsForPrompt(dealLessons(pushedOnPrice(3, 300_000, 300_000)))!;
  assert.ok(payload, "three deals is enough to say something");

  const said = JSON.stringify(payload).toLowerCase();
  assert.match(said, /held every time/, "the win has to be stated as a win");
  assert.match(said, /do not pre-emptively discount/, "and the instruction has to be explicit");
  assert.match(said, /held every time so far on: the price/, "named, so the model knows which argument it is winning");
  /**
   * THE FAILURE THIS EXISTS FOR.
   *
   * A model handed "clients asked about the price in 3 of your last 3" will helpfully open lower. On
   * these facts that hands over, unprompted, the margin the founder won three arguments to keep. The
   * payload must never carry a bare ask count without the concession count beside it.
   */
  assert.ok(!said.includes("typical_price_move"), "nothing moved, so there is no move to report");
});

test("a topic that actually MOVED is reported as movement, with what it cost", () => {
  const payload = lessonsForPrompt(dealLessons(pushedOnPrice(3, 300_000, 240_000)))!;
  const said = JSON.stringify(payload);
  assert.match(said, /it moved in 3/);
  assert.ok(!said.includes("held every time"), "it did not hold, and saying so would be a lie");
  assert.match(said, /-20%/, "300,000 → 240,000 is a 20% give and the founder should see the number");
});

test("below MIN_DEALS there is no payload at all", () => {
  // Two clients saying the same thing is a coincidence, and a prompt is the worst place to present
  // one as a pattern: nothing downstream will ever say where the number came from.
  assert.equal(lessonsForPrompt(dealLessons(pushedOnPrice(2, 300_000, 250_000))), undefined);
});
