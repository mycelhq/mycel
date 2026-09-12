// WHAT IS NEXT, AND WHAT FELL OUT.
//
// The pipeline has had a `booked` stage since it was written, the meeting bot has joined calls for
// months, and nothing anywhere carried WHEN. So "when is this meeting?" — the most ordinary question
// a founder asks about a booked lead — had no answer the product could give.
//
// A calendar is a SORT, not a record: the value is entirely in the ordering. These tests are mostly
// about the ordering, because that is the product.
import test from "node:test";
import assert from "node:assert/strict";
import { buildCalendar, calendarSummary, matchBookingCase } from "../src/calendar";
import type { Case } from "../src/contract";

const NOW = new Date("2026-08-29T12:00:00Z");
const k = (over: Partial<Case>): Case =>
  ({
    id: over.id ?? "c1", wedge: "gtm-operator", title: over.title ?? "Lead",
    stage: "booked", status: "open", data: {}, history: [],
    created_at: NOW.toISOString(), updated_at: NOW.toISOString(), ...over,
  }) as Case;

test("a meeting later today reads as today, not as upcoming", () => {
  // Separated because "today" is a different feeling from "soon", and a founder plans the two
  // differently.
  const [e] = buildCalendar([k({ meeting_at: "2026-08-29T16:00:00Z" })], NOW);
  assert.equal(e!.state, "today");
});

test("a booked case carries the person so the calendar can show a face", () => {
  const [e] = buildCalendar([
    k({
      title: "Lead",
      meeting_at: "2026-08-29T16:00:00Z",
      data: { name: "Dana Reyes", profile_id: "dana-reyes", title: "Founder", company: "Hartley", email: "dana@hartley.co" },
    }),
  ], NOW);
  assert.equal(e!.person?.name, "Dana Reyes");
  assert.equal(e!.person?.profile_id, "dana-reyes");
  assert.equal(e!.person?.company, "Hartley");
});

test("a booking matches the prospect by email, and never invents one", () => {
  const known = k({ data: { contact_email: "dana@hartley.co" } });
  assert.equal(matchBookingCase([known], ["dana@hartley.co"])?.id, "c1");
  assert.equal(matchBookingCase([known], ["stranger@elsewhere.co"]), undefined);
});

test("a meeting that passed with no outcome is OVERDUE, and sorts above everything", () => {
  /**
   * The most recoverable state in the pipeline and the one most likely to be silently abandoned:
   * `booked` looks like progress for ever. A calendar sorted purely by time buries the missed
   * meeting under next week's, which is exactly how it stays missed.
   */
  const out = buildCalendar(
    [
      k({ id: "soon", meeting_at: "2026-09-02T10:00:00Z" }),
      k({ id: "today", meeting_at: "2026-08-29T18:00:00Z" }),
      k({ id: "missed", meeting_at: "2026-08-27T10:00:00Z" }),
    ],
    NOW,
  );
  assert.equal(out[0]!.case_id, "missed");
  assert.equal(out[0]!.state, "overdue");
  assert.deepEqual(out.map((e) => e.case_id), ["missed", "today", "soon"]);
});

test("a meeting an hour ago is not yet overdue", () => {
  // A two-hour grace, because a call that ran long is not a missed one and telling a founder their
  // meeting was missed while they are still in it is worse than saying nothing.
  const [e] = buildCalendar([k({ meeting_at: "2026-08-29T11:00:00Z" })], NOW);
  assert.equal(e!.state, "today");
});

test("booked with no time is a defect the calendar SHOWS", () => {
  // A meeting nobody can name the hour of is the one that gets missed. Hiding the row because it
  // cannot be placed on a timeline is how it stays hidden.
  const [e] = buildCalendar([k({ meeting_at: undefined })], NOW);
  assert.equal(e!.state, "missing_time");
});

test("an unparseable time is treated as no time, not as the epoch", () => {
  const [e] = buildCalendar([k({ meeting_at: "next tuesday" })], NOW);
  assert.equal(e!.state, "missing_time");
});

test("only an open booked case is a calendar entry", () => {
  // `met` is history, `won` is a client, a closed case is neither. None of them is something to be
  // at, and a calendar that lists them is a list of things that already happened.
  const out = buildCalendar(
    [
      k({ id: "met", stage: "met", meeting_at: "2026-08-30T10:00:00Z" }),
      k({ id: "won", stage: "won", meeting_at: "2026-08-30T10:00:00Z" }),
      k({ id: "closed", status: "closed", meeting_at: "2026-08-30T10:00:00Z" }),
      k({ id: "live", meeting_at: "2026-08-30T10:00:00Z" }),
    ],
    NOW,
  );
  assert.deepEqual(out.map((e) => e.case_id), ["live"]);
});

test("the summary leads with the problems, in the same order the list does", () => {
  // The sentence and the list must agree, or a founder reads one and acts on the other.
  const out = buildCalendar(
    [k({ id: "a", meeting_at: "2026-08-25T10:00:00Z" }), k({ id: "b" }), k({ id: "c", meeting_at: "2026-09-05T10:00:00Z" })],
    NOW,
  );
  const s = calendarSummary(out);
  assert.match(s, /^1 meeting passed with no outcome recorded/);
  assert.match(s, /1 booked with no time/);
  assert.match(s, /1 coming up/);
});

test("nothing booked is an empty string, not a cheerful sentence", () => {
  assert.equal(calendarSummary(buildCalendar([], NOW)), "");
});
