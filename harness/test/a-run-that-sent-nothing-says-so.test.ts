/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * "DONE", ON A RUN THAT HANDED NOTHING OVER
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Opened a run on the demo. The header said DONE. Its own timeline, four lines up, said:
 *
 *     not delivered — the run named what it still needs from the client
 *
 * Both true. A run that discovers a missing input, writes down what it needs and parks the
 * engagement has SUCCEEDED — it did everything available to it — so the task status is right. Read
 * together they say a finished job, which is the one thing that did not happen.
 *
 * `orchestrator.ts` emits that sentence from three places and the console had no way to know it. A
 * FLAG rather than matching the `not delivered — ` prefix: a prefix in free prose is a contract
 * nobody declared, and the next person to reword the sentence would silently turn the signal off.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildTrace } from "../src/traces";

let seq = 0;
const ev = (type: string, data: Record<string, unknown> = {}) =>
  ({ task_id: "t1", seq: ++seq, type, ts: "2026-09-14T09:00:00.000Z", data }) as never;

test("A DECLINED DELIVERY SURVIVES THE FOLD, WITH ITS REASON", () => {
  const trace = buildTrace([
    ev("task.started"),
    ev("progress", { note: "not delivered — no accounting system is connected", delivered: false }),
    ev("task.finished", { status: "succeeded" }),
  ]);
  assert.equal(trace.not_delivered?.reason, "no accounting system is connected", "the reason did not survive");
});

test("the prefix is stripped, because the console does not repeat the label", () => {
  // The pill says "nothing sent"; the tooltip carries the reason. Leaving "not delivered — " on the
  // front would render "nothing sent / not delivered — no bank feed".
  const trace = buildTrace([
    ev("task.started"),
    ev("progress", { note: "not delivered — no bank feed", delivered: false }),
    ev("task.finished", { status: "succeeded" }),
  ]);
  assert.equal(trace.not_delivered?.reason, "no bank feed");
});

test("AN ORDINARY RUN IS NOT MARKED, AND THAT IS NOT THE SAME AS DELIVERED", () => {
  /*
    Undefined means the run never reached the client-facing verdict at all. Only a run that got there
    and declined sets this, so the console must not read absence as a claim either way.
  */
  const trace = buildTrace([
    ev("task.started"),
    ev("progress", { note: "wrote the summary" }),
    ev("task.finished", { status: "succeeded" }),
  ]);
  assert.equal(trace.not_delivered, undefined);
});

test("THE LAST VERDICT WINS", () => {
  // A run can decline, be steered, and then deliver. The final decision is the one that happened.
  const trace = buildTrace([
    ev("task.started"),
    ev("progress", { note: "not delivered — no bank feed", delivered: false }),
    ev("progress", { note: "not delivered — still nothing to reconcile", delivered: false }),
    ev("task.finished", { status: "succeeded" }),
  ]);
  assert.equal(trace.not_delivered?.reason, "still nothing to reconcile");
});

test("a note with no reason still says something", () => {
  // `delivered: false` with an empty note is a malformed emission, and "nothing sent" with a blank
  // tooltip is worse than the pill it replaced.
  const trace = buildTrace([
    ev("task.started"),
    ev("progress", { delivered: false }),
    ev("task.finished", { status: "succeeded" }),
  ]);
  assert.equal(trace.not_delivered?.reason, "the run did not say why");
});

test("EVERY PLACE THAT DECLINES SETS THE FLAG", () => {
  /**
   * The structural half. Three call sites emit `not delivered — …`, and one of them forgetting the
   * flag is a run that silently goes back to reading DONE — invisible, because the timeline still
   * says the right thing and only the header lies.
   */
  const src = readFileSync(new URL("../src/orchestrator.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");
  const declines = [...src.matchAll(/not delivered —/g)].length;
  assert.ok(declines >= 3, `expected at least three decline sites, found ${declines}`);
  const flagged = [...src.matchAll(/delivered: false/g)].length;
  assert.equal(flagged, declines, `${declines} places decline and ${flagged} set the flag`);
});
