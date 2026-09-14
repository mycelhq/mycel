// The craft that belongs to no trade, mounted on every run a client receives work from.
//
// ═══ WHY THIS EXISTS AS A DIRECTORY AND NOT AS A PARAGRAPH IN EACH WEDGE ═══
//
// A model playing a paying client rejected the same deliverable six times in a row, and not one of
// its complaints was about bookkeeping. "You sent me an account of the work rather than the work."
// "You say reconciled and show no reconciliation." "A retainer should buy a clear recommendation and
// an efficient evidence request, not a list of ambiguities pushed back to me."
//
// Every one of those is true of a GEO report, a screened longlist, an answered questionnaire and a
// finished site. Every one of them had been written down inside `books-keeper` as though it were an
// accounting rule, because that is the trade whose deliverable happened to be under a microscope.
//
// So the trade-agnostic half moved to `wedges/_craft/`, where a new trade inherits it on the day it
// is authored rather than rediscovering it through a rejected deliverable. VAT schemes, aging
// buckets, selection versus absorption stay in the wedge: those genuinely are a trade's.
//
// ═══ WHY IT IS READ FROM DISK RATHER THAN WRITTEN HERE ═══
//
// The same argument the wedges make. Craft is prose that a person edits after watching a client
// reject something, and prose that lives in a `.ts` file gets edited by whoever is already in the
// compiler rather than by whoever just read the complaint.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { MountedSkill } from "./compile";
import { libraryPath } from "./library";

/**
 * Beside `wedges/`, not inside it.
 *
 * It lived in `wedges/_craft/` for about a minute and two of this repo's own guards caught it: the
 * wedge-manifest tests read every directory under `wedges/` as a trade, and a separate test forbids
 * naming a wedge directory as a string literal in kernel source. Both were right. This is not a
 * trade, so it does not belong in the folder of trades.
 */
const CRAFT_DIR = libraryPath("craft", process.env.MYCEL_CRAFT_DIR);

/**
 * Every shared craft file, as mounted skills.
 *
 * Fails soft to `[]`. A missing directory means a deployment that ships wedges without it, and a run
 * that refuses to start over the absence of general advice would be trading the job for the lesson —
 * the same call `exemplarSkills` makes.
 */
export function sharedCraft(dir: string = CRAFT_DIR): MountedSkill[] {
  if (!existsSync(dir)) return [];
  const out: MountedSkill[] = [];
  try {
    for (const name of readdirSync(dir).sort()) {
      if (!name.endsWith(".md") || name.startsWith(".")) continue;
      const content = readFileSync(join(dir, name), "utf8").trim();
      if (!content) continue;
      // `craft:` rather than the bare filename, so a founder reading the trace can tell what came
      // from their trade and what every trade gets.
      out.push({ name: `craft:${name.replace(/\.md$/, "")}`, content });
    }
  } catch {
    return [];
  }
  return out;
}
