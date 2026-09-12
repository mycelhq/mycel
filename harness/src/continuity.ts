// ═══════════════════════════════════════════════════════════════════════════════════════════════
// WHAT THIS CLIENT WAS SENT LAST TIME
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//
// A run that produces a monthly deliverable knew everything except the one thing the client
// remembers: what arrived last month.
//
// Every other input is about STANDARD. `exemplarSkills` mounts the founder's own past work as the
// bar to clear, `sharedCraft` mounts the craft that is not a trade's, the library mounts the
// procedures, `research_quality` labels the evidence. All of them answer "how good does this have
// to be". None of them answers "what did we already tell these people".
//
// That is the question a retainer is actually judged on. A client reading their sixth monthly
// report is not comparing it to an ideal report; they are comparing it to their fifth. The
// complaints that end retainers are continuity complaints — a section that silently disappeared, a
// recommendation repeated for the third month with no acknowledgement that nothing happened, a
// figure that moved with no mention that it moved, an open item from last month that is simply not
// referred to again.
//
// ═══ WHY A STATELESS AGENT STRUCTURALLY CANNOT DO THIS ═══
//
// It is the clearest line between this product and a chat window, and the landing page has been
// making the claim for a while: same models, but one of them remembers. Until now that was true of
// the founder's CORRECTIONS (kept as versions, plotted as the learning curve) and false of the
// client's HISTORY. A chat window cannot mount last month's approved report because it has never
// seen it. Neither could we.
//
// ═══ THE ACCEPTED ONE, NOT THE LATEST ═══
//
// What gets mounted is the version the CLIENT accepted, or failing that the one that was released
// to them. Not the newest draft, which may be sitting in review and may be about to be rewritten —
// continuity is with what the client actually holds in their hand, and a draft they have never
// seen is not that. `released_at` is the field that decides it, for the same reason the portal
// reads it rather than a status: it is the only one that means a human on the other side has it.

import type { DomainStore } from "./domain";
import type { MountedSkill } from "./compile";
import type { Deliverable, DeliverableVersion } from "./contract";

/** Long enough to carry structure and open items; short enough not to be imitated wholesale. */
const MAX_CHARS = 6_000;

export interface DeliverableReader {
  listDeliverables(f: {
    project_id: string;
    client_id?: string;
    limit?: number;
  }): Promise<Deliverable[]>;
  listVersions(projectId: string, deliverableId: string): Promise<DeliverableVersion[]>;
}

/**
 * The last thing this client actually received, as a mounted skill.
 *
 * Takes the store as an argument rather than reaching for the singleton, so the rule can be argued
 * with in a test instead of inferred from production — the same shape `exemplarSkills` uses.
 *
 * Fails soft to an empty array, in line with every other mount on this path: losing continuity
 * costs depth on one run, and throwing costs the run entirely.
 */
export async function continuitySkills(
  store: DeliverableReader,
  args: { projectId?: string; clientId?: string },
): Promise<MountedSkill[]> {
  const { projectId, clientId } = args;
  if (!projectId || !clientId) return [];
  try {
    const rows = await store.listDeliverables({ project_id: projectId, client_id: clientId, limit: 25 });
    if (!rows.length) return [];

    // Newest first by the moment the client got it, which is not the same as the row's own
    // `updated_at` — a deliverable can be touched long after it was sent.
    const candidates: { d: Deliverable; v: DeliverableVersion }[] = [];
    for (const d of rows) {
      const versions = await store.listVersions(projectId, d.id).catch(() => []);
      const seen = versions
        .filter((v) => !!v.released_at)
        .sort((a, b) => String(b.released_at).localeCompare(String(a.released_at)));
      const v = seen[0];
      if (v) candidates.push({ d, v });
    }
    if (!candidates.length) return [];
    candidates.sort((a, b) => String(b.v.released_at).localeCompare(String(a.v.released_at)));

    const { d, v } = candidates[0]!;
    const accepted = !!d.accepted_at;
    const summary = String(v.summary ?? "").slice(0, MAX_CHARS);
    if (!summary.trim()) return [];

    /**
     * The instruction is as important as the text, and it is deliberately not "match this".
     *
     * Told only to be consistent, a model pads: it reproduces last month's section headings whether
     * or not it has anything to put under them, which is how a retainer report becomes a template
     * with the numbers swapped — the exact thing a client cancels over. What is asked for is the
     * narrower, harder thing: notice the differences and SAY them.
     */
    const content = [
      `# What ${d.client_id ? "this client" : "they"} was sent last time`,
      "",
      `Title: ${d.title}`,
      `Sent: ${v.released_at}${accepted ? " · the client accepted it" : " · not yet accepted"}`,
      v.change_request ? `They asked for changes: ${v.change_request}` : "",
      "",
      "## What it said",
      "",
      summary,
      "",
      "## What to do with this",
      "",
      "This is the document the client already has. They will read what you write now beside it,",
      "whether or not you do.",
      "",
      "- Anything that was open last time must be resolved here or explicitly carried forward. An",
      "  open item that simply stops being mentioned is the single most common reason a retainer",
      "  client stops trusting the reporting.",
      "- If a figure has moved, say that it moved and by how much. A number restated without its",
      "  movement reads as a number nobody looked at.",
      "- If a recommendation is repeated, say that it is a repeat and that nothing has changed yet.",
      "  Making it again as though it were new tells the client you are not reading your own work.",
      "- Do NOT copy the structure for its own sake. Consistency is about the story continuing, not",
      "  about the headings matching. A section with nothing to put in it must be dropped, and the",
      "  fact that it was dropped is itself worth a sentence.",
    ]
      .filter((l) => l !== "")
      .join("\n");

    return [{ name: "last-time.md", content }];
  } catch {
    return [];
  }
}
