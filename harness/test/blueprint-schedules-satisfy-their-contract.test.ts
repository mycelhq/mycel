// EVERY SCHEDULE A BLUEPRINT CREATES MUST BE ABLE TO PRODUCE A VALID TASK.
//
// ═══ WHAT THIS FOUND WHEN IT WAS FIRST RUN ═══
//
// Two of the nine shipped schedule templates violated their own task type's declared contract, and
// they were the two highest-volume jobs in the product:
//
//   · `books-keeper/monthly_close` — scheduled with `input: {}` while declaring `period` REQUIRED,
//     with a description that reads "a close with no period is a close of nothing, and production
//     runs have failed asking for exactly this after spending a sandbox to discover it." 3,077 runs
//     across two engagements in a fortnight, one every 31 minutes.
//   · `geo-monitor/weekly_report` — declaring `client` required, and NEITHER path that creates the
//     task supplies one. The blueprint sends an empty input; fulfillment ignition sends
//     `{ because, scheduled_at }` and carries the client as a task FIELD.
//
// Neither was a model failure and neither was a bug in any function. `inputFaults` was correct,
// `fireSchedule` was correct, the manifests were thorough — and the only thing joining them was an
// assumption nobody had checked. That is the exact shape this repo keeps finding in itself, so the
// check has to live somewhere it runs on every commit rather than in somebody's memory.
//
// ═══ WHY THE PRODUCT'S OWN VALIDATOR AND NOT A HAND-ROLLED ONE ═══
//
// It calls `inputFaults` and `fillScheduleInput` — the same two functions `fireSchedule` calls, in
// the same order, with the same fixed fields stamped on. A test that reimplemented the check could
// pass while production refused, which is worse than no test: it would be evidence for a claim that
// is false.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { inputFaults } from "../src/input-contract";
import { fillScheduleInput } from "../src/schedule-input";

const ROOT = join(import.meta.dirname, "../..");

interface Template {
  blueprint: string;
  wedge: string;
  task_type: string;
  name: string;
  input?: Record<string, unknown>;
}

function templates(): Template[] {
  const out: Template[] = [];
  for (const f of readdirSync(join(ROOT, "library", "blueprints"))) {
    if (!f.endsWith(".json")) continue;
    const b = JSON.parse(readFileSync(join(ROOT, "library", "blueprints", f), "utf8"));
    const wedge = b.wedge ?? f.replace(/\.json$/, "");
    for (const s of b.schedules ?? []) {
      out.push({ blueprint: f, wedge, task_type: s.task_type, name: s.name ?? s.task_type, input: s.input });
    }
  }
  return out;
}

function manifest(wedge: string): { task_types?: Record<string, { input_schema?: unknown }> } | undefined {
  const p = join(ROOT, "wedges", wedge, "wedge.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : undefined;
}

test("EVERY BLUEPRINT SCHEDULE CAN PRODUCE A TASK ITS OWN TASK TYPE ACCEPTS", () => {
  const now = new Date("2026-09-01T09:00:00Z");
  const bad: string[] = [];

  for (const t of templates()) {
    const declared = manifest(t.wedge)?.task_types?.[t.task_type];
    // No declared contract means no opinion — `inputFaults` refuses to invent one, and so does this.
    if (!declared?.input_schema) continue;

    // Exactly what `fireSchedule` builds, in the same order: tokens filled first so a template can
    // never shadow the fixed fields with one of its own.
    const input = {
      ...fillScheduleInput(t.input, now),
      scheduled_at: now.toISOString(),
      schedule_id: "s1",
      schedule_name: t.name,
    };
    const faults = inputFaults(input, declared.input_schema);
    if (faults.length) bad.push(`${t.blueprint} → ${t.wedge}/${t.task_type} ("${t.name}"): ${faults.join("; ")}`);
  }

  assert.deepEqual(
    bad,
    [],
    "a shipped schedule cannot produce a valid task, so every one of its firings will refuse:\n  " +
      bad.join("\n  ") +
      "\n\nFix the TEMPLATE, not this test. If the field is derivable from the clock, use a token from " +
      "`schedule-input.ts`. If it is something only the run can know — a client's own name for their " +
      "brand — it belongs out of `required` with the argument written down, as `monthly_close.currency` does.",
  );
});

test("a schedule that names a token names one that exists", () => {
  /**
   * An unknown token is deliberately left ALONE by `fillScheduleInput` rather than blanked, because
   * a schema violation naming the field beats a close of the literal string `{{munth_ended}}`. That
   * is the right RUNTIME behaviour and it is a poor authoring experience, so the typo is caught
   * here instead — where the message can say which file.
   */
  const known = new Set(["month_ended", "this_month", "week_ended", "today", "quarter_ended"]);
  const bad: string[] = [];
  for (const t of templates()) {
    for (const [k, v] of Object.entries(t.input ?? {})) {
      if (typeof v !== "string") continue;
      const m = /^\{\{\s*([a-z_]+)\s*\}\}$/.exec(v.trim());
      if (m && !known.has(m[1]!)) bad.push(`${t.blueprint} → ${t.task_type}.${k} uses unknown token {{${m[1]}}}`);
    }
  }
  assert.deepEqual(bad, [], bad.join("\n"));
});

test("the scheduler fills tokens and checks the contract, in that order", () => {
  /**
   * The wiring assertion. Both halves are useless alone: filling without checking is what shipped
   * for a fortnight, and checking without filling would refuse every template that uses a token —
   * which, after this change, is the one that carries the close.
   */
  const src = readFileSync(join(import.meta.dirname, "../src/scheduler.ts"), "utf8");
  const fill = src.indexOf("fillScheduleInput(s.input, now)");
  const check = src.indexOf("const faults = inputFaults(");
  const mint = src.indexOf("const task = makeTask();\n  await store.createTask(task);");

  assert.ok(fill > 0, "fireSchedule no longer fills schedule tokens");
  assert.ok(check > 0, "fireSchedule no longer checks the input contract — the 3,077-run path is open again");
  assert.ok(check < mint, "the contract is checked after the task is created, which is too late");
});
