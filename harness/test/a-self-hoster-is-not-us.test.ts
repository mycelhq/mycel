/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * A DEFAULT THAT IS RIGHT FOR THE VENDOR AND SILENTLY WRONG FOR EVERYBODY ELSE
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `internal-sender.ts` exists because of a real bug: a founder opened their Clients room and found
 * "Mycel Go-to-Market" listed as a customer, because `acceptIntake` files a client for whoever sent
 * the mail and had no notion that some senders are the platform itself.
 *
 * The fix named two mailboxes as literals — ours. This kernel is Apache-2.0 and meant to be
 * self-hosted, so for everyone who clones it the fix is inverted: their kernel carefully ignores mail
 * from OUR addresses, and their own ops mailbox has no way to be named, so it becomes a client in
 * their CRM. The exact bug, reproduced for every user except us.
 *
 * That is the shape of hardcoding worth hunting. It never fails here, so nothing ever reports it, and
 * the test suite is green because the suite runs on the vendor's assumptions too.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isPlatformAddress } from "../src/internal-sender";

const withEnv = (vars: Record<string, string | undefined>, fn: () => void) => {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fn();
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};

test("unset, the hosted product behaves exactly as before", () => {
  withEnv({ MYCEL_PLATFORM_DOMAINS: undefined, MYCEL_PLATFORM_ADDRESSES: undefined }, () => {
    assert.equal(isPlatformAddress("gotomarket@agentmail.to"), true);
    assert.equal(isPlatformAddress("Mycel <mycel@agentmail.to>"), true);
    assert.equal(isPlatformAddress("anyone@mycelai.dev"), true);
    // A tenant's own desk on the same domain is NOT the platform — see the note in the module about
    // why there is no `@agentmail.to` rule and must never be one.
    assert.equal(isPlatformAddress("qa-walkthrough-desk@agentmail.to"), false);
  });
});

test("A SELF-HOSTER CAN NAME THEIR OWN PLATFORM, AND STOPS INHERITING OURS", () => {
  withEnv(
    { MYCEL_PLATFORM_DOMAINS: "acme-ops.example", MYCEL_PLATFORM_ADDRESSES: "robot@acme.example" },
    () => {
      assert.equal(isPlatformAddress("noreply@acme-ops.example"), true, "their own domain is not machinery");
      assert.equal(isPlatformAddress("robot@acme.example"), true, "their own ops mailbox is not machinery");
      // And ours stop mattering on their box. A client of theirs who happens to mail from a Mycel
      // address is a client, not our machinery.
      assert.equal(isPlatformAddress("gotomarket@agentmail.to"), false);
      assert.equal(isPlatformAddress("someone@mycelai.dev"), false);
    },
  );
});

test("the env is read per call, not frozen at import", () => {
  // A module-level `const` is decided by whichever module loaded first, which makes this unsettable
  // by anything that configures the kernel after boot — and untestable without a fresh process.
  withEnv({ MYCEL_PLATFORM_DOMAINS: "first.example" }, () => {
    assert.equal(isPlatformAddress("a@first.example"), true);
  });
  withEnv({ MYCEL_PLATFORM_DOMAINS: "second.example" }, () => {
    assert.equal(isPlatformAddress("a@first.example"), false);
    assert.equal(isPlatformAddress("a@second.example"), true);
  });
});

test("SET-BUT-EMPTY MEANS NONE; ONLY UNSET FALLS BACK", () => {
  /*
    Falling back on an empty value would ignore a deliberate instruction. "I named none" is also the
    safe direction: nothing is treated as machinery, so a real sender is filed as a client — which is
    recoverable — rather than a real client being discarded as machinery, which is not.
  */
  // All four spellings of "none" must agree. The first version read `VAR="  "` as unset and
  // `VAR=" , ,"` as empty, so the same intent gave opposite answers depending on how it was typed.
  for (const none of ["", "  ", ",", " , ,"]) {
    withEnv({ MYCEL_PLATFORM_DOMAINS: none, MYCEL_PLATFORM_ADDRESSES: none }, () => {
      assert.equal(isPlatformAddress("gotomarket@agentmail.to"), false, `"${none}" restored our defaults`);
      assert.equal(isPlatformAddress("someone@mycelai.dev"), false, `"${none}" restored our defaults`);
    });
  }
});

test("case and plus-addressing still normalise", () => {
  withEnv({ MYCEL_PLATFORM_ADDRESSES: "Robot@Acme.Example" }, () => {
    assert.equal(isPlatformAddress("robot@acme.example"), true);
    // Plus-addressing is how a self-loop disguises itself: the desk replies from `desk+case123@…`.
    assert.equal(isPlatformAddress("robot+case123@acme.example"), true);
  });
});

test("a caller-supplied address still wins, whatever the env says", () => {
  // `extra` is how a project's OWN desk address is excluded — a message from your own desk is a loop,
  // and filing it as a client makes the business a customer of itself.
  withEnv({ MYCEL_PLATFORM_DOMAINS: undefined, MYCEL_PLATFORM_ADDRESSES: undefined }, () => {
    assert.equal(isPlatformAddress("desk@agentmail.to", ["desk@agentmail.to"]), true);
    assert.equal(isPlatformAddress("desk+case1@agentmail.to", ["desk@agentmail.to"]), true);
    assert.equal(isPlatformAddress("real-client@acme.example", ["desk@agentmail.to"]), false);
  });
});
