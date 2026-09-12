// THE ONLY THING ANYTHING KNEW ABOUT A RESEARCH RUN WAS `reached: true`.
//
// research-quality.ts classifies WHERE each finding came from — a regulator's page, vendor docs, a
// practitioner, a sales page, or nothing — and was reachable from its own unit tests and nowhere
// else. So a run that read three trade-body method statements and a run that read four agency
// landing pages arrived at the author identically labelled.
//
// That matters more here than anywhere else in the product: the research step is what separates a
// service written in a trade's real vocabulary from general business admin wearing it, and the
// author cannot tell the difference by reading the findings — they both look plausible.
//
// These tests are about the SEAM. research-quality.test.ts covers the classifier itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { withDraftServiceArsenal } from "../src/skill-arsenal";

const research = (findings: { source: string }[]) => ({
  reached: true,
  deliverables: findings.map((f, i) => ({ name: `d${i}`, source: f.source })),
});

test("research that reached carries a quality label to the author", () => {
  const out = withDraftServiceArsenal(
    { description: "bookkeeping for dentists" },
    research([{ source: "https://www.gov.uk/vat-returns" }, { source: "https://icb.org.uk/standards" }]),
  );
  assert.ok(out.research, "the findings still arrive");
  const q = out.research_quality as Record<string, unknown>;
  assert.ok(q, "and now they arrive labelled");
  assert.ok(typeof q.summary === "string" && (q.summary as string).length > 0);
  assert.ok((q.depth as number) > 0.5, "regulator pages should score high");
});

test("sales pages and trade bodies are told apart, which is the whole point", () => {
  const strong = withDraftServiceArsenal(
    {},
    research([{ source: "https://www.gov.uk/x" }, { source: "https://icb.org.uk/y" }]),
  ).research_quality as Record<string, unknown>;
  const weak = withDraftServiceArsenal(
    {},
    research([{ source: "https://someagency.com/services" }, { source: "https://another.io/pricing" }]),
  ).research_quality as Record<string, unknown>;

  assert.ok(
    (strong.depth as number) > (weak.depth as number),
    `four landing pages must not score like two regulators (${strong.depth} vs ${weak.depth})`,
  );
  assert.match(String(strong.summary), /standards or trade bodies/);
  assert.match(String(weak.summary), /sales pages/);
});

test("one publisher read five times is reported as one opinion", () => {
  const q = withDraftServiceArsenal(
    {},
    research(Array.from({ length: 5 }, () => ({ source: "https://oneblog.com/post" }))),
  ).research_quality as Record<string, unknown>;
  assert.equal(q.distinct_hosts, 1, "breadth is not depth, and the author should see which is missing");
});

test("findings that cited nothing are named, so the author knows which claims to hedge", () => {
  const out = withDraftServiceArsenal(
    {},
    { reached: true, deliverables: [{ name: "a", source: "" }], steps: [{ name: "b", source: "https://gov.uk/x" }] },
  );
  const q = out.research_quality as Record<string, unknown>;
  assert.deepEqual(q.unsourced, ["deliverables"]);
  assert.ok((q.sourced as number) < 1, "half-cited research must not read as fully cited");
});

test("research that never reached anything attaches nothing at all", () => {
  // `reached: false` means we could not look, which is a different and much weaker claim than
  // "there was nothing out there". No findings, so no quality label to invent about them.
  const out = withDraftServiceArsenal({ description: "x" }, { reached: false });
  assert.equal(out.research, undefined);
  assert.equal(out.research_quality, undefined, "a score over zero findings would be a fabrication");
});

test("no research at all is unchanged — this is additive to every existing caller", () => {
  const out = withDraftServiceArsenal({ description: "x" });
  assert.equal(out.research_quality, undefined);
  assert.ok(Array.isArray(out.capabilities), "the rest of the arsenal is untouched");
  assert.ok(Array.isArray(out.catalogue));
});
