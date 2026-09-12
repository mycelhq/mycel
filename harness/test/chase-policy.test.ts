// HOW OFTEN THIS BUSINESS CHASES ITS OWN CLIENTS.
//
// `chaseIntervalDays` was three `if` statements — 3 days, then 5, then 7. Good defaults, chosen
// carefully, and wrong to impose. "How many times do you want us to chase a client, and how hard" is
// the one question a founder has an opinion about before they have an opinion about anything else in
// this product, and a founder asking us to ease off had nothing to change because the number was in
// a compiled function.
//
// What they may NOT change is the floor. `wedges/invoice-chaser/knowledge/dunning-policy.md` says
// "never chase the same invoice twice in 48h", and that is not a preference — it is what stops our
// sending address chasing somebody's customer daily.
import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CHASE_POLICY,
  MAX_CHASES_CEILING,
  MAX_INTERVAL_DAYS,
  MIN_CHASE_INTERVAL_DAYS,
  chaseIntervalFor,
  chasesExhausted,
  toChasePolicy,
} from "../src/chase-policy";
import { chaseIntervalDays } from "../src/dunning";

test("the default ladder is exactly what was hardcoded", () => {
  // The change must be a refactor for every existing project. A founder who never opens the setting
  // has to be chased on the same rungs as before, or this is a silent behaviour change to live
  // collections.
  assert.equal(chaseIntervalDays(3), 3);
  assert.equal(chaseIntervalDays(14), 5);
  assert.equal(chaseIntervalDays(60), 7);
  assert.equal(chaseIntervalDays(Number.NaN), MIN_CHASE_INTERVAL_DAYS);
});

test("a founder's own ladder is honoured", () => {
  const gentle = toChasePolicy({ firstDays: 7, secondDays: 14, laterDays: 30, maxChases: 3 });
  assert.equal(chaseIntervalFor(3, gentle), 7);
  assert.equal(chaseIntervalFor(14, gentle), 14);
  assert.equal(chaseIntervalFor(60, gentle), 30);
});

test("the 48-hour floor cannot be configured away", () => {
  // The whole point. A settings screen that let a bad day override this would make the product an
  // instrument of something we would not defend.
  const aggressive = toChasePolicy({ firstDays: 0, secondDays: 1, laterDays: -5 });
  assert.equal(aggressive.firstDays, MIN_CHASE_INTERVAL_DAYS);
  assert.equal(aggressive.secondDays, MIN_CHASE_INTERVAL_DAYS);
  assert.equal(aggressive.laterDays, MIN_CHASE_INTERVAL_DAYS);
  assert.ok(chaseIntervalFor(1, aggressive) >= MIN_CHASE_INTERVAL_DAYS);
});

test("one bad field does not throw away the other three", () => {
  // A row hand-edited or written by an older shape must not be refused wholesale — that drops
  // settings the founder did choose, on the ground, silently.
  const p = toChasePolicy({ firstDays: "nonsense", secondDays: 9, laterDays: 12, maxChases: 4 });
  assert.equal(p.firstDays, DEFAULT_CHASE_POLICY.firstDays, "the bad field falls back");
  assert.equal(p.secondDays, 9);
  assert.equal(p.laterDays, 12);
  assert.equal(p.maxChases, 4);
});

test("the ladder has an end, and it cannot be removed", () => {
  // An invoice chased ten times is not going to be paid by an eleventh email. The honest next move
  // is a person deciding whether to write it off.
  assert.equal(toChasePolicy({ maxChases: 500 }).maxChases, MAX_CHASES_CEILING);
  assert.equal(toChasePolicy({ maxChases: 0 }).maxChases, 1, "zero means never, which is what disabling is for");
  assert.equal(toChasePolicy({ firstDays: 9999 }).firstDays, MAX_INTERVAL_DAYS);
});

test("chases are exhausted on COUNT, not on age", () => {
  const p = toChasePolicy({ maxChases: 3 });
  // An invoice 200 days overdue chased twice is still worth a third; one chased six times last month
  // is not worth a seventh whatever its age. Age is what the intervals already respond to.
  assert.equal(chasesExhausted(2, p), false);
  assert.equal(chasesExhausted(3, p), true);
  assert.equal(chasesExhausted(9, p), true);
});

test("an empty or missing policy is the default, never nothing", () => {
  // A store blip must not silently stop the collections a business depends on.
  assert.deepEqual(toChasePolicy(undefined), DEFAULT_CHASE_POLICY);
  assert.deepEqual(toChasePolicy({}), DEFAULT_CHASE_POLICY);
  assert.deepEqual(toChasePolicy(null), DEFAULT_CHASE_POLICY);
});
