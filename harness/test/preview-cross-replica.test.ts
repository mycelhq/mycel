// THE PREVIEW COULD NOT WORK IN PRODUCTION, AND THE REASON WAS THE DEPLOYMENT SHAPE.
//
//   · runs execute on the WORKER service (infra/main.tf, worker_count = 2)
//   · `/v1/preview/*` has no ALB listener rule, so it lands on the API service (api_count = 2)
//   · `getRun` is a process-local Map (runregistry.ts says so in its header)
//
// So the handle was absent for every real preview request, and the proxy answered its "the run is
// over" page every time. In local development the API and the worker are one process, so it worked
// perfectly on the machine of anyone who went looking. The founder's verdict was "I have never seen
// the browser preview in my life", and an earlier fix — booting the preview at run start instead of
// on demand — could not have helped: it changes WHEN the worker boots it, not whether the replica
// answering the browser can find it.
//
// These test the seam that fixes it: an address in the shared, TTL'd table both tiers can read.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { clearPreviewTarget, publishPreviewTarget, readPreviewTarget } from "../src/preview-target";

test("an address published by one process is readable by another", async () => {
  await publishPreviewTarget("task-a", { stage: "live", url: "https://sandbox.example/app", token: "tok", port: 4321, startedAt: 1 }, "proj-1");
  const got = await readPreviewTarget("task-a");
  assert.equal(got?.stage, "live");
  assert.equal(got?.url, "https://sandbox.example/app");
  assert.equal(got?.token, "tok", "the Daytona header token must survive, or the proxy gets a 401");
  assert.equal(got?.project_id, "proj-1");
});

test("every rung is published, not only 'live'", async () => {
  // A founder watching from another replica has to see "installing". Publishing only the final
  // state makes a normal two-minute npm install indistinguishable from a run that never started —
  // which is the shape of the original bug, just later in the ladder.
  for (const stage of ["starting", "installing", "booting"] as const) {
    await publishPreviewTarget("task-b", { stage, port: 4321, startedAt: 1 });
    assert.equal((await readPreviewTarget("task-b"))?.stage, stage);
  }
});

test("a failure carries its reason across the replica boundary", async () => {
  await publishPreviewTarget("task-c", { stage: "failed", error: "next: command not found", port: 4321, startedAt: 1 });
  assert.match(String((await readPreviewTarget("task-c"))?.error), /command not found/);
});

test("clearing it is what makes 'finished' honest", async () => {
  // The sandbox dies with the run. A row that outlives it points the proxy at an address that no
  // longer answers, so the founder gets a connection error where the truth is "this run is over".
  await publishPreviewTarget("task-d", { stage: "live", url: "https://gone.example", port: 4321, startedAt: 1 });
  assert.ok(await readPreviewTarget("task-d"));
  await clearPreviewTarget("task-d");
  assert.equal(await readPreviewTarget("task-d"), undefined);
});

test("an unknown task is absent, not an error", async () => {
  assert.equal(await readPreviewTarget("no-such-task"), undefined);
  assert.equal(await readPreviewTarget(""), undefined);
});

test("the routes consult the shared target before declaring the run over", () => {
  const src = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
  assert.match(src, /readPreviewTarget/, "server.ts never reads the shared target");
  assert.match(
    src,
    /if \(!run && !shared\) return page\("finished"\)/,
    "the proxy still calls a missing local handle 'finished' without asking the shared table",
  );
  const runtime = readFileSync(new URL("../src/runtime.ts", import.meta.url), "utf8");
  assert.match(runtime, /publishPreviewTarget/, "the boot ladder never publishes where it got to");
  assert.match(runtime, /clearPreviewTarget\(task\.id\)/, "the row is never cleared when the run ends");
});
