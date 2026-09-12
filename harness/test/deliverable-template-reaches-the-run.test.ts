// ═══════════════════════════════════════════════════════════════════════════════════════════════
// A TEMPLATE NOTHING POINTS AT IS A TEMPLATE THE MODEL SKIMS
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//
// The lesson is already paid for. `craft:presenting-work` sat mounted on every deliver run saying
// "self-contained HTML is the default", the prompt named no format at all, and production held
// 4,923 `.txt`, 2,045 `.md` and ZERO `.html`. Mounting a file is not telling a run to read it.
//
// So the shape has two halves and both are asserted here: it must be WRITTEN into the session, and
// AGENTS.md must name it. Either alone is the failure this repo keeps paying for — a mount nobody
// reads, or a pointer to a file that is not there, which teaches the model that the index lies.

import test from "node:test";
import assert from "node:assert/strict";
import { buildAgentsMdForTest } from "../src/runtime";
import { SHAPE_SKILL_FILE, deliverableShapeAsSkill, readDeliverableShape } from "../src/deliverable-shape";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadWedge } from "../src/wedge";
import { resolveHarnessProfile } from "../src/harness";
import type { Task } from "../src/contract";

const CEILINGS = { maxRuntimeS: 3600, maxCostUsd: 50 };
const WEDGES = join(import.meta.dirname, "..", "..", "wedges");

function taskOf(wedge: string, task_type: string): Task {
  return {
    id: "t1", project_id: "p1", wedge, task_type,
    actor: { kind: "system", id: "test" }, input: {},
    constraints: { max_runtime_s: 3600, max_cost_usd: 50, approval_required: false },
    tools: [], status: "queued", cost_usd: 0,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  } as Task;
}

/** The page the runtime would mount, built the same way the runtime builds it. */
function shapeMount(wedgeName: string, taskType: string) {
  const wedge = loadWedge(wedgeName)!;
  const declared = wedge.manifest.task_types?.[taskType]?.deliverable_shape;
  const page = deliverableShapeAsSkill(readDeliverableShape(declared));
  return page ? [{ name: SHAPE_SKILL_FILE, content: page }] : [];
}

test("a deliver run whose task type declares a shape is told to follow it, by filename", () => {
  const wedge = loadWedge("geo-monitor")!;
  const task = taskOf("geo-monitor", "weekly_report");
  const profile = resolveHarnessProfile({ task, wedge, ceilings: CEILINGS });
  assert.equal(profile.shape, "deliver", "weekly_report is the deliver run this test is about");

  const mounted = shapeMount("geo-monitor", "weekly_report");
  assert.equal(mounted.length, 1, "the runtime would mount nothing — the template never reaches the box");

  const md = buildAgentsMdForTest(
    task, wedge, [], profile, undefined, undefined, undefined, undefined, [], mounted,
  );
  assert.ok(md.includes(SHAPE_SKILL_FILE), `AGENTS.md never names ${SHAPE_SKILL_FILE} — the mount is unread`);
  // Not just named: named as authoritative about order. "Here is a file" and "follow this order"
  // are different instructions, and only the second stops a run redesigning the document.
  assert.match(md, /sections, in that order/i, "AGENTS.md names the file without saying it is the order to follow");
});

test("a deliver run with no declared shape is told nothing about one", () => {
  /**
   * An INLINE wedge, because there is no shipped one left to use — every `deliver` task type in
   * every wedge now declares a shape, which is the point of the pass and also removes the fixture.
   *
   * The first version of this test reached for `product-builder/design_identity` and passed while
   * asserting nothing: that task type does not resolve to `deliver`, so the branch under test was
   * never entered. It survived making the pointer unconditional — a test that cannot fail when the
   * behaviour it names is broken, which is the only kind worth deleting.
   */
  const wedge = {
    manifest: {
      wedge: "unwritten-trade",
      fulfillment: { deliverable_shapes: ["document"] },
      task_types: {
        produce_the_thing: {
          harness: { shape: "deliver" },
          description: "Produce the client's work for a trade whose format nobody has written down.",
        },
      },
    } as never,
    dir: "/tmp", skills: [], knowledge: [], exemplars: [],
  };
  const task = taskOf("unwritten-trade", "produce_the_thing");
  const profile = resolveHarnessProfile({ task, wedge, ceilings: CEILINGS });
  assert.equal(profile.shape, "deliver", "the fixture must be a deliver run or this asserts nothing");

  const md = buildAgentsMdForTest(
    task, wedge, [], profile, undefined, undefined, undefined, undefined, [], [],
  );
  // Silence, not a guess. Pointing at a file this run was never given is worse than saying nothing:
  // the model learns the index lies, and the next real pointer gets skimmed with it.
  assert.ok(!md.includes(SHAPE_SKILL_FILE), "AGENTS.md points at a template this run was never given");
  // And it still gets the general rule, which is what carries a trade whose format we do not know.
  assert.match(md, /craft:presenting-work/, "a run with no template lost the craft doc too");
});

test("the shape page and the pointer cannot drift apart", () => {
  // One constant, three writers: the runtime mount, wedgeauthor's mount, and the AGENTS.md pointer.
  // Read as source because the assertion is about the literal, which is the thing that drifts.
  const src = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
  for (const f of ["../src/runtime.ts", "../src/wedgeauthor.ts"]) {
    const body = src(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.ok(
      !body.includes('"the-shape-of-the-finished-work.md"'),
      `${f} hardcodes the shape filename instead of importing SHAPE_SKILL_FILE`,
    );
  }
});

test("every shipped deliver run declares what its artefact looks like", () => {
  /**
   * The population is complete as of this pass — seven of seven — so this is the `ship_requires`
   * argument applied to the template: it stops nothing that works today, and it stops the next
   * job that ships without one.
   *
   * A commit-time invariant rather than a compile-time refusal, deliberately. Missing a shape is a
   * MANIFEST AUTHORING mistake, and the person who can fix it is reading a test failure, not a
   * production run's timeline. A runtime refusal would also strand every AI-authored service whose
   * draft omitted the field — a gate with no door, which this repo has already built once.
   */
  const unwritten: string[] = [];
  for (const dir of readdirSync(WEDGES).filter((d) => !d.startsWith("."))) {
    const wedge = loadWedge(dir);
    if (!wedge) continue;
    for (const [taskType, def] of Object.entries<any>(wedge.manifest.task_types ?? {})) {
      const task = taskOf(dir, taskType);
      if (resolveHarnessProfile({ task, wedge, ceilings: CEILINGS }).shape !== "deliver") continue;
      if (!readDeliverableShape(def?.deliverable_shape)) unwritten.push(`${dir}/${taskType}`);
    }
  }
  assert.deepEqual(
    unwritten,
    [],
    "these runs produce the thing a client pays for and re-invent its layout every time: " + unwritten.join(", "),
  );
});
