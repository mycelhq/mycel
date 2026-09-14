// WRITING A SERVICE FOR A BUSINESS THE CATALOGUE DOES NOT COVER.
//
// ═══ THE FAILURE THIS EXISTS FOR ═══
//
// `sellableWedges` leaves four services. A founder types "I run a design studio — I scope projects,
// send proposals, and chase sign-off" and the shaper answers `fit: "none"`, which the onboarding UI
// renders as "We can't run this yet". That sentence is true and it is the end of the funnel. The
// alternative on offer was to hand-author a service per trade, which is weeks per trade against a
// market that has thousands of them, so the honest answer is that the kernel has to write the
// service itself.
//
// ═══ WHY THIS IS TRACTABLE, AND WHERE THE LINE IS ═══
//
// A service is JSON plus markdown, not executable code: task types with input/output schemas,
// approvals, a policy envelope, declared capabilities, case stages, skills and knowledge. Every part
// of that is ALREADY VALIDATED by machinery written for hand-authored manifests —
//
//   · `manifestFaults` refuses an unknown field, an unknown role, a role claimed without the task
//     types that prove it, and an unknown capability, each with a sentence naming the fix.
//   · `CAPABILITIES` and `WEDGE_ROLES` are closed vocabularies in code, so a typo is a refusal.
//   · `validateOutput` cannot pass a run whose task type declares no output schema.
//   · approvals default closed, and `policy.ts` auto-approve is an explicit, ceilinged envelope.
//
// So generating a MANIFEST requires no new trust model: the manifest is data, and the kernel already
// refuses bad data loudly. Generating a WORKFLOW would, because `workflows/<name>.mjs` is executable
// founder code that the sandbox runs — that needs a code-provenance and sandboxing story this change
// does not have, which is why `workflows` is one of the refusals below rather than a TODO.
//
// ═══ WHAT THIS MODULE IS ═══
//
// Pure. It takes whatever the model emitted, and returns either a draft or a list of sentences a
// founder can read. It touches no disk, no store and no clock, so every refusal below is unit
// testable without a model, a database or a filesystem — which matters because `MYCEL_RUNTIME=mock`
// means no real manifest can be produced in this environment at all.
import { manifestFaults, ALL_WEDGE_ROLES, type ManifestFault } from "./roles";
import { inferChart, inferChecks } from "./infer-checks";
import { deliverableShapeAsSkill, readDeliverableShape, SHAPE_SKILL_FILE } from "./deliverable-shape";
import {
  identitiesAsSkill,
  identitiesToChecks,
  mechanicsAsSkill,
  type TradeIdentity,
  type TradeMechanic,
} from "./trade-identities";
import { plainChecks, readShipChecks } from "./ship-checks";
import { SHARED_WORKFLOWS, isSharedWorkflow } from "./workflows";
import { ALL_CAPABILITIES, CAPABILITIES, isCapability, isDeclarableCapability, type CapabilityName } from "./capabilities";
import { authoredSlug, isAuthoredSlug, type WedgeFile, type WedgeManifest } from "./wedge";
import { isTier } from "./models";
import { SHAPE_DEFAULTS } from "./harness";
import type { Risk } from "./contract";
import { parsePackRef, resolvePack } from "./packs";
import { skillHasNever } from "./skill-arsenal";
import { isOperationalTaskType } from "./deliverables.wrap";

/**
 * The ways of working a WRITTEN service may ask for.
 *
 * Derived, never listed: a shape qualifies when it grants no actions — `grants_actions: false` is the
 * line `harness.ts` calls load-bearing and no manifest can negotiate it — so a shape added later that
 * CAN send cannot become authorable through somebody forgetting to update a constant here.
 *
 * `build` is filtered out for a different reason, and not a risk one: it needs a `workspace`, which
 * an authored service may not declare, so a build-shaped job would have nowhere to build and would
 * delete its own output. See the long note at the check itself.
 */
export const AUTHORABLE_SHAPES: string[] = [
  ...Object.entries(SHAPE_DEFAULTS)
    .filter(([shape, d]) => d.grants_actions === false && shape !== "build")
    .map(([shape]) => shape),
  /**
   * ═══ AND `deliver`, WHICH DOES GRANT ACTIONS, ADDED BY NAME AND ON PURPOSE ═══
   *
   * The derivation above is the good rule and it stays: a shape added later that CAN send does not
   * become authorable through somebody forgetting to update a constant.
   *
   * `deliver` is the exception because refusing it was incoherent rather than safe. An authored task
   * type that declares NO harness now resolves to `deliver` — see `resolveHarnessProfile`, which
   * used to drop it into `general`, a shape that grants actions just the same and is described in
   * its own file as the one nobody has thought about. So silence already produced this shape, while
   * asking for it was refused with the sentence "those are the ways of working that cannot send" —
   * a claim that was not true of the default sitting behind it.
   *
   * WHAT HOLDS THE LINE IS NOT THIS LIST, AND THE FIRST DRAFT OF THIS COMMENT SAID IT WAS.
   *
   * It claimed an authored service is refused a `policy` envelope so every send waits for a human.
   * That was true once and was deliberately reversed: a business that asks permission for everything
   * on day one is a gate the founder learns to stop reading, which kills it for the sends that
   * matter. A written service MAY carry day-one allowances.
   *
   * The real constraint is `sanitiseAuthoredPolicy`, which clamps them to
   * `AUTHORED_POLICY_MAX_RULES` rules at `AUTHORED_POLICY_MAX_PER_DAY` a day — harder than any
   * hand-written wedge is clamped, on the stated ground that the author here is the thing being
   * granted. Approvals still default closed for everything outside that envelope.
   *
   * So the shape list never constrained sending, which is the whole reason refusing `deliver` while
   * defaulting to `general` bought nothing.
   *
   * `general` is deliberately NOT here. It grants actions and is tuned for nothing; a service that
   * asks for it is asking for the worst harness in the system, and now nothing lands there by
   * accident either.
   */
  "deliver",
];

/**
 * Ceilings on the SHAPE of an authored service, not on its autonomy.
 *
 * Autonomy ceilings live where they always did (`HARD_MAX_PER_SWEEP`, `HARD_MAX_PER_DAY` in
 * autonomy.ts) and nothing here may widen them — an authored service that declared no policy at all
 * still runs under them. These numbers are here for a different failure: a model asked for a service
 * definition can emit forty task types and a megabyte of skill markdown, and a founder cannot review
 * that. A surface too big to read is a surface nobody reviewed.
 */
export const AUTHOR_LIMITS = {
  /** Enough for scope → propose → chase → close. Beyond this nobody reads the review card. */
  max_task_types: 8,
  max_skills: 6,
  /** ~40kB of markdown. A skill is a procedure, not a book; the sandbox mounts every byte. */
  max_skill_bytes: 40_000,
  max_knowledge: 6,
  max_knowledge_bytes: 40_000,
  max_intake_questions: 8,
  max_case_stages: 10,
  max_approvals: 12,
  /** Six: money/email plus one publish/CRM/calendar/ads pair without forcing a review-card novel. */
  max_capabilities: 6,
  max_title: 80,
  max_description: 600,
} as const;

/** A service the kernel wrote, before anybody has agreed to run it. */
export interface AuthoredWedgeDraft {
  /** Always carries `AUTHORED_SLUG_PREFIX`, so `loadWedge` cannot reach it. See wedge.ts. */
  slug: string;
  manifest: WedgeManifest;
  skills: WedgeFile[];
  knowledge: WedgeFile[];
}

export interface AuthorResult {
  draft?: AuthoredWedgeDraft;
  /** Every problem, as sentences. Non-empty means `draft` is absent — never both. */
  faults: ManifestFault[];
  /**
   * ═══ WHAT THE DRAFT ASKED FOR AND DID NOT GET ═══
   *
   * `repairAuthoredManifest` silently corrects five things a written service may not have: a
   * `policy` envelope it wrote itself, an approval marked `required: false`, a kernel role claimed
   * through `provides`, its own runnable `workflows`, and a mistyped capability. Every one of those
   * repairs is right — refusing a whole service over one strippable line loses a good service and
   * is "the difference between a runnable service and a dead magic moment", which this file already
   * argues.
   *
   * But they were SILENT, and running the eval harness is what showed it: five cases expecting a
   * named refusal got a clean draft and an empty `faults`, because the fields had been quietly
   * removed on the way past. Safe, and the founder never learns that the thing writing their
   * service tried to grant itself permission to send without asking.
   *
   * That is a signal about the author, not about the service, and it is exactly what a review card
   * is for. Notices never block: a draft with notices is a draft, and `faults` remains the only
   * thing that can withhold one.
   */
  notices: ManifestFault[];
}

// ═══════════════════════════ THE REFUSALS ═══════════════════════════

/**
 * Everything an authored service may NOT do, as sentences.
 *
 * `manifestFaults` runs first and unchanged: an authored manifest is held to exactly the standard a
 * hand-written one is, and there is no second, laxer validator for model output. The rules below are
 * the ones that only apply to a manifest NOBODY WROTE BY HAND, and each is here because the field it
 * governs is a way for a generated service to grant itself something a reviewer would not notice.
 *
 *  1. It may not claim a ROLE. Not "a role that is taken" — any role. A role is a job the KERNEL
 *     initiates, `cardinality: "one"` across the whole INSTALL, and the install is shared by every
 *     tenant. One project's authored service claiming `dunning` would either lose to
 *     `invoice-chaser` silently or take dunning away from every other business on the box. There is
 *     no per-project role index and inventing one is not this change.
 *  2. It may not declare `workflows`. That names `workflows/<name>.mjs`, executable code on disk
 *     which for a service that has no directory cannot exist. A manifest referencing a file that is
 *     not there is a run that dies mid-job having already emailed somebody.
 *  3. It may not declare `connections`. That names a specific connection ROW by id or name, which is
 *     how `books-keeper` ended up asking a QuickBooks bookkeeper for a bank feed it had been granted
 *     nothing for. Authored services bind by capability, which resolves per project against whatever
 *     the founder actually connected.
 *  4. It may not declare `policy`. The sane default auto-approve envelope for a service that no
 *     human has ever watched run is EMPTY: every outward action passes a person. This is the field a
 *     later change widens, deliberately, once there is a track record to widen it on — and it is
 *     refused rather than clamped so the founder's review card can say "it will never do anything
 *     outward without asking you" as a fact rather than as an estimate.
 *  5. It may not declare `approvals[].required: false`. Same rule, said at the other end: an
 *     approval that is not required is not an approval.
 *  6. It may not declare `harness` or `tools`. `HarnessProfileSpec` carries `allow_action_token`,
 *     tool grants and permission shape; a generated service asking for the action token is asking to
 *     act without passing the gate. Omitting it gets the permissive-but-clamped `general` default,
 *     which is what every wedge got before profiles existed. `tier` survives as its own field
 *     because "how hard is this job" is a judgement the author is well placed to make and
 *     `resolveTier` clamps it down by plan anyway.
 *  7. It may not declare `internal: true`. `internal` means machinery nobody sells; an authored
 *     service is by definition the thing this business sells, and a true here would hide it from
 *     `/knowledge` and from the catalogue the shaper reads.
 *  8. It may not declare `model`. Which model runs is an infrastructure and margin decision
 *     (models.ts), not a property of a trade.
 *  9. Every task type needs an `output_schema` that is an object schema. `validateOutput` cannot
 *     validate a run without one, so the run reports success on whatever the model said — this
 *     repo's most expensive bug shape, and the one a generated service is most likely to reach.
 * 10. `waits_for.resume` must name a task type in this same manifest, `cases.initial` must be one of
 *     `cases.stages`, and every capability must be one the kernel knows. Each of these is a dangling
 *     reference that reads as configured and does nothing.
 * 11. `wedge` must equal the authored slug. A manifest is otherwise free to call itself
 *     `invoice-chaser` and be stored under a slug nobody would look at twice.
 */
export function authoredFaults(slug: string, raw: unknown): ManifestFault[] {
  const faults: ManifestFault[] = [];
  const fault = (message: string) => faults.push({ wedge: slug, message });

  if (!isAuthoredSlug(slug)) {
    // Storing an authored manifest under a plain slug would put it back in `loadWedge`'s reach, and
    // `loadWedge` has no project — that is the whole cross-tenant argument in wedge.ts, undone.
    fault(`the slug "${slug}" is not marked as authored, so it could be confused with an installed service`);
  }

  // The hand-written standard first, and in full. There is no laxer path for model output.
  faults.push(...manifestFaults(slug, raw));

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return faults;
  const m = raw as Record<string, unknown>;

  if (m.wedge !== slug) {
    fault(`the definition calls itself "${String(m.wedge)}" but it is being stored as "${slug}" — those must match`);
  }

  const title = typeof m.title === "string" ? m.title.trim() : "";
  if (!title) fault("the service has no title, so there is nothing to show the founder");
  else if (title.length > AUTHOR_LIMITS.max_title) {
    fault(`the title is ${title.length} characters and the limit is ${AUTHOR_LIMITS.max_title}`);
  }

  // ── 1. no roles ────────────────────────────────────────────────────────────────────────────────
  const provides = Array.isArray(m.provides) ? m.provides : [];
  if (provides.length) {
    fault(
      `a written service cannot take on ${provides.map((r) => `"${String(r)}"`).join(", ")} — ` +
        `those jobs (${ALL_WEDGE_ROLES.join(", ")}) are started by Mycel itself and exactly one service on the ` +
        `whole installation can hold each of them, so one business claiming one would take it from every other business`,
    );
  }

  // ── 2, 3, 4, 6, 7, 8. fields a written service may not have at all ─────────────────────────────
  //
  // `workflows` stays forbidden (points at .mjs that was never written). `packs` is ALLOWED below —
  // those are pinned digests already installed on the box, which the agent may call but not author.
  const forbidden: Array<[string, string]> = [
    ["connections", "it would name one specific connected account; a written service asks for what it needs by capability instead, so it works with whatever this business already uses"],
    ["harness", "it would let the service choose its own tools and permissions, including acting without approval"],
    ["tools", "it would let the service choose its own tools"],
    ["model", "which model runs is our decision, not the service's"],
  ];
  for (const [key, why] of forbidden) {
    if (m[key] !== undefined) fault(`the definition sets "${key}", which a written service may not do: ${why}`);
  }
  if (m.internal === true) {
    fault(`the definition marks itself as internal machinery, but a written service is the work this business sells`);
  }
  if (m.tier !== undefined && !isTier(m.tier)) {
    fault(`"${String(m.tier)}" is not a difficulty this kernel knows (fast, standard, deep)`);
  }

  // ── packs: references to installed pinned mechanics only ───────────────────────────────────────
  if (m.packs !== undefined) {
    if (!Array.isArray(m.packs)) {
      fault(`"packs" must be a list of installed pack names like "share_of_voice@1"`);
    } else if (m.packs.length > 8) {
      fault(`the service references ${m.packs.length} packs and the limit is 8`);
    } else {
      for (const raw of m.packs) {
        const ref = String(raw ?? "");
        if (!parsePackRef(ref)) {
          fault(`"${ref}" is not a pack reference — use name@version, e.g. "share_of_voice@1"`);
          continue;
        }
        if (!resolvePack(ref)) {
          fault(`pack "${ref}" is not installed on this kernel — a written service may only call packs that already exist`);
        }
      }
    }
  }

  // ── workflows: SHARED-library references only, never authored code ───────────────────────────────
  //
  // A written service may not author executable logic — but it MAY reference a verified, kernel-owned
  // primitive (the dunning ladder, reconciliation) by name, exactly as it references an installed
  // pack. That reference is checkable here because `SHARED_WORKFLOWS` is a closed vocabulary in code.
  // A workflow entry that names no known `lib` is the old refusal (it would point at a file nobody
  // wrote); one that does is how a generated service gets real, tested mechanics.
  if (m.workflows !== undefined) {
    if (!Array.isArray(m.workflows)) {
      fault(`"workflows" must be a list of shared-primitive references`);
    } else if (m.workflows.length > 8) {
      fault(`the service references ${m.workflows.length} workflows and the limit is 8`);
    } else {
      for (const raw of m.workflows) {
        const w = isRecord(raw) ? raw : {};
        const name = typeof w.name === "string" ? w.name : "";
        if (!name) {
          fault(`every workflow needs a name`);
          continue;
        }
        if (!isSharedWorkflow(w.lib)) {
          fault(
            `workflow "${name}" must reference a verified shared primitive via "lib" (one of: ${SHARED_WORKFLOWS.join(", ")}) — ` +
              `a written service cannot author its own runnable code`,
          );
        }
      }
    }
  }

  // ── 9, 10. task types ──────────────────────────────────────────────────────────────────────────
  const taskTypes = isRecord(m.task_types) ? m.task_types : undefined;
  const names = taskTypes ? Object.keys(taskTypes) : [];
  if (!names.length) {
    fault("the service does not describe a single job it would do, so there is nothing for it to run");
  } else if (names.length > AUTHOR_LIMITS.max_task_types) {
    fault(
      `the service describes ${names.length} different jobs and the limit is ${AUTHOR_LIMITS.max_task_types} — ` +
        `more than that is more than anybody will read before agreeing to it`,
    );
  }
  for (const name of names) {
    if (!/^[a-z][a-z0-9_]{2,48}$/.test(name)) {
      fault(`"${name}" is not a usable job name — use lower case words joined by underscores, e.g. "draft_proposal"`);
    }
    const spec = taskTypes?.[name];
    if (!isRecord(spec)) {
      fault(`the job "${name}" is not described as an object`);
      continue;
    }
    // The single most important refusal in this file. See point 9 in the header.
    if (!isObjectSchema(spec.output_schema)) {
      fault(
        `the job "${name}" does not say what it produces, so nothing could check its work — ` +
          `it would report success on whatever came back`,
      );
    }
    if (spec.input_schema !== undefined && !isObjectSchema(spec.input_schema)) {
      fault(`the job "${name}" describes what it is given in a form this kernel cannot read`);
    }
    if (spec.tier !== undefined && !isTier(spec.tier)) {
      fault(`the job "${name}" asks for difficulty "${String(spec.tier)}", which is not one of fast, standard, deep`);
    }
    /**
     * ═══ A WRITTEN SERVICE MAY CHOOSE ITS SHAPE, AND NOTHING ELSE ABOUT ITS HARNESS ═══
     *
     * `harness` was refused whole, and the reason (rule 6 in the header) is exact: `HarnessProfileSpec`
     * carries `allow_action_token`, tool grants and permission overrides, so a generated service
     * asking for a harness is asking to act without passing the gate.
     *
     * That reasoning is about the DANGEROUS FIELDS INSIDE a harness spec. It is not about the shape
     * name, and the consequence of refusing the whole object was severe and invisible: an authored
     * service falls back to `general`, so every trade this platform writes for itself can DECIDE and
     * DRAFT and can never OPERATE. Bookkeeping means "produce a document about categorisation"
     * instead of categorising in the client's ledger; recruiting means a shortlist document instead
     * of moving candidates through their ATS. `PLATFORM.md` §3 calls that the difference between a
     * report and a back office, and it applied to every service the catalogue does not already cover
     * — which is the whole population this module exists for.
     *
     * ═══ WHY THIS IS SAFER THAN THE STATUS QUO, NOT LOOSER ═══
     *
     * `SHAPE_DEFAULTS.general.grants_actions` is TRUE. An authored service already holds an action
     * grant today, by falling through to the default. Every shape offered below has
     * `grants_actions: false`, which the shape file calls "the load-bearing line" and which no
     * manifest can negotiate — so declaring one REMOVES the grant. A written service that asks to
     * operate a browser thereby gives up the ability to send, charge or publish, which is exactly
     * the trade `harness-shapes` exists to make as one unit.
     *
     * The set is DERIVED from that property rather than listed, so a shape added later with an action
     * grant cannot become authorable by somebody forgetting to update a list here.
     *
     * `build` is excluded by name and the reason is not risk: it needs a `workspace`, which is still
     * refused below, and a build-shaped job with nowhere to build is a run that deletes its own
     * output. Allowing it would produce services that look configured and cannot work.
     *
     * Anything other than `shape` inside `harness` is still refused, with the original sentence.
     */
    if (spec.harness !== undefined) {
      const h = spec.harness;
      if (!isRecord(h)) {
        fault(`the job "${name}" describes its harness in a form this kernel cannot read`);
      } else {
        const extra = Object.keys(h).filter((k) => k !== "shape");
        if (extra.length) {
          fault(
            `the job "${name}" sets "harness.${extra[0]}", which a written service may not do — ` +
              `it may choose how it works (${AUTHORABLE_SHAPES.join(", ")}) and nothing else`,
          );
        } else if (typeof h.shape !== "string" || !AUTHORABLE_SHAPES.includes(h.shape)) {
          fault(
            `the job "${name}" asks to work as "${String(h.shape)}". A written service may be ` +
              `${AUTHORABLE_SHAPES.join(" or ")} — the ways of working that either cannot act at ` +
              `all, or can only act once you have approved it.`,
          );
        }
      }
    }
    if (spec.packages !== undefined) {
      // A different question from `workspace`, and a sharper one. A hand-authored manifest is a
      // human deciding their trade needs a library; this would be a MODEL choosing what to install
      // into a sandbox, which is a supply-chain decision made by something that cannot be asked why.
      fault(
        `the job "${name}" asks to install software, which a written service may not do — ` +
          `a library it needs has to be added by a person`,
      );
    }
    if (spec.workspace !== undefined) {
      fault(
        `the job "${name}" sets "workspace", which a written service may not do — a workspace is a ` +
          `directory of code the sandbox builds and exports, and that needs a provenance story this ` +
          `does not have`,
      );
    }
    const waits = spec.waits_for;
    if (waits !== undefined) {
      if (!isRecord(waits) || waits.on !== "client_request" || typeof waits.reason !== "string" || !waits.reason.trim()) {
        fault(`the job "${name}" describes waiting for the client in a form this kernel cannot arm`);
      } else if (typeof waits.resume !== "string" || !names.includes(waits.resume)) {
        // A dangling resume is a case that parks forever: the client answers and nothing picks it up.
        fault(
          `the job "${name}" says it would carry on with "${String(waits.resume)}" after the client replies, ` +
            `but this service has no such job — the work would stop there and never restart`,
        );
      } else if (waits.resume === name) {
        // `armDeclaredWait` makes this argument too: resuming yourself re-asks the question the
        // client just answered, which reads to them as being ignored.
        fault(`the job "${name}" says it would carry on with itself, which would ask the client the same thing again`);
      }
    }
  }

  // ── 5. approvals ───────────────────────────────────────────────────────────────────────────────
  const approvals = m.approvals;
  if (approvals !== undefined) {
    if (!Array.isArray(approvals)) fault(`"approvals" must be a list`);
    else {
      if (approvals.length > AUTHOR_LIMITS.max_approvals) {
        fault(`the service lists ${approvals.length} things to ask permission for and the limit is ${AUTHOR_LIMITS.max_approvals}`);
      }
      for (const a of approvals) {
        if (!isRecord(a) || typeof a.action !== "string" || !a.action.trim()) {
          fault("one of the permissions has no action on it");
          continue;
        }
        if (!RISKS.includes(a.risk as Risk)) {
          fault(`the permission for "${a.action}" has risk "${String(a.risk)}" — it must be one of ${RISKS.join(", ")}`);
        }
        if (a.required === false) {
          fault(
            `the permission for "${a.action}" is marked as not required, which means it is not a permission — ` +
              `a written service asks before every outward action`,
          );
        }
      }
    }
  }

  // ── 10. capabilities, cases, intake ────────────────────────────────────────────────────────────
  const capabilities = Array.isArray(m.capabilities) ? m.capabilities : [];
  if (capabilities.length > AUTHOR_LIMITS.max_capabilities) {
    fault(
      `the service asks to be connected to ${capabilities.length} things and the limit is ${AUTHOR_LIMITS.max_capabilities} — ` +
        `every one of them is a setup step the founder has to complete before anything runs`,
    );
  }

  const cases = m.cases;
  if (cases !== undefined) {
    const stages = isRecord(cases) && Array.isArray(cases.stages) ? cases.stages : undefined;
    if (!stages || !stages.length || stages.some((s) => typeof s !== "string" || !s.trim())) {
      fault(`"cases" must list the stages a piece of work moves through, as words`);
    } else {
      if (stages.length > AUTHOR_LIMITS.max_case_stages) {
        fault(`the service describes ${stages.length} stages and the limit is ${AUTHOR_LIMITS.max_case_stages}`);
      }
      const initial = (cases as Record<string, unknown>).initial;
      if (initial !== undefined && !stages.includes(initial as string)) {
        // Otherwise every new engagement starts in a stage the stage machine does not contain, and
        // nothing can ever advance it.
        fault(`work is said to start at "${String(initial)}", which is not one of the stages listed`);
      }
    }
  }

  const intake = m.intake;
  if (intake !== undefined) {
    if (!Array.isArray(intake)) fault(`"intake" must be a list of questions`);
    else if (intake.length > AUTHOR_LIMITS.max_intake_questions) {
      fault(`the service wants to ask ${intake.length} setup questions and the limit is ${AUTHOR_LIMITS.max_intake_questions}`);
    } else {
      for (const q of intake) {
        if (!isRecord(q) || typeof q.id !== "string" || !/^[a-z][a-z0-9-]{1,48}$/.test(q.id)) {
          fault(`one of the setup questions has no usable id (lower case words joined by hyphens)`);
        } else if (typeof q.ask !== "string" || !q.ask.trim()) {
          fault(`the setup question "${q.id}" has nothing to ask`);
        }
      }
    }
  }

  return faults;
}

/**
 * "Which X do you use?" — the identity question, whose only honest answer is a product name.
 *
 * Requires BOTH a system-ish noun and the "do you use" shape, so it catches the dead end without
 * touching the questions worth asking. `What is your booking system's cancellation policy?` has the
 * noun and not the shape; `Which practice management system do you use?` has both.
 */
const NAMES_A_PRODUCT =
  /\b(which|what)\b[^?]*\b(system|software|tool|platform|provider|app|suite)\b[^?]*\b(do|are)\s+you\s+(use|using|on|run|running)\b/i;

/** The field a job reports a refusal through. One name, so `not_when` and the grader agree. */
const COULD_NOT = "could_not_complete";

/**
 * Does this job already have a way to say it could not do the work?
 *
 * Mirrors `hasRefusal` in `deliverable-grade.ts` deliberately — the grader decides whether the
 * finding fires and this decides whether to fix it, and two different answers would mean a service
 * repaired into a state the grade still complains about.
 */
function hasRefusalPath(properties: Record<string, unknown>, checks: unknown): boolean {
  if (Array.isArray(checks) && checks.some((c) => isRecord(c) && c.kind === "not_when")) return true;
  for (const prop of Object.values(properties)) {
    if (!isRecord(prop) || !Array.isArray(prop.enum)) continue;
    if (prop.enum.some((v) => typeof v === "string" && /^(not_|no_|none|unavailable|blocked|insufficient|cannot)/i.test(v))) {
      return true;
    }
  }
  return false;
}

const RISKS: readonly Risk[] = ["low", "medium", "high"];

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Is this a JSON Schema the kernel's validator can actually use?
 *
 * Deliberately shallow: `validateOutput` is itself shallow, and demanding a schema this module can
 * fully verify would refuse valid schemas that the thing consuming them accepts. What it rules out
 * is the shape that actually comes back from a model that did not understand the ask — a string, a
 * bare `true`, or `{}` with no properties, all of which validate everything and therefore nothing.
 */
function isObjectSchema(v: unknown): boolean {
  if (!isRecord(v)) return false;
  if (v.type !== undefined && v.type !== "object") return false;
  return isRecord(v.properties) && Object.keys(v.properties).length > 0;
}

// ═══════════════════════════ PARSING WHAT THE MODEL SAID ═══════════════════════════

/**
 * Turn one model run's output into a draft, or into sentences saying why not.
 *
 * NOTHING IS REPAIRED HERE, and that is a decision rather than an omission. `reconcileShape` in the
 * cloud repairs a wedge NAME because there is a closed catalogue to snap it to and the cost of not
 * repairing is a founder told we cannot help them. There is no such target here: a manifest is the
 * thing being authored, so "repairing" it means this function quietly deciding what the business
 * does. The refusal is honest and the founder can be asked again.
 *
 * `slugBase` is supplied by the caller rather than taken from the model, because the slug is an
 * identifier the store keys on and a model that emitted `../invoice-chaser` should not get to
 * choose it. It is normalised hard and then marked as authored.
 */
/**
 * Bounded, honest repair of a generated manifest BEFORE it is judged — the authoring equivalent of
 * `repairOutput`. It fixes the ONE shape the model reliably gets wrong on iterative delivery work
 * (design, dev, content, anything multi-week), and nothing else: a job whose `waits_for` resumes
 * ITSELF, or resumes a job that does not exist. Both are broken loops, not stages — a self-resume
 * re-asks the client the question they just answered; a dangling resume parks the work forever.
 *
 * The model reaches for the self-loop because that IS the natural shape of iterative delivery ("do
 * some, get feedback, keep going"), and a prohibition in the skill was not enough to stop it —
 * observed in production, a real design/dev-agency brief hit this twice and the magic moment died on
 * "we couldn't build you a service". So instead of failing the founder, drop the broken wait: the
 * job becomes single-shot — it does the work, produces its declared output, and stops. The agent can
 * still pause for a decision through the approval/gap path (see `how-we-deliver`); what it loses is a
 * DECLARED structured wait that could never have armed. Nothing is invented — a founder reviewing the
 * card sees exactly the jobs the model proposed, minus a loop that could not run. The genuinely
 * iterative shape (draft → revise) stays reachable: the founder splits the job later.
 */
/**
 * Common capability-naming mistakes the model makes, mapped to the real name. These are morphological
 * (a plural/singular slip) or a plain synonym for a capability that genuinely exists — NOT a fuzzy
 * guess at intent. Mapping them turns a refusal into a runnable service; anything not here still
 * faults, because an unmappable capability is a real "we don't know what you meant".
 */
const CAPABILITY_ALIASES: Record<string, CapabilityName> = {
  email: "send_email",
  send_emails: "send_email",
  read_payment: "read_payments",
  read_invoice: "read_invoices",
  read_bank: "read_bank_transactions",
  read_bank_transaction: "read_bank_transactions",
  read_calendars: "read_calendar",
  book_calendars: "book_calendar",
  read_ad: "read_ads",
  write_ad: "write_ads",
  publish: "publish_content",
  publish_posts: "publish_content",
};

/** The hard bounds on a self-authored allowance. Tighter than any hand-written wedge, on purpose. */
export const AUTHORED_POLICY_MAX_RULES = 3;
export const AUTHORED_POLICY_MAX_PER_DAY = 10;

/**
 * Clamp a written service's day-one allowances to something a founder could regret only mildly.
 *
 * The asymmetry to keep in view: a HAND-written envelope (books-keeper's, say) was reasoned about
 * by a person who read policy.ts; this one was written by the same model that will benefit from
 * it. So every rule must be:
 *
 *   · EXACT. No `*`, no prefix forms. policy.ts honours prefixes for hand-written rules; an
 *     authored rule that said `email:` would cover every email verb the platform ever grows.
 *   · BOUNDED BY COUNT. `max_per_day` is required and clamped to 10 — half the ceiling a founder
 *     may write by hand — and `max_per_task` clamps the same way when present.
 *   · NEVER ABOUT MONEY. A rule carrying `max_amount_usd` is dropped whole. "Auto-approve up to
 *     $X" is money autonomy nobody demonstrated a need for; the earned path (standing grants,
 *     suggested from the founder's own decisions) is how that trust gets built instead.
 *   · FEW. Three rules. A service that needs more day-one autonomy than that needs a conversation,
 *     not a manifest.
 *
 * Silently repairs rather than refuses, matching everything else in this function: removing an
 * allowance the service was never entitled to changes nothing the founder was promised.
 */
export function sanitiseAuthoredPolicy(manifest: Record<string, unknown>, notices: ManifestFault[] = []): void {
  const note = (message: string) => notices.push({ wedge: String(manifest.title ?? "the draft"), message });
  const policy = manifest.policy;
  if (!isRecord(policy)) {
    if (policy !== undefined) note("The draft wrote an allowance that was not a set of rules, so it was removed.");
    delete manifest.policy;
    return;
  }
  const asked = Array.isArray(policy.auto_approve) ? policy.auto_approve.length : 0;
  const raw = Array.isArray(policy.auto_approve) ? policy.auto_approve : [];
  const clean: Record<string, unknown>[] = [];
  for (const r of raw) {
    if (!isRecord(r)) continue;
    const action = typeof r.action === "string" ? r.action.trim() : "";
    if (!action || action === "*" || action.endsWith("*") || action.endsWith(":")) continue;
    if (r.max_amount_usd !== undefined) continue;
    const perDay = typeof r.max_per_day === "number" && Number.isFinite(r.max_per_day) ? r.max_per_day : NaN;
    if (!(perDay >= 1)) continue;
    const rule: Record<string, unknown> = {
      action,
      max_per_day: Math.min(AUTHORED_POLICY_MAX_PER_DAY, Math.floor(perDay)),
    };
    const perTask = typeof r.max_per_task === "number" && Number.isFinite(r.max_per_task) ? r.max_per_task : undefined;
    if (perTask !== undefined && perTask >= 1) rule.max_per_task = Math.min(AUTHORED_POLICY_MAX_PER_DAY, Math.floor(perTask));
    clean.push(rule);
    if (clean.length >= AUTHORED_POLICY_MAX_RULES) break;
  }
  if (clean.length) manifest.policy = { auto_approve: clean };
  else delete manifest.policy;

  /*
    THE NOTICE THAT MATTERS MOST ON THIS WHOLE PAGE.

    A written service MAY carry day-one allowances — that reversal was deliberate, because a
    business that asks permission for everything on day one is a gate the founder learns to stop
    reading. What the model may not do is decide their SIZE, and the clamp here is harder than any
    hand-written wedge gets, because the author is the thing being granted.

    Silently, that reads as generosity. Said out loud it is the single most useful sentence a
    review card can carry about the thing that wrote this service: it asked to act on its own N
    times and was allowed M. A founder who reads that once will read every future draft properly.
  */
  const kept = clean.length;
  if (asked > kept) {
    note(
      kept === 0
        ? `The draft asked to act on its own ${asked} way${asked === 1 ? "" : "s"} without checking with you. None was allowed — a service nobody has watched run yet does not set its own limits.`
        : `The draft asked to act on its own ${asked} ways without checking with you. ${kept} ${kept === 1 ? "was" : "were"} allowed, each capped well below what a hand-written service gets.`,
    );
  }
}


/** One relation is one gate, however many sources stated it. See `identitiesToChecks`. */
function dedupeChecks(checks: readonly unknown[]): unknown[] {
  const seen = new Set<string>();
  return checks.filter((c) => {
    const key = JSON.stringify(c);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function repairAuthoredManifest(manifest: Record<string, unknown>, notices: ManifestFault[] = []): void {
  const note = (message: string) => notices.push({ wedge: String(manifest.title ?? "the draft"), message });
  // Fields a written service may not have AT ALL — the model reliably copies them from an example
  // wedge it was shown (a role via `provides`, a `policy` envelope, `connections`, `workflows`, the
  // harness knobs). Strip them rather than refuse the whole service: removing a field the service was
  // never allowed to have changes nothing the founder gets, and it is the difference between a
  // runnable service and a dead magic moment. `packs` is deliberately NOT here — those are allowed.
  const STRIPPED: Record<string, string> = {
    provides: "asked to take on one of Mycel's own roles. Those are singletons — one business claiming one takes it from every other on this box — so it was removed.",
    connections: "named its own connections. Which apps a business has is the founder's answer, not the draft's, so it was removed.",
    workflows: "declared its own runnable code. A written service is data; a workflow is a file somebody has to have written, so it was removed.",
    harness: "set its own runtime limits. Those come from the way of working it was given, so they were removed.",
    tools: "picked its own tools. Tools follow from the capability the founder granted, so they were removed.",
    model: "chose its own model. That is a billing decision and it was removed.",
  };
  for (const key of ["provides", "connections", "workflows", "harness", "tools", "model"]) {
    if (manifest[key] !== undefined) note(`The draft ${STRIPPED[key]}`);
    delete manifest[key];
  }
  // `policy` used to be stripped here and refused in `manifestFaults` — "a service nobody has
  // watched run yet gets no such allowance" — and the founder's direction reversed that
  // deliberately: a business that asks permission for everything on day one is a gate the founder
  // learns to stop reading, which kills the gate for the sends that matter. So a written service
  // MAY carry day-one allowances, and the model that wrote them gets no say in their size:
  // `sanitiseAuthoredPolicy` clamps harder than any hand-written wedge is clamped, because the
  // author here is the thing being granted.
  sanitiseAuthoredPolicy(manifest, notices);
  if (manifest.internal === true) delete manifest.internal;
  if (manifest.tier !== undefined && !isTier(manifest.tier)) delete manifest.tier;

  const taskTypes = manifest.task_types;

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════════════
   * THE STRUCTURAL HALF OF `fulfillment`, DERIVED RATHER THAN REFUSED
   * ═══════════════════════════════════════════════════════════════════════════════════════════════
   *
   * `fulfillment` is what makes a service a business: what to ask the client for, what it charges,
   * what they receive, and which job produces it. Without one, kickoff raises no asks, no invoice is
   * drafted and ignition never starts production — which is exactly what the first authored service
   * in production did, five times, for nothing.
   *
   * `draft_service`'s schema now requires it, so a fresh draft arrives with one. This is for the
   * ones that do not: drafts written before that change, and any future output where the model
   * omits it anyway.
   *
   * ═══ WHAT IS INFERRED, AND WHAT DELIBERATELY IS NOT ═══
   *
   * `production_task_type` and `deliverable_shapes` are STRUCTURAL — they are facts about the task
   * types already in this manifest, and the manifest is right there. Deriving them is the same move
   * this function already makes for `ship_requires`.
   *
   * `intake_asks` and `money_plan` are NOT inferred and must never be. What to ask a client for is
   * trade knowledge, and what to charge is the founder's business. Inventing either would put words
   * in a client's mouth and a number on an invoice, and a plausible guess there is worse than a
   * blank because nobody would think to check it. They stay absent, the grade names them as weak,
   * and a person fills them in.
   *
   * The point of splitting it this way is that the BLOCKING finding disappears — a service can now
   * transact as soon as it has a job that produces something, which is a state the manifest can
   * reach on its own. A gate whose only door is "reject and start again" is not a gate.
   */
  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════════════
   * A SETUP QUESTION WHOSE ONLY HONEST ANSWER IS A PRODUCT NAME
   * ═══════════════════════════════════════════════════════════════════════════════════════════════
   *
   * "Which practice management system do you use?" is a textarea. The founder types "Cliniko",
   * nothing connects to Cliniko, the service still has no way into the system it was written for,
   * and both sides believe setup is done.
   *
   * STRIPPED HERE RATHER THAN REFUSED, and that placement is the whole decision. It was a fault
   * first, and measured: authoring four real trades, it refused TWO — a physiotherapy clinic and a
   * dental practice. Those are about as mainstream as service businesses get, and the founder's
   * outcome was `service.draft_refused`, which is "we could not write your service" with no retry
   * behind it. A guard that turns half of ordinary trades away is worse than the question it
   * prevents.
   *
   * Dropping it loses nothing REAL: the answer reached no tool. What the service actually needs is a
   * capability the founder can connect something to, and the contract says so — this notice tells
   * them why a question disappeared rather than leaving it to be noticed.
   *
   * DELIBERATELY NOT INFERRING THE CAPABILITY. "Which practice management system do you use?" does
   * not map to a name without guessing, and a guessed capability appears on the founder's setup
   * screen as a thing to connect, forever, with nothing able to satisfy it. Same rule as
   * `intake_asks` and `money_plan` above: structure is derived, trade knowledge never is.
   */
  const intakeList = manifest.intake;
  if (Array.isArray(intakeList)) {
    const kept = intakeList.filter((q) => !(isRecord(q) && typeof q.ask === "string" && NAMES_A_PRODUCT.test(q.ask)));
    if (kept.length !== intakeList.length) {
      for (const q of intakeList) {
        if (isRecord(q) && typeof q.ask === "string" && NAMES_A_PRODUCT.test(q.ask)) {
          note(
            `The draft asked "${q.ask.trim().slice(0, 70)}" as a setup question. A typed answer ` +
              `connects to nothing, so it was removed — name what the service needs to DO as a ` +
              `capability and the founder connects the system that provides it.`,
          );
        }
      }
      manifest.intake = kept;
    }
  }

  if (isRecord(taskTypes) && !isRecord(manifest.fulfillment)) {
    const names = Object.keys(taskTypes).filter((n) => {
      const spec = (taskTypes as Record<string, unknown>)[n];
      return isRecord(spec) && spec.internal !== true && !isOperationalTaskType(n);
    });
    /**
     * ═══ THE JOB THAT STARTS THE WORK, NOT THE ONE THAT ENDS IT ═══
     *
     * This took the LAST non-machinery job, on the reasoning that "a service reads in order and the
     * thing it hands over is what it ends on". That is a true sentence about the DELIVERABLE and the
     * wrong answer to this question: `production_task_type` is what `sweepFulfillmentIgnition`
     * SPAWNS when an engagement is ready to begin.
     *
     * Read from the one written service live in production — a brand studio's, four jobs in order:
     *
     *     shape_brand_strategy      inputs: positioning, competitors, target_audience, goals
     *     develop_brand_identity    inputs: brand_strategy, approved_feedback
     *     build_marketing_website   inputs: brand_guidelines, website_copy
     *     revise_marketing_website  inputs: feedback, website_url          <- was chosen
     *
     * So a brand-new engagement would have begun by REVISING a website that does not exist, from
     * feedback nobody has given. Every later job takes a previous step's output as input; only the
     * first takes facts about the client. A single-job service makes first and last the same name,
     * which is why this went unseen.
     *
     * A job carrying `deliverable_kind` still wins — an author who says which job hands something
     * over has answered the question directly, and `authoredFaults` keeps that honest.
     */
    const declared = names.find((n) => {
      const spec = (taskTypes as Record<string, unknown>)[n];
      return isRecord(spec) && typeof spec.deliverable_kind === "string";
    });
    const production = declared ?? names[0];
    if (production) {
      const kinds = new Set(
        names
          .map((n) => (taskTypes as Record<string, Record<string, unknown>>)[n]?.deliverable_kind)
          .filter((k): k is string => typeof k === "string"),
      );
      manifest.fulfillment = {
        client_connections: [],
        // Empty, and honestly so: a run that discovers it needs something will raise the ask itself.
        // What cannot be honestly guessed is what to ask for BEFORE the first run.
        intake_asks: [],
        deliverable_shapes: kinds.size ? [...kinds] : ["document"],
        production_task_type: production,
      };
    }
  }

  if (isRecord(taskTypes)) {
    const names = Object.keys(taskTypes);

    // A service where EVERY job is machinery is not a service. `internal: true` exempts a job from
    // declaring a ship bar, on the honest ground that nothing it produces is delivered — so a
    // manifest that marks all of them is either confused about what it sells or has found the way
    // to opt out of the bar entirely. Strip the flag wholesale and let every job be held to what it
    // ships, which is the safe direction: the worst case is a bar on a step nobody reads.
    const specs = Object.values(taskTypes).filter(isRecord);
    if (specs.length > 0 && specs.every((spec) => spec.internal === true)) {
      for (const spec of specs) delete (spec as Record<string, unknown>).internal;
    }

    for (const [name, spec] of Object.entries(taskTypes)) {
      if (!isRecord(spec)) continue;
      const waits = spec.waits_for;
      if (!isRecord(waits)) continue;
      const resume = waits.resume;
      // A wait that resumes ITSELF (re-asks the client) or a job that does not exist (parks forever)
      // is a broken loop, not a stage — drop it and the job becomes single-shot.
      if (typeof resume !== "string" || resume === name || !names.includes(resume)) {
        /*
          The most consequential of the silent repairs, and the last one to get a voice.

          Dropping the wait is right — a resume that names no job parks the engagement forever, and
          one that names itself re-asks the client in a loop. But the job the founder read on the
          review card WAITED FOR THE CLIENT, and the one they get does not: it runs once and
          finishes. That is a change to the shape of the work, not a removed field, so it is the
          notice a founder most needs and the one that was quietest.
        */
        note(
          typeof resume === "string" && resume === name
            ? `"${name}" was written to wait for the client and then start itself again, which is a loop rather than a stage. It runs once now.`
            : `"${name}" was written to wait for the client and then continue as "${String(resume)}", which is not a job in this service. It runs once now instead of waiting for a reply that could never restart it.`,
        );
        delete (spec as Record<string, unknown>).waits_for;
      }
    }
  }

  // A singular/plural slip or a synonym for a real capability ("read_payment", "send_emails") is the
  // model naming a thing that exists in words the kernel does not index. Map it to the real name
  // rather than refusing the whole service over a plural.
  const caps = manifest.capabilities;
  if (Array.isArray(caps)) {
    manifest.capabilities = caps.map((c) => {
      if (typeof c !== "string" || isCapability(c) || !CAPABILITY_ALIASES[c]) return c;
      /*
        Worth telling the founder even though the repair is certainly right. A capability is what
        the service will ASK THEM to connect, so a corrected one changes which button appears on
        their setup screen — and a silent rename means the word on the screen is not the word the
        draft they approved contained.
      */
      note(`The draft asked for "${c}", which is not a thing this kernel can do. It was read as "${CAPABILITY_ALIASES[c]}".`);
      return CAPABILITY_ALIASES[c];
    });
  }

  // `cases.initial` must be one of `cases.stages`. When the model names a starting stage it forgot to
  // list (or lists stages but names no start), point it at the first stage rather than parking the
  // work in a stage that does not exist.
  const cases = manifest.cases;
  if (isRecord(cases) && Array.isArray(cases.stages) && cases.stages.length > 0) {
    const stages = cases.stages.filter((s): s is string => typeof s === "string");
    if (stages.length > 0 && (typeof cases.initial !== "string" || !stages.includes(cases.initial))) {
      cases.initial = stages[0];
    }
  }

  // A title a few characters over the limit is a good title with a long tail, not a broken service —
  // clip it rather than refuse the whole thing.
  if (typeof manifest.title === "string" && manifest.title.length > AUTHOR_LIMITS.max_title) {
    manifest.title = manifest.title.slice(0, AUTHOR_LIMITS.max_title).trimEnd();
  }

  // Approvals: never WEAKEN one, only make a malformed one valid. A missing/odd risk becomes the
  // cautious middle; `required: false` becomes true — the model meant to gate the action, and a
  // service must ask before every outward move regardless.
  if (Array.isArray(manifest.approvals)) {
    for (const a of manifest.approvals) {
      if (!isRecord(a) || typeof a.action !== "string" || !a.action.trim()) continue;
      if (!RISKS.includes(a.risk as Risk)) a.risk = "medium";
      if (a.required === false) {
        note(
          `The draft marked "${a.action}" as not needing your approval. Every outward move asks first, ` +
            "so that was changed back — the promise on the review card would otherwise be false while " +
            "the action still appeared on the list.",
        );
        a.required = true;
      }
    }
  }

  // An intake question with a real ask but no usable id: derive the id from the ask rather than lose
  // the question. The id is internal plumbing (how the answer is filed); the ask is the founder-facing
  // part, and that is what the model got right.
  if (Array.isArray(manifest.intake)) {
    for (const q of manifest.intake) {
      if (!isRecord(q) || typeof q.ask !== "string" || !q.ask.trim()) continue;
      if (typeof q.id !== "string" || !/^[a-z][a-z0-9-]{1,48}$/.test(q.id)) {
        q.id = deriveIntakeId(q.ask);
      }
    }
  }

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════════════
   * EVERY JOB A CLIENT RECEIVES CAN SAY "I COULD NOT"
   * ═══════════════════════════════════════════════════════════════════════════════════════════════
   *
   * A job with no way to report that it had nothing to work from produces something anyway. Measured
   * by authoring four real trades — a physiotherapy clinic, an immigration practice, a cleaning
   * company, a dental practice — and grading the output: every single job of every single one came
   * back `no-refusal-path`. A run with no source data writes a plausible recall list, and the grade's
   * own note says why it matters: zero is a measurement, absence is the truth, and a client reading
   * "no mentions this week" believes you looked.
   *
   * ═══ IT LIVES HERE, AND THAT COST A PRODUCTION MEASUREMENT TO LEARN ═══
   *
   * It was added in `authorWedgeFromOutput`, which runs ONCE — when the model's output is first
   * parsed. On 14 September the three services the meta-agent has ever written in production were
   * dated 9 August, 14 August and 6 September, all before that code existed, and all eleven of their
   * client-facing jobs still graded `no-refusal-path`. The fix had shipped and not one already-written
   * service would ever receive it, because nothing re-runs authoring. A repair that only reaches
   * services authored after the repair was written is a repair for a population of zero.
   *
   * This function runs on EVERY LOAD through `toLoaded`. That is what it is for, and it is why the
   * derivation is pure structure: "this job must be able to report that it could not do the work" is
   * equally true of a dental recall, a visa application and a cleaning rota. Nothing here guesses
   * anything about a trade, which is the rule every other repair in this function obeys.
   *
   * ═══ A BOOLEAN, AND THAT IS NOT COSMETIC ═══
   *
   * `shipFaults` evaluates `not_when` as `at(parsed, unknown_when) === true`, so a check pointed at
   * an enum VALUE can never fire. A gate that silently never runs is worse than no gate, because the
   * service ships believing it is held to something.
   *
   * OPTIONAL, never added to `required`: this runs on services that are already promoted and already
   * running, and making a new field mandatory would fail every run in flight for not setting a flag
   * it had never been told about.
   *
   * DECLARED WINS, like everything else here — a job whose author already gave it a refusal is left
   * alone. And idempotent by construction: the second pass finds the key and writes nothing.
   *
   * SILENT, for the reason the rest of this function is silent. `authoring-notices.test.ts` puts it
   * in one line — a notice on every service is a notice nobody reads. This is structure every job
   * needs, not news about this one.
   */
  for (const spec of Object.values((manifest.task_types ?? {}) as Record<string, unknown>)) {
    if (!isRecord(spec)) continue;
    const tt = spec as { output_schema?: unknown; internal?: boolean; ship_checks?: unknown[] };
    if (tt.internal || !isRecord(tt.output_schema)) continue;
    const properties = (tt.output_schema as { properties?: unknown }).properties;
    if (!isRecord(properties)) continue;
    /*
      AN EMPTY `properties` IS NOT A SCHEMA, AND MUST NOT BE REPAIRED INTO ONE.

      `authoredFaults` refuses `{ type: "object", properties: {} }` with "does not say what it
      produces" — a schema that validates everything is the thin failure that looks configured. The
      first version of this loop did not check, so it wrote one property into that empty object and
      `isObjectSchema` then passed it: a job with no declared output became a stored draft whose only
      field is its own refusal flag. `eval-generation-quality.test.ts` caught it on the first run.

      Adding a field to a schema that has none is not repair, it is invention — the same line every
      other branch of this function stays on.
    */
    if (!Object.keys(properties).length) continue;
    if (properties[COULD_NOT] !== undefined) continue;
    if (hasRefusalPath(properties, tt.ship_checks)) continue;
    properties[COULD_NOT] = {
      type: "boolean",
      description:
        "True when the work could not be done — no source data, an unreachable system, nothing " +
        "to report. Say so here rather than producing an empty or invented answer, and leave " +
        "every measurement below ABSENT rather than zero: a client reading a zero believes you " +
        "looked.",
    };
  }

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════════════
   * AN EVIDENCE FIELD NOBODY ENFORCES IS A COLUMN, NOT A GATE
   * ═══════════════════════════════════════════════════════════════════════════════════════════════
   *
   * business-shaper's own research job carries the argument, and it is the best one in this repo:
   *
   *   > Every finding carries `source`, and `each_has` refuses the output without one. Not because a
   *   > URL proves a claim — it does not — but because a model asked to cite is a model that had to
   *   > go and look, and the difference between reading three real agencies' service pages and
   *   > recalling what such a page usually says is invisible in the prose and total in the result.
   *
   * We apply that to our own meta-agent and to nothing the meta-agent writes. Measured across every
   * service written in production, 14 September: six lists of objects, and FIVE of them already
   * declared an evidence field — `evidence`, `citations`, `source_urls`, `citation_urls`. The author
   * asked for the provenance. Nothing ever refused an entry that omitted it, so a run could return
   * five findings with `evidence` blank and ship.
   *
   * ═══ ONLY WHERE THE FIELD ALREADY EXISTS ═══
   *
   * This never ADDS a source field, and that is the line the whole function runs on. Deciding that a
   * list of proposed actions ought to cite something is a judgement about the trade; noticing that
   * the author already said each entry carries `evidence` and then making that binding is structure.
   * A job whose list has no evidence field keeps its `claims-without-evidence` finding, and a founder
   * reading "nothing makes each entry name where it came from" is being told something true.
   *
   * Arrays of OBJECTS only, for the reason `ship-checks.ts` records in its own header: an `each_has`
   * pointed at a string array does nothing, and a gate that silently never runs is worse than no gate
   * because the service ships believing it is held to something.
   */
  for (const spec of Object.values((manifest.task_types ?? {}) as Record<string, unknown>)) {
    if (!isRecord(spec)) continue;
    const tt = spec as { output_schema?: unknown; internal?: boolean; ship_checks?: unknown[] };
    if (tt.internal || !isRecord(tt.output_schema)) continue;
    const properties = (tt.output_schema as { properties?: unknown }).properties;
    if (!isRecord(properties)) continue;

    const existing = Array.isArray(tt.ship_checks) ? tt.ship_checks : [];
    const already = new Set(
      existing
        .filter((c): c is Record<string, unknown> => isRecord(c) && c.kind === "each_has")
        .map((c) => `${String(c.items)}.${String(c.field)}`),
    );
    const derived: Array<{ kind: "each_has"; items: string; field: string }> = [];

    for (const [listName, listSpec] of Object.entries(properties)) {
      if (!isRecord(listSpec) || listSpec.type !== "array") continue;
      const items = listSpec.items;
      if (!isRecord(items) || items.type !== "object" || !isRecord(items.properties)) continue;
      const field = Object.keys(items.properties).find((k) => SOURCE_FIELD.test(k));
      if (!field || already.has(`${listName}.${field}`)) continue;
      derived.push({ kind: "each_has", items: listName, field });
    }
    if (derived.length) tt.ship_checks = [...existing, ...derived];
  }
}

/**
 * A field name that means "where this entry came from".
 *
 * Deliberately narrow. `source`, `evidence`, `citation` and `reference` are the words a schema uses
 * for provenance and almost nothing else; `basis` and `origin` are near-misses that also name
 * ordinary business fields, so they are out. Binding a gate to the wrong field is how a check ends
 * up refusing correct work, and the cost of missing one is a finding that stays visible — which is
 * the safe direction.
 */
const SOURCE_FIELD = /^(source|sources|source_urls?|source_domains?|evidence|citation|citations|citation_urls?|reference|references|cited_from|quoted_from)$/i;

/** A usable intake id from the question text: lower-case words joined by hyphens, letter-first. */
function deriveIntakeId(ask: string): string {
  let s = ask
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  if (!/^[a-z]/.test(s)) s = `q-${s}`.replace(/-+$/g, "");
  return /^[a-z][a-z0-9-]{1,48}$/.test(s) ? s : "setup-question";
}


/**
 * A skill file needs front matter or `parseSkillDoc` cannot read it, and a page nothing can parse is
 * a page nothing mounts — which is the same silent nothing this whole block exists to avoid.
 */
function withFrontMatter(name: string, description: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
}

export function authorWedgeFromOutput(
  raw: unknown,
  ctx: {
    slugBase: string;
    /**
     * WHAT THE RESEARCH LEARNED ABOUT THE TRADE'S OWN ARITHMETIC.
     *
     * `inferChecks` recovers gates from the SHAPE of a schema, which is a join rather than a
     * judgement and is deliberately silent whenever it is unsure. What it cannot recover is anything
     * the schema does not already imply — and the most valuable relations live in the trade, not in
     * the field names: presented plus rejected plus shortlisted equals screened; hours times rate
     * less the deposit is the balance.
     *
     * `research_service` goes and asks. This is where the answer arrives, and it comes from the
     * TASK INPUT rather than the model's output on purpose: the drafting run could restate an
     * identity it liked and drop one it did not, and then the gates would be as optimistic as the
     * service. What was found is not the drafter's to edit.
     */
    identities?: readonly TradeIdentity[];
    /**
     * The structure a practitioner knows and a novice does not — linking topology in SEO, the order
     * reliefs are applied in tax, how a scorecard is anchored in recruiting. Never gateable, always
     * worth telling the run: it is the difference between work that passes and work that wins.
     */
    mechanics?: readonly TradeMechanic[];
  },
): AuthorResult {
  /*
    Collected across the whole authoring pass and returned WHATEVER the outcome, including the two
    early exits below where nothing has been repaired yet — a caller that has to check `draft` first
    to know whether `notices` exists is a caller that will forget.
  */
  const notices: ManifestFault[] = [];
  const base = normaliseSlugBase(ctx.slugBase);
  if (!base) {
    return { faults: [{ wedge: ctx.slugBase, message: "the service has no usable name to file it under" }], notices };
  }
  const slug = authoredSlug(base);

  if (!isRecord(raw)) {
    return { faults: [{ wedge: slug, message: "the draft did not come back as a service definition at all" }], notices };
  }

  // The model is asked for `{ manifest, skills, knowledge }` so the markdown does not have to be
  // smuggled through JSON string fields inside the manifest. A run that returned only a manifest is
  // still usable — a service with no skills is thin, not broken — so that shape is accepted too.
  const manifestRaw = isRecord(raw.manifest) ? raw.manifest : raw;
  const manifest = { ...manifestRaw, wedge: slug } as Record<string, unknown>;

  // Salvage the broken-loop shape the model reliably produces for iterative delivery work, BEFORE
  // judging — so a normal agency brief becomes a runnable service instead of a dead magic moment.
  repairAuthoredManifest(manifest, notices);

  const faults = authoredFaults(slug, manifest);
  const skills = readFiles(raw.skills, "skills", AUTHOR_LIMITS.max_skills, AUTHOR_LIMITS.max_skill_bytes, faults, slug);
  const knowledge = readFiles(raw.knowledge, "knowledge", AUTHOR_LIMITS.max_knowledge, AUTHOR_LIMITS.max_knowledge_bytes, faults, slug);
  for (const s of skills) {
    if (!skillHasNever(s.content)) {
      faults.push({
        wedge: slug,
        message: `the skill "${s.name}" has no Never — a procedure without a human ceiling will invent, send, or plug`,
      });
    }
  }

  if (faults.length) return { faults, notices };

  // A written service with no procedure still has to start a job. Seed a generic delivery playbook
  // rather than a named trade — the shaper names the work; this only says how episodes stop.
  const mounted =
    skills.length > 0
      ? skills
      : [
          {
            name: "how-we-deliver.md",
            content:
              "---\nname: how-we-deliver\ndescription: Deliver the work in episodes. Stop for review. Do not invent missing facts.\n---\n\n# How we deliver\n\nDo the job this service describes, in episodes. Produce something inspectable. Stop when you need a decision, access, or a brief. Resume from live state, not memory.\n\n## Never\n\n- Never invent logos, numbers, a client, or a trade this house does not sell.\n- Never send, publish, or charge without the founder.\n",
          },
        ];

  /**
   * ═══ WHAT THE RESEARCH LEARNED ABOUT THE TRADE, AS PAGES THE RUN READS ═══
   *
   * `identitiesToChecks` turns the relations it can VERIFY into gates. Everything else it learned
   * would otherwise be thrown away at exactly the wrong moment: an identity naming a field this
   * schema does not have is still true about the trade, and the mechanics — the structure a
   * practitioner knows and a novice does not — were never gateable in the first place.
   *
   * Both were declared and read by nothing when they were first written, which is the failure this
   * codebase produces most: a thing that exists, tests green, and reaches no run. It is the fifth
   * instance found this week and the first one that was mine.
   *
   * They go where a practitioner would put them — in what the agent reads before it starts. Nothing
   * verifies the run honoured them, and that is not a reason to withhold them: an instruction that
   * is followed most of the time beats a fact nobody was told.
   */
  const learned: WedgeFile[] = [];
  const identityPage = identitiesAsSkill(ctx.identities ?? []);
  if (identityPage) learned.push({ name: "what-has-to-add-up.md", content: withFrontMatter("what-has-to-add-up", "The relations this trade expects to hold in the finished work.", identityPage) });
  const mechanicsPage = mechanicsAsSkill(ctx.mechanics ?? []);
  if (mechanicsPage) learned.push({ name: "how-this-trade-is-judged.md", content: withFrontMatter("how-this-trade-is-judged", "The structural rules practitioners follow that a novice would not know.", mechanicsPage) });
  /**
   * ═══ AND WHAT THE FINISHED OBJECT LOOKS LIKE ═══
   *
   * The layer this harness never had. Rules, procedures and arithmetic gates all describe the WORK;
   * none of them describes the ARTEFACT, so a service could know its trade perfectly and hand back
   * a text blob. Measured, not assumed: a real `write_post` run produced 688 excellent words that a
   * founder still had to format before anyone could send them.
   *
   * A SHAPE, not a specimen — see `deliverable-shape.ts` for why a worked example with invented
   * findings is the wrong artefact here, and the ICL result that says so.
   */
  const shapePage = deliverableShapeAsSkill(readDeliverableShape((raw as { deliverable_shape?: unknown }).deliverable_shape), ctx.identities ?? []);
  if (shapePage) learned.push({ name: SHAPE_SKILL_FILE, content: withFrontMatter("the-shape-of-the-finished-work", "What the client actually opens: format, sections, and how deep each one goes.", shapePage) });

  const m = manifest as unknown as WedgeManifest;
  // Appended, never replacing: the model's own skills are what it decided this service needs, and
  // the research is an addition to that rather than an opinion about it.
  mounted.push(...learned);
  m.skills = mounted.map((s) => s.name);
  m.knowledge = knowledge.map((k) => k.name);

  /**
   * ═══ THE GATES, GENERATED WITH THE SERVICE ═══
   *
   * books-keeper's `monthly_close` carries eleven `ship_checks`, every one written after a paying
   * client read a deliverable and objected: a total disagreeing with its own lines, a profit that was
   * not revenue minus costs, £34,000.00 printed for 34000 minor units, a figure stated as due beside
   * a sentence saying it could not be established. Thirty-two client-judged runs, on ONE service.
   *
   * A service authored here got `ship_checks: none` and `ship_requires: none`. Not weaker gates — no
   * gates. The authoring contract does not ask for them and this function never added any, so the
   * first client of every service Mycel invents received work held to nothing, and thirty-two runs of
   * hardening bought exactly one wedge.
   *
   * Hand-writing them per service does not scale past the services we personally wrote, which is the
   * opposite of the product. `inferChecks` reads them off the output schema instead — see the note
   * there on why it is inference rather than a model, and on why it stays silent when unsure.
   *
   * DECLARED WINS. An author that named its own bar keeps it: this fills a hole, it does not overrule
   * a decision. And `readShipChecks` parses what goes in, so an inferred check can never be a kind the
   * evaluator silently drops.
   */
  for (const [name, spec] of Object.entries(m.task_types ?? {})) {
    const tt = spec as {
      output_schema?: unknown;
      internal?: boolean;
      ship_requires?: string[];
      ship_checks?: unknown[];
      chart?: unknown;
    };
    if (!tt.output_schema) continue;
    const clientFacing = !tt.internal;
    // Read BEFORE anything below writes to it, so "the author declared a bar" stays answerable after
    // the inferred and learned checks have been merged in.
    const authorDeclaredChecks = !!tt.ship_checks?.length;
    const inferred = inferChecks(tt.output_schema, { clientFacing });
    if (!tt.ship_requires?.length && inferred.ship_requires.length) tt.ship_requires = inferred.ship_requires;

    /**
     * ═══ AND THE TRADE'S OWN ARITHMETIC, ON TOP OF WHAT THE SHAPE IMPLIES ═══
     *
     * ADDED to the inferred set rather than replacing it. The two know different things: inference
     * reads a total beside a list of figures, and the research read a practitioner saying that
     * presented plus rejected plus shortlisted equals screened. Neither is a superset.
     *
     * Every field an identity names is verified against THIS task's declared output schema — see
     * `identitiesToChecks`. The research learned the trade and did not write the schema, so it is
     * guessing at names, and a `sums_to` pointing at `line_items` when the schema says `lines` never
     * fires, silently, for ever, while the service ships believing it is gated.
     */
    const learned = identitiesToChecks(ctx.identities ?? [], tt.output_schema);
    const merged = [...(inferred.ship_checks ?? []), ...learned];
    // Declared still wins whole: an author that named its own bar keeps it. This fills a hole.
    if (!tt.ship_checks?.length && merged.length) {
      tt.ship_checks = dedupeChecks(merged);
    }
    /**
     * ═══ AND THE PICTURE ═══
     *
     * The checks above are about the work being RIGHT. This is about it being read. A close pack
     * shipped as a wall of correct figures and every client who read one asked where their money was
     * going — the answer was in the numbers and took four minutes to assemble, so most never did.
     *
     * books-keeper carries a hand-written `chart` because somebody sat down after those complaints.
     * A service invented at onboarding got none, so its first client received the wall. Same
     * argument as the checks, and the same posture: silent whenever the schema is ambiguous, and a
     * declared chart always wins.
     */
    /**
     * ═══════════════════════════════════════════════════════════════════════════════════════════════
     * A WAY TO SAY "I COULD NOT", ON EVERY JOB A CLIENT RECEIVES
     * ═══════════════════════════════════════════════════════════════════════════════════════════════
     *
     * Measured by authoring four real trades — a physiotherapy clinic, an immigration practice, a
     * cleaning company, a dental practice — and grading the output with `gradeDeliverables`. Every
     * single job of every single one came back `no-refusal-path`:
     *
     *     "patient_recall" has no way to say it could not do the job, so when it has nothing it
     *     will produce something anyway.
     *
     * That is the deliverable-quality failure with the worst consequence, and it is universal rather
     * than occasional: a run with no source data and no way to report that will write a plausible
     * recall list, and the grade's own note says why it matters — "zero is a measurement; absence is
     * the truth. A client reading 'no mentions this week' believes you looked."
     *
     * STRUCTURE, NOT TRADE KNOWLEDGE, which is what makes it derivable at all under this function's
     * rule. "This job must be able to report that it could not do the work" is true of a dental
     * recall, a visa application and a cleaning rota alike; nothing here guesses anything about the
     * trade. The same argument `ship_requires` above is derived on.
     *
     * A BOOLEAN, and that is not cosmetic. `shipFaults` evaluates `not_when` as
     * `at(parsed, unknown_when) === true`, so a check pointed at an enum VALUE can never fire — a
     * gate that silently never runs is worse than no gate, because the service ships believing it is
     * held to something.
     *
     * DECLARED WINS, like everything else here: a job whose author already gave it a refusal — a
     * `not_when` check or a status enum carrying `none`/`unavailable`/`cannot` — is left alone.
     *
     * ═══ AND IT RUNS AFTER THE MERGE ABOVE, WHICH COST FOUR TESTS TO LEARN ═══
     *
     * Placed before it first, and `ship_checks` became non-empty — so the "declared still wins"
     * guard read the guards below as an author's own bar and skipped the inferred and learned checks
     * entirely. A recruiting service came out holding three `not_when` guards and nothing else: no
     * `sums_to` on the funnel, no `minor_units` on the figure a client pays from. A repair that
     * silences the gates it was added beside is worse than the finding it fixes.
     *
     * SILENT, for the same reason the `ship_requires` derivation above is: a notice on every service
     * is a notice nobody reads, and `authoring-notices.test.ts` says so in those words. This is
     * structure every job needs, not news about this one.
     */
    /*
      THE FIELD IS ADDED BY `repairAuthoredManifest`, WHICH RAN AT THE TOP OF THIS FUNCTION.

      It used to be added here, and here is a place that runs ONCE — when the model's output is first
      parsed. Measured against production on 14 September: the three services the meta-agent has ever
      written were authored on 9 August, 14 August and 6 September, all before this code existed, and
      all three still graded `no-refusal-path` on every client-facing job. Eleven jobs. The fix had
      shipped and none of them would ever receive it, because nothing re-runs authoring.

      `repairAuthoredManifest` is the one that runs on EVERY LOAD, through `toLoaded`, which is what
      a deterministic idempotent repair is for. So the field lives there and reaches the services that
      already exist. What stays here is the ENFORCEMENT below, because it is the only half that needs
      a fact this function has and a load does not: whether the AUTHOR declared their own bar, or
      whether the checks now on the task are ones we inferred a moment ago.
    */
    if (clientFacing && isRecord(tt.output_schema)) {
      const schema = tt.output_schema as { properties?: Record<string, unknown>; required?: unknown };
      const properties = isRecord(schema.properties) ? schema.properties : undefined;
      if (properties && properties[COULD_NOT] !== undefined) {
        /*
          And one `not_when` per measurement, so the refusal is ENFORCED rather than merely offered.
          Numbers only: a string left in place beside a refusal is a note, while a FIGURE beside one
          is a client acting on something we have just said we could not establish.

          NOT WHEN THE AUTHOR DECLARED THEIR OWN BAR. "Declared wins whole" is this function's rule
          and `infer-checks.test.ts` pins it — an author who wrote `ship_checks` keeps exactly those,
          and appending here would overrule a decision rather than fill a hole. They still get the
          FIELD above, so the job can say it could not do the work; what they do not get is a gate
          they did not ask for. The field alone is enough for `gradeDeliverables`, which recognises a
          boolean refusal as one of three valid shapes.
        */
        if (!authorDeclaredChecks) {
          const measured = Object.entries(properties)
            .filter(([k, v]) => k !== COULD_NOT && isRecord(v) && (v.type === "number" || v.type === "integer"))
            .map(([k]) => k);
          const guards = measured.map((field) => ({ kind: "not_when", field, unknown_when: COULD_NOT }));
          if (guards.length) tt.ship_checks = [...(tt.ship_checks ?? []), ...guards];
        }
      }
    }

    if (!tt.chart) {
      const chart = inferChart(tt.output_schema, { clientFacing });
      if (chart) tt.chart = chart;
    }
    void name;
  }

  return { draft: { slug, manifest: m, skills: mounted, knowledge }, faults: [], notices };
}

/** `"Design Studio Delivery"` → `"design-studio-delivery"`. Never produces a traversal or a mark. */
export function normaliseSlugBase(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
}

function readFiles(
  raw: unknown,
  what: string,
  maxCount: number,
  maxBytes: number,
  faults: ManifestFault[],
  slug: string,
): WedgeFile[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    faults.push({ wedge: slug, message: `the ${what} came back in a form this kernel cannot read` });
    return [];
  }
  if (raw.length > maxCount) {
    faults.push({ wedge: slug, message: `the draft includes ${raw.length} ${what} files and the limit is ${maxCount}` });
    return [];
  }
  const out: WedgeFile[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!isRecord(item) || typeof item.name !== "string" || typeof item.content !== "string") {
      faults.push({ wedge: slug, message: `one of the ${what} files has no name or no content` });
      continue;
    }
    // Same argument as the slug: these names are joined onto a path when the sandbox is filled, and
    // a name is not a place. Normalised rather than refused because the model getting the file
    // EXTENSION wrong is not a reason to throw away a correct procedure.
    const name = `${normaliseSlugBase(item.name.replace(/\.md$/i, ""))}.md`;
    if (name === ".md") {
      faults.push({ wedge: slug, message: `one of the ${what} files has no usable name` });
      continue;
    }
    if (seen.has(name)) {
      // Two files with one name means one silently wins, and which one depends on iteration order.
      faults.push({ wedge: slug, message: `two ${what} files are both called "${name}"` });
      continue;
    }
    if (Buffer.byteLength(item.content, "utf8") > maxBytes) {
      faults.push({ wedge: slug, message: `the ${what} file "${name}" is longer than ${maxBytes} characters` });
      continue;
    }
    if (!item.content.trim()) {
      faults.push({ wedge: slug, message: `the ${what} file "${name}" is empty` });
      continue;
    }
    seen.add(name);
    out.push({ name, content: item.content });
  }
  return out;
}

// ═══════════════════════════ WHAT THE FOUNDER SEES ═══════════════════════════

/**
 * The review card.
 *
 * ═══ WHY THIS IS NOT "SHOW THEM THE JSON" ═══
 *
 * the self-improvement system (deleted in 59f1dd83 — 261 sandbox-hours, four proposals, nothing adopted)
 * is the precedent for propose → review → promote, and the half it gets right is
 * that only a human promotes. The half nobody has had to solve until now is what the human is
 * looking AT. A founder cannot read a manifest, and a review nobody can perform is worse than no
 * review: it manufactures consent for whatever the model wrote.
 *
 * So the card answers exactly three questions, in the founder's language, and it is built from the
 * manifest rather than from anything the model wrote in prose — a summary the model authored about
 * its own output is a summary that can be wrong in the founder's favour.
 *
 *   `does`         — what work this business will do. One line per task type.
 *   `needs`        — what it will need permission for. Capabilities, in the words CAPABILITIES uses
 *                    for them, plus the setup questions that must be answered first.
 *   `always_asks`  — what it will never do without asking. Every declared approval, plus the
 *                    guarantee that comes from refusing `policy` outright: there is no envelope, so
 *                    the list is not "these are auto-approved" with a gap for everything unlisted.
 *
 * The words "wedge", "kernel", "harness" and "provision" appear nowhere in the output, because a
 * customer must never see them — `plainEnglish` in the cloud enforces the same rule for the shaper
 * and this is the same surface one step along.
 */
/**
 * ═══ WHICH JOB IS THE ONE ON A CLOCK, AND HOW OFTEN — DERIVED ONCE ═══
 *
 * `authored.routes.ts` creates a schedule the moment a founder agrees to a service, and it picks
 * the job with this rule. It did so silently: the founder was never shown the job, never shown the
 * hour, and never asked. Agreeing to "we wrote this for you" quietly agreed to an 8am weekday tick
 * on a job chosen by a regex nobody could see.
 *
 * The rule moves here so the SCREEN and the SCHEDULER read the same function. Two copies of "which
 * job is the recurring one" is how a review ends up describing a rhythm the product does not keep —
 * and a founder who is told Tuesdays and gets Mondays stops believing the rest of the panel too.
 */
const NOT_A_DESK_TICK = /^(nudge_|deliverable_|check_in|advance_)/;

export function recurringJob(m: WedgeManifest): string | undefined {
  const types = Object.keys(m.task_types ?? {});
  return types.find((t) => !NOT_A_DESK_TICK.test(t)) ?? types[0];
}

/**
 * What the client ends up holding, in the words a client would use.
 *
 * Resolved the way `deliverables.wrap.ts` resolves it at run time — the task type's own
 * `deliverable_kind` first, then the wedge's `fulfillment.deliverable_shapes`, then the authored
 * default of `document` that `fulfillmentOf` applies (an authored service with no fulfillment block
 * still hands over a document; without that default the run goes green and Deliverables stay empty).
 *
 * Same argument as the rhythm above: describing the outcome with a second, independent guess is how
 * a founder is promised a report and sent a link.
 */
const DELIVERABLE_WORDS: Record<string, string> = {
  document: "a written document they can read and keep",
  file_set: "a set of files they can download",
  link: "a page at its own address, published for them",
};

export function deliverableWord(kind: string | undefined): string | undefined {
  return kind ? (DELIVERABLE_WORDS[kind] ?? `a ${kind.replace(/_/g, " ")}`) : undefined;
}

export interface DraftReview {
  title: string;
  /** "It would do these jobs." One entry per task type, in manifest order. */
  does: Array<{ job: string; description: string }>;
  /** "It needs to be connected to these, and you need to answer these first." */
  needs: string[];
  /** "It will always ask you before it does any of this." */
  always_asks: string[];
  /** The unconditional guarantee, stated once. True because `policy` is a refusal above. */
  never_acts_alone: boolean;
  /** Stages an engagement moves through, if it runs long. Empty for one-shot work. */
  stages: string[];
  /**
   * "And here is how the work is checked before your client sees it."
   *
   * ═══ THE MOST DIFFERENTIATED THING IN THE PRODUCT WAS INVISIBLE ═══
   *
   * A founder reviewing a generated service saw what it would do and what it would ask permission
   * for, and nothing about whether the output is any good. That is the wrong omission twice over.
   *
   * It is the moment they decide whether to trust a service a machine wrote twenty seconds ago, and
   * the honest answer — every total is checked against its own lines, a covering note that says
   * nothing is held, a figure printed in the wrong units never reaches you — is the strongest thing
   * we can say. Withholding it makes the draft look like a prompt with a name.
   *
   * And it is the half a founder can actually correct. Nobody reads a JSON schema, but anyone reads
   * "the invoice total must equal the sum of its lines" and knows immediately whether that is true
   * of their trade.
   */
  checks: string[];
  /**
   * "And here is what your client ends up holding."
   *
   * The most concrete question a founder has about a service written for them, and the panel did not
   * answer it. They were shown what it would do, what it needs, what it never does unasked and how
   * the work is checked — four true things, none of which says whether the client receives a
   * document, a folder of files, or a page. One entry per client-facing job; empty for pure
   * machinery, which is a real and correct answer rather than a gap.
   */
  delivers: Array<{ job: string; gets: string }>;
  /**
   * "And it will run on this rhythm, unless you say otherwise."
   *
   * Agreeing used to create a schedule the founder never saw. Naming it here is half the fix; the
   * other half is `POST /v1/services/drafts/:slug/go-live` accepting their choice, so the sentence
   * on the screen is a decision rather than a disclosure.
   */
  rhythm?: { job: string; says: string };
}

export function reviewDraft(draft: AuthoredWedgeDraft): DraftReview {
  const m = draft.manifest;
  const does = Object.entries(m.task_types ?? {}).map(([job, spec]) => ({
    job: job.replace(/_/g, " "),
    description: (spec.description ?? "").trim().slice(0, AUTHOR_LIMITS.max_description) || "No description was given for this.",
  }));

  const needs: string[] = [];
  for (const cap of m.capabilities ?? []) {
    /**
     * ═══ THREE CASES, AND THE MIDDLE ONE USED TO READ AS AN ERROR ═══
     *
     * This was two: a known capability got its title, and anything else got `something called "X",
     * which this kernel no longer offers`. That was right while `CAPABILITIES` was the whole
     * vocabulary — an unrecognised name could only be one removed from the kernel between authoring
     * and review, and saying so is better than crashing the page.
     *
     * It is wrong now, and wrong at the worst moment. A service written for a physiotherapy practice
     * declares `read_appointments` ON PURPOSE, and this is the "What it needs from you first" list
     * on the screen where the founder first meets their own service. They would read that the thing
     * their trade runs on is something we NO LONGER OFFER — about the only sentence that could make
     * a correct draft look broken.
     *
     * The third case is still real and still says so: a name that is neither known nor a well-formed
     * declaration is a capability that genuinely went away.
     */
    if (isCapability(cap)) {
      needs.push(CAPABILITIES[cap as CapabilityName].title);
    } else if (isDeclarableCapability(cap)) {
      // Its own words, said as a sentence. The service chose them; we are not translating a vendor.
      const plain = cap.replace(/_/g, " ");
      needs.push(plain.charAt(0).toUpperCase() + plain.slice(1));
    } else {
      needs.push(`something called "${cap}", which this kernel no longer offers`);
    }
  }
  for (const q of m.intake ?? []) needs.push(q.ask);

  const always_asks = (m.approvals ?? []).map((a) => `${a.action.replace(/[._]/g, " ")} (${a.risk} risk)`);

  /**
   * Read back off the manifest rather than re-inferred, so this describes what the service ACTUALLY
   * carries. A draft whose author declared its own bar shows that bar; re-running the inference here
   * would show a founder gates the service does not have, which is worse than showing none.
   */
  /**
   * ACROSS the whole service, not per job. A founder wants to know what is guaranteed, not to read
   * the same nine guarantees restated for each of six task types — and the job names are ours too
   * (`nudge_client_request` is not a phrase anybody says out loud).
   */
  const allChecks = Object.values(m.task_types ?? {}).flatMap((spec) =>
    readShipChecks((spec as { ship_checks?: unknown[] }).ship_checks),
  );
  const allRequires = Object.values(m.task_types ?? {}).flatMap(
    (spec) => (spec as { ship_requires?: string[] }).ship_requires ?? [],
  );
  const checks = plainChecks(allRequires, allChecks);

  /**
   * Machinery hands over nothing, and saying so is correct rather than a gap — the same distinction
   * `gradeDeliverables` draws with "This is machinery rather than a trade". A service that finds
   * clients or chases money delivers no document and is working perfectly.
   */
  const shapes = (m as { fulfillment?: { deliverable_shapes?: string[] } }).fulfillment?.deliverable_shapes ?? [];
  const fallback = shapes[0] ?? (isAuthoredSlug(m.wedge ?? draft.slug) ? "document" : undefined);
  const delivers = Object.entries(m.task_types ?? {})
    .filter(([name, spec]) => !(spec as { internal?: boolean }).internal && !isOperationalTaskType(name))
    .map(([name, spec]) => ({
      job: name.replace(/_/g, " "),
      gets: deliverableWord((spec as { deliverable_kind?: string }).deliverable_kind ?? fallback) ?? "",
    }))
    .filter((d) => d.gets);

  const recurring = recurringJob(m);

  return {
    title: m.title ?? draft.slug,
    does,
    needs,
    always_asks,
    never_acts_alone: !m.policy,
    stages: m.cases?.stages ?? [],
    checks,
    delivers,
    ...(recurring
      ? { rhythm: { job: recurring.replace(/_/g, " "), says: "every weekday morning" } }
      : {}),
  };
}

/** The one-line summary of what is missing, when authoring failed. Never "something went wrong". */
export function faultSentence(faults: readonly ManifestFault[]): string {
  if (!faults.length) return "";
  const first = faults.slice(0, 3).map((f) => f.message);
  return (
    `We drafted a service for this business and then refused it, because ${first.join("; and ")}` +
    (faults.length > 3 ? `; and ${faults.length - 3} more like that.` : ".")
  );
}

/** Capabilities an author may reference, with the founder-facing question. Handed to the model. */
export function authorableCapabilities(): Array<{ capability: string; title: string; question: string }> {
  return ALL_CAPABILITIES.map((c) => ({
    capability: c,
    title: CAPABILITIES[c].title,
    question: CAPABILITIES[c].question,
  }));
}
