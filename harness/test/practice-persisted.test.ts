import { test } from "node:test";
import assert from "node:assert/strict";
import { api, makeApp, waitTask } from "./helpers";
import { PRACTICE_COLLECTION } from "../src/practice.ts";

/**
 * ═══ THE RUN FINISHED AND FILED NOTHING ═══
 *
 * `draft_practice` reads the work a founder uploaded and derives how they practise. It ran, it
 * validated against its schema, it charged, and its output went into an artifact and nowhere else.
 * `practiceSkills` found no record, mounted nothing, and every delivery run fell back to the wedge
 * exactly as if the derivation had never happened.
 *
 * The task said `succeeded` the entire time. No test failed. It was found by running the thing
 * against a real model and then looking for the row.
 *
 * `practice-wired.test.ts` pins the call INTO the run. This pins the write OUT of it, which is the
 * half that was actually missing. A capability with an entrance and no exit is the defect this repo
 * keeps finding, and it is invisible from either side alone.
 */
test("a finished draft_practice leaves a practice record behind", async () => {
  const { app } = makeApp();

  // A case, for its project. Projects come from the key's scope rather than a POST — same shape
  // `batches.test.ts` uses to get a real project id.
  const kase = (await api(app, "cases", {
    method: "POST",
    body: JSON.stringify({ wedge: "business-shaper", title: "practice" }),
  })).json as { project_id: string };
  assert.ok(kase?.project_id, "could not open a case");

  const H = { "x-mycel-project": kase.project_id };

  // The exemplar the derivation reads. Stored exactly as onboarding stores it.
  await api(app, "records", {
    method: "POST",
    headers: H,
    body: JSON.stringify({
      wedge: "business-shaper",
      collection: "exemplar",
      key: "month-end.md",
      data: { name: "October month-end", text: "The accounts balance. £2,140 is unexplained." },
    }),
  });

  const created = await api(app, "tasks", {
    method: "POST",
    headers: H,
    body: JSON.stringify({
      wedge: "business-shaper",
      task_type: "draft_practice",
      actor: { kind: "system", id: "test" },
      input: { exemplar: "October month-end" },
    }),
  });
  assert.equal(created.status, 201, created.text);

  const done = await waitTask(app, (created.json as { id: string }).id, 15_000);
  assert.equal(done.status, "succeeded", `the run did not finish: ${JSON.stringify(done).slice(0, 300)}`);

  const rows = (await api(
    app,
    `records?wedge=business-shaper&collection=${PRACTICE_COLLECTION}&limit=1`,
    { headers: H },
  )).json as { data?: Record<string, unknown> }[];

  assert.equal(rows.length, 1, "the run succeeded and filed nothing — the exit is missing again");
  assert.ok(rows[0]?.data?.practice, "the record exists but carries no practice");
  /*
   * NOT stamped by the run. A derivation is a hypothesis until the founder reads it back, and
   * `practice.ts` mounts an unconfirmed one as a prior rather than as house rule. If a run ever
   * starts confirming its own inference, this fails.
   */
  assert.equal(rows[0]?.data?.confirmed_at, undefined, "a run must not confirm its own inference");
});
