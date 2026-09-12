// The work that was waiting for an account, woken the moment the account arrives.
//
// Onboarding asks a founder to connect LinkedIn before anything can go out. Connecting writes a row
// and returns — correct, because a route that started outreach would be doing the scheduler's job
// without its pacing. Then the GTM loop, having already ticked and found no account, sits on a
// `next_run_at` a full cadence away, and `DEFAULT_AUDIENCE_CADENCE` is SEVEN DAYS.
//
// Nothing breaks. Nothing logs an error. The founder does exactly what they were asked and watches
// the product do nothing for a week, which is when they stop opening it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { wakeForConnection, WOKEN_BY_CONNECTION } from "../src/wake-schedules";
import { AUTONOMOUS_GTM_TASK_TYPE } from "../src/gtm/autonomous";
import { ADVANCE_TASK_TYPE } from "../src/gtm/sequence";
import type { Schedule } from "../src/contract";

const NOW = new Date("2026-08-30T12:00:00.000Z");
const WEEK_AWAY = "2026-09-06T09:00:00.000Z";

const sched = (over: Partial<Schedule>): Schedule =>
  ({
    id: `s${Math.random()}`,
    project_id: "p1",
    name: "n",
    wedge: "gtm-operator",
    task_type: AUTONOMOUS_GTM_TASK_TYPE,
    input: {},
    cadence: { kind: "every", seconds: 604800 },
    enabled: true,
    next_run_at: WEEK_AWAY,
    created_at: "2026-08-01T00:00:00.000Z",
    ...over,
  }) as Schedule;

function store(rows: Schedule[]) {
  const updates: Array<{ id: string; patch: Partial<Schedule> }> = [];
  return {
    updates,
    listSchedules: async () => rows,
    updateSchedule: async (id: string, patch: Partial<Schedule>) => {
      updates.push({ id, patch });
      return rows.find((r) => r.id === id)!;
    },
  };
}

test("the week-long wait is closed: a schedule due next Monday runs now", () => {
  return (async () => {
    const gtm = sched({ id: "gtm" });
    const s = store([gtm]);
    const woken = await wakeForConnection(s as never, { project_id: "p1", kind: "linkedin", now: NOW });

    assert.equal(woken.length, 1);
    assert.equal(woken[0]!.task_type, AUTONOMOUS_GTM_TASK_TYPE);
    // What it WOULD have been, because the interesting fact in a log is how long the founder would
    // have waited — not that something changed.
    assert.equal(woken[0]!.was_due_at, WEEK_AWAY);
    assert.deepEqual(s.updates, [{ id: "gtm", patch: { next_run_at: NOW.toISOString() } }]);
  })();
});

test("the task types are the real ones, which a hand-typed string was not", async () => {
  /**
   * The first draft of the lookup wrote `"autonomous_gtm"`. The constant is `gtm_autonomous`. That
   * string would have matched no schedule, woken nothing, returned an empty array and looked exactly
   * like a working fix.
   *
   * This asserts against the exported constants, so a rename moves both or fails here.
   */
  assert.deepEqual([...WOKEN_BY_CONNECTION.linkedin!], [AUTONOMOUS_GTM_TASK_TYPE, ADVANCE_TASK_TYPE]);
  assert.equal(AUTONOMOUS_GTM_TASK_TYPE, "gtm_autonomous");

  const s = store([sched({ id: "adv", task_type: ADVANCE_TASK_TYPE })]);
  assert.equal((await wakeForConnection(s as never, { project_id: "p1", kind: "linkedin", now: NOW })).length, 1);
});

test("a disabled schedule stays asleep", async () => {
  // It is off because a founder or a go-live gate turned it off. Connecting an account is not
  // consent to start sending — that is what go-live is for, and waking it here would send mail
  // somebody deliberately stopped.
  const s = store([sched({ id: "off", enabled: false })]);
  assert.deepEqual(await wakeForConnection(s as never, { project_id: "p1", kind: "linkedin", now: NOW }), []);
  assert.deepEqual(s.updates, []);
});

test("another project's schedules are not touched", async () => {
  const s = store([sched({ id: "theirs", project_id: "p2" })]);
  assert.deepEqual(await wakeForConnection(s as never, { project_id: "p1", kind: "linkedin", now: NOW }), []);
  assert.deepEqual(s.updates, []);
});

test("an unrelated job is not dragged forward", async () => {
  /**
   * A closed list rather than "every schedule in the project". Waking a monthly close because
   * somebody connected LinkedIn would run a bookkeeping job a fortnight early against a ledger that
   * has not been updated — the founder asked for one thing to start and got an unrelated deliverable.
   */
  const s = store([sched({ id: "close", wedge: "books-keeper", task_type: "monthly_close" })]);
  assert.deepEqual(await wakeForConnection(s as never, { project_id: "p1", kind: "linkedin", now: NOW }), []);
});

test("an already-due schedule is left alone, so it does not lose how late it is", async () => {
  // The sweep takes it on the next pass anyway, and rewriting the timestamp would throw away the
  // one piece of information worth having about it.
  const s = store([sched({ id: "late", next_run_at: "2026-08-30T06:00:00.000Z" })]);
  assert.deepEqual(await wakeForConnection(s as never, { project_id: "p1", kind: "linkedin", now: NOW }), []);
  assert.deepEqual(s.updates, []);
});

test("a connection kind nothing waits on wakes nothing", async () => {
  const s = store([sched({ id: "gtm" })]);
  assert.deepEqual(await wakeForConnection(s as never, { project_id: "p1", kind: "email", now: NOW }), []);
  assert.deepEqual(await wakeForConnection(s as never, { project_id: "", kind: "linkedin", now: NOW }), []);
});
