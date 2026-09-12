// Can this business actually run, end to end?
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// THE LOOP IS THE PRODUCT AND NOTHING MODELLED IT
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// A service business is a loop: find clients, convert them, do the work, get paid, keep them. Every
// piece of machinery here serves one stage of it — `outreach` finds, signing converts, deliverables
// are the work, `dunning` collects — and no single thing has ever been able to answer "is this
// business's loop closed", because the stages were only ever visible one wedge at a time.
//
// That question is the one that matters at onboarding. A founder describes their business, the
// system instantiates what it thinks they need, and the honest report is not "here are six task
// types" — it is: **your business can find work, do it and invoice for it, and it cannot yet chase a
// renewal.** One of those a founder can act on.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// WHY THIS IS DERIVED FROM MANIFESTS AND NOT DECLARED BY THEM
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// The tempting design is a `loop_stage` field on each task type. It would be wrong twice.
//
// A field is a CLAIM, and the thing worth knowing is whether the machinery is actually there. A
// generated service that labelled a task `"stage": "collect"` and raised no invoice would report a
// closed loop and have an open one — and a generated service is exactly what this is for, so the
// evaluation must not rest on what the generator said about itself.
//
// And every signal below already exists for its own reasons: `signs` because a proposal opens an
// envelope, `deliverable_kind` because something reaches a client, `roles` because the sweep needs a
// claimant, `cases.stages` because an engagement runs over time. Reading those is reading what the
// business WILL DO. Reading a label is reading what somebody hoped.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════════
// AND ONLY ONE STAGE IS EVER TRADE-SPECIFIC
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// Finding clients is the same job for a bookkeeper and a video editor. So is sending a proposal,
// raising an invoice and chasing a renewal. **Only DELIVER is the trade** — which is why the
// catalogue can be small and the composition does the work, and why a business whose only gap is
// `deliver` needs something authored while a business missing `collect` just needs a stock wedge
// installed. `explain()` says which, because those are different amounts of work.
import { WEDGE_ROLES, type WedgeRole } from "./roles";
import { isOperationalTaskType } from "./deliverables.wrap";
import { RESPONSIVE_TASKS } from "./client-touch";
import type { WedgeManifest } from "./wedge";

export type LoopStage = "find" | "convert" | "deliver" | "collect" | "retain";

/** In the order a client moves through them. A report out of order reads as a list, not a loop. */
export const LOOP_STAGES: LoopStage[] = ["find", "convert", "deliver", "collect", "retain"];

export const STAGE_TITLE: Record<LoopStage, string> = {
  find: "Find clients",
  convert: "Win the work",
  deliver: "Do the work",
  collect: "Get paid",
  retain: "Keep them",
};

/**
 * What stops when a stage is uncovered, in the founder's terms.
 *
 * Modelled on `WEDGE_ROLES[...].absent`, which is the same idea one level down: never "role missing",
 * always the consequence. A founder reading "no wedge declares `dunning`" learns nothing; a founder
 * reading "nothing chases an overdue invoice, so you will do it by hand" knows what their week looks
 * like.
 */
export const STAGE_ABSENT: Record<LoopStage, string> = {
  find: "Nothing goes looking for new clients, so every one has to arrive some other way.",
  convert:
    "Nothing turns a yes into a signed agreement, so proposals and signatures stay a manual job — " +
    "and the work starts on an understanding rather than a contract.",
  deliver:
    "Nothing here produces the thing a client actually pays for. This is the trade itself, and it " +
    "is the one part of the loop that has to be written for this specific business.",
  collect: "Nothing raises or chases an invoice, so getting paid is entirely on you.",
  retain:
    "The work has no engagement that runs over time, so there is nothing to renew and nothing to " +
    "notice when a client goes quiet.",
};

export interface StageCoverage {
  stage: LoopStage;
  covered: boolean;
  /** Which wedges cover it, and how — "gtm-operator (draft_engagement signs an agreement)". */
  by: string[];
  /** Present only when uncovered. What stops, and the one thing that fixes it. */
  gap?: string;
}

export interface LoopReport {
  stages: StageCoverage[];
  /** Every stage covered. The only claim worth making about a business as a whole. */
  closed: boolean;
  /**
   * Uncovered stages that a STOCK wedge would close, as against `deliver`, which needs authoring.
   * The distinction is the difference between a click and a week.
   */
  installable_gaps: LoopStage[];
  needs_a_trade: boolean;
}

interface TaskSpec {
  signs?: boolean;
  deliverable_kind?: string;
  internal?: boolean;
}

const roleClaimedBy = (ms: readonly WedgeManifest[], role: WedgeRole): string[] =>
  ms.filter((m) => (m.provides ?? []).includes(role)).map((m) => m.wedge);

const tasksOf = (m: WedgeManifest): Array<[string, TaskSpec]> =>
  Object.entries((m.task_types ?? {}) as Record<string, TaskSpec>);

/**
 * What this composed business can and cannot do.
 *
 * Takes the manifests actually installed — primary plus `also_runs` — because the whole point of
 * composition is that no single wedge closes the loop. A bookkeeping practice sells bookkeeping,
 * chases its own unpaid invoices and has to find the next client; asking whether `books-keeper`
 * closes the loop is asking the wrong question about the wrong unit.
 */
export function loopCoverage(manifests: readonly WedgeManifest[]): LoopReport {
  const by: Record<LoopStage, string[]> = { find: [], convert: [], deliver: [], collect: [], retain: [] };

  // FIND — the outreach role, which is what the GTM machinery hands work to.
  for (const w of roleClaimedBy(manifests, "outreach" as WedgeRole)) {
    by.find.push(`${w} (${WEDGE_ROLES.outreach.task_types[0]})`);
  }

  for (const m of manifests) {
    // Declared once per wedge, read for every task that does not override it.
    const wedgeShapes = (m as { fulfillment?: { deliverable_shapes?: string[] } }).fulfillment?.deliverable_shapes ?? [];
    for (const [name, spec] of tasksOf(m)) {
      // CONVERT — `signs` is the manifest's own statement that this output opens a signature
      // envelope. Not a proxy for winning work: it IS the moment a yes becomes an agreement.
      if (spec.signs) by.convert.push(`${m.wedge} (${name} opens an agreement to sign)`);

      /**
       * DELIVER — something a CLIENT receives.
       *
       * ═══ THE SIGNAL IS TWO-PART, AND READING HALF OF IT WAS WRONG ═══
       *
       * This checked `deliverable_kind` on the task type only, and reported that books-keeper
       * delivers nothing — a wedge whose whole purpose is a monthly close. Eight of thirteen wedges
       * declare it on no task at all.
       *
       * They are not broken. `deliverables.wrap.ts` falls back to `fulfillment.deliverable_shapes`
       * at the WEDGE level, which is where books-keeper, recruiting-desk, contract-desk and
       * security-questionnaire say it. Per-task is the override for a job that hands over something
       * different from the rest of its trade — geo-monitor's `ship_page` produces a link where the
       * report produces a document.
       *
       * So the test is the same one the wrapper makes, and it must stay that way: a report that
       * disagrees with the machinery about what gets delivered is worse than no report.
       *
       * `internal: true` means "no client deliverable" — NOT "only machinery starts it", a
       * misreading that once cost a task type its life in this repo.
       *
       * `isOperationalTaskType` is imported rather than re-expressed. Chases, nudges, check-ins and
       * receipts are mail the founder already sent; counting one as the trade would report a closed
       * loop for a business that delivers nothing but reminders. Two copies of that rule would
       * drift, and the wrapper's copy is the one that decides what a client actually sees.
       */
      /**
       * `RESPONSIVE_TASKS` is excluded for a reason the operational regex does not cover.
       *
       * `deliverable_verdict` is the CLIENT answering us about work we already handed over. It is
       * inbound. Counting it as a deliverable would let a wedge whose only client-facing job is
       * "receive a verdict" report that it does the work — and it would list, as evidence that a
       * bookkeeper delivers, the task where their client replies about a delivery.
       *
       * Imported, not re-listed. client-touch.ts owns the question of which task types answer a
       * client rather than reach one, and a second copy here would drift from the one that decides
       * whether a message is sent.
       */
      const kind = spec.deliverable_kind ?? (wedgeShapes.length ? wedgeShapes[0] : undefined);
      if (kind && !spec.internal && !isOperationalTaskType(name) && !RESPONSIVE_TASKS.has(name)) {
        by.deliver.push(`${m.wedge} (${name} → ${kind})`);
      }
    }

    /**
     * RETAIN — an engagement with stages is work that runs over time.
     *
     * `cases.stages` is the manifest saying this is not one-shot. A business with no stages is not
     * broken; a photographer shooting weddings genuinely has no retainer to chase. The report says
     * the stage is uncovered and what that means, and it is the founder's call whether that is a gap
     * or an accurate description of their trade.
     */
    if ((m.cases?.stages ?? []).length > 0) by.retain.push(`${m.wedge} (${m.cases!.stages!.length} stages)`);
  }

  // COLLECT — chasing an overdue invoice. `receipts` confirms money that already arrived, which is
  // courtesy rather than collection, so it does not cover this on its own.
  for (const w of roleClaimedBy(manifests, "dunning" as WedgeRole)) {
    by.collect.push(`${w} (${WEDGE_ROLES.dunning.task_types[0]})`);
  }

  const stages: StageCoverage[] = LOOP_STAGES.map((stage) => {
    const who = [...new Set(by[stage])];
    return {
      stage,
      covered: who.length > 0,
      by: who,
      ...(who.length ? {} : { gap: STAGE_ABSENT[stage] }),
    };
  });

  const open = stages.filter((s) => !s.covered).map((s) => s.stage);
  return {
    stages,
    closed: open.length === 0,
    // `deliver` is the trade and needs writing. Everything else is a stock wedge away.
    installable_gaps: open.filter((s) => s !== "deliver"),
    needs_a_trade: open.includes("deliver"),
  };
}

/**
 * The report as sentences, for a founder who has just described their business.
 *
 * Leads with what WORKS. A founder reading a generated business for the first time is deciding
 * whether to trust it, and a list that opens with four gaps reads as a failure even when four of
 * five stages are covered — which is a better position than most businesses are in on day one.
 */
export function explain(r: LoopReport): string[] {
  const out: string[] = [];
  const covered = r.stages.filter((s) => s.covered);
  if (covered.length) {
    out.push(
      `End to end, this can ${covered.map((s) => STAGE_TITLE[s.stage].toLowerCase()).join(", ")}.`,
    );
  }
  for (const s of r.stages.filter((x) => !x.covered)) {
    out.push(
      `${STAGE_TITLE[s.stage]}: not covered. ${s.gap}` +
        // The two gaps are different amounts of work and a founder should not have to guess which.
        (s.stage === "deliver"
          ? ""
          : " A service that does this can be added without writing anything new."),
    );
  }
  if (r.closed) out.push("Every stage of the loop has something behind it.");
  return out;
}
