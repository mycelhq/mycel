// `npm run demo` is the first thing a stranger runs that is not a test suite.
//
// ═══ THE FUNNEL THIS GUARDS ═══
//
// Measured on a cold clone: to see anything beyond a passing suite you ran `npm run demo` (which
// blocks, because it is a server), opened a SECOND terminal, ran `npm run demo:seed`, read a wall
// of text telling you to curl, did a login-token dance with `jq`, and read raw JSON. Four commands,
// two terminals, and the payoff was a blob. Every step is a place to stop.
//
// The two-terminal split was also a trap rather than an inconvenience: the kernel and the seed have
// to agree on MYCEL_OWNER_EMAIL and MYCEL_OWNER_PASSWORD, and booting the kernel by hand gets you a
// generated owner and a seed that cannot log in.
//
// These tests pin the parts that can be checked without booting anything: that the wiring is what
// the docs say, and that the formatting the payoff depends on is correct. The rendering itself was
// checked by running it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { clip, money, wrap } from "../scripts/demo";

const read = (p: string): string => readFileSync(fileURLToPath(new URL(`../../${p}`, import.meta.url)), "utf8");
const PKG = JSON.parse(read("package.json")) as { scripts: Record<string, string> };

test("demo: one command, and it is the orchestrator rather than a bare server", () => {
  assert.match(PKG.scripts.demo!, /demo\.ts/, "`npm run demo` must be the thing that boots, seeds AND renders");
  // The old split is kept for contributors iterating on the seed — the server staying up across
  // runs is genuinely useful — but it must not be what a newcomer is pointed at.
  assert.ok(PKG.scripts["demo:kernel"], "the server-only script must still exist for contributors");
  assert.match(PKG.scripts["demo:kernel"]!, /harness\/src\/index\.ts/);
});

test("demo: the identity is defined once, not spelled out per script", () => {
  // The two-terminal trap in one assertion. When `demo` and `demo:seed` each carried their own
  // copy of the owner email and password, the two could drift and the seed could not log in.
  const src = read("harness/scripts/demo.ts");
  assert.match(src, /const DEMO_ENV = \{/);
  assert.equal(
    (PKG.scripts.demo!.match(/MYCEL_OWNER_PASSWORD/g) ?? []).length,
    0,
    "the demo script must not re-declare the identity that demo.ts owns",
  );
});

test("demo: importing it does not boot a kernel", () => {
  // This file imports the formatting helpers. Without the run-guard that import would boot a
  // kernel, seed it, and hold the process open — the suite would HANG rather than fail.
  assert.match(read("harness/scripts/demo.ts"), /import\.meta\.url === pathToFileURL\(process\.argv\[1\]\)\.href/);
});

// ── The formatting the payoff is made of ────────────────────────────────────

test("demo: money is divided once, at the last step, and never re-derived", () => {
  // Minor units are the invariant this whole codebase keeps — see the MONEY comment on `Invoice`.
  // A renderer that divides early, or that assumes cents, is how $2,970.00 becomes $29.70.
  assert.equal(money({ money_at_stake: 297000, currency: "USD", minor_unit_exponent: 2 }), "$2,970.00");
  assert.equal(money({ money_at_stake: 445000, currency: "USD", minor_unit_exponent: 2 }), "$4,450.00");
  // A zero-exponent currency has no minor unit at all. Assuming 2 would show ¥1,234.00 as ¥12.34.
  assert.equal(money({ money_at_stake: 1234, currency: "JPY", minor_unit_exponent: 0 }), "¥1,234");
  // Absent is not zero: a move with nothing at stake shows an empty column, never "$0.00".
  assert.equal(money({}), "");
  assert.equal(money({ money_at_stake: 0, currency: "USD", minor_unit_exponent: 2 }), "$0.00");
});

test("demo: a long label is clipped, never wrapped into the next column", () => {
  assert.equal(clip("short", 10), "short     ", "padded to the column width");
  assert.equal(clip("a very long deliverable title", 12), "a very long…");
  assert.equal(clip("exactly-ten", 11), "exactly-ten", "a value that just fits is not truncated");
});

test("demo: the reasoning wraps to the indent, and no word is lost", () => {
  const text = "INV-0001 is 34 days overdue with $2,970.00 outstanding and nothing has been said about it";
  const lines = wrap(text, "        ");
  assert.ok(lines.length > 1, "a sentence this long must wrap");
  for (const l of lines) assert.ok(l.startsWith("        "), `lost the indent: ${l}`);
  assert.equal(
    lines.map((l) => l.trim()).join(" "),
    text,
    "wrapping must preserve every word exactly — this is the line a reader is asked to judge",
  );
});

test("demo: wrapping never loses a word longer than the line", () => {
  // A URL in a blocked reason is one token and cannot be broken. It must survive whole rather than
  // being dropped or truncated into something that is no longer a link.
  const url = "https://example.com/a/very/long/path/that/exceeds/any/sensible/terminal/width/by/itself";
  assert.ok(wrap(`see ${url}`, "  ").join(" ").includes(url));
});
