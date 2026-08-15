// Lead-timezone-aware scheduling: the SOFT preference that sits inside the HARD seat window.
//
// Two properties matter and are both proved here:
//   · the seat window (08:00–19:00 weekdays, seat-local) is never violated — every returned instant
//     is inside it, whatever the lead's timezone;
//   · when there is overlap, the touch lands in the lead's own business hours too; when there is not,
//     ban-safety wins and it falls back to the seat window rather than deferring forever.
import { test } from "node:test";
import assert from "node:assert/strict";
import { timezoneForLocation, leadLocalHour, preferredSendAt } from "../src/gtm/lead-timezone";
import { withinSendingWindow, localClock } from "../src/pacing";

const H = 60;

test("timezoneForLocation maps known locations to sane offsets", () => {
  // US East (New York) — around UTC-5.
  assert.equal(timezoneForLocation("New York, New York, United States"), -5 * H);
  assert.equal(timezoneForLocation("San Francisco Bay Area"), -8 * H);
  // France — CET, UTC+1.
  assert.equal(timezoneForLocation("Paris, Paris, France"), 1 * H);
  // India — UTC+5:30, the half-hour case.
  assert.equal(timezoneForLocation("Bengaluru, Karnataka, India"), 5 * H + 30);
  assert.equal(timezoneForLocation("London, United Kingdom"), 0);
  assert.equal(timezoneForLocation("Sydney, New South Wales, Australia"), 10 * H);
});

test("timezoneForLocation returns undefined for garbage / empty", () => {
  assert.equal(timezoneForLocation(undefined), undefined);
  assert.equal(timezoneForLocation(""), undefined);
  assert.equal(timezoneForLocation("asdfqwer nowhere land"), undefined);
});

test("leadLocalHour applies the offset to the UTC instant", () => {
  // 12:00 UTC, lead at +5:30 → 17:30 local → hour 17.
  const noonUtc = new Date("2026-08-17T12:00:00.000Z");
  assert.equal(leadLocalHour(5 * H + 30, noonUtc), 17);
  // 12:00 UTC, lead at -5 → 07:00 local.
  assert.equal(leadLocalHour(-5 * H, noonUtc), 7);
});

// A France seat: utc_offset is in HOURS on the connection config, exactly as pacing.localClock reads.
const franceSeat = { utc_offset: 1 };

test("preferredSendAt picks a slot in BOTH windows for a US-East lead + France seat", () => {
  const usEast = timezoneForLocation("New York")!;
  // Monday 06:00 UTC — before the seat window opens (07:00 local Paris).
  const from = new Date("2026-08-17T06:00:00.000Z");
  const at = preferredSendAt({ seatConfig: franceSeat, leadOffsetMinutes: usEast, from });

  // HARD gate: inside the seat's 08:00–19:00 weekday window.
  const seat = localClock(franceSeat, at);
  assert.ok(withinSendingWindow(seat.hour, seat.day), "must be inside the seat window");

  // SOFT preference: inside the lead's 09:00–17:00 local too. The lead window opens at NY 09:00 ==
  // 14:00 UTC (== 15:00 Paris, still inside the seat window), so that is the first both-windows slot.
  const leadHour = leadLocalHour(usEast, at);
  assert.ok(leadHour >= 9 && leadHour < 17, `lead hour ${leadHour} must be in 9..17`);
  assert.equal(at.toISOString(), "2026-08-17T14:00:00.000Z");
});

test("preferredSendAt falls back to the seat window when there is NO overlap", () => {
  // A Sydney lead (+10) against a France seat (+1): the seat window is UTC 07:00–18:00 while the
  // lead's 09:00–17:00 is UTC 23:00–07:00 — they meet only at the 07:00 boundary, so there is no
  // real overlap. Ban-safety wins: the touch takes the first seat-window slot.
  const sydney = timezoneForLocation("Sydney, Australia")!;
  const from = new Date("2026-08-17T06:00:00.000Z"); // Monday, 07:00 Paris — before window opens
  const at = preferredSendAt({ seatConfig: franceSeat, leadOffsetMinutes: sydney, from, horizonH: 48 });

  const seat = localClock(franceSeat, at);
  assert.ok(withinSendingWindow(seat.hour, seat.day), "fallback must still respect the seat window");
  // First seat slot is 08:00 Paris == 07:00 UTC.
  assert.equal(at.toISOString(), "2026-08-17T07:00:00.000Z");
});

test("unknown lead offset → seat-window behaviour (next seat slot, unchanged)", () => {
  const from = new Date("2026-08-17T06:00:00.000Z"); // 07:00 Paris — before the window opens
  const at = preferredSendAt({ seatConfig: franceSeat, leadOffsetMinutes: undefined, from });
  const seat = localClock(franceSeat, at);
  assert.ok(withinSendingWindow(seat.hour, seat.day));
  // First seat slot: 08:00 Paris == 07:00 UTC.
  assert.equal(at.toISOString(), "2026-08-17T07:00:00.000Z");
});

test("preferredSendAt leaves an already-in-both-windows instant where it is", () => {
  const usEast = timezoneForLocation("New York")!;
  // Monday 15:00 UTC == 16:00 Paris (seat OK) == 10:00 NY (lead OK). No shift needed.
  const from = new Date("2026-08-17T15:00:00.000Z");
  const at = preferredSendAt({ seatConfig: franceSeat, leadOffsetMinutes: usEast, from });
  assert.equal(at.toISOString(), from.toISOString());
});
