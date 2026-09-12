import test from "node:test";
import assert from "node:assert/strict";
import { plan } from "../src/plan";

const seats = (n: number, each: number) =>
  Array.from({ length: n }, (_, i) => ({ name: `s${i}`, remainingToday: each, sentToday: 0, weekCap: null, sentThisWeek: 0 }));

test("it says how many a day, and admits when that is not enough", () => {
  const p = plan({ queued: 616, invited: 0, accepted: 0, messaged: 0, replied: 0, seats: seats(4, 11), daysToLaunch: 7 });
  assert.equal(p.capacityPerDay, 44);
  assert.equal(p.perDayToClearQueue, 88, "616 over 7 days");
  assert.equal(p.reachableByLaunch, 308, "44 a day for 7 days");
  assert.equal(p.unreachable, 308);
  assert.match(p.verdict, /308 of the queue will not be reached/);
});

test("when capacity covers the queue it says so plainly", () => {
  const p = plan({ queued: 200, invited: 0, accepted: 0, messaged: 0, replied: 0, seats: seats(4, 20), daysToLaunch: 7 });
  assert.equal(p.unreachable, 0);
  assert.match(p.verdict, /whole queue is reachable/);
});

// A rate computed off three invitations is noise presented as knowledge.
test("it projects on the observed rate only once there is enough of one", () => {
  const thin = plan({ queued: 100, invited: 3, accepted: 3, messaged: 0, replied: 0, seats: seats(1, 10), daysToLaunch: 5 });
  assert.equal(thin.acceptRate, 100, "the rate is still shown");
  assert.match(thin.verdict, /assumes 28%/, "but it is not used to project");

  const thick = plan({ queued: 100, invited: 50, accepted: 25, messaged: 0, replied: 0, seats: seats(1, 10), daysToLaunch: 5 });
  assert.equal(thick.acceptRate, 50);
  assert.doesNotMatch(thick.verdict, /assumes/);
  assert.equal(thick.projectedConnections, 50, "25 already + 50% of the 50 reachable");
});

test("rates are null rather than zero when nothing has happened", () => {
  const p = plan({ queued: 10, invited: 0, accepted: 0, messaged: 0, replied: 0, seats: seats(1, 5), daysToLaunch: 3 });
  assert.equal(p.acceptRate, null, "0/0 is not 0%");
  assert.equal(p.replyRate, null);
});
