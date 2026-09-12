// The proposer proposes only what was actually earned, and nothing it proposes is authority.
//
// Every test here is named for the way this feature would rot if unpinned. The module's job is to
// reduce approval fatigue WITHOUT weakening the gate, so the failure modes worth pinning are the
// ones where it either nags (suggests what is covered, suggests off thin evidence) or flatters
// (counts the policy engine's own output, shrugs off an edit, proposes past a high-risk row).

import { test } from "node:test";
import assert from "node:assert/strict";
import type { DecidedApproval } from "../src/store";
import type { StandingGrant } from "../src/standing";
import { HARD_MAX_USES_PER_DAY } from "../src/standing";
import { MIN_STREAK, suggestStandingGrants } from "../src/standing-suggest";

const NOW = new Date("2026-08-28T12:00:00Z");

/** N decided rows, newest first, one per day ending yesterday. */
function run(
  n: number,
  over: Partial<DecidedApproval> = {},
  startDaysAgo = 1,
): DecidedApproval[] {
  return Array.from({ length: n }, (_, i) => ({
    action: "email:send_email",
    risk: "medium" as const,
    status: "approved" as const,
    edited: false,
    decided_at: new Date(NOW.getTime() - (startDaysAgo + i) * 86_400_000).toISOString(),
    client_id: "cl_1",
    wedge: "invoice-chaser",
    task_type: "chase",
    ...over,
  }));
}

const grant = (over: Partial<StandingGrant> = {}): StandingGrant =>
  ({
    v: 1,
    id: "g1",
    action: "email:send_email",
    client_id: "cl_1",
    max_uses_per_day: 5,
    by: "member_1",
    created_at: "2026-08-01T00:00:00.000Z",
    expires_at: "2026-11-01T00:00:00.000Z",
    reason: "weekly update",
    ...over,
  }) as unknown as StandingGrant;

test("eight untouched approvals in a row earn a suggestion; seven do not", () => {
  assert.equal(suggestStandingGrants(run(MIN_STREAK), [], NOW).length, 1);
  assert.equal(suggestStandingGrants(run(MIN_STREAK - 1), [], NOW).length, 0);
});

test("an EDITED approval is a no-vote: it breaks the streak even when the total is high", () => {
  // 12 approvals, but the 3rd-newest was edited — the founder is still doing the agent's work.
  const rows = run(12);
  rows[2] = { ...rows[2]!, edited: true };
  assert.equal(suggestStandingGrants(rows, [], NOW).length, 0);
});

test("a rejection breaks the streak the same way", () => {
  const rows = run(12);
  rows[4] = { ...rows[4]!, status: "rejected" };
  assert.equal(suggestStandingGrants(rows, [], NOW).length, 0);
});

test("old rejections do not block forever — a fresh unbroken run outweighs them", () => {
  // A rejection 20 rows back, then MIN_STREAK clean ones since. The founder changed their mind;
  // the suggester must notice, and must SAY so in the evidence rather than hiding it.
  const rows = [...run(MIN_STREAK), ...run(1, { status: "rejected" }, MIN_STREAK + 1)];
  const out = suggestStandingGrants(rows, [], NOW);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.evidence.rejected, 1);
  assert.match(out[0]!.because, /1 rejected/);
});

test("one high-risk row in the window kills the suggestion for that pair", () => {
  const rows = run(12);
  rows[10] = { ...rows[10]!, risk: "high" };
  assert.equal(suggestStandingGrants(rows, [], NOW).length, 0);
});

test("a live grant covering the pair silences it; an expired one does not", () => {
  assert.equal(suggestStandingGrants(run(10), [grant()], NOW).length, 0);
  const expired = grant({ expires_at: "2026-08-01T00:00:00.000Z" } as Partial<StandingGrant>);
  assert.equal(suggestStandingGrants(run(10), [expired], NOW).length, 1);
});

test("an all-clients grant for the action silences every client's suggestion", () => {
  const wide = grant({ client_id: undefined } as Partial<StandingGrant>);
  assert.equal(suggestStandingGrants(run(10), [wide], NOW).length, 0);
});

test("no client, no suggestion — the machine never proposes the all-clients form", () => {
  assert.equal(suggestStandingGrants(run(10, { client_id: undefined }), [], NOW).length, 0);
});

test("the ceiling tracks observed volume and is clamped to the hand-written maximum", () => {
  // 30 approvals on one day: observed busiest day 30 → 45 with headroom → clamped to 20.
  const sameDay = run(30).map((r) => ({ ...r, decided_at: "2026-08-27T10:00:00.000Z" }));
  const out = suggestStandingGrants(sameDay, [], NOW);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.max_uses_per_day, HARD_MAX_USES_PER_DAY);
  // One a day → busiest day 1 → ceiling 2: room for an ordinary Tuesday, no more.
  assert.equal(suggestStandingGrants(run(10), [], NOW)[0]!.max_uses_per_day, 2);
});

test("groups are per (action, client): a streak split across clients earns nothing", () => {
  const rows = [...run(5), ...run(5, { client_id: "cl_2" }, 6)];
  assert.equal(suggestStandingGrants(rows, [], NOW).length, 0);
});

test("suggestions rank by streak — the heaviest attention-tax first", () => {
  const rows = [...run(9), ...run(14, { action: "portal:publish_update", client_id: "cl_2" }, 10)];
  const out = suggestStandingGrants(rows, [], NOW);
  assert.deepEqual(
    out.map((s) => s.action),
    ["portal:publish_update", "email:send_email"],
  );
});
