// TELLING A FOUNDER THEIR CLIENT ACCEPTED THE WORK.
//
// A client accepting a deliverable is the single instant where the product most obviously earned its
// fee: an agent did the work, a human checked it, and a third party signed it off. Everything
// already happened on that transition — timeline note, case stamp, skill verdict, the wait that
// drafts the invoice — and the founder found out by opening the app.
//
// The pattern is `linkedin-alerts.ts`'s: the kernel does not send mail, and an in-process "have we
// told them" flag dies with the process. So the durable stamp IS the queue, and here it costs no new
// table — `accepted_at` already exists, and a deliverable with one and no `founder_notified_at` is a
// founder who has not been told.
import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryDeliverableStore } from "../src/deliverables";

async function accepted(store: InMemoryDeliverableStore, id: string, at: string) {
  const d = await store.createDeliverable({
    project_id: "p1", case_id: "c1", client_id: "cl1", title: `Work ${id}`, kind: "document",
  } as any);
  await store.transitionDeliverable("p1", d.id, "accepted", [d.status], at, { accepted_at: at });
  return d.id;
}

test("markFounderNotified is the claim: exactly one caller wins", async () => {
  const store = new InMemoryDeliverableStore();
  const id = await accepted(store, "a", new Date().toISOString());

  const first = await store.markFounderNotified("p1", id, new Date().toISOString());
  assert.equal(first, true, "the first drain takes it");

  // Two cron replicas can drain the same list. The loser must LEARN it lost, or both send.
  const second = await store.markFounderNotified("p1", id, new Date().toISOString());
  assert.equal(second, false, "a second drain must not send a second mail");
});

test("markFounderNotified refuses another tenant's deliverable", async () => {
  const store = new InMemoryDeliverableStore();
  const id = await accepted(store, "b", new Date().toISOString());
  assert.equal(await store.markFounderNotified("p2", id, new Date().toISOString()), false);
  // And the real owner can still claim it — the refusal must not have consumed anything.
  assert.equal(await store.markFounderNotified("p1", id, new Date().toISOString()), true);
});

test("markFounderNotified refuses a deliverable that was never accepted", async () => {
  const store = new InMemoryDeliverableStore();
  const d = await store.createDeliverable({
    project_id: "p1", case_id: "c1", client_id: "cl1", title: "Draft", kind: "document",
  } as any);
  // "Your client accepted this" about something nobody accepted is the worst possible false
  // positive for this particular email.
  assert.equal(await store.markFounderNotified("p1", d.id, new Date().toISOString()), false);
});

test("markFounderNotified refuses an unknown id rather than throwing", async () => {
  const store = new InMemoryDeliverableStore();
  // The drain marks whatever the list gave it; a row deleted in between must be a quiet false, not
  // a 500 that strands every remaining alert in the same batch.
  assert.equal(await store.markFounderNotified("p1", "nope", new Date().toISOString()), false);
});
