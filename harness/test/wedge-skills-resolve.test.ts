// EVERY SKILL A MANIFEST NAMES MUST EXIST.
//
// Skills resolved only from `wedges/<name>/skills/`, so a task type naming one that lived anywhere
// else mounted NOTHING: no error, no warning, just a run missing the instructions its author thought
// they had given it. That is invisible in every other check — the manifest is valid JSON, the wedge
// loads, the run succeeds, and it does the job worse than intended for as long as nobody looks.
//
// Caught immediately on `publish_page`, which named `work-a-system` from the shared shelf.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadWedge, wedgesDir } from "../src/wedge";

/** Every wedge on disk. `loadWedge` is per-slug, and the shelf is the directory listing. */
const allWedges = () =>
  readdirSync(wedgesDir())
    .filter((d) => {
      try {
        return statSync(join(wedgesDir(), d)).isDirectory();
      } catch {
        return false;
      }
    })
    .map((d) => loadWedge(d))
    .filter((w): w is NonNullable<typeof w> => !!w);

test("every skill named by a wedge or a task type resolves to a real file", () => {
  const missing: string[] = [];
  for (const w of allWedges()) {
    const have = new Set(w.skills.map((s) => s.name));
    const check = (names: readonly string[] | undefined, where: string) => {
      for (const raw of names ?? []) {
        const name = raw.endsWith(".md") ? raw : `${raw}.md`;
        if (!have.has(name)) missing.push(`${w.manifest.wedge} ${where} → ${name}`);
      }
    };
    // The wedge-level list is what `loadWedge` actually reads; a task type naming a skill outside it
    // is the subtler bug, because the wedge looks fine and one job is quietly under-instructed.
    check(w.manifest.skills, "skills");
    for (const [tt, spec] of Object.entries(w.manifest.task_types ?? {})) {
      check((spec as { harness?: { skills?: string[] } })?.harness?.skills, `${tt}.harness.skills`);
    }
  }
  assert.deepEqual(missing, [], `manifests naming skills that mount nothing:\n  ${missing.join("\n  ")}`);
});

test("a wedge that names no skills at all does not inherit the shared shelf", () => {
  /**
   * The fallback is for NAMED files only.
   *
   * A wedge that names nothing means "everything in my own directory". Letting that also pick up
   * `service-skills/**` would hand every desk every other trade's craft — a bookkeeping run mounting
   * recruiting procedures is a different wedge from the one its author wrote, and the prompt budget
   * would go with it.
   *
   * A wedge that names skills at a task type is NOT this case: geo-monitor lists none at the wedge
   * level and `publish_page` asks for `work-a-system`, which is exactly the shared-shelf lookup this
   * is here to permit.
   */
  const wedges = allWedges();
  assert.ok(wedges.length > 0, "no wedges on disk means this test proves nothing");

  let checked = 0;
  for (const w of wedges) {
    const namesAny =
      !!w.manifest.skills?.length ||
      Object.values(w.manifest.task_types ?? {}).some(
        (spec) => !!(spec as { harness?: { skills?: string[] } })?.harness?.skills?.length,
      );
    if (namesAny) continue;
    checked++;
    const own = new Set(
      readdirSync(join(w.dir, "skills"), { withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => e.name),
    );
    for (const s of w.skills) {
      assert.ok(own.has(s.name), `${w.manifest.wedge} mounted ${s.name}, which is not its own`);
    }
  }
  assert.ok(checked > 0, "every wedge names skills, so this invariant is currently untested");
});

/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * AND THE OTHER DIRECTION: A FILE ON THE SHELF THAT NOTHING NAMES
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The test above catches a manifest naming a skill that does not exist. It cannot catch the reverse,
 * and the reverse is what production actually had: `multi-shot-fulfillment.md` was copy-pasted into
 * SEVEN wedges, and FOUR of them never named it. 128 lines of instruction sitting in the tree,
 * loaded by nothing, looking for all the world like the agent had been taught something.
 *
 * `manifest.skills` is a FILTER — name three and the other files in the directory are not loaded —
 * so an unnamed file is not "available if needed". It is dead weight that reads as coverage.
 *
 * Worse, one of the seven had drifted: contract-desk's copy was missing `connection` from the
 * ClientRequest kinds and "OAuth grant" from the never-invent list, so that desk did not know it
 * could ask a client to connect something. Six copies to keep in step is six chances to lose one.
 */
test("a wedge that names SOME skills does not leave others on the shelf unnamed", () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════════════
   * THE FILTER ONLY EXISTS ONCE YOU USE IT
   * ═══════════════════════════════════════════════════════════════════════════════════════════════
   *
   * `readFiles(dir, only, shared)` loads the WHOLE directory when `only` is undefined. So a wedge
   * that declares no skills at all gets every file in its `skills/` folder — which is why
   * `product-builder` works while naming nothing, and why flagging its files as dead was wrong.
   *
   * The moment a wedge names ONE skill, `manifest.skills` becomes a filter and every unnamed file in
   * that directory stops loading. That is the trap, and production was in it: `gtm-operator` names
   * `reading-signals.md`, and `after-the-call`, `draft_campaign_copy`, `draft_reply`, `find-people`
   * and `run-a-campaign` sat beside it loading into nothing — 700 lines of instruction that read as
   * coverage and reached no run.
   *
   * The same shape as `write-the-engagement`, which this file's first test was written for: every
   * proposal the product ever drafted was written without the skill that says how to draft one.
   *
   * So the rule is conditional, and the condition is the whole point.
   */
  const offenders: string[] = [];
  const WEDGES = wedgesDir();
  for (const wedge of readdirSync(WEDGES).filter((d) => statSync(join(WEDGES, d)).isDirectory())) {
    const dir = join(WEDGES, wedge, "skills");
    if (!existsSync(dir)) continue;
    const manifest = JSON.parse(readFileSync(join(WEDGES, wedge, "wedge.json"), "utf8"));
    const wedgeLevel = (manifest.skills ?? []) as string[];
    // No list means no filter — every file mounts, and none of them are stranded.
    if (wedgeLevel.length === 0) continue;
    const named = new Set<string>([
      ...wedgeLevel,
      ...Object.values<any>(manifest.task_types ?? {}).flatMap((t: any) => (t?.harness?.skills ?? []) as string[]),
    ]);
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
      const stem = f.replace(/\.md$/, "");
      if (!named.has(stem) && !named.has(f)) offenders.push(`${wedge}/skills/${f}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `this wedge names some skills, so these are filtered OUT and never mount:\n  ${offenders.join("\n  ")}\n` +
      `Name them, delete them, or — if the craft is not really a trade — move them to service-skills/ ` +
      `where the relevance-based arsenal can reach them from any desk.`,
  );
});
