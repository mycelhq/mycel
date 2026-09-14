// A source window that cannot silently become the wrong window.
//
// ═══ THE BUG THIS EXISTS FOR, THREE TIMES IN ONE PASS ═══
//
// Dozens of tests here assert on a REGION of a source file rather than the whole thing — the body of
// one function, one route handler, one section of the README. They all find that region the same
// way:
//
//     const region = src.slice(src.indexOf("### A business to look at"), src.indexOf("## Next"));
//
// `indexOf` returns -1 when the anchor is gone, and `String.prototype.slice` reads a negative start
// as an offset from the END. So a renamed heading does not fail the test — it moves the window to
// the last character of the file and asserts against nearly nothing. Sometimes that fails, which is
// luck. Sometimes the region still contains the matched text and the guard passes while guarding a
// different part of the file entirely.
//
// It happened three times while auditing this repo's docs:
//   · a README heading was renamed and `B6 stranger-install` started slicing from -1
//   · a guard took 300 characters after a call site and ran into the NEXT block's output
//   · a guard matched a whole `import { x } from "y"` line, so adding a second export broke it
//
// Two of those failed loudly and one passed. The one that passed is the reason this file exists.
//
// ═══ WHY A HELPER AND NOT A CODEMOD ═══
//
// There are 60 raw `slice(x.indexOf(…))` call sites. Rewriting all of them in one change would be a
// large mechanical diff across tests that are otherwise fine, and the risk of quietly altering what
// one of them asserts is worse than the debt. So: this helper for new and touched code, and a
// ratchet in `connectivity.test.ts`'s style that refuses to let the raw count grow.

import assert from "node:assert/strict";

/**
 * The text between two anchors, or a failed assertion naming the one that is missing.
 *
 * `to` is exclusive and optional — omit it for "from here to the end". Both anchors must be present
 * and `to` must come after `from`, because a backwards window is the same silent nothing as a
 * missing one.
 */
export function between(source: string, from: string, to?: string): string {
  const start = source.indexOf(from);
  assert.notEqual(start, -1, `anchor not found, so the window would have been wrong: ${JSON.stringify(from)}`);

  if (to === undefined) return source.slice(start);

  const end = source.indexOf(to, start);
  assert.notEqual(end, -1, `closing anchor not found after ${JSON.stringify(from)}: ${JSON.stringify(to)}`);
  return source.slice(start, end);
}

/**
 * The text from an anchor for `n` characters.
 *
 * Prefer `between` wherever there is a real closing anchor. A character count is a guess about how
 * long the thing you care about is, and it was wrong the first time it was used here: 300 characters
 * after a call site ran past the end of that block and into the next one's output, failing a file
 * that was entirely correct. Use this only when the region genuinely has no natural end.
 */
export function after(source: string, from: string, n: number): string {
  const start = source.indexOf(from);
  assert.notEqual(start, -1, `anchor not found, so the window would have been wrong: ${JSON.stringify(from)}`);
  return source.slice(start, start + n);
}
