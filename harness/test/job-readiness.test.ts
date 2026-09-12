// "Is this job equipped to produce expert work?" — asked before anything runs.
//
// `compile()` answers exactly this and only ever got asked mid-run, one task at a time, arriving as
// a thrown refusal after a founder pressed go. Its own header says the question is answerable "from
// data, before a sandbox boots and before a token is spent", and nothing asked it that way.
//
// `jobReadiness` lives in runtime.ts rather than in a route because `profileSkills` is private
// there, and a second implementation of "what craft does this job actually have" is how a readiness
// screen ends up disagreeing with what happens when you press the button.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { loadWedge } from "../src/wedge";
import { jobReadiness } from "../src/runtime";

const ceilings = { maxRuntimeS: 10_800, maxCostUsd: 50 };

test("every client-facing job we ship is equipped", () => {
  const bad: string[] = [];
  let checked = 0;
  for (const slug of readdirSync(new URL("../../wedges/", import.meta.url).pathname)) {
    const w = loadWedge(slug);
    if (!w) continue;
    for (const [taskType, spec] of Object.entries(w.manifest.task_types ?? {})) {
      if ((spec as { internal?: boolean })?.internal) continue;
      checked++;
      const r = jobReadiness({ wedge: w, taskType, ceilings });
      if (!r.ok) bad.push(`${slug}/${taskType}: ${r.refusals.map((x) => x.code).join(", ")}`);
    }
  }
  assert.ok(checked > 40, `only checked ${checked} jobs — the sweep is not seeing the wedges`);
  assert.deepEqual(bad, [], `jobs that would refuse at run time:\n  ${bad.join("\n  ")}`);
});

test("a job with no definition of done is refused", () => {
  // The bar is not "does it run". An expert knows when the month is closed; a job with no output
  // schema cannot know, and produces work that LOOKS finished.
  const w = loadWedge("books-keeper");
  assert.ok(w);
  const stripped = {
    ...w,
    manifest: {
      ...w.manifest,
      task_types: { ...w.manifest.task_types, monthly_close: { ...(w.manifest.task_types as never)["monthly_close"], output_schema: undefined } },
    },
  } as typeof w;
  const r = jobReadiness({ wedge: stripped, taskType: "monthly_close", ceilings });
  assert.equal(r.ok, false, "a job with no output schema was reported as equipped");
  assert.ok(r.refusals.some((x) => x.code === "no_definition_of_done"), JSON.stringify(r.refusals));
});

test("a job with no written craft is refused", () => {
  const w = loadWedge("books-keeper");
  assert.ok(w);
  const r = jobReadiness({ wedge: { ...w, skills: [] } as typeof w, taskType: "monthly_close", ceilings });
  assert.equal(r.ok, false, "a job with no craft was reported as equipped");
  assert.ok(
    r.refusals.some((x) => x.code === "no_craft" || x.code === "no_human_ceiling"),
    JSON.stringify(r.refusals),
  );
});

test("missing access is NOT a readiness failure", () => {
  // The run path deliberately reports a capability gap rather than refusing: a client mid-onboarding
  // with two connections out of five is not a broken service. A readiness panel that said otherwise
  // would tell founders their business is unequipped when what they need is to finish connecting.
  const w = loadWedge("books-keeper");
  assert.ok(w);
  const r = jobReadiness({ wedge: w, taskType: "monthly_close", ceilings });
  assert.ok(!r.refusals.some((x) => x.code === "missing_access"), "a connection gap leaked into readiness");
});

test("an internal step is not held to a client-facing bar", () => {
  // Machinery. No client opens its output, and grading it fills the screen with rows nobody can act
  // on — the fastest way to make a quality panel ignorable.
  const w = loadWedge("books-keeper");
  assert.ok(w);
  const internal = Object.entries(w.manifest.task_types ?? {}).find(
    ([, s]) => (s as { internal?: boolean })?.internal,
  );
  if (!internal) return; // this wedge declares none; the route filters them either way
  assert.equal(jobReadiness({ wedge: w, taskType: internal[0], ceilings }).ok, true);
});
