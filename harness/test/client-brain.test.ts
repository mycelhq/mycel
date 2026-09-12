// The reading-comprehension half. `client-mind` does the arithmetic; this decides what the client
// THINKS. Keeping them apart is what stops the simulation producing a plausible story and no signal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { briefing, judge, parseJudgement, PERSONAS, type Seen } from "../src/simulation/client-brain";
import { freshMemory, receive, type Memory, type Received } from "../src/simulation/client-mind";

const persona = PERSONAS[0]!;
const got = (version = 1, over: Partial<Received> = {}): Received =>
  ({ version, body: "Your close is done.", waitedHours: 1, files: ["close.pdf"], ...over });
const seen = (over: Partial<Seen> = {}): Seen =>
  ({ body: "Your close is done.", files: ["close.pdf"], openAsks: [], ...over });

test("an unparseable answer is NOT a pass", () => {
  // The tempting default is to treat a broken response as approval so a flaky model does not fail
  // the run. That makes the simulation lie in the flattering direction, silently, at exactly the
  // moments the model was confused.
  for (const junk of ["", "I think it's fine!", "MODEL ERROR: timeout", "{oops"]) {
    const j = parseJudgement(junk);
    assert.equal(j.meetsStandard, false, `"${junk}" must not read as approval`);
  }
});

test("it reads strict JSON, fenced JSON, and JSON with chatter around it", () => {
  const want = { meetsStandard: true };
  assert.equal(parseJudgement('{"meetsStandard":true,"addressesObjection":null,"complaint":null}').meetsStandard, true);
  assert.equal(parseJudgement('```json\n{"meetsStandard":true}\n```').meetsStandard, true);
  assert.equal(parseJudgement('Sure — {"meetsStandard":true} — hope that helps').meetsStandard, true);
  void want;
});

test("a dissatisfied client who names nothing still produces something actionable", () => {
  const j = parseJudgement('{"meetsStandard":false,"complaint":null}');
  assert.equal(j.meetsStandard, false);
  assert.equal(j.complaint, "this is not what we agreed");
});

test("addressesObjection is only carried when the model actually answered it", () => {
  assert.equal(parseJudgement('{"meetsStandard":true}').addressesObjection, undefined);
  assert.equal(parseJudgement('{"meetsStandard":true,"addressesObjection":null}').addressesObjection, undefined);
  assert.equal(parseJudgement('{"meetsStandard":true,"addressesObjection":false}').addressesObjection, false);
});

test("THE BRIEFING PUTS THE OBJECTION IN CAPITALS, because a model given it in passing answers it in passing", () => {
  const m: Memory = receive(freshMemory(), got(1), { meetsStandard: false, complaint: "the VAT figure is for the wrong quarter" }).memory;
  const text = briefing(persona, m, got(2), seen());
  assert.match(text, /LAST TIME YOU TOLD THEM: "the VAT figure is for the wrong quarter"/);
  assert.match(text, /THE MAIN QUESTION NOW IS WHETHER THEY FIXED IT/);
  assert.match(text, /version 2/);
});

test("a first delivery is framed as a first delivery, with no phantom history", () => {
  const text = briefing(persona, freshMemory(), got(1), seen());
  assert.match(text, /FIRST thing they have sent you/);
  assert.doesNotMatch(text, /LAST TIME YOU TOLD THEM/);
});

test("repeating yourself is stated, because it is what turns annoyance into churn", () => {
  let m = receive(freshMemory(), got(1), { meetsStandard: false, complaint: "wrong quarter" }).memory;
  m = receive(m, got(2), { meetsStandard: true, addressesObjection: false }).memory;
  const text = briefing(persona, m, got(3), seen());
  assert.match(text, /already had to say it 2 time\(s\)/);
  assert.match(text, /losing confidence/);
});

test("HOMEWORK IS THE FIRST IMPRESSION, and no text-only judgement can see it", () => {
  const text = briefing(persona, freshMemory(), got(1), seen({ openAsks: ["Your bank statement", "The month to close"] }));
  assert.match(text, /Before you can even see the work, they are asking you for 2 thing\(s\)/);
  assert.match(text, /Your bank statement/);
});

test("no files is stated loudly — an empty delivery is a real failure mode", () => {
  const text = briefing(persona, freshMemory(), got(1), seen({ files: [] }));
  assert.match(text, /NO FILES ARE ATTACHED/);
});

test("lateness only appears once it is a whole day", () => {
  assert.doesNotMatch(briefing(persona, freshMemory(), got(1, { waitedHours: 20 }), seen()), /You waited/);
  assert.match(briefing(persona, freshMemory(), got(1, { waitedHours: 50 }), seen()), /You waited 2 day\(s\)/);
});

test("images are announced, and the client is told to judge what they SEE", () => {
  const text = briefing(persona, freshMemory(), got(1), seen({ portalShot: Buffer.from("png") }));
  assert.match(text, /Judge what you SEE, not what it claims/);
});

test("personas differ, so the same deliverable can pass for one trade and fail for another", () => {
  const texts = PERSONAS.map((p) => briefing(p, freshMemory(), got(1), seen()));
  assert.equal(new Set(texts).size, PERSONAS.length, "each persona must brief differently");
  assert.match(texts.join("\n"), /reads on a phone between jobs/);
});

test("judge() passes both screenshots to the model and returns a parsed judgement", async () => {
  let captured: { images: Buffer[]; user: string } | undefined;
  const j = await judge({
    persona, memory: freshMemory(), got: got(1),
    seen: seen({ portalShot: Buffer.from("a"), artifactShot: Buffer.from("b") }),
    vision: async (a) => { captured = a; return '{"meetsStandard":true}'; },
  });
  assert.equal(j.meetsStandard, true);
  assert.equal(captured?.images.length, 2, "the client looks at the page AND the document");
});

test("a model that throws does not crash the run, and does not read as approval", async () => {
  const j = await judge({
    persona, memory: freshMemory(), got: got(1), seen: seen(),
    vision: async () => { throw new Error("provider 503"); },
  });
  assert.equal(j.meetsStandard, false);
});
