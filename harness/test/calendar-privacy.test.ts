// What we keep off somebody's calendar, and what we refuse to.
//
// `syncCalendar` wrote every event it read into the record store with `data: { ...event }`, title
// included. A founder connects a calendar so we can see when their client call is, and we were
// storing "Oncology follow-up, 09:30" alongside it — while nothing in the product ever read it.
//
// These tests are about the line, not the function: the shape of somebody's week is ours to know,
// the content of it is not, except for the meetings that are ours.
import { test } from "node:test";
import assert from "node:assert/strict";
import { redactCalendar, redactEvent, titleNamesSomeone, nameTokens } from "../src/calendar-privacy";
import type { ObservedEvent } from "../src/capabilities.normalise";

const KNOWN = ["Hart's Bakery", "Kestrel Coffee", "Brightline Logistics"];

const event = (over: Partial<ObservedEvent>): ObservedEvent => ({
  external_id: "e1",
  all_day: false,
  busy: true,
  starts_at: "2026-09-01T09:30:00Z",
  ends_at: "2026-09-01T10:15:00Z",
  ...over,
});

test("a private appointment keeps its time and loses every word", () => {
  const e = event({ external_id: "med", title: "Oncology follow-up", time_zone: "Europe/London" });
  const out = redactEvent(e, KNOWN);

  assert.equal(out.starts_at, "2026-09-01T09:30:00Z", "when you are busy is what a booking desk needs");
  assert.equal(out.ends_at, "2026-09-01T10:15:00Z");
  assert.equal(out.busy, true);
  assert.equal(out.time_zone, "Europe/London");
  // And nothing about WHAT.
  assert.equal(out.title, undefined);
  assert.equal(out.meeting_url, undefined);
  assert.equal(out.matched, undefined, "no reason to keep it, so nothing kept");
  assert.equal(JSON.stringify(out).toLowerCase().includes("oncology"), false);
});

test("a meeting with somebody already in the book keeps its title", () => {
  // We knew the name before we read the calendar. Learning it is ON the calendar tells us nothing
  // new about the founder, which is what makes this the strong signal.
  const out = redactEvent(event({ title: "Hart's Bakery — quarterly review" }), KNOWN);
  assert.equal(out.title, "Hart's Bakery — quarterly review");
  assert.equal(out.matched, "known_name");

  // Spelling drift is fine: apostrophes, case, punctuation all fold away.
  assert.ok(titleNamesSomeone("HARTS BAKERY catchup", KNOWN));
  assert.ok(titleNamesSomeone("call w/ harts bakery", KNOWN));
});

test("a call we would be asked to sit in keeps its title too", () => {
  // A nameless block in the founder's own week is worse than useless when they are working out
  // which call Mycel notes is joining.
  const out = redactEvent(event({ title: "Intro call", meeting_url: "https://meet.google.com/abc-defg-hij" }), KNOWN);
  assert.equal(out.title, "Intro call");
  assert.equal(out.meeting_url, "https://meet.google.com/abc-defg-hij");
  assert.equal(out.matched, "join_link");
});

test("one weak word does not unlock a calendar", () => {
  /**
   * THE FAILURE THIS GUARDS. A client called "The Studio" would otherwise make every event
   * containing the word "studio" a work meeting, and a client called "Design" would take the whole
   * calendar — including "Design a new kitchen with Mum".
   *
   * A name with no distinguishing tokens matches NOTHING, deliberately. Redacting a real client's
   * meeting is annoying and recoverable; keeping a private one is neither.
   */
  assert.deepEqual(nameTokens("The Studio"), []);
  assert.deepEqual(nameTokens("Design Co"), []);
  assert.equal(titleNamesSomeone("Studio time", ["The Studio"]), false);
  assert.equal(titleNamesSomeone("Design a new kitchen", ["Design Co"]), false);
  // And a real name still works with a weak word in it.
  assert.deepEqual(nameTokens("Hart's Bakery Ltd"), ["harts", "bakery"]);
  assert.ok(titleNamesSomeone("Harts Bakery Ltd — kickoff", ["Hart's Bakery Ltd"]));
});

test("every token of the name has to be there, so a coincidence is not a match", () => {
  // "bakery run" is buying bread. "Hart's Bakery" is a client. One word in common is not evidence.
  assert.equal(titleNamesSomeone("bakery run", KNOWN), false);
  assert.equal(titleNamesSomeone("coffee with Jo", KNOWN), false);
  assert.equal(titleNamesSomeone("Kestrel", KNOWN), false, "half a name is not the name");
  assert.ok(titleNamesSomeone("Kestrel Coffee — pricing", KNOWN));
});

test("the sweep reports what it kept and what it did not, because the promise has to be visible", () => {
  const summary = redactCalendar(
    [
      event({ external_id: "a", title: "Hart's Bakery — quarterly" }),
      event({ external_id: "b", title: "Dentist" }),
      event({ external_id: "c", title: "School pickup" }),
      event({ external_id: "d", title: "Intro", meeting_url: "https://zoom.us/j/123" }),
      event({ external_id: "e", title: "Lunch", all_day: true, busy: false, day: "2026-09-02" }),
    ],
    KNOWN,
  );
  assert.equal(summary.events.length, 5, "every event is stored — the times are the point");
  assert.equal(summary.kept, 2);
  assert.equal(summary.redacted, 3);

  // Nothing personal survives anywhere in what would be written.
  const written = JSON.stringify(summary.events).toLowerCase();
  for (const word of ["dentist", "school pickup", "lunch"]) {
    assert.equal(written.includes(word), false, `"${word}" reached the record store`);
  }
  // An all-day free block still keeps its day and its busy flag: that is availability, not content.
  const allDay = summary.events.find((e) => e.external_id === "e")!;
  assert.equal(allDay.day, "2026-09-02");
  assert.equal(allDay.busy, false);
  assert.equal(allDay.title, undefined);
});

test("no known clients at all redacts everything except calls", () => {
  // A brand-new business has an empty book. Every title is unattributable and the calendar is
  // therefore times-only — which is the correct default rather than an edge case.
  const summary = redactCalendar(
    [event({ external_id: "a", title: "Physio" }), event({ external_id: "b", title: "Standup", meeting_url: "https://meet.google.com/x" })],
    [],
  );
  assert.equal(summary.kept, 1);
  assert.equal(summary.events[0]!.title, undefined);
  assert.equal(summary.events[1]!.title, "Standup");
});
