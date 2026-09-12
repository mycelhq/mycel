import { createHash } from "node:crypto";
import { designSystemFor } from "./design-systems";
import type { VisualIdentity } from "./brandkit";

/**
 * THE LOOK A CLIENT WAS ACTUALLY SHOWN, RECORDED ON THE THING THEY WERE SHOWN.
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * WHY A PIN, AND WHY IT IS THE WHOLE POINT
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * openwork's artifact architecture (`docs/features/dynamic-artifact-mcp-apps/README.md`) separates
 * four things this product currently fuses into one: execution, scheduling, DATA and PRESENTATION.
 * A run there produces data and a receipt; the renderer is a separate versioned artifact, and an
 * automation refreshes the data and "never creates or executes UI code".
 *
 * Ours re-derives the look on every run. `designSystemFor(kit.identity)` is called fresh inside
 * `runtime.ts` each time a delivering task starts, so the answer is whatever the identity says at
 * that instant. Nothing anywhere records what a given deliverable was actually rendered with.
 *
 * Two consequences, and the second is the one clients see:
 *
 *   A FOUNDER WHO RESTYLES MID-ENGAGEMENT changes work already in flight. The client accepted v1 in
 *   one house style and the revision they asked for comes back in another — which reads as a
 *   different firm answering, on the one interaction where they were already unhappy enough to ask
 *   for a change.
 *
 *   THE ARCHIVE CANNOT SAY WHAT IT SHOWED. A client's January report renders today against today's
 *   identity, so re-opening an accepted deliverable can show something they never saw and agreed to.
 *
 * A pin fixes both by being boring: resolve the look ONCE, when the deliverable is created, store
 * it, and use the stored value for every version after. A restyle applies to the next NEW piece of
 * work and to nothing that already exists.
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * PROVENANCE, BECAUSE MOST OF THIS IS NOT THE FIRM'S BRAND
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * opendesign's first principle is "real over remembered": never recommend a colour or a font from
 * memory, because you will hallucinate plausible-but-wrong values and the result reads as slop.
 * openwork's diagnostics carry `evidenceKind` — `observed | derived | expected | unavailable` — for
 * the same reason, and the port doc records me getting exactly this wrong: reading derived evidence
 * as observed and reporting it as fact.
 *
 * So every part of a pinned style says how we came by it:
 *
 *   measured  read off the firm's own website and CONFIRMED by them. The only one that is a fact
 *             about their brand rather than a decision about ours. See house-style.measure.ts.
 *   chosen    the founder picked a system by name from the shelf.
 *   derived   inferred from something they did say — an archetype, an accent colour.
 *   default   we picked it because nothing said otherwise. Honest, and not a brand.
 *
 * ── WHY `measured` REQUIRES A CONFIRMATION AND THE OTHERS DO NOT ──
 *
 * The other three are all OUR decisions and are labelled as such. `measured` is a claim about
 * somebody else's brand, made by counting hex codes in a stylesheet we did not write. It is usually
 * right and it is occasionally a third-party widget's palette read as a firm's identity.
 *
 * So it only wins once the founder has looked at it and said yes — `accepted_at`. Before that the
 * reading is evidence to show them, and the pin falls through to what it would have been. A
 * measurement that silently repainted work they were about to send a client would be the strongest
 * possible version of the failure `evidence` exists to prevent.
 */

export type StyleEvidence = "measured" | "chosen" | "derived" | "default";

/**
 * The stored shape lives in `contract.ts` beside `Deliverable`, which carries it — that file is the
 * one every store already depends on, and a store importing this module would drag the design-system
 * reader and the brand kit into the persistence layer. Re-exported so callers have one import.
 */
export type { PinnedStyle } from "./contract";

interface PinnedStyleShape {
  /** An id under `design-systems/systems/`. */
  system: string;
  /** How we came by `system`. Never inferred at read time — stored, so it cannot drift. */
  evidence: StyleEvidence;
  /** The founder's accent, when they set one. Passed to `designSystemFilesFor`. */
  accent?: string;
  neutral?: string;
  /**
   * Over system + accent + neutral. Two deliverables with the same digest were rendered against the
   * same look, and that is checkable after the fact rather than assumed — which is the difference
   * between a pin and a comment claiming there is one.
   */
  digest: string;
  at: string;
}

/** Stable across key order and undefined-vs-absent, so an unchanged style never looks changed. */
export function styleDigest(s: Pick<PinnedStyleShape, "system" | "accent" | "neutral">): string {
  const canon = JSON.stringify([s.system, s.accent ?? null, s.neutral ?? null]);
  return createHash("sha256").update(canon).digest("hex").slice(0, 16);
}

/**
 * The look a NEW deliverable should be pinned to.
 *
 * Called once, at creation. Never called again for that deliverable — that is the entire mechanism.
 */
export function resolveStyle(
  kit:
    | {
        identity?: VisualIdentity;
        accent?: unknown;
        neutral?: unknown;
        /** See `BrandKitInput.measured`. Only an ACCEPTED reading is allowed to win. */
        measured?: { colors?: string[]; accepted_at?: string };
      }
    | undefined,
  now = new Date(),
): PinnedStyleShape {
  const identity = kit?.identity;
  const system = designSystemFor(identity);
  /**
   * An ACCEPTED reading of their own site beats anything from the shelf. `colors[0]` is the most
   * frequent chromatic value on the site — the accent by definition — and the shelf system stays as
   * the layout and type; only the colour it wears becomes theirs.
   */
  const m = kit?.measured;
  if (m?.accepted_at && m.colors?.[0]) {
    const accent = m.colors[0];
    const neutral = typeof kit?.neutral === "string" ? kit.neutral : undefined;
    return {
      system,
      evidence: "measured",
      accent,
      neutral,
      digest: styleDigest({ system, accent, neutral }),
      at: now.toISOString(),
    };
  }
  /**
   * `design_system` is the founder naming a look. `archetype` is us mapping a feeling onto one
   * through a seven-entry table, which is an inference about them and not a decision by them.
   * Collapsing the two would let a mapping we wrote be reported back to the founder as their choice.
   *
   * COMPARED AGAINST WHAT CAME BACK, not against what was asked for. `designSystemFor` deliberately
   * IGNORES a stored id that is no longer on disk — a rename, a trimmed vendored set — and falls
   * back to the archetype. Reading the request would then tell a founder "you picked it" about a
   * look they did not get, which is worse than the fallback itself: the fallback is a reasonable
   * substitution, and the label is a false statement about their own decision.
   */
  const evidence: StyleEvidence = identity?.design_system === system
    ? "chosen"
    : identity?.archetype
      ? "derived"
      : "default";
  const accent = typeof kit?.accent === "string" ? kit.accent : undefined;
  const neutral = typeof kit?.neutral === "string" ? kit.neutral : undefined;
  return { system, evidence, accent, neutral, digest: styleDigest({ system, accent, neutral }), at: now.toISOString() };
}

/**
 * What to render a version with: the pin if there is one, otherwise today's resolution.
 *
 * THE PIN ALWAYS WINS, including when it names a system that no longer exists on disk. That looks
 * wrong and is not: a deliverable pinned to a system we have since removed is a deliverable whose
 * look we can no longer reproduce, and silently substituting a different one would make the archive
 * quietly untrue rather than visibly incomplete. `designSystemFilesFor` already degrades to no house
 * style for an unknown id, which is the honest failure.
 */
export function styleForVersion(pinned: PinnedStyleShape | undefined, fallback: PinnedStyleShape): PinnedStyleShape {
  return pinned ?? fallback;
}

/** One line for a founder. Names the look and says whose decision it was. */
export function describeStyle(s: PinnedStyleShape | undefined): string {
  if (!s) return "No house style pinned — this renders against whatever the brand says today.";
  const how =
    s.evidence === "measured"
      ? "measured from your own site"
      : s.evidence === "chosen"
      ? "you picked it"
      : s.evidence === "derived"
        ? "from the look you described"
        : "our default — you have not chosen one";
  return `${s.system} (${how})`;
}
