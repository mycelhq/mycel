// WHICH SKILLS THE AGENT ACTUALLY OPENED — as opposed to which ones we left lying around.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// THE BUG IN THE SCALES THIS EXISTS TO FIX
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// `skill-scales.ts` is the right idea: when a client accepts a deliverable, credit the skills that
// produced it, cross-tenant, so a shared library learns which procedures land. It has one flaw, and
// the flaw is fatal to the thing it measures.
//
// It credits every skill the run MOUNTED, equally. A run mounts a dozen — the wedge's own, plus every
// library skill whose domains intersect — and a wedge mounts roughly the same dozen every time. So
// every skill in a wedge accumulates the same wins and the same losses, and converges on the same
// number: THE WEDGE'S acceptance rate. The scoreboard cannot tell two skills in one wedge apart,
// which is the only comparison it was built to make. It reads like data and it is the wedge's score
// printed twelve times.
//
// The signal that separates them is whether the agent OPENED the file. A skill it read is a skill
// that could have changed the work. A skill it never opened cannot have influenced the deliverable
// whatever happened to it, and crediting it is not weak evidence — it is noise with a confident face.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// TWO NUMBERS, NOT ONE, AND THE SECOND ONE IS THE MORE ACTIONABLE
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// Splitting mounted from read gives the library a question it could never ask before:
//
//   · ACCEPTANCE  — of the runs that read this skill, how many landed? Does the procedure work.
//   · ATTENTION   — of the runs that mounted it, how many opened it? Is anyone using it at all.
//
// A skill mounted five hundred times and opened twice is the library's real problem and it is
// invisible to an acceptance rate: it has no votes, so it sits at zero next to everything else with
// no votes. Low attention means the index line does not describe it well enough to be worth opening,
// or it is mounted into jobs it has nothing to do with. Both are fixable, and neither is "the
// procedure is bad".
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// WHY IT MATCHES ON THE PATH AND NOT ON THE TOOL NAME
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// The obvious implementation watches for the `read` tool. It is wrong here for the reason
// `runtime.ts` already gives about watching for the contract file: the agent may open a skill with
// `read`, with `bash cat`, with `grep -n`, with `glob` into a loop, or from a script it wrote a
// moment ago. A matcher over tool names misses most of that, and it misses it SILENTLY — the skill
// looks unread, so it loses its vote, so a procedure that works gets marked as dead weight.
//
// So this scans the ARGUMENTS of every tool call for the skill's own filename. The filename is
// distinctive (`nobody-remembers-the-redirects.md`), the arguments are already in the event stream
// the runtime consumes for other reasons, and a false positive costs one over-credited vote where a
// false negative costs a skill its evidence.

/** The directory every mounted skill is written to. Kept beside the matcher that depends on it. */
export const SKILLS_DIR = "skills";

/**
 * A read of the skills directory that names no particular skill.
 *
 * `skills/*.md`, `skills/*`, a `find`/`ls` over it. The agent went to the procedures — that much is
 * certain — and there is no way to say which one it used. `uses()` turns this into "not known"
 * rather than guessing either way, and the argument for that is written there.
 */
const BULK_READ = /skills\/(\*|\*\*|[^\s"']*\*)|(?:ls|find|glob)[^\n]{0,40}skills\b/;

/**
 * Watches a run's tool calls and remembers which mounted skills were opened.
 *
 * Stateful and per-run, deliberately: the caller feeds it the stream it is already consuming, and it
 * answers once at the end. Nothing here touches the store — attribution is written in one place,
 * when the run finishes, rather than a write per tool call.
 */
export class SkillAttention {
  /** Lower-cased filename → the name as mounted, so matching is case-insensitive but reporting is not. */
  private readonly watched = new Map<string, string>();
  private readonly opened = new Set<string>();
  /** See `BULK_READ` and the note on `uses()`. */
  private bulk = false;

  constructor(mounted: readonly { name: string }[]) {
    for (const s of mounted) {
      const name = String(s?.name ?? "").trim();
      // A one- or two-character name would match almost any argument. Nothing legitimate is that
      // short, and the cost of skipping it is one skill with no attention data rather than every
      // skill credited on every call.
      if (name.length < 4) continue;
      this.watched.set(name.toLowerCase(), name);
    }
  }

  /** Every mounted skill, whether opened or not. */
  get mounted(): string[] {
    return [...this.watched.values()];
  }

  /**
   * Feed one tool call's arguments.
   *
   * Takes the raw value rather than a string so the caller does not have to guess how to flatten it;
   * a bounded `JSON.stringify` is the flattening, and the bound matters because a tool result can
   * carry a whole file and this runs on every call in the stream.
   */
  observe(args: unknown): void {
    if (args === undefined || args === null) return;
    if (this.opened.size === this.watched.size) return; // everything already seen
    let text: string;
    try {
      text = typeof args === "string" ? args : JSON.stringify(args);
    } catch {
      return; // a circular or unserialisable argument is not evidence of anything
    }
    if (!text) return;
    const hay = text.slice(0, 20_000).toLowerCase();
    // The directory has to appear too. Without it, a skill named `pricing.md` would be marked read
    // by any run that merely MENTIONED pricing.md — a deliverable about the client's own pricing
    // page, say — and the whole point of this file is to stop confident noise.
    if (!hay.includes(SKILLS_DIR)) return;
    // A sweep over the whole directory — `skills/*.md`, `for f in skills/*`, a glob. It is genuine
    // evidence that the agent went to the procedures, and it attributes to NONE of them. See
    // `uses()` for what is done about that, which is the interesting part.
    if (BULK_READ.test(hay)) this.bulk = true;
    for (const [lower, name] of this.watched) {
      if (this.opened.has(name)) continue;
      if (hay.includes(lower)) this.opened.add(name);
    }
  }

  /** The mounted skills the agent actually opened. */
  get read(): string[] {
    return [...this.opened];
  }

  /** Whether this run swept the directory, making an unopened skill unattributable rather than unread. */
  get indeterminate(): boolean {
    return this.bulk;
  }

  /**
   * What gets written: every mounted skill, each flagged with whether it was opened.
   *
   * Both, not just the read ones. A skill that was mounted and ignored is the row that answers "is
   * anyone using this", and dropping it would make that question unanswerable in exactly the case
   * where the answer is interesting.
   *
   * ═══ THE THIRD ANSWER, WHICH IS THE ONE THAT MAKES THIS HONEST ═══
   *
   * A run that did `cat skills/*.md` read everything and named nothing. There are two tempting
   * moves and both are wrong:
   *
   *   · Count every skill as READ. This is the original bug wearing a new hat — one command credits
   *     a dozen skills equally, and the wedge's score gets printed twelve times again.
   *   · Count them as UNREAD. Worse, and this is the one that would have shipped. A skill's
   *     attention rate is `read / mounted`; recording "mounted, not read" for a run that demonstrably
   *     DID read it drives that rate toward zero and marks a procedure the agent relies on as dead
   *     weight. The library would then be pruned on the strength of it.
   *
   * So the third answer: `read: undefined` — not known. `skillScales` already treats an absent flag
   * as "no information" rather than "no", because rows predating attention tracking have the same
   * shape, and a row with no information contributes to neither side of the ratio. The run is simply
   * not evidence about which skill was opened, and says so.
   */
  uses(): Array<{ name: string; read?: boolean }> {
    return this.mounted.map((name) => {
      const opened = this.opened.has(name);
      if (opened) return { name, read: true };
      return this.bulk ? { name } : { name, read: false };
    });
  }
}
