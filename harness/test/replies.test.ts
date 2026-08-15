// What happens the moment a prospect answers.
//
// This file exists because the interesting part of `noteInboundReplies` is an ORDERING, and an
// ordering is exactly the kind of invariant that survives every type check, every lint and every
// other test in the suite while being silently wrong. See the first test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getDomainStore, type DomainStore } from "../src/domain";
import { noteInboundReplies, looksLikeBooking } from "../src/gtm/replies";
import { gtmWedge } from "../src/gtm/stages";
import type { Case } from "../src/contract";

const domain = () => getDomainStore();

/** A prospect mid-sequence, with a touch recent enough to be attributable. */
async function prospect(
  project: string,
  connectionId: string,
  over: Record<string, unknown> = {},
): Promise<Case> {
  return domain().createCase({
    project_id: project,
    wedge: gtmWedge(),
    title: "Dana",
    stage: "dm1",
    status: "open",
    data: {
      connection_id: connectionId,
      profile_id: "dana",
      name: "Dana",
      thread: "urn:li:thread:1",
      last_touch_at: new Date(Date.now() - 2 * 86_400_000).toISOString(),
      ...over,
    },
  });
}

async function outcomes(project: string): Promise<Array<Record<string, unknown>>> {
  const rows = await domain().queryRecords({ project_id: project, wedge: "moves", collection: "move_outcome" });
  return rows.map((r) => r.data as Record<string, unknown>);
}

test("a reply is attributed to the touch that earned it BEFORE the stage flips", async () => {
  /**
   * THE REGRESSION THIS EXISTS TO CATCH, in the exact form it nearly arrived in.
   *
   * `noteInboundReplies` does two things to the same case: it records a `gtm_next_touch` outcome
   * against the touch that produced the reply, and then it flips the stage to `replied`. A branch
   * that rewrote the flip — to add a `booked` stage, say — and dropped or relocated the
   * attribution call would still typecheck, still flip the case, still stop the sequence, and
   * still pass every other test in this suite.
   *
   * What it would break is invisible: `gtm_next_touch` never accumulates evidence, never crosses
   * `MIN_EVIDENCE`, and its learned term stays permanently 0 — so the next-move engine cannot tell
   * outreach that works from outreach that does not, while sitting on the one event that answers
   * the question. Nothing throws. Nothing logs. The founder sees a ranking that simply never
   * improves.
   *
   * Two assertions, and both matter: the outcome EXISTS (catches deleting the call), and the write
   * that records it lands BEFORE the case update (catches moving the call below the flip, where
   * `data.last_touch_at` is no longer identifiable on a re-read of the row).
   */
  const project = `p-order-${randomUUID().slice(0, 8)}`;
  const kase = await prospect(project, "conn-1");

  // Watch the store rather than the clock: the order of the two writes is the invariant.
  const store = domain();
  const seen: string[] = [];
  const spy = new Proxy(store, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv);
      if (prop === "upsertRecord" || prop === "updateCase") {
        return (...args: unknown[]) => {
          seen.push(String(prop));
          return (v as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as DomainStore;

  const flipped = await noteInboundReplies(spy, { id: "conn-1", project_id: project }, [
    { thread_id: "urn:li:thread:1", from: { id: "dana", name: "Dana" }, sent_at: new Date().toISOString() },
  ]);
  assert.equal(flipped, 1);

  const rows = await outcomes(project);
  const attributed = rows.filter((o) => o.kind === "gtm_next_touch" && o.entity_id === kase.id);
  assert.equal(attributed.length, 1, "the reply was not attributed — the learning loop is severed");
  assert.equal(attributed[0].result, "replied");

  assert.deepEqual(
    seen,
    ["upsertRecord", "updateCase"],
    "attribution must be written BEFORE the stage flip — see the comment above",
  );

  assert.equal((await domain().getCase(kase.id))!.stage, "replied");
});

test("an inbound that names a booking time flips to booked, not merely replied — and still attributes", async () => {
  // `booked` is terminal for the sequencer exactly as `replied` is, so the sequence stops either
  // way. It is a separate stage because a meeting on the calendar wants preparation rather than an
  // answer, and because a funnel that cannot count meetings cannot be tuned.
  const project = `p-booked-${randomUUID().slice(0, 8)}`;
  const kase = await prospect(project, "conn-2");

  const flipped = await noteInboundReplies(domain(), { id: "conn-2", project_id: project }, [
    {
      thread_id: "urn:li:thread:1",
      from: { id: "dana", name: "Dana" },
      sent_at: new Date().toISOString(),
      text: "sure — grabbed a slot: https://calendly.com/dana/30min",
    },
  ]);
  assert.equal(flipped, 1);

  const after = (await domain().getCase(kase.id))!;
  assert.equal(after.stage, "booked");
  assert.ok((after.data as Record<string, unknown>).booked_at, "when they booked is recorded");
  assert.equal((after.data as Record<string, unknown>).has_reply, true);

  // The booked branch must not have cost us the attribution — that is the whole point of the file.
  const rows = await outcomes(project);
  assert.equal(rows.filter((o) => o.kind === "gtm_next_touch").length, 1);
});

test("looksLikeBooking fails closed: a negated booking word is a reply, not a meeting", () => {
  /**
   * THE BUG. The phrase list contains a bare `booked`, and "not booked yet" matches it. That error
   * is not symmetric: a false `booked` tells the founder a meeting exists that does not, and they
   * never prepare for it because nothing ever said to. A false `replied` costs nothing — a human
   * reads the message either way. So anything ambiguous fails toward `replied`.
   */
  assert.equal(looksLikeBooking("not booked yet, but interested"), false);
  assert.equal(looksLikeBooking("I haven't booked anything — send me times?"), false);
  assert.equal(looksLikeBooking("can we get booked in sometime next month?"), false);
  assert.equal(looksLikeBooking("when we have booked something I'll confirm"), false);
  assert.equal(looksLikeBooking("I'd like to book a call"), false);
  assert.equal(looksLikeBooking(undefined), false);
  assert.equal(looksLikeBooking("  "), false);
  assert.equal(looksLikeBooking("thanks, interesting — tell me more"), false);

  assert.equal(looksLikeBooking("booked a call for Thursday"), true);
  assert.equal(looksLikeBooking("booking confirmed, see you then"), true);
  assert.equal(looksLikeBooking("scheduled a meeting with you"), true);
  assert.equal(looksLikeBooking("see you on Tuesday"), true);
  assert.equal(looksLikeBooking("https://cal.com/dana/intro works for me"), true);
});

test("noteInboundReplies refuses an unscoped read rather than seeing every tenant's cases", async () => {
  await assert.rejects(
    () => noteInboundReplies(domain(), { id: "conn-x", project_id: "" }, [
      { thread_id: "t", from: { id: "someone" } },
    ]),
    /project/,
  );
});
