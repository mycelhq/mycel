// Duplicates, rot, and the people you already have who went quiet.
//
// A CRM cleaner, a duplicate killer and a dormant reviver were asked for as three things, and all
// three begin by walking the same list asking "what is this record, and is it the same as that one".
// Three passes means three ideas of what "the same" means, and the day they disagree a founder sends
// a revival email to a duplicate.
//
// The rule underneath every test here: it PROPOSES and never writes. A dedupe that acts on its own
// is the highest-regret automation in a CRM — merging two records that were genuinely two people
// destroys history nobody can reconstruct, silently and in bulk. An unmerged duplicate costs one
// awkward email. A wrong merge costs the relationship and the record of it.
import test from "node:test";
import assert from "node:assert/strict";
import crmHygiene from "../../library/workflows/crm-hygiene.mjs";

const NOW = "2026-08-30";

test("an exact match on something only one person has is a confident merge", () => {
  const r = crmHygiene({
    now: NOW,
    records: [
      { id: "a", name: "Sarah Kelly", email: "sarah@hartsbakery.co.uk", stage: "connected" },
      { id: "b", name: "Sarah Kelly", email: "SARAH@hartsbakery.co.uk", stage: "queued" },
    ],
  });
  assert.equal(r.confident_merges.length, 1);
  assert.equal(r.confident_merges[0]!.matched_on, "email");
  // The record with the most to lose survives: further down the pipeline, more fields filled. Not
  // the oldest and not the newest — a merge keeps one row's history and that is the one whose loss
  // would actually cost something.
  assert.equal(r.confident_merges[0]!.keep, "a");
  assert.deepEqual(r.confident_merges[0]!.merge, ["b"]);
});

test("a good guess is separated from a certainty, and a human reads it", () => {
  // Two Sarah Kellys at one company is rare and not impossible, so name+domain is proposed for
  // review rather than waved through. The split is what makes bulk-applying the confident ones safe.
  const r = crmHygiene({
    now: NOW,
    records: [
      { id: "a", name: "Sarah Kelly", company_domain: "hartsbakery.co.uk", stage: "queued" },
      { id: "b", name: "sarah  kelly", company_domain: "www.hartsbakery.co.uk", stage: "queued" },
    ],
  });
  assert.equal(r.confident_merges.length, 0);
  assert.equal(r.review_merges.length, 1);
  assert.equal(r.review_merges[0]!.matched_on, "name+domain");
});

test("a shared free mailbox is not evidence two people are the same company", () => {
  // Every sole trader in Britain is at gmail.com. Matching on it would merge the entire market.
  const r = crmHygiene({
    now: NOW,
    records: [
      { id: "a", name: "Ann Poole", company_domain: "gmail.com", stage: "queued" },
      { id: "b", name: "Tom Reid", company_domain: "gmail.com", stage: "queued" },
    ],
  });
  assert.equal(r.confident_merges.length + r.review_merges.length, 0);
});

test("accents fold, but names are never reordered to make a match", () => {
  const same = crmHygiene({
    now: NOW,
    records: [
      { id: "a", name: "José García", company_domain: "bloom.co.uk", stage: "queued" },
      { id: "b", name: "Jose Garcia", company_domain: "bloom.co.uk", stage: "queued" },
    ],
  });
  assert.equal(same.review_merges.length, 1, "one person, two spellings");

  // Reordering to match is how a Hungarian record merges with a Spanish one.
  const reordered = crmHygiene({
    now: NOW,
    records: [
      { id: "a", name: "Jose Garcia", company_domain: "bloom.co.uk", stage: "queued" },
      { id: "b", name: "Garcia Jose", company_domain: "bloom.co.uk", stage: "queued" },
    ],
  });
  assert.equal(reordered.review_merges.length, 0);
});

test("faults are things a person can act on, not a data-quality score", () => {
  // "Data quality: 62" tells a founder nothing they can do. "No email, and the phone is four digits"
  // tells them exactly what to fix or drop.
  const r = crmHygiene({
    now: NOW,
    records: [
      { id: "a", name: "Tom Reid", email: "info@littlevictories.co.uk", stage: "dm1" },
      { id: "b", name: "", company: "", phone: "123", stage: "queued" },
      { id: "c", name: "Ann Poole", company: "Bloom", stage: "queued" },
      { id: "d", name: "Bad", email: "not-an-email", stage: "queued" },
    ],
  });
  const by = (id: string) => r.fixes.find((f: { id: string }) => f.id === id)!;
  // A shared inbox is often the only way into a small business — but a sequence that opens "Hi Tom"
  // to info@ is the tell, so it is surfaced rather than treated as clean.
  assert.match(by("a").faults.join(" "), /shared inbox/);
  assert.match(by("b").faults.join(" "), /too short to be a phone number/);
  assert.match(by("b").faults.join(" "), /neither a person nor a company/);
  assert.match(by("c").faults.join(" "), /no way to reach them at all/);
  assert.match(by("d").faults.join(" "), /not a valid email/);
});

test("a lead a human is holding is never woken behind their back", () => {
  // Waking someone mid-negotiation over the top of the founder is worse than not waking them at all.
  const r = crmHygiene({
    now: NOW,
    dormant_after_days: 30,
    records: [
      { id: "won", name: "A", stage: "won", last_touched_at: "2025-01-01" },
      { id: "replied", name: "B", stage: "replied", last_touched_at: "2025-01-01" },
      { id: "booked", name: "C", stage: "booked", last_touched_at: "2025-01-01" },
      { id: "cold", name: "D", stage: "connected", last_touched_at: "2025-01-01" },
    ],
  });
  assert.deepEqual(r.dormant.map((d: { id: string }) => d.id), ["cold"]);
});

test("the revival reason distinguishes a dead thread from a cold list", () => {
  const r = crmHygiene({
    now: NOW,
    dormant_after_days: 30,
    records: [
      { id: "warm", name: "A", stage: "connected", last_touched_at: "2026-01-10" },
      { id: "cold", name: "B", stage: "queued", last_touched_at: "2026-01-10" },
    ],
  });
  const warm = r.dormant.find((d: { id: string }) => d.id === "warm")!;
  const cold = r.dormant.find((d: { id: string }) => d.id === "cold")!;
  // They accepted and the thread died: the hardest part already happened, and that is a different
  // approach from someone who never answered at all.
  assert.match(warm.why, /the hardest part already happened/);
  assert.match(cold.why, /fresh approach rather than a nag/);
  // Longest quiet first — the ones most likely to have forgotten you entirely.
  assert.ok(r.dormant[0]!.days_quiet >= r.dormant[r.dormant.length - 1]!.days_quiet);
});

test("no date means the dormant pass SAYS it could not run", () => {
  // An empty list with no explanation reads as "nobody is dormant", which is the opposite of true.
  const r = crmHygiene({ records: [{ id: "a", name: "A", stage: "queued", last_touched_at: "2020-01-01" }] });
  assert.deepEqual(r.dormant, []);
  assert.match(r.detail!, /nothing could be judged dormant/);
});

test("it proposes and never writes", () => {
  // The whole posture. Every output is a suggestion with its evidence attached; nothing here mutates
  // a record, and the confident/review split is what lets a human apply forty at once safely.
  const input = [
    { id: "a", name: "Sarah Kelly", email: "s@x.co.uk", stage: "queued" },
    { id: "b", name: "Sarah Kelly", email: "s@x.co.uk", stage: "queued" },
  ];
  const before = JSON.stringify(input);
  const r = crmHygiene({ now: NOW, records: input });
  assert.equal(JSON.stringify(input), before, "the input is untouched");
  assert.ok(r.confident_merges[0]!.evidence, "and every proposal carries why");
});

test("an empty CRM is refused rather than reported as clean", () => {
  assert.throws(() => crmHygiene({ records: [] }), /must not be empty/);
});

test("a uniform verdict across every row names the likelier cause", async () => {
  /**
   * ═══ FOUND BY RUNNING IT, NOT BY READING IT ═══
   *
   * A realistic eight-record prospect list, every row carrying an obvious email — under the key
   * `contact`. This reads `email`, `linkedin_url` and `phone`, so it reported all eight as "no way
   * to reach them at all", found ZERO merges (the confident path is an exact email match and there
   * were no emails to match), and returned that with complete confidence.
   *
   * The founder-visible result was a hygiene report that missed two real duplicate pairs and called
   * a healthy list unreachable. Nothing errored. Nothing looked wrong. The agent had correctly
   * called the workflow — the trace shows `workflow:crm_hygiene` — so every check upstream passed.
   *
   * A WARNING, NOT A REFUSAL. A list where genuinely nobody is contactable is a real state and
   * exactly what somebody who imported names without emails should be told. Refusing would withhold
   * the true answer for the common case to protect the rare one.
   */
  const wrongField = crmHygiene({
    records: [
      { id: "a", name: "Fernwood Health", contact: "ops@fernwood.example" },
      { id: "b", name: "Fernwood Health Ltd", contact: "ops@fernwood.example" },
      { id: "c", name: "Kestrel Analytics", contact: "hello@kestrel.example" },
    ] as never,
  });
  assert.match(String(wrongField.warning), /field-name mismatch/, "a schema mismatch passes silently again");
  assert.match(String(wrongField.warning), /email/, "the warning does not name the keys it reads");
  // It still answers. The warning sits beside the result, it does not replace it.
  assert.equal(wrongField.total, 3);

  // The same records under the right key: no warning, and the duplicate is found.
  const rightField = crmHygiene({
    records: [
      { id: "a", name: "Fernwood Health", email: "ops@fernwood.example" },
      { id: "b", name: "Fernwood Health Ltd", email: "ops@fernwood.example" },
      { id: "c", name: "Kestrel Analytics", email: "hello@kestrel.example" },
    ],
  });
  assert.equal(rightField.warning, undefined, "a healthy list was warned about");
  assert.equal(rightField.confident_merges.length, 1, "the exact-email duplicate was not found");
});

test("two unreachable records are a coincidence, not a schema mismatch", () => {
  /*
    The threshold is ALL of them AND at least three. Two-out-of-two is an ordinary small list; eight
    -out-of-eight is a wrong field name. Without the floor, every two-record call would carry a
    warning about its own schema and founders would learn to ignore the field.
  */
  const tiny = crmHygiene({ records: [{ id: "a", name: "A" }, { id: "b", name: "B" }] });
  assert.equal(tiny.warning, undefined, "a two-record list was warned about");

  // And one reachable row among many is enough to prove the field name is right.
  const mixed = crmHygiene({
    records: [
      { id: "a", name: "A" },
      { id: "b", name: "B" },
      { id: "c", name: "C", email: "c@x.example" },
    ],
  });
  assert.equal(mixed.warning, undefined, "one good row should disprove a schema mismatch");

  /**
   * THE CASE THE `every` GUARDS, AND THE FIRST VERSION OF THIS TEST DID NOT COVER IT.
   *
   * Every row here is in `fixes`, so a check on `fixes.length === rows.length` alone passes — but
   * one of them is faulty for an unrelated reason (a malformed address), which PROVES the field name
   * was read correctly. Sabotaging `every` to `some` left the suite green until this existed.
   */
  const allFaultyDifferently = crmHygiene({
    records: [
      { id: "a", name: "A" },
      { id: "b", name: "B" },
      { id: "c", name: "C", email: "not-an-email" },
    ],
  });
  assert.equal(allFaultyDifferently.fixes.length, 3, "the fixture no longer has a fault on every row");
  assert.equal(
    allFaultyDifferently.warning,
    undefined,
    "warned about a field-name mismatch when one row plainly carried an email",
  );
});

test("a dormant pass that read no dates says so, rather than reporting none", () => {
  /**
   * ═══ THE SAME BUG AS THE REACHABILITY WARNING, ONE PASS OVER ═══
   *
   * The dormant check reads `last_touched_at` or `updated_at`. A caller supplied `last_touch`, every
   * row scored `undefined`, the loop `continue`d on all of them, and the workflow returned
   * `dormant: []`.
   *
   * The run then reported "no dormant prospects" about a list where somebody had been quiet 203
   * days. Nothing errored. The agent was faithful to what the tool gave it. The hole was invisible
   * to every check upstream — which is exactly why the judge could see it and the code could not.
   *
   * A silent empty section reads as a measured zero. That is the whole bug class.
   */
  const wrongField = crmHygiene({
    records: [
      { id: "a", name: "A", email: "a@x.example", last_touch: "2026-03-02" },
      { id: "b", name: "B", email: "b@x.example", last_touch: "2026-02-11" },
    ] as never,
    now: "2026-09-21T00:00:00Z",
  });
  assert.equal(wrongField.dormant.length, 0);
  assert.match(
    String(wrongField.detail),
    /not one of the 2 records carries a date this can read/,
    "an empty dormant list is being reported as a measured zero again",
  );
  assert.match(String(wrongField.detail), /last_touched_at/, "the detail does not name the key it reads");

  // The field it actually reads: no detail, and the quiet one is found.
  const rightField = crmHygiene({
    records: [
      { id: "a", name: "A", email: "a@x.example", last_touched_at: "2026-03-02" },
      { id: "b", name: "B", email: "b@x.example", last_touched_at: "2026-09-19" },
    ],
    now: "2026-09-21T00:00:00Z",
  });
  assert.equal(rightField.detail, undefined, "a healthy list was given a caveat");
  assert.equal(rightField.dormant.length, 1, "the 203-day-quiet record was not found");
});

test("no date at all and unreadable dates are different sentences", () => {
  /*
    Two ways the pass cannot run, and they need different answers. Absent `now` is the caller's
    omission and was already handled; readable-but-wrong-keyed rows were silent, and that is the one
    that shipped a confident zero.
  */
  const noNow = crmHygiene({ records: [{ id: "a", name: "A", last_touched_at: "2026-01-01" }] });
  assert.match(String(noNow.detail), /no date was supplied/);
  assert.doesNotMatch(String(noNow.detail), /carries a date this can read/, "the two cases collapsed into one sentence");
});
