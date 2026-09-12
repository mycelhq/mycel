// The report names the work. This file is the proof that we actually start it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.MYCEL_WEDGES_DIR ??= join(dirname(fileURLToPath(import.meta.url)), "..", "..", "wedges");

import type { Task } from "../src/contract";
import type { Store } from "../src/store";
import {
  pickShipableRecommendation,
  setShipDeps,
  spawnShipFollowOn,
  SHIP_PAGE_TASK_TYPE,
} from "../src/ship-follow-on";

test("pickShipableRecommendation leads with Small and skips Large", () => {
  const rec = pickShipableRecommendation({
    status: "reported",
    client: "Harborline",
    recommendations: [
      { what: "run a pricing survey", effort: "large", why: "original data" },
      { what: "rewrite /pricing opening", effort: "small", why: "answer is in paragraph four" },
      { what: "new comparison page", effort: "medium" },
    ],
  });
  assert.equal(rec?.what, "rewrite /pricing opening");
  assert.equal(rec?.effort, "small");
});

test("pickShipableRecommendation ignores a report that was never a measurement", () => {
  assert.equal(
    pickShipableRecommendation({
      status: "not_set_up",
      recommendations: [{ what: "rewrite /pricing", effort: "small" }],
    }),
    undefined,
  );
});

test("pickShipableRecommendation will not draft a Large-only week", () => {
  assert.equal(
    pickShipableRecommendation({
      status: "reported",
      recommendations: [{ what: "rebuild the IA", effort: "large" }],
    }),
    undefined,
  );
});

function task(over: Partial<Task> = {}): Task {
  return {
    id: "t-report",
    project_id: "p1",
    wedge: "geo-monitor",
    task_type: "weekly_report",
    status: "succeeded",
    created_at: new Date().toISOString(),
    case_id: "c1",
    client_id: "cl1",
    ...over,
  } as Task;
}

function fakeStore(existing: Task[] = []): Pick<Store, "listTasks"> {
  return {
    listTasks: async () => existing,
  };
}

test("spawnShipFollowOn starts ship_page from a reported week, once", async () => {
  const spawned: { task_type: string; case_id?: string; input: Record<string, unknown> }[] = [];
  setShipDeps({
    spawnTask: async (args) => {
      spawned.push(args);
      return "t-ship";
    },
  });
  const id = await spawnShipFollowOn({
    task: task(),
    parsed: {
      status: "reported",
      client: "Harborline",
      recommendations: [{ what: "rewrite /pricing opening", effort: "small" }],
    },
    store: fakeStore() as Store,
  });
  assert.equal(id, "t-ship");
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0]!.task_type, SHIP_PAGE_TASK_TYPE);
  assert.equal(spawned[0]!.case_id, "c1");
  assert.equal((spawned[0]!.input.recommendation as { what: string }).what, "rewrite /pricing opening");
  setShipDeps(null);
});

test("spawnShipFollowOn does not double-draft inside the same week", async () => {
  const spawned: unknown[] = [];
  setShipDeps({
    spawnTask: async () => {
      spawned.push(1);
      return "nope";
    },
  });
  const existing = [
    task({
      id: "t-ship-1",
      task_type: SHIP_PAGE_TASK_TYPE,
      status: "succeeded",
      created_at: new Date().toISOString(),
    }),
  ];
  const id = await spawnShipFollowOn({
    task: task(),
    parsed: {
      status: "reported",
      recommendations: [{ what: "rewrite /pricing opening", effort: "small" }],
    },
    store: fakeStore(existing) as Store,
  });
  assert.equal(id, undefined);
  assert.equal(spawned.length, 0);
  setShipDeps(null);
});
