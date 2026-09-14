import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ONLY_IN_MONOREPO, inMonorepo } from "./_monorepo";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * ONE INGREDIENT, MORE THAN ONE WAY TO HAND IT OVER
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * What a bookkeeping engagement needs is "your March bank statement". Xero is one way to get it and
 * it was the ONLY way the portal offered. If the client's bookkeeper holds the login, or their
 * finance policy forbids third-party OAuth, or the integration named on the row does not exist —
 * which a drafted service could produce until the catalogue check went in — the engagement stopped
 * there, with no other move available to the person looking at it.
 *
 * Production, fourteen days: 1,924 artifacts asking for inputs against 138 that are work. A run
 * without its ingredients writes down what it needed and succeeds, every time, forever.
 *
 * Asserted on source rather than by running kickoff, which needs a store, a channel, a case and a
 * client. What is pinned is the property that was missing, and it was missing because of statement
 * ORDER — which is exactly the kind of thing that comes back.
 */
const KICKOFF = readFileSync(join(import.meta.dirname, "..", "src", "kickoff.ts"), "utf8");
/**
 * The console's portal page, which is NOT in the published kernel.
 *
 * Read lazily and tolerantly, and that is load-bearing rather than defensive. As a top-level
 * `readFileSync` this threw at IMPORT time in a published clone — before any test ran — so the whole
 * file failed and a per-test `skip` could not help. It is the one failure of this kind that a
 * skip option cannot fix, because the module never finishes loading to be skipped.
 *
 * The three tests that read it are gated on `inMonorepo()`, so outside the monorepo they are skipped
 * with a reason and this string is never consulted.
 */
const BLOCKED = inMonorepo()
  ? readFileSync(join(import.meta.dirname, "..", "..", "..", "cloud", "app", "portal", "blocked.tsx"), "utf8")
  : "";

test("a connection ask carries a thread, so a file has somewhere to land", () => {
  const connLoop = KICKOFF.slice(
    KICKOFF.indexOf("② Connection invites"),
    KICKOFF.indexOf("③ Intake asks"),
  );
  assert.ok(connLoop.length > 100, "the connection loop moved — this test is reading the wrong slice");
  assert.match(
    connLoop,
    /thread_id: kickoffThreadId/,
    "connection asks have no thread again, so the portal can only offer the button",
  );
});

test("the thread is created before BOTH loops, not between them", () => {
  // The original bug was pure ordering: the thread was ensured after the connection loop, so only
  // intake asks got one. Position is the property, so position is what is asserted.
  const threadAt = KICKOFF.indexOf("let kickoffThreadId");
  const connAt = KICKOFF.indexOf("② Connection invites");
  const intakeAt = KICKOFF.indexOf("③ Intake asks");
  assert.ok(threadAt > 0 && connAt > 0 && intakeAt > 0, "the kickoff sections were renamed");
  assert.ok(threadAt < connAt, "the thread is ensured after the connection loop again");
  assert.ok(connAt < intakeAt, "the loops swapped order");
});

test("the portal offers the second path, and only when a file can actually land", { skip: inMonorepo() ? false : ONLY_IN_MONOREPO }, () => {
  const conn = BLOCKED.slice(BLOCKED.indexOf("function ConnectionAsk"), BLOCKED.indexOf("function TypedAsk"));
  assert.match(conn, /Or send it to us instead/, "the fallback path is gone from the connection row");
  /**
   * ═══ THIS ASSERTION USED TO REQUIRE THE OPPOSITE, AND ITS REASON EXPIRED ═══
   *
   * It read `/request\.thread_id &&/` — "with no thread the upload has nowhere to go and fails" —
   * which was true when `onFiles` posted only to `[thread]/attachments`. It stopped being true when
   * `portal/requests/[request]/attachments` was added, a door keyed on the REQUEST, which always
   * exists. That route's own header says why it was built: "thread_id is null on every ask the
   * product has ever written ... a client saw the question, a textarea and a Send button, and no way
   * to attach the one thing being asked for."
   *
   * So the gate stopped protecting anything and started removing the only second move a client had.
   * Live case, not hypothetical: AgentMail caps this account at three inboxes, all three are taken,
   * and every engagement opened since raises its asks with `thread_id` null. A client who cannot
   * complete the OAuth had one button that could not work for them and nothing else.
   */
  assert.ok(
    !/\{request\.thread_id && !waiting && \(/.test(conn),
    "the fallback is gated on a thread again, so a client with no mailbox behind them has one dead button",
  );
  assert.match(conn, /\{!waiting && \(/, "the fallback lost its waiting guard");
  assert.match(conn, /<TypedAsk request=\{request\} now=\{now\} bare \/>/, "it no longer reuses the real responder");
});

test("the second path is secondary, never a competing primary", { skip: inMonorepo() ? false : ONLY_IN_MONOREPO }, () => {
  /**
   * Connecting is better for everyone — one click, and it keeps working next month. Two
   * equally-weighted choices is how a portal starts feeling like a form, so the fallback is a text
   * button that swaps the row rather than a second `<Button>` beside the first.
   */
  const conn = BLOCKED.slice(BLOCKED.indexOf("function ConnectionAsk"), BLOCKED.indexOf("function TypedAsk"));
  assert.equal(
    (conn.match(/<Button\b/g) ?? []).length,
    1,
    "there is more than one Button in the connection row — the client now has two primaries",
  );
});

test("the nested responder drops its own chrome", { skip: inMonorepo() ? false : ONLY_IN_MONOREPO }, () => {
  // Rendered inside a card that has already shown the icon, the question and the due date. Repeating
  // them is how one request comes to look like two.
  const typed = BLOCKED.slice(BLOCKED.indexOf("function TypedAsk"), BLOCKED.indexOf("function SignOff"));
  assert.match(typed, /bare \? "" : "rounded-md border/, "the bare form still draws a card inside a card");
  assert.match(typed, /\{!bare && \(/, "the bare form restates the question it is nested under");
});
