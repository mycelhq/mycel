// SUPPORT COMES BEFORE THE INVITE, OR IT IS NOT WORTH ANYTHING.
//
// `supported` sits ahead of `invited` in the funnel on purpose: Product Hunt makers reciprocate,
// and "I left a note on your launch" is a reason to accept where a bare request is not. Soliciting
// upvotes for your own launch gets it delisted; supporting someone else's does not.
//
// The track shipped in the web CRM and `rally work` never had it — so the terminal, which is where
// the invitations actually get sent from, skipped the whole play and sent a cold invite instead.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addSeat, funnel, open, seats, upsertTarget, type Seat } from "../src/store";
import { supportable, workSeat } from "../src/work";

const db = () => open(join(mkdtempSync(join(tmpdir(), "rally-")), "t.db"));

/** One target, with the launch age the ranking would have written into `why`. */
const target = (d: ReturnType<typeof db>, key: string, why: string, productUrl: string | null) => {
  upsertTarget(d, {
    personKey: key,
    name: key,
    headline: null,
    linkedinUrl: `https://linkedin.com/in/${key}/`,
    why,
    productUrl,
    priority: 50,
  });
  d.prepare(`UPDATE targets SET seat = 'me' WHERE person_key = ?`).run(key);
};

const seatOf = (d: ReturnType<typeof db>): Seat => seats(d).find((s) => s.name === "me")!;

test("a launch from the last three days is supportable; an old one is not", () => {
  const t = (why: string, url: string | null) =>
    supportable({ why, productUrl: url } as never);
  assert.equal(t("maker · launched today", "https://ph/x"), true);
  assert.equal(t("maker · launched 2d ago", "https://ph/x"), true);
  assert.equal(t("maker · launched 3d ago", "https://ph/x"), true);
  // Six weeks on, a comment is seen by nobody and reads as research rather than support.
  assert.equal(t("maker · launched 28d ago", "https://ph/x"), false);
  // No launch page means there is nothing to open, whatever the age says.
  assert.equal(t("maker · launched today", null), false);
  assert.equal(t("maker", "https://ph/x"), false);
});

test("their launch is opened BEFORE their profile, and the support is recorded", async () => {
  const d = db();
  addSeat(d, "me");
  target(d, "fresh", "maker · launched today", "https://producthunt.com/posts/fresh");

  const opened: string[] = [];
  await workSeat(d, seatOf(d), {
    ask: async () => "",
    open: (u: string) => opened.push(u),
  } as never);

  assert.deepEqual(
    opened,
    ["https://producthunt.com/posts/fresh", "https://linkedin.com/in/fresh/"],
    "the launch must be opened first — supporting after the invite is not reciprocity",
  );
  const f = funnel(d, "me");
  assert.equal(f.supported, 1, "the support was not recorded");
  assert.equal(f.invited, 1, "they were still invited in the same sitting");
});

test("a stale launch is never offered — straight to the invite, one window", async () => {
  const d = db();
  addSeat(d, "me");
  target(d, "stale", "maker · launched 28d ago", "https://producthunt.com/posts/stale");

  const opened: string[] = [];
  await workSeat(d, seatOf(d), { ask: async () => "", open: (u: string) => opened.push(u) } as never);

  assert.deepEqual(opened, ["https://linkedin.com/in/stale/"]);
  assert.equal(funnel(d, "me").supported, 0);
  assert.equal(funnel(d, "me").invited, 1);
});

test("'n' invites without claiming support, so the record never says we commented when we did not", async () => {
  const d = db();
  addSeat(d, "me");
  target(d, "fresh", "maker · launched 1d ago", "https://producthunt.com/posts/fresh");

  const answers = ["n", ""];
  let i = 0;
  await workSeat(d, seatOf(d), { ask: async () => answers[i++] ?? "", open: () => {} } as never);

  const f = funnel(d, "me");
  assert.equal(f.supported, 0, "we did not comment, so nothing may claim we did");
  assert.equal(f.invited, 1);
});

test("skipping at the launch step does not then invite them anyway", async () => {
  const d = db();
  addSeat(d, "me");
  target(d, "fresh", "maker · launched today", "https://producthunt.com/posts/fresh");

  await workSeat(d, seatOf(d), { ask: async () => "s", open: () => {} } as never);

  const f = funnel(d, "me");
  assert.equal(f.invited, 0, "a skip at the launch step fell through to the invite");
  assert.equal(f.supported, 0);
});
