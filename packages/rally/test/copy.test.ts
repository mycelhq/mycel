import test from "node:test";
import assert from "node:assert/strict";
import { daysUntil, phaseOf, stillWorth, voiceFor } from "../src/copy";

const LAUNCH = new Date("2026-09-15T00:00:00Z");
const on = (iso: string) => new Date(iso);

test("the phase is whole days, not hours", () => {
  assert.equal(daysUntil(LAUNCH, on("2026-09-08T23:59:00Z")), 7);
  assert.equal(daysUntil(LAUNCH, on("2026-09-15T00:01:00Z")), 0, "launch day all day, not just midnight");
  assert.equal(daysUntil(LAUNCH, on("2026-09-15T23:59:00Z")), 0);
  assert.equal(daysUntil(LAUNCH, on("2026-09-16T00:01:00Z")), -1);
});

test("each phase says the thing that is true that day", () => {
  assert.equal(phaseOf(LAUNCH, on("2026-09-08T10:00:00Z")), "early");
  assert.equal(phaseOf(LAUNCH, on("2026-09-14T10:00:00Z")), "eve");
  assert.equal(phaseOf(LAUNCH, on("2026-09-15T10:00:00Z")), "launch");
  assert.equal(phaseOf(LAUNCH, on("2026-09-16T10:00:00Z")), "over");
});

// The two messages the founder actually described: before, we say we ARE GOING TO launch; on the
// day, we say we HAVE launched. Getting the tense wrong on either side wastes the connection.
test("before the launch it is a date, on the day it is a link", () => {
  const early = voiceFor("early", { at: LAUNCH }).firstMessage("Sankari Nair");
  assert.match(early, /launching on Product Hunt on 15 September/);
  assert.doesNotMatch(early, /today/);

  const day = voiceFor("launch", { at: LAUNCH, url: "https://ph.co/mycel" }).firstMessage("Sankari Nair");
  assert.match(day, /live on Product Hunt today/);
  assert.match(day, /https:\/\/ph\.co\/mycel/);
});

test("the day before says tomorrow, and does not send a link that does not exist yet", () => {
  const eve = voiceFor("eve", { at: LAUNCH }).firstMessage("Gal Dayan");
  assert.match(eve, /tomorrow/);
  assert.doesNotMatch(eve, /https?:\/\//);
});

test("it uses a first name, and survives one that is punctuated", () => {
  assert.match(voiceFor("early", { at: LAUNCH }).firstMessage("Tham (Sylvia) Nguyen"), /Thanks for connecting, Tham\./);
  assert.match(voiceFor("launch", { at: LAUNCH }).firstMessage("J.D. Salbego"), /^J\.D\. —/);
});

// growth/lib/launch/window.ts refuses the product's own ask as `too_late` for this reason, and the
// Product Hunt campaign still sat paused a week past its date because nothing acted on it.
test("after launch day the rally stops asking", () => {
  assert.equal(stillWorth("launch"), true);
  assert.equal(stillWorth("over"), false);
  const after = voiceFor("over", { at: LAUNCH });
  assert.doesNotMatch(after.firstMessage("Gal Dayan"), /take a look|would mean a lot|tomorrow/);
  assert.equal(after.followUp("Gal Dayan"), "", "there is no follow-up for a day that has passed");
});
