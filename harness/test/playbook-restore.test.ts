// PUTTING IT BACK — the thing "versions" implied and did not do.
//
// `playbookSaveMeta` pushed `{ at, reason }` onto a list called `versions`, and `updateKnowledge`
// overwrote the content in place. So a founder could read that their procedure changed on Tuesday,
// for a reason they no longer agreed with, and had no way to get Tuesday back. That is a changelog
// wearing a version history's name, and the difference only shows up on the day it matters.
//
// It was written when a machine wrote these too: the self-improvement system turned a reflection
// run into a proposal that, once approved, rewrote a playbook. That system is gone — deleted in
// 59f1dd83 after 261 sandbox-hours produced four proposals and nothing adopted — so today every
// write here is a person's. The argument survives the deletion and gets simpler: a founder who
// changed a procedure on Tuesday, for a reason they no longer agree with, still needs Tuesday back,
// and `updateKnowledge` overwrites content in place.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_KEPT_BODIES,
  MAX_VERSION_BYTES,
  playbookEnabled,
  playbookSaveMeta,
  playbookVersions,
} from "../src/playbooks";

/** The shape `playbookSaveMeta` reads: the row as it stands before being overwritten. */
const row = (content: string, metadata: Record<string, unknown> = {}) =>
  ({ content, metadata }) as never;

test("a save keeps the text it replaced", () => {
  const first = playbookSaveMeta(undefined, { reason: "first draft", enabled: true, now: "2026-01-01T00:00:00Z" });
  // Nothing was replaced by the first save, so there is no body to keep — and the entry still exists.
  assert.equal(playbookVersions(first).length, 1);
  assert.equal(playbookVersions(first)[0]!.content, undefined);

  const second = playbookSaveMeta(row("the original procedure", first), {
    reason: "tightened the redirect step",
    enabled: true,
    now: "2026-01-02T00:00:00Z",
  });
  const history = playbookVersions(second);
  assert.equal(history.length, 2);
  assert.equal(history[1]!.content, "the original procedure", "the replaced body is on file");
});

test("the history is append-only, and a restore is a new version rather than a rewind", () => {
  // Erasing the intervening versions would destroy exactly the evidence somebody needs to argue
  // about whether the restore was right.
  let meta = playbookSaveMeta(undefined, { reason: "v1", enabled: true, now: "2026-01-01T00:00:00Z" });
  meta = playbookSaveMeta(row("A", meta), { reason: "v2", enabled: true, now: "2026-01-02T00:00:00Z" });
  meta = playbookSaveMeta(row("B", meta), { reason: "v3", enabled: true, now: "2026-01-03T00:00:00Z" });
  // Now put A back: that is another save, whose replaced body is B.
  meta = playbookSaveMeta(row("C", meta), {
    reason: "restored the version saved 2026-01-02T00:00:00Z (v2)",
    enabled: true,
    now: "2026-01-04T00:00:00Z",
  });
  const history = playbookVersions(meta);
  assert.equal(history.length, 4, "nothing was removed");
  assert.match(history[3]!.reason, /^restored the version saved/);
  assert.equal(history[3]!.content, "C", "and what the restore itself replaced is on file too");
});

test("an old body is dropped before an old entry — the changelog stays complete", () => {
  // The bound exists because this history lives in the row's metadata beside the live content, and
  // the row is read on every run that mounts the playbook. Losing the ability to restore that far
  // back is the right thing to lose first.
  let meta: Record<string, unknown> = {};
  for (let i = 0; i < MAX_KEPT_BODIES + 6; i++) {
    meta = playbookSaveMeta(row(`body ${i}`, meta), {
      reason: `edit ${i}`,
      enabled: true,
      now: `2026-02-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
    });
  }
  const history = playbookVersions(meta);
  assert.equal(history.length, MAX_KEPT_BODIES + 6, "every entry survives");
  const withBodies = history.filter((v) => v.content !== undefined);
  assert.equal(withBodies.length, MAX_KEPT_BODIES, "only the bodies are capped");
  // And it is the OLDEST bodies that go, so the recent past is the restorable one.
  assert.equal(history[0]!.content, undefined);
  assert.equal(history[history.length - 1]!.content, `body ${MAX_KEPT_BODIES + 5}`);
});

test("a body too large to be prose is not kept, and does not break the entry", () => {
  const huge = "x".repeat(MAX_VERSION_BYTES + 1);
  const meta = playbookSaveMeta(row(huge), { reason: "pasted a whole book", enabled: true, now: "2026-03-01T00:00:00Z" });
  const [v] = playbookVersions(meta);
  assert.equal(v!.content, undefined, "not kept");
  assert.equal(v!.reason, "pasted a whole book", "still a true statement about when and why");
});

test("rows written before this existed still read, they simply cannot be restored", () => {
  // The migration story: no backfill is possible, because the text is genuinely gone. The history
  // must not throw on those rows, and must not claim they are restorable.
  const legacy = { versions: [{ at: "2025-12-01T00:00:00Z", reason: "before restore existed" }] };
  const history = playbookVersions(legacy);
  assert.equal(history.length, 1);
  assert.equal(history[0]!.content, undefined);
  assert.equal(history.filter((v) => v.content !== undefined).length, 0);
});

test("a restore does not switch a disabled playbook back on", () => {
  const off = playbookSaveMeta(undefined, { reason: "paused it", enabled: false, now: "2026-01-01T00:00:00Z" });
  assert.equal(playbookEnabled(off), false);
  const after = playbookSaveMeta(row("x", off), {
    reason: "restored",
    enabled: playbookEnabled(off),
    now: "2026-01-02T00:00:00Z",
  });
  assert.equal(playbookEnabled(after), false, "putting text back is not turning it on");
});

test("garbage in the metadata is skipped, never coerced into a version", () => {
  const junk = { versions: [null, "nope", { at: 5 }, { reason: "no at" }, { at: "2026-01-01T00:00:00Z", reason: "real" }] };
  const history = playbookVersions(junk);
  assert.equal(history.length, 1);
  assert.equal(history[0]!.reason, "real");
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// THE LOST UPDATE — which would silently destroy the thing the history exists to preserve
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// `metadata` is stored as a WHOLE OBJECT and `playbookSaveMeta` is read-modify-write: read the row,
// mutate the parsed jsonb in JS, write it all back. a comparable runtime named this exact shape in
// `lib/metadata-merge.ts`: "a concurrent writer holding a STALE snapshot silently reverted the pin
// (a classic read-modify-write lost update)."
//
// Here it is worse than a lost changelog line, because every version entry carries THE TEXT IT
// REPLACED. A lost update destroys the only copy of a procedure somebody could have restored — the
// feature whose whole purpose is "you can always get it back" quietly stops being able to. And the
// writers are not all human: a founder's save, an improvement approval starting a trial, and a trial
// being concluded all write this row.

test("a write guarded by ifUpdatedAt refuses to clobber a concurrent one", async () => {
  const { InMemoryDomainStore } = await import("../src/domain");
  const d = new InMemoryDomainStore();
  const created = await d.createKnowledge({
    project_id: "p1",
    wedge: "books-keeper",
    name: "playbooks/close.md",
    content: "V1",
    kind: "document",
    source: "feedback",
    metadata: playbookSaveMeta(undefined, { reason: "v1", enabled: true, now: "2026-01-01T00:00:00Z" }),
  });

  // Two writers read the SAME row. Both compute a new version list from that snapshot.
  const snapshot = await d.getKnowledge(created.id);
  const stamp = snapshot!.updated_at;

  const first = await d.updateKnowledge(
    created.id,
    { content: "V2", metadata: playbookSaveMeta(snapshot, { reason: "founder edit", enabled: true, now: "2026-01-02T00:00:00Z" }) },
    { ifUpdatedAt: stamp },
  );
  assert.ok(first, "the first writer wins");

  const second = await d.updateKnowledge(
    created.id,
    { content: "V2-other", metadata: playbookSaveMeta(snapshot, { reason: "trial promoted", enabled: true, now: "2026-01-02T00:00:01Z" }) },
    { ifUpdatedAt: stamp },
  );
  assert.equal(second, undefined, "the second is refused rather than silently overwriting");

  // And the winner's work is intact — this is the assertion that matters, because an unguarded
  // write would have left "V2-other" here with the founder's version entry gone.
  const now = await d.getKnowledge(created.id);
  assert.equal(now?.content, "V2");
  assert.equal(playbookVersions(now?.metadata).at(-1)?.reason, "founder edit");
});

test("an unguarded write is unchanged, so every existing caller behaves exactly as before", async () => {
  const { InMemoryDomainStore } = await import("../src/domain");
  const d = new InMemoryDomainStore();
  const k = await d.createKnowledge({
    project_id: "p1", wedge: "w", name: "n.md", content: "a", kind: "document", source: "feedback", metadata: {},
  });
  const stale = k.updated_at;
  await d.updateKnowledge(k.id, { content: "b" });
  // No `ifUpdatedAt`: this must still land even though the row has moved since `stale` was read.
  const out = await d.updateKnowledge(k.id, { content: "c" });
  assert.equal(out?.content, "c");
  assert.ok(stale);
});

test("a guard against a row that does not exist is still a miss, not a crash", async () => {
  const { InMemoryDomainStore } = await import("../src/domain");
  const d = new InMemoryDomainStore();
  assert.equal(await d.updateKnowledge("nope", { content: "x" }, { ifUpdatedAt: "2026-01-01T00:00:00Z" }), undefined);
});
