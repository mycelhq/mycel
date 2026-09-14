// THE THREE HALVES THAT HAVE TO SHIP TOGETHER.
//
// `memory.ts` was reverted an hour after it first landed, and correctly: `connectivity.test.ts`
// counted symbols reachable only from tests and it had gone 28 → 31. The commit that pulled it
// states the condition for its return in one line — "it comes back when the store and the write
// path come with it" — because a memory system with no writer is not a partial feature. It is a
// spec with a passing test suite, which looks MORE finished than dead code while proving nothing.
//
// So this file asserts the LOOP, not the functions. `memory.test.ts` next door owns the pure parts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { inMonorepo, ONLY_IN_MONOREPO } from "./_monorepo";
import {
  MEMORY_MAX_BYTES,
  getMemoryStore,
  recallForRun,
  rememberFromRun,
  resetMemoryStoreForTests,
} from "../src/memory";

const P = "proj_1";
/*
  COMMENTS STRIPPED BEFORE ANYTHING IS ASSERTED, and this file is the second one to need it.

  The first version matched `/MYCEL_MEMORY_URL/` against the whole of runtime.ts. Deleting the line
  that injects it left the test GREEN — because the comment three lines above, explaining why the
  address matters, still contained the string. A guard that its own subject's prose can satisfy is
  a guard that proves nothing, and the sabotage check is the only reason that was ever discovered.
*/
const code = (p: string) =>
  readFileSync(new URL(p, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
const runtime = code("../src/runtime.ts");
const server = code("../src/server.ts");
/**
 * `infra/` is not in the open-source distribution, so this read only works in the monorepo.
 *
 * It used to catch and fall back to `""`, and the one assertion that uses it was written
 * `if (tf) assert.match(…)`. That is a SILENT partial skip: the published suite printed the test as
 * a pass while three of its four assertions ran. `_monorepo.ts` argues the case against exactly
 * this — "a guard that reports success when it measured nothing is the failure mode this repo keeps
 * writing tests to avoid" — and seven other files already follow it. The ALB check is its own test
 * now, skipped by name and with a reason, so the published suite is green AND says what it did not
 * look at.
 */
const infraTf = (): string => readFileSync(new URL("../../../infra/sandbox.tf", import.meta.url), "utf8");

test("a run writes, and the next run recalls it", async () => {
  resetMemoryStoreForTests();
  const w = await rememberFromRun({ project_id: P, path: "clients/acme.md", body: "# Acme\n\nFinance contact is Dana." });
  assert.ok(w.ok, "the write was refused");
  const back = await recallForRun(P, "acme finance");
  assert.equal(back.length, 1);
  assert.match(back[0]!.body, /Dana/);
});

test("ONE BUSINESS CANNOT RECALL ANOTHER'S", async () => {
  /**
   * Not "denied" — unreachable. Every read resolves inside the project's own map, the same shape
   * `getRequest` uses, so a path from another tenant reads as absent rather than as a row somebody
   * remembered to filter.
   */
  resetMemoryStoreForTests();
  await rememberFromRun({ project_id: "proj_a", path: "clients/acme.md", body: "# Acme\n\nSecret." });
  assert.deepEqual(await recallForRun("proj_b", "acme"), []);
  assert.equal(await getMemoryStore().read("proj_b", "clients/acme.md"), undefined);
});

test("writing the same path again is an edit, never a second document", async () => {
  resetMemoryStoreForTests();
  await rememberFromRun({ project_id: P, path: "clients/acme.md", body: "# Acme\n\nContact is Dana." });
  await rememberFromRun({ project_id: P, path: "clients/acme.md", body: "# Acme\n\nContact is Priya now." });
  const all = await getMemoryStore().list(P);
  assert.equal(all.length, 1, "correcting a note created a second one");
  assert.match(all[0]!.body, /Priya/);
});

test("A TRANSCRIPT IS REFUSED", async () => {
  /**
   * A run that writes its context window into the vault is not misbehaving, it is a model doing
   * what models do — and the next run pays for it in retrieved tokens forever.
   */
  resetMemoryStoreForTests();
  const r = await rememberFromRun({ project_id: P, path: "knowledge/x.md", body: "x".repeat(MEMORY_MAX_BYTES + 1) });
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /transcript/);
});

test("a path from model output cannot escape its own drawer", async () => {
  resetMemoryStoreForTests();
  for (const bad of ["../../etc/passwd", "clients/../../x.md", "nope/x.md", "clients/x.txt", "clients/a/b.md"]) {
    const r = await rememberFromRun({ project_id: P, path: bad, body: "# x\n\nbody" });
    assert.equal(r.ok, false, `${bad} was accepted`);
  }
});

test("THE TIMELINE GRAIN IS THE CLOCK'S DECISION, NOT THE AGENT'S", async () => {
  /**
   * An agent asked to choose the filename writes `timeline/today.md`, or a new dated file every day
   * forever until the drawer holds 365 documents of one line each. `timeline` on its own is the
   * supported spelling and the age of the event picks the bucket — which is also why nothing has to
   * schedule a coarsening pass.
   */
  resetMemoryStoreForTests();
  const recent = await rememberFromRun({ project_id: P, path: "timeline", body: "# Today\n\nSent the close." });
  assert.ok(recent.ok && /^timeline\/\d{4}-\d{2}-\d{2}\.md$/.test(recent.doc.path), `daily bucket expected, got ${recent.ok && recent.doc.path}`);

  const old = await rememberFromRun({
    project_id: P,
    path: "timeline",
    at: new Date(Date.now() - 200 * 86_400_000).toISOString(),
    body: "# Back then\n\nFirst engagement.",
  });
  assert.ok(old.ok && /^timeline\/\d{4}-\d{2}\.md$/.test(old.doc.path), `monthly bucket expected, got ${old.ok && old.doc.path}`);
});

test("A MATCH PULLS IN WHAT IT LINKS TO, ONE HOP", async () => {
  /**
   * The half that makes wiki-links worth having. A note about an engagement says the client is
   * `[[acme]]`; a query about the engagement matches the engagement and not the client, because the
   * client's name may appear nowhere in the query. Without following the link the run gets the half
   * of the picture that happened to share vocabulary with the task description.
   */
  resetMemoryStoreForTests();
  await rememberFromRun({ project_id: P, path: "clients/acme.md", body: "# Acme\n\nWants the P&L split by region." });
  await rememberFromRun({ project_id: P, path: "engagements/q3-close.md", body: "# Q3 close\n\nFor [[acme]]. Statement arrives late." });

  const back = await recallForRun(P, "q3 close");
  const paths = back.map((d) => d.path);
  assert.ok(paths.includes("engagements/q3-close.md"), "the direct match is missing");
  assert.ok(paths.includes("clients/acme.md"), "the linked client was not followed");
  assert.ok(
    paths.indexOf("engagements/q3-close.md") < paths.indexOf("clients/acme.md"),
    "a linked document displaced the direct match it was reached through",
  );
});

test("THE WRITE PATH EXISTS, IS ADDRESSED, AND IS REACHABLE FROM A SANDBOX", () => {
  /**
   * Three separate things, and the memory module has already been reverted once for having none of
   * them. A route with no address in the sandbox is the `/v1/internal/artifacts` failure — live,
   * referenced in a comment three files away, unreachable for weeks. A route with an address but no
   * ALB rule is the `/v1/internal/gate` failure — the deny answers 404, which fails safe and reads
   * to the agent exactly like a founder declining.
   */
  assert.match(server, /app\.post\("\/v1\/internal\/memory\/write"/, "the route is gone");
  assert.match(server, /rememberFromRun\(/, "the route no longer writes anything");
  /*
    `env.MYCEL_MEMORY_URL =`, not the bare name. The name appears TWICE in runtime.ts — once as the
    env injection and once inside the curl example the prompt shows the agent — so a bare match
    stayed green with the injection deleted. Two facts, two assertions: the sandbox is given the
    address, and the agent is told what to do with it.
  */
  assert.match(runtime, /env\.MYCEL_MEMORY_URL\s*=/, "the sandbox is never given the address");
  assert.match(runtime, /\$MYCEL_MEMORY_URL/, "the prompt no longer shows the agent the call");
  // This one is prose the agent reads, so it survives comment-stripping as a string literal.
  assert.match(runtime, /Write down what you learned/, "the agent is never told the tool exists");
});

test("the edge admits the memory path at all", { skip: inMonorepo() ? false : ONLY_IN_MONOREPO }, () => {
  // The other half of the loop, and the half that has broken before: the ALB allowlist 404s a path
  // the kernel serves perfectly well, so every assertion above can be true and nothing reaches it.
  assert.match(infraTf(), /"\/v1\/internal\/memory\/write"/, "the ALB does not admit the path");
});

test("RECALL IS READ AFTER THE RULES, AND THE ORDER IS THE SAFETY PROPERTY", () => {
  /**
   * Rules are what a human corrected on real work and they bind. Memory is what the agent wrote for
   * itself and it binds nothing. Whatever a model reads last, closest to the task, is what it
   * weighs most — so putting recall above the rules would quietly invert that, silently.
   */
  const rules = runtime.indexOf("## What this business has taught you");
  const recall = runtime.indexOf("if (recalled) {");
  assert.ok(rules > 0 && recall > 0, "one of the two sections has moved");
  assert.ok(rules < recall, "recall is now rendered above the rules it must not outrank");
});
