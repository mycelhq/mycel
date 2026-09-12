// THE SERVICE AUTHORING CONTRACT — one shapeable list of rules the shaper must follow, in one place.
//
// Before this, what a generated service had to obey lived in three files that drifted: `authoredFaults`
// (the enforcement), `write-a-service.md` (the guidance the model reads), and `repairAuthoredManifest`
// (the salvage). The self-looping-`build_website` bug happened in exactly that gap — the fault existed,
// the guidance was a weak prohibition, and there was no repair, so a normal agency brief died on the
// magic moment. Whack-a-mole.
//
// This is the fix as a CATEGORY, not one bug: every rule the shaper must obey is one entry below, in
// positive "shape it this way" language with the reason. From this one list:
//   · `renderAuthoringContract()` produces the guidance the model is given (write-a-service.md is
//     regenerated from it — see authoring-contract.test.ts, which fails if they drift).
//   · `authoredFaults` (wedgeauthor.ts) enforces it; every fault should trace to a rule id here.
//   · `repairAuthoredManifest` salvages the shapes models reliably still get wrong.
//
// ADDING A NEW FAILURE CLASS is one edit here (rule + why), one line of guidance rendered for free,
// and — where the mistake is deterministically fixable — one repair. That is how the shaper gets more
// businesses right over time instead of the team finding each failure live.

export interface AuthoringRule {
  /** Stable id, referenced by the validator's fault and by tests. */
  id: string;
  /** Which part of a service this governs — used to group the rendered guidance. */
  section:
    | "identity"
    | "jobs"
    | "delivery-shape"
    | "cases"
    | "trade"
    | "capabilities"
    | "approvals"
    | "intake"
    | "procedures"
    | "forbidden"
    | "voice";
  /** Imperative, model-facing. "Do X" / "Never Y" — this is rendered verbatim into the skill. */
  guidance: string;
  /** Why the rule exists, in the founder's terms. Rendered as the reason so the model can generalise. */
  why: string;
}

export const SERVICE_AUTHORING_RULES: readonly AuthoringRule[] = [
  // ── identity ──
  {
    id: "title-present",
    section: "identity",
    guidance: "Give the service a title the founder would write on their own website, e.g. \"Proposals and sign-off\", not \"proposal_service\".",
    why: "The founder reads the title as-is on their dashboard; a code-shaped name reads as someone else's product.",
  },
  {
    id: "name-matches",
    section: "identity",
    guidance: "Do not set `wedge`/`provides`/`internal` yourself — the service is named and filed for you.",
    why: "Those are Mycel's own machinery; a service claiming them could be confused with an installed one or grant itself a role.",
  },

  // ── jobs (task_types) ──
  {
    id: "job-output-schema",
    section: "jobs",
    guidance: "Every job MUST declare an `output_schema` (a JSON object schema) saying exactly what it produces.",
    why: "Without it nothing can check the work, so the agent would report success on whatever came back — the single most expensive mistake.",
  },
  {
    id: "job-count",
    section: "jobs",
    guidance: "Keep to at most eight jobs, each a distinct thing the business does.",
    why: "A service the founder cannot hold in their head is one they cannot supervise.",
  },
  {
    id: "job-input-schema",
    section: "jobs",
    guidance: "If a job takes structured input, describe it as a JSON object schema in `input_schema`.",
    why: "The kernel reads the schema to hand the job its arguments; a non-object shape cannot be armed.",
  },
  /**
   * ═══ THE RULE THE VALIDATOR ENFORCED AND NOBODY EVER STATED ═══
   *
   * `shapelessArrays` in roles.ts refuses any `"type": "array"` in an output schema that carries no
   * `items`, and the contract said nothing about it. The model saw the requirement exactly once, as
   * an incidental `items` inside an example JSON block in write-a-service.md.
   *
   * Measured across eight trades on 31 August: it is the most common reason an authoring run
   * produces nothing. A commercial plumbing service came back complete and was rejected for three
   * untyped arrays in one job — `quotes_to_chase`, `parts_to_chase`, `invoices_to_chase` — every one
   * of which the model would plainly have shaped if asked.
   *
   * Stating a rule the code already enforces is the cheapest fix available: the refusal was correct
   * and the founder still got nothing, because the instruction and the enforcement lived in
   * different files and only one of them was read.
   */
  {
    id: "array-items",
    section: "jobs",
    guidance:
      'Every `"type": "array"` MUST carry an `items` shape, at any depth — including lists of plain ' +
      'strings (`{"type": "array", "items": {"type": "string"}}`).',
    why:
      "An array with no `items` is a list nothing can check: the gate cannot see whether a row has " +
      "the fields it needs, so a job returning twenty empty objects passes exactly like one that did " +
      "the work. The kernel refuses the whole service for it, and this is the most common reason an " +
      "authoring run produces nothing at all.",
  },

  // ── delivery shape (the class that caused the build_website bug) ──
  {
    id: "no-self-resume",
    section: "delivery-shape",
    guidance:
      "A job's `waits_for.resume` must name a DIFFERENT job — the NEXT stage — never itself. Shape multi-sitting delivery (a website, a brand, a monthly report) as stage-jobs that hand off: `draft_site` (waits_for.resume: `revise_site`) → `revise_site`. If the work is truly one sitting, give it no `waits_for` at all.",
    why: "A job that resumes itself re-asks the client the question they just answered, which reads as being ignored; this is the shape models reach for on iterative work, and it must be a hand-off instead.",
  },
  {
    id: "deliverable-shape",
    section: "delivery-shape",
    guidance:
      "Return a `deliverable_shape` beside the manifest: `{ format, sections: [{ heading, must, depth }] }`. " +
      "`format` is what the client OPENS — report, spreadsheet, deck, link — not `document` unless it " +
      "genuinely is one. Each section is a heading a practitioner in this trade would recognise, what " +
      "must be in it, and roughly how much (\"one line\", \"a short paragraph\", \"a table with a row per " +
      "zone\"). Describe the SHAPE only. Put no findings, figures or client names in it.",
    why:
      "Every other rule here describes the WORK; none describes the OBJECT, and a service can know its " +
      "trade perfectly and still hand back a text blob the founder has to format before anyone can send " +
      "it — measured on a real run that produced 688 correct, well-judged, entirely unformatted words. " +
      "DocReward names this as the standing gap in agentic document generation: workflows optimise " +
      "textual quality and overlook structural professionalism, which readers weigh just as heavily. " +
      "Depth is the part prose cannot carry — it is what separates a report from notes about one. " +
      "And it is a shape rather than a worked sample deliberately: an autogenerated specimen would be " +
      "full of invented findings sitting in context beside the real ones, which is the failure " +
      "\"When Correct Demonstrations Hurt\" calls contextual evidence shift, and it worsens on exactly " +
      "the harder tasks this is for.",
  },
  {
    id: "trade-artefacts",
    section: "trade",
    guidance:
      "Name the ARTEFACTS this trade actually moves, using the words the trade uses. Not \"documents\" — an EOB and a claim rejection for a dental practice; a planning application and a validation notice for an architect; a rate confirmation and a proof of delivery for a freight broker; a variation and a retention release for a builder. Every job should produce or consume one of them.",
    why: "A judge playing the founder scores a definition 3 or below when it is general business admin dressed in the trade's vocabulary, and 8 or above when it names the specific artefacts of the trade. Measured across authoring runs, this is the single thing that separates the two, and it is where every low score came from.",
  },
  {
    id: "trade-counterparties",
    section: "trade",
    guidance:
      "Name the third parties the work actually passes through, besides you and your client. An insurer or payer portal, a letting agent, a planning officer, a carrier, a main contractor, a registry. Jobs that touch them say so.",
    why: "Service work is mostly waiting on somebody who is not the client. A definition with only two parties in it describes a freelancer's to-do list, and the founder reads it and sees none of the week that actually costs them.",
  },
  {
    id: "trade-exception-path",
    section: "trade",
    guidance:
      "Write the job for when it goes WRONG, not only the happy path. The claim is denied, the application is invalidated, the invoice is unpaid at 60 days, the tenant is not in, the part did not arrive. Name what happens next: the correction, the resubmission, the chase, the rebooking.",
    why: "This is the job that was missing in every service measured. A dental service that files claims and never works a denial, a plumbing service that books an attendance and never chases access — the happy path is the part that already works. A founder buys the exception handling, because that is where their week goes.",
  },
  {
    id: "trade-clock",
    section: "trade",
    guidance:
      "Name the clock. Trades run on deadlines with real names and real numbers: a filing window, a statutory response period, a payment term, a recall interval, a renewal date. Put them on the jobs they govern.",
    why: "A deadline is what makes a service urgent rather than optional, and a definition without one cannot decide what to do first. It is also the fastest tell that the author knows the trade: the intervals are specific and checkable.",
  },
  {
    id: "trade-money-to-the-end",
    section: "trade",
    guidance:
      "Follow the money to the end of its path. Quoted, agreed, delivered, invoiced, chased, paid, reconciled — whichever of those this trade has. Do not stop at \"send the invoice\".",
    why: "Getting paid is the part of a service business most likely to be broken and least likely to be automated, and every founder description mentions it. Stopping at the invoice leaves the actual complaint — \"invoices nobody pays on time\" — untouched.",
  },
  {
    id: "trade-not-generic",
    section: "trade",
    guidance:
      "Before you finish, read each job back and ask: would this sentence be true of ANY service business? If yes, it is not a job — rewrite it around this trade's artefacts, counterparties and deadlines, or drop it.",
    why: "\"Manage client communications\", \"track project status\", \"handle billing\" pass every structural check and are worth nothing: they describe no trade, so they take no work off anybody's week. This is the last-pass filter that catches them.",
  },
  {
    id: "cases-stages",
    section: "cases",
    guidance:
      'Write a `cases` block: `{"stages": ["...", "..."], "initial": "<the first stage>"}`. Between two and eight stages, in the founder\'s words, naming where a single piece of work actually sits — "quoted", "parts ordered", "attended", "invoiced", "paid" for a plumber; "recall due", "reminded", "booked", "claimed", "paid" for a dental practice.',
    why: "A case IS the engagement — it is how the kernel knows one job for one client is the same piece of work across weeks, and it is the pipeline the founder watches. Measured on real authoring runs, `cases` was omitted every time and every service came back with an empty pipeline, so the review card showed no stages at all. The validator only checks stages when `cases` is present, so omitting it passes silently — which is how this went unnoticed.",
  },
  {
    id: "cases-stages-are-places",
    section: "cases",
    guidance:
      "Stages are where work SITS, not what the agent does. The jobs above are already the doing; a stage is a place a piece of work can be parked and found again.",
    why: '"draft quote" is a job; "quoted" is a stage. Listing the jobs again as stages produces a pipeline that tells the founder nothing they cannot already read above it.',
  },
  {
    id: "cases-initial",
    section: "cases",
    guidance: "`initial` must be one of the stages you listed.",
    why: "Otherwise every engagement starts in a stage the pipeline does not contain and nothing can ever advance it — the kernel refuses the service for this, and it is the easiest fault to avoid.",
  },
  {
    id: "resume-exists",
    section: "delivery-shape",
    guidance: "Any `waits_for.resume` must name a job that actually exists in this same service.",
    why: "A resume pointing at a job you did not write parks the work forever: the client answers and nothing picks it up.",
  },
  {
    id: "wait-shape",
    section: "delivery-shape",
    guidance: "A `waits_for` waits on the client: `{ on: \"client_request\", resume: \"<next job>\", reason: \"<why we're waiting>\" }`.",
    why: "That is the only wait the kernel can arm; any other shape cannot pause for the client and would be refused.",
  },

  // ── capabilities ──
  {
    id: "capabilities-known",
    section: "capabilities",
    guidance: "Only name capabilities from the known set (e.g. `send_email`, `read_payments`, `read_invoices`, `read_calendar`). Do not invent one.",
    why: "A capability is a promise the kernel can keep by connecting a real account; an unknown name is a promise nothing can fulfil.",
  },
  {
    id: "capabilities-not-connections",
    section: "capabilities",
    guidance: "Ask for what the service needs to DO via `capabilities`. Never name a specific connected account (`connections`).",
    why: "The founder connects Gmail or Outlook later; the service should say \"send email\", not pick the vendor.",
  },

  // ── approvals ──
  {
    id: "approvals-required",
    section: "approvals",
    guidance: "Anything that reaches a client (an email, a published site, a charge) belongs in `approvals` with `required: true` and a risk level.",
    why: "Nothing this service does should reach the outside world without the founder saying yes — an approval with `required: false` is not an approval.",
  },

  // ── intake ──
  {
    id: "intake-earns-its-place",
    section: "intake",
    guidance: "Ask at most eight `intake` questions, each one changing what the agent visibly does. Never invent a fact about THIS business — ask for it.",
    why: "A question whose answer changes nothing makes a busy founder work for nothing; and a service that invents prices or turnaround is lying to the client.",
  },
  {
    id: "intake-id",
    section: "intake",
    guidance: "Give each intake question a lower-case-words-joined-by-dashes `id`.",
    why: "The id is how the answer is filed and grounded into every later job; without it the answer has nowhere to live.",
  },

  // ── procedures (skills) ──
  {
    id: "compose-from-arsenal",
    section: "procedures",
    guidance:
      "The matching library runbooks are mounted as skills on this run — copy from those, then specialise with what the research found. `input.picked` names them (no bodies — those are on the skill mount). `input.arsenal` is the rest of the shelf. If a bundle in `input.bundles` covers the work, start there. Only webfetch a SKILL.md from `input.skill_sources` when the shelf has no procedure for that job.",
    why: "A service invented from two sentences is a taxonomy. A service copied from a close, then specialised, is how this business actually runs.",
  },
  {
    id: "skill-never",
    section: "procedures",
    guidance:
      "Every skill MUST contain a human ceiling: a `## Never` heading or a list item that starts with Never (never invent a client, never send, never plug a difference, never mark the books closed). Always is welcome; Never is required.",
    why: "Without a Never the next run has no stop. That is how a GEO job invents a jeweler and a close plugs a hole to look finished.",
  },

  // ── forbidden fields ──
  {
    id: "no-code",
    section: "forbidden",
    guidance: "Do not write `workflows`, `harness`, `tools`, or `model`. No code is being authored, and which tools and model to use are Mycel's decisions.",
    why: "`workflows` points at executable code, and a generated service that could ship code could ship anything; the rest are the kernel's to set safely.",
  },
  {
    id: "no-policy",
    section: "forbidden",
    guidance: "Do not set `policy`. Leave the service asking for permission on everything.",
    why: "`policy` is standing permission to act without asking, which no service nobody has watched run should grant itself.",
  },

  // ── voice ──
  {
    id: "founder-words",
    section: "voice",
    guidance: "In every title and job description, use the founder's words. Never write \"wedge\", \"kernel\", \"harness\", or \"provision\" — say service, Mycel, job, set up.",
    why: "The founder reads these verbatim; internal machinery words tell them they are looking at plumbing, not their business.",
  },
];

const SECTION_TITLE: Record<AuthoringRule["section"], string> = {
  identity: "Naming the service",
  jobs: "The jobs it does",
  "delivery-shape": "Work that takes more than one sitting",
  cases: "The stages a piece of work moves through",
  trade: "The specifics of THIS trade, not business admin in general",
  capabilities: "What it needs to be able to do",
  approvals: "What it must ask you first",
  intake: "What it asks the founder up front",
  procedures: "Where the craft comes from",
  forbidden: "What a written service may never do",
  voice: "The words the founder must read",
};

const SECTION_ORDER: AuthoringRule["section"][] = [
  "identity",
  "jobs",
  "delivery-shape",
  // After the jobs and the hand-offs, because a stage is where the work those jobs produce comes to
  // rest — it reads as nonsense before the reader knows what the jobs are.
  "cases",
  // Before capabilities, because what the service needs to be connected to follows from the
  // artefacts and counterparties named here.
  "trade",
  "capabilities",
  "approvals",
  "intake",
  "procedures",
  "forbidden",
  "voice",
];

/**
 * The contract, rendered as the markdown the shaper is given. Deterministic (stable order, no clock),
 * so a test can assert the committed skill equals this exactly and the two can never drift.
 */
export function renderAuthoringContract(): string {
  const lines: string[] = [
    "# The service authoring contract",
    "",
    "These are the rules every service you write must follow. They are exactly what the service will",
    "be judged against, so follow them and the service runs; break one and it is refused and the",
    "founder is told we could not build it. Each rule says what to do and why.",
    "",
  ];
  for (const section of SECTION_ORDER) {
    const rules = SERVICE_AUTHORING_RULES.filter((r) => r.section === section);
    if (!rules.length) continue;
    lines.push(`## ${SECTION_TITLE[section]}`, "");
    for (const r of rules) {
      lines.push(`- **${r.guidance}**`, `  Why: ${r.why}`, "");
    }
  }
  return lines.join("\n").trimEnd() + "\n";
}
