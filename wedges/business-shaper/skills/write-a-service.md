# Writing a service for a business we do not already cover

You are here because `draft_shape` looked at this business, looked at everything installed, and
honestly answered **none**. The alternative to what you are about to do is a screen that says "we
can't run this yet", which is the last screen that founder ever sees. So this matters.

You are writing a **definition**, not code. What comes out is checked, in full, before anybody sees
it, and anything that fails is reported to the founder as a refusal — nothing is quietly dropped and
nothing is repaired for you. Then a human reads what it would do and decides whether to run it.

## What you are given

- `description` — what the founder typed about their business. Usually one or two sentences.
- `business_name` — may be a real signal or may be invented marketing. Read
  `how-to-read-a-business-name.md` before you lean on it.
- `capabilities` — the complete list of things a service is allowed to ask to be connected to, each
  with the question the founder would be asked. **You may not invent one.** If the work needs
  something not on this list, write the service without it and say so in a setup question.
- `catalogue` — what is already installed. You are here because none of it fits, but read it anyway:
  it is the best available example of what a good definition looks like, and if you find yourself
  writing something that is 90% one of these, say so rather than duplicating it.

## The one question that decides whether this is any good

> **In a week, what will this business have that it did not have on Monday?**

Not "a system". A drafted proposal that went out. A signed-off scope. A chased sign-off that came
back. If you cannot answer that sentence with something concrete that a specific person receives,
you have written a taxonomy rather than a service, and the founder will read the review card and
decline — correctly.

If they named a website or a page, fetch it before you write. There is no research product here —
`webfetch` is the tool. Read what they actually sell, in their words, then write jobs that do that
work. Guessing a trade from two sentences is how a food-app studio gets a questionnaire desk.

When they agree to run this, the first job is put on a morning clock. Write that first job so it
can run with an empty desk: look for waiting briefs, open cases, unread asks. If nothing is waiting,
say the desk is empty — do not invent a client. Declare `intake` so Home has real questions; an
empty intake is a dead card. Declare `fulfillment.deliverable_shapes` as `["document"]` (or
`file_set` if the work is a pack of files) so a finished job becomes something the client can
accept — a green run that never appears on Deliverables is work nobody got. Write a skill for each
job: that is what the next run mounts as how this business works, and what the founder later edits.

## Start from the work, not from the trade

The trap is to write `design_studio_management`. Trades are nouns; services are verbs. Ask what
actually happens, in order, between a lead arriving and money landing:

> "I run a design studio — I scope projects, send proposals, and chase sign-off."

That is three jobs and a sequence, and the sequence is the service:

- `draft_scope` — turn what the client said into a scope with deliverables and a price
- `draft_proposal` — turn the scope into the document the client actually receives
- `chase_signoff` — the proposal has been out for a week and nobody has said anything

Between one and eight jobs. Fewer, better. Every job you add is another thing the founder has to
read and understand before they will agree to any of it, and a surface too big to review is a
surface nobody reviewed.

## Every job must say what it produces

`output_schema` is not paperwork. It is the only thing standing between this service and a run that
does nothing and reports that it went fine. A job whose schema is missing, or is `{}`, or is a bare
`true`, is **refused** — because a schema that validates everything validates nothing.

Write the schema for the thing a person would actually look at:

```json
"output_schema": {
  "type": "object",
  "properties": {
    "deliverables": { "type": "array", "items": { "type": "string" } },
    "price_minor_units": { "type": "integer", "description": "In the smallest unit of the currency — pence, cents. Never a decimal." },
    "currency": { "type": "string" },
    "assumptions": { "type": "array", "items": { "type": "string" } }
  },
  "required": ["deliverables", "price_minor_units", "currency"]
}
```

Money is always an integer in the smallest unit. Never a float, never a formatted string, never
something that has to be divided by a hundred to be useful.

## Ask for what you need by capability, never by brand

If the work needs to send email, ask for the capability called that in `input.capabilities`. Do not
write "Gmail". A bookkeeper who runs QuickBooks was once shown a checklist that said "Connect Xero",
with no second option and no way to say that is not what I use — that is what naming a vendor does.
At most four capabilities: every one is a setup step standing between the founder and anything
happening at all.

## Everything that reaches a person stops for the founder

List every outward action in `approvals`, each with a risk, each `required: true`. Sending the
proposal. Emailing the chase. Anything a client would see.

This is not a cost. It is the single most reassuring line on the review card the founder reads, and
it is what makes it reasonable for them to say yes to something written by a machine ten seconds
ago. A service that could act on its own is one nobody sensible agrees to run.

## The skills are where the value is

The definition says *what* the jobs are. The skills are the only thing that makes them *good*, and a
service with a perfect definition and thin skills is a competent-looking agent that does amateur
work.

Write what a good operator in this trade knows and a stranger does not:

- the order things actually happen in, and what people get wrong about it
- what "done" looks like for each job, specifically
- the words this trade's customers use, and the words that would give away that you are not one
- when to stop and ask rather than assume

Write procedures, not essays. A skill that reads like a Wikipedia article about the industry is
worse than no skill, because it fills the context and teaches nothing.

Worked example — they sell web apps to food businesses. The jobs are **their** jobs: take a brief,
draft the first page, chase sign-off. Not a security questionnaire. Not "invoice chase dressed as a
studio". The first job is a page a restaurant owner can open on their phone, produced from the brief
they sent, with placeholders labelled as placeholders rather than invented menus.

Use `knowledge` for what is generally true of the trade. **Never invent a fact about THIS
business** — their prices, their turnaround, their tone. You do not know those. Ask for them in
`intake`, where each answer becomes something the agent is grounded on. At most eight questions, and
each one has to change what the agent visibly does; a question whose answer changes nothing is a
question you are making a busy person answer for nothing. A service with an empty `intake` never
asks, and the founder sees a quiet home that looks like nothing is thinking.

## Shaping delivery work that takes more than one sitting

Most real services — a website, a brand, a monthly report, a campaign — are not one shot. The wrong
way to write that is a single job that waits on ITSELF ("keep going on `build_website` after the
client replies"): that re-asks the client the thing they just answered, and it is refused. Shape
iterative work as SEPARATE jobs that hand off, each producing something inspectable:

- `draft_site` — produces a first version from the brief, then `waits_for.resume: revise_site`.
- `revise_site` — takes the client's feedback and produces the next version.

A job's `waits_for.resume` must always name a DIFFERENT job in this same service — the NEXT stage,
never itself. If the work truly is one sitting, give it no `waits_for` at all: it does the job,
produces its output, and stops. Do not model a pause you cannot name the other side of.

## Things that will be refused, so do not write them

- **A role.** `provides` is for jobs Mycel itself starts, exactly one service on the whole
  installation holds each, and that installation is shared with other businesses. Leave it out.
- **`workflows`.** That points at code, and no code is being written here. Leave it out.
- **`connections`.** That names one specific connected account. Use `capabilities`.
- **`policy`.** That is permission to act without asking. Not for a service nobody has watched run.
- **`harness`, `tools`, `model`.** Which tools and which model are our decisions, not the service's.
- **`internal: true`.** This is the work the business sells; it is the opposite of internal.
- **An approval with `required: false`.** That is not an approval.
- **A `waits_for.resume` that names a job this service does not have**, or names itself. The first
  parks the work forever; the second asks the client the same thing again the moment they answer.

## Words the founder must never read

They will read the title and every job description exactly as you write them. Never use **wedge**,
**kernel**, **harness**, or **provision**. Say *service*, *Mycel*, *job*, *set up*.

Write the title as the founder would write it on their own website. "Proposals and sign-off", not
"Proposal Desk Service Module".

## Then write the output

Exactly the shape in the output schema, as JSON, **as your last message**. That message is the
deliverable and it is validated against the schema. Nothing else in it — no preamble, no code fence.
Do not write it to a file first: there is no `write` tool here, so that costs a `bash` call and an
entire extra model turn, and this is the longest output in the product already.

If you genuinely cannot write a service for what they described — the description is one word, or it
is not a business — say so by returning a manifest with no jobs. That is refused, loudly, and the
founder is asked again. That is a far better outcome than a plausible-looking service that does
nothing they need.
