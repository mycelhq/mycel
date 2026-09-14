/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * FIFTY-FOUR QUESTIONS ASKED OF CLIENTS WHO WERE NEVER ASKED ANYTHING
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Measured in production, 12 September:
 *
 *   · 54 client requests raised since 13 August. `thread_id` NULL on every one. Zero answered.
 *   · 1,470 runs ended in `ask` — the run correctly saying it cannot finish without something only
 *     the client has.
 *   · 1,950 `monthly_close` runs produced an artifact. 21 deliverables exist in the whole system,
 *     14 of them seeded into the demo.
 *   · One project in the entire system holds a channel, and it is the QA walkthrough.
 *
 * The fulfilment loop does not stall on deliverable quality. It stalls because the client is never
 * asked, so the run re-runs tomorrow and asks again, for ever.
 *
 * ═══ WHY HERE AND NOT AT ENGAGEMENT OPEN ═══
 *
 * `mailbox-ensure.ts` exists for exactly this and is wired to engagement open, whose header argues
 * that opening is "the first moment the address is certainly needed". That is true, and it is too
 * late for a business whose engagements were opened before it shipped — 16 engagements opened in
 * five weeks, and the backfill it promises only reaches a project whose NEXT engagement opens.
 *
 * Raising an ask is a more certain moment than opening. An engagement might need nothing from the
 * client; this run has already discovered that it does.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/orchestrator.ts", import.meta.url), "utf8");
const code = src
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
  .replace(/^\s*\/\/.*$/gm, "");

/** The function that turns a run's `needs` into questions for a client. */
const fn = (() => {
  const start = code.indexOf("async function openMaterialRequests");
  const end = code.indexOf("\n/**", start);
  return code.slice(start, end === -1 ? code.length : end);
})();

test("THE ADDRESS IS ENSURED BEFORE THE QUESTION IS WRITTEN", () => {
  assert.match(fn, /await ensureProjectMailbox\(\{/, "an ask is still created with nowhere to send it");
  const ensureAt = fn.indexOf("ensureProjectMailbox");
  const createAt = fn.indexOf("requests.createRequest");
  assert.ok(ensureAt > 0 && createAt > 0, "one of the two anchors moved");
  assert.ok(ensureAt < createAt, "the mailbox is ensured after the request is already written");
});

test("ONLY WHEN THERE IS SOMETHING TO ASK", () => {
  /**
   * An inbox is a real cost on an account with a quota. A run that needs nothing, or whose needs
   * are all duplicates of questions already open, must not mint one — which is the same argument
   * `mailbox-ensure.ts` makes against provisioning at signup.
   */
  assert.match(fn, /if \(toOpen\.length > 0 && task\.wedge\)/, "it provisions for a run with nothing to ask");
});

test("IT CANNOT BE THE THING THAT FAILS THE RUN", () => {
  /**
   * A request answerable in the portal beats no request at all. The whole point of the module's
   * "never fatal" rule is that an address is worth less than the work, and this call site inherits
   * it — the `.catch` turns a throw into a reason rather than losing the ask entirely.
   */
  assert.match(fn, /\.catch\(\(e: unknown\) => \(\{ ok: false as const, reason: String\(e\) \}\)\)/);
  // And the surrounding try/catch still stands, so nothing here can fail the run.
  assert.match(fn, /\} catch \(e\) \{[\s\S]*?could not open material requests/);
});

test("and the failure is loud, because the silent version is what happened", () => {
  assert.match(fn, /console\.warn/, "a project that cannot ask anybody says nothing about it");
  assert.match(fn, /is about to ask a client and has no mailbox/, "the log does not say what went wrong");
});

test("the call is keyed on this run's own facts", () => {
  // `task_type` here IS the production type — this run is the work. No second lookup to disagree
  // with, which is what `productionTaskType` exists to resolve at engagement open where there is no
  // run yet.
  assert.match(fn, /project_id: task\.project_id/);
  assert.match(fn, /wedge: task\.wedge/);
  assert.match(fn, /task_type: task\.task_type/);
});

/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * AND THE ADDRESS WAS POINTLESS WITHOUT A THREAD
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Ensuring a mailbox is HALF a fix, and shipping only that half would have looked like a closed loop
 * while changing nothing — which is why this was checked rather than assumed.
 *
 * `kickoff.ts` already does it properly: find the project's channel, open a thread, put `thread_id`
 * on every request it raises. Its own note says why — `blocked.tsx` shows the client an uploader
 * only when that field is set, so a request without one "can offer the client nothing but the
 * button".
 *
 * The run path never did. All 54 production requests carry `thread_id` null, and 1,470 runs ended in
 * an ask. A mailbox with no thread on the request changes neither number.
 */
test("A RUN'S ASK CARRIES A THREAD, LIKE KICKOFF'S DOES", () => {
  assert.match(fn, /askThreadId/, "the ask still has no conversation to live in");
  assert.match(fn, /findOrCreateThread\(/, "no thread is opened for the ask");
  assert.match(fn, /\.\.\.\(askThreadId \? \{ thread_id: askThreadId \} : \{\}\)/, "the thread is opened and then dropped");
});

test("the thread is opened AFTER the mailbox is ensured", () => {
  /**
   * Order is the whole thing: `listChannels` returns nothing until the mailbox exists, so opening
   * the thread first would find no channel on exactly the projects this is meant to rescue.
   */
  const ensureAt = fn.indexOf("ensureProjectMailbox");
  const threadAt = fn.indexOf("findOrCreateThread");
  const createAt = fn.indexOf("requests.createRequest");
  assert.ok(ensureAt > 0 && threadAt > 0 && createAt > 0, "an anchor moved");
  assert.ok(ensureAt < threadAt, "the thread is opened before there is an address to open it on");
  assert.ok(threadAt < createAt, "the request is written before the thread exists");
});

test("it is scoped to this project's channels", () => {
  // A channel belonging to another tenant would put this business's question in someone else's
  // conversation. Same filter kickoff uses, deliberately.
  assert.match(fn, /!ch\.project_id \|\| ch\.project_id === task\.project_id/, "channels are not tenant-scoped");
});

test("and a thread that cannot be opened does not lose the ask", () => {
  /**
   * A request the client can at least see in the portal beats no request at all. So the thread
   * attempt has its own catch and the ask is still written without it — degrading to exactly
   * today's behaviour rather than to nothing.
   */
  const block = fn.slice(fn.indexOf("let askThreadId"), fn.indexOf("for (const ask of toOpen)"));
  assert.match(block, /\} catch \(e\) \{[\s\S]*?could not open a thread for a client ask/);
});
