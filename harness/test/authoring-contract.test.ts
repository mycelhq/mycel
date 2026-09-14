// The service authoring contract is the ONE shapeable source of the shaper's rules. These tests keep
// it honest: the skill the shaper actually reads must equal what the code renders (no drift), every
// rule is well-formed, and the rule that cost us the build_website magic-moment failure is present.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SERVICE_AUTHORING_RULES, renderAuthoringContract } from "../src/authoring-contract";
import { capabilityFault } from "../src/capabilities";

const skillPath = fileURLToPath(new URL("../../wedges/business-shaper/skills/service-authoring-contract.md", import.meta.url));

test("contract: the committed skill the shaper reads is EXACTLY what the code renders — no drift", () => {
  const onDisk = readFileSync(skillPath, "utf8");
  assert.equal(
    onDisk,
    renderAuthoringContract(),
    "service-authoring-contract.md is stale — regenerate it from authoring-contract.ts so the shaper is given the current rules",
  );
});

test("contract: every rule is well-formed and ids are unique", () => {
  const ids = new Set<string>();
  for (const r of SERVICE_AUTHORING_RULES) {
    assert.ok(r.id && /^[a-z0-9-]+$/.test(r.id), `bad id: ${JSON.stringify(r.id)}`);
    assert.ok(!ids.has(r.id), `duplicate rule id: ${r.id}`);
    ids.add(r.id);
    assert.ok(r.guidance.trim().length > 10, `rule ${r.id} has no real guidance`);
    assert.ok(r.why.trim().length > 10, `rule ${r.id} has no reason`);
  }
});

test("contract: the delivery-shape rules that fix iterative work are present", () => {
  const ids = new Set(SERVICE_AUTHORING_RULES.map((r) => r.id));
  // These three are the class of bug that killed a real design-agency signup — they must not be
  // dropped from the contract by a future edit.
  for (const id of ["no-self-resume", "resume-exists", "job-output-schema", "skill-never", "compose-from-arsenal"]) {
    assert.ok(ids.has(id), `the contract lost the "${id}" rule`);
  }
  const render = renderAuthoringContract();
  assert.match(render, /NEXT stage — never itself/, "the self-resume guidance must reach the shaper verbatim");
});

// ── naming a need the catalogue does not cover ────────────────────────────────────────────────────
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// THE CONTRACT TOLD THE AUTHOR NOT TO, FOR A REASON THAT HAS EXPIRED
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// It said: "Only name capabilities from the known set. Do not invent one. Why: a capability is a
// promise the kernel can keep by connecting a real account; an unknown name is a promise nothing can
// fulfil."
//
// That was true. A name outside `ALL_CAPABILITIES` resolved to no connections, and `runtime.ts`
// skipped it silently — no grant, no `missing` entry, no explanation. So the rule was protecting the
// author from writing a service that would quietly run with no hands.
//
// It stopped being true when a connection gained the ability to declare what it PROVIDES. A need the
// author names is now answered by whatever the founder connects, appears on the setup screen as a
// question, and is reported in `missing` when nothing answers it. The rule now has the opposite
// cost: a physiotherapy service that cannot say `read_appointments` is a service that runs without
// the thing it needs and never says so.

test("THE CONTRACT LETS A SERVICE NAME ITS TRADE'S OWN NEED", () => {
  const contract = readFileSync(
    new URL("../../wedges/business-shaper/skills/service-authoring-contract.md", import.meta.url).pathname,
    "utf8",
  );
  assert.ok(
    !/Do not invent one/.test(contract),
    "the contract still forbids naming a need outside the eleven, so no trade we do not ship can be written for",
  );
  assert.match(contract, /NAME THE NEED ANYWAY/, "the contract does not say a trade-specific need is allowed");
  assert.match(contract, /read_appointments/, "the contract gives no example of one");

  /*
    AND IT STILL PREFERS THE KNOWN ELEVEN. Those are the ones the kernel parses and composes itself,
    which beats raw vendor tools — a bookkeeper's ledger is `read_bank_transactions`, not a new name.
    Dropping that preference would trade a working adapter for an improvised one on every service.
  */
  assert.match(contract, /Prefer a capability from the known set/);
  assert.match(contract, /read_bank_transactions/, "the contract does not steer a ledger need to the known name");
  // A need, not a vendor. `read_cliniko` is a product name with an underscore in it.
  assert.match(contract, /`read_cliniko` is a vendor with an underscore in it/);
});

test("and the validator agrees with the contract", () => {
  /**
   * The contract is prose the model reads; `capabilityFault` is what actually decides. They disagreed
   * for exactly as long as one of them was stale, and a contract that forbids what the validator
   * allows teaches the author to distrust both.
   */
  assert.equal(capabilityFault("read_appointments", { declarable: true }), undefined);
  assert.equal(capabilityFault("read_matters", { declarable: true }), undefined);
  // Still a typo, still caught — the kernel parses the eleven and a near miss would downgrade one.
  assert.match(capabilityFault("read_paymnets", { declarable: true })!, /did you mean/);
  // Still a vendor name, still allowed as a NAME — the contract asks for judgement the validator
  // cannot supply, and pretending otherwise would be a word list.
  assert.equal(capabilityFault("read_cliniko", { declarable: true }), undefined);
});
