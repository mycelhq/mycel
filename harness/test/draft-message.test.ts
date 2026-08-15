// "Draft for me" — the one model call that opens a campaign. No network: `complete` is injected,
// the same way ask.ts and generateCreative are driven in their tests.
//
// What matters here is the degradation contract the composer leans on: a usable short line comes
// back trimmed, an over-long line is clipped to the cap, and every failure mode (no org, model
// returns nothing) becomes `undefined` so the founder falls back to writing their own.
import { test } from "node:test";
import assert from "node:assert/strict";
import { draftFirstMessage, MAX_FIRST_MESSAGE } from "../src/gtm/draft-message";

const args = {
  orgId: "org_1",
  audience: "Heads of finance at UK agencies",
  sells: "automated invoice chasing for agencies",
  sells_to: "agency owners",
  name: "Ledgerly",
};

test("a valid short message is returned and trimmed", async () => {
  const complete = async () => "  Saw you run finance at an agency — we take the invoice chasing off your desk.  ";
  const msg = await draftFirstMessage({ ...args, complete });
  assert.equal(msg, "Saw you run finance at an agency — we take the invoice chasing off your desk.");
});

test("over-long output is clipped to the cap", async () => {
  const long = "x".repeat(MAX_FIRST_MESSAGE + 200);
  const msg = await draftFirstMessage({ ...args, complete: async () => long });
  assert.ok(msg);
  assert.ok(msg.length <= MAX_FIRST_MESSAGE, `expected <= ${MAX_FIRST_MESSAGE}, got ${msg.length}`);
  assert.ok(msg.endsWith("…"));
});

test("a fenced / quoted single line is unwrapped", async () => {
  const msg = await draftFirstMessage({ ...args, complete: async () => '```\n"Hi {first_name}, quick note."\n```' });
  assert.equal(msg, "Hi {first_name}, quick note.");
});

test("model returning undefined yields undefined (fallback)", async () => {
  const msg = await draftFirstMessage({ ...args, complete: async () => undefined });
  assert.equal(msg, undefined);
});

test("empty model output yields undefined", async () => {
  const msg = await draftFirstMessage({ ...args, complete: async () => "   " });
  assert.equal(msg, undefined);
});

test("no org yields undefined without calling the model", async () => {
  let called = false;
  const msg = await draftFirstMessage({
    ...args,
    orgId: undefined,
    complete: async () => {
      called = true;
      return "should not run";
    },
  });
  assert.equal(msg, undefined);
  assert.equal(called, false);
});

test("nothing to ground on (no offer, no audience) yields undefined without calling the model", async () => {
  let called = false;
  const msg = await draftFirstMessage({
    orgId: "org_1",
    complete: async () => {
      called = true;
      return "blank template";
    },
  });
  assert.equal(msg, undefined);
  assert.equal(called, false);
});
