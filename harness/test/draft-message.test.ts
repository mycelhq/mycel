// "Draft for me" — the one model call that opens a campaign. No network: `complete` is injected,
// the same way ask.ts and generateCreative are driven in their tests.
//
// What matters here is the degradation contract the composer leans on: a usable short line comes
// back trimmed, an over-long line is clipped to the cap, and every failure mode (no org, model
// returns nothing) becomes `undefined` so the founder falls back to writing their own.
import { test } from "node:test";
import assert from "node:assert/strict";
import { draftFirstMessage, draftPerProspect, MAX_FIRST_MESSAGE } from "../src/gtm/draft-message";

const args = {
  orgId: "org_1",
  audience: "Heads of finance at UK agencies",
  sells: "automated invoice chasing for agencies",
  sells_to: "agency owners",
  name: "Ledgerly",
};

test("a valid short message is returned and trimmed", async () => {
  // The em dash this fixture used to carry is now refused by the shared copy gate (see
  // @mycel/gtm-math: "em/en dashes read as machine-written"). The point of THIS test is the
  // trimming, so the fixture drops the tell; the refusal has its own test below.
  const complete = async () => "  Saw you run finance at an agency. We take the invoice chasing off your desk.  ";
  const msg = await draftFirstMessage({ ...args, complete });
  assert.equal(msg, "Saw you run finance at an agency. We take the invoice chasing off your desk.");
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

// ── PER-PERSON COPY ────────────────────────────────────────────────────────────────────────────
// The difference the whole composer exists to make: `draftPerProspect` writes a DISTINCT line per
// prospect grounded in that person's own world, not one opener pasted onto everyone. These drive it
// with an injected `complete` that echoes back who it was asked about, so the test can prove two
// prospects got different words and that the founder's typed line was used as guidance, not sent.
test("two prospects get DIFFERENT copy, each about the person it was written for", async () => {
  const complete = async ({ user }: { user: string }) => {
    const name = /Their name: (.+)/.exec(user)?.[1] ?? "there";
    const company = /Their company: (.+)/.exec(user)?.[1] ?? "your company";
    return `Hi ${name}, saw your work at ${company} — quick note.`;
  };
  const drafts = await draftPerProspect({
    orgId: "org_1",
    sells: "automated invoice chasing for agencies",
    goal: "Book intro calls with heads of finance",
    prospects: [
      { profile_id: "dana-okafor", name: "Dana Okafor", company: "Brightline" },
      { profile_id: "sam-rivers", name: "Sam Rivers", company: "Atlas Media" },
    ],
    complete,
  });
  assert.equal(drafts.length, 2);
  assert.equal(drafts[0].profile_id, "dana-okafor");
  assert.match(drafts[0].message!, /Dana Okafor/);
  assert.match(drafts[0].message!, /Brightline/);
  assert.match(drafts[1].message!, /Sam Rivers/);
  assert.match(drafts[1].message!, /Atlas Media/);
  assert.notEqual(drafts[0].message, drafts[1].message, "the whole point: not one shared string");
});

test("the founder's typed line is GUIDANCE, not the copy — it reaches the model as intent, never verbatim", async () => {
  let seenUser = "";
  const complete = async ({ user }: { user: string }) => {
    seenUser = user;
    return "A line written about this specific person.";
  };
  await draftPerProspect({
    orgId: "org_1",
    sells: "fractional CFO work",
    goal: "PLEASE_JUST_SEND_THIS_VERBATIM",
    prospects: [{ profile_id: "x", name: "Jo", company: "Acme" }],
    complete,
  });
  assert.match(seenUser, /guidance, not words to copy/i, "the typed line is framed as intent");
  assert.match(seenUser, /PLEASE_JUST_SEND_THIS_VERBATIM/, "and passed to the model as that intent");
});

test("per-person draft degrades to no-message rows, never throwing", async () => {
  const complete = async () => undefined; // model gives nothing
  const drafts = await draftPerProspect({
    orgId: "org_1",
    sells: "x",
    prospects: [{ profile_id: "a" }, { profile_id: "b" }],
    complete,
  });
  assert.equal(drafts.length, 2);
  assert.equal(drafts[0].message, undefined);
  assert.equal(drafts[1].message, undefined);
});

test("no org, or nothing to ground on, yields an empty list without calling the model", async () => {
  let called = false;
  const complete = async () => {
    called = true;
    return "should not run";
  };
  assert.deepEqual(await draftPerProspect({ prospects: [{ profile_id: "a" }], sells: "x", complete }), []);
  assert.deepEqual(
    await draftPerProspect({ orgId: "org_1", prospects: [{ profile_id: "a" }], complete }),
    [],
    "no sells and no goal is nothing to ground on",
  );
  assert.equal(called, false);
});

// ── The gate the customer's messages never had ──────────────────────────────
//
// growth/ has refused drafts on these rules since August — 263 rejected against 200 sent in one
// week — while this path, drafting the same kind of cold message for a paying customer, had no
// check at all. The rules now live in @mycel/gtm-math and both sides import the same file.

test("a message carrying a machine tell is refused, not sent", async () => {
  // An em dash is the most reliable tell there is in a short cold message.
  const msg = await draftFirstMessage({
    ...args,
    complete: async () => "Saw you run finance at an agency \u2014 we take the invoice chasing off your desk.",
  });
  assert.equal(msg, undefined, "an unsent message costs a touch; a bad one costs the prospect");
});

test("a clean message still goes out, so the gate is not a blanket refusal", async () => {
  const msg = await draftFirstMessage({
    ...args,
    complete: async () => "Saw you run finance at an agency. Want me to take the invoice chasing off your desk?",
  });
  assert.ok(msg, "the gate must not refuse ordinary, clean copy");
});
