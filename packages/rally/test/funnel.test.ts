import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addSeat, funnel, open, setTargetState, upsertTarget } from "../src/store";

const db = () => open(join(mkdtempSync(join(tmpdir(), "rally-")), "t.db"));

// A person who accepts must not stop counting as invited. The first version grouped by current
// state, so two acceptances off two invitations rendered as `invited 0 · accepted 2` and
// "accepted 0% of invitations" — on the one screen read every morning to decide if this works.
test("the funnel counts cumulatively, not by current state", () => {
  const d = db();
  addSeat(d, "me");
  for (const k of ["a", "b", "c"]) {
    upsertTarget(d, { personKey: k, name: k, headline: null, linkedinUrl: `https://x/${k}` });
    d.prepare(`UPDATE targets SET seat = 'me' WHERE person_key = ?`).run(k);
  }
  setTargetState(d, "a", "invited", "invited_at");
  setTargetState(d, "b", "invited", "invited_at");
  setTargetState(d, "b", "accepted", "accepted_at");
  setTargetState(d, "b", "messaged", "messaged_at");
  setTargetState(d, "b", "replied", "replied_at");

  const f = funnel(d, "me");
  assert.equal(f.invited, 2, "b was invited even though it has since replied");
  assert.equal(f.accepted, 1);
  assert.equal(f.messaged, 1);
  assert.equal(f.replied, 1);
  assert.equal(f.queued, 1, "c was never touched");
  // The rate this makes possible is the whole reason the board exists.
  assert.equal(Math.round((f.accepted / f.invited) * 100), 50);
});
