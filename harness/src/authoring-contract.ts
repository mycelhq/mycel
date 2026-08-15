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
    | "capabilities"
    | "approvals"
    | "intake"
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

  // ── delivery shape (the class that caused the build_website bug) ──
  {
    id: "no-self-resume",
    section: "delivery-shape",
    guidance:
      "A job's `waits_for.resume` must name a DIFFERENT job — the NEXT stage — never itself. Shape multi-sitting delivery (a website, a brand, a monthly report) as stage-jobs that hand off: `draft_site` (waits_for.resume: `revise_site`) → `revise_site`. If the work is truly one sitting, give it no `waits_for` at all.",
    why: "A job that resumes itself re-asks the client the question they just answered, which reads as being ignored; this is the shape models reach for on iterative work, and it must be a hand-off instead.",
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
  capabilities: "What it needs to be able to do",
  approvals: "What it must ask you first",
  intake: "What it asks the founder up front",
  forbidden: "What a written service may never do",
  voice: "The words the founder must read",
};

const SECTION_ORDER: AuthoringRule["section"][] = [
  "identity",
  "jobs",
  "delivery-shape",
  "capabilities",
  "approvals",
  "intake",
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
