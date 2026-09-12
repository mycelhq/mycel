// The founder's own work, mounted as the bar the run is held to.
//
// ═══ WHY THIS EXISTS ═══
//
// Onboarding asks "show us one you're proud of" and stores the file as a knowledge record
// (`collection: "exemplar"`). Storing it and never reading it would be the exact failure this
// codebase keeps producing: a thing that runs, reports success, and changes nothing.
//
// This is the read. It turns that upload into a mounted skill, which means the model sees a real
// deliverable from a professional in this exact trade every time it produces one.
//
// ═══ WHY AN EXAMPLE IS WORTH MORE THAN MORE INSTRUCTION ═══
//
// Every skill in `wedges/*/skills` is prose — "name the work", "do not guess a figure", "the report
// has to tell their client what happens this week". 824 lines of it across ten wedges, and ZERO
// worked examples. So a run knows the rules and has never been shown the game.
//
// That is the most likely explanation for the shape of real output today: competent, correctly
// structured, and SHORT. Nothing in the mounted craft says how much detail is enough, because
// depth is the one property prose cannot specify and an example conveys for free.
//
// ═══ WHAT IT DELIBERATELY DOES NOT DO ═══
//
// It does not ask the model to copy the document. An exemplar is a STANDARD, not a template: the
// client is different, the month is different, the findings are different. The framing below says
// so explicitly, because "here is a document" without that instruction produces a pastiche of
// somebody else's engagement — which is worse than a thin report, since it looks finished.
//
// It also does not silently drop in a 60,000-character file. `MAX_CHARS` clips, and the clip is
// announced in the text so the model knows it is reading a fragment rather than a complete piece
// whose ending it should imitate.

import type { DomainStore } from "./domain";
import type { MountedSkill } from "./compile";
import { wedgeForRole } from "./roles";
import type { LoadedWedge } from "./wedge";

/** Enough to convey structure, voice and depth. Beyond this the marginal token teaches nothing. */
const MAX_CHARS = 12_000;
/** A document, not a filename. See the note in `exemplarSkills`. */
const MIN_CHARS = 400;

/** How many exemplars to mount. One is a standard; five are a style guide nobody reads. */
const MAX_MOUNTED = 2;

interface ExemplarRow {
  name?: unknown;
  text?: unknown;
  chars?: unknown;
}

/**
 * The founder's uploaded deliverables for this project, as mounted skills.
 *
 * Fails soft to an empty array, deliberately and in line with `librarySkillsForWedge`: a run must
 * never be lost because a knowledge read blipped. Losing the exemplar costs depth on one run;
 * throwing costs the run entirely.
 */
/**
 * ═══ THE FALLBACK, WHICH IS THE COMMON CASE ═══
 *
 * Everything above assumes onboarding got an upload. In production it usually has not: of the
 * accounts that have ever signed in, most never reached that screen, and the one who did skipped
 * ahead. So the path that mounts the founder's own exemplar has, in practice, mounted nothing — and
 * "nothing" means the run is back to prose rules with no demonstration, which is the exact state
 * this module was written to end.
 *
 * A wedge may therefore SHIP its own worked example, in `wedges/<slug>/exemplars/`. It is used only
 * when the founder has none, because their work beats our reference every time: it carries their
 * voice, their client's expectations and their firm's habits, and none of that is ours to overrule.
 *
 * THE FRAMING IS DIFFERENT, and it has to be. The founder's exemplar says "this is a real
 * deliverable this firm has already sent a client". Saying that about a document we wrote would be
 * a lie the model would then act on — imitating a client relationship that does not exist. A shipped
 * exemplar says what it is: a reference standard for the trade, written to be matched in depth and
 * structure, with none of its specifics true of anybody.
 */
export function shippedExemplarSkills(wedge: Pick<LoadedWedge, "exemplars"> | null): MountedSkill[] {
  const files = wedge?.exemplars ?? [];
  const out: MountedSkill[] = [];
  for (const f of files.slice(0, MAX_MOUNTED)) {
    const text = f.content.trim();
    if (!text) continue;
    const clipped = text.length > MAX_CHARS;
    out.push({
      name: `exemplar:${f.name.replace(/\.md$/, "")}`,
      content: [
        `# The bar for this kind of work`,
        "",
        "This is a REFERENCE deliverable for this trade, written to show the standard. It is not this",
        "firm's work and it is not about a real client — every name, figure and finding in it is",
        "invented.",
        "",
        "READ IT FOR: how a piece of work like this is structured, what it always includes, how much",
        "detail is enough, and how directly it tells the reader what to do.",
        "",
        "DO NOT COPY ITS CONTENT. Nothing in it is true of the work in front of you. Match the",
        "STANDARD — the depth, the structure, the plainness — and fill it with what is actually true.",
        "",
        "If your output is markedly shorter or thinner than this, it is not finished.",
        "",
        "---",
        "",
        clipped ? `${text.slice(0, MAX_CHARS)}\n\n[…clipped. The full document is longer than this excerpt.]` : text,
      ].join("\n"),
    });
  }
  return out;
}

export async function exemplarSkills(domain: DomainStore, projectId?: string): Promise<MountedSkill[]> {
  if (!projectId) return [];

  // The exemplar was stored by onboarding under the shaping wedge, whichever wedge holds that
  // role on this install — resolved through the role, never named as a directory. This line
  // originally hardcoded the wedge string and the no-literal-wedge-names test caught it: the same
  // defect as every other hardcoded vocabulary in this repo, just one layer down.
  const shaper = wedgeForRole("business_shaping");
  if (!shaper) return [];
  const rows = await domain
    .queryRecords({ project_id: projectId, wedge: shaper, collection: "exemplar", limit: MAX_MOUNTED })
    .catch(() => []);

  const out: MountedSkill[] = [];
  for (const row of rows) {
    const d = (row.data ?? {}) as ExemplarRow;
    const text = typeof d.text === "string" ? d.text.trim() : "";
    /**
     * ═══ TOO SHORT TO BE A STANDARD IS WORSE THAN NO STANDARD ═══
     *
     * The check was `if (!text)`, which only refuses an exemplar that extracted to nothing at all.
     * Production holds two exemplars and one of them is FORTY-FIVE CHARACTERS — a scanned PDF whose
     * text layer gave back a filename and a date.
     *
     * That would be harmless if it sat alongside the wedge's own worked example. It does not:
     * `runtime.ts` chooses one, on the argument that "two exemplars written to different standards
     * is a style guide the model has to arbitrate between", and the founder's own work wins
     * outright. So forty-five characters of noise silently REPLACED a real reference, and the run
     * was told those characters were "the standard their work is held to".
     *
     * `MIN_CHARS` is a floor for being a document at all, not a judgement about quality. Anything a
     * professional actually sent a client clears it several times over; nothing that clears it is
     * rejected for being plain. Below the floor we fall through to the wedge's reference, which is
     * the behaviour a founder who uploaded nothing already gets, and the honest one for a founder
     * whose upload did not survive extraction.
     */
    if (text.length < MIN_CHARS) {
      if (text) {
        console.warn(
          `[mycel] project ${projectId}: exemplar "${typeof d.name === "string" ? d.name : "?"}" is ` +
            `${text.length} characters — too little to be a standard, so the service's own reference ` +
            `is used instead. Usually a scanned PDF with no text layer.`,
        );
      }
      continue;
    }
    const name = typeof d.name === "string" && d.name.trim() ? d.name.trim() : "a previous deliverable";
    const clipped = text.length > MAX_CHARS;

    out.push({
      name: `exemplar:${name}`,
      content: [
        `# The bar: ${name}`,
        "",
        "This is a real deliverable this firm has already sent a client. It was supplied by the",
        "founder as the standard their work is held to.",
        "",
        "READ IT FOR: how they structure a piece of work, what they always include, how much detail",
        "they go into, and the voice they write in.",
        "",
        "DO NOT COPY IT. The client is different, the period is different, the findings are",
        "different. Reproducing this document's specifics would be inventing an engagement that did",
        "not happen. Match the STANDARD — the depth, the structure, the directness — and fill it",
        "with what is actually true of the work in front of you.",
        "",
        "If your output is markedly shorter or thinner than this, it is not finished.",
        "",
        "---",
        "",
        clipped ? `${text.slice(0, MAX_CHARS)}\n\n[…clipped. The full document is longer than this excerpt.]` : text,
      ].join("\n"),
    });
  }
  return out;
}
