// Which buying signals are worth acting on today, and which have already gone cold.
//
// A static sequence assumes the prospect's situation is constant, so the only variable is which
// message lands. That is wrong in an exploitable way: volume cannot manufacture attention earlier,
// it just spends sender reputation faster. A signal detects the moment a fresh priority opens.
//
// The tests that matter are the refusals. A ranked list that quietly includes dead signals will have
// them acted on, and "we noticed you raised a round" eight months later is not a weak version of a
// good message — it is evidence nobody was paying attention.
import test from "node:test";
import assert from "node:assert/strict";
import signalScore, { SIGNALS } from "../../library/workflows/signal-score.mjs";

const NOW = "2026-08-30";
const CO = { name: "Hart's Bakery", domain: "hartsbakery.co.uk", industry: "bakery", location: "Bristol, United Kingdom" };
const ICP = { industries: ["bakery", "cafe", "restaurant"], locations: ["United Kingdom"] };

test("a stale signal is REFUSED, not ranked low", () => {
  const r = signalScore({
    now: NOW,
    signals: [{ type: "funding", observed_at: "2026-01-05", company: CO }],
  });
  assert.deepEqual(r.act, []);
  assert.equal(r.stale.length, 1);
  assert.match(r.stale[0]!.why, /stops being worth acting on after 45/);
  // And the headline names the real problem, which is routing rather than sourcing.
  assert.match(r.headline, /routing problem, not a sourcing one/);
});

test("each type decays on its own clock", () => {
  // Routing a hiring event on the same timeline as a pricing visit throws away the timing advantage
  // of at least one of them.
  const sixDays = (type: string) => signalScore({ now: NOW, signals: [{ type, observed_at: "2026-08-24", company: CO }] });
  // Six days is nothing to a funding round and fatal to a pricing visit.
  assert.equal(sixDays("funding").act.length, 1);
  assert.equal(sixDays("pricing_visit").act.length, 0);
  assert.equal(sixDays("pricing_visit").stale.length, 1);
});

test("a pricing visit yesterday outranks a senior hire last week", () => {
  // The tuning bug this caught: at a one-day half-life, yesterday's pricing visit scored BELOW a
  // six-day-old hire — inverting the one thing every operator agrees on, that somebody on your
  // pricing page is the highest-intent signal there is.
  const r = signalScore({
    now: NOW,
    signals: [
      { type: "leadership_hire", observed_at: "2026-08-24", company: CO },
      { type: "pricing_visit", observed_at: "2026-08-29", company: CO },
    ],
  });
  assert.equal(r.act[0]!.signals[0]!.type, "pricing_visit");
  assert.ok(r.act[0]!.signals[0]!.score > r.act[0]!.signals[1]!.score);
});

test("two signals on one company is ONE prospect at peak readiness", () => {
  // Not two rows. A company that raised last month, hired last week and read your pricing page
  // yesterday is one account, and the operator who notices first owns the conversation.
  const r = signalScore({
    now: NOW,
    signals: [
      { type: "pricing_visit", observed_at: "2026-08-29", company: CO },
      { type: "leadership_hire", observed_at: "2026-08-24", company: CO },
      { type: "funding", observed_at: "2026-08-10", company: CO },
    ],
  });
  assert.equal(r.act.length, 1);
  assert.equal(r.act[0]!.stacked, true);
  assert.equal(r.act[0]!.signals.length, 3);
  // Stacking adds, so a three-signal account outranks any one-signal account.
  const single = signalScore({ now: NOW, signals: [{ type: "pricing_visit", observed_at: NOW, company: CO }] });
  assert.ok(r.act[0]!.score > single.act[0]!.score);
});

test("the ICP filter is what stops a feed becoming a firehose", () => {
  const r = signalScore({
    now: NOW,
    icp: ICP,
    signals: [
      { type: "pricing_visit", observed_at: NOW, company: CO },
      { type: "pricing_visit", observed_at: NOW, company: { name: "BigCorp", industry: "software", location: "United States" } },
    ],
  });
  assert.equal(r.act.length, 1);
  assert.equal(r.unqualified.length, 1);
  // Named, not dropped: a real signal at a company you do not sell to is the filter working, and a
  // founder should be able to see that it did.
  assert.match(r.unqualified[0]!.why, /is not who you sell to/);

  // No ICP matches everything — the honest reading of "they did not tell us who they sell to".
  assert.equal(signalScore({ now: NOW, signals: [{ type: "pricing_visit", observed_at: NOW, company: { name: "Anyone" } }] }).act.length, 1);
});

test("every entry carries what to SAY and what to ASK, not just a score", () => {
  // The signal does the targeting; the message does the conversation. A note that names the event
  // reads as attention; "helping companies like yours grow" reads as a script even when the
  // targeting was perfect.
  const r = signalScore({ now: NOW, signals: [{ type: "leadership_hire", observed_at: "2026-08-28", company: CO }] });
  const a = r.act[0]!;
  assert.match(a.lead_with, /Hart's Bakery/);
  assert.match(a.lead_with, /2 days ago/);
  // Qualification changes with the signal: a funding reply has budget, a hiring reply has a mandate.
  assert.match(a.qualify_on!, /maps to what you sell/);
  assert.match(a.signals[0]!.say!, /name the role/);
  // And a deadline rather than a suggestion.
  assert.equal(a.act_by_days, 43);
});

test("a bought third-party score is kept and deliberately outranked by anything first-party", () => {
  // By the time a broker marks an account hot, the committee has usually shortlisted. It points you
  // at a race you are late to: useful for choosing among accounts you were going to work anyway.
  const r = signalScore({
    now: NOW,
    signals: [
      { type: "category_intent", observed_at: NOW, company: { name: "A" } },
      { type: "repeat_visit", observed_at: NOW, company: { name: "B" } },
    ],
  });
  assert.equal(r.act[0]!.company.name, "B");
  assert.equal(SIGNALS.category_intent.first_party, false);
  assert.ok(SIGNALS.category_intent.weight < SIGNALS.repeat_visit.weight);
  assert.match(SIGNALS.category_intent.say!, /never open with this/i);
});

test("a row it cannot read is reported, never silently dropped", () => {
  const r = signalScore({
    now: NOW,
    signals: [
      { type: "telepathy", observed_at: NOW, company: { name: "X" } },
      { type: "funding", observed_at: "not a date", company: { name: "Y" } },
    ],
  });
  assert.equal(r.act.length, 0);
  assert.equal(r.unknown.length, 2);
  assert.match(r.unknown[0]!.why, /not a signal type/);
  assert.match(r.unknown[1]!.why, /freshness cannot be judged/);
});

test("it refuses to guess the date, because freshness is the whole point", () => {
  // Cast, because `now` is required in the TYPE and this asserts the RUNTIME guard. Both matter: the
  // type stops a caller in this repo, and the guard stops one coming through the workflow route with
  // JSON, where there is no compiler.
  assert.throws(
    () => signalScore({ signals: [{ type: "funding", observed_at: NOW, company: CO }] } as unknown as Parameters<typeof signalScore>[0]),
    /now is required/,
  );
  assert.throws(() => signalScore({ now: NOW, signals: [] }), /must not be empty/);
});

test("the catalogue covers the signals an operator actually watches", () => {
  // Named rather than a free-text field, so a decay window exists for every one of them and an
  // unknown type is a loud refusal rather than a default.
  for (const t of ["pricing_visit", "champion_moved", "funding", "leadership_hire", "role_surge", "tech_change", "reply_then_silence"]) {
    assert.ok(SIGNALS[t as keyof typeof SIGNALS], `missing signal type ${t}`);
  }
  for (const [name, spec] of Object.entries(SIGNALS)) {
    assert.ok(spec.dead_after_days > spec.half_life_days, `${name}: a signal must outlive its own half-life`);
    assert.ok(spec.implies && spec.qualify_on, `${name}: every signal says what it means and what to ask`);
  }
});
