/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * "NOTHING HAS RUN YET", BESIDE "1,740 JOBS RUN", ON THE SAME SCREEN
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Seen on the demo, 14 September. Home's "Recent work" said the business had never run anything,
 * directly under its own stat saying it had run 1,740 jobs. Both came from the kernel and only one
 * was true.
 *
 * `GET /v1/tasks?limit=25` fetched `limit * 4` of the newest rows ACROSS EVERY TENANT and filtered to
 * the caller's projects afterwards. The multiplier is a guess at how much over-fetch is enough, and
 * it fails exactly when the installation is busiest. Measured against production: of the 100 most
 * recent tasks installation-wide, `default` owned 75 and `Northstar Creative` 24. The showroom, with
 * 1,987 tasks of its own, got ZERO.
 *
 * ═══ IT GETS WORSE WITH EVERY CUSTOMER ═══
 *
 * That is the part that makes this a launch blocker rather than a demo blemish. The failure is a
 * function of how many OTHER tenants are active, so it is invisible on a quiet box, arrives without
 * any change to the code, and deepens as the product succeeds. Five call sites had it, and two are
 * on the onboarding path — `business-shape.ts` looking for the founder's own `draft_shape`, and
 * `authored.routes.ts` looking for the run that is writing their service. On a launch day with real
 * signups those are the two that fail first.
 *
 * ═══ THE REMEDY WAS ALREADY WRITTEN DOWN ═══
 *
 * `listTasks` has taken `project_ids` for a while, and the comment on that parameter names this bug
 * exactly: *"a busy neighbour fills the window and a small customer's own rows never appear in it.
 * `countTasksSince` above carries the same warning about the same bug, fixed there and not here."*
 * Somebody found it, documented it, fixed one call site, and left the rest.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { InMemoryStore } from "../src/store";

const SRC = join(import.meta.dirname, "..", "src");

/** One task row, dated so ordering is deterministic. */
const task = (project_id: string, n: number) => ({
  id: `${project_id}-${n}`,
  project_id,
  wedge: "books-keeper",
  task_type: "monthly_close",
  status: "succeeded" as const,
  input: {},
  created_at: new Date(Date.UTC(2026, 8, 1, 0, n)).toISOString(),
});

test("A NOISY NEIGHBOUR CANNOT EMPTY YOUR WINDOW", async () => {
  const store = new InMemoryStore();
  // Theirs are all NEWER, which is the production shape: one busy tenant owns the recent window.
  await store.createTask(task("quiet-tenant", 0) as never);
  for (let i = 1; i <= 60; i++) await store.createTask(task("loud-tenant", i) as never);

  const mine = await store.listTasks({ project_ids: ["quiet-tenant"], limit: 25 });
  assert.equal(mine.length, 1, "the quiet tenant's own row was crowded out of its own window");
  assert.equal(mine[0]!.project_id, "quiet-tenant");

  // And the unscoped read is what the route used to do — kept as the contrast, so the test says why.
  const unscoped = (await store.listTasks({ limit: 25 })).filter((t) => t.project_id === "quiet-tenant");
  assert.equal(unscoped.length, 0, "the fixture no longer reproduces the bug — the contrast is gone");
});

test("scoping narrows and never invents", async () => {
  const store = new InMemoryStore();
  for (let i = 1; i <= 5; i++) await store.createTask(task("a", i) as never);
  for (let i = 1; i <= 5; i++) await store.createTask(task("b", i + 10) as never);
  const a = await store.listTasks({ project_ids: ["a"], limit: 50 });
  assert.equal(a.length, 5);
  assert.ok(a.every((t) => t.project_id === "a"), "a scoped read returned another tenant's rows");
  const both = await store.listTasks({ project_ids: ["a", "b"], limit: 50 });
  assert.equal(both.length, 10, "a caller with two projects must see both");
});

test("NO CALLER FETCHES GLOBALLY AND FILTERS BY PROJECT AFTERWARDS", () => {
  /**
   * The structural guard, because this is a class and not an incident. Five call sites had it and
   * each was invisible until the installation got busy enough — which no test on a fresh store will
   * ever be.
   *
   * The shape: a `listTasks` call with no `project_ids`, followed within a few lines by a filter on
   * `project_id`. That is fetch-then-discard, and the rows discarded are the ones that were never
   * fetched.
   */
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== "graphify-out") walk(p);
      } else if (p.endsWith(".ts")) {
        const src = readFileSync(p, "utf8");
        for (const m of src.matchAll(/listTasks\(\s*\{([^}]*)\}/g)) {
          if (/project_ids/.test(m[1]!)) continue;
          // What comes next, in the same statement chain: a `.filter(... project_id ...)` means the
          // caller wanted one tenant and asked for all of them.
          const after = src.slice((m.index ?? 0), (m.index ?? 0) + 320);
          /*
            `[\s\S]{0,90}?`, not `[^)]*`. The first version could not cross the `)` in the arrow
            parameter — every real call site reads `.filter((t) => t.project_id === ...)`, so the
            character class stopped at `(t)` and the guard matched nothing. It passed against both
            sabotages, which is how it was caught: a scanner that cannot see the shape it is looking
            for is worse than no scanner, because it is reported as coverage.
          */
          if (/\.filter\([\s\S]{0,90}?project_id/.test(after)) {
            offenders.push(`${p.slice(SRC.length + 1)} — listTasks({${m[1]!.trim().slice(0, 60)}}) then filters on project_id`);
          }
        }
      }
    }
  };
  walk(SRC);
  assert.deepEqual(
    offenders,
    [],
    `these fetch the newest rows across every tenant and filter afterwards:\n  ${offenders.join("\n  ")}\n` +
      `Pass \`project_ids\` instead — a busy neighbour fills the window and the caller's own rows never appear in it.`,
  );
});
