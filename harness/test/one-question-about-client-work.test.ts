/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * THREE VOCABULARIES FOR ONE QUESTION, AND THREE MODULES DISAGREEING
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * "Does this task type produce work a client receives?" was asked three different ways:
 *
 *   · a name-prefix regex        — `deliverables.wrap`, `fulfillment-ignite`
 *   · `internal: true`           — `deliverable-grade`
 *   · `client_facing: false`     — `delivery-precondition`
 *
 * So three modules gave three answers about the same task type, and the export comment above
 * `isOperationalTaskType` — "two copies of this regex would drift" — was right about the mechanism
 * and wrong about how many copies there were.
 *
 * MEASURED. `geo-monitor/probe_surface` declares `internal: true`. It is one measurement that feeds
 * `weekly_report`. Because the wrapper saw only the NAME, every run of it reached the client-ready
 * gate and put "not delivered — the summary is written for an operator, not a client" on a founder's
 * timeline. The wedge had already said so; nobody asked it. `deliverable_verdict` is the same from
 * the other direction: the SPINE declares `client_facing: false` and the wrapper wrapped it anyway.
 *
 * One predicate now, reading all three. A declaration beats a name — a prefix is a guess about what
 * an author meant, a flag is the author saying it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isOperationalTaskType } from "../src/deliverables.wrap";

test("A DECLARATION BEATS A NAME", () => {
  // Neither name matches the operational prefix regex; both specs say they are not client work.
  assert.equal(isOperationalTaskType("probe_surface"), false, "the regex alone cannot know");
  assert.equal(isOperationalTaskType("probe_surface", { internal: true }), true, "`internal` is ignored");
  assert.equal(isOperationalTaskType("deliverable_verdict", { client_facing: false }), true, "`client_facing` is ignored");
});

test("and a name still decides when nothing is declared", () => {
  // The regex covers every type that declares neither, which is most of them.
  assert.equal(isOperationalTaskType("chase_overdue"), true);
  assert.equal(isOperationalTaskType("nudge_open_requests"), true);
  assert.equal(isOperationalTaskType("monthly_close"), false);
  assert.equal(isOperationalTaskType("monthly_close", {}), false, "an empty spec must not flip the answer");
  assert.equal(isOperationalTaskType("monthly_close", null), false);
  assert.equal(isOperationalTaskType("monthly_close", undefined), false);
});

test("A DECLARATION CANNOT ACCIDENTALLY MAKE CLIENT WORK INTERNAL", () => {
  /**
   * The dangerous direction. `internal` is only honoured when it is exactly `true` and
   * `client_facing` only when exactly `false`, so a manifest carrying a string, a 0 or a null does
   * not silently stop a trade delivering — it falls through to the name, which is the behaviour
   * every wedge had before any of this existed.
   */
  for (const junk of ["true", 1, "yes", {}, []] as unknown[]) {
    assert.equal(isOperationalTaskType("monthly_close", { internal: junk }), false, `internal: ${JSON.stringify(junk)}`);
  }
  for (const junk of ["false", 0, null, ""] as unknown[]) {
    assert.equal(
      isOperationalTaskType("monthly_close", { client_facing: junk }),
      false,
      `client_facing: ${JSON.stringify(junk)}`,
    );
  }
  assert.equal(isOperationalTaskType("monthly_close", { client_facing: true }), false);
});

test("EVERY CONSUMER ASKS THE WHOLE QUESTION", () => {
  /**
   * The point of the fix. A module that keeps its own half of the predicate is the drift coming
   * back, and it is invisible until a founder reads "not delivered" about work the manifest already
   * called internal.
   */
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
  const grade = read("../src/deliverable-grade.ts");
  assert.ok(!/spec\.internal \|\| isOperationalTaskType\(name\)/.test(grade), "deliverable-grade kept its own half");
  assert.match(grade, /isOperationalTaskType\(name, spec\)/, "deliverable-grade does not pass the spec");

  const wrap = read("../src/deliverables.wrap.ts");
  assert.match(
    wrap,
    /isOperationalTaskType\(task\.task_type, loaded\?\.manifest\.task_types\?\.\[task\.task_type\]\)/,
    "the wrapper does not pass the spec, which is the bug this whole file is about",
  );
});

test("the internal types in the catalogue mean it", () => {
  /**
   * Read from the manifests rather than listed here, so adding one needs no change to this test —
   * and so a flag added carelessly has to survive being printed next to its own reason.
   */
  const WEDGES = join(import.meta.dirname, "..", "..", "wedges");
  const marked: string[] = [];
  for (const slug of readdirSync(WEDGES).filter((d) => !d.startsWith("."))) {
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(readFileSync(join(WEDGES, slug, "wedge.json"), "utf8")) as Record<string, unknown>;
    } catch {
      continue;
    }
    const types = (raw.task_types ?? {}) as Record<string, Record<string, unknown>>;
    for (const [name, spec] of Object.entries(types)) {
      if (spec?.internal !== true) continue;
      marked.push(`${slug}/${name}`);
      assert.ok(
        typeof spec._comment_internal === "string" && (spec._comment_internal as string).length > 20,
        `${slug}/${name} is marked internal with no reason beside it`,
      );
    }
  }
  assert.ok(marked.length >= 5, `only ${marked.length} internal task types — the declarations were lost`);
});
