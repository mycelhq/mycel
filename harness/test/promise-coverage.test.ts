import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { excusedFrom, readPromises } from "../src/promises";

const WEDGES = new URL("../../wedges/", import.meta.url).pathname;
const wedge = (d: string) => JSON.parse(readFileSync(`${WEDGES}${d}/wedge.json`, "utf8"));

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * THE MECHANISM THAT EXISTS FOR THIS BUG IS DECLARED ON ONE TASK TYPE
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `promises.ts` opens with a production failure: a `chase_invoice` run completed, reported success,
 * told the founder the draft would be waiting in Approvals, and created zero approvals. The module
 * is the general fix — a run's summary is a CLAIM, `approval.requested` is evidence.
 *
 * Sixty-one task types. One declares it.
 *
 * Two others say the same thing in prose and cannot be caught if they do the same thing:
 *
 *   gtm-operator/propose_campaign  "…and put ONE approval in front of the founder"
 *   gtm-operator/propose_reply     "…draft ONE follow-up DM for human approval. Nothing goes out
 *                                   until a human approves the exact words."
 *
 * ── WHY THEY ARE NOT SIMPLY DECLARED HERE, WHICH WAS THE OBVIOUS MOVE ──
 *
 * A promise FAILS a run that does not reach the gate. Neither of these has a skill file, and nothing
 * in the gtm-operator wedge references the action proxy or an approval, so whether their runs reach
 * `awaitApproval` today is unknown from the repo alone — it is a fact about production, and turning
 * on an enforcement against an unverified assumption would fail every run of both if the answer is
 * no. `promises.ts` argues exactly this about inference: "guessing here fails in the expensive
 * direction."
 *
 * So this test makes the gap VISIBLE and holds it, rather than closing it blind. It is a ratchet:
 * the number may fall and may never rise.
 *
 * TO CLOSE IT: query production for runs of either type, and check whether their event logs contain
 * `approval.requested` or `approval.resolved`. If they do, declare the promise (`propose_campaign`
 * is excused by `proposed: 0`, `propose_reply` by `drafted: false` — both now possible, see below)
 * and lower `UNDECLARED` accordingly. If they do not, the bug is already live and the promise is how
 * a founder finds out.
 */

/** Descriptions that state a human is put in front of an outward action before it happens. */
const PROMISES_A_GATE = /for human approval|approval in front of|on approval\)|until a human approves|before anything leaves/i;

/** Today's count. LOWER THIS WHEN YOU DECLARE ONE. It may never rise. */
const UNDECLARED = 2;

function undeclared(): string[] {
  const out: string[] = [];
  for (const d of readdirSync(WEDGES)) {
    let w: { task_types?: Record<string, Record<string, unknown>> };
    try { w = wedge(d); } catch { continue; }
    for (const [name, tt] of Object.entries(w.task_types ?? {})) {
      if (tt.internal === true) continue;
      if (!PROMISES_A_GATE.test(String(tt.description ?? ""))) continue;
      if (readPromises(tt.promises)) continue;
      out.push(`${d}/${name}`);
    }
  }
  return out.sort();
}

test("no NEW task type promises a human gate in prose without declaring it", () => {
  const open = undeclared();
  assert.ok(
    open.length <= UNDECLARED,
    `task types promising a gate without declaring one rose to ${open.length} (budget ${UNDECLARED}).\n` +
      `A description that says a human approves before anything leaves is a CLAIM. \`promises\` is the\n` +
      `only thing that checks it against the run's own event log — see promises.ts for the production\n` +
      `failure it was written for.\n` +
      open.map((x) => `  ${x}`).join("\n"),
  );
});

test("the one that IS declared is the one that shipped the bug", () => {
  // If this ever stops being true, the ratchet above is measuring nothing.
  const tt = wedge("invoice-chaser").task_types.chase_invoice;
  const p = readPromises(tt.promises);
  assert.ok(p?.send, "chase_invoice lost the promise it was written for");
  assert.deepEqual(p.send.unless?.step, ["hold"]);
});

test("a boolean or a number can excuse a promise, which is why only one wedge could use this", () => {
  /*
    THE REASON THE MECHANISM WAS STUCK AT ONE, and it is not that nobody got round to it.

    `excusedFrom` compared only when the run's field was a `string`. `chase_invoice` works because
    its "I decided to say nothing" signal is a string enum — `step: "hold"`. Every other candidate
    in the catalogue signals it with a boolean or a number: `drafted: false`, `proposed: 0`,
    `sent: false`. For those the comparison skipped silently, so no run could ever be excused and
    every legitimate no-op would have FAILED.

    Declaring a promise on them was therefore not merely unhelpful, it was unsafe. Widening the
    comparison is what makes the ratchet above closable at all.
  */
  assert.equal(excusedFrom({ unless: { drafted: ["false"] } }, { drafted: false }), 'it decided the right answer here was "false"');
  assert.equal(excusedFrom({ unless: { proposed: ["0"] } }, { proposed: 0 }), 'it decided the right answer here was "0"');
  // Still owed when the flag says it DID act.
  assert.equal(excusedFrom({ unless: { drafted: ["false"] } }, { drafted: true }), undefined);
  assert.equal(excusedFrom({ unless: { proposed: ["0"] } }, { proposed: 3 }), undefined);
  // The string case is unchanged — this is a widening, not a replacement.
  assert.equal(excusedFrom({ unless: { step: ["hold"] } }, { step: "hold" }), 'it decided the right answer here was "hold"');
});

test("absence is never an excuse, however the field is typed", () => {
  /*
    The swallow this module exists to close. A field the run never set is a run that did not decide,
    and "we could not tell" must not resolve to "it decided to do nothing" — that is the original bug
    wearing the fix's clothes. Widening to booleans makes this sharper, not softer: `undefined` is
    falsy and `String(undefined)` is a real string, so a careless implementation would match
    `"undefined"` against a value list and excuse a run that reported nothing at all.
  */
  for (const output of [{}, { drafted: null }, { drafted: undefined }, { drafted: {} }, { drafted: [] }]) {
    assert.equal(
      excusedFrom({ unless: { drafted: ["false"] } }, output as Record<string, unknown>),
      undefined,
      `a missing or non-scalar field excused the promise: ${JSON.stringify(output)}`,
    );
  }
  assert.equal(excusedFrom({ unless: { step: ["hold"] } }, null), undefined, "unreadable output excused the promise");

  /*
    THE CASE THAT MAKES THE TYPE GUARD LOAD-BEARING, and the first two attempts at it did not.

    Deleting the guard entirely left every assertion above still passing: `String(undefined)` is
    `"undefined"` and `String({})` is `"[object Object]"`, neither of which matches anything an author
    writes in an `unless` list. The second attempt used `{ reason: [] }` against `[""]` — `String([])`
    IS the empty string, so that should have matched — and it still passed, for a reason that turned
    out to be a second bug cancelling the first: `find` returned `""`, and the code then tested
    `if (hit)`, which is false for an empty string. Two defects hiding each other.

    `String([1])` is `"1"`. That is the discriminating case, it is truthy, and it is a real shape:
    a field that holds a count sometimes and a list sometimes. "It produced one artifact" excusing
    "it did not have to send" is the swallow this module exists to close, restored through the type
    system's back door.
  */
  assert.equal(
    excusedFrom({ unless: { proposed: ["1"] } }, { proposed: [1] }),
    undefined,
    "a one-element array coerced to a scalar and excused the promise",
  );

  /*
    AND THE SECOND BUG, now that it is not hidden. An excuse value of `""` matched and was then
    discarded as falsy, so `"unless": { "reason": [""] }` — "excused when it gave no reason" — was a
    promise that could never be kept and no author could have debugged.
  */
  assert.equal(
    excusedFrom({ unless: { reason: [""] } }, { reason: "" }),
    'it decided the right answer here was ""',
    "an empty-string excuse still silently never matches",
  );
});
