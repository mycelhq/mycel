// THE WORK LIST — which skills are asking to be rewritten, and which are being left alone.
//
// The expensive mistakes this file exists to prevent are all mistakes of SELECTION rather than of
// writing. A rewrite costs a reflection run, a trial, and weeks of split traffic, so proposing the
// wrong one is not a wasted paragraph — it is a fifth of a business's deliverables spent proving
// something that could not have helped.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MIN_EVIDENCE,
  MIN_MOUNTS,
  POOR_ATTENTION,
  POOR_FIRST_PASS,
  candidates,
  diagnose,
  promotionCandidate,
} from "../src/skill-candidates";
import type { SkillScale } from "../src/skill-scales";

const scale = (over: Partial<SkillScale> = {}): SkillScale => ({
  wedge: "site-studio",
  skill: "a-round-is-a-batch.md",
  accepted: 0,
  revised: 0,
  total: 0,
  acceptance_rate: 0,
  released: 0,
  edited: 0,
  sent_back: 0,
  founder_total: 0,
  paid: 0,
  first_pass_rate: 0,
  mounted: 0,
  read: 0,
  attention_rate: 0,
  ...over,
});

/** A skill that is read, followed, and still rewritten by the founder. */
const badProcedure = scale({ founder_total: 20, released: 4, first_pass_rate: 0.2, mounted: 40, read: 36, attention_rate: 0.9 });
/** A skill nobody opens. */
const ignored = scale({ mounted: 60, read: 3, attention_rate: 0.05, founder_total: 20, released: 4, first_pass_rate: 0.2 });
/** A skill doing its job. */
const healthy = scale({ founder_total: 30, released: 27, first_pass_rate: 0.9, mounted: 40, read: 34, attention_rate: 0.85 });

test("a followed procedure that keeps getting rewritten needs a new body", () => {
  assert.equal(diagnose(badProcedure), "rewrite_body");
});

test("a skill nobody opens needs a new description, not a new body", () => {
  // THE ORDERING TEST, and the most valuable assertion in this file. `ignored` has a terrible
  // first-pass rate too — it was mounted into runs that went badly for reasons it had no part in.
  // Diagnosing "the procedure is wrong" there is self-reinforcing: the rewritten body is also never
  // read, the rate does not move, and it gets proposed again for ever.
  assert.equal(diagnose(ignored), "rewrite_description");
});

test("a skill that is working is never a candidate", () => {
  // A selector that always returns something eventually proposes rewriting the best skill on the
  // shelf, because it ranks by lowest score and the bad ones ran out.
  assert.equal(diagnose(healthy), "healthy");
  assert.deepEqual(candidates([healthy]), []);
});

test("a thin record is not evidence, however bad it looks", () => {
  // One or two bad afternoons. A false positive costs a trial that occupies a fifth of the traffic
  // for weeks; a missed one costs nothing but time.
  const thin = scale({ founder_total: MIN_EVIDENCE - 1, released: 0, first_pass_rate: 0 });
  assert.equal(diagnose(thin), "healthy", "not yet judgeable");

  const enough = scale({ founder_total: MIN_EVIDENCE, released: 0, first_pass_rate: 0 });
  assert.equal(diagnose(enough), "rewrite_body");
});

test("low attention needs more mounts than a verdict needs decisions", () => {
  // Attention is cheap to observe — every run that mounts a skill reports on it, settled or not — so
  // there is no reason to conclude from a handful.
  const few = scale({ mounted: MIN_MOUNTS - 1, read: 0, attention_rate: 0 });
  assert.equal(diagnose(few), "healthy");
  const many = scale({ mounted: MIN_MOUNTS, read: 0, attention_rate: 0 });
  assert.equal(diagnose(many), "rewrite_description");
});

test("the thresholds are boundaries, not vibes", () => {
  assert.equal(diagnose(scale({ founder_total: 10, released: 6, first_pass_rate: POOR_FIRST_PASS })), "healthy");
  assert.equal(diagnose(scale({ founder_total: 10, released: 5, first_pass_rate: POOR_FIRST_PASS - 0.01 })), "rewrite_body");
  assert.equal(diagnose(scale({ mounted: 100, read: 25, attention_rate: POOR_ATTENTION })), "healthy");
  assert.equal(diagnose(scale({ mounted: 100, read: 24, attention_rate: POOR_ATTENTION - 0.01 })), "rewrite_description");
});

test("the list is ordered by how much work a fix buys back", () => {
  // The same rewrite costs the same trial whatever it is worth, so the only sensible order is value.
  const small = scale({ skill: "small.md", founder_total: 8, released: 2, first_pass_rate: 0.25, mounted: 10, read: 9, attention_rate: 0.9 });
  const large = scale({ skill: "large.md", founder_total: 60, released: 20, first_pass_rate: 0.33, mounted: 70, read: 65, attention_rate: 0.93 });
  const list = candidates([small, large]);
  assert.equal(list[0]!.skill, "large.md", "40 rewritten deliverables beats 6, despite the better rate");
  assert.equal(list[0]!.weight, 40);
  assert.equal(list[1]!.weight, 6);
});

test("the reason names the numbers, because a person has to approve the rewrite", () => {
  const [c] = candidates([badProcedure]);
  assert.match(c!.why, /4 of 20/);
  assert.match(c!.why, /20%/);
  const [d] = candidates([ignored]);
  assert.match(d!.why, /mounted into 60 runs and opened in 3/);
  assert.match(d!.why, /body cannot be why anything failed/);
});

test("an empty library produces an empty list rather than an excuse", () => {
  assert.deepEqual(candidates([]), []);
  assert.deepEqual(candidates([healthy, healthy], 5), []);
});

test("the limit is respected and cannot go negative", () => {
  const many = Array.from({ length: 20 }, (_, i) =>
    scale({ skill: `s${i}.md`, founder_total: 20, released: i, first_pass_rate: i / 20, mounted: 25, read: 24, attention_rate: 0.96 }),
  );
  assert.equal(candidates(many, 3).length, 3);
  assert.equal(candidates(many, 0).length, 0);
  assert.equal(candidates(many, -5).length, 0);
});

// ── crossing into the shared shelf ──────────────────────────────────────────────────────────────

const weakGlobal = scale({ founder_total: MIN_EVIDENCE * 2, released: 2, first_pass_rate: 0.17 });

test("promotion needs a won trial, not merely an edit", () => {
  // A founder rewriting a procedure to suit their house style is the common case and generalises to
  // nobody. Only a version that beat its incumbent on real deliverables has shown anything.
  assert.equal(
    promotionCandidate({ wedge: "w", skill: "s.md", wonTrial: false, global: weakGlobal }),
    undefined,
  );
  assert.ok(promotionCandidate({ wedge: "w", skill: "s.md", wonTrial: true, global: weakGlobal }));
});

test("promotion needs the shipped version to be weak EVERYWHERE", () => {
  // If the shelf's version works elsewhere, one agency doing better with their own is evidence about
  // that agency.
  const strongGlobal = scale({ founder_total: 100, released: 90, first_pass_rate: 0.9 });
  assert.equal(
    promotionCandidate({ wedge: "w", skill: "s.md", wonTrial: true, global: strongGlobal }),
    undefined,
  );
});

test("promotion needs real global evidence, not four data points", () => {
  const thinGlobal = scale({ founder_total: MIN_EVIDENCE * 2 - 1, released: 0, first_pass_rate: 0 });
  assert.equal(
    promotionCandidate({ wedge: "w", skill: "s.md", wonTrial: true, global: thinGlobal }),
    undefined,
  );
  assert.equal(promotionCandidate({ wedge: "w", skill: "s.md", wonTrial: true, global: undefined }), undefined);
});

test("a promotion candidate is never a promotion, and says so in its own shape", () => {
  // This is the one write that reaches every customer at once, and restore only helps the tenant who
  // notices. The type is built so a caller cannot mistake a candidate for a decision.
  const c = promotionCandidate({ wedge: "w", skill: "s.md", wonTrial: true, global: weakGlobal });
  assert.equal(c!.promoted, false);
  assert.match(c!.why, /not worth shipping on this evidence alone/);
});
