// A "wedge" is a service the kernel can fulfill. The founder brings four things:
//   wedge.json  — definition (task types + output schema/rubric, tools, approvals, model)
//   skills/     — procedures / know-how (SKILL.md files: how to do the job well)
//   knowledge/  — documents that ground the agent (playbooks, policies, pricing, examples)
//   (per task)  — uploaded documents + connected accounts, passed in task.input
// At run time the harness mounts skills + knowledge (+ task documents) into the sandbox so
// OpenCode can actually do the work. This is how a service becomes solvable.
import { SPINE_TASK_TYPES } from "./spine";
import type { ShipCheck } from "./ship-checks";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Risk } from "./contract";
import type { HarnessProfileSpec } from "./harness";
import type { IntakeQuestion } from "./intake";
import type { WorkspaceSpec } from "./workspace";
import { libraryPath } from "./library";

export interface WedgeTaskType {
  /**
   * ═══ THE KERNEL SENDS WHAT THIS JOB WROTE ═══
   *
   * Declared and read exactly the way `deck`, `chart` and `signs` are.
   *
   * A job with `sends: true` produces `{ channel, subject, message }` and does NOT dispatch it
   * itself. The kernel takes the validated output and puts it through the action proxy — the same
   * grant, the same approval gate, the same audit row the sandbox would have used.
   *
   * WHY THE KERNEL AND NOT THE AGENT. `nudge_client_request` has had `send_email` capability all
   * along and never used it, because nothing told it to: its schema asks for a message and a
   * channel, so a model correctly produces those and stops. Measured cost of that gap: 51 client
   * requests raised in production, 0 ever answered, and all four successful runs holding a finished
   * reminder that no one received. Asking the model more nicely is a fix that works most of the
   * time; taking the message off the validated output is a fix that works.
   *
   * See `deliver-message.ts`.
   */
  sends?: boolean;
  /**
   * How long a PERSON IN THIS TRADE takes to do this job once, in hours.
   *
   * Authored from the research findings, never from our own timings — how long an agent takes is a
   * fact about us; this is a fact about the trade, and it is the only input to what any of this is
   * worth. `value-measure.ts` says why hours and not dollars or activity: hours are what a service
   * business already bills in, so the conversion is a number the founder already defends to clients.
   *
   * Optional, and a job without one still runs. The measurement counts it as UNESTIMATED rather
   * than guessing, which is the whole discipline — a missing figure is a gap, an invented one is a
   * lie that gets multiplied by a rate and shown to a buyer.
   */
  typical_hours?: number;
  /**
   * How hard this job actually is: "fast" | "standard" | "deep".
   *
   * Declared per task_type because a wedge does several different things — classifying an inbound
   * message is not the same work as reconciling a month. Clamped by the org's plan at run time.
   *
   * Kept alongside `harness.tier` as the shorter spelling: wedges already use it, and forcing a
   * nesting level on every existing manifest to gain nothing would be a poor trade.
   */
  tier?: string;
  /**
   * Which of the wedge's capabilities THIS job actually needs. Defaults to all of them.
   *
   * ═══ A CLOSE DOES NOT SEND EMAIL ═══
   *
   * `capabilities` is declared once per wedge and was applied to every task type inside it.
   * books-keeper declares `read_bank_transactions`, `read_invoices` and `send_email` because between
   * them its jobs need all three — but `monthly_close` needs none of the sending. It was still
   * gated on it, so a founder with no mailbox connected got a close whose context said "you cannot
   * send email" and whose agent, reasonably, wrote down that it was blocked.
   *
   * That is a job refusing over access it was never going to use. Declared per task type, the close
   * asks for the ledger and nothing else, and a missing mailbox stops chases without stopping books.
   *
   * Omitted means the wedge's full set — the old behaviour, which is right for a wedge whose jobs
   * genuinely all need the same access, and is why this is not a required field.
   */
  /**
   * The harness spawns this on a schedule; a caller may not create one.
   *
   * Distinct from `internal`, which is about whether a CLIENT sees the output. This is about who
   * creates the row. `gtm_autonomous` is both — machinery, scheduler-dispatched — and
   * `find_prospects` is neither, but the two facts are independent and conflating them would mean a
   * founder-triggered internal job became uncreatable.
   *
   * Enforced at `POST /v1/tasks`. It was previously a sentence in the description ("do not create
   * these by hand"), which is an instruction to a model standing in for a rule — and posting one by
   * hand ran a model in a sandbox for work the scheduler does with neither.
   */
  harness_dispatched?: boolean;
  capabilities?: string[];
  /**
   * A chart for the delivered document, declared rather than written. See `chartBlock` in
   * render/report.ts — the series is a path into this task's own output, so the picture and the
   * figures cannot disagree and the model writes no markup.
   */
  chart?: { series: string; label: string; value: string; title?: string; currency?: string; limit?: number };
  description?: string;
  input_schema?: unknown;
  output_schema?: unknown;
  /**
   * How to engineer the harness for THIS task type — tools, permissions, tier, budgets, whether
   * the run may hold the action token. See harness.ts; every field is a request, clamped by the
   * org's plan and the server's ceilings. Absent means the permissive `general` shape, i.e. exactly
   * what every task got before profiles existed.
   */
  harness?: HarnessProfileSpec;
  /**
   * What this task type starts from and hands back as a DIRECTORY. See workspace.ts.
   *
   * Absent for every wedge that existed before it — and that is the contract: a wedge saying
   * nothing here still produces exactly one `result.txt` and nothing about its run changes.
   */
  workspace?: WorkspaceSpec;
  /**
   * WHAT A SUCCESSFUL RUN OF THIS TYPE MUST HAVE ACTUALLY DONE. See promises.ts.
   *
   * `{ "send": { "unless": { "step": ["hold"], "channel": ["none"] } } }` means: this run must have
   * put an outward action in front of the approval gate before it may be called succeeded, unless
   * its own validated output says it decided to stay silent.
   *
   * Absent on every task type that does not declare it, and such a run is byte-for-byte unchanged.
   * Deliberately declared rather than inferred — the argument is in promises.ts, along with the
   * production run this exists because of.
   */
  promises?: unknown;
  /**
   * Fields of the output that must carry something before the work may reach a client.
   *
   * Read as `unknown` in two places before this and declared nowhere, which is why the compiler
   * could only cast at it. Typed now so a manifest author gets told, and so `ship_checks` below has
   * an obvious neighbour.
   */
  ship_requires?: string[];
  /**
   * ═══ THE RUNG ABOVE `ship_requires`: do the fields AGREE WITH EACH OTHER ═══
   *
   * `ship_requires` asks whether a field carries anything. It is a non-emptiness test, so it accepts
   * a monthly close reporting `reconciled: true` next to `difference_cents: 4200` — a bookkeeper
   * telling a client the books balance while holding a hole — and an invoice whose total disagrees
   * with its own lines, which is a wrong figure in a document the client pays from.
   *
   * `PLATFORM.md` §6 calls this the frontier: "our runs prove they finished; they mostly do not
   * prove they were right... it is what would let the approval gates lift faster." Selective
   * auto-release is bounded by how much can be proven without a human, and until this there was
   * almost nothing.
   *
   * A CLOSED SET, never a script. These run in the KERNEL against JSON, so arbitrary manifest code
   * would be arbitrary code in the control plane — the line vision.md draws in its own words: "the
   * agent may not author, patch, or hot-swap executable logic on a live path." `product-builder`'s
   * shell `verify` is the opposite case and is safe for the opposite reason: it checks a running
   * application, inside a disposable sandbox that already holds the agent.
   *
   * Every member exists because a real task type here has two fields that can contradict each other.
   * See `ship-checks.ts` for the set and the arithmetic.
   */
  ship_checks?: ShipCheck[];
  /**
   * Libraries this job needs in the sandbox that the shared image does not carry.
   *
   * The image is one image for every shape and every trade, which is right until a trade needs
   * something nobody else does — motion graphics need a renderer, spreadsheet work needs a parser.
   * Baking all of those in makes the image enormous for the runs that never touch them; leaving them
   * out means those trades cannot be fitted, which is the constraint FITTING-A-TRADE.md exists to
   * remove. So the job asks, and the kernel installs before the agent's first turn.
   *
   * A NAME, never a command. `packages.ts` refuses anything that is not unambiguously a package
   * name — no flags, URLs, paths or shell — and refuses rather than sanitising, because installing
   * something adjacent to what was asked for is worse than not installing it. A written service may
   * not declare this at all: that would be a model making a supply-chain decision.
   */
  packages?: { npm?: string[]; pip?: string[] };
  /**
   * WHERE THIS TASK TYPE STOPS, and what picks it up again. See `armDeclaredWait` in waits.ts.
   *
   * ═══ WHY A MANIFEST FIELD AND NOT CODE ═══
   *
   * `waits.ts` shipped complete and nothing armed a wait, so the only way an engagement ever parked
   * was a founder knowing the capability existed and asking for it — a feature nobody triggers. The
   * alternative to this field was a `switch (wedge)` in the kernel, which makes waiting something the
   * KERNEL does to three named wedges rather than something a wedge declares about itself; vision.md
   * §7 is explicit that every new wedge should inherit waiting rather than have it reinvented for it.
   *
   * `on: "client_request"` is the only trigger, and deliberately so: a run asking the client for
   * something is the one place the kernel can SEE a run stop, with no model cooperation and no new
   * event. A task type that ends by sending (a dunning chase) is not eligible — see the "no second
   * ladder" section of `armDeclaredWait`.
   */
  waits_for?: {
    /** The observable end-of-run the kernel arms on. One value today; a union so it can grow. */
    on: "client_request";
    /**
     * The task type the resumed run spawns — the NEXT step, never this one.
     *
     * A resume that re-ran the task type which raised the ask would chase the client again the moment
     * they answered it. Validated against this wedge's own manifest at arm time.
     */
    resume: string;
    /** The founder-readable sentence on `/next` and the timeline. Required: "waiting" with no why is noise. */
    reason: string;
  };
  /**
   * How a successful run of THIS type becomes a Deliverable, when the wedge ships more than one shape.
   *
   * Wedge-level `fulfillment.deliverable_shapes` is a list, and wrap used to `find` the first of
   * `document` | `file_set`. A GEO week produces a branded PDF *and* a live page at a URL; those
   * are different nouns, and putting `document` first made every page a PDF. Declaring the kind on
   * the task type is the honest model — the run knows what it made. Absent means wrap still reads
   * the wedge list, so every existing wedge is byte-for-byte unchanged.
   */
  deliverable_kind?: "document" | "file_set" | "link";
  /**
   * WHAT THE FINISHED THING LOOKS LIKE — the template, declared per task type.
   *
   * `deliverable-shape.ts` built this and, until now, mounted it for AI-AUTHORED services only.
   * The thirteen wedges running real engagements — the ones with customers — were told how good
   * the work must be (the exemplar), what must be in the JSON (`output_schema`), and what must
   * carry substance (`ship_requires`), and were never told what the OBJECT looks like. So every
   * run re-invented the section order of a document its trade has produced the same way for
   * decades, which is both a waste of a run and the reason two months of the same close do not
   * look like each other.
   *
   * Per task type, not per wedge: a wedge ships several different nouns. books-keeper's close is
   * a report; its receipt is a message. One shape for both would be nobody's actual format.
   *
   * Optional, and `deliverableShapeAsSkill` returns undefined for a missing or malformed one — a
   * generic skeleton applied to a trade we do not know reads as authoritative and is a guess.
   */
  deliverable_shape?: {
    format?: "document" | "report" | "spreadsheet" | "deck" | "link";
    sections?: Array<{ heading?: string; must?: string; depth?: string }>;
  };
  /**
   * MACHINERY, not a step whose output a client ever opens. The task-type twin of the wedge-level
   * `internal` flag below, and it exists for the same reason: the coarser answer was wrong.
   *
   * ─── THE FAILURE THIS EXISTS FOR ───
   *
   * `compile.ts` decides whether a job is client-facing from `fulfillment.deliverable_shapes`,
   * which is declared on the WEDGE. So every task type inside a wedge that ships anything counted
   * as shipping — including `probe_surface` and `probe_mention`, which measure whether a brand was
   * cited and are read by the report-writer, never by a client; and `daily_sync`, which pulls
   * transactions so a human close has something to close.
   *
   * That inflated the "declares no ship_requires" warning from the jobs that genuinely ship to
   * nearly every job in the kernel, and the inflation was not harmless: the only way to clear a
   * warning on a measurement step is to declare a ship bar for output nobody ships, which is
   * precisely the "field everyone fills in with whatever passes" that the compiler's own note warns
   * turns a real guard into boilerplate. It also made the warning impossible to promote to a
   * refusal, because doing so would have stopped work that was never at risk.
   *
   * Absent means "this ships", because that is the safe default: a step wrongly treated as shipping
   * gets a warning, while a step wrongly treated as machinery gets no bar at all.
   */
  internal?: boolean;
}

export interface WedgeApproval {
  action: string;
  risk: Risk;
  required: boolean;
}

export interface WedgeManifest {
  /** Default tier for every task_type that does not declare one. */
  tier?: string;
  /** Wedge-wide harness defaults, overridden per task_type. See harness.ts. */
  harness?: HarnessProfileSpec;
  /** Wedge-wide workspace default, overridden per task_type — same two-level shape as `harness`. */
  workspace?: WorkspaceSpec;
  wedge: string;
  title?: string;
  /**
   * Machinery, not a service anybody sells. Absent means "a service", because that is what a wedge is.
   *
   * ─── THE FAILURE THIS EXISTS FOR ───
   *
   * `/knowledge` derives its tabs from the wedges that have schedules or tasks, which is the right
   * source — there is no list of "wedges this project uses" anywhere else. But `business-shaper` runs
   * during onboarding and `harness-operator` runs on the kernel's own reflection clock, so both leave
   * tasks behind, so both grew tabs. A founder was shown a tab called "Business Shaper" and invited to
   * teach it, next to a "Books Keeper" tab for a bookkeeping service he does not run.
   *
   * ─── WHY A FLAG HERE RATHER THAN A DENYLIST IN THE CONSOLE ───
   *
   * `/clock` already had one, inline, one entry long (`s.wedge !== "harness-operator"`), and it was
   * already incomplete — it never learned about `business-shaper`. That is the whole argument: a
   * denylist lives wherever somebody noticed the symptom, so the second surface gets a different
   * answer from the first and the third gets none. Whether a wedge is a service is a fact about the
   * wedge, so the wedge declares it once and every surface reads the same declaration.
   *
   * It cannot be INFERRED, and that is worth stating rather than leaving as an open question. Every
   * structural signal is a coincidence of the current set: "declares no connections" also describes a
   * real service that only drafts, and "declares no intake questions" is true of `invoice-chaser`,
   * the most complete service in the repo. Nothing separates machinery from work except intent, and
   * intent has to be stated.
   */
  internal?: boolean;
  /**
   * WHICH KERNEL-INITIATED JOBS THIS WEDGE HOLDS. See roles.ts for the closed set and the argument.
   *
   * ─── THE FAILURE THIS EXISTS FOR ───
   *
   * Seven places in the kernel named a wedge DIRECTORY as a string literal — `DUNNING_WEDGE =
   * "invoice-chaser"`, `GTM_WEDGE = "gtm-operator"`, `wedge: "harness-operator"` — which made "the
   * harness is general and a trade is configuration" half true. The worst of them was the invoice
   * sweep: it spawned a `chase_invoice` task for `invoice-chaser` whether or not that wedge was
   * installed, which is a run with no output schema, no policy envelope and no knowledge.
   *
   * Same shape as `internal` above, and for the same reason: a fact about the wedge belongs on the
   * wedge, stated once, read by every surface. Unlike `internal` it is validated — an unknown role,
   * or a role claimed by a wedge that does not declare the task types the kernel spawns against it,
   * refuses at load. `internal` can afford to be lax because a wrong answer shows a spare tab; a
   * role that silently does not take means the kernel quietly stops chasing invoices.
   */
  provides?: string[];
  /**
   * Roles this trade needs SOMEBODY ELSE to fill.
   *
   * The mirror of `provides`, and it did not exist. books-keeper produces invoices it cannot chase;
   * gtm-operator books meetings it cannot fulfil; every trade needs someone finding the next client.
   * Without this a shape can install a trade whose dependencies are unmet and nothing notices until
   * a run asks for a carrier that is not there and quietly does nothing.
   */
  requires?: string[];
  /**
   * CAN THIS SERVICE PRODUCE A FIRST DELIVERABLE FROM THE CLIENT'S IDENTITY ALONE?
   *
   * ─── THE FAILURE THIS EXISTS FOR ───
   *
   * `cloud/lib/first-hour-live.ts` read, in the middle of the go-live path:
   *
   *     const preferred = deliveryWedges.includes("geo-monitor") ? "geo-monitor" : deliveryWedges[0];
   *
   * One vertical, named as a string literal, in the code that decides what a founder is shown in the
   * first hour of owning the product. It was there for a real reason — a founder who has just gone
   * live and lands on an empty screen stops believing, and a GEO report is the one job that can run
   * on nothing but a domain — but the reason is a PROPERTY, and the property was written down as a
   * name.
   *
   * That is the same mistake `internal` and `provides` above were created to undo, and it costs the
   * same three things: a new vertical cannot be preferred without editing the console, GEO is
   * privileged in the core whether or not the tenant sells it, and the fact lives somewhere no
   * author of a wedge would ever look.
   *
   * ─── WHAT IT ACTUALLY MEANS ───
   *
   * True when the wedge can produce something a client can READ having been given only who the
   * client is — a domain, a name — with no intake answers, no uploaded documents and no waiting on a
   * human. `geo-monitor` qualifies: type a domain, get a report. `books-keeper` does not; it needs a
   * ledger. `contract-desk` does not; it needs a contract.
   *
   * It is NOT "fast" and it is NOT "good to demo". It is a statement about DEPENDENCIES, which is why
   * it can be declared honestly by somebody who has never seen our onboarding.
   *
   * ─── WHY IT CANNOT BE INFERRED ───
   *
   * The tempting signal is "declares no intake questions", and it is wrong in both directions:
   * `invoice-chaser` asks nothing and still needs invoices to exist, while a wedge could ask an
   * optional question and still work without the answer. Like `internal`, this is intent, and intent
   * has to be stated.
   *
   * Lax like `internal` rather than validated like `provides`: a wrong answer here means the founder
   * is offered a first job that turns out to need something, which is recoverable. A wrong `provides`
   * means the kernel quietly stops chasing invoices.
   */
  cold_start?: boolean;
  model?: string;
  task_types?: Record<string, WedgeTaskType>;
  tools?: string[];
  approvals?: WedgeApproval[];
  /**
   * Connection names/ids this wedge's agent may act through (via the action proxy).
   *
   * NAMES A SPECIFIC ROW, so it is only correct where the thing is genuinely singular and genuinely
   * ours — `linkedin` (a captured member session behind our proxy, not a brokered app) and a
   * founder's own bespoke endpoint. It was also how `invoice-chaser` declared `"stripe"` and
   * `books-keeper` declared `"bank-feed"`, which meant a business paid through QuickBooks got an
   * agent that had been granted nothing, silently: the name matched no connection, the grant was
   * empty, and the run went ahead with no hands. Use `capabilities` for anything with alternatives.
   */
  connections?: string[];
  /**
   * What this wedge's agent needs to be able to DO, by capability rather than by vendor.
   *
   * Resolved per project at grant time against whatever the founder actually connected — see
   * `capabilityConnections` in runtime.ts. Validated at load: a capability this kernel does not know
   * is a refusal naming the typo, because a silently-dropped capability is a run with no hands that
   * still reports a clean finish.
   */
  capabilities?: string[];
  /**
   * Capability → the task-input field that settles it.
   *
   * The capability gate refuses a run whose declared capabilities are not connected, and that was
   * right until it started refusing runs that had been HANDED the data. A monthly close posted with
   * sixteen transactions in `input.transactions` was told "no bank feed is connected to this
   * business, so the month cannot be reconciled" — while holding the ledger. Zero deliverables
   * reached a client because of it.
   *
   * So a manifest may name, per capability, the input field that stands in for the connection. The
   * field must be present and non-empty for the capability to count as satisfied. Only capabilities
   * with `satisfiable_by_input` may appear here: reads can be supplied, actions cannot, and
   * `roles.ts` refuses the manifest at load rather than discovering it mid-run.
   */
  capability_inputs?: Record<string, string>;
  /** Long-lived engagements: the stage machine a Case moves through. */
  cases?: { stages: string[]; initial?: string };
  /** Deterministic functions the agent may call. Founder code — the agent picks which one and the
   *  args, never the logic. Implementation is EITHER a per-wedge file (`workflows/<name>.mjs`) OR,
   *  when `lib` is set, a kernel-owned SHARED primitive from the verified library (workflowLibDir()).
   *  A shared reference is how a GENERATED service gets real mechanics without authoring code. */
  workflows?: Array<{ name: string; description?: string; input_schema?: unknown; output_schema?: unknown; lib?: string }>;
  /**
   * Versioned packs this wedge may call (`name@version`). Disk wedges and authored services may
   * both declare these — packs are pinned digests the agent cannot rewrite. See packs.ts.
   */
  packs?: string[];
  /** Policy-bounded autonomy: envelopes inside which actions auto-approve (see policy.ts).
   *  Absent means every action is gated — the safe default. */
  policy?: { auto_approve?: Array<{ action: string; max_amount_usd?: number; max_per_task?: number; max_per_day?: number }> };
  /** What this wedge needs to be told before it can do the job well. Answered once per project;
   *  each answer becomes a knowledge file the agent is grounded on. See intake.ts. */
  intake?: IntakeQuestion[];
  /**
   * Post-close fulfillment glue for this trade — client connects, intake asks, money plan template,
   * outbound deliverable shapes. Read by `kickoff.ts` when a prospect converts or a case is
   * explicitly kicked off. Absent means convert still opens the case; kickoff is a no-op.
   */
  fulfillment?: {
    client_connections?: Array<{ toolkit: string; ask: string; detail?: string }>;
    intake_asks?: Array<{ kind: string; ask: string; detail?: string }>;
    money_plan?: {
      currency: string;
      lines: Array<{ label: string; amount_minor: number; kind: string }>;
    };
    deliverable_shapes?: Array<"document" | "file_set" | "link">;
    /**
     * The task type ignition spawns as "the work" for this trade.
     *
     * Without it, ignition takes the first non-operational type in the manifest. That is correct
     * for books-keeper (`monthly_close` is first among producers) and wrong for geo-monitor, whose
     * first type is a single browser probe — a child of the weekly report, not the deliverable.
     * Declared rather than inferred: task-type order is an authoring accident, and inferring from
     * it would silently start the wrong job the day someone alphabetises the manifest.
     */
    production_task_type?: string;
  };
  /** Skill filenames under skills/ (with or without .md). Omit to load all. */
  skills?: string[];
  /** Knowledge filenames under knowledge/. Omit to load all. */
  knowledge?: string[];
  /**
   * Which shared-library domains reach this wedge — "web-dev", "design", "bookkeeping". A skill in
   * the kernel-owned library tagged with any of these is mounted alongside the wedge's own skills at
   * run time. The seam by which a generated web-dev service inherits web-dev procedure without every
   * founder writing it. Absent means the wedge draws on its own skills only. See skill-library.ts.
   */
  domains?: string[];
}

export interface WedgeFile {
  name: string;
  content: string;
}

export interface LoadedWedge {
  manifest: WedgeManifest;
  dir: string;
  skills: WedgeFile[];
  knowledge: WedgeFile[];
  /**
   * Worked examples of what this trade's output looks like when it is good.
   *
   * The bar a run is held to when the founder has not supplied one of their own. See exemplar.ts:
   * the craft skills are prose, and depth is the one property prose cannot specify and an example
   * conveys for free.
   */
  exemplars: WedgeFile[];
}

export function wedgesDir(): string {
  return process.env.MYCEL_WEDGES_DIR ?? join(process.cwd(), "wedges");
}

/**
 * The kernel-owned SHARED workflow library — verified, parameterized mechanics (dunning, reconcile,
 * prorate…) that any wedge, including a GENERATED one, may reference by name instead of shipping its
 * own executable file. This is the seam that lets the hardcoded catalogue dissolve into the
 * generator: a service is "these primitives, composed", and the primitives live here, not in a
 * per-business directory.
 */
export function workflowLibDir(): string {
  return libraryPath("workflows", process.env.MYCEL_WORKFLOW_LIB_DIR);
}

/**
 * The mark that says "this service was written for ONE business and does not exist on disk".
 *
 * ═══ WHY A RESERVED CHARACTER RATHER THAN A REGISTRY LOOKUP ═══
 *
 * `loadWedge(slug)` has ~50 callers and takes no project id. Once the kernel can author a service
 * per project, every one of those callers becomes a potential cross-tenant read: project B asks for
 * a slug, some shared cache or directory answers with project A's manifest, and B's agent runs A's
 * job with A's policy envelope. Two cross-tenant leaks have already shipped in this repo and both
 * were an identifier that was optional or defaulted, so "add an optional projectId to loadWedge" is
 * the exact shape of the bug, not the fix.
 *
 * The fix is to make the leak IMPOSSIBLE rather than guarded. An authored slug carries a character
 * that cannot occur in a directory name we create, `loadWedge` refuses it outright, and therefore
 * every existing caller answers "unknown service" for an authored slug — fail-closed by
 * construction, with no caller needing to be taught anything. Reaching an authored service requires
 * `loadProjectWedge(projectId, slug)` in authored.ts, whose project id is a REQUIRED positional
 * argument that throws when empty.
 *
 * The property is cheap to check (`isAuthoredSlug` is a string test, no I/O, no store) and it is
 * pinned by a test: for any authored slug, `loadWedge` returns null.
 */
export const AUTHORED_SLUG_PREFIX = "drafted:";

/** Is this the slug of a service the kernel wrote for one business? Lexical — no I/O, no store. */
export function isAuthoredSlug(slug: string | undefined): boolean {
  return !!slug && slug.startsWith(AUTHORED_SLUG_PREFIX);
}

/** `"invoice-chasing"` → `"drafted:invoice-chasing"`. The only place an authored slug is minted. */
export function authoredSlug(base: string): string {
  return `${AUTHORED_SLUG_PREFIX}${base}`;
}

/**
 * A slug that is safe to `join()` onto a directory root.
 *
 * Refuses the authored mark (see above) and, while we are here, refuses path traversal. `loadWedge`
 * previously did `join(root, slug)` on an unvalidated string, so a slug of `"../../etc"` read
 * outside `wedges/` — reachable from `POST /v1/tasks`, which passes `body.wedge` straight in. That
 * was only ever a read of a file named `wedge.json`, which is why it had not bitten, but "only
 * exploitable through a file called wedge.json" is not a security argument.
 */
function isDiskSlug(slug: string): boolean {
  if (!slug || isAuthoredSlug(slug)) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(slug) && !slug.includes("..");
}

/**
 * `root` exists so a caller can read a wedge from somewhere other than the install's own directory.
 *
 * `buildWedgeRoleIndex(dir)` documented itself as pointable at a fixture directory and was not:
 * it passed a slug to a reader that always resolved against `wedgesDir()`, so every fixture manifest
 * came back "could not be parsed as JSON" and the role-clash test appeared to pass for the wrong
 * reason. Defaulted rather than required, because every other caller genuinely means "this install".
 */
/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * EVERY TRADE INHERITS THE SPINE — INCLUDING THE ONES WE WRITE FOR A FOUNDER
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Chasing a client, handling their verdict and checking in on a quiet engagement are the same job in
 * every service business. They were copy-pasted into six manifests each and had already drifted into
 * two or three variants. See `spine.ts`.
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS IS A FUNCTION AND NOT SIX LINES INSIDE `loadWedge`
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Because it was six lines inside `loadWedge`, and there is a second loader.
 *
 * A service WRITTEN for a business — the whole point of `draft_service`, the thing that runs when
 * the catalogue does not cover what a founder actually sells — is stored in `authored_wedges` and
 * loaded by `loadProjectWedge` → `toLoaded`, which returns `row.manifest` verbatim. It never passes
 * through `loadWedge`. So the bespoke service, the one most likely to need help, was the only kind
 * of service in the product that could not chase a client, could not check in on an engagement, and
 * could not take a verdict on its own deliverable.
 *
 * Measured: three services written in production, one promoted and running. None of them had any of
 * those three jobs. The founder's own words for it were "the work is supposed to be done with
 * wedges, but it's not".
 *
 * One function, both callers. A third loader cannot forget it either.
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ONLY A WEDGE THAT SHIPS TO A CLIENT, which is the honest boundary and not a guess. The first
 * version merged the spine into every manifest and six tests said no — correctly. `gtm-operator`
 * finds prospects, `business-shaper` drafts a service during onboarding: neither has a client to
 * chase, a deliverable to hear a verdict on, or an engagement to check in on. Giving them those jobs
 * makes them "takeable" on the next-move list and offers a founder a button that cannot mean
 * anything.
 *
 * `fulfillment.deliverable_shapes` is the wedge's own declaration that it hands something to a
 * client, and it is the same field `compile.ts` uses to decide a job is client-facing.
 *
 * PER TASK TYPE, wedge keys last. A trade inherits the whole job by declaring nothing, and can still
 * narrow one field where it genuinely differs — books-keeper's `capabilities: ["send_email"]` on a
 * nudge is a fact about bookkeeping, not drift, and survives.
 */
export function withSpine(manifest: WedgeManifest): WedgeManifest {
  const declared = manifest.task_types ?? {};
  const shipsToAClient = (manifest.fulfillment?.deliverable_shapes?.length ?? 0) > 0;
  if (!shipsToAClient) return manifest;
  const merged: Record<string, WedgeTaskType> = { ...declared };
  for (const [name, spine] of Object.entries(SPINE_TASK_TYPES)) {
    merged[name] = { ...spine, ...(declared[name] ?? {}) };
  }
  return { ...manifest, task_types: merged };
}

/**
 * Every wedge on disk. Three files inlined this same `readdirSync` filter before it had a name,
 * which is how a rule about what counts as a wedge ends up with three definitions.
 *
 * Returns `[]` rather than throwing on an unreadable directory: a caller listing wedges to decorate
 * a response should degrade, not take the response down with it.
 */
export function listWedges(root: string = wedgesDir()): string[] {
  try {
    return readdirSync(root).filter((d) => existsSync(join(root, d, "wedge.json")));
  } catch {
    return [];
  }
}

export function loadWedge(slug: string, root: string = wedgesDir()): LoadedWedge | null {
  // THE TENANCY GATE. An authored slug names a service that belongs to exactly one project and lives
  // in a project-scoped table, never on disk; answering here — with no project in hand — is the leak.
  // Returning null makes every existing caller say "unknown service", which is the honest answer for
  // a reader that cannot express which tenant is asking. See AUTHORED_SLUG_PREFIX above.
  if (!isDiskSlug(slug)) return null;
  const dir = join(root, slug);
  const manifestPath = join(dir, "wedge.json");
  if (!existsSync(manifestPath)) return null;
  let manifest: WedgeManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as WedgeManifest;
  } catch {
    return null;
  }
  /**
   * ═══ EVERY TRADE INHERITS THE SPINE ═══
   *
   * Chasing a client, handling their verdict and checking in on a quiet engagement are the same job
   * in every service business, and they were copy-pasted into six manifests each — already drifted
   * into two or three variants. See `spine.ts`.
   *
   * Merged HERE rather than at the forty-odd `manifest.task_types?.[x]` call sites, for the reason
   * this file already applies to skills: one place that resolves, many readers. A consumer cannot
   * forget to do it.
   *
   * PER TASK TYPE, wedge keys last. A trade inherits the whole job by declaring nothing, and can
   * still narrow one field where it genuinely differs — books-keeper's `capabilities: ["send_email"]`
   * on a nudge is a fact about bookkeeping, not drift, and survives.
   */
  manifest = withSpine(manifest);
  /**
   * A NAMED SKILL IS LOOKED FOR ON THE WEDGE'S OWN SHELF FIRST, THEN ON THE SHARED ONE.
   *
   * Skills used to resolve only from `wedges/<name>/skills/`, so a manifest naming one that lived
   * anywhere else mounted NOTHING — no error, no warning, just a run missing the instructions its
   * author thought they had given it. `skillsInWedge` is the test that turns that into a red build.
   *
   * The fallback exists because some craft is genuinely not a trade. `work-a-system` — how to read
   * and change things inside software that has no API — is used by the desk that pulls invoices from
   * a supplier portal, the one that reads timesheets out of a staffing system, and the one that
   * publishes a page to a client's CMS. Copying it into three `skills/` directories would make three
   * copies to drift, and putting it in one wedge would hide it from the other two.
   *
   * The wedge's own directory still wins. A desk that needs its own version of a shared procedure
   * writes one and gets it, without having to rename it to avoid a collision.
   */
  /**
   * ═══ A TASK TYPE NAMING A SKILL IS A DECLARATION THAT IT IS NEEDED ═══
   *
   * `manifest.skills` was the only list read, and it acts as a FILTER: name three and the other four
   * files in the directory are not loaded. Task types name their own skills in `harness.skills`, and
   * those were resolved against whatever the wedge-level filter happened to admit.
   *
   * So a skill could sit on disk, be named by the job that needs it, and never mount. Two were:
   *
   *   gtm-operator lists only `reading-signals.md`, and `draft_engagement` asks for
   *   `write-the-engagement.md`. Every proposal this product has ever drafted was written WITHOUT
   *   the skill that says how to draft one.
   *
   *   business-shaper lists four, and `research_service` asks for `research-a-service.md`.
   *
   * No error, no warning. The manifest is valid, the wedge loads, the run succeeds and does the job
   * worse than its author believed, for as long as nobody looks. `wedge-skills-resolve.test.ts` is
   * what turns that into a red build.
   *
   * The union, not a replacement: a wedge-level list still means "every job gets these".
   */
  const named = new Set<string>();
  const add = (xs: readonly string[] | undefined) => {
    for (const x of xs ?? []) named.add(x.endsWith(".md") ? x : `${x}.md`);
  };
  add(manifest.skills);
  for (const spec of Object.values(manifest.task_types ?? {})) {
    add((spec as { harness?: { skills?: string[] } })?.harness?.skills);
  }
  /**
   * An absent `manifest.skills` still means "everything in this wedge's directory" — geo-monitor
   * relies on it. The union only narrows when the author wrote a list, which is the same rule as
   * before, applied to a list that is now complete.
   */
  const only = manifest.skills || named.size ? [...named] : undefined;
  const skills = readFiles(join(dir, "skills"), only, sharedSkillDirs());
  const knowledge = readFiles(join(dir, "knowledge"), manifest.knowledge);
  /**
   * WORKED EXAMPLES OF THE OUTPUT, shipped with the trade.
   *
   * Not listed in the manifest on purpose, unlike skills and knowledge. Those are a curated set a
   * wedge author chooses from; an exemplar directory is "everything here is the bar", and a manifest
   * list would be one more place to forget a file — which for this particular content means a run
   * silently loses the only thing telling it how good the output has to be.
   */
  const exemplars = readFiles(join(dir, "exemplars"));
  return { manifest, dir, skills, knowledge, exemplars };
}

// ── "can this wedge be asked to do X" ────────────────────────────────────────────────────────────
//
// ═══ WHY THIS LIVES HERE AND NOT IN THE THREE PLACES THAT ASKED IT ═══
//
// The manifest is the SINGLE source of truth for what a wedge can be asked to do. A run spawned for
// a task type no manifest declares arrives with no output schema, no policy rules and no knowledge —
// an agent handed a verb nobody taught it, which is the "fully autonomous theater" vision.md refuses.
//
// Three modules had independently grown the same question. `wedgeCarriesNudge` in nudges.ts had the
// memo and the doc comment; `DeliverableDeps.wedgeCarries` in deliverables.ts declared itself, in
// its own comment, to be "the `wedgeCarriesNudge` question, asked of a verdict"; and adding a fourth
// caller for `check_in_case` would have been the third copy of a `Map<string, boolean>` over the
// same files. Copies of a cache are how one of them ends up stale after a test writes a manifest,
// and `_resetWedgeCache` only ever cleared one of them.
//
// So the lookup is here, next to `loadWedge`, and the callers keep their own names for it.

/** slug → (task type → declared). Wedges are files baked into the image; immutable for a process. */
const declaredTypes = new Map<string, Set<string>>();

function typesOf(wedge: string): Set<string> {
  const hit = declaredTypes.get(wedge);
  if (hit) return hit;
  const set = new Set(Object.keys(loadWedge(wedge)?.manifest?.task_types ?? {}));
  declaredTypes.set(wedge, set);
  return set;
}

/** Does this wedge declare this task type on disk? The gate every spawner consults. */
export function wedgeDeclares(wedge: string | undefined, taskType: string): boolean {
  if (!wedge) return false;
  return typesOf(wedge).has(taskType);
}

/**
 * Does ANY installed wedge declare this task type?
 *
 * The install-wide question, which is a different one and is asked by `upkeep.ts`: a sweep whose
 * every item would be refused for want of a carrier must not be given a clock. Answering it needs a
 * directory scan, so the result is memoised on the same argument the per-wedge memo makes.
 *
 * Reads the directory rather than the role index deliberately. A role is a job the KERNEL initiates
 * and holds exactly one claimant; "can somebody chase a client for a document" is neither — every
 * trade that asks a client for anything needs it, and roles.ts:31 explains at length why that makes
 * a cardinality-one role the wrong axis for it.
 */
const anyDeclares = new Map<string, boolean>();
export function anyWedgeDeclares(taskType: string): boolean {
  const hit = anyDeclares.get(taskType);
  if (hit !== undefined) return hit;
  let slugs: string[] = [];
  try {
    slugs = readdirSync(wedgesDir()).filter((d) => existsSync(join(wedgesDir(), d, "wedge.json")));
  } catch {
    // No wedges directory at all is a real install — `create-mycel-app` boots through it. Nothing
    // declares anything, which is the correct answer and not an error.
    slugs = [];
  }
  const ok = slugs.some((s) => wedgeDeclares(s, taskType));
  anyDeclares.set(taskType, ok);
  return ok;
}

/** Test seam — a test that writes a manifest must be able to invalidate BOTH memos. */
export function _resetWedgeDeclarations(): void {
  declaredTypes.clear();
  anyDeclares.clear();
}

/**
 * The shared shelf, as a list of directories to fall back to.
 *
 * `service-skills/<domain>/*.md` — the same tree `skillsSeedDir()` loads into the skill library.
 * Read straight off disk here rather than through the library, because a wedge is loaded on boot
 * before anything is seeded, and a skill that mounts only after the first seed completes is a skill
 * that is missing on exactly the runs nobody watches.
 */
function sharedSkillDirs(): string[] {
  const root = libraryPath("service-skills", process.env.MYCEL_SERVICE_SKILLS_DIR);
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root)
      .filter((d) => !d.startsWith("."))
      .map((d) => join(root, d))
      .filter((d) => {
        try {
          return statSync(d).isDirectory();
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

/**
 * `only` names files; `alsoLook` are directories tried in order when `dir` does not have one.
 *
 * The fallback applies ONLY to named files. An unnamed load ("everything in this directory") stays
 * exactly that — otherwise a wedge that lists no skills would silently inherit the entire shared
 * shelf, which is a different wedge from the one its author wrote.
 */
function readFiles(dir: string, only?: string[], alsoLook: string[] = []): WedgeFile[] {
  const names = only ?? (existsSync(dir) ? readdirSync(dir).filter((f) => !f.startsWith(".")) : []);
  const out: WedgeFile[] = [];
  for (const name of names) {
    for (const base of [dir, ...(only ? alsoLook : [])]) {
      const p = join(base, name);
      if (!existsSync(p)) continue;
      try {
        out.push({ name, content: readFileSync(p, "utf8") });
      } catch {
        /* skip unreadable */
      }
      break; // the wedge's own copy wins, and one hit is enough
    }
  }
  return out;
}
