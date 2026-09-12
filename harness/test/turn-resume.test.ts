// RESUMING A TURN — which is not retrying the task, and the difference is the whole point.
//
// `queue.ts` is `maxAttempts: 1` for a documented reason: a run past the approval gate may already
// have sent an email or moved money, so re-running the TASK could send it twice. That constraint is
// right. Resuming the turn carries on in the same session with the same context, the same executed
// tool calls and the same approval history, so nothing is replayed — it is the one recovery move
// that constraint permits, which is exactly why the classifier has to be careful.
//
// Taken from kortix-ai/suna's `turn-auto-resume.ts` — the single best idea we found reading their
// repo. Every decision below is theirs.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BACKOFF_MS,
  MAX_RESUMES,
  RESUME_WINDOW_MS,
  isTransientTurnError,
  newResumeBudget,
  nextResumeDelay,
  noteResume,
  resumePrompt,
} from "../src/turn-resume";

test("a broken pipe is worth carrying on through", () => {
  for (const e of [
    "opencode APICallError: Upstream idle timeout exceeded",
    "opencode Error: ECONNRESET",
    "socket hang up",
    "opencode ProviderError: 502 Bad Gateway",
    "503 Service Unavailable",
    "504 gateway timeout",
    "opencode Error: premature close",
    "the model is overloaded, try again",
    "429 rate limit exceeded",
    "408 Request Timeout",
  ]) {
    assert.equal(isTransientTurnError(e), true, e);
  }
});

test("an abort is a decision, and resuming it would restart work a human stopped", () => {
  // The worst possible outcome of a recovery mechanism, so it is excluded BY NAME before any status
  // code or message pattern gets a say.
  for (const e of [
    "opencode MessageAbortedError: aborted",
    "aborted: cancelled by founder",
    "opencode Error: request aborted",
  ]) {
    assert.equal(isTransientTurnError(e), false, e);
  }
});

test("a credential failure will fail identically in five seconds", () => {
  // Retrying it makes the founder wait through three backoffs to see an error that was true
  // immediately.
  for (const e of [
    "opencode ProviderAuthError: 401 unauthorized",
    "403 forbidden",
    "invalid api key",
    "insufficient credits",
    "billing: quota exceeded",
  ]) {
    assert.equal(isTransientTurnError(e), false, e);
  }
});

test("every 4xx except 408 and 429 is permanent", () => {
  // The rule most likely to be got wrong by treating "it failed, try again" as a general truth. A
  // 400 is the caller's to fix; a retry burns the budget and changes nothing.
  for (const code of [400, 401, 403, 404, 409, 413, 422]) {
    assert.equal(isTransientTurnError(`opencode Error: ${code} something`), false, String(code));
  }
  for (const code of [408, 429, 500, 502, 503, 504]) {
    assert.equal(isTransientTurnError(`opencode Error: ${code} something`), true, String(code));
  }
});

test("an unrecognised error is permanent — the classifier fails toward surfacing", () => {
  // It can only ever turn a failure into a retry of something already known to be retryable. It can
  // never suppress an error.
  for (const e of ["", "   ", "opencode UnknownError: {}", "the wedge declared no output schema"]) {
    assert.equal(isTransientTurnError(e), false, JSON.stringify(e));
  }
});

test("the budget is rolling, and cannot be re-armed by anything the session does", () => {
  // THE BUG THEIR HEADER NAMES: a failed turn can end in `session.idle` as well as `session.error`,
  // so a counter that resets on idle re-arms on every failure and retries for ever. Timestamps in a
  // window have nothing to reset.
  const b = newResumeBudget();
  const t0 = 1_000_000;
  assert.equal(nextResumeDelay(b, t0), BACKOFF_MS[0]);
  noteResume(b, t0);
  assert.equal(nextResumeDelay(b, t0 + 1_000), BACKOFF_MS[1], "the backoff grows");
  noteResume(b, t0 + 1_000);
  assert.equal(nextResumeDelay(b, t0 + 2_000), BACKOFF_MS[2]);
  noteResume(b, t0 + 2_000);
  assert.equal(nextResumeDelay(b, t0 + 3_000), undefined, `spent after ${MAX_RESUMES}`);

  // And it comes back one at a time, as each timestamp ages out of the window — not all at once.
  // The three were delivered a second apart, so a moment past the window from the FIRST still has
  // two inside it, and the budget is only down to its last resume.
  assert.equal(nextResumeDelay(b, t0 + RESUME_WINDOW_MS - 1), undefined, "nothing has aged out yet");
  assert.equal(nextResumeDelay(b, t0 + RESUME_WINDOW_MS + 1), BACKOFF_MS[2], "one aged out, one left");
  assert.equal(nextResumeDelay(b, t0 + RESUME_WINDOW_MS + 2_500), BACKOFF_MS[0], "all three aged out");
});

test("a slow drip of failures never exhausts the budget permanently", () => {
  // One failure every twenty minutes for a long run is not a wedged provider, and it must not end up
  // permanently unable to recover because of something that happened an hour ago.
  const b = newResumeBudget();
  let now = 1_000_000;
  for (let i = 0; i < 10; i++) {
    const d = nextResumeDelay(b, now);
    assert.notEqual(d, undefined, `resume ${i} should be allowed`);
    noteResume(b, now);
    now += 20 * 60_000;
  }
});

test("the prompt says resume, not redo", () => {
  // The difference between a resume and a redo, and it matters most for a run holding an action
  // grant: a model told only "continue" will cheerfully re-run the tool call it just completed,
  // which is how one email becomes two.
  const p = resumePrompt("Upstream idle timeout exceeded");
  assert.match(p, /Do NOT redo work that already succeeded/);
  assert.match(p, /do not start the task again/);
  assert.match(p, /re-run that one\s+only if it did not complete/);
  assert.match(p, /Upstream idle timeout/, "it names what actually happened");
});

test("the reason is bounded — a provider that returns a page does not become the prompt", () => {
  const p = resumePrompt("x".repeat(5_000));
  assert.ok(p.length < 600, `prompt was ${p.length} characters`);
});
