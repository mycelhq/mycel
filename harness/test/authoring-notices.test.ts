// WHAT THE DRAFT ASKED FOR AND DID NOT GET, SAID OUT LOUD.
//
// ═══ HOW THIS WAS FOUND, WHICH IS THE POINT ═══
//
// `evals/` reported the generation-quality floor at 4 of 11. Five of the failures expected a named
// refusal and got a clean draft with an empty `faults` — so the first reading was "the kernel
// accepts a service that grants itself permission to send". It does not. It SANITISES: the policy
// is stripped, `required: false` is forced true, a claimed kernel role and self-authored workflows
// are removed, a mistyped capability is corrected, a wait that could never resume is dropped.
//
// Every one of those repairs is right, and refusing a whole service over one strippable line would
// be worse — `repairAuthoredManifest` calls that "the difference between a runnable service and a
// dead magic moment". What was wrong was the silence. A founder approving a written service is
// being asked to trust the thing that wrote it, and nothing told them it had asked for more than
// it was entitled to.
//
// These assert both halves at once, because either alone is a bug: the correction must still
// happen, AND it must be visible. A test that only checked the notice would pass if a later change
// turned the repair back into a refusal and lost the founder a good service.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { authorWedgeFromOutput } from "../src/wedgeauthor";

const job = (description: string) => ({
  description,
  output_schema: { type: "object", properties: { sent: { type: "boolean" } }, required: ["sent"] },
});

const author = (manifest: Record<string, unknown>) =>
  authorWedgeFromOutput({ manifest: { title: "Studio", ...manifest } }, { slugBase: "Design Studio" });

function corrected(manifest: Record<string, unknown>, said: RegExp) {
  const r = author(manifest);
  assert.ok(r.draft, "the service was refused outright — a good service lost over one strippable line");
  assert.match(r.notices.map((n) => n.message).join(" | "), said, "the repair happened silently");
  return r;
}

test("A DRAFT THAT WRITES ITS OWN AUTO-APPROVE IS STRIPPED, AND SAYS SO", () => {
  /**
   * The one that matters most. A written service MAY carry day-one allowances — that reversal was
   * deliberate, because a business that asks permission for everything on day one is a gate the
   * founder learns to stop reading. What the model may not do is set their SIZE.
   */
  const r = corrected(
    { task_types: { send_proposal: job("send the proposal") }, policy: { auto_approve: [{ action: "email.send" }] } },
    /act on its own/,
  );
  assert.equal((r.draft!.manifest as Record<string, unknown>).policy, undefined, "the self-written policy survived");
});

test("an approval marked not-required is forced back, and says so", () => {
  const r = corrected(
    { task_types: { send: job("send") }, approvals: [{ action: "email.send", risk: "high", required: false }] },
    /not needing your approval/,
  );
  const approvals = (r.draft!.manifest as { approvals?: { required?: boolean }[] }).approvals ?? [];
  assert.ok(approvals.every((a) => a.required !== false), "an approval survived as optional");
});

test("a claimed kernel role and self-authored code are removed, and say so", () => {
  // Roles are singletons: one business claiming one takes it from every other on the box.
  corrected({ provides: ["dunning"], task_types: { send: job("send") } }, /one of Mycel's own roles/);
  corrected({ task_types: { send: job("send") }, workflows: [{ name: "do_math" }] }, /its own runnable code/);
});

test("a mistyped capability is corrected, and says so", () => {
  /**
   * Worth telling them even though the repair is certainly right: a capability is what the service
   * will ASK THEM to connect, so a silent rename means the word on their setup screen is not the
   * word in the draft they approved.
   */
  const r = corrected({ task_types: { send: job("send") }, capabilities: ["send_emails"] }, /send_email/);
  assert.deepEqual((r.draft!.manifest as { capabilities?: string[] }).capabilities, ["send_email"]);
});

test("A JOB THAT WOULD WAIT FOREVER RUNS ONCE INSTEAD, AND SAYS SO", () => {
  /**
   * The most consequential and the quietest. A resume naming no job parks the engagement forever,
   * so dropping the wait is right — but the job the founder read on the card WAITED FOR THE CLIENT
   * and the one they get does not. That is a change to the shape of the work, not a removed field.
   */
  const r = corrected(
    {
      task_types: {
        ask_brief: {
          description: "ask the client for the brief",
          output_schema: { type: "object", properties: { ok: { type: "boolean" } } },
          waits_for: { on: "client_request", resume: "no_such_job", reason: "waiting" },
        },
      },
    },
    /runs once now/,
  );
  const tt = (r.draft!.manifest as { task_types: Record<string, { waits_for?: unknown }> }).task_types;
  assert.equal(tt.ask_brief!.waits_for, undefined, "a wait that could never resume survived");
});

test("a clean draft says nothing — a notice on every service is a notice nobody reads", () => {
  const r = author({ task_types: { send: job("send the proposal, once you approve it") } });
  assert.ok(r.draft);
  assert.deepEqual(r.notices, []);
});

test("A NOTICE THAT IS NOT PERSISTED IS A NOTICE THAT DIES AT AUTHORING TIME", () => {
  /**
   * It cannot be re-derived — the repaired manifest no longer contains what was removed — so the
   * write is the only thing between the founder and never knowing. Call-site assertions, because
   * the risk here is wiring: `notices` on the result, written onto the row, and read back onto the
   * review card, which is the one screen where it can change a decision.
   */
  const orch = readFileSync(new URL("../src/orchestrator.ts", import.meta.url), "utf8");
  const routes = readFileSync(new URL("../src/authored.routes.ts", import.meta.url), "utf8");
  assert.match(orch, /notices: authored\.notices\.map/, "the authored draft is stored without its notices");
  assert.match(routes, /notices: row\.notices/, "the review card does not carry them");
});
