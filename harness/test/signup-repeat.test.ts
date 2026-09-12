// A founder submitted the same address twice, ten seconds apart, and got two confirmation emails.
// That is the visible half. The invisible half is that the landing route rate-limits per IP only,
// so an attacker rotating addresses could submit a VICTIM's inbox repeatedly and we would mail it
// every time — an email bomb with us as the amplifier, burning the sending reputation the whole
// outbound engine depends on.
//
// `recordSignupRequest` was already reading the previous row and throwing the answer away.
import { test } from "node:test";
import assert from "node:assert/strict";
import { getIdentityStore } from "../src/identity";

/**
 * The identity store is a process singleton, so tests cannot each have a fresh one. Unique
 * addresses per test are the isolation instead — which is closer to production anyway, where the
 * store is long-lived and the addresses are what differ.
 */
let n = 0;
const addr = () => `founder${n++}@acme.com`;
const store = () => getIdentityStore();
const ok = (r: unknown): r is { email: string; repeat: boolean; created_at: string; last_seen_at: string } =>
  !!r && typeof r === "object" && "email" in (r as object);

test("the FIRST request for an address is not a repeat", () => {
  const s = store();
  const A = addr();
  const r = s.recordSignupRequest({ email: A, source: "landing" });
  assert.ok(ok(r));
  assert.equal(r.repeat, false, "they asked, and they hear from us — this is the only time they did");
});

test("THE BUG: the second request for the same address IS a repeat", () => {
  const s = store();
  const A = addr();
  s.recordSignupRequest({ email: A });
  const again = s.recordSignupRequest({ email: A });
  assert.ok(ok(again));
  assert.equal(again.repeat, true, "no second confirmation — they are already in the founder's queue");
});

test("case and whitespace are the same address — the obvious way around a check", () => {
  const s = store();
  const A = addr();
  s.recordSignupRequest({ email: A });
  const shouty = s.recordSignupRequest({ email: `  ${A.toUpperCase()}  ` });
  assert.ok(ok(shouty));
  assert.equal(shouty.repeat, true);
});

test("a repeat KEEPS the original created_at and moves last_seen_at", () => {
  // The founder's queue is sorted by last-seen, so a repeat should surface the person again
  // without pretending they are a new lead.
  const s = store();
  const A = addr();
  const first = s.recordSignupRequest({ email: A });
  const second = s.recordSignupRequest({ email: A });
  assert.ok(ok(first) && ok(second));
  assert.equal(second.created_at, first.created_at, "when they first asked does not move");
  assert.ok(second.last_seen_at >= first.last_seen_at);
});

test("interest is still RECORDED on a repeat — silence is about the email, not the lead", () => {
  const s = store();
  const A = addr();
  s.recordSignupRequest({ email: A });
  s.recordSignupRequest({ email: A, about: "we run six retainers" });
  const pending = s.listSignupRequests().filter((r) => r.email === A);
  assert.equal(pending.length, 1, "one row, not two");
  assert.equal(pending[0]!.about, "we run six retainers", "the newer detail is kept");
});

test("different addresses are independent — this is not a global mute", () => {
  const s = store();
  const A = addr();
  s.recordSignupRequest({ email: A });
  const b = s.recordSignupRequest({ email: addr() });
  assert.ok(ok(b));
  assert.equal(b.repeat, false);
});

test("no time window: an address that asked a month ago is still a repeat", () => {
  // A window would be a slow-motion version of the same bomb, and the person has not been
  // forgotten — they are sitting in the queue.
  const s = store();
  const A = addr();
  const first = s.recordSignupRequest({ email: A });
  assert.ok(ok(first));
  // Reach in and age the row the way a month would.
  const aged = new Date(Date.now() - 40 * 864e5).toISOString();
  (s as unknown as { signupRequests: Map<string, { created_at: string; last_seen_at: string }> })
    .signupRequests.set(A, { ...(first as never), created_at: aged, last_seen_at: aged });
  const again = s.recordSignupRequest({ email: A });
  assert.ok(ok(again));
  assert.equal(again.repeat, true);
});
