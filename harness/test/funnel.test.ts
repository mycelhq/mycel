// The reply rate the product never computed.
//
// Every ingredient sat on the case row — touch_count, has_reply, stage — and nothing divided one by
// the other. A founder could see faces and stages and could not see whether outbound worked.
//
// Gilbert's tip 5 is a debugging ORDER and every rung of it is read off this number. Without it the
// founder rewrites copy, which is fourth on her list.

import test from "node:test";
import assert from "node:assert/strict";

import { funnelOf, decides, MIN_SAMPLE, WEAK_RATE, type FunnelCase } from "../src/gtm/funnel";

const worked = (n: number, over: Partial<FunnelCase> = {}): FunnelCase[] =>
  Array.from({ length: n }, () => ({ touch_count: 1, stage: "dm1", title: "Owner", ...over }));

test("funnel: nothing written to yet reads as nothing to read, not as 0%", () => {
  const f = funnelOf([{ stage: "queued", touch_count: 0 }]);
  assert.equal(f.replyRate, null);
  assert.equal(f.worked, 0);
  assert.match(f.reading, /nothing to read/i);
});

test("funnel: the denominator is WORKED, never enrolled", () => {
  // A campaign holding 400 queued and 12 written to has a rate out of 12. Dividing by 400 reports
  // near-zero for a campaign that has barely started — the exact mistake that makes a founder
  // rewrite copy that was never measured.
  const cases = [...worked(12), ...Array.from({ length: 388 }, () => ({ stage: "queued", touch_count: 0 }))];
  const f = funnelOf(cases);
  assert.equal(f.enrolled, 400);
  assert.equal(f.worked, 12);
});

test("funnel: a small sample refuses to become a percentage", () => {
  // "Two to three replies on 100 emails" is her floor for iterating. At a 2% true rate, twenty
  // sends produce zero replies about two thirds of the time; rendering that as 0.0% is the single
  // most misleading number this product could show.
  const f = funnelOf(worked(20));
  assert.equal(f.tooEarly, true);
  assert.equal(f.needMore, MIN_SAMPLE - 20);
  assert.match(f.reading, /Too few to judge/);
  assert.equal(f.checks.length, 0, "a diagnosis on 20 sends is the false confidence this prevents");
});

test("funnel: a healthy rate says so and prescribes nothing", () => {
  const cases = [...worked(96), ...worked(4, { stage: "replied", has_reply: true })];
  const f = funnelOf(cases);
  assert.equal(f.worked, 100);
  assert.equal(f.replied, 4);
  assert.ok(f.replyRate! >= WEAK_RATE);
  assert.match(f.reading, /working baseline/);
  assert.equal(f.checks.length, 0);
});

test("funnel: a weak rate opens her ladder, first rung first", () => {
  const f = funnelOf(worked(150, { title: "Marketing Manager" }));
  assert.equal(f.replied, 0);
  assert.match(f.reading, /below the 2%/);
  assert.equal(f.checks[0]!.rung, 1);
  assert.equal(f.checks[0]!.name, "Contacting the right person");
  assert.equal(f.checks[0]!.verdict, "suspect");
  assert.match(f.checks[0]!.detail, /have to go and ask somebody/);
});

test("funnel: writing to people who CAN decide passes the first rung", () => {
  const f = funnelOf(worked(150, { title: "Owner" }));
  assert.equal(f.checks[0]!.verdict, "ok");
});

test("funnel: no titles means unknown, which is not the same as passing", () => {
  // A checklist that scores what it cannot see is how a diagnosis becomes decoration.
  const f = funnelOf(worked(150, { title: null, headline: null }));
  assert.equal(f.checks[0]!.verdict, "unknown");
  for (const c of f.checks.slice(1)) assert.equal(c.verdict, "unknown");
});

test("funnel: the rungs it cannot answer say so rather than guessing", () => {
  const f = funnelOf(worked(150, { title: "Manager" }));
  const names = f.checks.map((c) => c.name);
  assert.deepEqual(names.slice(1), [
    "Contacting the right companies",
    "Subject lines",
    "The message itself",
    "Your own site and profile",
  ]);
});

test("funnel: booked and met are replies too — they answered before they booked", () => {
  const cases = [...worked(97), ...worked(2, { stage: "booked" }), ...worked(1, { stage: "met" })];
  const f = funnelOf(cases);
  assert.equal(f.replied, 3, "a booked meeting implies a reply");
  assert.equal(f.booked, 3);
  assert.equal(f.met, 1);
});

test("funnel: seniority is read in order, so a founder is not scored as a manager", () => {
  // "Founder & Product Manager" is a founder. An unordered word list inverts this check entirely.
  assert.equal(decides({ title: "Founder & Product Manager" }), true);
  assert.equal(decides({ title: "Product Manager" }), false);
  assert.equal(decides({ headline: "CEO at Hart's Bakery" }), true);
  assert.equal(decides({ title: null, headline: null }), false);
});
