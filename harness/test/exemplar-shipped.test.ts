// THE BAR, WHEN THE FOUNDER HAS NOT SET ONE.
//
// `exemplar.ts` states the diagnosis: the craft skills are prose — "name the work", "do not guess a
// figure" — and "824 lines of it across ten wedges, and ZERO worked examples. So a run knows the
// rules and has never been shown the game." Its own fix reads the founder's upload from onboarding.
//
// In production that upload almost never exists: most accounts never reach the screen that asks for
// it. So the path meant to end this failure was mounting nothing, and every run fell back to prose
// rules with no demonstration — which is the state it was written to end.
import test from "node:test";
import assert from "node:assert/strict";
import { shippedExemplarSkills } from "../src/exemplar";
import { loadWedge } from "../src/wedge";

test("a wedge can ship the bar its runs are held to", () => {
  const w = loadWedge("geo-monitor");
  assert.ok(w, "geo-monitor should load");
  assert.ok(w!.exemplars.length > 0, "geo-monitor ships a worked example of its weekly report");

  const mounted = shippedExemplarSkills(w);
  assert.equal(mounted.length, 1);
  assert.match(mounted[0]!.name, /^exemplar:/);
});

test("a shipped exemplar says what it is — a reference, not this firm's work", () => {
  const mounted = shippedExemplarSkills(loadWedge("geo-monitor"));
  const c = mounted[0]!.content;

  // The founder's own exemplar is framed as "a real deliverable this firm has already sent a
  // client". Saying that about a document we wrote would be a lie the model then acts on, by
  // imitating a client relationship that does not exist.
  assert.match(c, /REFERENCE deliverable/);
  assert.match(c, /not this\s+firm's work/);
  assert.match(c, /invented/);
  assert.ok(!/already sent a client/.test(c), "must not claim our reference is the firm's own work");

  // And the instruction that makes an example useful rather than a template to plagiarise.
  assert.match(c, /DO NOT COPY ITS CONTENT/);
  assert.match(c, /markedly shorter or thinner/);
});

test("a wedge with no exemplars mounts nothing rather than an empty section", () => {
  // An empty "here is the bar" heading with no document under it is worse than silence: it tells
  // the model a standard exists and then shows it nothing.
  assert.deepEqual(shippedExemplarSkills({ exemplars: [] }), []);
  assert.deepEqual(shippedExemplarSkills(null), []);
  assert.deepEqual(shippedExemplarSkills({ exemplars: [{ name: "empty.md", content: "   " }] }), []);
});

test("the shipped exemplar is deep enough to be a bar", () => {
  // The whole argument for an example is that depth is the one property prose cannot specify. A
  // 200-word "example" would teach the opposite of what it is mounted to teach.
  const w = loadWedge("geo-monitor");
  const words = w!.exemplars[0]!.content.split(/\s+/).filter(Boolean).length;
  assert.ok(words > 700, `a reference deliverable should be substantial, got ${words} words`);
});
