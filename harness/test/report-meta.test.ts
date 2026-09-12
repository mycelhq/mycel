import { test } from "node:test";
import assert from "node:assert/strict";
import { reportScenes } from "../src/render/report";
import { resolveBrandKit } from "../src/brandkit";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * A LONG META VALUE PRINTED ON TOP OF ITS OWN LABEL
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Label and value are both right-aligned — the label ends at `R - space(25)`, the value ends at
 * `R` — so the value grows leftward into a gutter that was a fixed number, never measured against
 * the string put in it.
 *
 * A real deliverable shipped with "ChatGPT, Perplexity, Claude, Gemini" stamped through the word
 * "Surfaces", on page one of the document a client opens. Nothing threw: PDF text has no collision
 * detection, so both strings render at overlapping coordinates and the reader sees mud.
 *
 * The scene is inspected rather than the bytes, because the defect is geometric.
 */

const kit = resolveBrandKit(undefined, "Sightline Research");

/**
 * The SCENE, not the bytes. `render()` returns a base64 PDF and the defect here is geometric — two
 * strings at overlapping coordinates. `reportScenes` is the function `render` calls, so this reads
 * exactly what the emitter is handed.
 */
function metaNodes(meta: { label: string; value: string }[]) {
  const scenes = reportScenes(
    { title: "T", subtitle: "S", label: "Review", meta, blocks: [{ kind: "paragraph", text: "x" }] },
    kit,
  );
  return (scenes[0]?.nodes ?? []) as unknown as Record<string, unknown>[];
}

test("a long meta value never overlaps its label", () => {
  const label = "Surfaces";
  const value = "ChatGPT, Perplexity, Claude, Gemini";
  const nodes = metaNodes([{ label, value }]).filter(
    (n) => n.text === label || n.text === value || String(n.text ?? "").startsWith("ChatGPT"),
  );
  const l = nodes.find((n) => n.text === label) as { x: number; y: number } | undefined;
  const v = nodes.find((n) => String(n.text ?? "").startsWith("ChatGPT")) as
    | { x: number; y: number; text: string }
    | undefined;
  assert.ok(l && v, "the meta row did not render");
  assert.equal(l.y, v.y, "the fixture no longer puts them on one line");
  // Both are anchored "end", so x is each string's RIGHT edge. The label's right edge must sit left
  // of where the value begins — which is the one thing the fixed gutter could not guarantee.
  assert.ok(l.x < v.x, "label is not left of the value");
});

test("short values keep the spacing the header was designed with", () => {
  const nodes = metaNodes([{ label: "Prepared", value: "Sightline Research" }]);
  const l = nodes.find((n) => n.text === "Prepared") as { x: number; y: number } | undefined;
  assert.ok(l, "no label rendered");
  /**
   * MATCHED ON THE ROW, not on the string. The letterhead prints the business name too — at x=48,
   * anchored "start" — so finding by text alone picks the wordmark and compares a meta label
   * against a logo. That is what this test did on its first run, and it "failed" against a
   * renderer that was already correct.
   */
  const v = nodes.find(
    (n) => n.text === "Sightline Research" && n.y === l.y && n.anchor === "end",
  ) as { x: number } | undefined;
  assert.ok(v, "no meta value on the label's row");
  // A short row must not be nudged around by the new measurement — only long ones move.
  assert.ok(l.x < v.x, `label at ${l.x} is not left of value at ${v.x}`);
});

test("a value too long for the header is truncated, not the label", () => {
  const label = "Surfaces";
  const value = "ChatGPT, Perplexity, Claude, Gemini, Copilot, Grok, DeepSeek, Mistral and several more";
  const nodes = metaNodes([{ label, value }]);
  assert.ok(nodes.some((n) => n.text === label), "the LABEL was clipped — it must never be");
  const printed = nodes.find((n) => String(n.text ?? "").startsWith("ChatGPT")) as { text: string } | undefined;
  assert.ok(printed, "no value rendered");
  assert.notEqual(printed.text, value, "an over-long value was not shortened");
  assert.match(printed.text, /…$/, "truncation must be visible");
});
