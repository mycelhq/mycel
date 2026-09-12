// A CHALLENGER ON THE SHELF — the overlay half of a trial, where the wrong default is silent.
//
// `overlayPlaybooks` decides which text every run reads. A trial makes that decision depend on which
// arm the run is in, and every mistake available here is invisible at the time: the agent reads
// *something*, produces *something*, and the damage shows up weeks later as evidence attributed to
// the wrong version.

import { test } from "node:test";
import assert from "node:assert/strict";
import { overlayPlaybooks, playbookChallenger } from "../src/playbooks";

const disk = [{ name: "close-review.md", content: "SHIPPED" }];
const overlay = (content: string, metadata: Record<string, unknown> = {}) => [
  { name: "playbooks/close-review.md", content, metadata: { playbook: true, enabled: true, ...metadata } },
];
const body = (out: { name: string; content: string }[]) => out.find((s) => s.name === "close-review.md")?.content;

test("with no trial, both arms read the same thing", () => {
  const live = overlay("TENANT");
  assert.equal(body(overlayPlaybooks(disk, live, undefined, "incumbent")), "TENANT");
  assert.equal(body(overlayPlaybooks(disk, live, undefined, "challenger")), "TENANT");
});

test("a trial splits the two arms, and only the challenger sees the new text", () => {
  const live = overlay("TENANT", { challenger: { content: "PROPOSED" } });
  assert.equal(body(overlayPlaybooks(disk, live, undefined, "incumbent")), "TENANT");
  assert.equal(body(overlayPlaybooks(disk, live, undefined, "challenger")), "PROPOSED");
});

test("the default arm is the one with evidence behind it", () => {
  // Every caller that does not know about trials, and every run from before they existed, must read
  // the procedure that works. A default of "challenger" would put every unaware caller into the
  // experiment, which is the wrong direction for a mistake to fail in.
  const live = overlay("TENANT", { challenger: { content: "PROPOSED" } });
  assert.equal(body(overlayPlaybooks(disk, live)), "TENANT");
  assert.equal(body(overlayPlaybooks(disk, live, undefined)), "TENANT");
});

test("an empty challenger falls back to the live text rather than mounting nothing", () => {
  // An empty skill is worse than the wrong one: the agent reads a blank file with no way to know a
  // procedure was meant to be there, and the failure gets attributed to a trial that never ran.
  for (const junk of [{ content: "" }, { content: "   " }, {}, null, "PROPOSED", []]) {
    const live = overlay("TENANT", { challenger: junk });
    assert.equal(body(overlayPlaybooks(disk, live, undefined, "challenger")), "TENANT", JSON.stringify(junk));
  }
});

test("a disabled playbook is not resurrected by being on trial", () => {
  // Disabling is a founder saying "do not use this". A trial must not be a way around that.
  const live = overlay("TENANT", { enabled: false, challenger: { content: "PROPOSED" } });
  assert.equal(body(overlayPlaybooks(disk, live, undefined, "challenger")), undefined);
  assert.equal(body(overlayPlaybooks(disk, live, undefined, "incumbent")), undefined);
});

test("a trial on a playbook with no shipped file still mounts", () => {
  // A playbook the founder wrote from scratch has no disk skill behind it, and takes the other branch
  // of the overlay walk. Both branches have to know about arms or half of trials silently do nothing.
  const live = overlay("TENANT", { challenger: { content: "PROPOSED" } });
  assert.equal(body(overlayPlaybooks([], live, undefined, "challenger")), "PROPOSED");
  assert.equal(body(overlayPlaybooks([], live, undefined, "incumbent")), "TENANT");
});

test("task-type filtering still applies to a challenger", () => {
  // A trial must not widen where a procedure is mounted. Testing a new version of a skill scoped to
  // one job, against every job, would measure something nobody proposed.
  const live = overlay("TENANT", { task_types: ["monthly_close"], challenger: { content: "PROPOSED" } });
  assert.equal(body(overlayPlaybooks(disk, live, "monthly_close", "challenger")), "PROPOSED");
  assert.equal(body(overlayPlaybooks(disk, live, "chase_invoice", "challenger")), "SHIPPED", "falls back to the disk skill");
});

test("playbookChallenger refuses anything that is not a body", () => {
  for (const junk of [undefined, {}, { challenger: null }, { challenger: "text" }, { challenger: { content: 5 } }, { challenger: [] }]) {
    assert.equal(playbookChallenger(junk as Record<string, unknown>), undefined, JSON.stringify(junk));
  }
  assert.equal(playbookChallenger({ challenger: { content: "x" } }), "x");
});
