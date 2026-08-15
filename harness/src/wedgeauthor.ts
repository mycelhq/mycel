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
import { SHARED_WORKFLOWS, isSharedWorkflow } from "./workflows";
import { ALL_CAPABILITIES, CAPABILITIES, isCapability, type CapabilityName } from "./capabilities";
import { authoredSlug, isAuthoredSlug, type WedgeFile, type WedgeManifest } from "./wedge";
import { isTier } from "./models";
import type { Risk } from "./contract";
import { parsePackRef, resolvePack } from "./packs";

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
    ["policy", "it would let the service act without asking anybody; a service nobody has watched run yet gets no such allowance"],
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
    for (const key of ["harness", "workspace"]) {
      if (spec[key] !== undefined) fault(`the job "${name}" sets "${key}", which a written service may not do`);
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

export function repairAuthoredManifest(manifest: Record<string, unknown>): void {
  // Fields a written service may not have AT ALL — the model reliably copies them from an example
  // wedge it was shown (a role via `provides`, a `policy` envelope, `connections`, `workflows`, the
  // harness knobs). Strip them rather than refuse the whole service: removing a field the service was
  // never allowed to have changes nothing the founder gets, and it is the difference between a
  // runnable service and a dead magic moment. `packs` is deliberately NOT here — those are allowed.
  for (const key of ["provides", "policy", "connections", "workflows", "harness", "tools", "model"]) {
    delete manifest[key];
  }
  if (manifest.internal === true) delete manifest.internal;
  if (manifest.tier !== undefined && !isTier(manifest.tier)) delete manifest.tier;

  const taskTypes = manifest.task_types;
  if (isRecord(taskTypes)) {
    const names = Object.keys(taskTypes);
    for (const [name, spec] of Object.entries(taskTypes)) {
      if (!isRecord(spec)) continue;
      const waits = spec.waits_for;
      if (!isRecord(waits)) continue;
      const resume = waits.resume;
      // A wait that resumes ITSELF (re-asks the client) or a job that does not exist (parks forever)
      // is a broken loop, not a stage — drop it and the job becomes single-shot.
      if (typeof resume !== "string" || resume === name || !names.includes(resume)) {
        delete (spec as Record<string, unknown>).waits_for;
      }
    }
  }

  // A singular/plural slip or a synonym for a real capability ("read_payment", "send_emails") is the
  // model naming a thing that exists in words the kernel does not index. Map it to the real name
  // rather than refusing the whole service over a plural.
  const caps = manifest.capabilities;
  if (Array.isArray(caps)) {
    manifest.capabilities = caps.map((c) =>
      typeof c === "string" && !isCapability(c) && CAPABILITY_ALIASES[c] ? CAPABILITY_ALIASES[c] : c,
    );
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
      if (a.required === false) a.required = true;
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
}

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

export function authorWedgeFromOutput(raw: unknown, ctx: { slugBase: string }): AuthorResult {
  const base = normaliseSlugBase(ctx.slugBase);
  if (!base) {
    return { faults: [{ wedge: ctx.slugBase, message: "the service has no usable name to file it under" }] };
  }
  const slug = authoredSlug(base);

  if (!isRecord(raw)) {
    return { faults: [{ wedge: slug, message: "the draft did not come back as a service definition at all" }] };
  }

  // The model is asked for `{ manifest, skills, knowledge }` so the markdown does not have to be
  // smuggled through JSON string fields inside the manifest. A run that returned only a manifest is
  // still usable — a service with no skills is thin, not broken — so that shape is accepted too.
  const manifestRaw = isRecord(raw.manifest) ? raw.manifest : raw;
  const manifest = { ...manifestRaw, wedge: slug } as Record<string, unknown>;

  // Salvage the broken-loop shape the model reliably produces for iterative delivery work, BEFORE
  // judging — so a normal agency brief becomes a runnable service instead of a dead magic moment.
  repairAuthoredManifest(manifest);

  const faults = authoredFaults(slug, manifest);
  const skills = readFiles(raw.skills, "skills", AUTHOR_LIMITS.max_skills, AUTHOR_LIMITS.max_skill_bytes, faults, slug);
  const knowledge = readFiles(raw.knowledge, "knowledge", AUTHOR_LIMITS.max_knowledge, AUTHOR_LIMITS.max_knowledge_bytes, faults, slug);

  if (faults.length) return { faults };

  // A written service with no procedure still has to start a job. Seed a generic delivery playbook
  // rather than a named trade — the shaper names the work; this only says how episodes stop.
  const mounted =
    skills.length > 0
      ? skills
      : [
          {
            name: "how-we-deliver.md",
            content:
              "---\nname: how-we-deliver\ndescription: Deliver the work in episodes. Stop for review. Do not invent missing facts.\n---\n\n# How we deliver\n\nDo the job this service describes, in episodes. Produce something inspectable. Stop when you need a decision, access, or a brief. Resume from live state, not memory. Do not invent logos, numbers, or a trade this house does not sell.\n",
          },
        ];

  const m = manifest as unknown as WedgeManifest;
  m.skills = mounted.map((s) => s.name);
  m.knowledge = knowledge.map((k) => k.name);

  return { draft: { slug, manifest: m, skills: mounted, knowledge }, faults: [] };
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
 * `improvement.ts` is the precedent for propose → review → promote, and the half it gets right is
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
}

export function reviewDraft(draft: AuthoredWedgeDraft): DraftReview {
  const m = draft.manifest;
  const does = Object.entries(m.task_types ?? {}).map(([job, spec]) => ({
    job: job.replace(/_/g, " "),
    description: (spec.description ?? "").trim().slice(0, AUTHOR_LIMITS.max_description) || "No description was given for this.",
  }));

  const needs: string[] = [];
  for (const cap of m.capabilities ?? []) {
    // Guarded even though `authoredFaults` has already refused unknown capabilities: `reviewDraft`
    // is also called on rows read back from the store, and a capability removed from the kernel
    // between authoring and review must degrade to a readable line rather than crash the page.
    needs.push(isCapability(cap) ? CAPABILITIES[cap as CapabilityName].title : `something called "${cap}", which this kernel no longer offers`);
  }
  for (const q of m.intake ?? []) needs.push(q.ask);

  const always_asks = (m.approvals ?? []).map((a) => `${a.action.replace(/[._]/g, " ")} (${a.risk} risk)`);

  return {
    title: m.title ?? draft.slug,
    does,
    needs,
    always_asks,
    never_acts_alone: !m.policy,
    stages: m.cases?.stages ?? [],
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
