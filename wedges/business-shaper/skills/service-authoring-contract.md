# The service authoring contract

These are the rules every service you write must follow. They are exactly what the service will
be judged against, so follow them and the service runs; break one and it is refused and the
founder is told we could not build it. Each rule says what to do and why.

## Naming the service

- **Give the service a title the founder would write on their own website, e.g. "Proposals and sign-off", not "proposal_service".**
  Why: The founder reads the title as-is on their dashboard; a code-shaped name reads as someone else's product.

- **Do not set `wedge`/`provides`/`internal` yourself — the service is named and filed for you.**
  Why: Those are Mycel's own machinery; a service claiming them could be confused with an installed one or grant itself a role.

## The jobs it does

- **Every job MUST declare an `output_schema` (a JSON object schema) saying exactly what it produces.**
  Why: Without it nothing can check the work, so the agent would report success on whatever came back — the single most expensive mistake.

- **Keep to at most eight jobs, each a distinct thing the business does.**
  Why: A service the founder cannot hold in their head is one they cannot supervise.

- **If a job takes structured input, describe it as a JSON object schema in `input_schema`.**
  Why: The kernel reads the schema to hand the job its arguments; a non-object shape cannot be armed.

## Work that takes more than one sitting

- **A job's `waits_for.resume` must name a DIFFERENT job — the NEXT stage — never itself. Shape multi-sitting delivery (a website, a brand, a monthly report) as stage-jobs that hand off: `draft_site` (waits_for.resume: `revise_site`) → `revise_site`. If the work is truly one sitting, give it no `waits_for` at all.**
  Why: A job that resumes itself re-asks the client the question they just answered, which reads as being ignored; this is the shape models reach for on iterative work, and it must be a hand-off instead.

- **Any `waits_for.resume` must name a job that actually exists in this same service.**
  Why: A resume pointing at a job you did not write parks the work forever: the client answers and nothing picks it up.

- **A `waits_for` waits on the client: `{ on: "client_request", resume: "<next job>", reason: "<why we're waiting>" }`.**
  Why: That is the only wait the kernel can arm; any other shape cannot pause for the client and would be refused.

## What it needs to be able to do

- **Only name capabilities from the known set (e.g. `send_email`, `read_payments`, `read_invoices`, `read_calendar`). Do not invent one.**
  Why: A capability is a promise the kernel can keep by connecting a real account; an unknown name is a promise nothing can fulfil.

- **Ask for what the service needs to DO via `capabilities`. Never name a specific connected account (`connections`).**
  Why: The founder connects Gmail or Outlook later; the service should say "send email", not pick the vendor.

## What it must ask you first

- **Anything that reaches a client (an email, a published site, a charge) belongs in `approvals` with `required: true` and a risk level.**
  Why: Nothing this service does should reach the outside world without the founder saying yes — an approval with `required: false` is not an approval.

## What it asks the founder up front

- **Ask at most eight `intake` questions, each one changing what the agent visibly does. Never invent a fact about THIS business — ask for it.**
  Why: A question whose answer changes nothing makes a busy founder work for nothing; and a service that invents prices or turnaround is lying to the client.

- **Give each intake question a lower-case-words-joined-by-dashes `id`.**
  Why: The id is how the answer is filed and grounded into every later job; without it the answer has nowhere to live.

## What a written service may never do

- **Do not write `workflows`, `harness`, `tools`, or `model`. No code is being authored, and which tools and model to use are Mycel's decisions.**
  Why: `workflows` points at executable code, and a generated service that could ship code could ship anything; the rest are the kernel's to set safely.

- **Do not set `policy`. Leave the service asking for permission on everything.**
  Why: `policy` is standing permission to act without asking, which no service nobody has watched run should grant itself.

## The words the founder must read

- **In every title and job description, use the founder's words. Never write "wedge", "kernel", "harness", or "provision" — say service, Mycel, job, set up.**
  Why: The founder reads these verbatim; internal machinery words tell them they are looking at plumbing, not their business.
