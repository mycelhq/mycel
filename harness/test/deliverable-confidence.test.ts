// A finished deliverable and one the agent quietly guessed its way through look identical to a
// founder: both arrive complete, both read fluently. The difference is whether the run had to invent
// the client's intent somewhere — knowledge that exists exactly once, in the run, and is otherwise
// thrown away.
//
// Self-reported ON PURPOSE, and deliberately not a gate. A model scoring its own work is a weak
// signal about quality and a strong one about uncertainty.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readConfidence } from "../src/deliverables.routes";

const routes = () => readFileSync(new URL("../src/deliverables.routes.ts", import.meta.url), "utf8");

/** Exported from the route module so this tests the real function, not a copy of it. */
const readBody = async (b: Record<string, unknown>) => readConfidence(b.confidence);

test("a well-formed self-report survives intact", async () => {
  const got = (await readBody({
    confidence: { fit: 0.72, brief: "Q3 search visibility for the retail site", unsure: ["main domain or France subdomain?"] },
  })) as { fit: number; brief: string; unsure: string[] };
  assert.equal(got.fit, 0.72);
  assert.match(got.brief, /Q3 search visibility/);
  assert.equal(got.unsure.length, 1);
});

test("a number outside 0..1 is clamped, not refused", async () => {
  // This is a self-report from a model. A 1.5 is something it will do occasionally and is not worth
  // failing a finished deliverable over.
  assert.equal(((await readBody({ confidence: { fit: 1.5 } })) as { fit: number }).fit, 1);
  assert.equal(((await readBody({ confidence: { fit: -2 } })) as { fit: number }).fit, 0);
  assert.equal(((await readBody({ confidence: { fit: "0.4" } })) as { fit: number }).fit, 0.4);
});

test("saying nothing is different from saying zero", async () => {
  // Absent means the run did not report, and a review queue must sort that as unknown rather than
  // as the worst deliverable in the list.
  assert.equal(await readBody({}), undefined);
  assert.equal(await readBody({ confidence: {} }), undefined);
  assert.equal(await readBody({ confidence: { fit: "not a number" } }), undefined);
  assert.equal(await readBody({ confidence: "0.9" }), undefined);
});

test("unbounded text cannot ride along on every version read", async () => {
  const got = (await readBody({
    confidence: { fit: 0.5, brief: "x".repeat(5000), unsure: Array.from({ length: 40 }, () => "y".repeat(1000)) },
  })) as { brief: string; unsure: string[] };
  assert.ok(got.brief.length <= 600, `brief was ${got.brief.length} chars`);
  assert.ok(got.unsure.length <= 8, `kept ${got.unsure.length} entries`);
  assert.ok(got.unsure.every((u) => u.length <= 300));
});

test("nothing in the kernel branches on the score", () => {
  // The moment a number gates a release, every run learns to report 0.95 and the field is worthless
  // to everybody. This is the assertion that keeps it a sort key.
  const src = routes();
  assert.equal(
    /confidence[?.\s]*\.?\s*fit\s*[<>]=?/.test(src),
    false,
    "something compares confidence.fit against a threshold — it is a sort key, not a gate",
  );
});

test("the craft every deliverable run reads tells it to produce this", () => {
  // Otherwise the field is built and never populated — the failure mode this repo keeps hitting.
  const craft = readFileSync(new URL("../../library/craft/delivering-work.md", import.meta.url), "utf8");
  assert.match(craft, /confidence/, "no craft tells a run to report confidence");
  assert.match(craft, /"fit"|`fit`/, "the craft never names the field");
  assert.match(craft, /unsure/, "the craft never asks for what the run had to guess");
});
