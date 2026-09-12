// DID THE ARTEFACT WEAR THE STYLE IT WAS GIVEN?
//
// opendesign's first critique dimension is reference fidelity — "does it honour a real system, or is
// it generic". It is the one dimension our five-criterion review cannot see, because the reviewer
// grades readable TEXT and the style lives in the markup; and it only became checkable when the pin
// did, because before `Deliverable.style` there was no answer to "which system was this meant to be".
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fidelityRefusal, styleFidelity } from "../src/style-fidelity";

const SYSTEM = {
  id: "professional",
  tokens: ":root { --bg: #f5f8ff; --fg: #101828; --accent: #2563eb; --muted: #667085; --border: #d7e0ef; }",
};

const page = (style: string, body = "<h1>Q1 accounts</h1>") =>
  `<html><head><style>${style}</style></head><body>${body}</body></html>`;

test("fidelity: a document styled entirely past its tokens is refused", () => {
  // The failure this exists for. It clears every anti-slop rule — no purple, no indigo, no emoji —
  // and is a document that ignored the firm's house style completely, in tasteful greys of its own.
  const f = styleFidelity(page("body { background: #ffffff; color: #222222; font-family: Georgia; }"), SYSTEM);
  const ignored = f.find((x) => x.code === "tokens_ignored");
  assert.ok(ignored, "styling past every token was not caught");
  assert.equal(ignored.blocking, true);
  assert.match(ignored.message, /professional/, "the refusal must name the system it was meant to be in");
  assert.match(fidelityRefusal(f) ?? "", /submit again/);
});

test("fidelity: pasting the tokens and never referencing them is still ignoring them", () => {
  // The commonest shape, and the one a naive presence check passes: the `:root` block is in the file
  // and every rule underneath writes its own hex.
  const f = styleFidelity(
    page(`${SYSTEM.tokens} body { background: #ffffff; color: #222222; }`),
    SYSTEM,
  );
  assert.ok(f.some((x) => x.code === "tokens_ignored"), "declared-but-unused read as honoured");
});

test("fidelity: using the tokens passes, even alongside a few literals", () => {
  const f = styleFidelity(
    page(`${SYSTEM.tokens} body { background: var(--bg); color: var(--fg); } .chip { border: 1px solid #eee; }`),
    SYSTEM,
  );
  assert.equal(f.filter((x) => x.blocking).length, 0);
  assert.equal(fidelityRefusal(f), undefined);
});

test("fidelity: a fragment with no styling at all is silent", () => {
  // THE FALSE POSITIVE THE EXISTING SUITE CAUGHT. The first version of this blocked
  // `<h1>Hello client</h1>` — a file with no stylesheet, which is a snippet or an email body, not a
  // document that ignored anything. Refusing it gates a whole class of legitimate deliverables on a
  // decision they never made.
  assert.deepEqual(styleFidelity("<h1>Hello client</h1>", SYSTEM), []);
  assert.deepEqual(styleFidelity("<p>Numbers attached.</p><ul><li>one</li></ul>", SYSTEM), []);
});

test("fidelity: no pinned system means nothing to be unfaithful to", () => {
  // Inventing a standard here would gate work against a look nobody chose.
  const styled = page("body { background: #fff; color: #111; }");
  assert.deepEqual(styleFidelity(styled, undefined), []);
  assert.deepEqual(styleFidelity(styled, { id: "gone", tokens: "" }), []);
});

test("fidelity: literals past the tokens advise, they do not block", () => {
  // A threshold that blocks is a threshold that one day costs a founder their Friday over a document
  // that was fine. Only the unambiguous finding halts the agent.
  const many = Array.from({ length: 20 }, (_, i) => `.c${i} { border-color: #a${i % 10}b1c2; }`).join(" ");
  const f = styleFidelity(page(`${SYSTEM.tokens} body { color: var(--fg); } ${many}`), SYSTEM);
  const raw = f.find((x) => x.code === "raw_hex");
  assert.ok(raw, "twenty literal colours went unremarked");
  assert.equal(raw.blocking, false);
  assert.equal(fidelityRefusal(f), undefined, "an advisory must not refuse the submission");
});

test("fidelity: a hex defining a token is not a hex written past one", () => {
  // `--surface: #fff` is the token being defined and is the correct place for a literal. Counting it
  // would make every system's own `:root` block the largest violation in the file.
  const f = styleFidelity(
    page(`:root { ${Array.from({ length: 20 }, (_, i) => `--t${i}: #ab${i % 10}1c2;`).join(" ")} } body { color: var(--fg); }`),
    SYSTEM,
  );
  assert.equal(f.find((x) => x.code === "raw_hex"), undefined);
});

test("fidelity: a font stack is one choice, not three", () => {
  // `font-family: Inter, system-ui, sans-serif` is one family with two fallbacks. Counting the stack
  // would fail every well-written declaration in existence.
  const ok = styleFidelity(
    page(`${SYSTEM.tokens} body { color: var(--fg); font-family: Inter, system-ui, sans-serif; } h1 { font-family: Georgia, serif; }`),
    SYSTEM,
  );
  assert.equal(ok.find((x) => x.code === "font_families"), undefined);

  const tooMany = styleFidelity(
    page(`${SYSTEM.tokens} body { color: var(--fg); font-family: Inter; } h1 { font-family: Georgia; } .a { font-family: Courier; }`),
    SYSTEM,
  );
  assert.ok(tooMany.find((x) => x.code === "font_families"), "three faces went unremarked");
});

test("fidelity: the accent is counted where a reader sees it, not where CSS mentions it", () => {
  // Six rules that each set the accent on one element is a different thing from six elements wearing
  // it, and only the second is the accent losing its job.
  const css = `${SYSTEM.tokens} body { color: var(--fg); } .a,.b,.c,.d,.e,.f,.g,.h { color: var(--accent); }`;
  assert.equal(styleFidelity(page(css), SYSTEM).find((x) => x.code === "accent_overused"), undefined);

  const body = Array.from({ length: 8 }, () => `<span style="color: var(--accent)">x</span>`).join("");
  assert.ok(styleFidelity(page(`${SYSTEM.tokens} body { color: var(--fg); }`, body), SYSTEM)
    .find((x) => x.code === "accent_overused"));
});

test("fidelity: the gate is wired into the submit path, ahead of the anti-slop lint", () => {
  // A CALL-SITE TEST. Fidelity is the more specific complaint: "you ignored the house style" and
  // "your gradient is purple" can both be true, and telling a run about its gradient while it styles
  // past the brand entirely sends it to fix the smaller thing.
  const src = readFileSync(fileURLToPath(new URL("../src/deliverables.routes.ts", import.meta.url)), "utf8");
  assert.match(src, /const refusal = fidelityRefusal\(styleFidelity\(html, pinned \? designSystem\(pinned\.system\) : undefined\)\)/);
  const fidelityAt = src.indexOf("fidelityRefusal(styleFidelity(");
  const lintAt = src.indexOf("lintArtifact(html).filter");
  assert.ok(fidelityAt > 0 && lintAt > fidelityAt, "the anti-slop lint runs before the fidelity check");
  // And version 1 must be checked too — it is the one that sets the tone for the engagement.
  assert.match(src, /const slopStyle = d\?\.style \?\? resolveStyle\(getIdentityStore\(\)\.brandKit\(projectId\)\)/);
});

// ── the squint test, as the half a machine can run ──────────────────────────────────────────────

const doc = (body: string) =>
  `<html><head><style>:root{--fg:#111;} body{color:var(--fg);}</style></head><body>${body}</body></html>`;

test("fidelity: a clean heading ladder is silent", () => {
  const f = styleFidelity(doc("<h1>Q1</h1><h2>Cash</h2><h3>Detail</h3><h2>Risks</h2>"), SYSTEM);
  assert.equal(f.find((x) => x.code === "hierarchy"), undefined);
});

test("fidelity: four top-level headings means the page has no top line", () => {
  const f = styleFidelity(doc("<h1>A</h1><h1>B</h1><h1>C</h1><h2>d</h2>"), SYSTEM);
  const h = f.find((x) => x.code === "hierarchy");
  assert.ok(h, "three h1s went unremarked");
  assert.match(h.message, /3 top-level headings/);
  // Advice, never a gate: a one-section note legitimately has no h1, and refusing correct work over
  // a proxy for a judgement nobody made is how a check gets switched off.
  assert.equal(h.blocking, false);
});

test("fidelity: skipping a level asks the reader to infer a heading nobody wrote", () => {
  const f = styleFidelity(doc("<h1>A</h1><h3>B</h3><h4>C</h4>"), SYSTEM);
  const h = f.find((x) => x.code === "hierarchy");
  assert.ok(h);
  assert.match(h.message, /h1 → h3/);
});

test("fidelity: returning UP any number of levels is normal, not a skip", () => {
  // A section ending goes back to the top. Only jumping DOWN more than one level at a time asks the
  // reader to infer a level that is not there — counting both would fire on every well-formed
  // document with more than two sections.
  // A THREE-LEVEL return, which is the case a naive `Math.abs(jump) > 1` breaks on: a document that
  // goes down to h4 inside one section and then opens the next at h2 is well-formed, and that is the
  // shape of every long report. Testing only a one-level return would let the bug through.
  const f = styleFidelity(doc("<h1>A</h1><h2>B</h2><h3>C</h3><h4>D</h4><h2>E</h2><h3>F</h3>"), SYSTEM);
  assert.equal(f.find((x) => x.code === "hierarchy"), undefined);
});

test("fidelity: two headings are not a ladder, so the check stays quiet", () => {
  // Below three there is no shape to have lost, and complaining about a two-heading note is how a
  // signal earns its way into the ignore pile.
  assert.equal(styleFidelity(doc("<h1>A</h1><h3>B</h3>"), SYSTEM).find((x) => x.code === "hierarchy"), undefined);
});

test("fidelity: headings inside a <style> block are not headings", () => {
  // The ladder is read from the RENDERED body. A selector called `h1` in a stylesheet is not a
  // heading, and counting it would make every artefact that styles its own headings fail.
  const f = styleFidelity(
    `<html><head><style>:root{--fg:#111} h1{color:var(--fg)} h1.alt{margin:0} h1.x{margin:0}</style></head><body><h1>A</h1><h2>B</h2><h3>C</h3></body></html>`,
    SYSTEM,
  );
  assert.equal(f.find((x) => x.code === "hierarchy"), undefined);
});
