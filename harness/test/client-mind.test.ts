// The loop nothing tested: v1 → objection → v2 → does it address the objection?
// Every client in scripts/simulate.ts is scripted, so it can prove the transitions exist and
// nothing else. The transitions were never the risk.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  asked, freshMemory, receive, summarise, COST, QUIET_THRESHOLD,
  type Memory, type Received,
} from "../src/simulation/client-mind";

const got = (version: number, over: Partial<Received> = {}): Received => ({
  version, body: "Here is your monthly close.", waitedHours: 1, files: ["close.pdf"], ...over,
});
const good = { meetsStandard: true };
const bad = (complaint: string) => ({ meetsStandard: false, complaint });

test("work that meets the standard is accepted", () => {
  const { verdict, memory } = receive(freshMemory(), got(1), good);
  assert.equal(verdict.kind, "accept");
  assert.equal(memory.seen.length, 1);
});

test("a specific complaint becomes a remembered objection, not a vague rejection", () => {
  const { verdict, memory } = receive(freshMemory(), got(1), bad("the VAT figure is for the wrong quarter"));
  assert.equal(verdict.kind, "request_changes");
  assert.equal(memory.objections.length, 1);
  assert.equal(memory.objections[0]!.text, "the VAT figure is for the wrong quarter");
  assert.equal(memory.objections[0]!.version, 1);
});

test("THE WHOLE POINT: a polished v2 that ignores the objection ESCALATES, it does not accept", () => {
  // This is the failure that never reaches a support ticket. A v2 that is better in every way and
  // ignores the one thing said is worse than a rough v2 that addresses it.
  let m: Memory = receive(freshMemory(), got(1), bad("the VAT figure is for the wrong quarter")).memory;

  const second = receive(m, got(2, { body: "A far more polished close." }), {
    meetsStandard: true,              // the work is objectively better
    addressesObjection: false,        // and it ignored what was said
  });

  assert.equal(second.verdict.kind, "escalate", "quality must not paper over being ignored");
  assert.equal(second.memory.objections[0]!.ignoredCount, 1);
  assert.ok(second.memory.patience < m.patience - COST.IGNORED_OBJECTION + 1);
});

test("addressing the objection resolves it, and the next version is judged clean", () => {
  let m = receive(freshMemory(), got(1), bad("the VAT figure is wrong")).memory;
  const second = receive(m, got(2), { meetsStandard: true, addressesObjection: true });
  assert.equal(second.verdict.kind, "accept");
  assert.match(second.verdict.kind === "accept" ? second.verdict.why : "", /objection from v1 was addressed/);

  // And a third version is not still being judged against a resolved complaint.
  const third = receive(second.memory, got(3), { meetsStandard: true });
  assert.equal(third.verdict.kind, "accept");
});

test("ignored TWICE is churn — and the reason names the cause", () => {
  // Exactly enough patience to object once and be ignored once: the objection costs
  // IGNORED_OBJECTION, which takes them to zero. At 45 they would escalate instead, and that
  // difference is the design — escalation is still recoverable, churn is not.
  let m = freshMemory(COST.IGNORED_OBJECTION);
  m = receive(m, got(1), bad("the VAT figure is wrong")).memory;
  const out = receive(m, got(2), { meetsStandard: true, addressesObjection: false });
  assert.equal(out.verdict.kind, "churn");
  assert.match(out.verdict.kind === "churn" ? out.verdict.why : "", /asked twice/);
  assert.equal(out.memory.gone, true);
});

test("a client who has left does not come back because a nice v3 arrived", () => {
  // NOT freshMemory(1): a client already below the quiet line goes quiet on v1 and never registers
  // an objection at all — quiet clients stop giving feedback, which is the point of that ordering.
  // To reach `gone` they have to be engaged enough to object first, then be ignored.
  let m = freshMemory(COST.IGNORED_OBJECTION);
  m = receive(m, got(1), bad("wrong")).memory;
  m = receive(m, got(2), { meetsStandard: true, addressesObjection: false }).memory;
  assert.equal(m.gone, true);
  const later = receive(m, got(3), { meetsStandard: true, addressesObjection: true });
  assert.equal(later.verdict.kind, "churn", "nothing sent after they leave is read");
});

test("real clients GO QUIET rather than complain — and the sim must see it coming", () => {
  const m = freshMemory(QUIET_THRESHOLD + 2);
  const out = receive(m, got(1, { waitedHours: 24 }), good); // one day late tips them under
  assert.equal(out.verdict.kind, "go_quiet");
  assert.notEqual(out.memory.gone, true, "quiet is not gone — still nominally a client");
});

test("lateness is priced per day, and hours do not count", () => {
  const a = receive(freshMemory(), got(1, { waitedHours: 20 }), good);
  assert.equal(a.memory.patience, 100, "nobody notices twenty hours");
  const b = receive(freshMemory(), got(1, { waitedHours: 72 }), good);
  assert.equal(b.memory.patience, 100 - 3 * COST.LATE_PER_DAY);
});

test("an empty delivery costs, because that is what a refusal-as-work looks like from outside", () => {
  const out = receive(freshMemory(), got(1, { body: "  ", files: [] }), good);
  assert.equal(out.memory.patience, 100 - COST.EMPTY_DELIVERY);
});

test("asks compete with deliverables for the SAME patience", () => {
  // A simulation where only deliverables cost anything rates a system that asks fifteen questions
  // identically to one that asks three.
  const a = asked(freshMemory(), 3);
  assert.equal(a.memory.patience, 100 - 3 * COST.EACH_ASK);
  assert.equal(a.answers, true);

  const b = asked(freshMemory(30), 1);
  assert.equal(b.answers, false, "below the quiet line they stop doing homework first");
});

test("a reworded complaint is still the same complaint", () => {
  // The paraphrase problem that let one production case accumulate the same question three times.
  let m = receive(freshMemory(), got(1), bad("the VAT figure is wrong")).memory;
  const out = receive(m, got(2), bad("the sales-tax number still looks off to me"));
  assert.equal(out.verdict.kind, "escalate");
  assert.equal(out.memory.objections.length, 1, "not a second objection — the same one, twice");
  assert.equal(out.memory.objections[0]!.ignoredCount, 1);
});

test("summarise gives the report one readable line per relationship", () => {
  let m = receive(freshMemory(), got(1), bad("wrong quarter")).memory;
  m = receive(m, got(2), { meetsStandard: true, addressesObjection: true }).memory;
  m = asked(m, 2).memory;
  const line = summarise(m);
  assert.match(line, /2 version\(s\)/);
  assert.match(line, /all resolved/);
  assert.match(line, /2 ask\(s\)/);
  assert.match(line, /engaged/);
});
