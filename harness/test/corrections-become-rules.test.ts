/**
 * ═══ "YOU CORRECT IT ONCE, AND IT STOPS NEEDING YOU" ═══
 *
 * That sentence is on the landing page. It was not true.
 *
 * `recordApprovalOutcome` turns a founder's decision into an observation and, when they edited the
 * draft, into a scoped rule the next run retrieves. It was called from inside `awaitApproval` — the
 * WAITING RUN's own code path — and the comment above it claimed "every path converges on this
 * line". Every path a live run takes converges there. A founder who decides two hours later decides
 * after a deploy or a stall has killed the run that was waiting, and there is no process left to
 * record anything.
 *
 * Measured 2026-09-06: 21 approvals decided, every one carrying a project, every one on a task that
 * SUCCEEDED, across 26 days of overlap with that code. `observations` held zero rows, and all 22
 * rules in production carried `"source": "onboarding"` in their provenance — a founder answering a
 * setup question. Not one correction had ever become a rule.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const code = (f: string) =>
  readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8")
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*");
    })
    .join("\n");

test("the founder's decision records the lesson, at the door where it is made", () => {
  const s = code("server.ts");
  const i = s.indexOf("recordApprovalOutcome(getKnowledgeStore()");
  assert.ok(i > -1, "the approve route no longer records the lesson");

  // It has to sit on the path that runs for EVERY decision, not only the edited ones. A clean
  // approval is evidence too — it is the agent being told it got this right.
  const editGate = s.indexOf('decision === "approved" && body.edited');
  assert.ok(editGate > i, "the lesson is recorded inside the edited-only branch, so clean approvals teach nothing");

  // And it must never cost the founder their approval. The action is already in flight.
  assert.match(s.slice(i, i + 600), /\.catch\(/, "a failed write would fail the approval itself");
});

test("the waiting run no longer records it, so nothing is recorded twice", () => {
  const s = code("approvals.ts");
  assert.ok(
    !s.includes("recordApprovalOutcome("),
    "awaitApproval still records the outcome — a live run would now file the same lesson twice",
  );
});

test("a client's click in the portal does not teach the firm's voice", () => {
  // Deliberately NOT wired. `recordApprovalOutcome` learns how THIS FIRM wants work done, from the
  // founder correcting a draft. A client approving a deliverable is different evidence entirely,
  // and folding it in would put the client's preferences into the firm's rules.
  const s = code("portal-approvals.ts");
  assert.ok(!s.includes("recordApprovalOutcome"), "a client's approval now writes the firm's rules");
});

test("an auto-approval is not counted as a human saying it was right", () => {
  // The old placement caught policy-driven auto-approvals too, because it sat after the decision
  // whatever produced it. `recordAutoApproval` is a wedge policy firing, not a person, and
  // observing "approval_clean" from it is evidence nobody gave.
  const s = code("approvals.ts");
  const i = s.indexOf("export async function recordAutoApproval");
  assert.ok(i > -1);
  const body = s.slice(i, s.indexOf("\n}\n", i));
  assert.ok(!body.includes("recordApprovalOutcome"), "an auto-approval is being learned from as if a human decided");
});
